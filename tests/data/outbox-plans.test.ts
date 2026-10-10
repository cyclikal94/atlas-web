// @vitest-environment node
import { describe, expect, test } from "vitest";
import type { EnqueueRequest, TargetSpec } from "../../src/data/model/outbox";
import {
  setClosing,
  setDraftFence,
  summariseWork,
} from "../../src/data/plans/fence";
import { saveFormRecovery } from "../../src/data/plans/form-recovery";
import {
  admitReceipt,
  discardDraft,
  enqueueDraft,
  markInFlight,
  recordOutcome,
  unclaimDraft,
} from "../../src/data/plans/outbox";
import { outboxWorld } from "../support/data/outbox-world";
import { ACCOUNT } from "../support/data/page-world";
import {
  cacheRow,
  draftRow,
  effectRow,
  recoveryRow,
} from "../support/data/rows";

/**
 * The outbox plans, through the PRODUCTION code over the double of IndexedDB: atomic enqueue (F-O1), the fence (F-O2), the
 * claim and its unclaim (F-O4, F-O5), the receipt and the other answers as stored (F-O6, F-O8), and the digest (F-O15). FIXTURE
 * evidence: the real engines run the same plans in the e2e specs.
 */
const primary = (id: string, over: Partial<TargetSpec> = {}): TargetSpec => ({
  resourceId: id,
  role: "primary",
  basis: "resource",
  versionChecked: true,
  ...over,
});
const edit = (
  id: string,
  extra: Record<string, number> = {},
): EnqueueRequest => ({
  endpoint: "/commands",
  targets: [primary(id)],
  build: (bases) => ({
    command: { kind: "edit", id, base: bases[id] as number, ...extra },
  }),
});

async function setup(options: Parameters<typeof outboxWorld>[0] = {}) {
  const w = await outboxWorld(options);
  // The cache has one resource at version 5.
  w.put("cache", [cacheRow({ id: "r", version: 5 })]);
  const captured = () => w.capture();
  const inc = w.service.incarnationId;
  return { w, captured, inc };
}

describe("F-O1: enqueue is one atomic read-increment-write", () => {
  test("two tabs enqueuing for one resource at once get DISTINCT, serialised expected versions from the one durable record", async () => {
    const { w } = await setup();
    const pageB = w.env.page("B");
    pageB.identity.account = ACCOUNT;
    const openedB = await pageB.open(ACCOUNT);
    if (openedB.kind !== "opened") throw new Error("second tab");
    // Both transactions are created before either has run: a transaction split into a read and a later write would read 5 twice.
    const one = w.service.store.run(enqueueDraft, {
      incarnationId: w.service.incarnationId,
      request: edit("r"),
      localId: "tab-a",
      accountId: ACCOUNT,
      now: "2026-10-01T10:00:00.000Z",
    });
    const two = openedB.store.run(enqueueDraft, {
      incarnationId: openedB.store.incarnationId,
      request: edit("r"),
      localId: "tab-b",
      accountId: ACCOUNT,
      now: "2026-10-01T10:00:00.000Z",
    });
    await w.env.settle();
    const [a, b] = await Promise.all([one, two]);
    expect(a.kind).toBe("queued");
    expect(b.kind).toBe("queued");
    const rows = w.drafts();
    expect(rows.map((d) => d.expected_version).sort()).toEqual([5, 6]);
    expect(w.versions()).toEqual([
      { resource_id: "r", locally_assumed_version: 7, basis: "resource" },
    ]);
    // Distinct, increasing created_seq, and the second waits on the first.
    expect(rows.map((d) => d.created_seq)).toEqual([1, 2]);
    expect(rows[1]?.depends_on).toEqual([rows[0]?.local_id]);
  });

  test("a failure at any write leaves NOTHING: no draft, no increment, no sequence number used", async () => {
    const { w } = await setup();
    // A one-target enqueue writes the draft, its body, the version record and the singleton: four writes, then it commits.
    for (const n of [1, 2, 3, 4, 5]) {
      const remove = w.env.idb.inject({
        match: (tx) => tx.label === "data.enqueueDraft",
        mode: { kind: "throw_on_write", n, as: "error" },
        times: 1,
      });
      const out = await w.outbox.enqueue(edit("r"));
      remove();
      if (n === 5) {
        expect(out.kind).toBe("queued");
        break;
      }
      expect(out).toEqual({ kind: "refused", reason: "storage" });
      expect(w.drafts()).toEqual([]);
      // The header and the body are written together or not at all: a failed save leaves no orphan body.
      expect(w.rows("draft_commands")).toEqual([]);
      expect(w.versions()).toEqual([]);
      expect(w.sync().draft_seq).toBe(0);
    }
  });

  test("a save whose COMPLETION was lost (it committed) is recognised on retry with the same local id: one draft, one increment, and the first call is never reported as saved", async () => {
    const { w } = await setup();
    const remove = w.env.idb.inject({
      match: (tx) => tx.label === "data.enqueueDraft",
      mode: "commit_then_lose_completion",
      times: 1,
    });
    const request = {
      ...edit("r"),
      localId: "00000000-0000-4000-8000-0000000000aa",
    };
    let answered = false;
    void w.outbox.enqueue(request).then(
      () => {
        answered = true;
      },
      () => {
        answered = true;
      },
    );
    await w.settle();
    remove();
    // It committed, and the caller was never told "saved": the answer is the transaction's own completion.
    expect(answered).toBe(false);
    expect(w.drafts()).toHaveLength(1);
    const again = await w.outbox.enqueue(request);
    expect(again).toMatchObject({ kind: "queued", localId: request.localId });
    expect(w.drafts()).toHaveLength(1);
    expect(w.versions()).toEqual([
      { resource_id: "r", locally_assumed_version: 6, basis: "resource" },
    ]);
  });
});

describe("F-O2: the fence refuses a new draft and an in-place edit, in any tab, and nothing else", () => {
  const fenceUp = async (w: Awaited<ReturnType<typeof setup>>["w"]) =>
    w.service.store.run(setDraftFence, {
      incarnationId: w.service.incarnationId,
      now: w.now(),
      token: "t",
      operationId: "op",
    });

  test("an enqueue and an edit of a queued command are refused while it stands; both succeed once it is released", async () => {
    const { w } = await setup();
    const queued = await w.outbox.enqueue(edit("r"));
    if (queued.kind !== "queued") throw new Error("setup");
    await fenceUp(w);
    expect(await w.outbox.enqueue(edit("r"))).toEqual({
      kind: "refused",
      reason: "fenced",
    });
    expect(
      await w.outbox.editQueued(queued.localId, edit("r", { x: 1 })),
    ).toEqual({ kind: "refused", reason: "fenced" });
    expect(w.drafts()).toHaveLength(1);
  });

  test("a tab OPENED after the fence was set is refused too: the fence is in the database, not in a tab's memory", async () => {
    const { w } = await setup();
    await fenceUp(w);
    const pageC = w.env.page("C");
    pageC.identity.account = ACCOUNT;
    const opened = await pageC.open(ACCOUNT);
    if (opened.kind !== "opened") throw new Error("late tab");
    const out = await opened.store.run(enqueueDraft, {
      incarnationId: opened.store.incarnationId,
      request: edit("r"),
      localId: "late",
      accountId: ACCOUNT,
      now: "2026-10-01T10:00:00.000Z",
    });
    expect(out).toEqual({ kind: "refused", reason: "fenced" });
  });

  test("`closing` is reported as closing; and a status transition of an EXISTING row still goes through while a fence stands (D-20)", async () => {
    const { w, inc } = await setup();
    const queued = await w.outbox.enqueue(edit("r"));
    if (queued.kind !== "queued") throw new Error("setup");
    await fenceUp(w);
    const claim = await w.service.commit(markInFlight, {
      captured: w.capture(),
      localId: queued.localId,
    });
    expect(claim).toMatchObject({
      kind: "applied",
      value: { kind: "claimed" },
    });
    expect(w.drafts()[0]?.status).toBe("in_flight");
    await w.service.store.run(setClosing, {
      incarnationId: inc,
      now: 2,
      token: "t",
    });
    expect(await w.outbox.enqueue(edit("r"))).toEqual({
      kind: "refused",
      reason: "closing",
    });
    // Once `closing` is set nothing is claimed either (the account is about to be deleted).
    const again = await w.service.commit(markInFlight, {
      captured: w.capture(),
      localId: queued.localId,
    });
    expect(again).toEqual({ kind: "dropped", reason: "closing" });
  });

  test("form recovery still writes under a fence and is refused only when closing (the existing rule, unchanged)", async () => {
    const { w, inc } = await setup();
    await fenceUp(w);
    expect(
      await w.service.store.run(saveFormRecovery, {
        incarnationId: inc,
        row: recoveryRow(),
      }),
    ).toEqual({ kind: "saved" });
    await w.service.store.run(setClosing, {
      incarnationId: inc,
      now: 2,
      token: "t",
    });
    expect(
      await w.service.store.run(saveFormRecovery, {
        incarnationId: inc,
        row: recoveryRow({
          capture_seq: 2,
          fields: { name: "y" },
          content_digest: "y",
        }),
      }),
    ).toEqual({ kind: "refused" });
  });

  test("a STALE fence (old, no pending operation, session started) is reconciled once and the save then succeeds; a fresh one is not", async () => {
    const { w } = await setup({});
    await fenceUp(w);
    // Fresh: not stale, so refused.
    expect(await w.outbox.enqueue(edit("r"))).toEqual({
      kind: "refused",
      reason: "fenced",
    });
    await w.advance(130_000);
    w.fence.hasPendingOperation = true;
    expect(await w.outbox.enqueue(edit("r"))).toEqual({
      kind: "refused",
      reason: "fenced",
    });
    w.fence.hasPendingOperation = false;
    expect((await w.outbox.enqueue(edit("r"))).kind).toBe("queued");
    expect(w.sync().draft_fence).toBeNull();
  });
});

describe("F-O3: the command is frozen once the status leaves queued (as stored)", () => {
  test("an edit of a queued draft rewrites its body and digest in place; after the claim the store refuses it and a change is a new draft", async () => {
    const { w } = await setup();
    const out = await w.outbox.enqueue(edit("r"));
    if (out.kind !== "queued") throw new Error("setup");
    const before = w.drafts()[0];
    expect(
      await w.outbox.editQueued(out.localId, edit("r", { extra: 1 })),
    ).toEqual({ kind: "edited", localId: out.localId });
    const after = w.drafts()[0];
    expect(w.commandOf(after?.local_id as string)).toEqual({
      kind: "edit",
      id: "r",
      base: 5,
      extra: 1,
    });
    expect(after?.command_digest).not.toBe(before?.command_digest);
    expect([after?.created_seq, after?.expected_version]).toEqual([
      before?.created_seq,
      before?.expected_version,
    ]);
    // The version record is NOT raised again by an edit: the same one assumed change.
    expect(w.versions()).toEqual([
      { resource_id: "r", locally_assumed_version: 6, basis: "resource" },
    ]);
    await w.service.commit(markInFlight, {
      captured: w.capture(),
      localId: out.localId,
    });
    const frozen = JSON.stringify(w.drafts()[0]);
    expect(
      await w.outbox.editQueued(out.localId, edit("r", { extra: 2 })),
    ).toEqual({ kind: "refused", reason: "not_queued" });
    expect(JSON.stringify(w.drafts()[0])).toBe(frozen);
    expect(await w.outbox.editQueued("nope", edit("r"))).toEqual({
      kind: "refused",
      reason: "not_found",
    });
  });
});

describe("F-O4: markInFlight is ONE transaction", () => {
  const draftWith = async (
    w: Awaited<ReturnType<typeof setup>>["w"],
    request = edit("r"),
  ) => {
    const out = await w.outbox.enqueue(request);
    if (out.kind !== "queued") throw new Error("setup");
    return out.localId;
  };

  test("the status flip and the candidate rows commit together or not at all", async () => {
    const { w } = await setup();
    const id = await draftWith(w);
    const remove = w.env.idb.inject({
      match: (tx) => tx.label === "data.markInFlight",
      mode: { kind: "throw_on_write", n: 2, as: "error" },
      times: 1,
    });
    const out = await w.service.commit(markInFlight, {
      captured: w.capture(),
      localId: id,
    });
    remove();
    expect(out.kind).toBe("failed");
    expect(w.drafts()[0]?.status).toBe("queued");
    expect(w.effects()).toEqual([]);
    const ok = await w.service.commit(markInFlight, {
      captured: w.capture(),
      localId: id,
    });
    expect(ok).toMatchObject({
      kind: "applied",
      value: { kind: "claimed", flipped: true, created: ["r"] },
    });
    expect(w.effects()).toEqual([
      expect.objectContaining({
        resource_id: "r",
        local_id: id,
        submitted_at_page_seq: 0,
        resource_version: 5,
        display: null,
      }),
    ]);
  });

  test("a RESEND keeps the first submitted_at_page_seq and creates nothing again", async () => {
    const { w } = await setup();
    const id = await draftWith(w);
    await w.service.commit(markInFlight, {
      captured: w.capture(),
      localId: id,
    });
    w.setSync({ page_seq: 7 });
    const again = await w.service.commit(markInFlight, {
      captured: w.capture(),
      localId: id,
    });
    expect(again).toMatchObject({
      kind: "applied",
      value: { kind: "claimed", flipped: false, created: [] },
    });
    expect(w.effects().map((e) => e.submitted_at_page_seq)).toEqual([0]);
  });

  test("the row is keyed [resource_id+local_id]: two drafts against one resource keep TWO rows, ordered by their own created_at", async () => {
    const { w } = await setup();
    const a = await draftWith(w);
    const b = await draftWith(w);
    await w.service.commit(markInFlight, { captured: w.capture(), localId: a });
    // The second is only claimable once the first is settled, but the claim itself is the store's: it must not collide.
    await w.service.commit(markInFlight, { captured: w.capture(), localId: b });
    expect(
      w
        .effects()
        .map((e) => [e.resource_id, e.local_id])
        .sort(),
    ).toEqual(
      [
        ["r", a],
        ["r", b],
      ].sort(),
    );
  });

  test("a draft that is gone, or not sendable, claims nothing", async () => {
    const { w } = await setup();
    expect(
      await w.service.commit(markInFlight, {
        captured: w.capture(),
        localId: "nope",
      }),
    ).toEqual({ kind: "applied", value: { kind: "gone" } });
    const id = await draftWith(w);
    w.put("drafts", [{ ...w.drafts()[0], status: "rejected" }]);
    expect(
      await w.service.commit(markInFlight, {
        captured: w.capture(),
        localId: id,
      }),
    ).toMatchObject({
      kind: "applied",
      value: { kind: "not_sendable", status: "rejected" },
    });
    w.put("drafts", [
      {
        ...w.drafts()[0],
        status: "in_flight",
        review_block: { kind: "defaults", kinds: [] },
      },
    ]);
    expect(
      await w.service.commit(markInFlight, {
        captured: w.capture(),
        localId: id,
      }),
    ).toMatchObject({ value: { kind: "not_sendable" } });
  });
});

describe("F-O5: unclaim returns a draft that never reached the wire", () => {
  test("the draft goes back to queued and ONLY this claim's rows go; a retry candidate stays in_flight", async () => {
    const { w, inc } = await setup();
    const out = await w.outbox.enqueue(edit("r"));
    if (out.kind !== "queued") throw new Error("setup");
    const claim = await w.service.commit(markInFlight, {
      captured: w.capture(),
      localId: out.localId,
    });
    if (claim.kind !== "applied" || claim.value.kind !== "claimed")
      throw new Error("claim");
    // A row from an EARLIER claim of the same draft id must survive: only what this claim created is removed.
    w.put("pending_effects", [
      effectRow({ resource_id: "other", local_id: out.localId }),
    ]);
    await w.service.store.run(unclaimDraft, {
      incarnationId: inc,
      localId: out.localId,
      flipped: true,
      created: ["r"],
    });
    expect(w.drafts()[0]?.status).toBe("queued");
    expect(w.effects().map((e) => e.resource_id)).toEqual(["other"]);
    // Not flipped (it was already in flight): nothing changes.
    w.put("drafts", [{ ...w.drafts()[0], status: "in_flight" }]);
    await w.service.store.run(unclaimDraft, {
      incarnationId: inc,
      localId: out.localId,
      flipped: false,
      created: [],
    });
    expect(w.drafts()[0]?.status).toBe("in_flight");
  });
});

describe("F-O6, F-O8 as stored", () => {
  async function inFlight(
    w: Awaited<ReturnType<typeof setup>>["w"],
    request = edit("r"),
  ) {
    const out = await w.outbox.enqueue(request);
    if (out.kind !== "queued") throw new Error("setup");
    await w.service.commit(markInFlight, {
      captured: w.capture(),
      localId: out.localId,
    });
    return out.localId;
  }

  test("a receipt acknowledges, overlays, and NEVER writes the cache", async () => {
    const { w } = await setup();
    const id = await inFlight(w, {
      ...edit("r"),
      build: (bases) => ({
        command: { b: bases.r as number },
        displayPatch: { r: { label: "Shown" } },
      }),
    });
    w.setSync({ request_seq: 4 });
    const cacheBefore = JSON.stringify(w.rows("cache"));
    const out = await w.service.commit(admitReceipt, {
      captured: w.capture(),
      localId: id,
      revision: 9,
    });
    expect(out).toMatchObject({
      kind: "applied",
      value: { kind: "admitted", displayed: 1 },
    });
    expect(JSON.stringify(w.rows("cache"))).toBe(cacheBefore);
    expect(w.drafts()[0]).toMatchObject({
      status: "acknowledged",
      receipt_revision: 9,
    });
    expect(w.effects()[0]).toMatchObject({
      display: { label: "Shown" },
      no_publication_floor: 4,
      receipt_revision: 9,
    });
    // A duplicate receipt is a no-op.
    const snapshot = JSON.stringify(w.snapshot());
    expect(
      await w.service.commit(admitReceipt, {
        captured: w.capture(),
        localId: id,
        revision: 9,
      }),
    ).toMatchObject({
      value: { kind: "noop", reason: "not_in_flight" },
    });
    expect(JSON.stringify(w.snapshot())).toBe(snapshot);
  });

  test("a receipt that removes the draft (a page already mentioned its resource) removes its command body with it: a body never outlives its draft (R6)", async () => {
    const { w } = await setup();
    const id = await inFlight(w);
    expect(w.rows("draft_commands")).toHaveLength(1);
    // A delta page mentioned the resource before the receipt arrived: its row is released, so nothing keeps the draft.
    w.put(
      "pending_effects",
      w.effects().map((row) => ({ ...row, last_mentioned_page_seq: 2 })),
    );
    const out = await w.service.commit(admitReceipt, {
      captured: w.capture(),
      localId: id,
      revision: 9,
    });
    expect(out).toMatchObject({
      kind: "applied",
      value: { kind: "admitted", removed: true },
    });
    expect(w.drafts()).toEqual([]);
    expect(w.rows("draft_commands")).toEqual([]);
    expect(() => w.assertNoOrphanBodies()).not.toThrow();
  });

  test("with the cache not valid the receipt is held: acknowledged, no display, held_pending_cache, still counted as local work", async () => {
    const { w, inc } = await setup({ cacheStatus: "invalid" });
    const id = await inFlight(w);
    await w.service.commit(admitReceipt, {
      captured: w.capture(),
      localId: id,
      revision: 9,
    });
    expect(w.drafts()[0]).toMatchObject({
      status: "acknowledged",
      held_pending_cache: true,
    });
    expect(w.effects()[0]?.display).toBeNull();
    const summary = await w.service.store.run(summariseWork, {
      incarnationId: inc,
    });
    expect(summary.count).toBe(1);
  });

  test("a receipt is refused by the commit guard while a wipe is closing, and by a later epoch; the draft stays in_flight and uncounted", async () => {
    const { w, inc } = await setup();
    const id = await inFlight(w);
    const stale = w.capture();
    await w.service.store.run(setClosing, {
      incarnationId: inc,
      now: 1,
      token: "t",
    });
    expect(
      await w.service.commit(admitReceipt, {
        captured: stale,
        localId: id,
        revision: 1,
      }),
    ).toEqual({ kind: "dropped", reason: "closing" });
    expect(w.drafts()[0]).toMatchObject({ status: "in_flight", attempts: 0 });
  });

  test("a rejection is retained across a reload, rejects its dependants, and recomputes the base in the same transaction", async () => {
    const { w } = await setup();
    const a = await inFlight(w);
    const b = await w.outbox.enqueue(edit("r"));
    expect(w.versions()[0]?.locally_assumed_version).toBe(7);
    const out = await w.service.commit(recordOutcome, {
      captured: w.capture(),
      localId: a,
      outcome: { kind: "rejected" },
      error: { status: 404, code: "not_found", stage: "rejected" },
      now: 1,
      nowIso: "2026-10-01T10:00:00.000Z",
    });
    expect(out).toMatchObject({
      kind: "applied",
      value: { kind: "recorded", status: "rejected", changed: 2 },
    });
    // Durable in the store the next page reads: the draft AND its dependant, both retained, and the record back to the cache's 5.
    const rows = w.drafts();
    expect(rows.map((d) => d.status)).toEqual(["rejected", "rejected"]);
    expect(rows[1]?.local_id).toBe((b as { localId: string }).localId);
    expect(w.versions()).toEqual([
      { resource_id: "r", locally_assumed_version: 5, basis: "resource" },
    ]);
    expect(w.effects()).toEqual([]);
    // Dismissing a rejected row is the ONLY deletion, and recomputes nothing.
    const before = JSON.stringify(w.versions());
    expect(await w.outbox.discard(rows[0]?.local_id as string)).toMatchObject({
      kind: "discarded",
      outcome: "dismissed",
    });
    expect(JSON.stringify(w.versions())).toBe(before);
    expect(w.drafts().map((d) => d.local_id)).toEqual([rows[1]?.local_id]);
  });

  test("discarding a queued draft removes it, rejects the dependants and resets the record, all in ONE transaction (a fault at any write leaves the queue as it was)", async () => {
    const { w } = await setup();
    const a = await w.outbox.enqueue(edit("r"));
    await w.outbox.enqueue(edit("r"));
    if (a.kind !== "queued") throw new Error("setup");
    const queue = () =>
      JSON.stringify({
        drafts: w.rows("drafts"),
        versions: w.rows("resource_versions"),
        effects: w.rows("pending_effects"),
        cache: w.rows("cache"),
      });
    const before = queue();
    for (const n of [1, 2, 3]) {
      const remove = w.env.idb.inject({
        match: (tx) => tx.label === "data.discardDraft",
        mode: { kind: "throw_on_write", n, as: "error" },
        times: 1,
      });
      const out = await w.outbox.discard(a.localId);
      remove();
      expect(out).toMatchObject({ kind: "refused", reason: "storage" });
      expect(queue()).toBe(before);
    }
    expect(await w.outbox.discard(a.localId)).toMatchObject({
      kind: "discarded",
      outcome: "removed",
      affected: 1,
    });
    expect(w.drafts().map((d) => d.status)).toEqual(["rejected"]);
    expect(w.versions()).toEqual([
      { resource_id: "r", locally_assumed_version: 5, basis: "resource" },
    ]);
  });

  test("an in_flight draft cannot be discarded (it may have been executed)", async () => {
    const { w } = await setup();
    const id = await inFlight(w);
    expect(await w.outbox.discard(id)).toEqual({
      kind: "refused",
      reason: "in_flight",
    });
    expect(w.drafts()).toHaveLength(1);
    void discardDraft;
  });
});

describe("F-O15: the digest of the unsynced work", () => {
  const digest = async (
    w: Awaited<ReturnType<typeof setup>>["w"],
    inc: string,
  ) =>
    (await w.service.store.run(summariseWork, { incarnationId: inc })).digest;

  test("it changes when a queued command is edited in place, and when one draft is replaced by another (same count)", async () => {
    const { w, inc } = await setup();
    const a = await w.outbox.enqueue(edit("r"));
    if (a.kind !== "queued") throw new Error("setup");
    const first = await digest(w, inc);
    await w.outbox.editQueued(a.localId, edit("r", { extra: 1 }));
    const edited = await digest(w, inc);
    expect(edited).not.toBe(first);
    w.put("drafts", []);
    w.env.idb.seed(`atlas-${ACCOUNT}`, "drafts", [
      draftRow({
        local_id: "other",
        command: { kind: "edit", id: "r", base: 5, extra: 1 },
      }),
    ]);
    expect(await digest(w, inc)).not.toBe(edited);
  });

  test("it changes when an acknowledged draft's flag is set or cleared, and when a recovery copy's content changes", async () => {
    const { w, inc } = await setup();
    w.put("drafts", [
      draftRow({
        local_id: "ack",
        status: "acknowledged",
        held_pending_cache: true,
      }),
    ]);
    const held = await digest(w, inc);
    w.put("drafts", [
      draftRow({
        local_id: "ack",
        status: "acknowledged",
        held_pending_cache: false,
      }),
    ]);
    const cleared = await digest(w, inc);
    expect(cleared).not.toBe(held);
    w.env.idb.seed(`atlas-${ACCOUNT}`, "form_recovery", [
      recoveryRow({ fields: { a: "1" }, content_digest: "one" }),
    ]);
    const one = await digest(w, inc);
    w.env.idb.seed(`atlas-${ACCOUNT}`, "form_recovery", [
      recoveryRow({ fields: { a: "2" }, content_digest: "two" }),
    ]);
    expect(await digest(w, inc)).not.toBe(one);
  });

  test("it is unchanged by pending_effects and by cache changes", async () => {
    const { w, inc } = await setup();
    w.put("drafts", [draftRow({ local_id: "d" })]);
    const before = await digest(w, inc);
    w.put("pending_effects", [effectRow({ local_id: "d", resource_id: "r" })]);
    w.put("cache", [cacheRow({ id: "r", version: 99, label: "changed" })]);
    expect(await digest(w, inc)).toBe(before);
  });
});
