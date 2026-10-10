import {
  isStoreFailure,
  PlanRejected,
  StoreFailure,
  type StoreFailureCause,
} from "./port";

/**
 * One classification of whatever a transaction threw, shared by the Dexie adapter and the double of IndexedDB so that they
 * agree. The result is always from the closed set of causes; it never carries a message (a message could hold content).
 *
 * An allocation failure (`RangeError`, or an engine's out-of-memory) is `error` with the fixed detail `alloc/range_error`: Q23
 * needs it distinct from an ordinary abort, because it is a signal about the DEVICE and steps the page size down.
 */
const namesOf = (error: unknown): string[] => {
  const names: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current; depth += 1) {
    const named = current as {
      name?: unknown;
      inner?: unknown;
      failures?: unknown;
    };
    if (typeof named.name === "string") names.push(named.name);
    // Dexie's `BulkError` (`bulkPut`, `bulkDelete`) names its operations' failures: a quota or an abort inside a bulk write is in them.
    if (Array.isArray(named.failures))
      for (const failure of named.failures)
        if (typeof (failure as { name?: unknown })?.name === "string")
          names.push((failure as { name: string }).name);
    current = named.inner;
  }
  return names;
};

export function classifyFailure(error: unknown): StoreFailure {
  if (isStoreFailure(error)) return error;
  if (
    error instanceof PlanRejected ||
    (error as { name?: unknown })?.name === "PlanRejected"
  ) {
    const rejected = error as PlanRejected;
    return new StoreFailure("plan_rejected", {
      stage: rejected.stage,
      reason: rejected.reason,
    });
  }
  if (error instanceof RangeError)
    return new StoreFailure("error", { stage: "alloc", reason: "range_error" });
  const names = namesOf(error);
  let cause: StoreFailureCause = "error";
  if (names.includes("QuotaExceededError")) cause = "quota";
  else if (
    names.includes("DatabaseClosedError") ||
    names.includes("InvalidStateError") ||
    names.includes("CreateRefused")
  )
    cause = "closed";
  else if (
    names.includes("AbortError") ||
    names.includes("TransactionInactiveError")
  )
    cause = "abort";
  return new StoreFailure(cause);
}

/** True when a failure is an allocation failure (a signal about the device, not the data). */
export const isAllocationFailure = (failure: StoreFailure): boolean =>
  failure.cause === "error" &&
  failure.detail?.stage === "alloc" &&
  failure.detail.reason === "range_error";
