// @vitest-environment node
import { describe, expect, test } from "vitest";
import {
  failureVersion,
  recordWriteFailure,
  resetWriteFailure,
  type WriteFailures,
} from "../../src/data/model/retry";
import { recordLocalWriteOutcome } from "../../src/data/plans/retry-state";
import { pageWorld } from "../support/data/page-world";

/**
 * R53 (revision 32): a failure is a VERSION as well as a count.
 *
 * A count says how many consecutive failures an operation has; it cannot say which. Three failures, a reset and three more are the same
 * count, and a reset that was decided on the first three must not end the second. Each failure takes the next number of the row's
 * `local_write_seq` and stands under its operation in `local_write_versions`; the reset names the version it saw and clears only that
 * one, in the transaction that compares it. A streak with no version (a row written before versions) is version 0, which no failure
 * counted since is. This file is the model's and the plan's own contract (the callers are `outbox-retry-entitlement.test.ts` and
 * `engine-retry-entitlement.test.ts`).
 */
const EMPTY: WriteFailures = { local_write_streaks: {} };

describe("the model: a failure takes the next version, a reset names the one it saw", () => {
  test("each failure takes a version above every earlier one, and the versions of other operations are untouched", () => {
    const one = recordWriteFailure(EMPTY, "draft:a");
    expect(one.version).toBe(1);
    expect(one.streak).toBe(1);
    const two = recordWriteFailure(one.patch, "draft:b");
    expect(two.version).toBe(2);
    expect(two.patch.local_write_versions).toEqual({
      "draft:a": 1,
      "draft:b": 2,
    });
    const again = recordWriteFailure(two.patch, "draft:a");
    expect(again.version).toBe(3);
    expect(again.streak).toBe(2);
    expect(again.patch.local_write_versions).toEqual({
      "draft:a": 3,
      "draft:b": 2,
    });
    expect(failureVersion(again.patch, "draft:a")).toBe(3);
    expect(failureVersion(again.patch, "draft:c")).toBeNull();
  });

  test("the stop is the bound on the count, whatever the version", () => {
    let row: WriteFailures = EMPTY;
    const stops: boolean[] = [];
    for (let i = 0; i < 4; i += 1) {
      const next = recordWriteFailure(row, "draft:a");
      stops.push(next.stop);
      row = next.patch;
    }
    expect(stops).toEqual([false, false, true, true]);
  });

  test("a reset that names the version it saw ends it, and the version goes with the streak", () => {
    const row = recordWriteFailure(
      recordWriteFailure(EMPTY, "draft:a").patch,
      "draft:b",
    ).patch;
    const out = resetWriteFailure(row, "draft:a", 1);
    expect(out.cleared).toBe(true);
    expect(out.patch?.local_write_streaks).toEqual({ "draft:b": 1 });
    expect(out.patch?.local_write_versions).toEqual({ "draft:b": 2 });
  });

  test("a reset that names another version changes nothing and says which version stands (a newer failure; a count that comes back is not the same failure)", () => {
    let row: WriteFailures = EMPTY;
    for (let i = 0; i < 3; i += 1)
      row = recordWriteFailure(row, "draft:a").patch;
    const first = failureVersion(row, "draft:a");
    expect(first).toBe(3);
    // The failure is ended on the version it was seen, and three more come: the count is three again, the version is not.
    const ended = resetWriteFailure(row, "draft:a", first);
    expect(ended.cleared).toBe(true);
    row = { ...row, ...ended.patch } as WriteFailures;
    for (let i = 0; i < 3; i += 1)
      row = recordWriteFailure(row, "draft:a").patch;
    expect(row.local_write_streaks["draft:a"]).toBe(3);
    const stale = resetWriteFailure(row, "draft:a", first);
    expect(stale.cleared).toBe(false);
    expect(stale.patch).toBeNull();
    expect(stale.version).toBe(6);
  });

  test("a streak with no version is version 0; a reset that expects `null` does not end it; one that expects 0 does", () => {
    const planted: WriteFailures = { local_write_streaks: { "draft:a": 3 } };
    expect(failureVersion(planted, "draft:a")).toBe(0);
    expect(resetWriteFailure(planted, "draft:a", null).cleared).toBe(false);
    const ended = resetWriteFailure(planted, "draft:a", 0);
    expect(ended.cleared).toBe(true);
    expect(ended.patch?.local_write_streaks).toEqual({});
    // A failure counted on top of it has a version of its own.
    const next = recordWriteFailure(planted, "draft:a");
    expect(next.version).toBe(1);
    expect(resetWriteFailure(next.patch, "draft:a", 0).cleared).toBe(false);
  });

  test("an operation with no streak has nothing to end: the reset is a success and writes nothing", () => {
    const out = resetWriteFailure(EMPTY, "draft:a", null);
    expect(out).toEqual({ patch: null, cleared: true, version: null });
    expect(resetWriteFailure(EMPTY, "draft:a", 7).cleared).toBe(true);
  });

  test("the versions of operations that no longer have a streak are dropped by the next failure, so the record is as large as the streaks", () => {
    const stale: WriteFailures = {
      local_write_streaks: { "draft:b": 1 },
      local_write_versions: { "draft:a": 9, "draft:b": 10 },
      local_write_seq: 10,
    };
    const next = recordWriteFailure(stale, "draft:c");
    expect(next.patch.local_write_versions).toEqual({
      "draft:b": 10,
      "draft:c": 11,
    });
  });
});

describe("the plan: the same rules in the transaction that makes the write", () => {
  const input = (
    w: Awaited<ReturnType<typeof pageWorld>>,
    operation: string,
    outcome: { kind: "failure" } | { kind: "success"; expect: number | null },
  ) => ({ incarnationId: w.service.incarnationId, operation, outcome });

  test("a failure answers its version, and a reset on that version clears the streak and the version in one transaction", async () => {
    const w = await pageWorld({});
    const failed = await w.service.store.run(
      recordLocalWriteOutcome,
      input(w, "draft:a", { kind: "failure" }),
    );
    expect(failed).toMatchObject({ streak: 1, stop: false, version: 1 });
    expect(w.sync().local_write_versions).toEqual({ "draft:a": 1 });
    const ended = await w.service.store.run(
      recordLocalWriteOutcome,
      input(w, "draft:a", { kind: "success", expect: 1 }),
    );
    expect(ended).toMatchObject({ cleared: true, version: null });
    expect(w.sync().local_write_streaks).toEqual({});
    expect(w.sync().local_write_versions).toEqual({});
  });

  test("a reset on another version leaves the streak, answers the version that stands, and writes nothing", async () => {
    const w = await pageWorld({});
    await w.service.store.run(
      recordLocalWriteOutcome,
      input(w, "draft:a", { kind: "failure" }),
    );
    await w.service.store.run(
      recordLocalWriteOutcome,
      input(w, "draft:a", { kind: "failure" }),
    );
    const before = JSON.stringify(w.sync());
    const refused = await w.service.store.run(
      recordLocalWriteOutcome,
      input(w, "draft:a", { kind: "success", expect: 1 }),
    );
    expect(refused).toMatchObject({ cleared: false, version: 2, streak: 2 });
    expect(JSON.stringify(w.sync())).toBe(before);
  });

  test("a reset of an operation with no streak is a success that writes nothing, and the other operations' versions are untouched", async () => {
    const w = await pageWorld({});
    await w.service.store.run(
      recordLocalWriteOutcome,
      input(w, "draft:b", { kind: "failure" }),
    );
    const before = JSON.stringify(w.sync());
    const none = await w.service.store.run(
      recordLocalWriteOutcome,
      input(w, "draft:a", { kind: "success", expect: null }),
    );
    expect(none).toMatchObject({ cleared: true, version: null });
    expect(JSON.stringify(w.sync())).toBe(before);
  });

  test("an incarnation that is not the database's is refused by the guard, and changes nothing", async () => {
    const w = await pageWorld({});
    await w.service.store.run(
      recordLocalWriteOutcome,
      input(w, "draft:a", { kind: "failure" }),
    );
    const before = JSON.stringify(w.sync());
    await expect(
      w.service.store.run(recordLocalWriteOutcome, {
        incarnationId: "another-incarnation",
        operation: "draft:a",
        outcome: { kind: "success", expect: 1 },
      }),
    ).rejects.toMatchObject({ cause: "plan_rejected" });
    expect(JSON.stringify(w.sync())).toBe(before);
  });
});
