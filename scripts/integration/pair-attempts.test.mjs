// WEB-09c revision 24 (R23-PAIR.a): the development pair's attempt accounting, at the REAL hop boundary the pair runs through
// (stand-in backend → pair tap → holding delaying proxy → client), and with doubles for the schedules a browser cannot be made to produce
// on demand. The review's schedule: pieces 0-2 received, piece 3 held, the client gone, the held answer released to nobody, the same cursor
// asked again, piece 3 received, piece 4 ends the revision. The tap cannot see the loss (its hop to the proxy completed); the proxy can.
// The received sequence must be 0,1,2,3,4 with every attempt kept, and the R23 filter on the TAP's `client_gone` must be shown to fail.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, before, describe, test } from "node:test";
import { createProxy } from "./delaying-proxy.mjs";
import {
  CORRELATION_HEADER,
  createLedger,
  effectOf,
  outcomeOf,
  pickHeld,
  reachedClient,
  segmentedProblems,
  terminalOf,
} from "./pair-attempts.mjs";
import { createTap } from "./pair-tap.mjs";

const SYNC = "/api/experimental/v1/sync";
const page = (index, last, next) =>
  JSON.stringify({
    phase: "delta",
    batches: [
      {
        revision: 7,
        changes: [{ kind: "upsert", resource: { id: `r${index}` } }],
        segment: { index, last },
      },
    ],
    next_cursor: next,
    has_more: !last,
  });

/** The stand-in backend: piece i for cursor c<i> (c0…c4), the same bytes every time it is asked; it records every header it saw. */
function standIn() {
  const seen = [];
  const server = createServer((req, res) => {
    seen.push({ url: req.url, headers: req.headers });
    const url = new URL(req.url, "http://x");
    if (url.pathname === SYNC) {
      const i = Number((url.searchParams.get("cursor") ?? "c0").slice(1));
      res.writeHead(200, {
        "content-type": "application/json",
        "set-cookie": "s=1",
      });
      res.end(page(i, i === 4, `c${i + 1}`));
      return;
    }
    res.writeHead(204);
    res.end();
  });
  return { server, seen };
}
const listen = (server) =>
  new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve(server.address().port)),
  );
const until = async (predicate, what, ms = 5000) => {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out: ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
};
const control = async (url, method, path) => {
  const r = await fetch(`${url}${path}`, { method });
  return r.json();
};
const addHold = async (url) =>
  (
    await fetch(`${url}/rules`, {
      method: "POST",
      body: JSON.stringify({ method: "GET", path: SYNC, action: "hold" }),
    })
  ).json();

/** A client request through the proxy; `abort()` closes its connection (the page navigated away) and resolves once it has closed. */
function ask(proxyUrl, cursor) {
  let req;
  const answer = new Promise((resolve) => {
    req = httpRequest(
      `${proxyUrl}${SYNC}?cursor=${cursor}&max_changes=4`,
      { agent: false },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () =>
          resolve({ status: res.statusCode, body: Buffer.concat(chunks) }),
        );
      },
    );
    // The intentional reset of an aborted request is the schedule, not a failure of the test.
    req.on("error", () => resolve({ status: null, body: null }));
    req.end();
  });
  return {
    answer,
    abort: () =>
      new Promise((resolve) => {
        req.once("close", resolve);
        req.destroy();
      }),
  };
}

describe("the real hop boundary: stand-in backend → tap → holding proxy → client", () => {
  let backend;
  let tap;
  let proxy;
  let tapUrls;
  let proxyUrls;
  let dir;
  before(async () => {
    dir = mkdtempSync(
      join(process.env.TMPDIR ?? tmpdir(), "pair-attempts-test-"),
    );
    backend = standIn();
    const port = await listen(backend.server);
    tap = createTap({
      upstream: `http://127.0.0.1:${port}`,
      bodiesDir: join(dir, "bodies"),
      correlation: CORRELATION_HEADER,
    });
    tapUrls = await tap.start();
    proxy = createProxy({
      upstream: tapUrls.tapUrl,
      correlation: CORRELATION_HEADER,
    });
    proxyUrls = await proxy.start();
  });
  // Each test leaves no rule or hold behind, whatever its outcome (a failed test must not decide the next one's).
  afterEach(async () => {
    await control(proxyUrls.controlUrl, "POST", "/reset");
  });
  after(async () => {
    await proxy?.stop();
    await tap?.stop();
    await new Promise((r) => backend.server.close(r));
    rmSync(dir, { recursive: true, force: true });
  });

  /** One driven step, exactly as the pair driver does it (pair.development.spec.ts → support.ts drivePieces). */
  async function step(ledger, ruleId, index, reached, act) {
    const picked = await until(async () => {
      const held =
        (await control(proxyUrls.controlUrl, "GET", "/held?entries=1"))[
          ruleId
        ] ?? [];
      return pickHeld(
        held,
        tap.records.filter((r) => r.path === SYNC),
      );
    }, `step ${index} held`);
    ledger.observe({ atSeq: picked.record.seq, stage: { next_index: index } });
    const attempt = ledger.open({ step: index, ...picked });
    await act?.();
    const released = await control(
      proxyUrls.controlUrl,
      "POST",
      `/release/${ruleId}?entry=${picked.proxyId}`,
    );
    assert.equal(released.released, 1);
    ledger.settle(attempt, {
      reached,
      downstream: released.outcomes[0].outcome,
      effect: picked.record.segment?.last ? "activated" : "staged",
    });
    return { picked, attempt };
  }

  test("a held answer lost downstream is kept, retried from the same cursor, and the RECEIVED pieces are 0,1,2,3,4", async () => {
    const rule = await addHold(proxyUrls.controlUrl);
    const ledger = createLedger();
    const answers = [];
    for (const [index, cursor] of [
      [0, "c0"],
      [1, "c1"],
      [2, "c2"],
    ]) {
      const client = ask(proxyUrls.proxyUrl, cursor);
      await step(ledger, rule.id, index, true);
      answers.push(await client.answer);
    }
    // Piece 3: held; the client goes (its connection closes) and the proxy OBSERVES it before the release.
    const gone = ask(proxyUrls.proxyUrl, "c3");
    const lost = await step(ledger, rule.id, 3, false, async () => {
      await gone.abort();
      // Bounded wait, then an ASSERTION (a time-out is never what this test reports).
      const observed = await until(
        () =>
          proxy.log.some(
            (e) =>
              e.events.some((v) => v.event === "client_closed") &&
              e.path.includes("cursor=c3"),
          ),
        "the proxy observes the closed client",
        2000,
      ).catch(() => false);
      assert.ok(
        observed,
        "the proxy observed the closed client before the release",
      );
    });
    assert.equal(lost.attempt.client, "lost");
    assert.equal(lost.attempt.downstream, "client_gone");
    // The TAP's hop completed: it records neither a loss nor a drop. Only the proxy saw the departed client.
    assert.equal(lost.picked.record.client_gone, undefined);
    assert.equal(lost.picked.record.dropped, undefined);
    assert.equal(typeof lost.picked.record.t_delivered, "number");
    // The retry: the same cursor, the same piece, received.
    const retryClient = ask(proxyUrls.proxyUrl, "c3");
    const retry = await step(ledger, rule.id, 4, true);
    answers.push(await retryClient.answer);
    assert.equal(retry.picked.record.query.cursor, "c3");
    assert.equal(retry.picked.record.sha256, lost.picked.record.sha256);
    assert.notEqual(retry.picked.proxyId, lost.picked.proxyId);
    const lastClient = ask(proxyUrls.proxyUrl, "c4");
    await step(ledger, rule.id, 5, true);
    answers.push(await lastClient.answer);
    assert.deepEqual(
      answers.map((a) => JSON.parse(a.body).batches[0].segment.index),
      [0, 1, 2, 3, 4],
    );

    // Every attempt is kept (six), the received ones are the client's applied order, and the shared check accepts it.
    const bySeq = new Map(tap.records.map((r) => [r.seq, r]));
    assert.equal(ledger.attempts.length, 6);
    assert.deepEqual(
      ledger.attempts.map((a) => a.client),
      ["received", "received", "received", "lost", "received", "received"],
    );
    const received = ledger.received().map((a) => bySeq.get(a.seq));
    assert.deepEqual(segmentedProblems(received, 4), []);
    // Persistence is credited once per received, staged piece: never to the lost attempt, never twice for one stage.
    assert.deepEqual(
      ledger.persisted.map((p) => p.applied_seq),
      [
        ledger.attempts[0].seq,
        ledger.attempts[1].seq,
        ledger.attempts[2].seq,
        ledger.attempts[4].seq,
      ],
    );
    // The R23 filter (the TAP's client_gone) keeps both piece-3 answers: the strict check REJECTS it. This is the review's false assertion.
    const r23 = tap.records
      .filter((r) => r.path === SYNC && r.status === 200)
      .filter((r) => !r.client_gone);
    assert.match(
      segmentedProblems(r23, 4).join("; "),
      /piece indices 0,1,2,3,3,4 are not 0, 1, 2/,
    );
    // The correlation header never reached the backend; every sync record carries its proxy entry; the proxy log joins each.
    assert.ok(
      backend.seen.every((s) => !(CORRELATION_HEADER in s.headers)),
      "the correlation header is stripped before the backend",
    );
    const entries = new Map(proxy.log.map((e) => [e.id, e]));
    const joined = tap.records
      .filter((r) => r.path === SYNC)
      .map((r) => ({
        ...r,
        downstream: { outcome: outcomeOf(entries.get(r.proxy_id)) },
      }));
    assert.deepEqual(
      joined.map((r) => r.downstream.outcome),
      [
        "delivered",
        "delivered",
        "delivered",
        "client_gone",
        "delivered",
        "delivered",
      ],
    );
    assert.equal(joined.filter(reachedClient).length, 5);
    await control(proxyUrls.controlUrl, "POST", "/reset");
  });

  test("two outstanding answers to the SAME cursor: each held entry is joined to exactly its own tap record and released alone", async () => {
    const rule = await addHold(proxyUrls.controlUrl);
    const a = ask(proxyUrls.proxyUrl, "c0");
    const b = ask(proxyUrls.proxyUrl, "c0");
    const held = await until(async () => {
      const ids =
        (await control(proxyUrls.controlUrl, "GET", "/held?entries=1"))[
          rule.id
        ] ?? [];
      return ids.length === 2 ? ids : null;
    }, "two held");
    const records = tap.records.filter(
      (r) => r.path === SYNC && held.includes(r.proxy_id),
    );
    assert.equal(records.length, 2);
    const first = pickHeld(held, records);
    assert.equal(first.proxyId, Math.min(...held));
    assert.equal(first.record.proxy_id, first.proxyId);
    const one = await control(
      proxyUrls.controlUrl,
      "POST",
      `/release/${rule.id}?entry=${first.proxyId}`,
    );
    assert.deepEqual(one, {
      released: 1,
      outcomes: [{ id: first.proxyId, outcome: "delivered" }],
    });
    const left = (
      await control(proxyUrls.controlUrl, "GET", "/held?entries=1")
    )[rule.id];
    assert.deepEqual(left, [Math.max(...held)]);
    // The count form is unchanged for every other caller.
    assert.deepEqual(await control(proxyUrls.controlUrl, "GET", "/held"), {
      [rule.id]: 1,
    });
    const rest = await control(
      proxyUrls.controlUrl,
      "POST",
      `/release/${rule.id}`,
    );
    assert.equal(rest.released, 1);
    await a.answer;
    await b.answer;
    await control(proxyUrls.controlUrl, "POST", "/reset");
  });
});

describe("pickHeld refuses ambiguity instead of choosing", () => {
  const rec = (seq, proxy_id, status = 200) => ({ seq, proxy_id, status });
  test("the oldest held entry, by its own id", () => {
    assert.deepEqual(pickHeld([9, 7], [rec(1, 7), rec(2, 9)]), {
      proxyId: 7,
      record: rec(1, 7),
    });
  });
  test("nothing held, or its record not complete: wait", () => {
    assert.equal(pickHeld([], [rec(1, 7)]), null);
    assert.equal(pickHeld([7], [rec(1, 7, null)]), null);
    assert.equal(pickHeld([7], []), null);
  });
  test("a record without a correlation id: refused (the runner did not correlate)", () => {
    assert.throws(
      () => pickHeld([7], [rec(1, 7), { seq: 2, status: 200 }]),
      /carry no proxy correlation id/,
    );
  });
  test("one held entry claimed by two records: refused", () => {
    assert.throws(
      () => pickHeld([7], [rec(1, 7), rec(2, 7)]),
      /claimed by tap records 1,2/,
    );
  });
});

describe("the ledger", () => {
  const record = (seq, index, last = false) => ({
    seq,
    query: { cursor: `c${index}` },
    segment: { index, last },
    revision: 7,
    sha256: `h${index}`,
  });
  test("a received attempt the proxy did not deliver is a contradiction, not a pass", () => {
    const ledger = createLedger();
    const a = ledger.open({ step: 0, record: record(1, 0), proxyId: 1 });
    assert.throws(
      () =>
        ledger.settle(a, {
          reached: true,
          downstream: "client_gone",
          effect: "staged",
        }),
      /the proxy recorded client_gone/,
    );
  });
  test("a repeated observation of one stage earns no second persistence; a lost attempt earns none", () => {
    const ledger = createLedger();
    const a = ledger.open({ step: 0, record: record(1, 0), proxyId: 1 });
    ledger.settle(a, {
      reached: true,
      downstream: "delivered",
      effect: "staged",
    });
    assert.deepEqual(ledger.observe({ atSeq: 2, stage: { next_index: 1 } }), {
      applied_seq: 1,
      observed_at_seq: 2,
      next_index: 1,
    });
    // The same stage observed again (before anything else is settled): no second credit.
    assert.equal(ledger.observe({ atSeq: 2, stage: { next_index: 1 } }), null);
    const b = ledger.open({ step: 1, record: record(2, 1), proxyId: 2 });
    ledger.settle(b, {
      reached: false,
      downstream: "client_gone",
      effect: "none",
    });
    assert.equal(ledger.observe({ atSeq: 3, stage: { next_index: 1 } }), null);
    assert.equal(ledger.persisted.length, 1);
    assert.deepEqual(
      ledger.received().map((x) => x.seq),
      [1],
    );
    assert.deepEqual(
      ledger.attempts.map((x) => [x.seq, x.client, x.downstream]),
      [
        [1, "received", "delivered"],
        [2, "lost", "client_gone"],
      ],
    );
  });
  test("a piece received and then a LOST attempt before any observation: the piece is still credited once, when observed", () => {
    const ledger = createLedger();
    const a = ledger.open({ step: 0, record: record(1, 0), proxyId: 1 });
    ledger.settle(a, {
      reached: true,
      downstream: "delivered",
      effect: "staged",
    });
    const b = ledger.open({ step: 1, record: record(2, 1), proxyId: 2 });
    ledger.settle(b, {
      reached: false,
      downstream: "client_gone",
      effect: "none",
    });
    assert.deepEqual(
      ledger.observe({ atSeq: 3, stage: { next_index: 1 } })?.applied_seq,
      1,
    );
    assert.equal(ledger.observe({ atSeq: 4, stage: { next_index: 1 } }), null);
  });
  test("an answer the tap dropped is kept as dropped; an unheld answer it did not drop is refused", () => {
    const ledger = createLedger();
    const d = ledger.unheld(
      {
        seq: 4,
        proxy_id: 4,
        dropped: "TAP-INJECTED drop_connection",
        query: { cursor: "c2" },
      },
      "upstream_error",
    );
    assert.equal(d.client, "dropped");
    assert.throws(
      () => ledger.unheld({ seq: 5 }, "delivered"),
      /neither held nor dropped/,
    );
  });
  test("effectOf: staged, activated, restarted, none", () => {
    const m = (stage, activated = null, restarted = 0) => ({
      stage,
      activated,
      restarted,
    });
    assert.equal(
      effectOf(m(null), m({ revision: 7, next_index: 1 })),
      "staged",
    );
    assert.equal(
      effectOf(
        m({ revision: 7, next_index: 1 }),
        m({ revision: 7, next_index: 2 }),
      ),
      "staged",
    );
    assert.equal(
      effectOf(m({ revision: 7, next_index: 2 }), m(null, 7)),
      "activated",
    );
    assert.equal(
      effectOf(m({ revision: 7, next_index: 2 }), m(null, null, 1)),
      "restarted",
    );
    assert.equal(effectOf(m(null, 7), m(null, 7)), "none");
  });
});

describe("segmentedProblems keeps every strict check", () => {
  const ans = (seq, index, last = false, extra = {}) => ({
    seq,
    status: 200,
    query: { max_changes: "4" },
    changes: 4,
    revision: 7,
    segment: { index, last },
    ...extra,
  });
  test("consecutive pieces with one last: accepted", () => {
    assert.deepEqual(
      segmentedProblems([ans(1, 0), ans(2, 1), ans(3, 2, true)], 4),
      [],
    );
  });
  for (const [name, list, expected] of [
    [
      "a repeated index",
      [ans(1, 0), ans(2, 1), ans(3, 1), ans(4, 2, true)],
      /piece indices 0,1,1,2/,
    ],
    ["a gap", [ans(1, 0), ans(2, 2, true)], /piece indices 0,2/],
    ["no last piece", [ans(1, 0), ans(2, 1)], /0 last pieces/],
    ["two last pieces", [ans(1, 0, true), ans(2, 1, true)], /2 last pieces/],
    ["one answer", [ans(1, 0, true)], /more than one piece/],
    [
      "another budget",
      [ans(1, 0), ans(2, 1, true, { query: { max_changes: "5" } })],
      /budget 5/,
    ],
    [
      "above the budget",
      [ans(1, 0), ans(2, 1, true, { changes: 5 })],
      /above the budget/,
    ],
  ])
    test(`refused: ${name}`, () => {
      assert.match(segmentedProblems(list, 4).join("; "), expected);
    });
});

describe("terminalOf: the answers that reached the client", () => {
  const r = (
    seq,
    {
      status = 200,
      batches = 1,
      segment = null,
      revision = 7,
      last_revision = 7,
      has_more = false,
      outcome = "delivered",
      client,
    } = {},
  ) => ({
    seq,
    status,
    batches,
    segment,
    revision,
    last_revision,
    has_more,
    downstream: { outcome },
    ...(client ? { attempt: { client } } : {}),
  });
  test("the last activating answer and the last completion are distinct when an empty live-edge page follows", () => {
    assert.deepEqual(
      terminalOf(
        [
          r(1, { segment: { index: 0, last: false }, has_more: true }),
          r(2, { segment: { index: 1, last: true } }),
          r(3, { batches: 0, revision: null, last_revision: null }),
        ],
        7,
      ),
      { final_seq: 3, activated_by_seq: 2 },
    );
  });
  test("a final answer the client never received is not a completion; a lost one is not an activation", () => {
    assert.equal(terminalOf([r(1, { outcome: "client_gone" })], 7), null);
    assert.equal(
      terminalOf(
        [
          r(1, { client: "lost" }),
          r(2, { batches: 0, revision: null, last_revision: null }),
        ],
        7,
      ),
      null,
    );
  });
  test("an answer of another revision does not activate this one", () => {
    assert.equal(
      terminalOf([r(1, { last_revision: 6, revision: 6 })], 7),
      null,
    );
  });
});

describe("tap collection failures are recorded, never swallowed", () => {
  test("a body that cannot be written is a write error; a bounded log names the highest sequence it dropped", async () => {
    const dir = mkdtempSync(
      join(process.env.TMPDIR ?? tmpdir(), "pair-attempts-fail-"),
    );
    const backend = standIn();
    const port = await listen(backend.server);
    // The first body file's name is taken by a directory: its write fails (EISDIR), deterministically.
    mkdirSync(join(dir, "bodies", "000001.upstream.json"), { recursive: true });
    const t = createTap({
      upstream: `http://127.0.0.1:${port}`,
      bodiesDir: join(dir, "bodies"),
      maxRecords: 2,
    });
    const urls = await t.start();
    try {
      for (const c of ["c0", "c1", "c2"]) {
        const r = await fetch(`${urls.tapUrl}${SYNC}?cursor=${c}`);
        await r.text();
      }
      const flushed = await control(urls.controlUrl, "POST", "/flush");
      assert.equal(flushed.flushed, true);
      assert.equal(flushed.pending_writes, 0);
      assert.deepEqual(
        flushed.write_errors.map((e) => e.file),
        ["000001.upstream.json"],
      );
      const log = await control(urls.controlUrl, "GET", "/log?since=0");
      assert.equal(log.dropped, 1);
      assert.equal(log.dropped_through, 1);
      assert.deepEqual(
        log.records.map((r) => r.seq),
        [2, 3],
      );
      const reset = await control(urls.controlUrl, "POST", "/reset");
      assert.equal(reset.write_errors.length, 1);
      assert.deepEqual(
        (await control(urls.controlUrl, "GET", "/log?since=0")).write_errors,
        [],
      );
    } finally {
      await t.stop();
      await new Promise((r) => backend.server.close(r));
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("without correlation (every other caller) the proxy sends no header and the tap records no proxy_id", async () => {
    const dir = mkdtempSync(
      join(process.env.TMPDIR ?? tmpdir(), "pair-attempts-plain-"),
    );
    const backend = standIn();
    const port = await listen(backend.server);
    const t = createTap({
      upstream: `http://127.0.0.1:${port}`,
      bodiesDir: join(dir, "bodies"),
    });
    const tu = await t.start();
    const p = createProxy({ upstream: tu.tapUrl });
    const pu = await p.start();
    try {
      const r = await fetch(`${pu.proxyUrl}${SYNC}?cursor=c0`);
      await r.text();
      assert.ok(!("proxy_id" in t.records[0]));
      assert.ok(backend.seen.every((s) => !(CORRELATION_HEADER in s.headers)));
    } finally {
      await p.stop();
      await t.stop();
      await new Promise((r) => backend.server.close(r));
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
