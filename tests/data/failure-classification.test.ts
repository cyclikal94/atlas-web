// @vitest-environment node
import { describe, expect, test } from "vitest";
import {
  classifyFailure,
  isAllocationFailure,
} from "../../src/data/store/failure";
import { PlanRejected, StoreFailure } from "../../src/data/store/port";

/**
 * The one classification of whatever a transaction threw, shared by the Dexie adapter and the double. Dexie's `BulkError`
 * (`bulkPut`, `bulkDelete`) names the failures of its operations, and what went wrong is in THEM: a real engine reported the abort
 * of a queued transaction as a `BulkError` whose failure is an `AbortError`, which the first classification called a plain `error`.
 */
const named = (name: string, extra: Record<string, unknown> = {}) =>
  Object.assign(new Error(name), { name }, extra);

describe("classifyFailure", () => {
  test("a store failure passes through unchanged, and a PlanRejected keeps its stage and reason", () => {
    const failure = new StoreFailure("quota");
    expect(classifyFailure(failure)).toBe(failure);
    const rejected = classifyFailure(new PlanRejected("apply", "watchdog"));
    expect(rejected.cause).toBe("plan_rejected");
    expect(rejected.detail).toEqual({ stage: "apply", reason: "watchdog" });
  });

  test("the names of an error, of its `inner` chain, decide the cause", () => {
    expect(classifyFailure(named("QuotaExceededError")).cause).toBe("quota");
    expect(classifyFailure(named("AbortError")).cause).toBe("abort");
    expect(classifyFailure(named("TransactionInactiveError")).cause).toBe(
      "abort",
    );
    expect(classifyFailure(named("DatabaseClosedError")).cause).toBe("closed");
    expect(classifyFailure(named("OtherError")).cause).toBe("error");
    expect(
      classifyFailure(named("DexieError", { inner: named("AbortError") }))
        .cause,
    ).toBe("abort");
  });

  test("a BulkError is classified by the failures of its operations: an abort inside a bulk write is an abort, a quota is a quota", () => {
    const bulk = (...failures: Error[]) =>
      named("BulkError", {
        message: `drafts.bulkPut(): ${failures.length} operations failed`,
        failures,
      });
    expect(classifyFailure(bulk(named("AbortError"))).cause).toBe("abort");
    expect(classifyFailure(bulk(named("QuotaExceededError"))).cause).toBe(
      "quota",
    );
    // A mixed one: the quota wins (it is the one the engine must act on).
    expect(
      classifyFailure(bulk(named("AbortError"), named("QuotaExceededError")))
        .cause,
    ).toBe("quota");
    expect(classifyFailure(bulk(named("ConstraintError"))).cause).toBe("error");
    expect(classifyFailure(bulk()).cause).toBe("error");
    // A failure with no name does not throw.
    expect(
      classifyFailure(named("BulkError", { failures: [null, {}, 3] })).cause,
    ).toBe("error");
  });

  test("an allocation failure is its own fixed-shape signal about the device, never a message", () => {
    const failure = classifyFailure(
      new RangeError("Array buffer allocation failed"),
    );
    expect(isAllocationFailure(failure)).toBe(true);
    expect(failure.detail).toEqual({ stage: "alloc", reason: "range_error" });
    expect(JSON.stringify(failure)).not.toContain("buffer");
  });
});
