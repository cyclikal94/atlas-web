// WEB-09c revision 28 (R28-DIAG.a; design assessment Q1): the MAINTAINED schedule of the real-410 cases — `queueContinuation`, `expiryControl`
// and XL0's `reloadHook` from pair-schedule.mjs, composed exactly as tests/pair/pair.development.spec.ts composes them — against
// deterministic stand-ins: a request gate, a store, a tap log with causal positions, the diagnostic control and a page that reloads. A real
// non-empty opaque continuation is used throughout. Nothing waits on a real clock: every poll is bounded by a count.
//
// The revision-27 defect (the hook compared with an outer token assigned only when the helper returned, after the hook) is the healthy
// control's dependency: the hook must see the continuation BEFORE it runs, so the reload boundary is crossed and the gate opens after it.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  continuationOf,
  expiryControl,
  queueContinuation,
  reloadedRequest,
  reloadHook,
  UNCHANGED_BY_CLOCK,
} from "./pair-schedule.mjs";

const TOKEN = "d2.opaque-real-continuation";
const START = 1_000_000;
const RETENTION = 7_776_000;
const E = START + RETENTION;
const HEADER = { index: 2, expiry: E, revision: 9, boundary: 7 };
const LABEL = "PAIR-XL0:chromium:iv";

/** A bounded poll (a count, not a clock): `read` until `accept`, else throws with `what`. */
async function untilCount(read, accept, what, tries = 20) {
  for (let i = 0; i < tries; i += 1) {
    const v = await read();
    if (v && accept(v)) return v;
    await Promise.resolve();
  }
  throw new Error(`${what}: not reached in ${tries} polls`);
}

/**
 * The stand-in world. `fault`: "stored-other" (the page stores another cursor), "reload-other-cursor" (the reloaded page asks with another
 * cursor), "reload-stale-only" (the reloaded page never asks: only the departed page's request is at the gate), "reload-other-label" (the
 * reloaded request belongs to another interval), "reload-stores-other" (after the reload the stored cursor differs), "minus-refused" (E−1
 * answers 410), "baseline-moved" (inspect after E differs), "hook-rejects", "control-rejects".
 */
function world({ fault = null } = {}) {
  const events = [];
  const gates = [];
  let j = 0;
  const next = () => {
    j += 1;
    return j;
  };
  const store = { cursor: null, stage: null };
  const tap = [];
  let pageDocument = 1;
  const log = (e) => events.push(e);
  const queueRequest = (cursor, label = LABEL) => {
    tap.push({
      seq: tap.length + 1,
      label,
      gated: true,
      query: { cursor },
      j_request: next(),
      document: pageDocument,
    });
  };
  const queueIo = {
    headerOf: (t) => {
      assert.equal(
        t,
        TOKEN,
        "the header is read from the held piece's own token",
      );
      return HEADER;
    },
    gate: async (open) => {
      gates.push(open);
      log(open ? "gate_closed" : "gate_opened");
    },
    release: async () => {
      log("piece_released");
      store.cursor = fault === "stored-other" ? "d2.other" : TOKEN;
      store.stage = HEADER.index;
      queueRequest(store.cursor);
    },
    untilStored: (ctx) =>
      untilCount(
        async () => store,
        (s) => s.cursor === ctx.token && s.stage === ctx.header.index,
        "the staged piece persisted, its continuation stored",
      ).then(() => log("stored")),
    untilGated: (ctx) =>
      untilCount(
        async () => tap.find((r) => r.gated && r.query.cursor === ctx.token),
        Boolean,
        "the continuation queued at the gate",
      ).then(() => log("gated")),
  };
  const inspect = {
    revision_clock: 9,
    accounts: ["a"],
    batches: 3,
    receipts_sha256: "r",
    resources_sha256: "s",
    sessions: 2,
  };
  const controls = {};
  const probes = {};
  let clock = START;
  let seq = 0;
  const expiryIo = {
    receipt: { sync_start: START, retention_seconds: RETENTION },
    diagnostic: async (op, args) => {
      seq += 1;
      log(op === "inspect" ? "inspect" : `advance:${args.time - E}`);
      if (op === "inspect")
        return {
          seq,
          result:
            fault === "baseline-moved" && controls.advance_e !== undefined
              ? { ...inspect, batches: 4 }
              : inspect,
        };
      const from = clock;
      clock = args.time;
      return { seq, result: { from, to: clock } };
    },
    probeAt: async (label, t) => {
      log(`probe:${label}`);
      assert.equal(t, TOKEN, "the E−1 probe uses the queued continuation");
      return { status: fault === "minus-refused" ? 410 : 200 };
    },
    sessionLive: async () => {
      log("session_live");
      return { status: 200 };
    },
    controls,
    probes,
  };
  const seen = { before: null, after: null, reloadStored: null };
  const marks = {};
  const reloadIo = {
    mark: async (name) => {
      marks[name] = next();
      log(`mark:${name}`);
      return marks[name];
    },
    beforeReload: async () => log("trace_kept"),
    reload: async () => {
      log("reloaded");
      pageDocument += 1;
      if (fault === "reload-stores-other") store.cursor = "d2.rewritten";
      if (fault === "reload-stale-only") return;
      // The reloaded page asks with the continuation; with "reload-stores-other" its stored cursor alone differs (the request check passes).
      queueRequest(
        fault === "reload-other-cursor" ? "d2.another" : TOKEN,
        fault === "reload-other-label" ? "PAIR-X0:chromium:iv" : LABEL,
      );
    },
    records: async () => [...tap],
    stored: async () => ({ ...store }),
    until: (read, accept, what) => untilCount(read, accept, what),
    label: LABEL,
    after: async (s) => {
      seen.reloadStored = s;
      log("after_reload_barrier");
    },
  };
  const hooks = {
    beforeInspect: async (ctx) => {
      seen.before = ctx;
      log("local_work_admitted");
    },
    afterE: async (ctx) => {
      seen.after = ctx;
      if (fault === "hook-rejects") throw new Error("the reload failed");
      await reloadHook(reloadIo)(ctx);
    },
  };
  return {
    events,
    gates,
    tap,
    store,
    controls,
    probes,
    marks,
    seen,
    queueIo,
    expiryIo,
    reloadIo,
    hooks,
  };
}
const held = (cursor = TOKEN) => ({ seq: 17, next_cursor: cursor });
/** XL0's composition, as the spec makes it: queueContinuation(record, expiryControl(hooks with reloadHook)). */
const xl0 = (w, record = held()) =>
  queueContinuation(w.queueIo, record, expiryControl(w.expiryIo, w.hooks)).then(
    (value) => ({ value }),
    (error) => ({ error }),
  );

test("Q1 control (XL0): the reload hook receives the continuation BEFORE it runs, crosses the reload boundary, and the gate opens after it", async () => {
  const w = world();
  const r = await xl0(w);
  assert.equal(r.error?.message, undefined);
  assert.equal(r.value.token, TOKEN);
  assert.equal(w.seen.before?.token, TOKEN, "beforeInspect saw the token");
  assert.equal(w.seen.after?.token, TOKEN, "afterE saw the token");
  assert.ok(Object.isFrozen(w.seen.after), "the context is immutable");
  assert.equal(
    w.seen.reloadStored?.cursor,
    TOKEN,
    "the reloaded page's stored cursor",
  );
  assert.deepEqual(w.gates, [true, false], "closed once, opened once");
  assert.deepEqual(w.events, [
    "gate_closed",
    "piece_released",
    "stored",
    "gated",
    "local_work_admitted",
    "inspect",
    "advance:-1",
    "probe:x0-e-minus-1",
    "advance:0",
    "session_live",
    "inspect",
    "mark:reload_begin",
    "trace_kept",
    "reloaded",
    "mark:reload_end",
    "after_reload_barrier",
    "gate_opened",
  ]);
  // The reloaded request is the NEW document's, requested after the reload began; the departed page's stays the lost one.
  const again = reloadedRequest(w.tap, {
    label: LABEL,
    token: TOKEN,
    begin: w.marks.reload_begin,
  });
  assert.equal(again?.document, 2);
  assert.ok(again.j_request > w.marks.reload_begin);
  assert.equal(w.tap.filter((x) => x.query.cursor === TOKEN).length, 2);
  assert.deepEqual(Object.keys(w.controls), [
    "inspect_before",
    "advance_e_minus_1",
    "advance_e",
    "inspect_after_e",
  ]);
  assert.deepEqual(Object.keys(w.probes), ["e_minus_1", "session_after_e"]);
});
test("Q1 control (X0/XR0): the same schedule without hooks; (X2/XR2) a control receives the context directly", async () => {
  const w = world();
  const r = await queueContinuation(
    w.queueIo,
    held(),
    expiryControl(w.expiryIo),
  ).then(
    (value) => ({ value }),
    (error) => ({ error }),
  );
  assert.equal(r.error?.message, undefined);
  assert.equal(w.events.at(-2), "inspect");
  assert.equal(w.events.at(-1), "gate_opened");
  const p = world();
  let given = null;
  const r2 = await queueContinuation(p.queueIo, held(), async (ctx) => {
    given = ctx;
  });
  assert.equal(r2.token, TOKEN);
  assert.equal(given?.token, TOKEN);
  assert.deepEqual(given?.header, HEADER);
  assert.deepEqual(p.gates, [true, false]);
});
for (const [name, opts, expected] of [
  [
    "the page stores another continuation",
    { fault: "stored-other" },
    /continuation stored: not reached/,
  ],
  [
    "the reloaded page asks with another cursor",
    { fault: "reload-other-cursor" },
    /asks again from the stored continuation: not reached/,
  ],
  [
    "only the departed page's (stale) request is at the gate",
    { fault: "reload-stale-only" },
    /asks again from the stored continuation: not reached/,
  ],
  [
    "the reloaded request belongs to another interval",
    { fault: "reload-other-label" },
    /asks again from the stored continuation: not reached/,
  ],
  [
    "the reloaded page's stored cursor is not the continuation",
    { fault: "reload-stores-other" },
    /asks again from the stored continuation: not reached/,
  ],
  [
    "E−1 already refuses the continuation",
    { fault: "minus-refused" },
    /the token is valid at E−1/,
  ],
  [
    "the clock steps moved the durable baseline",
    { fault: "baseline-moved" },
    /batches unchanged by the clock steps/,
  ],
  ["the reload hook fails", { fault: "hook-rejects" }, /the reload failed/],
])
  test(`Q1 refused: ${name} — the failure propagates and the gate stays CLOSED`, async () => {
    const w = world(opts);
    const r = await xl0(w);
    assert.match(String(r.error?.message), expected);
    assert.deepEqual(w.gates, [true], "never opened on failure");
  });
test("Q1 refused: a held piece without a continuation never closes the gate", async () => {
  for (const record of [
    { seq: 17, next_cursor: "" },
    { seq: 17, next_cursor: null },
    { seq: 17 },
    { seq: 17, next_cursor: 7 },
  ]) {
    const w = world();
    const r = await xl0(w, record);
    assert.match(String(r.error?.message), /carries no continuation to queue/);
    assert.deepEqual(w.gates, []);
  }
});
test("Q1 refused: a control that rejects leaves the gate closed and is not reported as success", async () => {
  const w = world();
  const r = await queueContinuation(w.queueIo, held(), async () => {
    throw new Error("diagnostic command latched");
  }).then(
    (value) => ({ value }),
    (error) => ({ error }),
  );
  assert.match(String(r.error?.message), /diagnostic command latched/);
  assert.equal(r.value, undefined);
  assert.deepEqual(w.gates, [true]);
});
test("Q1 rules: the reloaded request is matched by label, gate, the context's cursor and a causal position after the reload began", () => {
  const records = [
    { label: LABEL, gated: true, query: { cursor: TOKEN }, j_request: 4 },
    { label: "other", gated: true, query: { cursor: TOKEN }, j_request: 9 },
    { label: LABEL, gated: false, query: { cursor: TOKEN }, j_request: 10 },
    { label: LABEL, gated: true, query: { cursor: "x" }, j_request: 11 },
  ];
  assert.equal(
    reloadedRequest(records, { label: LABEL, token: TOKEN, begin: 5 }),
    null,
  );
  const fresh = {
    label: LABEL,
    gated: true,
    query: { cursor: TOKEN },
    j_request: 12,
  };
  assert.equal(
    reloadedRequest([...records, fresh], {
      label: LABEL,
      token: TOKEN,
      begin: 5,
    }),
    fresh,
  );
  assert.equal(
    reloadedRequest([...records, fresh], { label: LABEL, token: "", begin: 5 }),
    null,
    "an empty token never matches",
  );
  assert.deepEqual(
    [...UNCHANGED_BY_CLOCK],
    [
      "revision_clock",
      "accounts",
      "batches",
      "receipts_sha256",
      "resources_sha256",
      "sessions",
    ],
  );
  assert.throws(
    () => continuationOf({ seq: 1, next_cursor: "" }, () => ({})),
    /no continuation/,
  );
});
