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
 * writes nothing. The rows are a few hundred bytes each, one per task with a sequence and day, and older ones of a task are pruned when a
 * newer one begins, so like `claimFormWriter` they are a fixed-size write, not admitted through the quota ledger (docs/data-layer.md).
 */
export type SequenceKey = Pick<
  MaterialiseSequenceRow,
  "task_id" | "through_date"
>;

/** What the caller decided on: the key absent (`null`), or the stored row's identity of the moment. */
export type SequenceExpectation = null | {
  sequence_generation: string;
  phase: MaterialiseSequenceRow["phase"];
  read_seq: number;
  attempt_key: string | null;
};

export type SequenceWrite =
  | { kind: "written"; stored: MaterialiseSequenceRow | null }
  /** The stored row is not the one expected: nothing was written. */
  | { kind: "stale"; stored: MaterialiseSequenceRow | null };

/** The most rows a read of the store returns (the queue's working set): a task has at most a few, the account at most one per task. */
export const SEQUENCE_WINDOW = 100;

const keyOf = (key: SequenceKey): [string, string] => [
  key.task_id,
  key.through_date,
];

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
    (stored.attempt?.key ?? null) === expected.attempt_key
  );
}

export const writeMaterialiseSequence = guardedPlan<
  {
    captured: Captured;
    key: SequenceKey;
    expected: SequenceExpectation;
    /** The replacement row (its key must be `key`), or `null` to delete: the sequence is over. */
    next: MaterialiseSequenceRow | null;
  },
  // Wrapped: a guarded plan reads `undefined` as "no singleton", and an absent row is an answer here.
  { row: MaterialiseSequenceRow | undefined },
  SequenceWrite
>({
  name: "data.writeMaterialiseSequence",
  // A fixed-size row (a few hundred bytes, one per task and day while it catches up): classed as a cache write, not admitted (R28).
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
    return {
      writes: [w.put("materialise_sequences", next)],
      result: { kind: "written", stored: next },
    };
  },
});

/**
 * Housekeeping when a new day's sequence of a task begins: deletes that task's sequences of EARLIER days that are not running (stopped or
 * ready), at most one window per call. A sequence that is sending or awaiting its read is left to finish.
 */
export const pruneMaterialiseSequences = guardedPlan<
  { captured: Captured; task_id: string; before: string },
  MaterialiseSequenceRow[],
  { removed: number }
>({
  name: "data.pruneMaterialiseSequences",
  meta: { writer: "W27", guards: ["INC", "CLS", "EPO"], quota: null },
  scope: ["materialise_sequences"],
  durability: "strict",
  read: (reader, input) =>
    reader.byIndex(
      "materialise_sequences",
      "[task_id+through_date]",
      range.between([input.task_id, ""], [input.task_id, input.before], {
        upperOpen: true,
      }),
      SEQUENCE_WINDOW,
    ),
  decide: ({ reads }) => {
    const gone = reads.filter(
      (row) => row.phase === "stopped" || row.phase === "ready",
    );
    return {
      writes: gone.map((row) =>
        w.delete("materialise_sequences", [row.task_id, row.through_date]),
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

/** What one task's entry is admitted at: its fields, a stop's reason and a request id of at most `DISCOVERY_REQUEST_ID` characters. */
export const DISCOVERY_ENTRY_BYTES = 512;
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

const sameDiscovery = (
  a: MaterialiseDiscovery | null,
  b: MaterialiseDiscovery | null,
) =>
  a === null || b === null
    ? a === b
    : a.retry === b.retry &&
      a.failures === b.failures &&
      (a.stop === null) === (b.stop === null) &&
      (a.attempt ?? null) === (b.attempt ?? null);

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
