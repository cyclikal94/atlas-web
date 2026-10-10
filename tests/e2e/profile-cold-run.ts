import type { Browser, BrowserContext } from "@playwright/test";
import {
  bootSession,
  seedSettled,
  startLeader,
  stubNetwork,
} from "./data-sync-helpers";
import { browserMemory, cdpHeap, sampler, sleep } from "./profile-helpers";

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
 * by `integration.profile-sync.spec.ts`). Heap is Chromium's only (CDP); RSS is the browser's own processes, attributed per run
 * (`browserMemory`: on macOS WebKit its WebContent, Networking and GPU services too; BROWSER-PROCESS RSS: not device memory, not server
 * RSS).
 *
 * Every attempt returns its record: a context that cannot be set up, a crash or a failed read after a time-out is an `error` run with its
 * detail and whatever was measured before it, never an attempt that vanishes. The context is closed on every path.
 */
export async function oneColdRun(
  browser: Browser,
  baseURL: string | undefined,
  engine: string,
  body: string,
) {
  let context: BrowserContext | null = null;
  const memory = browserMemory();
  let outcome = "error";
  let detail = "";
  let elapsed: number | null = null;
  let requests: number | null = null;
  let heapBaseline: number | null = null;
  let heapPeak: number | null = null;
  let heapAfter: number | null = null;
  let commit: Commit | undefined;
  try {
    context = await browser.newContext({ baseURL });
    const net = await stubNetwork(context);
    await seedSettled(context);
    const page = await bootSession(context);
    const heap = await cdpHeap(page, engine);
    await heap.gc();
    heapBaseline = await heap.used();
    await memory.baseline();
    net.script.push(() => ({ status: 200, body }));
    const heapSampler = sampler(() => heap.used(), 25);
    memory.start(100);
    const started = Date.now();
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
      detail = JSON.stringify(state ?? null).slice(0, 200);
    } catch (error) {
      outcome = "timeout";
      detail = String(error).slice(0, 200);
    }
    elapsed = Date.now() - started;
    const heapSamples = await heapSampler.stop();
    await memory.stop();
    heapPeak = heapSamples.length ? Math.max(...heapSamples) : null;
    await heap.gc();
    heapAfter = await heap.used();
    await sleep(200);
    await memory.after();
    requests = net.requests.length;
    const trace = await page.evaluate(
      () => window.__atlasData?.engineTrace ?? [],
    );
    commit = commitsOf(trace).at(-1);
  } catch (error) {
    // Set-up, a crash, or a read after the outcome failed: recorded as an error run (a time-out keeps its outcome; its detail says more).
    await memory.stop();
    if (outcome !== "timeout") outcome = "error";
    detail = `${detail ? `${detail}; ` : ""}${String(error).slice(0, 200)}`;
  } finally {
    await context?.close().catch(() => undefined);
  }
  const rss = memory.record();
  return {
    outcome,
    detail,
    elapsed_ms: elapsed,
    scan_ms: commit?.scan_ms ?? null,
    commit_ms: commit?.commit_ms ?? null,
    requests,
    heap_baseline_bytes: heapBaseline,
    heap_peak_bytes: heapPeak,
    heap_after_gc_bytes: heapAfter,
    rss_baseline_kib: rss.baseline_kib,
    rss_peak_kib: rss.peak_kib,
    rss_after_kib: rss.after_kib,
    rss,
  };
}
