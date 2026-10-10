import { DATA_CONFIG } from "../model/config";
import {
  failureVersion,
  invalidateOperation,
  onLocalWriteSuccess,
} from "../model/retry";
import {
  atFloor,
  type DeviceSignals,
  initialState,
  next as nextSizing,
  type SizingAction,
  type SizingOutcome,
} from "../model/sizing";
import type { Captured, SizingState } from "../model/types";
import { w } from "../store/port";
import { guardedPlan, singletonPlan } from "./builders";
import { clearOverlayDisplays } from "./reconcile-windows";

/**
 * The small `sync_state` writers of ordinary sync: W19 `captureRequest`, W16 the sizing marker and outcome, and W18
 * `invalidateCache` (the ordinary-phase half of the recovery handoff). Each is one short transaction.
 *
 * THE SIZING MARKER'S LIFETIME (R42, revision 23). `sizing.attempt` says "a page of at least `markerMinBytes` was being processed and
 * nobody has seen how that ended": the one signal of a tab that did not survive (killed for memory, frozen and discarded). It is
 * therefore a claim about an UNKNOWN outcome, and it must not outlive the moment an outcome is known. Exactly five things touch it:
 *   * `recordSizingAttempt` writes it, bound to the attempt by an id, after the page's growth was admitted;
 *   * `commitPage` clears it in the transaction that lands the page (the outcome "applied");
 *   * `retireSizingAttempt` clears it when the engine SAW the attempt end without landing the page (a safe drop, a refusal, a failed
 *     commit), and only if the marker is still that attempt's: a continuation that has been overtaken cannot erase a newer one's;
 *   * `captureRequest` consumes it at the next step: counted as a crash when nothing says otherwise, or cleared without a count when this
 *     page names the attempt as one it saw end and could not retire (the retirement's own write failed);
 *   * `resetSizingFloor` ("Try again") clears it with the count.
 * No OUTCOME record (`recordSizingOutcome`) touches it: it decides the ladder, and the marker belongs to the attempt.
 */

// ---- W19 ----------------------------------------------------------------------------------------------------------------
/**
 * The identity of the WRITE of the request sequence itself in `sync_state.local_write_streaks` and in the fallback markers: a failure of
 * `data.captureRequest` is counted under it, three consecutive ones stop it, and it is enforced by the capture gate exactly as a
 * page's operation (`page:<cursor>`) is. Keyed apart from every page, draft and receipt, so no other operation's success or retry
 * touches it, and its own success (while it is below the stop) clears only its own streak.
 */
export const CAPTURE_OPERATION = "capture";

/**
 * The identities of the two OTHER bookkeeping writes of a step whose failure removes a bound if it is swallowed (R20, revision 9): the
 * `sync` caller's retry record (`read_retry_states.sync`, the counter of its back-off, its duration and its unrecognised answers) and
 * the sizing record (the ladder and its floor count). When the counter itself cannot be written the stop is IMMEDIATE and uncounted,
 * as for the capture write: the account's fallback marker, then this tab's memory, and the capture gate enforces it exactly as it does
 * `capture` and `page:<cursor>`. Only that operation's explicit retry leaves it.
 */
export const READ_RETRY_OPERATION = "retry-state";
export const SIZING_OPERATION = "sizing";

export type GateReason =
  | "phase"
  | "cache_status"
  | "paused"
  /** The sync caller is paused because three answers in a row were unrecognised: only an explicit retry leaves it. */
  | "unrecognised"
  /**
   * Three durable write failures of the current page's operation, of the write of an admitted invalidation at this position, or of the
   * capture write itself (or the operation's fallback marker, or a stop only this tab holds): only an explicit retry leaves it.
   */
  | "local_storage"
  /**
   * The record of a stop of the current page's operation (or of the capture write, or of an admitted invalidation at this position)
   * could not be read, and nothing the page established says what it holds (R47, revision 29): not a stop, and not a permission to
   * send. Left by a read that lands; the engine asks again, paced.
   */
  | "unreadable"
  | "floor"
  | "closing"
  | "absent";

export type CaptureResult =
  | {
      kind: "captured";
      /** `request_seq` AFTER the increment: the value this request carries. */
      requestSeq: number;
      cursor: string | null;
      recoveryGeneration: number;
      limit: number;
      /** True when the previous attempt never finished (the crash-loop marker was found) and the ladder stepped down. */
      steppedDown: boolean;
    }
  | {
      kind: "gated";
      reason: GateReason;
      /**
       * `local_storage`: the operation that is stopped (`capture` or `page:<cursor>`), so an explicit retry clears exactly that one;
       * `unreadable`: the first operation whose record could not be read.
       */
      operation?: string;
      /**
       * `local_storage`: the version of the durable failure that stands under `operation` in the snapshot the gate decided on (R53,
       * revision 32), or `null` when the stop is a marker's or the tab's alone. An explicit retry resets on it.
       */
      version?: number | null;
      /** `unreadable`: EVERY operation of this decision whose record could not be read, in the gate's order (R47, revision 29). */
      operations?: readonly string[];
    };

/**
 * Takes the local gate and, if it is open, captures the request: `request_seq` is incremented when the request is CAPTURED FOR
 * ISSUE, before it is sent. A request that is then not sent leaves a gap, which is safe: `no_publication` eligibility is the
 * STRICT comparison `captured.request_seq > floor` (the conservative direction). The counter is durable and monotone, so a
 * restart cannot leave rows stuck behind a larger floor.
 *
 * The gate: `phase === "delta"`, `cache_status === "valid"`, no closing fence, the `sync` caller not paused, none of the capture write
 * itself (`capture`), the current page's operation (`page:<cursor>`) and the write of an admitted invalidation at this position
 * (`invalidate:<cursor>`) stopped by local write failures (the durable streak, the
 * account's fallback marker or a stop this tab holds, as the engine read them), and not at the floor. A stop of the capture write is
 * enforced before the next capture is attempted, whatever woke the engine, and is left only by that operation's explicit retry (its
 * own success cannot happen while it stands: nothing is attempted). Ordinary sync never runs behind a recovery (the recovery job is
 * WEB-09b's); a closed gate sends NOTHING.
 */
export const captureRequest = singletonPlan<
  {
    incarnationId: string;
    signals: DeviceSignals;
    /**
     * The operations (`capture`, `retry-state`, `sizing`, `page:<cursor>`, `invalidate:<cursor>`) that a stop which could not be counted durably names: the
     * account's fallback markers and the stops this tab alone holds. The engine reads them in its step, never inside the transaction.
     */
    stoppedOperations?: readonly string[];
    /**
     * What the account's fallback marker of an operation says NOW (R47, revision 29): asked, synchronously, for exactly the operations
     * this decision names (`capture`, `retry-state`, `sizing`, `page:<cursor>`, `invalidate:<cursor>`), which only the transaction
     * knows (the position is read in it). `marked` is a stop; `unknown` (the key and the enumeration could not be read, and nothing the
     * page established says what they hold) is the `unreadable` gate; absent, no marker is consulted. It is a read of the markers'
     * own storage and the plan never touches `localStorage`.
     */
    markerState?: (operation: string) => "marked" | "unmarked" | "unknown";
    /**
     * The stop of the write of an admitted invalidation (`invalidate:<cursor>`) that an explicit retry has LIFTED for one bounded cycle
     * (R10, revision 9). The retry does not erase the stop's record (the streak, the fallback marker, the tab's memory): that record is
     * also what hides the cache, and a retry is not evidence that the cache has become valid. It only lets this step proceed; the
     * invalidation's own transaction clears the streak when, and only when, the write succeeds. Only that operation can be lifted:
     * the capture write's and a page's stops are still cleared by their own retry.
     */
    liftedOperations?: readonly string[];
    /**
     * The id of an attempt this page SAW end without landing its page, whose marker it could not retire (the retirement's write failed
     * or the service had gone): a marker with that id is not a tab that did not survive, and is cleared without a count. Any other
     * marker found here is read as it always was. Absent: nothing is claimed.
     */
    endedAttempt?: string | null;
  },
  null,
  CaptureResult
>({
  name: "data.captureRequest",
  meta: { writer: "W19", guards: ["INC"], quota: null },
  scope: [],
  durability: "default",
  read: async () => null,
  decide: ({ sync, input }) => {
    if (sync === undefined)
      return { result: { kind: "gated", reason: "absent" } };
    // First use: classify the device once. A later start never undoes a step-down.
    let sizing: SizingState =
      sync.sizing.class === null ? initialState(input.signals) : sync.sizing;
    let steppedDown = false;
    if (sizing.attempt !== null) {
      if (sizing.attempt.id === input.endedAttempt) {
        // This page saw that attempt end (a safe drop, a refusal, a failed commit) and its retirement could not be written: nothing
        // was lost to resource exhaustion, so nothing is counted.
        sizing = { ...sizing, attempt: null };
      } else {
        // A marker found here means the previous attempt did not finish: a tab killed for memory is the realistic failure.
        sizing = nextSizing(sizing, { kind: "crashed_attempt" }).state;
        steppedDown = true;
      }
    }
    const sizingChanged = sizing !== sync.sizing;
    const pageOperation = `page:${sync.cursor ?? ""}`;
    const invalidation = invalidateOperation(sync.cursor);
    const markers = new Map<string, "marked" | "unmarked" | "unknown">();
    const markerOf = (operation: string): "marked" | "unmarked" | "unknown" => {
      const known = markers.get(operation);
      if (known !== undefined) return known;
      const state = input.markerState?.(operation) ?? "unmarked";
      markers.set(operation, state);
      return state;
    };
    const stopped = (operation: string): boolean =>
      (sync.local_write_streaks[operation] ?? 0) >=
        DATA_CONFIG.localWritePauseAfter ||
      input.stoppedOperations?.includes(operation) === true ||
      markerOf(operation) === "marked";
    // The write of the request sequence is the first local write of a step, so its stop is named before the page's, and the stop of
    // an admitted invalidation (R10) after it: that one is the cache's own state, which the page cannot be applied over.
    const stoppedOperation = ((): string | null =>
      stopped(CAPTURE_OPERATION)
        ? CAPTURE_OPERATION
        : stopped(READ_RETRY_OPERATION)
          ? READ_RETRY_OPERATION
          : stopped(SIZING_OPERATION)
            ? SIZING_OPERATION
            : stopped(pageOperation)
              ? pageOperation
              : stopped(invalidation) &&
                  input.liftedOperations?.includes(invalidation) !== true
                ? invalidation
                : null)();
    // The operations of the same order whose stop is not known to stand and whose record cannot be read (R47, revision 29).
    const unreadableOperations = [
      CAPTURE_OPERATION,
      READ_RETRY_OPERATION,
      SIZING_OPERATION,
      pageOperation,
      invalidation,
    ].filter((operation) => markerOf(operation) === "unknown");
    const gate = ((): GateReason | null => {
      if (sync.draft_fence?.closing === true) return "closing";
      if (sync.phase !== "delta") return "phase";
      if (sync.cache_status !== "valid") return "cache_status";
      const retry = sync.read_retry_states.sync;
      if (retry?.paused === true)
        return retry.unrecognised_streak >= DATA_CONFIG.unrecognisedPauseAfter
          ? "unrecognised"
          : "paused";
      if (stoppedOperation !== null) return "local_storage";
      if (unreadableOperations.length > 0) return "unreadable";
      if (atFloor(sizing)) return "floor";
      return null;
    })();
    if (gate !== null)
      return {
        sync: sizingChanged ? { ...sync, sizing } : null,
        result: {
          kind: "gated",
          reason: gate,
          ...(gate === "local_storage" && stoppedOperation !== null
            ? {
                operation: stoppedOperation,
                version: failureVersion(sync, stoppedOperation),
              }
            : gate === "unreadable"
              ? {
                  operation: unreadableOperations[0] as string,
                  operations: unreadableOperations,
                }
              : {}),
        },
      };
    const requestSeq = sync.request_seq + 1;
    return {
      sync: {
        ...sync,
        request_seq: requestSeq,
        sizing,
        // The capture write succeeded: that is this operation's success, and it clears this operation's streak and no other's.
        local_write_streaks: onLocalWriteSuccess(
          sync.local_write_streaks,
          CAPTURE_OPERATION,
        ),
      },
      result: {
        kind: "captured",
        requestSeq,
        cursor: sync.cursor,
        recoveryGeneration: sync.recovery_generation,
        limit: Math.min(sizing.limit, DATA_CONFIG.syncLimitMax),
        steppedDown,
      },
    };
  },
});

// ---- W16 ----------------------------------------------------------------------------------------------------------------
/** The crash-loop marker (decision D-09): written durably before a page of at least `markerMinBytes` is processed. */
export const recordSizingAttempt = singletonPlan<
  { incarnationId: string; id: string; limit: number; startedAt: number },
  null,
  { written: boolean }
>({
  name: "data.recordSizingAttempt",
  meta: { writer: "W16", guards: ["INC"], quota: null },
  scope: [],
  durability: "default",
  read: async () => null,
  decide: ({ sync, input }) => {
    if (sync === undefined) return { result: { written: false } };
    return {
      sync: {
        ...sync,
        sizing: {
          ...sync.sizing,
          attempt: {
            id: input.id,
            limit: input.limit,
            started_at: input.startedAt,
          },
        },
      },
      result: { written: true },
    };
  },
});

/**
 * The end of an attempt that landed nothing (R42, revision 23): the engine saw the commit return without applying the page, so the
 * marker written before it is no longer a claim about an unknown outcome and must go, or the next capture would read a normal end as a
 * tab that did not survive (three safe drops at the lowest rung would then be the resource-exhaustion floor). Bound to the attempt:
 * the marker is cleared only if it is still THIS attempt's, so a continuation that has been overtaken (a restarted run, another page's
 * newer attempt) cannot erase the marker of one that is genuinely under way. Nothing else of the row changes: no count, no step.
 */
export const retireSizingAttempt = singletonPlan<
  { incarnationId: string; id: string },
  null,
  { retired: boolean }
>({
  name: "data.retireSizingAttempt",
  meta: { writer: "W16", guards: ["INC"], quota: null },
  scope: [],
  durability: "default",
  read: async () => null,
  decide: ({ sync, input }) => {
    if (sync === undefined || sync.sizing.attempt?.id !== input.id)
      return { result: { retired: false } };
    return {
      sync: { ...sync, sizing: { ...sync.sizing, attempt: null } },
      result: { retired: true },
    };
  },
});

/**
 * The outcome of a page that did NOT commit: steps the ladder and counts a floor hit at the lowest rung. It leaves the crash-loop
 * marker exactly as it finds it (R42): the marker belongs to the attempt that wrote it, which retires it itself
 * (`retireSizingAttempt`), and an outcome recorded by a continuation that has been overtaken must not erase a newer attempt's.
 */
export const recordSizingOutcome = singletonPlan<
  { incarnationId: string; outcome: SizingOutcome },
  null,
  { action: SizingAction; sizing: SizingState } | { action: "none" }
>({
  name: "data.recordSizingOutcome",
  meta: { writer: "W16", guards: ["INC"], quota: null },
  scope: [],
  durability: "default",
  read: async () => null,
  decide: ({ sync, input }) => {
    if (sync === undefined) return { result: { action: "none" } };
    const out = nextSizing(sync.sizing, input.outcome);
    const sizing: SizingState = { ...out.state, attempt: sync.sizing.attempt };
    return {
      sync: { ...sync, sizing },
      result: { action: out.action, sizing },
    };
  },
});

/** "Try again" on the floor screen. */
export const resetSizingFloor = singletonPlan<
  { incarnationId: string },
  null,
  { reset: boolean }
>({
  name: "data.resetSizingFloor",
  meta: { writer: "W16", guards: ["INC"], quota: null },
  scope: [],
  durability: "default",
  read: async () => null,
  decide: ({ sync }) => {
    if (sync === undefined) return { result: { reset: false } };
    return {
      sync: {
        ...sync,
        sizing: { ...sync.sizing, floor_hits: 0, attempt: null },
      },
      result: { reset: true },
    };
  },
});

// ---- W18 ----------------------------------------------------------------------------------------------------------------
export type InvalidationReason =
  | "resync_required"
  | "construction_defect"
  | "access_changed"
  | "unrecognised_delta";

/**
 * The ordinary-phase invalidation (`410 resync_required`, `400`/`422` on a sent cursor): the cache is hidden (`cache_status:
 * "invalid"`), the delta position is abandoned, a new recovery generation begins, any staging is dropped, and every overlay
 * display is dropped (an overlay is never shown while the cache is gated). The cached CONTENT stays where it is: it is hidden by
 * the gate and replaced by WEB-09b's atomic activation, never edited here. Drafts and their flags are untouched.
 *
 * Guarded like a commit: a duplicate or delayed `410` for a cursor that has since moved (CAS), or a superseded attempt (GEN),
 * must not invalidate state that is valid. WEB-09b re-uses this plan for its own recovery-position invalidations.
 *
 * BOUNDED (R11, revision 8): the overlays are dropped by a windowed walk of the pending effects in the SAME transaction (`apply`,
 * through the transaction's own sink), `queueWorkingSet` rows at a time, so what is in hand never grows with the retained queue.
 * Nothing is capped or discarded: every effect is visited, and a failure anywhere (the walk included) rolls the whole invalidation
 * back, leaving the cache, the position and every overlay exactly as they were.
 */
export const invalidateRecoveryPosition = guardedPlan<
  { captured: Captured; reason: InvalidationReason; window?: number },
  null,
  { generation: number; reason: InvalidationReason; overlaysDropped: number }
>({
  name: "data.invalidateCache",
  meta: {
    writer: "W18",
    guards: ["INC", "CLS", "CAS", "GEN", "EPO"],
    quota: null,
  },
  scope: ["cache_staging", "pending_effects"],
  durability: "strict",
  // No read: the effects are walked in windows by `apply`, never prefetched.
  read: async () => null,
  decide: ({ sync, input }) => {
    const generation = sync.recovery_generation + 1;
    return {
      writes: [w.clear("cache_staging")],
      sync: {
        ...sync,
        cache_status: "invalid",
        cursor: null,
        recovery_generation: generation,
        staging_position: null,
        expected_position: null,
        // The write of this invalidation succeeded: that is this operation's success, and it clears this operation's streak.
        local_write_streaks: onLocalWriteSuccess(
          sync.local_write_streaks,
          invalidateOperation(sync.cursor),
        ),
      },
      result: {
        generation,
        reason: input.reason,
        overlaysDropped: 0,
      },
    };
  },
  async apply(sink, { reader, input, result }) {
    const dropped = await clearOverlayDisplays(
      reader,
      sink,
      input.window ?? DATA_CONFIG.queueWorkingSet,
    );
    return { ...result, overlaysDropped: dropped };
  },
});
