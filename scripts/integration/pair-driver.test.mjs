// WEB-09c revision 25 (R24-PAIR.c, DA-PAIR-S/E; family `segmented-sync-development-pairing`): the development pair's COMMON DRIVER and its
// OPENING (pair-driver.mjs), qualified as maintained code, never a copy of one step:
//   - Q1/Q2: deterministic worlds. A server model answers each request when it ARRIVES (so a poll that reaches it before the grant's
//     publication is an empty live-edge page, R24-PAIR.c's poll 1372), every answer is held until the driver releases it, and a client
//     model commits like W1/W27 a moment AFTER delivery (empty and whole pages advance page_seq, an empty page may renew the cursor, a
//     final piece activates, staging advances nothing, a broken chain restarts at the boundary). Nudges during a request are remembered.
//   - Q3: the real stand-in backend → pair tap → holding delaying proxy → client hop, with a grant latch, a /sync admitted before the hold
//     is armed, and the tap's request-side gate; the record the drive produced is assembled and validated as the spec does it.
// Every test asserts the drive's own result; a drive that throws fails by an assertion that names the driver's message (`driveOk`).
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, before, describe, test } from "node:test";
import { createProxy } from "./delaying-proxy.mjs";
import {
  CORRELATION_HEADER,
  createLedger,
  seenOf,
  terminalOf,
} from "./pair-attempts.mjs";
import {
  addMilestone,
  advance,
  createTarget,
  drive,
  openHold,
  roleOf,
} from "./pair-driver.mjs";
import {
  assembleInterval,
  joinExchanges,
  validateInterval,
} from "./pair-evidence.mjs";
import { createTap, describeSync } from "./pair-tap.mjs";

const SYNC = "/api/experimental/v1/sync";
const BASE = 100;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * The server: revisions published by `publish` (a receipt's revision), answered per request from its cursor. Cursors: `e<k>` (the live
 * edge after k revisions; `e<k>~<n>` when an empty page renewed it), `s<k>.<i>` (revision k, next piece i). `lastHasMore`: a revision's last
 * piece (or whole page) says the feed continues, and the next request completes it with an empty page. `emptyFinal`: one more, EMPTY, last
 * piece. `unrelated`: a revision published for this reader that is not the target.
 */
function serverModel({ lastHasMore = false, renewEmpty = false } = {}) {
  const published = [];
  let clock = BASE;
  let renewals = 0;
  const parse = (cursor) => {
    const edge = /^e(\d+)(~\d+)?$/.exec(cursor);
    if (edge) return { k: Number(edge[1]), i: 0, edge: true };
    const mid = /^s(\d+)\.(\d+)$/.exec(cursor);
    if (mid) return { k: Number(mid[1]), i: Number(mid[2]), edge: false };
    throw new Error(`unknown cursor ${cursor}`);
  };
  return {
    published,
    publish({ changes = 12, emptyFinal = false, prefix = "r" } = {}) {
      clock += 1;
      published.push({ revision: clock, changes, emptyFinal, prefix });
      return clock;
    },
    answer(cursor, maxChanges) {
      const { k, i, edge } = parse(cursor);
      const rev = published[k];
      if (!rev) {
        renewals += 1;
        return {
          phase: "delta",
          batches: [],
          next_cursor: renewEmpty && edge ? `e${k}~${renewals}` : cursor,
          has_more: false,
        };
      }
      const more = published.length > k + 1 || lastHasMore;
      const change = (j) => ({
        kind: "upsert",
        resource: { id: `${rev.prefix}${rev.revision}-${j}`, kind: "field" },
      });
      if (maxChanges === null)
        return {
          phase: "delta",
          batches: [
            {
              revision: rev.revision,
              changes: Array.from({ length: rev.changes }, (_, j) => change(j)),
            },
          ],
          next_cursor: `e${k + 1}`,
          has_more: more,
        };
      const pieces =
        Math.max(1, Math.ceil(rev.changes / maxChanges)) +
        (rev.emptyFinal ? 1 : 0);
      const n = Math.max(0, Math.min(maxChanges, rev.changes - i * maxChanges));
      const last = i === pieces - 1;
      return {
        phase: "delta",
        batches: [
          {
            revision: rev.revision,
            changes: Array.from({ length: n }, (_, j) =>
              change(i * maxChanges + j),
            ),
            segment: { index: i, last },
          },
        ],
        next_cursor: last ? `e${k + 1}` : `s${k}.${i + 1}`,
        has_more: !last || more,
      };
    },
  };
}

/** The client's stored state and its W1/W27 rules (a model of the product, independent of the driver's own `advance`). */
function clientModel() {
  const st = {
    cursor: "e0",
    phase: "delta",
    cache_status: "valid",
    applied_revision: BASE,
    page_seq: 5,
    request_seq: 0,
    composition_seq: 9,
    delta_stage: null,
    staged: 0,
    drafts: 0,
    cache_digest: `d${BASE}`,
    cache_count: 10,
  };
  const restart = () => {
    st.cursor = st.delta_stage.boundary_cursor;
    st.delta_stage = null;
    st.staged = 0;
  };
  const commit = (next, revision, changes) => {
    st.cursor = next;
    st.page_seq += 1;
    if (revision !== null) {
      st.applied_revision = Math.max(st.applied_revision, revision);
      st.cache_count += changes;
      st.cache_digest = `d${st.applied_revision}`;
      st.composition_seq += 1;
    }
  };
  return {
    st,
    apply(page, status) {
      if (status !== 200) return;
      const batches = page.batches ?? [];
      const segment = batches[0]?.segment;
      const changes = batches.reduce((n, b) => n + b.changes.length, 0);
      if (!segment) {
        if (st.delta_stage) return restart();
        return commit(
          page.next_cursor,
          batches.length ? batches.at(-1).revision : null,
          changes,
        );
      }
      const stage = st.delta_stage;
      const revision = batches[0].revision;
      const broken =
        stage === null
          ? segment.index !== 0
          : revision !== stage.revision ||
            segment.index !== stage.next_index ||
            (!segment.last && page.has_more !== true);
      if (broken) {
        if (stage) restart();
        return;
      }
      if (segment.last) {
        const staged = st.staged;
        st.delta_stage = null;
        st.staged = 0;
        return commit(page.next_cursor, revision, staged + changes);
      }
      st.delta_stage = {
        revision,
        next_index: segment.index + 1,
        boundary_cursor: stage ? stage.boundary_cursor : st.cursor,
        cursor: page.next_cursor,
      };
      st.cursor = page.next_cursor;
      st.staged += changes;
    },
  };
}

/**
 * The deterministic world: one leader asking with its stored cursor (`max`: its budget, null for whole pages), every answer held, a tap
 * record per exchange, faults applied to the answer the client SEES (the server's stays in the record), commits a moment after delivery.
 */
function world({ max = 4, server = serverModel(), faults = [] } = {}) {
  const client = clientModel();
  const records = [];
  const held = [];
  let seq = 0;
  let generation = 0;
  let busy = false;
  let wake = false;
  const barriers = [];
  const pending = new Set();
  const describe = (page) => describeSync(Buffer.from(JSON.stringify(page)));
  const request = () => {
    busy = true;
    client.st.request_seq += 1;
    seq += 1;
    const cursor = client.st.cursor;
    const page = server.answer(cursor, max);
    const record = {
      seq,
      proxy_id: 1000 + seq,
      label: "iv",
      method: "GET",
      path: SYNC,
      query: {
        cursor,
        limit: null,
        max_changes: max === null ? null : String(max),
      },
      status: 200,
      ...describe(page),
      page,
    };
    const fault = faults.find(
      (f) =>
        !f.fired &&
        record.segment &&
        record.segment.index >= (f.afterIndex ?? 0) &&
        (f.revision === undefined || f.revision === record.revision),
    );
    if (fault) {
      fault.fired = seq;
      if (fault.kind === "drop") {
        record.dropped = "TAP-INJECTED drop_connection";
        records.push(record);
        // The client is answered 502; the engine asks again.
        const at = generation;
        const timer = setTimeout(() => {
          pending.delete(timer);
          if (at !== generation) return;
          busy = false;
          request();
        }, 1);
        pending.add(timer);
        return;
      }
      const altered = fault.alter(structuredClone(page));
      record.delivered = {
        injected: `TAP-INJECTED ${fault.kind}`,
        status: altered.status ?? 200,
        ...describe(altered),
        page: altered,
      };
    }
    records.push(record);
    held.push({ proxyId: record.proxy_id, record, generation });
  };
  const nudge = () => {
    if (busy) wake = true;
    else request();
  };
  const deliver = (proxyId) => {
    const at = held.findIndex((h) => h.proxyId === proxyId);
    if (at < 0) return { released: 0, outcomes: [] };
    const [entry] = held.splice(at, 1);
    // The page that asked is gone (a reload, a closed tab): the answer reaches nobody.
    if (entry.generation !== generation)
      return {
        released: 1,
        outcomes: [{ id: proxyId, outcome: "client_gone" }],
      };
    const seenPage = entry.record.delivered?.page ?? entry.record.page;
    const status = entry.record.delivered?.status ?? 200;
    const timer = setTimeout(() => {
      pending.delete(timer);
      if (entry.generation !== generation) return;
      client.apply(seenPage, status);
      busy = false;
      if (status === 200 && (seenPage.has_more || wake)) {
        wake = false;
        request();
      }
    }, 2);
    pending.add(timer);
    return { released: 1, outcomes: [{ id: proxyId, outcome: "delivered" }] };
  };
  const io = {
    held: async () => held.map((h) => h.proxyId),
    records: async () => records,
    read: async () => structuredClone(client.st),
    release: async (_rule, proxyId) => deliver(proxyId),
    nudge: async () => nudge(),
    waitFor: async (predicate, what, options) => {
      for (let i = 0; i < 200; i += 1) {
        const s = structuredClone(client.st);
        if (predicate(s)) return options?.rows ? { ...s, rows: [] } : s;
        await sleep(1);
      }
      throw new Error(
        `${what}: not reached; last ${JSON.stringify(client.st)}`,
      );
    },
    barrier: (name, detail) => {
      barriers.push({ name, at: barriers.length + 1, detail });
    },
    now: () => Date.now(),
    sleep: () => sleep(1),
  };
  return {
    client,
    server,
    records,
    held,
    barriers,
    io,
    nudge,
    /** The page goes (a reload, a closed tab): its held answer reaches nobody; `resume` is the new page asking from what is stored. */
    depart: () => {
      generation += 1;
      busy = false;
      wake = false;
    },
    resume: () => request(),
    close: () => {
      for (const t of pending) clearTimeout(t);
      generation += 1;
    },
  };
}
const startModel = (w) => ({
  cursor: w.client.st.cursor,
  boundary: null,
  stage: null,
  activated: null,
  restarted: 0,
  pages: 0,
});
/** Runs the drive and ASSERTS it completed (a thrown drive fails here, by an assertion naming the driver's message). */
async function driveOk(w, options) {
  const outcome = await drive(w.io, {
    ruleId: "hold",
    base: structuredClone(w.client.st),
    model: startModel(w),
    heldTimeoutMs: 2000,
    ...options,
  }).then(
    (run) => ({ run }),
    (error) => ({ error }),
  );
  w.close();
  assert.equal(
    outcome.error?.message,
    undefined,
    "the drive completes (the driver's message)",
  );
  return outcome.run;
}
/** Runs a drive that must FAIL, and returns its message. */
async function driveFails(w, options) {
  const outcome = await drive(w.io, {
    ruleId: "hold",
    base: structuredClone(w.client.st),
    model: startModel(w),
    heldTimeoutMs: 300,
    ...options,
  }).then(
    (run) => ({ run }),
    (error) => ({ error }),
  );
  w.close();
  assert.ok(
    outcome.error,
    `the drive must refuse; it returned ${JSON.stringify(outcome.run?.terminal)}`,
  );
  return outcome.error.message;
}
const grant = (w, opts) => ({
  revision: w.server.publish(opts),
  source: "the public grant receipt (POST /access-commands)",
});
/** R24-PAIR.c's schedule: an ordinary poll reaches the server before the grant is published (an empty page), then the grant. */
const pollThenGrant =
  (w, polls = 1, opts) =>
  async () => {
    for (let i = 0; i < polls; i += 1) {
      w.nudge();
      // A second poll is asked only after the first was answered (one request at a time): release it outside the drive.
      if (i < polls - 1) {
        const entry = w.held.at(-1);
        await w.io.release("hold", entry.proxyId);
        await sleep(5);
      }
    }
    return grant(w, opts);
  };
const targetPieces = (run) =>
  run.attempts.filter((a) => a.role === "target" && a.client === "received");

describe("Q1: the target and the feed's completion are different things", () => {
  test("control: a whole response (W1 shape) driven to its one activation", async () => {
    const w = world({ max: null });
    const run = await driveOk(w, { start: async () => grant(w) });
    assert.equal(run.target.length, 1);
    assert.equal(run.incidental.length, 0);
    assert.deepEqual(run.activations, [{ revision: 101, seq: 1 }]);
    assert.deepEqual(run.terminal, { final_seq: 1, activated_by_seq: 1 });
    assert.equal(run.final.applied_revision, 101);
  });

  test("control: a bounded revision (max 4, 12 changes: pieces 0..2), every piece held, one activation", async () => {
    const w = world();
    const run = await driveOk(w, { start: async () => grant(w) });
    assert.deepEqual(
      targetPieces(run).map((a) => a.segment.index),
      [0, 1, 2],
    );
    assert.ok(targetPieces(run).every((a) => a.step !== null));
    assert.deepEqual(run.terminal, { final_seq: 3, activated_by_seq: 3 });
    assert.equal(
      w.barriers.filter((b) => b.name === "piece_persisted").length,
      2,
    );
  });

  test("R24-PAIR.c: an EMPTY poll answered before the grant's publication is incidental; the drive continues with the hold and reaches the target", async () => {
    const w = world();
    const run = await driveOk(w, { start: pollThenGrant(w) });
    assert.deepEqual(
      run.attempts.map((a) => [a.seq, a.role, a.effect]),
      [
        [1, "incidental", "committed"],
        [2, "target", "staged"],
        [3, "target", "staged"],
        [4, "target", "activated"],
      ],
    );
    // The empty page is never the terminal; every target piece was held and observed.
    assert.deepEqual(run.terminal, { final_seq: 4, activated_by_seq: 4 });
    assert.equal(run.incidental.length, 1);
    assert.deepEqual(
      targetPieces(run).map((a) => a.segment.index),
      [0, 1, 2],
    );
    assert.equal(run.final.applied_revision, 101);
    // Its W1 commit advanced page_seq: predicted, not re-read (5 + the empty page + the activating piece).
    assert.equal(run.final.page_seq, 7);
  });

  test("R24-PAIR.c, whole: an empty poll before a whole target response", async () => {
    const w = world({ max: null });
    const run = await driveOk(w, { start: pollThenGrant(w) });
    assert.deepEqual(
      run.attempts.map((a) => a.role),
      ["incidental", "target"],
    );
    assert.equal(run.target.length, 1);
    assert.deepEqual(run.terminal, { final_seq: 2, activated_by_seq: 2 });
  });

  test("TWO empty pages before the target is visible, each RENEWING the cursor: both incidental, the requests carry the renewed cursors, page_seq predicted", async () => {
    const w = world({ server: serverModel({ renewEmpty: true }) });
    let empties = 0;
    const run = await driveOk(w, {
      start: async () => {
        w.nudge();
        return {
          revision: 101,
          source: "a receipt the reader's feed shows late",
        };
      },
      onHeld: async ({ role }) => {
        if (role === "incidental" && ++empties === 2) w.server.publish();
        return undefined;
      },
    });
    assert.deepEqual(
      run.attempts.map((a) => a.role),
      ["incidental", "incidental", "target", "target", "target"],
    );
    const [one, two, first] = run.steps;
    assert.notEqual(one.next_cursor, one.query.cursor, "renewed");
    assert.equal(two.query.cursor, one.next_cursor);
    assert.equal(first.query.cursor, two.next_cursor);
    assert.equal(run.final.page_seq, 8);
    assert.deepEqual(run.terminal, { final_seq: 5, activated_by_seq: 5 });
  });

  test("an empty page renewing the cursor during the drive, then the target", async () => {
    const w = world({ server: serverModel({ renewEmpty: true }) });
    const run = await driveOk(w, { start: pollThenGrant(w) });
    const [empty, first] = run.steps;
    assert.notEqual(empty.next_cursor, empty.query.cursor, "renewed");
    assert.equal(first.query.cursor, empty.next_cursor);
    assert.equal(run.final.page_seq, 7);
  });

  test("the target's last piece says has_more: the activation is observed, the drive continues to the empty page that completes the feed", async () => {
    const w = world({ server: serverModel({ lastHasMore: true }) });
    const run = await driveOk(w, { start: async () => grant(w) });
    assert.deepEqual(run.terminal, { final_seq: 4, activated_by_seq: 3 });
    const activated = w.barriers.find((b) => b.name === "target_activated");
    assert.equal(activated.detail.activated_by_seq, 3);
    assert.equal(activated.detail.cache_digest, "d101");
    assert.equal(run.attempts.at(-1).role, "incidental");
    assert.equal(run.final.page_seq, 7);
  });

  test("an EMPTY final segment still activates the staged revision", async () => {
    const w = world();
    const run = await driveOk(w, {
      start: async () => grant(w, { changes: 8, emptyFinal: true }),
    });
    const last = run.target.at(-1);
    assert.equal(last.segment.last, true);
    assert.equal(last.changes, 0);
    assert.deepEqual(run.activations, [{ revision: 101, seq: last.seq }]);
    assert.equal(run.final.cache_count, 18);
  });

  test("refused: the target is never published (only empty pages): the drive ends at its step bound, awaiting the target, with no activation", async () => {
    const w = world();
    const message = await driveFails(w, {
      start: async () => ({ revision: 101, source: "a receipt" }),
      maxSteps: 4,
    });
    assert.match(message, /did not finish within the step bound \(4\)/);
    assert.match(message, /phase awaiting; target 101; activated none/);
  });

  test("refused: a revision that is NOT the target arrives (an unrelated batch)", async () => {
    const w = world();
    const message = await driveFails(w, {
      start: async () => {
        w.server.publish({ prefix: "u" });
        return { revision: 102, source: "a receipt" };
      },
    });
    assert.match(message, /carries revision 101\.\.101, not a target revision/);
  });

  test("refused: a target that names a revision BEFORE an unrelated later one is still refused at the unrelated batch", async () => {
    const w = world({ max: null, server: serverModel() });
    const message = await driveFails(w, {
      start: async () => {
        const first = grant(w);
        w.server.publish({ prefix: "u" });
        return first;
      },
    });
    assert.match(message, /carries revision 102\.\.102, not a target revision/);
  });

  test("the final piece's answer LOST (the page departed while it was held), asked again and received: the activation is the retry's", async () => {
    const w = world();
    let departed = false;
    const run = await driveOk(w, {
      start: async () => grant(w),
      onHeld: async ({ piece, release }) => {
        if (!piece?.last || departed) return undefined;
        departed = true;
        w.depart();
        await release();
        w.resume();
        return { delivered: false };
      },
    });
    const lost = run.attempts.filter((a) => a.client === "lost");
    assert.equal(lost.length, 1);
    assert.equal(lost[0].segment.index, 2);
    assert.deepEqual(run.activations, [{ revision: 101, seq: 4 }]);
    assert.deepEqual(run.terminal, { final_seq: 4, activated_by_seq: 4 });
  });

  test("a dropped answer (the tap destroyed the connection) is kept, never a piece; the retry from the same cursor is", async () => {
    const w = world({ faults: [{ kind: "drop", afterIndex: 1 }] });
    const run = await driveOk(w, { start: pollThenGrant(w) });
    const dropped = run.attempts.filter((a) => a.client === "dropped");
    assert.equal(dropped.length, 1);
    assert.equal(dropped[0].role, "target");
    assert.equal(dropped[0].step, null);
    assert.deepEqual(
      targetPieces(run).map((a) => a.segment.index),
      [0, 1, 2],
    );
  });

  test("refused: the client never commits the activation: the drive does not record one (its durable witness is required)", async () => {
    const w = world();
    const apply = w.client.apply;
    w.client.apply = (page, status) => {
      if (page.batches?.[0]?.segment?.last) return;
      apply(page, status);
    };
    const message = await driveFails(w, { start: async () => grant(w) });
    assert.match(message, /the durable activation of revision 101/);
  });
});

describe("Q2: hooks act on the server's piece, never on an attempt's ordinal", () => {
  test("R1 with an empty prefix and a lost attempt: the reload happens at PIECE 3 (the fifth attempt), once; the retry is piece 3 again", async () => {
    const w = world({ max: 2 });
    let at = null;
    const run = await driveOk(w, {
      start: pollThenGrant(w, 1, { changes: 10 }),
      onHeld: async ({ piece, before, index, release }) => {
        if (piece?.index !== 3 || !piece.next || at !== null) return undefined;
        at = { index, next_index: before.delta_stage?.next_index };
        w.depart();
        await release();
        w.resume();
        return { delivered: false };
      },
    });
    assert.deepEqual(at, { index: 4, next_index: 3 });
    const lost = run.attempts.find((a) => a.client === "lost");
    assert.equal(lost.segment.index, 3);
    const retry = run.attempts.find((a) => a.seq > lost.seq);
    assert.equal(retry.segment.index, 3);
    assert.equal(retry.request_cursor, lost.request_cursor);
    assert.deepEqual(
      targetPieces(run).map((a) => a.segment.index),
      [0, 1, 2, 3, 4],
    );
  });

  test("T2 with an empty prefix: the leader closes at PIECE 2 (the fourth attempt); the new one asks from the stored continuation", async () => {
    const w = world();
    let closedAt = null;
    const run = await driveOk(w, {
      start: pollThenGrant(w, 1, { changes: 16 }),
      onHeld: async ({ piece, index, release }) => {
        if (piece?.index !== 2 || !piece.next || closedAt !== null)
          return undefined;
        closedAt = index;
        w.depart();
        await release();
        w.resume();
        return { delivered: false };
      },
    });
    assert.equal(closedAt, 3);
    const lost = run.attempts.find((a) => a.client === "lost");
    assert.equal(lost.segment.index, 2);
    assert.equal(run.terminal.activated_by_seq, run.target.at(-1).seq);
  });

  test("a restart (piece 2 altered: its index moved on) does not move the action: the hook fires at the real piece 3 of the new chain", async () => {
    const w = world({
      max: 2,
      faults: [
        {
          kind: "segment_index_delta",
          afterIndex: 2,
          alter: (p) => {
            p.batches[0].segment.index += 1;
            return p;
          },
        },
      ],
    });
    const fired = [];
    const run = await driveOk(w, {
      start: async () => grant(w, { changes: 10 }),
      onHeld: async ({ piece, record, model }) => {
        if (piece?.index === 3 && piece.next)
          fired.push({ seq: record.seq, restarted: model.restarted });
        return undefined;
      },
    });
    assert.equal(run.model.restarted, 1);
    // Seq 3 was the server's piece 2 (seen as 3): the restart; the chain begins again at seq 4; the real piece 3 is seq 7.
    assert.deepEqual(fired, [{ seq: 7, restarted: 1 }]);
    assert.deepEqual(run.activations, [{ revision: 101, seq: 8 }]);
  });

  test("A1: the revocation at the grant's piece 2 is a later milestone; the drive activates BOTH revisions and ends at the revocation's", async () => {
    const w = world();
    let revoke = null;
    const run = await driveOk(w, {
      start: async () => grant(w, { changes: 16 }),
      onHeld: async ({ piece, addMilestone }) => {
        if (piece?.index !== 2 || !piece.next || revoke !== null)
          return undefined;
        revoke = {
          revision: w.server.publish({ changes: 8, prefix: "x" }),
          source: "the public revoke receipt",
        };
        addMilestone(revoke);
        return undefined;
      },
    });
    assert.deepEqual(run.goal, { revisions: [101, 102], through: 102 });
    assert.deepEqual(
      run.activations.map((a) => a.revision),
      [101, 102],
    );
    assert.equal(run.final.applied_revision, 102);
    // The grant's activation did NOT end the drive (has_more was true): the terminal is the revocation's.
    assert.equal(run.terminal.activated_by_seq, run.target.at(-1).seq);
  });

  test("L1: a hand-off at PIECE 3 (after an empty prefix) returns the stop with its exchange; nothing is claimed beyond it", async () => {
    const w = world({ max: 2 });
    const run = await driveOk(w, {
      start: pollThenGrant(w, 1, { changes: 10 }),
      onHeld: async ({ piece }) =>
        piece?.index === 3 && piece.next
          ? { stop: true, reason: "the session was replaced" }
          : undefined,
    });
    assert.equal(run.stoppedAt.segment.index, 3);
    assert.deepEqual(run.handOff, {
      at_seq: run.stoppedAt.seq,
      reason: "the session was replaced",
    });
    assert.equal(run.terminal, null);
    assert.deepEqual(run.activations, []);
  });

  test("T1: the follower reads the OLD state at the held actual last piece (phase receiving) and the NEW state at the completion page (after_activation)", async () => {
    const w = world({ server: serverModel({ lastHasMore: true }) });
    const seenBy = [];
    const run = await driveOk(w, {
      start: pollThenGrant(w),
      onHeld: async ({ piece, phase, target }) => {
        const follower = await w.io.read();
        if (piece?.last && piece.revision === target.through)
          seenBy.push(["last", phase, follower.cache_digest]);
        if (phase === "after_activation")
          seenBy.push(["after", phase, follower.cache_digest]);
        return undefined;
      },
    });
    assert.deepEqual(seenBy, [
      ["last", "receiving", "d100"],
      ["after", "after_activation", "d101"],
    ]);
    assert.deepEqual(run.terminal, { final_seq: 5, activated_by_seq: 4 });
  });
});

describe("the pieces of the driver", () => {
  test("roleOf judges the SERVER's answer: target, incidental, other, unrelated", () => {
    const t = createTarget({ revision: 7, source: "r" });
    assert.equal(
      roleOf({ status: 200, batches: 1, revision: 7, last_revision: 7 }, t),
      "target",
    );
    assert.equal(roleOf({ status: 200, batches: 0 }, t), "incidental");
    assert.equal(roleOf({ status: 410 }, t), "other");
    assert.equal(
      roleOf({ status: 200, batches: 2, revision: 7, last_revision: 8 }, t),
      "unrelated",
    );
  });
  test("a milestone must follow the target and name its source", () => {
    const t = createTarget({ revision: 7, source: "r" });
    assert.throws(
      () => createTarget({ revision: 0, source: "r" }),
      /positive integer/,
    );
    assert.throws(() => createTarget({ revision: 7 }), /names no source/);
    assert.throws(() => advanceMilestone(t, 7), /does not follow the target 7/);
  });
  test("advance: an empty page commits (pages +1) without activating; a staged piece commits nothing; a restart commits nothing", () => {
    const m = {
      cursor: "c0",
      boundary: null,
      stage: null,
      activated: null,
      restarted: 0,
      pages: 0,
    };
    const empty = advance(m, {
      status: 200,
      batches: 0,
      next_cursor: "c0b",
      has_more: false,
    });
    assert.deepEqual(
      [empty.pages, empty.activated, empty.cursor],
      [1, null, "c0b"],
    );
    const staged = advance(m, {
      status: 200,
      batches: 1,
      revision: 7,
      segment: { index: 0, last: false },
      has_more: true,
      next_cursor: "c1",
    });
    assert.equal(staged.pages, 0);
    const broken = advance(staged, {
      status: 200,
      batches: 1,
      revision: 7,
      segment: { index: 2, last: false },
      has_more: true,
      next_cursor: "c3",
    });
    assert.deepEqual(
      [broken.pages, broken.restarted, broken.cursor],
      [0, 1, "c0"],
    );
  });
});
const advanceMilestone = (t, revision) =>
  addMilestone(t, { revision, source: "r" });

// ---- Q3: the real hop ------------------------------------------------------------------------------------------------------------------
/** The stand-in backend over HTTP: the server model, a per-request latch (`holdNext`), and every request it saw. */
function standInBackend(server) {
  const seen = [];
  let latch = null;
  const http = createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    if (url.pathname !== SYNC) {
      res.writeHead(204);
      res.end();
      return;
    }
    const cursor = url.searchParams.get("cursor");
    const max = url.searchParams.get("max_changes");
    seen.push({ cursor, at: seen.length });
    const page = server.answer(cursor, max === null ? null : Number(max));
    const send = () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(page));
    };
    if (latch) {
      const l = latch;
      latch = null;
      l.waiting(send);
    } else send();
  });
  return {
    http,
    seen,
    /** The NEXT /sync request is answered (computed now) only when the returned function is called. */
    holdNext() {
      let release;
      const ready = new Promise((resolve) => {
        latch = {
          waiting: (send) => {
            release = send;
            resolve();
          },
        };
      });
      return { ready, release: () => release() };
    },
  };
}
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

/** A client through the proxy: the client model, one request at a time, nudges remembered, commits after its answer arrives. */
function hopClient(proxyUrl, max) {
  const client = clientModel();
  let busy = false;
  let wake = false;
  const ask = () => {
    busy = true;
    client.st.request_seq += 1;
    const req = httpRequest(
      `${proxyUrl}${SYNC}?cursor=${client.st.cursor}&max_changes=${max}`,
      { agent: false },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const page = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          setTimeout(() => {
            client.apply(page, res.statusCode);
            busy = false;
            if (res.statusCode === 200 && (page.has_more || wake)) {
              wake = false;
              ask();
            }
          }, 2);
        });
      },
    );
    req.on("error", () => {
      busy = false;
    });
    req.end();
  };
  return {
    client,
    nudge: () => {
      if (busy) wake = true;
      else ask();
    },
    idle: () => !busy,
  };
}

describe("Q3: the real hop boundary: stand-in backend → tap → holding proxy → client", () => {
  let backend;
  let server;
  let tap;
  let proxy;
  let tapUrls;
  let proxyUrls;
  let dir;
  before(async () => {
    dir = mkdtempSync(
      join(process.env.TMPDIR ?? tmpdir(), "pair-driver-test-"),
    );
  });
  const stack = async () => {
    server = serverModel();
    backend = standInBackend(server);
    const port = await listen(backend.http);
    tap = createTap({
      upstream: `http://127.0.0.1:${port}`,
      bodiesDir: join(dir, `bodies-${port}`),
      correlation: CORRELATION_HEADER,
    });
    tapUrls = await tap.start();
    proxy = createProxy({
      upstream: tapUrls.tapUrl,
      correlation: CORRELATION_HEADER,
    });
    proxyUrls = await proxy.start();
    return join(dir, `bodies-${port}`);
  };
  afterEach(async () => {
    await proxy?.stop();
    await tap?.stop();
    if (backend) await new Promise((r) => backend.http.close(r));
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  const openingIo = (c) => ({
    addRule: () =>
      control(proxyUrls.controlUrl, "POST", "/rules", {
        method: "GET",
        path: SYNC,
        action: "hold",
      }),
    proxyLog: () => control(proxyUrls.controlUrl, "GET", "/log"),
    held: async (rule) =>
      (await control(proxyUrls.controlUrl, "GET", "/held?entries=1"))[rule] ??
      [],
    releaseOne: (rule, id) =>
      control(proxyUrls.controlUrl, "POST", `/release/${rule}?entry=${id}`),
    label: async (label) =>
      (await control(tapUrls.controlUrl, "POST", "/label", { label })).seq,
    tapRecords: async () => tap.records,
    quietNow: async () => (c.idle() ? structuredClone(c.client.st) : null),
    now: () => Date.now(),
    sleep,
  });
  const driveIo = (c, label, barriers) => ({
    held: async (rule) =>
      (await control(proxyUrls.controlUrl, "GET", "/held?entries=1"))[rule] ??
      [],
    records: async () =>
      tap.records.filter((r) => r.label === label && r.path === SYNC),
    read: async () => structuredClone(c.client.st),
    release: (rule, id) =>
      control(proxyUrls.controlUrl, "POST", `/release/${rule}?entry=${id}`),
    nudge: async () => c.nudge(),
    waitFor: async (predicate, what, options) => {
      for (let i = 0; i < 400; i += 1) {
        const s = structuredClone(c.client.st);
        if (predicate(s)) return options?.rows ? { ...s, rows: [] } : s;
        await sleep(5);
      }
      throw new Error(`${what}: not reached`);
    },
    barrier: (name, detail) =>
      barriers.push({
        name,
        at: barriers.length + 1,
        ...(detail === undefined ? {} : { detail }),
      }),
    now: () => Date.now(),
    sleep,
  });

  test("an empty answer computed before the grant, HELD through the grant, then the target: driven to its activation, and the record the spec would write is valid", async () => {
    const bodies = await stack();
    const c = hopClient(proxyUrls.proxyUrl, 4);
    const opening = await openHold(openingIo(c), { label: "PAIR-W2:node:iv" });
    assert.equal(opening.rounds, 1);
    const barriers = [
      {
        name: "pre_grant_complete",
        at: 0,
        detail: { cache_digest: c.client.st.cache_digest },
      },
    ];
    const ledger = createLedger();
    const outcome = await drive(driveIo(c, "PAIR-W2:node:iv", barriers), {
      ruleId: opening.ruleId,
      base: structuredClone(c.client.st),
      model: {
        cursor: "e0",
        boundary: null,
        stage: null,
        activated: null,
        restarted: 0,
        pages: 0,
      },
      ledger,
      heldTimeoutMs: 5000,
      start: async () => {
        // The grant latch: a poll reaches the backend and is ANSWERED (empty) while the grant is not yet published, and is held.
        c.nudge();
        const held = async () =>
          (
            (await control(proxyUrls.controlUrl, "GET", "/held?entries=1"))[
              opening.ruleId
            ] ?? []
          ).length;
        for (let i = 0; i < 400 && (await held()) === 0; i += 1) await sleep(5);
        assert.equal(
          await held(),
          1,
          "the empty answer is held before the grant",
        );
        return {
          revision: server.publish({ changes: 12 }),
          source: "the grant receipt",
        };
      },
    }).then(
      (run) => ({ run }),
      (error) => ({ error }),
    );
    assert.equal(
      outcome.error?.message,
      undefined,
      "the drive completes (the driver's message)",
    );
    const { run } = outcome;
    assert.deepEqual(
      run.attempts.map((a) => [a.role, a.client, a.effect]),
      [
        ["incidental", "received", "committed"],
        ["target", "received", "staged"],
        ["target", "received", "staged"],
        ["target", "received", "activated"],
      ],
    );
    // The record, assembled and validated exactly as the spec does (joinExchanges, assembleInterval, validateInterval).
    const { seq: until } = await control(tapUrls.controlUrl, "POST", "/label", {
      label: null,
    });
    await control(tapUrls.controlUrl, "POST", "/flush");
    const records = joinExchanges(
      tap.records.filter(
        (r) => r.seq <= until && r.label === "PAIR-W2:node:iv",
      ),
      await control(proxyUrls.controlUrl, "GET", "/log"),
      ledger.attempts,
    );
    const record = assembleInterval({
      iv: {
        id: "PAIR-W2:node:iv",
        caseId: "PAIR-W2",
        engine: "node",
        barriers,
        piecesPersisted: barriers.filter((b) => b.name === "piece_persisted")
          .length,
        attempts: ledger.attempts,
        target: { ...run.goal, sources: run.sources },
        handOff: run.handOff,
        opening: {
          label_seq: opening.since,
          rounds: opening.rounds,
          released: opening.released,
        },
        holdReleases: [],
        observations: [],
        terminal: run.terminal,
        traces: [],
      },
      records,
      collection: {
        since: opening.since,
        until,
        dropped_through: 0,
        pending_writes: 0,
        write_errors: [],
        unsettled: [],
      },
      details: {
        backend: "development",
        selection: "f434df4a",
        apiVersion: "x",
        workload: "W-real",
        preGrantCursor: "e0",
        driven: "full",
        requiredObservations: [],
        terminal: "activated",
        appliedRevision: run.final.applied_revision,
        oracle: { verdict: "match", problems: [] },
        person: "none",
      },
      memory: { kind: null, reason: "node: no browser" },
      readBody: (f) => readFileSync(join(bodies, f)),
    });
    assert.deepEqual(
      validateInterval(record, {
        readBody: (f) => readFileSync(join(bodies, f)),
      }),
      [],
    );
    assert.equal(record.terminal.final_seq, record.requests.at(-1).seq);
    assert.notEqual(record.terminal.final_seq, record.requests[0].seq);
    // The empty answer completed a feed, but it is not the terminal (the R24 predicate would have stopped at it).
    assert.equal(seenOf(record.requests[0]).has_more, false);
    assert.deepEqual(terminalOf(record.requests, 101), run.terminal);
  });

  test("the opening: a /sync admitted BEFORE the hold is waited for until it settles, and the label follows it", async () => {
    await stack();
    // The page the opening watches is idle; the request admitted before the hold is ANOTHER lifetime's (a closed tab, a page reloaded).
    const c = hopClient(proxyUrls.proxyUrl, 4);
    const departed = hopClient(proxyUrls.proxyUrl, 4);
    const latch = backend.holdNext();
    departed.nudge();
    await latch.ready;
    let answeredAt = null;
    setTimeout(() => {
      answeredAt = Date.now();
      latch.release();
    }, 60);
    const opening = await openHold(openingIo(c), { label: "PAIR-W2:node:o" });
    const openedAt = Date.now();
    assert.ok(
      answeredAt !== null && openedAt >= answeredAt,
      "the label follows the pre-arm answer",
    );
    const pre = tap.records.find((r) => r.path === SYNC);
    assert.ok(
      pre.seq <= opening.since,
      "the pre-arm exchange is outside the window",
    );
    assert.equal(pre.label, null);
    assert.ok(c.idle());
  });

  test("the opening: a request that reached the tap just BEFORE the label, under the hold, would be held outside the window: the round is repeated", async () => {
    await stack();
    const c = hopClient(proxyUrls.proxyUrl, 4);
    const io = openingIo(c);
    let forced = false;
    const opening = await openHold(
      {
        ...io,
        label: async (label) => {
          if (label !== null && !forced) {
            forced = true;
            // An ordinary poll reaches the tap (and its answer the hold) between the quiet check and the label.
            c.nudge();
            for (
              let i = 0;
              i < 400 &&
              !tap.records.some((r) => r.path === SYNC && r.status !== null);
              i += 1
            )
              await sleep(5);
          }
          return io.label(label);
        },
      },
      { label: "PAIR-W2:node:e" },
    );
    assert.equal(opening.rounds, 2);
    assert.deepEqual(
      opening.released.map((r) => [r.round, r.outcome]),
      [[2, "delivered"]],
    );
    const early = tap.records.find((r) => r.path === SYNC);
    assert.ok(
      early.seq <= opening.since,
      "the early exchange precedes the window",
    );
  });

  test("the opening: an answer the hold took BEFORE the label is released (kept), and only later requests belong to the window", async () => {
    await stack();
    const c = hopClient(proxyUrls.proxyUrl, 4);
    const rule = await control(proxyUrls.controlUrl, "POST", "/rules", {
      method: "GET",
      path: SYNC,
      action: "hold",
    });
    c.nudge();
    for (
      let i = 0;
      i < 400 &&
      (
        (await control(proxyUrls.controlUrl, "GET", "/held?entries=1"))[
          rule.id
        ] ?? []
      ).length === 0;
      i += 1
    )
      await sleep(5);
    const io = openingIo(c);
    const opening = await openHold(
      { ...io, addRule: async () => rule },
      { label: "PAIR-W2:node:r" },
    );
    assert.equal(opening.released.length, 1);
    assert.equal(opening.released[0].outcome, "delivered");
    assert.ok(tap.records.every((r) => r.seq <= opening.since));
  });

  test("the tap's gate: a request closed out of the backend until the fault is armed; then piece 0 is the faulted answer", async () => {
    await stack();
    const c = hopClient(proxyUrls.proxyUrl, 4);
    await control(tapUrls.controlUrl, "POST", "/gate", { closed: true });
    server.publish({ changes: 12 });
    c.nudge();
    for (let i = 0; i < 400 && !tap.records.some((r) => r.gated); i += 1)
      await sleep(5);
    assert.equal(
      backend.seen.length,
      0,
      "nothing reached the backend while the gate was closed",
    );
    await control(tapUrls.controlUrl, "POST", "/fault", {
      kind: "tamper_next_cursor",
      afterIndex: 0,
    });
    const opened = await control(tapUrls.controlUrl, "POST", "/gate", {
      closed: false,
    });
    assert.deepEqual(opened.forwarded, [1]);
    for (let i = 0; i < 400 && !tap.records[0]?.delivered; i += 1)
      await sleep(5);
    const [first] = tap.records;
    assert.equal(first.gated, true);
    assert.equal(first.segment.index, 0);
    assert.match(first.delivered.injected, /tamper_next_cursor/);
    const faults = await control(tapUrls.controlUrl, "GET", "/faults");
    assert.equal(faults[0].fired, 1);
  });
});

// ---- revision 27 (C4): named local work is DECLARED by its case; the zero-draft premise stands everywhere else ---------------------
describe("revision 27: declared local work", () => {
  test("control: a case that declares its admitted draft (count and composition) is driven to its activation", async () => {
    const w = world();
    let declared = false;
    const run = await driveOk(w, {
      localWork: true,
      start: async () => grant(w),
      onHeld: async ({ piece, declareLocalWork }) => {
        if (piece?.index !== 1 || declared) return undefined;
        // The admitted local work: one draft and one composition step, read and declared by the case.
        w.client.st.drafts = 1;
        w.client.st.composition_seq += 1;
        declareLocalWork({
          drafts: 1,
          composition_seq: w.client.st.composition_seq,
          reason: "the admitted create_person L1",
        });
        declared = true;
        return undefined;
      },
    });
    assert.equal(declared, true);
    assert.equal(run.activations.length, 1);
  });
  test("refused: a draft appears in a case that declared none (the zero-draft premise)", async () => {
    const w = world();
    const message = await driveFails(w, {
      start: async () => grant(w),
      onHeld: async ({ piece }) => {
        if (piece?.index === 1) w.client.st.drafts = 1;
        return undefined;
      },
    });
    assert.match(
      message,
      /the reader holds no local work \(the fixture's premise\)/,
    );
  });
  test("refused: declaring local work in a case that did not opt in", async () => {
    const w = world();
    const message = await driveFails(w, {
      start: async () => grant(w),
      onHeld: async ({ declareLocalWork }) => {
        declareLocalWork({ drafts: 1, composition_seq: 9, reason: "x" });
        return undefined;
      },
    });
    assert.match(message, /this case declared no local work/);
  });
  test("refused: local work that vanishes after its declaration (lost at a later barrier)", async () => {
    const w = world();
    let step = 0;
    const message = await driveFails(w, {
      localWork: true,
      start: async () => grant(w),
      onHeld: async ({ declareLocalWork }) => {
        step += 1;
        if (step === 1) {
          w.client.st.drafts = 1;
          declareLocalWork({
            drafts: 1,
            composition_seq: w.client.st.composition_seq,
            reason: "L1",
          });
        } else w.client.st.drafts = 0;
        return undefined;
      },
    });
    assert.match(message, /holds 0 drafts, the declared local work 1 \(L1\)/);
  });
  test("refused: a composition change after the declaration that the case did not declare", async () => {
    const w = world();
    let step = 0;
    const message = await driveFails(w, {
      localWork: true,
      start: async () => grant(w),
      onHeld: async ({ declareLocalWork }) => {
        step += 1;
        if (step === 1) {
          w.client.st.drafts = 1;
          declareLocalWork({
            drafts: 1,
            composition_seq: w.client.st.composition_seq,
            reason: "L1",
          });
        } else if (step === 2) w.client.st.composition_seq += 5;
        return undefined;
      },
    });
    assert.match(message, /composition \d+, predicted \d+/);
  });
});
