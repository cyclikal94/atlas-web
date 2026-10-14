// @vitest-environment node
import { describe, expect, test } from "vitest";
import {
  parseSyncMessage,
  type SyncMessage,
} from "../../src/data/engine/sync-channel";
import {
  A,
  B,
  type LeaderPage,
  type LeaderWorld,
  leaderWorld,
} from "../support/data/leader-world";
import { projection, Rng, uuid } from "../support/data/sync-pages";

/**
 * WEB-08c revision 3 (R5 of the review of 14 October 2026, T24 D; design assessment S9): the recovery job's report (state 2 "Catching up",
 * state 3 "Couldn't finish catching up") was the page memory of the LEADING page only. Every other page of the account kept showing
 * "Catching up" after the recovery had stopped, with no "Try again" (found by the composed native case LR-6). The leading page now
 * announces each report on `atlas-sync` for the identity it serves; a page that does not lead adopts it only for exactly its own
 * (account, epoch), drops it when its identity changes, and asks for the standing report when it starts. The hint selects a neutral card
 * only: it never authorises a display (the native cases run under the display oracle).
 */
const snapshotServer = (w: LeaderWorld): void => {
  w.server = (request) => {
    if (request.path !== "/sync") return w.status(404);
    if (request.cursor === null)
      return w.json({
        phase: "snapshot",
        hasMore: false,
        nextCursor: "delta-1",
        batches: [
          {
            revision: 10,
            changes: [
              {
                kind: "upsert",
                resource: { ...projection(new Rng(1), 1), id: uuid(1) },
              },
            ],
          },
        ],
      });
    return w.json({
      phase: "delta",
      hasMore: false,
      nextCursor: request.cursor,
      batches: [],
    });
  };
};

/**
 * Two pages of account A; A leads. Then the account is FENCED in both (a neutral state) and the leader's `begin` is refused: its job stops
 * in recovery mode and reports "failed".
 */
async function stoppedRecovery() {
  const w = leaderWorld();
  snapshotServer(w);
  const one = w.page("A");
  await w.settle();
  const two = w.page("B");
  await w.settle();
  expect(one.leader.role.get()).toEqual({ kind: "leader" });
  expect(two.leader.role.get()).toEqual({ kind: "follower" });
  // Every `begin` of the leader is refused while the check runs (a current-epoch entry stands): its job stays stopped.
  for (let i = 0; i < 200; i += 1)
    one.begins.push({ kind: "ineligible", reason: "current_epoch_entry" });
  for (const page of [one, two])
    page.view.set({ kind: "neutral", state: "2" as never });
  await w.settle();
  return { w, one, two };
}
const last = (page: LeaderPage) => page.reports.at(-1);

describe("the leading page's recovery report reaches the other pages of the account (WEB-08c revision 3)", () => {
  test("a follower adopts the leader's 'failed' report for its own account and epoch, so it shows state 3 too", async () => {
    const { one, two } = await stoppedRecovery();
    expect(last(one)).toBe("failed");
    expect(last(two)).toBe("failed");
  });

  test("a page opened AFTER the report asks for the standing one and adopts it", async () => {
    const { w, one } = await stoppedRecovery();
    expect(last(one)).toBe("failed");
    const three = w.page("C");
    three.view.set({ kind: "neutral", state: "2" as never });
    await w.settle();
    expect(three.leader.role.get()).toEqual({ kind: "follower" });
    expect(last(three)).toBe("failed");
  });

  test("the leader's later reports follow: 'none' when the recovery is over is adopted as no report", async () => {
    const { w, one, two } = await stoppedRecovery();
    expect(last(two)).toBe("failed");
    // The account is displayed again (the session cleared the fence): the job ends its recovery run and reports nothing.
    one.begins.length = 0;
    for (const page of [one, two])
      page.view.set({ kind: "displaying", account_id: A, epoch: 1 });
    await w.settle();
    expect(last(one)).toBeNull();
    expect(last(two)).toBeNull();
  });

  for (const [what, message] of [
    [
      "another epoch",
      { type: "recovery_state", account: A, epoch: 2, phase: "none" },
    ],
    [
      "another account",
      { type: "recovery_state", account: B, epoch: 1, phase: "none" },
    ],
  ] as const)
    test(`control: a report for ${what} is not adopted (it neither replaces nor withdraws the page's own)`, async () => {
      const { w, two } = await stoppedRecovery();
      expect(last(two)).toBe("failed");
      const before = [...two.reports];
      w.hint(message as SyncMessage);
      await w.settle();
      expect(two.reports).toEqual(before);
    });

  test("control: the leading page never adopts another page's report (its own job's is the one it shows)", async () => {
    const { w, one } = await stoppedRecovery();
    const before = [...one.reports];
    w.hint({
      type: "recovery_state",
      account: A,
      epoch: 1,
      phase: "catching_up",
    });
    await w.settle();
    expect(one.reports).toEqual(before);
  });

  test("a page showing the recovery card is NOT re-evaluated by a report that changes nothing, and an identical report is applied once", async () => {
    const w = leaderWorld();
    snapshotServer(w);
    const one = w.page("A");
    await w.settle();
    const two = w.page("B");
    await w.settle();
    two.view.set({ kind: "neutral", state: "2" as never });
    await w.settle();
    const before = [...two.reports];
    w.hint({ type: "recovery_state", account: A, epoch: 1, phase: "none" });
    await w.settle();
    expect(two.reports).toEqual(before);
    w.hint({ type: "recovery_state", account: A, epoch: 1, phase: "failed" });
    w.hint({ type: "recovery_state", account: A, epoch: 1, phase: "failed" });
    await w.settle();
    expect(two.reports).toEqual([...before, "failed"]);
    void one;
  });

  test("T22 (i): a page that is NOT showing the recovery card (displaying, gated, hidden or frozen) is never given a report, so a hint never wakes it; it takes the kept report once it shows card 2", async () => {
    const w = leaderWorld();
    snapshotServer(w);
    const one = w.page("A");
    await w.settle();
    const two = w.page("B");
    await w.settle();
    expect(two.view.get().kind).toBe("displaying");
    const before = [...two.reports];
    w.hint({ type: "recovery_state", account: A, epoch: 1, phase: "failed" });
    await w.settle();
    expect(two.reports).toEqual(before);
    two.view.set({ kind: "neutral", state: "2" as never });
    await w.settle();
    expect(last(two)).toBe("failed");
    void one;
  });

  test("a follower whose identity changes drops the adopted report", async () => {
    const { w, two } = await stoppedRecovery();
    expect(last(two)).toBe("failed");
    two.identity.move(A, 2);
    await w.settle();
    expect(last(two)).toBeNull();
  });

  test("the messages are part of the channel's closed union, and malformed ones are ignored", () => {
    expect(
      parseSyncMessage({
        type: "recovery_state",
        account: A,
        epoch: 3,
        phase: "failed",
      }),
    ).toEqual({
      type: "recovery_state",
      account: A,
      epoch: 3,
      phase: "failed",
    });
    expect(
      parseSyncMessage({ type: "recovery_state_query", account: A, epoch: 0 }),
    ).toEqual({ type: "recovery_state_query", account: A, epoch: 0 });
    for (const bad of [
      { type: "recovery_state", account: A, epoch: 3, phase: "stopped" },
      { type: "recovery_state", account: A, epoch: "3", phase: "failed" },
      { type: "recovery_state", account: "", epoch: 3, phase: "none" },
      { type: "recovery_state_query", account: A, epoch: -1 },
      { type: "recovery_state_query", account: A },
    ])
      expect(parseSyncMessage(bad)).toBeNull();
  });
});
