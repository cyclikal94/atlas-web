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
import {
  admissibilityProblems,
  hiddenProblems,
  holdsComplete,
  MAX_INCOHERENT_REREADS,
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
      coherent: true,
      incoherence: null,
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
    coherent: true,
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

// Revision 29 (C5): an INCOHERENT sample (fences or stored state changed during the bracketed capture) is re-read, bounded and counted —
// never judged; every coherent sample is judged, so a forbidden coherent one is never re-read into success.
test("R29 C5 control: incoherent samples are re-read and counted in the sample that ends them; nothing is judged on them", async () => {
  const w = world({ caller: "recovery", pages: 3, fencedReadsAfter: 6 });
  const read = w.io.read;
  let n = 0;
  w.io.read = async (who, o) => {
    const r = await read(who, o);
    n += 1;
    // Incoherent, and showing what would be forbidden if it were judged.
    if (n === 5 || n === 6)
      return {
        ...r,
        ...asShown(r),
        fenced: null,
        coherent: false,
        incoherence: "the stored state changed during the sample",
      };
    return r;
  };
  const r = await run(w, { caller: "recovery" });
  assert.equal(r.error?.message, undefined);
  const counted = w.observations
    .flatMap((o) => [o.detail.leader, o.detail.follower])
    .map((x) => x.incoherent_rereads);
  assert.ok(
    counted.includes(2),
    `the two re-reads are counted: ${JSON.stringify(counted)}`,
  );
});
test("R29 C5 refused: a read that never yields a coherent sample fails (bounded), never hidden or shown", async () => {
  const w = world({ pages: 3 });
  const read = w.io.read;
  w.io.read = async (who, o) => {
    const r = await read(who, o);
    return who === "follower" && w.state.activated
      ? { ...r, coherent: false, incoherence: "x changed" }
      : r;
  };
  const r = await run(w);
  assert.match(
    String(r.error?.message),
    new RegExp(
      `no coherent sample of the follower in ${MAX_INCOHERENT_REREADS + 1} reads at after activation \\(x changed\\)`,
    ),
  );
});
test("R29 C5 refused: a coherent forbidden sample is judged at once (not re-read)", async () => {
  const w = world({ caller: "recovery", pages: 3, fencedReadsAfter: 12 });
  const seen = afterActivation(w, (i, _who, r) =>
    i === 4 ? asShown(r) : undefined,
  );
  const r = await run(w, { caller: "recovery" });
  assert.match(
    String(r.error?.message),
    /leader is shown while the recovery fence stands/,
  );
  assert.equal(seen.length, 4);
});
test("R29 C5 refused: a sample stating no coherence is incomplete", async () => {
  const w = world({ pages: 3 });
  const read = w.io.read;
  w.io.read = async (who, o) => {
    const { coherent: _c, ...r } = await read(who, o);
    return r;
  };
  const r = await run(w);
  assert.match(
    String(r.error?.message),
    /leader's sample is not stated coherent/,
  );
});
