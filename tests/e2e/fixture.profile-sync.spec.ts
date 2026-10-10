import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import type { BrowserContext, Page } from "@playwright/test";
import {
  allWorkloads,
  denseChecklistPage,
  ordinaryPage,
} from "../../scripts/lib/profile-workloads.mjs";
import {
  ACCOUNT,
  bootSession,
  seedSettled,
  startLeader,
  stubNetwork,
  waitForState,
} from "./data-sync-helpers";
import { expect, test } from "./helpers";
import {
  cdpHeap,
  descendantsRssKb,
  engineOf,
  mib,
  PROFILE_OUT,
  record,
  recordValue,
  sampler,
  sleep,
} from "./profile-helpers";

/**
 * WEB-09a profiling, fixture layer (plan 7.2): P-2, P-3, P-5, P-11 and P-Q in real Chromium, Firefox and WebKit through the production
 * session (so `fetchFor`, the real stamped wrapper, is on the path) with the network stubbed. MEASUREMENTS, not budgets; skipped unless
 * ATLAS_PROFILE=1 (`pnpm profile:sync`, which runs a single worker so nothing else loads the machine). Playwright contexts are
 * ephemeral profiles: `durability: "strict"` is NOT measured against a real on-disk profile, and every durability figure says so.
 * There is no backend behind any of it, so none of it is integration evidence.
 */
test.skip(
  !process.env.ATLAS_PROFILE,
  "not run: measurements are taken by `pnpm profile:sync`",
);
test.describe.configure({ mode: "serial" });

// ATLAS_PROFILE_SAMPLES shortens a DEBUGGING run of this spec; the recorded measurements use the defaults (20 warm-ups, 300 samples).
const QUICK = Number(process.env.ATLAS_PROFILE_SAMPLES ?? 0);
const WARMUP = QUICK > 0 ? 2 : 20;
const SAMPLES = QUICK > 0 ? QUICK : 300;

interface Commit {
  scan_ms?: number;
  commit_ms?: number;
  bytes?: number;
  kind?: string;
}
const commitsOf = (trace: string[]): Commit[] =>
  trace
    .filter((line) => line.includes("data.sync_commit"))
    .map((line) => {
      const at = line.indexOf("{");
      try {
        return at < 0 ? {} : (JSON.parse(line.slice(at)) as Commit);
      } catch {
        return {};
      }
    });

/** Installs a long-task observer (Chromium and some others; the figure is null where the engine has none). */
const observeLongTasks = (page: Page) =>
  page.evaluate(() => {
    const w = window as unknown as { __long: number[] };
    w.__long = [];
    try {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) w.__long.push(entry.duration);
      }).observe({ entryTypes: ["longtask"] });
      return true;
    } catch {
      return false;
    }
  });

// ---- P-2: the cost of a page commit by shape ------------------------------------------------------------------------------------------
interface Shape {
  name: string;
  /** A fresh body for sample `i` (the version rises, so every sample really rewrites the rows). */
  body: (i: number) => string;
  samples: number;
  warmup: number;
}
const SHAPES: Shape[] = [
  ...[100, 200, 400, 800].map((n) => ({
    name: `ordinary-${n}`,
    body: (i: number) => ordinaryPage(n, i),
    samples: SAMPLES,
    warmup: WARMUP,
  })),
  // Dense checklists (100 items each) are 7.6 KB a change: the counts fall as the page grows so a run stays within minutes. The n is recorded.
  {
    name: "dense-100",
    body: () => denseChecklistPage(100),
    samples: 60,
    warmup: 5,
  },
  {
    name: "dense-200",
    body: () => denseChecklistPage(200),
    samples: 40,
    warmup: 5,
  },
  {
    name: "dense-400",
    body: () => denseChecklistPage(400),
    samples: 25,
    warmup: 3,
  },
  {
    name: "dense-800-W1",
    body: () => denseChecklistPage(800),
    samples: 15,
    warmup: 3,
  },
];

test("P-2: the end-to-end cost of applying one page, by shape (fetchFor, scan, commit; the network is a stub)", async ({
  context,
}, info) => {
  test.setTimeout(30 * 60_000);
  const engine = engineOf(info);
  const net = await stubNetwork(context);
  await seedSettled(context);
  const page = await bootSession(context);
  const supportsLong = await observeLongTasks(page);
  await startLeader(page);
  await waitForState(page, "idle");
  for (const shape of SHAPES) {
    if (QUICK > 0) {
      shape.samples = Math.min(shape.samples, QUICK);
      shape.warmup = Math.min(shape.warmup, 2);
    }
    const wall: number[] = [];
    const scan: number[] = [];
    const commit: number[] = [];
    const long: number[] = [];
    let bytes = 0;
    for (let i = 0; i < shape.warmup + shape.samples; i += 1) {
      const body = shape.body(i);
      bytes = new TextEncoder().encode(body).length;
      net.script.push(() => ({ status: 200, body }));
      const before = await page.evaluate(() => {
        const w = window as unknown as { __long: number[] };
        w.__long = [];
        return (window.__atlasData?.engineTrace ?? []).length;
      });
      const started = Date.now();
      await page.evaluate(() => window.__atlasData?.nudgeSync());
      await expect
        .poll(
          () =>
            page.evaluate(
              (n) =>
                (window.__atlasData?.engineTrace ?? [])
                  .slice(n)
                  .some((line) => line.includes("data.sync_commit")) &&
                window.__atlasData?.engineState()?.kind === "idle",
              before,
            ),
          { timeout: 120_000, intervals: [5, 10, 25] },
        )
        .toBe(true);
      const elapsed = Date.now() - started;
      if (i < shape.warmup) continue;
      const trace = await page.evaluate(
        (n) => (window.__atlasData?.engineTrace ?? []).slice(n),
        before,
      );
      const last = commitsOf(trace).at(-1);
      wall.push(elapsed);
      if (last?.scan_ms !== undefined) scan.push(last.scan_ms);
      if (last?.commit_ms !== undefined) commit.push(last.commit_ms);
      long.push(
        await page.evaluate(() =>
          (window as unknown as { __long: number[] }).__long.reduce(
            (a, b) => a + b,
            0,
          ),
        ),
      );
    }
    const extra = {
      shape: shape.name,
      bytes,
      mib: mib(bytes),
      warmup: shape.warmup,
      method:
        "wall = nudge to idle through the stubbed network (includes the stub's own transfer); scan and commit are the engine's own monotonic timings",
    };
    record(`P-2 ${shape.name} wall_ms`, engine, wall, extra);
    record(`P-2 ${shape.name} scan_ms`, engine, scan, extra);
    record(`P-2 ${shape.name} commit_ms`, engine, commit, extra);
    if (supportsLong)
      record(`P-2 ${shape.name} long_task_ms_per_page`, engine, long, extra);
    else
      recordValue(`P-2 ${shape.name} long_task_ms_per_page`, engine, {
        status: "not_run",
        reason: "this engine has no longtask observer",
      });
  }
  // The raw engine trace of the whole run is kept.
  const trace = await page.evaluate(
    () => window.__atlasData?.engineTrace ?? [],
  );
  mkdirSync(`${PROFILE_OUT}/raw`, { recursive: true });
  writeFileSync(`${PROFILE_OUT}/raw/P-2.trace.${engine}.txt`, trace.join("\n"));
});

// ---- P-3: durability ------------------------------------------------------------------------------------------------------------------
test("P-3: `strict` against `default` durability for draft, fence and form_recovery writes (a Playwright profile is ephemeral)", async ({
  context,
}, info) => {
  test.setTimeout(10 * 60_000);
  const engine = engineOf(info);
  await stubNetwork(context);
  await seedSettled(context);
  const page = await bootSession(context);
  await page.evaluate(async (account) => {
    const data = window.__atlasData;
    if (!data) throw new Error("no harness");
    await data.startOutbox(account, { start: false, seedCursor: "cursor-0" });
  }, ACCOUNT);
  for (const kind of ["draft", "fence", "form_recovery"] as const)
    for (const durability of ["strict", "default"] as const) {
      const all = await page.evaluate(
        async ({ a, k, d, n }) =>
          window.__atlasData?.timeWrites(a, k, d, n) ?? [],
        { a: ACCOUNT, k: kind, d: durability, n: WARMUP + SAMPLES },
      );
      record(`P-3 ${kind} ${durability} write_ms`, engine, all.slice(WARMUP), {
        kind,
        durability,
        warmup: WARMUP,
        method:
          "a copy of the production plan with its durability set; the hint is passed through Dexie's `chromeTransactionDurability` option; whether Firefox and WebKit act on it was not determined; in an ephemeral profile the two rows are indistinguishable in every engine",
        caveat:
          "ephemeral Playwright profile: 'strict' is not measured against a real on-disk profile",
      });
    }
});

// ---- P-5: outbox drain ----------------------------------------------------------------------------------------------------------------
test("P-5: draining a 200-entry queue at maxInFlight 1 (the only value D-18 defines), 20 runs", async ({
  browser,
}, info) => {
  test.setTimeout(20 * 60_000);
  const engine = engineOf(info);
  const drains: number[] = [];
  const perDraft: number[] = [];
  for (let run = 0; run < 20; run += 1) {
    const context = await browser.newContext({
      baseURL: info.project.use.baseURL,
    });
    try {
      await stubNetwork(context);
      await seedSettled(context);
      const page = await bootSession(context);
      await page.evaluate(async (account) => {
        const data = window.__atlasData;
        if (!data) throw new Error("no harness");
        await data.startOutbox(account, {
          start: false,
          seedCursor: "cursor-0",
        });
        for (let i = 0; i < 200; i += 1) {
          const id = crypto.randomUUID();
          await data.enqueue({
            endpoint: "/commands",
            targets: [
              {
                resourceId: id,
                role: "primary",
                basis: "resource",
                versionChecked: false,
                seedIfUntracked: 1,
              },
            ],
            command: {
              commands: [{ kind: "create_person", id, name: `P-5 ${i}` }],
            },
          });
        }
      }, ACCOUNT);
      const started = Date.now();
      await page.evaluate(() => window.__atlasData?.beginOutbox());
      await expect
        .poll(
          () =>
            page.evaluate(
              async (a) =>
                (await window.__atlasData?.queue(a))?.every(
                  (d) => d.status === "acknowledged",
                ),
              ACCOUNT,
            ),
          { timeout: 120_000, intervals: [25, 50, 100] },
        )
        .toBe(true);
      const elapsed = Date.now() - started;
      drains.push(elapsed);
      perDraft.push(elapsed / 200);
    } finally {
      await context.close();
    }
  }
  const extra = {
    queue: 200,
    maxInFlight: 1,
    method:
      "wall time from beginOutbox to every draft acknowledged, the command endpoint a stub (includes Playwright's route round trip)",
  };
  record("P-5 drain_200_ms", engine, drains, extra);
  record("P-5 per_draft_ms", engine, perDraft, extra);
  recordValue("P-5 maxInFlight_2_and_3", engine, {
    status: "not_run",
    reason:
      "decision D-18 fixes maxInFlight at 1 and the dispatcher has no other value to measure; the effect of the SYNC leader on a second page's waits is P-7 and P-9 (pnpm profile:contention); the outbox drain's own effect on a second page is not separately measured",
  });
});

// ---- P-11: dense workloads through the REAL wrapper path ------------------------------------------------------------------------------
const VALID = ["W1", "W3", "W4", "W6"];
const COLD_RUNS = QUICK > 0 ? 1 : 5;

async function oneColdRun(
  browser: import("@playwright/test").Browser,
  baseURL: string | undefined,
  engine: string,
  body: string,
) {
  const context: BrowserContext = await browser.newContext({ baseURL });
  try {
    const net = await stubNetwork(context);
    await seedSettled(context);
    const page = await bootSession(context);
    const heap = await cdpHeap(page, engine);
    await heap.gc();
    const baselineHeap = await heap.used();
    const baselineRss = descendantsRssKb();
    net.script.push(() => ({ status: 200, body }));
    const heapSampler = sampler(() => heap.used(), 25);
    const rssSampler = sampler(() => descendantsRssKb(), 100);
    const started = Date.now();
    let outcome = "admitted";
    try {
      await startLeader(page);
      await page.waitForFunction(
        () => {
          const state = window.__atlasData?.engineState();
          return (
            state !== null &&
            state?.kind !== "running" &&
            state?.kind !== "not_started"
          );
        },
        undefined,
        { timeout: 240_000, polling: 25 },
      );
      const state = await page.evaluate(() =>
        window.__atlasData?.engineState(),
      );
      outcome = state?.kind === "idle" ? "admitted" : "refused";
    } catch {
      outcome = "timeout";
    }
    const elapsed = Date.now() - started;
    const heapSamples = await heapSampler.stop();
    const rssSamples = await rssSampler.stop();
    await heap.gc();
    const afterHeap = await heap.used();
    await sleep(200);
    const afterRss = descendantsRssKb();
    const trace = await page.evaluate(
      () => window.__atlasData?.engineTrace ?? [],
    );
    const commit = commitsOf(trace).at(-1);
    return {
      outcome,
      elapsed_ms: elapsed,
      scan_ms: commit?.scan_ms ?? null,
      commit_ms: commit?.commit_ms ?? null,
      requests: net.requests.length,
      heap_baseline_bytes: baselineHeap,
      heap_peak_bytes: heapSamples.length ? Math.max(...heapSamples) : null,
      heap_after_gc_bytes: afterHeap,
      rss_baseline_kib: baselineRss,
      rss_peak_kib: rssSamples.length ? Math.max(...rssSamples) : null,
      rss_after_kib: afterRss,
    };
  } finally {
    await context.close();
  }
}

test("P-11: W1, W3, W4, W6 (five cold runs each) and the W7 negative controls through fetchFor, the scanner and the page commit", async ({
  browser,
}, info) => {
  test.setTimeout(40 * 60_000);
  const engine = engineOf(info);
  const baseURL = info.project.use.baseURL;
  const workloads = allWorkloads().filter(
    (w) => VALID.includes(w.name) || w.name.startsWith("W7-"),
  );
  const rows: Array<Record<string, unknown>> = [];
  for (const workload of workloads) {
    const runs = VALID.includes(workload.name) ? COLD_RUNS : 1;
    const bytes = new TextEncoder().encode(workload.body).length;
    const results = [];
    for (let run = 1; run <= runs; run += 1)
      results.push(await oneColdRun(browser, baseURL, engine, workload.body));
    const expectedOutcome = workload.name.startsWith("W7-")
      ? "refused"
      : "admitted";
    rows.push({
      workload: workload.name,
      bytes,
      mib: mib(bytes),
      expected: expectedOutcome,
      runs: results,
    });
    // A negative control that is ADMITTED, or a valid workload that is not, is a finding, not a pass mark (it is reported, never decided here).
  }
  mkdirSync(`${PROFILE_OUT}/memory`, { recursive: true });
  writeFileSync(
    `${PROFILE_OUT}/memory/P-11.${engine}.json`,
    `${JSON.stringify(
      {
        engine,
        path: "production session (fetchFor, the real stamped wrapper) -> scanner -> validator -> page commit; the network is a Playwright route stub",
        cold: "a new browser context for every run",
        heap:
          engine === "chromium"
            ? "CDP Performance.getMetrics JSHeapUsedSize sampled every 25 ms; baseline and 'after' follow HeapProfiler.collectGarbage"
            : "not available in this engine (null)",
        rss: "resident set of the browser process tree started by the test worker, sampled every 100 ms with ps; includes every renderer and helper of the engine, so it is an upper bound for the tab and is not comparable between engines",
        durability_note: "ephemeral Playwright profile",
        rows,
      },
      null,
      2,
    )}\n`,
  );
  // One summary line per workload for the measurement table.
  for (const row of rows) {
    const runs = row.runs as Array<{
      elapsed_ms: number;
      rss_peak_kib: number | null;
      heap_peak_bytes: number | null;
    }>;
    record(
      `P-11 ${row.workload} elapsed_ms`,
      engine,
      runs.map((r) => r.elapsed_ms),
      { bytes: row.bytes, expected: row.expected },
    );
    const rss = runs
      .map((r) => r.rss_peak_kib)
      .filter((v): v is number => v !== null);
    if (rss.length)
      record(`P-11 ${row.workload} rss_peak_kib`, engine, rss, {
        bytes: row.bytes,
        caveat: "whole process tree of the engine",
      });
    const heap = runs
      .map((r) => r.heap_peak_bytes)
      .filter((v): v is number => v !== null);
    if (heap.length)
      record(`P-11 ${row.workload} heap_peak_bytes`, engine, heap, {
        bytes: row.bytes,
      });
  }
  // W5 is the processing path only: it runs in the device page (`/profile-harness`), covered by the protocol test below.
  recordValue("P-11 W5", engine, {
    status: "measured_in_profile_harness",
    reason:
      "snapshot pages are not ordinary pages; the shared processing path (scan, validate every change) runs in /profile-harness",
  });
  expect(rows.length).toBeGreaterThan(0);
});

// ---- the device page itself, on this desktop: the whole protocol, validated ---------------------------------------------------------------
test("P-11 (device page): the full /profile-harness protocol on this desktop engine, collected and written for the validator", async ({
  context,
}, info) => {
  test.setTimeout(40 * 60_000);
  const engine = engineOf(info);
  const page = await context.newPage();
  await page.goto("/profile-harness?protocol=1");
  const rssSampler = sampler(() => descendantsRssKb(), 200);
  await page.waitForFunction(
    () =>
      document
        .getElementById("profile-status")
        ?.textContent?.includes("Protocol complete") === true,
    undefined,
    { timeout: 35 * 60_000, polling: 500 },
  );
  const rss = await rssSampler.stop();
  const collected = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("atlas-profile-results") ?? "null"),
  );
  expect(collected?.runs?.length).toBeGreaterThan(0);
  mkdirSync(`${PROFILE_OUT}/device-page`, { recursive: true });
  writeFileSync(
    `${PROFILE_OUT}/device-page/results.${engine}.json`,
    `${JSON.stringify(collected, null, 2)}\n`,
  );
  recordValue("P-11 device page", engine, {
    runs: collected.runs.length,
    rss_peak_kib_whole_tree: rss.length ? Math.max(...rss) : null,
  });
});

// ---- P-Q: footprints ------------------------------------------------------------------------------------------------------------------
test("P-Q: the storage footprint of an empty account database, of 200 queued drafts, of a draft carrying a 1 MiB import payload, and of atlas-auth with many fences", async ({
  context,
}, info) => {
  test.setTimeout(10 * 60_000);
  const engine = engineOf(info);
  await stubNetwork(context);
  await seedSettled(context);
  const page = await bootSession(context);
  const usage = async () =>
    page.evaluate(async () => {
      const estimate = await navigator.storage.estimate();
      return { usage: estimate.usage ?? null, quota: estimate.quota ?? null };
    });
  const cdp =
    engine === "chromium" ? await page.context().newCDPSession(page) : null;
  const exact = async () => {
    if (!cdp) return null;
    const result = (await cdp.send("Storage.getUsageAndQuota", {
      origin: new URL(page.url()).origin,
    })) as {
      usage: number;
      usageBreakdown?: Array<{ storageType: string; usage: number }>;
    };
    return (
      result.usageBreakdown?.find((b) => b.storageType === "indexeddb")
        ?.usage ?? null
    );
  };
  // Storage accounting lags the writes (Chromium reports a stale figure for a moment), so every reading waits until two readings half a
  // second apart agree (at most eight seconds).
  const snapshot = async () => ({
    estimate: await usage(),
    indexeddb: await exact(),
  });
  const reading = async () => {
    let last = await snapshot();
    for (let i = 0; i < 16; i += 1) {
      await sleep(500);
      const next = await snapshot();
      const same =
        next.estimate.usage === last.estimate.usage &&
        next.indexeddb === last.indexeddb;
      last = next;
      if (same) break;
    }
    return last;
  };
  const baseline = await reading();
  await page.evaluate(async (account) => {
    const data = window.__atlasData;
    if (!data) throw new Error("no harness");
    await data.startOutbox(account, { start: false, seedCursor: "cursor-0" });
  }, ACCOUNT);
  const empty = await reading();
  await page.evaluate(async () => {
    const data = window.__atlasData;
    if (!data) throw new Error("no harness");
    for (let i = 0; i < 200; i += 1) {
      const id = crypto.randomUUID();
      await data.enqueue({
        endpoint: "/commands",
        targets: [
          {
            resourceId: id,
            role: "primary",
            basis: "resource",
            versionChecked: false,
            seedIfUntracked: 1,
          },
        ],
        command: {
          commands: [{ kind: "create_person", id, name: `P-Q ${i}` }],
        },
        displayPatch: { [id]: { label: `P-Q ${i}` } },
      });
    }
  });
  const withDrafts = await reading();
  // Incompressible text: the engines compress what they store (a run of one character would hide the payload's real footprint).
  const big = await page.evaluate(async () => {
    let payloadText = "";
    for (let chunk = 0; chunk < 32; chunk += 1) {
      const bytes = new Uint8Array(24_576);
      crypto.getRandomValues(bytes);
      payloadText += btoa(String.fromCharCode(...bytes));
    }
    const data = window.__atlasData;
    if (!data) throw new Error("no harness");
    const id = crypto.randomUUID();
    const out = await data.enqueue({
      endpoint: "/commands",
      targets: [
        {
          resourceId: id,
          role: "primary",
          basis: "resource",
          versionChecked: false,
          seedIfUntracked: 1,
        },
      ],
      command: {
        commands: [
          {
            kind: "create_person",
            id,
            name: "P-Q import",
            payload: payloadText,
          },
        ],
      },
    });
    return out.kind;
  });
  const withImport = await reading();
  // atlas-auth: the session record with many fences and leases (steady is the first reading; the worst case is seeded).
  const authBefore = await reading();
  await page.evaluate(async (account) => {
    const harness = window.__atlasFixture?.session;
    if (!harness) throw new Error("no session harness");
    const records = (await harness.readRecords()) as {
      auth_state: Record<string, unknown>;
    };
    const fences: Record<string, unknown[]> = {};
    fences[account] = Array.from({ length: 100 }, (_, i) => ({
      seq: i + 1,
      epoch: 1,
      kind: "operation",
      operation_id: `op-${i}`,
    }));
    const leases: Record<string, unknown> = {};
    for (let i = 0; i < 200; i += 1)
      leases[`lease-${i}`] = {
        account_id: account,
        epoch: 1,
        boot_id: "b",
        created_at: new Date().toISOString(),
        class: "ordinary",
      };
    await harness.seedAuthState({ ...records.auth_state, fences, leases });
  }, ACCOUNT);
  const authWorst = await reading();
  recordValue("P-Q footprints", engine, {
    note: "navigator.storage.estimate() is quantised or obfuscated in Firefox and Safari; only Chromium's CDP figure (indexeddb, bytes) is exact",
    baseline,
    empty_account_database: empty,
    with_200_drafts: withDrafts,
    one_draft_with_1_mib_payload: { outcome: big, ...withImport },
    atlas_auth_steady: authBefore,
    atlas_auth_100_fences_200_leases: authWorst,
    per_draft_bytes_chromium:
      empty.indexeddb !== null && withDrafts.indexeddb !== null
        ? Math.round((withDrafts.indexeddb - empty.indexeddb) / 200)
        : null,
  });
  appendFileSync(`${PROFILE_OUT}/values.jsonl`, "");
});
