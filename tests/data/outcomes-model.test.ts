// @vitest-environment node
import { describe, expect, test } from "vitest";
import {
  classifyAnswer,
  durableNotBefore,
  selectCandidate,
} from "../../src/data/model/dispatch";
import {
  decideOutcome,
  decideReceipt,
  type OutcomeFacts,
  resumeDraft,
} from "../../src/data/model/outcomes";
import {
  applyPatch,
  mergeResource,
  orderEffects,
} from "../../src/data/model/overlay";
import { summariseQueue } from "../../src/data/model/queue-summary";
import { nextDelay } from "../../src/data/model/retry";
import type { DraftRow, PendingEffectRow } from "../../src/data/model/types";
import { cacheRow, draftRow, effectRow } from "../support/data/rows";

/**
 * The outbox's answers, as pure decisions: which draft is sent next (F-O13), what each response means (F-O6 to F-O9), the queue
 * summary (F-O14) and the overlay merge (plan 5.5.6). FIXTURE-level: no database, no network.
 */
const atlasError = (code: string) => ({ code, message: "m", request_id: "r" });
const answer = (status: number, code: string | null, revision?: unknown) =>
  classifyAnswer({
    status,
    error: code === null ? null : atlasError(code),
    revision,
  });

describe("the outcome table of a command request (plan 5.5.4)", () => {
  test.each([
    [200, null, 4, { kind: "receipt", revision: 4 }],
    [200, null, 0, { kind: "receipt", revision: 0 }],
    [409, "conflict", undefined, { kind: "conflict", code: "conflict" }],
    [
      409,
      "operation_conflict",
      undefined,
      { kind: "conflict", code: "operation_conflict" },
    ],
    [409, "defaults_changed", undefined, { kind: "defaults_changed" }],
    [
      409,
      "materialisation_required",
      undefined,
      { kind: "other_conflict", code: "materialisation_required" },
    ],
    [
      409,
      "stale_refresh",
      undefined,
      { kind: "other_conflict", code: "stale_refresh" },
    ],
    [
      403,
      "forbidden",
      undefined,
      { kind: "rejected", status: 403, code: "forbidden" },
    ],
    [
      404,
      "not_found",
      undefined,
      { kind: "rejected", status: 404, code: "not_found" },
    ],
    [
      422,
      "validation_failed",
      undefined,
      { kind: "rejected", status: 422, code: "validation_failed" },
    ],
    [
      400,
      "malformed_request",
      undefined,
      { kind: "rejected", status: 400, code: "malformed_request" },
    ],
    [503, "slice_capacity", undefined, { kind: "capacity" }],
    [
      503,
      "temporarily_unavailable",
      undefined,
      { kind: "retry", status: 503, code: "temporarily_unavailable" },
    ],
    [
      500,
      "internal_error",
      undefined,
      { kind: "retry", status: 500, code: "internal_error" },
    ],
    [429, null, undefined, { kind: "retry", status: 429, code: null }],
  ])("%i %s", (status, code, revision, expected) => {
    expect(answer(status, code, revision)).toEqual(expected);
  });

  test("a refusal is recognised only from an ATLAS-FORMATTED body: a gateway's 404, 403 or 422 never rejects a draft", () => {
    for (const status of [400, 403, 404, 422])
      expect(answer(status, null)).toEqual({
        kind: "retry",
        status,
        code: null,
      });
  });

  test("a 403 with another code (e.g. a credential mismatch that should have been the wrapper's) and a 400 that is not malformed_request are unrecognised, not rejections", () => {
    expect(answer(403, "credential_mismatch")).toMatchObject({ kind: "retry" });
    expect(answer(400, "other")).toMatchObject({ kind: "retry" });
  });

  test("a 200 whose body has no usable revision is an unrecognised answer: it never acknowledges", () => {
    expect(answer(200, null, undefined)).toMatchObject({ kind: "retry" });
    expect(answer(200, null, -1)).toMatchObject({ kind: "retry" });
    expect(answer(200, null, 1.5)).toMatchObject({ kind: "retry" });
    expect(answer(200, null, "3")).toMatchObject({ kind: "retry" });
  });
});

describe("F-O13: which draft is sent next", () => {
  const D = (seq: number, over: Partial<DraftRow> = {}) =>
    draftRow({ local_id: `d${seq}`, created_seq: seq, ...over });
  const pick = (
    rows: DraftRow[],
    now = 1_000,
    blocked: Array<[string, number]> = [],
  ) => selectCandidate({ rows, now, blockedUntil: new Map(blocked) });

  test("global FIFO by created_seq, whatever the order the rows arrive in", () => {
    expect(pick([D(1), D(2), D(3)]).pick?.local_id).toBe("d1");
  });

  test("a draft that waits on an unsettled predecessor is not sent; an acknowledged or missing one does not hold it", () => {
    expect(
      pick([
        D(1, { index_targets: ["r"] }),
        D(2, { depends_on: ["d1"], index_targets: ["r"] }),
      ]).pick?.local_id,
    ).toBe("d1");
    expect(
      pick([D(1, { status: "acknowledged" }), D(2, { depends_on: ["d1"] })])
        .pick?.local_id,
    ).toBe("d2");
    expect(pick([D(2, { depends_on: ["gone"] })]).pick?.local_id).toBe("d2");
    expect(
      pick([
        D(1, { status: "version_conflict", index_targets: ["r"] }),
        D(2, { depends_on: ["d1"], index_targets: ["r"] }),
      ]).pick,
    ).toBeNull();
  });

  test("one entry's back-off never blocks another that shares no resource with it (D-18)", () => {
    const rows = [
      D(1, {
        index_targets: ["a"],
        attempts: 1,
        retry_state: { state: "backing_off", since: 0 },
      }),
      D(2, { index_targets: ["b"] }),
    ];
    const out = pick(rows, 1_000, [["d1", 5_000]]);
    expect(out.pick?.local_id).toBe("d2");
    expect(out.wakeAt).toBe(5_000);
    expect(out.backingOff).toBe(1);
  });

  test("...but two drafts against one resource are NEVER reordered: the later waits for the earlier's back-off", () => {
    const rows = [
      D(1, {
        index_targets: ["a"],
        attempts: 1,
        retry_state: { state: "backing_off", since: 0 },
      }),
      D(2, { index_targets: ["a"] }),
    ];
    expect(pick(rows, 1_000, [["d1", 5_000]]).pick).toBeNull();
    expect(pick(rows, 5_001, [["d1", 5_000]]).pick?.local_id).toBe("d1");
  });

  test("two drafts that share only a SIDE-EFFECT id are not reordered either", () => {
    const rows = [
      D(1, {
        status: "operation_conflict",
        index_targets: ["task1", "stream"],
      }),
      D(2, { index_targets: ["task2", "stream"] }),
    ];
    expect(pick(rows).pick).toBeNull();
  });

  test("a paused draft is not sent and is counted for the 'Retry now' state; an in_flight draft is a retry candidate", () => {
    const paused = D(1, {
      status: "in_flight",
      retry_state: { state: "paused", since: 0 },
      index_targets: ["a"],
    });
    const retry = D(2, { status: "in_flight", index_targets: ["b"] });
    const out = pick([paused, retry]);
    expect(out.pick?.local_id).toBe("d2");
    expect(out.paused).toBe(1);
  });

  test("D-19: a defaults review holds the queue from that draft onward, not before it", () => {
    const rows = [
      D(1, { index_targets: ["a"] }),
      D(2, {
        status: "in_flight",
        review_block: { kind: "defaults", kinds: [] },
        index_targets: ["b"],
      }),
      D(3, { index_targets: ["c"] }),
    ];
    expect(pick(rows).pick?.local_id).toBe("d1");
    expect(pick(rows.slice(1)).pick).toBeNull();
    expect(pick(rows.slice(1)).holdFrom).toBe(2);
  });

  test("the durable back-off survives a reload: attempts and last_attempt_at give the earliest next time", () => {
    const d = D(1, {
      attempts: 3,
      retry_state: { state: "backing_off", since: 0 },
      last_attempt_at: new Date(10_000).toISOString(),
    });
    expect(durableNotBefore(d)).toBe(10_000 + nextDelay(3, 0.5));
    expect(durableNotBefore(D(1))).toBe(0);
    // A draft backing off durably is not eligible at a time before its own back-off ends.
    expect(pick([d], 10_001).pick).toBeNull();
    expect(pick([d], 10_000 + nextDelay(3, 0.5)).pick?.local_id).toBe("d1");
  });

  test("terminal and non-sendable rows are never candidates", () => {
    expect(
      pick([
        D(1, { status: "rejected" }),
        D(2, { status: "blocked" }),
        D(3, { status: "superseded" }),
        D(4, { status: "acknowledged" }),
      ]).pick,
    ).toBeNull();
  });
});

describe("F-O6: admitReceipt, condition by condition", () => {
  const draft = (over: Partial<DraftRow> = {}): DraftRow =>
    draftRow({
      local_id: "d",
      status: "in_flight",
      index_targets: ["r"],
      target_resource_ids: ["r"],
      display_patch: { r: { label: "Shown" } },
      ...over,
    });
  const row = (over: Partial<PendingEffectRow> = {}): PendingEffectRow =>
    effectRow({ resource_id: "r", local_id: "d", ...over });
  const facts = (over: Partial<Parameters<typeof decideReceipt>[0]> = {}) => ({
    draft: draft(),
    effects: [row()],
    dependants: [],
    cacheStatus: "valid" as const,
    requestSeq: 5,
    revision: 12,
    ...over,
  });

  test("0: a draft that is gone, or not exactly in_flight, makes the whole thing a no-op (a duplicate or late receipt)", () => {
    expect(decideReceipt(facts({ draft: undefined }))).toEqual({
      kind: "noop",
      reason: "not_found",
    });
    for (const status of [
      "queued",
      "acknowledged",
      "version_conflict",
      "rejected",
      "blocked",
    ] as const)
      expect(decideReceipt(facts({ draft: draft({ status }) }))).toEqual({
        kind: "noop",
        reason: "not_in_flight",
      });
  });

  test("2: an unmentioned row on a valid cache gets its display, the floor is the request_seq NOW, and the revision is recorded", () => {
    const out = decideReceipt(facts());
    if (out.kind !== "admitted") throw new Error(out.kind);
    expect(out.effectPuts).toEqual([
      expect.objectContaining({
        display: { label: "Shown" },
        no_publication_floor: 5,
        receipt_revision: 12,
      }),
    ]);
    expect(out.displayed).toBe(1);
    // 3: acknowledged UNCONDITIONALLY, and the draft stays until its overlay clears.
    expect(out.draftPut).toMatchObject({
      status: "acknowledged",
      receipt_revision: 12,
      held_pending_cache: false,
    });
    expect(out.draftDelete).toBeNull();
  });

  test("2: a mention BEFORE the receipt means no display (the page already published it); the row and the draft leave at once", () => {
    const out = decideReceipt(
      facts({ effects: [row({ last_mentioned_page_seq: 3 })] }),
    );
    if (out.kind !== "admitted") throw new Error(out.kind);
    expect(out.displayed).toBe(0);
    expect(out.effectDeletes).toEqual([["r", "d"]]);
    expect(out.draftDelete).toBe("d");
    expect(out.draftPut).toBeNull();
  });

  test("2: a row already resolved no_publication gets no display", () => {
    const out = decideReceipt(
      facts({ effects: [row({ resolved: "no_publication" })] }),
    );
    if (out.kind !== "admitted") throw new Error(out.kind);
    expect(out.displayed).toBe(0);
  });

  test("2: with the cache not valid there is NO display and the draft is held_pending_cache (an overlay is never shown over a hidden cache)", () => {
    for (const cacheStatus of ["invalid", "empty"] as const) {
      const out = decideReceipt(facts({ cacheStatus }));
      if (out.kind !== "admitted") throw new Error(out.kind);
      expect(out.displayed).toBe(0);
      expect(out.held).toBe(true);
      expect(out.draftPut).toMatchObject({
        status: "acknowledged",
        held_pending_cache: true,
      });
      // The floor is still recorded, so a later live-edge can resolve it.
      expect(out.effectPuts[0]).toMatchObject({
        no_publication_floor: 5,
        display: null,
      });
      expect(out.draftDelete).toBeNull();
    }
  });

  test("a draft with no candidate rows (nothing to overlay) is acknowledged and leaves immediately", () => {
    const out = decideReceipt(facts({ effects: [] }));
    if (out.kind !== "admitted") throw new Error(out.kind);
    expect(out.draftDelete).toBe("d");
  });

  test("4: direct dependants lose their depends_on entry for this draft, and only that entry", () => {
    const dep = draftRow({ local_id: "x", depends_on: ["d", "other"] });
    const out = decideReceipt(
      facts({
        dependants: [dep, draftRow({ local_id: "y", depends_on: ["z"] })],
      }),
    );
    if (out.kind !== "admitted") throw new Error(out.kind);
    expect(out.dependantPuts).toEqual([{ ...dep, depends_on: ["other"] }]);
  });
});

describe("F-O7, F-O8, F-O10: the other answers", () => {
  const draft = (over: Partial<DraftRow> = {}): DraftRow =>
    draftRow({
      local_id: "d",
      status: "in_flight",
      index_targets: ["r"],
      target_resource_ids: ["r"],
      bases: { r: 2 },
      bumped: ["r"],
      ...over,
    });
  const facts = (over: Partial<OutcomeFacts> = {}): OutcomeFacts => ({
    draft: draft(),
    outcome: { kind: "retry" },
    error: { stage: "network" },
    members: [draft()],
    effects: [effectRow({ local_id: "d", resource_id: "r" })],
    others: [],
    cache: new Map([["r", cacheRow({ id: "r", version: 2 })]]),
    versions: new Map(),
    now: 100_000,
    nowIso: new Date(100_000).toISOString(),
    ...over,
  });
  const recorded = (out: ReturnType<typeof decideOutcome>) => {
    if (out.kind !== "recorded") throw new Error(out.kind);
    return out;
  };

  test("only an in_flight draft is changed: a duplicate or late answer is a no-op", () => {
    expect(decideOutcome(facts({ draft: undefined }))).toEqual({
      kind: "noop",
      reason: "not_found",
    });
    expect(
      decideOutcome(facts({ draft: draft({ status: "acknowledged" }) })),
    ).toEqual({ kind: "noop", reason: "not_in_flight" });
  });

  test("409 conflict: ONLY that draft changes (version_conflict), it is counted, and its candidate rows go", () => {
    const out = recorded(
      decideOutcome(
        facts({
          outcome: { kind: "conflict", as: "version_conflict" },
          error: { status: 409, code: "conflict", stage: "conflict" },
        }),
      ),
    );
    expect(out.status).toBe("version_conflict");
    expect(out.draftPuts).toHaveLength(1);
    expect(out.draftPuts[0]).toMatchObject({
      attempts: 1,
      last_error: { status: 409, code: "conflict" },
    });
    expect(out.effectDeletes).toEqual([["r", "d"]]);
  });

  test("409 operation_conflict is its own status and is never resubmitted under the same key", () => {
    const out = recorded(
      decideOutcome(
        facts({ outcome: { kind: "conflict", as: "operation_conflict" } }),
      ),
    );
    expect(out.status).toBe("operation_conflict");
  });

  test("409 defaults_changed: a review block on the STILL FROZEN in_flight draft, nothing deleted (D-19)", () => {
    const out = recorded(
      decideOutcome(facts({ outcome: { kind: "defaults_changed" } })),
    );
    expect(out.status).toBe("in_flight");
    expect(out.draftPuts[0]).toMatchObject({
      status: "in_flight",
      review_block: { kind: "defaults" },
    });
    expect(out.effectDeletes).toEqual([]);
  });

  test("slice_capacity: blocked with its reason, retained, no retry state (a manual retry only)", () => {
    const out = recorded(
      decideOutcome(facts({ outcome: { kind: "capacity" } })),
    );
    expect(out.draftPuts[0]).toMatchObject({
      status: "blocked",
      blocked_reason: "slice_capacity",
      retry_state: null,
    });
  });

  test("a refusal rejects the draft AND every dependant, retained; the base is recomputed in the same step", () => {
    const a = draft();
    const b = draft({
      local_id: "b",
      status: "queued",
      created_seq: 9,
      bases: { r: 3 },
      depends_on: ["d"],
    });
    const out = recorded(
      decideOutcome(
        facts({
          outcome: { kind: "rejected" },
          members: [a, b],
          versions: new Map([
            [
              "r",
              {
                resource_id: "r",
                locally_assumed_version: 4,
                basis: "resource",
              },
            ],
          ]),
        }),
      ),
    );
    expect(out.draftPuts.map((d) => [d.local_id, d.status])).toEqual([
      ["d", "rejected"],
      ["b", "rejected"],
    ]);
    expect(out.draftPuts[1]?.last_error).toEqual({
      stage: "dependency_rejected",
    });
    expect(out.versions.puts).toEqual([
      { resource_id: "r", locally_assumed_version: 2, basis: "resource" },
    ]);
    expect(out.effectDeletes).toEqual([["r", "d"]]);
  });

  test("a retry-class failure keeps the draft in_flight with its rows, counts, and backs off; after the sustained duration it pauses", () => {
    const first = recorded(decideOutcome(facts()));
    expect(first.status).toBe("in_flight");
    expect(first.draftPuts[0]).toMatchObject({
      attempts: 1,
      retry_state: { state: "backing_off", since: 100_000 },
    });
    expect(first.effectDeletes).toEqual([]);
    const later = recorded(
      decideOutcome(
        facts({
          draft: draft({
            attempts: 5,
            retry_state: { state: "backing_off", since: 100_000 - 181_000 },
          }),
          now: 100_000,
        }),
      ),
    );
    expect(later.draftPuts[0]?.retry_state).toEqual({
      state: "paused",
      since: 100_000 - 181_000,
    });
  });

  test("resume: a paused draft is released with a fresh count; a blocked one is queued again; a healthy one is untouched", () => {
    expect(
      resumeDraft(
        draft({ retry_state: { state: "paused", since: 1 }, attempts: 9 }),
      ),
    ).toMatchObject({ retry_state: null, attempts: 0, status: "in_flight" });
    const blocked = resumeDraft(
      draft({ status: "blocked", blocked_reason: "slice_capacity" }),
    );
    expect(blocked).toMatchObject({ status: "queued", attempts: 0 });
    expect(blocked).not.toHaveProperty("blocked_reason");
    expect(resumeDraft(draft())).toBeNull();
  });
});

describe("F-O14: the queue summary and its warning", () => {
  test("waiting, needs a decision, held; superseded and ordinary acknowledged rows are not counted", () => {
    const rows = [
      draftRow({ status: "queued" }),
      draftRow({ status: "in_flight" }),
      draftRow({
        status: "in_flight",
        review_block: { kind: "defaults", kinds: [] },
      }),
      draftRow({ status: "version_conflict" }),
      draftRow({ status: "operation_conflict" }),
      draftRow({ status: "rejected" }),
      draftRow({ status: "blocked" }),
      draftRow({ status: "acknowledged", held_pending_cache: true }),
      draftRow({ status: "acknowledged", unavailable_outcome: true }),
      draftRow({ status: "acknowledged" }),
      draftRow({ status: "superseded" }),
    ];
    expect(summariseQueue(rows)).toEqual({
      waiting: 2,
      needsDecision: 5,
      held: 2,
      total: 9,
      warn: false,
    });
  });

  test("the warning appears at 200 and is informational: the summary has no field that disables anything", () => {
    const rows = Array.from({ length: 200 }, () =>
      draftRow({ status: "queued" }),
    );
    expect(summariseQueue(rows.slice(1)).warn).toBe(false);
    const full = summariseQueue(rows);
    expect(full.warn).toBe(true);
    expect(Object.keys(full).sort()).toEqual([
      "held",
      "needsDecision",
      "total",
      "waiting",
      "warn",
    ]);
  });
});

describe("plan 5.5.6: reading with the overlay", () => {
  const base = cacheRow({
    id: "r",
    label: "Base",
    archived: false,
    value: { a: 1, b: 2 },
  });
  const fx = (
    local: string,
    at: string,
    display: PendingEffectRow["display"],
  ) =>
    effectRow({ resource_id: "r", local_id: local, created_at: at, display });

  test("a later effect's field wins and fields no effect touches fall through; value is a SHALLOW merge", () => {
    const merged = mergeResource(base, [
      fx("a", "2026-10-01T09:00:00.000Z", { label: "First", value: { b: 9 } }),
      fx("b", "2026-10-01T09:00:01.000Z", { label: "Second", archived: true }),
    ]);
    expect(merged.merged).toMatchObject({
      label: "Second",
      archived: true,
      value: { a: 1, b: 9 },
    });
    expect(merged.base).toBe(base);
  });

  test("rows are ordered by their OWN created_at, then local_id: by_resource is not an ordering", () => {
    const a = fx("b", "2026-10-01T09:00:00.000Z", null);
    const b = fx("a", "2026-10-01T09:00:00.000Z", null);
    const c = fx("c", "2026-10-01T08:00:00.000Z", null);
    expect(orderEffects([a, b, c]).map((e) => e.local_id)).toEqual([
      "c",
      "a",
      "b",
    ]);
  });

  test("an effect with no display (not yet admitted, or released) shows nothing", () => {
    expect(
      mergeResource(base, [fx("a", "2026-10-01T09:00:00.000Z", null)]).merged,
    ).toEqual(base);
  });

  test("nothing is edited in place, and an absent base with no projection merges to null (creates are listed, not invented)", () => {
    const patched = applyPatch(base, { label: "X" });
    expect(base.label).toBe("Base");
    expect(patched.label).toBe("X");
    const create = draftRow({
      local_id: "c",
      status: "queued",
      target_resource_ids: ["r"],
    });
    const out = mergeResource(null, [], [create]);
    expect(out.merged).toBeNull();
    expect(out.creates).toEqual([create]);
    const projected = mergeResource(
      null,
      [fx("c", "2026-10-01T09:00:00.000Z", { label: "Mine" })],
      [create],
      () => cacheRow({ id: "r", label: "Draft" }),
    );
    expect(projected.merged?.label).toBe("Mine");
  });
});
