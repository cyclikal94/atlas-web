// @vitest-environment node
import { describe, expect, test } from "vitest";
import {
  parseSyncMessage,
  type SyncMessage,
} from "../../src/data/engine/sync-channel";
import { STATUS_ASK_MAX_MS } from "../../src/data/leader/leader";
import {
  A,
  B,
  type LeaderPage,
  type LeaderWorld,
  leaderWorld,
} from "../support/data/leader-world";
import { projection, Rng, uuid } from "../support/data/sync-pages";

/** A report as another page's leader would post it (WEB-08c revision 4: every report names its producer and its sequence there). */
const report = (
  fields: {
    account: string;
    epoch: number;
    phase: "catching_up" | "failed" | "none";
  },
  producer = "outside-producer",
  seq = 1,
  failure?: string,
): SyncMessage => ({
  type: "recovery_state",
  ...fields,
  producer,
  seq,
  ...(failure === undefined ? {} : { failure }),
});

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
    // ADAPTATION (WEB-08c revision 4, R9): the original asserted `last(two) === null` at once. A displaying follower is no longer given
    // any report (a report never wakes a page that does not show card 2 or 3: T22 (i)), and its session withdraws the old report at its
    // own record read (the fence is gone; `tests/session/recovery-api.test.ts`). The original intent, "the follower adopts 'none' and keeps
    // no state 3 once the recovery is over", is asserted on the follower's kept report: should the page come to show card 3 again, it is
    // given no report (null), never the old "failed".
    two.view.set({ kind: "neutral", state: "3" as never });
    await w.settle();
    expect(last(two)).toBeNull();
  });

  for (const [what, message] of [
    ["another epoch", report({ account: A, epoch: 2, phase: "none" })],
    ["another account", report({ account: B, epoch: 1, phase: "none" })],
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
    w.hint(report({ account: A, epoch: 1, phase: "catching_up" }));
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
    w.hint(report({ account: A, epoch: 1, phase: "none" }, "p", 1));
    await w.settle();
    expect(two.reports).toEqual(before);
    w.hint(report({ account: A, epoch: 1, phase: "failed" }, "p", 2));
    w.hint(report({ account: A, epoch: 1, phase: "failed" }, "p", 3));
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
    // ADAPTATION (WEB-08c revision 4, R9): the original posted the "failed" report from outside the pages. The leading page now answers
    // every question with ITS report ("none" included), so a report no leader stands behind is replaced by the leader's answer when the
    // page asks; the leading page's OWN failure is used instead (the same hint, from the producer that a follower asks). The original
    // assertions are unchanged.
    for (let i = 0; i < 200; i += 1)
      one.begins.push({ kind: "ineligible", reason: "current_epoch_entry" });
    one.view.set({ kind: "neutral", state: "2" as never });
    await w.settle();
    expect(last(one)).toBe("failed");
    expect(
      w.posted.some(
        (p) =>
          p.from === "A" &&
          p.message.type === "recovery_state" &&
          p.message.phase === "failed",
      ),
    ).toBe(true);
    expect(two.reports).toEqual(before);
    two.view.set({ kind: "neutral", state: "2" as never });
    await w.settle();
    expect(last(two)).toBe("failed");
  });

  test("a follower whose identity changes drops the adopted report", async () => {
    const { w, two } = await stoppedRecovery();
    expect(last(two)).toBe("failed");
    two.identity.move(A, 2);
    await w.settle();
    // ADAPTATION (WEB-08c revision 4, R9): the original asserted `last(two) === null` right after the move. `move` displays the page, and a
    // displaying page is given nothing (T22 (i)); the session itself withdraws a report of another identity at its record read (scope
    // mismatch: `tests/session/recovery-api.test.ts`). The original intent is asserted where it can bite: the report kept for (A, 1) is
    // never given for (A, 2). When the page shows card 3 at (A, 2), it is given null, scoped to (A, 2).
    two.view.set({ kind: "neutral", state: "3" as never });
    await w.settle();
    expect(last(two)).toBeNull();
    expect(two.scopes.at(-1)).toEqual({ account: A, epoch: 2 });
  });

  test("the messages are part of the channel's closed union, and malformed ones are ignored", () => {
    const full = {
      type: "recovery_state",
      account: A,
      epoch: 3,
      phase: "failed",
      producer: "p",
      seq: 4,
      failure: "p:1",
    } as const;
    expect(parseSyncMessage(full)).toEqual(full);
    expect(
      parseSyncMessage({
        type: "recovery_state",
        account: A,
        epoch: 3,
        phase: "none",
        producer: "p",
        seq: 0,
      }),
    ).toEqual({
      type: "recovery_state",
      account: A,
      epoch: 3,
      phase: "none",
      producer: "p",
      seq: 0,
    });
    expect(
      parseSyncMessage({ type: "recovery_state_query", account: A, epoch: 0 }),
    ).toEqual({ type: "recovery_state_query", account: A, epoch: 0 });
    expect(
      parseSyncMessage({
        type: "retry_requested",
        account: A,
        epoch: 1,
        failure: "p:1",
      }),
    ).toEqual({
      type: "retry_requested",
      account: A,
      epoch: 1,
      failure: "p:1",
    });
    for (const bad of [
      { ...full, phase: "stopped" },
      { ...full, epoch: "3" },
      { ...full, account: "" },
      { ...full, producer: undefined },
      { ...full, seq: -1 },
      { ...full, failure: "" },
      // The revision-3 form (no producer, no sequence) is no longer a report.
      { type: "recovery_state", account: A, epoch: 3, phase: "failed" },
      { type: "recovery_state_query", account: A, epoch: -1 },
      { type: "recovery_state_query", account: A },
      { type: "retry_requested", account: A, epoch: 1, failure: 7 },
    ])
      expect(parseSyncMessage(bad)).toBeNull();
  });
});

/**
 * WEB-08c revision 4 (R9 of the review of 14 October 2026; design assessment P3, S2/S4/S6/S8/S11; RECOVERY-NAVIGATION-ENROLMENT-20261014
 * D1): one report is not reliable state. A follower that shows state 2 or 3 and is visible keeps ASKING, paced, and the leading page answers
 * every question with its current report; reports are ordered per producer; an unbinding producer announces nothing; a retry names the
 * failure it was pressed against. Each schedule counts the messages it lost, so a "pass" cannot come from a loss that never happened.
 */
describe("R9: lost, late and spent recovery messages (WEB-08c revision 4)", () => {
  const reportsFrom = (w: LeaderWorld, from: string) =>
    w.posted.filter(
      (
        p,
      ): p is {
        from: string;
        message: Extract<SyncMessage, { type: "recovery_state" }>;
      } => p.from === from && p.message.type === "recovery_state",
    );
  const questionsFrom = (w: LeaderWorld, from: string) =>
    w.posted.filter(
      (p) => p.from === from && p.message.type === "recovery_state_query",
    );
  /** Two pages; B shows card 2 first (it asks), then A's recovery stops ("failed"). */
  async function followerOnCard2(drop: LeaderWorld["drop"] = null) {
    const w = leaderWorld();
    snapshotServer(w);
    const one = w.page("A");
    await w.settle();
    const two = w.page("B");
    await w.settle();
    two.view.set({ kind: "neutral", state: "2" as never });
    await w.settle();
    w.drop = drop;
    for (let i = 0; i < 200; i += 1)
      one.begins.push({ kind: "ineligible", reason: "current_epoch_entry" });
    one.view.set({ kind: "neutral", state: "2" as never });
    await w.settle();
    expect(last(one)).toBe("failed");
    return { w, one, two };
  }

  /** Loses the first `n` "failed" reports of the leading page A (its announcement first, then its answers). */
  const loseFailed = (n: number) => {
    let lost = 0;
    return (m: SyncMessage, from: string) => {
      if (from !== "A" || m.type !== "recovery_state" || m.phase !== "failed")
        return false;
      lost += 1;
      return lost <= n;
    };
  };

  test("S2 (lost report): the leader's 'failed' never reaches the follower; its next paced question is answered and it shows state 3", async () => {
    const { w, two } = await followerOnCard2(loseFailed(1));
    expect(
      w.dropped.filter(
        (d) =>
          d.message.type === "recovery_state" && d.message.phase === "failed",
      ),
    ).toHaveLength(1);
    expect(two.view.get()).toMatchObject({ state: "2" });
    expect(two.reports).not.toContain("failed");
    const asked = questionsFrom(w, "B").length;
    await w.advance(STATUS_ASK_MAX_MS);
    expect(last(two)).toBe("failed");
    expect(two.view.get()).toMatchObject({ state: "3" });
    // It was the answer to a LATER question: a second "failed" of the same producer, with a newer sequence.
    expect(questionsFrom(w, "B").length).toBeGreaterThan(asked);
    const failed = reportsFrom(w, "A").filter(
      (p) => p.message.phase === "failed",
    );
    expect(failed.length).toBeGreaterThanOrEqual(2);
    expect(failed[1]?.message.seq).toBeGreaterThan(
      failed[0]?.message.seq ?? Number.POSITIVE_INFINITY,
    );
  });

  test("S2 (lost question, then lost answer): each loss only delays the follower", async () => {
    let questionsLost = 0;
    let failedLost = 0;
    const { w, two } = await followerOnCard2((m, from) => {
      // The leader's announcement and its first answer are lost, and the follower's first question after the failure.
      if (
        from === "A" &&
        m.type === "recovery_state" &&
        m.phase === "failed" &&
        failedLost < 2
      ) {
        failedLost += 1;
        return true;
      }
      if (
        from === "B" &&
        m.type === "recovery_state_query" &&
        failedLost > 0 &&
        questionsLost < 1
      ) {
        questionsLost += 1;
        return true;
      }
      return false;
    });
    await w.advance(2 * STATUS_ASK_MAX_MS);
    expect(questionsLost).toBe(1);
    expect(failedLost).toBe(2);
    expect(last(two)).toBe("failed");
    expect(two.view.get()).toMatchObject({ state: "3" });
  });

  test("the leader answers a question with 'none' too, and only for its own bound identity", async () => {
    const w = leaderWorld();
    snapshotServer(w);
    w.page("A");
    await w.settle();
    w.hint({ type: "recovery_state_query", account: A, epoch: 1 });
    w.hint({ type: "recovery_state_query", account: A, epoch: 2 });
    w.hint({ type: "recovery_state_query", account: B, epoch: 1 });
    await w.settle();
    const answers = reportsFrom(w, "A").map((p) => p.message);
    expect(answers).toHaveLength(1);
    expect(answers[0]).toMatchObject({ account: A, epoch: 1, phase: "none" });
  });

  test("S4: a late report of the SAME producer cannot replace its newer one; a newer one does", async () => {
    const { w, two } = await followerOnCard2();
    expect(two.view.get()).toMatchObject({ state: "3" });
    w.hint(report({ account: A, epoch: 1, phase: "failed" }, "p", 5, "p:9"));
    await w.settle();
    const before = [...two.reports];
    // Older than the producer's last: ignored (an old "none" cannot erase a newer stop).
    w.hint(report({ account: A, epoch: 1, phase: "none" }, "p", 4));
    w.hint(report({ account: A, epoch: 1, phase: "none" }, "p", 5));
    await w.settle();
    expect(two.reports).toEqual(before);
    expect(two.view.get()).toMatchObject({ state: "3" });
    // Newer: applied.
    w.hint(report({ account: A, epoch: 1, phase: "none" }, "p", 6));
    await w.settle();
    expect(last(two)).toBeNull();
    expect(two.view.get()).toMatchObject({ state: "2" });
  });

  test("S6: a producer that unbinds or goes away announces nothing; the follower's next question reaches the new leader", async () => {
    const { w, one, two } = await followerOnCard2();
    const before = reportsFrom(w, "A").length;
    w.destroy("A");
    await w.settle();
    // The dying leader's own job withdrew its report on ITS page (unbind) but posted no "none".
    expect(reportsFrom(w, "A")).toHaveLength(before);
    expect(last(one)).toBeNull();
    expect(two.leader.role.get()).toEqual({ kind: "leader" });
  });

  test("S8: a HIDDEN follower neither asks nor is given a report; it asks and shows state 3 when visible again", async () => {
    const w = leaderWorld();
    snapshotServer(w);
    const one = w.page("A");
    await w.settle();
    const two = w.page("B");
    await w.settle();
    two.setVisible(false);
    two.view.set({ kind: "neutral", state: "2" as never });
    await w.settle();
    // Nothing is lost: the hidden page RECEIVES the leader's "failed" and keeps it, but is not given it (nor asks) until it is visible.
    for (let i = 0; i < 200; i += 1)
      one.begins.push({ kind: "ineligible", reason: "current_epoch_entry" });
    one.view.set({ kind: "neutral", state: "2" as never });
    await w.settle();
    const asked = questionsFrom(w, "B").length;
    await w.advance(4 * STATUS_ASK_MAX_MS);
    expect(questionsFrom(w, "B")).toHaveLength(asked);
    expect(two.reports).not.toContain("failed");
    two.setVisible(true);
    await w.settle();
    expect(questionsFrom(w, "B").length).toBeGreaterThan(asked);
    expect(last(two)).toBe("failed");
  });

  test("S11: a follower's retry names the failure it saw; the leader acts on it while it stands, never on a spent one; a retry naming no failure (a sync notice) still acts", async () => {
    const { w, one, two } = await followerOnCard2();
    const failed = reportsFrom(w, "A")
      .filter((p) => p.message.phase === "failed")
      .at(-1)?.message;
    expect(failed?.failure).toBeDefined();
    const begun = () => 200 - one.begins.length;
    const atStart = begun();
    two.leader.retryUpdates({ account: A, epoch: 1 });
    await w.settle();
    const sent = w.posted
      .filter((p) => p.from === "B" && p.message.type === "retry_requested")
      .at(-1);
    expect(sent?.message).toEqual({
      type: "retry_requested",
      account: A,
      epoch: 1,
      failure: failed?.failure,
    });
    expect(begun()).toBeGreaterThan(atStart);
    const afterRetry = begun();
    w.hint({
      type: "retry_requested",
      account: A,
      epoch: 1,
      failure: "spent:1",
    });
    await w.settle();
    expect(begun()).toBe(afterRetry);
    w.hint({ type: "retry_requested", account: A, epoch: 1 });
    await w.settle();
    expect(begun()).toBeGreaterThan(afterRetry);
  });

  test("D1 (accepted limit, RECOVERY-NAVIGATION-ENROLMENT-20261014): with NO working channel the follower learns no failure and its retry reaches no leader; the leading page shows state 3", async () => {
    const { w, one, two } = await followerOnCard2(() => true);
    await w.advance(4 * STATUS_ASK_MAX_MS);
    expect(last(one)).toBe("failed");
    expect(two.reports).not.toContain("failed");
    expect(two.view.get()).toMatchObject({ state: "2" });
    const atStart = one.begins.length;
    two.leader.retryUpdates({ account: A, epoch: 1 });
    await w.settle();
    expect(one.begins.length).toBe(atStart);
    // It kept asking (paced, bounded by the cap), and every question was lost.
    expect(questionsFrom(w, "B").length).toBeGreaterThan(2);
    expect(w.dropped.length).toBeGreaterThan(2);
  });

  test("control: the paced questions are bounded (1 s doubling to 30 s) and stop when the card goes", async () => {
    const { w, two } = await followerOnCard2();
    const t0 = questionsFrom(w, "B").length;
    await w.advance(10 * STATUS_ASK_MAX_MS);
    const asked = questionsFrom(w, "B").length - t0;
    // 1+2+4+8+16 s then every 30 s: about 5 + 9 in 300 s; never one per second.
    expect(asked).toBeGreaterThan(5);
    expect(asked).toBeLessThan(20);
    two.view.set({ kind: "displaying", account_id: A, epoch: 1 });
    await w.settle();
    const stopped = questionsFrom(w, "B").length;
    await w.advance(10 * STATUS_ASK_MAX_MS);
    expect(questionsFrom(w, "B")).toHaveLength(stopped);
  });
});
