/**
 * The outcome of one profiled application of a `/sync` page, observed ONCE (WEB-09c revision 9, review 9 R2), with the evidence that
 * corroborates it (revision 10, review 10's R2 follow-up; design assessment DA-1/DA-2).
 *
 * Review 9 found two WebKit cold runs recorded `refused` while their recorded state was `running`: the old helper waited for ANY state
 * other than `running`/`not_started` (the start's own `waiting/cache_not_valid` included), then read the state again in a separate call
 * and called every non-idle answer a refusal. Revision 9 made the predicate the observation. Review 10 then found its supporting relations
 * optional: a first commit without bytes, a terminal equal to or before the request, a failed step paired with idle, and a live dense
 * commit never compared with the capture or the trace all still classified (and resolved) as verdicts.
 *
 * Revision 10: the page function returns a WITNESS, not a summary. It names the page instance and the one engine start it observed (the
 * harness's `page`, `engineEpochs`, and every state's `generation`; a reload or a second start while observing throws, so no observation
 * survives either), and retains every state published since the mark (structured, never truncated: a long `has_more` schedule keeps all of
 * its publications) and every commit/step-end trace event from the mark to the step's end. The classifier recomputes the request, its end,
 * the terminal state and the commits from that witness with the shared rules (scripts/lib/profile-outcome-rules.mjs), against what the
 * test knows independently: the bytes it served and the stub's request count. The evidence contract applies the same rules to the record.
 *
 * The observed operation is the measured request: the first `running` state after the mark (the engine publishes `running` immediately
 * before it calls `fetchFor` for `/sync`, with only synchronous code between, and the stub answers that first request with the measured
 * body). Its end is the first `data.sync_next` after it that does not record `running` (a `has_more` page is followed), or a
 * `data.sync_step_failed`; the terminal state is the one published before that `data.sync_next`, or the stop published after the failure.
 *
 * Revision 11 (review 11's R2 follow-up; design assessment DA-L1): the live witness's terminal state is corroborated by the step end that
 * completes it. `live-dense-commit/3` retains every publication since the mark and every step event of the epoch before its boundary (raw
 * lines), and the rules derive the end, its publication and the dense commit from that slice and bind it to the trace file of the page.
 *
 * `observeColdOutcome` and `observeLiveOutcome` run IN THE PAGE (Playwright serialises them): they must not refer to anything outside
 * their own bodies.
 */
import {
  COLD_METHOD,
  coldObservationRules,
  LIVE_METHOD,
  liveObservationRules,
  REFUSED_STATES as RULES_REFUSED_STATES,
} from "../../scripts/lib/profile-outcome-rules.mjs";

/** The state kinds that are the engine's verdict that a page was not applied (the device-page protocol's set, `profile-page.ts`). */
export const REFUSED_STATES = RULES_REFUSED_STATES;
export const OBSERVATION_METHOD = COLD_METHOD;
export const LIVE_OBSERVATION_METHOD = LIVE_METHOD;

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
/** One retained publication: its position after the mark, the engine start it belongs to, when, the trace position, the state. */
export interface PublishedState {
  index: number;
  generation: number;
  at: number;
  trace: number;
  state: ObservedState;
}
/** One retained trace event (a commit or a step end) at its trace position, with its JSON payload. */
export interface StepEvent {
  trace: number;
  event: string;
  payload: Record<string, unknown> | null;
}
export interface EngineEpochEntry {
  generation: number;
  run?: number;
  trace: number;
}
/** Where an observation begins: the page instance, and the lengths of its state log and trace and its engine starts so far. */
export interface ObservationMark {
  page: string;
  states: number;
  trace: number;
  generation: number;
}
export interface ColdObservation {
  method: typeof COLD_METHOD;
  page: string;
  mark: ObservationMark;
  /** The engine start whose request was observed; `epochs` are the starts since the mark (exactly that one). */
  generation: number;
  epochs: EngineEpochEntry[];
  /** Every state published since the mark, up to and including the terminal one. */
  published: PublishedState[];
  /** Every commit/step-end trace event from the mark to the step's end, inclusive. */
  events: StepEvent[];
  /** The first `running` published after the mark: the measured request's step. `index` is in `published`. */
  request: { index: number; at: number; trace: number };
  /** The state the step ended in, as it was published. */
  terminal: { index: number; at: number; trace: number; state: ObservedState };
  /** The trace event that ended that step; `recorded` is the state kind it carries (`data.sync_next`), or null after a step failure. */
  step_end: { trace: number; event: string; recorded: string | null };
  /** The commits between the request and the step end, in order; the first is the measured page's. */
  commits: ObservedCommit[];
}

/** The harness fields the observers read (`src/fixture/data-harness/main.ts`). */
interface ObservedHarness {
  page: string;
  engineStates: Array<{
    run: number;
    generation: number;
    at: number;
    trace: number;
    state: ObservedState;
  }>;
  engineEpochs: EngineEpochEntry[];
  engineTrace: string[];
  engineState(): ObservedState | null;
}

/** In the page: where this observation begins (taken before the engine is started). */
export function observationMark(): ObservationMark | null {
  const data = (window as unknown as { __atlasData?: ObservedHarness })
    .__atlasData;
  if (!data) return null;
  return {
    page: data.page,
    states: data.engineStates.length,
    trace: data.engineTrace.length,
    generation: data.engineEpochs.at(-1)?.generation ?? 0,
  };
}

/** In the page: the witness once the measured request's step has ended, or null (Playwright polls again). */
export function observeColdOutcome(
  mark: ObservationMark,
): ColdObservation | null {
  const data = (window as unknown as { __atlasData?: ObservedHarness })
    .__atlasData;
  if (!data) return null;
  // No observation survives a reload or completes with a later engine's states: both end the attempt (an error, never a verdict).
  if (data.page !== mark.page)
    throw new Error(
      "observation identity: the page was replaced (a reload) while observing",
    );
  const epochs = data.engineEpochs
    .filter((e) => e.generation > mark.generation)
    .map((e) => ({ generation: e.generation, run: e.run, trace: e.trace }));
  if (epochs.length > 1)
    throw new Error(
      "observation identity: the engine was started again while observing",
    );
  const epoch = epochs[0];
  if (!epoch) return null;
  const all = data.engineStates.slice(mark.states).map((e, index) => ({
    index,
    generation: e.generation,
    at: e.at,
    trace: e.trace,
    state: e.state,
  }));
  if (all.some((e) => e.generation !== epoch.generation))
    throw new Error(
      "observation identity: another engine published while observing",
    );
  const trace = data.engineTrace;
  const begin = all.findIndex((e) => e.state.kind === "running");
  if (begin < 0) return null;
  const request = all[begin];
  if (!request) return null;
  const payload = (line: string): Record<string, unknown> | null => {
    const at = line.indexOf("{");
    if (at < 0) return null;
    try {
      const value = JSON.parse(line.slice(at)) as unknown;
      return typeof value === "object" &&
        value !== null &&
        !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  };
  const eventOf = (line: string): string | null => {
    const parts = line.split(" ");
    const name = parts[1] ?? "";
    return name === "data.sync_commit" ||
      name === "data.sync_next" ||
      name === "data.sync_step_failed"
      ? name
      : null;
  };
  for (let t = request.trace; t < trace.length; t += 1) {
    const line = trace[t] ?? "";
    const event = eventOf(line);
    if (event !== "data.sync_next" && event !== "data.sync_step_failed")
      continue;
    const failed = event === "data.sync_step_failed";
    const recorded = failed ? null : payload(line)?.state;
    // A page with has_more: the engine asks again at once; the operation continues.
    if (recorded === "running") continue;
    let end = -1;
    for (let i = begin + 1; i < all.length; i += 1) {
      const entry = all[i];
      if (!entry) continue;
      // After a failed step the engine publishes its stop after the trace line; otherwise the step's state was published before it.
      if (failed ? entry.trace > t : entry.trace <= t) {
        end = i;
        if (failed) break;
      }
    }
    // A failed step's stop is not published yet: polled again. A normal end with nothing published since the request is returned with
    // the request itself as its terminal, and the rules refuse it as the contradiction it is.
    if (end < 0) {
      if (failed) return null;
      end = begin;
    }
    const terminal = all[end];
    if (!terminal) return null;
    const events: Array<{
      trace: number;
      event: string;
      payload: Record<string, unknown> | null;
    }> = [];
    for (let c = mark.trace; c <= t; c += 1) {
      const kept = trace[c] ?? "";
      const name = eventOf(kept);
      if (name) events.push({ trace: c, event: name, payload: payload(kept) });
    }
    return {
      method: "engine-state-log/2",
      page: data.page,
      mark,
      generation: epoch.generation,
      epochs,
      published: all.slice(0, end + 1),
      events,
      request: { index: begin, at: request.at, trace: request.trace },
      terminal: {
        index: end,
        at: terminal.at,
        trace: terminal.trace,
        state: terminal.state,
      },
      step_end: {
        trace: t,
        event,
        recorded: typeof recorded === "string" ? recorded : null,
      },
      commits: events
        .filter(
          (e) =>
            e.event === "data.sync_commit" &&
            e.trace >= request.trace &&
            e.trace < t,
        )
        .map((e) => (e.payload ?? {}) as ObservedCommit),
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

/** The problems of an observation as evidence of one verdict on the served page (the shared rules; the contract applies them again). */
export function observationProblems(
  observation: ColdObservation,
  served: Served,
): string[] {
  return coldObservationRules(observation, {
    servedBytes: served.bytes,
    requests: served.requests,
  }).problems;
}

/** The outcome an observation shows; a contradictory, incomplete or non-terminal observation is an `error`, never a refusal. */
export function classifyColdOutcome(
  observation: ColdObservation,
  served: Served,
): ColdOutcome {
  const { shows, problems } = coldObservationRules(observation, {
    servedBytes: served.bytes,
    requests: served.requests,
  });
  const shown = JSON.stringify(observation?.terminal?.state ?? null).slice(
    0,
    200,
  );
  if (problems.length || shows === null) {
    const all = problems.length ? problems : ["the end state is no verdict"];
    return {
      outcome: "error",
      detail: `${all.join("; ")}; ${shown}`.slice(0, 400),
      problems: all,
    };
  }
  return { outcome: shows, detail: shown, problems };
}

/** One retained live step event: its trace position and the raw trace line (the rules parse the event and payload from it). */
export interface LiveStepLine {
  trace: number;
  line: string;
}

/**
 * The live W2 witness (`live-dense-commit/3`, one evaluation). Revision 11 (review 11's R2 follow-up; design assessment DA-L1): the
 * terminal state is corroborated by the step end that completes the observation, so the witness retains that support itself: every state
 * published since the mark and every step event of the epoch before the boundary, as raw lines. `dense`, `step_end` and `state_entry` are
 * claims the shared rules derive again from that slice.
 */
export interface LiveObservation {
  method: typeof LIVE_METHOD;
  page: string;
  mark: ObservationMark;
  generation: number;
  epochs: EngineEpochEntry[];
  /** The trace length when the observation was made: the exclusive end of everything it retains. */
  boundary: number;
  /** Every state published since the mark, up to the observation. */
  published: PublishedState[];
  /** Every commit and step end of the epoch before the boundary, each its raw trace line. */
  events: LiveStepLine[];
  /** The first commit of the epoch of at least 90% of the captured limit-1 bytes, and its trace position; null if none. */
  dense: { trace: number; commit: ObservedCommit } | null;
  /** The step end that completes the observation; `recorded` is the state kind a normal end carries, null after a failed step. */
  step_end: { trace: number; event: string; recorded: string | null };
  /** The publication that step end rests on (a normal end: the last published at or before it; a failed step: the stop after it). */
  state_entry: PublishedState;
}

/**
 * In the page: the live application's end, or null (polled again). The epoch's step ends are walked in order; a normal end rests on the
 * last state published at or before its trace line, a failed step on the first published after it (its stop; until that is published
 * the observation waits). A continuation (running after a `has_more` page, a back-off, a pause, a wait, an idle before the dense page)
 * is waited out. The observation is complete at the first end that is idle with the dense page (the first commit of the epoch of at
 * least 90% of the captured limit-1 bytes) traced before the idle, any stop, or a contradiction (an end recording another state than the
 * one published, a failed step not followed by its stop, an end with no verdict): a completed contradiction is returned, so the rules
 * name it, rather than waited past to a convenient later state. A reload or another start while observing throws (no verdict).
 */
export function observeLiveOutcome(arg: {
  least: number;
  mark: ObservationMark;
}): LiveObservation | null {
  const data = (window as unknown as { __atlasData?: ObservedHarness })
    .__atlasData;
  if (!data) return null;
  const { least, mark } = arg;
  if (data.page !== mark.page)
    throw new Error(
      "observation identity: the page was replaced (a reload) while observing",
    );
  const epochs = data.engineEpochs
    .filter((e) => e.generation > mark.generation)
    .map((e) => ({ generation: e.generation, run: e.run, trace: e.trace }));
  if (epochs.length > 1)
    throw new Error(
      "observation identity: the engine was started again while observing",
    );
  const epoch = epochs[0];
  if (!epoch) return null;
  const states = data.engineStates;
  const last = states.at(-1);
  if (!last || states.length <= mark.states) return null;
  const published = states.slice(mark.states).map((e, index) => ({
    index,
    generation: e.generation,
    at: e.at,
    trace: e.trace,
    state: e.state,
  }));
  if (published.some((e) => e.generation !== epoch.generation))
    throw new Error(
      "observation identity: another engine published while observing",
    );
  // The store notifies synchronously: the last logged state is the current one, or the log is behind (polled again).
  if (JSON.stringify(data.engineState()) !== JSON.stringify(last.state))
    return null;
  const trace = data.engineTrace;
  const boundary = trace.length;
  const payload = (line: string): Record<string, unknown> | null => {
    const at = line.indexOf("{");
    if (at < 0) return null;
    try {
      const value = JSON.parse(line.slice(at)) as unknown;
      return typeof value === "object" &&
        value !== null &&
        !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  };
  const events: Array<{ trace: number; line: string }> = [];
  for (let t = epoch.trace; t < boundary; t += 1) {
    const line = trace[t] ?? "";
    const name = line.split(" ")[1];
    if (
      name === "data.sync_commit" ||
      name === "data.sync_next" ||
      name === "data.sync_step_failed"
    )
      events.push({ trace: t, line });
  }
  let dense: { trace: number; commit: ObservedCommit } | null = null;
  for (const e of events) {
    if (e.line.split(" ")[1] !== "data.sync_commit") continue;
    const commit = payload(e.line) as ObservedCommit | null;
    if (commit && (commit.bytes ?? 0) >= least * 0.9) {
      dense = { trace: e.trace, commit };
      break;
    }
  }
  const witness = (
    end: { trace: number; line: string },
    entry: (typeof published)[number],
  ): LiveObservation => {
    const failed = end.line.split(" ")[1] === "data.sync_step_failed";
    const recorded = failed ? null : payload(end.line)?.state;
    return {
      method: "live-dense-commit/3",
      page: data.page,
      mark,
      generation: epoch.generation,
      epochs,
      boundary,
      published,
      events,
      dense,
      step_end: {
        trace: end.trace,
        event: failed ? "data.sync_step_failed" : "data.sync_next",
        recorded: typeof recorded === "string" ? recorded : null,
      },
      state_entry: entry,
    };
  };
  for (const e of events) {
    const name = e.line.split(" ")[1];
    if (name === "data.sync_commit") continue;
    if (name === "data.sync_step_failed") {
      const stop = published.find((p) => p.trace > e.trace);
      // The stop the engine publishes after a failed step's line: not published yet, polled again.
      if (!stop) return null;
      // Complete: the rules judge it (a stop of another cause, or another event before it, is a contradiction).
      return witness(e, stop);
    }
    let entry: (typeof published)[number] | undefined;
    for (const p of published) if (p.trace <= e.trace) entry = p;
    const recorded = payload(e.line)?.state;
    // The start publishes its waiting state before the epoch's first trace line: an end before any publication is not this engine's.
    if (!entry)
      throw new Error(
        "observation identity: a step end of the epoch follows no state its engine published",
      );
    if (entry.state.kind !== recorded) return witness(e, entry);
    if (recorded === "stopped") return witness(e, entry);
    if (recorded === "idle") {
      if (!dense || dense.trace > e.trace) continue;
      return witness(e, entry);
    }
    if (
      recorded === "running" ||
      recorded === "backing_off" ||
      recorded === "paused" ||
      recorded === "waiting"
    )
      continue;
    return witness(e, entry);
  }
  return null;
}

/**
 * The live outcome its one observation shows, corroborated by the shared rules against the verified capture's size and the page's
 * retained trace (and the page instance that trace was read from).
 */
export function classifyLiveOutcome(
  observation: LiveObservation,
  context: {
    capturedBytes: number;
    traceLines: string[] | null;
    tracePage: string | null;
  },
): { outcome: "admitted" | "refused" | "error"; problems: string[] } {
  const { shows, problems } = liveObservationRules(observation, context);
  if (problems.length || shows === null)
    return {
      outcome: "error",
      problems: problems.length ? problems : ["no verdict"],
    };
  return { outcome: shows, problems };
}
