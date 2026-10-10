// @vitest-environment node
import { describe, expect, test } from "vitest";
import { canonicalJson } from "../../src/data/model/canonical";
import type { EnqueueRequest, TargetSpec } from "../../src/data/model/outbox";
import { nextDelay } from "../../src/data/model/retry";
import { StampedRequestError } from "../../src/session";
import { outboxWorld } from "../support/data/outbox-world";
import { cacheRow } from "../support/data/rows";

/**
 * The dispatcher through the PRODUCTION plans and the production commit guard over the double of IndexedDB, with a scripted
 * `/commands` server and fake time (plan 5.5.3 and 5.5.4; F-O5 to F-O13, F-S9). FIXTURE evidence: no backend is involved, and
 * nothing here says how the real server answers (the I-O specs run against the released backend).
 */
const target = (id: string, over: Partial<TargetSpec> = {}): TargetSpec => ({
  resourceId: id,
  role: "primary",
  basis: "resource",
  versionChecked: false,
  seedIfUntracked: 1,
  ...over,
});
/** A create of a new resource: independent of every other draft. */
const create = (
  id: string,
  over: Partial<EnqueueRequest> = {},
): EnqueueRequest => ({
  endpoint: "/commands",
  targets: [target(id)],
  build: () => ({
    command: { kind: "create", id },
    displayPatch: { [id]: { label: id } },
  }),
  ...over,
});
/** An edit of an existing resource (version-checked), so two of them are one chain. */
const edit = (id: string, n = 0): EnqueueRequest => ({
  endpoint: "/commands",
  targets: [target(id, { versionChecked: true })],
  build: (bases) => ({
    command: { kind: "edit", id, base: bases[id] as number, n },
  }),
});

async function started(options: Parameters<typeof outboxWorld>[0] = {}) {
  const w = await outboxWorld(options);
  w.put("cache", [cacheRow({ id: "r", version: 5 })]);
  w.start();
  await w.settle();
  return w;
}
const queued = async (
  w: Awaited<ReturnType<typeof started>>,
  request: EnqueueRequest,
) => {
  const out = await w.outbox.enqueue(request);
  if (out.kind !== "queued") throw new Error(`enqueue: ${out.kind}`);
  await w.settle();
  return out.localId;
};
const statuses = (w: Awaited<ReturnType<typeof started>>) =>
  w.drafts().map((d) => d.status);

describe("sending: the request, the receipt and the overlay", () => {
  test("a queued draft is sent once: POST to its endpoint with Idempotency-Key = local_id and the canonical body", async () => {
    const w = await started();
    const id = await queued(w, create("new"));
    expect(w.sent).toHaveLength(1);
    expect(w.sent[0]).toEqual({
      path: "/commands",
      method: "POST",
      key: id,
      contentType: "application/json",
      body: canonicalJson({ kind: "create", id: "new" }),
    });
  });

  test("the receipt acknowledges the draft, shows the overlay (never the cache) and asks the sync engine to look soon", async () => {
    const w = await started();
    const id = await queued(w, create("new"));
    expect(w.drafts()).toEqual([
      expect.objectContaining({
        local_id: id,
        status: "acknowledged",
        receipt_revision: 101,
      }),
    ]);
    expect(w.effects()).toEqual([
      expect.objectContaining({
        resource_id: "new",
        display: { label: "new" },
        receipt_revision: 101,
      }),
    ]);
    expect(w.rows("cache").map((r) => (r as { id: string }).id)).toEqual(["r"]);
    expect(w.receipts).toBe(1);
    expect(w.dispatcher.state.get()).toEqual({ kind: "idle" });
    expect(
      w.posted.some(
        (m) => m.type === "data_changed" && m.stores.includes("drafts"),
      ),
    ).toBe(true);
  });

  test("a templated endpoint is resolved from target_id at dispatch", async () => {
    const w = await started();
    await queued(w, {
      endpoint: "/calendar-sources/{id}/import",
      targetId: "cal-1",
      targets: [target("import-1")],
      build: () => ({ command: { kind: "import", n: 1 } }),
    });
    expect(w.sent[0]?.path).toBe("/calendar-sources/cal-1/import");
  });

  test("F-O13: global FIFO by created_seq, one request in flight at a time, each draft only after its predecessor settled", async () => {
    const w = await started();
    let release: (r: Response) => void = () => undefined;
    w.script.push(
      () =>
        new Promise<Response>((resolve) => {
          release = resolve;
        }),
    );
    const a = await w.outbox.enqueue(create("a"));
    await w.outbox.enqueue(create("b"));
    await w.outbox.enqueue(create("c"));
    await w.settle();
    // `a` is on the wire and unanswered: nothing else is sent (maxInFlight = 1).
    expect(w.sent.map((s) => s.key)).toEqual([
      (a as { localId: string }).localId,
    ]);
    release(w.receipt());
    await w.settle();
    expect(w.sent.map((s) => JSON.parse(s.body).id)).toEqual(["a", "b", "c"]);
    expect(statuses(w)).toEqual([
      "acknowledged",
      "acknowledged",
      "acknowledged",
    ]);
  });

  test("a chain on one resource is sent in order, each expected_version from the record the previous one raised", async () => {
    const w = await started();
    await w.outbox.enqueue(edit("r", 1));
    await w.outbox.enqueue(edit("r", 2));
    await w.outbox.enqueue(edit("r", 3));
    await w.settle();
    expect(w.sent.map((s) => JSON.parse(s.body).base)).toEqual([5, 6, 7]);
    expect(w.sent.map((s) => JSON.parse(s.body).n)).toEqual([1, 2, 3]);
  });

  test("F-O16: a 1 MiB command is stored, digested, sent byte for byte and recovered", async () => {
    const w = await started();
    const payload = "x".repeat(1024 * 1024);
    const id = await queued(
      w,
      create("big", {
        build: () => ({ command: { kind: "import", payload } }),
      }),
    );
    expect(w.sent[0]?.body.length).toBeGreaterThan(1024 * 1024);
    expect(JSON.parse(w.sent[0]?.body as string).payload).toBe(payload);
    expect(w.sent[0]?.key).toBe(id);
    // The body is recovered from its own store; the header the queue and every scan read stays small whatever the payload.
    const stored = w.commandOf(id) as unknown as { payload: string };
    expect(stored.payload).toBe(payload);
    expect(JSON.stringify(w.drafts()[0]).length).toBeLessThan(4 * 1024);
  });

  test("a response that is not a receipt body never acknowledges: it is an unrecognised answer and the draft stays in flight", async () => {
    const w = await started();
    w.script.push(
      new Response("{}", {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    await queued(w, create("a"));
    expect(statuses(w)).toEqual(["in_flight"]);
    expect(w.drafts()[0]).toMatchObject({
      attempts: 1,
      retry_state: { state: "backing_off" },
    });
  });
});

describe("F-O9: an unsent request is not an attempt", () => {
  test.each([
    "not_sent",
    "closed",
    "closed_unresolved",
    "not_covered",
    "auth_state",
  ] as const)(
    "%s: the draft goes back to queued exactly as it was, nothing is counted, nothing is rejected",
    async (kind) => {
      const w = await started();
      w.script.push(new StampedRequestError(kind));
      const id = await queued(w, create("a"));
      const row = w.drafts().find((d) => d.local_id === id);
      expect(row).toMatchObject({
        status: "queued",
        attempts: 0,
        retry_state: null,
        last_error: null,
      });
      expect(w.effects()).toEqual([]);
      expect(w.sync().local_write_streaks).toEqual({});
    },
  );

  test("`auth_state` pauses the queue (no request until the session allows) and resumes when it does, without loss or duplication", async () => {
    const w = await started();
    w.script.push(new StampedRequestError("auth_state"));
    await queued(w, create("a"));
    await w.advance(5 * 60_000);
    expect(w.sent).toHaveLength(1);
    expect(w.dispatcher.state.get()).toEqual({
      kind: "waiting",
      reason: "session",
    });
    w.fire();
    await w.settle();
    expect(w.sent).toHaveLength(2);
    expect(statuses(w)).toEqual(["acknowledged"]);
  });

  test("not_sent is retried quietly on a bounded schedule and counts nothing; not_covered backs off 2 s doubling, counting nothing", async () => {
    const w = await started();
    w.script.push(
      new StampedRequestError("not_sent"),
      new StampedRequestError("not_sent"),
    );
    await queued(w, create("a"));
    expect(w.sent).toHaveLength(1);
    await w.advance(60);
    expect(w.sent).toHaveLength(2);
    await w.advance(150);
    expect(w.sent).toHaveLength(3);
    expect(statuses(w)).toEqual(["acknowledged"]);

    const x = await started();
    x.script.push(
      new StampedRequestError("not_covered"),
      new StampedRequestError("not_covered"),
      new StampedRequestError("not_covered"),
    );
    await queued(x, create("a"));
    const waits = [nextDelay(1, 0.5), nextDelay(2, 0.5), nextDelay(3, 0.5)];
    expect(waits).toEqual([2_000, 4_000, 8_000]);
    expect(x.sent).toHaveLength(1);
    await x.advance(waits[0] as number);
    expect(x.sent).toHaveLength(2);
    await x.advance((waits[1] as number) - 1);
    expect(x.sent).toHaveLength(2);
    await x.advance(1);
    expect(x.sent).toHaveLength(3);
    expect(x.drafts()[0]).toMatchObject({ attempts: 0 });
  });

  test("F-S9: a stale answer is dropped silently; the draft stays in_flight, unrejected, unremoved and uncounted, and is retried under the SAME key", async () => {
    const w = await started();
    w.script.push(new StampedRequestError("stale"));
    const id = await queued(w, create("a"));
    expect(w.sent.map((s) => s.key)).toEqual([id, id]);
    expect(statuses(w)).toEqual(["acknowledged"]);
    const x = await started();
    x.script.push(
      new StampedRequestError("stale"),
      new StampedRequestError("stale"),
      new StampedRequestError("stale"),
      new StampedRequestError("stale"),
    );
    await queued(x, create("a"));
    // A run of them is paced, not spun: the draft is still in flight and counted nothing.
    expect(x.drafts()[0]).toMatchObject({
      status: "in_flight",
      attempts: 0,
      last_error: null,
    });
  });
});

describe("F-O10: a failure with no answer is a counted failure of the draft class", () => {
  test("a network error keeps the draft in_flight, counts, backs off 2 s, and the retry carries the SAME key and a byte-identical body", async () => {
    const w = await started();
    w.script.push(new TypeError("network"));
    const id = await queued(w, create("a"));
    expect(w.drafts()[0]).toMatchObject({
      status: "in_flight",
      attempts: 1,
      last_error: { stage: "network" },
      retry_state: { state: "backing_off" },
    });
    await w.advance(nextDelay(1, 0.5) - 1);
    expect(w.sent).toHaveLength(1);
    await w.advance(1);
    expect(w.sent).toHaveLength(2);
    expect(w.sent[1]).toEqual(w.sent[0]);
    expect(w.sent[1]?.key).toBe(id);
    expect(statuses(w)).toEqual(["acknowledged"]);
  });

  test("a time-out and an abort are recorded with their own fixed word, and are counted the same way", async () => {
    const w = await started();
    const timeout = Object.assign(new Error("t"), { name: "TimeoutError" });
    const aborted = Object.assign(new Error("a"), { name: "AbortError" });
    w.script.push(timeout, aborted);
    await queued(w, create("a"));
    expect(w.drafts()[0]?.last_error).toEqual({ stage: "timeout" });
    await w.advance(nextDelay(1, 0.5));
    expect(w.drafts()[0]?.last_error).toEqual({ stage: "aborted" });
  });

  test("repeated 503s: back-off doubles to 60 s, and after the sustained duration the draft is PAUSED and nothing more is sent", async () => {
    const w = await started();
    for (let i = 0; i < 40; i += 1)
      w.script.push(w.error(503, "temporarily_unavailable"));
    await queued(w, create("a"));
    let guard = 0;
    while (w.drafts()[0]?.retry_state?.state !== "paused" && guard < 40) {
      await w.advance(10_000);
      guard += 1;
    }
    expect(w.drafts()[0]?.retry_state?.state).toBe("paused");
    const sentWhenPaused = w.sent.length;
    // Duration-based: at least the sustained 180 s passed since the FIRST failure.
    const first = w.drafts()[0]?.retry_state?.since as number;
    expect(w.now() - first).toBeGreaterThanOrEqual(180_000);
    await w.advance(10 * 60_000);
    expect(w.sent).toHaveLength(sentWhenPaused);
    expect(w.dispatcher.state.get()).toEqual({ kind: "needs_retry", count: 1 });
    // The delays were capped at 60 s and doubled from 2 s.
    const gaps = w.sent.slice(1).length;
    expect(gaps).toBeGreaterThan(3);
  });

  test("a paused draft resumes ONLY on `online` or its own Retry now, never on another draft's success or the passage of time", async () => {
    const w = await started();
    for (let i = 0; i < 30; i += 1)
      w.script.push(w.error(500, "internal_error"));
    const stuck = await queued(w, edit("r", 1));
    while (w.drafts()[0]?.retry_state?.state !== "paused")
      await w.advance(10_000);
    const before = w.sent.length;
    // An unrelated draft is sent and succeeds: the paused one does not move.
    w.script.length = 0;
    await queued(w, create("other"));
    expect(w.sent.length).toBe(before + 1);
    expect(
      w.drafts().find((d) => d.local_id === stuck)?.retry_state?.state,
    ).toBe("paused");
    await w.advance(30 * 60_000);
    expect(w.sent.length).toBe(before + 1);
    // `online` resumes it, and it goes out with its own key.
    w.goOnline();
    await w.settle();
    expect(w.sent.length).toBe(before + 2);
    expect(w.sent[w.sent.length - 1]?.key).toBe(stuck);
    expect(w.drafts().find((d) => d.local_id === stuck)).toMatchObject({
      status: "acknowledged",
    });
  });

  test("Retry now on one paused draft resumes it and only it", async () => {
    const w = await started();
    for (let i = 0; i < 30; i += 1)
      w.script.push(w.error(503, "temporarily_unavailable"));
    const a = await queued(w, edit("r", 1));
    while (w.drafts()[0]?.retry_state?.state !== "paused")
      await w.advance(10_000);
    w.script.length = 0;
    w.dispatcher.retry(a);
    await w.settle();
    expect(w.drafts()[0]).toMatchObject({ status: "acknowledged" });
  });

  test("a reload mid-back-off keeps the clock: the durable attempts and last_attempt_at make the draft wait out its own back-off", async () => {
    const w = await started();
    w.script.push(
      w.error(503, "temporarily_unavailable"),
      w.error(503, "temporarily_unavailable"),
      w.error(503, "temporarily_unavailable"),
    );
    await queued(w, create("a"));
    await w.advance(nextDelay(1, 0.5));
    await w.advance(nextDelay(2, 0.5));
    expect(w.sent).toHaveLength(3);
    // A fresh dispatcher (a reload): no in-memory schedule at all.
    w.dispatcher.stop();
    const sentBefore = w.sent.length;
    w.start();
    await w.settle();
    expect(w.sent.length).toBe(sentBefore);
    await w.advance(nextDelay(3, 0.5) - 5);
    expect(w.sent.length).toBe(sentBefore);
    await w.advance(5);
    expect(w.sent.length).toBe(sentBefore + 1);
  });

  test("a Retry-After longer than the back-off is honoured, capped at the maximum", async () => {
    const w = await started();
    w.script.push(w.error(429, "rate_limited", { "retry-after": "30" }));
    await queued(w, create("a"));
    await w.advance(29_000);
    expect(w.sent).toHaveLength(1);
    await w.advance(1_100);
    expect(w.sent).toHaveLength(2);
  });

  test("one draft's back-off never blocks another that shares nothing with it (D-18)", async () => {
    const w = await started();
    w.script.push(new TypeError("network"));
    await w.outbox.enqueue(create("a"));
    await w.outbox.enqueue(create("b"));
    await w.settle();
    expect(w.sent.map((s) => JSON.parse(s.body).id)).toEqual(["a", "b"]);
    expect(w.drafts().map((d) => d.status)).toEqual([
      "in_flight",
      "acknowledged",
    ]);
  });

  test("F-O10: a draft's repeated local write failure stops THAT draft only; the others go on, and Try again resumes it under the same key", async () => {
    const w = await started();
    const remove = w.env.idb.inject({
      match: (tx) => tx.label === "data.admitReceipt",
      mode: "error",
      times: 3,
    });
    const first = await queued(w, create("a"));
    await w.advance(5_000);
    // `a` is left alone (its own writes failed three times)...
    expect(w.sync().local_write_streaks).toEqual({ [`receipt:${first}`]: 3 });
    expect(w.dispatcher.state.get()).toEqual({
      kind: "stopped",
      cause: "local_storage",
    });
    remove();
    // ...but a draft saved afterwards is sent and acknowledged: nothing else was stopped.
    const second = await queued(w, create("b"));
    expect(w.drafts().find((d) => d.local_id === second)?.status).toBe(
      "acknowledged",
    );
    expect(w.sent.filter((s) => s.key === first)).toHaveLength(3);
    expect(w.drafts().find((d) => d.local_id === first)?.status).toBe(
      "in_flight",
    );
    expect(w.dispatcher.state.get()).toEqual({
      kind: "stopped",
      cause: "local_storage",
    });
    w.dispatcher.retry(first);
    await w.settle();
    expect(w.drafts().find((d) => d.local_id === first)?.status).toBe(
      "acknowledged",
    );
    expect(w.sent.filter((s) => s.key === first)).toHaveLength(4);
    expect(w.dispatcher.state.get()).toEqual({ kind: "idle" });
    expect(w.sync().local_write_streaks).toEqual({});
  });

  test("a local write failure of the answer (three in a row) stops with 'local storage isn't responding' and Try again resumes under the same key", async () => {
    const w = await started();
    const remove = w.env.idb.inject({
      match: (tx) => tx.label === "data.admitReceipt",
      mode: "error",
      times: 3,
    });
    const id = await queued(w, create("a"));
    await w.advance(5_000);
    expect(w.dispatcher.state.get()).toEqual({
      kind: "stopped",
      cause: "local_storage",
    });
    expect(w.drafts()[0]).toMatchObject({ status: "in_flight" });
    expect(w.sync().local_write_streaks).toEqual({ [`receipt:${id}`]: 3 });
    remove();
    const before = w.sent.length;
    w.dispatcher.retry();
    await w.settle();
    expect(w.sent.length).toBe(before + 1);
    expect(w.sent.every((s) => s.key === id)).toBe(true);
    expect(w.drafts()[0]).toMatchObject({ status: "acknowledged" });
    expect(w.sync().local_write_streaks).toEqual({});
  });
});

describe("a wake that arrives while a step runs never costs the step its own schedule (found in revision 9)", () => {
  test("a back-off after a failed send is scheduled although a wake arrived during the step", async () => {
    const w = await started();
    let release: (response: Response) => void = () => undefined;
    w.script.push(
      () => new Promise<Response>((resolve) => (release = resolve)),
    );
    await w.outbox.enqueue(create("new"));
    await w.settle();
    expect(w.sent).toHaveLength(1);
    w.fire();
    release(w.error(503, "temporarily_unavailable"));
    await w.settle();
    expect(w.sent).toHaveLength(1);
    // The draft is retried on its own back-off (2 s, +/- jitter), not only when something else wakes the dispatcher.
    await w.advance(3_000);
    expect(w.sent.length).toBeGreaterThan(1);
  });
});
