// @vitest-environment node
import { describe, expect, test } from "vitest";
import { DATA_CONFIG } from "../../src/data/model/config";
import {
  atFloor,
  classify,
  initialLimit,
  initialState,
  isAllocationError,
  lowerRung,
  next,
  resetFloor,
  type SizingOutcome,
} from "../../src/data/model/sizing";
import type { SizingState } from "../../src/data/model/types";

const state = (over: Partial<SizingState> = {}): SizingState => ({
  limit: 4,
  class: "unconstrained",
  floor_hits: 0,
  attempt: null,
  ...over,
});
const FAIL: SizingOutcome[] = [
  { kind: "allocation_failed" },
  { kind: "commit_failed", cause: "abort" },
  { kind: "commit_failed", cause: "error" },
  { kind: "watchdog", elapsedMs: 31_000 },
  { kind: "crashed_attempt" },
];

describe("F-Z1: the device class selects the initial rung", () => {
  test("8 GiB or more is unconstrained; below is constrained; ABSENT is unknown and never assumed unconstrained", () => {
    expect(classify({ deviceMemoryGiB: 8, hasStorageEstimate: true })).toBe(
      "unconstrained",
    );
    expect(classify({ deviceMemoryGiB: 16, hasStorageEstimate: true })).toBe(
      "unconstrained",
    );
    expect(classify({ deviceMemoryGiB: 4, hasStorageEstimate: true })).toBe(
      "constrained",
    );
    expect(classify({ deviceMemoryGiB: 0.5, hasStorageEstimate: true })).toBe(
      "constrained",
    );
    expect(classify({ hasStorageEstimate: true })).toBe("unknown");
    expect(
      classify({ deviceMemoryGiB: Number.NaN, hasStorageEstimate: false }),
    ).toBe("unknown");
  });
  test("the initial rung: 4 for unconstrained, 1 for the others, never above the SyncPage maximum", () => {
    expect(initialLimit("unconstrained")).toBe(4);
    expect(initialLimit("constrained")).toBe(1);
    expect(initialLimit("unknown")).toBe(1);
    expect(
      initialLimit("unconstrained", {
        initialLimitUnconstrained: 500,
        initialLimitOther: 1,
        syncLimitMax: 80,
      }),
    ).toBe(80);
  });
  test("F-Z6: the whole path works with NO device-memory signal (the Firefox and Safari case)", () => {
    const s = initialState({ hasStorageEstimate: false });
    expect(s).toEqual({
      limit: 1,
      class: "unknown",
      floor_hits: 0,
      attempt: null,
    });
    // It can still make progress and still be stepped down or floored by what actually happens.
    expect(
      next(s, { kind: "admitted", bytes: 10, changes: 1, durationMs: 1 })
        .action,
    ).toBe("continue");
    expect(next(s, { kind: "allocation_failed" }).action).toBe("retry_same");
  });
});

describe("F-Z2: what steps down, and what never does", () => {
  test("each of the five signals steps down one rung", () => {
    for (const outcome of FAIL) {
      const out = next(state({ limit: 4 }), outcome);
      expect(out.action, outcome.kind).toBe("retry_lower");
      expect(out.state.limit).toBe(2);
      const again = next(out.state, outcome);
      expect(again.state.limit).toBe(1);
    }
  });
  test("`oversize` (a contract violation) and `quota` (a smaller page creates no space) NEVER step down (MU-34, MU-35)", () => {
    for (const outcome of [{ kind: "oversize" }, { kind: "quota" }] as const) {
      for (const limit of [4, 2, 1]) {
        const out = next(state({ limit, floor_hits: 1 }), outcome);
        expect(out.action).toBe("continue");
        expect(out.state.limit).toBe(limit);
        expect(out.state.floor_hits).toBe(1);
      }
    }
  });
  test("the ladder ends at limit = 1 and there is no step-up while it is disabled", () => {
    expect(DATA_CONFIG.stepUpAfterSuccesses).toBeNull();
    expect(lowerRung(80)).toBe(40);
    expect(lowerRung(3)).toBe(1);
    expect(lowerRung(1)).toBe(1);
    let s = state({ limit: 1 });
    for (let i = 0; i < 50; i += 1)
      s = next(s, {
        kind: "admitted",
        bytes: 1,
        changes: 1,
        durationMs: 1,
      }).state;
    expect(s.limit).toBe(1);
  });
  test("a success clears the crash marker and the count of failures at the lowest rung", () => {
    const out = next(
      state({
        limit: 1,
        floor_hits: 2,
        attempt: { id: "a", limit: 1, started_at: 1 },
      }),
      { kind: "admitted", bytes: 1, changes: 1, durationMs: 1 },
    );
    expect(out.state).toMatchObject({ floor_hits: 0, attempt: null });
  });
});

describe("F-Z4: the floor is reached ONLY by repeated failure at the lowest rung", () => {
  test("one failure at limit = 1 is not the floor; FLOOR_AFTER of them are (MU-36)", () => {
    let s = state({ limit: 1 });
    const trace: string[] = [];
    for (let i = 0; i < DATA_CONFIG.floorAfter; i += 1) {
      const out = next(s, { kind: "allocation_failed" });
      trace.push(out.action);
      s = out.state;
    }
    expect(trace).toEqual(["retry_same", "retry_same", "floor"]);
    expect(atFloor(s)).toBe(true);
  });
  test("a local commit abort or error at the lowest rung never counts toward the floor (it has its own terminal state)", () => {
    let s = state({ limit: 1 });
    for (let i = 0; i < 10; i += 1) {
      const out = next(s, { kind: "commit_failed", cause: "abort" });
      expect(out.action).toBe("retry_same");
      s = out.state;
    }
    expect(s.floor_hits).toBe(0);
    expect(atFloor(s)).toBe(false);
  });
  test("a failure ABOVE the lowest rung never counts toward the floor", () => {
    let s = state({ limit: 4 });
    for (const _ of [1, 2]) s = next(s, { kind: "allocation_failed" }).state;
    expect(s).toMatchObject({ limit: 1, floor_hits: 0 });
    expect(atFloor(s)).toBe(false);
  });
  test('"Try again" resets the count and keeps the lowest rung', () => {
    const floored = state({ limit: 1, floor_hits: 3 });
    expect(atFloor(floored)).toBe(true);
    const again = resetFloor(floored);
    expect(again).toMatchObject({ limit: 1, floor_hits: 0 });
    expect(atFloor(again)).toBe(false);
  });
  test("an interleaved success restarts the count: the floor needs CONSECUTIVE failures", () => {
    let s = state({ limit: 1 });
    s = next(s, { kind: "allocation_failed" }).state;
    s = next(s, { kind: "allocation_failed" }).state;
    s = next(s, {
      kind: "admitted",
      bytes: 1,
      changes: 1,
      durationMs: 1,
    }).state;
    s = next(s, { kind: "allocation_failed" }).state;
    expect(s.floor_hits).toBe(1);
  });
});

describe("R44: what counts as an allocation failure when it is thrown", () => {
  test("a RangeError (and anything built on one) is the device's signal", () => {
    expect(
      isAllocationError(new RangeError("Array buffer allocation failed")),
    ).toBe(true);
    expect(
      isAllocationError(
        new RangeError("Invalid typed array length: 99999999999"),
      ),
    ).toBe(true);
    class Named extends RangeError {}
    expect(isAllocationError(new Named("a subclass"))).toBe(true);
  });
  test("a fault of the data, a defect and a storage failure are not", () => {
    expect(isAllocationError(new SyntaxError("Unexpected token"))).toBe(false);
    expect(
      isAllocationError(
        new TypeError("The encoded data was not valid for encoding utf-8"),
      ),
    ).toBe(false);
    expect(isAllocationError(new Error("a defect"))).toBe(false);
    expect(
      isAllocationError(new DOMException("full", "QuotaExceededError")),
    ).toBe(false);
    expect(isAllocationError({ name: "RangeError" })).toBe(false);
    for (const value of [null, undefined, "RangeError", 0, {}])
      expect(isAllocationError(value)).toBe(false);
  });
});
