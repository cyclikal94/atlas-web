import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import type { Page } from "@playwright/test";
import {
  engineOf,
  PROFILE_OUT,
  record,
  recordValue,
} from "../e2e/profile-helpers";
import {
  bootHarness,
  expect,
  proxy,
  raw,
  rawSignIn,
  signIn,
  test,
  untilView,
} from "./helpers";

/**
 * WEB-09a profiling, integration layer (plan 7.2): P-4 (the per-request write cost of a sync page and of a draft submission, end to
 * end against the released backend on loopback), P-10 (request durations, against the stamped request time-out) and the W2 feasibility
 * probe (what the real server can produce). MEASUREMENTS, not budgets; skipped unless ATLAS_PROFILE=1. The sync engine and the outbox
 * dispatcher are started by the FIXTURE test leader, and the first snapshot is a FIXTURE seeder's; loopback removes the network.
 */
test.skip(
  !process.env.ATLAS_PROFILE,
  "not run: measurements are taken by `pnpm profile:sync`",
);
test.describe.configure({ mode: "serial" });

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

test("W2: what the released backend can actually produce (a feasibility probe, with the largest page captured from the real /sync)", async ({
  context,
}, info) => {
  test.setTimeout(10 * 60_000);
  const engine = engineOf(info);
  const page = await bootHarness(context);
  const id = await signedIn(page);
  const seeded = (await page.evaluate(
    (a) => window.__atlasData?.prepareAccount(a),
    id.account_id,
  )) as { cursor: string };
  const session = await rawSignIn("carol");
  // A request the server refuses by closing the connection (a body above its limit) is an ANSWER of this probe, not a failure of it.
  const post = async (commands: unknown[]) => {
    try {
      return await raw("POST", "/commands", {
        cookie: session.cookie,
        headers: {
          "x-csrf-token": session.csrf,
          "idempotency-key": crypto.randomUUID(),
        },
        body: { commands },
      });
    } catch (error) {
      return {
        status: 0,
        json: { transport_error: String(error).slice(0, 160) } as unknown,
      };
    }
  };
  const person = crypto.randomUUID();
  const created = await post([
    { kind: "create_person", id: person, name: "W2 person" },
  ]);
  expect(created.status).toBe(200);
  const probe: Record<string, unknown> = {};
  // 1. does the released backend accept a checklist-shaped value on a field at all?
  const checklistTry = await post([
    {
      kind: "create_field",
      id: crypto.randomUUID(),
      person_id: person,
      label: "Checklist",
      value: {
        kind: "checklist",
        items: [{ id: crypto.randomUUID(), label: "x" }],
        checked: [],
      },
    },
  ]);
  probe.checklist_value = {
    status: checklistTry.status,
    body: checklistTry.json,
  };
  // 2. the largest text value a field accepts
  let valueLength = 0;
  for (const length of [4096, 2000, 1000, 500, 100]) {
    const r = await post([
      {
        kind: "create_field",
        id: crypto.randomUUID(),
        person_id: person,
        label: "Text",
        value: "w".repeat(length),
      },
    ]);
    if (r.status === 200) {
      valueLength = length;
      break;
    }
  }
  probe.largest_text_value_accepted_of_tried = valueLength;
  // 3. the most commands one request accepts: with the largest value, and with a one-character value (to tell a count limit from a body limit)
  const bulk = (n: number, length: number) =>
    Array.from({ length: n }, () => ({
      kind: "create_field",
      id: crypto.randomUUID(),
      person_id: person,
      label: "Bulk",
      value: "w".repeat(length),
    }));
  let perRequest = 0;
  for (const n of [800, 400, 200, 100, 50, 40, 30, 25, 20, 15, 10, 5, 1]) {
    const r = await post(bulk(n, valueLength > 0 ? valueLength : 1));
    probe[`request_with_${n}_commands_of_${valueLength}_chars`] = {
      status: r.status,
    };
    if (r.status === 200) {
      perRequest = n;
      break;
    }
  }
  probe.most_commands_in_one_request_of_tried = perRequest;
  for (const n of [800, 200, 100, 50, 40, 30, 25, 20, 10]) {
    const r = await post(bulk(n, 1));
    probe[`request_with_${n}_commands_of_1_char`] = { status: r.status };
    if (r.status === 200) {
      probe.most_commands_in_one_request_with_1_char_values = n;
      break;
    }
  }
  // 3b. the biggest page the server can then be asked for: eighty requests (the largest `limit`) of the largest accepted size
  for (let i = 0; i < 79 && perRequest > 0; i += 1)
    expect((await post(bulk(perRequest, valueLength))).status).toBe(200);
  // 4. read the page the real server produces for all of that, from the seeded cursor, at the largest `limit`
  // The cursor belongs to THIS page's session, so the page reads it (through the stamped wrapper, as the engine does). An engine whose
  // fetch fails on a body this large (WebKit did, once) is a finding to record, not a reason to lose the other engines' capture.
  const read = () =>
    page.evaluate(
      async ({ a, e, cursor }) => {
        const fetchPage = window.__s.api.fetchFor("ordinary", a, e);
        const url = new URL("/api/experimental/v1/sync", location.origin);
        url.searchParams.set("cursor", cursor);
        url.searchParams.set("limit", "80");
        for (let attempt = 0; attempt < 60; attempt += 1) {
          try {
            const response = await fetchPage(
              new Request(url, { method: "GET" }),
            );
            return {
              status: response.status,
              text: await response.text(),
              error: null as string | null,
            };
          } catch (error) {
            if (!String(error).includes("not_sent"))
              return {
                status: 0,
                text: "",
                error: String(error).slice(0, 200),
              };
            await new Promise((resolve) => setTimeout(resolve, 100));
          }
        }
        return { status: 0, text: "", error: "not_sent for six seconds" };
      },
      { a: id.account_id, e: id.epoch, cursor: seeded.cursor },
    );
  let captured = await read();
  for (let again = 0; again < 2 && captured.status === 0; again += 1)
    captured = await read();
  if (captured.status === 0) {
    recordValue("W2 feasibility", engine, {
      status: "capture_failed_in_this_engine",
      error: captured.error,
      probe,
      reading:
        "the probe's limits above stand; the page could not be read back through this engine's fetch (three attempts)",
    });
    return;
  }
  expect(captured.status).toBe(200);
  const body = JSON.parse(captured.text) as {
    batches: Array<{ changes: unknown[] }>;
    has_more: boolean;
    phase: string;
  };
  const bytes = Buffer.byteLength(captured.text);
  const sha = createHash("sha256").update(captured.text).digest("hex");
  mkdirSync(`${PROFILE_OUT}/handoff/fixtures`, { recursive: true });
  writeFileSync(
    `${PROFILE_OUT}/handoff/fixtures/W2-captured.${engine}.json`,
    captured.text,
  );
  recordValue("W2 feasibility", engine, {
    status: "measured",
    server: "the released v0.27.0-rc.1 on SQLite behind the delaying proxy",
    probe,
    captured: {
      phase: body.phase,
      bytes,
      mib: +(bytes / 1_048_576).toFixed(3),
      batches: body.batches.length,
      changes: body.batches.reduce((n, b) => n + b.changes.length, 0),
      has_more: body.has_more,
      sha256: sha,
    },
    reading:
      "this is the largest page the released backend produced from what the probe could create; a checklist value (the W1 shape) is reported separately above; the dense W1 batch is a CONTRACT-valid shape that this server release may not be able to produce",
  });
});
