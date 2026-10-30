import type {
  Captured,
  MaterialiseDiscovery,
  MaterialiseSequenceRow,
} from "../model/types";
import { range, w } from "../store/port";
import { guardedPlan, readPlan } from "./builders";

/**
 * W27 (WEB-10c, D-10c-1/2): the catch-up sequences in `materialise_sequences`. The data layer stores and compares rows; it knows no task
 * semantics. Every write is a COMPARE-AND-SET: it applies only if the stored row is still the one the caller decided on (its
 * generation, phase, read sequence and attempt key; or absent), so two runners, a reload or a late answer can never overwrite a newer
 * decision. A write that loses writes nothing and says what is stored (`stale`), so the caller adopts it.
 *
 * Every write is guarded as a response-derived one (INC, CLS, EPO, and the service's G1/G2/G5 through `AccountService.commit`), the
 * person's "Try again" included: an answer of a former account, epoch or database incarnation, or one that lands while a wipe is closing,
 * writes nothing.
 *
 * RETENTION (WEB-10c revision 5, reviews R24 and R25; WEB-04 §5.8): a row is removed only when its OWN need is satisfied: its sequence
 * found the position covering its day, or a later day's sequence of the task found a position that covers it too
 * (`deleteSatisfiedSequences`, each row compared as the caller decided on it). A stop (the bound, no progress, the horizon, capacity, a
 * refusal, no answer) is kept with its attempt, whatever later day begins. So rows are no longer bounded by the number of tasks: a NEW
 * row grows the store, and the caller admits it through the origin's quota ledger first (`leaseLive`; `admitted: false` when the ledger
 * refused it); a growth not admitted is `refused`, with nothing written. Replacing or deleting a row needs no admission.
 */
export type SequenceKey = Pick<
  MaterialiseSequenceRow,
  "task_id" | "through_date"
>;

/**
 * What the caller decided on: the key absent (`null`), or the stored row's identity of the moment. Revision 4 (review R20): with its
 * `revision`, which every write moves, so a row that returns to the same phase, read and attempt (a fresh budget that stopped again the
 * same way) is still not the row an earlier decision saw.
 */
export type SequenceExpectation = null | {
  sequence_generation: string;
  phase: MaterialiseSequenceRow["phase"];
  read_seq: number;
  attempt_key: string | null;
  revision: number;
};

export type SequenceWrite =
  | { kind: "written"; stored: MaterialiseSequenceRow | null }
  /** The stored row is not the one expected: nothing was written. */
  | { kind: "stale"; stored: MaterialiseSequenceRow | null }
  /** A new row whose growth the quota ledger did not admit (revision 5): nothing was written. */
  | { kind: "refused"; stored: null };

/** What one new row is admitted at (revision 5): its fields, an attempt's key and body, and a stop's request id. */
export const SEQUENCE_ROW_BYTES = 1024;

/** The most rows a read of the store returns (the queue's working set): a task has at most a few, the account at most one per task. */
export const SEQUENCE_WINDOW = 100;

const keyOf = (key: SequenceKey): [string, string] => [
  key.task_id,
  key.through_date,
];

/** A row's revision as stored: absent (a row of an earlier build) or unreadable is 0, so the next write moves it to 1. */
export const sequenceRevision = (
  row: Pick<MaterialiseSequenceRow, "revision">,
) =>
  Number.isSafeInteger(row.revision) && (row.revision as number) >= 0
    ? (row.revision as number)
    : 0;

export function matchesExpectation(
  stored: MaterialiseSequenceRow | undefined,
  expected: SequenceExpectation,
): boolean {
  if (expected === null) return stored === undefined;
  return (
    stored !== undefined &&
    stored.sequence_generation === expected.sequence_generation &&
    stored.phase === expected.phase &&
    stored.read_seq === expected.read_seq &&
    (stored.attempt?.key ?? null) === expected.attempt_key &&
    sequenceRevision(stored) === sequenceRevision(expected)
  );
}

export const writeMaterialiseSequence = guardedPlan<
  {
    captured: Captured;
    key: SequenceKey;
    expected: SequenceExpectation;
    /** The replacement row (its key must be `key`), or `null` to delete: the sequence is over. */
    next: MaterialiseSequenceRow | null;
    /** The quota ledger refused a new row's growth (revision 5). */
    admitted?: boolean;
    /** The reservation's `live()`, for a new row; absent: not admitted through the ledger (a test of the plan alone). */
    leaseLive?: () => boolean;
  },
  // Wrapped: a guarded plan reads `undefined` as "no singleton", and an absent row is an answer here.
  { row: MaterialiseSequenceRow | undefined },
  SequenceWrite
>({
  name: "data.writeMaterialiseSequence",
  // A row of a few hundred bytes per task and day while it catches up: a new one is admitted as a cache write (revision 5).
  meta: { writer: "W27", guards: ["INC", "CLS", "EPO"], quota: "cache" },
  scope: ["materialise_sequences"],
  durability: "strict",
  read: async (reader, input) => ({
    row: await reader.get("materialise_sequences", keyOf(input.key)),
  }),
  decide: ({ reads: { row: reads }, input }) => {
    const stored = reads ?? null;
    if (!matchesExpectation(reads, input.expected))
      return { result: { kind: "stale", stored } };
    const next = input.next;
    if (next === null)
      return {
        writes:
          reads === undefined
            ? []
            : [w.delete("materialise_sequences", keyOf(input.key))],
        result: { kind: "written", stored: null },
      };
    if (
      next.task_id !== input.key.task_id ||
      next.through_date !== input.key.through_date
    )
      return { result: { kind: "stale", stored } };
    if (
      reads === undefined &&
      (input.admitted === false ||
        (input.leaseLive !== undefined && !input.leaseLive()))
    )
      return { result: { kind: "refused", stored: null } };
    // The revision is the store's, never the caller's (review R20): one more than the row replaced, 1 for a new one. A revision that
    // cannot move any more is not overwritten (nothing is written; the caller adopts what is stored).
    const revision = reads === undefined ? 0 : sequenceRevision(reads);
    if (revision >= Number.MAX_SAFE_INTEGER)
      return { result: { kind: "stale", stored } };
    const row: MaterialiseSequenceRow = { ...next, revision: revision + 1 };
    return {
      writes: [w.put("materialise_sequences", row)],
      result: { kind: "written", stored: row },
    };
  },
});

/**
 * Revision 5 (reviews R24 and R25, WEB-04 §5.8): removes rows of ONE task whose need the caller established is SATISFIED (a position read
 * that covers each row's day; the caller decides, the data layer only compares), each only while it is still the row the caller decided
 * on (its expectation, revision included): a row another page lifted, advanced or made again since is left as it is. At most
 * `SEQUENCE_WINDOW` rows per call. Removing rows needs no admission.
 */
export const deleteSatisfiedSequences = guardedPlan<
  {
    captured: Captured;
    task_id: string;
    rows: ReadonlyArray<{
      through_date: string;
      expected: Exclude<SequenceExpectation, null>;
    }>;
  },
  Array<MaterialiseSequenceRow | undefined>,
  { removed: number }
>({
  name: "data.deleteSatisfiedSequences",
  meta: { writer: "W27", guards: ["INC", "CLS", "EPO"], quota: null },
  scope: ["materialise_sequences"],
  durability: "strict",
  read: async (reader, input) => {
    if (input.rows.length > SEQUENCE_WINDOW)
      throw new Error(
        "deleteSatisfiedSequences: more rows than one write admits",
      );
    const out: Array<MaterialiseSequenceRow | undefined> = [];
    for (const row of input.rows)
      out.push(
        await reader.get("materialise_sequences", [
          input.task_id,
          row.through_date,
        ]),
      );
    return out;
  },
  decide: ({ reads, input }) => {
    const gone = input.rows.filter((row, i) =>
      matchesExpectation(reads[i], row.expected),
    );
    return {
      writes: gone.map((row) =>
        w.delete("materialise_sequences", [input.task_id, row.through_date]),
      ),
      result: { removed: gone.length },
    };
  },
});

export const readMaterialiseSequence = readPlan<
  { incarnationId: string; key: SequenceKey },
  MaterialiseSequenceRow | undefined,
  MaterialiseSequenceRow | null
>({
  name: "data.readMaterialiseSequence",
  scope: ["materialise_sequences"],
  read: (reader, input) =>
    reader.get("materialise_sequences", keyOf(input.key)),
  decide: ({ reads }) => reads ?? null,
});

/** The sequences of one task (by its key range), or of the account, in key order: at most `SEQUENCE_WINDOW`. */
export const readMaterialiseSequences = readPlan<
  { incarnationId: string; taskId: string | null },
  MaterialiseSequenceRow[],
  MaterialiseSequenceRow[]
>({
  name: "data.readMaterialiseSequences",
  scope: ["materialise_sequences"],
  read: (reader, input) =>
    input.taskId === null
      ? reader.list("materialise_sequences", SEQUENCE_WINDOW)
      : reader.byIndex(
          "materialise_sequences",
          "[task_id+through_date]",
          range.between([input.taskId, ""], [input.taskId, "￿"]),
          SEQUENCE_WINDOW,
        ),
  decide: ({ reads }) => reads,
});

/**
 * The rows of one task a recovery read returns besides its exact days, unless the caller asks for more (revision 5): its latest days. A
 * screen that shows every retained stop asks for this many more each time the person asks for earlier days (revision 6, R28).
 */
export const TASK_SEQUENCE_ROWS = 8;
/** The most tasks one recovery read covers (a caller with more reads them in several reads). */
export const TASK_SEQUENCE_TASKS = 25;
/** The most further exact days of one task a recovery read looks up by key (revision 6, R28: a selected day, days a command asked for). */
export const TASK_SEQUENCE_DAYS = 8;

/**
 * What a recovery read found of one task (revision 5, review R24): the row of the exact day asked for (`target`: `null` absent; not asked:
 * `undefined`), its latest rows in key order (`TASK_SEQUENCE_ROWS`, or as many as asked), and whether those are ALL its rows (`complete`).
 * A row is reached by its own key, never because it is the latest: a later day (a horizon stop) cannot hide the day a screen works for.
 * Revision 6 (review R28): further exact days by key (`days`: each `null` when absent), so a selected day or a day a command asked for is
 * found however many later rows the task holds. Incomplete rows are never "no stop": the rest is reached by asking for more rows.
 */
export interface TaskSequences {
  target?: MaterialiseSequenceRow | null;
  days?: Record<string, MaterialiseSequenceRow | null>;
  rows: MaterialiseSequenceRow[];
  complete: boolean;
}

/** One task a recovery read is asked for (revision 6, R28: further exact `days` and how many latest `rows`). */
export interface TaskSequencesAsk {
  taskId: string;
  throughDate?: string;
  days?: readonly string[];
  rows?: number;
}

/**
 * Revision 5 (review R24; revision 4, review R21): the recovery rows of each named task, whatever else the account holds: the exact day
 * asked for, and the task's latest days. Bounded per read: at most `TASK_SEQUENCE_TASKS` tasks, each found with a count of its key range,
 * at most `TASK_SEQUENCE_ROWS` rows at its end and one row by key.
 */
export const readTaskSequences = readPlan<
  {
    incarnationId: string;
    tasks: ReadonlyArray<TaskSequencesAsk>;
  },
  Record<string, TaskSequences>,
  Record<string, TaskSequences>
>({
  name: "data.readTaskSequences",
  scope: ["materialise_sequences"],
  read: async (reader, input) => {
    if (input.tasks.length > TASK_SEQUENCE_TASKS)
      throw new Error("readTaskSequences: more tasks than one read admits");
    const out: Record<string, TaskSequences> = {};
    for (const { taskId, throughDate, days, rows: asked } of input.tasks) {
      if (out[taskId] !== undefined)
        throw new Error("readTaskSequences: a task asked for twice");
      const limit = asked ?? TASK_SEQUENCE_ROWS;
      if (!Number.isSafeInteger(limit) || limit < 1)
        throw new Error("readTaskSequences: rows must be a positive count");
      if (days !== undefined && days.length > TASK_SEQUENCE_DAYS)
        throw new Error("readTaskSequences: more days than one read admits");
      const span = range.between([taskId, ""], [taskId, "￿"]);
      const n = await reader.count(
        "materialise_sequences",
        "[task_id+through_date]",
        span,
      );
      // One transaction: the count and the latest rows agree, so a longer window is never a page that shifted (revision 6, R28).
      const rows =
        n === 0
          ? []
          : await reader.byIndex(
              "materialise_sequences",
              "[task_id+through_date]",
              span,
              limit,
              Math.max(0, n - limit),
            );
      const exact: Record<string, MaterialiseSequenceRow | null> = {};
      for (const day of days ?? [])
        exact[day] =
          (await reader.get("materialise_sequences", [taskId, day])) ?? null;
      out[taskId] = {
        rows,
        complete: n <= limit,
        ...(days === undefined ? {} : { days: exact }),
        ...(throughDate === undefined
          ? {}
          : {
              target:
                (await reader.get("materialise_sequences", [
                  taskId,
                  throughDate,
                ])) ?? null,
            }),
      };
    }
    return out;
  },
  decide: ({ reads }) => reads,
});

/**
 * WEB-10c revision 2 (review R13, design assessment DA-M1): the DISCOVERY of a task's catch-up (its first read, before its day is known,
 * so before any sequence row can exist) in `sync_state.materialise_discovery`, by task. A COMPARE-AND-SET like the rows: it applies only
 * while the stored entry is the one the caller decided on (absent, or its `retry`, `failures`, whether it is stopped and its `attempt`),
 * so a reload, another tab or a late answer of an earlier "Try again" or of an earlier read never overwrites a newer decision; a loss
 * writes nothing and says what is stored. Response-derived (the person's "Try again" included), so INC, CLS and EPO.
 *
 * Revision 3 (reviews R16 and R17, design assessment DA-M1): a first read is ADMITTED before it is sent: the caller writes the entry with
 * a fresh `attempt` (the read's identity, never reused), and each answer is recorded only over that very attempt, so an answer of a read
 * another page re-admitted since, or of a deleted and re-created entry, changes nothing. There is no fixed number of entries: an entry
 * that would ADD a task grows the singleton, so the caller admits it through the origin's quota ledger first (`leaseLive`, read where
 * this decides; `admitted: false` when the ledger refused), and a growth not admitted is `refused`, with nothing written and nothing sent.
 * Replacing a task's entry (its outcome, a "Try again") stays within the size admitted for it (`DISCOVERY_ENTRY_BYTES`). A success removes
 * the entry.
 */
export type DiscoveryWrite =
  | { kind: "written"; stored: MaterialiseDiscovery | null }
  | { kind: "stale"; stored: MaterialiseDiscovery | null }
  /** A new task's entry whose growth the quota ledger did not admit: nothing was written. */
  | { kind: "refused"; stored: null };

/**
 * What one task's entry is admitted at: its fields, a stop's reason, a request id of at most `DISCOVERY_REQUEST_ID` characters and,
 * since revision 10 (Decision B), its retry schedule (512 before it; the largest entry with a schedule is under 600 bytes).
 */
export const DISCOVERY_ENTRY_BYTES = 768;
export const DISCOVERY_REQUEST_ID = 128;

const isDiscovery = (value: unknown): value is MaterialiseDiscovery => {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    Number.isSafeInteger(v.retry) &&
    Number.isSafeInteger(v.failures) &&
    (v.attempt === undefined ||
      v.attempt === null ||
      (typeof v.attempt === "string" && v.attempt.length <= 64)) &&
    (v.stop === null ||
      (typeof v.stop === "object" &&
        v.stop !== null &&
        ((v.stop as { reason?: unknown }).reason === "unreachable" ||
          (v.stop as { reason?: unknown }).reason === "rejected")))
  );
};

/** One task's entry as stored (`null`: none, or one that does not read). */
export const discoveryOf = (
  entries: unknown,
  taskId: string,
): MaterialiseDiscovery | null => {
  if (typeof entries !== "object" || entries === null) return null;
  const value = (entries as Record<string, unknown>)[taskId];
  return isDiscovery(value) ? value : null;
};

/**
 * Revision 10 (Decision B): a discovery's retry schedule as compared (stored as given; the task slice validates it): two entries that
 * differ only in a deadline or an issue are not the same entry.
 */
const scheduleOf = ({ schedule: s }: MaterialiseDiscovery) =>
  typeof s === "object" && s !== null
    ? [
        s.issued,
        s.since,
        s.failures,
        s.next,
        s.server,
        s.unknown,
        s.seen,
        s.pause,
      ].join()
    : String(s);

const sameDiscovery = (
  a: MaterialiseDiscovery | null,
  b: MaterialiseDiscovery | null,
) =>
  a === null || b === null
    ? a === b
    : a.retry === b.retry &&
      a.failures === b.failures &&
      (a.stop === null) === (b.stop === null) &&
      (a.attempt ?? null) === (b.attempt ?? null) &&
      scheduleOf(a) === scheduleOf(b);

export const writeMaterialiseDiscovery = guardedPlan<
  {
    captured: Captured;
    task_id: string;
    expected: MaterialiseDiscovery | null;
    /** The replacement entry, or `null` to remove it (the discovery succeeded). */
    next: MaterialiseDiscovery | null;
    /** The quota ledger refused a new task's entry. */
    admitted?: boolean;
    /** The reservation's `live()`, for a new task's entry; absent: not admitted through the ledger (a test of the plan alone). */
    leaseLive?: () => boolean;
  },
  null,
  DiscoveryWrite
>({
  name: "data.writeMaterialiseDiscovery",
  meta: { writer: "W27", guards: ["INC", "CLS", "EPO"], quota: "cache" },
  scope: [],
  durability: "strict",
  read: async () => null,
  decide: ({ sync, input }) => {
    const entries = { ...(sync.materialise_discovery ?? {}) };
    const stored = discoveryOf(entries, input.task_id);
    if (!sameDiscovery(stored, input.expected))
      return { result: { kind: "stale", stored } };
    if (input.next === null) {
      if (!(input.task_id in entries))
        return { result: { kind: "written", stored: null } };
      delete entries[input.task_id];
    } else {
      if (
        !(input.task_id in entries) &&
        (input.admitted === false ||
          (input.leaseLive !== undefined && !input.leaseLive()))
      )
        return { result: { kind: "refused", stored: null } };
      entries[input.task_id] = input.next;
    }
    return {
      sync: { ...sync, materialise_discovery: entries },
      result: { kind: "written", stored: input.next },
    };
  },
});

/**
 * Revision 4 (review R20): the person's "Try again" as ONE compare-and-set of what it was pressed on: the task's stopped discovery entry
 * and the day's stopped sequence (either may be absent). Both still stand as seen and both are replaced, or nothing is written (`stale`),
 * so a lift never clears one stop and loses the other, and a press can never lift a later stop it did not see (the sequence's revision
 * moves on every write). A discovery lift replaces an existing entry (no growth); a sequence row is the fixed-size W27 row.
 *
 * Revision 6 (review R30): what the press expects of the discovery is ALWAYS compared, separately from what it writes: `stopped` (that
 * very entry, replaced by `next`) or `no_stop` (the screen showed no discovery stop: one recorded since, here or in another tab, makes the
 * whole lift stale, so the sequence is not lifted beside a stop the person never saw). A missing replacement never means "not checked".
 */
export type DiscoveryExpectation =
  | {
      kind: "stopped";
      expected: MaterialiseDiscovery;
      next: MaterialiseDiscovery;
    }
  /** No STOPPED discovery entry (an entry still working, with no stop, is not one). */
  | { kind: "no_stop" };

export interface MaterialiseLift {
  task_id: string;
  discovery: DiscoveryExpectation;
  sequence: {
    key: SequenceKey;
    expected: Exclude<SequenceExpectation, null>;
    next: MaterialiseSequenceRow;
  } | null;
}

export const liftMaterialiseStops = guardedPlan<
  MaterialiseLift & { captured: Captured },
  { row: MaterialiseSequenceRow | undefined },
  { kind: "written" } | { kind: "stale" }
>({
  name: "data.liftMaterialiseStops",
  meta: { writer: "W27", guards: ["INC", "CLS", "EPO"], quota: "cache" },
  scope: ["materialise_sequences"],
  durability: "strict",
  read: async (reader, input) => ({
    row:
      input.sequence === null
        ? undefined
        : await reader.get("materialise_sequences", keyOf(input.sequence.key)),
  }),
  decide: ({ sync, reads: { row }, input }) => {
    const stale = { result: { kind: "stale" as const } };
    const entries = { ...(sync.materialise_discovery ?? {}) };
    const lift = input.discovery;
    const current = discoveryOf(entries, input.task_id);
    // Every prerequisite is compared before anything is replaced: the discovery as expected (a stop, or none), then the sequence.
    if (lift.kind === "no_stop") {
      if (current?.stop) return stale;
    } else {
      if (!(input.task_id in entries) || !sameDiscovery(current, lift.expected))
        return stale;
      entries[input.task_id] = lift.next;
    }
    const writes = [];
    const seq = input.sequence;
    if (seq !== null) {
      const next = seq.next;
      const revision = row === undefined ? 0 : sequenceRevision(row);
      if (
        seq.key.task_id !== input.task_id ||
        next.task_id !== seq.key.task_id ||
        next.through_date !== seq.key.through_date ||
        !matchesExpectation(row, seq.expected) ||
        revision >= Number.MAX_SAFE_INTEGER
      )
        return stale;
      writes.push(
        w.put("materialise_sequences", { ...next, revision: revision + 1 }),
      );
    }
    return {
      writes,
      ...(lift.kind === "no_stop"
        ? {}
        : { sync: { ...sync, materialise_discovery: entries } }),
      result: { kind: "written" as const },
    };
  },
});

/** Every task's discovery entry (or one task's), as stored. */
export const readMaterialiseDiscovery = readPlan<
  { incarnationId: string },
  null,
  Record<string, MaterialiseDiscovery>
>({
  name: "data.readMaterialiseDiscovery",
  scope: [],
  read: async () => null,
  decide: ({ sync }) => {
    const out: Record<string, MaterialiseDiscovery> = {};
    for (const taskId of Object.keys(sync?.materialise_discovery ?? {})) {
      const entry = discoveryOf(sync?.materialise_discovery, taskId);
      if (entry !== null) out[taskId] = entry;
    }
    return out;
  },
});
