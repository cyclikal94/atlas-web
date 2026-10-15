/**
 * The operation each timed sample belongs to (WEB-09c revision 12; review 12, design assessment DA-M1/DA-M2; family
 * profiling-evidence-completeness). Shared by the P-2 writer (fixture.profile-sync.spec.ts), the P-4/P-10 sync writers
 * (integration.profile-sync.spec.ts) and their deterministic tests (tests/profiling/profile-samples.test.ts).
 *
 * Revision 11's P-2 waited for ANY commit and idle, then took the LAST commit of a later read: after a lapsed hold the engine's retry of an
 * empty page supplied the sample's scan and commit times. Its P-4/P-10 took the first tick and commit of one read and the LATEST `/sync`
 * ResourceTiming entry of another, so a second request before or between them paired two operations. Here a sample is one operation:
 *
 *   P-2   the first commit at or after the sample's trace start and the first step end after it; the commit must be of the sample's served
 *         bytes, applied AND committed, and the end `data.sync_next` recording idle (`p2SampleProblems`), else the sample fails;
 *   P-4   (revision 13, review 13 R2, design assessment DA-R2-A/DA-R2-B/DA-N1) a sync sample is the FIRST real step after a mark that one
 *         page call set and triggered while no step was open, closed by that step's own end; a draft sample is the first send after the
 *         enqueue and the first answer after it. Each sample keeps its whole bounded witness (page and engine identity, the contiguous trace
 *         slice, every request entry) and the selection is derived from it by the pure rules of scripts/lib/profile-sample-rules.mjs, which
 *         the evidence contract applies again. Revision 12's `readSyncSample`/`syncSample` took the first real tick, the first commit
 *         anywhere after it and an end after that: an earlier step that ended without a request donated its start to a later request.
 *
 * The page functions run IN THE PAGE (Playwright serialises them): they refer to nothing outside their own bodies.
 */
import {
  pageCommitted,
  traceEvent,
  tracePayload,
} from "../../scripts/lib/profile-outcome-rules.mjs";
import {
  DRAFT_WITNESS_METHOD,
  type DraftSelected,
  type DraftValues,
  draftWitnessSelection,
  type RequestEntry,
  SYNC_WITNESS_METHOD,
  type SyncSelected,
  type SyncValues,
  syncWitnessSelection,
} from "../../scripts/lib/profile-sample-rules.mjs";

export const P2_SAMPLE_METHOD = "p2-sample/1";
export const SYNC_SAMPLE_METHOD = SYNC_WITNESS_METHOD;
export const DRAFT_SAMPLE_METHOD = DRAFT_WITNESS_METHOD;

/** One recorded P-2 sample's operation: its index (warm-ups included), its trace start, its commit and its step end (trace positions). */
export interface P2Sample {
  index: number;
  from: number;
  commit: number;
  end: number;
  bytes: number;
}
export interface P2Support {
  commit: { trace: number; line: string };
  end: { trace: number; line: string };
}

/** In the page: the sample's first commit at or after `from` and the first step end after it, once that end is traced (else null). */
export function selectP2Sample(from: number): P2Support | null {
  const trace =
    (window as unknown as { __atlasData?: { engineTrace: string[] } })
      .__atlasData?.engineTrace ?? [];
  let commit = -1;
  for (let t = from; t < trace.length; t += 1) {
    const name = (trace[t] ?? "").split(" ")[1];
    if (commit < 0) {
      if (name === "data.sync_commit") commit = t;
      continue;
    }
    if (name === "data.sync_next" || name === "data.sync_step_failed")
      return {
        commit: { trace: commit, line: trace[commit] ?? "" },
        end: { trace: t, line: trace[t] ?? "" },
      };
  }
  return null;
}

/** Why the selected operation is not a sample of a written page of `bytes` ending idle (empty: it is one). */
export function p2SampleProblems(support: P2Support, bytes: number): string[] {
  const commit = tracePayload(support.commit.line);
  const problems: string[] = [];
  if (!pageCommitted(commit))
    problems.push(
      `its commit wrote no page (${String(commit?.kind)}/${String(commit?.value ?? "no value")})`,
    );
  if (commit?.bytes !== bytes)
    problems.push(
      `its commit is ${String(commit?.bytes)} bytes, not the served ${bytes}`,
    );
  for (const key of ["scan_ms", "commit_ms"])
    if (typeof commit?.[key] !== "number")
      problems.push(`its commit records no ${key}`);
  if (
    traceEvent(support.end.line) !== "data.sync_next" ||
    tracePayload(support.end.line)?.state !== "idle"
  )
    problems.push(`its step did not end idle (${support.end.line})`);
  return problems;
}

// ---- P-4/P-10: one request per sample, with its bounded witness (revision 13) ---------------------------------------------------------

/** What one page call established before it triggered the sample's step. */
export interface SyncMark {
  page: string;
  time_origin: number;
  /** How many engine starts the page had recorded (`engineEpochs.length`); the current one's generation. */
  epochs: number;
  generation: number | null;
  /** The trace position of the first line the sample may own. */
  from: number;
  at: number;
}
/** What the observation read, in the same evaluation as the lines and entries it returns. */
export interface SampleRead {
  page: string | null;
  time_origin: number;
  /** The engine starts recorded since the mark (none, for a valid sample) and the current generation. */
  epochs: unknown[];
  generation: number | null;
  /** The exclusive end of the trace slice. */
  to: number;
  at: number;
  /** Every ResourceTiming entry in the buffer (any type): at the buffer's limit the browser drops new ones. */
  resource_entries: number;
}
export interface SyncWitness {
  mark: SyncMark;
  read: SampleRead;
  /** The engine trace from the mark to the read, contiguous (position `mark.from + i`). */
  lines: string[];
  /** Every `/sync` ResourceTiming entry in the buffer at the read. */
  resources: RequestEntry[];
}
export type SyncSampleEntry = { index: number } & SyncWitness & {
    selected: SyncSelected;
  };

/**
 * In the page: while a real step is open (the last real-step line is a non-coalesced tick), null: polled again, nothing triggered.
 * Otherwise, in this one synchronous call, clears ResourceTiming, records the mark and nudges the engine once.
 */
export function prepareSyncSample(_?: unknown): SyncMark | null {
  const data = window.__atlasData;
  if (!data) return null;
  const trace = data.engineTrace;
  for (let t = trace.length - 1; t >= 0; t -= 1) {
    const line = trace[t] ?? "";
    const name = line.split(" ")[1];
    if (name === "data.sync_next" || name === "data.sync_step_failed") break;
    if (name === "data.sync_tick" && line.includes('"coalesced":false'))
      return null;
  }
  performance.clearResourceTimings();
  const mark = {
    page: data.page,
    time_origin: performance.timeOrigin,
    epochs: data.engineEpochs.length,
    generation: data.engineEpochs.at(-1)?.generation ?? null,
    from: trace.length,
    at: performance.now(),
  };
  data.nudgeSync();
  return mark;
}

/**
 * In the page: the sample's witness once the first real step after the mark has ended (and, if it committed, once a `/sync` entry that
 * began with it is visible), at once on a page or engine change or a contradiction, or whenever `force` is set (the time-out). Else null.
 * The page, the engine starts, the trace slice and the entries are copied together, in this one evaluation.
 */
export function readSyncSample(arg: {
  mark: SyncMark;
  force: boolean;
}): SyncWitness | null {
  const { mark } = arg;
  const data = window.__atlasData;
  const trace = data?.engineTrace ?? [];
  const epochs = data?.engineEpochs ?? [];
  const entries = performance.getEntriesByType(
    "resource",
  ) as PerformanceResourceTiming[];
  const sync = entries.filter((e) =>
    new URL(e.name).pathname.endsWith("/sync"),
  );
  let ready =
    arg.force ||
    !data ||
    data.page !== mark.page ||
    performance.timeOrigin !== mark.time_origin ||
    epochs.length !== mark.epochs ||
    trace.length < mark.from;
  let tick = Number.NaN;
  let committed = false;
  for (let t = mark.from; !ready && t < trace.length; t += 1) {
    const line = trace[t] ?? "";
    const name = line.split(" ")[1];
    const real =
      name === "data.sync_tick" && line.includes('"coalesced":false');
    const end = name === "data.sync_next" || name === "data.sync_step_failed";
    if (Number.isNaN(tick)) {
      if (real) tick = Number(/^(-?\d+)ms /.exec(line)?.[1]);
      else if (end || name === "data.sync_commit") ready = true;
    } else if (real) ready = true;
    else if (name === "data.sync_commit") committed = true;
    else if (end) {
      ready = !committed || sync.some((e) => e.startTime >= tick - 1);
      if (!ready) return null;
    }
  }
  if (!ready) return null;
  return {
    mark,
    read: {
      page: data?.page ?? null,
      time_origin: performance.timeOrigin,
      epochs: epochs.slice(mark.epochs),
      generation: epochs.at(-1)?.generation ?? null,
      to: trace.length,
      at: performance.now(),
      resource_entries: entries.length,
    },
    lines: trace.slice(mark.from),
    resources: sync.map((e) => ({
      name: new URL(e.name).pathname,
      startTime: e.startTime,
      requestStart: e.requestStart,
      responseEnd: e.responseEnd,
    })),
  };
}

/** The page as the collectors use it: Playwright's `waitForFunction` + `jsonValue` and `evaluate`, or a test's scripted double. */
export interface SamplePage {
  /** Polls `fn` in the page until it returns a value (not null); rejects at the time-out. */
  poll<A, R>(
    fn: (arg: A) => R | null,
    arg: A,
    options: { timeout: number; polling: number },
  ): Promise<R>;
  /** Runs `fn` in the page once. */
  run<A, R>(fn: (arg: A) => R | Promise<R>, arg: A): Promise<R>;
}
export const samplePageOf = (page: {
  waitForFunction: (
    fn: never,
    arg: never,
    options: { timeout: number; polling: number },
  ) => Promise<{ jsonValue(): Promise<unknown> }>;
  evaluate: (fn: never, arg: never) => Promise<unknown>;
}): SamplePage => ({
  poll: async (fn, arg, options) =>
    (await (
      await page.waitForFunction(fn as never, arg as never, options)
    ).jsonValue()) as never,
  run: async (fn, arg) =>
    (await page.evaluate(fn as never, arg as never)) as never,
});

/** The first sample that did not complete: which (warm-ups included), why, and its witness as read (null if none could be read). */
export interface SampleFailure {
  index: number;
  warmup: boolean;
  problem: string;
  witness: unknown;
}
export interface SampleOptions {
  warmup: number;
  samples: number;
  timeout: number;
  polling: number;
}

/**
 * The P-4/P-10 sync collector, shared by the ordinary (P-4, whose request series P-10 reuses) and the throttled (P-10) writers. Every
 * sample, warm-ups included, is one mark, one observation and the rule's selection; the FIRST sample that does not complete stops the
 * collection and is returned as the failure with its witness (never skipped, replaced or retried). Only valid warm-up values are dropped.
 */
export async function collectSyncSamples(
  page: SamplePage,
  o: SampleOptions,
): Promise<{
  samples: SyncSampleEntry[];
  values: SyncValues[];
  failure: SampleFailure | null;
}> {
  const samples: SyncSampleEntry[] = [];
  const values: SyncValues[] = [];
  for (let i = 0; i < o.warmup + o.samples; i += 1) {
    const failed = (problem: string, witness: unknown) => ({
      samples,
      values,
      failure: { index: i, warmup: i < o.warmup, problem, witness },
    });
    let mark: SyncMark;
    try {
      mark = await page.poll(prepareSyncSample, null, o);
    } catch (error) {
      return failed(
        `no mark could be set: a step stayed open (${String(error).slice(0, 200)})`,
        null,
      );
    }
    let witness: SyncWitness;
    try {
      witness = await page.poll(readSyncSample, { mark, force: false }, o);
    } catch {
      try {
        witness = (await page.run(readSyncSample, {
          mark,
          force: true,
        })) as SyncWitness;
      } catch (error) {
        return failed(
          `the sample could not be read (${String(error).slice(0, 200)})`,
          { mark },
        );
      }
    }
    const s = syncWitnessSelection(witness);
    if (s.status !== "complete" || !s.selected || !s.values)
      return failed(
        s.status === "pending"
          ? `${s.problem} within ${o.timeout} ms`
          : String(s.problem),
        witness,
      );
    if (i < o.warmup) continue;
    samples.push({ index: i, ...witness, selected: s.selected });
    values.push(s.values);
  }
  return { samples, values, failure: null };
}

// ---- P-4 draft: one send, its answer and its request per sample (revision 13, DA-N1) ----------------------------------------------------

export interface DraftMark {
  page: string;
  time_origin: number;
  /** The outbox trace position of the first line the sample may own. */
  from: number;
  /** Drafts queued or in flight when the sample began (0: the page call refuses otherwise). */
  waiting: number;
  /** The enqueue's start and end (`performance.now()`). */
  t0: number;
  t1: number;
}
export interface DraftWitness {
  local_id: string | null;
  enqueued: string;
  mark: DraftMark;
  read: SampleRead & { done: number };
  lines: string[];
  resources: RequestEntry[];
  /** The draft's row once its outcome was recorded (`absent` once it is gone); null until read. */
  settled: { local_id: string | null; status: string } | null;
}
export type DraftSampleEntry = { index: number } & DraftWitness & {
    selected: DraftSelected;
  };

/**
 * In the page: while any draft is queued or in flight, null (nothing enqueued). Otherwise clears ResourceTiming, marks the outbox trace and
 * enqueues ONE draft creating `person`, timing the enqueue.
 */
export async function prepareDraftSample(arg: {
  account: string;
  person: string;
  n: number;
}): Promise<Pick<DraftWitness, "local_id" | "enqueued" | "mark"> | null> {
  const data = window.__atlasData;
  if (!data) throw new Error("no data harness");
  const rows = await data.queue(arg.account);
  const waiting = rows.filter(
    (r) => r.status === "queued" || r.status === "in_flight",
  ).length;
  if (waiting > 0) return null;
  performance.clearResourceTimings();
  const from = data.outboxTrace.length;
  const t0 = performance.now();
  const out = await data.enqueue({
    endpoint: "/commands",
    targets: [
      {
        resourceId: arg.person,
        role: "primary",
        basis: "resource",
        versionChecked: false,
        seedIfUntracked: 1,
      },
    ],
    command: {
      commands: [
        { kind: "create_person", id: arg.person, name: `P-4 ${arg.n}` },
      ],
    },
  });
  const t1 = performance.now();
  return {
    local_id: out.localId ?? null,
    enqueued: out.kind,
    mark: {
      page: data.page,
      time_origin: performance.timeOrigin,
      from,
      waiting,
      t0,
      t1,
    },
  };
}

/**
 * In the page: the draft sample's witness once an answer follows the first send after the mark (and a `/commands` entry that began with it
 * is visible), at once on a second send, a failed step, a page change or `force`. Else null. `done` is the observation's own time.
 */
export function readDraftSample(arg: {
  mark: DraftMark;
  force: boolean;
}): Omit<DraftWitness, "local_id" | "enqueued" | "settled"> | null {
  const { mark } = arg;
  const data = window.__atlasData;
  const trace = data?.outboxTrace ?? [];
  const entries = performance.getEntriesByType(
    "resource",
  ) as PerformanceResourceTiming[];
  const commands = entries.filter((e) =>
    new URL(e.name).pathname.endsWith("/commands"),
  );
  let ready =
    arg.force ||
    !data ||
    data.page !== mark.page ||
    performance.timeOrigin !== mark.time_origin ||
    trace.length < mark.from;
  let send = Number.NaN;
  for (let t = mark.from; !ready && t < trace.length; t += 1) {
    const line = trace[t] ?? "";
    const name = line.split(" ")[1];
    if (name === "data.outbox_send") {
      if (!Number.isNaN(send)) ready = true;
      else send = Number(/^(-?\d+)ms /.exec(line)?.[1]);
    } else if (name === "data.outbox_step_failed") ready = true;
    else if (name === "data.outbox_answer") {
      ready =
        Number.isNaN(send) || commands.some((e) => e.startTime >= send - 1);
      if (!ready) return null;
    }
  }
  if (!ready) return null;
  const now = performance.now();
  return {
    mark,
    read: {
      page: data?.page ?? null,
      time_origin: performance.timeOrigin,
      epochs: [],
      generation: null,
      to: trace.length,
      at: now,
      done: now,
      resource_entries: entries.length,
    },
    lines: trace.slice(mark.from),
    resources: commands.map((e) => ({
      name: new URL(e.name).pathname,
      startTime: e.startTime,
      requestStart: e.requestStart,
      responseEnd: e.responseEnd,
    })),
  };
}

/** In the page: the status of the draft's row (`absent` once it is gone). */
export async function draftStatus(arg: {
  account: string;
  localId: string;
}): Promise<string> {
  const data = window.__atlasData;
  if (!data) throw new Error("no data harness");
  const rows = await data.queue(arg.account);
  return rows.find((r) => r.local_id === arg.localId)?.status ?? "absent";
}

const pause = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * The P-4 draft collector (the P-10 unthrottled draft series reuses its request values). Each sample: one page call that waits for an
 * empty queue and enqueues, one observation of the send/answer/request, then the draft's own outcome from the queue (its completion is the
 * recorded outcome, never the answer event alone); the rule's selection. The first incomplete sample stops the collection.
 */
export async function collectDraftSamples(
  page: SamplePage,
  o: SampleOptions & { account: string; person: () => string },
): Promise<{
  samples: DraftSampleEntry[];
  values: DraftValues[];
  failure: SampleFailure | null;
}> {
  const samples: DraftSampleEntry[] = [];
  const values: DraftValues[] = [];
  for (let i = 0; i < o.warmup + o.samples; i += 1) {
    const failed = (problem: string, witness: unknown) => ({
      samples,
      values,
      failure: { index: i, warmup: i < o.warmup, problem, witness },
    });
    let prepared: Awaited<ReturnType<typeof prepareDraftSample>> = null;
    const until = Date.now() + o.timeout;
    try {
      for (;;) {
        prepared = await page.run(prepareDraftSample, {
          account: o.account,
          person: o.person(),
          n: i,
        });
        if (prepared || Date.now() > until) break;
        await pause(o.polling);
      }
    } catch (error) {
      return failed(
        `the draft could not be enqueued (${String(error).slice(0, 200)})`,
        null,
      );
    }
    if (!prepared)
      return failed(
        `another draft was still waiting after ${o.timeout} ms`,
        null,
      );
    let read: Omit<DraftWitness, "local_id" | "enqueued" | "settled">;
    try {
      read = await page.poll(
        readDraftSample,
        { mark: prepared.mark, force: false },
        o,
      );
    } catch {
      try {
        read = (await page.run(readDraftSample, {
          mark: prepared.mark,
          force: true,
        })) as typeof read;
      } catch (error) {
        return failed(
          `the sample could not be read (${String(error).slice(0, 200)})`,
          prepared,
        );
      }
    }
    let status = "unread";
    if (prepared.local_id !== null) {
      const by = Date.now() + o.timeout;
      try {
        for (;;) {
          status = await page.run(draftStatus, {
            account: o.account,
            localId: prepared.local_id,
          });
          if (!["queued", "in_flight"].includes(status) || Date.now() > by)
            break;
          await pause(o.polling);
        }
      } catch (error) {
        status = `unreadable: ${String(error).slice(0, 120)}`;
      }
    }
    const witness: DraftWitness = {
      local_id: prepared.local_id,
      enqueued: prepared.enqueued,
      ...read,
      settled: { local_id: prepared.local_id, status },
    };
    const s = draftWitnessSelection(witness);
    if (s.status !== "complete" || !s.selected || !s.values)
      return failed(
        s.status === "pending"
          ? `${s.problem} within ${o.timeout} ms`
          : String(s.problem),
        witness,
      );
    if (i < o.warmup) continue;
    samples.push({ index: i, ...witness, selected: s.selected });
    values.push(s.values);
  }
  return { samples, values, failure: null };
}
