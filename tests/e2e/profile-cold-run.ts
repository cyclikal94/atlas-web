import { createHash } from "node:crypto";
import type { Browser, BrowserContext, Page } from "@playwright/test";
import {
  EFFECTS_METHOD,
  effectsText,
  entriesOfPage,
  entriesOfRows,
  type RecordedEffects,
} from "../../scripts/lib/profile-effects.mjs";
import {
  ACCOUNT,
  bootSession,
  seedSettled,
  startLeader,
  stubNetwork,
} from "./data-sync-helpers";
import {
  type ColdObservation,
  classifyColdOutcome,
  type ObservationMark,
  observationMark,
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

const sha256 = (text: string) =>
  createHash("sha256").update(text, "utf8").digest("hex");

/** What a served body leaves in a new, empty cache (`cache-rows/1`), derived from the served bytes; null for a body that is not a page. */
export function expectedEffectsOf(
  body: string | Buffer,
): { rows: number; entries_sha256: string } | null {
  const { entries } = entriesOfPage(
    typeof body === "string" ? body : body.toString("utf8"),
  );
  return entries
    ? { rows: entries.length, entries_sha256: sha256(effectsText(entries)) }
    : null;
}

/**
 * The cache the run left (revision 12), read after the observation and outside every measured window: the stub serves the measured body
 * once and an empty page to every later request, so nothing but the measured page (and its empty continuation) can have changed it.
 */
async function readEffects(
  page: Page,
): Promise<{ effects: RecordedEffects; cursor: string | null }> {
  const read = await page.evaluate(async (account) => {
    const data = window.__atlasData;
    if (!data) throw new Error("no data harness");
    const rows = (await data.rows(account, "cache")) as Array<{
      id?: unknown;
      version?: unknown;
    }>;
    const sync = (await data.syncState(account)) as { cursor?: unknown } | null;
    return {
      rows: rows.map((row) => ({ id: row.id, version: row.version })),
      cursor: typeof sync?.cursor === "string" ? sync.cursor : null,
    };
  }, ACCOUNT);
  const { entries, problem } = entriesOfRows(read.rows);
  if (!entries) throw new Error(`the cache the run left: ${problem}`);
  return {
    effects: {
      method: EFFECTS_METHOD,
      rows: entries.length,
      entries_sha256: sha256(effectsText(entries)),
    },
    cursor: read.cursor,
  };
}

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
 *
 * Revision 10 (review 10 R2 follow-up): the observation is a witness bound to this page instance and the one engine start after the mark
 * (a reload or a second start while observing is an `error` run, never a verdict), classified by the shared rules against the bytes this
 * function served and the stub's count.
 *
 * Revision 12 (review 12's R2 follow-up; design assessment DA-C1): the witness is `engine-state-log/3` (a measured attempt that wrote
 * nothing and asked again completes it as no verdict), and after every measurement the run reads the cache it left (`effects`, with the
 * sync cursor): an admission requires the measured page committed AND those effects equal to what the served bytes leave in the new,
 * empty database (`expectedEffectsOf`). A failed read of the effects leaves an observation unclassifiable as an admission (an `error`).
 */
export async function oneColdRun(
  browser: Browser,
  baseURL: string | undefined,
  engine: string,
  body: string | Buffer,
  /**
   * FIXTURE FAULT INJECTION for the outcome controls only (revision 12; labelled, never used by the programme): the next n cache
   * reservations of the measured page report their hold already ended (src/fixture/data-harness/main.ts `__fixtureLapseReservations`).
   */
  faults: { lapseReservations?: number } = {},
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
  let effects: RecordedEffects | null = null;
  let effectsError: string | null = null;
  let cursorAfter: string | null = null;
  const expectedEffects = expectedEffectsOf(body);
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
    if (faults.lapseReservations)
      await page.evaluate((n) => {
        (
          globalThis as { __fixtureLapseReservations?: number }
        ).__fixtureLapseReservations = n;
      }, faults.lapseReservations);
    const marked = await page.evaluate(observationMark);
    if (!marked) throw new Error("no data harness on the measured page");
    const mark: ObservationMark = marked;
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
      // A reload or another engine start while observing ends the attempt without a verdict (an error); no end in time is a time-out.
      outcome = String(error).includes("observation identity")
        ? "error"
        : "timeout";
      detail = String(error).slice(0, 200);
    }
    heapSamples = await heapSampler.stop();
    await memory.stop();
    heapPeak = heapSamples.length ? Math.max(...heapSamples) : null;
    await heap.gc();
    heapAfter = await heap.used();
    await sleep(200);
    await memory.after();
    if (observation)
      try {
        const read = await readEffects(page);
        effects = read.effects;
        cursorAfter = read.cursor;
      } catch (error) {
        effectsError = String(error).slice(0, 200);
      }
    requests = net.requests.length;
    if (observation) {
      const classified = classifyColdOutcome(observation, {
        bytes,
        requests,
        effects,
        expectedEffects,
      });
      outcome = classified.outcome;
      // (The detail of a verdict is exactly the observed terminal state; a read failure is reported beside an `error` only.)
      detail =
        effectsError && classified.outcome === "error"
          ? `${classified.detail}; effects not read: ${effectsError}`.slice(
              0,
              400,
            )
          : classified.detail;
      commit = observation.commits[0];
    } else if (outcome === "timeout")
      // (Not after an identity error: the page or engine read now is no longer the observed one.)
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
    // The cache the run left (`cache-rows/1`) and the sync cursor, read after the measurements (null: not read; see `detail`).
    effects,
    cursor_after: cursorAfter,
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
