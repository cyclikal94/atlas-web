// @vitest-environment node
import { describe, expect, test } from "vitest";
import { LOCAL_WRITE_STOPS_STORE } from "../../src/data/engine/sync-channel";
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

/**
 * F-13b-1a (WEB-13b revision 4, review 4): revision 3 recorded the answer a stopped run had issued when its commit SUCCEEDED, but returned
 * for the ended run before looking at a FAILED commit, so the failure was never counted, paced or stopped, and the run the leader started
 * when the display opened sent the unchanged `in_flight` draft again at once (review 4: four sends 25-31 ms apart where three, 250 ms apart,
 * are the bound). Every send is held here until the case answers it; the record of the answer fails by a named injection whose hits are
 * counted. The display closes and opens around each answer as the session's interim hold makes it (`holdDisplay`, `reopenDisplay`).
 */
function heldEvery(w: LeaderWorld, status: number, body: unknown) {
  const at: number[] = [];
  const pending: Array<() => void> = [];
  w.server = (request) => {
    if (request.path === "/commands") {
      at.push(w.env.world.time);
      return new Promise<Response>((resolve) => {
        pending.push(() =>
          resolve(
            new Response(JSON.stringify(body), {
              status,
              headers: { "content-type": "application/json" },
            }),
          ),
        );
      });
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
  return {
    at,
    async answer() {
      const release = pending.shift();
      if (release === undefined) throw new Error("setup: no send is held");
      release();
      await w.settle();
    },
  };
}
async function enqueueOne(w: LeaderWorld, one: LeaderPage) {
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
}
function failNamed(
  w: LeaderWorld,
  label: string,
  times: number,
  mode: "error" | "quota" = "error",
) {
  const hits = { count: 0 };
  w.env.idb.inject({
    match: (tx) => {
      if (tx.label !== label || hits.count >= times) return false;
      hits.count += 1;
      return true;
    },
    mode,
    times,
  });
  return hits;
}
const RECEIPT_OP = `receipt:${LOCAL_ID}`;

describe("F-13b-1a: a failed record of an issued answer is counted, paced and stopped through the session's display hold (production leadership)", () => {
  test.each([
    ["an ordinary 403", 403, forbidden, "data.recordOutcome"],
    ["a receipt", 200, { revision: 30 }, "data.admitReceipt"],
  ] as const)(
    "%s with three failed records, the display closed and opened before each answer: three sends 250 ms apart at least, streak 1/2/3, then stopped",
    async (_, status, body, label) => {
      const w = leaderWorld();
      const one = w.page("A");
      await w.settle();
      const sends = heldEvery(w, status, body);
      await enqueueOne(w, one);
      expect(sends.at).toHaveLength(1);
      const hits = failNamed(w, label, 3);
      for (let n = 1; n <= 3; n += 1) {
        await holdDisplay(w, one);
        await reopenDisplay(w, one);
        expect(
          sends.at,
          "nothing is sent while an answer is held",
        ).toHaveLength(n);
        await sends.answer();
        expect(hits.count).toBe(n);
        expect(w.sync()?.local_write_streaks).toEqual({ [RECEIPT_OP]: n });
        expect(draft(w)).toMatchObject({ status: "in_flight", attempts: 0 });
        if (n < 3) {
          await w.advance(249);
          expect(sends.at, "not sent again before the pause").toHaveLength(n);
          await w.advance(1);
          expect(sends.at).toHaveLength(n + 1);
        }
      }
      await w.advance(5 * 60_000);
      expect(sends.at).toHaveLength(3);
      for (let i = 1; i < sends.at.length; i += 1)
        expect(
          (sends.at[i] as number) - (sends.at[i - 1] as number),
        ).toBeGreaterThanOrEqual(250);
      expect(new Set(posts(w).map((r) => r.key))).toEqual(new Set([LOCAL_ID]));
      expect(one.leader.dispatcher.state.get()).toEqual({
        kind: "stopped",
        cause: "local_storage",
      });
      // The stop is durable: the display closing and opening again sends nothing, and neither does a new page after this one's end.
      await holdDisplay(w, one);
      await reopenDisplay(w, one);
      await w.advance(60_000);
      w.destroy("A");
      const next = w.page("C");
      await w.settle();
      await w.advance(60_000);
      expect(sends.at).toHaveLength(3);
      expect(next.leader.dispatcher.state.get()).toEqual({
        kind: "stopped",
        cause: "local_storage",
      });
    },
  );

  test("the stop recorded by a stopped run's failed record is announced to the account's other pages (they read their own records: R60)", async () => {
    const w = leaderWorld();
    const one = w.page("A");
    w.page("B");
    await w.settle();
    const sends = heldEvery(w, 403, forbidden);
    await enqueueOne(w, one);
    failNamed(w, "data.recordOutcome", 3);
    const stopHints = () =>
      w.posted.filter(
        (p) =>
          p.from === "A" &&
          p.message.type === "data_changed" &&
          (p.message as { stores?: readonly string[] }).stores?.includes(
            LOCAL_WRITE_STOPS_STORE,
          ),
      ).length;
    for (let n = 1; n <= 3; n += 1) {
      await holdDisplay(w, one);
      await reopenDisplay(w, one);
      // `sync_state` is the record of durable stops, which the sync engine's own commits also announce: only the answer's delta counts.
      const before = stopHints();
      await sends.answer();
      if (n < 3) expect(stopHints(), "no stop below the bound").toBe(before);
      else expect(stopHints()).toBeGreaterThan(before);
      await w.advance(250);
    }
    expect(sends.at).toHaveLength(3);
    expect(w.sync()?.local_write_streaks).toEqual({ [RECEIPT_OP]: 3 });
    expect(w.dropped).toEqual([]);
  });

  test("a full disk met recording an ordinary 403 under the display hold: one send, storage full after the display opens, until the person's retry", async () => {
    const w = leaderWorld();
    const one = w.page("A");
    await w.settle();
    const sends = heldEvery(w, 403, forbidden);
    await enqueueOne(w, one);
    const hits = failNamed(w, "data.recordOutcome", 1, "quota");
    await holdDisplay(w, one);
    await reopenDisplay(w, one);
    await sends.answer();
    expect(hits.count).toBe(1);
    await w.advance(5 * 60_000);
    await holdDisplay(w, one);
    await reopenDisplay(w, one);
    await w.advance(60_000);
    expect(sends.at).toHaveLength(1);
    expect(one.leader.dispatcher.state.get()).toEqual({
      kind: "stopped",
      cause: "storage_full",
    });
    one.leader.dispatcher.retry(LOCAL_ID);
    await w.settle();
    expect(sends.at).toHaveLength(2);
    await sends.answer();
    expect(draft(w)).toMatchObject({ status: "rejected", attempts: 1 });
    await w.advance(5 * 60_000);
    expect(sends.at).toHaveLength(2);
  });
});

/**
 * Holds the DELIVERY of the first run of the plan `name` on the page's service: the transaction runs at once, its caller hears at `release()`.
 */
function holdDelivery(one: LeaderPage, name: string) {
  const service = one.runtime.serviceFor(A);
  if (service === null) throw new Error("setup: no service");
  const store = service.store as unknown as {
    run: (plan: { name: string }, ...rest: unknown[]) => Promise<unknown>;
  };
  const real = store.run.bind(store);
  let hits = 0;
  let release = () => {};
  store.run = (plan, ...rest) => {
    const result = real(plan, ...rest);
    if (plan.name !== name || hits > 0) return result;
    hits += 1;
    return new Promise((resolve, reject) =>
      result.then(
        (value) => {
          release = () => resolve(value);
        },
        (error) => {
          release = () => reject(error);
        },
      ),
    );
  };
  return {
    service,
    get hits() {
      return hits;
    },
    release: () => release(),
  };
}

describe("F-13b-1b and F-13b-1c (revision 5) through production leadership and the public retry", () => {
  test.each([
    ["the second answer meets a full disk again: that new hold stands", 2],
    ["control: the second answer is recorded", 1],
  ] as const)(
    "two overlapping retries of the page's public outbox (DataActions.retryChanges) after a visible full disk, the first one's completion delivered last; %s",
    async (_, faults) => {
      const w = leaderWorld();
      const one = w.page("A");
      await w.settle();
      const sends = heldEvery(w, 403, forbidden);
      await enqueueOne(w, one);
      const hits = failNamed(w, "data.recordOutcome", faults, "quota");
      await holdDisplay(w, one);
      await reopenDisplay(w, one);
      await sends.answer();
      expect(one.leader.dispatcher.state.get()).toEqual({
        kind: "stopped",
        cause: "storage_full",
      });
      const outbox = one.leader.outbox();
      if (outbox === null) throw new Error("setup: no outbox");
      const first = holdDelivery(one, "data.resumeDrafts");
      outbox.retry(LOCAL_ID);
      await w.settle();
      expect(first.hits).toBe(1);
      outbox.retry(LOCAL_ID);
      await w.settle();
      expect(sends.at).toHaveLength(2);
      await holdDisplay(w, one);
      await reopenDisplay(w, one);
      await sends.answer();
      expect(hits.count).toBe(faults);
      first.release();
      await w.settle();
      await w.advance(5 * 60_000);
      await holdDisplay(w, one);
      await reopenDisplay(w, one);
      await w.advance(60_000);
      expect(sends.at).toHaveLength(2);
      expect(new Set(posts(w).map((r) => r.key))).toEqual(new Set([LOCAL_ID]));
      expect(one.leader.dispatcher.state.get()).toEqual(
        faults === 2
          ? { kind: "stopped", cause: "storage_full" }
          : { kind: "idle" },
      );
    },
  );

  test.each([
    [
      "the leader gives the binding up (its service live): no stop is left, and the page that leads after the rejection's delivery sends the draft again under its key",
      true,
    ],
    ["control: the binding stands, the draft is stopped", false],
  ] as const)(
    "a failed record whose counter fails too, the counter's rejection delivered after the display reopened; %s",
    async (_, ends) => {
      const w = leaderWorld();
      const one = w.page("A");
      await w.settle();
      const sends = heldEvery(w, 403, forbidden);
      await enqueueOne(w, one);
      const record = failNamed(w, "data.recordOutcome", 1);
      const counter = failNamed(w, "data.recordLocalWriteOutcome", 1);
      const held = holdDelivery(one, "data.recordLocalWriteOutcome");
      await holdDisplay(w, one);
      await reopenDisplay(w, one);
      await sends.answer();
      expect([record.count, counter.count, held.hits]).toEqual([1, 1, 1]);
      if (ends) {
        one.leader.dispose();
        await w.settle();
        expect(held.service.live, "the service outlives the binding").toBe(
          true,
        );
      }
      held.release();
      await w.settle();
      await w.advance(60_000);
      if (!ends) {
        expect(sends.at).toHaveLength(1);
        expect(one.leader.dispatcher.state.get()).toEqual({
          kind: "stopped",
          cause: "local_storage",
        });
        return;
      }
      expect(sends.at, "nobody leads yet").toHaveLength(1);
      // The page that leads next, AFTER the ended binding's late rejection was delivered: it reads the account's records.
      const next = w.page("C");
      await w.settle();
      expect(next.leader.role.get()).toEqual({ kind: "leader" });
      expect(sends.at, "the next leader is not stopped").toHaveLength(2);
      expect(new Set(posts(w).map((r) => r.key))).toEqual(new Set([LOCAL_ID]));
    },
  );
});
