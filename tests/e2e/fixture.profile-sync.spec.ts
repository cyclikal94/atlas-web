import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import type { Page } from "@playwright/test";
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
import { commitsOf, oneColdRun } from "./profile-cold-run";
import {
  beginCollection,
  descendantsRssKb,
  endCollection,
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
// Each test's collection window (review finding R1): every row carries it, and the collection log records how the test ended.
test.beforeEach(({ browserName: _browserName }, info) => beginCollection(info));
test.afterEach(({ browserName: _browserName }, info) => endCollection(info));

// ATLAS_PROFILE_SAMPLES shortens a DEBUGGING run of this spec; the recorded measurements use the defaults (20 warm-ups, 300 samples).
const QUICK = Number(process.env.ATLAS_PROFILE_SAMPLES ?? 0);
const WARMUP = QUICK > 0 ? 2 : 20;
const SAMPLES = QUICK > 0 ? QUICK : 300;

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
// It runs in the `device` stage, after the integration stage has captured W2 into the same evidence directory: the capture is picked with the
// page's file input, as an operator picks it on a device, and every W2 run reads it back and verifies its SHA-256 (review R3).
test("P-11 (device page): the full /profile-harness protocol on this desktop engine, W2 included, collected and written for the validator", async ({
  context,
}, info) => {
  test.setTimeout(40 * 60_000);
  const engine = engineOf(info);
  const capture = `${PROFILE_OUT}/w2/W2-captured.${engine}.limit-1.json`;
  expect(
    existsSync(capture),
    `the device stage needs the integration stage's W2 capture ${capture}`,
  ).toBe(true);
  const w2 = readFileSync(capture);
  const w2sha256 = createHash("sha256").update(w2).digest("hex");
  const page = await context.newPage();
  await page.goto("/profile-harness");
  await page.setInputFiles("#w2-capture", {
    name: `W2-captured.${engine}.limit-1.json`,
    mimeType: "application/json",
    buffer: w2,
  });
  await expect(page.locator("#profile-status")).toContainText(
    `SHA-256 ${w2sha256}`,
  );
  await page.goto(`/profile-harness?protocol=1&w2sha256=${w2sha256}`);
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
  // The capture route was taken: five cold W2 runs of exactly these bytes.
  const w2Runs = (
    collected.runs as Array<{ workload: string; sha256: string }>
  ).filter((r) => r.workload === "W2");
  expect(w2Runs.map((r) => r.sha256)).toEqual(Array(5).fill(w2sha256));
  mkdirSync(`${PROFILE_OUT}/device-page`, { recursive: true });
  writeFileSync(
    `${PROFILE_OUT}/device-page/results.${engine}.json`,
    `${JSON.stringify(collected, null, 2)}\n`,
  );
  recordValue("P-11 device page", engine, {
    runs: collected.runs.length,
    w2_capture: {
      file: `w2/W2-captured.${engine}.limit-1.json`,
      sha256: w2sha256,
    },
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

// ---- P-5 (dense): draining a queue of dense drafts and one 1 MiB import draft ---------------------------------------------------------
test("P-5 (dense): draining 200 drafts each carrying a dense checklist value, and one draft carrying a 1 MiB import payload, at maxInFlight 1, 20 runs", async ({
  browser,
}, info) => {
  test.setTimeout(30 * 60_000);
  const engine = engineOf(info);
  const drains: number[] = [];
  const perDraft: number[] = [];
  let bytesQueued = 0;
  for (let run = 0; run < (QUICK > 0 ? 2 : 20); run += 1) {
    const context = await browser.newContext({
      baseURL: info.project.use.baseURL,
    });
    try {
      await stubNetwork(context);
      await seedSettled(context);
      const page = await bootSession(context);
      bytesQueued = await page.evaluate(async (account) => {
        const data = window.__atlasData;
        if (!data) throw new Error("no harness");
        await data.startOutbox(account, {
          start: false,
          seedCursor: "cursor-0",
        });
        // WEB-03's dense checklist: 100 items, 40 checked, one-character labels (7,402 bytes of value).
        const checklist = () => {
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
        let bytes = 0;
        const person = crypto.randomUUID();
        for (let i = 0; i < 200; i += 1) {
          const id = crypto.randomUUID();
          const command = {
            commands: [
              {
                kind: "create_field",
                id,
                person_id: person,
                label: "Checklist",
                value: checklist(),
              },
            ],
          };
          bytes += JSON.stringify(command).length;
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
            command,
          });
          if (out.kind !== "queued") throw new Error(`draft ${i}: ${out.kind}`);
        }
        // Incompressible text, as P-Q's import: the engines compress what they store.
        let payloadText = "";
        for (let chunk = 0; chunk < 32; chunk += 1) {
          const random = new Uint8Array(24_576);
          crypto.getRandomValues(random);
          payloadText += btoa(String.fromCharCode(...random));
        }
        const id = crypto.randomUUID();
        const imported = {
          commands: [
            { kind: "create_person", id, name: "import", payload: payloadText },
          ],
        };
        bytes += JSON.stringify(imported).length;
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
          command: imported,
        });
        if (out.kind !== "queued") throw new Error(`import: ${out.kind}`);
        return bytes;
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
          { timeout: 240_000, intervals: [25, 50, 100] },
        )
        .toBe(true);
      const elapsed = Date.now() - started;
      drains.push(elapsed);
      perDraft.push(elapsed / 201);
    } finally {
      await context.close();
    }
  }
  const extra = {
    queue: 201,
    dense_drafts: 200,
    import_drafts: 1,
    bytes_queued: bytesQueued,
    maxInFlight: 1,
    method:
      "wall time from beginOutbox to every draft acknowledged, the command endpoint a stub (includes Playwright's route round trip); every draft was queued through the facade (quota reserve and key rule applied)",
  };
  record("P-5 dense drain_201_ms", engine, drains, extra);
  record("P-5 dense per_draft_ms", engine, perDraft, extra);
});

// ---- P-Q2: the inputs of the quota reserve (WEB-09c plan 4.5) --------------------------------------------------------------------------
/** The origin's storage as the page and (Chromium only) the DevTools protocol report it, after two readings half a second apart agree. */
async function footprint(page: Page, engine: string) {
  const cdp =
    engine === "chromium" ? await page.context().newCDPSession(page) : null;
  const snapshot = async () => {
    const estimate = await page.evaluate(async () => {
      const e = await navigator.storage.estimate();
      return { usage: e.usage ?? null, quota: e.quota ?? null };
    });
    let indexeddb: number | null = null;
    if (cdp) {
      const result = (await cdp.send("Storage.getUsageAndQuota", {
        origin: new URL(page.url()).origin,
      })) as {
        usageBreakdown?: Array<{ storageType: string; usage: number }>;
      };
      indexeddb =
        result.usageBreakdown?.find((b) => b.storageType === "indexeddb")
          ?.usage ?? null;
    }
    return { usage: estimate.usage, quota: estimate.quota, indexeddb };
  };
  let last = await snapshot();
  for (let i = 0; i < 16; i += 1) {
    await sleep(500);
    const next = await snapshot();
    const same = next.usage === last.usage && next.indexeddb === last.indexeddb;
    last = next;
    if (same) break;
  }
  await cdp?.detach();
  return last;
}

test("P-Q2: the quota reserve's inputs: the atlas-auth burst of three pages' stamped requests, each engine's estimate step, and the ledger cost of a reservation", async ({
  context,
}, info) => {
  test.setTimeout(20 * 60_000);
  const engine = engineOf(info);
  await stubNetwork(context);
  // Ordinary requests to `/probe` are HELD until released, so every lease and observation write the pages let out is outstanding at once.
  // After the release nothing is held: requests that were waiting to be issued go straight through.
  const waiting: Array<() => void> = [];
  let held = 0;
  let holding = true;
  await context.route(/\/api\/experimental\/v1\/probe/, async (route) => {
    if (holding) {
      held += 1;
      await new Promise<void>((resolve) => waiting.push(resolve));
    }
    await route
      .fulfill({ status: 200, contentType: "application/json", body: "{}" })
      .catch(() => undefined);
  });
  await seedSettled(context);
  const pages = [
    await bootSession(context),
    await bootSession(context),
    await bootSession(context),
  ];
  const [first] = pages;
  if (!first) throw new Error("no page");

  // (a) The atlas-auth burst: 3 pages x 20 stamped requests in flight together.
  const idle = await footprint(first, engine);
  const inFlight = pages.map((page) =>
    page.evaluate(async (account) => {
      const session = window.__atlasFixture?.session?.booted?.session;
      const identity = session?.identity.get();
      if (!session || !identity) throw new Error("no session");
      const fetchPage = session.api.fetchFor(
        "ordinary",
        account,
        identity.epoch,
      );
      const outcomes = await Promise.all(
        Array.from({ length: 20 }, async () => {
          try {
            const response = await fetchPage(
              new Request(
                new URL("/api/experimental/v1/probe", location.origin),
              ),
            );
            await response.arrayBuffer();
            return "released";
          } catch (error) {
            return (error as { kind?: string }).kind ?? "error";
          }
        }),
      );
      return outcomes;
    }, ACCOUNT),
  );
  // The plateau: as many as the pages let out together (another page's request may wait for this one's to be resolved), unchanged for 2 s.
  let plateau = -1;
  for (let i = 0; i < 60 && plateau !== held; i += 1) {
    plateau = held;
    await sleep(2_000);
  }
  const heldAtOnce = held;
  const burst = await footprint(first, engine);
  holding = false;
  for (const release of waiting.splice(0)) release();
  const outcomes = (await Promise.all(inFlight)).flat();
  const after = await footprint(first, engine);
  const growth = (to: { usage: number | null; indexeddb: number | null }) => ({
    estimate:
      to.usage !== null && idle.usage !== null ? to.usage - idle.usage : null,
    indexeddb_exact:
      to.indexeddb !== null && idle.indexeddb !== null
        ? to.indexeddb - idle.indexeddb
        : null,
  });

  // (b) The estimate's step: incompressible writes of 1 KiB x 2^k into a scratch database of this origin, deleted afterwards.
  const steps = await first.evaluate(async () => {
    const open = () =>
      new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open("atlas-pq2-scratch", 1);
        request.onupgradeneeded = () =>
          request.result.createObjectStore("blobs");
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    const db = await open();
    const usage = async () => {
      let last = (await navigator.storage.estimate()).usage ?? null;
      for (let i = 0; i < 16; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        const next = (await navigator.storage.estimate()).usage ?? null;
        if (next === last) break;
        last = next;
      }
      return last;
    };
    const rows: Array<{
      added_bytes: number;
      total_written: number;
      usage: number | null;
      delta: number | null;
    }> = [];
    let previous = await usage();
    let written = 0;
    for (let k = 0; k <= 14; k += 1) {
      const size = 1024 * 2 ** k;
      const bytes = new Uint8Array(size);
      for (let at = 0; at < size; at += 65_536)
        crypto.getRandomValues(bytes.subarray(at, Math.min(size, at + 65_536)));
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction("blobs", "readwrite");
        tx.objectStore("blobs").put(bytes.buffer, `k${k}`);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
      written += size;
      const now = await usage();
      rows.push({
        added_bytes: size,
        total_written: written,
        usage: now,
        delta: now !== null && previous !== null ? now - previous : null,
      });
      previous = now;
    }
    db.close();
    await new Promise<void>((resolve) => {
      const request = indexedDB.deleteDatabase("atlas-pq2-scratch");
      request.onsuccess = () => resolve();
      request.onerror = () => resolve();
      request.onblocked = () => resolve();
    });
    return rows;
  });
  const firstChange = steps.find((row) => (row.delta ?? 0) > 0);

  // (c) The ledger: what one reservation of the outbox's quota guard costs in the origin, over 100 reservations never settled.
  await first.evaluate(async (account) => {
    const data = window.__atlasData;
    if (!data) throw new Error("no harness");
    await data.startOutbox(account, { start: false, seedCursor: "cursor-0" });
  }, ACCOUNT);
  const ledgerBefore = await footprint(first, engine);
  const verdicts: Record<string, number> = {};
  for (let i = 0; i < 100; i += 1) {
    const verdict = await first.evaluate(
      () => window.__atlasData?.reserveQuota(1024) ?? "no harness",
    );
    verdicts[verdict] = (verdicts[verdict] ?? 0) + 1;
  }
  const ledgerAfter = await footprint(first, engine);

  const burstBytes =
    growth(burst).indexeddb_exact ?? growth(burst).estimate ?? null;
  const step = firstChange?.delta ?? null;
  const recommendation =
    burstBytes === null || step === null
      ? null
      : Math.max(burstBytes * 4, step * 2);
  recordValue("P-Q2 quota reserve inputs", engine, {
    note: "navigator.storage.estimate() is quantised or obfuscated in Firefox and Safari; only Chromium's CDP figure (indexeddb, bytes) is exact. Desktop figures: they do not set the reserve of any device class",
    atlas_auth_burst: {
      pages: 3,
      requests_per_page: 20,
      held_at_once: heldAtOnce,
      held_at_once_reading:
        "the stamped requests the three pages let out together while every answer was held: fewer than 60 means a page's requests waited for another page's (the burst is that of what was out together)",
      outcomes,
      idle,
      during: burst,
      after,
      growth_during: growth(burst),
      growth_after: growth(after),
    },
    estimate_granularity: {
      rows: steps,
      smallest_write_that_moved_the_estimate: firstChange?.added_bytes ?? null,
      estimate_step_bytes: step,
      reading:
        firstChange === undefined
          ? "the estimate did not move for any write up to 16 MiB: an obfuscated or very coarse estimate"
          : "the first write that changed the estimate, and by how much",
    },
    ledger: {
      reservations: 100,
      bytes_each: 1024,
      verdicts,
      growth: {
        estimate:
          ledgerAfter.usage !== null && ledgerBefore.usage !== null
            ? ledgerAfter.usage - ledgerBefore.usage
            : null,
        indexeddb_exact:
          ledgerAfter.indexeddb !== null && ledgerBefore.indexeddb !== null
            ? ledgerAfter.indexeddb - ledgerBefore.indexeddb
            : null,
      },
    },
    derived_desktop_recommendation_bytes: recommendation,
    derivation:
      "max(burst x 4, estimate step x 2): the multipliers are an ENGINEERING MARGIN, not a measurement; reported against quotaReserveBytes (8 MiB), which is NOT changed",
    quota_reserve_bytes_in_use: 8 * 1024 * 1024,
  });
  // The measurement happened: at least one page's twenty requests were out together while held, and every request was then answered.
  expect(heldAtOnce).toBeGreaterThanOrEqual(20);
  expect(outcomes.length).toBe(60);
  expect(steps.length).toBe(15);
});
