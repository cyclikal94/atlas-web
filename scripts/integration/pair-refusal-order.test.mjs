// WEB-09c revision 39 (R39-DIAG, family `segmented-sync-development-pairing`; design assessment C1–C4, Q1–Q5): XL0's two refusals of one
// continuation — the DEPARTED page's request queued before the clock steps and the RELOADED page's own request — handled by identity,
// whatever order their answers become available in. Everything here is the MAINTAINED code: `queueContinuation`, `expiryControl`,
// `reloadHook` and `refusalPair` (pair-schedule.mjs) composed as tests/pair/pair.development.spec.ts composes them, the real driver `drive`
// (pair-driver.mjs) with its ledger and `pickHeld` (pair-attempts.mjs).
//
//   - Q1: a deterministic world. Requests are recorded by a tap with causal positions; the gate forwards both gated requests at once; an
//     answer is held only once its upstream COMPLETED, and the test's completion schedule decides which completes first (departed first,
//     live first with the departed several polls later, both together, a permuted held list). A client model stores like W27 and, on a
//     delivered 410, invalidates and asks for a snapshot. Polls are counted, never timed: the driver's clock is a counter.
//   - Q2: sensitivity to the original omission. The verbatim pre-revision-39 XL0 branches (restated below, labelled) with the driver's
//     default selection pass departed-first and fail live-first exactly as review run PAIR-XL0-chromium-370f3ae03603 did (`stored cursor`);
//     the coordinator without its selection fails closed instead.
//   - Q3: the hand-off boundary: after the hand-off no departed answer is held, so the recovery observer's own selection (records after
//     the refusal, entries it has not handled) reaches the snapshot; the original configuration strands the old id.
//   - Q4: identity and failure closure: binding refusals, ambiguity, a missing/wrong/undelivered answer, a failed release, a failed
//     held-refusal preparation, an unexpected held answer, a mis-joined entry. Every failure propagates and the live refusal stays held.
//   - Q5: the real tap → holding proxy hop with a loopback backend whose two 410s are completed by explicitly resolved promises in each
//     order; the attempts are joined to the proxy's log as the spec joins them.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, before, describe, test } from "node:test";
import { createJournal } from "./causal-journal.mjs";
import { createProxy } from "./delaying-proxy.mjs";
import {
  CORRELATION_HEADER,
  createLedger,
  pickHeld,
} from "./pair-attempts.mjs";
import { drive } from "./pair-driver.mjs";
import { joinExchanges } from "./pair-evidence.mjs";
import {
  expiryControl,
  queueContinuation,
  refusalPair,
  reloadedRequest,
  reloadHook,
} from "./pair-schedule.mjs";
import { createTap } from "./pair-tap.mjs";

const TOKEN = "d2.opaque-real-continuation";
const START = 1_000_000;
const RETENTION = 7_776_000;
const E = START + RETENTION;
const HEADER = { index: 2, expiry: E, revision: 9, boundary: 7 };
const LABEL = "PAIR-XL0:node:iv";
const RULE = "r1";
const REFUSAL = {
  status: 410,
  code: "resync_required",
  batches: null,
  revision: null,
  last_revision: null,
  segment: null,
  has_more: null,
  next_cursor: null,
};
const REASON =
  "the server's real 410 (expiry) to the reloaded page: the recovery is observed";

/** A bounded poll (a count, not a clock). */
async function untilCount(read, accept, what, tries = 20) {
  for (let i = 0; i < tries; i += 1) {
    const v = await read();
    if (v && accept(v)) return v;
    await Promise.resolve();
  }
  throw new Error(`${what}: not reached in ${tries} polls`);
}

/**
 * The deterministic world. `order`: "departed-first", "live-first" (the departed answer completes `lag` polls after the live one),
 * "simultaneous", "departed-never". `permute`: the held list is reported newest first. `faults`: "departed-200" (the departed request is
 * answered with a piece), "live-200", "departed-release-0" (releasing the departed entry releases nothing), "live-gone" (the live client is
 * gone at its release), "extra-held" (a third request of the interval is held), "mis-joined" (a second tap record claims the live entry),
 * "reload-twice" (the reloaded page's request is recorded twice). `snapshot`: "immediate" (the snapshot request completes when asked) or
 * "never".
 */
function world({
  order = "departed-first",
  lag = 3,
  permute = false,
  faults = [],
  snapshot = "immediate",
} = {}) {
  let j = 0;
  const next = () => {
    j += 1;
    return j;
  };
  const tap = [];
  const entries = new Map(); // proxy id → { seq, document, released, outcome }
  const held = [];
  const releases = [];
  const gate = { closed: false, waiting: [] };
  let document = 1;
  const departedDocuments = new Set();
  let polls = 0;
  let liveHeldAtPoll = null;
  const completeAt = new Map(); // seq → poll number at which its upstream completes (Infinity: never)
  const store = {
    cursor: "c1",
    delta_stage: { revision: 9, next_index: 1 },
    page_seq: 4,
    applied_revision: 8,
    cache_digest: "old",
    composition_seq: 3,
    drafts: 0,
    staged: 1,
    recovery_generation: 1,
  };
  const answers = new Map(); // seq → the upstream answer to give at completion
  const request = (cursor, { extra = false, answer, at } = {}) => {
    const seq = tap.length + 1;
    const r = {
      seq,
      label: LABEL,
      path: "/api/experimental/v1/sync",
      method: "GET",
      query: { cursor },
      proxy_id: 100 + seq,
      status: null,
      j_request: next(),
      document,
      extra,
    };
    tap.push(r);
    entries.set(r.proxy_id, { seq, document, released: false, outcome: null });
    if (answer) answers.set(seq, answer);
    if (at !== undefined) completeAt.set(seq, at);
    if (gate.closed) {
      r.gated = true;
      gate.waiting.push(r);
    } else forward(r);
    return r;
  };
  const complete = (r) => {
    if (r.status !== null) return;
    Object.assign(r, answers.get(r.seq) ?? REFUSAL, {
      j_upstream_end: next(),
    });
    held.push(r.proxy_id);
  };
  const forward = (r) => {
    r.t_gate_open = r.gated ? next() : undefined;
    if (r.gated) r.j_gate_open = r.t_gate_open;
    const at = completeAt.get(r.seq);
    if (at === undefined || at <= polls) complete(r);
  };
  // The scheduled piece (revision 9, index 1, the continuation) is already held when the drive begins.
  const piece = {
    seq: 0,
    label: LABEL,
    path: "/api/experimental/v1/sync",
    method: "GET",
    query: { cursor: "c1" },
    proxy_id: 100,
    status: 200,
    batches: 1,
    revision: 9,
    last_revision: 9,
    segment: { index: 1, last: false },
    has_more: true,
    next_cursor: TOKEN,
    j_request: next(),
    j_upstream_end: next(),
  };
  tap.push(piece);
  entries.set(100, { seq: 0, document: 1, released: false, outcome: null });
  held.push(100);
  // The client: stores the piece (W27), then asks with its continuation; a delivered 410 invalidates and asks for a snapshot.
  const deliver = (r) => {
    if (r.status === 200 && r.segment && !r.segment.last) {
      store.cursor = r.next_cursor;
      store.delta_stage = {
        revision: r.revision,
        next_index: r.segment.index + 1,
      };
      store.staged += 1;
      request(store.cursor);
      return;
    }
    if (r.status === 410) {
      store.cursor = null;
      store.delta_stage = null;
      store.staged = 0;
      store.recovery_generation += 1;
      // The snapshot request: answered at once, or (as in the review's attempt, where it completed after the departed answer) never here.
      request(null, {
        answer: {
          status: 200,
          batches: 3,
          revision: 13,
          last_revision: 13,
          segment: null,
          has_more: false,
          next_cursor: "e13",
          phase: "snapshot",
        },
        at: snapshot === "immediate" ? polls : Number.POSITIVE_INFINITY,
      });
    }
  };
  // The completion schedule: which of the two forwarded refusals completes first.
  const schedule = (departed, live) => {
    const at = {
      "departed-first": [0, lag],
      "live-first": [lag, 0],
      simultaneous: [0, 0],
      "departed-never": [Number.POSITIVE_INFINITY, 0],
    }[order];
    completeAt.set(departed.seq, polls + at[0]);
    completeAt.set(live.seq, polls + at[1]);
    if (faults.includes("departed-200"))
      answers.set(departed.seq, {
        status: 200,
        batches: 1,
        revision: 9,
        last_revision: 9,
        segment: { index: 2, last: false },
        has_more: true,
        next_cursor: "d2.next",
      });
    if (faults.includes("live-200"))
      answers.set(live.seq, {
        status: 200,
        batches: 1,
        revision: 9,
        last_revision: 9,
        segment: { index: 2, last: false },
        has_more: true,
        next_cursor: "d2.next",
      });
  };
  const tick = () => {
    polls += 1;
    for (const r of tap)
      if (r.status === null && r.t_gate_open !== undefined) {
        const at = completeAt.get(r.seq);
        if (at !== undefined && at <= polls) complete(r);
      }
    const live = tap.find((r) => r.document === 2 && r.gated);
    if (live && held.includes(live.proxy_id) && liveHeldAtPoll === null)
      liveHeldAtPoll = polls;
  };
  let clock = 0;
  const driveIo = {
    held: async () => (permute ? [...held].reverse() : [...held]),
    records: async () => tap.map((r) => ({ ...r })),
    read: async () => structuredClone(store),
    release: async (_rule, id) => {
      const at = held.indexOf(id);
      if (at < 0) return { released: 0, outcomes: [] };
      const e = entries.get(id);
      const r = tap.find((x) => x.proxy_id === id);
      if (faults.includes("departed-release-0") && r.document === 1 && r.gated)
        return { released: 0, outcomes: [] };
      // "departed-stays-held": the proxy reports the release but the entry is still listed as held.
      if (
        !(faults.includes("departed-stays-held") && r.document === 1 && r.gated)
      )
        held.splice(at, 1);
      const gone =
        departedDocuments.has(e.document) ||
        (faults.includes("live-gone") && r.document === 2 && r.gated);
      e.released = true;
      e.outcome = gone ? "client_gone" : "delivered";
      releases.push({ proxy_id: id, seq: r.seq, outcome: e.outcome });
      if (!gone) deliver(r);
      return { released: 1, outcomes: [{ id, outcome: e.outcome }] };
    },
    nudge: async () => undefined,
    waitFor: async () => {
      throw new Error("no activation in this world");
    },
    barrier: () => undefined,
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
      tick();
    },
  };
  const marks = {};
  const controls = {};
  const probes = {};
  let inspect = 0;
  const expiryIo = {
    receipt: { sync_start: START, retention_seconds: RETENTION },
    diagnostic: async (op, args) => {
      inspect += 1;
      if (op === "inspect")
        return { seq: inspect, result: { revision_clock: 9, batches: 3 } };
      return {
        seq: inspect,
        result: {
          from: args.time === E ? E - 1 : START,
          to: args.time,
        },
      };
    },
    probeAt: async () => ({ status: 200 }),
    sessionLive: async () => ({ status: 200 }),
    controls,
    probes,
  };
  const reloadIo = (pair) => ({
    mark: async (name) => {
      marks[name] = next();
      return marks[name];
    },
    beforeReload: async () => undefined,
    reload: async () => {
      departedDocuments.add(document);
      document += 1;
      request(store.cursor);
      if (faults.includes("reload-twice")) request(store.cursor);
    },
    records: async () => tap.map((r) => ({ ...r })),
    stored: async () => ({ ...store }),
    until: (read, accept, what) => untilCount(read, accept, what),
    label: LABEL,
    after: async () => undefined,
    reloaded: pair ? (r, at) => pair.reloaded(r, at) : undefined,
  });
  const queueIo = (release, pair) => ({
    headerOf: (t) => {
      assert.equal(t, TOKEN);
      return HEADER;
    },
    gate: async (closed) => {
      gate.closed = closed;
      if (!closed) {
        const departed = tap.find((r) => r.document === 1 && r.gated);
        const live = tap.find((r) => r.document === 2 && r.gated);
        if (departed && live) schedule(departed, live);
        if (faults.includes("extra-held")) {
          const x = tap.find((r) => r.document === 2 && r.gated);
          const extra = {
            ...x,
            seq: tap.length + 1,
            proxy_id: 999,
            query: { cursor: "d2.other" },
            j_request: next(),
            status: null,
          };
          tap.push(extra);
          entries.set(999, {
            seq: extra.seq,
            document: 2,
            released: false,
            outcome: null,
          });
          gate.waiting.push(extra);
          completeAt.set(extra.seq, polls);
        }
        if (faults.includes("mis-joined")) {
          const l = tap.find((r) => r.document === 2 && r.gated);
          tap.push({ ...l, seq: tap.length + 1, gated: false });
        }
        for (const r of gate.waiting.splice(0)) forward(r);
      }
    },
    release,
    untilStored: (ctx) =>
      untilCount(
        async () => store,
        (s) =>
          s.cursor === ctx.token &&
          s.delta_stage?.next_index === ctx.header.index,
        "the staged piece persisted, its continuation stored",
      ),
    untilGated: (ctx) =>
      untilCount(
        async () =>
          tap.find((r) => r.gated && r.query.cursor === ctx.token) ?? null,
        Boolean,
        "the continuation queued at the gate",
      ).then((r) => ({ ...r })),
    queued: pair ? (r, ctx) => pair.queued(r, ctx) : undefined,
  });
  return {
    tap,
    held,
    releases,
    store,
    marks,
    entries,
    get polls() {
      return polls;
    },
    get liveHeldAtPoll() {
      return liveHeldAtPoll;
    },
    driveIo,
    expiryIo,
    reloadIo,
    queueIo,
  };
}

const model = () => ({
  cursor: "c1",
  boundary: "c0",
  stage: { revision: 9, next_index: 1 },
  activated: null,
  restarted: 0,
  pages: 0,
});

/**
 * XL0's composition, as the spec composes it (revision 39): the scheduled piece queues its continuation (the departed request bound by
 * `queued`), the expiry control's `afterE` reloads (the live request bound by `reloaded`), and every later answer goes to `pair.answer`.
 * `live(record, w)` stands in for `atHeldRefusal`. `select: false` gives the driver its default selection (the omission's sensitivity).
 */
async function xl0(w, { select = true, live } = {}) {
  const pair = refusalPair({ label: LABEL });
  const seen = { lost: null, refused: null, atLive: null };
  let staged = null;
  const ledger = createLedger();
  const run = await drive(w.driveIo, {
    ruleId: RULE,
    base: structuredClone(w.store),
    model: model(),
    ledger,
    heldTimeoutMs: 2000,
    select: select ? pair.select : undefined,
    start: async () => ({ revision: 9, source: "the grant receipt" }),
    onHeld: async ({ record, piece, release }) => {
      if (staged === null && piece?.index === 1) {
        staged = record;
        await queueContinuation(
          w.queueIo(release, pair),
          record,
          expiryControl(w.expiryIo, { afterE: reloadHook(w.reloadIo(pair)) }),
        );
        return undefined;
      }
      return pair.answer(
        { record, release },
        {
          lost: (r) => {
            seen.lost = r;
          },
          live: async (r) => {
            seen.refused = r;
            seen.atLive = {
              held: w.held.includes(r.proxy_id),
              released: w.releases.some((x) => x.proxy_id === r.proxy_id),
              cursor: w.store.cursor,
              next_index: w.store.delta_stage?.next_index ?? null,
              generation: w.store.recovery_generation,
            };
            await live?.(r, w);
          },
        },
      );
    },
  }).then(
    (value) => ({ value }),
    (error) => ({ error }),
  );
  return { ...run, pair, seen, ledger };
}

/**
 * The verbatim pre-revision-39 XL0 refusal branches (tests/pair/pair.development.spec.ts at 455ab3e, lines 1764–1788), restated over this
 * world's markers: the omission R39-DIAG names. Kept ONLY as the sensitivity control (Q2); the spec no longer contains them.
 */
async function legacyXl0(w) {
  let staged = null;
  let lost = null;
  let refused = null;
  const m = { marks: w.marks };
  const ledger = createLedger();
  const run = await drive(w.driveIo, {
    ruleId: RULE,
    base: structuredClone(w.store),
    model: model(),
    ledger,
    heldTimeoutMs: 2000,
    start: async () => ({ revision: 9, source: "the grant receipt" }),
    onHeld: async ({ record, piece, release }) => {
      if (staged === null && piece?.index === 1) {
        staged = record;
        await queueContinuation(
          w.queueIo(release, null),
          record,
          expiryControl(w.expiryIo, { afterE: reloadHook(w.reloadIo(null)) }),
        );
        return undefined;
      }
      if (
        staged !== null &&
        lost === null &&
        record.status === 410 &&
        (record.j_request ?? 0) < (m.marks.reload_begin ?? 0)
      ) {
        lost = record;
        await release();
        return { delivered: false };
      }
      if (lost !== null && refused === null && record.status === 410) {
        refused = record;
        return { stop: true, reason: REASON };
      }
      return undefined;
    },
  }).then(
    (value) => ({ value }),
    (error) => ({ error }),
  );
  return { ...run, lost, refused, ledger };
}

const departedOf = (w) => w.tap.find((r) => r.document === 1 && r.gated);
const liveOf = (w) => w.tap.find((r) => r.document === 2 && r.gated);

/** The healthy outcome, whatever the completion order. */
function assertHealthy(w, r, what) {
  assert.equal(r.error?.message, undefined, `${what}: the drive completes`);
  const D = departedOf(w);
  const L = liveOf(w);
  assert.equal(r.seen.lost?.seq, D.seq, `${what}: the departed request lost`);
  assert.equal(r.seen.refused?.seq, L.seq, `${what}: the live refusal`);
  assert.deepEqual(
    r.seen.atLive,
    {
      held: true,
      released: false,
      cursor: TOKEN,
      next_index: 2,
      generation: 1,
    },
    `${what}: the live refusal is observed while HELD, the stored continuation untouched`,
  );
  assert.deepEqual(r.value.handOff, { at_seq: L.seq, reason: REASON });
  assert.deepEqual(
    r.value.attempts.map((a) => [a.seq, a.client, a.downstream, a.effect]),
    [
      [0, "received", "delivered", "staged"],
      [D.seq, "lost", "client_gone", "none"],
      [L.seq, "received", "delivered", "none"],
    ],
    `${what}: one lost departed attempt, one received live attempt`,
  );
  // One release per entry: the departed first, then the live refusal (at the hand-off).
  assert.deepEqual(
    w.releases.map((x) => x.seq),
    [0, D.seq, L.seq, ...w.releases.slice(3).map((x) => x.seq)],
  );
  assert.equal(w.releases.filter((x) => x.seq === L.seq).length, 1);
  assert.equal(w.releases.filter((x) => x.seq === D.seq).length, 1);
  assert.deepEqual(r.pair.bound(), {
    label: LABEL,
    departed: { seq: D.seq, proxy_id: D.proxy_id, j_request: D.j_request },
    live: { seq: L.seq, proxy_id: L.proxy_id, j_request: L.j_request },
    reload_begin: w.marks.reload_begin,
  });
  assert.ok(D.j_request < w.marks.reload_begin);
  assert.ok(w.marks.reload_begin < L.j_request);
  // No departed answer is left held at the hand-off.
  assert.equal(w.held.includes(D.proxy_id), false);
}

describe("Q1: the maintained XL0 composition, in every completion order", () => {
  test("departed first (the order the old branches supported): one lost, one live hand-off", async () => {
    const w = world({ order: "departed-first" });
    const r = await xl0(w);
    assertHealthy(w, r, "departed first");
    assert.ok(departedOf(w).j_upstream_end < liveOf(w).j_upstream_end);
  });
  test("live first, the departed answer several polls later: the live refusal is left HELD and untouched until the departed one is accounted", async () => {
    const w = world({ order: "live-first", lag: 5 });
    const r = await xl0(w);
    assertHealthy(w, r, "live first");
    // The real completion chronology is kept: the live answer completed (and was held) first.
    assert.ok(liveOf(w).j_upstream_end < departedOf(w).j_upstream_end);
    assert.ok(
      w.liveHeldAtPoll !== null && w.liveHeldAtPoll < 5,
      "the live answer was held polls before the departed one completed",
    );
  });
  test("both completed together, and a permuted (newest-first) held list: identity, never list order, decides", async () => {
    for (const [order, permute] of [
      ["simultaneous", false],
      ["simultaneous", true],
      ["live-first", true],
      ["departed-first", true],
    ]) {
      const w = world({ order, permute });
      assertHealthy(w, await xl0(w), `${order}${permute ? " permuted" : ""}`);
    }
  });
});

describe("Q2: sensitivity to the original omission", () => {
  test("the verbatim pre-revision-39 branches pass departed-first (the positive control)", async () => {
    const w = world({ order: "departed-first", snapshot: "never" });
    const r = await legacyXl0(w);
    assert.equal(r.error?.message, undefined);
    assert.equal(r.lost?.seq, departedOf(w).seq);
    assert.equal(r.refused?.seq, liveOf(w).seq);
  });
  test("the verbatim pre-revision-39 branches fail live-first exactly as the review's attempt did: the live 410 released as an ordinary answer, then `stored cursor`", async () => {
    const w = world({ order: "live-first", snapshot: "never" });
    const r = await legacyXl0(w);
    assert.match(String(r.error?.message), /attempt \d+: stored cursor/);
    assert.equal(r.refused, null, "no hand-off, no held-refusal observation");
    // The live refusal reached the client unobserved (the client then began its snapshot recovery).
    const L = liveOf(w);
    assert.deepEqual(
      w.releases.find((x) => x.seq === L.seq),
      { proxy_id: L.proxy_id, seq: L.seq, outcome: "delivered" },
    );
    assert.equal(w.store.cursor, null);
  });
  test("the coordinator WITHOUT its selection (the wait bypassed) fails closed live-first, never releasing the live refusal; departed-first still passes", async () => {
    const w = world({ order: "live-first" });
    const r = await xl0(w, { select: false });
    assert.match(
      String(r.error?.message),
      /live refusal \d+ is handled before the departed request \d+ was accounted/,
    );
    const L = liveOf(w);
    assert.equal(
      w.releases.some((x) => x.seq === L.seq),
      false,
    );
    assert.equal(w.held.includes(L.proxy_id), true);
    const ok = world({ order: "departed-first" });
    assertHealthy(
      ok,
      await xl0(ok, { select: false }),
      "no selection, departed first",
    );
  });
});

describe("Q3: the hand-off boundary", () => {
  // The recovery observer's own selection (pair-recovery.mjs `nextHeld`): entries it has not handled, records after the refusal.
  const recoveryPick = (held, records, refusalSeq, handled = new Set()) =>
    pickHeld(
      held.filter((id) => !handled.has(id)),
      records.filter((r) => r.seq > refusalSeq),
    );
  test("after the corrected hand-off no departed answer is held: the observer's selection reaches the snapshot, in every order", async () => {
    for (const order of ["departed-first", "live-first", "simultaneous"]) {
      const w = world({ order });
      const r = await xl0(w);
      assertHealthy(w, r, order);
      const picked = recoveryPick(
        [...w.held],
        w.tap.map((x) => ({ ...x })),
        liveOf(w).seq,
      );
      assert.equal(picked?.record.query.cursor, null, `${order}: snapshot`);
      assert.equal(picked?.record.status, 200);
    }
  });
  test("the original configuration (an unaccounted departed answer still held at the hand-off) strands the observer: detected, not timed into success", async () => {
    const w = world({ order: "live-first" });
    const r = await xl0(w);
    assertHealthy(w, r, "live first");
    const D = departedOf(w);
    // Restore the old id to the held list as the original code left it (never released before the hand-off).
    const stranded = [D.proxy_id, ...w.held];
    const records = w.tap.map((x) => ({ ...x }));
    assert.equal(recoveryPick(stranded, records, liveOf(w).seq), null);
    assert.notEqual(recoveryPick([...w.held], records, liveOf(w).seq), null);
  });
});

describe("Q4: identity and failure closure", () => {
  const ctx = Object.freeze({ token: TOKEN, header: HEADER });
  const gated = (seq, proxy_id, j_request, extra = {}) => ({
    seq,
    proxy_id,
    j_request,
    label: LABEL,
    gated: true,
    query: { cursor: TOKEN },
    status: null,
    ...extra,
  });
  test("binding refuses a request that is not one of this pair", () => {
    const fresh = () => {
      const p = refusalPair({ label: LABEL });
      p.queued(gated(5, 105, 10), ctx);
      return p;
    };
    for (const [what, bind, expected] of [
      [
        "a departed request of another interval",
        (p) => p.queued(gated(5, 105, 10, { label: "PAIR-X0:node:iv" }), ctx),
        /belongs to PAIR-X0/,
      ],
      [
        "a departed request without its correlation",
        (p) => p.queued(gated(5, null, 10), ctx),
        /no tap seq and proxy correlation/,
      ],
      [
        "a departed request already forwarded",
        (p) => p.queued(gated(5, 105, 10, { t_gate_open: 11 }), ctx),
        /already forwarded/,
      ],
      [
        "a departed request with another cursor",
        (p) => p.queued(gated(5, 105, 10, { query: { cursor: "x" } }), ctx),
        /does not carry the continuation/,
      ],
      [
        "a departed request without a causal position",
        (p) => p.queued(gated(5, 105, null), ctx),
        /no causal request position/,
      ],
      [
        "a departed request that was not gated",
        (p) => p.queued(gated(5, 105, 10, { gated: false }), ctx),
        /not queued at the gate/,
      ],
      [
        "the live request before the departed one",
        (p) => p.reloaded(gated(6, 106, 30), { begin: 20, ctx }),
        /before the departed one/,
      ],
    ])
      assert.throws(() => bind(refusalPair({ label: LABEL })), expected, what);
    for (const [what, bind, expected] of [
      [
        "the departed request bound twice",
        (p) => p.queued(gated(7, 107, 11), ctx),
        /bound twice/,
      ],
      [
        "a live request requested before the reload began",
        (p) => p.reloaded(gated(6, 106, 15), { begin: 20, ctx }),
        /not on either side of the reload/,
      ],
      [
        "a reload that began before the departed request",
        (p) => p.reloaded(gated(6, 106, 30), { begin: 9, ctx }),
        /not on either side of the reload/,
      ],
      [
        "the departed request bound again as the live one",
        (p) => p.reloaded(gated(5, 105, 30), { begin: 20, ctx }),
        /is the departed one/,
      ],
      [
        "a live request with the departed entry's proxy id",
        (p) => p.reloaded(gated(6, 105, 30), { begin: 20, ctx }),
        /is the departed one/,
      ],
      [
        "a live request bound with another continuation",
        (p) =>
          p.reloaded(gated(6, 106, 30, { query: { cursor: "d2.x" } }), {
            begin: 20,
            ctx: { token: "d2.x", header: HEADER },
          }),
        /another continuation/,
      ],
    ])
      assert.throws(() => bind(fresh()), expected, what);
    const p = fresh();
    p.reloaded(gated(6, 106, 30), { begin: 20, ctx });
    assert.throws(
      () => p.reloaded(gated(6, 106, 30), { begin: 20, ctx }),
      /bound twice/,
    );
    assert.throws(() => refusalPair({ label: "" }), /one named interval/);
  });
  test("a selection while only the departed request is bound, or an answer then, fails", async () => {
    const p = refusalPair({ label: LABEL });
    assert.equal(p.select.pick([], []), null, "unbound: the default");
    assert.equal(
      await p.answer(
        { record: { seq: 1 }, release: async () => undefined },
        {},
      ),
      undefined,
      "unbound: an ordinary answer",
    );
    p.queued(gated(5, 105, 10), ctx);
    assert.throws(() => p.select.pick([105], []), /only the departed/);
    await assert.rejects(
      p.answer({ record: { seq: 5 }, release: async () => undefined }, {}),
      /only the departed request is bound/,
    );
  });
  test("a bound entry joined to another tap record, or an answer through another proxy entry, fails", async () => {
    const p = refusalPair({ label: LABEL });
    p.queued(gated(5, 105, 10), ctx);
    p.reloaded(gated(6, 106, 30), { begin: 20, ctx });
    const refusal = { status: 410, code: "resync_required" };
    assert.throws(
      () => p.select.pick([105], [{ seq: 9, proxy_id: 105, ...refusal }]),
      /proxy entry 105 is joined to tap record 9, not the bound 5/,
    );
    assert.equal(
      p.select.pick([106], [{ seq: 6, proxy_id: 106, ...refusal }]),
      null,
      "the live refusal is not selectable before the departed one",
    );
    let released = 0;
    await assert.rejects(
      p.answer(
        {
          record: { seq: 5, proxy_id: 999, ...refusal },
          release: async () => {
            released += 1;
          },
        },
        {},
      ),
      /came through proxy entry 999, not 105/,
    );
    await assert.rejects(
      p.answer(
        {
          record: { seq: 7, proxy_id: 107, ...refusal },
          release: async () => {
            released += 1;
          },
        },
        {},
      ),
      /neither the departed \(5\) nor the live \(6\)/,
    );
    assert.equal(released, 0, "nothing released on a refused answer");
  });
  test("the reloaded page's request recorded twice is ambiguity: the hook fails and the gate never opens", async () => {
    const w = world({ faults: ["reload-twice"] });
    const r = await xl0(w);
    assert.match(String(r.error?.message), /ambiguity, not a choice/);
    assert.equal(departedOf(w).t_gate_open, undefined, "never forwarded");
    assert.throws(
      () =>
        reloadedRequest([gated(6, 106, 30), gated(7, 107, 31)], {
          label: LABEL,
          token: TOKEN,
          begin: 20,
        }),
      /ambiguity/,
    );
  });
  test("the departed answer never completes: a bounded failure naming it; the live refusal never released", async () => {
    const w = world({ order: "departed-never" });
    const r = await xl0(w);
    assert.match(
      String(r.error?.message),
      /no \/sync answer was held within 2000 ms .*the selection waits for the departed request's answer \(tap \d+, proxy \d+\)/,
    );
    const L = liveOf(w);
    assert.equal(w.held.includes(L.proxy_id), true);
    assert.equal(
      w.releases.some((x) => x.seq === L.seq),
      false,
    );
    assert.equal(w.store.cursor, TOKEN, "nothing reached the client");
  });
  for (const [name, opts, expected, liveHeld] of [
    [
      "the departed request answered with a piece, not the server's 410",
      { order: "live-first", faults: ["departed-200"] },
      /the departed request \d+ was answered 200 .*not the server's own 410/,
      true,
    ],
    [
      "the live request answered with a piece, not the server's 410",
      { order: "departed-first", faults: ["live-200"] },
      /the live request \d+ was answered 200 .*not the server's own 410/,
      true,
    ],
    [
      "releasing the departed entry releases nothing",
      { order: "live-first", faults: ["departed-release-0"] },
      /releasing proxy entry \d+ released 0/,
      true,
    ],
    [
      "the departed entry is still held after its reported release",
      { order: "live-first", faults: ["departed-stays-held"] },
      /the departed answer \(proxy \d+\) is still held after its release/,
      true,
    ],
    [
      "a third answer of the interval is held",
      { order: "simultaneous", faults: ["extra-held"] },
      /held proxy entries 999 are neither the departed .* nor the live/,
      true,
    ],
    [
      "a second tap record claims the live entry",
      { order: "live-first", faults: ["mis-joined"] },
      /claimed by tap records/,
      true,
    ],
    [
      "the live refusal's client is gone at the hand-off (non-delivery is a contradiction, never a pass)",
      { order: "live-first", faults: ["live-gone"] },
      /expected the answer to reach the client, but the proxy recorded client_gone/,
      false,
    ],
  ])
    test(`refused: ${name}`, async () => {
      const w = world(opts);
      const r = await xl0(w);
      assert.match(String(r.error?.message), expected);
      const L = liveOf(w);
      assert.equal(w.held.includes(L.proxy_id), liveHeld);
      if (liveHeld)
        assert.equal(
          w.releases.some((x) => x.seq === L.seq),
          false,
          "the live refusal was never released",
        );
    });
  test("refused: the held-refusal preparation (the follower) fails — the failure propagates, the live refusal stays held for its owner", async () => {
    for (const order of ["departed-first", "live-first"]) {
      const w = world({ order });
      const r = await xl0(w, {
        live: async () => {
          throw new Error("the second page did not attach as a follower");
        },
      });
      assert.match(String(r.error?.message), /did not attach as a follower/);
      const L = liveOf(w);
      assert.equal(w.held.includes(L.proxy_id), true);
      assert.equal(
        w.releases.some((x) => x.seq === L.seq),
        false,
      );
      assert.equal(r.seen.lost?.seq, departedOf(w).seq, "the departed lost");
    }
  });
});

// ---- Q5: the real hop ------------------------------------------------------------------------------------------------------------------
const SYNC = "/api/experimental/v1/sync";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const listen = (server) =>
  new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve(server.address().port)),
  );
const control = async (url, method, path, body) => {
  const r = await fetch(`${url}${path}`, {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return r.json();
};

describe("Q5: the real tap → holding proxy hop, each completion order resolved explicitly", () => {
  let backend;
  let tap;
  let proxy;
  let tapUrls;
  let proxyUrls;
  let dir;
  before(() => {
    dir = mkdtempSync(
      join(process.env.TMPDIR ?? tmpdir(), "pair-refusal-order-test-"),
    );
  });
  afterEach(async () => {
    await proxy?.stop();
    await tap?.stop();
    if (backend) {
      backend.closeAllConnections?.();
      await new Promise((r) => backend.close(r));
    }
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  for (const order of ["live-first", "departed-first"])
    test(`${order}: the departed answer is lost to its departed client, the live refusal observed while held and then delivered once`, async () => {
      // The backend: every continuation request is answered with the real 410 shape only when the test resolves it.
      const arrivals = [];
      backend = createServer((req, res) => {
        const url = new URL(req.url, "http://x");
        if (url.pathname !== SYNC) {
          res.writeHead(204);
          res.end();
          return;
        }
        arrivals.push(() => {
          res.writeHead(410, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              code: "resync_required",
              message: "the continuation expired",
              details: [],
            }),
          );
        });
      });
      const port = await listen(backend);
      const journal = createJournal({ attempt: "PAIR-XL0-node-r39" });
      tap = createTap({
        upstream: `http://127.0.0.1:${port}`,
        bodiesDir: join(dir, `bodies-${order}`),
        correlation: CORRELATION_HEADER,
        journal,
      });
      tapUrls = await tap.start();
      proxy = createProxy({
        upstream: tapUrls.tapUrl,
        correlation: CORRELATION_HEADER,
      });
      proxyUrls = await proxy.start();
      const { id: ruleId } = await control(
        proxyUrls.controlUrl,
        "POST",
        "/rules",
        { method: "GET", path: SYNC, action: "hold" },
      );
      await control(tapUrls.controlUrl, "POST", "/label", { label: LABEL });
      await control(tapUrls.controlUrl, "POST", "/gate", { closed: true });
      // Two clients through the proxy with the SAME continuation: the departed page's (its socket destroyed at the "reload") and the live one's.
      const ask = () => {
        const got = { status: null, body: null, error: null };
        const req = httpRequest(
          `${proxyUrls.proxyUrl}${SYNC}?cursor=${encodeURIComponent(TOKEN)}&max_changes=4`,
          { agent: false },
          (res) => {
            const chunks = [];
            res.on("data", (c) => chunks.push(c));
            res.on("end", () => {
              got.status = res.statusCode;
              got.body = Buffer.concat(chunks).toString("utf8");
            });
          },
        );
        req.on("error", (e) => {
          got.error = e.code ?? String(e);
        });
        req.end();
        return { req, got };
      };
      const syncRecords = () =>
        tap.records
          .filter((r) => r.label === LABEL && r.path === SYNC)
          .map((r) => ({ ...r }));
      const gatedRecords = async (n) => {
        for (let i = 0; i < 400; i += 1) {
          const g = syncRecords().filter((r) => r.gated === true);
          if (g.length >= n) return g;
          await sleep(5);
        }
        throw new Error(`${n} requests did not reach the gate`);
      };
      const pair = refusalPair({ label: LABEL });
      const ctx = Object.freeze({ token: TOKEN, header: HEADER });
      const departedClient = ask();
      const [D0] = await gatedRecords(1);
      pair.queued(D0, ctx);
      const begin = journal.record("bridge", "mark", { name: "reload_begin" });
      departedClient.req.destroy();
      const liveClient = ask();
      const all = await gatedRecords(2);
      assert.equal(all.length, 2);
      const L0 = reloadedRequest(all, { label: LABEL, token: TOKEN, begin });
      pair.reloaded(L0, { begin, ctx });
      await control(tapUrls.controlUrl, "POST", "/gate", { closed: false });
      for (let i = 0; i < 400 && arrivals.length < 2; i += 1) await sleep(5);
      assert.equal(arrivals.length, 2, "both requests reached the backend");
      // Arrival order at the backend follows the gate's forwarding order (departed first); the COMPLETION order is the test's.
      const [departedAnswer, liveAnswer] = arrivals;
      const heldIds = async () =>
        (await control(proxyUrls.controlUrl, "GET", "/held?entries=1"))[
          ruleId
        ] ?? [];
      const first = order === "live-first" ? liveAnswer : departedAnswer;
      const second = order === "live-first" ? departedAnswer : liveAnswer;
      const firstId = order === "live-first" ? L0.proxy_id : D0.proxy_id;
      first();
      for (let i = 0; i < 400 && !(await heldIds()).includes(firstId); i += 1)
        await sleep(5);
      assert.deepEqual(await heldIds(), [firstId], "only the first is held");
      let polls = 0;
      let secondAtPoll = null;
      const releases = [];
      const ledger = createLedger();
      const stored = {
        cursor: TOKEN,
        delta_stage: { revision: 9, next_index: 2 },
        page_seq: 4,
        applied_revision: 8,
        cache_digest: "old",
        composition_seq: 3,
        drafts: 0,
        staged: 1,
      };
      let atLive = null;
      const run = await drive(
        {
          held: heldIds,
          records: async () => syncRecords(),
          read: async () => structuredClone(stored),
          release: async (rule, id) => {
            const r = await control(
              proxyUrls.controlUrl,
              "POST",
              `/release/${rule}?entry=${id}`,
            );
            releases.push({ id, outcome: r.outcomes?.[0]?.outcome ?? null });
            return r;
          },
          nudge: async () => undefined,
          waitFor: async () => {
            throw new Error("no activation here");
          },
          barrier: () => undefined,
          now: () => Date.now(),
          // The second answer is completed only after the driver has polled three times with the first held and untouched.
          sleep: async (ms) => {
            polls += 1;
            if (polls === 3 && secondAtPoll === null) {
              secondAtPoll = polls;
              second();
            }
            await sleep(ms);
          },
        },
        {
          ruleId,
          base: structuredClone(stored),
          model: {
            cursor: TOKEN,
            boundary: "c0",
            stage: { revision: 9, next_index: 2 },
            activated: null,
            restarted: 0,
            pages: 0,
          },
          ledger,
          heldTimeoutMs: 10_000,
          select: pair.select,
          start: async () => ({ revision: 9, source: "the grant receipt" }),
          onHeld: async ({ record, release }) =>
            pair.answer(
              { record, release },
              {
                live: async (r) => {
                  const log = await control(
                    proxyUrls.controlUrl,
                    "GET",
                    "/log",
                  );
                  atLive = {
                    held: (await heldIds()).includes(r.proxy_id),
                    events: log
                      .find((e) => e.id === r.proxy_id)
                      ?.events.map((e) => e.event)
                      .filter((e) => e !== "request" && e !== "forwarded"),
                    client: liveClient.got.status,
                  };
                },
              },
            ),
        },
      ).then(
        (value) => ({ value }),
        (error) => ({ error }),
      );
      assert.equal(run.error?.message, undefined, "the drive completes");
      if (order === "live-first")
        assert.ok(polls >= 3, "the driver waited with the live refusal held");
      assert.equal(
        atLive?.held,
        true,
        "the live refusal was HELD when observed",
      );
      assert.equal(atLive?.client, null, "the live client had no answer yet");
      assert.deepEqual(
        releases.map((x) => x.id),
        [D0.proxy_id, L0.proxy_id],
        "the departed entry released first, then the live one, once each",
      );
      assert.equal(releases[1].outcome, "delivered");
      assert.notEqual(releases[0].outcome, "delivered");
      for (let i = 0; i < 400 && liveClient.got.status === null; i += 1)
        await sleep(5);
      assert.equal(liveClient.got.status, 410);
      assert.equal(JSON.parse(liveClient.got.body).code, "resync_required");
      assert.deepEqual(run.value.handOff, { at_seq: L0.seq, reason: REASON });
      // The real chronology is kept: the first answer's upstream ended first.
      const D = syncRecords().find((r) => r.seq === D0.seq);
      const L = syncRecords().find((r) => r.seq === L0.seq);
      if (order === "live-first")
        assert.ok(L.j_upstream_end < D.j_upstream_end);
      else assert.ok(D.j_upstream_end < L.j_upstream_end);
      // Joined as the spec joins them: the departed exchange LOST with the proxy's own outcome, the live one RECEIVED and delivered.
      await control(tapUrls.controlUrl, "POST", "/flush");
      const joined = joinExchanges(
        syncRecords(),
        await control(proxyUrls.controlUrl, "GET", "/log"),
        ledger.attempts,
      );
      const jd = joined.find((r) => r.seq === D0.seq);
      const jl = joined.find((r) => r.seq === L0.seq);
      assert.equal(jd.attempt.client, "lost");
      assert.equal(jd.attempt.effect, "none");
      assert.equal(jd.status, 410);
      assert.equal(jd.code, "resync_required");
      assert.notEqual(jd.downstream.outcome, "delivered");
      assert.equal(jl.attempt.client, "received");
      assert.equal(jl.downstream.outcome, "delivered");
      assert.equal(jl.code, "resync_required");
      assert.equal(jd.delivered, undefined);
      assert.equal(jl.delivered, undefined);
    });
});
