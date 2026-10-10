// @vitest-environment node
import { describe, expect, test } from "vitest";
import { digestOf } from "../../src/data/model/canonical";
import { DATA_CONFIG } from "../../src/data/model/config";
import {
  decideSupersede,
  type EnqueueRequest,
  type SupersedeFacts,
} from "../../src/data/model/outbox";
import { initialSyncState } from "../../src/data/model/sync-state";
import type { DraftRow, SyncStateRow } from "../../src/data/model/types";
import { outboxWorld } from "../support/data/outbox-world";
import { cacheRow, draftRow, headerOf } from "../support/data/rows";

/**
 * R24 (revision 12): a replacement must have a FRESH identity.
 *
 * `supersede(old, next)` takes `next.localId` (a documented save/retry input) and the plan wrote the replacement under it and deleted
 * `old`, without asking whether that key already named a draft. With `next.localId === old` the transaction put the replacement and
 * deleted it: neither remained, and the answer was `superseded`. With another draft's key it OVERWROTE that draft's header and body
 * (a queued one, one in flight with a frozen body, one retained after its answer) and removed `old`.
 *
 * The rule: the uniqueness of the key is decided in the SAME transaction, before anything is written; an incompatible collision is
 * refused (`key_in_use`) and neither command, their effects, dependencies nor versions move. A retry of a supersession whose completion
 * was lost (the old row is gone and the draft under the key IS that replacement) is recognised, as an enqueue's retry is, and writes
 * nothing. The production plans, facade and dispatcher over the double of IndexedDB. FIXTURE evidence.
 */
const OLD = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const FRESH = "33333333-3333-4333-8333-333333333333";
const DEP = "44444444-4444-4444-8444-444444444444";
const TARGET = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

const syncRow = (over: Partial<SyncStateRow> = {}): SyncStateRow => ({
  ...initialSyncState("inc"),
  phase: "delta",
  cache_status: "valid",
  ...over,
});

const note = (localId: string, text: string): EnqueueRequest => ({
  localId,
  endpoint: "/commands",
  targets: [],
  build: () => ({ command: { kind: "create", text } }),
});
/** A command that edits `TARGET`, version-checked: two of them are one chain (the second depends on the first). */
const edit = (localId: string, text: string): EnqueueRequest => ({
  localId,
  endpoint: "/commands",
  targets: [
    {
      resourceId: TARGET,
      role: "primary",
      basis: "resource",
      versionChecked: true,
      seedIfUntracked: 1,
    },
  ],
  build: (bases) => ({
    command: {
      kind: "update",
      text,
      expected_version: bases[TARGET] as number,
    },
  }),
});

type World = Awaited<ReturnType<typeof outboxWorld>>;
const STORES = [
  "drafts",
  "draft_commands",
  "pending_effects",
  "resource_versions",
  "sync_state",
] as const;
/** Every store the plan can touch, as it is at rest: refusals must leave all of it byte for byte as it was. */
const everything = (w: World) => {
  const snapshot = w.snapshot() ?? {};
  return Object.fromEntries(STORES.map((name) => [name, snapshot[name]]));
};
const status = (w: World, id: string) =>
  w.drafts().find((draft) => draft.local_id === id)?.status;
const setStatus = (w: World, id: string, next: DraftRow["status"]) =>
  w.put("drafts", [
    {
      ...(w.drafts().find((d) => d.local_id === id) as DraftRow),
      status: next,
    },
  ]);

/** `OLD` in a version conflict, and (where the case wants it) `OTHER` as unrelated work in the given status. */
async function arranged(
  other: DraftRow["status"] | null,
  options: { cache?: boolean } = {},
): Promise<World> {
  const w = await outboxWorld();
  if (options.cache) w.put("cache", [cacheRow({ id: TARGET, version: 5 })]);
  await w.outbox.enqueue(note(OLD, "original"));
  setStatus(w, OLD, "version_conflict");
  if (other !== null) {
    await w.outbox.enqueue(note(OTHER, "precious work"));
    setStatus(w, OTHER, other);
  }
  return w;
}

describe("a replacement's key that already names a draft is refused, and nothing moves", () => {
  const STATUSES: DraftRow["status"][] = [
    "queued",
    "in_flight",
    "acknowledged",
    "rejected",
    "version_conflict",
    "operation_conflict",
    "blocked",
  ];
  for (const other of STATUSES)
    test(`the key of an unrelated draft that is ${other}: refused; both commands, all effects and versions are byte for byte as they were`, async () => {
      const w = await arranged(other);
      const before = everything(w);
      const bodyBefore = w.commandOf(OTHER);
      const out = await w.outbox.supersede(OLD, note(OTHER, "replacement"));
      expect(out).toEqual({ kind: "refused", reason: "key_in_use" });
      expect(everything(w)).toEqual(before);
      expect(w.commandOf(OTHER)).toEqual(bodyBefore);
      expect(status(w, OLD)).toBe("version_conflict");
      expect(status(w, OTHER)).toBe(other);
    });

  test("the key of the old draft itself: refused, the old draft stays (the replacement was put and then deleted before)", async () => {
    const w = await arranged(null);
    const before = everything(w);
    const out = await w.outbox.supersede(OLD, note(OLD, "replacement"));
    expect(out).toEqual({ kind: "refused", reason: "key_in_use" });
    expect(everything(w)).toEqual(before);
    expect(w.commandOf(OLD)).toEqual({ kind: "create", text: "original" });
  });

  test("the key of a DEPENDANT of the old draft: refused, the dependant and its dependency stay as they were", async () => {
    const w = await outboxWorld();
    w.put("cache", [cacheRow({ id: TARGET, version: 5 })]);
    await w.outbox.enqueue(edit(OLD, "first"));
    await w.outbox.enqueue(edit(DEP, "second"));
    setStatus(w, OLD, "version_conflict");
    expect(w.drafts().find((d) => d.local_id === DEP)?.depends_on).toEqual([
      OLD,
    ]);
    const before = everything(w);
    const out = await w.outbox.supersede(OLD, edit(DEP, "replacement"));
    expect(out).toEqual({ kind: "refused", reason: "key_in_use" });
    expect(everything(w)).toEqual(before);
  });

  test("an in-flight command that was SENT keeps its frozen body and its status, whatever key a later supersession asks for (through the public calls alone)", async () => {
    const w = await outboxWorld();
    w.script.push(w.error(409, "conflict"));
    await w.outbox.enqueue(note(OLD, "first"));
    w.start();
    await w.settle();
    expect(status(w, OLD)).toBe("version_conflict");
    let answer!: (response: Response) => void;
    w.script.push(
      () =>
        new Promise<Response>((resolve) => {
          answer = resolve;
        }),
    );
    await w.outbox.enqueue(note(OTHER, "second, sent"));
    await w.settle();
    expect(w.sent).toHaveLength(2);
    expect(status(w, OTHER)).toBe("in_flight");
    const transmitted = w.sent[1]?.body;
    const bodyBefore = w.commandOf(OTHER);
    const idempotencyKey = w.sent[1]?.key;
    const out = await w.outbox.supersede(OLD, note(OTHER, "replacement"));
    expect(out).toEqual({ kind: "refused", reason: "key_in_use" });
    // Nothing of the sent draft moved while its request is still outstanding.
    expect(w.commandOf(OTHER)).toEqual(bodyBefore);
    expect(status(w, OTHER)).toBe("in_flight");
    expect(status(w, OLD)).toBe("version_conflict");
    answer(w.receipt());
    await w.settle();
    // Its answer is recorded against the body that was transmitted, under the key it was sent with.
    expect(w.sent).toHaveLength(2);
    expect(w.sent[1]?.body).toBe(transmitted);
    expect(w.sent[1]?.key).toBe(idempotencyKey);
    w.dispatcher.stop();
  });

  test("control: a fresh key supersedes (the old draft is gone, the replacement is queued under the new key, unrelated work is untouched)", async () => {
    const w = await arranged("in_flight");
    const bodyBefore = w.commandOf(OTHER);
    const out = await w.outbox.supersede(OLD, note(FRESH, "replacement"));
    expect(out).toEqual({ kind: "superseded", localId: FRESH, paused: [] });
    expect(w.drafts().map((d) => d.local_id)).toEqual(
      expect.arrayContaining([FRESH, OTHER]),
    );
    expect(w.drafts().some((d) => d.local_id === OLD)).toBe(false);
    expect(w.commandOf(FRESH)).toEqual({ kind: "create", text: "replacement" });
    expect(w.commandOf(OLD)).toBeUndefined();
    expect(w.commandOf(OTHER)).toEqual(bodyBefore);
    expect(status(w, OTHER)).toBe("in_flight");
  });

  test("control: a key that no draft has ever had, with the dispatcher running, supersedes and the replacement is sent", async () => {
    const w = await arranged(null);
    const out = await w.outbox.supersede(OLD, note(FRESH, "replacement"));
    expect(out).toMatchObject({ kind: "superseded", localId: FRESH });
    w.start();
    await w.settle();
    expect(w.sent.map((s) => s.key)).toEqual([FRESH]);
    w.dispatcher.stop();
  });

  test("an enqueue under a key that already names a draft never overwrites it (it is the documented retry of that very save)", async () => {
    const w = await arranged("in_flight");
    const before = everything(w);
    const out = await w.outbox.enqueue(note(OTHER, "a different command"));
    expect(out).toMatchObject({ kind: "queued", localId: OTHER });
    expect(everything(w)).toEqual(before);
    expect(w.commandOf(OTHER)).toEqual({
      kind: "create",
      text: "precious work",
    });
  });
});

describe("a retry of a supersession whose completion was lost is recognised, and writes nothing", () => {
  test("the lost completion is real: it committed, the caller was never told, and the same call again answers `superseded`", async () => {
    const w = await arranged(null);
    const remove = w.env.idb.inject({
      match: (tx) => tx.label === "data.supersedeDraft",
      mode: "commit_then_lose_completion",
      times: 1,
    });
    let answered = false;
    void w.outbox.supersede(OLD, note(FRESH, "replacement")).then(
      () => {
        answered = true;
      },
      () => {
        answered = true;
      },
    );
    await w.settle();
    remove();
    expect(answered).toBe(false);
    expect(w.drafts().map((d) => d.local_id)).toEqual([FRESH]);
    const afterFirst = everything(w);
    const again = await w.outbox.supersede(OLD, note(FRESH, "replacement"));
    expect(again).toEqual({ kind: "superseded", localId: FRESH, paused: [] });
    expect(everything(w)).toEqual(afterFirst);
  });

  test("an ordinary retry after a completed supersession: `superseded` again with the dependants it paused, and not a byte written", async () => {
    const w = await outboxWorld();
    w.put("cache", [cacheRow({ id: TARGET, version: 5 })]);
    await w.outbox.enqueue(edit(OLD, "first"));
    await w.outbox.enqueue(edit(DEP, "second"));
    setStatus(w, OLD, "version_conflict");
    const first = await w.outbox.supersede(OLD, edit(FRESH, "first, again"));
    expect(first).toEqual({
      kind: "superseded",
      localId: FRESH,
      paused: [DEP],
    });
    expect(status(w, DEP)).toBe("version_conflict");
    const afterFirst = everything(w);
    // ADAPTED (revision 13): revision 12 observed "it debited nothing" through the guard's cached free space (a write that lands drops
    // the cache, one that did not leaves it). The guard now judges against a ledger and reports the free space of its last judgement,
    // which a settlement does not erase, so that observable is gone; the same fact is read where it still shows: what the guard leaves
    // for the NEXT save. The first supersession's own debit is allowed to lapse (one estimate lifetime), the free space is pinned, and
    // after the retry the guard must report exactly that free space: a retry that settled as WRITTEN would have left its bytes in the
    // ledger of landed writes and lowered it.
    //
    // ADAPTED AGAIN (revision 18; this test's mutants MU-354 and MU-355 had survived since revision 17, found by the first FULL run of the
    // catalogue since): the first supersession's landed entry is kept one lifetime after its end (revision 17), so a retry that settled as
    // WRITTEN merges its bytes into THAT entry, which keeps the figure the FIRST save was judged on. The pinned free space therefore has to
    // be that same figure (the world's default), or the cap (that figure less the bytes) is larger than the pin and hides the extra debit.
    await w.advance(DATA_CONFIG.quotaEstimateTtlMs + 1);
    const FREE = 500 * 1024 * 1024;
    w.freeBytes = FREE;
    w.quota.invalidate();
    const again = await w.outbox.supersede(OLD, edit(FRESH, "first, again"));
    expect(again).toEqual(first);
    expect(everything(w)).toEqual(afterFirst);
    // It wrote nothing, so it debited nothing.
    await w.quota.check("input", 0);
    expect(w.quota.lastFree()).toBe(FREE);
    // The revision-12 assertion, kept: the guard still reports a free space after the retry.
    expect(w.quota.lastFree()).not.toBeNull();
  });

  test("a retry whose replacement was EDITED since is not the same save: `not_found`, nothing changes", async () => {
    const w = await arranged(null);
    expect(
      await w.outbox.supersede(OLD, note(FRESH, "replacement")),
    ).toMatchObject({ kind: "superseded" });
    expect(
      await w.outbox.editQueued(FRESH, note(FRESH, "edited by the person")),
    ).toEqual({ kind: "edited", localId: FRESH });
    const before = everything(w);
    expect(await w.outbox.supersede(OLD, note(FRESH, "replacement"))).toEqual({
      kind: "refused",
      reason: "not_found",
    });
    expect(everything(w)).toEqual(before);
  });

  test("a DIFFERENT command under that key is somebody else's: `not_found` for the old draft that is gone, nothing changes", async () => {
    const w = await arranged(null);
    expect(
      await w.outbox.supersede(OLD, note(FRESH, "replacement")),
    ).toMatchObject({ kind: "superseded" });
    const before = everything(w);
    expect(
      await w.outbox.supersede(OLD, note(FRESH, "something else entirely")),
    ).toEqual({ kind: "refused", reason: "not_found" });
    expect(everything(w)).toEqual(before);
  });

  test("another endpoint or other targets under the same key: not the same save", async () => {
    const w = await arranged(null);
    await w.outbox.supersede(OLD, note(FRESH, "replacement"));
    const before = everything(w);
    expect(
      await w.outbox.supersede(OLD, {
        ...note(FRESH, "replacement"),
        endpoint: "/other-commands",
      }),
    ).toEqual({ kind: "refused", reason: "not_found" });
    expect(await w.outbox.supersede(OLD, edit(FRESH, "replacement"))).toEqual({
      kind: "refused",
      reason: "not_found",
    });
    expect(everything(w)).toEqual(before);
  });

  test("an old draft that never existed and a key nobody uses: `not_found`, as before", async () => {
    const w = await arranged(null);
    const before = everything(w);
    expect(await w.outbox.supersede(OTHER, note(FRESH, "x"))).toEqual({
      kind: "refused",
      reason: "not_found",
    });
    expect(everything(w)).toEqual(before);
  });

  test("a retry after a reload (a new facade over the same database) is recognised too", async () => {
    const w = await arranged(null);
    await w.outbox.supersede(OLD, note(FRESH, "replacement"));
    const before = everything(w);
    w.reload();
    expect(await w.outbox.supersede(OLD, note(FRESH, "replacement"))).toEqual({
      kind: "superseded",
      localId: FRESH,
      paused: [],
    });
    expect(everything(w)).toEqual(before);
  });
});

describe("concurrent and duplicate replacement attempts", () => {
  test("two different replacements of one old draft: one wins, the other finds nothing to supersede, and only one replacement exists", async () => {
    const w = await arranged(null);
    const [a, b] = await Promise.all([
      w.outbox.supersede(OLD, note(FRESH, "one")),
      w.outbox.supersede(OLD, note(DEP, "two")),
    ]);
    const kinds = [a.kind, b.kind].sort();
    expect(kinds).toEqual(["refused", "superseded"]);
    const loser = a.kind === "refused" ? a : b;
    expect(loser).toEqual({ kind: "refused", reason: "not_found" });
    expect(w.drafts()).toHaveLength(1);
    expect(w.drafts()[0]?.local_id).toBe(a.kind === "superseded" ? FRESH : DEP);
    w.assertNoOrphanBodies();
  });

  test("the same replacement attempted twice at once: both answers are `superseded`, and one replacement and one version increment exist", async () => {
    const w = await outboxWorld();
    w.put("cache", [cacheRow({ id: TARGET, version: 5 })]);
    await w.outbox.enqueue(edit(OLD, "first"));
    setStatus(w, OLD, "version_conflict");
    const reference = await outboxWorld();
    reference.put("cache", [cacheRow({ id: TARGET, version: 5 })]);
    await reference.outbox.enqueue(edit(OLD, "first"));
    setStatus(reference, OLD, "version_conflict");
    await reference.outbox.supersede(OLD, edit(FRESH, "again"));
    const [a, b] = await Promise.all([
      w.outbox.supersede(OLD, edit(FRESH, "again")),
      w.outbox.supersede(OLD, edit(FRESH, "again")),
    ]);
    expect(a).toEqual({ kind: "superseded", localId: FRESH, paused: [] });
    expect(b).toEqual(a);
    expect(w.drafts().map((d) => d.local_id)).toEqual([FRESH]);
    expect(w.versions()).toEqual(reference.versions());
  });

  test("two old drafts asking for one key: one is replaced, the other is refused and stays whole", async () => {
    const w = await arranged("version_conflict");
    const [a, b] = await Promise.all([
      w.outbox.supersede(OLD, note(FRESH, "from old")),
      w.outbox.supersede(OTHER, note(FRESH, "from other")),
    ]);
    const winner = a.kind === "superseded" ? OLD : OTHER;
    const loser = winner === OLD ? OTHER : OLD;
    expect([a.kind, b.kind].sort()).toEqual(["refused", "superseded"]);
    expect(a.kind === "refused" ? a : b).toMatchObject({
      kind: "refused",
      reason: expect.stringMatching(/^(key_in_use|not_found)$/),
    });
    expect(status(w, loser)).toBe("version_conflict");
    expect(w.drafts().some((d) => d.local_id === winner)).toBe(false);
    expect(w.drafts().filter((d) => d.local_id === FRESH)).toHaveLength(1);
    w.assertNoOrphanBodies();
  });

  test("an enqueue and a supersession under the same new key at once: exactly one draft holds the key, whole, and the old draft is gone only if the supersession won", async () => {
    const w = await arranged(null);
    const [queued, superseded] = await Promise.all([
      w.outbox.enqueue(note(FRESH, "by enqueue")),
      w.outbox.supersede(OLD, note(FRESH, "by supersession")),
    ]);
    const body = w.commandOf(FRESH) as { text: string };
    expect(w.drafts().filter((d) => d.local_id === FRESH)).toHaveLength(1);
    if (body.text === "by enqueue") {
      expect(superseded).toEqual({ kind: "refused", reason: "key_in_use" });
      expect(status(w, OLD)).toBe("version_conflict");
    } else {
      expect(body.text).toBe("by supersession");
      expect(superseded).toMatchObject({ kind: "superseded", localId: FRESH });
      expect(w.drafts().some((d) => d.local_id === OLD)).toBe(false);
      expect(queued).toMatchObject({ kind: "queued", localId: FRESH });
    }
    w.assertNoOrphanBodies();
  });
});

// ---- the decision, as a table -------------------------------------------------------------------------------------------------
describe("decideSupersede: the key is judged from the facts the transaction read", () => {
  const old = draftRow({
    local_id: OLD,
    created_seq: 1,
    status: "version_conflict",
  });
  const header = (draft: ReturnType<typeof draftRow>): DraftRow =>
    headerOf(draft);
  const facts = (over: Partial<SupersedeFacts> = {}): SupersedeFacts => ({
    old: header(old),
    existing: undefined,
    existingPaused: [],
    direct: [],
    cascade: [header(old)],
    effects: [],
    others: [],
    cache: new Map(),
    versions: new Map(),
    sync: syncRow({ draft_seq: 1 }),
    localId: FRESH,
    accountId: "acct",
    now: "2026-10-01T10:00:00.000Z",
    ...over,
  });
  const request = note(FRESH, "replacement");
  const stored = (over = {}) =>
    header(
      draftRow({
        local_id: FRESH,
        command: { kind: "create", text: "replacement" },
        command_digest: digestOf({ kind: "create", text: "replacement" }),
        ...over,
      }),
    );

  test("a fresh key supersedes", () => {
    expect(decideSupersede(request, facts()).kind).toBe("superseded");
  });

  test("any draft under the key refuses, whatever its status, without a single write", () => {
    for (const next of [
      "queued",
      "in_flight",
      "acknowledged",
      "rejected",
      "version_conflict",
      "blocked",
    ] as const) {
      const out = decideSupersede(
        request,
        facts({
          existing: header(draftRow({ local_id: FRESH, status: next })),
        }),
      );
      expect(out).toEqual({ kind: "refused", reason: "key_in_use" });
    }
  });

  test("the old draft's own key refuses", () => {
    expect(
      decideSupersede(
        note(OLD, "replacement"),
        facts({ localId: OLD, existing: header(old) }),
      ),
    ).toEqual({ kind: "refused", reason: "key_in_use" });
  });

  test("an old draft that cannot be superseded is reported as that, before the key", () => {
    const queued = header(draftRow({ local_id: OLD, status: "queued" }));
    expect(
      decideSupersede(
        request,
        facts({ old: queued, existing: header(draftRow({ local_id: FRESH })) }),
      ),
    ).toEqual({ kind: "refused", reason: "not_supersedable" });
  });

  test("the old draft gone: the same save under the key is a duplicate (with what it paused), anything else is `not_found`", () => {
    const same = decideSupersede(
      request,
      facts({ old: undefined, existing: stored(), existingPaused: [DEP] }),
    );
    expect(same).toMatchObject({ kind: "duplicate", paused: [DEP] });
    for (const different of [
      stored({ command_digest: digestOf({ kind: "create", text: "other" }) }),
      stored({ endpoint: "/elsewhere" }),
      stored({ target_resource_ids: [TARGET], index_targets: [TARGET] }),
      undefined,
    ])
      expect(
        decideSupersede(
          request,
          facts({ old: undefined, existing: different }),
        ),
      ).toEqual({ kind: "refused", reason: "not_found" });
  });

  test("a builder that throws cannot make a retry look like a duplicate", () => {
    const throwing: EnqueueRequest = {
      ...request,
      build: () => {
        throw new Error("the builder failed");
      },
    };
    expect(
      decideSupersede(throwing, facts({ old: undefined, existing: stored() })),
    ).toEqual({ kind: "refused", reason: "not_found" });
  });
});
