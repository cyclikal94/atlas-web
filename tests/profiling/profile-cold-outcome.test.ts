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
}
let harness: Harness;
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
const BODY = "x".repeat(1_000);
const commit = (bytes = BODY.length, kind = "applied") =>
  trace("data.sync_commit", { bytes, scan_ms: 4, commit_ms: 28, kind });

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
  };
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
const served = (requests = 1) => ({ bytes: BODY.length, requests });
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
    trace("data.sync_commit", { scan_ms: 4, commit_ms: 28, kind: "applied" });
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

describe("observeLiveOutcome and classifyLiveOutcome", () => {
  const BIG = 1_000_000;
  const live = (least: number, m: ReturnType<typeof mark>) =>
    defined(observeLiveOutcome({ least, mark: m }));
  const lines = () => [...harness.engineTrace];
  const classify = (o: LiveObservation, captured = BIG) =>
    classifyLiveOutcome(o, {
      capturedBytes: captured,
      traceLines: lines(),
    });
  const dense = (bytes = BIG, kind = "applied") =>
    trace("data.sync_commit", { bytes, scan_ms: 20, commit_ms: 300, kind });

  it("case: the dense commit and idle at the same moment are admitted; a later running poll does not change the observation", () => {
    const m = mark();
    start();
    trace("data.sync_commit", {
      bytes: 8_035,
      scan_ms: 1,
      commit_ms: 2,
      kind: "applied",
    });
    publish({ kind: "running", catchingUp: true });
    expect(observeLiveOutcome({ least: BIG, mark: m })).toBeNull();
    dense();
    publish(idle);
    const o = live(BIG, m);
    publish({ kind: "running", catchingUp: false });
    expect(classify(o)).toEqual({ outcome: "admitted", problems: [] });
    expect(o.state_entry.state.kind).toBe("idle");
  });

  it("control: a stop is refused; a back-off is waited out; an idle without the dense page is not an end", () => {
    const m = mark();
    start();
    publish({ kind: "backing_off", since: 1 });
    expect(observeLiveOutcome({ least: 1_000, mark: m })).toBeNull();
    publish(idle);
    expect(observeLiveOutcome({ least: 1_000, mark: m })).toBeNull();
    publish({ kind: "stopped", cause: "floor" });
    expect(classify(live(1_000, m), 1_000).outcome).toBe("refused");
    // A failed dense commit at idle is no admission.
    const m2 = mark();
    begin();
    publish({ kind: "running", catchingUp: true });
    dense(1_000, "failed");
    publish(idle);
    const failed = live(1_000, m2);
    expect(classify(failed, 1_000)).toEqual({
      outcome: "error",
      problems: ["the dense commit was not applied"],
    });
  });

  it("case (revision 10, DA-2): the density is judged against the verified capture: below 90% is an error, exactly 90% and above are admitted", () => {
    const m = mark();
    start();
    publish({ kind: "running", catchingUp: true });
    dense(900_000);
    publish(idle);
    const o = live(BIG, m);
    expect(classify(o, BIG).outcome).toBe("admitted");
    expect(classify(o, 900_000).outcome).toBe("admitted");
    expect(classify(o, 1_000_002)).toEqual({
      outcome: "error",
      problems: [
        "the dense commit is 900000 bytes, below 90% of the captured 1000002",
      ],
    });
  });

  it("case (revision 10, DA-2): review 10's invented dense commits (zero bytes; 999,999,999 bytes absent from the trace) are errors", () => {
    const m = mark();
    start();
    publish({ kind: "running", catchingUp: true });
    dense();
    publish(idle);
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
      };
    expect(classify(invented).problems).toEqual([
      "the dense commit is not the retained trace's commit at its position",
    ]);
  });

  it("case (revision 10, DA-2): a dense commit before the epoch does not qualify; one after it inside the epoch does", () => {
    // A large commit by an earlier engine, before the mark.
    begin();
    dense();
    const m = mark();
    start();
    publish({ kind: "running", catchingUp: true });
    publish(idle);
    expect(observeLiveOutcome({ least: BIG, mark: m })).toBeNull();
    publish({ kind: "running", catchingUp: true });
    dense();
    publish(idle);
    const o = live(BIG, m);
    expect(classify(o).outcome).toBe("admitted");
    // The same witness pointing at the earlier engine's commit is refused.
    const early = clone(o);
    if (early.dense) early.dense.trace = 0;
    expect(classify(early).problems).toEqual([
      "the dense commit lies outside the observation's epoch and boundary",
    ]);
  });

  it("case (revision 10, DA-2): a dense commit after the observation's boundary, or an idle published before it, is not corroboration", () => {
    const m = mark();
    start();
    publish({ kind: "running", catchingUp: true });
    dense();
    publish(idle);
    const o = live(BIG, m);
    const after = clone(o);
    if (after.dense) after.dense.trace = after.boundary;
    expect(classify(after).problems).toContain(
      "the dense commit lies outside the observation's epoch and boundary",
    );
    const before = clone(o);
    before.state_entry.trace = before.dense?.trace ?? 0;
    expect(classify(before).problems).toEqual([
      "the idle state was not published after the dense commit",
    ]);
  });

  it("case (revision 10): an idle published before the dense commit, with nothing published after it, is not an end", () => {
    const m = mark();
    start();
    publish({ kind: "running", catchingUp: true });
    publish(idle);
    dense();
    expect(observeLiveOutcome({ least: BIG, mark: m })).toBeNull();
  });

  it("control (revision 10): a live back-off, retry and dense idle is admitted; a genuine stop without a dense commit is refused", () => {
    const m = mark();
    start();
    publish({ kind: "running", catchingUp: true });
    publish({ kind: "backing_off", since: 1 });
    expect(observeLiveOutcome({ least: BIG, mark: m })).toBeNull();
    publish({ kind: "running", catchingUp: true });
    dense();
    publish(idle);
    expect(classify(live(BIG, m)).outcome).toBe("admitted");
    const m2 = mark();
    begin();
    publish({ kind: "running", catchingUp: true });
    publish({ kind: "stopped", cause: "storage_full" });
    const stopped = live(BIG, m2);
    expect(stopped.dense).toBeNull();
    expect(classify(stopped)).toEqual({ outcome: "refused", problems: [] });
  });

  it("case (revision 10, invariant 1): a restart or a reload while observing the live application is no verdict", () => {
    const m = mark();
    start();
    publish({ kind: "running", catchingUp: true });
    begin();
    publish({ kind: "waiting", reason: "cache_not_valid" });
    expect(() => observeLiveOutcome({ least: BIG, mark: m })).toThrow(
      "observation identity: the engine was started again while observing",
    );
    const m2 = mark();
    begin();
    harness.page = "page-2";
    expect(() => observeLiveOutcome({ least: BIG, mark: m2 })).toThrow(
      "observation identity: the page was replaced (a reload) while observing",
    );
  });
});

// ---- the actual oneColdRun, its dependencies replaced (the composition: one observation, never read again) ----------------------------
let schedule: Array<() => void> = [];
const net = { script: [] as unknown[], requests: [] as unknown[] };
vi.mock("../e2e/data-sync-helpers", () => ({
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
      () =>
        trace("data.sync_commit", {
          bytes: 80,
          scan_ms: 0.5,
          commit_ms: 1.5,
          kind: "applied",
        }),
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
