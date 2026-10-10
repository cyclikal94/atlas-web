import { DATA_CONFIG, type DataConfig } from "./config";
import type { SizingClass, SizingState } from "./types";

/**
 * Q23: device class, step-down and the floor (plan 5.4.5, decisions D-08 and D-09). Pure.
 *
 * The answer to Q23 is NOT a fixed memory estimate that refuses a valid workload for good. The device class selects the INITIAL
 * rung only; from there the ladder is driven by what actually happens: an allocation failure, a non-quota transaction abort, a
 * watchdog overrun, or a durable crash-loop marker found at start (a tab killed for memory is the realistic failure on mobile).
 * Quota exhaustion and an oversize response NEVER step down: a smaller page creates no space, and an oversize body is a contract
 * violation, not a device limit. The floor state (a refusal to sync) is reached only by repeated failure AT the lowest rung, so
 * it is reserved for genuine resource exhaustion.
 *
 * `navigator.deviceMemory` is a class selector, not an availability probe: its absence (Firefox, Safari) selects `unknown`, which
 * starts at the lowest rung and is never assumed to be unconstrained.
 */
export type DeviceClass = SizingClass;

export interface DeviceSignals {
  deviceMemoryGiB?: number;
  hardwareConcurrency?: number;
  hasStorageEstimate: boolean;
}

export type SizingOutcome =
  | { kind: "admitted"; bytes: number; changes: number; durationMs: number }
  /** A RangeError or an ArrayBuffer allocation failure. */
  | { kind: "allocation_failed" }
  /** A transaction abort or error that is NOT quota. */
  | { kind: "commit_failed"; cause: "abort" | "error" }
  /** The apply exceeded `syncApplyWatchdogMs` at a chunk boundary. */
  | { kind: "watchdog"; elapsedMs: number }
  /** The durable marker was found at start: the previous attempt did not finish. */
  | { kind: "crashed_attempt" }
  /** A response larger than the contract allows: NOT exhaustion. */
  | { kind: "oversize" }
  /** The engine's quota failed: NOT a reason to ask for less. */
  | { kind: "quota" };

/**
 * An allocation failure, as a thrown value (R44): a `RangeError` (a typed array, array, string or buffer that cannot be made). It is
 * the ONE definition every stage of a page's processing uses, so that no stage that catches an exception for its own reason can turn
 * a signal about the DEVICE into a verdict about the DATA: the body read, the scan (its offset arrays, their growth and trimmed
 * copies, the decoding of a key or the cursor), the decoding and validation of an element, and the commit all report it as
 * `allocation_failed`. A malformed page (a `SyntaxError`, an invalid UTF-8 `TypeError`, a `PageInvalid`) is not one.
 */
export const isAllocationError = (error: unknown): error is RangeError =>
  error instanceof RangeError;

export type SizingAction =
  /** Nothing about the ladder changed. */
  | "continue"
  /** Ask again for a smaller page. */
  | "retry_lower"
  /** Ask again at the lowest rung (the floor is not reached yet). */
  | "retry_same"
  /** The floor: stop syncing and say so. */
  | "floor";

export function classify(signals: DeviceSignals): DeviceClass {
  const memory = signals.deviceMemoryGiB;
  if (memory === undefined || !Number.isFinite(memory)) return "unknown";
  return memory >= 8 ? "unconstrained" : "constrained";
}

export function initialLimit(
  deviceClass: DeviceClass,
  config: Pick<
    DataConfig,
    "initialLimitUnconstrained" | "initialLimitOther" | "syncLimitMax"
  > = DATA_CONFIG,
): number {
  const rung =
    deviceClass === "unconstrained"
      ? config.initialLimitUnconstrained
      : config.initialLimitOther;
  return Math.max(1, Math.min(rung, config.syncLimitMax));
}

/** The next rung down: halving, never below 1. */
export const lowerRung = (limit: number): number =>
  Math.max(1, Math.floor(limit / 2));

export function initialState(
  signals: DeviceSignals,
  config: Pick<
    DataConfig,
    "initialLimitUnconstrained" | "initialLimitOther" | "syncLimitMax"
  > = DATA_CONFIG,
): SizingState {
  const deviceClass = classify(signals);
  return {
    limit: initialLimit(deviceClass, config),
    class: deviceClass,
    floor_hits: 0,
    attempt: null,
  };
}

export function next(
  state: SizingState,
  outcome: SizingOutcome,
  config: Pick<DataConfig, "floorAfter"> = DATA_CONFIG,
): { state: SizingState; action: SizingAction } {
  switch (outcome.kind) {
    case "admitted":
      // A success clears the marker and the count of failures at the lowest rung. Step-up is disabled until measured.
      return {
        state: { ...state, attempt: null, floor_hits: 0 },
        action: "continue",
      };
    case "oversize":
    case "quota":
      return { state: { ...state, attempt: null }, action: "continue" };
    case "allocation_failed":
    case "commit_failed":
    case "watchdog":
    case "crashed_attempt": {
      if (state.limit > 1)
        return {
          state: { ...state, limit: lowerRung(state.limit), attempt: null },
          action: "retry_lower",
        };
      // A local transaction abort or error at the lowest rung is the local-write-failure class (its own bound and its own
      // terminal state, "Retry applying changes"): it does NOT count toward the floor, which is reserved for the signals about
      // the DEVICE (an allocation failure, a watchdog overrun, a tab that did not survive). Otherwise three aborts would reach
      // two different terminal screens at once.
      if (outcome.kind === "commit_failed")
        return { state: { ...state, attempt: null }, action: "retry_same" };
      const hits = state.floor_hits + 1;
      return {
        state: { ...state, floor_hits: hits, attempt: null },
        action: hits >= config.floorAfter ? "floor" : "retry_same",
      };
    }
  }
}

/** "Try again" on the floor screen: the count starts again, the limit stays at the lowest rung. */
export const resetFloor = (state: SizingState): SizingState => ({
  ...state,
  floor_hits: 0,
  attempt: null,
});

export const atFloor = (
  state: SizingState,
  config: Pick<DataConfig, "floorAfter"> = DATA_CONFIG,
): boolean => state.limit <= 1 && state.floor_hits >= config.floorAfter;
