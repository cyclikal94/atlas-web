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
 *   P-4   the first non-coalesced `data.sync_tick` after the sample's start, the first commit after it, the step end after that, and the ONE
 *         `/sync` request inside [tick, commit] (1 ms trace rounding), read in ONE evaluation (`readSyncSample`, `syncSample`); a latency
 *         sample does not require a written page (the commit's value is recorded, not judged).
 *
 * The page functions run IN THE PAGE (Playwright serialises them): they refer to nothing outside their own bodies.
 */
import {
  pageCommitted,
  traceEvent,
  tracePayload,
} from "../../scripts/lib/profile-outcome-rules.mjs";

export const P2_SAMPLE_METHOD = "p2-sample/1";
export const SYNC_SAMPLE_METHOD = "sync-request-sample/1";
/** The trace's own millisecond rounding (`Math.round(performance.now())`): a resource time may lie up to this far outside its line. */
export const TRACE_ROUNDING_MS = 1;

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

/** One sync request sample, read in ONE page evaluation once its step has ended. */
export interface SyncSampleRead {
  lines: Array<{ trace: number; line: string }>;
  resources: Array<{
    startTime: number;
    requestStart: number;
    responseEnd: number;
  }>;
}

/** In the page: the sample's trace lines and `/sync` entries once a step end follows a commit after `from` (else null). */
export function readSyncSample(from: number): SyncSampleRead | null {
  const trace =
    (window as unknown as { __atlasData?: { engineTrace: string[] } })
      .__atlasData?.engineTrace ?? [];
  let commit = false;
  let ended = false;
  for (let t = from; t < trace.length && !ended; t += 1) {
    const name = (trace[t] ?? "").split(" ")[1];
    if (name === "data.sync_commit") commit = true;
    else if (
      commit &&
      (name === "data.sync_next" || name === "data.sync_step_failed")
    )
      ended = true;
  }
  if (!ended) return null;
  return {
    lines: trace.slice(from).map((line, i) => ({ trace: from + i, line })),
    resources: (
      performance.getEntriesByType("resource") as PerformanceResourceTiming[]
    )
      .filter((e) => new URL(e.name).pathname.endsWith("/sync"))
      .map((e) => ({
        startTime: e.startTime,
        requestStart: e.requestStart,
        responseEnd: e.responseEnd,
      })),
  };
}

export interface SyncSupport {
  tick: { trace: number; line: string };
  commit: { trace: number; line: string };
  end: { trace: number; line: string };
  request: SyncSampleRead["resources"][number];
  sync_entries: number;
}

const msOf = (line: string) =>
  Number(/^(-?\d+)ms /.exec(line)?.[1] ?? Number.NaN);

/** The sample's one operation, or the reason it is not one. */
export function syncSample(read: SyncSampleRead): {
  support: SyncSupport | null;
  problem: string | null;
} {
  const tick = read.lines.find(
    (l) =>
      traceEvent(l.line) === "data.sync_tick" &&
      tracePayload(l.line)?.coalesced === false,
  );
  if (!tick)
    return { support: null, problem: "no step started after the sample began" };
  const commit = read.lines.find(
    (l) => l.trace > tick.trace && traceEvent(l.line) === "data.sync_commit",
  );
  if (!commit) return { support: null, problem: "the step committed nothing" };
  const end = read.lines.find(
    (l) =>
      l.trace > commit.trace &&
      ["data.sync_next", "data.sync_step_failed"].includes(
        String(traceEvent(l.line)),
      ),
  );
  if (!end) return { support: null, problem: "the step's end is not traced" };
  const from = msOf(tick.line) - TRACE_ROUNDING_MS;
  const to = msOf(commit.line) + TRACE_ROUNDING_MS;
  const inside = read.resources.filter(
    (r) => r.startTime >= from && r.responseEnd <= to,
  );
  const request = inside[0];
  if (inside.length !== 1 || !request)
    return {
      support: null,
      problem: `${inside.length} /sync requests lie between the step's start and its commit (${read.resources.length} since the sample began)`,
    };
  return {
    support: {
      tick: { trace: tick.trace, line: tick.line },
      commit: { trace: commit.trace, line: commit.line },
      end: { trace: end.trace, line: end.line },
      request,
      sync_entries: read.resources.length,
    },
    problem: null,
  };
}

/** The P-4 segments of one operation (trace times are the engine's own, rounded to 1 ms). */
export function syncSegments(support: SyncSupport) {
  const tick = msOf(support.tick.line);
  const commit = msOf(support.commit.line);
  const r = support.request;
  return {
    pre_issue_ms: r.requestStart - tick,
    request_ms: r.responseEnd - r.requestStart,
    post_response_ms: commit - r.responseEnd,
    total_ms: commit - tick,
    duration_ms: r.responseEnd - r.startTime,
  };
}
