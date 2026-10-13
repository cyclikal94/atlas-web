import type { Browser, BrowserContext } from "@playwright/test";
import {
  bootSession,
  seedSettled,
  startLeader,
  stubNetwork,
} from "./data-sync-helpers";
import {
  type ColdObservation,
  classifyColdOutcome,
  type ObservationMark,
  observeColdOutcome,
} from "./profile-cold-outcome";
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
 *
 * A `Buffer` body (a captured W2 page, WEB-09c revision 5) is served as exactly those bytes, never re-encoded from text.
 *
 * Revision 9 (review 9 R2): the outcome is ONE observation of the measured request's step (`observeColdOutcome`, returned by the very
 * evaluation that found it, never read again), classified by `classifyColdOutcome`: `admitted` only for the served page's applied commit
 * and idle, `refused` only for the engine's own refusal states, and `error` for anything contradictory or not a verdict on the page (a
 * start's `waiting`, a `running` read, a step that never asked). The run keeps the observation; a time-out keeps the states published so far
 * (diagnostic, not an outcome). The scan and commit figures are the measured page's (the first commit after the request), not the last.
 */
export async function oneColdRun(
  browser: Browser,
  baseURL: string | undefined,
  engine: string,
  body: string | Buffer,
) {
  let context: BrowserContext | null = null;
  const memory = browserMemory();
  let outcome = "error";
  let detail = "";
  let elapsed: number | null = null;
  let requests: number | null = null;
  let heapBaseline: number | null = null;
  let heapSamples: number[] = [];
  let heapPeak: number | null = null;
  let heapAfter: number | null = null;
  let commit: Commit | undefined;
  let observation: ColdObservation | null = null;
  /** Read only after a time-out: what the engine published until then (never an outcome). */
  let published: string[] | null = null;
  const bytes =
    typeof body === "string" ? Buffer.byteLength(body) : body.length;
  try {
    context = await browser.newContext({ baseURL });
    const net = await stubNetwork(context);
    await seedSettled(context);
    const page = await bootSession(context);
    const heap = await cdpHeap(page, engine);
    await heap.gc();
    heapBaseline = await heap.used();
    await memory.baseline();
    // Where this run's states and trace begin (taken before the sampling window opens, so the window is as it was).
    const mark: ObservationMark = await page.evaluate(() => ({
      states: window.__atlasData?.engineStates.length ?? 0,
      trace: window.__atlasData?.engineTrace.length ?? 0,
    }));
    net.script.push(() => ({ status: 200, body }));
    const heapSampler = sampler(() => heap.used(), 25);
    memory.start(100);
    const started = Date.now();
    try {
      await startLeader(page);
      const found = await page.waitForFunction(observeColdOutcome, mark, {
        timeout: 240_000,
        polling: 25,
      });
      elapsed = Date.now() - started;
      observation = (await found.jsonValue()) as ColdObservation;
    } catch (error) {
      elapsed ??= Date.now() - started;
      outcome = "timeout";
      detail = String(error).slice(0, 200);
    }
    heapSamples = await heapSampler.stop();
    await memory.stop();
    heapPeak = heapSamples.length ? Math.max(...heapSamples) : null;
    await heap.gc();
    heapAfter = await heap.used();
    await sleep(200);
    await memory.after();
    requests = net.requests.length;
    if (observation) {
      const classified = classifyColdOutcome(observation, { bytes, requests });
      outcome = classified.outcome;
      detail = classified.detail;
      commit = observation.commits[0];
    } else
      published = await page.evaluate(
        (from) =>
          (window.__atlasData?.engineStates ?? [])
            .slice(from)
            .slice(0, 40)
            .map((e) => JSON.stringify(e.state).slice(0, 120)),
        mark.states,
      );
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
    // The one observation the outcome was classified from (null: none was made; `published` then says what the engine showed).
    observation,
    ...(published ? { published_until_timeout: published } : {}),
    elapsed_ms: elapsed,
    scan_ms: commit?.scan_ms ?? null,
    commit_ms: commit?.commit_ms ?? null,
    requests,
    heap_baseline_bytes: heapBaseline,
    // Every heap sample (Chromium; empty where the engine has none): the peak is the largest of them (revision 3).
    heap_samples_bytes: heapSamples,
    heap_peak_bytes: heapPeak,
    heap_after_gc_bytes: heapAfter,
    rss_baseline_kib: rss.baseline_kib,
    rss_peak_kib: rss.peak_kib,
    rss_after_kib: rss.after_kib,
    rss,
  };
}

/**
 * The runs without a verdict on the page (revision 9, review 9 R2): an `error` (a contradictory or non-terminal observation, or a failed
 * set-up or read) or a `timeout`. The caller fails its stage on them AFTER writing every run, so the evidence is kept and the programme
 * does not continue on unusable observations. `admitted` and `refused` are the engine's verdicts and are reported, not decided, here.
 */
export const unusableRuns = (
  runs: Array<{ outcome: string; detail: string }>,
): string[] =>
  runs.flatMap((run, i) =>
    run.outcome === "admitted" || run.outcome === "refused"
      ? []
      : [`cold run ${i + 1}: ${run.outcome} (${run.detail.slice(0, 160)})`],
  );
