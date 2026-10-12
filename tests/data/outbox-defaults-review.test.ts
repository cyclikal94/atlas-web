// @vitest-environment node
import { describe, expect, test } from "vitest";
import { captureDefaults } from "../../src/data";
import {
  decideSupersede,
  type EnqueueRequest,
  planEdit,
  planEnqueue,
  type TargetSpec,
} from "../../src/data/model/outbox";
import {
  BasesMoved,
  confirmationPath,
  confirmationRequest,
  isReviewedDraft,
  reviewedOf,
  targetsOf,
} from "../../src/data/model/review-confirmation";
import { initialSyncState } from "../../src/data/model/sync-state";
import type { DraftRow, SyncStateRow } from "../../src/data/model/types";
import { outboxWorld } from "../support/data/outbox-world";
import { cacheRow, draftRow } from "../support/data/rows";
import { record, revision, snapshot } from "../support/data/sharing";

/**
 * WEB-12a (D-12a-5, D-12a-6; WEB-04 §5.7): a queued create that relies on defaults the device cannot vouch for is stored BLOCKED on review
 * (`BuildResult.defaultsReview`), is never sent, holds the queue behind it (D-19), and is released ONLY by the person's confirmation,
 * which rebuilds the stored body with only its `defaults_revision` replaced. Model rules, then the production facade and dispatcher over
 * the double of IndexedDB with a scripted server. FIXTURE evidence: no backend.
 */
const NOW = "2026-10-10T10:00:00.000Z";
const sync = (over: Partial<SyncStateRow> = {}): SyncStateRow => ({
  ...initialSyncState("inc"),
  phase: "delta",
  cache_status: "valid",
  ...over,
});
const target = (id: string, over: Partial<TargetSpec> = {}): TargetSpec => ({
  resourceId: id,
  role: "primary",
  basis: "resource",
  versionChecked: false,
  seedIfUntracked: 1,
  ...over,
});
/** A queued create of a resource that relies on the person template, as WEB-10/11 will build one (never in product code here). */
const createWith = (
  id: string,
  capture: ReturnType<typeof captureDefaults>,
): EnqueueRequest => ({
  endpoint: "/commands",
  targets: [target(id)],
  build: () => ({
    command: {
      commands: [{ kind: "create_person", id, name: id }],
      ...(capture.defaultsRevision === null
        ? {}
        : { defaults_revision: capture.defaultsRevision }),
    },
    displayPatch: { [id]: { label: id } },
    defaultsRevision: capture.defaultsRevision,
    defaultsContext: capture.defaultsContext,
    defaultsReview: capture.defaultsReview,
  }),
});
const plain = (id: string): EnqueueRequest => ({
  endpoint: "/commands",
  targets: [target(id)],
  build: () => ({ command: { kind: "create", id } }),
});
const facts = (localId = "L1") => ({
  sync: sync(),
  cache: new Map(),
  versions: new Map(),
  related: [],
  existing: undefined,
  localId,
  accountId: "acc",
  now: NOW,
});

describe("model: the review block a build asks for", () => {
  test("MU-D7: a never-fetched capture stores review_block { kind: defaults, kinds }", () => {
    const planned = planEnqueue(
      createWith("p", captureDefaults(null, ["person"])),
      facts(),
    );
    expect(planned.kind).toBe("queued");
    expect(planned.kind === "queued" && planned.draft.review_block).toEqual({
      kind: "defaults",
      kinds: ["person"],
    });
    expect(planned.kind === "queued" && planned.draft.defaults_revision).toBe(
      null,
    );
  });

  test("a capture with nothing to review stores no block; a request that says nothing stores none either", () => {
    const captured = planEnqueue(
      createWith("p", captureDefaults(record(), ["person"])),
      facts(),
    );
    expect(captured.kind === "queued" && captured.draft.review_block).toBe(
      null,
    );
    expect(captured.kind === "queued" && captured.draft.defaults_revision).toBe(
      revision(1),
    );
    const none = planEnqueue(plain("x"), facts());
    expect(none.kind === "queued" && none.draft.review_block).toBe(null);
  });

  test("a defaultsReview that is not a list of texts is not what the contract allows (not_json)", () => {
    const planned = planEnqueue(
      {
        ...plain("x"),
        build: () => ({
          command: { kind: "create", id: "x" },
          defaultsReview: "person" as unknown as string[],
        }),
      },
      facts(),
    );
    expect(planned).toEqual({ kind: "invalid", reason: "not_json" });
  });

  test("MU-D8: an edit that says nothing about defaults KEEPS the block; [] (the confirmation) clears it; a list replaces it", () => {
    const queued = planEnqueue(
      createWith("p", captureDefaults(null, ["person", "progress"])),
      facts(),
    );
    if (queued.kind !== "queued") throw new Error("setup");
    const draft = queued.draft;
    const kept = planEdit(plain("p"), draft, sync());
    expect(kept.kind === "edited" && kept.draft.review_block).toEqual({
      kind: "defaults",
      kinds: ["person", "progress"],
    });
    const cleared = planEdit(
      {
        ...plain("p"),
        build: () => ({
          command: { kind: "create", id: "p" },
          defaultsReview: [],
        }),
      },
      draft,
      sync(),
    );
    expect(cleared.kind === "edited" && cleared.draft.review_block).toBe(null);
    const replaced = planEdit(
      {
        ...plain("p"),
        build: () => ({
          command: { kind: "create", id: "p" },
          defaultsReview: ["task", "task"],
        }),
      },
      draft,
      sync(),
    );
    expect(replaced.kind === "edited" && replaced.draft.review_block).toEqual({
      kind: "defaults",
      kinds: ["task"],
    });
  });
});

describe("model: the confirmation's rebuild (D-12a-6)", () => {
  const stored = draftRow({
    local_id: "L1",
    endpoint: "/commands",
    target_resource_ids: ["p"],
    index_targets: ["p", "s"],
    side_effect_bases: { s: 4 },
    bases: { p: 1, s: 4 },
    bumped: ["s"],
    review_block: { kind: "defaults", kinds: ["person"] },
    display_patch: { p: { label: "p" } },
  });
  const command = {
    commands: [{ kind: "create_person", id: "p", name: "p" }],
    defaults_revision: revision(1),
  };
  const confirmed = {
    reviewed: reviewedOf(stored),
    defaultsRevision: revision(2),
    defaultsContext: { format: "x" },
  };

  test("only the top-level defaults_revision changes; the context is replaced and the block cleared", () => {
    const request = confirmationRequest(stored, command, new Map(), confirmed);
    expect(request.build({ p: 1, s: 4 })).toEqual({
      command: { ...command, defaults_revision: revision(2) },
      displayPatch: { p: { label: "p" } },
      defaultsRevision: revision(2),
      defaultsContext: { format: "x" },
      defaultsReview: [],
    });
    expect(request.endpoint).toBe("/commands");
  });

  test("MU-D10: handed versions that differ from the stored bases, the build REFUSES", () => {
    const request = confirmationRequest(stored, command, new Map(), confirmed);
    expect(() => request.build({ p: 1, s: 5 })).toThrow(BasesMoved);
    expect(() => request.build({ p: 1 })).toThrow(BasesMoved);
    expect(() => request.build({ p: 1, s: 4, q: 1 })).toThrow(BasesMoved);
  });

  test("the targets are the draft's own: the create seeded at its base, the side effect version-checked with its recorded basis", () => {
    expect(targetsOf(stored, new Map([["s", "progress_stream"]]))).toEqual([
      {
        resourceId: "p",
        role: "primary",
        basis: "resource",
        versionChecked: false,
        seedIfUntracked: 1,
      },
      {
        resourceId: "s",
        role: "side_effect",
        basis: "progress_stream",
        versionChecked: true,
      },
    ]);
  });

  test("the path: queued with a block is an edit, in flight with a block a supersession, anything else none", () => {
    expect(
      confirmationPath({ status: "queued", review_block: stored.review_block }),
    ).toBe("edit");
    expect(
      confirmationPath({
        status: "in_flight",
        review_block: stored.review_block,
      }),
    ).toBe("supersede");
    expect(confirmationPath({ status: "queued", review_block: null })).toBe(
      null,
    );
    expect(
      confirmationPath({
        status: "rejected",
        review_block: stored.review_block,
      }),
    ).toBe(null);
  });
});

const draftOf = (w: { drafts(): DraftRow[] }, localId: string): DraftRow => {
  const found = w.drafts().find((d) => d.local_id === localId);
  if (found === undefined) throw new Error(`no draft ${localId}`);
  return found;
};

async function started() {
  const w = await outboxWorld();
  w.put("cache", [cacheRow({ id: "r", version: 5 })]);
  w.start();
  await w.settle();
  return w;
}

describe("the facade and dispatcher: a locally blocked draft", () => {
  test("A11: is never sent, holds every LATER draft (D-19), and is counted as needing a decision", async () => {
    const w = await started();
    const blocked = await w.outbox.enqueue(
      createWith("p", captureDefaults(null, ["person"])),
    );
    const behind = await w.outbox.enqueue(plain("later"));
    await w.settle();
    await w.advance(10 * 60_000);
    expect(blocked.kind).toBe("queued");
    expect(behind.kind).toBe("queued");
    expect(w.sent).toEqual([]);
    expect(w.drafts().map((d) => [d.status, d.review_block !== null])).toEqual([
      ["queued", true],
      ["queued", false],
    ]);
  });

  test("an earlier independent draft is still sent: the hold is FROM the blocked draft, not before it", async () => {
    const w = await started();
    await w.outbox.enqueue(plain("first"));
    await w.outbox.enqueue(createWith("p", captureDefaults(null, ["person"])));
    await w.settle();
    expect(w.sent.map((s) => JSON.parse(s.body).id)).toEqual(["first"]);
  });

  test("an edit of its content does not release it", async () => {
    const w = await started();
    const out = await w.outbox.enqueue(
      createWith("p", captureDefaults(null, ["person"])),
    );
    if (out.kind !== "queued") throw new Error("setup");
    const edited = await w.outbox.editQueued(out.localId, {
      ...plain("p"),
      build: () => ({
        command: { commands: [{ kind: "create_person", id: "p", name: "P2" }] },
      }),
    });
    expect(edited.kind).toBe("edited");
    await w.settle();
    await w.advance(60_000);
    expect(w.sent).toEqual([]);
    expect(w.drafts()[0]?.review_block).not.toBeNull();
  });

  test("the confirmation edits it IN PLACE (same local_id), clears the block, and it is sent with the reviewed revision", async () => {
    const w = await started();
    const out = await w.outbox.enqueue(
      createWith("p", captureDefaults(null, ["person"])),
    );
    if (out.kind !== "queued") throw new Error("setup");
    await w.outbox.enqueue(plain("later"));
    await w.settle();
    expect(w.sent).toEqual([]);
    const now = captureDefaults(record(snapshot({ revision: revision(7) })), [
      "person",
    ]);
    const confirmed = await w.outbox.confirmDefaultsReview(out.localId, {
      reviewed: reviewedOf(draftOf(w, out.localId)),
      defaultsRevision: now.defaultsRevision as string,
      defaultsContext: now.defaultsContext,
    });
    expect(confirmed).toEqual({
      kind: "confirmed",
      how: "edited",
      localId: out.localId,
      paused: [],
    });
    await w.settle();
    expect(w.sent.map((s) => s.key)[0]).toBe(out.localId);
    expect(JSON.parse(w.sent[0]?.body as string)).toEqual({
      commands: [{ kind: "create_person", id: "p", name: "p" }],
      defaults_revision: revision(7),
    });
    // The hold is gone with the block: the later draft follows.
    expect(w.sent).toHaveLength(2);
    const header = w.drafts().find((d) => d.local_id === out.localId);
    expect(header?.defaults_context).toEqual(now.defaultsContext);
    expect(header?.defaults_revision).toBe(revision(7));
  });

  test("a draft with no review is refused (not_reviewing), and an unknown id is not_found", async () => {
    const w = await started();
    // The plain draft is sent at once, so it is acknowledged by the time it is asked about.
    const out = await w.outbox.enqueue(plain("x"));
    await w.settle();
    if (out.kind !== "queued") throw new Error("setup");
    const confirmation = {
      reviewed: reviewedOf(draftOf(w, out.localId)),
      defaultsRevision: revision(1),
      defaultsContext: null,
    };
    expect(
      await w.outbox.confirmDefaultsReview(out.localId, confirmation),
    ).toEqual({
      kind: "refused",
      reason: "not_reviewing",
    });
    expect(
      await w.outbox.confirmDefaultsReview(
        "00000000-0000-4000-8000-000000000000",
        confirmation,
      ),
    ).toEqual({ kind: "refused", reason: "not_found" });
  });

  test("a locally blocked draft can be discarded (it was never sent)", async () => {
    const w = await started();
    const out = await w.outbox.enqueue(
      createWith("p", captureDefaults(null, ["person"])),
    );
    if (out.kind !== "queued") throw new Error("setup");
    expect((await w.outbox.discard(out.localId)).kind).toBe("discarded");
    expect(w.drafts()).toEqual([]);
  });
});

describe("the facade and dispatcher: a draft refused with defaults_changed", () => {
  test("the confirmation SUPERSEDES it with a fresh local_id carrying the reviewed revision, and the replacement is sent", async () => {
    const w = await started();
    w.script.push(w.error(409, "defaults_changed"));
    const out = await w.outbox.enqueue(
      createWith("p", captureDefaults(record(), ["person"])),
    );
    if (out.kind !== "queued") throw new Error("setup");
    await w.settle();
    expect(w.drafts()[0]).toMatchObject({
      status: "in_flight",
      review_block: { kind: "defaults" },
    });
    const now = captureDefaults(record(snapshot({ revision: revision(3) })), [
      "person",
    ]);
    const replacementId = "55555555-5555-4555-8555-555555555555";
    const reviewed = reviewedOf(draftOf(w, out.localId));
    const confirmed = await w.outbox.confirmDefaultsReview(out.localId, {
      reviewed,
      defaultsRevision: now.defaultsRevision as string,
      defaultsContext: now.defaultsContext,
      replacementId,
    });
    expect(confirmed).toEqual({
      kind: "confirmed",
      how: "superseded",
      localId: replacementId,
      paused: [],
    });
    await w.settle();
    expect(w.sent.map((s) => s.key)).toEqual([out.localId, replacementId]);
    expect(JSON.parse(w.sent[1]?.body as string).defaults_revision).toBe(
      revision(3),
    );
    expect(w.drafts().map((d) => d.local_id)).toEqual([replacementId]);
    // Confirming again after the supersession landed finds no draft under review: `not_found`, and nothing changes (the review closes).
    expect(
      await w.outbox.confirmDefaultsReview(out.localId, {
        reviewed,
        defaultsRevision: now.defaultsRevision as string,
        defaultsContext: now.defaultsContext,
        replacementId,
      }),
    ).toEqual({ kind: "refused", reason: "not_found" });
  });
});

/**
 * WEB-12a R2 (review cycle 1): the confirmation is decided on a draft read BEFORE its write, so it is conditional on that draft. Another
 * page's edit of the same queued draft committed between the confirmation's read and its write must survive, and the confirmation must
 * be refused (`draft_changed`) so the person reviews the draft as it now is. The forced schedule holds the confirmation after its read
 * transaction has COMPLETED (a held result, not a live transaction), exactly the reviewer's reproduction.
 */
describe("R2: the confirmation never overwrites a newer committed edit", () => {
  const named = (name: string, blocked = true): EnqueueRequest => ({
    endpoint: "/commands",
    targets: [target("p")],
    build: () => ({
      command: { commands: [{ kind: "create_person", id: "p", name }] },
      ...(blocked ? { defaultsReview: ["person"] } : {}),
    }),
  });
  const reviewedNow = captureDefaults(
    record(snapshot({ revision: revision(2) })),
    ["person"],
  );
  const confirmWith = (reviewed: DraftRow) => ({
    reviewed: reviewedOf(reviewed),
    defaultsRevision: reviewedNow.defaultsRevision as string,
    defaultsContext: reviewedNow.defaultsContext,
  });

  /** Holds every run of `data.readReviewDraft` after its transaction completed, until released. */
  function holdReviewRead(w: Awaited<ReturnType<typeof started>>) {
    const run = w.service.store.run.bind(w.service.store);
    let release!: () => void;
    let read!: () => void;
    const done = new Promise<void>((resolve) => {
      read = resolve;
    });
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    w.service.store.run = (async (plan: { name: string }, input: unknown) => {
      const result = await run(plan as never, input as never);
      if (plan.name === "data.readReviewDraft") {
        read();
        await hold;
      }
      return result;
    }) as typeof w.service.store.run;
    return { done, release };
  }

  test("MU-S23: an edit committed after the confirmation's read is KEPT; the confirmation is refused (draft_changed) and the block stays", async () => {
    const w = await started();
    const out = await w.outbox.enqueue(named("original"));
    if (out.kind !== "queued") throw new Error("setup");
    const shown = draftOf(w, out.localId);
    const held = holdReviewRead(w);
    const confirming = w.outbox.confirmDefaultsReview(
      out.localId,
      confirmWith(shown),
    );
    await held.done;
    expect((await w.outbox.editQueued(out.localId, named("newer"))).kind).toBe(
      "edited",
    );
    expect(w.commandOf(out.localId)).toEqual({
      commands: [{ kind: "create_person", id: "p", name: "newer" }],
    });
    held.release();
    expect(await confirming).toEqual({
      kind: "refused",
      reason: "draft_changed",
    });
    // The newer edit survives, still blocked on review: nothing was approved implicitly, and nothing was sent.
    expect(w.commandOf(out.localId)).toEqual({
      commands: [{ kind: "create_person", id: "p", name: "newer" }],
    });
    expect(draftOf(w, out.localId).review_block).toEqual({
      kind: "defaults",
      kinds: ["person"],
    });
    await w.settle();
    expect(w.sent).toEqual([]);
  });

  test("MU-S24: the row the review SHOWED is what is checked: an edit before the confirmation's read is refused too, and a renewed review confirms the newer body", async () => {
    const w = await started();
    const out = await w.outbox.enqueue(named("original"));
    if (out.kind !== "queued") throw new Error("setup");
    const shown = draftOf(w, out.localId);
    expect((await w.outbox.editQueued(out.localId, named("newer"))).kind).toBe(
      "edited",
    );
    expect(
      await w.outbox.confirmDefaultsReview(out.localId, confirmWith(shown)),
    ).toEqual({ kind: "refused", reason: "draft_changed" });
    expect(w.commandOf(out.localId)).toEqual({
      commands: [{ kind: "create_person", id: "p", name: "newer" }],
    });
    // The person reviews the draft as it now is and confirms: the NEWER body is sent with the reviewed revision.
    const renewed = draftOf(w, out.localId);
    expect(
      await w.outbox.confirmDefaultsReview(out.localId, confirmWith(renewed)),
    ).toMatchObject({ kind: "confirmed", how: "edited" });
    await w.settle();
    expect(JSON.parse(w.sent[0]?.body as string)).toEqual({
      commands: [{ kind: "create_person", id: "p", name: "newer" }],
      defaults_revision: revision(2),
    });
  });

  test("control: with no edit in between, the held confirmation still confirms the reviewed body", async () => {
    const w = await started();
    const out = await w.outbox.enqueue(named("original"));
    if (out.kind !== "queued") throw new Error("setup");
    const held = holdReviewRead(w);
    const confirming = w.outbox.confirmDefaultsReview(
      out.localId,
      confirmWith(draftOf(w, out.localId)),
    );
    await held.done;
    held.release();
    expect(await confirming).toMatchObject({
      kind: "confirmed",
      how: "edited",
    });
    expect(draftOf(w, out.localId).review_block).toBe(null);
    expect(w.commandOf(out.localId)).toEqual({
      commands: [{ kind: "create_person", id: "p", name: "original" }],
      defaults_revision: revision(2),
    });
  });

  test("a change of the review itself (block or context) between the read and the write is refused as well", async () => {
    const w = await started();
    const out = await w.outbox.enqueue(named("original"));
    if (out.kind !== "queued") throw new Error("setup");
    const shown = draftOf(w, out.localId);
    const held = holdReviewRead(w);
    const confirming = w.outbox.confirmDefaultsReview(
      out.localId,
      confirmWith(shown),
    );
    await held.done;
    // The same body, re-captured with another kind to review: what the person saw is no longer the whole review.
    expect(
      (
        await w.outbox.editQueued(out.localId, {
          ...named("original"),
          build: () => ({
            command: {
              commands: [{ kind: "create_person", id: "p", name: "original" }],
            },
            defaultsReview: ["person", "progress"],
          }),
        })
      ).kind,
    ).toBe("edited");
    held.release();
    expect(await confirming).toEqual({
      kind: "refused",
      reason: "draft_changed",
    });
    expect(draftOf(w, out.localId).review_block).toEqual({
      kind: "defaults",
      kinds: ["person", "progress"],
    });
  });

  test("model: expectDraft is checked against the STORED draft in planEdit and decideSupersede; false writes nothing", () => {
    const queued = draftRow({
      local_id: "L1",
      endpoint: "/commands",
      target_resource_ids: ["p"],
      index_targets: ["p"],
      bases: { p: 1 },
      review_block: { kind: "defaults", kinds: ["person"] },
    });
    const refuse = { ...plain("p"), expectDraft: () => false };
    expect(planEdit(refuse, queued, sync())).toEqual({
      kind: "refused",
      reason: "draft_changed",
    });
    expect(
      planEdit({ ...plain("p"), expectDraft: () => true }, queued, sync()).kind,
    ).toBe("edited");
    const inFlight = { ...queued, status: "in_flight" as const };
    const supersedeFacts = {
      old: inFlight,
      existing: undefined,
      existingPaused: [],
      direct: [],
      cascade: [inFlight],
      effects: [],
      others: [],
      cache: new Map(),
      versions: new Map(),
      sync: sync(),
      localId: "L2",
      accountId: "acc",
      now: NOW,
    };
    expect(decideSupersede(refuse, supersedeFacts)).toEqual({
      kind: "refused",
      reason: "draft_changed",
    });
    expect(
      decideSupersede(
        { ...plain("p"), expectDraft: () => true },
        supersedeFacts,
      ).kind,
    ).toBe("superseded");
  });

  test("isReviewedDraft compares the body digest, revision, context, block and status, nothing else", () => {
    const base = draftRow({
      local_id: "L1",
      review_block: { kind: "defaults", kinds: ["person"] },
    });
    expect(isReviewedDraft(base, reviewedOf(base))).toBe(true);
    const busier: DraftRow = { ...base, attempts: 3, last_error: null };
    expect(isReviewedDraft(busier, reviewedOf(base))).toBe(true);
    for (const changed of [
      { command_digest: "f".repeat(64) },
      { defaults_revision: revision(9) },
      { defaults_context: { other: true } },
      { review_block: { kind: "defaults" as const, kinds: ["task"] } },
      { status: "in_flight" as const },
    ])
      expect(isReviewedDraft({ ...base, ...changed }, reviewedOf(base))).toBe(
        false,
      );
  });
});
