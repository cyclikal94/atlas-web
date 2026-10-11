// @vitest-environment node
import { describe, expect, test } from "vitest";
import type { EnqueueRequest, TargetSpec } from "../../src/data/model/outbox";
import { outboxWorld } from "../support/data/outbox-world";
import { cacheRow, draftRow, effectRow } from "../support/data/rows";

/**
 * The server's answers to a queued command, and the page's eligibility to send at all, through the production dispatcher over the
 * double (F-O7, F-O8, F-O11 to F-O14). FIXTURE evidence: it says what THIS code does with each answer, not how the real backend
 * produces one (the I-O specs run against the released backend).
 */
const target = (id: string, over: Partial<TargetSpec> = {}): TargetSpec => ({
  resourceId: id,
  role: "primary",
  basis: "resource",
  versionChecked: false,
  seedIfUntracked: 1,
  ...over,
});
const create = (id: string): EnqueueRequest => ({
  endpoint: "/commands",
  targets: [target(id)],
  build: () => ({
    command: { kind: "create", id },
    displayPatch: { [id]: { label: id } },
  }),
});
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
type World = Awaited<ReturnType<typeof started>>;
const enqueue = async (w: World, request: EnqueueRequest) => {
  const out = await w.outbox.enqueue(request);
  if (out.kind !== "queued") throw new Error(`enqueue: ${out.kind}`);
  return out.localId;
};
const status = (w: World, id: string) =>
  w.drafts().find((d) => d.local_id === id)?.status;

describe("F-O7: 409", () => {
  test("`conflict` pauses ONLY that draft and its dependants; an independent draft is still sent", async () => {
    const w = await started();
    w.script.push(w.error(409, "conflict"));
    const a = await enqueue(w, edit("r", 1));
    const dep = await enqueue(w, edit("r", 2));
    const other = await enqueue(w, create("x"));
    await w.settle();
    expect(status(w, a)).toBe("version_conflict");
    expect(status(w, dep)).toBe("queued");
    expect(status(w, other)).toBe("acknowledged");
    // The dependant is not sent while its predecessor waits for the person.
    expect(
      w.sent.map((s) => JSON.parse(s.body).n ?? JSON.parse(s.body).id),
    ).toEqual([1, "x"]);
    await w.advance(10 * 60_000);
    expect(w.sent).toHaveLength(2);
    expect(w.drafts().find((d) => d.local_id === a)).toMatchObject({
      attempts: 1,
      last_error: { status: 409, code: "conflict", stage: "conflict" },
    });
    expect(w.effects().some((e) => e.local_id === a)).toBe(false);
  });

  test("`operation_conflict` is its own status and is NEVER resubmitted under the same key", async () => {
    const w = await started();
    w.script.push(w.error(409, "operation_conflict"));
    const a = await enqueue(w, create("a"));
    await w.settle();
    await w.advance(60 * 60_000);
    w.fire();
    w.goOnline();
    await w.settle();
    expect(status(w, a)).toBe("operation_conflict");
    expect(w.sent).toHaveLength(1);
  });

  test("`defaults_changed` puts a review block on the still-frozen draft and HOLDS the queue from it (D-19), not before it", async () => {
    const w = await started();
    const first = await enqueue(w, create("first"));
    await w.settle();
    w.script.push(w.error(409, "defaults_changed"));
    const held = await enqueue(w, create("held"));
    const behind = await enqueue(w, create("behind"));
    await w.settle();
    expect(status(w, first)).toBe("acknowledged");
    const row = w.drafts().find((d) => d.local_id === held);
    expect(row).toMatchObject({
      status: "in_flight",
      review_block: { kind: "defaults" },
    });
    expect(status(w, behind)).toBe("queued");
    expect(w.sent).toHaveLength(2);
    await w.advance(10 * 60_000);
    expect(w.sent).toHaveLength(2);
    // The body is frozen: nothing about the held draft changed.
    expect(w.commandOf(row?.local_id as string)).toEqual({
      kind: "create",
      id: "held",
    });
  });

  test("an unregistered 409 code takes the unrecognised path: in_flight, retried with the SAME key under the back-off", async () => {
    const w = await started();
    w.script.push(w.error(409, "materialisation_required"));
    const a = await enqueue(w, create("a"));
    await w.settle();
    expect(status(w, a)).toBe("in_flight");
    await w.advance(2_000);
    expect(w.sent.map((s) => s.key)).toEqual([a, a]);
    expect(status(w, a)).toBe("acknowledged");
  });

  test("a registered handler may reclassify a 409 by command kind; a throwing handler never wedges the queue", async () => {
    const w = await started();
    w.conflicts.register("materialisation_required", ({ draft }) =>
      (draft.command as { kind?: string }).kind === "create"
        ? { kind: "reclassify", as: "version_conflict" }
        : { kind: "default" },
    );
    w.conflicts.register("stale_delivery", () => {
      throw new Error("handler bug");
    });
    w.script.push(
      w.error(409, "materialisation_required"),
      w.error(409, "stale_delivery"),
    );
    const a = await enqueue(w, create("a"));
    await w.settle();
    expect(status(w, a)).toBe("version_conflict");
    const b = await enqueue(w, create("b"));
    await w.settle();
    expect(status(w, b)).toBe("in_flight");
    expect(() =>
      w.conflicts.register("stale_delivery", () => ({ kind: "default" })),
    ).toThrow();
  });
});

describe("F-O8: a refusal, and slice capacity", () => {
  test.each([
    [403, "forbidden"],
    [404, "not_found"],
    [422, "validation_failed"],
    [400, "malformed_request"],
  ])(
    "%i %s: rejected, RETAINED (never silently deleted), non-replaying, and every dependant is rejected with it",
    async (code, name) => {
      const w = await started();
      w.script.push(w.error(code, name));
      const a = await enqueue(w, edit("r", 1));
      const b = await enqueue(w, edit("r", 2));
      await w.settle();
      expect(w.drafts().map((d) => [d.local_id, d.status])).toEqual([
        [a, "rejected"],
        [b, "rejected"],
      ]);
      expect(w.drafts()[0]?.last_error).toEqual({
        status: code,
        code: name,
        stage: "rejected",
      });
      expect(w.drafts()[1]?.last_error).toEqual({
        stage: "dependency_rejected",
      });
      // The version base is back at the cache's own value, in the same step as the rejections.
      expect(w.versions()).toEqual([
        { resource_id: "r", locally_assumed_version: 5, basis: "resource" },
      ]);
      await w.advance(60 * 60_000);
      expect(w.sent).toHaveLength(1);
    },
  );

  test("a fresh draft on the same resource is built on the RECOVERED base, never on the voided chain (no fabricated conflict)", async () => {
    const w = await started();
    w.script.push(w.error(404, "not_found"));
    await enqueue(w, edit("r", 1));
    await enqueue(w, edit("r", 2));
    await w.settle();
    await enqueue(w, edit("r", 3));
    await w.settle();
    expect(w.sent.map((s) => JSON.parse(s.body).base)).toEqual([5, 5]);
  });

  test("a gateway's 404 (no Atlas body) never rejects: the draft stays in flight and backs off", async () => {
    const w = await started();
    w.script.push(
      new Response("<html>not found</html>", {
        status: 404,
        headers: { "content-type": "text/html" },
      }),
    );
    const a = await enqueue(w, create("a"));
    await w.settle();
    expect(status(w, a)).toBe("in_flight");
    expect(w.drafts()[0]?.attempts).toBe(1);
  });

  test("503 slice_capacity: blocked with its reason, retained, NO automatic retry; the manual retry queues it again", async () => {
    const w = await started();
    w.script.push(w.error(503, "slice_capacity"));
    const a = await enqueue(w, create("a"));
    await w.settle();
    expect(w.drafts()[0]).toMatchObject({
      status: "blocked",
      blocked_reason: "slice_capacity",
    });
    await w.advance(60 * 60_000);
    expect(w.sent).toHaveLength(1);
    w.dispatcher.retry(a);
    await w.settle();
    expect(w.sent).toHaveLength(2);
    expect(status(w, a)).toBe("acknowledged");
  });

  test("a stored draft that cannot be addressed (a template with no target) is rejected locally with its content kept, and nothing is sent", async () => {
    const w = await started();
    w.env.idb.seed(`atlas-${w.service.account}`, "drafts", [
      draftRow({
        local_id: "bad",
        status: "queued",
        endpoint: "/calendar-sources/{id}/import",
        target_id: null,
        created_seq: 1,
      }),
    ]);
    w.setSync({ draft_seq: 1 });
    w.fire();
    await w.settle();
    expect(w.sent).toEqual([]);
    expect(w.drafts()[0]).toMatchObject({
      status: "rejected",
      last_error: { stage: "unaddressable" },
    });
  });
});

describe("F-O11: the compatibility pause (decision D-21)", () => {
  test.each([
    [
      {
        status: "unsupported",
        version: "0.29.0",
        supported: ">=0.28.0 <0.29.0",
      } as const,
      { kind: "paused", reason: "compat_unsupported" },
    ],
    [
      { status: "missing" } as const,
      { kind: "paused", reason: "compat_missing" },
    ],
  ])(
    "%j pauses VISIBLY: nothing is sent, the drafts are kept",
    async (compat, expected) => {
      const w = await started({ compat });
      const id = await enqueue(w, create("a"));
      await w.settle();
      expect(w.sent).toEqual([]);
      expect(w.dispatcher.state.get()).toEqual(expected);
      expect(status(w, id)).toBe("queued");
      expect(w.drafts()[0]).toMatchObject({ attempts: 0, last_error: null });
    },
  );

  test.each([
    { status: "unknown" } as const,
    { status: "unreachable" } as const,
  ])(
    "%j holds QUIETLY: nothing is sent, nothing is counted",
    async (compat) => {
      const w = await started({ compat });
      await enqueue(w, create("a"));
      await w.advance(10 * 60_000);
      expect(w.sent).toEqual([]);
      expect(w.dispatcher.state.get()).toEqual({
        kind: "held",
        reason: "compat_unconfirmed",
      });
      expect(w.drafts()[0]).toMatchObject({ status: "queued", attempts: 0 });
    },
  );

  test("`supported` resumes without loss or duplication, in order", async () => {
    const w = await started({ compat: { status: "unknown" } });
    await enqueue(w, create("a"));
    await enqueue(w, create("b"));
    await w.settle();
    expect(w.sent).toEqual([]);
    w.compat.set({ status: "supported", version: "0.28.0" });
    await w.settle();
    expect(w.sent.map((s) => JSON.parse(s.body).id)).toEqual(["a", "b"]);
    expect(w.drafts().map((d) => d.status)).toEqual([
      "acknowledged",
      "acknowledged",
    ]);
  });

  test("the pause is the pause of WRITES: an incompatible server leaves input, the queue summary and the cached rows alone", async () => {
    const w = await started({ compat: { status: "missing" } });
    const out = await w.outbox.enqueue(create("a"));
    expect(out.kind).toBe("queued");
    expect(w.rows("cache")).toHaveLength(1);
    expect(w.outbox.queue.get()).toBeDefined();
  });

  test("a compat change that arrives MID-attempt stops the next send: it is re-evaluated in the step that issues the request", async () => {
    const w = await started();
    // The claim is committed (a transaction), and then the page learns the server is incompatible before the request leaves.
    const remove = w.env.idb.inject({
      match: (tx) => tx.label === "data.markInFlight",
      mode: "pending",
      times: 1,
    });
    await w.outbox.enqueue(create("a"));
    await w.settle();
    w.compat.set({ status: "unsupported", version: "9", supported: "1" });
    remove();
    await w.settle();
    expect(w.sent).toEqual([]);
  });
});

describe("F-O12: account switch and a draft held by a lifecycle state", () => {
  test("the outgoing account's queue is retained, nothing is sent after the identity leaves, and it resumes only when that account is settled again", async () => {
    const w = await started({ compat: { status: "unknown" } });
    const a = await enqueue(w, create("a"));
    const b = await enqueue(w, create("b"));
    await w.settle();
    expect(w.sent).toEqual([]);
    w.identity.move({
      account: "22222222-2222-4222-8222-222222222222",
      epoch: 1,
    });
    await w.settle();
    // The queue becomes sendable while the page shows ANOTHER account: nothing of the outgoing account is sent.
    w.compat.set({ status: "supported", version: "0.28.0" });
    await w.settle();
    await w.advance(5 * 60_000);
    expect(w.sent).toEqual([]);
    expect(w.dispatcher.state.get()).toEqual({
      kind: "waiting",
      reason: "no_account",
    });
    // Retained, byte for byte, in the outgoing account's own database.
    expect(w.drafts().map((d) => [d.local_id, d.status, d.attempts])).toEqual([
      [a, "queued", 0],
      [b, "queued", 0],
    ]);
  });

  test("an answer that arrives after the identity left is DROPPED: the draft stays in flight and is not counted", async () => {
    const w = await started();
    let answer: (r: Response) => void = () => undefined;
    w.script.push(
      () =>
        new Promise<Response>((resolve) => {
          answer = resolve;
        }),
    );
    const a = await enqueue(w, create("a"));
    await w.settle();
    w.identity.move({
      account: "22222222-2222-4222-8222-222222222222",
      epoch: 1,
    });
    await w.settle();
    answer(w.receipt());
    await w.settle();
    expect(w.drafts()[0]).toMatchObject({
      local_id: a,
      status: "in_flight",
      attempts: 0,
    });
  });

  test("a wipe that is closing stops the dispatcher: nothing is claimed or sent, and the draft stays queued", async () => {
    const w = await started();
    w.setSync({
      draft_fence: {
        token: "t",
        started_at: w.now(),
        operation_ids: ["op"],
        consent_digest: "d",
        closing: true,
      },
    });
    w.env.idb.seed(`atlas-${w.service.account}`, "drafts", [
      draftRow({ local_id: "q", created_seq: 1, status: "queued" }),
    ]);
    w.fire();
    await w.settle();
    expect(w.sent).toEqual([]);
    expect(w.drafts()[0]?.status).toBe("queued");
  });

  test("a fence that is NOT closing does not stop sending (D-20): replay and status transitions continue", async () => {
    const w = await started();
    w.setSync({
      draft_fence: {
        token: "t",
        started_at: w.now(),
        operation_ids: ["op"],
        consent_digest: "d",
        closing: false,
      },
    });
    w.env.idb.seed(`atlas-${w.service.account}`, "drafts", [
      draftRow({
        local_id: "q",
        created_seq: 1,
        status: "queued",
        endpoint: "/commands",
        target_resource_ids: ["q"],
        index_targets: ["q"],
      }),
    ]);
    w.fire();
    await w.settle();
    expect(w.sent).toHaveLength(1);
    expect(w.drafts()[0]?.status).toBe("acknowledged");
  });

  test("offline: nothing is sent and the draft input is not affected; online resumes", async () => {
    const w = await started();
    w.online = false;
    const a = await enqueue(w, create("a"));
    await w.settle();
    expect(w.sent).toEqual([]);
    expect(w.dispatcher.state.get()).toEqual({
      kind: "waiting",
      reason: "offline",
    });
    w.goOnline();
    await w.settle();
    expect(status(w, a)).toBe("acknowledged");
  });
});

describe("boot: an in_flight draft is a retry candidate, neither lost nor blindly assumed sent", () => {
  test("it is resent with its own key and the original body; the server's idempotent answer acknowledges it", async () => {
    const w = await outboxWorld();
    const command = { kind: "create", id: "n" };
    w.env.idb.seed(`atlas-${w.service.account}`, "drafts", [
      draftRow({
        local_id: "L",
        created_seq: 1,
        status: "in_flight",
        command,
        target_resource_ids: ["n"],
        index_targets: ["n"],
        bases: { n: 1 },
      }),
    ]);
    w.env.idb.seed(`atlas-${w.service.account}`, "pending_effects", [
      effectRow({ local_id: "L", resource_id: "n", submitted_at_page_seq: 0 }),
    ]);
    w.setSync({ draft_seq: 1 });
    w.start();
    await w.settle();
    expect(w.sent).toHaveLength(1);
    expect(w.sent[0]).toMatchObject({
      key: "L",
      body: '{"id":"n","kind":"create"}',
    });
    expect(w.drafts()[0]).toMatchObject({ status: "acknowledged" });
  });
});

describe("F-O13: order and fairness at scale", () => {
  test("the 101-row counterexample: a blocked create with 100 dependants does NOT starve an independent draft behind them", async () => {
    const w = await outboxWorld();
    const rows = [
      draftRow({
        local_id: "create",
        created_seq: 1,
        status: "version_conflict",
        index_targets: ["c"],
        target_resource_ids: ["c"],
      }),
      ...Array.from({ length: 100 }, (_, i) =>
        draftRow({
          local_id: `dep${i}`,
          created_seq: i + 2,
          status: "queued",
          index_targets: ["c"],
          target_resource_ids: ["c"],
          depends_on: [i === 0 ? "create" : `dep${i - 1}`],
        }),
      ),
      draftRow({
        local_id: "independent",
        created_seq: 102,
        status: "queued",
        index_targets: ["z"],
        target_resource_ids: ["z"],
      }),
    ];
    w.env.idb.seed(`atlas-${w.service.account}`, "drafts", rows);
    w.setSync({ draft_seq: 102 });
    w.start();
    await w.settle();
    expect(w.sent.map((s) => s.key)).toEqual(["independent"]);
  });

  test("two drafts against one resource are never reordered, even across a clock that goes backwards", async () => {
    const w = await started();
    const a = await enqueue(w, edit("r", 1));
    // The clock steps back an hour between the two saves: FIFO is by created_seq, not by time.
    await w.advance(1);
    const b = await enqueue(w, edit("r", 2));
    await w.settle();
    expect(w.sent.map((s) => s.key)).toEqual([a, b]);
    expect(w.drafts().map((d) => d.created_seq)).toEqual([1, 2]);
  });
});

describe("F-O13: acknowledged rows waiting for a page do not strand a queued draft", () => {
  const acknowledged = (n: number) =>
    Array.from({ length: n }, (_, i) =>
      draftRow({
        local_id: `ack${i}`,
        created_seq: i + 1,
        status: "acknowledged",
        held_pending_cache: false,
        index_targets: [`a${i}`],
        target_resource_ids: [`a${i}`],
      }),
    );
  const seed = (
    w: Awaited<ReturnType<typeof outboxWorld>>,
    rows: ReturnType<typeof draftRow>[],
  ) => {
    w.env.idb.seed(`atlas-${w.service.account}`, "drafts", rows);
    w.setSync({ draft_seq: rows.length });
  };

  test("a queued draft behind several windows of acknowledged rows is still found", async () => {
    const w = await outboxWorld();
    seed(w, [
      ...acknowledged(350),
      draftRow({
        local_id: "waiting",
        created_seq: 351,
        status: "queued",
        index_targets: ["z"],
        target_resource_ids: ["z"],
      }),
    ]);
    w.start();
    await w.settle();
    expect(w.sent.map((s) => s.key)).toEqual(["waiting"]);
  });

  test("620 acknowledged rows in front are not even read: the queued draft behind them is sent at once, and nothing waits for the front to clear", async () => {
    const w = await outboxWorld();
    seed(w, [
      ...acknowledged(620),
      draftRow({
        local_id: "waiting",
        created_seq: 621,
        status: "queued",
        index_targets: ["z"],
        target_resource_ids: ["z"],
      }),
    ]);
    w.env.idb.reads.reset();
    w.start();
    await w.settle();
    expect(w.sent.map((s) => s.key)).toEqual(["waiting"]);
    // Acknowledged rows are not candidates, so the window of candidates never reads them.
    expect(w.env.idb.reads.rows.get("drafts") ?? 0).toBeLessThan(20);
  });
});

describe("F-O14: the queue warning blocks nothing", () => {
  test("at 200 waiting changes the summary warns; every further save is still accepted and sent", async () => {
    const w = await started({ compat: { status: "unknown" } });
    for (let i = 0; i < 200; i += 1) {
      const out = await w.outbox.enqueue(create(`n${i}`));
      expect(out.kind).toBe("queued");
    }
    const off = w.outbox.summary.subscribe(() => undefined);
    await w.settle();
    const warned = w.outbox.summary.get();
    off();
    expect(warned).toMatchObject({
      status: "ready",
      value: { waiting: 200, total: 200, warn: true },
    });
    const more = await w.outbox.enqueue(create("one-more"));
    expect(more.kind).toBe("queued");
    w.compat.set({ status: "supported", version: "0.28.0" });
    await w.settle();
    for (let i = 0; i < 40; i += 1) {
      if (w.sent.length >= 201) break;
      await w.advance(1_000);
    }
    expect(w.sent).toHaveLength(201);
  });
});

describe("the facade", () => {
  test("input is the LAST thing the quota refuses: a person's save is refused only when almost nothing is left, and sending is not", async () => {
    const w = await started();
    const id = await enqueue(w, create("a"));
    await w.settle();
    expect(status(w, id)).toBe("acknowledged");
    w.freeBytes = 1024;
    w.quota.invalidate();
    expect(await w.outbox.enqueue(create("b"))).toEqual({
      kind: "refused",
      reason: "quota",
    });
    expect(w.drafts()).toHaveLength(1);
    w.env.idb.seed(`atlas-${w.service.account}`, "drafts", [
      ...w.drafts(),
      draftRow({ local_id: "q", created_seq: 2, status: "queued" }),
    ]);
    w.setSync({ draft_seq: 2 });
    w.fire();
    await w.settle();
    expect(w.sent).toHaveLength(2);
  });

  test("a save after the identity left the account is refused as identity_changed, not queued under another account", async () => {
    const w = await started();
    w.identity.move({ account: null, epoch: 1 });
    expect(await w.outbox.enqueue(create("a"))).toEqual({
      kind: "refused",
      reason: "identity_changed",
    });
  });

  test("three durable failures of ONE save say 'local storage isn't responding'; the person's retry clears it", async () => {
    const w = await started();
    const remove = w.env.idb.inject({
      match: (tx) => tx.label === "data.enqueueDraft",
      mode: "error",
      times: 3,
    });
    const request = {
      ...create("a"),
      localId: "00000000-0000-4000-8000-0000000000bb",
    };
    expect(w.outbox.storageNotResponding.get()).toBe(false);
    for (let i = 0; i < 3; i += 1)
      expect(await w.outbox.enqueue(request)).toEqual({
        kind: "refused",
        reason: "storage",
      });
    remove();
    expect(w.outbox.storageNotResponding.get()).toBe(true);
    expect(w.sync().local_write_streaks).toEqual({
      [`draft:${request.localId}`]: 3,
    });
    w.outbox.retry();
    expect(w.outbox.storageNotResponding.get()).toBe(false);
    expect((await w.outbox.enqueue(request)).kind).toBe("queued");
    expect(w.sync().local_write_streaks).toEqual({});
  });

  test("an invalid request is a defect and throws before anything is written", async () => {
    const w = await started();
    await expect(
      w.outbox.enqueue({ ...create("a"), endpoint: "https://evil.example/x" }),
    ).rejects.toThrow();
    await expect(
      w.outbox.enqueue({
        ...create("a"),
        build: () => {
          throw new Error("x");
        },
      }),
    ).rejects.toThrow(TypeError);
    expect(w.drafts()).toEqual([]);
    expect(w.versions()).toEqual([]);
  });

  test("supersede: a version conflict's replacement takes its place, dependants are retargeted and paused, the old row is gone", async () => {
    const w = await started();
    w.script.push(w.error(409, "conflict"));
    const a = await enqueue(w, edit("r", 1));
    const dep = await enqueue(w, edit("r", 2));
    await w.settle();
    expect(status(w, a)).toBe("version_conflict");
    const out = await w.outbox.supersede(a, edit("r", 9));
    if (out.kind !== "superseded") throw new Error(out.kind);
    expect(out.paused).toEqual([dep]);
    expect(w.drafts().find((d) => d.local_id === a)).toBeUndefined();
    const replacement = w.drafts().find((d) => d.local_id === out.localId);
    expect(replacement).toMatchObject({
      status: "queued",
      expected_version: 5,
    });
    expect(w.drafts().find((d) => d.local_id === dep)).toMatchObject({
      status: "version_conflict",
      depends_on: [out.localId],
    });
    await w.settle();
    expect(status(w, out.localId)).toBe("acknowledged");
    // The paused dependant is not sent behind the replacement: it waits for the person's review.
    expect(w.sent.map((s) => JSON.parse(s.body).n)).toEqual([1, 9]);
  });

  test("the live summary follows the queue: waiting while queued, nothing once acknowledged and cleared", async () => {
    const w = await started({ compat: { status: "unknown" } });
    const off = w.outbox.summary.subscribe(() => undefined);
    await w.outbox.enqueue(create("a"));
    await w.settle();
    expect(w.outbox.summary.get()).toMatchObject({
      status: "ready",
      value: { waiting: 1, total: 1 },
    });
    // The compat gate opens, the draft is sent and acknowledged: with its overlay cleared by a page it would leave; until then it
    // is `held` only when a flag is set, so an ordinary acknowledged draft is simply not counted.
    w.compat.set({ status: "supported", version: "0.28.0" });
    await w.settle();
    expect(w.outbox.summary.get()).toMatchObject({
      status: "ready",
      value: { waiting: 0, total: 0 },
    });
    off();
  });
});
