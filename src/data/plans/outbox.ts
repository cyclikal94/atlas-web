import { DATA_CONFIG } from "../model/config";
import {
  type CandidateFacts,
  candidateEligibility,
  durableNotBefore,
  isSendableStatus,
  type Selection,
} from "../model/dispatch";
import {
  candidateRows,
  type DraftWrite,
  decideDiscard,
  decideSupersede,
  draftWriteBytes,
  type EnqueueRequest,
  planEdit,
  planEnqueue,
} from "../model/outbox";
import {
  decideOutcome,
  decideReceipt,
  type RecordedOutcome,
  resumeDraft,
} from "../model/outcomes";
import {
  applyOverlay,
  type MergedResource,
  mergeResource,
  type Overlay,
} from "../model/overlay";
import {
  isQueueVisible,
  type QueueSummary,
  summaryFromCounts,
} from "../model/queue-summary";
import { OldestDrafts, TargetFold } from "../model/related";
import {
  draftOperations,
  failureVersion,
  onLocalWriteSuccess,
  operationDraft,
  QUEUE_OPERATION,
} from "../model/retry";
import type {
  CacheRow,
  Captured,
  DraftCommandRow,
  DraftError,
  DraftRow,
  DraftWithCommand,
  JsonObject,
  LocalId,
  PendingEffectRow,
  ResourceId,
  ResourceKind,
  SyncStateRow,
} from "../model/types";
import { type Reader, range, w } from "../store/port";
import {
  bulkGetWindowed,
  collectIndex,
  existingDrafts,
  readEarliestSharing,
  readObservation,
  readTouched,
  type Touched,
  WINDOW,
  walkIndex,
} from "./bounded-reads";
import { guardedPlan, readPlan, singletonPlan } from "./builders";
import { readOverlays } from "./overlay-windows";

/**
 * The outbox plans (plan 5.5; writers W2 to W8). Each is ONE transaction. The decisions are the pure functions of
 * `model/outbox.ts`, `model/outcomes.ts` and `model/dispatch.ts`; a plan reads what the decision needs, never the whole database.
 *
 * Durability is `strict` for every one of them: the person's promise ("saved") and the outbox's own state are the writes that
 * must have reached the disk before the answer is given (decision D-03). The quota reserve refuses an enqueue and an edit LAST
 * (a person's input is the last thing refused) and nothing else here.
 */

// ---- shared reads -------------------------------------------------------------------------------------------------------------
// Every read of a population below is WINDOWED (`bounded-reads.ts`): no single read returns more than `queueWorkingSet` rows, and a
// population that is only asked about (the drafts that share a target) is reduced as it is read instead of held.

/**
 * A cascade's root with every transitive dependant, through the `depends_on` index, a window of dependants at a time. The members are
 * the atomic unit of the operation (every one of them is rewritten in the one transaction), so they are held, as headers; what is
 * bounded is each read. Only `Reader` calls are awaited.
 */
async function readCascade(
  reader: Reader,
  root: DraftRow,
): Promise<DraftRow[]> {
  const members = new Map<LocalId, DraftRow>([[root.local_id, root]]);
  const frontier: LocalId[] = [root.local_id];
  while (frontier.length > 0) {
    const id = frontier.pop() as LocalId;
    await walkIndex(
      reader,
      "drafts",
      "depends_on",
      range.only(id),
      (dependant) => {
        if (!members.has(dependant.local_id)) {
          members.set(dependant.local_id, dependant);
          frontier.push(dependant.local_id);
        }
      },
    );
  }
  return [...members.values()].sort((a, b) => a.created_seq - b.created_seq);
}

async function readEffectsOf(
  reader: Reader,
  members: readonly DraftRow[],
): Promise<PendingEffectRow[]> {
  const rows: PendingEffectRow[] = [];
  for (const member of members)
    rows.push(
      ...(await collectIndex(
        reader,
        "pending_effects",
        "local_id",
        range.only(member.local_id),
      )),
    );
  return rows;
}

const touchedIds = (members: readonly DraftRow[]): ResourceId[] =>
  members.flatMap((member) => [...member.index_targets, ...member.bumped]);

/**
 * What the facade reserved from the quota for a write is a BOUND on what the write stores (R25, revisions 12 and 13). The bases, and so
 * the command, are fixed inside the transaction, after the reservation was made, so the plan measures the WHOLE write it really composed
 * (`draftWriteBytes`, the same accounting as the estimate: the command, the display patch, the header with its defaults context, the
 * version rows, the identifiers and the dependants a supersession rewrites) and writes NOTHING when it is larger, saying how large it is;
 * the facade then admits the write again at that size. `maxBytes` absent: no bound (a caller that does not reserve, as the plan-level
 * tests do).
 *
 * The reservation is also a LEASE (R28, revision 14): the origin's other pages count its bytes only while the hold stands, so the write
 * may begin only while it does. `leaseLive` is the reservation's `live()`, read here, in the same synchronous step that decides what the
 * transaction writes: a write whose hold has ended writes nothing and says so (`lease_lapsed`), and the facade admits it again, judged
 * against everything admitted and written meanwhile.
 */
export type TooLarge = { kind: "too_large"; bytes: number };
export type LeaseLapsed = { kind: "lease_lapsed" };
/** What the admission of a write may answer instead of its result: ask for admission again (the facade does, a bounded number of times). */
export type Readmit = TooLarge | LeaseLapsed;
/** What the facade hands a plan about the reservation it made: how large a write it covers, and whether its hold still stands. */
interface Admission {
  maxBytes?: number;
  leaseLive?: () => boolean;
}
function overBound(
  admission: Admission,
  write: DraftWrite,
): Readmit | { kind: "invalid"; reason: "not_json" } | null {
  if (admission.maxBytes === undefined) return null;
  if (admission.leaseLive !== undefined && !admission.leaseLive())
    return { kind: "lease_lapsed" };
  const bytes = draftWriteBytes(write);
  // A value that cannot be measured is never a small write.
  if (bytes === null) return { kind: "invalid", reason: "not_json" };
  return bytes > admission.maxBytes ? { kind: "too_large", bytes } : null;
}

// ---- the end of an operation's failure streak (R46) ------------------------------------------------------------------------------
/**
 * `sync` with the failure streaks of `operations` removed, or `undefined` when none of them held one (so no write of `sync_state` is
 * made for it). The success of an operation, or its explicit abandonment, ENDS that operation's consecutive failures, and it is written
 * in the SAME transaction as the write that ended it (R46, revision 26): a streak is never left to a second, separate write that can
 * itself fail, be lost to a reload, or be skipped because the page that succeeded did not see the failure. Only the operations named
 * here are touched; every other operation's streak, and every other caller's budget, is as it was.
 */
function withoutStreaks(
  sync: SyncStateRow,
  operations: readonly string[],
): SyncStateRow | undefined {
  let streaks = sync.local_write_streaks;
  for (const operation of operations)
    streaks = onLocalWriteSuccess(streaks, operation);
  return streaks === sync.local_write_streaks
    ? undefined
    : { ...sync, local_write_streaks: streaks };
}

/**
 * The longest of the streaks of `operations` that `withoutStreaks` removes (0: none held one). A writer whose result does not otherwise
 * tell other pages that the record changed (a refusal, the record of a request that got no answer) compares it with the bound: a STOP
 * that ended is a change of the record of durable stops, which a page showing it hears only when it is told (R60, revision 38).
 */
function endedStreak(
  sync: SyncStateRow | undefined,
  operations: readonly string[],
): number {
  if (sync === undefined) return 0;
  return Math.max(
    0,
    ...operations.map((operation) => sync.local_write_streaks[operation] ?? 0),
  );
}

// ---- W2: enqueue ---------------------------------------------------------------------------------------------------------------
export type EnqueueResult =
  | { kind: "queued"; localId: LocalId; createdSeq: number; duplicate: boolean }
  /**
   * `changed`: the request stated what its caller saw (`observed`), and this transaction read something else; nothing was written.
   * `denied`: a target the request needs to write is cached with `can_edit: false` (`TargetSpec.requiresEdit`); nothing was written.
   */
  | {
      kind: "refused";
      reason: "fenced" | "closing" | "no_base" | "changed" | "denied";
    }
  | { kind: "invalid"; reason: "build_failed" | "not_json" }
  | Readmit;

interface EnqueueReads {
  existing: DraftRow | undefined;
  touched: Touched;
  /** The token of what the request said its caller saw, read here (`readObservation`), or null when it said nothing. */
  observed: string | null;
}

/** The observation a request states, read again inside the writing transaction (WEB-13a revision 2), or null when it states none. */
async function observedNow(
  reader: Reader,
  incarnationId: string,
  request: EnqueueRequest,
): Promise<string | null> {
  if (request.observed === undefined) return null;
  return (
    await readObservation(reader, incarnationId, request.observed.resourceId)
  ).token;
}

/** Whether a request that states an observation was made from what the transaction read (always, when it states none). */
const stillObserved = (
  request: EnqueueRequest,
  observed: string | null,
): boolean =>
  request.observed === undefined || request.observed.token === observed;

/**
 * ONE atomic read-increment-write over `drafts`, `resource_versions` and `cache` (read): every base is read and every record
 * raised in the same transaction, so two tabs enqueuing for one resource serialise on the one durable record (F-O1). The draft
 * fence refuses a new draft here (FEN), and a save that already happened under the same local id is recognised and not made twice.
 */
export const enqueueDraft = singletonPlan<
  {
    incarnationId: string;
    request: EnqueueRequest;
    localId: LocalId;
    accountId: string;
    now: string;
    /** What the facade reserved from the quota: the command built here may not be larger, nor written once the hold ended (see `overBound`). */
    maxBytes?: number;
    leaseLive?: () => boolean;
  },
  EnqueueReads,
  EnqueueResult
>({
  name: "data.enqueueDraft",
  meta: { writer: "W2", guards: ["INC", "FEN"], quota: "input" },
  scope: ["drafts", "draft_commands", "resource_versions", "cache"],
  durability: "strict",
  read: async (reader, input) => ({
    existing: await reader.get("drafts", input.localId),
    touched: await readTouched(
      reader,
      input.request.targets.map((target) => target.resourceId),
      new Set([input.localId]),
    ),
    observed: await observedNow(reader, input.incarnationId, input.request),
  }),
  decide: ({ sync, reads, input }) => {
    if (sync === undefined)
      return { result: { kind: "refused", reason: "no_base" } };
    const planned = planEnqueue(input.request, {
      sync,
      cache: reads.touched.cache,
      versions: reads.touched.versions,
      related: reads.touched.others,
      existing: reads.existing,
      localId: input.localId,
      accountId: input.accountId,
      now: input.now,
    });
    if (planned.kind === "refused" || planned.kind === "invalid")
      return { result: planned };
    // The save's own success ends the save's own failures (R46): a retry of a save whose completion was lost ends them too.
    const ended = [`draft:${input.localId}`];
    if (planned.kind === "duplicate") {
      const cleared = withoutStreaks(sync, ended);
      return {
        ...(cleared === undefined ? {} : { sync: cleared }),
        result: {
          kind: "queued",
          localId: planned.draft.local_id,
          createdSeq: planned.draft.created_seq,
          duplicate: true,
        },
      };
    }
    // After the duplicate: a retry of a save that was made is recognised, although its own write changed what its caller saw.
    if (!stillObserved(input.request, reads.observed))
      return { result: { kind: "refused", reason: "changed" } };
    const over = overBound(input, {
      draft: planned.draft,
      command: planned.command,
      versionPuts: planned.versionPuts,
    });
    if (over !== null) return { result: over };
    return {
      writes: [
        w.put("drafts", planned.draft),
        w.put("draft_commands", {
          local_id: planned.draft.local_id,
          command: planned.command,
        }),
        ...(planned.versionPuts.length
          ? [w.bulkPut("resource_versions", planned.versionPuts)]
          : []),
      ],
      sync: withoutStreaks(planned.sync, ended) ?? planned.sync,
      result: {
        kind: "queued",
        localId: planned.draft.local_id,
        createdSeq: planned.draft.created_seq,
        duplicate: false,
      },
    };
  },
});

// ---- W3: edit a queued command ----------------------------------------------------------------------------------------------
export type EditResult =
  | { kind: "edited"; localId: LocalId }
  | {
      kind: "refused";
      reason:
        | "fenced"
        | "closing"
        | "not_found"
        | "not_queued"
        | "retargeted"
        | "draft_changed"
        /** As `EnqueueResult`'s `denied`. */
        | "denied";
    }
  | { kind: "invalid"; reason: "build_failed" | "not_json" }
  | Readmit;

interface EditReads {
  draft: DraftRow | undefined;
  /**
   * The cached rows of the targets the request needs to write (`requiresEdit`), and of the participations it would create
   * (`joinRequiresEdit`) and the resources they name, read in this transaction.
   */
  cache: Map<ResourceId, CacheRow>;
  /** The other unsettled drafts that write such a participation (`TargetFold` stand-ins; never the edited draft). */
  others: DraftRow[];
}

export const editQueuedDraft = singletonPlan<
  {
    incarnationId: string;
    localId: LocalId;
    request: EnqueueRequest;
    /** What the facade reserved from the quota: the command built here may not be larger, nor written once the hold ended (see `overBound`). */
    maxBytes?: number;
    leaseLive?: () => boolean;
  },
  EditReads,
  EditResult
>({
  name: "data.editQueuedDraft",
  meta: { writer: "W3", guards: ["INC", "FEN"], quota: "input" },
  scope: ["drafts", "draft_commands", "cache"],
  durability: "strict",
  read: async (reader, input) => {
    const draft = await reader.get("drafts", input.localId);
    // The permission an edit needs is read in the SAME transaction that writes it (R30): a denial committed before it is honoured.
    // (A request's target ids are distinct: `validateRequest`.)
    // A participation the edit would create is known from the cache or another unsettled draft that writes it (DA17-N2), read here too.
    const joins = input.request.targets.filter(
      (target) => target.joinRequiresEdit !== undefined,
    );
    const ids = input.request.targets.flatMap((target) =>
      target.joinRequiresEdit !== undefined
        ? [target.resourceId, target.joinRequiresEdit]
        : target.requiresEdit
          ? [target.resourceId]
          : [],
    );
    const rows = await bulkGetWindowed(reader, "cache", ids);
    const cache = new Map<ResourceId, CacheRow>();
    for (const row of rows) if (row) cache.set(row.id, row);
    const others = new Map<LocalId, DraftRow>();
    for (const target of joins) {
      const fold = new TargetFold(target.resourceId);
      await walkIndex(
        reader,
        "drafts",
        "index_targets",
        range.only(target.resourceId),
        // Only a draft OLDER than the edited one is evidence: a later one that writes the stream stands on the edited draft (it depends on
        // it), and the edited draft is not its own evidence (left in as the latest, either would also hide an older one from the fold).
        (row) => {
          if (draft !== undefined && row.created_seq < draft.created_seq)
            fold.add(row);
        },
      );
      for (const row of fold.rows()) others.set(row.local_id, row);
    }
    return { draft, cache, others: [...others.values()] };
  },
  decide: ({ sync, reads, input }) => {
    if (sync === undefined)
      return { result: { kind: "refused", reason: "not_found" } };
    const planned = planEdit(
      input.request,
      reads.draft,
      sync,
      reads.cache,
      reads.others,
    );
    if (planned.kind !== "edited") return { result: planned };
    const over = overBound(input, {
      draft: planned.draft,
      command: planned.command,
      versionPuts: [],
    });
    if (over !== null) return { result: over };
    // The edit's own success ends the save's own failures (R46).
    const cleared = withoutStreaks(sync, [`draft:${input.localId}`]);
    return {
      writes: [
        w.put("drafts", planned.draft),
        w.put("draft_commands", {
          local_id: planned.draft.local_id,
          command: planned.command,
        }),
      ],
      ...(cleared === undefined ? {} : { sync: cleared }),
      result: { kind: "edited", localId: planned.draft.local_id },
    };
  },
});

// ---- W4: discard and supersede ---------------------------------------------------------------------------------------------------
export type DiscardResult =
  | {
      kind: "refused";
      reason:
        | "not_found"
        | "in_flight"
        | "acknowledged"
        | "dependant_in_flight";
      /**
       * A `not_found` refusal that ended the draft's streaks: the longest it ended (absent: none). Bookkeeping for the page that
       * discarded, never part of the person's answer (R60, revision 38).
       */
      endedStreak?: number;
    }
  | {
      kind: "discarded";
      outcome: "removed" | "retained" | "dismissed";
      /** Dependants that became `rejected`. */
      affected: number;
    };

interface DiscardReads {
  draft: DraftRow | undefined;
  dependants: DraftRow[];
  effects: PendingEffectRow[];
  touched: Touched;
}

/**
 * Discards a draft, with the cascade of plan 5.5.5, in ONE transaction over `drafts`, `pending_effects`, `resource_versions` and
 * `cache`: the draft's fate, every dependant's `rejected`, the removal of the candidate rows and the version-base recompute are
 * durable together or not at all (WEB-04 D:3030-3034).
 */
export const discardDraft = singletonPlan<
  { incarnationId: string; localId: LocalId },
  DiscardReads,
  DiscardResult
>({
  name: "data.discardDraft",
  meta: { writer: "W4", guards: ["INC"], quota: null },
  scope: [
    "drafts",
    "draft_commands",
    "pending_effects",
    "resource_versions",
    "cache",
  ],
  durability: "strict",
  read: async (reader, input) => {
    const draft = await reader.get("drafts", input.localId);
    if (draft === undefined)
      return {
        draft,
        dependants: [],
        effects: [],
        touched: { cache: new Map(), versions: new Map(), others: [] },
      };
    const cascade = await readCascade(reader, draft);
    const dependants = cascade.filter((m) => m.local_id !== draft.local_id);
    return {
      draft,
      dependants,
      effects: await readEffectsOf(reader, cascade),
      touched: await readTouched(
        reader,
        touchedIds(cascade),
        new Set(cascade.map((member) => member.local_id)),
      ),
    };
  },
  decide: ({ sync, reads, input }) => {
    const decision = decideDiscard({
      draft: reads.draft,
      dependants: reads.dependants,
      effects: reads.effects,
      others: reads.touched.others,
      cache: reads.touched.cache,
      versions: reads.touched.versions,
    });
    // A draft the person abandons (or that is already gone) has no operation left to fail: both of ITS operations end here, its
    // saves' and its receipts' (R46). A refusal for any other reason abandons nothing.
    const ended =
      sync === undefined
        ? undefined
        : withoutStreaks(sync, draftOperations(input.localId));
    if (decision.kind === "refused") {
      if (decision.reason !== "not_found" || ended === undefined)
        return { result: decision };
      return {
        sync: ended,
        result: {
          ...decision,
          endedStreak: endedStreak(sync, draftOperations(input.localId)),
        },
      };
    }
    return {
      writes: [
        ...(decision.draftPuts.length
          ? [w.bulkPut("drafts", decision.draftPuts)]
          : []),
        ...(decision.draftDeletes.length
          ? [
              w.bulkDelete("drafts", decision.draftDeletes),
              // A body never outlives its draft.
              w.bulkDelete("draft_commands", decision.draftDeletes),
            ]
          : []),
        ...(decision.effectDeletes.length
          ? [w.bulkDelete("pending_effects", decision.effectDeletes)]
          : []),
        ...(decision.versions.puts.length
          ? [w.bulkPut("resource_versions", decision.versions.puts)]
          : []),
        ...(decision.versions.deletes.length
          ? [w.bulkDelete("resource_versions", decision.versions.deletes)]
          : []),
      ],
      ...(ended === undefined ? {} : { sync: ended }),
      result: {
        kind: "discarded",
        outcome: decision.outcome,
        affected: decision.draftPuts.filter(
          (row) => row.status === "rejected" && row.local_id !== input.localId,
        ).length,
      },
    };
  },
});

export type SupersedeResult =
  | {
      kind: "superseded";
      localId: LocalId;
      paused: LocalId[];
      /** True for a retry of a supersession that had already been made: nothing was written. */
      duplicate: boolean;
    }
  | {
      kind: "refused";
      reason:
        | "fenced"
        | "closing"
        | "not_found"
        | "not_supersedable"
        | "key_in_use"
        | "no_base"
        /** As `EnqueueResult`'s `denied`. */
        | "denied"
        /** The request's `expectDraft` refused the old draft as it is stored now; nothing was written. */
        | "draft_changed"
        /** No order of the queue lets the replacement and the drafts around it all be sent (R45, revision 25); nothing was written. */
        | "order_conflict"
        /** The request stated what its caller saw (`observed`), and this transaction read something else; nothing was written. */
        | "changed";
    }
  | { kind: "invalid"; reason: "build_failed" | "not_json" }
  | Readmit;

interface SupersedeReads {
  old: DraftRow | undefined;
  /** The draft stored under the replacement's key, whatever it is (R24). */
  existing: DraftRow | undefined;
  existingPaused: LocalId[];
  cascade: DraftRow[];
  /** The drafts that exist under the request's explicit dependencies (R45): where they stand decides the replacement's place. */
  extras: DraftRow[];
  effects: PendingEffectRow[];
  touched: Touched;
  /** As `EnqueueReads.observed`. */
  observed: string | null;
}

export const supersedeDraft = singletonPlan<
  {
    incarnationId: string;
    oldLocalId: LocalId;
    request: EnqueueRequest;
    localId: LocalId;
    accountId: string;
    now: string;
    /** What the facade reserved from the quota: the command built here may not be larger, nor written once the hold ended (see `overBound`). */
    maxBytes?: number;
    leaseLive?: () => boolean;
  },
  SupersedeReads,
  SupersedeResult
>({
  name: "data.supersedeDraft",
  meta: { writer: "W4", guards: ["INC", "FEN"], quota: "input" },
  scope: [
    "drafts",
    "draft_commands",
    "pending_effects",
    "resource_versions",
    "cache",
  ],
  durability: "strict",
  read: async (reader, input) => {
    const old = await reader.get("drafts", input.oldLocalId);
    // The replacement's key is read in the SAME transaction that writes under it (R24): its uniqueness is decided before anything moves.
    const existing = await reader.get("drafts", input.localId);
    if (old === undefined || existing !== undefined) {
      // Nothing is superseded from here: the old draft is gone (nothing to supersede, or a retry of a supersession already made, which
      // reports the dependants that one paused) or the key is taken (refused). Either way the decision needs no cascade.
      const existingPaused: LocalId[] = [];
      if (old === undefined && existing !== undefined)
        await walkIndex(
          reader,
          "drafts",
          "depends_on",
          range.only(existing.local_id),
          (dependant) => {
            if (
              dependant.status === "version_conflict" &&
              dependant.last_error?.stage === "dependency_superseded"
            )
              existingPaused.push(dependant.local_id);
          },
        );
      return {
        old,
        existing,
        existingPaused,
        cascade: [],
        extras: [],
        effects: [],
        touched: { cache: new Map(), versions: new Map(), others: [] },
        observed: null,
      };
    }
    const cascade = await readCascade(reader, old);
    // Explicit dependencies are read by key (windowed): the caller names them, and where they stand in the queue decides whether the
    // replacement can keep the old draft's place (`decideSupersede`).
    const named = [...new Set(input.request.dependsOnExtra ?? [])].filter(
      (id) => id !== old.local_id && id !== input.localId,
    );
    const extras = (await bulkGetWindowed(reader, "drafts", named)).filter(
      (row): row is DraftRow => row !== undefined,
    );
    return {
      old,
      existing,
      existingPaused: [],
      cascade,
      extras,
      effects: await readEffectsOf(reader, [old]),
      touched: await readTouched(
        reader,
        [
          ...touchedIds([old]),
          ...input.request.targets.map((target) => target.resourceId),
        ],
        new Set(cascade.map((member) => member.local_id)),
      ),
      observed: await observedNow(reader, input.incarnationId, input.request),
    };
  },
  decide: ({ sync, reads, input }) => {
    if (sync === undefined)
      return { result: { kind: "refused", reason: "not_found" } };
    const decision = decideSupersede(input.request, {
      old: reads.old,
      existing: reads.existing,
      existingPaused: reads.existingPaused,
      direct: reads.cascade.filter(
        (member) =>
          reads.old !== undefined &&
          member.local_id !== reads.old.local_id &&
          member.depends_on.includes(reads.old.local_id),
      ),
      cascade: reads.cascade,
      extras: reads.extras,
      effects: reads.effects,
      others: reads.touched.others,
      cache: reads.touched.cache,
      versions: reads.touched.versions,
      sync,
      localId: input.localId,
      accountId: input.accountId,
      now: input.now,
    });
    // The replacement's own success ends the replacement's failures, and the supersession abandons the draft it replaces: that
    // draft's operations end too (R46).
    const ended = [
      `draft:${input.localId}`,
      ...draftOperations(input.oldLocalId),
    ];
    if (decision.kind === "duplicate") {
      const cleared = withoutStreaks(sync, ended);
      return {
        ...(cleared === undefined ? {} : { sync: cleared }),
        result: {
          kind: "superseded",
          localId: decision.draft.local_id,
          paused: decision.paused,
          duplicate: true,
        },
      };
    }
    if (decision.kind !== "superseded") return { result: decision };
    // Only a supersession that would be written is checked: a retry of one already made, or a refusal, says what it said before.
    if (!stillObserved(input.request, reads.observed))
      return { result: { kind: "refused", reason: "changed" } };
    const over = overBound(input, {
      draft: decision.draft,
      command: decision.command,
      versionPuts: decision.versionPuts,
      rewritten: decision.draftPuts.length,
    });
    if (over !== null) return { result: over };
    // A replacement that took a new place at the end of the queue consumed a sequence number, and the counter is written with it; the
    // ended streaks are removed from whichever of the two the transaction writes.
    const base = decision.sync ?? sync;
    const cleared = withoutStreaks(base, ended);
    const written = cleared ?? (decision.sync === undefined ? undefined : base);
    return {
      writes: [
        w.put("drafts", decision.draft),
        w.put("draft_commands", {
          local_id: decision.draft.local_id,
          command: decision.command,
        }),
        ...(decision.draftPuts.length
          ? [w.bulkPut("drafts", decision.draftPuts)]
          : []),
        w.bulkDelete("drafts", decision.draftDeletes),
        w.bulkDelete("draft_commands", decision.draftDeletes),
        ...(decision.effectDeletes.length
          ? [w.bulkDelete("pending_effects", decision.effectDeletes)]
          : []),
        ...(decision.versionPuts.length
          ? [w.bulkPut("resource_versions", decision.versionPuts)]
          : []),
        ...(decision.versionDeletes.length
          ? [w.bulkDelete("resource_versions", decision.versionDeletes)]
          : []),
      ],
      ...(written === undefined ? {} : { sync: written }),
      result: {
        kind: "superseded",
        localId: decision.draft.local_id,
        paused: decision.paused,
        duplicate: false,
      },
    };
  },
});

// ---- W5: claim a draft for sending, and give the claim back ---------------------------------------------------------------------
export type ClaimResult =
  | {
      kind: "claimed";
      /** The header, as claimed. */
      draft: DraftRow;
      /** The body, read here for THIS draft only (the one place a send needs it). */
      command: JsonObject;
      /** True when THIS claim moved the draft from `queued` to `in_flight` (so it can be moved back). */
      flipped: boolean;
      /** The candidate rows THIS claim created (and so the only ones an unclaim may remove). */
      created: ResourceId[];
    }
  | { kind: "gone" }
  | { kind: "not_sendable"; status: DraftRow["status"] }
  /**
   * A stop stands for the draft (R46, revision 28): its own local writes failed, and only the person's "Try again" or the operation's own
   * success or abandonment may lift it. Nothing was written, and the stop was not touched: a claim is never the recovery that permits it.
   */
  | { kind: "stopped" };

interface ClaimReads {
  draft: DraftRow | undefined;
  command: DraftCommandRow | undefined;
  effects: PendingEffectRow[];
}

/**
 * Whether the durable record stops this draft: the streak of either of its operations has reached the bound. Decided from the
 * `sync_state` singleton the caller already holds, so it can be asked inside the transaction that would otherwise end the streak.
 */
export function draftStopped(
  streaks: Readonly<Record<string, number>>,
  localId: LocalId,
  after: number = DATA_CONFIG.localWritePauseAfter,
): boolean {
  return draftOperations(localId).some(
    (operation) => (streaks[operation] ?? 0) >= after,
  );
}

/**
 * `markInFlight`: ONE transaction flips `queued` to `in_flight` and inserts one candidate row per primary target, with
 * `submitted_at_page_seq = sync_state.page_seq`. A resend (the draft is already `in_flight`) inserts only the rows that are missing
 * and never overwrites `submitted_at_page_seq` (a mention of the resource BEFORE this page must not clear the overlay of a change
 * sent after it).
 *
 * The claim is where a send is ADMITTED, so it is where a stop is enforced (R46, revision 28): the dispatcher chose this draft from a
 * read made before, and another writer may have stopped it since (the facade's edit failed three times, or recorded its stop in the
 * fallback marker or in the page's memory). The decision reads the durable streaks of the transaction it runs in, and the page's own
 * stops through `heldOutside`, in the same synchronous step, and refuses a draft that stands stopped WITHOUT touching its streak: the
 * claim that ends a below-bound streak (it landed, so the failures are not consecutive) never ends one that has reached its bound.
 */
export const markInFlight = guardedPlan<
  {
    captured: Captured;
    localId: LocalId;
    /**
     * Whether a stop the database does not hold (the account's fallback marker, the page's memory) names this draft RIGHT NOW. Read
     * synchronously in the decision, like `leaseLive`; absent: only the durable record is consulted.
     */
    heldOutside?: (localId: LocalId) => boolean;
  },
  ClaimReads,
  ClaimResult
>({
  name: "data.markInFlight",
  meta: { writer: "W5", guards: ["INC", "CLS"], quota: null },
  scope: ["drafts", "draft_commands", "pending_effects"],
  durability: "strict",
  read: async (reader, input) => {
    const draft = await reader.get("drafts", input.localId);
    return {
      draft,
      command: draft
        ? await reader.get("draft_commands", input.localId)
        : undefined,
      effects: draft
        ? await collectIndex(
            reader,
            "pending_effects",
            "local_id",
            range.only(input.localId),
          )
        : [],
    };
  },
  decide: ({ sync, reads, input }) => {
    const { draft } = reads;
    if (draft === undefined) return { result: { kind: "gone" } };
    if (
      (draft.status !== "queued" && draft.status !== "in_flight") ||
      draft.review_block !== null
    )
      return { result: { kind: "not_sendable", status: draft.status } };
    // A header without its body can never be sent (the two are written in one transaction, so this is damage, not a race): a
    // definitive local refusal, never a request with an empty body.
    if (reads.command === undefined)
      return { result: { kind: "not_sendable", status: draft.status } };
    // A stop that stands is not lifted by this claim, and nothing is written for a draft that may not be sent (R46).
    if (
      draftStopped(sync.local_write_streaks, draft.local_id) ||
      input.heldOutside?.(draft.local_id) === true
    )
      return { result: { kind: "stopped" } };
    const flipped = draft.status === "queued";
    const have = new Set(reads.effects.map((row) => row.resource_id));
    const missing = candidateRows(draft, sync.page_seq).filter(
      (row) => !have.has(row.resource_id),
    );
    const claimed: DraftRow = flipped
      ? { ...draft, status: "in_flight" }
      : draft;
    // A claim that lands ends the failures of the claim (`draft:<id>`), in the same transaction (R46).
    const cleared = withoutStreaks(sync, [`draft:${draft.local_id}`]);
    return {
      writes: [
        ...(flipped ? [w.put("drafts", claimed)] : []),
        ...(missing.length ? [w.bulkPut("pending_effects", missing)] : []),
      ],
      ...(cleared === undefined ? {} : { sync: cleared }),
      result: {
        kind: "claimed",
        draft: claimed,
        command: reads.command.command,
        flipped,
        created: missing.map((row) => row.resource_id),
      },
    };
  },
});

/**
 * `unclaimDraft`: a request that DEFINITIVELY never left (`not_sent`, `closed`, `closed_unresolved`, `not_covered`) returns the
 * draft to `queued` and removes only the candidate rows this claim created, so a draft that never reached the wire is not frozen.
 * A draft that was already `in_flight` before this claim (a retry candidate) stays so: an earlier attempt may have been sent.
 */
export const unclaimDraft = singletonPlan<
  {
    incarnationId: string;
    localId: LocalId;
    flipped: boolean;
    created: readonly ResourceId[];
  },
  DraftRow | undefined,
  { kind: "unclaimed" | "unchanged" }
>({
  name: "data.unclaimDraft",
  meta: { writer: "W5", guards: ["INC"], quota: null },
  scope: ["drafts", "pending_effects"],
  durability: "strict",
  read: (reader, input) => reader.get("drafts", input.localId),
  decide: ({ reads, input }) => {
    if (reads === undefined || reads.status !== "in_flight")
      return { result: { kind: "unchanged" } };
    if (!input.flipped && input.created.length === 0)
      return { result: { kind: "unchanged" } };
    return {
      writes: [
        ...(input.flipped
          ? [w.put("drafts", { ...reads, status: "queued" as const })]
          : []),
        ...(input.created.length
          ? [
              w.bulkDelete(
                "pending_effects",
                input.created.map((id) => [id, input.localId]),
              ),
            ]
          : []),
      ],
      result: { kind: "unclaimed" },
    };
  },
});

// ---- W6: the receipt ---------------------------------------------------------------------------------------------------------------
export type ReceiptResult =
  | { kind: "noop"; reason: "not_found" | "not_in_flight" }
  | {
      kind: "admitted";
      /** The draft row left the store with its overlay (nothing more to wait for). */
      removed: boolean;
      displayed: number;
      held: boolean;
    };

interface ReceiptReads {
  draft: DraftRow | undefined;
  effects: PendingEffectRow[];
  dependants: DraftRow[];
}

/**
 * `admitReceipt`: conditions 0 to 4 of plan 5.5.4 (`decideReceipt`). It NEVER writes `cache`: the overlay is shown until a delta
 * page publishes the resource, or the live edge shows that nothing will.
 */
export const admitReceipt = guardedPlan<
  {
    captured: Captured;
    localId: LocalId;
    revision: number;
  },
  ReceiptReads,
  ReceiptResult
>({
  name: "data.admitReceipt",
  meta: { writer: "W6", guards: ["INC", "CLS", "EPO"], quota: null },
  scope: ["drafts", "draft_commands", "pending_effects"],
  durability: "strict",
  read: async (reader, input) => {
    const draft = await reader.get("drafts", input.localId);
    return {
      draft,
      effects: draft
        ? await collectIndex(
            reader,
            "pending_effects",
            "local_id",
            range.only(input.localId),
          )
        : [],
      dependants: draft
        ? await collectIndex(
            reader,
            "drafts",
            "depends_on",
            range.only(input.localId),
          )
        : [],
    };
  },
  decide: ({ sync, reads, input }) => {
    const decision = decideReceipt({
      draft: reads.draft,
      effects: reads.effects,
      dependants: reads.dependants,
      cacheStatus: sync.cache_status,
      requestSeq: sync.request_seq,
      revision: input.revision,
    });
    if (decision.kind === "noop") return { result: decision };
    const streaks = onLocalWriteSuccess(
      sync.local_write_streaks,
      `receipt:${input.localId}`,
    );
    return {
      writes: [
        ...(decision.draftPut ? [w.put("drafts", decision.draftPut)] : []),
        ...(decision.draftDelete
          ? [
              w.delete("drafts", decision.draftDelete),
              // A body never outlives its draft.
              w.delete("draft_commands", decision.draftDelete),
            ]
          : []),
        ...(decision.dependantPuts.length
          ? [w.bulkPut("drafts", decision.dependantPuts)]
          : []),
        ...(decision.effectPuts.length
          ? [w.bulkPut("pending_effects", decision.effectPuts)]
          : []),
        ...(decision.effectDeletes.length
          ? [w.bulkDelete("pending_effects", decision.effectDeletes)]
          : []),
      ],
      ...(streaks === sync.local_write_streaks
        ? {}
        : { sync: { ...sync, local_write_streaks: streaks } }),
      result: {
        kind: "admitted",
        removed: decision.draftDelete !== null,
        displayed: decision.displayed,
        held: decision.held,
      },
    };
  },
});

// ---- W7 and W8: every other answer -----------------------------------------------------------------------------------------------
export type OutcomeResult =
  | { kind: "noop"; reason: "not_found" | "not_in_flight" }
  | {
      kind: "recorded";
      status: DraftRow["status"];
      /** Drafts the outcome changed (a rejection also rejects its dependants). */
      changed: number;
      paused: boolean;
      /**
       * `recordFailureOfSend` only: the longest receipt streak it ended (absent: none), for the page that recorded it to tell the
       * account's other pages when it was a stop (R60, revision 38).
       */
      endedStreak?: number;
    };

interface OutcomeReads {
  draft: DraftRow | undefined;
  members: DraftRow[];
  effects: PendingEffectRow[];
  touched: Touched;
}

const emptyTouched = (): Touched => ({
  cache: new Map(),
  versions: new Map(),
  others: [],
});

/**
 * `recordOutcome`: the answer of the server (a `409`, a refusal, `slice_capacity`, a `5xx`) applied to an `in_flight` draft. A
 * rejection runs the cascade and the version-base recompute in this same transaction. Anything but an `in_flight` draft is a
 * no-op, so a duplicate or late answer changes nothing.
 */
export const recordOutcome = guardedPlan<
  {
    captured: Captured;
    localId: LocalId;
    outcome: RecordedOutcome;
    error: DraftError;
    now: number;
    nowIso: string;
  },
  OutcomeReads,
  OutcomeResult
>({
  name: "data.recordOutcome",
  meta: { writer: "W7", guards: ["INC", "CLS", "EPO"], quota: null },
  scope: ["drafts", "pending_effects", "resource_versions", "cache"],
  durability: "strict",
  read: async (reader, input) => {
    const draft = await reader.get("drafts", input.localId);
    if (draft === undefined)
      return { draft, members: [], effects: [], touched: emptyTouched() };
    if (draft.status !== "in_flight")
      return { draft, members: [draft], effects: [], touched: emptyTouched() };
    const members =
      input.outcome.kind === "rejected"
        ? await readCascade(reader, draft)
        : [draft];
    const rows =
      input.outcome.kind === "retry" ||
      input.outcome.kind === "defaults_changed"
        ? []
        : await readEffectsOf(reader, members);
    return {
      draft,
      members,
      effects: rows,
      touched:
        input.outcome.kind === "rejected"
          ? await readTouched(
              reader,
              touchedIds(members),
              new Set(members.map((member) => member.local_id)),
            )
          : emptyTouched(),
    };
  },
  decide: ({ sync, reads, input }) => {
    const decision = decideOutcome({
      draft: reads.draft,
      outcome: input.outcome,
      error: input.error,
      members: reads.members,
      effects: reads.effects,
      others: reads.touched.others,
      cache: reads.touched.cache,
      versions: reads.touched.versions,
      now: input.now,
      nowIso: input.nowIso,
    });
    if (decision.kind === "noop") return { result: decision };
    const streaks = onLocalWriteSuccess(
      sync.local_write_streaks,
      `receipt:${input.localId}`,
    );
    return {
      writes: [
        w.bulkPut("drafts", decision.draftPuts),
        ...(decision.effectDeletes.length
          ? [w.bulkDelete("pending_effects", decision.effectDeletes)]
          : []),
        ...(decision.versions.puts.length
          ? [w.bulkPut("resource_versions", decision.versions.puts)]
          : []),
        ...(decision.versions.deletes.length
          ? [w.bulkDelete("resource_versions", decision.versions.deletes)]
          : []),
      ],
      ...(streaks === sync.local_write_streaks
        ? {}
        : { sync: { ...sync, local_write_streaks: streaks } }),
      result: {
        kind: "recorded",
        status: decision.status,
        changed: decision.draftPuts.length,
        paused: decision.draftPuts.some(
          (draft) => draft.retry_state?.state === "paused",
        ),
      },
    };
  },
});

/**
 * `recordFailureOfSend`: a request that WAS issued and produced no answer (a network error, a time-out, an abort). A counted
 * failure of the draft class: back-off, then `paused` after the sustained duration. There is no response to guard, so the guard is
 * the incarnation.
 */
export const recordFailureOfSend = singletonPlan<
  {
    incarnationId: string;
    localId: LocalId;
    error: DraftError;
    now: number;
    nowIso: string;
  },
  DraftRow | undefined,
  OutcomeResult
>({
  name: "data.recordFailureOfSend",
  meta: { writer: "W8", guards: ["INC"], quota: null },
  scope: ["drafts"],
  durability: "strict",
  read: (reader, input) => reader.get("drafts", input.localId),
  decide: ({ sync, reads, input }) => {
    const decision = decideOutcome({
      draft: reads,
      outcome: { kind: "retry" },
      error: input.error,
      members: reads ? [reads] : [],
      effects: [],
      others: [],
      cache: new Map(),
      versions: new Map(),
      now: input.now,
      nowIso: input.nowIso,
    });
    if (decision.kind === "noop") return { result: decision };
    // The record of a request that got no answer is a local write of the draft's receipt class: when it lands it ends that class's
    // failures, in the same transaction, as `admitReceipt` and `recordOutcome` do (R46). The network failure budget is the draft's
    // own `retry_state`, a different thing, and is not touched here.
    const cleared =
      sync === undefined
        ? undefined
        : withoutStreaks(sync, [`receipt:${input.localId}`]);
    return {
      writes: [w.bulkPut("drafts", decision.draftPuts)],
      ...(cleared === undefined ? {} : { sync: cleared }),
      result: {
        kind: "recorded",
        status: decision.status,
        changed: decision.draftPuts.length,
        paused: decision.draftPuts.some(
          (draft) => draft.retry_state?.state === "paused",
        ),
        ...(cleared === undefined
          ? {}
          : {
              endedStreak: endedStreak(sync, [`receipt:${input.localId}`]),
            }),
      },
    };
  },
});

/**
 * `online`, or an explicit "Retry now" / "Retry": a paused or backing-off draft is resumed, a `blocked` one is queued again. It is
 * the ONLY thing that resumes a paused draft: never another draft's success (F-O10).
 */
export const resumeDrafts = singletonPlan<
  { incarnationId: string; localIds: readonly LocalId[] | "retrying" },
  DraftRow[],
  { resumed: LocalId[] }
>({
  name: "data.resumeDrafts",
  meta: { writer: "W8", guards: ["INC"], quota: null },
  scope: ["drafts"],
  durability: "strict",
  read: async (reader, input) => {
    // Every retrying draft is walked in windows by `apply` and never prefetched: what is in hand does not grow with them.
    if (input.localIds === "retrying") return [];
    const rows: DraftRow[] = [];
    for (const row of await bulkGetWindowed(reader, "drafts", input.localIds))
      if (row) rows.push(row);
    return rows;
  },
  decide: ({ reads }) => {
    const puts: DraftRow[] = [];
    for (const row of reads) {
      const next = resumeDraft(row);
      if (next !== null) puts.push(next);
    }
    return {
      writes: puts.length ? [w.bulkPut("drafts", puts)] : [],
      result: { resumed: puts.map((row) => row.local_id) },
    };
  },
  /**
   * "Retry now" for every retrying draft: the `in_flight` drafts that carry a retry state (a draft with none is not changed by
   * `resumeDraft`), a window of each state at a time by keyset (the writes below leave the index they are walked by, so an offset
   * would skip rows; a keyset meets every row once), written through the sink in the SAME transaction. Nothing is capped.
   */
  async apply(sink, { input, result, reader }) {
    if (input.localIds !== "retrying") return result;
    const resumed: LocalId[] = [];
    for (const state of ["paused", "backing_off"] as const) {
      const windows =
        Math.ceil(
          (await reader.count(
            "drafts",
            "retry_state.state",
            range.only(state),
          )) / WINDOW,
        ) + 1;
      let after: string | undefined;
      for (let at = 0; at < windows; at += 1) {
        const rows = await reader.pageByKey(
          "drafts",
          "retry_state.state",
          state,
          {
            ...(after === undefined ? {} : { after }),
            match: { status: "in_flight" },
            limit: WINDOW,
          },
        );
        const puts: DraftRow[] = [];
        for (const row of rows) {
          const next = resumeDraft(row);
          if (next !== null) puts.push(next);
        }
        if (puts.length > 0) await sink.bulkPut("drafts", puts);
        for (const put of puts) resumed.push(put.local_id);
        const last = rows[rows.length - 1];
        if (rows.length < WINDOW || last === undefined) break;
        after = last.local_id;
      }
    }
    return { resumed: resumed.sort() };
  },
});

// ---- reads ---------------------------------------------------------------------------------------------------------------------
// Every read below touches HEADERS only (decision D-23: a draft's body is in `draft_commands` and is read for one draft at a time),
// and asks the store's indexes for what it needs instead of scanning the queue: the oldest sendable drafts of a status, the paused
// and the reviewing ones, the drafts that share a target, the counts of each status. The work of one read is bounded by a window,
// never by the length of the queue.

export interface DispatchWindow {
  /** A wipe is under way: nothing is sent. */
  closing: boolean;
  /** The first eligible draft in queue order among the candidates examined, or null. */
  pick: DraftRow | null;
  /**
   * Waits for the person or for a back-off, counted over the WHOLE queue by index (never only the rows examined): the dispatcher's
   * visible state ("some changes need Retry now", "trying again") and its next wake come from these.
   */
  selection: Pick<Selection, "wakeAt" | "paused" | "backingOff" | "holdFrom">;
  /** Sendable candidates examined that were blocked behind another draft (a shared target, an unfinished dependency, a hold). */
  blocked: number;
  /**
   * The `created_seq` to continue from when the window was exhausted with no pick and more candidates follow, else null. The
   * dispatcher carries it across turns, so a long run of retained conflicts and blocked drafts cannot starve one that is behind it.
   */
  next: number | null;
  /**
   * The drafts whose own local writes failed three times (the durable streak of `draft:<id>` or `receipt:<id>`, or the account's
   * fallback marker the dispatcher passed in) and still exist: left alone until "Try again", restored on a cold start.
   */
  stopped: LocalId[];
  /**
   * How many consecutive failures of THIS read (the operation `queue`) the record holds. This read just succeeded, so the dispatcher
   * ends them when it is not zero (R46): the count is of consecutive failures, and a success is not one.
   */
  queueFailures: number;
  /**
   * The version of the failure that stands under each of these operations in the same snapshot as the read (R53, revision 32): the
   * queue read's own, and the two operations of every stopped draft. An operation with no streak is absent. A reset the dispatcher
   * decides on what this read showed carries the version it saw, so a failure recorded after the read is not ended by it.
   */
  failureVersions: Readonly<Record<string, number>>;
}

/** The version of the failure under each of `operations` that has one, in the snapshot `sync` is. */
function failureVersionsOf(
  sync: SyncStateRow | undefined,
  operations: readonly string[],
): Record<string, number> {
  const versions: Record<string, number> = {};
  if (sync === undefined) return versions;
  for (const operation of operations) {
    const version = failureVersion(sync, operation);
    if (version !== null) versions[operation] = version;
  }
  return versions;
}

/** The drafts a local-write stop names, from the durable streaks and the fallback markers. */
export function stoppedDrafts(
  streaks: Readonly<Record<string, number>>,
  markerOperations: readonly string[] = [],
  after: number = DATA_CONFIG.localWritePauseAfter,
): LocalId[] {
  const ids = new Set<LocalId>();
  const take = (operation: string): void => {
    const draft = operationDraft(operation);
    if (draft !== null) ids.add(draft);
  };
  for (const [operation, count] of Object.entries(streaks))
    if (count >= after) take(operation);
  for (const operation of markerOperations) take(operation);
  return [...ids];
}

interface WindowReads {
  holdFrom: number | null;
  stopped: LocalId[];
  /**
   * The drafts that wait for the person (a defaults review, or paused: counted once each), the drafts waiting out a back-off and the
   * earliest instant one of them is tried again: aggregated over the WHOLE queue a window at a time, never held as rows (R21).
   */
  needsPerson: number;
  backingOff: number;
  wakeAt: number | null;
  /** Candidates in queue order, each with the facts that decide it, up to and including the first the pure rule picks. */
  examined: Array<{ row: DraftRow; facts: CandidateFacts }>;
  next: number | null;
}

const FAR = Number.MAX_SAFE_INTEGER;

/**
 * The dispatcher's read (plan 5.5.3). It asks the `[status+created_seq]` index for the oldest `queued` and `in_flight` drafts after
 * `after`, `windowSize` at a time, and for each decides eligibility from the drafts it depends on and the drafts that share a target
 * with it (`candidateEligibility`), stopping at the first eligible one. Drafts that cannot be sent and cannot block anyone (the
 * conflicts, a rejected one, an acknowledged one waiting for a page) are never read at all, so 500 retained conflicts in front of an
 * independent draft cost nothing; and when a window of candidates is exhausted with no pick, `next` lets the dispatcher continue
 * from there on its next turn, so no draft is out of reach however long the queue is.
 */
export const readDispatchWindow = readPlan<
  {
    incarnationId: string;
    now: number;
    blockedUntil: ReadonlyMap<LocalId, number>;
    /** Examine candidates after this `created_seq` (a turn that continues an earlier one); omitted: from the oldest. */
    after?: number;
    windowSize?: number;
    /** The operations the account's fallback markers name (`localStorage`), read by the dispatcher in its own step. */
    markerOperations?: readonly string[];
  },
  WindowReads,
  DispatchWindow
>({
  name: "data.readDispatchWindow",
  scope: ["drafts"],
  read: async (reader, input, sync) => {
    const size = input.windowSize ?? DATA_CONFIG.queueWorkingSet;
    // The drafts a stop names that still exist: as many as the queue has, so asked a window at a time and reduced to the ids as it is
    // read (R21, revision 10: a population of stops was bulk-read whole, 501 headers in one read, whatever the window).
    const stopped = await existingDrafts(
      reader,
      stoppedDrafts(sync?.local_write_streaks ?? {}, input.markerOperations),
      size,
    );
    const blocked = new Map(input.blockedUntil);
    for (const id of stopped) blocked.set(id, Number.POSITIVE_INFINITY);

    // Reviewing drafts hold the queue behind them (D-19) and need the person; paused and backing-off drafts are the dispatcher's
    // visible state and its next wake. Each has its own small index, walked a window at a time and REDUCED as it is read: a count, a
    // minimum, never the rows (R21), so 501 paused or 501 reviewing drafts hold no more than one window.
    let holdFrom: number | null = null;
    let needsPerson = 0;
    await walkIndex(
      reader,
      "drafts",
      "review_block.kind",
      range.all(),
      (row) => {
        if (!isSendableStatus(row.status)) return;
        needsPerson += 1;
        holdFrom =
          holdFrom === null || row.created_seq < holdFrom
            ? row.created_seq
            : holdFrom;
      },
    );
    // A paused draft that is also reviewing was counted above: each draft needs the person once.
    await walkIndex(
      reader,
      "drafts",
      "retry_state.state",
      range.only("paused"),
      (row) => {
        if (isSendableStatus(row.status) && row.review_block === null)
          needsPerson += 1;
      },
    );
    let backingOff = 0;
    let wakeAt: number | null = null;
    await walkIndex(
      reader,
      "drafts",
      "retry_state.state",
      range.only("backing_off"),
      (row) => {
        if (!isSendableStatus(row.status) || row.review_block !== null) return;
        const notBefore =
          blocked.get(row.local_id) ?? durableNotBefore(row, DATA_CONFIG);
        if (notBefore > input.now) {
          backingOff += 1;
          if (Number.isFinite(notBefore))
            wakeAt = wakeAt === null ? notBefore : Math.min(wakeAt, notBefore);
        }
      },
    );

    const context = { now: input.now, holdFrom, blockedUntil: blocked };
    const examined: WindowReads["examined"] = [];
    const lowest = input.after ?? 0;
    let next: number | null = null;
    // The two sendable statuses are two runs of one index: read `size` of each after `lowest`, merge by `created_seq`.
    const after = (status: DraftRow["status"]) =>
      range.between([status, lowest], [status, FAR], { lowerOpen: true });
    const queued = await reader.byIndex(
      "drafts",
      "[status+created_seq]",
      after("queued"),
      size,
    );
    const inFlight = await reader.byIndex(
      "drafts",
      "[status+created_seq]",
      after("in_flight"),
      size,
    );
    const candidates = [...queued, ...inFlight]
      .sort((a, b) => a.created_seq - b.created_seq)
      .slice(0, size);
    // More candidates follow when either run was cut off at `size` beyond what this window took.
    const moreAfter =
      queued.length >= size ||
      inFlight.length >= size ||
      queued.length + inFlight.length > candidates.length;
    // The earliest unsettled draft of each target is read once per read, however many candidates share it.
    const earliest = new Map<ResourceId, DraftRow | null>();
    for (const row of candidates) {
      const facts = await factsOf(reader, row, earliest);
      examined.push({ row, facts });
      if (candidateEligibility(row, context, facts).verdict === "eligible")
        break;
    }
    const last = examined[examined.length - 1];
    const picked =
      last !== undefined &&
      candidateEligibility(last.row, context, last.facts).verdict ===
        "eligible";
    if (!picked && moreAfter && last !== undefined) next = last.row.created_seq;
    return {
      holdFrom,
      stopped,
      needsPerson,
      backingOff,
      wakeAt,
      examined,
      next,
    };
  },
  decide: ({ sync, reads, input }) => {
    const blocked = new Map(input.blockedUntil);
    for (const id of reads.stopped) blocked.set(id, Number.POSITIVE_INFINITY);
    const context = {
      now: input.now,
      holdFrom: reads.holdFrom,
      blockedUntil: blocked,
    };
    let pick: DraftRow | null = null;
    let blockedBehind = 0;
    for (const { row, facts } of reads.examined) {
      const verdict = candidateEligibility(row, context, facts).verdict;
      if (verdict === "eligible") {
        pick = row;
        break;
      }
      if (verdict === "waiting_on_draft" || verdict === "held")
        blockedBehind += 1;
    }
    // A draft left alone after its own local writes stopped waits for nobody but the person; it is not a back-off.
    return {
      closing: sync?.draft_fence?.closing === true,
      pick,
      selection: {
        wakeAt: reads.wakeAt,
        paused: reads.needsPerson,
        backingOff: reads.backingOff,
        holdFrom: reads.holdFrom,
      },
      blocked: blockedBehind,
      next: pick === null ? reads.next : null,
      stopped: reads.stopped,
      queueFailures: sync?.local_write_streaks[QUEUE_OPERATION] ?? 0,
      failureVersions: failureVersionsOf(sync, [
        QUEUE_OPERATION,
        ...reads.stopped.flatMap((id) => draftOperations(id)),
      ]),
    };
  },
});

/**
 * The facts that decide one candidate, by index and BOUNDED: the headers it depends on (a handful), and, for each of its targets, the
 * earliest unsettled draft that has it (`readEarliestSharing`: a window at a time, once per target per read, reduced to one row). The
 * rule only ever asks whether a draft that is not terminal and is OLDER than the candidate shares one of its targets, and the earliest
 * of them answers exactly that, so the whole population of drafts that share a target is never held, for any candidate.
 */
async function factsOf(
  reader: Reader,
  row: DraftRow,
  earliest: Map<ResourceId, DraftRow | null>,
): Promise<CandidateFacts> {
  const dependencies = new Map<LocalId, DraftRow>();
  for (const found of await bulkGetWindowed(reader, "drafts", row.depends_on))
    if (found) dependencies.set(found.local_id, found);
  return {
    dependencies,
    sharing: await readEarliestSharing(reader, row.index_targets, earliest),
  };
}

/** The durable failure state of one draft operation: how many consecutive failures, and which failure (its version). */
export interface LocalWriteRecord {
  operation: string;
  streak: number;
  version: number;
}

/**
 * The draft operations (`draft:<id>`, `receipt:<id>`) that hold a durable failure streak, with the version of the failure each stands
 * for (R53, revision 32). A caller takes the stops from the streaks that reached the bound, and keeps the versions of them all: a
 * reset it decides on this read carries the version it saw. READONLY: one snapshot.
 */
export const readLocalWriteStops = readPlan<
  { incarnationId: string },
  null,
  LocalWriteRecord[]
>({
  name: "data.readLocalWriteStops",
  scope: [],
  read: async () => null,
  decide: ({ sync }) =>
    Object.entries(sync?.local_write_streaks ?? {})
      .filter(
        ([operation, count]) => count > 0 && operationDraft(operation) !== null,
      )
      .map(([operation, streak]) => ({
        operation,
        streak,
        version:
          sync === undefined ? 0 : (failureVersion(sync, operation) ?? 0),
      })),
});

/** One WINDOW of the visible queue: the working set the screen holds and keeps live, never the rows it has been through. */
export interface QueuePage {
  /** At most `limit` drafts that appear in the queue, in `created_seq` order, starting after the window's cursor. */
  rows: DraftRow[];
  /** More visible drafts follow this window; the person asks for them (the next window). */
  more: boolean;
  /** This is not the first window: visible drafts precede it (the previous window). */
  previous: boolean;
  /** The cursor the NEXT window starts after (the `created_seq` of this window's last row), or null when it has no rows. */
  next: number | null;
  /** For each row, how many drafts name it in `depends_on` (the discard confirmation says so), by the `depends_on` index. */
  dependants: Record<LocalId, number>;
}

/**
 * The visible queue, one window at a time (Q9: 100-row working sets, further records through pagination). It walks `created_seq`
 * from the window's cursor, in chunks, and keeps the drafts that appear in a tab (`isQueueVisible`), stopping once it has `limit` and
 * knows whether another follows: so a refresh of the window reads that window (and the rows the tabs hide that fall in it), never
 * the rows before it, and what is held is `limit` rows, whichever window is shown. Headers only; the tab counts come from
 * `readQueueSummary`, which counts by index and does not depend on how many rows are loaded.
 */
export const readQueuePage = readPlan<
  { incarnationId: string; limit: number; after?: number | null },
  {
    rows: DraftRow[];
    more: boolean;
    previous: boolean;
    next: number | null;
    dependants: Record<LocalId, number>;
  },
  QueuePage
>({
  name: "data.readQueuePage",
  scope: ["drafts"],
  read: async (reader, input) => {
    const chunk = Math.max(input.limit, 50);
    const visible: DraftRow[] = [];
    const start = input.after ?? null;
    let after: number | null = start;
    while (visible.length <= input.limit) {
      const rows: DraftRow[] = await reader.byIndex(
        "drafts",
        "created_seq",
        after === null ? range.all() : range.atLeast(after, true),
        chunk,
      );
      for (const row of rows) if (isQueueVisible(row)) visible.push(row);
      const tail = rows[rows.length - 1];
      if (rows.length < chunk || tail === undefined) break;
      after = tail.created_seq;
    }
    const rows = visible.slice(0, input.limit);
    const dependants: Record<LocalId, number> = {};
    for (const row of rows) {
      const n = await reader.count(
        "drafts",
        "depends_on",
        range.only(row.local_id),
      );
      if (n > 0) dependants[row.local_id] = n;
    }
    return {
      rows,
      more: visible.length > input.limit,
      previous: start !== null,
      next: rows[rows.length - 1]?.created_seq ?? null,
      dependants,
    };
  },
  decide: ({ reads }) => reads,
});

/** The drafts that need a decision, oldest first, a bounded page (the conflict inbox). */
export interface ConflictPage {
  rows: Array<{
    draft: DraftRow;
    kind: "version_conflict" | "operation_conflict" | "defaults_review";
  }>;
  more: boolean;
}

export const readConflicts = readPlan<
  { incarnationId: string; limit: number },
  ConflictPage["rows"],
  ConflictPage
>({
  name: "data.readConflicts",
  scope: ["drafts"],
  read: async (reader, input) => {
    const found: ConflictPage["rows"] = [];
    // The oldest `limit + 1` are all that is shown (and the one more says "more"), so the population of each kind is walked a window at
    // a time and only that many are kept, the oldest by `created_seq`: the defaults reviews have no `created_seq` order of their own.
    const keep = input.limit + 1;
    const offer = (
      draft: DraftRow,
      kind: ConflictPage["rows"][number]["kind"],
    ): void => {
      found.push({ draft, kind });
      found.sort((a, b) => a.draft.created_seq - b.draft.created_seq);
      if (found.length > keep) found.length = keep;
    };
    for (const kind of ["version_conflict", "operation_conflict"] as const)
      for (const draft of await reader.byIndex(
        "drafts",
        "[status+created_seq]",
        range.between([kind, 0], [kind, FAR]),
        input.limit + 1,
      ))
        offer(draft, kind);
    await walkIndex(
      reader,
      "drafts",
      "review_block.kind",
      range.all(),
      (draft) => {
        if (isSendableStatus(draft.status)) offer(draft, "defaults_review");
      },
    );
    return found;
  },
  decide: ({ reads, input }) => ({
    rows: reads.slice(0, input.limit),
    more: reads.length > input.limit,
  }),
});

/**
 * The summary counts, from the indexes (plan 5.5.7): a count of each status, the reviewing drafts by their own index and the
 * acknowledged drafts (the only status whose flags decide membership), never the queue. Exact, whatever the length of the queue.
 */
export const readQueueSummary = readPlan<
  { incarnationId: string },
  {
    queued: number;
    inFlight: number;
    versionConflict: number;
    operationConflict: number;
    rejected: number;
    blocked: number;
    reviewing: number;
    held: number;
  },
  QueueSummary
>({
  name: "data.readQueueSummary",
  scope: ["drafts"],
  read: async (reader) => {
    // Counted a window at a time (R21): the reviewing drafts and the acknowledged drafts that are still held are populations of any size.
    let reviewing = 0;
    await walkIndex(
      reader,
      "drafts",
      "review_block.kind",
      range.all(),
      (row) => {
        if (isSendableStatus(row.status)) reviewing += 1;
      },
    );
    let held = 0;
    await walkIndex(
      reader,
      "drafts",
      "status",
      range.only("acknowledged"),
      (row) => {
        if (row.held_pending_cache || row.unavailable_outcome) held += 1;
      },
    );
    return {
      queued: await reader.count("drafts", "status", range.only("queued")),
      inFlight: await reader.count("drafts", "status", range.only("in_flight")),
      versionConflict: await reader.count(
        "drafts",
        "status",
        range.only("version_conflict"),
      ),
      operationConflict: await reader.count(
        "drafts",
        "status",
        range.only("operation_conflict"),
      ),
      rejected: await reader.count("drafts", "status", range.only("rejected")),
      blocked: await reader.count("drafts", "status", range.only("blocked")),
      reviewing,
      held,
    };
  },
  decide: ({ reads }) =>
    summaryFromCounts({
      waiting: reads.queued + reads.inFlight - reads.reviewing,
      needsDecision:
        reads.versionConflict +
        reads.operationConflict +
        reads.rejected +
        reads.blocked +
        reads.reviewing,
      held: reads.held,
    }),
});

/** One resource with the overlay of its admitted changes (plan 5.5.6). */
export const readMerged = readPlan<
  { incarnationId: string; id: ResourceId; after?: number | null },
  {
    base: CacheRow | undefined;
    effects: PendingEffectRow[];
    drafts: DraftWithCommand[];
    total: number;
    next: number | null;
  },
  MergedResource
>({
  name: "data.readMerged",
  scope: ["cache", "pending_effects", "drafts", "draft_commands"],
  read: async (reader, input) => {
    const base = await reader.get("cache", input.id);
    // Only the queued and in-flight drafts of THIS resource that the cache does not know yet are projected, so only their bodies are
    // read; a resource the cache holds projects none, so the drafts that target it are not read at all. For one it does not, they are
    // walked a window at a time of HEADERS and folded into the OLDEST window of them with their exact number (R21, revision 10: a new
    // resource with many saved edits queued behind it was collected whole and its bodies joined in one read), and only that window's
    // bodies are read: at most one window, however many drafts there are.
    const oldest = new OldestDrafts(WINDOW, input.after ?? null);
    if (base === undefined)
      await walkIndex(
        reader,
        "drafts",
        "index_targets",
        range.only(input.id),
        (draft) => {
          if (
            (draft.status === "queued" || draft.status === "in_flight") &&
            draft.target_resource_ids.includes(input.id)
          )
            oldest.add(draft);
        },
      );
    const creates = oldest.rows();
    const bodies = await bulkGetWindowed(
      reader,
      "draft_commands",
      creates.map((draft) => draft.local_id),
    );
    return {
      base,
      // The changes of one resource, as rows (the detail view lists them): read a window at a time.
      effects: await collectIndex(
        reader,
        "pending_effects",
        "resource_id",
        range.only(input.id),
      ),
      drafts: creates.flatMap((draft, index) => {
        const body = bodies[index];
        return body ? [{ ...draft, command: body.command }] : [];
      }),
      total: oldest.total,
      next: oldest.next,
    };
  },
  decide: ({ reads }) =>
    mergeResource(reads.base ?? null, reads.effects, reads.drafts, undefined, {
      total: reads.total,
      next: reads.next,
    }),
});

/**
 * One resource as a LIST shows it: the cached row and the row with every outstanding change over it applied. It carries the NUMBER of
 * those changes, not the changes: a list of 100 must not hold every change of every one of them (R14). The changes of one resource,
 * as rows, are `readMerged`'s (`useCachedResource`).
 */
export interface ListedResource {
  base: CacheRow;
  /** Equal to `mergeResource(base, every effect of the resource).merged`. */
  merged: CacheRow;
  /** How many outstanding changes lie over the resource (a resource with any shows as pending). */
  pending: number;
}

/**
 * A page of the list. `next` is the cursor of the FOLLOWING page (pass it as `after`), or null when this is the last: the records
 * beyond the page stay reachable, a page at a time (Q9).
 */
export interface ResourcePage {
  rows: ListedResource[];
  next: ResourceId | null;
}

/** The size of the page asked for: never above the approved bound (Q9: 100 rows), never below one, and the bound when it is not a number. */
export const listPageSize = (limit?: number): number =>
  Math.max(
    1,
    Math.min(
      DATA_CONFIG.listPage,
      limit === undefined || Number.isNaN(limit)
        ? DATA_CONFIG.listPage
        : Math.floor(limit),
    ),
  );

/**
 * A PAGE of the cached resources of one kind (optionally under one parent), each with the overlay of its admitted changes (R14).
 *
 * The page is a keyset walk of the `kind` (or `parent_id`) index in primary-key order: at most `limit` rows after the cursor `after`
 * (default and largest: `listPage`, 100); a full page asks for one more row only to know whether it is the last. Nothing but the page
 * is read from `cache`, whatever the size of the list, and what the walk skips (rows of another kind under a parent) is skipped inside
 * the store. The overlay is read only for the resources of the page, in windows (`readOverlays`), so the effects of every other
 * resource are never touched and one resource with a very long queue of changes is folded a window at a time. A read is ONE
 * transaction, and a later page begins after the last row of this one, so a walk meets every row once however the list changes
 * between pages. Nothing is capped: every record is reachable and no outstanding change is dropped.
 */
export const readResourceList = readPlan<
  {
    incarnationId: string;
    kind: ResourceKind;
    parentId?: string;
    after?: ResourceId | null;
    limit?: number;
  },
  { rows: CacheRow[]; more: boolean; overlays: Map<ResourceId, Overlay> },
  ResourcePage
>({
  name: "data.readResourceList",
  scope: ["cache", "pending_effects"],
  read: async (reader, input) => {
    const limit = listPageSize(input.limit);
    const index = input.parentId === undefined ? "kind" : "parent_id";
    const key = input.parentId === undefined ? input.kind : input.parentId;
    const match =
      input.parentId === undefined ? {} : { match: { kind: input.kind } };
    const rows = await reader.pageByKey("cache", index, key, {
      ...(input.after === undefined || input.after === null
        ? {}
        : { after: input.after }),
      ...match,
      limit,
    });
    // Whether the page is the last: a full page asks for ONE row after it, so no read ever returns more than the page.
    const last = rows[rows.length - 1];
    const more =
      last !== undefined &&
      rows.length === limit &&
      (
        await reader.pageByKey("cache", index, key, {
          after: last.id,
          ...match,
          limit: 1,
        })
      ).length > 0;
    return {
      rows,
      more,
      overlays: await readOverlays(
        reader,
        rows.map((row) => row.id),
        DATA_CONFIG.queueWorkingSet,
      ),
    };
  },
  decide: ({ reads }) => ({
    rows: reads.rows.map((base) => {
      const overlay = reads.overlays.get(base.id) as Overlay;
      return {
        base,
        merged: applyOverlay(base, overlay),
        pending: overlay.pending,
      };
    }),
    next:
      reads.more && reads.rows.length > 0
        ? (reads.rows[reads.rows.length - 1] as CacheRow).id
        : null,
  }),
});
