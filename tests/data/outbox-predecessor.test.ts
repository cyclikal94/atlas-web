// @vitest-environment node
import { describe, expect, test } from "vitest";
import { captureDefaults } from "../../src/data";
import { createQuotaGuard } from "../../src/data/engine/quota-guard";
import {
  type EnqueueRequest,
  type ExpectedPredecessor,
  OutboxRequestError,
  onlyDefaultsRevisionChanged,
  planEdit,
  predecessorStands,
  snapshotRequest,
  type TargetSpec,
  validateRequestFor,
} from "../../src/data/model/outbox";
import { reviewedOf } from "../../src/data/model/review-confirmation";
import { initialSyncState } from "../../src/data/model/sync-state";
import type { DraftRow } from "../../src/data/model/types";
import { createOutbox, type Outbox } from "../../src/data/outbox/outbox";
import { markInFlight, unclaimDraft } from "../../src/data/plans/outbox";
import {
  baseGuard,
  putFieldUpdateRequest,
  renameEditRequest,
} from "../../src/features/people/model/commands";
import {
  followsOf,
  reviewedDraft,
  snapshotOf,
} from "../../src/features/people/model/snapshot";
import { outboxWorld } from "../support/data/outbox-world";
import { cacheRow, draftRow } from "../support/data/rows";
import { record, revision, snapshot } from "../support/data/sharing";

/**
 * WEB-11a review 12, R12.1 (family `people-edit-baseline-rebinding`), and the reverse schedule of its design assessment (DA12-02/03/04/07).
 * A new draft that follows a save the person reviewed names that save (`expectPredecessor`); an edit in place of a save asks that it is still
 * the newest of its target (`expectLatest`). Both are judged inside the writing transaction. Pure tables first (literal expected decisions),
 * then the public outbox facade over the production plans and the IndexedDB double, with the competing writes made through public
 * operations (`editQueued`, `enqueue`, `confirmDefaultsReview`) and the real claim/unclaim plans, and gates exactly where the admission
 * waits (the quota estimate) or where the store transaction begins. FIXTURE evidence: controlled delays over the IndexedDB double, not two
 * native pages, a real quota wait or a backend.
 */

const P = "55555555-5555-4555-8555-555555555555";
const F = "66666666-6666-4666-8666-666666666666";
type World = Awaited<ReturnType<typeof outboxWorld>>;

const draftOf = (w: World, localId: string): DraftRow => {
  const found = w.drafts().find((d) => d.local_id === localId);
  if (found === undefined) throw new Error(`no draft ${localId}`);
  return found;
};
const recordOf = (w: World, id: string) =>
  w.versions().find((row) => row.resource_id === id)?.locally_assumed_version;

/** The people requests of both callers: a field update and an unlinked rename, both version-checked on `id`. */
const KINDS = {
  field: {
    id: F,
    row: () =>
      cacheRow({ id: F, kind: "field", version: 4, policy_version: 6 }),
    request: (text: string, guard?: ReturnType<typeof baseGuard>) =>
      putFieldUpdateRequest({
        fieldId: F,
        personId: P,
        label: "Note",
        value: { kind: "text", text },
        policyVersion: 6,
        sameKind: true,
        guard,
      }),
  },
  rename: {
    id: P,
    row: () =>
      cacheRow({ id: P, kind: "person", version: 4, policy_version: 6 }),
    request: (text: string, guard?: ReturnType<typeof baseGuard>) =>
      renameEditRequest({ personId: P, name: text, policyVersion: 6, guard }),
  },
} as const;

/** A second page's outbox whose writes wait at `at` until `release`: the quota estimate, or the start of the named store plan. */
function delayedPage(
  w: World,
  at: { quota: true } | { plan: "data.enqueueDraft" | "data.editQueuedDraft" },
) {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered = 0;
  const service =
    "plan" in at
      ? new Proxy(w.service, {
          get(target, key) {
            if (key !== "store") return Reflect.get(target, key, target);
            return new Proxy(target.store, {
              get(store, member) {
                if (member !== "run") return Reflect.get(store, member, store);
                return async (plan: { name: string }, ...rest: unknown[]) => {
                  if (plan.name === at.plan) {
                    entered += 1;
                    await gate;
                  }
                  return (store.run as (...a: unknown[]) => unknown)(
                    plan,
                    ...rest,
                  );
                };
              },
            });
          },
        })
      : w.service;
  const outbox: Outbox = createOutbox({
    service,
    quota: createQuotaGuard({
      storage: {
        estimate: async () => {
          if ("quota" in at) {
            entered += 1;
            await gate;
          }
          return { usage: 0, quota: 1e9 };
        },
      },
      now: () => 0,
    }),
    ids: { uuid: () => crypto.randomUUID() },
    clock: { now: () => 0, iso: () => new Date(0).toISOString() },
    fence: () => ({ hasPendingOperation: false, sessionStarted: true }),
  });
  return { outbox, release, entered: () => entered };
}

const until = async (condition: () => boolean) => {
  for (let i = 0; i < 1000 && !condition(); i += 1)
    await new Promise((resolve) => setTimeout(resolve, 0));
  if (!condition()) throw new Error("the delayed write never began");
};

/** L, the reviewed save: body A at stored base 4 (the resource's record is then 5), and the snapshot an editor opened on it with. */
async function seeded(kind: keyof typeof KINDS) {
  const k = KINDS[kind];
  const w = await outboxWorld();
  const row = k.row();
  w.put("cache", [row]);
  const first = await w.outbox.enqueue({ ...k.request("A"), localId: "L" });
  expect(first.kind).toBe("queued");
  const read = [{ ...draftOf(w, "L"), command: w.commandOf("L") as never }];
  const opened = snapshotOf(row, read, "L");
  expect(opened.expectedBase).toBe(5);
  expect(recordOf(w, k.id)).toBe(5);
  return { w, k, opened };
}

const claim = async (w: World) => {
  const claimed = await w.service.commit(markInFlight, {
    captured: w.capture(),
    localId: "L",
  });
  if (claimed.kind !== "applied" || claimed.value.kind !== "claimed")
    throw new Error("claim setup");
  return claimed.value;
};

// ---- DA12-02: the predicate, as a literal table ------------------------------------------------------------------------------------
describe("DA12-02: predecessorStands (pure, literal expected decisions)", () => {
  const expected: ExpectedPredecessor = {
    resourceId: "r",
    localId: "L",
    digest: "d-A",
  };
  const stored = (over: Partial<DraftRow> = {}): DraftRow =>
    draftRow({
      local_id: "L",
      command_digest: "d-A",
      target_resource_ids: ["r"],
      index_targets: ["r"],
      bumped: ["r"],
      bases: { r: 4 },
      status: "queued",
      ...over,
    });
  const rows: Array<[string, DraftRow | undefined, number, string[], boolean]> =
    [
      ["queued, same body, base 4 → 5, waited on", stored(), 5, ["L"], true],
      [
        "in flight (claimed), same body",
        stored({ status: "in_flight" }),
        5,
        ["L"],
        true,
      ],
      [
        "blocked for the defaults review, same body",
        stored({ status: "blocked" }),
        5,
        ["L"],
        true,
      ],
      [
        "acknowledged, same body (final), not waited on",
        stored({ status: "acknowledged" }),
        5,
        [],
        true,
      ],
      [
        "another body (an edit in place)",
        stored({ command_digest: "d-B" }),
        5,
        ["L"],
        false,
      ],
      ["not stored (discarded, released)", undefined, 5, [], false],
      ["another id under the key", stored({ local_id: "M" }), 5, ["L"], false],
      [
        "does not name the resource",
        stored({ target_resource_ids: ["s"], index_targets: ["s"] }),
        5,
        ["L"],
        false,
      ],
      [
        "did not raise it",
        stored({ bumped: [], bases: { r: 4 } }),
        5,
        ["L"],
        false,
      ],
      ["no recorded base", stored({ bases: {} }), 5, ["L"], false],
      [
        "another save came between (base resolved 6)",
        stored(),
        6,
        ["M"],
        false,
      ],
      ["a published version moved the base", stored(), 7, ["L"], false],
      ["rejected", stored({ status: "rejected" }), 5, [], false],
      ["superseded", stored({ status: "superseded" }), 5, [], false],
      [
        "unsettled but not what the new draft waits on",
        stored(),
        5,
        ["M"],
        false,
      ],
    ];
  for (const [name, row, base, dependsOn, stands] of rows)
    test(`${name}: ${stands ? "stands" : "refused"}`, () => {
      expect(predecessorStands(expected, row, { r: base }, dependsOn)).toBe(
        stands,
      );
    });
});

describe("DA12-02: the request boundary", () => {
  const target: TargetSpec = {
    resourceId: "r",
    role: "primary",
    basis: "resource",
    versionChecked: true,
  };
  const request = (over: Partial<EnqueueRequest> = {}): EnqueueRequest => ({
    endpoint: "/task-commands",
    targets: [target],
    build: () => ({ command: { command: { kind: "x" } } }),
    ...over,
  });
  const named = { resourceId: "r", localId: "L", digest: "d" };
  test("a predecessor of a version-checked primary target of this request is accepted on an enqueue only", () => {
    expect(() =>
      validateRequestFor(request({ expectPredecessor: named }), "enqueue"),
    ).not.toThrow();
    for (const op of ["edit", "supersede"] as const)
      expect(() =>
        validateRequestFor(request({ expectPredecessor: named }), op),
      ).toThrow(OutboxRequestError);
  });
  test("one of another resource, an unversioned target or an empty identity is refused (it would check the wrong row)", () => {
    for (const bad of [
      { ...named, resourceId: "s" },
      { ...named, localId: "" },
      { ...named, digest: "" },
    ])
      expect(() =>
        validateRequestFor(request({ expectPredecessor: bad }), "enqueue"),
      ).toThrow(OutboxRequestError);
    expect(() =>
      validateRequestFor(
        request({
          targets: [{ ...target, versionChecked: false }],
          expectPredecessor: named,
        }),
        "enqueue",
      ),
    ).toThrow(OutboxRequestError);
  });
  test("the newest-save rule is accepted on an edit only", () => {
    expect(() =>
      validateRequestFor(request({ expectLatest: true }), "edit"),
    ).not.toThrow();
    for (const op of ["enqueue", "supersede"] as const)
      expect(() =>
        validateRequestFor(request({ expectLatest: true }), op),
      ).toThrow(OutboxRequestError);
  });
  test("the boundary copies the predecessor: the caller changing it later changes nothing", () => {
    const given = { ...named };
    const copy = snapshotRequest(request({ expectPredecessor: given }));
    given.digest = "changed";
    given.localId = "M";
    expect(copy.expectPredecessor).toEqual(named);
  });
});

describe("DA12-07: planEdit's newest-save rule (pure)", () => {
  const sync = initialSyncState("inc");
  const L = draftRow({
    local_id: "L",
    status: "queued",
    created_seq: 1,
    endpoint: "/task-commands",
    target_resource_ids: ["r"],
    index_targets: ["r"],
    bumped: ["r"],
    bases: { r: 4 },
  });
  const body = (text: string, rev?: string) => ({
    command: { kind: "put_field", id: "r", text },
    ...(rev === undefined ? {} : { defaults_revision: rev }),
  });
  const edit = (text: string, rev?: string, latest = true): EnqueueRequest => ({
    endpoint: "/task-commands",
    targets: [
      {
        resourceId: "r",
        role: "primary",
        basis: "resource",
        versionChecked: true,
      },
    ],
    build: () => ({ command: body(text, rev) }),
    ...(latest ? { expectLatest: true } : {}),
  });
  const later = (over: Partial<DraftRow> = {}) =>
    draftRow({
      local_id: "C",
      status: "queued",
      created_seq: 2,
      index_targets: ["r"],
      target_resource_ids: ["r"],
      ...over,
    });
  const stored = body("A", "rev-1");
  const cases: Array<[string, EnqueueRequest, DraftRow[], string]> = [
    ["no later save", edit("B"), [], "edited"],
    ["a later save of the same target", edit("B"), [later()], "not_latest"],
    [
      "a later save of an unrelated target",
      edit("B"),
      [later({ index_targets: ["s"], target_resource_ids: ["s"] })],
      "edited",
    ],
    [
      "a later save that is settled",
      edit("B"),
      [later({ status: "acknowledged" })],
      "edited",
    ],
    [
      "an older save of the target",
      edit("B"),
      [later({ created_seq: 0 })],
      "edited",
    ],
    [
      "a later save, the audience's revision only (confirmation)",
      edit("A", "rev-2"),
      [later()],
      "edited",
    ],
    [
      "a later save, the content AND the revision",
      edit("B", "rev-2"),
      [later()],
      "not_latest",
    ],
    [
      "a later save, without the rule (other callers unchanged)",
      edit("B", undefined, false),
      [later()],
      "edited",
    ],
  ];
  for (const [name, request, others, kind] of cases)
    test(`${name}: ${kind}`, () => {
      const planned = planEdit(request, L, sync, undefined, undefined, {
        later: others,
        command: stored,
      });
      expect(planned.kind === "refused" ? planned.reason : planned.kind).toBe(
        kind,
      );
    });
  test("facts that were not read, or a body that could not be read, are never taken as 'no later save'", () => {
    expect(planEdit(edit("B"), L, sync)).toEqual({
      kind: "refused",
      reason: "not_latest",
    });
    expect(
      planEdit(edit("A", "rev-2"), L, sync, undefined, undefined, {
        later: [later()],
        command: undefined,
      }),
    ).toEqual({ kind: "refused", reason: "not_latest" });
  });
  test("onlyDefaultsRevisionChanged compares everything but the top-level revision", () => {
    expect(onlyDefaultsRevisionChanged(body("A", "1"), body("A", "2"))).toBe(
      true,
    );
    expect(onlyDefaultsRevisionChanged(body("A"), body("A", "2"))).toBe(true);
    expect(onlyDefaultsRevisionChanged(body("A", "1"), body("B", "1"))).toBe(
      false,
    );
  });
});

// ---- DA12-03 / DA12-04: the R12.1 schedule and its controls over the production facade ------------------------------------------
for (const kind of ["field", "rename"] as const)
  describe(`R12.1 (${kind}): the successor is judged in its writing transaction`, () => {
    for (const at of [
      { quota: true } as const,
      { plan: "data.enqueueDraft" } as const,
    ])
      for (const peer of ["changed", "identical", "none"] as const)
        test(`first claim, non-send rollback while the save waits at ${"quota" in at ? "the quota estimate" : "the transaction's start"}; peer edit: ${peer}`, async () => {
          const { w, k, opened } = await seeded(kind);
          const claimed = await claim(w);
          expect(claimed.flipped).toBe(true);
          const page = delayedPage(w, at);
          const saving = page.outbox.enqueue({
            ...k.request("C", baseGuard(opened.expectedBase)),
            ...followsOf(opened, k.id),
          });
          await until(() => page.entered() > 0);
          // The dispatcher's definite non-send: the first claim returns to queued.
          const unclaimed = await w.service.store.run(unclaimDraft, {
            incarnationId: w.service.incarnationId,
            localId: "L",
            flipped: claimed.flipped,
            created: claimed.created,
          });
          expect(unclaimed.kind).toBe("unclaimed");
          expect(draftOf(w, "L").status).toBe("queued");
          if (peer !== "none") {
            const edited = await w.outbox.editQueued("L", {
              ...k.request(peer === "changed" ? "B" : "A"),
              expectDraft: reviewedDraft(opened),
            });
            expect(edited.kind).toBe("edited");
            expect(draftOf(w, "L").command_digest === opened.latestDigest).toBe(
              peer === "identical",
            );
          }
          expect(recordOf(w, k.id)).toBe(5);
          const seqBefore = w.sync().draft_seq;
          page.release();
          const outcome = await saving;
          if (peer === "changed") {
            expect(outcome).toEqual({
              kind: "refused",
              reason: "predecessor_changed",
            });
            // Nothing written: no draft, no body, no record raised, no counter used.
            expect(w.drafts().map((d) => d.local_id)).toEqual(["L"]);
            expect(recordOf(w, k.id)).toBe(5);
            expect(w.sync().draft_seq).toBe(seqBefore);
            w.assertNoOrphanBodies();
          } else {
            expect(outcome.kind).toBe("queued");
            const added = w.drafts().find((d) => d.local_id !== "L");
            expect(added?.bases[k.id]).toBe(5);
            expect(added?.depends_on).toEqual(["L"]);
            expect(recordOf(w, k.id)).toBe(6);
          }
        });

    test("edit first: the body changed before the save began (the page's read was older) is refused", async () => {
      const { w, k, opened } = await seeded(kind);
      expect(
        (
          await w.outbox.editQueued("L", {
            ...k.request("B"),
            expectDraft: reviewedDraft(opened),
          })
        ).kind,
      ).toBe("edited");
      expect(
        await w.outbox.enqueue({
          ...k.request("C", baseGuard(opened.expectedBase)),
          ...followsOf(opened, k.id),
        }),
      ).toEqual({ kind: "refused", reason: "predecessor_changed" });
      expect(w.drafts()).toHaveLength(1);
    });

    test("a genuinely frozen retry (a second claim, flipped=false) stays in flight: an edit is refused and the successor follows", async () => {
      const { w, k, opened } = await seeded(kind);
      expect((await claim(w)).flipped).toBe(true);
      const retry = await claim(w);
      expect(retry.flipped).toBe(false);
      const kept = await w.service.store.run(unclaimDraft, {
        incarnationId: w.service.incarnationId,
        localId: "L",
        flipped: retry.flipped,
        created: retry.created,
      });
      expect(kept.kind).not.toBe("unclaimed");
      expect(draftOf(w, "L").status).toBe("in_flight");
      expect(
        await w.outbox.editQueued("L", {
          ...k.request("B"),
          expectDraft: reviewedDraft(opened),
        }),
      ).toEqual({ kind: "refused", reason: "not_queued" });
      const outcome = await w.outbox.enqueue({
        ...k.request("C", baseGuard(opened.expectedBase)),
        ...followsOf(opened, k.id),
      });
      expect(outcome.kind).toBe("queued");
    });

    test("a competing save of the same item while this one waits: refused, only the competitor is added", async () => {
      const { w, k, opened } = await seeded(kind);
      const page = delayedPage(w, { plan: "data.enqueueDraft" });
      const saving = page.outbox.enqueue({
        ...k.request("C", baseGuard(opened.expectedBase)),
        ...followsOf(opened, k.id),
      });
      await until(() => page.entered() > 0);
      expect(
        (await w.outbox.enqueue({ ...k.request("M"), localId: "M" })).kind,
      ).toBe("queued");
      page.release();
      // An assertion, not a rejection (MU-2682, MU-2683; WEB-11a revision 18).
      await expect(saving).resolves.toMatchObject({ kind: "refused" });
      expect(w.drafts().map((d) => d.local_id)).toEqual(["L", "M"]);
    });

    test("a save of an UNRELATED item meanwhile changes nothing: the successor follows (positive control)", async () => {
      const { w, k, opened } = await seeded(kind);
      w.put("cache", [cacheRow({ id: "other", kind: "field", version: 2 })]);
      const page = delayedPage(w, { plan: "data.enqueueDraft" });
      const saving = page.outbox.enqueue({
        ...k.request("C", baseGuard(opened.expectedBase)),
        ...followsOf(opened, k.id),
      });
      await until(() => page.entered() > 0);
      expect(
        (
          await w.outbox.enqueue({
            ...putFieldUpdateRequest({
              fieldId: "other",
              personId: P,
              label: "x",
              value: { kind: "text", text: "x" },
              policyVersion: 1,
              sameKind: true,
            }),
          })
        ).kind,
      ).toBe("queued");
      page.release();
      expect((await saving).kind).toBe("queued");
    });

    test("a discarded predecessor is refused (a missing save is never taken as unchanged)", async () => {
      const { w, k, opened } = await seeded(kind);
      expect((await w.outbox.discard("L")).kind).toBe("discarded");
      // An assertion, not a rejection (MU-2682, MU-2683; WEB-11a revision 18).
      await expect(
        w.outbox.enqueue({
          ...k.request("C", baseGuard(opened.expectedBase)),
          ...followsOf(opened, k.id),
        }),
      ).resolves.toEqual({ kind: "refused", reason: "predecessor_changed" });
    });

    test("a retry of a save that was already made is recognised first (its predecessor changed since)", async () => {
      const { w, k, opened } = await seeded(kind);
      const request = {
        ...k.request("C", baseGuard(opened.expectedBase)),
        ...followsOf(opened, k.id),
        localId: "S",
      };
      expect((await w.outbox.enqueue(request)).kind).toBe("queued");
      const queued = await w.outbox.enqueue({
        ...k.request("C", baseGuard(opened.expectedBase)),
        ...followsOf(opened, k.id),
        localId: "S",
      });
      expect(queued.kind).toBe("queued");
      expect(w.drafts()).toHaveLength(2);
    });
  });

// ---- DA12-07: the reverse schedule, both orders -------------------------------------------------------------------------------------
for (const kind of ["field", "rename"] as const)
  describe(`reverse schedule (${kind}): an older edit in place never changes a save a later one was built over`, () => {
    test("successor first: the later save commits, then the delayed edit of L is refused not_latest and L keeps A", async () => {
      const { w, k, opened } = await seeded(kind);
      const page = delayedPage(w, { plan: "data.editQueuedDraft" });
      const editing = page.outbox.editQueued("L", {
        ...k.request("B"),
        expectDraft: reviewedDraft(opened),
        expectLatest: true,
      });
      await until(() => page.entered() > 0);
      expect(
        (
          await w.outbox.enqueue({
            ...k.request("C", baseGuard(opened.expectedBase)),
            ...followsOf(opened, k.id),
          })
        ).kind,
      ).toBe("queued");
      page.release();
      expect(await editing).toEqual({ kind: "refused", reason: "not_latest" });
      expect(draftOf(w, "L").command_digest).toBe(opened.latestDigest);
    });

    test("edit first: L becomes B, then the later save built over A is refused predecessor_changed", async () => {
      const { w, k, opened } = await seeded(kind);
      const page = delayedPage(w, { plan: "data.enqueueDraft" });
      const saving = page.outbox.enqueue({
        ...k.request("C", baseGuard(opened.expectedBase)),
        ...followsOf(opened, k.id),
      });
      await until(() => page.entered() > 0);
      expect(
        (
          await w.outbox.editQueued("L", {
            ...k.request("B"),
            expectDraft: reviewedDraft(opened),
            expectLatest: true,
          })
        ).kind,
      ).toBe("edited");
      page.release();
      expect(await saving).toEqual({
        kind: "refused",
        reason: "predecessor_changed",
      });
      expect(w.drafts()).toHaveLength(1);
    });

    test("control: with no later save the edit in place is written; a later save of ANOTHER item does not block it", async () => {
      const { w, k, opened } = await seeded(kind);
      w.put("cache", [cacheRow({ id: "other", kind: "field", version: 2 })]);
      expect(
        (
          await w.outbox.enqueue(
            putFieldUpdateRequest({
              fieldId: "other",
              personId: P,
              label: "x",
              value: { kind: "text", text: "x" },
              policyVersion: 1,
              sameKind: true,
            }),
          )
        ).kind,
      ).toBe("queued");
      expect(
        (
          await w.outbox.editQueued("L", {
            ...k.request("B"),
            expectDraft: reviewedDraft(opened),
            expectLatest: true,
          })
        ).kind,
      ).toBe("edited");
    });
  });

// ---- the defaults confirmation: metadata only goes on behind a later save; content never does -----------------------------------
describe("defaults confirmation behind a later save of the same target (web11a-chain-latest-only-20261024)", () => {
  const target = (id: string): TargetSpec => ({
    resourceId: id,
    role: "primary",
    basis: "resource",
    versionChecked: false,
    seedIfUntracked: 1,
  });
  const createWith = (name: string): EnqueueRequest => {
    const capture = captureDefaults(null, ["person"]);
    return {
      localId: "L",
      endpoint: "/commands",
      targets: [target("p")],
      build: () => ({
        command: {
          commands: [{ kind: "create_person", id: "p", name }],
          ...(capture.defaultsRevision === null
            ? {}
            : { defaults_revision: capture.defaultsRevision }),
        },
        defaultsRevision: capture.defaultsRevision,
        defaultsContext: capture.defaultsContext,
        defaultsReview: capture.defaultsReview,
      }),
    };
  };
  async function blockedWithSuccessor() {
    const w = await outboxWorld();
    expect((await w.outbox.enqueue(createWith("Ada"))).kind).toBe("queued");
    expect(draftOf(w, "L").review_block).not.toBeNull();
    const after = await w.outbox.enqueue({
      localId: "C",
      endpoint: "/commands",
      targets: [target("p")],
      build: () => ({ command: { commands: [{ kind: "note", id: "p" }] } }),
    });
    expect(after.kind).toBe("queued");
    expect(draftOf(w, "C").depends_on).toEqual(["L"]);
    return w;
  }
  test("the confirmation (the revision only) is written: the queue held behind the review is not deadlocked", async () => {
    const w = await blockedWithSuccessor();
    const now = captureDefaults(record(snapshot({ revision: revision(7) })), [
      "person",
    ]);
    const out = await w.outbox.confirmDefaultsReview("L", {
      reviewed: reviewedOf(draftOf(w, "L")),
      defaultsRevision: now.defaultsRevision as string,
      defaultsContext: now.defaultsContext,
    });
    expect(out).toMatchObject({ kind: "confirmed", how: "edited" });
    expect(draftOf(w, "L").review_block).toBeNull();
    expect(w.commandOf("L")).toMatchObject({
      commands: [{ name: "Ada" }],
      defaults_revision: revision(7),
    });
  });
  test("a content-changing rebuild under the same rule is refused not_latest, and nothing changes", async () => {
    const w = await blockedWithSuccessor();
    const before = draftOf(w, "L");
    const out = await w.outbox.editQueued("L", {
      ...createWith("Ada Lovelace"),
      localId: undefined,
      expectDraft: (stored) => stored.command_digest === before.command_digest,
      expectLatest: true,
    });
    expect(out).toEqual({ kind: "refused", reason: "not_latest" });
    expect(draftOf(w, "L")).toEqual(before);
  });
});
