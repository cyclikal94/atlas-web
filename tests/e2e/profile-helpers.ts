import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import type { Page, TestInfo } from "@playwright/test";
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

/** One row of `measurements.jsonl` (n, min, p50, p95, p99, max) and the raw samples beside it (raw traces are kept). */
export function record(
  name: string,
  engine: string,
  samples: number[],
  extra: Record<string, unknown> = {},
): void {
  const sorted = [...samples].sort((a, b) => a - b);
  const dir = out();
  const at = new Date().toISOString();
  const collected = collectionWindow(at);
  mkdirSync(`${dir}/raw`, { recursive: true });
  const safe = `${name}.${engine}`.replace(/[^A-Za-z0-9._-]/g, "_");
  writeFileSync(
    `${dir}/raw/${safe}.json`,
    `${JSON.stringify({ name, engine, samples, ...extra })}\n`,
  );
  appendFileSync(
    `${dir}/measurements.jsonl`,
    `${JSON.stringify({
      name,
      engine,
      n: samples.length,
      min: +(sorted[0] ?? 0).toFixed(3),
      p50: +quantile(sorted, 0.5).toFixed(3),
      p95: +quantile(sorted, 0.95).toFixed(3),
      p99: +quantile(sorted, 0.99).toFixed(3),
      max: +(sorted.at(-1) ?? 0).toFixed(3),
      at,
      ...extra,
      collection: collected,
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
  const collected = collectionWindow(at);
  mkdirSync(dir, { recursive: true });
  appendFileSync(
    `${dir}/values.jsonl`,
    `${JSON.stringify({ name, engine, at, ...value, collection: collected })}\n`,
  );
}

export const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Resident set of this process's DESCENDANTS in KiB (the browser and its helpers: the worker started them; nothing else is counted). */
export function descendantsRssKb(root = process.pid): number {
  const rows = execFileSync("ps", ["-axo", "pid=,ppid=,rss="], {
    encoding: "utf8",
  })
    .trim()
    .split("\n")
    .map((line) => line.trim().split(/\s+/).map(Number));
  const children = new Map<number, number[]>();
  const rss = new Map<number, number>();
  for (const [pid, ppid, kb] of rows) {
    if (pid === undefined || ppid === undefined || kb === undefined) continue;
    rss.set(pid, kb);
    children.set(ppid, [...(children.get(ppid) ?? []), pid]);
  }
  let total = 0;
  const stack = [...(children.get(root) ?? [])];
  while (stack.length > 0) {
    const pid = stack.pop() as number;
    total += rss.get(pid) ?? 0;
    stack.push(...(children.get(pid) ?? []));
  }
  return total;
}

/** Samples a number every `everyMs` while running; `stop()` returns the samples. */
export function sampler(
  read: () => Promise<number | null> | number | null,
  everyMs = 50,
) {
  const samples: number[] = [];
  let running = true;
  const done = (async () => {
    while (running) {
      try {
        const value = await read();
        if (value !== null) samples.push(value);
      } catch {
        // the page may be busy or closing: a missing sample is a missing sample
      }
      await sleep(everyMs);
    }
  })();
  return {
    async stop() {
      running = false;
      await done;
      return samples;
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
