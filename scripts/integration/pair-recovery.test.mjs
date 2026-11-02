// WEB-09c revision 27 (R27-DIAG.b; design assessment Q2): the maintained RECOVERY OBSERVER against deterministic worlds. A world is the
// client's durable recovery (after the real 410 was released: invalidated, then snapshot pages staged hidden, then one atomic activation)
// behind a holding proxy, read by a leader and a follower. The positive controls pass for the ordinary caller (W18) and the recovery caller
// (W24); each negative is a defect a final-state-only check would miss: a partial exposure, a skipped invalidation, a stale follower, a
// delta stage W24 did not abandon, a fence cleared early, a split activation, a single-page snapshot, a foreign answer held mid-recovery.
//
// Revision 28 (R28-DIAG.b; design assessment Q2/Q3): every sample carries a separate RENDERING of its own document, shaped as
// tests/pair/support.ts `renderingOf` reports it: the session's REAL view kinds (`displaying` with its account, `neutral` with its state,
// `signed_out` …; there is no `fenced` kind), #protected-root (present, gated, mounted), the cache gate's placeholders (present, visible),
// the attachment and a document identity. The truth table holds the STORED state correct (invalid, generation, digest, staging) and changes
// only the leader's or the follower's rendering at each barrier — the invalidation, the first staged page, an intermediate page and the
// last held page — and after the activation: each must be refused for what the page shows or for an incomplete observation, never accepted
// because the stored status is invalid. The cache-valid negative stays a separate storage control.
import assert from "node:assert/strict";
import { test } from "node:test";
import { recoverySample, renderingOf } from "./pair-capture.mjs";
import {
  admissibilityProblems,
  hiddenProblems,
  holdsComplete,
  MAX_UNRESOLVED_REREADS,
  OBSERVATION_SCHEMA,
  observationProblems,
  observeRecovery,
  shownProblems,
} from "./pair-recovery.mjs";

const OLD = "old-digest";
const NEW = "new-digest";
const ACCOUNT = "acct-reader";
const REFUSAL = { seq: 40, generation: 5 };

/** The rendering the real pages show, by caller and phase (healthy). */
function healthyRendering(reader, { caller, phase, fenced }) {
  const base = {
    status: "observed",
    document: `${reader}-document`,
    attachment: reader,
  };
  if (phase === "after" && !fenced)
    return {
      ...base,
      view: { kind: "displaying", account_id: ACCOUNT, state: null },
      root: { present: true, gated: false, mounted: true },
      placeholders: { present: 0, refreshing_visible: 0 },
    };
  if (caller === "recovery")
    // The fenced recovery: the neutral state over the gated protected tree (level 0), the placeholder inert beneath it.
    return {
      ...base,
      view: { kind: "neutral", account_id: null, state: "1e.checking" },
      root: { present: true, gated: true, mounted: true },
      placeholders: { present: 1, refreshing_visible: 1 },
    };
  // The ordinary recovery: the displaying account behind the cache gate's visible refreshing placeholder.
  return {
    ...base,
    view: { kind: "displaying", account_id: ACCOUNT, state: null },
    root: { present: true, gated: false, mounted: true },
    placeholders: { present: 1, refreshing_visible: 1 },
  };
}
/** The rendering faults: each changes ONLY what a page shows (or whether it was observed), never the stored state. */
const SHAPES = {
  open: (g) => ({
    ...g,
    view: { kind: "displaying", account_id: ACCOUNT, state: null },
    root: { present: true, gated: false, mounted: true },
    placeholders: { present: 0, refreshing_visible: 0 },
  }),
  unavailable: () => ({ status: "unavailable", error: "evaluate failed" }),
  "no-view": (g) => ({ ...g, view: null }),
  "unknown-kind": (g) => ({
    ...g,
    view: { kind: "fenced", account_id: null, state: null },
  }),
  "signed-out": (g) => ({
    ...g,
    view: { kind: "signed_out", account_id: null, state: null },
    root: { present: true, gated: true, mounted: false },
  }),
  "no-root": (g) => ({
    ...g,
    root: { present: false, gated: false, mounted: false },
  }),
  "placeholder-not-visible": (g) => ({
    ...g,
    view: { kind: "displaying", account_id: ACCOUNT, state: null },
    root: { present: true, gated: false, mounted: true },
    placeholders: { present: 1, refreshing_visible: 0 },
  }),
  "neutral-root-lifted": (g) => ({
    ...g,
    view: { kind: "neutral", account_id: null, state: "1e.checking" },
    root: { present: true, gated: false, mounted: true },
    placeholders: { present: 0, refreshing_visible: 0 },
  }),
  "wrong-account": (g) => ({
    ...g,
    view: { kind: "displaying", account_id: "acct-other", state: null },
    root: { present: true, gated: false, mounted: true },
    placeholders: { present: 1, refreshing_visible: 1 },
  }),
  "wrong-attachment": (g) => ({ ...g, attachment: "none" }),
  "attachment-unavailable": (g) => ({ ...g, attachment: null }),
  "document-changed": (g) => ({ ...g, document: `${g.document}-reloaded` }),
  "leader-document": (g) => ({ ...g, document: "leader-document" }),
  "displaying-refreshing": (g) => ({
    ...g,
    view: { kind: "displaying", account_id: ACCOUNT, state: null },
    root: { present: true, gated: false, mounted: true },
    placeholders: { present: 1, refreshing_visible: 1 },
  }),
};

/**
 * A world of `pages` snapshot pages (`rows` staged by each), the first already held; `fault` injects one stored-state defect; `render`
 * {reader, at, shape} one rendering defect (at: "invalidated" page 1, "staged" page 2, "intermediate" page 3, "final" the last page, "after"
 * the activation); `fencedReadsAfter` how many reads after the activation still see the recovery fence (the recovery caller); `notShown`
 * a reader that never shows the recovered cache; `fencesUnavailable` a reader whose fences cannot be read.
 */
function world({
  pages = 4,
  rows = 3,
  caller = "ordinary",
  fault = null,
  render = null,
  fencedReadsAfter = 2,
  notShown = null,
  fencesUnavailable = null,
  shownWhileFenced = false,
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
    notice:
      caller === "recovery" && fault !== "no-notice"
        ? { reason: "resync_required" }
        : null,
    fenced: caller === "recovery" || fault === "ordinary-fenced",
    incarnation: "incarnation-1",
    activated: false,
    readsAfter: 0,
  };
  let nextSeq = 41;
  let nextProxy = 100;
  const records = [];
  const held = [];
  const releases = [];
  const observations = [];
  const reads = [];
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
  const barrierOf = () => {
    if (state.activated) return "after";
    if (page === 1) return "invalidated";
    if (page === pages) return "final";
    if (page === 2) return "staged";
    if (page === 3) return "intermediate";
    return "later";
  };
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
        };
        activate();
        return half;
      }
      if (state.activated && caller === "recovery") {
        state.readsAfter += 1;
        if (state.readsAfter > fencedReadsAfter) state.fenced = false;
      }
      const s = snapshot(reader);
      if (
        reader === "follower" &&
        fault === "stale-follower" &&
        observations.length === 0
      )
        s.recovery_generation = 5;
      reads.push({ reader, barrier: barrierOf() });
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
      activated: true,
    });
  }
  function snapshot(reader) {
    const barrier = barrierOf();
    const phase = state.activated ? "after" : "before";
    let rendering = healthyRendering(reader, {
      // Revision 29 (R29-DIAG; labelled adaptation): the stored "ordinary caller fenced" fault renders the fence's lawful hidden shape, so
      // the STORED check stays the one refusing it; displayed while fenced, the per-page fence implication refuses it first (tested below).
      caller: fault === "ordinary-fenced" ? "recovery" : caller,
      phase,
      fenced: state.fenced && !shownWhileFenced,
    });
    if (state.activated && notShown === reader)
      rendering = healthyRendering(reader, {
        caller: "ordinary",
        phase: "before",
      });
    if (render && render.reader === reader && render.at === barrier)
      rendering = SHAPES[render.shape](rendering);
    return {
      reader,
      page: `${reader}-page`,
      account: ACCOUNT,
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
      rendering,
      notice: state.notice,
      fenced: fencesUnavailable === reader ? null : state.fenced,
      // Revision 30 (C1): the separate capture brackets and the database incarnation (pair-capture.mjs `recoverySample`'s shape).
      incarnation: state.incarnation,
      capture: {
        auth:
          fencesUnavailable === reader
            ? {
                status: "unavailable",
                error: "the auth fences are not readable",
              }
            : { status: "stable" },
        storage: { status: "stable" },
      },
    };
  }
  return { io, releases, observations, records, reads, state };
}
const run = (w, { caller = "ordinary", expectFinal = () => [] } = {}) =>
  observeRecovery(w.io, {
    ruleId: "r1",
    caller,
    account: ACCOUNT,
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
      ["recovery_activated", 44],
      ["recovery_rendered", 44],
    ],
  );
  assert.equal(w.releases.length, 4);
  assert.ok(w.releases.every((x) => x.outcome === "delivered"));
  for (const o of w.observations) {
    assert.equal(o.detail.schema, OBSERVATION_SCHEMA);
    assert.equal(o.detail.leader.reader, "leader");
    assert.equal(o.detail.follower.reader, "follower");
  }
  assert.equal(w.observations[0].detail.generation_at_refusal, 5);
  assert.equal(typeof w.observations[3].detail.rows_sha256, "string");
  assert.deepEqual(r.value.pages, [41, 42, 43, 44]);
});
test("Q2 control, recovery caller (W24): the snapshot restart, the job's notice and the fence stand until the exposure", async () => {
  const w = world({ pages: 3, caller: "recovery", fencedReadsAfter: 5 });
  const r = await run(w, { caller: "recovery" });
  assert.equal(r.error?.message, undefined);
  assert.equal(w.observations.length, 5);
  // The data activation is legal while the fence still stands; the rendered settlement comes after the fence is cleared.
  const activated = w.observations.find((o) => o.kind === "recovery_activated");
  assert.equal(activated.detail.leader.fenced, true);
  assert.equal(activated.detail.leader.rendering.view.kind, "neutral");
  const rendered = w.observations.find((o) => o.kind === "recovery_rendered");
  assert.equal(rendered.detail.leader.fenced, false);
  assert.equal(rendered.detail.follower.rendering.view.kind, "displaying");
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
      ["recovery_activated", 42],
      ["recovery_rendered", 42],
    ],
  );
});
test("Q2 control (revision 28, C4): BOTH pages are read at EVERY held page, and the last held observation carries them all", async () => {
  const w = world({ pages: 6 });
  const r = await run(w);
  assert.equal(r.error?.message, undefined);
  const final = w.observations.find((o) => o.kind === "recovery_final_held");
  assert.deepEqual(
    final.detail.pages.map((p) => [p.seq, p.leader.reader, p.follower.reader]),
    [42, 43, 44, 45, 46].map((seq) => [seq, "leader", "follower"]),
  );
  for (const barrier of ["staged", "intermediate", "later", "final"])
    assert.ok(
      w.reads.some((x) => x.reader === "follower" && x.barrier === barrier),
      `the follower is read at ${barrier}`,
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
    // Nothing is observed as activated when the recovery was not shown to be atomic.
    assert.ok(!w.observations.some((o) => o.kind === "recovery_activated"));
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

// ---- revision 28 (R28-DIAG.b; design assessment Q2/Q3): the rendering truth table -------------------------------------------------------
// The stored state stays correct in every case below (invalid cache, the new generation, the old digest, one generation staged); only what
// ONE page shows, or whether it was observed, changes. Before revision 28 every hidden-barrier case was accepted by the invalid status.
const BARRIERS = [
  ["invalidated", "at the invalidation"],
  ["staged", "at the first staged page"],
  ["intermediate", "at an intermediate page (a longer snapshot)"],
  ["final", "at the last held page"],
];
// [shape, expected (ordinary), expected for the recovery caller when it differs]
const HIDDEN_FAULTS = [
  [
    "open",
    /shows the account's cache content .*\(shown\)/,
    /is displaying .*never displayed/,
  ],
  [
    "unavailable",
    /rendering was not observed \(unavailable: evaluate failed\)/,
  ],
  ["no-view", /session view is not observed/],
  ["unknown-kind", /session is fenced .*not a recovery state/],
  ["signed-out", /session is signed_out .*not a recovery state/],
  ["no-root", /protected root is not observed/],
  [
    "placeholder-not-visible",
    /placeholder_not_visible/,
    /is displaying .*never displayed/,
  ],
  ["neutral-root-lifted", /shows the protected surface/],
  ["wrong-account", /displays the account acct-other/],
  ["wrong-attachment", /attached as none, not/],
  ["attachment-unavailable", /attached as nothing, not/],
  ["document-changed", /document changed during the observation/],
];
for (const caller of ["ordinary", "recovery"])
  for (const reader of ["leader", "follower"])
    for (const [at, where] of BARRIERS)
      for (const [shape, ordinaryExpected, recoveryExpected] of HIDDEN_FAULTS) {
        const expected =
          caller === "recovery" && recoveryExpected
            ? recoveryExpected
            : ordinaryExpected;
        // A changed document needs an earlier sample of the same reader to differ from.
        if (shape === "document-changed" && at === "invalidated") continue;
        test(`Q2 refused (revision 28, ${caller}): the ${reader} ${shape} ${where}, every stored field correct`, async () => {
          const w = world({ pages: 5, caller, render: { reader, at, shape } });
          const r = await run(w, { caller });
          assert.match(String(r.error?.message), expected);
          assert.ok(
            !w.observations.some((o) => o.kind === "recovery_activated"),
            "no activation is observed after a failed hidden barrier",
          );
        });
      }
test("Q2 refused (revision 28, recovery caller): a displaying page behind the refreshing placeholder is not the fenced recovery's hidden state", async () => {
  const w = world({
    pages: 4,
    caller: "recovery",
    render: {
      reader: "follower",
      at: "staged",
      shape: "displaying-refreshing",
    },
  });
  const r = await run(w, { caller: "recovery" });
  assert.match(
    String(r.error?.message),
    /recovery caller's follower is displaying .*never displayed/,
  );
});
test("Q2 refused (revision 28): the follower reports the leader's own document", async () => {
  const w = world({
    render: { reader: "follower", at: "invalidated", shape: "leader-document" },
  });
  const r = await run(w);
  assert.match(
    String(r.error?.message),
    /the follower is the leading page's own document/,
  );
});
test("Q2 refused (revision 28): a reader whose auth fences cannot be read is incomplete, never unfenced", async () => {
  const r = await run(world({ fencesUnavailable: "follower" }));
  assert.match(
    String(r.error?.message),
    /follower's auth fences are not observed/,
  );
});
test("Q2 refused (revision 28): a read that throws is a failed observation, never a hidden one", async () => {
  const w = world();
  const read = w.io.read;
  let n = 0;
  w.io.read = async (who, o) => {
    n += 1;
    if (who === "follower" && n > 4) throw new Error("page closed");
    return read(who, o);
  };
  const r = await run(w);
  assert.match(
    String(r.error?.message),
    /the follower's read failed: page closed/,
  );
});
test("Q2 refused (revision 28): a sample of another account", async () => {
  const w = world();
  const read = w.io.read;
  w.io.read = async (who, o) => ({ ...(await read(who, o)), account: "x" });
  const r = await run(w);
  assert.match(String(r.error?.message), /read the account x, not acct-reader/);
});
// After the activation (C5): the activation is legal before display; both pages must then SHOW it, and nothing else may be seen meanwhile.
test("Q3 refused (revision 28): the follower never shows the recovered cache (a leader-only display check would pass)", async () => {
  const w = world({ notShown: "follower" });
  const r = await run(w);
  assert.match(
    String(r.error?.message),
    /recovered cache was not shown within 200 ms \(follower does not show the recovered cache \(refreshing\)\)/,
  );
  assert.ok(w.observations.some((o) => o.kind === "recovery_activated"));
  assert.ok(!w.observations.some((o) => o.kind === "recovery_rendered"));
});
test("Q3 refused (revision 28): the leader never shows the recovered cache", async () => {
  const r = await run(world({ notShown: "leader" }));
  assert.match(
    String(r.error?.message),
    /leader does not show the recovered cache/,
  );
});
test("Q3 refused (revision 28): a page signed out after the activation is not a recovery", async () => {
  const w = world({
    render: { reader: "follower", at: "after", shape: "signed-out" },
  });
  const r = await run(w);
  assert.match(
    String(r.error?.message),
    /session is signed_out .*not a recovery state/,
  );
});
test("Q3 refused (revision 28): an unavailable rendering after the activation", async () => {
  const w = world({
    render: { reader: "leader", at: "after", shape: "unavailable" },
  });
  const r = await run(w);
  assert.match(String(r.error?.message), /leader's rendering was not observed/);
});
test("Q3 refused (revision 28, recovery caller): the recovered cache shown while the recovery fence stands", async () => {
  const w = world({
    caller: "recovery",
    pages: 3,
    fencedReadsAfter: 100,
    shownWhileFenced: true,
  });
  const r = await run(w, { caller: "recovery" });
  assert.match(
    String(r.error?.message),
    /shown while the recovery fence stands/,
  );
});
test("Q3 control (revision 28, recovery caller): the fence standing through several reads after the activation is legal; no exposure is demanded early", async () => {
  const w = world({ caller: "recovery", pages: 3, fencedReadsAfter: 9 });
  const r = await run(w, { caller: "recovery" });
  assert.equal(r.error?.message, undefined);
  assert.ok(w.reads.filter((x) => x.barrier === "after").length > 9);
});
test("Q3 refused (revision 28, recovery caller): a fence never cleared never reaches the rendered settlement (bounded, no deadlock)", async () => {
  const w = world({ caller: "recovery", pages: 3, fencedReadsAfter: 1e9 });
  const r = await run(w, { caller: "recovery" });
  assert.match(String(r.error?.message), /was not shown within 200 ms/);
});

// The pure rules on their own, for the reader-parity table (pair-evidence.test.mjs applies the same shapes to the interval reader).
test("Q2 rules (revision 28): hidden/shown are judged from the rendering alone, never from the stored status", () => {
  const sample = (rendering, extra = {}) => ({
    reader: "leader",
    account: ACCOUNT,
    cache_status: "invalid",
    fenced: false,
    incarnation: "incarnation-1",
    capture: { auth: { status: "stable" }, storage: { status: "stable" } },
    rendering,
    ...extra,
  });
  const ordinary = healthyRendering("leader", {
    caller: "ordinary",
    phase: "before",
  });
  const fenced = healthyRendering("leader", {
    caller: "recovery",
    phase: "before",
  });
  const shown = healthyRendering("leader", {
    caller: "ordinary",
    phase: "after",
  });
  assert.deepEqual(
    observationProblems(sample(ordinary), { account: ACCOUNT }),
    [],
  );
  assert.deepEqual(
    hiddenProblems(sample(ordinary), { caller: "ordinary", what: "x" }),
    [],
  );
  assert.deepEqual(
    hiddenProblems(sample(fenced), { caller: "recovery", what: "x" }),
    [],
  );
  assert.deepEqual(
    hiddenProblems(sample(fenced), { caller: "ordinary", what: "x" }),
    [],
  );
  assert.equal(
    hiddenProblems(sample(ordinary), { caller: "recovery", what: "x" }).length,
    1,
  );
  assert.equal(
    hiddenProblems(sample(shown), { caller: "ordinary", what: "x" }).length,
    1,
  );
  assert.equal(
    hiddenProblems(sample(shown, { cache_status: "invalid" }), {
      caller: "ordinary",
      what: "x",
    }).length,
    1,
  );
  assert.deepEqual(shownProblems(sample(shown)), []);
  assert.equal(shownProblems(sample(ordinary)).length, 1);
  assert.equal(
    hiddenProblems(sample({ status: "unavailable", error: "e" }), {
      caller: "ordinary",
      what: "x",
    }).length,
    1,
  );
  assert.equal(
    shownProblems(sample({ status: "unavailable", error: "e" })).length,
    1,
  );
});

// ---- revision 29 (R29-DIAG; design assessment Q1-Q5): each page's rendering against its OWN fence, at EVERY read -----------------------
// Revision 28 published `recovery_activated` from stored completeness alone and checked the fence only when BOTH pages were shown; a page
// displayed while fenced was accepted when it was hidden again before the settlement, or while its peer was still hidden (the review's
// settlement probe). Every case below keeps the stored state correct and injects ONE page's forbidden rendering at ONE read, restoring the
// lawful shape at once (a fault left standing until the end could be caught later for the wrong reason).
const NEUTRAL = healthyRendering("x", { caller: "recovery", phase: "before" });
const REFRESHING = healthyRendering("x", {
  caller: "ordinary",
  phase: "before",
});
const SHOWN = healthyRendering("x", { caller: "ordinary", phase: "after" });
const R29_SHAPES = {
  "neutral-hidden": NEUTRAL,
  shown: SHOWN,
  "displaying-refreshing": REFRESHING,
  "placeholder-not-visible": SHAPES["placeholder-not-visible"](SHOWN),
  unavailable: SHAPES.unavailable(),
};
// [shape, fenced] → admissible before (ordinary caller), before (recovery caller), after (either caller)
const TRUTH = [
  ["neutral-hidden", false, true, true, true],
  ["neutral-hidden", true, true, true, true],
  ["shown", false, false, false, true],
  ["shown", true, false, false, false],
  ["displaying-refreshing", false, true, false, true],
  ["displaying-refreshing", true, false, false, false],
  ["placeholder-not-visible", false, false, false, false],
  ["placeholder-not-visible", true, false, false, false],
  ["unavailable", false, false, false, false],
  ["unavailable", true, false, false, false],
];
test("R29 Q1: the per-page admissibility truth table (both readers, both callers, fenced or not, before/after the complete replacement)", () => {
  for (const reader of ["leader", "follower"])
    for (const [
      shape,
      fenced,
      ordinaryBefore,
      recoveryBefore,
      after,
    ] of TRUTH) {
      const base = {
        reader,
        account: ACCOUNT,
        fenced,
        rendering: { ...R29_SHAPES[shape], document: `${reader}-document` },
      };
      const before = { ...base, cache_status: "invalid", staging_rows: 3 };
      const done = { ...base, cache_status: "valid", staging_rows: 0 };
      const ok = (r, caller, phase) =>
        admissibilityProblems(r, { caller, phase, what: "x" }).length === 0;
      const name = `${reader} ${shape} fenced=${fenced}`;
      assert.equal(
        ok(before, "ordinary", "before_activation"),
        ordinaryBefore,
        `${name} before, ordinary`,
      );
      assert.equal(
        ok(before, "recovery", "before_activation"),
        recoveryBefore,
        `${name} before, recovery`,
      );
      for (const caller of ["ordinary", "recovery"]) {
        assert.equal(
          ok(done, caller, "after_activation"),
          after,
          `${name} after, ${caller}`,
        );
        // `activation` judges each poll by the stored state it holds.
        assert.equal(
          ok(done, caller, "activation"),
          after,
          `${name} activation complete, ${caller}`,
        );
        assert.equal(
          ok(before, caller, "activation"),
          caller === "ordinary" ? ordinaryBefore : recoveryBefore,
          `${name} activation staged, ${caller}`,
        );
      }
    }
  // A shown page while fenced names the fence; unreadable fences are never unfenced; an unknown phase is a harness error.
  const fencedShown = {
    reader: "follower",
    account: ACCOUNT,
    fenced: true,
    cache_status: "valid",
    staging_rows: 0,
    rendering: { ...SHOWN, document: "d" },
  };
  assert.match(
    admissibilityProblems(fencedShown, {
      caller: "ordinary",
      phase: "after_activation",
      what: "x",
    }).join(),
    /follower is shown while the recovery fence stands/,
  );
  assert.match(
    admissibilityProblems(
      { ...fencedShown, fenced: null },
      { caller: "ordinary", phase: "after_activation", what: "x" },
    ).join(),
    /auth fences x were not observed/,
  );
  assert.throws(
    () =>
      admissibilityProblems(fencedShown, {
        caller: "ordinary",
        phase: "later",
        what: "x",
      }),
    /unknown admissibility phase/,
  );
  assert.equal(holdsComplete({ cache_status: "valid", staging_rows: 0 }), true);
  assert.equal(
    holdsComplete({ cache_status: "valid", staging_rows: 1 }),
    false,
  );
});

/**
 * Wraps a world's reads after the activation: `at(n, reader, sample)` sees the n-th read after the commit (1: the first complete leader
 * poll, 2: the complete follower, 3: the leader's row-bearing read, 4…: the settlement polls, leader then follower) and may change it.
 */
function afterActivation(w, at) {
  const read = w.io.read;
  const seen = [];
  let n = 0;
  w.io.read = async (who, o) => {
    const r = await read(who, o);
    if (!w.state.activated) return r;
    n += 1;
    const changed = at(n, who, r, o) ?? r;
    seen.push({
      n,
      reader: who,
      rows: Boolean(o?.rows),
      fenced: changed.fenced,
      shape: changed.rendering?.view?.kind,
    });
    return changed;
  };
  return seen;
}
const asShown = (r) => ({
  ...r,
  rendering: {
    ...r.rendering,
    ...SHOWN,
    document: r.rendering.document,
    attachment: r.rendering.attachment,
  },
});
const asRefreshing = (r) => ({
  ...r,
  rendering: {
    ...r.rendering,
    ...REFRESHING,
    document: r.rendering.document,
    attachment: r.rendering.attachment,
  },
});
const FORBIDDEN = { shown: asShown, "displaying-refreshing": asRefreshing };
const ACTIVATION_READS = [
  [1, "leader", "the first complete leader poll"],
  [2, "follower", "the complete follower read"],
  [3, "leader", "the leader's row-bearing read"],
];
for (const caller of ["recovery", "ordinary"])
  for (const [n, reader, where] of ACTIVATION_READS)
    for (const [shape, change] of Object.entries(FORBIDDEN))
      test(`R29 Q2 refused (${caller}): the ${reader} ${shape} while fenced at ${where} only, lawful again at once`, async () => {
        const w = world({ caller, pages: 3, fencedReadsAfter: 30 });
        const seen = afterActivation(w, (i, _who, r) =>
          // The ordinary caller is never fenced; the injected fence is the auth observation alone (storage untouched).
          i === n ? change({ ...r, fenced: true }) : undefined,
        );
        assert.equal(seen.length, 0);
        const r = await run(w, { caller });
        assert.match(
          String(r.error?.message),
          new RegExp(
            `the ${reader}'s page is not admissible: ${reader} is (shown|displaying \\(refreshing\\)) while the recovery fence stands`,
          ),
        );
        assert.equal(
          seen.at(-1).n,
          n,
          "it fails AT that read, before any later one",
        );
        assert.equal(seen.at(-1).reader, reader);
        assert.ok(
          !w.observations.some((o) => o.kind === "recovery_activated"),
          "no activation is published",
        );
        assert.ok(!w.observations.some((o) => o.kind === "recovery_rendered"));
      });
test("R29 Q2 refused: the row-bearing read holding staged rows again (digest unchanged) is judged in full itself", async () => {
  const w = world({ pages: 3 });
  afterActivation(w, (i, _who, r) =>
    i === 3 ? { ...r, staging_rows: 1 } : undefined,
  );
  const r = await run(w);
  assert.match(
    String(r.error?.message),
    /the leader's row-bearing read after the activation: leader still holds staged rows/,
  );
  assert.ok(!w.observations.some((o) => o.kind === "recovery_activated"));
});
test("R29 Q2 control (recovery caller): complete data while fenced and HIDDEN at every activation read is legal", async () => {
  const w = world({ caller: "recovery", pages: 3, fencedReadsAfter: 6 });
  const seen = afterActivation(w, () => undefined);
  const r = await run(w, { caller: "recovery" });
  assert.equal(r.error?.message, undefined);
  assert.deepEqual(
    seen.slice(0, 3).map((x) => [x.reader, x.fenced, x.shape]),
    [
      ["leader", true, "neutral"],
      ["follower", true, "neutral"],
      ["leader", true, "neutral"],
    ],
  );
  const activated = w.observations.find((o) => o.kind === "recovery_activated");
  assert.equal(activated.detail.leader.fenced, true);
  assert.ok(w.observations.some((o) => o.kind === "recovery_rendered"));
});

// Q3: asymmetric settlement. The settlement reads begin at n = 4 (leader 4, follower 5, leader 6 …).
const SETTLEMENT = { leader: 4, follower: 5 };
for (const reader of ["leader", "follower"]) {
  test(`R29 Q3 refused (recovery caller): the ${reader} shown while fenced for ONE settlement sample, its peer hidden, then lawful`, async () => {
    const w = world({ caller: "recovery", pages: 3, fencedReadsAfter: 12 });
    const seen = afterActivation(w, (i, who, r) =>
      i === SETTLEMENT[reader] + 2 && who === reader ? asShown(r) : undefined,
    );
    const r = await run(w, { caller: "recovery" });
    assert.match(
      String(r.error?.message),
      new RegExp(
        `the ${reader}'s page is not admissible: ${reader} is shown while the recovery fence stands`,
      ),
    );
    assert.equal(
      seen.at(-1).n,
      SETTLEMENT[reader] + 2,
      "the FIRST bad sample fails; nothing later is read",
    );
    const peer = seen.find((x) => x.reader !== reader && x.n > 3);
    assert.equal(peer.shape, "neutral", "its peer was hidden");
    assert.ok(!w.observations.some((o) => o.kind === "recovery_rendered"));
  });
  test(`R29 Q3 refused (recovery caller): the ${reader} shown while fenced for several samples while its peer stays hidden`, async () => {
    const w = world({ caller: "recovery", pages: 3, fencedReadsAfter: 12 });
    const seen = afterActivation(w, (i, who, r) =>
      i > 3 && who === reader ? asShown(r) : undefined,
    );
    const r = await run(w, { caller: "recovery" });
    assert.match(
      String(r.error?.message),
      /is shown while the recovery fence stands/,
    );
    assert.equal(
      seen.at(-1).n,
      SETTLEMENT[reader],
      "refused at the first settlement sample",
    );
  });
  test(`R29 Q3 refused (recovery caller): the ${reader} displaying behind the placeholder while fenced (not the recovery-hidden shape)`, async () => {
    const w = world({ caller: "recovery", pages: 3, fencedReadsAfter: 12 });
    afterActivation(w, (i, who, r) =>
      i === SETTLEMENT[reader] && who === reader ? asRefreshing(r) : undefined,
    );
    const r = await run(w, { caller: "recovery" });
    assert.match(
      String(r.error?.message),
      new RegExp(
        `${reader}'s page is not admissible: ${reader} is displaying \\(refreshing\\) while the recovery fence stands`,
      ),
    );
  });
  test(`R29 Q3 control (recovery caller): the ${reader} renders FIRST, only after its own fence cleared; the peer stays fenced and hidden`, async () => {
    const w = world({ caller: "recovery", pages: 3, fencedReadsAfter: 1e9 });
    const clearAt = {
      [reader]: SETTLEMENT[reader],
      [reader === "leader" ? "follower" : "leader"]: SETTLEMENT[reader] + 6,
    };
    const seen = afterActivation(w, (i, who, r) =>
      i >= clearAt[who] ? asShown({ ...r, fenced: false }) : undefined,
    );
    const r = await run(w, { caller: "recovery" });
    assert.equal(r.error?.message, undefined);
    const first = seen.find((x) => x.shape === "displaying");
    assert.equal(first.reader, reader);
    assert.ok(
      seen.some(
        (x) =>
          x.n > first.n &&
          x.reader !== reader &&
          x.fenced === true &&
          x.shape === "neutral",
      ),
      "the peer was still fenced and hidden afterwards",
    );
    const rendered = w.observations.find((o) => o.kind === "recovery_rendered");
    assert.equal(rendered.detail.leader.fenced, false);
    assert.equal(rendered.detail.follower.fenced, false);
  });
  test(`R29 Q3 control (recovery caller): the ${reader} unfenced but still behind the refreshing placeholder while it waits`, async () => {
    const w = world({ caller: "recovery", pages: 3, fencedReadsAfter: 1e9 });
    afterActivation(w, (i, who, r) => {
      if (who !== reader)
        return i >= 9 ? asShown({ ...r, fenced: false }) : undefined;
      if (i >= 9) return asShown({ ...r, fenced: false });
      return i >= 4 ? asRefreshing({ ...r, fenced: false }) : undefined;
    });
    const r = await run(w, { caller: "recovery" });
    assert.equal(r.error?.message, undefined);
  });
  test(`R29 Q5 refused: the ${reader}'s document replaced after the activation (a reload is a new observation, never this one)`, async () => {
    const w = world({ pages: 3 });
    afterActivation(w, (i, who, r) =>
      i >= SETTLEMENT[reader] && who === reader
        ? {
            ...r,
            rendering: {
              ...r.rendering,
              document: `${r.rendering.document}-reloaded`,
            },
          }
        : undefined,
    );
    const r = await run(w);
    assert.match(
      String(r.error?.message),
      new RegExp(`the ${reader}'s document changed during the observation`),
    );
    assert.ok(!w.observations.some((o) => o.kind === "recovery_rendered"));
  });
}
test("R29 Q3 refused (ordinary caller): a page shown while an (unexpected) fence stands is refused whatever its peer shows", async () => {
  const w = world({ pages: 3 });
  afterActivation(w, (i, who, r) =>
    i === 5 && who === "follower" ? { ...r, fenced: true } : undefined,
  );
  const r = await run(w);
  assert.match(
    String(r.error?.message),
    /follower is shown while the recovery fence stands/,
  );
});
test("R29 Q5 refused (ordinary caller): a follower displaying behind the placeholder while fenced BEFORE the activation", async () => {
  const w = world({ pages: 4 });
  const read = w.io.read;
  let n = 0;
  w.io.read = async (who, o) => {
    const r = await read(who, o);
    if (who === "follower" && ++n === 2) return { ...r, fenced: true };
    return r;
  };
  const r = await run(w);
  assert.match(
    String(r.error?.message),
    /follower is displaying \(refreshing\) while the recovery fence stands/,
  );
});

// ---- revision 30 (R30-DIAG; design assessment C1-C5, Q2-Q5): the COMPOSED capture → sample → observer chain --------------------------
// Revision 29's own coherence tests (kept in its history, restated here) gave the observer already-merged samples: a storage-only change
// was modelled as `fenced: null`, but the real adapter kept `fenced: true` and only merged the storage outcome into `coherent: false`. Each
// layer passed while their composition discarded a stable fenced exposure or an unavailable rendering (the review's coherence probe). Below,
// every read of the deterministic world goes through the MAINTAINED pair-capture.mjs `recoverySample` and `renderingOf`/`captureInPage`
// (the in-page function runs against doubled `window`/`document`), and only the IO is doubled: the two raw stored reads, the auth records
// the page reads before and after its capture, and the DOM. Injected faults are labelled test interventions; they demonstrate the
// harness's sensitivity, never product exposure.
const FENCE = [{ kind: "invalid_session", seq: 8 }];
/** A doubled page: `evaluate(captureInPage, account)` runs the real page function with doubled globals built from `spec`. */
function pageDouble(spec) {
  return {
    evaluate: async (fn, account) => {
      if (spec.evaluateThrows) throw new Error(spec.evaluateThrows);
      const g = spec.rendering;
      let fenceReads = 0;
      const saved = {
        window: globalThis.window,
        document: globalThis.document,
      };
      globalThis.window = {
        __pairDocument: g.document,
        __s: spec.noView
          ? undefined
          : { view: { get: () => structuredClone(g.view) } },
        __atlasFixture: {
          session: {
            leader: () =>
              spec.noAttachment
                ? null
                : { attachment: g.attachment, notice: spec.notice },
            readRecords: async () => {
              const fenced = spec.fences[Math.min(fenceReads, 1)];
              fenceReads += 1;
              if (fenced === "throw")
                throw new Error("the auth store is closed");
              return {
                auth_state: { fences: { [account]: fenced ? FENCE : [] } },
              };
            },
          },
        },
      };
      globalThis.document = {
        getElementById: (id) =>
          id === "protected-root" && g.root.present
            ? {
                hasAttribute: (k) => k === "inert" && g.root.gated,
                getAttribute: (k) =>
                  k === "aria-hidden" && g.root.gated ? "true" : null,
                childElementCount: g.root.mounted ? 1 : 0,
                querySelectorAll: () =>
                  Array.from({ length: g.placeholders.present }, (_, i) => ({
                    getBoundingClientRect: () => ({ width: 100, height: 20 }),
                    getAttribute: () => "refreshing",
                    checkVisibility: () =>
                      i < g.placeholders.refreshing_visible,
                  })),
              }
            : null,
      };
      try {
        return await fn(account);
      } finally {
        globalThis.window = saved.window;
        globalThis.document = saved.document;
      }
    },
  };
}
const STORED_KEYS = (s) => {
  const {
    reader: _r,
    page: _p,
    account: _a,
    rendering: _g,
    notice: _n,
    fenced: _f,
    capture: _c,
    ...stored
  } = s;
  return stored;
};
/**
 * Routes EVERY read of world `w` through the maintained composition. `plan(ctx)` may return a change for one capture: `rendering`
 * (replaces what the page shows), `fences` ([before, after]: true/false/"throw"), `storageAfter` (fields of the second stored read),
 * `storageThrows`, `storageGone`, `noView`, `noAttachment`, `evaluateThrows`. ctx: {n (the read number of this reader), who, barrier,
 * after (the read number after the activation, as `afterActivation` numbers them, or 0), sample (the world's lawful sample)}.
 * Returns the log of every capture: the composed sample and the change applied.
 */
function composed(w, plan = () => null) {
  const read = w.io.read;
  const log = [];
  const perReader = { leader: 0, follower: 0 };
  let afterN = 0;
  w.io.read = async (who, o = {}) => {
    const s = await read(who, o);
    perReader[who] += 1;
    if (w.state.activated) afterN += 1;
    const ctx = {
      n: perReader[who],
      who,
      barrier: w.reads.at(-1).barrier,
      after: w.state.activated ? afterN : 0,
      sample: s,
    };
    const change = plan(ctx) ?? {};
    const before = {
      ...STORED_KEYS(s),
      composition_seq: 10,
      ...(change.storageBefore ?? {}),
    };
    const after = {
      ...STORED_KEYS(s),
      composition_seq: 10,
      ...(change.storageAfter ?? {}),
    };
    delete after.rows;
    let storedReads = 0;
    const spec = {
      rendering: change.rendering ?? s.rendering,
      fences: change.fences ?? [s.fenced, s.fenced],
      notice: s.notice,
      noView: change.noView,
      noAttachment: change.noAttachment,
      evaluateThrows: change.evaluateThrows,
    };
    const out = await recoverySample(
      {
        stored: async () => {
          storedReads += 1;
          if (storedReads === 1) return structuredClone(before);
          if (change.storageThrows) throw new Error(change.storageThrows);
          return change.storageGone ? null : structuredClone(after);
        },
        rendering: () => renderingOf(pageDouble(spec), s.account),
      },
      { reader: who, page: s.page, account: s.account, rows: Boolean(o.rows) },
    );
    log.push({
      ...ctx,
      change: Object.keys(change),
      out: structuredClone(out),
    });
    return out;
  };
  const failures = [];
  w.io.failed = (f) => failures.push(f);
  return { log, failures };
}
const OPEN = (g) => ({ ...g, ...SHAPES.open(g) });
const R30_VARIANTS = {
  "healthy, stable storage": { change: () => ({}), refused: null },
  "healthy, changed storage": {
    change: () => ({ storageAfter: { composition_seq: 11 } }),
    refused: null,
  },
  "fenced exposure, stable storage": {
    change: (s) => ({ rendering: OPEN(s.rendering), fences: [true, true] }),
    refused: /is shown while the recovery fence stands/,
  },
  "the same fenced exposure, changed storage": {
    change: (s) => ({
      rendering: OPEN(s.rendering),
      fences: [true, true],
      storageAfter: { composition_seq: 11 },
    }),
    refused: /is shown while the recovery fence stands/,
  },
  "unavailable rendering, stable storage": {
    change: () => ({ noView: true }),
    refused:
      /rendering was not observed \(unavailable: the session view is not readable\)/,
  },
  "the same unavailable rendering, changed storage": {
    change: () => ({ noView: true, storageAfter: { composition_seq: 11 } }),
    refused:
      /rendering was not observed \(unavailable: the session view is not readable\)/,
  },
};
// Q2: the review's six variants for each page, at that page's FIRST read after the commit while its fence stands (the recovery caller's
// complete-but-fenced activation): the leader's first complete poll (after = 1) and the follower's complete read (after = 2).
for (const [who, at] of [
  ["leader", 1],
  ["follower", 2],
])
  for (const [name, v] of Object.entries(R30_VARIANTS))
    test(`R30 Q2 composed (recovery caller, ${who}): ${name}`, async () => {
      const w = world({ caller: "recovery", pages: 3, fencedReadsAfter: 9 });
      const { log, failures } = composed(w, (c) =>
        c.after === at ? v.change(c.sample) : null,
      );
      const r = await run(w, { caller: "recovery" });
      const injected = log.find((x) => x.after === at);
      assert.equal(injected.who, who);
      assert.equal(
        injected.sample.fenced,
        true,
        "the page's fence stands at the injected capture",
      );
      if (v.refused === null) {
        assert.equal(r.error?.message, undefined);
        assert.ok(w.observations.some((o) => o.kind === "recovery_rendered"));
        const changed = name.includes("changed storage");
        assert.equal(
          injected.out.capture.storage.status,
          changed ? "changed" : "stable",
        );
        // A changed capture is re-read, and the read that ends it counts it by cause; a stable one is used at once.
        const next = log[log.indexOf(injected) + 1];
        if (changed) {
          assert.equal(next.who, who, "the same reader is read again");
          assert.equal(next.out.capture.storage.status, "stable");
        } else
          assert.notEqual(next.who, who, "a stable capture is used at once");
        if (who === "follower") {
          const activated = w.observations.find(
            (o) => o.kind === "recovery_activated",
          );
          assert.deepEqual(
            activated.detail.follower.rereads,
            changed
              ? { total: 1, auth: 0, storage: 1 }
              : { total: 0, auth: 0, storage: 0 },
          );
        }
        return;
      }
      assert.match(String(r.error?.message), v.refused);
      assert.equal(
        log.at(-1),
        injected,
        "it fails AT the injected capture: the later healthy sample is never read",
      );
      assert.ok(
        !w.observations.some((o) => o.kind === "recovery_activated"),
        "no activation is published",
      );
      assert.ok(!w.observations.some((o) => o.kind === "recovery_rendered"));
      // The first failure's facts (C3): this page, this phase, both bracket outcomes as captured.
      assert.equal(failures.length, 1);
      const f = failures[0].capture;
      assert.equal(f.reader, who);
      assert.equal(f.read, 1);
      assert.equal(
        f.capture.storage.status,
        name.includes("changed storage") ? "changed" : "stable",
      );
      if (name.includes("changed storage"))
        assert.deepEqual(f.capture.storage.fields, ["composition_seq"]);
      // The rendering's unavailability leaves the auth bracket standing on its own (a separate outcome).
      assert.equal(f.capture.auth.status, "stable");
      assert.equal(
        r.error.capture,
        f,
        "the thrown error carries the same facts",
      );
    });

// Q3: every observer read site, both pages, both callers — inject ONE independently established fault at ONE capture (the IO is lawful
// again at once), with the stored state stable or moving across that capture. Each must be refused AT that capture, before any later read
// and with no later milestone. The sites: the held pages (the invalidation, the first staged, an intermediate and the last held page) for
// each reader; then the leader's first complete activation poll (after 1), the follower's complete read (2), the leader's row-bearing read
// (3) and the first settlement poll of each side (4 leader, 5 follower).
const HELD_SITES = ["invalidated", "staged", "intermediate", "final"].flatMap(
  (barrier) =>
    ["leader", "follower"].map((who) => ({
      who,
      barrier,
      name: `${who} at the ${barrier} page`,
    })),
);
const AFTER_SITES = [
  {
    who: "leader",
    after: 1,
    name: "leader at the first complete activation poll",
  },
  { who: "follower", after: 2, name: "follower at its complete read" },
  { who: "leader", after: 3, name: "leader at its row-bearing read" },
  { who: "leader", after: 4, name: "leader at its first settlement poll" },
  { who: "follower", after: 5, name: "follower at its first settlement poll" },
];
const lawfulAs = (g, shape) => ({
  ...g,
  ...shape,
  document: g.document,
  attachment: g.attachment,
});
const SITE_FAULTS = {
  "stable fence, open surface": {
    change: (s) => ({ rendering: OPEN(s.rendering), fences: [true, true] }),
    refused: /page is not admissible/,
  },
  "stable fence, displaying behind the refreshing placeholder": {
    change: (s) => ({
      rendering: lawfulAs(s.rendering, REFRESHING),
      fences: [true, true],
    }),
    refused: /page is not admissible/,
  },
  "stable fence, displaying over a gated tree": {
    change: (s) => ({
      rendering: lawfulAs(s.rendering, {
        view: { kind: "displaying", account_id: ACCOUNT, state: null },
        root: { present: true, gated: true, mounted: true },
        placeholders: { present: 1, refreshing_visible: 1 },
      }),
      fences: [true, true],
    }),
    refused: /page is not admissible/,
  },
  "no session view (unavailable)": {
    change: () => ({ noView: true }),
    refused:
      /rendering was not observed \(unavailable: the session view is not readable\)/,
  },
  "no data attachment (unavailable)": {
    change: () => ({ noAttachment: true }),
    refused:
      /rendering was not observed \(unavailable: the page's data attachment is not readable\)/,
  },
  "the page cannot be evaluated (closed)": {
    change: () => ({
      evaluateThrows: "Target page, context or browser has been closed",
    }),
    refused:
      /rendering was not observed \(unavailable: Target page, context or browser has been closed\)/,
  },
  "another account displayed": {
    change: (s) => ({
      rendering: lawfulAs(s.rendering, SHAPES["wrong-account"](s.rendering)),
    }),
    refused: /displays the account acct-other, not acct-reader/,
  },
  "the wrong role": {
    change: (s) => ({ rendering: { ...s.rendering, attachment: "none" } }),
    refused: /page is attached as none, not/,
  },
  "the document replaced": {
    change: (s) => ({
      rendering: {
        ...s.rendering,
        document: `${s.rendering.document}-reloaded`,
      },
    }),
    refused: /document changed during the observation \(reloaded or replaced\)/,
    skip: (_site, c) => c.n === 1,
  },
  "the peer's document": {
    change: (s, who) => ({
      rendering: {
        ...s.rendering,
        document: who === "leader" ? "follower-document" : "leader-document",
      },
    }),
    // At a reader's first read the peer check refuses it; later, its own document's continuity is checked first (also an identity fault).
    refused: (c) =>
      c.n === 1
        ? /the follower is the leading page's own document/
        : /document changed during the observation \(reloaded or replaced\)/,
    skip: (site) => site.who === "leader" && site.barrier === "invalidated",
  },
  "unreadable auth fences": {
    change: () => ({ fences: ["throw", "throw"] }),
    refused: /auth fences are not observed \(the auth store is closed\)/,
  },
  "the second stored read fails": {
    change: () => ({ storageThrows: "the transaction was aborted" }),
    refused:
      /stored state was not read again \(the stored state could not be read again: the transaction was aborted\)/,
    storage: false,
  },
  "the database is gone at the second read": {
    change: () => ({ storageGone: true }),
    refused:
      /stored state was not read again \(the account database was not found at the second read\)/,
    storage: false,
  },
  "another database incarnation at the second read": {
    change: () => ({ storageAfter: { incarnation: "incarnation-2" } }),
    refused: /account database was replaced during the sample/,
    storage: false,
  },
};
for (const caller of ["ordinary", "recovery"])
  for (const site of [...HELD_SITES, ...AFTER_SITES])
    for (const [fault, f] of Object.entries(SITE_FAULTS))
      for (const moving of f.storage === false ? [false] : [false, true])
        test(`R30 Q3 composed refused (${caller}): ${fault} — ${site.name}${moving ? ", the stored state moving across it" : ""}`, async () => {
          const w = world({ caller, pages: 5, fencedReadsAfter: 3 });
          let at = null;
          let skipped = false;
          const { log, failures } = composed(w, (c) => {
            if (at !== null || c.who !== site.who) return null;
            if (
              site.after
                ? c.after !== site.after
                : c.after !== 0 || c.barrier !== site.barrier
            )
              return null;
            if (f.skip?.(site, c)) {
              skipped = true;
              return null;
            }
            at = { ctx: c, observed: w.observations.length };
            const change = f.change(c.sample, c.who);
            return moving
              ? {
                  ...change,
                  storageAfter: {
                    composition_seq: 11,
                    ...(change.storageAfter ?? {}),
                  },
                }
              : change;
          });
          const r = await run(w, { caller });
          if (skipped) {
            assert.equal(
              r.error?.message,
              undefined,
              "a site where the fault cannot exist stays a healthy run",
            );
            return;
          }
          assert.ok(at, "the site was read");
          assert.match(
            String(r.error?.message),
            typeof f.refused === "function" ? f.refused(at.ctx) : f.refused,
          );
          assert.equal(log.at(-1).n, at.ctx.n, "refused AT that capture");
          assert.equal(log.at(-1).who, site.who);
          assert.equal(
            w.observations.length,
            at.observed,
            "no milestone after the injected capture",
          );
          assert.equal(failures.length, 1, "one first failure, recorded once");
          if (moving)
            assert.equal(failures[0].capture.capture.storage.status, "changed");
        });

// Q4: LAWFUL transitions are re-read (bounded, counted by cause), never refused and never published mixed; identity lost during a re-read is
// refused. `SHOWN_AS`/`NEUTRAL_AS` keep the reader's own document and attachment.
const SHOWN_AS = (g) => lawfulAs(g, SHOWN);
const NEUTRAL_AS = (g) => lawfulAs(g, NEUTRAL);
const resolvedEverywhere = (w) =>
  w.observations
    .flatMap((o) => [
      o.detail.leader,
      o.detail.follower,
      ...(o.detail.pages ?? []).flatMap((p) => [p.leader, p.follower]),
    ])
    .every(
      (x) =>
        x.capture.auth.status === "stable" &&
        x.capture.storage.status === "stable",
    );
test("R30 Q4 control (recovery caller): the fence clears DURING one settlement capture (hidden) — re-read, counted as auth, then lawful", async () => {
  const w = world({ caller: "recovery", pages: 3, fencedReadsAfter: 3 });
  const { log } = composed(w, (c) =>
    c.after === 4
      ? { fences: [true, false], rendering: NEUTRAL_AS(c.sample.rendering) }
      : null,
  );
  const r = await run(w, { caller: "recovery" });
  assert.equal(r.error?.message, undefined);
  const changed = log.find((x) => x.after === 4);
  assert.equal(changed.out.capture.auth.status, "changed");
  assert.equal(
    changed.out.fenced,
    null,
    "the indeterminate fence is never paired with the later DOM",
  );
  assert.equal(
    log[log.indexOf(changed) + 1].who,
    "leader",
    "the same page is read again",
  );
  assert.ok(
    resolvedEverywhere(w),
    "no milestone records an unresolved capture",
  );
});
test("R30 Q4 control (recovery caller): the fence clears DURING a capture that already SHOWS the page — admissible unfenced, re-read", async () => {
  const w = world({ caller: "recovery", pages: 3, fencedReadsAfter: 3 });
  composed(w, (c) =>
    c.after === 5
      ? { fences: [true, false], rendering: SHOWN_AS(c.sample.rendering) }
      : null,
  );
  const r = await run(w, { caller: "recovery" });
  assert.equal(r.error?.message, undefined);
  const rendered = w.observations.find((o) => o.kind === "recovery_rendered");
  assert.equal(rendered.detail.follower.capture.auth.status, "stable");
});
// Restates revision 29's "incoherent samples are re-read … nothing is judged on them" (its forbidden shape under an unresolved capture).
// Revision 30 judges what the capture ESTABLISHES: shown BEFORE the activation is forbidden whatever the fence did (the held barrier fixes
// the phase), so it is refused at once rather than re-read; a lawful shape under the same uncertainty is re-read.
test("R30 Q4 refused (restated R29 C5 control): shown before the activation with the fence changing — refused, never re-read", async () => {
  const w = world({ caller: "recovery", pages: 4 });
  const { log } = composed(w, (c) =>
    c.who === "follower" && c.barrier === "staged"
      ? { fences: [true, false], rendering: SHOWN_AS(c.sample.rendering) }
      : null,
  );
  const r = await run(w, { caller: "recovery" });
  assert.match(
    String(r.error?.message),
    /inadmissible under every interpretation its brackets allow \(auth changed, storage stable\)/,
  );
  assert.equal(log.at(-1).who, "follower");
  assert.equal(log.at(-1).barrier, "staged");
});
test("R30 Q4 control: the stored state moves around a lawful hidden capture at a held page — re-read, counted as storage in the milestone", async () => {
  const w = world({ pages: 4 });
  composed(w, (c) =>
    c.who === "follower" && c.barrier === "staged" && c.n === 2
      ? { storageAfter: { composition_seq: 11 } }
      : null,
  );
  const r = await run(w);
  assert.equal(r.error?.message, undefined);
  const staged = w.observations.find(
    (o) => o.kind === "recovery_staged_hidden",
  );
  assert.deepEqual(staged.detail.follower.rereads, {
    total: 1,
    auth: 0,
    storage: 1,
  });
  assert.deepEqual(staged.detail.leader.rereads, {
    total: 0,
    auth: 0,
    storage: 0,
  });
  assert.ok(w.releases.every((x) => x.outcome === "delivered"));
  assert.equal(
    w.releases.length,
    4,
    "every held answer released once, by its owner",
  );
  assert.ok(resolvedEverywhere(w));
});
test("R30 Q4 control: both brackets change in one capture — one re-read counted under both causes", async () => {
  const w = world({ caller: "recovery", pages: 3, fencedReadsAfter: 9 });
  composed(w, (c) =>
    c.after === 2
      ? {
          fences: [true, false],
          rendering: NEUTRAL_AS(c.sample.rendering),
          storageAfter: { composition_seq: 11 },
        }
      : null,
  );
  const r = await run(w, { caller: "recovery" });
  assert.equal(r.error?.message, undefined);
  const activated = w.observations.find((o) => o.kind === "recovery_activated");
  assert.deepEqual(activated.detail.follower.rereads, {
    total: 1,
    auth: 1,
    storage: 1,
  });
});
const STAGED_STORE = {
  cache_status: "invalid",
  cache_digest: OLD,
  staging_rows: 6,
  staging_generations: [6],
  applied_revision: 8,
};
for (const [caller, fenced, rendering, refused] of [
  ["recovery", true, NEUTRAL_AS, null],
  ["ordinary", false, SHOWN_AS, null],
  ["ordinary", true, SHOWN_AS, /is shown while the recovery fence stands/],
])
  test(`R30 Q4 ${refused ? "refused" : "control"} (${caller}): the activation COMMITS between the two stored reads of a poll, fence ${fenced ? "standing" : "clear"}, the page ${rendering === SHOWN_AS ? "shown" : "hidden"}`, async () => {
    const w = world({ caller, pages: 3, fencedReadsAfter: 9 });
    const { log } = composed(w, (c) =>
      c.after === 1
        ? {
            storageBefore: STAGED_STORE,
            fences: [fenced, fenced],
            rendering: rendering(c.sample.rendering),
          }
        : null,
    );
    const r = await run(w, { caller });
    const commit = log.find((x) => x.after === 1);
    assert.equal(commit.out.capture.storage.status, "changed");
    assert.ok(commit.out.capture.storage.fields.includes("cache_status"));
    if (refused) {
      assert.match(String(r.error?.message), refused);
      assert.equal(log.at(-1), commit);
      return;
    }
    // Lawful under one of the two phases the moving storage allows: re-read, and the complete state is then judged in full.
    assert.equal(r.error?.message, undefined);
    assert.equal(log[log.indexOf(commit) + 1].after, 2);
    assert.equal(log[log.indexOf(commit) + 1].who, "leader");
  });
test("R30 Q4 refused: the activation poll's moving storage cannot excuse a shape no phase admits (the floor/signed-out page)", async () => {
  const w = world({ pages: 3 });
  composed(w, (c) =>
    c.after === 1
      ? {
          storageBefore: STAGED_STORE,
          rendering: SHAPES["signed-out"](c.sample.rendering),
        }
      : null,
  );
  const r = await run(w);
  assert.match(
    String(r.error?.message),
    /inadmissible under every interpretation its brackets allow \(auth stable, storage changed\)/,
  );
  assert.match(String(r.error?.message), /signed_out/);
});
for (const reader of ["leader", "follower"])
  test(`R30 Q4 control (recovery caller, composed): the ${reader} renders FIRST once its own fence cleared; the peer stays fenced and hidden`, async () => {
    const w = world({ caller: "recovery", pages: 3, fencedReadsAfter: 1e9 });
    const clearAt = {
      [reader]: 4,
      [reader === "leader" ? "follower" : "leader"]: 10,
    };
    const { log } = composed(w, (c) =>
      c.after >= clearAt[c.who]
        ? { fences: [false, false], rendering: SHOWN_AS(c.sample.rendering) }
        : null,
    );
    const r = await run(w, { caller: "recovery" });
    assert.equal(r.error?.message, undefined);
    const first = log.find((x) => x.out.rendering.view.kind === "displaying");
    assert.equal(first.who, reader);
    assert.ok(
      log.some(
        (x) =>
          x.after > first.after && x.who !== reader && x.out.fenced === true,
      ),
    );
  });
test("R30 Q4 control: a reload BEFORE the observation (XL0's planned reload) is only a new baseline document", async () => {
  const w = world({ pages: 3 });
  composed(w, (c) => ({
    rendering: {
      ...c.sample.rendering,
      document: `${c.sample.rendering.document}-after-planned-reload`,
    },
  }));
  const r = await run(w);
  assert.equal(r.error?.message, undefined);
});
for (const [name, next, refused] of [
  [
    "an unexpected reload",
    (s) => ({
      rendering: {
        ...s.rendering,
        document: `${s.rendering.document}-reloaded`,
      },
    }),
    /leader's document changed during the observation/,
  ],
  [
    "the account database recreated (another incarnation in both reads)",
    () => ({
      storageBefore: { incarnation: "incarnation-2" },
      storageAfter: { incarnation: "incarnation-2" },
    }),
    /leader reads another account database incarnation \(incarnation-2, not incarnation-1\): replaced during the observation/,
  ],
  [
    "a role change",
    (s) => ({ rendering: { ...s.rendering, attachment: "follower" } }),
    /attached as follower, not leader/,
  ],
  [
    "the page closed",
    () => ({ evaluateThrows: "page closed" }),
    /rendering was not observed \(unavailable: page closed\)/,
  ],
])
  test(`R30 Q4 refused: ${name} on the RE-READ after a lawful moving-storage capture`, async () => {
    const w = world({ pages: 4 });
    let first = null;
    const { log } = composed(w, (c) => {
      if (c.who !== "leader" || c.barrier !== "staged") return null;
      if (first === null) {
        first = c.n;
        return { storageAfter: { composition_seq: 11 } };
      }
      return c.n === first + 1 ? next(c.sample) : null;
    });
    const r = await run(w);
    assert.match(String(r.error?.message), refused);
    assert.equal(log.at(-1).n, first + 1, "refused on the re-read itself");
    assert.ok(!w.observations.some((o) => o.kind === "recovery_staged_hidden"));
  });
for (const [extra, ok] of [
  [0, true],
  [1, false],
])
  test(`R30 Q4 ${ok ? "control" : "refused"}: ${MAX_UNRESOLVED_REREADS + extra} consecutive unresolved captures of one read ${ok ? "then a resolved one (the bound itself)" : "(one beyond the bound)"}`, async () => {
    const w = world({ pages: 3 });
    let unresolved = 0;
    let active = false;
    // The follower's complete read starts at after = 2; each of its re-reads is the next world read, until one capture is resolved.
    const { log } = composed(w, (c) => {
      if (c.who === "follower" && c.after === 2) active = true;
      if (!active || unresolved >= MAX_UNRESOLVED_REREADS + extra) {
        active = false;
        return null;
      }
      unresolved += 1;
      return unresolved % 2
        ? { storageAfter: { composition_seq: 11 } }
        : { fences: [false, true], rendering: SHOWN_AS(c.sample.rendering) };
    });
    const r = await run(w);
    if (ok) {
      assert.equal(r.error?.message, undefined, String(r.error?.message));
      const activated = w.observations.find(
        (o) => o.kind === "recovery_activated",
      );
      assert.deepEqual(activated.detail.follower.rereads, {
        total: MAX_UNRESOLVED_REREADS,
        auth: MAX_UNRESOLVED_REREADS / 2,
        storage: MAX_UNRESOLVED_REREADS / 2,
      });
    } else {
      assert.match(
        String(r.error?.message),
        new RegExp(
          `no resolved sample of the follower in ${MAX_UNRESOLVED_REREADS + 1} reads at after activation`,
        ),
      );
      assert.equal(
        log.filter((x) => x.who === "follower" && x.after >= 2).length,
        MAX_UNRESOLVED_REREADS + 1,
      );
      assert.ok(!w.observations.some((o) => o.kind === "recovery_activated"));
    }
  });

// C1/C3 envelope and failure propagation (restating revision 29's "a sample stating no coherence is incomplete"): the brackets the observer
// receives are themselves checked; a malformed or missing one is an incomplete observation, refused on that capture, never re-read.
const envelope = (change) => async () => {
  const w = world({ pages: 3 });
  const read = w.io.read;
  let n = 0;
  w.io.read = async (who, o) => {
    const r = await read(who, o);
    n += 1;
    if (n !== 3) return r;
    const altered = structuredClone(r);
    change(altered);
    return altered;
  };
  return { w, r: await run(w) };
};
for (const [name, change, refused] of [
  [
    "no capture at all",
    (r) => {
      delete r.capture;
    },
    /leader's sample states no capture brackets/,
  ],
  [
    "a /3 `coherent` flag instead of brackets",
    (r) => {
      delete r.capture;
      r.coherent = true;
    },
    /states no capture brackets/,
  ],
  [
    "an unknown auth outcome",
    (r) => {
      r.capture.auth = { status: "coherent" };
    },
    /auth bracket is malformed \("coherent"\)/,
  ],
  [
    "an unknown storage outcome",
    (r) => {
      r.capture.storage = { status: "unchanged" };
    },
    /storage bracket is malformed \("unchanged"\)/,
  ],
  [
    "a stable auth bracket with no fence",
    (r) => {
      r.fenced = null;
    },
    /auth fences are not observed \(a stable bracket, no fence\)/,
  ],
  [
    "a changed auth bracket paired with a fence",
    (r) => {
      r.capture.auth = { status: "changed", reason: "x" };
    },
    /pairs a changed auth bracket with a fence/,
  ],
  [
    "a changed storage bracket naming no field",
    (r) => {
      r.capture.storage = { status: "changed", fields: [] };
    },
    /changed storage bracket names no field/,
  ],
  [
    "no database incarnation",
    (r) => {
      delete r.incarnation;
    },
    /account database names no incarnation/,
  ],
])
  test(`R30 C1 refused: ${name} is an incomplete observation`, async () => {
    const { w, r } = await envelope(change)();
    assert.match(String(r.error?.message), refused);
    assert.match(
      String(r.error?.message),
      /an incomplete observation of the leader \(at before activation, read 1\)/,
    );
    assert.ok(!w.observations.some((o) => o.kind === "recovery_staged_hidden"));
  });
test("R30 C3: the FIRST failure is handed to `failed` once, before the throw, and no milestone follows; a throwing `failed` does not mask it", async () => {
  for (const throwing of [false, true]) {
    const w = world({ caller: "recovery", pages: 3, fencedReadsAfter: 9 });
    const order = [];
    const observe = w.io.observe;
    w.io.observe = (...a) => {
      order.push(`observe:${a[0]}`);
      return observe(...a);
    };
    composed(w, (c) =>
      c.after === 2
        ? {
            rendering: OPEN(c.sample.rendering),
            storageAfter: { composition_seq: 11 },
          }
        : null,
    );
    w.io.failed = (f) => {
      order.push("failed");
      assert.match(
        f.reason,
        /follower is shown while the recovery fence stands/,
      );
      assert.equal(f.capture.phase, "after_activation");
      assert.equal(f.capture.document, "follower-document");
      assert.equal(f.capture.incarnation, "incarnation-1");
      assert.equal(f.capture.stored.cache_status, "valid");
      if (throwing) throw new Error("recording failed");
    };
    const r = await run(w, { caller: "recovery" });
    assert.match(
      String(r.error?.message),
      /follower is shown while the recovery fence stands/,
    );
    assert.equal(order.at(-1), "failed");
    assert.equal(order.filter((x) => x === "failed").length, 1);
  }
});
