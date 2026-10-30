// WEB-09c R23-PAIR: the tap passes everything through unchanged and records the server's exact bytes; a one-shot labelled fault alters
// exactly one answer, is recorded apart from the server's body and is counted. Against a loopback stand-in upstream (no backend).
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { createTap, INJECTED_410, tamper } from "./pair-tap.mjs";

const sha = (b) => createHash("sha256").update(b).digest("hex");
let upstream;
let tap;
let urls;
let dir;
const answers = [];
const page = (index, last, cursor) =>
  JSON.stringify({
    phase: "delta",
    batches: [
      {
        revision: 7,
        changes: [{ kind: "upsert", resource: { id: `r${index}` } }],
        segment: { index, last },
      },
    ],
    next_cursor: cursor,
    has_more: !last,
  });
before(async () => {
  dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "pair-tap-test-"));
  upstream = createServer((req, res) => {
    if (req.url.startsWith("/api/experimental/v1/sync")) {
      const body =
        answers.shift() ??
        JSON.stringify({
          phase: "delta",
          batches: [],
          next_cursor: "same",
          has_more: false,
        });
      res.writeHead(200, {
        "content-type": "application/json",
        "set-cookie": "a=b",
      });
      res.end(body);
      return;
    }
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      res.writeHead(201, {
        "content-type": "application/json",
        "x-seen-cookie": req.headers.cookie ?? "",
      });
      res.end(
        JSON.stringify({ echoed: Buffer.concat(chunks).toString("utf8") }),
      );
    });
  });
  await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
  tap = createTap({
    upstream: `http://127.0.0.1:${upstream.address().port}`,
    bodiesDir: join(dir, "bodies"),
  });
  urls = await tap.start();
});
after(async () => {
  await tap.stop();
  await new Promise((r) => upstream.close(r));
  rmSync(dir, { recursive: true, force: true });
});
const control = async (method, path, body) =>
  (
    await fetch(`${urls.controlUrl}${path}`, {
      method,
      headers: { "content-type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    })
  ).json();
const sync = (query = "") =>
  fetch(`${urls.tapUrl}/api/experimental/v1/sync${query}`);

test("a non-sync request and its body, cookie and status pass through untouched", async () => {
  const r = await fetch(`${urls.tapUrl}/api/experimental/v1/commands`, {
    method: "POST",
    headers: { cookie: "s=1" },
    body: "payload",
  });
  assert.equal(r.status, 201);
  assert.equal(r.headers.get("x-seen-cookie"), "s=1");
  assert.deepEqual(await r.json(), { echoed: "payload" });
});

test("a /sync answer is delivered byte for byte and recorded with its hash, query, segment and label; the body file is written", async () => {
  await control("POST", "/reset");
  await control("POST", "/label", { label: "iv-1" });
  const body = page(0, false, "c1");
  answers.push(body);
  const r = await sync("?cursor=c0&max_changes=4");
  assert.equal(await r.text(), body);
  assert.equal(r.headers.get("set-cookie"), "a=b");
  await control("POST", "/flush");
  const { records } = await control("GET", "/log");
  const rec = records.at(-1);
  assert.equal(rec.label, "iv-1");
  assert.deepEqual(rec.query, { cursor: "c0", limit: null, max_changes: "4" });
  assert.equal(rec.sha256, sha(body));
  assert.equal(rec.bytes, Buffer.byteLength(body));
  assert.deepEqual(rec.segment, { index: 0, last: false });
  assert.equal(rec.next_cursor, "c1");
  assert.equal(rec.delivered, undefined);
  assert.equal(readFileSync(join(dir, "bodies", rec.body_file), "utf8"), body);
});

for (const [kind, extra, check] of [
  [
    "tamper_next_cursor",
    {},
    (got) => assert.equal(got.next_cursor, tamper("c1")),
  ],
  [
    "substitute_next_cursor",
    { value: "foreign" },
    (got) => assert.equal(got.next_cursor, "foreign"),
  ],
  [
    "segment_index_delta",
    { delta: 1 },
    (got) => assert.equal(got.batches[0].segment.index, 1),
  ],
  [
    "revision_delta",
    { delta: 1 },
    (got) => assert.equal(got.batches[0].revision, 8),
  ],
])
  test(`fault ${kind}: one answer altered, recorded apart from the server's, fired once; the next answer is the server's`, async () => {
    await control("POST", "/reset");
    const armed = await control("POST", "/fault", { kind, ...extra });
    const first = page(0, false, "c1");
    const second = page(1, false, "c2");
    answers.push(first, second);
    const got = await (await sync("?cursor=c0")).json();
    check(got);
    const untouched = await (await sync("?cursor=c1")).text();
    assert.equal(untouched, second);
    await control("POST", "/flush");
    const { records } = await control("GET", "/log");
    const [a, b] = records.slice(-2);
    assert.equal(
      a.sha256,
      sha(first),
      "the server's body is recorded unaltered",
    );
    assert.match(a.delivered.injected, new RegExp(`TAP-INJECTED ${kind}`));
    assert.equal(a.delivered.status, 200);
    assert.notEqual(a.delivered.sha256, a.sha256);
    assert.equal(
      readFileSync(join(dir, "bodies", a.delivered.body_file), "utf8"),
      JSON.stringify(got),
    );
    assert.equal(b.delivered, undefined);
    const faults = await control("GET", "/faults");
    assert.equal(faults.find((f) => f.id === armed.id).fired, a.seq);
  });

test("fault replay_previous answers the previously delivered piece at the current cursor", async () => {
  await control("POST", "/reset");
  const p0 = page(0, false, "c1");
  const p1 = page(1, false, "c2");
  answers.push(p0, p1);
  await control("POST", "/fault", { kind: "replay_previous", afterIndex: 1 });
  assert.equal(await (await sync("?cursor=c0")).text(), p0);
  assert.equal(await (await sync("?cursor=c1")).text(), p0);
});

test("fault answer_410 answers a 410 resync_required with no Set-Cookie, recording the server's real 200 apart", async () => {
  await control("POST", "/reset");
  await control("POST", "/fault", { kind: "answer_410" });
  answers.push(page(0, false, "c1"));
  const r = await sync("?cursor=c0");
  assert.equal(r.status, 410);
  assert.equal(r.headers.get("set-cookie"), null);
  assert.equal(r.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(await r.json(), INJECTED_410);
  const { records } = await control("GET", "/log");
  assert.equal(records.at(-1).status, 200);
  assert.equal(records.at(-1).delivered.status, 410);
});

test("fault drop_connection: the server answered (recorded), the client receives nothing", async () => {
  await control("POST", "/reset");
  await control("POST", "/fault", { kind: "drop_connection" });
  answers.push(page(0, false, "c1"));
  await assert.rejects(sync("?cursor=c0"));
  await control("POST", "/flush");
  const { records } = await control("GET", "/log");
  assert.equal(records.at(-1).status, 200);
  assert.match(records.at(-1).dropped, /TAP-INJECTED drop_connection/);
  assert.equal(records.at(-1).delivered, undefined);
});

test("a fault never alters an answer that is not a segment, waits for afterIndex, and an unfired fault is reported at reset", async () => {
  await control("POST", "/reset");
  await control("POST", "/fault", {
    kind: "tamper_next_cursor",
    afterIndex: 2,
  });
  const whole = JSON.stringify({
    phase: "delta",
    batches: [{ revision: 3, changes: [] }],
    next_cursor: "w",
    has_more: false,
  });
  answers.push(whole, page(0, false, "c1"));
  assert.equal(await (await sync()).text(), whole);
  assert.equal(await (await sync("?cursor=w")).text(), page(0, false, "c1"));
  const reset = await control("POST", "/reset");
  assert.equal(reset.unfired.length, 1);
});

test("tamper keeps a hexadecimal MAC hexadecimal and the token's length", () => {
  assert.equal(tamper("d2.aa.ff"), "d2.aa.f0");
  assert.equal(tamper("d2.aa.f9"), "d2.aa.fa");
  assert.equal(tamper("cursorZ").length, "cursorZ".length);
  assert.notEqual(tamper("cursorZ"), "cursorZ");
});

test("an unknown fault is refused", async () => {
  const r = await fetch(`${urls.controlUrl}/fault`, {
    method: "POST",
    body: JSON.stringify({ kind: "anything" }),
  });
  assert.equal(r.status, 400);
});

test("the tap forwards to loopback only", () => {
  assert.throws(
    () => createTap({ upstream: "http://example.com:80", bodiesDir: dir }),
    /loopback only/,
  );
});
