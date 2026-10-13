import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The profiled outcome observation (WEB-09c revision 9, review 9 R2; family profiling-evidence-completeness).
 *
 * Review 9 retained two WebKit cold runs recorded `refused` over a `running` state: the old `oneColdRun` accepted ANY state but
 * `running`/`not_started` as the end (the start's own `waiting/cache_not_valid` included), then read the state again in a separate call
 * and labelled every non-idle read a refusal. These schedules drive the page function (`observeColdOutcome`) and the actual `oneColdRun`
 * (its browser, network and memory dependencies replaced; a deterministic schedule of what the engine publishes between polls) with the
 * review's forced schedules, positive idle and genuine refusal controls, has_more, a failed step, a request step that ended waiting for
 * the session and contradictory records. Not a browser test or a measurement: the native counterpart is the P-11 spec control in WebKit.
 */

type State = { kind: string; [key: string]: unknown };
interface Harness {
  engineStates: Array<{ run: number; at: number; trace: number; state: State }>;
  engineTrace: string[];
  engineState(): State | null;
}
let harness: Harness;
let clock = 0;
let current: State | null = null;
const publish = (state: State, run = 1) => {
  current = state;
  clock += 5;
  harness.engineStates.push({
    run,
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
  current = null;
  harness = {
    engineStates: [],
    engineTrace: [],
    engineState: () => current,
  };
  (window as unknown as { __atlasData: Harness }).__atlasData = harness;
});

const outcomes = await import("../e2e/profile-cold-outcome");
const {
  observeColdOutcome,
  classifyColdOutcome,
  observeLiveOutcome,
  classifyLiveOutcome,
} = outcomes;
/** A value the schedule guarantees (an explicit failure, never a non-null assertion). */
const defined = <T>(value: T | null | undefined): T => {
  if (value === null || value === undefined)
    throw new Error("no observation where the schedule guarantees one");
  return value;
};
const observed = (m: { states: number; trace: number }) =>
  defined(observeColdOutcome(m));
const liveObserved = (least: number) => defined(observeLiveOutcome(least));
const mark = () => ({
  states: harness.engineStates.length,
  trace: harness.engineTrace.length,
});
/** The engine's start: its own `waiting/cache_not_valid` before the first tick (sync-engine.ts `start`). */
const start = () => publish({ kind: "waiting", reason: "cache_not_valid" });
const requestStep = () => {
  trace("data.sync_tick", { why: "start", coalesced: false });
  publish({ kind: "running", catchingUp: true });
};
const endStep = (state: State, when = "after") => {
  publish(state);
  trace("data.sync_next", { when, state: state.kind });
};

describe("observeColdOutcome (the page function) and classifyColdOutcome", () => {
  it("case: review 9's startup schedule: the start's waiting is not an end, nor is the running request; the step's idle end is admitted", () => {
    const m = mark();
    start();
    expect(observeColdOutcome(m)).toBeNull();
    requestStep();
    expect(observeColdOutcome(m)).toBeNull();
    commit();
    endStep({ kind: "idle", lastSyncedAt: "t" });
    const o = observeColdOutcome(m);
    expect(o).not.toBeNull();
    expect(o?.states).toEqual(["waiting/cache_not_valid", "running", "idle"]);
    expect(
      classifyColdOutcome(defined(o), { bytes: BODY.length, requests: 1 }),
    ).toEqual({
      outcome: "admitted",
      detail: JSON.stringify({ kind: "idle", lastSyncedAt: "t" }),
      problems: [],
    });
  });

  it("case: review 9's observed schedule: a later poll that runs again does not change the observation already made", () => {
    const m = mark();
    start();
    requestStep();
    commit();
    endStep({ kind: "idle", lastSyncedAt: "t" });
    const first = observeColdOutcome(m);
    // The live-edge poll starts the next step: the state is `running` again.
    requestStep();
    expect(current?.kind).toBe("running");
    expect(observeColdOutcome(m)).toEqual(first);
    expect(
      classifyColdOutcome(defined(first), { bytes: BODY.length, requests: 2 })
        .outcome,
    ).toBe("admitted");
  });

  it("control: a genuine refusal (the engine stopped after the request) is refused, its detail the observed state", () => {
    const m = mark();
    start();
    requestStep();
    endStep({ kind: "stopped", cause: "device_capacity" }, "event");
    const o = observed(m);
    expect(classifyColdOutcome(o, { bytes: BODY.length, requests: 1 })).toEqual(
      {
        outcome: "refused",
        detail: JSON.stringify({ kind: "stopped", cause: "device_capacity" }),
        problems: [],
      },
    );
  });

  it("control: a W7 negative control's back-off after its request (its failed commit is the served page) is refused", () => {
    const m = mark();
    start();
    requestStep();
    commit(BODY.length, "failed");
    endStep({ kind: "backing_off", since: 1 });
    const o = observed(m);
    expect(o.commits).toHaveLength(1);
    expect(
      classifyColdOutcome(o, { bytes: BODY.length, requests: 1 }).outcome,
    ).toBe("refused");
  });

  it("case: a step before the request that ended waiting (no service yet) is not the observed operation", () => {
    const m = mark();
    start();
    trace("data.sync_tick", { why: "start", coalesced: false });
    trace("data.sync_next", { when: "event", state: "waiting" });
    expect(observeColdOutcome(m)).toBeNull();
    requestStep();
    commit();
    endStep({ kind: "idle", lastSyncedAt: "t" });
    expect(
      classifyColdOutcome(observed(m), {
        bytes: BODY.length,
        requests: 1,
      }).outcome,
    ).toBe("admitted");
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
    endStep({ kind: "idle", lastSyncedAt: "t" });
    const o = observed(m);
    expect(o.commits.map((c) => c.bytes)).toEqual([BODY.length, 80]);
    expect(
      classifyColdOutcome(o, { bytes: BODY.length, requests: 2 }).outcome,
    ).toBe("admitted");
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
    expect(
      classifyColdOutcome(o, { bytes: BODY.length, requests: 1 }).outcome,
    ).toBe("refused");
  });

  it("case: a request step that ended waiting for the session is an error, not a refusal", () => {
    const m = mark();
    start();
    requestStep();
    endStep({ kind: "waiting", reason: "paused_by_session" }, "event");
    const c = classifyColdOutcome(observed(m), {
      bytes: BODY.length,
      requests: 1,
    });
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
    expect(
      classifyColdOutcome(observed(m), {
        bytes: BODY.length,
        requests: 1,
      }).outcome,
    ).toBe("refused");
  });

  it("case: idle without the served page's applied commit, another page's bytes, or no request at the stub, is an error", () => {
    const m = mark();
    start();
    requestStep();
    endStep({ kind: "idle", lastSyncedAt: "t" });
    const none = observed(m);
    expect(
      classifyColdOutcome(none, { bytes: BODY.length, requests: 1 }).problems,
    ).toEqual(["idle without the served page's applied commit"]);
    const other = { ...none, commits: [{ bytes: 7, kind: "applied" }] };
    expect(
      classifyColdOutcome(other, { bytes: BODY.length, requests: 1 }).problems,
    ).toEqual([
      `the first commit after the request is 7 bytes, not the served ${BODY.length}`,
    ]);
    const withCommit = {
      ...none,
      commits: [{ bytes: BODY.length, kind: "applied" }],
    };
    expect(
      classifyColdOutcome(withCommit, { bytes: BODY.length, requests: 0 })
        .problems,
    ).toEqual(["no /sync request reached the stub"]);
  });

  it("case: a contradictory record (a step end recording another state, or an end while running) is an error, never a refusal", () => {
    const m = mark();
    start();
    requestStep();
    endStep({ kind: "stopped", cause: "floor" }, "event");
    const o = observed(m);
    const mismatched = { ...o, step_end: { ...o.step_end, recorded: "idle" } };
    expect(
      classifyColdOutcome(mismatched, { bytes: BODY.length, requests: 1 })
        .outcome,
    ).toBe("error");
    const running = {
      ...o,
      terminal: { ...o.terminal, state: { kind: "running", catchingUp: true } },
      step_end: { ...o.step_end, recorded: "running" },
    };
    const c = classifyColdOutcome(running, { bytes: BODY.length, requests: 1 });
    expect(c.outcome).toBe("error");
    expect(c.problems).toContain("the step ended in running");
  });

  it("case: states and trace before the mark (an earlier engine run) are not this run's", () => {
    publish({ kind: "running", catchingUp: true }, 1);
    trace("data.sync_next", { when: "after", state: "running" });
    publish({ kind: "idle", lastSyncedAt: "old" }, 1);
    trace("data.sync_next", { when: "after", state: "idle" });
    const m = mark();
    expect(observeColdOutcome(m)).toBeNull();
    publish({ kind: "waiting", reason: "cache_not_valid" }, 2);
    trace("data.sync_tick", { why: "start", coalesced: false });
    publish({ kind: "running", catchingUp: true }, 2);
    commit();
    publish({ kind: "idle", lastSyncedAt: "new" }, 2);
    trace("data.sync_next", { when: "after", state: "idle" });
    const o = observed(m);
    expect(o.run).toBe(2);
    expect(o.terminal.state).toEqual({ kind: "idle", lastSyncedAt: "new" });
  });
});

describe("observeLiveOutcome and classifyLiveOutcome", () => {
  it("case: the dense commit and idle at the same moment are admitted; a later running poll does not change the observation", () => {
    trace("data.sync_commit", { bytes: 8_035, kind: "applied" });
    publish({ kind: "running", catchingUp: true });
    expect(observeLiveOutcome(1_000_000)).toBeNull();
    trace("data.sync_commit", { bytes: 1_000_000, kind: "applied" });
    publish({ kind: "idle", lastSyncedAt: "t" });
    const o = liveObserved(1_000_000);
    publish({ kind: "running", catchingUp: false });
    expect(classifyLiveOutcome(o)).toBe("admitted");
    expect(o.state?.kind).toBe("idle");
  });

  it("control: a stop is refused; a back-off is waited out; an idle without the dense page is not an end", () => {
    publish({ kind: "backing_off", since: 1 });
    expect(observeLiveOutcome(1_000)).toBeNull();
    publish({ kind: "idle", lastSyncedAt: "t" });
    expect(observeLiveOutcome(1_000)).toBeNull();
    publish({ kind: "stopped", cause: "floor" });
    expect(classifyLiveOutcome(liveObserved(1_000))).toBe("refused");
    expect(
      classifyLiveOutcome({
        method: "live-dense-commit/1",
        state: { kind: "idle" },
        dense: { bytes: 1_000, kind: "failed" },
        trace: 1,
      }),
    ).toBe("error");
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
    schedule = [
      asked,
      () => commit(),
      () => endStep({ kind: "idle", lastSyncedAt: "t" }),
    ];
    const r = await run();
    expect(r.outcome).toBe("admitted");
    expect(r.scan_ms).toBe(4);
    expect(r.commit_ms).toBe(28);
    expect(r.observation?.terminal.state.kind).toBe("idle");
    expect(unusableRuns([r])).toEqual([]);
  });

  it("case: review 9's startup schedule (waiting, then running) is never a refusal: the run waits for the request step's end", async () => {
    schedule = [
      asked,
      () => commit(),
      () => endStep({ kind: "idle", lastSyncedAt: "t" }),
    ];
    const r = await run();
    expect(r.outcome).toBe("admitted");
    expect(r.detail).not.toMatch(/running/);
  });

  it("case: review 9's observed schedule (idle, then running before any second read) keeps the observed idle", async () => {
    schedule = [
      asked,
      () => commit(),
      () => endStep({ kind: "idle", lastSyncedAt: "t" }),
    ];
    runAgainAfterObservation = true;
    try {
      const r = await run();
      expect(current?.kind).toBe("running");
      expect(r.outcome).toBe("admitted");
      expect(r.detail).toBe(
        JSON.stringify({ kind: "idle", lastSyncedAt: "t" }),
      );
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
      () => endStep({ kind: "idle", lastSyncedAt: "t" }),
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
    expect(r.observation?.states).toEqual([
      "waiting/cache_not_valid",
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
});
