import type { DraftRow, PendingEffectRow, ResourceVersionRow } from "./types";

/**
 * What a delta page does to the local-work stores, as a PURE function (plan 5.4.4 items 3 to 5; WEB-04 design 5.4, 3.2).
 *
 * A page names resources (an `Upsert` or a `Remove`). For the ids that matter to local work it:
 *  - records the page's `page_seq` as `last_mentioned_page_seq` on EVERY live candidate row sharing the id, whatever the batch's
 *    own labelled revision (the per-id mechanism; a revision comparison is wrong, see the 40/50/60 case);
 *  - RELEASE (a): drops the overlay's `display` for a mentioned id, and clears `held_pending_cache` on the owning draft (a delta
 *    page's content is always the account's present-moment view of the ids it names);
 *  - LIVE-EDGE `no_publication`: for an open candidate row whose id this page does NOT name, resolves it `no_publication` iff the
 *    request that produced the page was CAPTURED after the receipt was recorded (`request_seq > no_publication_floor`, strictly)
 *    and the page has `has_more: false`. It does not consult `last_mentioned_page_seq` (a snapshot-phase mention is not evidence
 *    of a current publication). Release (a) runs first, per id;
 *  - RELEASE (b): the same transaction moves a draft's `held_pending_cache` to `unavailable_outcome`;
 *  - reconciles `resource_versions` for the ids it names, and removes whatever is now finished.
 *
 * A STAGED word (WEB-09c, R20-SEG) is the exception to "present-moment": the activation of a segmented revision moves into the cache words
 * that earlier requests delivered, possibly long before, so such a word is evidence only about a candidate that already existed when its
 * request was captured (`stagedMentionReaches`). To any other candidate the page does not name the id.
 *
 * The cache itself is written by the caller, one change at a time. Nothing here reads a clock or the database.
 */
export interface Mention {
  /** The page's final word on the id: removed, or upserted at this version. */
  removed: boolean;
  version: number | null;
  /**
   * Present only for a word STAGED by an earlier segment of the revision and moved into the cache by the activation: the `request_seq` its
   * request was captured with (null: unknown). Absent: the page's own word (an ordinary page, or the final segment), the present-moment view.
   */
  stagedRequestSeq?: number | null;
}

/**
 * Whether `mention` is evidence about the candidate `row` (R20-SEG). The page's own words always are. A staged word is only when its request
 * was captured STRICTLY after the row was created (`submitted_at_request_seq`): a request captured at or before the claim cannot reflect a
 * command sent after it, and applying its word would retire the overlay, the held flag and then the draft of an edit the server has
 * acknowledged, over content older than that edit. A row without the claim's witness uses its receipt's floor, which is later than the claim
 * and so only stricter; a row with neither (in flight, written before the witness) is not reached. The comparison is the live edge's: strict,
 * on the durable, monotone `request_seq`, never a batch revision (a delta batch can carry present-moment content under an older label).
 */
export function stagedMentionReaches(
  mention: Mention,
  row: PendingEffectRow,
): boolean {
  if (mention.stagedRequestSeq === undefined) return true;
  const since = row.submitted_at_request_seq ?? row.no_publication_floor;
  return (
    mention.stagedRequestSeq !== null &&
    since !== null &&
    mention.stagedRequestSeq > since
  );
}

export interface PageFacts {
  /** The NEW `page_seq` (the page being applied). */
  pageSeq: number;
  hasMore: boolean;
  /** The `request_seq` the page's request was captured with; null for a page that has none (a fixture). */
  requestSeq: number | null;
}

export interface ReconcileInput {
  effects: readonly PendingEffectRow[];
  versions: readonly ResourceVersionRow[];
  drafts: readonly DraftRow[];
  mentions: ReadonlyMap<string, Mention>;
  facts: PageFacts;
}

export interface Reconciled {
  effectPuts: PendingEffectRow[];
  effectDeletes: Array<[string, string]>;
  draftPuts: DraftRow[];
  draftDeletes: string[];
  versionPuts: ResourceVersionRow[];
  versionDeletes: string[];
  stats: {
    mentioned: number;
    resolvedNoPublication: number;
    heldReleased: number;
    unavailable: number;
  };
}

/** The ids whose mention matters: the pending effects' and the tracked versions'. Anything else is not tested. */
export function interestingIds(
  effects: readonly PendingEffectRow[],
  versions: readonly ResourceVersionRow[],
): Set<string> {
  const ids = new Set<string>();
  for (const e of effects) ids.add(e.resource_id);
  for (const v of versions) ids.add(v.resource_id);
  return ids;
}

/** Statuses of a draft that still stand behind an assumed version (a settled, superseded or rejected draft does not). */
export const OUTSTANDING: ReadonlySet<string> = new Set([
  "queued",
  "in_flight",
  "version_conflict",
  "operation_conflict",
  "blocked",
]);

/** Whether a settled draft may leave the store: acknowledged and nothing is waiting on it. */
const retentionMet = (draft: DraftRow | undefined): boolean =>
  draft === undefined ||
  (draft.status === "acknowledged" &&
    !draft.held_pending_cache &&
    !draft.unavailable_outcome);

/** What `reconcileEffects` needs: the effect rows in play, the drafts that own them, and the page's words. */
export interface EffectsInput {
  /** In PRIMARY-KEY order (`[resource_id, local_id]`): the order is part of the semantics (which effect of a draft moves its flags first). */
  effects: readonly PendingEffectRow[];
  /** The headers of the drafts that own `effects` (a missing one is a draft that no longer exists). */
  drafts: readonly DraftRow[];
  mentions: ReadonlyMap<string, Mention>;
  facts: PageFacts;
  /**
   * Owners that have an effect row OUTSIDE `effects` that still shows an overlay (`display !== null`). Such a row is a survivor
   * exactly as an untouched row of `effects` is: the draft cannot leave while it stands. Empty when `effects` is every effect row.
   */
  othersDisplaying?: ReadonlySet<string>;
}

export interface EffectsReconciled {
  effectPuts: PendingEffectRow[];
  effectDeletes: Array<[string, string]>;
  draftPuts: DraftRow[];
  draftDeletes: string[];
  stats: Reconciled["stats"];
}

/**
 * The effect rows of a page and the drafts that own them (release (a), the live edge, release (b), and what leaves). It is correct
 * to call it over the effect rows in WINDOWS of the key order, writing each window's result before the next is read, because a
 * draft's flags move at most once and at its first touched effect (a later effect finds `held_pending_cache` already clear), a
 * row's departure depends only on its own draft's flags after that move, and a draft that still has an effect showing an overlay
 * anywhere in the store stays (`othersDisplaying`).
 */
export function reconcileEffects(input: EffectsInput): EffectsReconciled {
  const { effects, drafts, mentions, facts } = input;
  const othersDisplaying = input.othersDisplaying ?? new Set<string>();
  const original = new Map(drafts.map((d) => [d.local_id, d]));
  const changedDrafts = new Map<string, DraftRow>();
  const current = (id: string): DraftRow | undefined =>
    changedDrafts.get(id) ?? original.get(id);
  const edit = (id: string, patch: Partial<DraftRow>): void => {
    const draft = current(id);
    if (draft) changedDrafts.set(id, { ...draft, ...patch });
  };

  const stats = {
    mentioned: 0,
    resolvedNoPublication: 0,
    heldReleased: 0,
    unavailable: 0,
  };
  const touchedDrafts = new Set<string>();
  const nextEffects = new Map<string, PendingEffectRow>();
  const key = (e: PendingEffectRow): string =>
    JSON.stringify([e.resource_id, e.local_id]);
  const changedKeys = new Set<string>();

  for (const e of effects) {
    let row = e;
    const word = mentions.get(e.resource_id);
    // A staged word this row is not reached by leaves the id unnamed for it: the live edge decides, as if the piece came before the row.
    const mention =
      word !== undefined && stagedMentionReaches(word, e) ? word : undefined;
    if (mention) {
      // Release (a), first, per id. It settles this row's fate for the page entirely.
      row = { ...row, last_mentioned_page_seq: facts.pageSeq, display: null };
      stats.mentioned += 1;
      const draft = current(e.local_id);
      if (draft?.held_pending_cache) {
        edit(e.local_id, { held_pending_cache: false });
        stats.heldReleased += 1;
      }
      touchedDrafts.add(e.local_id);
    } else if (
      !facts.hasMore &&
      facts.requestSeq !== null &&
      e.no_publication_floor !== null &&
      e.resolved === null &&
      // STRICT: a request already in flight when the receipt was recorded proves nothing.
      facts.requestSeq > e.no_publication_floor
    ) {
      row = { ...row, resolved: "no_publication", display: null };
      stats.resolvedNoPublication += 1;
      const draft = current(e.local_id);
      if (draft?.held_pending_cache) {
        // Release (b): the outcome is retained and shown until the person dismisses it.
        edit(e.local_id, {
          held_pending_cache: false,
          unavailable_outcome: true,
        });
        stats.unavailable += 1;
      }
      touchedDrafts.add(e.local_id);
    }
    if (row !== e) changedKeys.add(key(e));
    nextEffects.set(key(e), row);
  }

  // Rows that are finished leave: cleared, and either mentioned or resolved, and their draft needs nothing more.
  const effectDeletes: Array<[string, string]> = [];
  const effectPuts: PendingEffectRow[] = [];
  // local_id -> untouched rows still showing an overlay. A touched row always ends with `display: null` (both releases clear it).
  const survivors = new Map<string, number>();
  for (const e of effects) {
    const k = key(e);
    if (!changedKeys.has(k)) {
      const row = nextEffects.get(k) as PendingEffectRow;
      if (row.display !== null)
        survivors.set(row.local_id, (survivors.get(row.local_id) ?? 0) + 1);
      continue;
    }
    const row = nextEffects.get(k) as PendingEffectRow;
    const finished =
      row.display === null &&
      (row.last_mentioned_page_seq !== null || row.resolved !== null) &&
      retentionMet(current(row.local_id));
    if (finished) effectDeletes.push([row.resource_id, row.local_id]);
    else effectPuts.push(row);
  }
  // A settled draft whose overlay has cleared (and whose flags are clear) leaves.
  const draftDeletes: string[] = [];
  for (const id of touchedDrafts) {
    const draft = current(id);
    if (
      draft &&
      draft.status === "acknowledged" &&
      retentionMet(draft) &&
      !survivors.get(id) &&
      !othersDisplaying.has(id)
    ) {
      draftDeletes.push(id);
      changedDrafts.delete(id);
    }
  }
  const draftPuts = [...changedDrafts.values()];
  return { effectPuts, effectDeletes, draftPuts, draftDeletes, stats };
}

/** What `reconcileVersions` needs: the tracked versions in play, the page's words, and which resources still have drafts standing on them. */
export interface VersionsInput {
  versions: readonly ResourceVersionRow[];
  mentions: ReadonlyMap<string, Mention>;
  /** The resources some outstanding draft (`OUTSTANDING`) still targets. Only the ids of `versions` are consulted. */
  outstanding: ReadonlySet<string>;
}

/** `resource_versions`, for the ids a page names. Each row is judged on its own, so it may be called over windows of the versions. */
export function reconcileVersions(input: VersionsInput): {
  versionPuts: ResourceVersionRow[];
  versionDeletes: string[];
} {
  const { versions, mentions, outstanding } = input;
  const versionPuts: ResourceVersionRow[] = [];
  const versionDeletes: string[] = [];
  for (const v of versions) {
    // A timer session is not a delivered Projection: it follows the local-only rule and is never reconciled by a page.
    if (v.basis === "timer_session") continue;
    const m = mentions.get(v.resource_id);
    if (!m) continue;
    if (m.removed) {
      if (!outstanding.has(v.resource_id)) versionDeletes.push(v.resource_id);
      continue;
    }
    const delivered = m.version as number;
    if (
      delivered >= v.locally_assumed_version &&
      !outstanding.has(v.resource_id)
    ) {
      versionDeletes.push(v.resource_id);
    } else if (delivered > v.locally_assumed_version) {
      // Higher: the record follows the server. Queued drafts keep their bases and meet a genuine 409. Lower: never overwritten.
      versionPuts.push({ ...v, locally_assumed_version: delivered });
    }
  }
  return { versionPuts, versionDeletes };
}

/**
 * The whole page over the WHOLE population at once: the reference semantics. The page-commit plan does the same work in windows
 * (`plans/reconcile-windows.ts`) and a property test holds the two to the same result; this is also what the pure tests call.
 */
export function reconcilePage(input: ReconcileInput): Reconciled {
  const { effects, versions, drafts, mentions, facts } = input;
  const reconciledEffects = reconcileEffects({
    effects,
    drafts,
    mentions,
    facts,
  });
  // resource_versions: reconcile the ids this page names.
  const outstanding = new Set<string>();
  for (const d of drafts)
    if (OUTSTANDING.has(d.status))
      for (const t of d.index_targets) outstanding.add(t);
  const { versionPuts, versionDeletes } = reconcileVersions({
    versions,
    mentions,
    outstanding,
  });
  return { ...reconciledEffects, versionPuts, versionDeletes };
}
