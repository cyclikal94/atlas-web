/**
 * The outcome of one profiled application of a `/sync` page, observed ONCE (WEB-09c revision 9, review 9 R2).
 *
 * Review 9 found two WebKit cold runs recorded `refused` while their recorded state was `running`: the old helper waited for ANY state
 * other than `running`/`not_started` (the start's own `waiting/cache_not_valid` included, set before the first step), then read the state
 * again in a separate call and called every non-idle answer a refusal. The predicate here is the observation: it reads the fixture
 * harness's log of every published engine state (`window.__atlasData.engineStates`, in publication order, each with its trace position)
 * and the engine's trace in one evaluation, and returns the record the outcome is classified from. Nothing is read again afterwards.
 *
 * The observed operation is the measured request: the first `running` state after the mark (the engine publishes `running` immediately
 * before it calls `fetchFor` for `/sync`, with only synchronous code between, and the stub answers that first request with the measured
 * body). Its outcome is the state the engine showed when the first step after it ENDED in something other than `running` (a page with
 * `has_more` asks again at once and is followed): the `data.sync_next` trace line carries the state the step ended in, and the log entry
 * published before that line must be the same state. A step that threw (`data.sync_step_failed`) ends in the stop the engine publishes
 * next. The commits are the engine's own `data.sync_commit` entries from the request to that end; the first is the measured page's.
 *
 * `observeColdOutcome` runs IN THE PAGE (Playwright serialises it): it must not refer to anything outside its own body.
 */

/** The state kinds that are the engine's verdict that a page was not applied (the device-page protocol's set, `profile-page.ts`). */
export const REFUSED_STATES = ["stopped", "backing_off", "paused"] as const;
export const OBSERVATION_METHOD = "engine-state-log/1";

export interface ObservedState {
  kind: string;
  reason?: string;
  cause?: string;
  [key: string]: unknown;
}
export interface ObservedCommit {
  bytes?: number;
  scan_ms?: number;
  commit_ms?: number;
  kind?: string;
  [key: string]: unknown;
}
export interface ColdObservation {
  method: typeof OBSERVATION_METHOD;
  /** The engine (`startSync` count in the page) whose request was observed. */
  run: number;
  /** The first `running` state after the mark: the measured request's step. `index` is in the log after the mark. */
  request: { index: number; at: number; trace: number };
  /** The state the step ended in, as it was published. */
  terminal: { index: number; at: number; trace: number; state: ObservedState };
  /** The trace line that ended that step; `recorded` is the state kind it carries (`data.sync_next`), or null after a step failure. */
  step_end: { trace: number; event: string; recorded: string | null };
  /** Every state published after the mark up to the terminal one (kind, and its reason or cause), at most 40. */
  states: string[];
  /** `data.sync_commit` entries between the request and the step end, in order; the first is the measured page's. */
  commits: ObservedCommit[];
}

export interface ObservationMark {
  states: number;
  trace: number;
}

/** In the page: the observation once the measured request's step has ended, or null (Playwright polls again). */
export function observeColdOutcome(
  mark: ObservationMark,
): ColdObservation | null {
  const data = (
    window as unknown as {
      __atlasData?: {
        engineStates: Array<{
          run: number;
          at: number;
          trace: number;
          state: ObservedState;
        }>;
        engineTrace: string[];
      };
    }
  ).__atlasData;
  if (!data) return null;
  const states = data.engineStates.slice(mark.states);
  const trace = data.engineTrace;
  const begin = states.findIndex((e) => e.state.kind === "running");
  if (begin < 0) return null;
  const request = states[begin];
  if (!request || request.trace < mark.trace) return null;
  const label = (s: ObservedState): string =>
    s.kind +
    (typeof s.reason === "string" ? `/${s.reason}` : "") +
    (typeof s.cause === "string" ? `/${s.cause}` : "");
  const payload = (line: string): Record<string, unknown> | null => {
    const at = line.indexOf("{");
    if (at < 0) return null;
    try {
      return JSON.parse(line.slice(at)) as Record<string, unknown>;
    } catch {
      return null;
    }
  };
  for (let t = request.trace; t < trace.length; t += 1) {
    const line = trace[t] ?? "";
    const failed = line.includes(" data.sync_step_failed");
    const next = line.includes(" data.sync_next ");
    if (!failed && !next) continue;
    const recorded = next ? payload(line)?.state : null;
    // A page with has_more: the engine asks again at once; the operation continues.
    if (recorded === "running") continue;
    let end = -1;
    for (let i = begin; i < states.length; i += 1) {
      const entry = states[i];
      if (!entry || entry.run !== request.run) continue;
      // After a failed step the engine publishes its stop after the trace line; otherwise the step's state was published before it.
      if (failed ? entry.trace > t : entry.trace <= t) {
        end = i;
        if (failed) break;
      }
    }
    // A failed step's stop is not published yet: polled again. (Otherwise the request's own entry precedes the line, so `end` is set; a
    // step that ended while `running` is still showing is returned as it is, and classified as the contradiction it is.)
    if (end < 0) return null;
    const terminal = states[end];
    if (!terminal) return null;
    const commits: ObservedCommit[] = [];
    for (let c = request.trace; c < t; c += 1) {
      const commitLine = trace[c] ?? "";
      if (commitLine.includes(" data.sync_commit"))
        commits.push((payload(commitLine) ?? {}) as ObservedCommit);
    }
    return {
      method: "engine-state-log/1",
      run: request.run,
      request: { index: begin, at: request.at, trace: request.trace },
      terminal: {
        index: end,
        at: terminal.at,
        trace: terminal.trace,
        state: terminal.state,
      },
      step_end: {
        trace: t,
        event: failed ? "data.sync_step_failed" : "data.sync_next",
        recorded: typeof recorded === "string" ? recorded : null,
      },
      states: states.slice(0, Math.min(end + 1, 40)).map((e) => label(e.state)),
      commits,
    };
  }
  return null;
}

/** What the page served for the measured request, as the test (not the page) knows it. */
export interface Served {
  /** The measured body's byte length. */
  bytes: number;
  /** `/sync` requests the stub answered by the time of classification. */
  requests: number;
}

export interface ColdOutcome {
  outcome: "admitted" | "refused" | "error";
  /** The terminal state as observed (JSON, at most 200 characters), with any problem first. */
  detail: string;
  /** Why the observation is not a verdict on the page; empty for `admitted` and `refused`. */
  problems: string[];
}

/** The problems of an observation as evidence of one verdict on the served page; the contract applies the same rules to the record. */
export function observationProblems(
  observation: ColdObservation,
  served: Served,
): string[] {
  const problems: string[] = [];
  const state = observation.terminal.state;
  if (observation.method !== OBSERVATION_METHOD)
    problems.push(`observation method ${String(observation.method)}`);
  if (observation.terminal.index < observation.request.index)
    problems.push("the terminal state precedes the request");
  if (state.kind === "running" || state.kind === "not_started")
    problems.push(`the step ended in ${state.kind}`);
  if (
    observation.step_end.event === "data.sync_next" &&
    observation.step_end.recorded !== state.kind
  )
    problems.push(
      `the step's end records ${String(observation.step_end.recorded)}, but ${state.kind} was published`,
    );
  if (!(served.requests >= 1))
    problems.push("no /sync request reached the stub");
  const first = observation.commits[0];
  if (first?.bytes !== undefined && first.bytes !== served.bytes)
    problems.push(
      `the first commit after the request is ${first.bytes} bytes, not the served ${served.bytes}`,
    );
  if (state.kind === "idle" && first?.kind !== "applied")
    problems.push("idle without the served page's applied commit");
  if (state.kind === "waiting" && state.reason !== "cache_not_valid")
    problems.push(
      `the step ended waiting (${String(state.reason)}): not a verdict on the page`,
    );
  return problems;
}

/** The outcome an observation shows; a contradictory or non-terminal observation is an `error`, never a refusal. */
export function classifyColdOutcome(
  observation: ColdObservation,
  served: Served,
): ColdOutcome {
  const state = observation.terminal.state;
  const shown = JSON.stringify(state).slice(0, 200);
  const problems = observationProblems(observation, served);
  if (problems.length)
    return {
      outcome: "error",
      detail: `${problems.join("; ")}; ${shown}`.slice(0, 400),
      problems,
    };
  if (state.kind === "idle")
    return { outcome: "admitted", detail: shown, problems };
  // The engine requires a valid cache again after the request (an admitted invalidation, a page that was not ready): not applied.
  if (
    (REFUSED_STATES as readonly string[]).includes(state.kind) ||
    state.kind === "waiting"
  )
    return { outcome: "refused", detail: shown, problems };
  return {
    outcome: "error",
    detail: `the step ended in ${state.kind}; ${shown}`.slice(0, 400),
    problems: [`the step ended in ${state.kind}`],
  };
}

/** The live W2 observation (one evaluation): the dense commit and the state at that same moment. */
export interface LiveObservation {
  method: "live-dense-commit/1";
  state: ObservedState | null;
  dense: ObservedCommit | null;
  trace: number;
}

/**
 * In the page: the live application's end, or null. Admitted: the dense page (at least 90% of the captured limit-1 bytes) has committed
 * and the engine is idle at the same moment. Refused: the engine stopped. Anything else (a back-off is transient) is waited out.
 */
export function observeLiveOutcome(least: number): LiveObservation | null {
  const data = (
    window as unknown as {
      __atlasData?: {
        engineTrace: string[];
        engineState(): ObservedState | null;
      };
    }
  ).__atlasData;
  if (!data) return null;
  const trace = data.engineTrace;
  const state = data.engineState();
  let dense: ObservedCommit | null = null;
  for (const line of trace) {
    if (!line.includes("data.sync_commit")) continue;
    const at = line.indexOf("{");
    if (at < 0) continue;
    try {
      const commit = JSON.parse(line.slice(at)) as ObservedCommit;
      if ((commit.bytes ?? 0) >= least * 0.9) {
        dense = commit;
        break;
      }
    } catch {
      // not a commit record
    }
  }
  if ((dense && state?.kind === "idle") || state?.kind === "stopped")
    return {
      method: "live-dense-commit/1",
      state,
      dense,
      trace: trace.length,
    };
  return null;
}

/** The live outcome its one observation shows. */
export function classifyLiveOutcome(
  observation: LiveObservation,
): "admitted" | "refused" | "error" {
  if (
    observation.state?.kind === "idle" &&
    observation.dense?.kind === "applied"
  )
    return "admitted";
  if (observation.state?.kind === "stopped") return "refused";
  return "error";
}
