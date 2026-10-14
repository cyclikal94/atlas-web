import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The profiled outcome observation (WEB-09c revision 9, review 9 R2; revision 10, review 10's R2 follow-up and design assessment
 * DA-1/DA-2; family profiling-evidence-completeness).
 *
 * Review 9 retained two WebKit cold runs recorded `refused` over a `running` state: the old `oneColdRun` accepted ANY state but
 * `running`/`not_started` as the end (the start's own `waiting/cache_not_valid` included), then read the state again in a separate call
 * and labelled every non-idle read a refusal. Review 10 found the corrected observation's corroboration optional (a first commit without
 * bytes, a terminal equal to or before the request, a failed step paired with idle, an uncorroborated live dense commit).
 *
 * These schedules drive the page functions (`observeColdOutcome`, `observeLiveOutcome`) over a harness that publishes exactly as the
 * fixture harness does (every state with its engine generation and trace position, every engine start in `engineEpochs`, the page
 * instance), the classifiers (the shared rules) and the actual `oneColdRun` (its browser, network and memory dependencies replaced; a
 * deterministic schedule of what the engine publishes between polls). Positive idle, genuine refusal and `has_more` controls sit beside
 * every contradiction; each expected outcome and reason is written here, not taken from the rules. Not a browser test or a measurement:
 * the native counterparts are the P-11 and W2 spec controls.
 *
 * Revision 11 (review 11's R2 follow-up; design assessment DA-L1/DA-H1): the live schedules now trace the step ends the production engine
 * traces (revision 10's published idle or stop WITHOUT its `data.sync_next` is kept as an incomplete control), and the cases M1-M9 of
 * the design assessment relate the live witness's terminal state to the step end that completes it.
 *
 * Revision 12 (review 12's R2 follow-up; design assessment DA-C1, DA-H1, Q1/Q2): the cold schedules carry the production commit payload
 * (`kind: "applied"` with the page plan's `value`; revision 10/11's positive cold schedules omitted it), the served body is a real page
 * whose cache effects are written out by hand below (never derived by the rules under test), the harness answers the cache read the run
 * makes afterwards, and the cases R12-C1..C12 cover the measured attempt that wrote nothing (lease_lapsed, not_ready, a missing or unknown
 * value, a dropped or unestablished admission), the committed `has_more` continuation, a committed page that ends refused, and the effects.
 */

type State = { kind: string; [key: string]: unknown };
interface Harness {
  page: string;
  engineStates: Array<{
    run: number;
    generation: number;
    at: number;
    trace: number;
    state: State;
  }>;
  engineEpochs: Array<{ generation: number; run: number; trace: number }>;
  engineTrace: string[];
  engineState(): State | null;
  /** The cache read the cold run makes after its observation (revision 12). */
  rows(account: string, store: string): Promise<object[]>;
  syncState(account: string): Promise<{ cursor: string } | null>;
}
let harness: Harness;
/** The cache rows the modelled database holds: a committed measured page writes the served page's rows (`commit`). */
let cacheRows: object[] = [];
let cacheFault: string | null = null;
let clock = 0;
let generation = 0;
let current: State | null = null;
const publish = (state: State, gen = generation) => {
  current = state;
  clock += 5;
  harness.engineStates.push({
    run: 1,
    generation: gen,
    at: clock,
    trace: harness.engineTrace.length,
    state,
  });
};
const trace = (event: string, data?: unknown) => {
  clock += 1;
  harness.engineTrace.push(
    `${clock}ms ${event} ${data === undefined ? "" : JSON.stringify(data)}`,
  );
};
// The served page (revision 12): two batches, a repeated upsert, a removal and a re-creation, so its effects are neither its change count
// nor its first writes. Written out by hand below.
const A = "00000000-0000-4000-8000-00000000000a";
const B = "00000000-0000-4000-8000-00000000000b";
const C = "00000000-0000-4000-8000-00000000000c";
const resource = (id: string, version: number) => ({
  id,
  kind: "field",
  parent_id: null,
  label: "x",
  value: { kind: "text", text: "t" },
  version,
  can_edit: true,
  policy_version: 1,
  archived: false,
});
const BODY = JSON.stringify({
  phase: "delta",
  batches: [
    {
      revision: 1,
      changes: [
        { kind: "upsert", resource: resource(A, 1) },
        { kind: "upsert", resource: resource(B, 1) },
        { kind: "upsert", resource: resource(C, 1) },
      ],
    },
    {
      revision: 2,
      changes: [
        { kind: "upsert", resource: resource(A, 2) },
        { kind: "remove", id: C },
        { kind: "upsert", resource: resource(C, 1) },
      ],
    },
  ],
  next_cursor: "c-1",
  has_more: false,
});
// (The last change re-creates C after its removal; the expectation is therefore A@2, B@1, C@1: three rows from six changes.)
const ROWS = [resource(A, 2), resource(B, 1), resource(C, 1)];
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const EXPECTED = {
  rows: 3,
  entries_sha256: sha([`${A}@2`, `${B}@1`, `${C}@1`].join("\n")),
};
const EFFECTS = { method: "cache-rows/1", ...EXPECTED };
/** A commit as the production engine traces it: an applied one carries its plan's `value` (pass null to omit it, as old fixtures did). */
const commit = (
  bytes = BODY.length,
  kind = "applied",
  value: string | null = "committed",
) => {
  trace("data.sync_commit", {
    bytes,
    scan_ms: 4,
    commit_ms: 28,
    kind,
    ...(kind === "applied" && value !== null ? { value } : {}),
  });
  // The modelled database: a committed served page leaves its rows.
  if (kind === "applied" && value === "committed" && bytes === BODY.length)
    cacheRows = ROWS.map((r) => ({ ...r, kind_date: null }));
};
/** A follow-up page (the stub's empty one) as the engine traces it: applied, committed, no rows. */
const emptyCommit = () =>
  trace("data.sync_commit", {
    bytes: 80,
    scan_ms: 0.5,
    commit_ms: 1.5,
    kind: "applied",
    value: "committed",
  });

beforeEach(() => {
  clock = 0;
  generation = 0;
  current = null;
  harness = {
    page: "page-1",
    engineStates: [],
    engineEpochs: [],
    engineTrace: [],
    engineState: () => current,
    rows: async () => {
      if (cacheFault) throw new Error(cacheFault);
      return cacheRows;
    },
    syncState: async () => ({ cursor: "c-1" }),
  };
  cacheRows = [];
  cacheFault = null;
  (window as unknown as { __atlasData: Harness }).__atlasData = harness;
});

const outcomes = await import("../e2e/profile-cold-outcome");
const {
  observationMark,
  observeColdOutcome,
  classifyColdOutcome,
  observeLiveOutcome,
  classifyLiveOutcome,
} = outcomes;
type ColdObservation = import("../e2e/profile-cold-outcome").ColdObservation;
type LiveObservation = import("../e2e/profile-cold-outcome").LiveObservation;
/** A value the schedule guarantees (an explicit failure, never a non-null assertion). */
const defined = <T>(value: T | null | undefined): T => {
  if (value === null || value === undefined)
    throw new Error("no observation where the schedule guarantees one");
  return value;
};
const mark = () => defined(observationMark());
const observed = (m: ReturnType<typeof mark>) => defined(observeColdOutcome(m));
const served = (
  requests = 1,
  effects: unknown = EFFECTS,
): import("../e2e/profile-cold-outcome").Served => ({
  bytes: BODY.length,
  requests,
  effects: effects as never,
  expectedEffects: EXPECTED,
});
/** An engine start: a new generation (the harness's `beginEpoch`), then the start's own `waiting/cache_not_valid` before its first tick. */
const begin = () => {
  generation += 1;
  harness.engineEpochs.push({
    generation,
    run: 1,
    trace: harness.engineTrace.length,
  });
};
const start = () => {
  begin();
  publish({ kind: "waiting", reason: "cache_not_valid" });
};
const requestStep = (catchingUp = true) => {
  trace("data.sync_tick", { why: "start", coalesced: false });
  publish({ kind: "running", catchingUp });
};
const endStep = (state: State, when = "after") => {
  publish(state);
  trace("data.sync_next", { when, state: state.kind });
};
const idle = { kind: "idle", lastSyncedAt: "t" };
const clone = <T>(x: T): T => structuredClone(x);

describe("observeColdOutcome (the page function) and classifyColdOutcome", () => {
  it("case: review 9's startup schedule: the start's waiting is not an end, nor is the running request; the step's idle end is admitted", () => {
    const m = mark();
    start();
    expect(observeColdOutcome(m)).toBeNull();
    requestStep();
    expect(observeColdOutcome(m)).toBeNull();
    commit();
    endStep(idle);
    const o = observeColdOutcome(m);
    expect(o).not.toBeNull();
    expect(o?.published.map((e) => e.state.kind)).toEqual([
      "waiting",
      "running",
      "idle",
    ]);
    expect(classifyColdOutcome(defined(o), served())).toEqual({
      outcome: "admitted",
      detail: JSON.stringify(idle),
      problems: [],
    });
  });

  it("case: review 9's observed schedule: a later poll that runs again does not change the observation already made", () => {
    const m = mark();
    start();
    requestStep();
    commit();
    endStep(idle);
    const first = observeColdOutcome(m);
    // The live-edge poll starts the next step: the state is `running` again.
    requestStep();
    expect(current?.kind).toBe("running");
    expect(observeColdOutcome(m)).toEqual(first);
    expect(classifyColdOutcome(defined(first), served(2)).outcome).toBe(
      "admitted",
    );
  });

  it("control: a genuine refusal (the engine stopped after the request) is refused, its detail the observed state", () => {
    const m = mark();
    start();
    requestStep();
    endStep({ kind: "stopped", cause: "device_capacity" }, "event");
    const o = observed(m);
    expect(classifyColdOutcome(o, served())).toEqual({
      outcome: "refused",
      detail: JSON.stringify({ kind: "stopped", cause: "device_capacity" }),
      problems: [],
    });
  });

  it("control: a W7 negative control's back-off after its request (its failed commit is the served page) is refused", () => {
    const m = mark();
    start();
    requestStep();
    commit(BODY.length, "failed");
    endStep({ kind: "backing_off", since: 1 });
    const o = observed(m);
    expect(o.commits).toHaveLength(1);
    expect(classifyColdOutcome(o, served()).outcome).toBe("refused");
  });

  it("case: a step before the request that ended waiting (no service yet) is not the observed operation", () => {
    const m = mark();
    start();
    trace("data.sync_tick", { why: "start", coalesced: false });
    trace("data.sync_next", { when: "event", state: "waiting" });
    expect(observeColdOutcome(m)).toBeNull();
    requestStep();
    commit();
    endStep(idle);
    expect(classifyColdOutcome(observed(m), served()).outcome).toBe("admitted");
  });

  it("case: a page with has_more is followed to its end; the measured figures are the FIRST commit's, not the last", () => {
    const m = mark();
    start();
    requestStep();
    commit(BODY.length);
    trace("data.sync_next", { when: "now", state: "running" });
    expect(observeColdOutcome(m)).toBeNull();
    trace("data.sync_tick", { why: "now", coalesced: false });
    trace("data.sync_commit", {
      bytes: 80,
      scan_ms: 0,
      commit_ms: 1,
      kind: "applied",
      value: "committed",
    });
    endStep(idle);
    const o = observed(m);
    expect(o.commits.map((c) => c.bytes)).toEqual([BODY.length, 80]);
    expect(classifyColdOutcome(o, served(2)).outcome).toBe("admitted");
  });

  it("case: a step that threw ends in the stop the engine publishes after its trace line, not before", () => {
    const m = mark();
    start();
    requestStep();
    trace("data.sync_step_failed");
    expect(observeColdOutcome(m)).toBeNull();
    publish({ kind: "stopped", cause: "local_storage" });
    const o = observed(m);
    expect(o.step_end).toMatchObject({
      event: "data.sync_step_failed",
      recorded: null,
    });
    expect(classifyColdOutcome(o, served()).outcome).toBe("refused");
  });

  it("case: a request step that ended waiting for the session is an error, not a refusal", () => {
    const m = mark();
    start();
    requestStep();
    endStep({ kind: "waiting", reason: "paused_by_session" }, "event");
    const c = classifyColdOutcome(observed(m), served());
    expect(c.outcome).toBe("error");
    expect(c.problems).toEqual([
      "the step ended waiting (paused_by_session): not a verdict on the page",
    ]);
  });

  it("control: a request step that ended waiting for a valid cache (an admitted invalidation) is refused", () => {
    const m = mark();
    start();
    requestStep();
    endStep({ kind: "waiting", reason: "cache_not_valid" }, "event");
    expect(classifyColdOutcome(observed(m), served()).outcome).toBe("refused");
  });

  it("case: idle without the served page's applied commit, another page's bytes, or no request at the stub, is an error", () => {
    const m = mark();
    start();
    requestStep();
    endStep(idle);
    expect(classifyColdOutcome(observed(m), served()).problems).toEqual([
      "idle without the served page's applied commit",
    ]);
    // Another page's bytes: the engine committed 7 bytes after the request.
    const m2 = mark();
    begin();
    requestStep();
    commit(7);
    endStep(idle);
    expect(classifyColdOutcome(observed(m2), served()).problems).toEqual([
      `the first commit after the request is 7 bytes, not the served ${BODY.length}`,
    ]);
    const m3 = mark();
    begin();
    requestStep();
    commit();
    endStep(idle);
    expect(classifyColdOutcome(observed(m3), served(0)).problems).toEqual([
      "no /sync request reached the stub",
    ]);
  });

  it("case: a contradictory record (a step end recording another state, or an end while running) is an error, never a refusal", () => {
    const m = mark();
    start();
    requestStep();
    endStep({ kind: "stopped", cause: "floor" }, "event");
    const o = observed(m);
    const mismatched = clone(o);
    mismatched.step_end.recorded = "idle";
    expect(classifyColdOutcome(mismatched, served()).outcome).toBe("error");
    // The engine traced a step end recording `stopped` while `running` is the last thing it published.
    const m2 = mark();
    begin();
    requestStep();
    trace("data.sync_next", { when: "event", state: "stopped" });
    const running = observed(m2);
    expect(running.terminal.state.kind).toBe("running");
    const c = classifyColdOutcome(running, served());
    expect(c.outcome).toBe("error");
    expect(c.problems).toContain(
      "no state was published after the request before its end (the terminal is the request itself)",
    );
  });

  it("case: states and trace before the mark (an earlier engine run) are not this run's", () => {
    begin();
    publish({ kind: "running", catchingUp: true });
    trace("data.sync_next", { when: "after", state: "running" });
    publish({ kind: "idle", lastSyncedAt: "old" });
    trace("data.sync_next", { when: "after", state: "idle" });
    const m = mark();
    expect(observeColdOutcome(m)).toBeNull();
    start();
    trace("data.sync_tick", { why: "start", coalesced: false });
    publish({ kind: "running", catchingUp: true });
    commit();
    publish({ kind: "idle", lastSyncedAt: "new" });
    trace("data.sync_next", { when: "after", state: "idle" });
    const o = observed(m);
    expect(o.generation).toBe(2);
    expect(o.terminal.state).toEqual({ kind: "idle", lastSyncedAt: "new" });
    expect(classifyColdOutcome(o, served()).outcome).toBe("admitted");
  });

  it("case (revision 10, DA-1): a has_more schedule of more than 40 publications keeps every one; its first commit stays the measured page's", () => {
    const m = mark();
    start();
    requestStep(true);
    commit(BODY.length);
    // Each continuation publishes a distinct running state (catchingUp toggles), so every one is published and kept.
    for (let i = 0; i < 30; i += 1) {
      trace("data.sync_next", { when: "now", state: "running" });
      trace("data.sync_tick", { why: "now", coalesced: false });
      publish({ kind: "running", catchingUp: i % 2 === 0 });
      trace("data.sync_commit", {
        bytes: 80,
        scan_ms: 0,
        commit_ms: 1,
        kind: "applied",
        value: "committed",
      });
      publish({ kind: "running", catchingUp: i % 2 !== 0 });
    }
    endStep(idle);
    const o = observed(m);
    expect(o.published.length).toBeGreaterThan(40);
    expect(o.published.at(-1)?.state).toEqual(idle);
    expect(o.commits).toHaveLength(31);
    expect(o.commits[0]?.bytes).toBe(BODY.length);
    expect(classifyColdOutcome(o, served(31))).toEqual({
      outcome: "admitted",
      detail: JSON.stringify(idle),
      problems: [],
    });
  });

  it("control (revision 10): a refusal after a has_more continuation keeps the measured page's earlier applied commit and is refused", () => {
    const m = mark();
    start();
    requestStep();
    commit(BODY.length);
    trace("data.sync_next", { when: "now", state: "running" });
    trace("data.sync_tick", { why: "now", coalesced: false });
    endStep({ kind: "backing_off", since: 3 });
    const o = observed(m);
    expect(o.commits.map((c) => c.bytes)).toEqual([BODY.length]);
    expect(classifyColdOutcome(o, served(2)).outcome).toBe("refused");
  });

  it("case (revision 10, DA-1): a failed step followed by an idle publication is an error, not an admission", () => {
    const m = mark();
    start();
    requestStep();
    commit();
    trace("data.sync_step_failed");
    publish(idle);
    const c = classifyColdOutcome(observed(m), served());
    expect(c.outcome).toBe("error");
    expect(c.problems).toEqual([
      "a failed step ends in stopped/local_storage, not idle",
    ]);
  });

  it("case (revision 10, DA-1): a first commit without its bytes, or an idle published before the served page's commit, is an error", () => {
    const m = mark();
    start();
    requestStep();
    trace("data.sync_commit", {
      scan_ms: 4,
      commit_ms: 28,
      kind: "applied",
      value: "committed",
    });
    endStep(idle);
    expect(classifyColdOutcome(observed(m), served()).problems).toEqual([
      "the first commit after the request does not record its bytes",
    ]);
    const m2 = mark();
    begin();
    requestStep();
    publish(idle);
    commit();
    trace("data.sync_next", { when: "after", state: "idle" });
    expect(classifyColdOutcome(observed(m2), served()).problems).toEqual([
      "the idle state was published before the served page's commit",
    ]);
  });

  it("case (revision 10, review 10's records): a witness edited after the fact (equal or reversed indices, deleted bytes, an earlier step end) is an error", () => {
    const m = mark();
    start();
    requestStep();
    commit();
    endStep(idle);
    const o = observed(m);
    expect(classifyColdOutcome(o, served()).outcome).toBe("admitted");
    const equal = clone(o);
    equal.terminal.index = equal.request.index;
    expect(classifyColdOutcome(equal, served()).problems).toEqual([
      "the recorded terminal state is not the step end's",
    ]);
    const reversed = clone(o);
    reversed.terminal.at = reversed.request.at - 1;
    reversed.step_end.trace = reversed.request.trace - 1;
    expect(classifyColdOutcome(reversed, served()).problems).toEqual([
      "the recorded step end is not the request step's end",
      "the recorded terminal state is not the step end's",
    ]);
    const deleted = clone(o) as ColdObservation;
    delete deleted.commits[0]?.bytes;
    for (const e of deleted.events)
      if (e.event === "data.sync_commit") delete e.payload?.bytes;
    expect(classifyColdOutcome(deleted, served()).problems).toEqual([
      "the first commit after the request does not record its bytes",
    ]);
  });

  it("case (revision 10, invariant 1): a reload or another engine start while observing ends the observation without a verdict", () => {
    const m = mark();
    start();
    requestStep();
    begin();
    publish({ kind: "waiting", reason: "cache_not_valid" });
    expect(() => observeColdOutcome(m)).toThrow(
      "observation identity: the engine was started again while observing",
    );
    const m2 = mark();
    begin();
    requestStep();
    harness.page = "page-2";
    commit();
    endStep(idle);
    expect(() => observeColdOutcome(m2)).toThrow(
      "observation identity: the page was replaced (a reload) while observing",
    );
  });
});

// ---- revision 12 (review 12's R2 follow-up; design assessment DA-C1, Q1/Q2): the measured attempt and what it wrote -----------------
const lapsedRetryToIdle = () => {
  // Production (sync-engine.ts): the measured page's every admission round lapsed, so the outcome traced is applied/lease_lapsed; the step
  // returns `dropped("unverified")` WITHOUT publishing (the state stays running) and the loop traces its end recording running; the paced
  // retry asks again, the stub answers its empty page, which commits, and the engine publishes idle.
  start();
  requestStep();
  commit(BODY.length, "applied", "lease_lapsed");
  trace("data.sync_next", { when: "after", state: "running" });
};
const retryEmptyToIdle = () => {
  trace("data.sync_tick", { why: "timer", coalesced: false });
  emptyCommit();
  endStep(idle);
};

it("case R12-C1 (review 12): a measured lease_lapsed attempt ends the observation at its own running end; the retry's empty idle can never stand for it", () => {
  const m = mark();
  lapsedRetryToIdle();
  // Complete at the attempt's own end (an assertion, so an observer that waits on is caught as one).
  expect(observeColdOutcome(m)).not.toBeNull();
  const o = observed(m);
  expect(o.method).toBe("engine-state-log/3");
  expect(o.step_end).toMatchObject({
    event: "data.sync_next",
    recorded: "running",
  });
  expect(o.terminal.state.kind).toBe("running");
  // The retry and its idle come later: the observation already made is unchanged.
  retryEmptyToIdle();
  expect(observeColdOutcome(m)).toEqual(o);
  const c = classifyColdOutcome(o, served(2));
  expect(c.outcome).toBe("error");
  // (The engine published nothing after the request: its running end rests on the request's own publication.)
  expect(c.problems).toEqual([
    "the measured page was not written (value lease_lapsed) and the engine asked again: a later response cannot stand for it",
    "no state was published after the request before its end (the terminal is the request itself)",
  ]);
});

it("case R12-C2 (review 12's diagnostic, labelled corrected counterpart): the revision-11 witness of that schedule (walked on to the retry's idle) is an error, not an admission", () => {
  const m = mark();
  lapsedRetryToIdle();
  retryEmptyToIdle();
  const o = observed(m);
  // The witness revision 11's observer made of the same history: every event to the retry's idle end, its terminal the idle.
  const walked = clone(o);
  const end = harness.engineTrace.length - 1;
  walked.events = harness.engineTrace
    .map((line, trace) => ({ line, trace }))
    .filter(({ line }) =>
      ["data.sync_commit", "data.sync_next", "data.sync_step_failed"].includes(
        line.split(" ")[1] ?? "",
      ),
    )
    .map(({ line, trace }) => ({
      trace,
      event: line.split(" ")[1] ?? "",
      payload: JSON.parse(line.slice(line.indexOf("{"))),
    }));
  const last = harness.engineStates.length - 1;
  walked.published = harness.engineStates.map((e, index) => ({
    index,
    generation: e.generation,
    at: e.at,
    trace: e.trace,
    state: e.state,
  }));
  walked.terminal = {
    index: last,
    at: walked.published[last]?.at ?? 0,
    trace: walked.published[last]?.trace ?? 0,
    state: idle,
  };
  walked.step_end = { trace: end, event: "data.sync_next", recorded: "idle" };
  walked.commits = walked.events
    .filter((e) => e.event === "data.sync_commit")
    .map((e) => e.payload ?? {});
  const c = classifyColdOutcome(walked, served(2));
  expect(c.outcome).toBe("error");
  expect(c.problems).toContain(
    "the measured page was not written (value lease_lapsed) and the engine asked again: a later response cannot stand for it",
  );
});

it("control R12-C3: an internal lapse of an admission round followed by a committed round within the same request (one committed line) is admitted", () => {
  const m = mark();
  start();
  requestStep();
  // admitAndCommit retries a lapsed round inside the step and traces only the final outcome.
  commit(BODY.length, "applied", "committed");
  endStep(idle);
  expect(classifyColdOutcome(observed(m), served())).toEqual({
    outcome: "admitted",
    detail: JSON.stringify(idle),
    problems: [],
  });
});

it("control R12-C4: a committed has_more measured page continues to the stub's committed empty page and idle; the measured page's figures are kept", () => {
  const m = mark();
  start();
  requestStep();
  commit();
  trace("data.sync_next", { when: "now", state: "running" });
  expect(observeColdOutcome(m)).toBeNull();
  trace("data.sync_tick", { why: "now", coalesced: false });
  emptyCommit();
  endStep(idle);
  const o = observed(m);
  expect(o.commits.map((c) => [c.bytes, c.value])).toEqual([
    [BODY.length, "committed"],
    [80, "committed"],
  ]);
  expect(classifyColdOutcome(o, served(2)).outcome).toBe("admitted");
});

it("control R12-C5: applied/not_ready, published waiting for a valid cache, is a genuine refusal with its diagnostic commit kept", () => {
  const m = mark();
  start();
  requestStep();
  commit(BODY.length, "applied", "not_ready");
  endStep({ kind: "waiting", reason: "cache_not_valid" }, "event");
  const o = observed(m);
  expect(o.commits[0]?.value).toBe("not_ready");
  expect(classifyColdOutcome(o, served()).outcome).toBe("refused");
});

it("case R12-C6: not_ready, a missing value or an unknown value paired with a claimed idle is an error naming what the commit wrote", () => {
  for (const [value, says] of [
    ["not_ready", "value not_ready"],
    [null, "value missing"],
    ["written", "value written"],
  ] as const) {
    const m = mark();
    begin();
    publish({ kind: "waiting", reason: "cache_not_valid" });
    requestStep();
    commit(BODY.length, "applied", value);
    endStep(idle);
    expect(classifyColdOutcome(observed(m), served()).problems).toEqual([
      `idle, but the served page's commit wrote no page (${says})`,
    ]);
  }
});

it("case R12-C7: a dropped measured commit or an unestablished admission (no commit) that asked again ends the observation with no verdict", () => {
  const m = mark();
  start();
  requestStep();
  trace("data.sync_commit", {
    bytes: BODY.length,
    scan_ms: 4,
    commit_ms: 28,
    kind: "dropped",
    reason: "position",
  });
  trace("data.sync_next", { when: "now", state: "running" });
  expect(observeColdOutcome(m)).not.toBeNull();
  const dropped = observed(m);
  retryEmptyToIdle();
  expect(classifyColdOutcome(dropped, served(2)).problems[0]).toBe(
    "the measured page was not written (a dropped commit) and the engine asked again: a later response cannot stand for it",
  );
  const m2 = mark();
  begin();
  publish({ kind: "waiting", reason: "cache_not_valid" });
  requestStep();
  trace("data.sync_next", { when: "after", state: "running" });
  expect(observeColdOutcome(m2)).not.toBeNull();
  const none = observed(m2);
  retryEmptyToIdle();
  expect(classifyColdOutcome(none, served(2)).problems[0]).toBe(
    "the measured page was not written (no commit) and the engine asked again: a later response cannot stand for it",
  );
});

it("case R12-C8: a committed measured page whose own step ended in a refusal is a contradiction; a refusal after its continuation stays a refusal", () => {
  const m = mark();
  start();
  requestStep();
  commit();
  endStep({ kind: "stopped", cause: "storage_full" }, "event");
  expect(classifyColdOutcome(observed(m), served()).problems).toEqual([
    "the served page was committed, but its step ended stopped: a committed page ends idle or running",
  ]);
  const m2 = mark();
  begin();
  publish({ kind: "waiting", reason: "cache_not_valid" });
  requestStep();
  commit();
  trace("data.sync_next", { when: "now", state: "running" });
  trace("data.sync_tick", { why: "now", coalesced: false });
  endStep({ kind: "stopped", cause: "storage_full" }, "event");
  expect(classifyColdOutcome(observed(m2), served(2))).toEqual({
    outcome: "refused",
    detail: JSON.stringify({ kind: "stopped", cause: "storage_full" }),
    problems: [],
  });
});

it("control R12-C9: a failed step after a committed page ends in its local_storage stop and is refused (the commit retained)", () => {
  const m = mark();
  start();
  requestStep();
  commit();
  trace("data.sync_step_failed");
  publish({ kind: "stopped", cause: "local_storage" });
  const o = observed(m);
  expect(o.commits[0]?.value).toBe("committed");
  expect(classifyColdOutcome(o, served()).outcome).toBe("refused");
});

it("case R12-C10: a committed idle run whose cache is not the served page's (zero rows, change count instead of surviving rows, another version), or unread, is an error", () => {
  const m = mark();
  start();
  requestStep();
  commit();
  endStep(idle);
  const o = observed(m);
  const say = (effects: unknown) =>
    classifyColdOutcome(o, served(1, effects)).problems;
  expect(say({ ...EFFECTS, rows: 0, entries_sha256: sha("") })).toEqual([
    "the cache holds 0 rows; the served page leaves 3",
  ]);
  // Six changes are not six rows (W4's 800 changes leave 80).
  expect(say({ ...EFFECTS, rows: 6 })).toEqual([
    "the cache holds 6 rows; the served page leaves 3",
  ]);
  // A@1 survived instead of A@2: the last write did not win.
  expect(
    say({
      ...EFFECTS,
      entries_sha256: sha([`${A}@1`, `${B}@1`, `${C}@1`].join("\n")),
    }),
  ).toEqual(["the cache's rows are not the ones the served page leaves"]);
  expect(say(null)).toEqual(["the cache the run left was not recorded"]);
  // A refusal is never judged by its effects.
  expect(
    classifyColdOutcome(o, { ...served(1, null), expectedEffects: null })
      .outcome,
  ).toBe("error");
});

it("case R12-C11: a witness of the revision-11 method (engine-state-log/2) is no longer evidence", () => {
  const m = mark();
  start();
  requestStep();
  commit();
  endStep(idle);
  const old = clone(observed(m)) as ColdObservation;
  (old as { method: string }).method = "engine-state-log/2";
  expect(classifyColdOutcome(old, served()).problems).toEqual([
    "observation method engine-state-log/2 is not engine-state-log/3",
  ]);
});

describe("observeLiveOutcome and classifyLiveOutcome", () => {
  // Revision 11 (review 11's R2 follow-up; design assessment DA-L1, DA-H1, M1-M9): the live schedules are written from the production
  // engine (src/data/engine/sync-engine.ts), WITH its step ends. A step publishes running (an identical state is not published again),
  // traces its commits, publishes the state it ends in and returns; the loop then traces `data.sync_next` recording the state published
  // last. `has_more` ends with running and the engine ticks again at once; a step that throws traces `data.sync_step_failed` and then
  // publishes stopped/local_storage. An applied commit carries the plan's result (`value: "committed"`). Revision 10's live schedules
  // published idle or stopped WITHOUT the end (DA-H1); they are kept below as incomplete controls.
  const BIG = 1_000_000;
  /** The witness the schedule guarantees (asserted, so a missing one is an assertion failure). */
  const live = (least: number, m: ReturnType<typeof mark>) => {
    const o = observeLiveOutcome({ least, mark: m });
    expect(o).not.toBeNull();
    return defined(o);
  };
  const lines = () => [...harness.engineTrace];
  const classify = (
    o: LiveObservation,
    captured = BIG,
    traceLines = lines(),
    tracePage: string | null = harness.page,
  ) =>
    classifyLiveOutcome(o, { capturedBytes: captured, traceLines, tracePage });
  /** Publishes `state` unless it is the current one (the engine's `sameStop`). */
  const show = (state: State) => {
    if (JSON.stringify(current) !== JSON.stringify(state)) publish(state);
  };
  const tick = (why = "now") =>
    trace("data.sync_tick", { why, coalesced: false });
  const running = { kind: "running", catchingUp: true };
  const pageCommit = (bytes: number, kind = "applied", value = "committed") =>
    trace("data.sync_commit", {
      bytes,
      scan_ms: bytes === BIG ? 20 : 1,
      commit_ms: bytes === BIG ? 300 : 2,
      kind,
      ...(kind === "applied" ? { value } : { reason: "unverified" }),
    });
  /** A step's normal end: the state it ended in (if any), then the line recording the state published last. */
  const stepEnd = (state: State | null, when: string) => {
    if (state) show(state);
    trace("data.sync_next", { when, state: current?.kind });
  };
  const failedEnd = () => trace("data.sync_step_failed");
  const localStop = { kind: "stopped", cause: "local_storage" };
  /** A whole has_more page then the dense page, ending idle: the healthy live schedule (M1). */
  const healthy = () => {
    start();
    tick("start");
    show(running);
    pageCommit(8_035);
    stepEnd(null, "now");
    tick();
    show(running);
    pageCommit(BIG);
    stepEnd(idle, "after");
  };
  /** Replaces the retained line at `at` in the witness and in `lines` alike (both representations of one raw trace). */
  const rewrite = (
    o: LiveObservation,
    all: string[],
    at: number,
    line: string,
  ) => {
    all[at] = line;
    for (const e of o.events) if (e.trace === at) e.line = line;
  };

  it("control (M1): a dense commit, the idle it leads to and the idle end are admitted; the witness retains them and a later running poll changes nothing", () => {
    const m = mark();
    start();
    tick("start");
    show(running);
    pageCommit(8_035);
    stepEnd(null, "now");
    expect(observeLiveOutcome({ least: BIG, mark: m })).toBeNull();
    tick();
    show(running);
    pageCommit(BIG);
    show(idle);
    // The idle is published, but its step end is not traced yet: not complete.
    expect(observeLiveOutcome({ least: BIG, mark: m })).toBeNull();
    trace("data.sync_next", { when: "after", state: "idle" });
    const o = live(BIG, m);
    tick("timer");
    show(running);
    expect(classify(o)).toEqual({ outcome: "admitted", problems: [] });
    expect(o.method).toBe("live-dense-commit/3");
    expect(o.published.map((e) => e.state.kind)).toEqual([
      "waiting",
      "running",
      "idle",
    ]);
    expect(o.events.map((e) => e.trace)).toEqual([1, 2, 4, 5]);
    expect(o.dense?.trace).toBe(4);
    expect(o.step_end).toEqual({
      trace: 5,
      event: "data.sync_next",
      recorded: "idle",
    });
    expect(o.state_entry).toEqual(o.published[2]);
    expect(o.boundary).toBe(6);
  });

  it("case (review 11, M2): replacing only the idle end by a stopped, failed-step or running end, its commits unchanged, is an error naming the step end", () => {
    const m = mark();
    healthy();
    const o = live(BIG, m);
    const end = o.step_end.trace;
    const prefix = (o.events.find((e) => e.trace === end)?.line ?? "").split(
      " ",
    )[0];
    // Each replacement edits every representation of that one trace line (the trace, the retained line and the step-end claim), so
    // only the terminal relation can refuse it.
    const cases: Array<[string, LiveObservation["step_end"], string[]]> = [
      [
        `${prefix} data.sync_next ${JSON.stringify({ when: "event", state: "stopped" })}`,
        { trace: end, event: "data.sync_next", recorded: "stopped" },
        [
          `the step end at trace ${end} records stopped, but idle was published`,
        ],
      ],
      [
        `${prefix} data.sync_step_failed `,
        { trace: end, event: "data.sync_step_failed", recorded: null },
        [
          "the failed step's stop is not retained inside the observation",
          "the observed state is not the publication its step end rests on",
        ],
      ],
      [
        `${prefix} data.sync_next ${JSON.stringify({ when: "now", state: "running" })}`,
        { trace: end, event: "data.sync_next", recorded: "running" },
        [
          `the step end at trace ${end} records running, but idle was published`,
        ],
      ],
    ];
    for (const [line, claim, problems] of cases) {
      const edited = clone(o);
      const all = lines();
      rewrite(edited, all, end, line);
      edited.step_end = claim;
      expect(classify(edited, BIG, all)).toEqual({
        outcome: "error",
        problems,
      });
    }
    // The review's original form (the trace file edited, the witness not) is refused by the binding.
    const all = lines();
    all[end] = cases[0]?.[0] ?? "";
    expect(classify(o, BIG, all)).toEqual({
      outcome: "error",
      problems: [
        "the retained step events are not the page's trace lines at their positions",
      ],
    });
  });

  it("case (review 11, M2): in the page, a completed contradictory end (stopped or running recorded over the published idle) is returned for the rules to refuse, not waited past", () => {
    for (const recorded of ["stopped", "running"]) {
      const m = mark();
      start();
      tick("start");
      show(running);
      pageCommit(BIG);
      show(idle);
      trace("data.sync_next", { when: "after", state: recorded });
      const o = live(BIG, m);
      expect(o.step_end.recorded).toBe(recorded);
      expect(o.state_entry.state.kind).toBe("idle");
      expect(classify(o)).toEqual({
        outcome: "error",
        problems: [
          `the step end at trace ${o.step_end.trace} records ${recorded}, but idle was published`,
        ],
      });
      begin();
    }
  });

  it("case (M3): a missing, malformed, pre-epoch or outside-boundary end is an error, and a convenient idle end after the boundary does not repair it", () => {
    const m = mark();
    healthy();
    const o = live(BIG, m);
    // The end removed from the witness, the trace keeping it.
    const removed = clone(o);
    removed.events = removed.events.filter((e) => e.trace !== 5);
    expect(classify(removed).problems).toEqual([
      "the trace's step event at 5, inside the observation, was not retained",
      "no step end inside the observation ends it (idle after the dense commit, or a stop)",
    ]);
    // Removed from both, the boundary drawn before it; a matching idle end is then appended after the boundary.
    const cut = clone(o);
    cut.events = cut.events.filter((e) => e.trace !== 5);
    cut.boundary = 5;
    const suffixed = [...lines()];
    expect(classify(cut, BIG, suffixed).problems).toEqual([
      "no step end inside the observation ends it (idle after the dense commit, or a stop)",
    ]);
    // The end malformed (no payload).
    const malformed = clone(o);
    const all = lines();
    rewrite(malformed, all, 5, "6ms data.sync_next not-json");
    expect(classify(malformed, BIG, all).problems).toEqual([
      "step event 3 is malformed or unknown",
    ]);
    // The end placed at the boundary (outside the observation), the trace extended to hold it there.
    const outside = clone(o);
    const longer = [...lines(), lines()[5] ?? ""];
    const last = outside.events[3];
    if (last) last.trace = 6;
    longer[5] = `6ms data.sync_tick ${JSON.stringify({ why: "timer", coalesced: false })}`;
    expect(classify(outside, BIG, longer).problems).toEqual([
      "step event 3 lies outside the observation's epoch and boundary",
      "no step end inside the observation ends it (idle after the dense commit, or a stop)",
    ]);
    // An end that follows no publication (every publication moved after it, in order).
    const orphan = clone(o);
    for (const p of orphan.published) p.trace = Math.max(p.trace, 3);
    orphan.state_entry = clone(orphan.published[2] ?? orphan.state_entry);
    expect(classify(orphan).problems).toEqual([
      "the step end at trace 2 follows no published state",
      "the recorded step end is not the one that ends the observation",
      "the observed state is not the publication its step end rests on",
    ]);
    // An end before the epoch (the witness's epoch moved after the dense page's step).
    const early = clone(o);
    const epoch = early.epochs[0];
    if (epoch) epoch.trace = 6;
    expect(classify(early).problems).toContain(
      "step event 0 lies outside the observation's epoch and boundary",
    );
  });

  it("control (M4): pages with has_more end in running and are followed; the first dense commit is the one retained, through several continuations", () => {
    const m = mark();
    start();
    tick("start");
    show(running);
    pageCommit(8_035);
    stepEnd(null, "now");
    tick();
    pageCommit(BIG);
    stepEnd(null, "now");
    expect(observeLiveOutcome({ least: BIG, mark: m })).toBeNull();
    tick();
    pageCommit(BIG);
    stepEnd(null, "now");
    tick();
    pageCommit(500);
    stepEnd(idle, "after");
    const o = live(BIG, m);
    expect(o.dense?.trace).toBe(4);
    expect(classify(o)).toEqual({ outcome: "admitted", problems: [] });
    // Citing the second dense commit instead is refused: the first is the measured one.
    const second = clone(o);
    second.dense = {
      trace: 7,
      commit: JSON.parse(
        (lines()[7] ?? "").slice((lines()[7] ?? "").indexOf("{")),
      ),
    };
    expect(classify(second).problems).toEqual([
      "an earlier commit of the epoch already met the density: the observed commit is not the first dense one",
    ]);
  });

  it("control (M5): a back-off end is waited out; the retry's dense commit and idle end are admitted (no premature live refusal)", () => {
    const m = mark();
    start();
    tick("start");
    show(running);
    stepEnd({ kind: "backing_off", since: 1 }, "after");
    expect(observeLiveOutcome({ least: BIG, mark: m })).toBeNull();
    tick("timer");
    show(running);
    pageCommit(BIG);
    stepEnd(idle, "after");
    const o = live(BIG, m);
    expect(classify(o)).toEqual({ outcome: "admitted", problems: [] });
    expect(o.published.map((e) => e.state.kind)).toEqual([
      "waiting",
      "running",
      "backing_off",
      "running",
      "idle",
    ]);
  });

  it("control (M6): a normal stopped end without a dense commit, a failed step's local_storage stop, and a stop after a dense has_more continuation are refusals", () => {
    const m = mark();
    start();
    tick("start");
    show(running);
    stepEnd({ kind: "stopped", cause: "storage_full" }, "event");
    const plain = live(BIG, m);
    expect(plain.dense).toBeNull();
    expect(classify(plain)).toEqual({ outcome: "refused", problems: [] });
    const m2 = mark();
    begin();
    publish({ kind: "waiting", reason: "cache_not_valid" });
    tick("start");
    show(running);
    failedEnd();
    publish(localStop);
    const failed = live(BIG, m2);
    expect(failed.step_end).toEqual({
      trace: failed.events.at(-1)?.trace,
      event: "data.sync_step_failed",
      recorded: null,
    });
    expect(classify(failed)).toEqual({ outcome: "refused", problems: [] });
    const m3 = mark();
    begin();
    publish({ kind: "waiting", reason: "cache_not_valid" });
    tick("start");
    show(running);
    pageCommit(BIG);
    stepEnd(null, "now");
    tick();
    stepEnd({ kind: "stopped", cause: "floor" }, "event");
    const later = live(BIG, m3);
    expect(later.dense).not.toBeNull();
    expect(classify(later)).toEqual({ outcome: "refused", problems: [] });
  });

  it("case (M7): between a failed step's line and its stop the observation waits; a stop of another cause, or one published before the line, is an error", () => {
    const m = mark();
    start();
    tick("start");
    show(running);
    failedEnd();
    expect(observeLiveOutcome({ least: BIG, mark: m })).toBeNull();
    publish(localStop);
    const o = live(BIG, m);
    expect(classify(o).outcome).toBe("refused");
    const cause = clone(o);
    const stop = cause.published.at(-1);
    if (stop) stop.state = { kind: "stopped", cause: "floor" };
    cause.state_entry = clone(stop ?? cause.state_entry);
    expect(classify(cause).problems).toEqual([
      "a failed step ends in stopped/local_storage, not stopped",
    ]);
    const idleAfter = clone(o);
    const after = idleAfter.published.at(-1);
    if (after) after.state = idle;
    idleAfter.state_entry = clone(after ?? idleAfter.state_entry);
    expect(classify(idleAfter).problems).toEqual([
      "a failed step ends in stopped/local_storage, not idle",
    ]);
    // Reversed: the stop published before the failure line (its trace position not after it).
    const reversed = clone(o);
    const moved = reversed.published.at(-1);
    if (moved) moved.trace = reversed.step_end.trace;
    expect(classify(reversed).problems).toEqual([
      "the failed step's stop is not retained inside the observation",
      "the observed state is not the publication its step end rests on",
    ]);
    // Another step event traced between the failure and its stop.
    const m2 = mark();
    begin();
    publish({ kind: "waiting", reason: "cache_not_valid" });
    tick("start");
    show(running);
    failedEnd();
    trace("data.sync_next", { when: "now", state: "running" });
    publish(localStop);
    expect(classify(live(BIG, m2)).problems).toEqual([
      "another step event lies between the failed step and its stop",
    ]);
  });

  it("case (M8): what follows the boundary (a later running poll, a failure, a restart) neither changes nor repairs a frozen witness", () => {
    const m = mark();
    healthy();
    const o = live(BIG, m);
    tick("timer");
    show(running);
    stepEnd(null, "after");
    failedEnd();
    publish(localStop);
    begin();
    publish({ kind: "waiting", reason: "cache_not_valid" });
    expect(lines().length).toBeGreaterThan(o.boundary);
    expect(classify(o)).toEqual({ outcome: "admitted", problems: [] });
  });

  it("case (M9): a reload or second start while observing throws; a trace read from another page instance, or a replaced trace, is an error", () => {
    const m = mark();
    healthy();
    const o = live(BIG, m);
    expect(classify(o, BIG, lines(), "page-2").problems).toEqual([
      "the retained live trace was not read from the observation's page instance",
    ]);
    // The page reloaded after the witness: a fresh trace, its own timings.
    const fresh = lines().map((l) =>
      l.replace(/^\d+ms/, (t) => `${Number.parseInt(t, 10) + 1000}ms`),
    );
    expect(classify(o, BIG, fresh, harness.page).problems).toEqual([
      "the retained step events are not the page's trace lines at their positions",
    ]);
    const m2 = mark();
    begin();
    publish({ kind: "waiting", reason: "cache_not_valid" });
    tick("start");
    show(running);
    begin();
    expect(() => observeLiveOutcome({ least: BIG, mark: m2 })).toThrow(
      "observation identity: the engine was started again while observing",
    );
    const m3 = mark();
    begin();
    publish({ kind: "waiting", reason: "cache_not_valid" });
    publish({ kind: "running", catchingUp: true }, generation + 7);
    expect(() => observeLiveOutcome({ least: BIG, mark: m3 })).toThrow(
      "observation identity: another engine published while observing",
    );
    // A step end traced in the epoch before its engine published anything is not this engine's.
    const m5 = mark();
    begin();
    trace("data.sync_next", { when: "now", state: "running" });
    publish({ kind: "waiting", reason: "cache_not_valid" });
    expect(() => observeLiveOutcome({ least: BIG, mark: m5 })).toThrow(
      "observation identity: a step end of the epoch follows no state its engine published",
    );
    const m4 = mark();
    begin();
    harness.page = "page-2";
    expect(() => observeLiveOutcome({ least: BIG, mark: m4 })).toThrow(
      "observation identity: the page was replaced (a reload) while observing",
    );
  });

  it("case (revision 10, DA-2): the density is judged against the verified capture: below 90% is an error, exactly 90% and above are admitted", () => {
    const m = mark();
    start();
    tick("start");
    show(running);
    pageCommit(900_000);
    stepEnd(idle, "after");
    const o = live(BIG, m);
    expect(classify(o, BIG).outcome).toBe("admitted");
    expect(classify(o, 900_000).outcome).toBe("admitted");
    expect(classify(o, 1_000_002)).toEqual({
      outcome: "error",
      problems: [
        "the dense commit is 900000 bytes, below 90% of the captured 1000002",
        "no step end inside the observation ends it (idle after the dense commit, or a stop)",
      ],
    });
  });

  it("case (revision 10, DA-2): review 10's invented dense commits (zero bytes; 999,999,999 bytes absent from the trace) are errors", () => {
    const m = mark();
    healthy();
    const o = live(BIG, m);
    const zero = clone(o);
    if (zero.dense) zero.dense.commit = { kind: "applied", bytes: 0 };
    expect(classify(zero).problems).toEqual([
      "the dense commit is 0 bytes, below 90% of the captured 1000000",
      "the dense commit's scan_ms is not a time",
      "the dense commit's commit_ms is not a time",
      "the dense commit is not the retained trace's commit at its position",
    ]);
    const invented = clone(o);
    if (invented.dense)
      invented.dense.commit = {
        bytes: 999_999_999,
        scan_ms: 999,
        commit_ms: 999,
        kind: "applied",
        value: "committed",
      };
    expect(classify(invented).problems).toEqual([
      "the dense commit is not the retained trace's commit at its position",
    ]);
  });

  it("case (revision 10, DA-2): a dense commit before the epoch does not qualify; one after it inside the epoch does", () => {
    // A large commit by an earlier engine, before the mark.
    begin();
    pageCommit(BIG);
    const m = mark();
    start();
    tick("start");
    show(running);
    stepEnd(idle, "after");
    // Idle without the dense page is a continuation, not an end.
    expect(observeLiveOutcome({ least: BIG, mark: m })).toBeNull();
    tick("timer");
    show(running);
    pageCommit(BIG);
    stepEnd(idle, "after");
    const o = live(BIG, m);
    expect(classify(o).outcome).toBe("admitted");
    // The same witness pointing at the earlier engine's commit is refused.
    const early = clone(o);
    if (early.dense) early.dense.trace = 0;
    expect(classify(early).problems).toEqual([
      "the dense commit lies outside the observation's epoch and boundary",
      "the dense commit is not the retained trace's commit at its position",
    ]);
  });

  it("case (revision 10, DA-2): a dense commit claimed at the boundary, or an idle published before the dense commit, is not corroboration", () => {
    const m = mark();
    healthy();
    const o = live(BIG, m);
    const after = clone(o);
    if (after.dense) after.dense.trace = after.boundary;
    expect(classify(after).problems).toContain(
      "the dense commit lies outside the observation's epoch and boundary",
    );
    // The idle publication moved to the dense commit's own position (consistently in the slice and the claim).
    const before = clone(o);
    const entry = before.published[2];
    if (entry) entry.trace = before.dense?.trace ?? 0;
    before.state_entry = clone(entry ?? before.state_entry);
    expect(classify(before).problems).toEqual([
      "the idle state was not published after the dense commit",
    ]);
  });

  it("case (revision 11): a dense commit that was not applied, or applied no page (a lapsed lease), is no admission", () => {
    const m = mark();
    start();
    tick("start");
    show(running);
    pageCommit(BIG, "dropped");
    stepEnd(null, "after");
    tick("timer");
    show(running);
    pageCommit(BIG);
    stepEnd(idle, "after");
    expect(classify(live(BIG, m))).toEqual({
      outcome: "error",
      problems: ["the dense commit was not applied"],
    });
    const m2 = mark();
    begin();
    publish({ kind: "waiting", reason: "cache_not_valid" });
    tick("start");
    show(running);
    pageCommit(BIG, "applied", "lease_lapsed");
    stepEnd(null, "after");
    tick("timer");
    pageCommit(BIG);
    stepEnd(idle, "after");
    expect(classify(live(BIG, m2))).toEqual({
      outcome: "error",
      problems: ["the dense commit wrote no page (lease_lapsed)"],
    });
  });

  it("control (review 11, DA-H1): revision 10's end-less schedules (idle or a stop published, no step end traced) are not complete: the observer waits", () => {
    // Revision 10's admission control: a small commit, running, the dense commit, idle published; no `data.sync_next`.
    const m = mark();
    start();
    trace("data.sync_commit", {
      bytes: 8_035,
      scan_ms: 1,
      commit_ms: 2,
      kind: "applied",
      value: "committed",
    });
    publish({ kind: "running", catchingUp: true });
    pageCommit(BIG);
    publish(idle);
    expect(observeLiveOutcome({ least: BIG, mark: m })).toBeNull();
    // Revision 10's refusal control: a stop published without its end.
    const m2 = mark();
    begin();
    publish({ kind: "running", catchingUp: true });
    publish({ kind: "stopped", cause: "storage_full" });
    expect(observeLiveOutcome({ least: BIG, mark: m2 })).toBeNull();
  });
});

// ---- the actual oneColdRun, its dependencies replaced (the composition: one observation, never read again) ----------------------------
let schedule: Array<() => void> = [];
const net = { script: [] as unknown[], requests: [] as unknown[] };
vi.mock("../e2e/data-sync-helpers", () => ({
  ACCOUNT: "00000000-0000-4000-8000-0000000000ac",
  stubNetwork: async () => net,
  seedSettled: async () => undefined,
  bootSession: async () => page,
  // The engine's start publishes its waiting state before its first tick (the state the old helper took as the end).
  startLeader: async () => start(),
}));
vi.mock("../e2e/profile-helpers", () => ({
  browserMemory: () => ({
    baseline: async () => undefined,
    start: () => undefined,
    stop: async () => undefined,
    after: async () => undefined,
    record: () => ({ baseline_kib: 1, peak_kib: 1, after_kib: 1 }),
  }),
  cdpHeap: async () => ({ gc: async () => undefined, used: async () => null }),
  sampler: () => ({ stop: async () => [] }),
  sleep: async () => undefined,
}));
const reads: string[] = [];
/** The engine runs again the moment the observation is taken (the live-edge poll), before anything else could read the page. */
let runAgainAfterObservation = false;
const page = {
  /** Polls the page function; between polls the engine moves on by one scheduled event (none left: the time-out). */
  waitForFunction: async (fn: (arg: unknown) => unknown, arg: unknown) => {
    for (;;) {
      const value = fn(arg);
      if (value) {
        if (runAgainAfterObservation) requestStep();
        return { jsonValue: async () => structuredClone(value) };
      }
      const next = schedule.shift();
      if (!next)
        throw new Error("page.waitForFunction: Timeout 240000ms exceeded.");
      next();
    }
  },
  evaluate: async (fn: (arg: unknown) => unknown, arg: unknown) => {
    reads.push(String(fn).slice(0, 40));
    return fn(arg);
  },
};
const browser = { newContext: async () => ({ close: async () => undefined }) };
const { oneColdRun, unusableRuns } = await import("../e2e/profile-cold-run");
const run = () => oneColdRun(browser as never, undefined, "webkit", BODY);
const asked = () => {
  net.requests.push({});
  requestStep();
};

describe("oneColdRun (actual helper, deterministic schedules)", () => {
  beforeEach(() => {
    schedule = [];
    net.requests = [];
    reads.length = 0;
  });

  it("control: a positive idle schedule is admitted with the served page's figures and the observation kept", async () => {
    schedule = [asked, () => commit(), () => endStep(idle)];
    const r = await run();
    expect(r.outcome).toBe("admitted");
    expect(r.scan_ms).toBe(4);
    expect(r.commit_ms).toBe(28);
    expect(r.observation?.terminal.state.kind).toBe("idle");
    expect(unusableRuns([r])).toEqual([]);
  });

  it("case: review 9's startup schedule (waiting, then running) is never a refusal: the run waits for the request step's end", async () => {
    schedule = [asked, () => commit(), () => endStep(idle)];
    const r = await run();
    expect(r.outcome).toBe("admitted");
    expect(r.detail).not.toMatch(/running/);
  });

  it("case: review 9's observed schedule (idle, then running before any second read) keeps the observed idle", async () => {
    schedule = [asked, () => commit(), () => endStep(idle)];
    runAgainAfterObservation = true;
    try {
      const r = await run();
      expect(current?.kind).toBe("running");
      expect(r.outcome).toBe("admitted");
      expect(r.detail).toBe(JSON.stringify(idle));
    } finally {
      runAgainAfterObservation = false;
    }
  });

  it("control: a genuine stop after the request is refused", async () => {
    schedule = [
      asked,
      () => endStep({ kind: "stopped", cause: "device_capacity" }, "event"),
    ];
    const r = await run();
    expect(r.outcome).toBe("refused");
    expect(r.detail).toBe(
      JSON.stringify({ kind: "stopped", cause: "device_capacity" }),
    );
  });

  it("case: a page with has_more: the run's scan and commit figures are the measured page's (the first commit), not the follow-up's", async () => {
    schedule = [
      asked,
      () => commit(),
      () => trace("data.sync_next", { when: "now", state: "running" }),
      () => {
        net.requests.push({});
        trace("data.sync_tick", { why: "now", coalesced: false });
      },
      () => emptyCommit(),
      () => endStep(idle),
    ];
    const r = await run();
    expect(r.outcome).toBe("admitted");
    expect([r.scan_ms, r.commit_ms]).toEqual([4, 28]);
    expect(r.observation?.commits).toHaveLength(2);
  });

  it("control: review 9's back-off schedule: a back-off that ends the request step is the engine's verdict (refused); before the request it is not an end", async () => {
    schedule = [
      () => {
        publish({ kind: "backing_off", since: 1 });
        trace("data.sync_next", { when: "after", state: "backing_off" });
      },
      asked,
      () => endStep({ kind: "backing_off", since: 2 }),
    ];
    const r = await run();
    expect(r.outcome).toBe("refused");
    expect(r.detail).toBe(JSON.stringify({ kind: "backing_off", since: 2 }));
    expect(r.observation?.published.map((e) => e.state.kind)).toEqual([
      "waiting",
      "backing_off",
      "running",
      "backing_off",
    ]);
  });

  it("case: no end within the time-out is a timeout with the published states kept (never a refusal), and an unusable run", async () => {
    schedule = [asked];
    const r = await run();
    expect(r.outcome).toBe("timeout");
    expect(r.observation).toBeNull();
    expect(r.published_until_timeout).toEqual([
      JSON.stringify({ kind: "waiting", reason: "cache_not_valid" }),
      JSON.stringify({ kind: "running", catchingUp: true }),
    ]);
    expect(unusableRuns([r])).toHaveLength(1);
  });

  it("case: a request step that ended waiting for the session is an error run, which the stage barrier names", async () => {
    schedule = [
      asked,
      () => endStep({ kind: "waiting", reason: "paused_by_session" }, "event"),
    ];
    const r = await run();
    expect(r.outcome).toBe("error");
    expect(unusableRuns([r])).toEqual([
      expect.stringMatching(/^cold run 1: error \(the step ended waiting/),
    ]);
  });

  it("case (revision 10, invariant 1): an engine restarted while observing is an error run with no observation, which the stage barrier names", async () => {
    schedule = [
      asked,
      () => {
        begin();
        publish({ kind: "waiting", reason: "cache_not_valid" });
      },
      () => endStep(idle),
    ];
    const r = await run();
    expect(r.outcome).toBe("error");
    expect(r.observation).toBeNull();
    expect(r.published_until_timeout).toBeUndefined();
    expect(unusableRuns([r])).toEqual([
      expect.stringMatching(/^cold run 1: error \(.*observation identity/),
    ]);
  });

  it("control R12-R1: a healthy run records the cache it left (cache-rows/1) and the cursor, and the served page's effects admit it", async () => {
    schedule = [asked, () => commit(), () => endStep(idle)];
    const r = await run();
    expect(r.outcome).toBe("admitted");
    expect(r.effects).toEqual(EFFECTS);
    expect(r.cursor_after).toBe("c-1");
  });

  it("case R12-R2 (review 12): the measured lease_lapsed attempt, retried into the stub's empty page and idle, is an error run, which the stage barrier names", async () => {
    schedule = [
      asked,
      () => commit(BODY.length, "applied", "lease_lapsed"),
      () => trace("data.sync_next", { when: "after", state: "running" }),
      () => {
        net.requests.push({});
        trace("data.sync_tick", { why: "timer", coalesced: false });
      },
      () => emptyCommit(),
      () => endStep(idle),
    ];
    const r = await run();
    expect(r.outcome).toBe("error");
    expect(r.detail).toMatch(
      /^the measured page was not written \(value lease_lapsed\) and the engine asked again/,
    );
    expect(r.observation?.terminal.state.kind).toBe("running");
    expect(r.effects).toEqual({
      method: "cache-rows/1",
      rows: 0,
      entries_sha256: sha(""),
    });
    expect(unusableRuns([r])).toHaveLength(1);
  });

  it("case R12-R3: an idle run whose cache cannot be read afterwards is an error run (never an admission), its reason in the detail", async () => {
    schedule = [asked, () => commit(), () => endStep(idle)];
    cacheFault = "the store is closed";
    const r = await run();
    expect(r.outcome).toBe("error");
    expect(r.effects).toBeNull();
    expect(r.detail).toMatch(/effects not read: Error: the store is closed/);
  });

  it("control R12-R4: a committed has_more page continued by the stub's empty page is admitted with the measured page's figures and effects", async () => {
    schedule = [
      asked,
      () => commit(),
      () => trace("data.sync_next", { when: "now", state: "running" }),
      () => {
        net.requests.push({});
        trace("data.sync_tick", { why: "now", coalesced: false });
      },
      () => emptyCommit(),
      () => endStep(idle),
    ];
    const r = await run();
    expect(r.outcome).toBe("admitted");
    expect([r.scan_ms, r.commit_ms]).toEqual([4, 28]);
    expect(r.effects).toEqual(EFFECTS);
  });

  it("case (revision 10, DA-1): a first commit of other bytes than the served body is an error run", async () => {
    schedule = [asked, () => commit(BODY.length + 1), () => endStep(idle)];
    const r = await run();
    expect(r.outcome).toBe("error");
    expect(r.detail).toMatch(
      new RegExp(
        `^the first commit after the request is ${BODY.length + 1} bytes, not the served ${BODY.length}`,
      ),
    );
  });
});
