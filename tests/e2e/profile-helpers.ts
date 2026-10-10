import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import type { Page } from "@playwright/test";

/**
 * Shared by the WEB-09a profiling specs (`fixture.profile-sync.spec.ts`, `integration.profile-sync.spec.ts`). They are MEASUREMENTS, not
 * budgets (plan 7.1): every figure is written with its engine, the number of samples and the method, and none is an acceptance number.
 */
export const PROFILE_OUT = ".agtx/evidence/WEB-09a/profiling";
export const engineOf = (info: { project: { name: string } }) =>
  info.project.name.replace(/^(fixture|integration)-/, "");

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
  mkdirSync(`${PROFILE_OUT}/raw`, { recursive: true });
  const safe = `${name}.${engine}`.replace(/[^A-Za-z0-9._-]/g, "_");
  writeFileSync(
    `${PROFILE_OUT}/raw/${safe}.json`,
    `${JSON.stringify({ name, engine, samples, ...extra })}\n`,
  );
  appendFileSync(
    `${PROFILE_OUT}/measurements.jsonl`,
    `${JSON.stringify({
      name,
      engine,
      n: samples.length,
      min: +(sorted[0] ?? 0).toFixed(3),
      p50: +quantile(sorted, 0.5).toFixed(3),
      p95: +quantile(sorted, 0.95).toFixed(3),
      p99: +quantile(sorted, 0.99).toFixed(3),
      max: +(sorted.at(-1) ?? 0).toFixed(3),
      at: new Date().toISOString(),
      ...extra,
    })}\n`,
  );
}

/** A single value (not a distribution): written to `values.jsonl`. */
export function recordValue(
  name: string,
  engine: string,
  value: Record<string, unknown>,
): void {
  mkdirSync(PROFILE_OUT, { recursive: true });
  appendFileSync(
    `${PROFILE_OUT}/values.jsonl`,
    `${JSON.stringify({ name, engine, at: new Date().toISOString(), ...value })}\n`,
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
