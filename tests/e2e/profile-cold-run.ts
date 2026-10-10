import type { Browser, BrowserContext } from "@playwright/test";
import {
  bootSession,
  seedSettled,
  startLeader,
  stubNetwork,
} from "./data-sync-helpers";
import { cdpHeap, descendantsRssKb, sampler, sleep } from "./profile-helpers";

/** The engine's own `data.sync_commit` trace entries, with the scan and commit times it measured. */
export interface Commit {
  scan_ms?: number;
  commit_ms?: number;
  bytes?: number;
  kind?: string;
}
export const commitsOf = (trace: string[]): Commit[] =>
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

/**
 * One COLD application of a `/sync` page body through the production path (fetchFor, the real stamped wrapper; the scanner; the
 * validator; the page commit) in a new browser context, the network a Playwright route stub that answers the next `/sync` with `body`.
 * Shared by P-11 (the generated workloads, `fixture.profile-sync.spec.ts`) and P-W2 (the bytes the released backend produced, captured
 * by `integration.profile-sync.spec.ts`). Heap is Chromium's only (CDP); RSS is the engine process tree's (BROWSER-PROCESS RSS: not
 * device memory, not server RSS).
 */
export async function oneColdRun(
  browser: Browser,
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
