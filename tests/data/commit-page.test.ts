// @vitest-environment node
import { describe, expect, test } from "vitest";
import { DATA_CONFIG } from "../../src/data/model/config";
import { ACCOUNT, NAME, pageWorld } from "../support/data/page-world";
import {
  cacheRow,
  draftRow,
  effectRow,
  versionRow,
} from "../support/data/rows";
import {
  type PageSpec,
  projection,
  Rng,
  uuid,
} from "../support/data/sync-pages";

/**
 * F-C1 to F-C5, F-C8 (plan 8.3): the page commit, through the PRODUCTION plan over the double. The guard property matrix is
 * `commit-guard.test.ts`; the byte-level properties are `scan.test.ts` and `validate.test.ts`.
 */
const upsert = (
  n: number,
  over: Partial<ReturnType<typeof projection>> = {},
) => ({
  kind: "upsert" as const,
  resource: { ...projection(new Rng(n), n), id: uuid(n), ...over },
});
const remove = (n: number) => ({ kind: "remove" as const, id: uuid(n) });
const page = (
  changes: PageSpec["batches"][number]["changes"],
  over: Partial<PageSpec> = {},
): PageSpec => ({
  phase: "delta",
  hasMore: false,
  nextCursor: "cursor-1",
  batches: [{ revision: 7, changes }],
  ...over,
});

describe("F-C1: the page is atomic", () => {
  test("a clean page writes every change, the cursor VERBATIM, page_seq, applied_revision and last_synced_at together", async () => {
    const w = await pageWorld();
    const out = await w.commit(
      w.input(
        page([upsert(1), upsert(2), remove(3)], { nextCursor: 'a"b\\c é' }),
      ),
    );
    expect(out.kind).toBe("applied");
    expect(
      w
        .cache()
        .map((r) => r.id)
        .sort(),
    ).toEqual([uuid(1), uuid(2)]);
    expect(w.sync()).toMatchObject({
      cursor: 'a"b\\c é',
      page_seq: 1,
      applied_revision: 7,
      last_synced_at: "2026-10-01T12:00:00.000Z",
    });
  });

  test("a fault at EVERY write index leaves zero rows changed and the position unchanged; a retry applies the same page identically", async () => {
    const changes = Array.from({ length: 12 }, (_, i) =>
      i % 4 === 3 ? remove(i + 1) : upsert(i + 1),
    );
    const spec = page(changes);
    const baseline = await pageWorld();
    baseline.put("cache", [
      cacheRow({ id: uuid(4) }),
      cacheRow({ id: uuid(99) }),
    ]);
    const before = baseline.snapshot();
    // How many writes does the clean commit make? (Counted by running it once on a copy of the scenario.)
    const clean = await pageWorld();
    clean.put("cache", [cacheRow({ id: uuid(4) }), cacheRow({ id: uuid(99) })]);
    await clean.commit(clean.input(spec));
    const finalState = clean.snapshot();
    const total = 12 /* cache */ + 1 /* sync_state */ + 0;
    for (let n = 1; n <= total; n += 1) {
      for (const as of ["error", "quota"] as const) {
        const w = await pageWorld();
        w.put("cache", [cacheRow({ id: uuid(4) }), cacheRow({ id: uuid(99) })]);
        w.env.idb.inject({
          match: (tx) => tx.label === "data.commitPage",
          mode: { kind: "throw_on_write", n, as },
          times: 1,
        });
        const out = await w.commit(w.input(spec));
        expect(out.kind, `fault ${as} at write ${n}`).toBe("failed");
        expect(
          w.snapshot(),
          `fault ${as} at write ${n} must leave the database exactly as it was`,
        ).toEqual(before);
        // The same page, requested again, applies identically.
        const again = await w.commit(w.input(spec));
        expect(again.kind).toBe("applied");
        expect(w.snapshot()).toEqual(finalState);
      }
    }
  });

  test("a transaction that is lost after it committed is indistinguishable, and reapplying the page changes nothing further (idempotent)", async () => {
    const w = await pageWorld();
    const spec = page([upsert(1), remove(2)]);
    await w.commit(w.input(spec));
    const once = w.snapshot();
    // The same page, extending the position it already extended: the CAS refuses it, so it cannot double-advance page_seq.
    const second = await w.commit(
      w.input(spec, { captured: w.capture({ expectedPosition: "cursor-0" }) }),
    );
    expect(second).toEqual({ kind: "dropped", reason: "position" });
    expect(w.snapshot()).toEqual(once);
  });
});

describe("F-C2: an EMPTY page still commits its (possibly renewed) cursor", () => {
  test("no batches: cursor and page_seq advance; applied_revision and the cache do not", async () => {
    const w = await pageWorld();
    w.setSync({ applied_revision: 41 });
    const out = await w.commit(
      w.input({
        phase: "delta",
        hasMore: false,
        nextCursor: "renewed",
        batches: [],
      }),
    );
    expect(out.kind).toBe("applied");
    expect(w.sync()).toMatchObject({
      cursor: "renewed",
      page_seq: 1,
      applied_revision: 41,
    });
    expect(w.cache()).toEqual([]);
  });
  test("a reused cursor is written as it is (the same string), and batches with no changes still advance the revision", async () => {
    const w = await pageWorld({ cursor: "same" });
    await w.commit(
      w.input({
        phase: "delta",
        hasMore: true,
        nextCursor: "same",
        batches: [{ revision: 9, changes: [] }],
      }),
    );
    expect(w.sync()).toMatchObject({
      cursor: "same",
      page_seq: 1,
      applied_revision: 9,
      last_synced_at: null,
    });
  });
});

describe("F-C3 and F-C5: order, absence, and the counters", () => {
  test("changes apply in the server's order within a page and across batches: an upsert then a remove of one id leaves it removed, and the reverse leaves it", async () => {
    const w = await pageWorld();
    await w.commit(
      w.input({
        phase: "delta",
        hasMore: false,
        nextCursor: "c1",
        batches: [
          { revision: 1, changes: [upsert(1), remove(1)] },
          { revision: 2, changes: [remove(2), upsert(2)] },
        ],
      }),
    );
    expect(w.cache().map((r) => r.id)).toEqual([uuid(2)]);
  });
  test("a Remove of an absent id is a no-op, and absence from a page is never a deletion", async () => {
    const w = await pageWorld();
    w.put("cache", [cacheRow({ id: uuid(50) })]);
    await w.commit(w.input(page([remove(77), upsert(1)])));
    expect(
      w
        .cache()
        .map((r) => r.id)
        .sort(),
    ).toEqual([uuid(1), uuid(50)].sort());
  });
  test("applied_revision is the highest batch revision seen and never goes backwards; last_synced_at moves only when has_more is false", async () => {
    const w = await pageWorld();
    w.setSync({ applied_revision: 50 });
    await w.commit(
      w.input({
        phase: "delta",
        hasMore: true,
        nextCursor: "c1",
        batches: [
          { revision: 30, changes: [] },
          { revision: 40, changes: [] },
        ],
      }),
    );
    expect(w.sync()).toMatchObject({
      applied_revision: 50,
      last_synced_at: null,
      page_seq: 1,
    });
    await w.commit(
      w.input(
        {
          phase: "delta",
          hasMore: false,
          nextCursor: "c2",
          batches: [
            { revision: 90, changes: [] },
            { revision: 60, changes: [] },
          ],
        },
        { captured: w.capture() },
      ),
    );
    expect(w.sync()).toMatchObject({
      applied_revision: 90,
      last_synced_at: "2026-10-01T12:00:00.000Z",
      page_seq: 2,
    });
  });
  test("a page that commits resets the sync read-retry state, this page's local-write streak, and the sizing marker and floor count", async () => {
    const w = await pageWorld();
    w.setSync({
      read_retry_states: {
        sync: { backing_off_since: 5, paused: false, unrecognised_streak: 2 },
        other: { backing_off_since: 9, paused: true, unrecognised_streak: 0 },
      },
      local_write_streaks: { "page:cursor-0": 2, "draft:x": 1 },
      sizing: {
        limit: 1,
        class: "unknown",
        floor_hits: 2,
        attempt: { id: "a", limit: 1, started_at: 1 },
      },
    });
    await w.commit(w.input(page([upsert(1)])));
    const s = w.sync();
    expect(s.read_retry_states.sync).toEqual({
      backing_off_since: null,
      paused: false,
      unrecognised_streak: 0,
    });
    expect(s.read_retry_states.other).toEqual({
      backing_off_since: 9,
      paused: true,
      unrecognised_streak: 0,
    });
    expect(s.local_write_streaks).toEqual({ "draft:x": 1 });
    expect(s.sizing).toMatchObject({ attempt: null, floor_hits: 0 });
  });
});

describe("the page is refused whole", () => {
  const bad = (labelled: string) =>
    `{"phase":"delta","batches":[{"revision":1,"changes":[{"kind":"upsert","resource":{"id":"${uuid(1)}","kind":"task","parent_id":null,"label":${labelled},"value":null,"version":1,"can_edit":true,"archived":false}},{"kind":"upsert","resource":{"id":"${uuid(2)}","kind":"task","parent_id":null,"label":"ok","value":null,"version":1,"can_edit":true,"archived":false}}]}],"next_cursor":"cursor-1","has_more":false}`;
  test("F-C11: an invalid element anywhere aborts the transaction: nothing is written, the cursor does not move, and it is a plan rejection with a fixed reason", async () => {
    const w = await pageWorld();
    w.put("cache", [cacheRow({ id: uuid(99) })]);
    const before = w.snapshot();
    // The FIRST change is valid in position terms but the page contains an invalid one: everything rolls back.
    const out = await w.commit(w.input(bad('""')));
    expect(out).toMatchObject({
      kind: "failed",
      failure: {
        cause: "plan_rejected",
        detail: { stage: "projection", reason: "bad_label" },
      },
    });
    expect(w.snapshot()).toEqual(before);
  });
  test("the same page with the element fixed commits", async () => {
    const w = await pageWorld();
    expect((await w.commit(w.input(bad('"fine"')))).kind).toBe("applied");
    expect(w.cache()).toHaveLength(2);
  });
  test("a page of the wrong phase, or a database that is not delta/valid, writes nothing but is not a failure", async () => {
    const snapshotPage = await pageWorld();
    expect(
      await snapshotPage.commit(
        snapshotPage.input(page([upsert(1)], { phase: "snapshot" })),
      ),
    ).toEqual({
      kind: "applied",
      value: { kind: "not_ready", reason: "page_phase" },
    });
    const invalid = await pageWorld({ cacheStatus: "invalid" });
    expect(await invalid.commit(invalid.input(page([upsert(1)])))).toEqual({
      kind: "applied",
      value: { kind: "not_ready", reason: "cache_status" },
    });
    const snap = await pageWorld({ phase: "snapshot" });
    expect(await snap.commit(snap.input(page([upsert(1)])))).toEqual({
      kind: "applied",
      value: { kind: "not_ready", reason: "phase" },
    });
    for (const w of [snapshotPage, invalid, snap])
      expect(w.cache()).toEqual([]);
  });
  test("the watchdog: an apply that runs too long is abandoned at a chunk boundary and rolls back", async () => {
    const w = await pageWorld();
    const many = Array.from({ length: DATA_CONFIG.applyChunk * 2 }, (_, i) =>
      upsert(i + 1),
    );
    let t = 0;
    const out = await w.commit(
      w.input(page(many), { elapsed: () => (t += 20_000), watchdogMs: 30_000 }),
    );
    expect(out).toMatchObject({
      kind: "failed",
      failure: {
        cause: "plan_rejected",
        detail: { stage: "apply", reason: "watchdog" },
      },
    });
    expect(w.cache()).toEqual([]);
    expect(w.sync().cursor).toBe("cursor-0");
  });
  // ADAPTED, revision 24 (R44): the title's intent stands (an allocation failure is a distinct fixed-shape failure, not an ordinary
  // error). The BODY used to pin the opposite for a validator that throws a RangeError ("the registrant's defect, NOT an allocation
  // failure"), which the invariant of R44 refuses: an allocation failure observed while processing a valid page is the device's signal at
  // every stage, and a RangeError is the one signal the engine has for it. What the old body protected (a registrant's ORDINARY defect is a
  // refusal of the page, never a storage fault) is the next test, unchanged. The original text is in
  // `.agtx/evidence/WEB-09a/revision-24/adapted-assertion-original.ts.txt`.
  test("an allocation failure (a RangeError) is a distinct fixed-shape failure, not an ordinary error (adapted, revision 24: a validator's RangeError is that failure)", async () => {
    const w = await pageWorld();
    const out = await w.commit(
      w.input(page([upsert(1)]), {
        decode: {
          validators: {
            register: () => undefined,
            validate: () => {
              throw new RangeError("Array buffer allocation failed");
            },
          },
          derivers: { register: () => undefined, derive: () => null },
        },
      }),
    );
    expect(out).toMatchObject({
      kind: "failed",
      failure: {
        cause: "error",
        detail: { stage: "alloc", reason: "range_error" },
      },
    });
    expect(w.cache()).toEqual([]);
  });
  test("a throwing validator that is NOT an allocation failure is a refusal of the page (the registrant's defect), not a storage fault (the original assertion of the test above, kept for the input where it still holds)", async () => {
    const w = await pageWorld();
    const out = await w.commit(
      w.input(page([upsert(1)]), {
        decode: {
          validators: {
            register: () => undefined,
            validate: () => {
              throw new Error("a defect of the registrant");
            },
          },
          derivers: { register: () => undefined, derive: () => null },
        },
      }),
    );
    expect(out).toMatchObject({
      kind: "failed",
      failure: {
        cause: "plan_rejected",
        detail: { stage: "value", reason: "validator_failed" },
      },
    });
    expect(w.cache()).toEqual([]);
  });
});

describe("F-C4: admission", () => {
  test("a seeded owner, generation and cursor with a DELIBERATELY MISMATCHED captured value each abort independently with nothing written", async () => {
    const seeded = {
      owner: { tab_id: "t", ownership_token: "tok-1", heartbeat_at: 1 },
      recovery_generation: 3,
      cursor: "cursor-0",
    } as const;
    const cases: Array<
      [
        string,
        Parameters<typeof pageWorld>[0] | undefined,
        Record<string, unknown>,
        string,
      ]
    > = [
      ["owner", undefined, { ownershipToken: "tok-OTHER" }, "owner"],
      ["owner missing", undefined, { ownershipToken: null }, "owner"],
      ["generation", undefined, { recoveryGeneration: 2 }, "generation"],
      ["position", undefined, { expectedPosition: "cursor-OTHER" }, "position"],
    ];
    for (const [name, , override, reason] of cases) {
      const w = await pageWorld();
      w.setSync({ ...seeded });
      const before = w.snapshot();
      const out = await w.commit(
        w.input(page([upsert(1)]), {
          captured: w.capture({
            ownershipToken: "tok-1",
            recoveryGeneration: 3,
            expectedPosition: "cursor-0",
            ...override,
          }),
        }),
      );
      expect(out, name).toEqual({ kind: "dropped", reason });
      expect(w.snapshot(), name).toEqual(before);
    }
    // And matching values commit.
    const ok = await pageWorld();
    ok.setSync({ ...seeded });
    expect(
      (
        await ok.commit(
          ok.input(page([upsert(1)]), {
            captured: ok.capture({
              ownershipToken: "tok-1",
              recoveryGeneration: 3,
              expectedPosition: "cursor-0",
            }),
          }),
        )
      ).kind,
    ).toBe("applied");
  });
  test("a duplicate or delayed page extending a position that has moved is refused on the cursor", async () => {
    const w = await pageWorld();
    const first = w.input(page([upsert(1)]));
    const stale = w.input(page([upsert(2)]), { captured: w.capture() }); // captured at cursor-0
    expect((await w.commit(first)).kind).toBe("applied");
    expect(await w.commit(stale)).toEqual({
      kind: "dropped",
      reason: "position",
    });
    expect(w.cache().map((r) => r.id)).toEqual([uuid(1)]);
  });
});

describe("what a page does to local work (through the production plan)", () => {
  const R = uuid(500);
  test("a mention clears the overlay and the settled draft; an unrelated id is untouched", async () => {
    const w = await pageWorld();
    w.put("drafts", [
      draftRow({ local_id: "d1", status: "acknowledged", index_targets: [R] }),
    ]);
    w.put("pending_effects", [
      effectRow({
        resource_id: R,
        local_id: "d1",
        display: { label: "shown" },
        no_publication_floor: 1,
      }),
    ]);
    await w.commit(w.input(page([upsert(500, { id: R })])));
    expect(w.rows("pending_effects")).toEqual([]);
    expect(w.rows("drafts")).toEqual([]);
    expect(w.cache().map((r) => r.id)).toEqual([R]);
  });
  test("the live-edge no_publication fires only for a request CAPTURED after the receipt (the strict comparison, end to end)", async () => {
    const w = await pageWorld();
    w.setSync({ request_seq: 7 });
    w.put("drafts", [
      draftRow({
        local_id: "d1",
        status: "acknowledged",
        held_pending_cache: true,
        index_targets: [R],
      }),
    ]);
    w.put("pending_effects", [
      effectRow({
        resource_id: R,
        local_id: "d1",
        display: null,
        no_publication_floor: 7,
      }),
    ]);
    // Captured at request_seq 7 == the floor: a request already in flight when the receipt was recorded. Nothing resolves.
    await w.commit(
      w.input(page([upsert(1)]), { captured: w.capture({ requestSeq: 7 }) }),
    );
    expect(
      (w.rows("pending_effects")[0] as { resolved: unknown }).resolved,
    ).toBeNull();
    // The next request (8) is eligible.
    w.setSync({ request_seq: 8 });
    await w.commit(
      w.input(page([upsert(2)], { nextCursor: "cursor-2" }), {
        captured: w.capture({ requestSeq: 8 }),
      }),
    );
    expect(
      (w.rows("pending_effects")[0] as { resolved: unknown }).resolved,
    ).toBe("no_publication");
    expect(w.rows("drafts")[0]).toMatchObject({
      held_pending_cache: false,
      unavailable_outcome: true,
    });
  });
  test("F-C8: resource_versions follow the server upwards and are retired when finished; queued drafts keep their bases", async () => {
    const w = await pageWorld();
    w.put("resource_versions", [
      versionRow({ resource_id: R, locally_assumed_version: 5 }),
    ]);
    w.put("drafts", [
      draftRow({
        local_id: "q",
        status: "queued",
        index_targets: [R],
        expected_version: 5,
      }),
    ]);
    await w.commit(w.input(page([upsert(500, { id: R, version: 9 })])));
    expect(w.rows("resource_versions")[0]).toMatchObject({
      locally_assumed_version: 9,
    });
    expect(w.rows("drafts")[0]).toMatchObject({ expected_version: 5 }); // meets a genuine 409 later
  });
  test("the read set is the outstanding local work, not the page: a dense page against a small queue touches only the ids of interest", async () => {
    const w = await pageWorld();
    w.put("pending_effects", [
      effectRow({ resource_id: R, local_id: "d1", display: { label: "x" } }),
    ]);
    w.put("drafts", [
      draftRow({ local_id: "d1", status: "in_flight", index_targets: [R] }),
    ]);
    const changes = Array.from({ length: 400 }, (_, i) => upsert(i + 1));
    changes.push(upsert(500, { id: R }));
    await w.commit(w.input(page(changes)));
    expect(w.rows("cache")).toHaveLength(401);
    expect(w.rows("pending_effects")[0]).toMatchObject({
      last_mentioned_page_seq: 1,
      display: null,
    });
  });
});

describe("the account and the name used above", () => {
  test("are consistent", () => {
    expect(NAME).toBe(`atlas-${ACCOUNT}`);
  });
});
