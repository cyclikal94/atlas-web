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
 *         enqueue and the first answer after it, and (revision 14, review 14 R2, DA-R14-A/B/C) its completion is the observed dispatcher's
 *         own admitted receipt of that draft, read with the binding checked across every await. Each sample keeps its whole bounded
 *         witness (page, engine or dispatcher identity, the contiguous trace slice, the dispatch records, every request entry) and the
 *         selection is derived from it by the pure rules of scripts/lib/profile-sample-rules.mjs, which the evidence contract applies again. Revision 12's `readSyncSample`/`syncSample` took the first real tick, the first commit
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
  draftBindingChange,
  draftWitnessSelection,
  type RequestEntry,
  SYNC_WITNESS_METHOD,
  type SyncSelected,
  type SyncValues,
  syncWitnessSelection,
} from "../../scripts/lib/profile-sample-rules.mjs";
import type {
  DispatchIdentity,
  DispatchRecord,
} from "../../src/fixture/data-harness/main";

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

// ---- P-4 draft: one send, its answer, its request and its own completion per sample (revision 14; review 14 R2, DA-R14-A/B/C) ---------
//
// Revision 13 froze the send/answer/request at the answer and then polled the queue separately, unfenced: a read that threw became the
// status `unreadable: …`, a replacement page's empty queue `absent`, and a row a later retry acknowledged closed the first attempt; the
// rule accepted every status but queued/in_flight. Production emits `data.outbox_answer` before it awaits the receipt transaction, so the
// answer is not the end of the operation. Here the harness outbox runs with `observeDispatch` (src/fixture/data-harness/dispatch-observer.ts)
// and a sample is: the dispatch identity read before and after the queue read (a change refuses, nothing enqueued) and after the enqueue;
// the timing read, unchanged; then, once the observed dispatcher's receipt for THAT local ID has delivered its result (or anything else is
// recorded), one call that reads the identity, the row through the bound service and the identity again, and copies the outbox trace,
// the dispatch records and the `/commands` entries from the mark to that moment.

/** A dispatch identity as a page function reads it: the harness's, with the page's time origin. */
export type DispatchIdentityRead = DispatchIdentity & { time_origin: number };
export interface DraftMark {
  page: string;
  time_origin: number;
  /** The outbox trace position, and the dispatch record sequence number, of the first line or record the sample may own. */
  from: number;
  log_from: number;
  /** Drafts queued or in flight when the sample began (0: the page call refuses otherwise). */
  waiting: number;
  /** The enqueue's start and end (`performance.now()`). */
  t0: number;
  t1: number;
}
export interface DraftPrepared {
  local_id: string | null;
  account: string;
  enqueue: { kind: string; local_id: string | null };
  identities: {
    before: DispatchIdentityRead;
    queued: DispatchIdentityRead;
    enqueued: DispatchIdentityRead;
  };
  mark: DraftMark;
}
/** The page call refused before anything was enqueued: why, and the identities it read. */
export interface DraftRefused {
  refused: string;
  identities: Partial<DraftPrepared["identities"]>;
}
/** The timing read (revision 13's observation, unchanged in readiness and values): what it saw, where, and its own time `done`. */
export interface DraftTiming {
  identity: DispatchIdentityRead | null;
  to: number;
  log_to: number;
  at: number;
  done: number;
  /** The `/commands` entries it saw. */
  requests: number;
  resource_entries: number;
}
export type DraftRow =
  | { kind: "row"; local_id: string; status: string }
  | { kind: "absent" }
  | { kind: "error"; problem: string };
export interface DraftCompletion {
  identity_before: DispatchIdentityRead | null;
  identity_after: DispatchIdentityRead | null;
  /** The draft's row through the bound service, and how many OTHER drafts were queued or in flight there (-1: not read). */
  row: DraftRow;
  waiting: number;
  at: number;
  to: number;
  log_first: number;
  log_to: number;
  resource_entries: number;
}
export interface DraftClose {
  completion: DraftCompletion;
  /** The outbox trace from the mark to the completion read, contiguous (position `mark.from + i`). */
  lines: string[];
  /** The dispatch records from the mark to the completion read (sequence `mark.log_from + i`). */
  records: DispatchRecord[];
  /** Every `/commands` ResourceTiming entry in the buffer at the completion read. */
  resources: RequestEntry[];
}
export type DraftWitness = DraftPrepared & { timing: DraftTiming } & DraftClose;
export type DraftSampleEntry = { index: number } & DraftWitness & {
    selected: DraftSelected;
  };

/**
 * In the page: the dispatch identity before and after the queue read; while any draft is queued or in flight, null (nothing enqueued); a
 * changed identity, an unreadable queue or an unobserved dispatcher refuses. Otherwise clears ResourceTiming, marks the outbox trace and the
 * dispatch records and enqueues ONE draft creating `person`, timing the enqueue, and reads the identity again.
 */
export async function prepareDraftSample(arg: {
  account: string;
  person: string;
  n: number;
}): Promise<DraftPrepared | DraftRefused | null> {
  const data = window.__atlasData;
  if (!data) throw new Error("no data harness");
  const before = {
    ...data.dispatchIdentity(),
    time_origin: performance.timeOrigin,
  };
  if (!before.observing)
    return {
      refused:
        "the harness outbox's dispatcher is not observed (observeDispatch)",
      identities: { before },
    };
  let rows: Array<{ status: string }>;
  try {
    rows = await data.queue(arg.account);
  } catch (error) {
    return {
      refused: `the queue could not be read: ${String(error).slice(0, 200)}`,
      identities: { before },
    };
  }
  const queued = {
    ...data.dispatchIdentity(),
    time_origin: performance.timeOrigin,
  };
  if (JSON.stringify(queued) !== JSON.stringify(before))
    return {
      refused:
        "the dispatch binding changed during the queue read: nothing was enqueued",
      identities: { before, queued },
    };
  const waiting = rows.filter(
    (r) => r.status === "queued" || r.status === "in_flight",
  ).length;
  if (waiting > 0) return null;
  performance.clearResourceTimings();
  const from = data.outboxTrace.length;
  const logFrom = data.dispatchNext();
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
  const enqueued = {
    ...data.dispatchIdentity(),
    time_origin: performance.timeOrigin,
  };
  return {
    local_id: out.localId ?? null,
    account: arg.account,
    enqueue: { kind: out.kind, local_id: out.localId ?? null },
    identities: { before, queued, enqueued },
    mark: {
      page: data.page,
      time_origin: performance.timeOrigin,
      from,
      log_from: logFrom,
      waiting,
      t0,
      t1,
    },
  };
}

/**
 * In the page: the timing read, once an answer follows the first send after the mark (and a `/commands` entry that began with it is
 * visible), at once on a second send, a failed step, a page change or `force`. Else null. `done` is the observation's own time.
 */
export function readDraftSample(arg: {
  mark: DraftMark;
  force: boolean;
}): DraftTiming | null {
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
    identity: data
      ? { ...data.dispatchIdentity(), time_origin: performance.timeOrigin }
      : null,
    to: trace.length,
    log_to: data?.dispatchNext() ?? 0,
    at: now,
    done: now,
    requests: commands.length,
    resource_entries: entries.length,
  };
}

/**
 * In the page: true once the sample can be closed: the observed dispatcher's receipt of `local_id` has delivered its result, or anything
 * the sample cannot contain has happened (an identity change, a trimmed log, a failed or non-receipt commit, a writer run, a lifecycle
 * record, a request error, another draft's record, a further send, answer or failed step). Else null (still running).
 */
export function draftCompletionReady(arg: {
  mark: DraftMark;
  local_id: string;
  expected: DispatchIdentityRead;
}): true | null {
  const data = window.__atlasData;
  if (!data) return true;
  const now = {
    ...data.dispatchIdentity(),
    time_origin: performance.timeOrigin,
  };
  if (JSON.stringify(now) !== JSON.stringify(arg.expected)) return true;
  const first = data.dispatchFirst();
  if (first > arg.mark.log_from) return true;
  const log = data.dispatchLog;
  for (let i = arg.mark.log_from - first; i < log.length; i += 1) {
    const r = log[i];
    if (!r) continue;
    const subject = r.event.startsWith("request_") ? r.key : r.local_id;
    if (subject !== arg.local_id) return true;
    if (r.event === "commit_end")
      if (r.plan === "data.admitReceipt" || r.outer !== "applied") return true;
    if (r.event === "request_end" && r.outer !== "response") return true;
    if (
      r.event !== "commit_begin" &&
      r.event !== "commit_end" &&
      r.event !== "commit_gated" &&
      r.event !== "request_begin" &&
      r.event !== "request_end"
    )
      return true;
  }
  const trace = data.outboxTrace;
  let sends = 0;
  let answers = 0;
  for (let t = arg.mark.from; t < trace.length; t += 1) {
    const name = (trace[t] ?? "").split(" ")[1];
    if (name === "data.outbox_step_failed") return true;
    if (name === "data.outbox_send") sends += 1;
    if (name === "data.outbox_answer") answers += 1;
  }
  return sends > 1 || answers > 1 ? true : null;
}

/**
 * In the page: the completion read. The identity, the draft's row through the BOUND service (a rejection is a recorded read failure, never
 * absence), the identity again, then, synchronously, the outbox trace, the dispatch records and the `/commands` entries from the mark.
 */
export async function closeDraftSample(arg: {
  mark: DraftMark;
  local_id: string;
}): Promise<DraftClose> {
  const data = window.__atlasData;
  if (!data) throw new Error("no data harness");
  const identityBefore = {
    ...data.dispatchIdentity(),
    time_origin: performance.timeOrigin,
  };
  let row: DraftRow;
  let waiting = -1;
  try {
    const read = await data.boundDraft(arg.local_id);
    row = read.row
      ? { kind: "row", local_id: read.row.local_id, status: read.row.status }
      : { kind: "absent" };
    waiting = read.waiting;
  } catch (error) {
    row = { kind: "error", problem: String(error).slice(0, 200) };
  }
  const identityAfter = {
    ...data.dispatchIdentity(),
    time_origin: performance.timeOrigin,
  };
  const trace = data.outboxTrace;
  const entries = performance.getEntriesByType(
    "resource",
  ) as PerformanceResourceTiming[];
  const first = data.dispatchFirst();
  return {
    completion: {
      identity_before: identityBefore,
      identity_after: identityAfter,
      row,
      waiting,
      at: performance.now(),
      to: trace.length,
      log_first: first,
      log_to: data.dispatchNext(),
      resource_entries: entries.length,
    },
    lines: trace.slice(arg.mark.from),
    records: data.dispatchLog
      .slice(Math.max(0, arg.mark.log_from - first))
      .map((r) => ({ ...r })),
    resources: entries
      .filter((e) => new URL(e.name).pathname.endsWith("/commands"))
      .map((e) => ({
        name: new URL(e.name).pathname,
        startTime: e.startTime,
        requestStart: e.requestStart,
        responseEnd: e.responseEnd,
      })),
  };
}

const pause = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * The P-4 draft collector (the P-10 unthrottled draft series reuses its request values). Each sample: one page call that waits for an
 * empty queue and enqueues (refusing on a changed binding), the timing read of the send/answer/request, then the completion read once the
 * observed dispatcher's own receipt has delivered its result; the rule's selection. The first incomplete sample stops the collection.
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
    let prepared: DraftPrepared | DraftRefused | null = null;
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
    if ("refused" in prepared) return failed(prepared.refused, prepared);
    // The enqueue awaited: a facade, dispatcher, service or session that changed meanwhile is not the sample's (nothing more is read).
    const moved = draftBindingChange(
      prepared.identities.before,
      prepared.identities.enqueued,
      "after the enqueue",
    );
    if (moved) return failed(moved, prepared);
    const localId = prepared.local_id;
    if (localId === null)
      return failed(
        `the sample's draft was not enqueued (${prepared.enqueue.kind})`,
        prepared,
      );
    let timing: DraftTiming;
    try {
      timing = await page.poll(
        readDraftSample,
        { mark: prepared.mark, force: false },
        o,
      );
    } catch {
      try {
        timing = (await page.run(readDraftSample, {
          mark: prepared.mark,
          force: true,
        })) as DraftTiming;
      } catch (error) {
        return failed(
          `the sample could not be read (${String(error).slice(0, 200)})`,
          prepared,
        );
      }
    }
    try {
      await page.poll(
        draftCompletionReady,
        {
          mark: prepared.mark,
          local_id: localId,
          expected: prepared.identities.enqueued,
        },
        o,
      );
    } catch {
      // The time-out: the completion read below records what stood then (a receipt still running is pending, never complete).
    }
    let closed: DraftClose;
    try {
      closed = await page.run(closeDraftSample, {
        mark: prepared.mark,
        local_id: localId,
      });
    } catch (error) {
      return failed(
        `the sample's completion could not be read (${String(error).slice(0, 200)})`,
        { ...prepared, timing },
      );
    }
    const witness: DraftWitness = { ...prepared, timing, ...closed };
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
