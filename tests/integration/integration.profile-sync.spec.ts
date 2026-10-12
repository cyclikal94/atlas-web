import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import type { Page } from "@playwright/test";
import contractPin from "../../contract-pin.json" with { type: "json" };
import {
  observeW2Capture,
  sameTargetProblems,
  type W2Observation,
} from "../../scripts/lib/profile-w2-capture.mjs";
import { oneColdRun } from "../e2e/profile-cold-run";
import {
  beginCollection,
  browserMemory,
  cdpHeap,
  endCollection,
  engineOf,
  mib,
  PROFILE_OUT,
  record,
  recordValue,
  sampler,
  writeEvidence,
} from "../e2e/profile-helpers";
import { readSyncBytes } from "../e2e/profile-sync-read";
import {
  API as API_URL,
  BACKEND,
  bootHarness,
  expect,
  ORIGIN,
  proxy,
  raw,
  rawSignIn,
  signIn,
  test,
  untilView,
} from "./helpers";

/**
 * Sync profiling, integration layer (evidence key `WEB-09a:sync-profiling`, owned by WEB-09c): P-4 (the per-request write cost of a sync
 * page and of a draft submission, end to end against the released backend on loopback), P-10 (request durations, against the stamped
 * request time-out), P-W2 (the server-maximal dense batch the released backend produces, captured from the real `/sync`, hashed and
 * processed) and the W2-limits diagnostic. MEASUREMENTS, not budgets; skipped unless ATLAS_PROFILE=1. The sync engine and the outbox
 * dispatcher are started by the FIXTURE test leader, and the first snapshot is a FIXTURE seeder's; loopback removes the network.
 */
test.skip(
  !process.env.ATLAS_PROFILE,
  "not run: measurements are taken by `pnpm profile:sync`",
);
test.describe.configure({ mode: "serial" });
// Each test's collection window (review finding R1): every row carries it, and the collection log records how the test ended.
test.beforeEach(({ browserName: _browserName }, info) => beginCollection(info));
test.afterEach(({ browserName: _browserName }, info) => endCollection(info));

const API = "/api/experimental/v1";
// ATLAS_PROFILE_SAMPLES shortens a DEBUGGING run of this spec; the recorded measurements use the defaults (20 warm-ups, 300 samples).
const QUICK = Number(process.env.ATLAS_PROFILE_SAMPLES ?? 0);
const WARMUP = QUICK > 0 ? 2 : 20;
const SAMPLES = QUICK > 0 ? QUICK : 300;

async function signedIn(page: Page) {
  expect((await signIn(page, "carol")).kind).toBe("settled");
  await untilView(page, "displaying");
  const id = await page.evaluate(
    () => window.__s.identity.get() as { account_id: string; epoch: number },
  );
  return id;
}

/** The fixture test leader (outbox and sync) over a fixture-seeded snapshot. */
async function leader(page: Page, account: string, startSync: boolean) {
  await page.evaluate((a) => window.__atlasData?.prepareAccount(a), account);
  await page.evaluate(
    async ({ a, s }) => {
      const data = window.__atlasData;
      if (!data) throw new Error("no data harness");
      await data.startOutbox(a, { start: true });
      if (s) await data.startSync(a);
    },
    { a: account, s: startSync },
  );
}

interface TraceLine {
  at: number;
  event: string;
}
const parse = (line: string): TraceLine => {
  const m = /^(\d+)ms (\S+)/.exec(line);
  return { at: Number(m?.[1] ?? 0), event: m?.[2] ?? "" };
};

const lastResource = (page: Page, suffix: string) =>
  page.evaluate((s) => {
    const entries = performance
      .getEntriesByType("resource")
      .filter((e) => e.name.includes(s)) as PerformanceResourceTiming[];
    const e = entries.at(-1);
    return e
      ? {
          requestStart: e.requestStart,
          responseEnd: e.responseEnd,
          startTime: e.startTime,
        }
      : null;
  }, suffix);

test("P-4: what the page does around ONE sync page, against the real backend", async ({
  context,
}, info) => {
  test.setTimeout(10 * 60_000);
  const engine = engineOf(info);
  const page = await bootHarness(context);
  const id = await signedIn(page);
  await leader(page, id.account_id, true);
  await expect
    .poll(() => page.evaluate(() => window.__atlasData?.engineState()?.kind))
    .toBe("idle");
  const preIssue: number[] = [];
  const request: number[] = [];
  const postResponse: number[] = [];
  const total: number[] = [];
  for (let i = 0; i < WARMUP + SAMPLES; i += 1) {
    // The page's resource-timing buffer holds 250 entries and then DROPS new ones, which would make "the last /sync" a stale entry.
    await page.evaluate(() => performance.clearResourceTimings());
    const before = await page.evaluate(
      () => (window.__atlasData?.engineTrace ?? []).length,
    );
    await page.evaluate(() => window.__atlasData?.nudgeSync());
    await expect
      .poll(
        () =>
          page.evaluate(
            (n) =>
              (window.__atlasData?.engineTrace ?? [])
                .slice(n)
                .some((l) => l.includes("data.sync_commit")),
            before,
          ),
        { timeout: 30_000, intervals: [2, 5, 10] },
      )
      .toBe(true);
    if (i < WARMUP) continue;
    const lines = (
      await page.evaluate(
        (n) => (window.__atlasData?.engineTrace ?? []).slice(n),
        before,
      )
    ).map(parse);
    const tick = lines.find((l) => l.event === "data.sync_tick");
    const commit = lines.find((l) => l.event === "data.sync_commit");
    const res = await lastResource(page, "/sync");
    if (!tick || !commit || !res) continue;
    preIssue.push(res.requestStart - tick.at);
    request.push(res.responseEnd - res.requestStart);
    postResponse.push(commit.at - res.responseEnd);
    total.push(commit.at - tick.at);
  }
  const extra = {
    warmup: WARMUP,
    method:
      "the engine's own trace (rounded to 1 ms) against the page's ResourceTiming for /sync; pre-issue = tick to requestStart (capture, lease cover, stamping), request = requestStart to responseEnd (the real backend on loopback), post-response = responseEnd to the commit event (the release checks, scan, the guarded commit and the sizing marker)",
  };
  record("P-4 sync page pre_issue_ms", engine, preIssue, extra);
  record("P-4 sync page request_ms", engine, request, extra);
  record("P-4 sync page post_response_ms", engine, postResponse, extra);
  record("P-4 sync page total_ms", engine, total, extra);
  // P-10: the same durations against the stamped time-out
  record("P-10 sync page request_ms (unthrottled loopback)", engine, request, {
    ...extra,
    stampedRequestTimeoutMs: 30_000,
  });
});

test("P-4: what the page does around ONE draft submission, against the real backend", async ({
  context,
}, info) => {
  test.setTimeout(15 * 60_000);
  const engine = engineOf(info);
  const page = await bootHarness(context);
  const id = await signedIn(page);
  await leader(page, id.account_id, false);
  const enqueue: number[] = [];
  const claim: number[] = [];
  const stamping: number[] = [];
  const request: number[] = [];
  const record_: number[] = [];
  const total: number[] = [];
  for (let i = 0; i < WARMUP + SAMPLES; i += 1) {
    await page.evaluate(() => performance.clearResourceTimings());
    const before = await page.evaluate(
      () => (window.__atlasData?.outboxTrace ?? []).length,
    );
    const person = crypto.randomUUID();
    const started = await page.evaluate(
      async ({ p, n }) => {
        const data = window.__atlasData;
        if (!data) throw new Error("no harness");
        const t0 = performance.now();
        const out = await data.enqueue({
          endpoint: "/commands",
          targets: [
            {
              resourceId: p,
              role: "primary",
              basis: "resource",
              versionChecked: false,
              seedIfUntracked: 1,
            },
          ],
          command: {
            commands: [{ kind: "create_person", id: p, name: `P-4 ${n}` }],
          },
        });
        return { t0, t1: performance.now(), localId: out.localId };
      },
      { p: person, n: i },
    );
    await expect
      .poll(
        () =>
          page.evaluate(
            (n) =>
              (window.__atlasData?.outboxTrace ?? [])
                .slice(n)
                .some((l) => l.includes("data.outbox_answer")),
            before,
          ),
        { timeout: 30_000, intervals: [2, 5, 10] },
      )
      .toBe(true);
    if (i < WARMUP) continue;
    const lines = (
      await page.evaluate(
        (n) => (window.__atlasData?.outboxTrace ?? []).slice(n),
        before,
      )
    ).map(parse);
    const send = lines.find((l) => l.event === "data.outbox_send");
    const answer = lines.find((l) => l.event === "data.outbox_answer");
    const res = await lastResource(page, "/commands");
    const done = await page.evaluate(() => performance.now());
    if (!send || !answer || !res) continue;
    enqueue.push(started.t1 - started.t0);
    claim.push(send.at - started.t1);
    stamping.push(res.requestStart - send.at);
    request.push(res.responseEnd - res.requestStart);
    record_.push(answer.at - res.responseEnd);
    total.push(done - started.t0);
  }
  const extra = {
    warmup: WARMUP,
    method:
      "enqueue = the strict enqueue transaction; claim = enqueue complete to the dispatcher's send event (wake, window read, markInFlight); stamping = send event to requestStart (lease cover write, issue); request = the real backend on loopback; record = responseEnd to the answer event (the release checks and the outcome transaction). Trace times are rounded to 1 ms.",
  };
  record("P-4 draft enqueue_ms", engine, enqueue, extra);
  record("P-4 draft claim_ms", engine, claim, extra);
  record("P-4 draft stamping_ms", engine, stamping, extra);
  record("P-4 draft request_ms", engine, request, extra);
  record("P-4 draft record_ms", engine, record_, extra);
  record("P-4 draft total_ms", engine, total, extra);
  record("P-10 draft request_ms (unthrottled loopback)", engine, request, {
    ...extra,
    stampedRequestTimeoutMs: 30_000,
  });
});

test("P-10: request durations under a throttled loopback (a proxy-injected 250 ms delay on /sync and /commands)", async ({
  context,
}, info) => {
  test.setTimeout(10 * 60_000);
  const engine = engineOf(info);
  const page = await bootHarness(context);
  const id = await signedIn(page);
  await leader(page, id.account_id, true);
  await expect
    .poll(() => page.evaluate(() => window.__atlasData?.engineState()?.kind))
    .toBe("idle");
  for (const path of [`${API}/sync`, `${API}/commands`])
    await proxy.addRule({
      method: path.endsWith("/sync") ? "GET" : "POST",
      path,
      action: "delay",
      ms: 250,
    });
  const sync: number[] = [];
  for (let i = 0; i < 100; i += 1) {
    // The page's resource-timing buffer holds 250 entries and then DROPS new ones, which would make "the last /sync" a stale entry.
    await page.evaluate(() => performance.clearResourceTimings());
    const before = await page.evaluate(
      () => (window.__atlasData?.engineTrace ?? []).length,
    );
    await page.evaluate(() => window.__atlasData?.nudgeSync());
    await expect
      .poll(
        () =>
          page.evaluate(
            (n) =>
              (window.__atlasData?.engineTrace ?? [])
                .slice(n)
                .some((l) => l.includes("data.sync_commit")),
            before,
          ),
        { timeout: 30_000, intervals: [10, 25, 50] },
      )
      .toBe(true);
    const res = await lastResource(page, "/sync");
    if (res) sync.push(res.responseEnd - res.startTime);
  }
  record("P-10 sync page duration_ms (proxy delay 250 ms)", engine, sync, {
    stampedRequestTimeoutMs: 30_000,
    method:
      "ResourceTiming startTime to responseEnd; the delay is injected by the delaying proxy and labelled so",
    conclusion:
      "the stamped time-out (30 s) is two orders of magnitude above every duration measured here; this run gives no ground for changing it: measured; unchanged",
  });
});

// ---- P-W2: the server-maximal dense batch (WEB-09c plan 4.3) --------------------------------------------------------------------------
/**
 * WEB-03's dense checklist (100 items, 40 checked, one-character labels), with fresh ids: 7,402 bytes of value, the size of every
 * change of the W1 fixture (scripts/lib/profile-workloads.mjs uses the same id length).
 */
const denseChecklist = () => {
  const items = Array.from({ length: 100 }, () => ({
    id: crypto.randomUUID(),
    label: "x",
  }));
  return {
    kind: "checklist",
    items,
    checked: items.slice(0, 40).map((item) => item.id),
  };
};

interface Change {
  kind: string;
  id?: string;
  resource?: { id: string; kind: string; value?: { kind?: string } | null };
}
interface SyncBody {
  phase: string;
  batches: Array<{ revision: number; changes: Change[] }>;
  next_cursor: string;
  has_more: boolean;
}
/**
 * Generic statistics of one batch, recorded for every observation (the pre-grant drain, both captures, the bound): how many checklist field
 * upserts, and whether `person` is in it. They describe a batch; they do NOT qualify a capture as W2 (that is `observeW2Capture`).
 */
const shapeOf = (batch: { changes: Change[] }, person: string) => ({
  changes: batch.changes.length,
  checklist_upserts: batch.changes.filter(
    (c) =>
      c.kind === "upsert" &&
      c.resource?.kind === "field" &&
      c.resource.value?.kind === "checklist",
  ).length,
  person_ancestor: batch.changes.some(
    (c) => c.kind === "upsert" && c.resource?.id === person,
  ),
});

/** A raw writer (another account, raw HTTP through the preview origin and the proxy, as a browser's request would go). */
async function writer() {
  const session = await rawSignIn("dave");
  const retried: Array<{ path: string; status: number }> = [];
  const send = async (path: string, body: unknown) => {
    // One idempotency key per logical write: a write the server refused for capacity (503) is asked again with the SAME key, so a
    // retry can never create a second resource; every retry is recorded.
    const key = crypto.randomUUID();
    for (let attempt = 0; ; attempt += 1) {
      const r = await raw("POST", path, {
        cookie: session.cookie,
        headers: { "x-csrf-token": session.csrf, "idempotency-key": key },
        body,
      });
      if (r.status !== 503 || attempt >= 5) return r;
      retried.push({ path, status: r.status });
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  };
  return { session, send, retried };
}

/**
 * Reads `/sync` from `cursor` at `limit` through THIS page's stamped wrapper (the cursor belongs to the page's session), as the engine does.
 * Revision 5 (design assessment DA-E3, A2): the body's exact BYTES (`readSyncBytes`); `text` is a decoded view for messages and for the
 * pages this spec only reads (the drain, the bound), never a capture.
 */
const readSync = readSyncBytes;

/**
 * The released backend's sharing rules, read from its source at the pinned commit (crates/core/src/policy.rs `put_policy`,
 * resources/mod.rs `Grant`/`Revoke`): a field may be shared only with an account that can ALREADY see its person
 * (`identity_grant_required`), a field is visible only while it is shared AND every ancestor is visible, and a grant or revocation of a
 * person publishes the person and all of its children in ONE revision ("a person's visibility gates all of its independently shared
 * fields"), refused or turned into a snapshot recovery above 200 changes for one account. The densest batch a reader can be sent is
 * therefore reached by revoking and then granting again a person whose dense fields are shared with the reader.
 */
async function policyVersionOf(
  session: Awaited<ReturnType<typeof writer>>["session"],
  person: string,
) {
  const read = await raw("GET", `/people/${person}`, {
    cookie: session.cookie,
    headers: { "x-csrf-token": session.csrf },
  });
  expect(read.status, JSON.stringify(read.json)).toBe(200);
  return (read.json as { person: { policy_version: number } }).person
    .policy_version;
}

/** Grants (`grant`) or revokes (`revoke`) the reader's read access to `person`, with the policy version read back from the server. */
async function access(
  w: Awaited<ReturnType<typeof writer>>,
  kind: "grant" | "revoke",
  person: string,
  account: string,
) {
  const policyVersion = await policyVersionOf(w.session, person);
  const answer = await w.send("/access-commands", {
    commands: [
      {
        kind,
        id: person,
        expected_version: policyVersion,
        account_id: account,
        ...(kind === "grant" ? { edit: false } : {}),
      },
    ],
  });
  return { status: answer.status, body: answer.json, policyVersion };
}

/**
 * Seeds one person of the writer, granted to `reader`, holding `fields` dense checklist fields (put_field, one command per request), each
 * shared with `reader` at its creation; then REVOKES the person, so the reader sees none of it. Every answer is asserted: the first
 * put_field is the shape check, and a refusal fails the case with the server's own body, never "W2 not producible".
 */
async function seedDensePerson(
  w: Awaited<ReturnType<typeof writer>>,
  fields: number,
  reader: string,
) {
  const person = crypto.randomUUID();
  const created = await w.send("/commands", {
    commands: [
      {
        kind: "create_person",
        id: person,
        name: "W2 person",
        initial_policy: { grants: [], exclude_accounts: [] },
      },
    ],
  });
  expect(created.status, JSON.stringify(created.json)).toBe(200);
  const granted = await access(w, "grant", person, reader);
  expect(granted.status, JSON.stringify(granted.body)).toBe(200);
  let valueBytes = 0;
  for (let i = 0; i < fields; i += 1) {
    const value = denseChecklist();
    valueBytes = Buffer.byteLength(JSON.stringify(value));
    // A creation with a non-empty explicit sharing policy is an ONLINE task command: `/task-access-commands`, not `/task-commands`
    // (the released server refuses it there as `invalid_value`, crates/server/src/tasks.rs).
    const put = await w.send("/task-access-commands", {
      command: {
        kind: "put_field",
        id: crypto.randomUUID(),
        parent_id: person,
        expected_version: null,
        label: "Checklist",
        value,
        initial_policy: {
          grants: [{ kind: "account", id: reader, edit: false }],
          exclude_accounts: [],
        },
      },
    });
    expect(
      put.status,
      `put_field ${i + 1} of ${fields}: ${JSON.stringify(put.json)}`,
    ).toBe(200);
  }
  return { person, valueBytes };
}

/** Reads the reader's delta from `cursor` to the live edge (limit 80 pages), returning the cursor there and the shape of every batch. */
async function drain(
  page: Page,
  id: { account_id: string; epoch: number },
  cursor: string,
  person: string,
) {
  let at = cursor;
  const shapes: Array<ReturnType<typeof shapeOf>> = [];
  for (let pages = 0; pages < 100; pages += 1) {
    const r = await readSync(page, id.account_id, id.epoch, at, 80);
    expect(r.status, r.error ?? r.text.slice(0, 400)).toBe(200);
    const body = JSON.parse(r.text) as SyncBody;
    shapes.push(...body.batches.map((b) => shapeOf(b, person)));
    at = body.next_cursor;
    if (!body.has_more) return { cursor: at, shapes };
  }
  throw new Error("the delta did not reach the live edge in 100 pages");
}

test("W2: the server-maximal dense batch from the released backend (a person holding 199 put_field checklists shared with the reader, revoked and granted again), captured from the real /sync, hashed and processed", async ({
  context,
  browser,
}, info) => {
  test.setTimeout(30 * 60_000);
  const engine = engineOf(info);
  const page = await bootHarness(context);
  const id = await signedIn(page);
  const seeded = (await page.evaluate(
    (a) => window.__atlasData?.prepareAccount(a),
    id.account_id,
  )) as { cursor: string };
  // What the server says it is, beside what the runner fetched and verified.
  // `GET /health` is at the origin root (decision D-08), not under the API prefix.
  const health = await fetch(`${ORIGIN}/health`);
  recordValue("backend", engine, {
    health: { status: health.status, body: await health.json() },
    revision: JSON.parse(
      process.env.ATLAS_INTEGRATION_BACKEND_REVISION ?? "null",
    ),
  });

  // 1-3. Seeding through the real write path: a person of another account, granted to the reader, holding 199 dense checklist fields
  // shared with the reader, then revoked (one batch of removals). The reader reads to the live edge, and the person is granted again:
  // that revision is the server-maximal dense batch (the person and its 199 fields).
  const w = await writer();
  const seededAt = Date.now();
  const { person, valueBytes } = await seedDensePerson(w, 199, id.account_id);
  const revoked = await access(w, "revoke", person, id.account_id);
  expect(revoked.status, JSON.stringify(revoked.body)).toBe(200);
  const before = await drain(page, id, seeded.cursor, person);
  const granted = await access(w, "grant", person, id.account_id);
  expect(granted.status, JSON.stringify(granted.body)).toBe(200);
  const seedingMs = Date.now() - seededAt;

  // 4. Capture: the reader's delta from the live edge before the grant, at limit 1 and at limit 80.
  // The seed's own value size, checked against the documented one (WEB-03's dense checklist with 36-character ids: 7,402 bytes).
  expect(valueBytes, "the seeded dense checklist's serialised size").toBe(
    7_402,
  );
  const captures: Record<string, unknown> = {};
  const observations: W2Observation[] = [];
  let w2Body: Buffer = Buffer.alloc(0);
  let afterW2 = "";
  mkdirSync(`${PROFILE_OUT}/w2`, { recursive: true });
  for (const limit of [1, 80]) {
    const captured = await readSync(
      page,
      id.account_id,
      id.epoch,
      before.cursor,
      limit,
    );
    expect(captured.status, captured.error ?? captured.text.slice(0, 400)).toBe(
      200,
    );
    // The measurement happened only if the bytes ARE the seeded dense batch (revision 4, review 4 R2): a valid sync page whose one batch
    // holding this person is the person and its 199 distinct checklist fields of 100 items and 40 checked ids each, 200 changes and
    // nothing else; the same reader the evidence contract applies to the file. Revision 5 (DA-E3): the reader sees, and the file, hash
    // and cold replays get, the response body's exact bytes; they are decoded for the figures below only after the reader (which puts
    // them through the production receive path) admitted them.
    const raw = captured.bytes;
    const observed = observeW2Capture(raw, { person, limit });
    expect(observed.problems, `limit ${limit}`).toEqual([]);
    expect(observed.target?.value_bytes, `limit ${limit}`).toBe(valueBytes);
    observations.push(observed);
    const body = JSON.parse(raw.toString("utf8")) as SyncBody;
    const shapes = body.batches.map((b) => shapeOf(b, person));
    const bytes = raw.length;
    writeFileSync(
      `${PROFILE_OUT}/w2/W2-captured.${engine}.limit-${limit}.json`,
      raw,
    );
    captures[`limit_${limit}`] = {
      phase: body.phase,
      bytes,
      mib: +(bytes / 1_048_576).toFixed(3),
      batches: body.batches.length,
      batch_shapes: shapes,
      changes: body.batches.reduce((n, b) => n + b.changes.length, 0),
      has_more: body.has_more,
      sha256: createHash("sha256").update(raw).digest("hex"),
      file: `w2/W2-captured.${engine}.limit-${limit}.json`,
    };
    if (limit === 1) w2Body = raw;
    if (limit === 80) afterW2 = body.next_cursor;
  }
  // Both limits show the same seeded batch (its revision and contents); their pagination may differ.
  expect(
    sameTargetProblems(
      observations[0] as W2Observation,
      observations[1] as W2Observation,
    ),
  ).toEqual([]);

  // 5. Process, live: the page's FIXTURE leader syncs from the seeded cursor against the real server (every batch of the seeding, then
  // the dense one) and commits through the production engine path; heap (Chromium) and the engine process tree's RSS are sampled while
  // it does. It is done when a commit at least as large as the captured limit-1 page is traced and the engine is no longer running.
  const heap = await cdpHeap(page, engine);
  await heap.gc();
  const heapBaseline = await heap.used();
  const memory = browserMemory();
  await memory.baseline();
  const heapSampler = sampler(() => heap.used(), 25);
  memory.start(100);
  await page.evaluate(() => performance.clearResourceTimings());
  const liveStarted = Date.now();
  // Only the engine: `leader` would run `prepareAccount` again, which seeds a NEW snapshot (holding the dense fields as snapshot rows)
  // and moves the cursor past the very delta this step measures.
  await page.evaluate(async (a) => {
    const data = window.__atlasData;
    if (!data) throw new Error("no data harness");
    await data.startSync(a);
  }, id.account_id);
  let liveOutcome = "admitted";
  try {
    await page.waitForFunction(
      (least) => {
        const trace = window.__atlasData?.engineTrace ?? [];
        const state = window.__atlasData?.engineState();
        const dense = trace.some((l) => {
          if (!l.includes("data.sync_commit")) return false;
          const at = l.indexOf("{");
          try {
            return (
              at >= 0 && (JSON.parse(l.slice(at)).bytes ?? 0) >= least * 0.9
            );
          } catch {
            return false;
          }
        });
        // Admitted: the dense page committed and the engine is idle. Refused: the engine stopped. Anything else is waited out (a
        // back-off is transient) until the time-out, which is recorded as such.
        return (dense && state?.kind === "idle") || state?.kind === "stopped";
      },
      w2Body.length,
      { timeout: 240_000, polling: 25 },
    );
    const state = await page.evaluate(() => window.__atlasData?.engineState());
    liveOutcome = state?.kind === "idle" ? "admitted" : "refused";
  } catch {
    liveOutcome = "timeout";
  }
  const liveElapsed = Date.now() - liveStarted;
  const heapSamples = await heapSampler.stop();
  await memory.stop();
  await memory.after();
  const liveMemory = memory.record();
  const trace = await page.evaluate(
    () => window.__atlasData?.engineTrace ?? [],
  );
  // The engine's own trace of the live run is kept whatever its outcome: a refusal or a time-out is read from it, never guessed at.
  writeFileSync(
    `${PROFILE_OUT}/w2/P-W2.${engine}.live-engine-trace.txt`,
    trace.join("\n"),
  );
  const commits = trace
    .filter((l) => l.includes("data.sync_commit"))
    .map((l) => {
      const at = l.indexOf("{");
      try {
        return at < 0 ? {} : JSON.parse(l.slice(at));
      } catch {
        return {};
      }
    });
  const limitsAsked = await page.evaluate(() =>
    performance
      .getEntriesByType("resource")
      .filter((e) => e.name.includes("/sync"))
      .map((e) => new URL(e.name).searchParams.get("limit")),
  );
  const live = {
    outcome: liveOutcome,
    elapsed_ms: liveElapsed,
    commits,
    limits_the_engine_asked_for: limitsAsked,
    heap_baseline_bytes: heapBaseline,
    heap_samples_bytes: heapSamples,
    heap_peak_bytes: heapSamples.length ? Math.max(...heapSamples) : null,
    rss_baseline_kib: liveMemory.baseline_kib,
    rss_peak_kib: liveMemory.peak_kib,
    rss: liveMemory,
    label:
      "the released backend's /sync read by the production engine (FIXTURE leader), on a desktop engine; RSS is the browser's own processes, attributed (on macOS WebKit with its launchd services; browser-process RSS: not device memory, not server RSS)",
  };

  // 5 (continued). Five cold applications of the captured limit-1 bytes through the production path, the network a stub serving them.
  const coldRuns = [];
  for (let run = 1; run <= 5; run += 1)
    coldRuns.push(
      await oneColdRun(browser, info.project.use.baseURL, engine, w2Body),
    );
  const bytes = w2Body.length;
  writeEvidence(`w2/P-W2.${engine}.json`, {
    engine,
    path: "production session (fetchFor, the real stamped wrapper) -> scanner -> validator -> page commit; the CAPTURED bytes of the released backend's /sync (limit 1), served by a Playwright route stub in a new context per run",
    cold: "a new browser context for every run",
    rss: "the browser's own processes, attributed per run (the test worker's descendants and, for WebKit on macOS, its host's launchd services; browser-process RSS: not device memory, not server RSS)",
    live,
    rows: [
      {
        workload: "W2",
        bytes,
        mib: mib(bytes),
        expected: "admitted",
        runs: coldRuns,
      },
    ],
  });
  // Every run's figure as it is: an error run leaves a non-number, which the evidence contract refuses (never a shorter series).
  record(
    "P-W2 elapsed_ms",
    engine,
    coldRuns.map((r) => r.elapsed_ms as number),
    { bytes, expected: "admitted" },
  );
  record(
    "P-W2 rss_peak_kib",
    engine,
    coldRuns.map((r) => r.rss_peak_kib as number),
    {
      bytes,
      caveat:
        "the browser's own processes (on macOS WebKit with its launchd services); per-run attribution in w2/",
    },
  );
  if (engine === "chromium")
    record(
      "P-W2 heap_peak_bytes",
      engine,
      coldRuns.map((r) => r.heap_peak_bytes as number),
      { bytes },
    );
  else
    recordValue("P-W2 heap_peak_bytes", engine, {
      capability: "unavailable",
      reason:
        "this engine exposes no JS heap signal to the test (CDP's Performance domain is Chromium's)",
    });
  recordValue("P-W2 capture", engine, {
    status: "measured",
    server: `the released ${contractPin.backend_tag} on SQLite behind the delaying proxy, loopback`,
    seeding: {
      writer: "dave (raw HTTP)",
      reader: "carol (this page)",
      // The seeded person: the capture's dense batch is recomputed from the bytes against THIS identity (revision 3, review 3 R2).
      person,
      dense_fields: 199,
      value_bytes: valueBytes,
      seeding_ms: seedingMs,
      grant_policy_version: granted.policyVersion,
      revoke_status: revoked.status,
      batches_before_the_grant: before.shapes,
      capacity_retries: w.retried,
    },
    captures,
    live,
    cold_outcomes: coldRuns.map((r) => r.outcome),
  });
  // 6. The observed bound (recorded, not a client requirement), LAST because it may move the reader's access epoch: one more person
  // with 200 dense fields granted at once, which would be a batch of 201 changes. What the released server answered and what it then
  // delivered is recorded; the publisher bound is BE-B1's.
  const bound = await seedDensePerson(w, 200, id.account_id);
  const boundRevoke = await access(w, "revoke", bound.person, id.account_id);
  let boundRead: Record<string, unknown> = { status: "not_read" };
  if (boundRevoke.status === 200) {
    const r = await readSync(page, id.account_id, id.epoch, afterW2, 80);
    boundRead =
      r.status === 200
        ? {
            status: 200,
            batch_shapes: (JSON.parse(r.text) as SyncBody).batches.map((b) =>
              shapeOf(b, bound.person),
            ),
            has_more: (JSON.parse(r.text) as SyncBody).has_more,
            bytes: Buffer.byteLength(r.text),
          }
        : { status: r.status, error: r.error, body: r.text.slice(0, 400) };
  }
  recordValue("P-W2 observed bound", engine, {
    bound_person: bound.person,
    write:
      "one revocation of a person holding 200 dense checklist fields shared with the reader (201 changes for the reader in one revision)",
    revoke: { status: boundRevoke.status, body: boundRevoke.body },
    delivered: boundRead,
    reading: `what the released ${contractPin.backend_tag} did; the publisher's bound (B-7) belongs to BE-B1 and is not a client requirement`,
  });
});

// ---- W2-limits: the old probes, and the proxy's 502 diagnosed (each oversized body is also sent directly to the backend) ----------------
test("W2-limits: the largest text value and command count the released backend accepts, and what answers an oversized body (through the proxy and directly)", async ({
  context,
}, info) => {
  test.setTimeout(10 * 60_000);
  const engine = engineOf(info);
  await bootHarness(context);
  const session = await rawSignIn("carol");
  const post = async (commands: unknown[], direct = false) => {
    const headers = {
      origin: ORIGIN,
      "content-type": "application/json",
      cookie: session.cookie,
      "x-csrf-token": session.csrf,
      "idempotency-key": crypto.randomUUID(),
    };
    try {
      const response = await fetch(
        `${direct ? `${BACKEND}/api/experimental/v1` : API_URL}/commands`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({ commands }),
          redirect: "manual",
        },
      );
      const text = await response.text();
      return { status: response.status, body: text.slice(0, 300) };
    } catch (error) {
      return { status: 0, body: `transport: ${String(error).slice(0, 200)}` };
    }
  };
  const person = crypto.randomUUID();
  expect(
    (await post([{ kind: "create_person", id: person, name: "W2 limits" }]))
      .status,
  ).toBe(200);
  const bulk = (n: number, length: number) =>
    Array.from({ length: n }, () => ({
      kind: "create_field",
      id: crypto.randomUUID(),
      person_id: person,
      label: "Bulk",
      value: "w".repeat(length),
    }));
  const probe: Record<string, unknown> = {};
  // The legacy create_field cannot carry a checklist (the old probe's 400): recorded again, so the reason W2 needs put_field is on file.
  probe.legacy_create_field_checklist = await post([
    {
      kind: "create_field",
      id: crypto.randomUUID(),
      person_id: person,
      label: "Checklist",
      value: denseChecklist(),
    },
  ]);
  let valueLength = 0;
  for (const length of [4096, 2000, 1000, 500, 100])
    if ((await post(bulk(1, length))).status === 200) {
      valueLength = length;
      break;
    }
  probe.largest_text_value_accepted_of_tried = valueLength;
  // Command counts: through the proxy, and the SAME size directly to the backend, so a proxy 502 is told apart from the server's answer.
  const rows: Array<Record<string, unknown>> = [];
  for (const n of [800, 400, 200, 100, 40, 21, 20]) {
    const body = bulk(n, Math.max(valueLength, 1));
    const bodyBytes = Buffer.byteLength(JSON.stringify({ commands: body }));
    const proxied = await post(body);
    const direct =
      proxied.status === 200
        ? null
        : await post(
            body.map((c) => ({ ...c, id: crypto.randomUUID() })),
            true,
          );
    rows.push({ commands: n, body_bytes: bodyBytes, proxied, direct });
    if (proxied.status === 200) break;
  }
  probe.command_count_rows = rows;
  recordValue("W2-limits", engine, {
    status: "measured",
    probe,
    reading:
      "the contract allows 20 content commands per request and a 4,096-character text value. `direct` is the backend's own answer; where `proxied` is 502 and `direct` is not, the backend refused the body before reading it whole and the delaying proxy (Node's http client loses an answer sent before the upload ended) reported its own 502: a harness limitation, not the server's answer",
  });
});
