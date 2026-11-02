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
  ENDPOINT_FIELDS,
  recoverySample,
  renderingOf,
} from "./pair-capture.mjs";
import {
  activationProblems,
  admissibilityProblems,
  captureProblems,
  hiddenProblems,
  holdsComplete,
  interpretations,
  MAX_UNRESOLVED_REREADS,
  OBSERVATION_SCHEMA,
  observationProblems,
  observeRecovery,
  shownProblems,
  storedActivatedProblems,
  storedInvalidatedProblems,
  storedProblemsAt,
  storedStagedProblems,
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
/** The fields of a stored state as its second coherent transaction (pair-capture.mjs `ENDPOINT_FIELDS`). */
const endpointOf = (s) =>
  Object.fromEntries(ENDPOINT_FIELDS.map((k) => [k, s[k] ?? null]));
/**
 * Revision 31 (R31-DIAG; labelled test double): a sample of the plain world (not `composed`) states a STABLE storage bracket, so its second
 * stored transaction is the stored state it returned — supplied here, OUTSIDE every test's own read wrapper, so a test that alters a stored
 * field alters both transactions alike. A sample that already states `stored_after` (every `composed` capture, or a test that sets it, even
 * to null) is left as it is.
 */
const run = (w, { caller = "ordinary", expectFinal = () => [] } = {}) => {
  const read = w.io.read;
  w.io.read = async (who, o) => {
    const r = await read(who, o);
    return r && typeof r === "object" && r.stored_after === undefined
      ? { ...r, stored_after: endpointOf(r) }
      : r;
  };
  return observe(w, { caller, expectFinal });
};
const observe = (w, { caller, expectFinal }) =>
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
  // Revision 31 (labelled adaptation, C3): a complete sample now states its second stored transaction; with a stable bracket it is the
  // sample's own stored state. The rules judged below are unchanged.
  const sample = (rendering, extra = {}) => {
    const x = {
      reader: "leader",
      account: ACCOUNT,
      cache_status: "invalid",
      fenced: false,
      incarnation: "incarnation-1",
      capture: { auth: { status: "stable" }, storage: { status: "stable" } },
      rendering,
      ...extra,
    };
    return { ...x, stored_after: endpointOf(x) };
  };
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
    stored_after: _e,
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
      // Revision 31 (test robustness, no assertion changed): the site's presence is itself asserted before it is read.
      assert.ok(injected, "the injected site was read");
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
      assert.ok(failures[0]?.capture, "the failure carries its facts");
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
            assert.equal(
              failures[0]?.capture?.capture?.storage?.status,
              "changed",
            );
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
    assert.ok(commit, "the first activation poll was read");
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
  // Revision 31 (R31-DIAG, C3): the second coherent stored transaction is part of the envelope.
  [
    "a stable storage bracket whose second stored read is not retained",
    (r) => {
      r.stored_after = null;
    },
    /leader's second stored read is not retained/,
  ],
  [
    "a second stored read of another incarnation under a stable bracket",
    (r) => {
      r.stored_after = { ...endpointOf(r), incarnation: "incarnation-2" };
    },
    /leader's second stored read names another incarnation \(incarnation-2\)/,
  ],
  [
    "a stable storage bracket whose second read differs",
    (r) => {
      r.stored_after = { ...endpointOf(r), cache_digest: "moved" };
    },
    /leader's stable storage bracket disagrees with its second read \(differing: cache_digest\)/,
  ],
  [
    "a changed storage bracket naming another field than the one that moved",
    (r) => {
      r.stored_after = { ...endpointOf(r), composition_seq: 11 };
      r.capture.storage = {
        status: "changed",
        fields: ["cursor"],
        before: {},
        after: {},
      };
    },
    /leader's changed storage bracket disagrees with its second read \(differing: composition_seq\)/,
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

// ---- revision 31 (R31-DIAG, family `segmented-sync-development-pairing`, incomplete_fix of R30-DIAG; design assessment Q1-Q5) -------------
// Each raw stored read is ONE coherent IndexedDB transaction. Revision 30 judged the stored-data predicates only on a RESOLVED capture after
// `read()` returned, so a capture whose bracket moved (an unrelated composition write, a legal activation, an auth change) discarded an
// independently invalid transaction and a later healthy sample passed (the review's atomicity and family probes, preserved unchanged under
// .agtx/evidence/WEB-09c/review-r30-20261102). Now BOTH coherent transactions of every capture are judged against the barrier's frozen
// read context before any re-read. Injected faults are labelled test interventions on doubled IO (harness sensitivity, never product
// corruption); one fault is injected and the IO is healthy again at once, so each refusal also proves first-failure retention.
const WRONG = "independently-wrong-live-cache";
const OTHER = "another-new-cache";
const STAGED_END = {
  cache_status: "invalid",
  cache_digest: OLD,
  staging_rows: 6,
  staging_generations: [6],
  applied_revision: 8,
};
const COMPLETE_END = {
  cache_status: "valid",
  cache_digest: NEW,
  staging_rows: 0,
  staging_generations: [],
  applied_revision: 12,
};
const SPLIT_END = {
  ...COMPLETE_END,
  staging_rows: 3,
  staging_generations: [6],
};

// Q1: the pure stored predicates on one transaction and an explicit context (no rendering, no fence, no bracket consulted).
test("R31 Q1: the stored invalidation — each predicate on its own, and a healthy control", () => {
  const ok = {
    cache_status: "invalid",
    cursor: null,
    phase: "snapshot",
    delta_stage: null,
    staged: 0,
    staging_rows: 0,
    recovery_generation: 6,
    cache_digest: OLD,
  };
  const ctx = {
    who: "leader",
    caller: "recovery",
    oldDigest: OLD,
    refusalGeneration: 5,
  };
  assert.deepEqual(storedInvalidatedProblems(ok, ctx), []);
  for (const [change, expected, c = {}] of [
    [{ cache_status: "valid" }, /still shows a valid cache/],
    [{ cursor: "c9" }, /keeps a cursor/],
    [{ delta_stage: { revision: 9 } }, /keeps the abandoned delta stage/],
    [{ staged: 2 }, /keeps the abandoned delta stage/],
    [{ staging_rows: 1 }, /holds snapshot rows before the first page/],
    [{ recovery_generation: 5 }, /has no new recovery generation/],
    [{ cache_digest: WRONG }, /live cache changed before the snapshot/],
    [{ phase: "delta" }, /refusal did not restart the snapshot/],
    [{}, /does not read the leader's generation 7 \(6\)/, { generation: 7 }],
  ])
    assert.match(
      storedInvalidatedProblems({ ...ok, ...change }, { ...ctx, ...c }).join(),
      expected,
    );
  // The stored phase is the RECOVERY leader's obligation only (unchanged scope).
  assert.deepEqual(
    storedInvalidatedProblems(
      { ...ok, phase: "delta" },
      { ...ctx, who: "follower" },
    ),
    [],
  );
});
test("R31 Q1: the stored staging — row floor, one generation, the old live cache, never valid; and a healthy control", () => {
  const ok = { ...STAGED_END, recovery_generation: 6 };
  const ctx = {
    who: "follower",
    oldDigest: OLD,
    generation: 6,
    rowsAtLeast: 6,
  };
  assert.deepEqual(storedStagedProblems(ok, ctx), []);
  for (const [change, expected] of [
    [{ staging_rows: 5 }, /holds 5 staged rows, expected at least 6/],
    [{ staging_generations: [6, 7] }, /not all of generation 6/],
    [{ recovery_generation: 7 }, /moved to generation 7/],
    [{ cache_digest: WRONG }, /live cache changed before the activation/],
    [{ cache_status: "valid" }, /shows a valid cache before the last page/],
  ])
    assert.match(
      storedStagedProblems({ ...ok, ...change }, ctx).join(),
      expected,
    );
});
test("R31 Q1: the stored activation — wholly staged or wholly complete; a split refused; never backwards once a complete cache was validated", () => {
  const base = { delta_stage: null, staged: 0, recovery_generation: 6 };
  const ctx = { who: "leader", oldDigest: OLD, generation: 6, rowsAtLeast: 6 };
  assert.deepEqual(activationProblems({ ...base, ...STAGED_END }, ctx), []);
  assert.deepEqual(activationProblems({ ...base, ...COMPLETE_END }, ctx), []);
  assert.match(
    activationProblems({ ...base, ...SPLIT_END }, ctx).join(),
    /a split activation: neither the staged nor the complete state/,
  );
  // A changed live cache before validity (the old split form).
  assert.match(
    activationProblems(
      { ...base, ...STAGED_END, cache_digest: OTHER },
      ctx,
    ).join(),
    /a split activation/,
  );
  const after = { ...ctx, witness: NEW };
  assert.deepEqual(activationProblems({ ...base, ...COMPLETE_END }, after), []);
  assert.match(
    activationProblems({ ...base, ...STAGED_END }, after).join(),
    /the activation went backwards: a complete cache new-digest was read, then/,
  );
  assert.match(
    activationProblems(
      { ...base, ...COMPLETE_END, cache_digest: OTHER },
      after,
    ).join(),
    /the activation went backwards: .*does not hold the activated cache new-digest \(another-new-cache\)/,
  );
});
test("R31 Q1: the stored activated state — valid, nothing staged, a new cache, and the bound digest named by its site", () => {
  const ok = { ...COMPLETE_END, delta_stage: null, staged: 0 };
  const ctx = {
    who: "follower",
    oldDigest: OLD,
    digest: NEW,
    mismatch: "the follower does not read the activated cache",
  };
  assert.deepEqual(storedActivatedProblems(ok, ctx), []);
  for (const [change, expected] of [
    [{ cache_status: "invalid" }, /does not hold a valid cache/],
    [{ staging_rows: 1 }, /still holds staged rows after the activation/],
    [
      { delta_stage: { revision: 3 } },
      /still holds staged rows after the activation/,
    ],
    [{ cache_digest: OLD }, /still holds the old cache/],
    [
      { cache_digest: OTHER },
      /^the follower does not read the activated cache$/,
    ],
  ])
    assert.match(
      storedActivatedProblems({ ...ok, ...change }, ctx).join(),
      expected,
    );
  assert.throws(
    () => storedProblemsAt(ok, { barrier: "rendered" }, { who: "leader" }),
    /unknown stored barrier rendered/,
  );
});
test("R31 Q1/C2: an activation poll's phases come from its two KNOWN transactions — both staged: before only; both complete: after only; one of each: both", () => {
  const moving = (first, second) => ({
    reader: "leader",
    fenced: false,
    ...first,
    stored_after: { ...second },
    capture: {
      auth: { status: "stable" },
      storage: { status: "changed", fields: ["composition_seq"] },
    },
  });
  const phases = (r) => interpretations(r, "activation").map((i) => i.phase);
  assert.deepEqual(phases(moving(STAGED_END, STAGED_END)), [
    "before_activation",
  ]);
  assert.deepEqual(phases(moving(COMPLETE_END, COMPLETE_END)), [
    "after_activation",
  ]);
  assert.deepEqual(phases(moving(STAGED_END, COMPLETE_END)), [
    "before_activation",
    "after_activation",
  ]);
});
test("R31 C1/C3: the capture envelope requires the second stored transaction under a stable or changed bracket", () => {
  const sample = {
    reader: "follower",
    fenced: false,
    incarnation: "incarnation-1",
    composition_seq: 10,
    cache_digest: OLD,
    capture: { auth: { status: "stable" }, storage: { status: "stable" } },
  };
  assert.deepEqual(
    captureProblems({ ...sample, stored_after: endpointOf(sample) }),
    [],
  );
  assert.deepEqual(
    captureProblems({
      ...sample,
      stored_after: { ...endpointOf(sample), composition_seq: 11 },
      capture: {
        ...sample.capture,
        storage: { status: "changed", fields: ["composition_seq"] },
      },
    }),
    [],
  );
  assert.match(
    captureProblems({ ...sample }).join(),
    /follower's second stored read is not retained/,
  );
});

// Q2: the review's preserved stimuli, carried forward through the MAINTAINED composition (`composed`: pair-capture.mjs `recoverySample`
// and `renderingOf` with the real in-page capture over doubled globals, into `observeRecovery`), with the corrected expectations.
const refusedAt = (r, log, failures, injected, observedBefore, w, expected) => {
  assert.match(String(r.error?.message), expected);
  assert.equal(
    log.at(-1),
    injected,
    "refused AT the injected capture: no later read",
  );
  assert.equal(w.observations.length, observedBefore, "no milestone after it");
  assert.equal(failures.length, 1, "one first failure, recorded once");
  assert.ok(failures[0]?.capture, "the failure carries its facts");
  assert.equal(
    r.error.capture,
    failures[0].capture,
    "the thrown error carries the same facts",
  );
  return failures[0].capture;
};
// The atomicity probe's four variants per caller, at the leader's first activation poll after the last page's release.
const ATOMICITY = {
  "healthy, stable storage": {
    split: false,
    change: () => null,
    refused: null,
  },
  "a lawful atomic transition: the first transaction wholly staged, the second wholly complete":
    {
      split: false,
      change: () => ({ storageBefore: STAGED_END }),
      refused: null,
    },
  "the maintained split-activation fault, stable storage": {
    split: true,
    change: () => ({}),
    refused:
      /a split activation: neither the staged nor the complete state .*\[the first stored read of capture 1\]/,
    endpoint: "first",
  },
  "the same split first transaction, the second complete": {
    split: true,
    change: () => ({ storageAfter: COMPLETE_END }),
    refused:
      /a split activation: neither the staged nor the complete state .*\[the first stored read of capture 1\]/,
    endpoint: "first",
    storage: "changed",
  },
  // DA31-ENDPOINT (the reverse direction): a lawful first transaction, then an invalid SECOND one.
  "a lawful staged first transaction, then a split second one": {
    split: false,
    change: () => ({ storageBefore: STAGED_END, storageAfter: SPLIT_END }),
    refused: /a split activation: .*\[the second stored read of capture 1\]/,
    endpoint: "second",
    storage: "changed",
  },
  "a complete first transaction, then a staged second one (backwards)": {
    split: false,
    change: () => ({ storageAfter: STAGED_END }),
    refused:
      /the activation went backwards: a complete cache new-digest was read, then .*\[the second stored read of capture 1\]/,
    endpoint: "second",
    storage: "changed",
  },
};
for (const caller of ["ordinary", "recovery"])
  for (const [name, v] of Object.entries(ATOMICITY))
    test(`R31 Q2 composed (${caller}, atomicity): ${name}`, async () => {
      // Three pages of three rows: the activation's row floor is the six rows of STAGED_END.
      const w = world({
        caller,
        pages: 3,
        fault: v.split ? "split" : null,
        fencedReadsAfter: 12,
      });
      let injected = null;
      let observedBefore = 0;
      const { log, failures } = composed(w, (c) => {
        if (injected !== null || c.who !== "leader" || c.after !== 1)
          return null;
        injected = c;
        observedBefore = w.observations.length;
        return v.change(c);
      });
      const r = await run(w, { caller });
      assert.ok(injected, "the first activation poll was read");
      const at = log.find((x) => x.n === injected.n && x.who === "leader");
      if (v.split)
        assert.deepEqual(
          [at.out.cache_status, at.out.staging_rows > 0, at.out.cache_digest],
          ["valid", true, NEW],
          "the maintained world's own split fault, unchanged",
        );
      if (v.refused === null) {
        assert.equal(r.error?.message, undefined);
        assert.ok(w.observations.some((o) => o.kind === "recovery_rendered"));
        assert.deepEqual(failures, []);
        return;
      }
      const f = refusedAt(r, log, failures, at, observedBefore, w, v.refused);
      assert.equal(f.predicate, "stored.activation");
      assert.equal(f.endpoint, v.endpoint);
      assert.equal(f.barrier, "activation");
      assert.equal(f.capture.storage.status, v.storage ?? "stable");
      assert.ok(!w.observations.some((o) => o.kind === "recovery_activated"));
    });

// Q2: the family probe's 48 variants (two callers × two pages × four sites × three controls): a wrong live cache in BOTH coherent
// transactions, only `composition_seq` moving between them (or not). The stable negative and the moving negative now both refuse at once.
const FAMILY_SITES = {
  invalidated: (c) => c.after === 0 && c.barrier === "invalidated",
  staged: (c) => c.after === 0 && c.barrier === "staged",
  "final-held": (c) => c.after === 0 && c.barrier === "final",
  settlement: (_c, w) =>
    w.observations.some((o) => o.kind === "recovery_activated"),
};
for (const caller of ["ordinary", "recovery"])
  for (const who of ["leader", "follower"])
    for (const [site, matches] of Object.entries(FAMILY_SITES))
      for (const variant of ["healthy-moving", "bad-stable", "bad-moving"])
        test(`R31 Q2 composed (${caller}, family): the ${who} at ${site}, ${variant}`, async () => {
          const w = world({ caller, fencedReadsAfter: 12 });
          let injected = null;
          let observedBefore = 0;
          const { log, failures } = composed(w, (c) => {
            if (injected !== null || c.who !== who || !matches(c, w))
              return null;
            injected = c;
            observedBefore = w.observations.length;
            const digest = variant.startsWith("bad")
              ? { cache_digest: WRONG }
              : {};
            return {
              storageBefore: digest,
              storageAfter: {
                ...digest,
                composition_seq: variant.endsWith("moving") ? 11 : 10,
              },
            };
          });
          const r = await run(w, { caller });
          assert.ok(injected);
          if (variant === "healthy-moving") {
            assert.equal(r.error?.message, undefined);
            assert.ok(
              w.observations.some((o) => o.kind === "recovery_rendered"),
            );
            return;
          }
          const at = log.find((x) => x.who === who && x.n === injected.n);
          const f = refusedAt(
            r,
            log,
            failures,
            at,
            observedBefore,
            w,
            site === "invalidated"
              ? /live cache changed before the snapshot \[the first stored read/
              : site === "settlement"
                ? new RegExp(
                    `the ${who}'s cache changed after the activation \\[the first stored read`,
                  )
                : /live cache changed before the activation \[the first stored read/,
          );
          assert.equal(f.endpoint, "first");
          assert.equal(f.stored.cache_digest, WRONG);
          assert.equal(
            f.stored_after?.cache_digest,
            WRONG,
            "the second transaction is retained too",
          );
          assert.equal(
            f.capture.storage.status,
            variant === "bad-moving" ? "changed" : "stable",
          );
          if (variant === "bad-moving")
            assert.deepEqual(f.capture.storage.fields, ["composition_seq"]);
          assert.ok(
            !w.observations.some((o) => o.kind === "recovery_rendered"),
          );
        });

// Q3: every read site, both callers, each direction of the fault across the two transactions and each kind of movement. `bad` is the
// independently invalid stored state of that site; it is in the FIRST, the SECOND or BOTH transactions, with the storage stable or moving
// (composition only, or because the bad transaction differs from the healthy one), the auth bracket stable or changing. Controls: the
// healthy capture with each movement (re-read, then lawful).
const R31_SITES = [
  ...["invalidated", "staged", "intermediate", "final"].flatMap((barrier) =>
    ["leader", "follower"].map((who) => ({
      who,
      barrier,
      name: `the ${who} at the ${barrier} page`,
      bad: { cache_digest: WRONG },
      expected:
        barrier === "invalidated"
          ? /live cache changed before the snapshot/
          : /live cache changed before the activation/,
      predicate: `stored.${barrier === "invalidated" ? "invalidated" : "staged"}`,
    })),
  ),
  {
    who: "leader",
    after: 1,
    name: "the leader's first complete activation poll",
    bad: SPLIT_END,
    expected: /a split activation|the activation went backwards/,
    predicate: "stored.activation",
  },
  {
    who: "follower",
    after: 2,
    name: "the follower's complete read",
    bad: { cache_digest: OTHER },
    expected: /the follower does not read the activated cache/,
    predicate: "stored.activated",
  },
  {
    who: "leader",
    after: 3,
    name: "the leader's row-bearing read",
    bad: { cache_digest: OTHER },
    expected: /the cache changed between the activation and its rows/,
    predicate: "stored.activated",
  },
  {
    who: "leader",
    after: 4,
    name: "the leader's first settlement poll",
    bad: { staging_rows: 2 },
    expected: /leader still holds staged rows after the activation/,
    predicate: "stored.activated",
  },
  {
    who: "follower",
    after: 5,
    name: "the follower's first settlement poll",
    bad: { cache_digest: OTHER },
    expected: /the follower's cache changed after the activation/,
    predicate: "stored.activated",
  },
];
// [name, first bad?, second bad?, composition moves?, auth moves?]
const DIRECTIONS = [
  ["healthy, composition moving", false, false, true, false],
  ["healthy, the auth bracket changing", false, false, false, true],
  ["healthy, both brackets changing", false, false, true, true],
  ["the first bad, stable", true, true, false, false],
  ["the first bad, the second healthy", true, false, false, false],
  ["the first healthy, the second bad", false, true, false, false],
  ["both bad, composition only moving", true, true, true, false],
  ["the first bad, the auth bracket changing", true, true, false, true],
  ["the first bad, both brackets changing", true, false, true, true],
];
for (const caller of ["ordinary", "recovery"])
  for (const site of R31_SITES)
    for (const [
      direction,
      firstBad,
      secondBad,
      composition,
      auth,
    ] of DIRECTIONS)
      test(`R31 Q3 composed (${caller}): ${site.name} — ${direction}`, async () => {
        const w = world({ caller, pages: 5, fencedReadsAfter: 3 });
        let injected = null;
        let observedBefore = 0;
        const { log, failures } = composed(w, (c) => {
          if (injected !== null || c.who !== site.who) return null;
          if (
            site.after
              ? c.after !== site.after
              : c.after !== 0 || c.barrier !== site.barrier
          )
            return null;
          injected = c;
          observedBefore = w.observations.length;
          return {
            storageBefore: firstBad ? site.bad : {},
            storageAfter: {
              ...(secondBad ? site.bad : {}),
              composition_seq: composition ? 11 : 10,
            },
            ...(auth ? { fences: [c.sample.fenced, !c.sample.fenced] } : {}),
          };
        });
        const r = await run(w, { caller });
        assert.ok(injected, "the site was read");
        const at = log.find((x) => x.who === site.who && x.n === injected.n);
        if (!firstBad && !secondBad) {
          assert.equal(r.error?.message, undefined, String(r.error?.message));
          assert.ok(w.observations.some((o) => o.kind === "recovery_rendered"));
          assert.equal(
            log[log.indexOf(at) + 1]?.who,
            site.who,
            "the unresolved capture is re-read",
          );
          return;
        }
        const f = refusedAt(
          r,
          log,
          failures,
          at,
          observedBefore,
          w,
          site.expected,
        );
        assert.equal(f.predicate, site.predicate);
        assert.equal(f.endpoint, firstBad ? "first" : "second");
        assert.equal(f.reader, site.who);
        assert.equal(f.read, 1);
        assert.equal(f.capture.auth.status, auth ? "changed" : "stable");
        const moved = composition || firstBad !== secondBad;
        assert.equal(f.capture.storage.status, moved ? "changed" : "stable");
        for (const k of ENDPOINT_FIELDS) {
          assert.ok(k in f.stored, `the first transaction's ${k} is reported`);
          assert.ok(
            f.stored_after !== null && k in f.stored_after,
            `the second transaction's ${k} is reported`,
          );
        }
      });

// Q4: legitimate transitions are preserved, and the new pairwise/oracle checks have their controls.
test("R31 Q4 refused: the recovery generation moves between the two transactions of a held invalidation capture (a restart is never a new baseline)", async () => {
  const w = world({ caller: "recovery", pages: 3, fencedReadsAfter: 9 });
  let injected = null;
  const { log, failures } = composed(w, (c) => {
    if (injected || c.who !== "leader" || c.barrier !== "invalidated")
      return null;
    injected = c;
    return { storageAfter: { recovery_generation: 7 } };
  });
  const r = await run(w, { caller: "recovery" });
  const f = refusedAt(
    r,
    log,
    failures,
    log.at(0),
    0,
    w,
    /the leader's recovery generation moved during a held capture \(6, then 7\)/,
  );
  assert.equal(f.predicate, "stored.generation_moved");
});
test("R31 Q4 refused: the staged rows go backwards between the two transactions of a held capture (the floor raised by the first)", async () => {
  const w = world({ pages: 4 });
  let injected = null;
  const { log, failures } = composed(w, (c) => {
    if (injected || c.who !== "follower" || c.barrier !== "intermediate")
      return null;
    injected = c;
    // The context's floor is the leader's six rows; the first transaction raises it to nine, the second has seven.
    return {
      storageBefore: { staging_rows: 9 },
      storageAfter: { staging_rows: 7, composition_seq: 11 },
    };
  });
  const r = await run(w);
  const at = log.find((x) => x.who === "follower" && x.n === injected.n);
  const f = refusedAt(
    r,
    log,
    failures,
    at,
    2,
    w,
    /follower holds 7 staged rows, expected at least 9 \[the second stored read/,
  );
  assert.equal(f.expected.rowsAtLeast, 9);
});
test("R31 Q4 control: the row floor and generation stand between two lawful transactions at a held page (composition moving)", async () => {
  const w = world({ pages: 4 });
  composed(w, (c) =>
    c.who === "follower" && c.barrier === "intermediate" && c.n === 3
      ? { storageAfter: { composition_seq: 11 } }
      : null,
  );
  const r = await run(w);
  assert.equal(r.error?.message, undefined);
});
for (const moving of [false, true])
  test(`R31 Q4 refused: the row-bearing capture's rows fail the oracle${moving ? " while the storage moves" : ""} — judged on that capture, never repaired by a later valid read`, async () => {
    const w = world({ pages: 3 });
    let injected = null;
    const calls = [];
    const { log, failures } = composed(w, (c) => {
      if (injected || c.after !== 3) return null;
      injected = c;
      return {
        storageBefore: { rows: [{ id: "a" }] },
        storageAfter: { composition_seq: moving ? 11 : 10 },
      };
    });
    const r = await run(w, {
      expectFinal: (rows) => {
        calls.push(rows.length);
        return rows.length === 2 ? [] : ["person b missing"];
      },
    });
    const at = log.find((x) => x.after === 3);
    const f = refusedAt(
      r,
      log,
      failures,
      at,
      3,
      w,
      /the activated cache against the oracle: person b missing \(capture 1\)/,
    );
    assert.equal(f.predicate, "rows.oracle");
    assert.equal(f.rows.count, 1);
    assert.match(f.rows.sha256, /^[0-9a-f]{64}$/);
    assert.deepEqual(f.rows.problems, ["person b missing"]);
    assert.deepEqual(
      calls,
      [1],
      "the oracle judged the injected capture's own rows",
    );
  });
test("R31 Q4 control: lawful rows on a row-bearing capture whose storage moves — the oracle judges each capture, then the resolved one is published", async () => {
  const w = world({ pages: 3 });
  const calls = [];
  composed(w, (c) =>
    c.after === 3 ? { storageAfter: { composition_seq: 11 } } : null,
  );
  const r = await run(w, {
    expectFinal: (rows) => {
      calls.push(rows.length);
      return [];
    },
  });
  assert.equal(r.error?.message, undefined);
  assert.deepEqual(calls, [2, 2]);
  const activated = w.observations.find((o) => o.kind === "recovery_activated");
  assert.deepEqual(activated.detail.leader.rereads, {
    total: 1,
    auth: 0,
    storage: 1,
  });
});
test("R31 Q4 refused: the requested rows were not read (never judged as an empty cache)", async () => {
  const w = world({ pages: 3 });
  const { failures } = composed(w, (c) =>
    c.after === 3 ? { storageBefore: { rows: undefined } } : null,
  );
  const r = await run(w);
  assert.match(
    String(r.error?.message),
    /the leader's row-bearing read after the activation: the requested rows were not read \(capture 1\)/,
  );
  assert.equal(failures[0]?.capture?.predicate, "rows.missing");
});
for (const [name, first, second, rendering, refused] of [
  [
    "both transactions staged, the page SHOWN (before the activation)",
    STAGED_END,
    STAGED_END,
    (g) => SHOWN_AS(g),
    /shows the account's cache content at activation \(shown\)/,
  ],
  [
    "both transactions complete, the page SHOWN unfenced",
    COMPLETE_END,
    COMPLETE_END,
    (g) => SHOWN_AS(g),
    null,
  ],
  [
    "both transactions complete, the page hidden while it waits",
    COMPLETE_END,
    COMPLETE_END,
    (g) => g,
    null,
  ],
])
  test(`R31 Q4 ${refused ? "refused" : "control"} (ordinary): an activation poll with composition moving — ${name}`, async () => {
    const w = world({ pages: 3 });
    const { log } = composed(w, (c) =>
      c.after === 1
        ? {
            storageBefore: first,
            storageAfter: { ...second, composition_seq: 11 },
            fences: [false, false],
            rendering: rendering(c.sample.rendering),
          }
        : null,
    );
    const r = await run(w);
    const at = log.find((x) => x.after === 1);
    assert.ok(at, "the first activation poll was read");
    assert.equal(at.out.capture.storage.status, "changed");
    if (refused) {
      assert.match(String(r.error?.message), refused);
      assert.equal(log.at(-1), at);
      return;
    }
    assert.equal(r.error?.message, undefined);
    assert.equal(
      log[log.indexOf(at) + 1]?.who,
      "leader",
      "re-read for the association",
    );
  });
test("R31 Q4 control (recovery caller): complete-but-fenced and hidden while composition moves at every activation read — re-read, never refused", async () => {
  const w = world({ caller: "recovery", pages: 3, fencedReadsAfter: 30 });
  const moved = new Set();
  composed(w, (c) => {
    if (c.after < 1 || c.after > 3 || moved.has(c.after)) return null;
    moved.add(c.after);
    return { storageAfter: { composition_seq: 11 } };
  });
  const r = await run(w, { caller: "recovery" });
  assert.equal(r.error?.message, undefined);
  const activated = w.observations.find((o) => o.kind === "recovery_activated");
  assert.equal(activated.detail.leader.fenced, true);
});
test("R31 Q4 control: an activation witnessed in the SECOND transaction of an unresolved capture binds the next one (complete, the same cache)", async () => {
  const w = world({ pages: 3 });
  let n = 0;
  const { log } = composed(w, (c) => {
    if (c.who !== "leader" || c.after < 1) return null;
    n += 1;
    return n === 1 ? { storageBefore: STAGED_END } : null;
  });
  const r = await run(w);
  assert.equal(r.error?.message, undefined);
  assert.equal(
    log.find((x) => x.after === 1).out.capture.storage.status,
    "changed",
  );
});
test("R31 Q4 refused: after an activation witnessed in an unresolved capture, the next capture's cache is ANOTHER complete one", async () => {
  const w = world({ pages: 3 });
  let n = 0;
  const { log, failures } = composed(w, (c) => {
    if (c.who !== "leader" || c.after < 1) return null;
    n += 1;
    if (n === 1) return { storageBefore: STAGED_END };
    if (n === 2)
      return {
        storageBefore: { cache_digest: OTHER },
        storageAfter: { cache_digest: OTHER },
      };
    return null;
  });
  const r = await run(w);
  assert.match(
    String(r.error?.message),
    /the activation went backwards: a complete cache new-digest was read, then leader does not hold the activated cache new-digest \(another-new-cache\) \[the first stored read of capture 2\]/,
  );
  assert.equal(log.at(-1).after, 2);
  assert.equal(failures[0]?.capture?.expected?.witness, NEW);
  assert.ok(!w.observations.some((o) => o.kind === "recovery_activated"));
});

// C5: every failure carries bounded facts — stored, rendering-side, pairwise, oracle and barrier failures alike.
test("R31 C5: a stored failure's facts — barrier, held answer, predicate, endpoint, frozen expectations, both transactions, both brackets", async () => {
  const w = world({ pages: 4 });
  composed(w, (c) =>
    c.who === "follower" && c.barrier === "staged"
      ? { storageAfter: { cache_digest: WRONG, composition_seq: 11 } }
      : null,
  );
  const failures = [];
  w.io.failed = (f) => failures.push(f);
  const r = await run(w);
  assert.match(
    String(r.error?.message),
    /the follower at snapshot page 42: follower's live cache changed before the activation \[the second stored read of capture 1\]/,
  );
  assert.ok(failures[0]?.capture, "the failure carries its facts");
  const f = failures[0].capture;
  assert.deepEqual(
    [f.reader, f.barrier, f.held_seq, f.phase, f.predicate, f.endpoint, f.read],
    [
      "follower",
      "staged",
      42,
      "before_activation",
      "stored.staged",
      "second",
      1,
    ],
  );
  assert.deepEqual(
    [
      f.expected.oldDigest,
      f.expected.generation,
      f.expected.rowsAtLeast,
      f.expected.witness,
    ],
    [OLD, 6, 3, null],
  );
  assert.equal(f.stored.cache_digest, OLD);
  assert.equal(f.stored_after?.cache_digest, WRONG);
  assert.equal(f.capture.storage.status, "changed");
  assert.equal(f.document, "follower-document");
  assert.equal(f.incarnation, "incarnation-1");
  assert.ok(!("label" in f.expected) && !("mismatch" in f.expected));
});
for (const [name, opts, caller, predicate] of [
  [
    "a rendering-side invalidation failure (no notice)",
    { fault: "no-notice", caller: "recovery" },
    "recovery",
    "rendering.invalidated",
  ],
  [
    "a rendering-side staging failure (the fence cleared early)",
    { fault: "early-fence-clear", caller: "recovery" },
    "recovery",
    "rendering.staged",
  ],
  [
    "a barrier failure (a single snapshot page)",
    { pages: 1 },
    "ordinary",
    "held.pages",
  ],
  [
    "a barrier failure (a foreign answer held)",
    { fault: "foreign-held", pages: 4 },
    "ordinary",
    "held.snapshot",
  ],
])
  test(`R31 C5: ${name} carries its facts (revision 30 passed none)`, async () => {
    const w = world(opts);
    const failures = [];
    w.io.failed = (f) => failures.push(f);
    const r = await run(w, { caller });
    assert.ok(r.error);
    assert.equal(failures.length, 1);
    assert.equal(failures[0]?.capture?.predicate, predicate);
    if (predicate.startsWith("rendering."))
      assert.equal(failures[0]?.capture?.stored?.incarnation, "incarnation-1");
  });
test("R31 Q4 refused: the follower reads a NEWER generation than the leader's at the invalidation (bound from the leader's validated sample, before the follower's read)", async () => {
  const w = world({ pages: 3 });
  let injected = null;
  const { log, failures } = composed(w, (c) => {
    if (injected || c.who !== "follower" || c.barrier !== "invalidated")
      return null;
    injected = c;
    return {
      storageBefore: { recovery_generation: 7 },
      storageAfter: { recovery_generation: 7 },
    };
  });
  const r = await run(w);
  const at = log.find((x) => x.who === "follower" && x.n === injected.n);
  const f = refusedAt(
    r,
    log,
    failures,
    at,
    0,
    w,
    /follower does not read the leader's generation 6 \(7\) \[the first stored read of capture 1\]/,
  );
  assert.equal(f.expected.generation, 6);
});
