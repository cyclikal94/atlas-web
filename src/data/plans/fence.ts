import {
  digestOfMembers,
  EMPTY_DIGEST,
  isMemberDraft,
  type LocalWorkSummaryValue,
  NO_CONSENT_DIGEST,
  population,
  summarise,
} from "../model/local-work";
import type {
  DraftFence,
  DraftRow,
  FormRecoveryRow,
  SyncStateRow,
} from "../model/types";
import { type Reader, range } from "../store/port";
import { singletonPlan } from "./builders";

/**
 * The plans behind the wipe ports (plan 5.3.3, writer W10) and the unsynced-work read. The draft fence is the one thing that
 * refuses a person's input at a lifecycle edge (matrix AMB-1: drafts otherwise "stay in IndexedDB"), and the consent digest the
 * ticket binds to is computed INSIDE the fence transaction, over stored per-row digests (decision D-07).
 *
 * Decision D-06: `draft_fence = { token, started_at, operation_ids[], consent_digest, closing }`. `setDraftFence` replaces
 * `consent_digest` with the digest read in its own transaction and appends its operation id; `releaseFence(op)` removes the id
 * and clears the record when none remains. The fence blocks draft inserts and in-place edits of a `queued` command only
 * (decision D-20): replay and status transitions continue.
 */
interface WorkReads {
  drafts: DraftRow[];
  recovery: FormRecoveryRow[];
}
/**
 * The members of the unsynced population, read by status index: the HEADERS of the drafts that are work (never a body: decision
 * D-23), and no superseded or fully published draft. Exact (every member is read, because the digest is over every member's
 * stored digest), but it never touches the payload of any draft, however many large imports are retained.
 */
const readWork = async (reader: Reader): Promise<WorkReads> => {
  const drafts: DraftRow[] = [];
  for (const status of [
    "queued",
    "in_flight",
    "rejected",
    "blocked",
    "version_conflict",
    "operation_conflict",
  ] as const)
    drafts.push(
      ...(await reader.byIndex("drafts", "status", range.only(status))),
    );
  for (const row of await reader.byIndex(
    "drafts",
    "status",
    range.only("acknowledged"),
  ))
    if (isMemberDraft(row)) drafts.push(row);
  return { drafts, recovery: await reader.list("form_recovery") };
};

/** The unsynced-work summary: count, generic category lines, digest. READONLY. */
export const summariseWork = singletonPlan<
  { incarnationId: string },
  WorkReads,
  LocalWorkSummaryValue
>({
  name: "data.summariseWork",
  meta: { writer: "W10", guards: ["INC"], quota: null },
  scope: ["drafts", "form_recovery"],
  mode: "readonly",
  durability: "default",
  read: (reader) => readWork(reader),
  decide: ({ reads }) => ({
    result: summarise(population(reads.drafts, reads.recovery)),
  }),
});

/** The fence's `consent_digest`, or what to report when there is none (see `baselineDigest`). READONLY. */
export const readBaseline = singletonPlan<
  { incarnationId: string },
  WorkReads,
  { fenceDigest: string | null; liveCount: number; liveDigest: string }
>({
  name: "data.readBaseline",
  meta: { writer: "W10", guards: ["INC"], quota: null },
  scope: ["drafts", "form_recovery"],
  mode: "readonly",
  durability: "default",
  read: (reader) => readWork(reader),
  decide: ({ sync, reads }) => {
    const members = population(reads.drafts, reads.recovery);
    return {
      result: {
        fenceDigest: sync?.draft_fence?.consent_digest ?? null,
        liveCount: members.length,
        liveDigest: digestOfMembers(members),
      },
    };
  },
});

export type FenceSetResult =
  | { kind: "set"; consentDigest: string }
  | { kind: "absent_singleton" };

/** `setDraftFence`: ONE `strict` transaction over `drafts`, `form_recovery` and `sync_state`. Takes no lock. */
export const setDraftFence = singletonPlan<
  { incarnationId: string; now: number; token: string; operationId: string },
  WorkReads,
  FenceSetResult
>({
  name: "data.setDraftFence",
  meta: { writer: "W10", guards: ["INC"], quota: null },
  scope: ["drafts", "form_recovery"],
  durability: "strict",
  read: (reader) => readWork(reader),
  decide: ({ sync, reads, input }) => {
    if (sync === undefined) return { result: { kind: "absent_singleton" } };
    const digest = digestOfMembers(population(reads.drafts, reads.recovery));
    const existing = sync.draft_fence;
    const fence: DraftFence = existing
      ? {
          ...existing,
          operation_ids: existing.operation_ids.includes(input.operationId)
            ? existing.operation_ids
            : [...existing.operation_ids, input.operationId],
          consent_digest: digest,
        }
      : {
          token: input.token,
          started_at: input.now,
          operation_ids: [input.operationId],
          consent_digest: digest,
          closing: false,
        };
    return {
      sync: { ...sync, draft_fence: fence },
      result: { kind: "set", consentDigest: digest },
    };
  },
});

/**
 * `setClosing`: `draft_fence.closing = true`, creating the fence if absent so that recovery writes are refused regardless. The
 * adapter posts `wipe_imminent` only AFTER this transaction has completed, so no tab can observe the broadcast while `closing`
 * is still false.
 */
export const setClosing = singletonPlan<
  { incarnationId: string; now: number; token: string },
  null,
  { kind: "closing" | "absent_singleton" }
>({
  name: "data.setClosing",
  meta: { writer: "W10", guards: ["INC"], quota: null },
  scope: [],
  durability: "strict",
  read: async () => null,
  decide: ({ sync, input }) => {
    if (sync === undefined) return { result: { kind: "absent_singleton" } };
    const fence: DraftFence = sync.draft_fence
      ? { ...sync.draft_fence, closing: true }
      : {
          token: input.token,
          started_at: input.now,
          operation_ids: [],
          consent_digest: "",
          closing: true,
        };
    return {
      sync: { ...sync, draft_fence: fence },
      result: { kind: "closing" },
    };
  },
});

/**
 * `releaseFence`: ownership-scanning, idempotent, never throws. Removes `operationId`; deletes the whole record (including
 * `closing`) when none remains; a NO-OP when there is no fence or another operation owns it (MU-38).
 */
export const releaseFence = singletonPlan<
  { incarnationId: string; operationId: string },
  null,
  { kind: "released" | "kept" | "noop" }
>({
  name: "data.releaseFence",
  meta: { writer: "W10", guards: ["INC"], quota: null },
  scope: [],
  durability: "strict",
  read: async () => null,
  decide: ({ sync, input }) => {
    const fence = sync?.draft_fence ?? null;
    if (
      sync === undefined ||
      fence === null ||
      !fence.operation_ids.includes(input.operationId)
    )
      return { result: { kind: "noop" } };
    const remaining = fence.operation_ids.filter(
      (id) => id !== input.operationId,
    );
    if (remaining.length === 0)
      return {
        sync: { ...sync, draft_fence: null },
        result: { kind: "released" },
      };
    return {
      sync: { ...sync, draft_fence: { ...fence, operation_ids: remaining } },
      result: { kind: "kept" },
    };
  },
});

/**
 * Stale-fence reconciliation (D:1430-1450, decision D-06). A fence is cleared only if it is older than `staleMs` AND no
 * operation is pending for the account AND the session has started (so `operations.resume()` has populated the pending store).
 * Otherwise it does nothing (MU-39). The ledger entry cannot be read through the public API: the caller passes the session's
 * own `operations.pending` fact.
 */
export const reconcileStaleFence = singletonPlan<
  {
    incarnationId: string;
    now: number;
    staleMs: number;
    hasPendingOperation: boolean;
    sessionStarted: boolean;
  },
  null,
  { cleared: boolean }
>({
  name: "data.reconcileStaleFence",
  meta: { writer: "W10", guards: ["INC"], quota: null },
  scope: [],
  durability: "strict",
  read: async () => null,
  decide: ({ sync, input }) => {
    const fence = sync?.draft_fence ?? null;
    if (sync === undefined || fence === null)
      return { result: { cleared: false } };
    const stale = input.now - fence.started_at > input.staleMs;
    if (!stale || input.hasPendingOperation || !input.sessionStarted)
      return { result: { cleared: false } };
    return { sync: { ...sync, draft_fence: null }, result: { cleared: true } };
  },
});

export type { SyncStateRow };
export { EMPTY_DIGEST, NO_CONSENT_DIGEST };
