// @vitest-environment node
import { describe, expect, test } from "vitest";
import { accountDatabaseName } from "../../src/data/model/schema";
import type { DraftRow } from "../../src/data/model/types";
import { StampedRequestError } from "../../src/session";
import {
  A,
  B,
  type LeaderPage,
  type LeaderWorld,
  leaderWorld,
} from "../support/data/leader-world";
import {
  type PageSpec,
  projection,
  Rng,
  uuid,
} from "../support/data/sync-pages";

/**
 * F-13b-1 (WEB-13b revision 3; handover `delivery/handoffs/web13b-foundation-403-approved-20261025.md`): an ISSUED queued command's answer
 * belongs to the draft, not to the dispatcher run that sent it. The session's handling of a `403` closes the account's display for a
 * moment (the interim hold, set before the body is classified; `session/kernel/send.ts`), and the leader stops the dispatcher for it; an
 * ordinary `403 forbidden` then releases the hold and the display opens again, so the leader starts a new run. The answer that arrives
 * meanwhile was dropped with the run that ended, the draft stayed `in_flight` with no attempt counted, and the new run sent it again:
 * one `POST` after another for as long as the server refused it. Production leadership (`createSyncLeader`, its dispatcher, its view and
 * binding) over the deterministic world; the session's interim hold is the view's closure and reopening, in both orders around the answer.
 * A binding that ENDS (another identity) still drops the answer: it is the next owner's to send again, under the same key (F-2).
 */
const upsert = (n: number) => ({
  kind: "upsert" as const,
  resource: { ...projection(new Rng(n), n), id: uuid(n) },
});
const snapshot = (over: Partial<PageSpec> = {}): PageSpec => ({
  phase: "snapshot",
  hasMore: false,
  nextCursor: "delta-1",
  batches: [{ revision: 10, changes: [upsert(1)] }],
  ...over,
});
const LOCAL_ID = "33333333-0000-4000-8000-0000000000f1";
const forbidden = {
  code: "forbidden",
  message: "m",
  request_id: uuid(9),
  details: [],
};
const invalid = {
  code: "invalid_value",
  message: "m",
  request_id: uuid(9),
  details: [],
};

/** The commands sent, and the one draft as the database holds it. */
const posts = (w: LeaderWorld) =>
  w.requests.filter((r) => r.path === "/commands");
const draft = (w: LeaderWorld, account = A) =>
  (
    (w.env.idb.snapshot(accountDatabaseName(account))?.drafts ??
      []) as DraftRow[]
  ).find((d) => d.local_id === LOCAL_ID);

/**
 * A leader page with one queued command whose FIRST send is held until `answer`; every later send of it is answered with the same
 * status at once (the loop the defect made).
 */
async function heldCommand(
  status: number,
  body: unknown,
  /** The FIRST send fails with this instead (the session refused it for its credentials, say). */
  failure?: Error,
) {
  const w = leaderWorld();
  const respond = () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  let release: () => void = () => undefined;
  w.server = (request) => {
    if (request.path === "/commands") {
      if (posts(w).length === 1)
        return new Promise<Response>((resolve, reject) => {
          release = () =>
            failure === undefined ? resolve(respond()) : reject(failure);
        });
      return respond();
    }
    if (request.path !== "/sync") return w.status(404);
    if (request.cursor === null) return w.json(snapshot());
    return w.json({
      phase: "delta",
      hasMore: false,
      nextCursor: request.cursor,
      batches: [],
    });
  };
  const one = w.page("A");
  await w.settle();
  const outbox = one.leader.outbox();
  if (outbox === null) throw new Error("setup: no outbox");
  const saved = await w.env.run(
    outbox.enqueue({
      endpoint: "/commands",
      targets: [],
      localId: LOCAL_ID,
      build: () => ({ command: { kind: "note", body: "x" } }),
    } as never),
  );
  expect(saved).toMatchObject({ kind: "queued" });
  await w.settle();
  expect(posts(w)).toHaveLength(1);
  expect(draft(w)?.status).toBe("in_flight");
  return {
    w,
    one,
    answer: async () => {
      release();
      await w.settle();
    },
  };
}

/** The session's interim hold: the account's display closes (a neutral state; the recovery job is not eligible for it). */
async function holdDisplay(w: LeaderWorld, one: LeaderPage) {
  one.begins.push({ kind: "ineligible", reason: "current_epoch_entry" });
  one.view.set({ kind: "neutral", state: "1d.reauth" as never });
  await w.settle();
  // The leader stopped its dispatcher for it.
  expect(one.leader.dispatcher.state.get()).toEqual({ kind: "not_started" });
}
async function reopenDisplay(w: LeaderWorld, one: LeaderPage) {
  one.view.set({ kind: "displaying", account_id: A, epoch: 1 });
  await w.settle();
}

describe("F-13b-1: an issued command's answer is the draft's, whatever became of the run that sent it", () => {
  test.each([
    [
      "the display opens again before the answer is handled (the session's order)",
      true,
    ],
    ["the answer is handled while the display is still closed", false],
  ])(
    "an ordinary 403 forbidden: sent once and rejected, attempt counted; %s",
    async (_, reopenFirst) => {
      const { w, one, answer } = await heldCommand(403, forbidden);
      await holdDisplay(w, one);
      if (reopenFirst) await reopenDisplay(w, one);
      await answer();
      if (!reopenFirst) await reopenDisplay(w, one);
      await w.advance(5 * 60_000);
      expect(
        posts(w),
        "a returned domain refusal is never replayed",
      ).toHaveLength(1);
      expect(draft(w)).toMatchObject({ status: "rejected", attempts: 1 });
      expect(draft(w)?.last_error).toMatchObject({
        status: 403,
        code: "forbidden",
      });
      // The run that stands goes on: a later command is sent, once.
      const outbox = one.leader.outbox();
      if (outbox === null) throw new Error("no outbox");
      w.server = (request) =>
        request.path === "/commands"
          ? new Response(JSON.stringify({ revision: 31 }), {
              status: 200,
              headers: { "content-type": "application/json" },
            })
          : w.json({
              phase: "delta",
              hasMore: false,
              nextCursor: request.cursor ?? "x",
              batches: [],
            });
      await w.env.run(
        outbox.enqueue({
          endpoint: "/commands",
          targets: [],
          build: () => ({ command: { kind: "note", body: "later" } }),
        }),
      );
      await w.settle();
      expect(posts(w)).toHaveLength(2);
    },
  );

  test("a 422 answered under the same interruption is the draft's too (the run's end, not the status, lost it): sent once and rejected", async () => {
    const { w, one, answer } = await heldCommand(422, invalid);
    await holdDisplay(w, one);
    await reopenDisplay(w, one);
    await answer();
    await w.advance(5 * 60_000);
    expect(posts(w)).toHaveLength(1);
    expect(draft(w)).toMatchObject({ status: "rejected", attempts: 1 });
  });

  test("control: a 422 with the display never closed is sent once and rejected", async () => {
    const { w, answer } = await heldCommand(422, invalid);
    await answer();
    await w.advance(5 * 60_000);
    expect(posts(w)).toHaveLength(1);
    expect(draft(w)).toMatchObject({ status: "rejected", attempts: 1 });
  });

  test("a receipt under the same interruption is recorded once: the command is not sent again", async () => {
    const { w, one, answer } = await heldCommand(200, { revision: 30 });
    await holdDisplay(w, one);
    await reopenDisplay(w, one);
    await answer();
    // Receipted: acknowledged, or already gone (a command with no targets has no effect left to reconcile); never sendable again.
    expect([undefined, "acknowledged"]).toContain(draft(w)?.status);
    await w.advance(5 * 60_000);
    expect(posts(w)).toHaveLength(1);
  });

  test("while the display stays closed nothing more is sent; the draft the answer rejected is not sent when it opens again", async () => {
    const { w, one, answer } = await heldCommand(403, forbidden);
    await holdDisplay(w, one);
    await answer();
    await w.advance(5 * 60_000);
    expect(posts(w)).toHaveLength(1);
    expect(draft(w)?.status).toBe("rejected");
    await reopenDisplay(w, one);
    await w.advance(5 * 60_000);
    expect(posts(w)).toHaveLength(1);
  });

  test("control: a send the session refused for its credentials while the display was closed (auth_state) goes back to queued, uncounted, never rejected", async () => {
    const { w, one, answer } = await heldCommand(
      200,
      { revision: 30 },
      new StampedRequestError("auth_state", {
        observation: "credential_mismatch",
      }),
    );
    await holdDisplay(w, one);
    await answer();
    expect(draft(w)).toMatchObject({ status: "queued", attempts: 0 });
    await w.advance(5 * 60_000);
    expect(posts(w)).toHaveLength(1);
    expect(draft(w)).toMatchObject({ status: "queued", attempts: 0 });
  });

  test("control: a binding that ENDS (another identity) drops the answer; the account's next owner sends the draft again under the same key", async () => {
    const { w, one, answer } = await heldCommand(403, forbidden);
    const key = posts(w)[0]?.key;
    one.identity.move(B);
    await w.settle();
    await answer();
    expect(draft(w)).toMatchObject({ status: "in_flight", attempts: 0 });
    one.identity.move(A);
    await w.advance(60_000);
    const sent = posts(w).filter((r) => r.account === A);
    expect(sent.length).toBe(2);
    expect(sent.every((r) => r.key === key)).toBe(true);
    expect(draft(w)).toMatchObject({ status: "rejected", attempts: 1 });
  });
});
