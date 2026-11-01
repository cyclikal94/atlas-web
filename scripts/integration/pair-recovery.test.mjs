// WEB-09c revision 27 (R27-DIAG.b; design assessment Q2): the maintained RECOVERY OBSERVER against deterministic worlds. A world is the
// client's durable recovery (after the real 410 was released: invalidated, then snapshot pages staged hidden, then one atomic activation)
// behind a holding proxy, read by a leader and a follower. The positive controls pass for the ordinary caller (W18) and the recovery caller
// (W24); each negative is a defect a final-state-only check would miss: a partial exposure, a skipped invalidation, a stale follower, a
// delta stage W24 did not abandon, a fence cleared early, a split activation, a single-page snapshot, a foreign answer held mid-recovery.
import assert from "node:assert/strict";
import { test } from "node:test";
import { observeRecovery } from "./pair-recovery.mjs";

const OLD = "old-digest";
const NEW = "new-digest";
const REFUSAL = { seq: 40, generation: 5 };

/** A world of `pages` snapshot pages (`rows` staged by each), the first already held; `fault` injects one defect. */
function world({
  pages = 4,
  rows = 3,
  caller = "ordinary",
  fault = null,
} = {}) {
  const state = {
    cache_status: fault === "skip-invalidation" ? "valid" : "invalid",
    cursor: null,
    phase: "snapshot",
    delta_stage:
      fault === "retained-stage" ? { revision: 9, next_index: 3 } : null,
    staged: fault === "retained-stage" ? 2 : 0,
    staging: [],
    recovery_generation: 6,
    cache_digest: OLD,
    applied_revision: 8,
    gate: "refreshing",
    view: caller === "recovery" ? "fenced" : "displaying",
    notice:
      caller === "recovery" && fault !== "no-notice"
        ? { reason: "resync_required" }
        : null,
    fenced: caller === "recovery" || fault === "ordinary-fenced",
  };
  let nextSeq = 41;
  let nextProxy = 100;
  const records = [];
  const held = [];
  const releases = [];
  const observations = [];
  let page = 0;
  let splitReads = 0;
  const hold = (extra = {}) => {
    page += 1;
    const r = {
      seq: nextSeq++,
      proxy_id: nextProxy++,
      status: 200,
      phase: "snapshot",
      has_more: page < pages,
      ...extra,
    };
    records.push(r);
    held.push(r.proxy_id);
  };
  hold();
  const io = {
    held: async () => [...held],
    records: async () => records,
    release: async (_rule, proxyId) => {
      const at = held.indexOf(proxyId);
      if (at < 0) return { released: 0, outcomes: [] };
      held.splice(at, 1);
      const r = records.find((x) => x.proxy_id === proxyId);
      if (r.has_more) {
        for (let i = 0; i < rows; i += 1)
          state.staging.push({
            generation: fault === "mixed-generation" && page === 2 ? 7 : 6,
          });
        if (fault === "partial-exposure") state.cache_digest = "partly-new";
        if (fault === "early-fence-clear") state.fenced = false;
        if (fault === "foreign-held" && page === 2) {
          const f = {
            seq: nextSeq++,
            proxy_id: nextProxy++,
            status: 200,
            phase: "delta",
            has_more: false,
          };
          records.push(f);
          held.push(f.proxy_id);
        } else hold();
      } else {
        // The activation: one atomic commit (or, injected, a read that sees half of it first).
        if (fault === "split") splitReads = 1;
        else activate();
      }
      return { released: 1, outcomes: [{ outcome: "delivered" }] };
    },
    read: async (reader, o = {}) => {
      if (splitReads > 0) {
        splitReads -= 1;
        const half = {
          ...snapshot(reader),
          cache_status: "valid",
          cache_digest: NEW,
          gate: null,
        };
        activate();
        return half;
      }
      const s = snapshot(reader);
      if (
        reader === "follower" &&
        fault === "stale-follower" &&
        observations.length === 0
      )
        s.recovery_generation = 5;
      return o.rows ? { ...s, rows: [{ id: "a" }, { id: "b" }] } : s;
    },
    recordRelease: (r) => releases.push(r),
    observe: (kind, at_seq, cache_digest, detail) =>
      observations.push({ kind, at_seq, cache_digest, detail }),
    now: () => Date.now(),
    sleep: async () => undefined,
  };
  function activate() {
    Object.assign(state, {
      cache_status: "valid",
      cache_digest: NEW,
      staging: [],
      applied_revision: 12,
      gate: null,
      view: "displaying",
    });
  }
  function snapshot(reader) {
    return {
      reader,
      page: `${reader}-page`,
      cache_status: state.cache_status,
      cursor: state.cursor,
      phase: state.phase,
      delta_stage: state.delta_stage,
      staged: state.staged,
      staging_rows: state.staging.length,
      staging_generations: [
        ...new Set(state.staging.map((x) => x.generation)),
      ].sort(),
      recovery_generation: state.recovery_generation,
      cache_digest: state.cache_digest,
      applied_revision: state.applied_revision,
      gate: state.gate,
      view: state.view,
      notice: state.notice,
      fenced: state.fenced,
    };
  }
  return { io, releases, observations, records };
}
const run = (w, { caller = "ordinary", expectFinal = () => [] } = {}) =>
  observeRecovery(w.io, {
    ruleId: "r1",
    caller,
    refusal: REFUSAL,
    oldDigest: OLD,
    expectFinal,
    heldTimeoutMs: 200,
    settleTimeoutMs: 200,
  }).then(
    (value) => ({ value }),
    (error) => ({ error }),
  );

test("Q2 control, ordinary caller (W18): invalidated, staged hidden, last page held, one exposure — every page released and recorded", async () => {
  const w = world({ pages: 4 });
  const r = await run(w);
  assert.equal(r.error?.message, undefined);
  assert.deepEqual(
    w.observations.map((o) => [o.kind, o.at_seq]),
    [
      ["recovery_invalidated", 41],
      ["recovery_staged_hidden", 42],
      ["recovery_final_held", 44],
      ["recovery_exposed", 44],
    ],
  );
  assert.equal(w.releases.length, 4);
  assert.ok(w.releases.every((x) => x.outcome === "delivered"));
  for (const o of w.observations) {
    assert.equal(o.detail.leader.reader, "leader");
    assert.equal(o.detail.follower.reader, "follower");
  }
  assert.equal(w.observations[0].detail.generation_at_refusal, 5);
  assert.equal(typeof w.observations[3].detail.rows_sha256, "string");
  assert.deepEqual(r.value.pages, [41, 42, 43, 44]);
});
test("Q2 control, recovery caller (W24): the snapshot restart, the job's notice and the fence stand until the exposure", async () => {
  const w = world({ pages: 3, caller: "recovery" });
  const r = await run(w, { caller: "recovery" });
  assert.equal(r.error?.message, undefined);
  assert.equal(w.observations.length, 4);
});
test("Q2 control: the minimum, two snapshot pages (staged and last at the same held page)", async () => {
  const w = world({ pages: 2 });
  const r = await run(w);
  assert.equal(r.error?.message, undefined);
  assert.deepEqual(
    w.observations.map((o) => [o.kind, o.at_seq]),
    [
      ["recovery_invalidated", 41],
      ["recovery_staged_hidden", 42],
      ["recovery_final_held", 42],
      ["recovery_exposed", 42],
    ],
  );
});
for (const [name, opts, expected] of [
  [
    "a partial exposure while staging (the live cache changed before the activation)",
    { fault: "partial-exposure" },
    /live cache changed before the activation/,
  ],
  [
    "the invalidation skipped (the cache still valid at the first page)",
    { fault: "skip-invalidation" },
    /still shows a valid cache/,
  ],
  [
    "a stale follower (another generation)",
    { fault: "stale-follower" },
    /has no new recovery generation|does not read the leader's generation/,
  ],
  [
    "W24 did not abandon the delta stage",
    { fault: "retained-stage", caller: "recovery" },
    /keeps the abandoned delta stage/,
  ],
  [
    "the fence cleared before the snapshot was complete",
    { fault: "early-fence-clear", caller: "recovery" },
    /fence was cleared before the snapshot was complete/,
  ],
  [
    "the job did not record its server restart",
    { fault: "no-notice", caller: "recovery" },
    /did not record its server restart/,
  ],
  [
    "an ordinary caller that is fenced",
    { fault: "ordinary-fenced" },
    /an ordinary caller is fenced/,
  ],
  [
    "staged rows of two generations",
    { fault: "mixed-generation", pages: 4 },
    /not all of generation 6/,
  ],
  [
    "a split activation (valid with rows still staged)",
    { fault: "split" },
    /a split activation/,
  ],
  [
    "a single snapshot page (no hidden staging to observe)",
    { pages: 1 },
    /fewer than two snapshot pages/,
  ],
  [
    "a foreign answer held during the recovery",
    { fault: "foreign-held", pages: 4 },
    /not a snapshot page/,
  ],
])
  test(`Q2 refused: ${name}`, async () => {
    const w = world(opts);
    const r = await run(w, { caller: opts.caller ?? "ordinary" });
    assert.match(String(r.error?.message), expected);
    // Nothing is observed as exposed when the recovery was not shown to be atomic.
    assert.ok(!w.observations.some((o) => o.kind === "recovery_exposed"));
  });
test("Q2 refused: correct final content against a failing oracle is still refused", async () => {
  const w = world();
  const r = await run(w, { expectFinal: () => ["field f1 missing"] });
  assert.match(
    String(r.error?.message),
    /against the oracle: field f1 missing/,
  );
});
test("Q2 refused: an unknown caller", async () => {
  const r = await run(world(), { caller: "someone" });
  assert.match(String(r.error?.message), /unknown caller/);
});
