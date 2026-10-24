import { beforeEach, describe, expect, test } from "vitest";
import type {
  DraftWithCommand,
  EnqueueRequest,
  JsonObject,
} from "../../../src/data";
import { digestOf } from "../../../src/data/model/canonical";
import { OutboxRequestError, planEdit } from "../../../src/data/model/outbox";
import { initialSyncState } from "../../../src/data/model/sync-state";
import { forgetAllPeopleMemory } from "../../../src/features/people/memory";
import {
  archiveRequest,
  putFieldCreateRequest,
  putFieldUpdateRequest,
  renameEditRequest,
} from "../../../src/features/people/model/commands";
import { draftRow, headerOf } from "../data/rows";
import { fieldRow, type PeopleWorld, peopleWorld, person } from "./world";

/**
 * The People world's outbox double against the outbox's contract (review 11, R11.1; its design assessment, DA11-01..04). A double that
 * accepts what the real outbox refuses, or stores what it would not, lets the screens' tests pass on writes the product never makes. Every
 * expectation here is LITERAL (the base the wire carries, the body as written out, `digestOf` of that body, the state left after a
 * refusal); none is the world compared with the planner it now uses, so these cases would catch a double that drifts from the contract
 * whatever it is built on. Review 11's base 1 / record 2 case also runs through the production `planEdit` as the control.
 */
const P = "55555555-5555-4555-8555-555555555555";
const F = "66666666-6666-4666-8666-666666666666";
const G = "77777777-7777-4777-8777-777777777777";

beforeEach(() => forgetAllPeopleMemory());

/** The `put_field` update body exactly as the wire carries it. */
const updateBody = (base: number, text: string) => ({
  command: {
    kind: "put_field",
    id: F,
    parent_id: P,
    expected_version: base,
    expected_policy_version: 1,
    label: "Note",
    value: { kind: "text", text },
  },
});

const update = (text: string, reviewed?: string): EnqueueRequest => ({
  ...putFieldUpdateRequest({
    fieldId: F,
    personId: P,
    label: "Note",
    value: { kind: "text", text },
    policyVersion: 1,
    sameKind: true,
  }),
  ...(reviewed === undefined
    ? {}
    : { expectDraft: (d) => d.command_digest === reviewed }),
});

/** Review 11's case: a queued update stored on base 1, after which its own enqueue raised the record to 2. */
function queuedUpdate() {
  const w = peopleWorld({ online: false });
  w.setCache([
    person({ id: P }),
    fieldRow({ id: F, parent_id: P, version: 1, policy_version: 1 }),
  ]);
  const command = updateBody(1, "Original queued body");
  const draft = draftRow({
    local_id: "queued",
    endpoint: "/task-commands",
    command,
    kind: "put_field",
    target_resource_ids: [F],
    index_targets: [F],
    bases: { [F]: 1 },
    bumped: [F],
    expected_version: 1,
    created_seq: 7,
  });
  w.setDrafts([draft]);
  w.versions.set(F, 2);
  return { w, draft, outbox: outboxOf(w) };
}

function outboxOf(w: PeopleWorld) {
  const outbox = w.env.outbox();
  if (outbox === null) throw new Error("no outbox");
  return outbox;
}

/** Everything a refused write must leave as it was. */
const stateOf = (w: PeopleWorld) =>
  structuredClone({
    drafts: w.drafts,
    versions: [...w.versions],
    built: w.built.map((b) => ({ op: b.op, localId: b.localId })),
  });

describe("DA11-01: an in-place edit rebuilds on the draft's OWN bases and publishes its body's digest", () => {
  test("production control: planEdit keeps base 1, writes the new body's digest and refuses the old reviewed digest", () => {
    const { draft } = queuedUpdate();
    const sync = initialSyncState("control");
    const edited = planEdit(
      update("Replacement body", draft.command_digest),
      headerOf(draft),
      sync,
    );
    expect(edited.kind).toBe("edited");
    if (edited.kind !== "edited") return;
    expect(edited.command).toEqual(updateBody(1, "Replacement body"));
    expect(edited.draft.command_digest).toBe(
      digestOf(updateBody(1, "Replacement body")),
    );
    expect(
      planEdit(
        update("Replacement body", draft.command_digest),
        edited.draft,
        sync,
      ),
    ).toEqual({ kind: "refused", reason: "draft_changed" });
  });

  test("the world: base 1 on the wire, the stored body's digest, same id/place/dependencies, the record untouched", async () => {
    const { w, draft, outbox } = queuedUpdate();
    expect(
      await outbox.editQueued(
        "queued",
        update("Replacement body", draft.command_digest),
      ),
    ).toEqual({ kind: "edited", localId: "queued" });
    expect(w.drafts).toHaveLength(1);
    const stored = w.drafts[0] as DraftWithCommand;
    expect(stored.command).toEqual(updateBody(1, "Replacement body"));
    expect(stored.command_digest).toBe(
      digestOf(updateBody(1, "Replacement body")),
    );
    expect(stored.command_digest).not.toBe(draft.command_digest);
    expect(stored).toMatchObject({
      local_id: "queued",
      created_seq: 7,
      bases: { [F]: 1 },
      bumped: [F],
      depends_on: [],
      status: "queued",
      display_patch: {
        [F]: {
          label: "Note",
          value: { kind: "text", text: "Replacement body" },
        },
      },
    });
    expect(w.versions.get(F)).toBe(2);
    expect(w.built.map((b) => [b.op, b.localId])).toEqual([["edit", "queued"]]);
    expect(w.built[0]?.command).toEqual(updateBody(1, "Replacement body"));
  });

  test("a later edit that still reviews the OLD body is refused, and nothing changes", async () => {
    const { w, draft, outbox } = queuedUpdate();
    await outbox.editQueued("queued", update("B", draft.command_digest));
    const before = stateOf(w);
    expect(
      await outbox.editQueued("queued", update("C", draft.command_digest)),
    ).toEqual({ kind: "refused", reason: "draft_changed" });
    expect(stateOf(w)).toEqual(before);
  });

  test("repeated edits, each reviewing the body before it: base 1 every time, a fresh digest every time", async () => {
    const { w, draft, outbox } = queuedUpdate();
    let reviewed = draft.command_digest;
    for (const text of ["B", "C", "D"]) {
      expect(await outbox.editQueued("queued", update(text, reviewed))).toEqual(
        { kind: "edited", localId: "queued" },
      );
      const stored = w.drafts[0] as DraftWithCommand;
      expect(stored.command).toEqual(updateBody(1, text));
      expect(stored.command_digest).toBe(digestOf(updateBody(1, text)));
      expect(stored.command_digest).not.toBe(reviewed);
      reviewed = stored.command_digest;
    }
    expect(w.versions.get(F)).toBe(2);
    expect(w.drafts).toHaveLength(1);
  });

  test("an edit to the identical body keeps the digest (a different body is what changes it)", async () => {
    const { w, outbox } = queuedUpdate();
    const original = digestOf(updateBody(1, "Original queued body"));
    expect(
      await outbox.editQueued(
        "queued",
        update("Original queued body", original),
      ),
    ).toEqual({ kind: "edited", localId: "queued" });
    expect(w.drafts[0]?.command_digest).toBe(original);
  });
});

describe("DA11-01: enqueue resolves and raises the bases once, and stores the digest of each body", () => {
  test("two updates of one field: cached base, then the raised record; distinct digests; the second waits on the first", async () => {
    const w = peopleWorld({ online: false });
    w.setCache([
      person({ id: P }),
      fieldRow({ id: F, parent_id: P, version: 4, policy_version: 1 }),
    ]);
    const outbox = outboxOf(w);
    const first = await outbox.enqueue(update("first"));
    const second = await outbox.enqueue(update("second"));
    expect(first.kind).toBe("queued");
    expect(second.kind).toBe("queued");
    const [a, b] = w.drafts as [DraftWithCommand, DraftWithCommand];
    expect(a.command).toEqual(updateBody(4, "first"));
    expect(b.command).toEqual(updateBody(5, "second"));
    expect(a.command_digest).toBe(digestOf(updateBody(4, "first")));
    expect(b.command_digest).toBe(digestOf(updateBody(5, "second")));
    expect(a).toMatchObject({
      bases: { [F]: 4 },
      bumped: [F],
      expected_version: 4,
      target_resource_ids: [F],
      index_targets: [F],
      endpoint: "/task-commands",
      kind: "put_field",
      depends_on: [],
    });
    expect(b).toMatchObject({ bases: { [F]: 5 }, depends_on: [a.local_id] });
    expect(b.created_seq).toBeGreaterThan(a.created_seq);
    expect(w.versions.get(F)).toBe(6);
  });

  test("a create seeds its record without an expected version; its update then builds on the seed", async () => {
    const w = peopleWorld({ online: false });
    w.setCache([person({ id: P })]);
    const outbox = outboxOf(w);
    await outbox.enqueue(
      putFieldCreateRequest({
        fieldId: G,
        personId: P,
        label: "Pet",
        value: { kind: "text", text: "Biscuit" },
        audience: "only_you",
        record: null,
      }),
    );
    const created = w.drafts[0] as DraftWithCommand;
    expect(created).toMatchObject({ bases: { [G]: 1 }, bumped: [] });
    expect(created).not.toHaveProperty("expected_version");
    expect(created.command_digest).toBe(digestOf(created.command));
    expect(w.versions.get(G)).toBe(1);
  });

  test("the same save again (same local id): one row, no second raise, the first's place", async () => {
    const w = peopleWorld({ online: false });
    w.setCache([
      person({ id: P }),
      fieldRow({ id: F, parent_id: P, version: 4, policy_version: 1 }),
    ]);
    const outbox = outboxOf(w);
    const request = { ...update("once"), localId: "same-save" };
    const first = await outbox.enqueue(request);
    const again = await outbox.enqueue(request);
    expect(again).toEqual(first);
    expect(w.drafts).toHaveLength(1);
    expect(w.versions.get(F)).toBe(5);
    expect(w.built).toHaveLength(1);
  });

  test("archive and rename take the record a queued save raised, not the cache", async () => {
    const w = peopleWorld({ online: false });
    w.setCache([person({ id: P, version: 3, policy_version: 2 })]);
    const outbox = outboxOf(w);
    await outbox.enqueue(
      renameEditRequest({ personId: P, name: "Ada", policyVersion: 2 }),
    );
    await outbox.enqueue(archiveRequest({ id: P, archived: true }));
    const [rename, archive] = w.drafts as [DraftWithCommand, DraftWithCommand];
    expect(rename.command).toEqual({
      commands: [
        {
          kind: "edit",
          id: P,
          expected_version: 3,
          expected_policy_version: 2,
          label: "Ada",
          value: "",
        },
      ],
    });
    expect(archive.command).toEqual({
      command: { kind: "archive", id: P, expected_version: 4, archived: true },
    });
    expect(archive.depends_on).toEqual([rename.local_id]);
    expect(w.versions.get(P)).toBe(5);
  });
});

describe("DA11-01: a published page reconciles the version records as commitPage does", () => {
  async function seeded() {
    const w = peopleWorld({ online: false });
    w.setCache([person({ id: P })]);
    await outboxOf(w).enqueue(
      putFieldCreateRequest({
        fieldId: G,
        personId: P,
        label: "Pet",
        value: { kind: "text", text: "Biscuit" },
        audience: "only_you",
        record: null,
      }),
    );
    expect(w.versions.get(G)).toBe(1);
    return w;
  }

  test("the create published (its draft retired in the same commit): the record ends, and the next update builds on the cache", async () => {
    const w = await seeded();
    w.handOff([fieldRow({ id: G, parent_id: P, version: 2 })], []);
    expect(w.versions.has(G)).toBe(false);
    await outboxOf(w).enqueue({
      ...putFieldUpdateRequest({
        fieldId: G,
        personId: P,
        label: "Pet",
        value: { kind: "text", text: "Rex" },
        policyVersion: 1,
        sameKind: true,
      }),
    });
    expect(w.drafts[0]?.command).toMatchObject({
      command: { expected_version: 2 },
    });
    expect(w.versions.get(G)).toBe(3);
  });

  test("controls: while a draft still targets it, a higher version raises the record and a lower one leaves it", async () => {
    const w = await seeded();
    const outstanding = w.drafts;
    w.handOff([fieldRow({ id: G, parent_id: P, version: 3 })], outstanding);
    expect(w.versions.get(G)).toBe(3);
    w.putCache(fieldRow({ id: G, parent_id: P, version: 2 }));
    expect(w.versions.get(G)).toBe(3);
  });
});

describe("DA11-02: what an edit stores in the header, and refusals that write nothing", () => {
  /** A queued create carrying a defaults review block and context, as a "Use my defaults" save never fetched would. */
  function reviewedCreate() {
    const w = peopleWorld({ online: false });
    w.setCache([person({ id: P })]);
    const command = { command: { kind: "put_field", id: G, label: "Pet" } };
    w.setDrafts([
      draftRow({
        local_id: "create",
        endpoint: "/task-commands",
        command,
        kind: "put_field",
        target_resource_ids: [G],
        index_targets: [G],
        bases: { [G]: 1 },
        defaults_revision: "rev-1",
        defaults_context: { kinds: ["field"] },
        review_block: { kind: "defaults", kinds: ["field"] },
        created_seq: 3,
      }),
    ]);
    return { w, outbox: outboxOf(w) };
  }
  const createEdit = (
    label: string,
    extra: Record<string, unknown> = {},
  ): EnqueueRequest => ({
    endpoint: "/task-commands",
    targets: [
      {
        resourceId: G,
        role: "primary",
        basis: "resource",
        versionChecked: false,
        seedIfUntracked: 1,
      },
    ],
    build: () => ({
      command: { command: { kind: "put_field", id: G, label } },
      ...extra,
    }),
  });

  test("a content edit keeps the review block, revision and context; [] clears the block; a list replaces it, once each", async () => {
    const { w, outbox } = reviewedCreate();
    await outbox.editQueued("create", createEdit("Cat"));
    expect(w.drafts[0]).toMatchObject({
      defaults_revision: "rev-1",
      defaults_context: { kinds: ["field"] },
      review_block: { kind: "defaults", kinds: ["field"] },
      command: { command: { kind: "put_field", id: G, label: "Cat" } },
    });
    await outbox.editQueued(
      "create",
      createEdit("Cat", { defaultsReview: [] }),
    );
    expect(w.drafts[0]?.review_block).toBeNull();
    await outbox.editQueued(
      "create",
      createEdit("Cat", { defaultsReview: ["field", "person", "field"] }),
    );
    expect(w.drafts[0]?.review_block).toEqual({
      kind: "defaults",
      kinds: ["field", "person"],
    });
    expect(w.drafts[0]?.command_digest).toBe(
      digestOf({ command: { kind: "put_field", id: G, label: "Cat" } }),
    );
  });

  test("each refusal writes nothing: gone, sent, retargeted, changed, no base, scripted", async () => {
    const { w, draft, outbox } = queuedUpdate();
    const before = stateOf(w);
    expect(await outbox.editQueued("missing", update("x"))).toEqual({
      kind: "refused",
      reason: "not_found",
    });
    expect(
      await outbox.editQueued("queued", {
        ...update("x"),
        endpoint: "/commands",
      }),
    ).toEqual({ kind: "refused", reason: "retargeted" });
    expect(
      await outbox.editQueued("queued", update("x", "another digest")),
    ).toEqual({ kind: "refused", reason: "draft_changed" });
    w.outcomes.push({ kind: "refused", reason: "quota" });
    expect(
      await outbox.editQueued("queued", update("x", draft.command_digest)),
    ).toEqual({ kind: "refused", reason: "quota" });
    expect(stateOf(w)).toEqual(before);
    // No base: a checked target nothing caches or tracks.
    expect(
      await outbox.enqueue(archiveRequest({ id: G, archived: true })),
    ).toEqual({ kind: "refused", reason: "no_base" });
    expect(stateOf(w)).toEqual(before);
    // Sent: the body is frozen once it leaves `queued`.
    w.setDrafts([{ ...draft, status: "in_flight" }]);
    const sent = stateOf(w);
    expect(
      await outbox.editQueued("queued", update("x", draft.command_digest)),
    ).toEqual({ kind: "refused", reason: "not_queued" });
    expect(stateOf(w)).toEqual(sent);
  });

  test("a build that throws, or is not JSON, rejects with a TypeError (as the facade does) and writes nothing", async () => {
    const { w, draft, outbox } = queuedUpdate();
    const before = stateOf(w);
    const throwing: EnqueueRequest = {
      ...update("x", draft.command_digest),
      build: () => {
        throw new Error("builder defect");
      },
    };
    await expect(outbox.editQueued("queued", throwing)).rejects.toThrow(
      TypeError,
    );
    await expect(outbox.enqueue(throwing)).rejects.toThrow(TypeError);
    const notJson: EnqueueRequest = {
      ...update("x", draft.command_digest),
      build: () => ({
        command: { value: new Map() as unknown as JsonObject },
      }),
    };
    await expect(outbox.editQueued("queued", notJson)).rejects.toThrow(
      TypeError,
    );
    await expect(outbox.enqueue(notJson)).rejects.toThrow(TypeError);
    expect(stateOf(w)).toEqual(before);
  });

  test("an invalid request is refused at the boundary (OutboxRequestError) and writes nothing", async () => {
    const { w, outbox } = queuedUpdate();
    const before = stateOf(w);
    const twice: EnqueueRequest = {
      ...update("x"),
      targets: [...update("x").targets, ...update("x").targets],
    };
    await expect(outbox.enqueue(twice)).rejects.toThrow(OutboxRequestError);
    await expect(outbox.editQueued("queued", twice)).rejects.toThrow(
      OutboxRequestError,
    );
    expect(stateOf(w)).toEqual(before);
  });

  test("the request is read once, at the boundary: a caller that alters it afterwards changes nothing stored", async () => {
    const w = peopleWorld({ online: false });
    w.setCache([
      person({ id: P }),
      fieldRow({ id: F, parent_id: P, version: 4, policy_version: 1 }),
    ]);
    const request = { ...update("kept") } as {
      -readonly [K in keyof EnqueueRequest]: EnqueueRequest[K];
    };
    const pending = outboxOf(w).enqueue(request);
    request.endpoint = "/commands";
    await pending;
    expect(w.drafts[0]?.endpoint).toBe("/task-commands");
  });
});

describe("DA11-03: the reviewed body is judged at the write, after whatever committed in between", () => {
  test("field: A reviews dA; B is written through the outbox; A then refuses and adds no draft. Control: A alone is written", async () => {
    const { w, draft, outbox } = queuedUpdate();
    const a = update("A", draft.command_digest);
    expect(
      await outbox.editQueued("queued", update("B", draft.command_digest)),
    ).toMatchObject({ kind: "edited" });
    const afterB = stateOf(w);
    expect(await outbox.editQueued("queued", a)).toEqual({
      kind: "refused",
      reason: "draft_changed",
    });
    expect(stateOf(w)).toEqual(afterB);
    expect(w.drafts[0]?.command).toEqual(updateBody(1, "B"));

    const control = queuedUpdate();
    expect(
      await control.outbox.editQueued(
        "queued",
        update("A", control.draft.command_digest),
      ),
    ).toMatchObject({ kind: "edited" });
    expect(control.w.drafts[0]?.command).toEqual(updateBody(1, "A"));
  });

  test("rename: the same, on the person's own stored base", async () => {
    const w = peopleWorld({ online: false });
    w.setCache([person({ id: P, version: 3, policy_version: 2 })]);
    const outbox = outboxOf(w);
    await outbox.enqueue(
      renameEditRequest({ personId: P, name: "First", policyVersion: 2 }),
    );
    const queued = w.drafts[0] as DraftWithCommand;
    const rename = (name: string, reviewed: string): EnqueueRequest => ({
      ...renameEditRequest({ personId: P, name, policyVersion: 2 }),
      expectDraft: (d) => d.command_digest === reviewed,
    });
    const body = (name: string) => ({
      commands: [
        {
          kind: "edit",
          id: P,
          expected_version: 3,
          expected_policy_version: 2,
          label: name,
          value: "",
        },
      ],
    });
    await outbox.editQueued(
      queued.local_id,
      rename("Second", queued.command_digest),
    );
    expect(w.drafts[0]?.command).toEqual(body("Second"));
    expect(w.drafts[0]?.command_digest).toBe(digestOf(body("Second")));
    expect(
      await outbox.editQueued(
        queued.local_id,
        rename("Stale", queued.command_digest),
      ),
    ).toEqual({ kind: "refused", reason: "draft_changed" });
    expect(w.drafts[0]?.command).toEqual(body("Second"));
    expect(w.versions.get(P)).toBe(4);
  });
});

describe("DA11-04: a supersession is the real transition, not a logged call", () => {
  function conflicted() {
    const w = peopleWorld({ online: false });
    w.setCache([
      person({ id: P }),
      fieldRow({ id: F, parent_id: P, version: 9, policy_version: 1 }),
    ]);
    const old = draftRow({
      local_id: "old",
      endpoint: "/task-commands",
      command: updateBody(8, "conflicted"),
      kind: "put_field",
      status: "version_conflict",
      target_resource_ids: [F],
      index_targets: [F],
      bases: { [F]: 8 },
      bumped: [F],
      expected_version: 8,
      created_seq: 5,
    });
    const dependant = draftRow({
      local_id: "after",
      endpoint: "/task-commands",
      command: {
        command: {
          kind: "archive",
          id: G,
          expected_version: 1,
          archived: true,
        },
      },
      target_resource_ids: [G],
      index_targets: [G],
      depends_on: ["old"],
      created_seq: 6,
    });
    w.setDrafts([old, dependant]);
    w.versions.set(F, 9);
    return { w, old, outbox: outboxOf(w) };
  }

  test("the old draft leaves, the replacement is built on the current base with its own digest, its dependant is retargeted and paused", async () => {
    const { w, old, outbox } = conflicted();
    const out = await outbox.supersede(
      "old",
      update("mine", old.command_digest),
    );
    expect(out).toMatchObject({ kind: "superseded", paused: ["after"] });
    const id = (out as { localId: string }).localId;
    expect(w.drafts.map((d) => d.local_id).sort()).toEqual(
      ["after", id].sort(),
    );
    const replacement = w.drafts.find(
      (d) => d.local_id === id,
    ) as DraftWithCommand;
    expect(replacement.command).toEqual(updateBody(9, "mine"));
    expect(replacement.command_digest).toBe(digestOf(updateBody(9, "mine")));
    expect(replacement).toMatchObject({ status: "queued", bases: { [F]: 9 } });
    expect(w.drafts.find((d) => d.local_id === "after")).toMatchObject({
      depends_on: [id],
      status: "version_conflict",
      last_error: { stage: "dependency_superseded" },
    });
    expect(w.versions.get(F)).toBe(10);
    expect(w.built.map((b) => [b.op, b.target])).toEqual([
      ["supersede", "old"],
    ]);
  });

  test("a stale reviewed body, or a draft that is not in conflict, is refused and nothing moves", async () => {
    const { w, outbox } = conflicted();
    const before = stateOf(w);
    expect(await outbox.supersede("old", update("mine", "stale"))).toEqual({
      kind: "refused",
      reason: "draft_changed",
    });
    expect(await outbox.supersede("after", update("mine"))).toEqual({
      kind: "refused",
      reason: "not_supersedable",
    });
    expect(stateOf(w)).toEqual(before);
  });

  test("a conflict the inbox lists is superseded out of the inbox", async () => {
    const w = peopleWorld({ online: false });
    w.setCache([
      person({ id: P }),
      fieldRow({ id: F, parent_id: P, version: 9, policy_version: 1 }),
    ]);
    const old = draftRow({
      local_id: "c",
      endpoint: "/task-commands",
      command: updateBody(8, "conflicted"),
      kind: "put_field",
      status: "version_conflict",
      target_resource_ids: [F],
      index_targets: [F],
      bases: { [F]: 8 },
      bumped: [F],
    });
    w.env.setDrafts([old]);
    const out = await outboxOf(w).supersede(
      "c",
      update("mine", old.command_digest),
    );
    expect(out).toMatchObject({ kind: "superseded", paused: [] });
    const inbox = w.env.conflicts.get();
    expect(inbox.status === "ready" ? inbox.value.rows : null).toEqual([]);
    expect(w.drafts.map((d) => d.command)).toEqual([updateBody(9, "mine")]);
  });
});
