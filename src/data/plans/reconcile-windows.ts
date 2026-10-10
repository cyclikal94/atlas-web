import {
  type Mention,
  OUTSTANDING,
  type PageFacts,
  type Reconciled,
  reconcileEffects,
  reconcileVersions,
} from "../model/reconcile";
import type { DraftRow, PendingEffectRow } from "../model/types";
import { type Key, type Reader, range, type WriteSink } from "../store/port";

/**
 * The reconciliation of a delta page, in WINDOWS (R6, revision 6).
 *
 * The first revision read every pending effect, every tracked version and every draft header that matched a version into memory
 * before the page was decoded, so what a page held grew with the queue, whatever the page said. This does the same work with
 * what is in hand bounded by the window (`queueWorkingSet`, 100 rows) whatever the size of the queue:
 *
 * - WHAT MATTERS is found by LOOKUP, as the page is decoded (`interestingOf`): only the ids the page names that have an effect row
 *   or a tracked version are kept, as small id-to-word records (never a row), so a page that names nothing of the local work
 *   reads none of it. The lookup is itself bounded: one `bulkGet` of the versions and EXISTENCE rounds over the effects, none of
 *   which returns more than the window, because ONE resource can have far more pending effects than a window holds (every
 *   acknowledged operation that touched it, until a page reconciles them);
 * - EFFECTS are reconciled a window at a time, in primary-key order, with each window's writes made before the next is read.
 *   `reconcileEffects` is the same pure function whole-population `reconcilePage` uses, and the order is part of its semantics: a
 *   draft's flags move at most once, at its first touched effect, so the windowing cannot change a result. A draft that would leave
 *   but has an effect elsewhere that still shows an overlay stays (`hasOtherDisplaying`: the draft's own effects, a window at a
 *   time). On a final page (the live edge) every effect row is visited, so an unmentioned one can be resolved; on any other only
 *   the effects of the ids the page names;
 * - VERSIONS are reconciled a window at a time over the ids the page names, and "does an outstanding draft still stand on this
 *   resource" is asked of the `index_targets` index a window of headers at a time, stopping at the first that does.
 *
 * Nothing is capped and nothing is dropped: every row that the whole-population function would have reconciled is reconciled, in the
 * same transaction as the page (`tests/data/reconcile-windows.test.ts` holds the two to the same result over random queues and
 * pages, at several window sizes).
 */
export interface WindowedReconcile {
  reader: Reader;
  sink: WriteSink;
  /** The page's final word on each id that has local work (an effect row or a tracked version). */
  mentions: ReadonlyMap<string, Mention>;
  facts: PageFacts;
  /** Visit every effect row (the live edge can resolve one the page does not name), not only those of the ids it names. */
  walkAllEffects: boolean;
  /** Rows in hand at once. */
  window: number;
  /**
   * WEB-09b's recovery mode (matrix 3.7.3: the recovery touches NO draft, `pending_effects` or outbox entry; R8 of the review of 10
   * October 2026): no effect row and no draft is read for writing or written at all, and no tracked version is deleted. The page's
   * delivered versions are still recorded (cache-side bookkeeping). The receipt bookkeeping it skips is done after the recovery, as an
   * ordinary write once the account is displayed (W26). Absent: the ordinary page, exactly as before.
   */
  recovery?: boolean;
}

/** The compound primary key of `pending_effects`, as an index. */
const EFFECT_KEY = "[resource_id+local_id]";
const effectKey = (row: PendingEffectRow): Key => [
  row.resource_id,
  row.local_id,
];
const effectKeyString = (row: PendingEffectRow): string =>
  JSON.stringify(effectKey(row));

/** Whether the store holds any local work at all: an effect row or a tracked version. Counts only; no row is read. */
export async function hasLocalWork(reader: Reader): Promise<boolean> {
  return (
    (await reader.count("pending_effects")) > 0 ||
    (await reader.count("resource_versions")) > 0
  );
}

/**
 * The ids, of `ids`, that have local work: a tracked version or a pending effect. No read returns more than `window` rows, whatever
 * the size of the stores and however many effects ONE resource has; the rows themselves are dropped on return, only the ids are kept.
 *
 * Versions are one row per resource, so one batched `bulkGet`. A resource's pending effects are NOT bounded by the number of ids asked
 * for (every acknowledged operation that touched it, until a page reconciles them, leaves one, each with its display patch), so asking
 * the index for "every effect of any of these ids" read them all. Only whether each id HAS one matters, so the ids that remain
 * undecided are asked in rounds of at most `min(window, remaining)` rows: a round that returns fewer rows than it was allowed has seen
 * every effect of every remaining id, and a full round is cut short, so the ids it did find are settled and the rest are asked again.
 * Every full round settles at least one id, so the traversal ends, in at most as many rounds as there are ids, and a limit that merely
 * truncated the combined result (and so missed the ids behind it) is never relied on.
 */
export async function interestingOf(
  reader: Reader,
  ids: readonly string[],
  window: number,
): Promise<Set<string>> {
  const hits = new Set<string>();
  if (ids.length === 0) return hits;
  const versions = await reader.bulkGet("resource_versions", ids);
  versions.forEach((row, at) => {
    if (row !== undefined) hits.add(ids[at] as string);
  });
  // An id that already has a tracked version is interesting whatever its effects are: it is not asked about again.
  let remaining = ids.filter((id) => !hits.has(id));
  // At most one round per id: every full round settles at least one, so this bound is never the reason the loop ends, and a store that
  // answered with rows of other ids (a defect) could not make it run for ever.
  for (let round = 0; round < ids.length && remaining.length > 0; round += 1) {
    const allowed = Math.max(1, Math.min(window, remaining.length));
    const rows = await reader.anyOf(
      "pending_effects",
      "resource_id",
      remaining,
      allowed,
    );
    for (const effect of rows) hits.add(effect.resource_id);
    if (rows.length < allowed) break;
    remaining = remaining.filter((id) => !hits.has(id));
  }
  return hits;
}

/** Whether an outstanding draft still targets `resource`: the index's headers a window at a time, until one is found. */
export async function hasOutstandingDraft(
  reader: Reader,
  resource: string,
  window: number,
): Promise<boolean> {
  for (let offset = 0; ; offset += window) {
    const headers: DraftRow[] = await reader.byIndex(
      "drafts",
      "index_targets",
      range.only(resource),
      window,
      offset,
    );
    if (headers.some((draft) => OUTSTANDING.has(draft.status))) return true;
    if (headers.length < window) return false;
  }
}

/** Whether `owner` has an effect row, outside `inWindow`, that still shows an overlay: its effects, a window at a time. */
async function hasOtherDisplaying(
  reader: Reader,
  owner: string,
  inWindow: ReadonlySet<string>,
  window: number,
): Promise<boolean> {
  for (let offset = 0; ; offset += window) {
    const rows: PendingEffectRow[] = await reader.byIndex(
      "pending_effects",
      "local_id",
      range.only(owner),
      window,
      offset,
    );
    if (
      rows.some(
        (row) => row.display !== null && !inWindow.has(effectKeyString(row)),
      )
    )
      return true;
    if (rows.length < window) return false;
  }
}

/**
 * One window of effect rows and the drafts that own them, reconciled and written through the caller's sink (`reconcileEffects`, with a
 * draft that would leave kept while another of its effects still shows an overlay). `select` (WEB-09b) narrows the rows that take part
 * by their owner's header: a row it refuses is not handed to `reconcileEffects` at all, so it is neither written nor counted as touched,
 * and `deletes: false` keeps every row and draft the reconciliation would have removed (P-7). Adds the window's counts to `stats`.
 */
export async function reconcileEffectWindow(
  reader: Reader,
  sink: WriteSink,
  rows: readonly PendingEffectRow[],
  context: {
    mentions: ReadonlyMap<string, Mention>;
    facts: PageFacts;
    window: number;
    stats: Reconciled["stats"];
    select?: (row: PendingEffectRow, owner: DraftRow | undefined) => boolean;
    deletes?: boolean;
  },
): Promise<void> {
  const { mentions, facts, window, stats } = context;
  const owners = [...new Set(rows.map((row) => row.local_id))];
  const headers: DraftRow[] = [];
  for (const header of await reader.bulkGet("drafts", owners))
    if (header !== undefined) headers.push(header);
  const select = context.select;
  const byId = new Map(headers.map((header) => [header.local_id, header]));
  const effects =
    select === undefined
      ? rows
      : rows.filter((row) => select(row, byId.get(row.local_id)));
  if (effects.length === 0) return;
  const inWindow = new Set(effects.map(effectKeyString));
  let result = reconcileEffects({
    effects,
    drafts: headers,
    mentions,
    facts,
  });
  if (result.draftDeletes.length > 0) {
    const others = new Set<string>();
    for (const owner of result.draftDeletes)
      if (await hasOtherDisplaying(reader, owner, inWindow, window))
        others.add(owner);
    if (others.size > 0)
      result = reconcileEffects({
        effects,
        drafts: headers,
        mentions,
        facts,
        othersDisplaying: others,
      });
  }
  stats.mentioned += result.stats.mentioned;
  stats.resolvedNoPublication += result.stats.resolvedNoPublication;
  stats.heldReleased += result.stats.heldReleased;
  stats.unavailable += result.stats.unavailable;
  const deletes = context.deletes !== false;
  // A row the reconciliation would have removed is kept, finished as it is, when nothing may be deleted (P-7).
  const kept = deletes
    ? []
    : effects.filter((row) =>
        result.effectDeletes.some(
          ([resource, local]) =>
            resource === row.resource_id && local === row.local_id,
        ),
      );
  const keptRows = kept.map((row) => {
    const mention = mentions.get(row.resource_id);
    return mention
      ? { ...row, last_mentioned_page_seq: facts.pageSeq, display: null }
      : { ...row, resolved: "no_publication" as const, display: null };
  });
  const effectPuts = [...result.effectPuts, ...keptRows];
  if (effectPuts.length) await sink.bulkPut("pending_effects", effectPuts);
  if (deletes && result.effectDeletes.length)
    await sink.bulkDelete("pending_effects", result.effectDeletes);
  // A draft the reconciliation would have removed leaves with its flags clear (`retentionMet`): kept, it is written with them clear.
  const keptDrafts = deletes
    ? []
    : result.draftDeletes.flatMap((id) => {
        const header = byId.get(id);
        return header === undefined
          ? []
          : [{ ...header, held_pending_cache: false }];
      });
  const draftPuts = [...result.draftPuts, ...keptDrafts];
  if (draftPuts.length) await sink.bulkPut("drafts", draftPuts);
  if (deletes && result.draftDeletes.length) {
    await sink.bulkDelete("drafts", result.draftDeletes);
    // A body never outlives its draft.
    await sink.bulkDelete("draft_commands", result.draftDeletes);
  }
}

/** The drafts whose receipt bookkeeping a recovery may do (P-7): settled by an acknowledgement, never unsent work. */
export const acknowledgedOnly = (
  _row: PendingEffectRow,
  owner: DraftRow | undefined,
): boolean => owner?.status === "acknowledged";

export async function reconcileInWindows(
  input: WindowedReconcile,
): Promise<Reconciled["stats"]> {
  const { reader, sink, mentions, facts, window } = input;
  const stats = {
    mentioned: 0,
    resolvedNoPublication: 0,
    heldReleased: 0,
    unavailable: 0,
  };

  // ---- effects and the drafts that own them ---------------------------------------------------------------------------------
  const effectWindow = (rows: PendingEffectRow[]): Promise<void> =>
    reconcileEffectWindow(reader, sink, rows, {
      mentions,
      facts,
      window,
      stats,
    });

  if (input.recovery === true) {
    // Nothing of the queue (R8): the effects and their drafts are left exactly as they are.
  } else if (input.walkAllEffects) {
    let after: Key | null = null;
    for (;;) {
      const rows: PendingEffectRow[] = await reader.byIndex(
        "pending_effects",
        EFFECT_KEY,
        after === null ? range.all() : range.atLeast(after, true),
        window,
      );
      if (rows.length === 0) break;
      await effectWindow(rows);
      const last = rows[rows.length - 1] as PendingEffectRow;
      if (rows.length < window) break;
      after = effectKey(last);
    }
  } else {
    // The ids the page names, in KEY order (the order of the compound primary key's first component), each id's effects in key order:
    // the order a walk of the whole store would have met them in.
    let buffer: PendingEffectRow[] = [];
    const flush = async (): Promise<void> => {
      if (buffer.length === 0) return;
      const ready = buffer;
      buffer = [];
      await effectWindow(ready);
    };
    for (const id of [...mentions.keys()].sort()) {
      let after: Key | null = null;
      for (;;) {
        const rows: PendingEffectRow[] = await reader.byIndex(
          "pending_effects",
          EFFECT_KEY,
          // `[id]` sorts before every `[id, local_id]`, and no local id (a UUID) sorts after "\uffff".
          range.between(after ?? [id], [id, "\uffff"], {
            lowerOpen: after !== null,
          }),
          window,
        );
        for (const row of rows) {
          buffer.push(row);
          if (buffer.length >= window) await flush();
        }
        if (rows.length < window) break;
        after = effectKey(rows[rows.length - 1] as PendingEffectRow);
      }
    }
    await flush();
  }

  // ---- the tracked versions the page names ----------------------------------------------------------------------------------------
  const ids = [...mentions.keys()];
  for (let from = 0; from < ids.length; from += window) {
    const batch = ids.slice(from, from + window);
    const versions = [];
    for (const row of await reader.bulkGet("resource_versions", batch))
      if (row !== undefined) versions.push(row);
    if (versions.length === 0) continue;
    const outstanding = new Set<string>();
    for (const version of versions)
      if (
        version.basis !== "timer_session" &&
        (await hasOutstandingDraft(reader, version.resource_id, window))
      )
        outstanding.add(version.resource_id);
    const result = reconcileVersions({ versions, mentions, outstanding });
    if (result.versionPuts.length)
      await sink.bulkPut("resource_versions", result.versionPuts);
    if (result.versionDeletes.length && input.recovery !== true)
      await sink.bulkDelete("resource_versions", result.versionDeletes);
  }
  return stats;
}

/**
 * Drops every overlay display (`display: null`) in WINDOWS, in primary-key order, and returns how many rows had one (R11, revision 8).
 * The invalidation of the cache hides every overlay and used to read the whole store of pending effects to find them; what it held grew
 * with the queue, display patches included, and the arrays it built to clear them grew with it too. This reads at most `window` rows at
 * a time and writes each window's changes before the next is read, inside the CALLER's transaction (the writes go through its sink, so a
 * failure anywhere rolls the whole invalidation back). Nothing is dropped or capped: every row is visited, and only its `display`
 * changes. The walk is by key, not by offset, so what the writes change cannot move it.
 */
export async function clearOverlayDisplays(
  reader: Reader,
  sink: WriteSink,
  window: number,
): Promise<number> {
  const size = Math.max(1, window);
  let cleared = 0;
  let after: Key | null = null;
  for (;;) {
    const rows: PendingEffectRow[] = await reader.byIndex(
      "pending_effects",
      EFFECT_KEY,
      after === null ? range.all() : range.atLeast(after, true),
      size,
    );
    if (rows.length === 0) break;
    const showing = rows.filter((row) => row.display !== null);
    if (showing.length > 0) {
      await sink.bulkPut(
        "pending_effects",
        showing.map((row) => ({ ...row, display: null })),
      );
      cleared += showing.length;
    }
    if (rows.length < size) break;
    after = effectKey(rows[rows.length - 1] as PendingEffectRow);
  }
  return cleared;
}
