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
//   * a live observation (`live-dense-commit/2`) retains its epoch and the qualifying commit's trace position: the commit must be in the
//     raw trace at that position inside the epoch and before the observation, the first there of at least 90% of the captured limit-1
//     bytes, with the idle published after it;
//   * a device engine run's detail is the state it ended in and must show its outcome; its first commit (schema 3) is the served body's.

export const COLD_METHOD = "engine-state-log/2";
export const LIVE_METHOD = "live-dense-commit/2";
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
 */
export function coldObservationRules(o, { servedBytes, requests }) {
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

  // Its end: the first failed step, or the first step end not still running, at or after the request.
  const end = events.find(
    (e) =>
      e.trace >= request.trace &&
      (e.event === "data.sync_step_failed" ||
        (e.event === "data.sync_next" && e.payload?.state !== "running")),
  );
  if (!end)
    return none([...problems, "the request step's end is not retained"]);
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
    else if (!(firstEvent.trace < terminal.trace))
      problems.push(
        "the idle state was published before the served page's commit",
      );
  }
  if (!(isCount(requests) && requests >= 1))
    problems.push("no /sync request reached the stub");
  if (!isCount(servedBytes) || servedBytes === 0)
    problems.push("the served bytes are not known");
  return { shows: verdict, problems, first };
}

/**
 * A live observation as evidence of the live application's outcome. `capturedBytes` is the verified limit-1 capture's byte length (the
 * density basis), `traceLines` the page's retained engine trace read after the observation (append-only on that page) or null.
 */
export function liveObservationRules(o, { capturedBytes, traceLines }) {
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
  if (!isCount(o.boundary) || o.boundary < epoch.trace)
    return none([...problems, "the observation's trace boundary is malformed"]);
  if (lines && o.boundary > lines.length)
    problems.push("the observation's boundary lies beyond the retained trace");
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
  if (s.generation !== o.generation)
    problems.push("the observed state is not the observed engine's");
  if (s.trace < epoch.trace || s.trace > o.boundary)
    problems.push("the observed state lies outside the observation's epoch");
  const least = LIVE_DENSITY * capturedBytes;
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
    if (lines) {
      const line = lines[dense.trace];
      if (
        !String(line ?? "").includes("data.sync_commit") ||
        !sameValue(tracePayload(line), c)
      )
        problems.push(
          "the dense commit is not the retained trace's commit at its position",
        );
      const earlier = lines
        .slice(epoch.trace, dense.trace)
        .findIndex(
          (l) =>
            String(l).includes("data.sync_commit") &&
            (tracePayload(l)?.bytes ?? 0) >= least,
        );
      if (earlier >= 0)
        problems.push(
          "an earlier commit of the epoch already met the density: the observed commit is not the first dense one",
        );
    }
  }
  let shows = null;
  if (s.state.kind === "idle") {
    if (!dense) problems.push("idle without a dense commit");
    else {
      if (dense.commit?.kind !== "applied")
        problems.push("the dense commit was not applied");
      if (!(s.trace > dense.trace))
        problems.push(
          "the idle state was not published after the dense commit",
        );
      shows = "admitted";
    }
  } else if (s.state.kind === "stopped") shows = "refused";
  else problems.push(`no verdict (${s.state.kind})`);
  return { shows, problems };
}

/**
 * A device run's outcome corroboration (schema 3): an engine run's detail is the JSON state it ended in and must show its outcome, and its
 * first commit (`first_commit`) is the served body's, with the figures the run reports. W5 (processing only) and killed attempts have
 * none. Errors and time-outs keep whatever they have. Returns the problems, each naming the field.
 */
export function deviceRunOutcomeProblems(run) {
  const problems = [];
  if (!("first_commit" in run))
    return ["first_commit is neither a commit nor an explicit null"];
  const fc = run.first_commit;
  if (!(fc === null || isObj(fc)))
    return ["first_commit is neither a commit nor an explicit null"];
  const processingOnly = String(run.workload).startsWith("W5-");
  if (run.outcome === "killed" || processingOnly) {
    if (fc !== null)
      problems.push(
        processingOnly
          ? "W5 is the processing path only: no commit"
          : "a killed attempt cannot have committed anything",
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
    else
      for (const key of ["scan_ms", "commit_ms"])
        if (run[key] !== fc[key])
          problems.push(`${key} is not the served body's commit's`);
  }
  return problems;
}
