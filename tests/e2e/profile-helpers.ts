import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import type { Page, TestInfo } from "@playwright/test";
import {
  type Inventory,
  sampleBrowserMemoryAsync,
} from "../../scripts/lib/browser-processes.mjs";
import {
  COLLECTION_LOG,
  profileOutFromEnv,
} from "../../scripts/lib/profile-evidence.mjs";

/**
 * Shared by the sync-profiling specs (`fixture.profile-sync.spec.ts`, `fixture.profile-contention.spec.ts`,
 * `integration.profile-sync.spec.ts`; evidence key `WEB-09a:sync-profiling`, owned by WEB-09c). They are MEASUREMENTS, not budgets (plan
 * 7.1): every figure is written with its engine, the number of samples and the method, and none is an acceptance number.
 *
 * The evidence directory is `ATLAS_PROFILE_OUT`, which the drivers set from their required `--evidence` (WEB-09c plan 4.1). There is no
 * default: a profiling run without it fails here, before anything is written. Outside a profiling run the specs skip and nothing is written.
 */
const profileOut = profileOutFromEnv();
export const PROFILE_OUT = profileOut ?? "";
const out = (): string => {
  if (!profileOut)
    throw new Error(
      "no evidence directory: ATLAS_PROFILE_OUT is unset (only a profiling run writes measurements)",
    );
  return profileOut;
};
export const engineOf = (info: { project: { name: string } }) =>
  info.project.name.replace(/^(fixture|integration)-/, "");
/**
 * Which stage and invocation of the programme this spec run belongs to (the drivers set both). Every row, every collection-log line and
 * every file a spec writes directly carries them, so the evidence contract can tell this run's evidence from any other's.
 */
const STAGE = process.env.ATLAS_PROFILE_STAGE ?? null;
const INVOCATION = process.env.ATLAS_PROFILE_INVOCATION ?? null;

/**
 * The collection window of the running test (review finding R1). Every row a test writes carries `collection: { test, from, to }`: from
 * the test's start (its `beforeEach`) to the row's export. That window ENCLOSES the time the row's figures were taken, whatever order a
 * test collects and exports in, so the isolation verdict (scripts/lib/profile-isolation.mjs) is drawn over it and never over the moment of
 * writing. Each profiling spec declares, at its top level, `test.beforeEach(... beginCollection(info))` and
 * `test.afterEach(... endCollection(info))` (a hook declared in this shared module would attach to the first spec only). A row written
 * outside a test is an error.
 */
let collection: { test: string; engine: string; from: string } | null = null;
export function beginCollection(info: TestInfo): void {
  collection = {
    test: info.title,
    engine: engineOf(info),
    from: new Date().toISOString(),
  };
}
/** Closes the window and appends the test to the collection log: its title, engine, window and how it ended. */
export function endCollection(info: TestInfo): void {
  const open = collection;
  collection = null;
  if (!open || !profileOut) return;
  mkdirSync(profileOut, { recursive: true });
  appendFileSync(
    `${profileOut}/${COLLECTION_LOG}`,
    `${JSON.stringify({
      test: open.test,
      engine: open.engine,
      from: open.from,
      to: new Date().toISOString(),
      status: info.status,
      expected_status: info.expectedStatus,
      retry: info.retry,
      stage: STAGE,
      invocation: INVOCATION,
    })}\n`,
  );
}
const collectionWindow = (at: string) => {
  if (!collection)
    throw new Error(
      "a profiling row written outside a collection window: the spec must call beginCollection in a beforeEach",
    );
  return { test: collection.test, from: collection.from, to: at };
};

const quantile = (sorted: number[], p: number) =>
  sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] ??
  Number.NaN;
const sha256 = (text: string) =>
  createHash("sha256").update(text).digest("hex");
/** The fields that identify a row; a caller's `extra` can never replace them (they are written last). */
const identity = (name: string, engine: string, at: string) => ({
  id: `${name}[${engine}]`,
  name,
  engine,
  stage: STAGE,
  invocation: INVOCATION,
  at,
  collection: collectionWindow(at),
});

/**
 * One row of `measurements.jsonl` (n, min, p50, p95, p99, max) and the raw samples beside it, linked by path and SHA-256 (raw traces are
 * kept). A series is recorded once: a second row of the same name and engine is refused, never written beside the first.
 */
export function record(
  name: string,
  engine: string,
  samples: number[],
  extra: Record<string, unknown> = {},
): void {
  const sorted = [...samples].sort((a, b) => a - b);
  const dir = out();
  const at = new Date().toISOString();
  const id = identity(name, engine, at);
  mkdirSync(`${dir}/raw`, { recursive: true });
  const safe = `${name}.${engine}`.replace(/[^A-Za-z0-9._-]/g, "_");
  const raw = `${JSON.stringify({ ...extra, name, engine, samples })}\n`;
  writeFileSync(`${dir}/raw/${safe}.json`, raw, { flag: "wx" });
  appendFileSync(
    `${dir}/measurements.jsonl`,
    `${JSON.stringify({
      ...extra,
      n: samples.length,
      min: +(sorted[0] ?? 0).toFixed(3),
      p50: +quantile(sorted, 0.5).toFixed(3),
      p95: +quantile(sorted, 0.95).toFixed(3),
      p99: +quantile(sorted, 0.99).toFixed(3),
      max: +(sorted.at(-1) ?? 0).toFixed(3),
      raw: `raw/${safe}.json`,
      raw_sha256: sha256(raw),
      ...id,
    })}\n`,
  );
}

/** A single value (not a distribution): written to `values.jsonl`. */
export function recordValue(
  name: string,
  engine: string,
  value: Record<string, unknown>,
): void {
  const dir = out();
  const at = new Date().toISOString();
  mkdirSync(dir, { recursive: true });
  appendFileSync(
    `${dir}/values.jsonl`,
    `${JSON.stringify({ ...value, ...identity(name, engine, at) })}\n`,
  );
}

/**
 * The stamp of a file a spec writes directly (not a row): its stage, its invocation and its collection window so far. The evidence
 * contract judges such a file over its enclosing test's window in the collection log.
 */
export function evidenceStamp(): Record<string, unknown> {
  const at = new Date().toISOString();
  return {
    stage: STAGE,
    invocation: INVOCATION,
    collection: collectionWindow(at),
  };
}

/** A file a spec writes directly, created once (a second write of the same evidence file is refused) and stamped. */
export function writeEvidence(
  relative: string,
  data: Record<string, unknown>,
): void {
  const file = `${out()}/${relative}`;
  mkdirSync(file.slice(0, file.lastIndexOf("/")), { recursive: true });
  writeFileSync(
    file,
    `${JSON.stringify({ ...data, evidence: evidenceStamp() }, null, 2)}\n`,
    { flag: "wx" },
  );
}

export const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Samples a number every `everyMs` while running; `stop()` returns the samples. A read that throws is COUNTED (`failed()`), never
 * silently dropped: a series with failed reads says so.
 */
export function sampler(
  read: () => Promise<number | null> | number | null,
  everyMs = 50,
) {
  const samples: number[] = [];
  let failures = 0;
  let running = true;
  const done = (async () => {
    while (running) {
      try {
        const value = await read();
        if (value !== null) samples.push(value);
      } catch {
        // the page may be busy or closing: the failed read is counted
        failures += 1;
      }
      await sleep(everyMs);
    }
  })();
  return {
    failed: () => failures,
    async stop() {
      running = false;
      await done;
      return samples;
    },
  };
}

/** The attributed browser memory of one run (review R4): what a memory cell of the evidence contract needs. */
export interface BrowserMemory {
  scope: string;
  platform: string;
  webkit_hosts: number;
  baseline_kib: number | null;
  peak_kib: number | null;
  after_kib: number | null;
  samples: number;
  failed_samples: number;
  complete: boolean;
  errors: string[];
  processes_at_peak: Inventory["processes"];
  process_identities: string[];
}

/**
 * The browser's resident memory over one run, attributed to ITS processes (scripts/lib/browser-processes.mjs): the test worker's
 * descendants and, for WebKit on macOS, the services of each WebKit host's launchd PID domain. `baseline()` before the run,
 * `start(everyMs)` while it runs, `stop()` when it ends, `after()` once settled, then `record()`. Every sample that could not attribute
 * every process, or could not be taken, makes the record incomplete; nothing is filled with zero.
 */
export function browserMemory() {
  let baseline: Inventory | null = null;
  let after: Inventory | null = null;
  let peak: Inventory | null = null;
  let samples = 0;
  let failed = 0;
  let scope = "";
  let hosts = 0;
  const errors = new Set<string>();
  const identities = new Set<string>();
  let running = false;
  let loop: Promise<void> = Promise.resolve();
  const take = async (): Promise<Inventory | null> => {
    try {
      const now = await sampleBrowserMemoryAsync(process.pid);
      for (const e of now.errors) errors.add(e);
      for (const p of now.processes) identities.add(`${p.pid}@${p.start}`);
      scope = now.scope;
      hosts = Math.max(hosts, now.webkit_hosts);
      if (!now.complete) failed += 1;
      return now;
    } catch (error) {
      failed += 1;
      errors.add(String(error).slice(0, 160));
      return null;
    }
  };
  return {
    async baseline() {
      baseline = await take();
    },
    start(everyMs = 100) {
      running = true;
      loop = (async () => {
        while (running) {
          const now = await take();
          if (now) {
            samples += 1;
            if (!peak || now.rss_kib > peak.rss_kib) peak = now;
          }
          await sleep(everyMs);
        }
      })();
    },
    async stop() {
      running = false;
      await loop;
    },
    async after() {
      after = await take();
    },
    record(): BrowserMemory {
      return {
        scope,
        platform: process.platform,
        webkit_hosts: hosts,
        baseline_kib: baseline?.rss_kib ?? null,
        peak_kib: peak?.rss_kib ?? null,
        after_kib: after?.rss_kib ?? null,
        samples,
        failed_samples: failed,
        complete: failed === 0 && baseline !== null && samples > 0,
        errors: [...errors].slice(0, 10),
        processes_at_peak: peak?.processes ?? [],
        process_identities: [...identities].sort(),
      };
    },
  };
}

/** Chromium only: the page's JS heap in bytes through the DevTools protocol, or null. */
export async function cdpHeap(
  page: Page,
  engine: string,
): Promise<{ used: () => Promise<number | null>; gc: () => Promise<void> }> {
  if (engine !== "chromium")
    return { used: async () => null, gc: async () => undefined };
  const client = await page.context().newCDPSession(page);
  await client.send("Performance.enable");
  return {
    used: async () => {
      const { metrics } = await client.send("Performance.getMetrics");
      return metrics.find((m) => m.name === "JSHeapUsedSize")?.value ?? null;
    },
    gc: async () => {
      await client.send("HeapProfiler.collectGarbage");
    },
  };
}

export const mib = (bytes: number) => +(bytes / 1_048_576).toFixed(2);
