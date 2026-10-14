// The semantic rules of profiled outcome evidence (WEB-09c revision 10; review 10's R2 follow-up and design assessment DA-1 to DA-3,
// A1/A2; family profiling-evidence-completeness). Dependency-free, so ONE rule set judges every representation: the Node-side classifiers
// of the cold runs and the live application (tests/e2e/profile-cold-outcome.ts), the evidence contract (scripts/lib/profile-contract.mjs)
// and the device results reader (scripts/lib/profile-device-results.mjs). The browser observers stay self-contained in the page (Playwright
// serialises them); these rules check what they returned against facts the caller knows independently of it: the bytes it served, the
// verified capture's size and the raw trace of the page. A producer's own "valid" flag or scalar summary is never trusted.
//
// Review 10 found that revision 9's observation could be absent or contradict itself and still derive desktop support: a cold first
// commit without bytes skipped the served-byte comparison; the request and terminal could be the same entry, or the terminal and step
// end could precede the request; a failed step paired with an idle admission passed; and a live dense commit was never compared with the
// captured size or the retained trace. Revision 10 makes the corroboration REQUIRED data:
//
//   * a cold observation (`engine-state-log/2`) retains the page instance, the engine generation, every state published since the mark
//     (structured, never truncated), every step-relevant trace event from the mark to the step end, and the engine starts since the mark;
//     the request, its end, the terminal state and the commits are RECOMPUTED from that retained slice and must equal the claims;
//   * the order is the engine's (src/data/engine/sync-engine.ts): a step publishes `running` immediately before its request; a normal end
//     publishes its state and then traces `data.sync_next` with that state's kind (`running` after a `has_more` page: the operation goes
//     on); a step that threw traces `data.sync_step_failed` and only then publishes `stopped/local_storage`; a commit is traced before the
//     state it leads to is published;
//   * the first commit after the request is the served page: integer bytes equal to what the caller served, finite timings; an idle end
//     requires it applied and traced before the idle; a refusal may have none (and keeps the one it had after a `has_more` continuation);
//   * a live observation retains its epoch and the qualifying commit's trace position: the commit must be in the raw trace at that
//     position inside the epoch and before the observation, the first there of at least 90% of the captured limit-1 bytes, with the idle
//     published after it. Review 11 found its terminal state never related to the step end of the same observation (a stopped, failed
//     or running end beside an idle witness resolved admitted), so revision 11's `live-dense-commit/3` retains every publication and the
//     raw line of every step event inside its boundary, derives the end that completes it and the publication that end rests on
//     (`liveTerminalRelation`), and binds that slice to the trace file read from the same page;
//   * a device engine run's detail is the state it ended in and must show its outcome; its first commit (schema 3) is the served body's.
//
// Review 12 found the cold and device rules admitted a measured commit that wrote no page: `kind: "applied"` is the TRANSACTION's result,
// and the page plan's own result (`value`) can be `not_ready` or `lease_lapsed`, which write nothing (src/data/plans/commit-page.ts). After
// a lapsed hold the engine asks again without publishing anything (it stays `running`), so the cold observer walked past the measured
// attempt's end as if it were a `has_more` continuation, and the stub's later empty page committed and published idle. Revision 12
// (design assessment DA-C1/DA-D1, invariants 1 to 5): a commit wrote its page only when it is applied AND committed (`pageCommitted`,
// shared by the cold, live and device rules); the measured attempt is the step that made the first request after the mark, and only a
// committed measured page may continue past a `running` end (`engine-state-log/3`); an attempt that wrote nothing and asked again ends
// the observation with no verdict, so no later response can stand for it; and an admitted run's durable effects (the cache it left,
// `cache-rows/1`, scripts/lib/profile-effects.mjs) must be the ones the served page leaves. Device results are schema 4: each engine run
// carries the same observation and its effects.

import { effectsProblems } from "./profile-effects.mjs";

export const COLD_METHOD = "engine-state-log/3";
export const LIVE_METHOD = "live-dense-commit/3";
/** The state kinds that are the engine's verdict that a page was not applied (the device protocol's set, profile-page.ts). */
export const REFUSED_STATES = ["stopped", "backing_off", "paused"];
/** The trace events an observation retains: the commits and the two ways a step ends. */
export const STEP_EVENTS = [
  "data.sync_commit",
  "data.sync_next",
  "data.sync_step_failed",
];
/** The live predicate: a commit of at least this fraction of the captured limit-1 bytes is the dense page (pagination may differ). */
export const LIVE_DENSITY = 0.9;

const isObj = (x) => typeof x === "object" && x !== null && !Array.isArray(x);
const isCount = (x) => Number.isInteger(x) && x >= 0;
const isTime = (x) => typeof x === "number" && Number.isFinite(x) && x >= 0;
const isText = (x) => typeof x === "string" && x.length > 0;
/**
 * Whether a traced commit wrote its page: the transaction applied (`kind`) AND the page plan committed (`value`). `not_ready`,
 * `lease_lapsed`, a missing or unknown value, a dropped or failed transaction wrote nothing; a missing value never defaults to committed.
 */
export const pageCommitted = (commit) =>
  isObj(commit) && commit.kind === "applied" && commit.value === "committed";
/** Why a measured commit did not write its page, for a problem message. */
const notWritten = (commit) =>
  !isObj(commit)
    ? "no commit"
    : commit.kind !== "applied"
      ? `a ${String(commit.kind)} commit`
      : `value ${String(commit.value ?? "missing")}`;
/** JSON with sorted keys: two representations of one value are the same only if this text is. */
const canonical = (x) =>
  JSON.stringify(x, (_key, value) =>
    isObj(value)
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((k) => [k, value[k]]),
        )
      : value,
  );
export const sameValue = (a, b) => canonical(a) === canonical(b);

/** The trace line's JSON payload (`<ms>ms <event> <json>`), or null. */
export function tracePayload(line) {
  const text = String(line ?? "");
  const at = text.indexOf("{");
  if (at < 0) return null;
  try {
    const value = JSON.parse(text.slice(at));
    return isObj(value) ? value : null;
  } catch {
    return null;
  }
}
/** The event name of a trace line (`<ms>ms <event> ...`), or null. */
export function traceEvent(line) {
  const parts = String(line ?? "").split(" ");
  return parts.length >= 2 && /^-?\d+ms$/.test(parts[0]) ? parts[1] : null;
}
/** Every `data.sync_commit` payload of a trace, as the writers record them (an unreadable payload is `{}`). */
export const commitsOfTrace = (lines) =>
  lines
    .filter((line) => String(line).includes("data.sync_commit"))
    .map((line) => tracePayload(line) ?? {});

/**
 * What a published end state says about the page: `admitted` (idle), `refused` (the engine's refusal states, or waiting for a valid cache
 * after the request) or null with the reason it is no verdict (running, not started, waiting for the session or the network, unknown).
 */
export function verdictOfState(state) {
  if (!isObj(state) || typeof state.kind !== "string")
    return { verdict: null, problem: "the end state is not a state" };
  if (state.kind === "idle") return { verdict: "admitted", problem: null };
  if (REFUSED_STATES.includes(state.kind))
    return { verdict: "refused", problem: null };
  if (state.kind === "waiting")
    return state.reason === "cache_not_valid"
      ? { verdict: "refused", problem: null }
      : {
          verdict: null,
          problem: `the step ended waiting (${String(state.reason)}): not a verdict on the page`,
        };
  return { verdict: null, problem: `the step ended in ${state.kind}` };
}

/** The identity problems of an observation's page, mark, generation and engine starts (one engine, started once since the mark). */
function epochProblems(o) {
  const problems = [];
  if (!isText(o.page)) problems.push("the observation names no page instance");
  const mark = o.mark;
  if (
    !isObj(mark) ||
    !isCount(mark.states) ||
    !isCount(mark.trace) ||
    !isCount(mark.generation)
  )
    return { problems: [...problems, "the observation's mark is malformed"] };
  if (mark.page !== o.page)
    problems.push(
      "the observation was made on another page instance than its mark (a reload)",
    );
  if (!(Number.isInteger(o.generation) && o.generation > mark.generation))
    problems.push(
      `the observed engine generation ${String(o.generation)} is not one started after the mark (${mark.generation})`,
    );
  const epochs = Array.isArray(o.epochs) ? o.epochs : null;
  if (!epochs)
    return { problems: [...problems, "the engine starts are not retained"] };
  if (epochs.length !== 1)
    return {
      problems: [
        ...problems,
        `the engine was started ${epochs.length} times since the mark: one start is the observed operation`,
      ],
    };
  const epoch = epochs[0];
  if (
    !isObj(epoch) ||
    epoch.generation !== o.generation ||
    !isCount(epoch.trace) ||
    epoch.trace < mark.trace
  )
    problems.push(
      "the engine start since the mark is not the observed generation's",
    );
  return { problems, mark, epoch: isObj(epoch) ? epoch : null };
}

/**
 * A cold observation as evidence of one verdict on the served page. `servedBytes` is the byte length of what the caller served (the
 * generated workload, or the verified captured W2 page), `requests` the stub's count. Returns the verdict the end state shows (`shows`),
 * every problem, and the first commit after the request (the measured page's, or null).
 *
 * Revision 12: `effects` is the cache the run left (`cache-rows/1`, recorded after the observation) and `expectedEffects` what the served
 * page leaves in the run's new, empty database (derived by the CALLER from the served bytes, never from the run's record); an admission
 * requires them to agree as well as the measured page's commit to have written it (`pageCommitted`). `effectsExempt` (a reason, or null)
 * is the caller's explicit statement that this record's effects are judged elsewhere: a negative control (its admission fails the control
 * whatever it wrote) or a W2 run whose capture is itself invalid (that defect is the capture cell's finding). It never makes an admission
 * valid on its own: every other relation is still required.
 */
export function coldObservationRules(
  o,
  {
    servedBytes,
    requests,
    effects = null,
    expectedEffects = null,
    effectsExempt = null,
  },
) {
  const none = (problems) => ({ shows: null, problems, first: null });
  if (!isObj(o)) return none(["no observation was retained"]);
  if (o.method !== COLD_METHOD)
    return none([
      `observation method ${String(o.method)} is not ${COLD_METHOD}`,
    ]);
  const problems = [];
  const id = epochProblems(o);
  problems.push(...id.problems);
  if (!id.mark || !id.epoch) return none(problems);
  const { mark, epoch } = id;

  // The retained publications since the mark, in order, all of the observed generation.
  const published = Array.isArray(o.published) ? o.published : null;
  if (!published || published.length === 0)
    return none([...problems, "the published states are not retained"]);
  for (const [i, e] of published.entries()) {
    const where = `published state ${i}`;
    if (
      !isObj(e) ||
      e.index !== i ||
      !isTime(e.at) ||
      !isCount(e.trace) ||
      !isObj(e.state) ||
      typeof e.state.kind !== "string"
    )
      return none([...problems, `${where} is malformed`]);
    if (e.generation !== o.generation)
      problems.push(
        `${where} belongs to engine generation ${String(e.generation)}, not the observed ${o.generation}`,
      );
    if (e.trace < epoch.trace)
      problems.push(`${where} precedes the observed engine's start`);
    const previous = published[i - 1];
    if (previous && (e.at < previous.at || e.trace < previous.trace))
      problems.push(`${where} is out of order`);
  }
  // The retained step events from the mark to the step end.
  const events = Array.isArray(o.events) ? o.events : null;
  if (!events) return none([...problems, "the step events are not retained"]);
  for (const [i, e] of events.entries()) {
    if (
      !isObj(e) ||
      !isCount(e.trace) ||
      !STEP_EVENTS.includes(e.event) ||
      !(e.payload === null || isObj(e.payload))
    )
      return none([...problems, `step event ${i} is malformed or unknown`]);
    if (e.trace < mark.trace)
      problems.push(`step event ${i} precedes the mark`);
    if (i > 0 && e.trace <= events[i - 1].trace)
      problems.push(`step event ${i} is out of order`);
  }

  // The request: the first `running` published since the mark.
  const begin = published.findIndex((e) => e.state.kind === "running");
  if (begin < 0)
    return none([...problems, "no request step (running) was published"]);
  const request = published[begin];
  if (
    !isObj(o.request) ||
    o.request.index !== begin ||
    o.request.at !== request.at ||
    o.request.trace !== request.trace
  )
    problems.push("the recorded request is not the first running published");

  // The measured attempt: the request's own step, ended by the first step end after it; its commit is the first before that end.
  const isEnd = (e) =>
    e.event === "data.sync_step_failed" || e.event === "data.sync_next";
  const attemptEnd = events.find((e) => e.trace >= request.trace && isEnd(e));
  if (!attemptEnd)
    return none([...problems, "the request step's end is not retained"]);
  const measuredEvent =
    events.find(
      (e) =>
        e.event === "data.sync_commit" &&
        e.trace >= request.trace &&
        e.trace < attemptEnd.trace,
    ) ?? null;
  const written = pageCommitted(measuredEvent?.payload);
  // Revision 12 (review 12 R2): only a WRITTEN measured page continues past a `running` end (`has_more`: the engine asks for the next page
  // at once). A measured attempt that wrote nothing and ended `running` (a lapsed hold asks again without publishing anything) ends the
  // observation: the measured page was not applied, and no later response can stand for it.
  const continued =
    attemptEnd.event === "data.sync_next" &&
    attemptEnd.payload?.state === "running" &&
    written;
  const end = continued
    ? events.find(
        (e) =>
          e.trace > attemptEnd.trace &&
          (e.event === "data.sync_step_failed" ||
            (e.event === "data.sync_next" && e.payload?.state !== "running")),
      )
    : attemptEnd;
  if (!end)
    return none([...problems, "the request step's end is not retained"]);
  if (
    attemptEnd.event === "data.sync_next" &&
    attemptEnd.payload?.state === "running" &&
    !written
  )
    problems.push(
      `the measured page was not written (${notWritten(measuredEvent?.payload)}) and the engine asked again: a later response cannot stand for it`,
    );
  if (events.at(-1) !== end)
    problems.push("step events after the request step's end are retained");
  const failed = end.event === "data.sync_step_failed";
  const recorded = failed ? null : end.payload?.state;
  if (!failed && typeof recorded !== "string")
    problems.push("the step's end records no state");
  if (
    !isObj(o.step_end) ||
    o.step_end.trace !== end.trace ||
    o.step_end.event !== end.event ||
    o.step_end.recorded !== (recorded ?? null)
  )
    problems.push("the recorded step end is not the request step's end");

  // The terminal: the state the end published (normal: the last before the end line; failed: the first after it, the stop).
  let at = -1;
  for (const [i, e] of published.entries())
    if (i > begin && (failed ? e.trace > end.trace : e.trace <= end.trace)) {
      at = i;
      if (failed) break;
    }
  if (at < 0)
    return none([
      ...problems,
      failed
        ? "the failed step's stop is not retained"
        : "no state was published after the request before its end (the terminal is the request itself)",
    ]);
  const terminal = published[at];
  if (at !== published.length - 1)
    problems.push("states published after the terminal state are retained");
  if (
    !isObj(o.terminal) ||
    o.terminal.index !== at ||
    !(o.terminal.index > o.request?.index) ||
    o.terminal.at !== terminal.at ||
    o.terminal.trace !== terminal.trace ||
    !sameValue(o.terminal.state, terminal.state)
  )
    problems.push("the recorded terminal state is not the step end's");
  if (!(terminal.at >= request.at))
    problems.push("the terminal state was published before the request");
  if (failed) {
    if (!(end.trace < terminal.trace))
      problems.push("the failed step's stop was published before its failure");
    if (
      terminal.state.kind !== "stopped" ||
      terminal.state.cause !== "local_storage"
    )
      problems.push(
        `a failed step ends in stopped/local_storage, not ${terminal.state.kind}`,
      );
  } else if (recorded !== terminal.state.kind)
    problems.push(
      `the step's end records ${String(recorded)}, but ${terminal.state.kind} was published`,
    );

  // The commits from the request to the end, recomputed from the retained events; the first is the served page's.
  const derived = events.filter(
    (e) =>
      e.event === "data.sync_commit" &&
      e.trace >= request.trace &&
      e.trace < end.trace,
  );
  if (derived.some((e) => e.payload === null))
    problems.push("a commit's payload is not retained");
  const commits = derived.map((e) => e.payload);
  if (!Array.isArray(o.commits) || !sameValue(o.commits, commits))
    problems.push("the recorded commits are not the request step's commits");
  const firstEvent = derived[0] ?? null;
  const first = firstEvent?.payload ?? null;
  if (first) {
    if (typeof first.kind !== "string")
      problems.push("the first commit after the request has no kind");
    if (!isCount(first.bytes))
      problems.push(
        "the first commit after the request does not record its bytes",
      );
    else if (first.bytes !== servedBytes)
      problems.push(
        `the first commit after the request is ${first.bytes} bytes, not the served ${String(servedBytes)}`,
      );
    for (const key of ["scan_ms", "commit_ms"])
      if (!isTime(first[key]))
        problems.push(`the first commit's ${key} is not a time`);
  }
  const { verdict, problem } = verdictOfState(terminal.state);
  if (problem) problems.push(problem);
  if (verdict === "admitted") {
    if (first?.kind !== "applied")
      problems.push("idle without the served page's applied commit");
    else if (!pageCommitted(first))
      problems.push(
        `idle, but the served page's commit wrote no page (${notWritten(first)})`,
      );
    else if (!(firstEvent.trace < terminal.trace))
      problems.push(
        "the idle state was published before the served page's commit",
      );
    else if (typeof effectsExempt !== "string" || effectsExempt.length === 0)
      problems.push(...effectsProblems(effects, expectedEffects));
  } else if (verdict === "refused" && !failed && end === attemptEnd && written)
    problems.push(
      `the served page was committed, but its step ended ${terminal.state.kind}: a committed page ends idle or running`,
    );
  if (!(isCount(requests) && requests >= 1))
    problems.push("no /sync request reached the stub");
  if (!isCount(servedBytes) || servedBytes === 0)
    problems.push("the served bytes are not known");
  return { shows: verdict, problems, first };
}

/**
 * The relation between a live observation's step ends and its publications (revision 11, review 11's R2 follow-up; design assessment
 * DA-L1): walks the retained step ends of the epoch in order and returns the first that ends the observation, with the publication it is
 * corroborated by. A normal end (`data.sync_next`) records the state the engine had published last when the step returned, so that
 * publication (the last at or before the end's trace line) must be of the recorded kind; a failed step (`data.sync_step_failed`) is
 * followed by its stop, the first publication after the line, which must be `stopped/local_storage` with no other step event between.
 * A continuation (running after a `has_more` page, a back-off, a pause, a wait, or an idle reached before the dense page) does not end
 * the observation; idle with the dense commit traced before it does (`admitted`), and so does any stop (`refused`). A contradictory end,
 * an end with no verdict (a stop of the engine) or a failed step whose stop is not retained ends it with a `problem`. Returns
 * `{ end: null }` when nothing in the slice ends it. `dense` is the derived first dense commit event (or null).
 */
export function liveTerminalRelation(published, events, dense) {
  for (const [i, e] of events.entries()) {
    if (e.event === "data.sync_commit") continue;
    const failed = e.event === "data.sync_step_failed";
    let terminal = null;
    if (failed) {
      terminal = published.find((p) => p.trace > e.trace) ?? null;
      if (!terminal)
        return {
          end: e,
          terminal: null,
          shows: null,
          problem:
            "the failed step's stop is not retained inside the observation",
        };
      if (events.slice(i + 1).some((x) => x.trace < terminal.trace))
        return {
          end: e,
          terminal,
          shows: null,
          problem:
            "another step event lies between the failed step and its stop",
        };
      if (
        terminal.state.kind !== "stopped" ||
        terminal.state.cause !== "local_storage"
      )
        return {
          end: e,
          terminal,
          shows: null,
          problem: `a failed step ends in stopped/local_storage, not ${terminal.state.kind}`,
        };
      return { end: e, terminal, shows: "refused", problem: null };
    }
    for (const p of published) if (p.trace <= e.trace) terminal = p;
    const recorded = e.payload?.state;
    if (!terminal)
      return {
        end: e,
        terminal: null,
        shows: null,
        problem: `the step end at trace ${e.trace} follows no published state`,
      };
    if (terminal.state.kind !== recorded)
      return {
        end: e,
        terminal,
        shows: null,
        problem: `the step end at trace ${e.trace} records ${String(recorded)}, but ${terminal.state.kind} was published`,
      };
    if (recorded === "stopped")
      return { end: e, terminal, shows: "refused", problem: null };
    if (recorded === "idle") {
      if (!dense || dense.trace > e.trace) continue;
      if (!(dense.trace < terminal.trace))
        return {
          end: e,
          terminal,
          shows: null,
          problem: "the idle state was not published after the dense commit",
        };
      return { end: e, terminal, shows: "admitted", problem: null };
    }
    if (["running", "backing_off", "paused", "waiting"].includes(recorded))
      continue;
    return {
      end: e,
      terminal,
      shows: null,
      problem: `no verdict (the step ended in ${String(recorded)})`,
    };
  }
  return { end: null, terminal: null, shows: null, problem: null };
}

/**
 * A live observation as evidence of the live application's outcome (`live-dense-commit/3`). `capturedBytes` is the verified limit-1
 * capture's byte length (the density basis), `traceLines` the page's retained engine trace read after the observation (append-only on
 * that page) or null, and `tracePage` the page instance that trace was read from.
 *
 * Revision 11 (review 11's R2 follow-up; DA-L1, invariants 1 to 8): the observation retains, from ONE page evaluation, every state
 * published since its mark and every step event (commit, normal or failed step end) of its epoch up to its exclusive trace boundary, each
 * as its raw trace line. The verdict, the dense commit, the step end and the publication it rests on are DERIVED from that slice
 * (`liveTerminalRelation`) and the claims must equal them. The slice is bound to the retained trace file: each line must be the file's
 * line at its position, no step event of the epoch inside the boundary may be missing from it, and the file must have been read from the
 * observation's page. What follows the boundary (a later poll, a failure, another start) is never consulted.
 */
export function liveObservationRules(
  o,
  { capturedBytes, traceLines, tracePage },
) {
  const none = (problems) => ({ shows: null, problems });
  if (!isObj(o)) return none(["no observation was retained"]);
  if (o.method !== LIVE_METHOD)
    return none([
      `observation method ${String(o.method)} is not ${LIVE_METHOD}`,
    ]);
  const problems = [];
  const id = epochProblems(o);
  problems.push(...id.problems);
  if (!id.mark || !id.epoch) return none(problems);
  // The epoch (the one engine start, at or after the mark) bounds everything the live witness may cite.
  const { epoch } = id;
  if (!isCount(capturedBytes) || capturedBytes === 0)
    problems.push("the captured limit-1 size is not known");
  const lines = Array.isArray(traceLines) ? traceLines : null;
  if (!lines) problems.push("the live engine trace is not retained");
  else if (tracePage !== o.page)
    problems.push(
      "the retained live trace was not read from the observation's page instance",
    );
  if (!isCount(o.boundary) || o.boundary < epoch.trace)
    return none([...problems, "the observation's trace boundary is malformed"]);
  if (lines && o.boundary > lines.length)
    problems.push("the observation's boundary lies beyond the retained trace");

  // The publications since the mark, in order, all of the observed generation and inside the epoch and boundary.
  const published = Array.isArray(o.published) ? o.published : null;
  if (!published || published.length === 0)
    return none([...problems, "the published states are not retained"]);
  for (const [i, e] of published.entries()) {
    const where = `published state ${i}`;
    if (
      !isObj(e) ||
      e.index !== i ||
      !isTime(e.at) ||
      !isCount(e.trace) ||
      !isObj(e.state) ||
      typeof e.state.kind !== "string"
    )
      return none([...problems, `${where} is malformed`]);
    if (o.generation !== e.generation)
      problems.push(
        `${where} belongs to engine generation ${String(e.generation)}, not the observed ${o.generation}`,
      );
    if (e.trace < epoch.trace || e.trace > o.boundary)
      problems.push(
        `${where} lies outside the observation's epoch and boundary`,
      );
    const before = published[i - 1];
    if (before && (e.at < before.at || e.trace < before.trace))
      problems.push(`${where} is out of order`);
  }
  // The epoch's step events up to the boundary, each its raw trace line.
  const raw = Array.isArray(o.events) ? o.events : null;
  if (!raw) return none([...problems, "the step events are not retained"]);
  const events = [];
  for (const [i, e] of raw.entries()) {
    const event = isObj(e) ? traceEvent(e.line) : null;
    const payload = isObj(e) ? tracePayload(e.line) : null;
    if (
      !isObj(e) ||
      !isCount(e.trace) ||
      typeof e.line !== "string" ||
      !STEP_EVENTS.includes(event) ||
      (event !== "data.sync_step_failed" && payload === null) ||
      (event === "data.sync_next" && typeof payload.state !== "string")
    )
      return none([...problems, `step event ${i} is malformed or unknown`]);
    if (i > 0 && e.trace <= raw[i - 1].trace)
      problems.push(`step event ${i} is out of order`);
    // Support outside the observation is never consulted (it cannot be borrowed from a suffix, nor from before the start).
    if (e.trace < epoch.trace || e.trace >= o.boundary)
      problems.push(
        `step event ${i} lies outside the observation's epoch and boundary`,
      );
    else events.push({ trace: e.trace, event, payload, line: e.line });
  }
  if (lines) {
    if (events.some((e) => lines[e.trace] !== e.line))
      problems.push(
        "the retained step events are not the page's trace lines at their positions",
      );
    const kept = new Set(events.map((e) => e.trace));
    for (let t = epoch.trace; t < Math.min(o.boundary, lines.length); t += 1)
      if (STEP_EVENTS.includes(traceEvent(lines[t])) && !kept.has(t)) {
        problems.push(
          `the trace's step event at ${t}, inside the observation, was not retained`,
        );
        break;
      }
  }

  // The dense commit: the epoch's first commit of at least 90% of the captured bytes (derived), and the claim's agreement with it.
  const least = LIVE_DENSITY * capturedBytes;
  const derived =
    events.find(
      (e) =>
        e.event === "data.sync_commit" &&
        isCount(e.payload.bytes) &&
        e.payload.bytes >= least,
    ) ?? null;
  const dense = o.dense;
  if (dense !== null) {
    if (!isObj(dense) || !isCount(dense.trace) || !isObj(dense.commit))
      return none([...problems, "the dense commit is malformed"]);
    const c = dense.commit;
    if (dense.trace < epoch.trace || dense.trace >= o.boundary)
      problems.push(
        "the dense commit lies outside the observation's epoch and boundary",
      );
    if (!isCount(c.bytes))
      problems.push("the dense commit does not record its bytes");
    else if (!(c.bytes >= least))
      problems.push(
        `the dense commit is ${c.bytes} bytes, below ${LIVE_DENSITY * 100}% of the captured ${String(capturedBytes)}`,
      );
    for (const key of ["scan_ms", "commit_ms"])
      if (!isTime(c[key]))
        problems.push(`the dense commit's ${key} is not a time`);
    if (typeof c.kind !== "string")
      problems.push("the dense commit has no kind");
    const at = events.find((e) => e.trace === dense.trace);
    if (at?.event !== "data.sync_commit" || !sameValue(at.payload, c))
      problems.push(
        "the dense commit is not the retained trace's commit at its position",
      );
    else if (derived && derived.trace < dense.trace)
      problems.push(
        "an earlier commit of the epoch already met the density: the observed commit is not the first dense one",
      );
  } else if (derived)
    problems.push(
      "the epoch has a commit of at least 90% of the capture, but the observation names no dense commit",
    );

  // The step end that ends the observation and the publication it rests on, derived and compared with the claims.
  const relation = liveTerminalRelation(published, events, derived);
  if (!relation.end)
    return none([
      ...problems,
      "no step end inside the observation ends it (idle after the dense commit, or a stop)",
    ]);
  if (relation.problem) problems.push(relation.problem);
  const ending = relation.end;
  const recorded =
    ending.event === "data.sync_next" ? (ending.payload?.state ?? null) : null;
  if (
    !isObj(o.step_end) ||
    o.step_end.trace !== ending.trace ||
    o.step_end.event !== ending.event ||
    o.step_end.recorded !== recorded
  )
    problems.push(
      "the recorded step end is not the one that ends the observation",
    );
  const s = o.state_entry;
  if (
    !isObj(s) ||
    !isCount(s.index) ||
    !isTime(s.at) ||
    !isCount(s.trace) ||
    !isObj(s.state) ||
    typeof s.state.kind !== "string"
  )
    return none([...problems, "the observed state is malformed"]);
  if (!relation.terminal || !sameValue(s, relation.terminal))
    problems.push(
      "the observed state is not the publication its step end rests on",
    );
  let shows = null;
  if (relation.shows === "admitted") {
    if (derived?.payload.kind !== "applied")
      problems.push("the dense commit was not applied");
    else if (!pageCommitted(derived.payload))
      problems.push(
        `the dense commit wrote no page (${String(derived.payload.value)})`,
      );
    shows = "admitted";
  } else if (relation.shows === "refused") shows = "refused";
  return { shows, problems };
}

/**
 * A device run's outcome corroboration. Schema 3: an engine run's detail is the JSON state it ended in and must show its outcome, and its
 * first commit (`first_commit`) is the served body's, with the figures the run reports. W5 (processing only) and killed attempts have
 * none. Errors and time-outs keep whatever they have. Schema 4 (revision 12, review 12 R2, design assessment DA-D1): an admitted or
 * refused engine run carries the ONE observation it was classified from (`engine-state-log/3`, made by the page from its own state log
 * and trace, src/fixture/data-harness/profile-observation.ts) and the cache it left (`effects`, read after its engine was stopped); the
 * cold rules judge that observation against the run's served bytes and request count, the recorded outcome, detail, first commit and
 * figures must be the observation's, an admission needs the measured page written (`pageCommitted`) and the effects the served page
 * leaves (`expectedEffects`, derived by the caller from the verified bytes), and `changes_written` is the effects' row count. Returns the
 * problems, each naming the field.
 */
export function deviceRunOutcomeProblems(
  run,
  { expectedEffects = null, effectsExempt = null } = {},
) {
  const problems = [];
  if (!("first_commit" in run))
    return ["first_commit is neither a commit nor an explicit null"];
  const fc = run.first_commit;
  if (!(fc === null || isObj(fc)))
    return ["first_commit is neither a commit nor an explicit null"];
  const processingOnly = String(run.workload).startsWith("W5-");
  if (
    !("observation" in run) ||
    !(run.observation === null || isObj(run.observation))
  )
    problems.push("observation is neither an observation nor an explicit null");
  if (!("effects" in run) || !(run.effects === null || isObj(run.effects)))
    problems.push("effects is neither a record nor an explicit null");
  if (run.outcome === "killed" || processingOnly) {
    if (fc !== null)
      problems.push(
        processingOnly
          ? "W5 is the processing path only: no commit"
          : "a killed attempt cannot have committed anything",
      );
    if (run.observation != null)
      problems.push(
        processingOnly
          ? "W5 is the processing path only: no engine observation"
          : "a killed attempt cannot have observed anything",
      );
    return problems;
  }
  if (fc !== null) {
    if (typeof fc.kind !== "string") problems.push("first_commit has no kind");
    if (!isCount(fc.bytes))
      problems.push("first_commit does not record its bytes");
    else if (fc.bytes !== run.bytes)
      problems.push(
        `the first commit is ${fc.bytes} bytes, not the served ${String(run.bytes)}`,
      );
    for (const key of ["scan_ms", "commit_ms"])
      if (!isTime(fc[key])) problems.push(`first_commit.${key} is not a time`);
  }
  if (run.outcome !== "admitted" && run.outcome !== "refused") return problems;
  let state = null;
  try {
    state = JSON.parse(String(run.detail));
  } catch {
    state = null;
  }
  if (!isObj(state) || typeof state.kind !== "string")
    return [
      ...problems,
      `an ${run.outcome} engine run's detail is not the state it ended in`,
    ];
  const { verdict, problem } = verdictOfState(state);
  if (verdict !== run.outcome)
    problems.push(
      `recorded ${run.outcome}, but its end state shows ${verdict ?? `no verdict (${problem})`}`,
    );
  if (run.outcome === "admitted") {
    if (fc?.kind !== "applied")
      problems.push(
        "an admitted engine run without the served body's applied commit",
      );
    else {
      if (!pageCommitted(fc))
        problems.push(
          `an admitted engine run whose served body's commit wrote no page (${notWritten(fc)})`,
        );
      for (const key of ["scan_ms", "commit_ms"])
        if (run[key] !== fc[key])
          problems.push(`${key} is not the served body's commit's`);
    }
  }
  // Schema 4: the observation the outcome was classified from, judged by the cold rules, and the effects.
  const o = run.observation;
  if (!isObj(o))
    return [
      ...problems,
      `an ${run.outcome} engine run without the observation it was classified from`,
    ];
  const judged = coldObservationRules(o, {
    servedBytes: run.bytes,
    requests: run.request_count,
    effects: run.effects,
    expectedEffects,
    effectsExempt,
  });
  problems.push(...judged.problems);
  if (judged.shows !== run.outcome)
    problems.push(
      `recorded ${run.outcome}, but its observation shows ${judged.shows ?? "no verdict"}`,
    );
  if (!sameValue(state, o.terminal?.state ?? null))
    problems.push("the detail is not the observed terminal state");
  if (!sameValue(fc, judged.first))
    problems.push("first_commit is not the observation's measured commit");
  if (isObj(run.effects) && run.changes_written !== run.effects.rows)
    problems.push(
      "changes_written is not the row count of the cache the run left",
    );
  return problems;
}
