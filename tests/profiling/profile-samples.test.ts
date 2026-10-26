import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type BufferSnapshot,
  bufferLifetimeProblem,
  COMMANDS_PATH,
  DRAFT_WITNESS_METHOD,
  draftWitnessSelection,
  type P2MarkFrame,
  p2IterationSelection,
  p2SequenceProblem,
  SYNC_PATH,
  SYNC_WITNESS_METHOD,
  syncWitnessSelection,
} from "../../scripts/lib/profile-sample-rules.mjs";
import { apiUrl } from "../../src/lib/api-client/wire";
import {
  closeDraftSample,
  collectDraftSamples,
  collectP2Iterations,
  collectSyncSamples,
  type DraftWitness,
  draftCompletionReady,
  markP2Iteration,
  nudgeP2Iteration,
  type P2Phase,
  type P2Port,
  type P2Shape,
  type P2Witness,
  prepareDraftSample,
  prepareSyncSample,
  readDraftSample,
  readP2Iteration,
  readP2LongTasks,
  readSyncSample,
  type SamplePage,
  type SyncMark,
  type SyncWitness,
} from "../e2e/profile-samples";

/**
 * The operation each timed sample belongs to (WEB-09c revision 12; review 12, design assessment DA-M1/DA-M2, Q2). These schedules drive
 * the REAL extraction code the P-2 and P-4/P-10 writers use (the page functions over a harness trace and ResourceTiming entries as the
 * page has them, and the Node-side selection), not hand-authored JSON. Every expectation is written here from the production order
 * (src/data/engine/sync-engine.ts: a step traces `data.sync_tick`, makes its one request, traces `data.sync_commit` with the plan's value,
 * publishes its state and the loop traces `data.sync_next`; after a lapsed hold the step ends `running` and a paced retry asks again).
 * Not a browser test or a measurement: the native counterparts are the P-2/P-4/P-10 spec controls.
 */

let trace: string[] = [];
let resources: Array<{
  name: string;
  startTime: number;
  requestStart: number;
  responseEnd: number;
}> = [];
/**
 * REVISION 16 HARNESS CORRECTION (labelled; review 16 R16-SYNC, design assessment DA16-H1): the sync page's own clock. The production
 * trace stamps a line with `Math.round(performance.now())` when it is written, and the mark and the read take `performance.now()`; these
 * doubles scripted trace and entry times without any page clock, so a mark or a read could be timed anywhere. Writing a line now advances
 * the page clock to it, a page read happens once the entries it sees have ended (`readAt`), and a fresh trace starts a fresh clock
 * (`restartTrace`). Every schedule, expected value and problem of revisions 12-15 is unchanged; the clock only makes them possible.
 */
let pageClock = 0;
const line = (ms: number, event: string, data?: unknown) => {
  pageClock = Math.max(pageClock, ms);
  trace.push(
    `${ms}ms ${event} ${data === undefined ? "" : JSON.stringify(data)}`,
  );
};
const restartTrace = () => {
  trace = [];
  pageClock = 0;
};
const SYNC = "http://127.0.0.1:4100/api/experimental/v1/sync?limit=200";

/**
 * The harness double the page functions read (revision 13): the engine trace, the engine starts, the page instance, the nudge, the outbox
 * trace and queue, and the enqueue, as `window.__atlasData` has them. A test scripts what each call does.
 */
interface HarnessDouble {
  page: string;
  engineEpochs: Array<{ generation: number; run: number; trace: number }>;
  nudges: number;
  onNudge: () => void;
  outbox: string[];
  rows: Array<{ local_id: string; status: string }>;
  onEnqueue: (localId: string) => void;
  /** Revision 14: the dispatch identity (`dispatchIdentity`), the observed dispatcher's records and the bound service's row read. */
  identity: {
    page: string;
    account: string | null;
    identity_account: string | null;
    epoch: number | null;
    service: number | null;
    incarnation: string | null;
    live: boolean;
    current_service: number | null;
    dispatcher: number | null;
    run: number | null;
    running: boolean;
    observing: boolean;
  };
  log: Array<Record<string, unknown> & { seq: number }>;
  logFirst: number;
  seq: number;
  onBoundDraft: () => void | Promise<void>;
}
let harness: HarnessDouble;
let clears = 0;
beforeEach(() => {
  trace = [];
  pageClock = 0;
  resources = [];
  clears = 0;
  harness = {
    page: "page-1",
    engineEpochs: [{ generation: 1, run: 1, trace: 0 }],
    nudges: 0,
    onNudge: () => {},
    outbox: [],
    rows: [],
    onEnqueue: () => {},
    identity: {
      page: "page-1",
      account: "a",
      identity_account: "a",
      epoch: 3,
      service: 2,
      incarnation: "inc-1",
      live: true,
      current_service: 2,
      dispatcher: 1,
      run: 1,
      running: true,
      observing: true,
    },
    log: [],
    logFirst: 0,
    seq: 0,
    onBoundDraft: () => {},
  };
  (window as unknown as { __atlasData: unknown }).__atlasData = {
    get engineTrace() {
      return trace;
    },
    get engineEpochs() {
      return harness.engineEpochs;
    },
    get page() {
      return harness.page;
    },
    nudgeSync() {
      harness.nudges += 1;
      harness.onNudge();
    },
    get outboxTrace() {
      return harness.outbox;
    },
    async queue() {
      return harness.rows.map((r) => ({ ...r }));
    },
    async enqueue() {
      const localId = `draft-${harness.rows.length + 1}`;
      harness.rows.push({ local_id: localId, status: "queued" });
      harness.onEnqueue(localId);
      return { kind: "queued", localId };
    },
    dispatchIdentity() {
      return { ...harness.identity };
    },
    get dispatchLog() {
      return harness.log;
    },
    dispatchFirst: () => harness.log[0]?.seq ?? harness.seq,
    dispatchNext: () => harness.seq,
    async boundDraft(localId: string) {
      await harness.onBoundDraft();
      const row = harness.rows.find((r) => r.local_id === localId);
      return {
        row: row ? { ...row } : null,
        waiting: harness.rows.filter(
          (r) =>
            r.local_id !== localId &&
            (r.status === "queued" || r.status === "in_flight"),
        ).length,
      };
    },
  };
  vi.spyOn(performance, "getEntriesByType").mockImplementation(
    () => resources as unknown as PerformanceEntryList,
  );
  // Revision 16 (DA16-H1): the sync page clock (the draft schedules below install their own).
  vi.spyOn(performance, "now").mockImplementation(() => pageClock);
  vi.spyOn(performance, "clearResourceTimings").mockImplementation(() => {
    clears += 1;
    resources = [];
  });
});
afterEach(() => {
  vi.restoreAllMocks();
});

const committed = (ms: number, bytes: number, scan: number, commit: number) =>
  line(ms, "data.sync_commit", {
    bytes,
    scan_ms: scan,
    commit_ms: commit,
    kind: "applied",
    value: "committed",
  });

// ---- P-4/P-10 (revision 13; review 13 R2, design assessment DA-R2-A/DA-R2-B/DA-N1, Q1/Q2/Q4) ----------------------------------------------
// The page functions (`prepareSyncSample`, `readSyncSample`, `prepareDraftSample`, `readDraftSample`, `draftCompletionReady`,
// `closeDraftSample`; revision 13's `draftStatus` was replaced in revision 14), the shared rule
// (scripts/lib/profile-sample-rules.mjs) and the collectors both integration writers call, over the harness double above. Every expected
// value is written here from the production order (sync-engine.ts `tick`: a non-coalesced `data.sync_tick`, the step's request and
// commit, then `data.sync_next`; a gate or a failed step ends a step with no request; outbox-dispatcher.ts: `data.outbox_send` before the
// stamped call, a `not_sent`/aborted attempt has no answer and a paced retry sends again). Not a browser test: the native counterparts are
// fixture.profile-outcome.spec.ts's.

/**
 * A page function as the browser runs it: rebuilt from its own source text, so a reference to anything outside its body (a module
 * constant, an import) fails here exactly as it does after Playwright serialises it (revision 13: a module constant once passed these
 * schedules and failed natively).
 */
const isolated = <F extends (...args: never[]) => unknown>(fn: F): F =>
  new Function(`return (${fn.toString()});`)() as F;
const inPage = {
  prepareSyncSample: isolated(prepareSyncSample),
  readSyncSample: isolated(readSyncSample),
  prepareDraftSample: isolated(prepareDraftSample),
  readDraftSample: isolated(readDraftSample),
  draftCompletionReady: isolated(draftCompletionReady),
  closeDraftSample: isolated(closeDraftSample),
};

const mark = (): SyncMark => {
  const m = inPage.prepareSyncSample();
  if (!m) throw new Error("a step is open");
  return m;
};
/** A page read once the entries it sees have ended (revision 16, DA16-H1): the clock is at least every visible entry's end. */
const readAt = () => {
  for (const r of resources)
    if (Number.isFinite(r.responseEnd))
      pageClock = Math.max(pageClock, r.responseEnd);
};
const witnessOf = (m: SyncMark, force = false) => {
  readAt();
  return inPage.readSyncSample({ mark: m, force });
};
const select = (m: SyncMark) => syncWitnessSelection(witnessOf(m, true));
const healthyLines = (t: number) => {
  line(t, "data.sync_tick", { why: "now", coalesced: false });
  resources.push({
    name: SYNC,
    startTime: t + 1.2,
    requestStart: t + 2,
    responseEnd: t + 10.5,
  });
  line(t + 15, "data.sync_commit", { kind: "applied", value: "committed" });
  line(t + 16, "data.sync_next", { when: "after", state: "idle" });
};

describe("P-4/P-10 sync: the mark, the page read and the rule (Q1)", () => {
  it("control: one page call clears ResourceTiming, marks and nudges once; while a real step is open it does nothing and is polled again", () => {
    line(5, "data.sync_tick", { why: "timer", coalesced: false });
    line(6, "data.sync_tick", { why: "wake", coalesced: true });
    expect(inPage.prepareSyncSample()).toBeNull();
    expect([harness.nudges, clears]).toEqual([0, 0]);
    line(9, "data.sync_next", { when: "after", state: "idle" });
    const m = mark();
    expect(m).toMatchObject({
      page: "page-1",
      epochs: 1,
      generation: 1,
      from: 3,
    });
    expect([harness.nudges, clears]).toEqual([1, 1]);
  });

  it("control: the healthy step is complete with pre-issue 2, request 8.5, post-response 4.5, total 15; the read retains the contiguous slice and every /sync entry", () => {
    const m = mark();
    healthyLines(100);
    const w = witnessOf(m);
    expect(w?.lines).toHaveLength(3);
    expect(w?.read).toMatchObject({ to: 3, epochs: [], resource_entries: 1 });
    const s = syncWitnessSelection(w);
    expect(s).toEqual({
      status: "complete",
      problem: null,
      selected: { start: 0, commit: 1, end: 2, request: 0 },
      values: {
        pre_issue_ms: 2,
        request_ms: 8.5,
        post_response_ms: 4.5,
        total_ms: 15,
        duration_ms: 110.5 - 101.2,
      },
    });
  });

  it("control: coalesced ticks before and during the step are retained and start nothing; ties within the 1 ms rounding are inside; a later step's lines and entry after the read's step end are outside it", () => {
    const m = mark();
    line(99, "data.sync_tick", { why: "receipt", coalesced: true });
    line(100, "data.sync_tick", { why: "now", coalesced: false });
    line(101, "data.sync_tick", { why: "wake", coalesced: true });
    resources.push({
      name: SYNC,
      startTime: 99.3,
      requestStart: 100.5,
      responseEnd: 115.8,
    });
    line(115, "data.sync_commit", { kind: "applied", value: "committed" });
    line(115, "data.sync_next", { when: "now", state: "running" });
    line(116, "data.sync_tick", { why: "now", coalesced: false });
    resources.push({
      name: SYNC,
      startTime: 117,
      requestStart: 118,
      responseEnd: 140,
    });
    const s = select(m);
    expect(s.status).toBe("complete");
    expect(s.selected).toEqual({ start: 1, commit: 3, end: 4, request: 0 });
    expect(s.values?.pre_issue_ms).toBe(0.5);
  });

  it("control: a request-latency step whose commit wrote nothing (lease_lapsed, the step ending running) is one complete sample", () => {
    const m = mark();
    line(100, "data.sync_tick", { why: "now", coalesced: false });
    resources.push({
      name: SYNC,
      startTime: 101,
      requestStart: 102,
      responseEnd: 110,
    });
    line(115, "data.sync_commit", { kind: "applied", value: "lease_lapsed" });
    line(116, "data.sync_next", { when: "after", state: "running" });
    expect(select(m)).toMatchObject({
      status: "complete",
      values: { pre_issue_ms: 2, total_ms: 15 },
    });
  });

  it("case (review 13 R2): tick 10, end 11 (no request), tick 100, request 102, commit 115, end 116: the read stops at the first end and the sample is invalid there; a late read of the whole history is invalid the same way; 92 is never a pre-issue value", () => {
    const m = mark();
    line(10, "data.sync_tick", { why: "nudge", coalesced: false });
    expect(witnessOf(m)).toBeNull();
    line(11, "data.sync_next", { when: "event", state: "stopped" });
    const early = witnessOf(m);
    expect(early?.lines).toHaveLength(2);
    const problem = `the sample's step ended without a commit (${trace[1]?.trim()}): no later step can stand for it`;
    expect(syncWitnessSelection(early)).toEqual({
      status: "invalid",
      problem,
      selected: null,
      values: null,
    });
    healthyLines(100);
    const late = syncWitnessSelection(witnessOf(m));
    expect(late).toMatchObject({ status: "invalid", problem, values: null });
  });

  it("case: an earlier FAILED step (sync_step_failed, no commit) and a step ending before its commit are invalid at their end", () => {
    const m = mark();
    line(10, "data.sync_tick", { why: "nudge", coalesced: false });
    line(12, "data.sync_step_failed");
    healthyLines(100);
    // Asserted as an object (revision 13 calibration, NC22): a null problem is an assertion failure, never a TypeError.
    expect(select(m)).toMatchObject({
      status: "invalid",
      problem: expect.stringMatching(
        /^the sample's step ended without a commit \(12ms data\.sync_step_failed\): no later step can stand for it$/,
      ),
    });
  });

  it("case: a nested real start, two commits, and a commit or end before any start are contradictions; a start without its end stays pending (the page keeps polling, a forced read is pending)", () => {
    let m = mark();
    line(100, "data.sync_tick", { why: "now", coalesced: false });
    expect(witnessOf(m)).toBeNull();
    expect(select(m)).toMatchObject({
      status: "pending",
      problem: "the sample's step has not ended",
    });
    line(101, "data.sync_tick", { why: "timer", coalesced: false });
    expect(syncWitnessSelection(witnessOf(m))?.problem).toBe(
      "a second step started before the sample's step ended",
    );
    restartTrace();
    m = mark();
    line(100, "data.sync_tick", { why: "now", coalesced: false });
    line(105, "data.sync_commit", { kind: "applied", value: "committed" });
    line(106, "data.sync_commit", { kind: "applied", value: "committed" });
    line(107, "data.sync_next", { when: "after", state: "idle" });
    expect(select(m).problem).toBe("the sample's step traced two commits");
    restartTrace();
    m = mark();
    line(105, "data.sync_commit", { kind: "applied", value: "committed" });
    expect(syncWitnessSelection(witnessOf(m))?.problem).toBe(
      "a step that began before the sample traced data.sync_commit inside it",
    );
    expect(select({ ...m, from: 99 }).status).toBe("invalid");
  });

  // REVISION 13 ADAPTATION (labelled) of revision 12's "a request before the step (an earlier poll) and one after its commit (the next
  // poll) are not the sample's; the latest entry is never taken": the later entry is still never taken (the control above keeps a later
  // step's entry outside the sample), but an entry that began BEFORE the step can no longer be filtered away. The mark is set only while
  // no step is open and clears ResourceTiming, so such an entry means the witness is not bounded: the sample is invalid.
  it("case: zero, two, preceding or overlapping /sync entries, an entry without usable timing, or a full buffer leave no unique request; until the committed step's request is visible the page keeps polling; another endpoint is not /sync", () => {
    let m = mark();
    line(100, "data.sync_tick", { why: "now", coalesced: false });
    line(115, "data.sync_commit", { kind: "applied", value: "committed" });
    line(116, "data.sync_next", { when: "after", state: "idle" });
    resources.push({
      name: "http://127.0.0.1:4100/api/experimental/v1/commands",
      startTime: 101,
      requestStart: 102,
      responseEnd: 110,
    });
    expect(witnessOf(m)).toBeNull();
    expect(select(m).problem).toBe(
      "0 /sync requests lie inside the operation (0 since the sample began)",
    );
    const one = {
      name: SYNC,
      startTime: 101,
      requestStart: 102,
      responseEnd: 110,
    };
    const cases: Array<[Array<typeof one>, number, string]> = [
      [
        [one, { ...one, startTime: 103, requestStart: 104, responseEnd: 112 }],
        5,
        "2 /sync requests lie inside the operation (2 since the sample began)",
      ],
      [
        [{ ...one, startTime: 50, requestStart: 51, responseEnd: 60 }, one],
        5,
        "a /sync request began before the sample's operation",
      ],
      [
        [one, { ...one, startTime: 114, requestStart: 114, responseEnd: 140 }],
        5,
        "a /sync request overlaps the sample's operation without lying inside it",
      ],
      [
        [{ ...one, requestStart: Number.NaN }],
        5,
        "a request entry has no usable timing",
      ],
      [
        [{ ...one, requestStart: 111 }],
        5,
        "a request entry has no usable timing",
      ],
      [
        [one],
        250,
        "the resource-timing buffer was full: requests may be missing",
      ],
    ];
    for (const [entries, total, problem] of cases) {
      resources = entries;
      const w = witnessOf(m, true);
      if (w) w.read.resource_entries = total === 5 ? entries.length : total;
      expect(syncWitnessSelection(w).problem, problem).toBe(problem);
    }
    m = { ...m };
    resources = [one];
    expect(select(m).status).toBe("complete");
  });

  it("case: a reload (another page instance) or an engine start since the mark makes the read return at once, invalid; a moved time origin on the same page does not (revision 18, A18-T2)", () => {
    const m = mark();
    line(100, "data.sync_tick", { why: "now", coalesced: false });
    harness.engineEpochs.push({ generation: 2, run: 1, trace: 1 });
    const w = witnessOf(m);
    expect(w?.read.epochs).toEqual([{ generation: 2, run: 1, trace: 1 }]);
    expect(syncWitnessSelection(w).problem).toBe(
      "the engine was started again during the sample",
    );
    harness.engineEpochs.pop();
    harness.page = "page-2";
    expect(syncWitnessSelection(witnessOf(m)).problem).toBe(
      "the page was reloaded or replaced during the sample",
    );
    harness.page = "page-1";
    // REVISION 18 ADAPTATION (A18-T2): the page instance is the identity; a time origin that moved on it (WebKit's follows the wall clock)
    // neither makes the read return at once nor refuses the sample as a reload.
    const drifted = { ...m, time_origin: m.time_origin + 1 };
    expect(witnessOf(drifted)).toBeNull();
    expect(syncWitnessSelection(witnessOf(drifted, true)).problem).not.toBe(
      "the page was reloaded or replaced during the sample",
    );
  });
});

/** A scripted page: every poll evaluates the page function and, while it has no answer, lets the scripted engine take ONE action. */
let actions: Array<() => void> = [];
const scripted = (limit = 60): SamplePage => ({
  async poll(fn, arg, o) {
    const page = isolated(fn);
    for (let n = 0; n < limit; n += 1) {
      const out = page(arg);
      if (out !== null) return out;
      await Promise.resolve();
      actions.shift()?.();
    }
    throw new Error(`Timeout ${o.timeout}ms exceeded`);
  },
  async run(fn, arg) {
    actions.shift()?.();
    return await isolated(fn)(arg);
  },
});
let at = 1_000;
/**
 * A healthy step's three actions: its tick, then its request and commit, then its end. Its pre-issue time cycles 2, 2.5, 3 (request 8.5,
 * 8, 7.5; post-response 4.5; total 15), so a sample carrying another sample's values is visible.
 */
let steps = 0;
const healthyStep = (pre = 2 + (steps++ % 3) * 0.5) => {
  at += 100;
  const t = at;
  return [
    () => line(t, "data.sync_tick", { why: "now", coalesced: false }),
    () => {
      resources.push({
        name: SYNC,
        startTime: t + 1.2,
        requestStart: t + pre,
        responseEnd: t + 10.5,
      });
      line(t + 15, "data.sync_commit", { kind: "applied", value: "committed" });
    },
    () => line(t + 16, "data.sync_next", { when: "after", state: "idle" }),
  ] as const;
};
/** Review 13's no-request step (a stop) and, later, a requesting timer step. */
const stoppedThenTimer = () => {
  at += 100;
  const t = at;
  const later = healthyStep();
  return [
    () => line(t, "data.sync_tick", { why: "now", coalesced: false }),
    () => line(t + 1, "data.sync_next", { when: "after", state: "stopped" }),
    ...later,
  ];
};
const OPTIONS = { timeout: 30_000, polling: 5 };

describe("P-4/P-10 sync: the shared collector both writers call (Q2)", () => {
  beforeEach(() => {
    actions = [];
    at = 1_000;
    steps = 0;
  });

  it("control: warm-ups and samples are each one mark, one read and the rule; only the samples are kept, indexed after the warm-ups, each mark after the previous read", async () => {
    harness.onNudge = () => actions.push(...healthyStep());
    const c = await collectSyncSamples(scripted(), {
      ...OPTIONS,
      warmup: 2,
      samples: 3,
    });
    expect(c.failure).toBeNull();
    expect(harness.nudges).toBe(5);
    expect(c.samples.map((e) => e.index)).toEqual([2, 3, 4]);
    // Steps 0-1 were the warm-ups (pre-issue 2, 2.5); the samples are steps 2-4 (3, 2, 2.5).
    expect(c.values).toEqual(
      [3, 2, 2.5].map((pre) => ({
        pre_issue_ms: pre,
        request_ms: 10.5 - pre,
        post_response_ms: 4.5,
        total_ms: 15,
        duration_ms: expect.closeTo(9.3, 9),
      })),
    );
    for (const [k, e] of c.samples.entries()) {
      expect(e.read.to).toBe(e.mark.from + e.lines.length);
      if (k > 0)
        expect(e.mark.from).toBeGreaterThanOrEqual(
          c.samples[k - 1]?.read.to ?? 0,
        );
      expect(syncWitnessSelection(e).selected).toEqual(e.selected);
    }
  });

  it("control (revision 18, A18-T2): a time origin that moves on the same page instance, inside each sample and between samples, keeps the collection complete with the same values and selections", async () => {
    // macOS WebKit moves `performance.timeOrigin` with the disciplined wall clock (+1 ms every 92 s on one still page, measured).
    let origin = 2_000_000;
    vi.spyOn(performance, "timeOrigin", "get").mockImplementation(() => origin);
    harness.onNudge = () => {
      origin += 1;
      actions.push(...healthyStep());
    };
    const c = await collectSyncSamples(scripted(), {
      ...OPTIONS,
      warmup: 2,
      samples: 3,
    });
    expect(c.failure).toBeNull();
    expect(c.samples.map((e) => e.index)).toEqual([2, 3, 4]);
    expect(c.values).toEqual(
      [3, 2, 2.5].map((pre) => ({
        pre_issue_ms: pre,
        request_ms: 10.5 - pre,
        post_response_ms: 4.5,
        total_ms: 15,
        duration_ms: expect.closeTo(9.3, 9),
      })),
    );
    for (const e of c.samples) {
      expect(e.read.time_origin).toBe(e.mark.time_origin + 1);
      expect(syncWitnessSelection(e).selected).toEqual(e.selected);
    }
    expect(c.samples[2]?.mark.time_origin).toBe(2_000_004);
  });

  it("case: a step open at the mark (a timer step already running) is waited for, never marked over; the sample is the next step", async () => {
    line(900, "data.sync_tick", { why: "timer", coalesced: false });
    actions.push(
      () => {},
      () => line(905, "data.sync_next", { when: "after", state: "idle" }),
    );
    harness.onNudge = () => actions.push(...healthyStep());
    const c = await collectSyncSamples(scripted(), {
      ...OPTIONS,
      warmup: 0,
      samples: 1,
    });
    expect(c.failure).toBeNull();
    expect(c.samples[0]?.mark.from).toBe(2);
    expect(c.values[0]?.pre_issue_ms).toBe(2);
  });

  it("case (review 13 R2): a sample whose first step ends without a request stops the collection there with its witness; the later timer step's request is never charged to it and no further sample is taken", async () => {
    let n = 0;
    harness.onNudge = () => {
      n += 1;
      actions.push(...(n === 4 ? stoppedThenTimer() : healthyStep()));
    };
    const c = await collectSyncSamples(scripted(), {
      ...OPTIONS,
      warmup: 1,
      samples: 5,
    });
    expect(c.samples.map((e) => e.index)).toEqual([1, 2]);
    expect(c.values).toHaveLength(2);
    expect(harness.nudges).toBe(4);
    expect(c.failure).toMatchObject({ index: 3, warmup: false });
    expect(c.failure?.problem).toMatch(
      /^the sample's step ended without a commit \(\d+ms data\.sync_next \{"when":"after","state":"stopped"\}\): no later step can stand for it$/,
    );
    const w = c.failure?.witness as { lines: string[] };
    expect(w.lines.map((l) => l.split(" ")[1])).toEqual([
      "data.sync_tick",
      "data.sync_next",
    ]);
  });

  it("case: a warm-up's failure stops the collection as a warm-up failure (no sample kept); a step that never ends is read once more at the time-out and fails as pending", async () => {
    harness.onNudge = () => actions.push(...stoppedThenTimer());
    const c = await collectSyncSamples(scripted(), {
      ...OPTIONS,
      warmup: 2,
      samples: 2,
    });
    expect(c.samples).toEqual([]);
    expect(c.failure).toMatchObject({ index: 0, warmup: true });
    restartTrace();
    actions = [];
    harness.onNudge = () =>
      actions.push(() =>
        line(5_000, "data.sync_tick", { why: "now", coalesced: false }),
      );
    const d = await collectSyncSamples(scripted(10), {
      ...OPTIONS,
      warmup: 0,
      samples: 1,
    });
    expect(d.failure).toMatchObject({
      index: 0,
      problem: "the sample's step has not ended within 30000 ms",
    });
    expect(d.failure).not.toBeNull();
    expect(
      (d.failure?.witness as { lines: string[] } | undefined)?.lines,
    ).toHaveLength(1);
  });
});

describe("P-4/P-10 sync: consecutive samples in one collector (revision 16, review 16 R16-SYNC, DA16-S2, Q3)", () => {
  beforeEach(() => {
    actions = [];
    at = 1_000;
    steps = 0;
  });
  /** The collector's page with the n-th mark (from 1) edited as it leaves the page: a mark the page clock or trace could not produce. */
  const editedMark = (
    n: number,
    edit: (m: SyncMark) => SyncMark,
  ): SamplePage => {
    const base = scripted();
    let marks = 0;
    return {
      async poll(fn, arg, o) {
        const out = await base.poll(fn, arg, o);
        if ((fn as unknown) !== prepareSyncSample) return out;
        marks += 1;
        return (marks === n ? edit(out as SyncMark) : out) as typeof out;
      },
      run: base.run,
    };
  };

  it("control: each mark follows the previous read in position and time, a tie included (the page clock does not move between a read and the next mark)", async () => {
    harness.onNudge = () => actions.push(...healthyStep());
    const c = await collectSyncSamples(scripted(), {
      ...OPTIONS,
      warmup: 1,
      samples: 3,
    });
    expect(c.failure).toBeNull();
    for (const [k, e] of c.samples.entries()) {
      expect(e.mark.at).toBeLessThanOrEqual(e.read.at);
      if (k > 0) {
        const previous = c.samples[k - 1]?.read;
        expect(e.mark.from).toBeGreaterThanOrEqual(previous?.to ?? Infinity);
        expect(e.mark.at).toBe(previous?.at);
      }
    }
  });

  it("cases: a mark timed before the previous read, or positioned before its end, stops the collection at that sample with its mark kept; nothing further is nudged", async () => {
    for (const [edit, label] of [
      [(m: SyncMark) => ({ ...m, at: m.at - 5 }), "time"],
      [(m: SyncMark) => ({ ...m, from: m.from - 1 }), "position"],
    ] as const) {
      restartTrace();
      actions = [];
      harness.nudges = 0;
      harness.onNudge = () => actions.push(...healthyStep());
      const c = await collectSyncSamples(editedMark(3, edit), {
        ...OPTIONS,
        warmup: 1,
        samples: 3,
      });
      expect(c.failure, label).toMatchObject({
        index: 2,
        warmup: false,
        problem: "the sample's mark does not follow the previous sample's read",
      });
      expect(c.failure?.witness).toMatchObject({ mark: expect.any(Object) });
      expect(
        c.samples.map((e) => e.index),
        label,
      ).toEqual([1]);
      expect(harness.nudges, label).toBe(3);
    }
  });

  it("cases (Q3): a second ResourceTiming clear during a sample (another collector on the page) leaves the step's request unseen: the read waits, is forced at the time-out and fails, never borrowing a later entry; a stop traced after a completed step does not undo it", async () => {
    harness.onNudge = () => {
      const [tick, requestAndCommit, end] = healthyStep();
      actions.push(
        tick,
        () => {
          requestAndCommit();
          resources = [];
        },
        end,
      );
    };
    const c = await collectSyncSamples(scripted(12), {
      ...OPTIONS,
      warmup: 0,
      samples: 2,
    });
    expect(c.samples).toEqual([]);
    expect(c.failure).toMatchObject({
      index: 0,
      problem:
        "0 /sync requests lie inside the operation (0 since the sample began)",
    });
    expect(harness.nudges).toBe(1);
    // A stop after the step ended (the engine stopped before the read): the completed step stays the sample.
    restartTrace();
    resources = [];
    actions = [];
    harness.onNudge = () => {
      const [tick, requestAndCommit, end] = healthyStep();
      actions.push(tick, requestAndCommit, () => {
        end();
        line(pageClock + 1, "data.sync_next", {
          when: "event",
          state: "stopped",
        });
      });
    };
    const d = await collectSyncSamples(scripted(), {
      ...OPTIONS,
      warmup: 0,
      samples: 1,
    });
    expect(d.failure).toBeNull();
    expect(d.samples[0]?.lines.at(-1)).toContain('"state":"stopped"');
  });
});

/**
 * WEB-09c revision 16 (review 16 R16-SYNC, design assessment DA16-S1, invariants I1-I4, Q0-Q2): `sync-request-sample/3` judged on a
 * HAND-WRITTEN witness (no generator, no selector as the oracle). Mark at 99.6 (unrounded page clock); trace 20-23: the real tick 100, a
 * coalesced wake 101, the commit 115 and the end 115 (rounded lines); one entry 100.5/102/110.5 named as the writer stores it; read at
 * 115.4. Values by hand: pre-issue 2, request 8.5, post-response 4.5, total 15, duration 10.
 */
describe("P-4/P-10 sync `sync-request-sample/3`: the observation interval and the endpoint on a hand-written witness (revision 16, Q1/Q2)", () => {
  const PATH = "/api/experimental/v1/sync";
  // biome-ignore lint/suspicious/noExplicitAny: a hand-written JSON witness, edited freely by each case
  const healthyWitness = (): any => ({
    mark: {
      page: "page-1",
      time_origin: 1000.5,
      epochs: 1,
      generation: 1,
      from: 20,
      at: 99.6,
    },
    read: {
      page: "page-1",
      time_origin: 1000.5,
      epochs: [],
      generation: 1,
      to: 24,
      at: 115.4,
      resource_entries: 1,
    },
    lines: [
      '100ms data.sync_tick {"why":"nudge","coalesced":false}',
      '101ms data.sync_tick {"why":"wake","coalesced":true}',
      '115ms data.sync_commit {"kind":"applied","value":"committed"}',
      '115ms data.sync_next {"when":"after","state":"idle"}',
    ],
    resources: [
      { name: PATH, startTime: 100.5, requestStart: 102, responseEnd: 110.5 },
    ],
  });
  const SELECTED = { start: 20, commit: 22, end: 23, request: 0 };
  const VALUES = {
    pre_issue_ms: 2,
    request_ms: 8.5,
    post_response_ms: 4.5,
    total_ms: 15,
    duration_ms: 10,
  };
  // biome-ignore lint/suspicious/noExplicitAny: see above
  const judge = (edit: (w: any) => void) => {
    const w = healthyWitness();
    edit(w);
    return syncWitnessSelection(w);
  };

  it("the writer's route: the stored pathnames are the API client's (`apiUrl`), without the query, and the methods are the successors", () => {
    expect(apiUrl("/sync").pathname).toBe(PATH);
    expect(SYNC_PATH).toBe(PATH);
    expect(apiUrl("/commands").pathname).toBe(COMMANDS_PATH);
    expect(new URL(SYNC).pathname).toBe(PATH);
    // Revision 18 (adapted, version literal only; A18-T2): the successors are `/4` and `/6`.
    expect([SYNC_WITNESS_METHOD, DRAFT_WITNESS_METHOD]).toEqual([
      "sync-request-sample/4",
      "draft-request-sample/6",
    ]);
    // The page read stores exactly that pathname from a full URL with its query.
    resources = [{ name: SYNC, startTime: 1, requestStart: 2, responseEnd: 3 }];
    const m = mark();
    line(1, "data.sync_tick", { why: "now", coalesced: false });
    expect(witnessOf(m, true)?.resources.map((r) => r.name)).toEqual([]);
    resources = [
      { name: SYNC, startTime: 1.5, requestStart: 2, responseEnd: 3 },
    ];
    expect((witnessOf(m, true) as SyncWitness).resources[0]?.name).toBe(PATH);
  });

  it("controls: the healthy ordinary and 250 ms steps, zero and tied times, the 1 ms trace rounding at each end, a coalesced tail and a later step inside the read keep their hand-computed values", () => {
    expect(judge(() => {})).toEqual({
      status: "complete",
      problem: null,
      selected: SELECTED,
      values: VALUES,
    });
    // P-10: the proxy holds the response 250 ms.
    expect(
      judge((w) => {
        w.lines[2] =
          '353ms data.sync_commit {"kind":"applied","value":"committed"}';
        w.lines[3] = '353ms data.sync_next {"when":"after","state":"idle"}';
        w.resources[0] = {
          name: PATH,
          startTime: 100.5,
          requestStart: 101,
          responseEnd: 351,
        };
        w.read.at = 353.2;
      }),
    ).toEqual({
      status: "complete",
      problem: null,
      selected: SELECTED,
      values: {
        pre_issue_ms: 1,
        request_ms: 250,
        post_response_ms: 2,
        total_ms: 253,
        duration_ms: 250.5,
      },
    });
    // Zero and tied: everything at the page's first millisecond.
    expect(
      judge((w) => {
        w.mark.at = 0;
        w.read.at = 0;
        w.lines = [
          '0ms data.sync_tick {"why":"nudge","coalesced":false}',
          '0ms data.sync_commit {"kind":"applied","value":"committed"}',
          '0ms data.sync_next {"when":"after","state":"idle"}',
        ];
        w.read.to = 23;
        w.resources[0] = {
          name: PATH,
          startTime: 0,
          requestStart: 0,
          responseEnd: 0,
        };
      }),
    ).toMatchObject({
      status: "complete",
      selected: { start: 20, commit: 21, end: 22, request: 0 },
      values: {
        pre_issue_ms: 0,
        request_ms: 0,
        post_response_ms: 0,
        total_ms: 0,
        duration_ms: 0,
      },
    });
    // The rounding: a line 1 ms before the mark and 1 ms after the read is inside (the entry stays on the unrounded clock).
    expect(
      judge((w) => {
        w.mark.at = 101;
        w.resources[0].startTime = 101.5;
        w.read.at = 114;
      }),
    ).toMatchObject({
      status: "complete",
      selected: SELECTED,
      values: { ...VALUES, duration_ms: 9 },
    });
    // A coalesced tail and a later real step (its own entry) inside the read: the sample is still the first step's.
    expect(
      judge((w) => {
        w.lines.push(
          '116ms data.sync_tick {"why":"wake","coalesced":true}',
          '117ms data.sync_tick {"why":"timer","coalesced":false}',
          '121ms data.sync_commit {"kind":"applied","value":"committed"}',
          '121ms data.sync_next {"when":"after","state":"idle"}',
        );
        w.read.to = 28;
        w.read.at = 121.3;
        w.read.resource_entries = 2;
        w.resources.push({
          name: PATH,
          startTime: 117.5,
          requestStart: 118,
          responseEnd: 119.5,
        });
      }),
    ).toEqual({
      status: "complete",
      problem: null,
      selected: SELECTED,
      values: VALUES,
    });
    // A buffer one short of full is complete.
    expect(
      judge((w) => {
        w.read.resource_entries = 249;
      }).status,
    ).toBe("complete");
  });

  it("cases (I1, I2): the observation's own times, the engine's start and the slice's chronology refuse the sample with their own reason, and nothing throws", () => {
    // biome-ignore lint/suspicious/noExplicitAny: a hand-written JSON witness, edited freely by each case
    const cases: Array<[string, (w: any) => void, string]> = [];
    const markTime = "its mark records no finite, non-negative page time";
    const readTime = "its read records no finite, non-negative page time";
    for (const [what, value] of [
      ["missing", undefined],
      ["null", null],
      ["a string", "99.6"],
      ["negative", -1],
    ] as const) {
      cases.push([
        `mark time ${what}`,
        (w) => {
          if (value === undefined) delete w.mark.at;
          else w.mark.at = value;
        },
        markTime,
      ]);
      cases.push([
        `read time ${what}`,
        (w) => {
          if (value === undefined) delete w.read.at;
          else w.read.at = value;
        },
        readTime,
      ]);
    }
    cases.push(
      // Direct-selector inputs only (JSON writes NaN and Infinity as null, covered above).
      [
        "mark time NaN",
        (w) => {
          w.mark.at = Number.NaN;
        },
        markTime,
      ],
      [
        "read time Infinity",
        (w) => {
          w.read.at = Number.POSITIVE_INFINITY;
        },
        readTime,
      ],
      // Review 16's schedules.
      [
        "both observation times missing",
        (w) => {
          delete w.mark.at;
          delete w.read.at;
        },
        markTime,
      ],
      [
        "read timed before the mark",
        (w) => {
          w.read.at = 99;
        },
        "its read is timed before its mark",
      ],
      [
        "the step end traced at 1 ms, before its tick",
        (w) => {
          w.lines[3] = '1ms data.sync_next {"when":"after","state":"idle"}';
        },
        "a trace line (23) precedes the sample's mark",
      ],
      // The engine (I1): matching absent generations are no started engine.
      [
        "no engine start recorded at the mark",
        (w) => {
          w.mark.epochs = 0;
        },
        "the sample's engine had not been started",
      ],
      [
        "no generation at either end",
        (w) => {
          w.mark.generation = null;
          w.read.generation = null;
        },
        "the sample's engine had not been started",
      ],
      [
        "a generation as a string at both ends",
        (w) => {
          w.mark.generation = "1";
          w.read.generation = "1";
        },
        "the sample's engine had not been started",
      ],
      [
        "an empty page identity",
        (w) => {
          w.mark.page = "";
          w.read.page = "";
        },
        "the page was reloaded or replaced during the sample",
      ],
      // The chronology (I2).
      [
        "the commit traced before the tick",
        (w) => {
          w.lines[2] =
            '99ms data.sync_commit {"kind":"applied","value":"committed"}';
        },
        "the trace's times go back (line 22)",
      ],
      [
        "the end traced before its commit (inside the rounding)",
        (w) => {
          w.lines[3] = '114ms data.sync_next {"when":"after","state":"idle"}';
        },
        "the trace's times go back (line 23)",
      ],
      [
        "the tick 1.5 ms before the mark",
        (w) => {
          w.mark.at = 101.5;
          w.resources[0].startTime = 101.6;
        },
        "a trace line (20) precedes the sample's mark",
      ],
      [
        "the end 1.5 ms after the read",
        (w) => {
          w.read.at = 113.5;
        },
        "a trace line (22) follows the sample's read",
      ],
      [
        "a coalesced tail after the read",
        (w) => {
          w.lines.push('130ms data.sync_tick {"why":"wake","coalesced":true}');
          w.read.to = 25;
        },
        "a trace line (24) follows the sample's read",
      ],
      [
        "an untimed line",
        (w) => {
          w.lines[1] = 'data.sync_tick {"why":"wake","coalesced":true}';
        },
        "a trace line (21) carries no time or event",
      ],
      [
        "a malformed line where the step began (never skipped for a later step)",
        (w) => {
          w.lines[0] = "garbage";
        },
        "a trace line (20) carries no time or event",
      ],
    );
    for (const [label, edit, problem] of cases) {
      let s: ReturnType<typeof judge> | undefined;
      expect(() => {
        s = judge(edit);
      }, label).not.toThrow();
      expect(s, label).toEqual({
        status: "invalid",
        problem,
        selected: null,
        values: null,
      });
    }
  });

  it("cases (I3, I4): every retained entry is the exact /sync pathname with usable timing inside the observation; prior, duplicate and overlapping entries keep their reasons", () => {
    const foreign = (name: unknown) =>
      `a retained request entry is not the /sync endpoint (${String(name)})`;
    // biome-ignore lint/suspicious/noExplicitAny: a hand-written JSON witness, edited freely by each case
    const cases: Array<[string, (w: any) => void, string]> = [
      ...(
        [
          "/not-sync",
          "/sync",
          `${PATH}-extra`,
          `${PATH}?limit=200`,
          `http://127.0.0.1:4100${PATH}`,
          "/api/experimental/v1/commands",
          "/api/experimental/v2/sync",
          "",
          null,
          5,
        ] as const
      ).map(
        // biome-ignore lint/suspicious/noExplicitAny: see above
        (name): [string, (w: any) => void, string] => [
          `entry named ${String(name)}`,
          (w) => {
            w.resources[0].name = name;
          },
          foreign(name),
        ],
      ),
      [
        "entry with no name",
        (w) => {
          delete w.resources[0].name;
        },
        foreign(undefined),
      ],
      [
        "a later foreign entry inside the read",
        (w) => {
          w.read.resource_entries = 2;
          w.resources.push({
            name: "/not-sync",
            startTime: 112,
            requestStart: 112,
            responseEnd: 113,
          });
        },
        foreign("/not-sync"),
      ],
      [
        "an entry that began before the mark (inside the trace's rounding)",
        (w) => {
          w.resources[0].startTime = 99.5;
        },
        "a /sync request entry lies outside the sample's observation",
      ],
      [
        "an entry that ended after the read (inside the commit's rounding)",
        (w) => {
          w.resources[0].responseEnd = 115.5;
        },
        "a /sync request entry lies outside the sample's observation",
      ],
      [
        "a negative start",
        (w) => {
          w.resources[0].startTime = -0.5;
        },
        "a request entry has no usable timing",
      ],
      [
        "reversed request and response",
        (w) => {
          w.resources[0].requestStart = 111;
        },
        "a request entry has no usable timing",
      ],
      [
        "a missing response end",
        (w) => {
          delete w.resources[0].responseEnd;
        },
        "a request entry has no usable timing",
      ],
      [
        "fewer buffer entries than retained entries",
        (w) => {
          w.read.resource_entries = 0;
        },
        "the witness retains more requests than the buffer held",
      ],
      [
        "a full buffer",
        (w) => {
          w.read.resource_entries = 250;
        },
        "the resource-timing buffer was full: requests may be missing",
      ],
      [
        "a duplicate entry",
        (w) => {
          w.read.resource_entries = 2;
          w.resources.push({ ...w.resources[0] });
        },
        "2 /sync requests lie inside the operation (2 since the sample began)",
      ],
      [
        "a prior entry (before the step, after the mark)",
        (w) => {
          w.mark.at = 90;
          w.read.resource_entries = 2;
          w.resources.unshift({
            name: PATH,
            startTime: 90.5,
            requestStart: 91,
            responseEnd: 95,
          });
        },
        "a /sync request began before the sample's operation",
      ],
      [
        "an entry overlapping the step's end (inside the read)",
        (w) => {
          w.read.at = 130;
          w.read.resource_entries = 2;
          w.resources.push({
            name: PATH,
            startTime: 114,
            requestStart: 114,
            responseEnd: 125,
          });
        },
        "a /sync request overlaps the sample's operation without lying inside it",
      ],
    ];
    for (const [label, edit, problem] of cases) {
      let s: ReturnType<typeof judge> | undefined;
      expect(() => {
        s = judge(edit);
      }, label).not.toThrow();
      expect(s, label).toEqual({
        status: "invalid",
        problem,
        selected: null,
        values: null,
      });
    }
  });

  it("pending stays pending: a forced read before the step's end, inside its observation, yields no value; a contradiction appended later stays invalid", () => {
    expect(
      judge((w) => {
        w.lines = w.lines.slice(0, 2);
        w.read.to = 22;
        w.read.at = 101.2;
        w.resources = [];
        w.read.resource_entries = 0;
      }),
    ).toEqual({
      status: "pending",
      problem: "the sample's step has not ended",
      selected: null,
      values: null,
    });
    // The first step ended without a commit: a later healthy step inside the read cannot stand for it.
    expect(
      judge((w) => {
        w.lines = [
          '100ms data.sync_tick {"why":"nudge","coalesced":false}',
          '101ms data.sync_next {"when":"event","state":"waiting"}',
          '102ms data.sync_tick {"why":"online","coalesced":false}',
          '115ms data.sync_commit {"kind":"applied","value":"committed"}',
          '115ms data.sync_next {"when":"after","state":"idle"}',
        ];
        w.read.to = 25;
        w.resources[0].startTime = 102.5;
        w.resources[0].requestStart = 103;
      }).problem,
    ).toBe(
      'the sample\'s step ended without a commit (101ms data.sync_next {"when":"event","state":"waiting"}): no later step can stand for it',
    );
  });
});

// ---- P-4 draft (revision 14; review 14 R2, design assessment DA-R14-A/B/C, Q1-Q5) -----------------------------------------------------------
// The actual page functions (rebuilt from their source text) and collector over the harness double, now with a dispatch identity, the
// observed dispatcher's records and the bound service's row read. Every schedule writes the dispatcher's acts in production order
// (outbox-dispatcher.ts `attempt`/`answer`: the claim commit, `data.outbox_send`, the stamped request keyed by the local ID, its response,
// `data.outbox_answer`, THEN the receipt commit, whose result arrives later) and every expected value and problem is stated here by hand.
// Revision 13's three draft cases are carried as labelled adaptations: its healthy control is Q1's control (the completion is now the
// receipt record, not a later queue status), its aborted-then-resent case keeps its expected problem, and its "outcome never recorded"
// case is the pending receipt below.
describe("P-4 draft: one send, its answer, its request and its own completion per sample (revision 14, Q1-Q5)", () => {
  let clock = 0;
  let lastRequest = -1;
  let lastReceipt = -1;
  let enqueues = 0;
  const COMMANDS = "http://127.0.0.1:4100/api/experimental/v1/commands";
  const PATH = "/api/experimental/v1/commands";
  beforeEach(() => {
    actions = [];
    clock = 0;
    enqueues = 0;
    vi.spyOn(performance, "now").mockImplementation(() => clock);
  });
  /** A record of the observed dispatcher: the actor (dispatcher, run, service, epoch) as the identity says NOW unless given. */
  const rec = (event: string, fields: Record<string, unknown>) => {
    const seq = harness.seq;
    harness.seq += 1;
    harness.log.push({
      seq,
      at: clock,
      event,
      dispatcher: harness.identity.dispatcher,
      run: harness.identity.run,
      ...fields,
    });
    return seq;
  };
  const actor = () => ({
    service: harness.identity.service,
    epoch: harness.identity.epoch,
  });
  /** The dispatcher's acts on draft `id`, one step each (a step is what happens between two observations). */
  const act = {
    claim:
      (id: string, at: number, end = at + 0.5) =>
      () => {
        clock = at;
        const of = rec("commit_begin", {
          plan: "data.markInFlight",
          local_id: id,
          ...actor(),
        });
        clock = end;
        rec("commit_end", {
          of,
          plan: "data.markInFlight",
          local_id: id,
          ...actor(),
          outer: "applied",
          inner: "claimed",
        });
        const row = harness.rows.find((r) => r.local_id === id);
        if (row) row.status = "in_flight";
      },
    send:
      (id: string, at: number, resend = false) =>
      () => {
        clock = at;
        harness.outbox.push(
          `${at}ms data.outbox_send ${JSON.stringify({ resend })}`,
        );
        lastRequest = rec("request_begin", { key: id, path: PATH });
      },
    respond:
      (
        id: string,
        r: { startTime: number; requestStart: number; responseEnd: number },
      ) =>
      () => {
        resources.push({ name: COMMANDS, ...r });
        clock = r.responseEnd + 0.1;
        rec("request_end", {
          of: lastRequest,
          key: id,
          path: PATH,
          outer: "response",
          http: 200,
        });
      },
    abort: (id: string, at: number) => () => {
      clock = at;
      rec("request_end", {
        of: lastRequest,
        key: id,
        path: PATH,
        outer: "error",
        error: "TypeError",
      });
    },
    /** The answer line, then (synchronously, as production) the receipt commit's call; the clock then stands at `then`. */
    answer:
      (id: string, at: number, then = at + 0.05, kind = "receipt") =>
      () => {
        clock = at;
        harness.outbox.push(
          `${at}ms data.outbox_answer ${JSON.stringify({ kind })}`,
        );
        clock = at + 0.05;
        lastReceipt = rec("commit_begin", {
          plan: "data.admitReceipt",
          local_id: id,
          ...actor(),
        });
        clock = then;
      },
    receipt:
      (
        id: string,
        at: number,
        result: Record<string, unknown> = {
          outer: "applied",
          inner: "admitted",
          removed: false,
        },
      ) =>
      () => {
        clock = at;
        rec("commit_end", {
          of: lastReceipt,
          plan: "data.admitReceipt",
          local_id: id,
          ...actor(),
          ...result,
        });
        if (result.outer !== "applied" || result.inner !== "admitted") return;
        const at_ = harness.rows.findIndex((r) => r.local_id === id);
        if (result.removed === true) harness.rows.splice(at_, 1);
        else if (at_ >= 0)
          harness.rows[at_] = { local_id: id, status: "acknowledged" };
      },
  };
  /** A healthy dispatch of `id` from `base` (the enqueue ends at base + 1): send +9, request +10/+11/+19, answer +20, receipt +30. */
  const healthy = (id: string, base: number) => [
    act.claim(id, base + 4),
    act.send(id, base + 9),
    act.respond(id, {
      startTime: base + 10,
      requestStart: base + 11,
      responseEnd: base + 19,
    }),
    act.answer(id, base + 20, base + 21),
    act.receipt(id, base + 30),
  ];
  /** Each enqueue: the clock moves one millisecond and `schedule(localId, base)` supplies the dispatcher's steps. */
  const enqueueWith = (
    schedule: (localId: string, base: number) => Array<() => void>,
  ) => {
    (
      window as unknown as { __atlasData: { enqueue: unknown } }
    ).__atlasData.enqueue = async () => {
      enqueues += 1;
      const localId = `draft-${harness.rows.length + 1}`;
      harness.rows.push({ local_id: localId, status: "queued" });
      const base = clock;
      clock += 1;
      actions.push(...schedule(localId, base));
      return { kind: "queued", localId };
    };
  };
  /** The page as Playwright drives it: `poll` observes, then lets one step happen; `run` runs the function once. */
  const driven = (limit = 60): SamplePage => ({
    async poll(fn, arg, o) {
      const page = isolated(fn);
      for (let n = 0; n < limit; n += 1) {
        const out = page(arg);
        if (out !== null) return out;
        await Promise.resolve();
        actions.shift()?.();
      }
      throw new Error(`Timeout ${o.timeout}ms exceeded`);
    },
    async run(fn, arg) {
      return await isolated(fn)(arg);
    },
  });
  const OPT = {
    timeout: 30_000,
    polling: 5,
    account: "a",
    person: () => "p",
  };
  const one = (page: SamplePage = driven()) =>
    collectDraftSamples(page, { ...OPT, warmup: 0, samples: 1 });
  const witness = (c: Awaited<ReturnType<typeof one>>) =>
    (c.samples[0] ?? c.failure?.witness) as DraftWitness;

  it("Q1 control: enqueue 1-2, send 10, request 11/12/20, answer 21, timing read 22, receipt completes 40, completion read 41: values 1/8/2/8/1/21; completion is evidence, not an endpoint", async () => {
    enqueueWith((id) => [
      act.claim(id, 5),
      act.send(id, 10),
      act.respond(id, { startTime: 11, requestStart: 12, responseEnd: 20 }),
      act.answer(id, 21, 22),
      act.receipt(id, 40),
    ]);
    harness.onBoundDraft = () => {
      clock = 41;
    };
    clock = 1;
    const c = await one();
    expect(c.failure).toBeNull();
    expect(c.values).toEqual([
      {
        enqueue_ms: 1,
        claim_ms: 8,
        stamping_ms: 2,
        request_ms: 8,
        record_ms: 1,
        total_ms: 21,
      },
    ]);
    const w = witness(c);
    expect(w.timing.done).toBe(22);
    expect(w.completion.at).toBe(41);
    expect(w.records.at(-1)).toMatchObject({
      event: "commit_end",
      plan: "data.admitReceipt",
      at: 40,
      outer: "applied",
      inner: "admitted",
    });
    expect(w.completion.row).toEqual({
      kind: "row",
      local_id: "draft-1",
      status: "acknowledged",
    });
    expect(c.samples[0]?.selected).toEqual({
      send: 0,
      answer: 1,
      request: 0,
      claim: 0,
      issued: 2,
      receipt: 4,
      received: 5,
    });
    expect(draftWitnessSelection(w).selected).toEqual(c.samples[0]?.selected);
  });

  it("Q1/Q2 control: warm-ups and samples each close on their own receipt; a receipt that removed the row (admitted, removed) is complete with the row absent; each mark follows the previous completion read", async () => {
    let n = 0;
    enqueueWith((id, base) => {
      n += 1;
      const steps = healthy(id, base);
      if (n === 3)
        steps[4] = act.receipt(id, base + 30, {
          outer: "applied",
          inner: "admitted",
          removed: true,
        });
      return steps;
    });
    const c = await collectDraftSamples(driven(), {
      ...OPT,
      warmup: 1,
      samples: 3,
    });
    expect(c.failure).toBeNull();
    expect(c.samples.map((e) => [e.index, e.completion.row.kind])).toEqual([
      [1, "row"],
      [2, "absent"],
      [3, "row"],
    ]);
    for (const [k, e] of c.samples.entries()) {
      expect(c.values[k]).toEqual({
        enqueue_ms: 1,
        claim_ms: 8,
        stamping_ms: 2,
        request_ms: 8,
        record_ms: 1,
        total_ms: 21,
      });
      if (k > 0) {
        const previous = c.samples[k - 1]?.completion;
        expect(e.mark.from).toBeGreaterThanOrEqual(previous?.to ?? 0);
        expect(e.mark.log_from).toBeGreaterThanOrEqual(previous?.log_to ?? 0);
      }
    }
    expect(enqueues).toBe(4);
  });

  it("control (revision 18, A18-T2): a time origin that moves on the same page instance between a draft's awaits and between samples keeps every sample complete with the same values and selections", async () => {
    // macOS WebKit moves `performance.timeOrigin` with the disciplined wall clock (+1 ms every 92 s on one still page, measured).
    let origin = 3_000_000;
    vi.spyOn(performance, "timeOrigin", "get").mockImplementation(() => origin);
    // Also during each queue read (between the binding before it and the binding after it).
    const data = (
      window as unknown as { __atlasData: { queue: () => Promise<unknown> } }
    ).__atlasData;
    const queue = data.queue;
    data.queue = async () => {
      origin += 1;
      return queue();
    };
    enqueueWith((id, base) =>
      healthy(id, base).map((step, k) =>
        k === 2
          ? () => {
              origin += 1;
              step();
            }
          : step,
      ),
    );
    const c = await collectDraftSamples(driven(), {
      ...OPT,
      warmup: 1,
      samples: 3,
    });
    expect(c.failure).toBeNull();
    for (const [k, e] of c.samples.entries()) {
      expect(c.values[k]).toEqual({
        enqueue_ms: 1,
        claim_ms: 8,
        stamping_ms: 2,
        request_ms: 8,
        record_ms: 1,
        total_ms: 21,
      });
      expect(
        e.completion.identity_after?.time_origin ?? Number.NaN,
      ).toBeGreaterThan(e.mark.time_origin);
      expect(draftWitnessSelection(e).selected).toEqual(e.selected);
    }
    // Four samples, each moved once during its queue read and once between its awaits.
    expect(origin).toBe(3_000_008);
    data.queue = queue;
  });

  it("Q1 case: a receipt still running at the time-out is pending (never complete); the witness keeps the call; nothing further is enqueued", async () => {
    enqueueWith((id, base) => healthy(id, base).slice(0, 4));
    const c = await collectDraftSamples(driven(12), {
      ...OPT,
      timeout: 40,
      warmup: 0,
      samples: 3,
    });
    expect(c.values).toEqual([]);
    expect(c.failure).toMatchObject({
      index: 0,
      problem: "the draft's receipt transaction has not completed within 40 ms",
    });
    expect(witness(c).records.at(-1)).toMatchObject({
      event: "commit_begin",
      plan: "data.admitReceipt",
    });
    expect(enqueues).toBe(1);
  });

  it("Q1/Q4 case (review 14): answer A, its receipt transaction FAILS, the draft is resent and B's receipt admitted: the sample is invalid at A's failed receipt, also when read after B; B never completes it and the totals never move", async () => {
    for (const late of [false, true]) {
      harness.rows = [];
      harness.outbox = [];
      harness.log = [];
      harness.seq = 0;
      resources = [];
      actions = [];
      enqueueWith((id, base) => [
        ...healthy(id, base).slice(0, 4),
        act.receipt(id, base + 25, { outer: "failed", reason: "abort" }),
        () => {
          rec("write_begin", {
            plan: "data.recordLocalWriteOutcome",
            local_id: null,
            service: harness.identity.service,
          });
        },
        act.send(id, base + 300, true),
        act.respond(id, {
          startTime: base + 301,
          requestStart: base + 302,
          responseEnd: base + 310,
        }),
        act.answer(id, base + 311),
        act.receipt(id, base + 320),
      ]);
      // A late completion read: every later step has happened before the row is read.
      harness.onBoundDraft = late
        ? () => {
            for (let step = actions.shift(); step; step = actions.shift())
              step();
          }
        : () => {};
      clock = 1;
      const c = await one();
      expect(c.values).toEqual([]);
      expect(c.failure?.problem).toBe(
        "the draft's receipt transaction was not applied (failed/abort)",
      );
      const w = witness(c);
      expect(w.timing.done).toBe(22);
      if (late) {
        expect(w.completion.row).toMatchObject({ status: "acknowledged" });
        expect(w.lines).toHaveLength(4);
        expect(w.resources).toHaveLength(2);
      }
    }
  });

  it("Q2 cases: the receipt's actual result decides: dropped, applied/noop, failed are invalid with their own reason; a row contradicting the receipt, a read failure, a row still queued or another draft waiting are invalid; nothing is taken as absence", async () => {
    const cases: Array<
      [string, (id: string, base: number) => Array<() => void>, string]
    > = [
      [
        "dropped",
        (id, base) => [
          ...healthy(id, base).slice(0, 4),
          act.receipt(id, base + 30, {
            outer: "dropped",
            reason: "unverified",
          }),
        ],
        "the draft's receipt transaction was not applied (dropped/unverified)",
      ],
      [
        "noop",
        (id, base) => [
          ...healthy(id, base).slice(0, 4),
          act.receipt(id, base + 30, {
            outer: "applied",
            inner: "noop",
            reason: "not_in_flight",
          }),
        ],
        "the draft's receipt was not admitted (noop/not_in_flight)",
      ],
      [
        "kept but gone",
        (id, base) => [
          ...healthy(id, base),
          () => {
            harness.rows = harness.rows.filter((r) => r.local_id !== id);
          },
        ],
        "the draft's row is gone though its receipt kept it: no recorded relation explains the removal",
      ],
      [
        "removed but present",
        (id, base) => [
          ...healthy(id, base).slice(0, 4),
          act.receipt(id, base + 30, {
            outer: "applied",
            inner: "admitted",
            removed: true,
          }),
          () => {
            harness.rows.push({ local_id: id, status: "acknowledged" });
          },
        ],
        "the receipt removed the draft's row but the completion read found it (acknowledged)",
      ],
      [
        "still queued",
        (id, base) => [
          ...healthy(id, base),
          () => {
            const row = harness.rows.find((r) => r.local_id === id);
            if (row) row.status = "queued";
          },
        ],
        "the completion read found the draft queued, not acknowledged",
      ],
      [
        "another waiting",
        (id, base) => [
          ...healthy(id, base),
          () => {
            harness.rows.push({ local_id: "intruder", status: "queued" });
          },
        ],
        "another draft was waiting at the completion read",
      ],
    ];
    for (const [label, schedule, problem] of cases) {
      harness.rows = [];
      harness.outbox = [];
      harness.log = [];
      harness.seq = 0;
      resources = [];
      actions = [];
      enqueueWith(schedule);
      // Whatever the schedule still holds happens before the row is read.
      harness.onBoundDraft = () => {
        for (let step = actions.shift(); step; step = actions.shift()) step();
      };
      const c = await one();
      expect(c.failure?.problem, label).toBe(problem);
      expect(c.values, label).toEqual([]);
    }
    // The row read fails (review 14's unreadable queue): a recorded read failure with its diagnostic, never `absent`.
    harness.rows = [];
    harness.outbox = [];
    harness.log = [];
    harness.seq = 0;
    resources = [];
    actions = [];
    enqueueWith(healthy);
    harness.onBoundDraft = () => {
      throw new Error("independent injected queue read failure");
    };
    const c = await one();
    expect(c.failure?.problem).toBe(
      "the completion read failed: Error: independent injected queue read failure",
    );
    expect(witness(c).completion.row).toEqual({
      kind: "error",
      problem: "Error: independent injected queue read failure",
    });
  });

  it("Q3 cases: the binding is checked at every await: a change during the queue read refuses with nothing enqueued; during the enqueue fails at once; between the timing and completion reads, or during the completion read, fails with what changed", async () => {
    // During the queue read: the dispatcher is rebuilt; nothing is enqueued.
    const queue = (window as unknown as { __atlasData: { queue: unknown } })
      .__atlasData;
    const realQueue = queue.queue as () => Promise<unknown>;
    queue.queue = async () => {
      harness.identity = { ...harness.identity, dispatcher: 2, run: 1 };
      return realQueue();
    };
    enqueueWith(healthy);
    let c = await one();
    expect(c.failure?.problem).toBe(
      "the dispatch binding changed during the queue read: nothing was enqueued",
    );
    expect(enqueues).toBe(0);
    queue.queue = realQueue;
    const reset = () => {
      harness.identity = {
        ...harness.identity,
        page: "page-1",
        dispatcher: 1,
        run: 1,
        running: true,
        service: 2,
        current_service: 2,
        live: true,
        epoch: 3,
        account: "a",
        identity_account: "a",
      };
      harness.rows = [];
      harness.outbox = [];
      harness.log = [];
      harness.seq = 0;
      resources = [];
      actions = [];
    };
    // During the enqueue: the account's service is replaced.
    reset();
    (
      window as unknown as { __atlasData: { enqueue: unknown } }
    ).__atlasData.enqueue = async () => {
      enqueues += 1;
      harness.identity = {
        ...harness.identity,
        service: 3,
        current_service: 3,
      };
      harness.rows.push({ local_id: "draft-1", status: "queued" });
      return { kind: "queued", localId: "draft-1" };
    };
    c = await one();
    expect(c.failure?.problem).toBe(
      "the account service ended or was replaced during the sample (after the enqueue: service, current_service)",
    );
    // Refused at once: nothing is observed or read for a draft the sample no longer owns.
    expect(c.failure?.witness).not.toHaveProperty("timing");
    expect(c.failure?.witness).not.toHaveProperty("completion");
    const between: Array<[string, () => void, string]> = [
      [
        "page replaced",
        () => {
          harness.identity = { ...harness.identity, page: "page-2" };
        },
        "the page was reloaded or replaced during the sample (before the completion read: page)",
      ],
      [
        "dispatcher restarted",
        () => {
          harness.identity = { ...harness.identity, run: 2 };
        },
        "the dispatcher was rebuilt, restarted or stopped during the sample (before the completion read: run)",
      ],
      [
        "service ended",
        () => {
          harness.identity = { ...harness.identity, live: false };
        },
        "the account service ended or was replaced during the sample (before the completion read: live)",
      ],
      [
        "epoch",
        () => {
          harness.identity = { ...harness.identity, epoch: 4 };
        },
        "the account or its epoch changed during the sample (before the completion read: epoch)",
      ],
      [
        "account A, B, A",
        () => {
          // Back on account A, but through a new service object: equal account strings do not hide the change.
          harness.identity = {
            ...harness.identity,
            service: 5,
            current_service: 5,
          };
        },
        "the account service ended or was replaced during the sample (before the completion read: service, current_service)",
      ],
    ];
    for (const [label, change, problem] of between) {
      reset();
      enqueueWith((id, base) => [
        ...healthy(id, base).slice(0, 4),
        change,
        act.receipt(id, base + 30),
      ]);
      harness.onBoundDraft = () => {};
      c = await one();
      expect(c.failure?.problem, label).toBe(problem);
    }
    // During the completion read: the dispatcher is stopped while the row is being read.
    reset();
    enqueueWith(healthy);
    harness.onBoundDraft = async () => {
      await Promise.resolve();
      harness.identity = { ...harness.identity, running: false };
    };
    c = await one();
    expect(c.failure?.problem).toBe(
      "the dispatcher was rebuilt, restarted or stopped during the sample (after the completion read: running)",
    );
    // An OLD completion delivered after the replacement: the receipt result comes from dispatcher 1 while dispatcher 2 is bound.
    reset();
    enqueueWith((id, base) => [
      ...healthy(id, base).slice(0, 4),
      () => {
        harness.identity = { ...harness.identity, dispatcher: 2, run: 1 };
        rec("dispatcher_built", { dispatcher: 2, run: 0 });
      },
      () => {
        clock = base + 30;
        rec("commit_end", {
          of: lastReceipt,
          plan: "data.admitReceipt",
          local_id: id,
          dispatcher: 1,
          run: 1,
          service: 2,
          epoch: 3,
          outer: "applied",
          inner: "admitted",
          removed: false,
        });
      },
    ]);
    harness.onBoundDraft = () => {};
    c = await one();
    expect(c.failure?.problem).toBe(
      "the dispatcher was rebuilt, restarted or stopped during the sample (before the completion read: dispatcher)",
    );
    expect(c.values).toEqual([]);
  });

  it("Q4 cases: another draft's dispatch, a second answer, a further request or send, an earlier sample's late receipt inside the sample, a non-receipt answer and an aborted first attempt (revision 13's case) never yield a value", async () => {
    const cases: Array<
      [string, (id: string, base: number) => Array<() => void>, string]
    > = [
      [
        "another draft claimed",
        (id, base) => [
          ...healthy(id, base).slice(0, 4),
          act.claim("intruder", base + 22),
          act.receipt(id, base + 30),
        ],
        "another draft's dispatch (data.markInFlight) was recorded during the sample",
      ],
      [
        "second answer",
        (id, base) => [
          ...healthy(id, base).slice(0, 4),
          () => {
            harness.outbox.push(
              `${base + 22}ms data.outbox_answer {"kind":"receipt"}`,
            );
          },
          act.receipt(id, base + 30),
        ],
        "a second answer followed the sample's answer",
      ],
      [
        "further request",
        (id, base) => [
          ...healthy(id, base).slice(0, 4),
          act.send(id, base + 22, true),
          act.receipt(id, base + 30),
        ],
        "the draft was requested again during the sample: a later attempt cannot complete the sample's",
      ],
      [
        // Revision 15 (adapted): the late result names its real call, the earlier sample's receipt call recorded BEFORE this sample's
        // mark (record 0, set up below); revision 14's `of: 0` named the result itself, which `/3` refuses as malformed.
        "earlier sample's late receipt",
        (id, base) => [
          () => {
            rec("commit_end", {
              of: 0,
              plan: "data.admitReceipt",
              local_id: "earlier",
              ...actor(),
              outer: "applied",
              inner: "admitted",
              removed: false,
            });
          },
          ...healthy(id, base),
        ],
        "another draft's dispatch (data.admitReceipt) was recorded during the sample",
      ],
      [
        "conflict answer",
        (id, base) => [
          ...healthy(id, base).slice(0, 3),
          act.answer(id, base + 20, base + 21, "conflict"),
          act.receipt(id, base + 30),
        ],
        "the draft's answer was conflict, not a receipt: outside the measured population",
      ],
      [
        "aborted then resent (revision 13's DA-N1 case, adapted)",
        (id, base) => [
          act.claim(id, base + 4),
          act.send(id, base + 9),
          act.abort(id, base + 12),
          act.send(id, base + 100, true),
          act.respond(id, {
            startTime: base + 101,
            requestStart: base + 102,
            responseEnd: base + 110,
          }),
          act.answer(id, base + 111),
          act.receipt(id, base + 120),
        ],
        "the draft was sent again before an answer: a first attempt that got no answer cannot donate its send",
      ],
    ];
    for (const [label, schedule, problem] of cases) {
      harness.rows = [];
      harness.outbox = [];
      harness.log = [];
      harness.seq = 0;
      resources = [];
      actions = [];
      if (label === "earlier sample's late receipt")
        rec("commit_begin", {
          plan: "data.admitReceipt",
          local_id: "earlier",
          ...actor(),
        });
      enqueueWith(schedule);
      harness.onBoundDraft = () => {
        for (let step = actions.shift(); step; step = actions.shift()) step();
      };
      const c = await one();
      expect(c.failure?.problem, label).toBe(problem);
      expect(c.values, label).toEqual([]);
    }
  });

  it("Q5 cases: an unobserved dispatcher refuses; a trimmed record log, a full resource buffer, an entry outside the send and answer, a request no observation saw, a warm-up's failure and a completion read that rejects stop the collection with the witness kept", async () => {
    harness.identity = { ...harness.identity, observing: false };
    enqueueWith(healthy);
    let c = await one();
    expect(c.failure?.problem).toBe(
      "the harness outbox's dispatcher is not observed (observeDispatch)",
    );
    expect(enqueues).toBe(0);
    harness.identity = { ...harness.identity, observing: true };
    const cases: Array<[string, () => void, string]> = [
      [
        "trimmed",
        () => {
          harness.log.splice(0, 1);
        },
        "dispatch records of the sample were trimmed from the log",
      ],
      [
        "buffer full",
        () => {
          resources.push(
            ...Array.from({ length: 249 }, (_, i) => ({
              name: `http://127.0.0.1:4100/asset-${i}.js`,
              startTime: 1,
              requestStart: 1,
              responseEnd: 2,
            })),
          );
        },
        "the resource-timing buffer was full: requests may be missing",
      ],
      // REVISION 16 ADAPTATION (labelled; DA16-S1, invariant I3): revision 14's entry moved 40 ms later now ends after the completion read
      // itself, which no browser can show (an entry is retained only once it has ended), and is refused for that first; the old intent
      // (an entry overlapping the answer, inside the observation) is the 3 ms move, refused with the old reason.
      [
        "entry outside",
        () => {
          const r = resources.find((e) => e.name === COMMANDS);
          if (r) r.responseEnd += 3;
        },
        "a /commands request overlaps the sample's operation without lying inside it",
      ],
      [
        "entry ending after the completion read",
        () => {
          const r = resources.find((e) => e.name === COMMANDS);
          if (r) r.responseEnd += 40;
        },
        "a /commands request entry lies outside the sample's observation",
      ],
    ];
    for (const [label, edit, problem] of cases) {
      harness.rows = [];
      harness.outbox = [];
      harness.log = [];
      harness.seq = 0;
      resources = [];
      actions = [];
      enqueueWith(healthy);
      harness.onBoundDraft = edit;
      c = await one();
      expect(c.failure?.problem, label).toBe(problem);
    }
    // A warm-up's failure is the run's (no sample kept, nothing enqueued after it).
    harness.rows = [];
    harness.outbox = [];
    harness.log = [];
    harness.seq = 0;
    resources = [];
    actions = [];
    enqueues = 0;
    enqueueWith((id, base) => [
      ...healthy(id, base).slice(0, 4),
      act.receipt(id, base + 30, { outer: "failed", reason: "error" }),
    ]);
    harness.onBoundDraft = () => {};
    // A short time-out: a collector that went on after the failed warm-up would wait for the still-in-flight draft and fail by
    // assertion (another draft still waiting at sample 1), never by the test's own time-out.
    c = await collectDraftSamples(driven(), {
      ...OPT,
      timeout: 40,
      warmup: 2,
      samples: 2,
    });
    expect(c.failure).toMatchObject({ index: 0, warmup: true });
    expect(c.samples).toEqual([]);
    expect(enqueues).toBe(1);
    // The completion read rejects (the page's context was destroyed): the sample fails with its mark, enqueue and timing read kept.
    harness.rows = [];
    harness.outbox = [];
    harness.log = [];
    harness.seq = 0;
    resources = [];
    actions = [];
    enqueueWith(healthy);
    clock = 0;
    const page = driven();
    c = await one({
      poll: page.poll,
      run: async (fn, arg) => {
        if ((fn as unknown) === closeDraftSample)
          throw new Error("Execution context was destroyed");
        return page.run(fn, arg);
      },
    });
    expect(c.failure?.problem).toBe(
      "the sample's completion could not be read (Error: Execution context was destroyed)",
    );
    expect(
      (c.failure?.witness as { timing?: { done: number } } | null)?.timing
        ?.done,
    ).toBe(21);
  });

  it("the page functions themselves: an answer whose /commands entry is not yet visible is not read; the completion is not ready while the receipt runs and is ready at once on an identity change or another draft's record", async () => {
    enqueueWith(() => []);
    const prepared = await inPage.prepareDraftSample({
      account: "a",
      person: "q",
      n: 1,
    });
    if (!prepared || "refused" in prepared) throw new Error("not prepared");
    const { mark } = prepared;
    harness.outbox.push(
      `${Math.ceil(clock) + 2}ms data.outbox_send {"resend":false}`,
    );
    harness.outbox.push(
      `${Math.ceil(clock) + 9}ms data.outbox_answer {"kind":"receipt"}`,
    );
    expect(inPage.readDraftSample({ mark, force: false })).toBeNull();
    const ready = () =>
      inPage.draftCompletionReady({
        mark,
        local_id: prepared.local_id as string,
        expected: prepared.identities.enqueued,
      });
    rec("commit_begin", {
      plan: "data.admitReceipt",
      local_id: prepared.local_id,
      ...actor(),
    });
    expect(ready()).toBeNull();
    rec("commit_begin", {
      plan: "data.markInFlight",
      local_id: "other",
      ...actor(),
    });
    expect(ready()).toBe(true);
    harness.log.pop();
    harness.seq -= 1;
    expect(ready()).toBeNull();
    harness.identity = { ...harness.identity, epoch: 9 };
    expect(ready()).toBe(true);
  });

  it("Q2 (revision 15, review 15 R2): the completion read records its start before it awaits the row; a delayed receipt delivered before it completes the sample with its timing values; a receipt result delivered DURING the read (the poll timed out first) is refused, its witness kept and nothing further enqueued", async () => {
    // Control: the receipt's result at 40, the read starts at 40 (a tie), the row is read by 41.
    enqueueWith((id) => [
      act.claim(id, 5),
      act.send(id, 10),
      act.respond(id, { startTime: 11, requestStart: 12, responseEnd: 20 }),
      act.answer(id, 21, 22),
      act.receipt(id, 40),
    ]);
    harness.onBoundDraft = () => {
      clock = 41;
    };
    clock = 1;
    let c = await one();
    expect(c.failure).toBeNull();
    let w = witness(c);
    expect(w.completion.started_at).toBe(40);
    expect(w.completion.log_before).toBe(6);
    expect(w.completion.at).toBe(41);
    expect(w.records.at(-1)).toMatchObject({ seq: 5, at: 40 });
    expect(c.values[0]?.total_ms).toBe(21);
    // Case: the receipt is never delivered while the collector waits; it is delivered while the bound row is being read.
    harness.rows = [];
    harness.outbox = [];
    harness.log = [];
    harness.seq = 0;
    resources = [];
    actions = [];
    enqueues = 0;
    let deliver = () => {};
    enqueueWith((id, base) => {
      deliver = act.receipt(id, base + 30);
      return healthy(id, base).slice(0, 4);
    });
    harness.onBoundDraft = () => deliver();
    c = await collectDraftSamples(driven(30), {
      ...OPT,
      timeout: 40,
      warmup: 0,
      samples: 3,
    });
    expect(c.values).toEqual([]);
    expect(c.failure?.problem).toBe(
      "the receipt's result was delivered during the completion read: the read cannot corroborate it",
    );
    w = witness(c);
    expect(w.completion.log_before).toBe(5);
    expect(w.records.at(-1)).toMatchObject({ seq: 5, event: "commit_end" });
    expect(w.completion.row).toMatchObject({ status: "acknowledged" });
    expect(enqueues).toBe(1);
  });

  it("Q2 (revision 15): consecutive samples: each mark follows the previous completion read in position AND time; the collector's samples satisfy the consumer's frame", async () => {
    enqueueWith(healthy);
    const c = await collectDraftSamples(driven(), {
      ...OPT,
      warmup: 1,
      samples: 3,
    });
    expect(c.failure).toBeNull();
    for (const [k, e] of c.samples.entries()) {
      expect(e.completion.started_at).toBeLessThanOrEqual(e.completion.at);
      expect(e.timing.done).toBeLessThanOrEqual(e.completion.started_at);
      if (k > 0) {
        const previous = c.samples[k - 1]?.completion;
        expect(e.mark.t0).toBeGreaterThanOrEqual(previous?.at ?? Infinity);
        expect(e.mark.log_from).toBeGreaterThanOrEqual(previous?.log_to ?? 0);
      }
    }
  });

  // Revision 17 (review 17 R17-REQUEST/R17-BUFFER, design assessment DA17-BF/RQ, Q8/Q9): the writer's two ResourceTiming snapshots and the
  // collector's first failure. The page's buffer holds unrelated entries too (an asset), so a total is never the request count.
  const ASSET = "http://127.0.0.1:4100/assets/app.js";
  const asset = (at: number) => ({
    name: ASSET,
    startTime: at,
    requestStart: at,
    responseEnd: at + 0.5,
  });

  it("Q8 (revision 17): each read takes its total and its /commands entries from ONE ResourceTiming read of the whole buffer; prepare clears it once, before the mark, and neither read clears it; an unrelated entry between the reads is counted by the completion read only", async () => {
    enqueueWith((id, base) => [
      act.claim(id, base + 4),
      act.send(id, base + 9),
      () => {
        resources.push(asset(base + 9.5));
        act.respond(id, {
          startTime: base + 10,
          requestStart: base + 11,
          responseEnd: base + 19,
        })();
      },
      act.answer(id, base + 20, base + 21),
      () => {
        resources.push(asset(base + 25));
      },
      act.receipt(id, base + 30),
    ]);
    harness.onBoundDraft = () => {
      clock += 1;
    };
    resources = [asset(0)]; // a page entry from before the sample: the mark's clear removes it
    clock = 1;
    const c = await one();
    expect(c.failure).toBeNull();
    expect(clears).toBe(1);
    const w = witness(c);
    expect(w.timing).toMatchObject({ requests: 1, resource_entries: 2 });
    expect(w.completion.resource_entries).toBe(3);
    expect(w.resources).toEqual([
      { name: PATH, startTime: 11, requestStart: 12, responseEnd: 20 },
    ]);
    expect(c.values).toEqual([
      {
        enqueue_ms: 1,
        claim_ms: 8,
        stamping_ms: 2,
        request_ms: 8,
        record_ms: 1,
        total_ms: 21,
      },
    ]);
    // The page functions themselves: one buffer read each, no clear.
    const read = vi.mocked(performance.getEntriesByType);
    resources = [
      asset(1),
      { name: COMMANDS, startTime: 11, requestStart: 12, responseEnd: 20 },
      asset(2),
    ];
    const reads = read.mock.calls.length;
    const timing = readDraftSample({ mark: w.mark, force: true });
    expect(read.mock.calls.length - reads).toBe(1);
    expect(timing).toMatchObject({ requests: 1, resource_entries: 3 });
    resources.push(asset(3));
    const closed = await closeDraftSample({
      mark: w.mark,
      local_id: w.local_id as string,
    });
    expect(read.mock.calls.length - reads).toBe(2);
    expect(closed.completion.resource_entries).toBe(4);
    expect(closed.resources.map((r) => r.name)).toEqual([PATH]);
    expect(clears).toBe(1);
  });

  it("Q9 (revision 17): a call recorded after its entry started, or a buffer cleared and partly refilled between the reads (another collector's clear), stops the collection at that sample, as a warm-up or after a healthy one, with its witness kept, no value and nothing further enqueued", async () => {
    /** The dispatcher's call begins at the send line (+9), half a millisecond after its entry started (+8.5). */
    const lateBegin = (id: string, base: number) => [
      act.claim(id, base + 4),
      act.send(id, base + 9),
      act.respond(id, {
        startTime: base + 8.5,
        requestStart: base + 9.5,
        responseEnd: base + 19,
      }),
      act.answer(id, base + 20, base + 21),
      act.receipt(id, base + 30),
    ];
    /** Two unrelated entries and the request at the timing read; then a clear and only the request back before the completion read. */
    const refilled = (id: string, base: number) => {
      const entry = {
        name: COMMANDS,
        startTime: base + 10,
        requestStart: base + 11,
        responseEnd: base + 19,
      };
      return [
        act.claim(id, base + 4),
        act.send(id, base + 9),
        () => {
          resources.push(asset(base + 9.2), asset(base + 9.4));
          act.respond(id, entry)();
        },
        act.answer(id, base + 20, base + 21),
        () => {
          performance.clearResourceTimings();
          resources.push({ ...entry });
        },
        act.receipt(id, base + 30),
      ];
    };
    const BEGAN =
      "the dispatcher's request began after its /commands entry started: the entry is not that call's";
    const SHRANK =
      "the resource-timing buffer shrank between the timing and completion reads: it was cleared or lost entries";
    for (const [label, bad, problem] of [
      ["late begin", lateBegin, BEGAN],
      ["cleared and refilled", refilled, SHRANK],
    ] as const)
      for (const warm of [true, false]) {
        enqueues = 0;
        clears = 0;
        harness.rows = [];
        let n = 0;
        enqueueWith((id, base) => {
          n += 1;
          return (warm ? n === 1 : n === 2) ? bad(id, base) : healthy(id, base);
        });
        harness.onBoundDraft = () => {
          clock += 1;
        };
        const c = await collectDraftSamples(driven(), {
          ...OPT,
          warmup: 1,
          samples: 2,
        });
        const what = `${label}, ${warm ? "as the warm-up" : "after a healthy warm-up"}`;
        expect(c.values, what).toEqual([]);
        expect(c.samples, what).toEqual([]);
        expect(c.failure, what).toMatchObject({
          index: warm ? 0 : 1,
          warmup: warm,
          problem,
        });
        const kept = c.failure?.witness as DraftWitness;
        expect(
          kept.records.map((r) => r.event),
          what,
        ).toEqual([
          "commit_begin",
          "commit_end",
          "request_begin",
          "request_end",
          "commit_begin",
          "commit_end",
        ]);
        expect(draftWitnessSelection(kept), what).toMatchObject({
          status: "invalid",
          problem,
        });
        expect(enqueues, what).toBe(warm ? 1 : 2);
        actions = [];
      }
  });
});

/**
 * WEB-09c revision 15 (review 15 R2, design assessment DA15-R2a/R2b, Q1): `draft-request-sample/3` judged on a HAND-WRITTEN witness in
 * production order (no generator, no selector as the oracle): enqueue 100→101, claim 102/103, send 109, request begin 109, entry
 * 110/111/119, request result 119.1, answer 120, receipt call 120.05, timing read 121, receipt result 130, completion read 130.5→131.
 * Values by hand: enqueue 1, claim 8, stamping 2, request 8, record 1, total 21.
 */
describe("P-4 draft `draft-request-sample/3`: schema, pairing and the closed interval on a hand-written witness (revision 15, Q1)", () => {
  const PATH = "/api/experimental/v1/commands";
  const I = {
    page: "page-1",
    time_origin: 1000,
    account: "a",
    identity_account: "a",
    epoch: 3,
    service: 2,
    incarnation: "inc-1",
    live: true,
    current_service: 2,
    dispatcher: 1,
    run: 1,
    running: true,
    observing: true,
  };
  const actorOf = { dispatcher: 1, run: 1 };
  const commit = { ...actorOf, service: 2, local_id: "d", epoch: 3 };
  const request = { ...actorOf, key: "d", path: PATH };
  // biome-ignore lint/suspicious/noExplicitAny: a hand-written JSON witness, edited freely by each case
  const healthyWitness = (): any => ({
    local_id: "d",
    account: "a",
    enqueue: { kind: "queued", local_id: "d" },
    identities: { before: I, queued: I, enqueued: I },
    mark: {
      page: "page-1",
      time_origin: 1000,
      from: 10,
      log_from: 4,
      waiting: 0,
      t0: 100,
      t1: 101,
    },
    timing: {
      identity: I,
      to: 12,
      log_to: 9,
      at: 121,
      done: 121,
      requests: 1,
      resource_entries: 1,
    },
    completion: {
      identity_before: I,
      identity_after: I,
      row: { kind: "row", local_id: "d", status: "acknowledged" },
      waiting: 0,
      started_at: 130.5,
      log_before: 10,
      at: 131,
      to: 12,
      log_first: 0,
      log_to: 10,
      resource_entries: 1,
    },
    lines: [
      '109ms data.outbox_send {"resend":false}',
      '120ms data.outbox_answer {"kind":"receipt"}',
    ],
    records: [
      {
        seq: 4,
        at: 102,
        event: "commit_begin",
        plan: "data.markInFlight",
        ...commit,
      },
      {
        seq: 5,
        at: 103,
        event: "commit_end",
        of: 4,
        plan: "data.markInFlight",
        ...commit,
        outer: "applied",
        inner: "claimed",
      },
      { seq: 6, at: 109, event: "request_begin", ...request },
      {
        seq: 7,
        at: 119.1,
        event: "request_end",
        of: 6,
        ...request,
        outer: "response",
        http: 200,
      },
      {
        seq: 8,
        at: 120.05,
        event: "commit_begin",
        plan: "data.admitReceipt",
        ...commit,
      },
      {
        seq: 9,
        at: 130,
        event: "commit_end",
        of: 8,
        plan: "data.admitReceipt",
        ...commit,
        outer: "applied",
        inner: "admitted",
        removed: false,
      },
    ],
    resources: [
      { name: PATH, startTime: 110, requestStart: 111, responseEnd: 119 },
    ],
  });
  const VALUES = {
    enqueue_ms: 1,
    claim_ms: 8,
    stamping_ms: 2,
    request_ms: 8,
    record_ms: 1,
    total_ms: 21,
  };
  // biome-ignore lint/suspicious/noExplicitAny: see above
  const judge = (edit: (w: any) => void) => {
    const w = healthyWitness();
    edit(w);
    return draftWitnessSelection(w);
  };

  it("controls: the healthy witness, a receipt delivered before the timing read, ties at every boundary, the removal branch, a fetch answered before its body ended, and a same-evaluation read inside the answer line's rounding are complete with their hand-computed values", () => {
    expect(judge(() => {})).toEqual({
      status: "complete",
      problem: null,
      selected: {
        send: 10,
        answer: 11,
        request: 0,
        claim: 4,
        issued: 6,
        receipt: 8,
        received: 9,
      },
      values: VALUES,
    });
    // Receipt result BEFORE the timing read (seq 9 inside its position, at 120.5 ≤ 121): same values.
    expect(
      judge((w) => {
        w.records[5].at = 120.5;
        w.timing.log_to = 10;
      }),
    ).toMatchObject({ status: "complete", values: VALUES });
    // Ties: claim result at the request's time (the send's), the read's start at the receipt result's, its end at its start, the timing
    // read at the receipt call's time (total 20.05).
    expect(
      judge((w) => {
        w.records[1].at = 109;
        w.completion.started_at = 130;
        w.completion.at = 130;
        w.timing.done = 120.05;
        w.timing.at = 120.05;
      }),
    ).toMatchObject({
      status: "complete",
      values: { ...VALUES, total_ms: 120.05 - 100 },
    });
    expect(
      judge((w) => {
        w.records[5].removed = true;
        w.completion.row = { kind: "absent" };
      }),
    ).toMatchObject({ status: "complete", values: VALUES });
    // The fetch promise resolves with the headers, before ResourceTiming's responseEnd (the body): not required to follow it.
    expect(
      judge((w) => {
        w.records[3].at = 118;
      }),
    ).toMatchObject({ status: "complete", values: VALUES });
    // Same evaluation as the answer: 0.3 ms before the rounded line, after the receipt call (0.35 before it).
    expect(
      judge((w) => {
        w.records[4].at = 119.65;
        w.timing.done = 119.7;
        w.timing.at = 119.7;
      }),
    ).toMatchObject({
      status: "complete",
      values: { ...VALUES, total_ms: 119.7 - 100 },
    });
  });

  it("cases (review 15 and their claim/request analogues): each contradicted, malformed, misplaced or late record is invalid with its own reason, and nothing throws", () => {
    // biome-ignore lint/suspicious/noExplicitAny: a hand-written JSON witness, edited freely by each case
    const cases: Array<[string, (w: any) => void, string]> = [
      [
        "receipt result omits its service",
        (w) => {
          delete w.records[5].service;
        },
        "dispatch record 9 is malformed: its commit_end names no service",
      ],
      [
        "receipt result null service",
        (w) => {
          w.records[5].service = null;
        },
        "dispatch record 9 is malformed: its commit_end names no service",
      ],
      [
        "receipt result another service",
        (w) => {
          w.records[5].service = 999;
        },
        "a commit result (record 9) contradicts its call (service)",
      ],
      [
        "receipt result epoch +100",
        (w) => {
          w.records[5].epoch = 103;
        },
        "a commit result (record 9) contradicts its call (epoch)",
      ],
      [
        "receipt result another plan",
        (w) => {
          w.records[5].plan = "data.recordOutcome";
        },
        "a commit result (record 9) contradicts its call (plan)",
      ],
      [
        "receipt result another local ID",
        (w) => {
          w.records[5].local_id = "e";
        },
        "a commit result (record 9) contradicts its call (local_id)",
      ],
      [
        "receipt result another dispatcher",
        (w) => {
          w.records[5].dispatcher = 2;
        },
        "a commit result (record 9) contradicts its call (dispatcher)",
      ],
      [
        "receipt result delivered in another run",
        (w) => {
          w.records[5].run = 2;
        },
        "the receipt's result was made by another dispatcher, run or service than the sample's",
      ],
      [
        "receipt result after the read",
        (w) => {
          w.records[5].at = 131 + 60_000;
        },
        "a dispatch record's time (9) contradicts the completion read's start (its record position and its time disagree)",
      ],
      [
        "receipt result without a time",
        (w) => {
          delete w.records[5].at;
        },
        "dispatch record 9 is malformed: its time is not a finite, non-negative page time",
      ],
      [
        "receipt result null time",
        (w) => {
          w.records[5].at = null;
        },
        "dispatch record 9 is malformed: its time is not a finite, non-negative page time",
      ],
      [
        "receipt result non-finite time",
        (w) => {
          w.records[5].at = Number.POSITIVE_INFINITY;
        },
        "dispatch record 9 is malformed: its time is not a finite, non-negative page time",
      ],
      [
        "receipt result negative time",
        (w) => {
          w.records[5].at = -1;
        },
        "dispatch record 9 is malformed: its time is not a finite, non-negative page time",
      ],
      [
        "receipt result failed without reason",
        (w) => {
          w.records[5].outer = "failed";
        },
        "dispatch record 9 is malformed: its failed commit_end names no reason",
      ],
      [
        "receipt result removal not a boolean",
        (w) => {
          w.records[5].removed = "no";
        },
        "dispatch record 9 is malformed: its commit_end's removal is not a boolean",
      ],
      [
        "completion read before the mark",
        (w) => {
          w.completion.at = 100 - 60_000;
        },
        "its completion read's times are not after its timing read and in order",
      ],
      [
        "completion start missing",
        (w) => {
          delete w.completion.started_at;
        },
        "its completion read's times are not after its timing read and in order",
      ],
      [
        "completion start before the timing read",
        (w) => {
          w.completion.started_at = 120;
        },
        "its completion read's times are not after its timing read and in order",
      ],
      [
        "completion start position missing",
        (w) => {
          delete w.completion.log_before;
        },
        "its completion read records no start inside the sample's records",
      ],
      [
        "completion start position before the timing read's",
        (w) => {
          w.completion.log_before = 8;
        },
        "its completion read records no start inside the sample's records",
      ],
      [
        "receipt result delivered during the read",
        (w) => {
          w.completion.log_before = 9;
          w.completion.started_at = 129;
        },
        "the receipt's result was delivered during the completion read: the read cannot corroborate it",
      ],
      [
        "read start position contradicts its time",
        (w) => {
          w.completion.started_at = 129;
        },
        "a dispatch record's time (9) contradicts the completion read's start (its record position and its time disagree)",
      ],
      [
        "timing position contradicts its time",
        (w) => {
          w.timing.log_to = 8;
        },
        "a dispatch record's time (8) contradicts the timing read (its record position and its time disagree)",
      ],
      [
        "timing read with two times",
        (w) => {
          w.timing.at = 122;
        },
        "its timing read does not record one time",
      ],
      [
        "timing read before the enqueue ended",
        (w) => {
          w.timing.done = 100.5;
          w.timing.at = 100.5;
        },
        "its timing read's time is not after the enqueue",
      ],
      [
        "claim result another epoch",
        (w) => {
          w.records[1].epoch = 4;
        },
        "a commit result (record 5) contradicts its call (epoch)",
      ],
      [
        "claim result omits its service",
        (w) => {
          delete w.records[1].service;
        },
        "dispatch record 5 is malformed: its commit_end names no service",
      ],
      [
        "claim result before its call",
        (w) => {
          w.records[1].at = 101.5;
        },
        "the dispatch records' times go back (record 5)",
      ],
      [
        "claim before the mark",
        (w) => {
          w.records[0].at = 99;
        },
        "a dispatch record (4) precedes the sample's mark",
      ],
      [
        "request result another key",
        (w) => {
          w.records[3].key = "e";
        },
        "a request result (record 7) contradicts its call (key)",
      ],
      [
        "request result another path",
        (w) => {
          w.records[3].path = "/x";
        },
        "a request result (record 7) contradicts its call (path)",
      ],
      [
        "request result without HTTP status",
        (w) => {
          delete w.records[3].http;
        },
        "dispatch record 7 is malformed: its answered request_end names no HTTP status",
      ],
      [
        "request result error without its error",
        (w) => {
          w.records[3].outer = "error";
          delete w.records[3].http;
        },
        "dispatch record 7 is malformed: its request_end names no error",
      ],
      [
        "request without a path",
        (w) => {
          delete w.records[2].path;
        },
        "dispatch record 6 is malformed: its request_begin names no key and path",
      ],
      [
        "a result naming another kind",
        (w) => {
          w.records[3].of = 5;
        },
        "a request result (record 7) names a commit_end as its call",
      ],
      [
        "a result naming itself",
        (w) => {
          w.records[5].of = 9;
        },
        "dispatch record 9 is malformed: its commit_end names no earlier call",
      ],
      [
        "two results of one call",
        (w) => {
          w.records[5].of = 4;
        },
        "a commit call (record 4) has two results",
      ],
      [
        "an unknown outcome",
        (w) => {
          w.records[5].outer = "maybe";
        },
        "dispatch record 9 is malformed: its commit_end's outcome (maybe) is not one of applied, dropped, failed, threw, unknown",
      ],
      [
        "an unknown event",
        (w) => {
          w.records[5].event = "mystery";
        },
        "dispatch record 9 is malformed: its event (mystery) is not a dispatch record",
      ],
      [
        "a record that is not an object",
        (w) => {
          w.records[5] = null;
        },
        "its dispatch records are not contiguous from the mark to the completion read",
      ],
      [
        "request to another path than its entry",
        (w) => {
          w.records[2].path = "/x";
          w.records[3].path = "/x";
        },
        "the dispatcher's request was made to another path than its /commands entry",
      ],
      [
        "outbox trace going back",
        (w) => {
          w.lines[1] = '108ms data.outbox_answer {"kind":"receipt"}';
        },
        "the outbox trace's times go back",
      ],
      [
        "outbox line after the read",
        (w) => {
          w.lines.push('140ms data.outbox_send {"resend":true}');
          w.completion.to = 13;
        },
        "an outbox line follows the completion read",
      ],
      [
        "outbox line contradicts the timing read",
        (w) => {
          w.timing.to = 10;
        },
        "an outbox line's time contradicts the timing read (its position and its time disagree)",
      ],
      [
        "a gate of another plan",
        (w) => {
          w.records.push({
            seq: 10,
            at: 130.2,
            event: "commit_gated",
            plan: "data.markInFlight",
            ...actorOf,
            service: 2,
            local_id: "d",
          });
          w.completion.log_to = 11;
          w.completion.log_before = 11;
        },
        "the dispatcher held data.markInFlight of another actor or plan during the sample",
      ],
    ];
    for (const [label, edit, problem] of cases) {
      let s: ReturnType<typeof judge> | undefined;
      expect(() => {
        s = judge(edit);
      }, label).not.toThrow();
      expect(s, label).toMatchObject({
        status: "invalid",
        problem,
        selected: null,
        values: null,
      });
    }
  });

  it("cases (revision 16, DA16-D1, I3/I4): the /commands endpoint is established apart from the paths agreeing; entries lie inside [t0, completion read] and the selected entry ended by the timing read", () => {
    const OTHER = "/api/experimental/v1/task-commands";
    // biome-ignore lint/suspicious/noExplicitAny: a hand-written JSON witness, edited freely by each case
    const cases: Array<[string, (w: any) => void, string]> = [
      [
        "request, result and entry all agreeing on another endpoint",
        (w) => {
          w.records[2].path = OTHER;
          w.records[3].path = OTHER;
          w.resources[0].name = OTHER;
        },
        `a retained request entry is not the /commands endpoint (${OTHER})`,
      ],
      [
        "the entry alone on another endpoint",
        (w) => {
          w.resources[0].name = OTHER;
        },
        `a retained request entry is not the /commands endpoint (${OTHER})`,
      ],
      [
        "the request call alone",
        (w) => {
          w.records[2].path = OTHER;
        },
        "a request result (record 7) contradicts its call (path)",
      ],
      [
        "the request result alone",
        (w) => {
          w.records[3].path = OTHER;
        },
        "a request result (record 7) contradicts its call (path)",
      ],
      [
        "request and result agreeing on another endpoint than their /commands entry",
        (w) => {
          w.records[2].path = OTHER;
          w.records[3].path = OTHER;
        },
        "the dispatcher's request was made to another path than its /commands entry",
      ],
      [
        "an entry named by its full URL",
        (w) => {
          w.resources[0].name = `http://127.0.0.1:4100${PATH}`;
        },
        `a retained request entry is not the /commands endpoint (http://127.0.0.1:4100${PATH})`,
      ],
      [
        "an entry that began before the enqueue",
        (w) => {
          w.resources[0].startTime = 99.9;
        },
        "a /commands request entry lies outside the sample's observation",
      ],
      [
        "an entry that ended after the completion read",
        (w) => {
          w.completion.resource_entries = 2;
          w.resources.push({
            name: PATH,
            startTime: 125,
            requestStart: 126,
            responseEnd: 131.5,
          });
        },
        "a /commands request entry lies outside the sample's observation",
      ],
      [
        "the selected entry ending after the timing read that counted it",
        (w) => {
          w.timing.done = 120.5;
          w.timing.at = 120.5;
          w.resources[0].responseEnd = 120.8;
        },
        "its timing read did not see its request",
      ],
    ];
    for (const [label, edit, problem] of cases) {
      let s: ReturnType<typeof judge> | undefined;
      expect(() => {
        s = judge(edit);
      }, label).not.toThrow();
      expect(s, label).toMatchObject({
        status: "invalid",
        problem,
        selected: null,
        values: null,
      });
    }
    // Controls: the healthy entry; a later /commands entry (another draft's, after the answer) inside the completion read is no request of
    // this operation; the selected entry ending exactly at the timing read.
    expect(judge(() => {})).toMatchObject({
      status: "complete",
      values: VALUES,
    });
    expect(
      judge((w) => {
        w.timing.done = 119;
        w.timing.at = 119;
        w.records[4].at = 119;
        w.lines[1] = '119ms data.outbox_answer {"kind":"receipt"}';
        w.records[3].at = 119;
      }),
    ).toMatchObject({
      status: "complete",
      values: { ...VALUES, record_ms: 0, total_ms: 19 },
    });
  });

  // Revision 17 (review 17 R17-REQUEST/R17-BUFFER, design assessment DA17-RQ/BF/HR, Q1-Q7; `draft-request-sample/5`). The healthy
  // witness's call begins at 109 and returns at 119.1; its entry starts at 110, sends its request at 111 and ends at 119; both reads count
  // one entry, the request. Every expected problem and value is written here.
  const BEGAN =
    "the dispatcher's request began after its /commands entry started: the entry is not that call's";
  const RETURNED =
    "the dispatcher's request returned before its /commands entry's request was sent: the entry is not that call's";

  it("cases (revision 17, R17-REQUEST, DA17-RQ Q1/Q2): a call that began after its entry ended, after it started (by much, by half the trace rounding, by a microsecond), or that returned before the entry's request was sent (by much, or a microsecond) is invalid with its own reason, the trace and the other relations unchanged", () => {
    // biome-ignore lint/suspicious/noExplicitAny: a hand-written JSON witness, edited freely by each case
    const cases: Array<[string, (w: any) => void, string]> = [
      // Review 17: begun 0.05 ms after the entry's response ended (the records stay ordered, the call still after its send line).
      ["begun after the entry ended", (w) => (w.records[2].at = 119.05), BEGAN],
      [
        "begun 5 ms after the entry started",
        (w) => (w.records[2].at = 115),
        BEGAN,
      ],
      [
        "begun within the trace rounding after the entry started",
        (w) => (w.records[2].at = 110.5),
        BEGAN,
      ],
      [
        "begun 0.001 ms after the entry started",
        (w) => (w.records[2].at = 110.001),
        BEGAN,
      ],
      [
        "returned before the entry started",
        (w) => (w.records[3].at = 109.5),
        RETURNED,
      ],
      [
        "returned within the trace rounding before the entry's request",
        (w) => (w.records[3].at = 110.5),
        RETURNED,
      ],
      [
        "returned 0.001 ms before the entry's request",
        (w) => (w.records[3].at = 110.999),
        RETURNED,
      ],
    ];
    for (const [label, edit, problem] of cases)
      expect(judge(edit), label).toEqual({
        status: "invalid",
        problem,
        selected: null,
        values: null,
      });
  });

  it("controls (revision 17, DA17-RQ/HR Q3): a call beginning exactly at its entry's start, returning exactly when its request was sent (the generic headers-return boundary), both at once with the entry's start equal to its request, and a return before the body ended are complete with their hand-computed values", () => {
    for (const [label, edit] of [
      ["begin at the entry's start", (w) => (w.records[2].at = 110)],
      ["return at the entry's request", (w) => (w.records[3].at = 111)],
      [
        "both ties, start = request",
        (w) => {
          w.resources[0].startTime = 111;
          w.records[2].at = 111;
          w.records[3].at = 111;
        },
      ],
      ["return before the body ended", (w) => (w.records[3].at = 118.5)],
      // biome-ignore lint/suspicious/noExplicitAny: see above
    ] as Array<[string, (w: any) => void]>)
      expect(judge(edit), label).toMatchObject({
        status: "complete",
        problem: null,
        values: VALUES,
      });
  });

  it("cases (revision 17, R17-BUFFER, DA17-BF Q4-Q7): either total or the counted requests missing, null, a string, fractional or negative; a count above its own read's total; either total at the buffer's 250; a total that shrank are invalid with their own reason", () => {
    const NOT_RECORDED =
      "the witness does not record the resource buffer's entries";
    const TIMING_NOT_RECORDED =
      "its timing read does not record the resource buffer's entries";
    // biome-ignore lint/suspicious/noExplicitAny: a hand-written JSON witness, edited freely by each case
    const cases: Array<[string, (w: any) => void, string]> = [];
    for (const [what, bad] of [
      ["missing", undefined],
      ["null", null],
      ["a string", "1"],
      ["fractional", 1.5],
      ["negative", -1],
    ] as Array<[string, unknown]>) {
      cases.push(
        [
          `timing total ${what}`,
          (w) => (w.timing.resource_entries = bad),
          TIMING_NOT_RECORDED,
        ],
        [
          `completion total ${what}`,
          (w) => (w.completion.resource_entries = bad),
          NOT_RECORDED,
        ],
        [
          `timing requests ${what}`,
          (w) => (w.timing.requests = bad),
          NOT_RECORDED,
        ],
      );
    }
    cases.push(
      [
        "timing total 0 with its 1 request",
        (w) => (w.timing.resource_entries = 0),
        "its timing read saw more requests than the buffer held",
      ],
      [
        "completion total 0 with its 1 retained entry",
        (w) => (w.completion.resource_entries = 0),
        "the completion read retains more requests than the buffer held",
      ],
      [
        "both totals 0",
        (w) => {
          w.timing.resource_entries = 0;
          w.completion.resource_entries = 0;
        },
        "the completion read retains more requests than the buffer held",
      ],
      [
        "timing total 250, completion 1",
        (w) => (w.timing.resource_entries = 250),
        "the resource-timing buffer was full at the timing read: requests may be missing",
      ],
      [
        "both totals 251",
        (w) => {
          w.timing.resource_entries = 251;
          w.completion.resource_entries = 251;
        },
        "the resource-timing buffer was full: requests may be missing",
      ],
      [
        "timing total 1, completion 250",
        (w) => (w.completion.resource_entries = 250),
        "the resource-timing buffer was full: requests may be missing",
      ],
      [
        "249 at the timing read, 1 at the completion read",
        (w) => (w.timing.resource_entries = 249),
        "the resource-timing buffer shrank between the timing and completion reads: it was cleared or lost entries",
      ],
      [
        "2 then 1",
        (w) => (w.timing.resource_entries = 2),
        "the resource-timing buffer shrank between the timing and completion reads: it was cleared or lost entries",
      ],
      // Conservation's own reason, on a witness one-request selection refuses anyway (its second entry): the timing read's other entry
      // left the buffer while the request count grew, totals equal.
      [
        "an unrelated entry replaced by a second request (2/1 then 2/2)",
        (w) => {
          w.timing.resource_entries = 2;
          w.completion.resource_entries = 2;
          w.resources.push({
            name: PATH,
            startTime: 110.5,
            requestStart: 111,
            responseEnd: 118,
          });
        },
        "entries other than the requests left the resource-timing buffer between the timing and completion reads",
      ],
    );
    for (const [label, edit, problem] of cases) {
      let s: ReturnType<typeof judge> | undefined;
      expect(() => {
        s = judge(edit);
      }, label).not.toThrow();
      expect(s, label).toEqual({
        status: "invalid",
        problem,
        selected: null,
        values: null,
      });
    }
  });

  it("controls (revision 17, DA17-BF Q6/Q7): totals 249 at both reads, 1 then 2 (an unrelated entry between the reads), 1 then 249, and 248 then 249 with the request and an unrelated entry are complete with their hand-computed values", () => {
    for (const [label, timing, completion] of [
      ["249 and 249", 249, 249],
      ["1 then 2", 1, 2],
      ["1 then 249", 1, 249],
      ["248 then 249", 248, 249],
    ] as Array<[string, number, number]>)
      expect(
        judge((w) => {
          w.timing.resource_entries = timing;
          w.completion.resource_entries = completion;
        }),
        label,
      ).toMatchObject({ status: "complete", problem: null, values: VALUES });
  });

  it("bufferLifetimeProblem itself (revision 17, DA17-BF Q7): equal or growing totals whose other entries never leave are one buffer; a total that shrank, or other entries that left while the requests grew more than the total, are not", () => {
    const shrank =
      "the resource-timing buffer shrank between the timing and completion reads: it was cleared or lost entries";
    const left =
      "entries other than the requests left the resource-timing buffer between the timing and completion reads";
    for (const [earlier, later, problem] of [
      [{ total: 1, retained: 1 }, { total: 1, retained: 1 }, null],
      [{ total: 0, retained: 0 }, { total: 1, retained: 1 }, null],
      [{ total: 1, retained: 0 }, { total: 2, retained: 1 }, null],
      [{ total: 1, retained: 1 }, { total: 3, retained: 1 }, null],
      [{ total: 249, retained: 1 }, { total: 249, retained: 1 }, null],
      [{ total: 249, retained: 1 }, { total: 1, retained: 1 }, shrank],
      [{ total: 2, retained: 0 }, { total: 1, retained: 0 }, shrank],
      [{ total: 2, retained: 1 }, { total: 2, retained: 2 }, left],
      [{ total: 2, retained: 1 }, { total: 3, retained: 3 }, left],
    ] as Array<[BufferSnapshot, BufferSnapshot, string | null]>)
      expect(
        bufferLifetimeProblem(earlier, later),
        JSON.stringify([earlier, later]),
      ).toBe(problem);
  });
});

// ---- P-2 (revision 18; review 18 R18-P2, design assessment invariants 1-4, C1/C2, schedule matrix) ---------------------------------------
// REVISION 18 ADAPTATION (labelled): revision 12's four selector cases (`selectP2Sample`, `p2SampleProblems`, both removed) are kept here
// with their schedules unchanged, judged by the shared iteration rule over the witness the writer now reads (`markP2Iteration`,
// `readP2Iteration`). The rule reports the FIRST problem only, so the lapsed case expects its first reason (no page written) where
// revision 12 listed it and the running end together; the running end is asserted on its own below.

const P2_PAGES = {
  markP2Iteration: isolated(markP2Iteration),
  readP2Iteration: isolated(readP2Iteration),
  readP2LongTasks: isolated(readP2LongTasks),
};
/** The witness of an iteration marked at `from`: the page read (forced) and a body served once with nothing queued, unless stated. */
const p2WitnessAt = (
  from: number,
  o: { served?: number; pending?: number } = {},
): P2Witness => {
  const m = { ...P2_PAGES.markP2Iteration(), from } as P2MarkFrame;
  const r = P2_PAGES.readP2Iteration({ mark: m, force: true });
  if (!r) throw new Error("no read");
  return { ...r, served: o.served ?? 1, pending: o.pending ?? 0 };
};

describe("P-2: one iteration's own page (p2IterationSelection over the page read)", () => {
  it("control: the first commit after the iteration's start, committed, of the served bytes, ending idle, is the iteration", () => {
    line(1, "data.sync_next", { when: "after", state: "idle" });
    const from = trace.length;
    line(2, "data.sync_tick", { why: "now", coalesced: false });
    committed(10, 5_000, 3, 7);
    line(11, "data.sync_next", { when: "after", state: "idle" });
    const s = p2IterationSelection(p2WitnessAt(from), 5_000);
    expect(s).toEqual({
      status: "complete",
      problem: null,
      selected: { commit: 2, end: 3 },
      values: { scan_ms: 3, commit_ms: 7 },
    });
  });

  it("control: the end not yet traced, or no commit yet, is pending (polled again); the page read waits for both", () => {
    line(2, "data.sync_tick", { why: "now", coalesced: false });
    expect(
      p2IterationSelection(p2WitnessAt(0, { served: 0 }), 5_000),
    ).toMatchObject({
      status: "pending",
      problem: "its body has not been served",
    });
    committed(10, 5_000, 3, 7);
    const m = { ...P2_PAGES.markP2Iteration(), from: 0 } as P2MarkFrame;
    expect(P2_PAGES.readP2Iteration({ mark: m, force: false })).toBeNull();
    expect(p2IterationSelection(p2WitnessAt(0), 5_000)).toMatchObject({
      status: "pending",
      problem: "its step has not ended",
    });
  });

  it("case (review 12, DA-M1): a lapsed page retried into an empty one: the iteration is the lapsed commit and fails; the retry's timings are never taken", () => {
    line(2, "data.sync_tick", { why: "now", coalesced: false });
    line(10, "data.sync_commit", {
      bytes: 5_000,
      scan_ms: 3,
      commit_ms: 7,
      kind: "applied",
      value: "lease_lapsed",
    });
    line(11, "data.sync_next", { when: "after", state: "running" });
    line(400, "data.sync_tick", { why: "timer", coalesced: false });
    committed(402, 80, 0.1, 0.9);
    line(403, "data.sync_next", { when: "after", state: "idle" });
    expect(p2IterationSelection(p2WitnessAt(0), 5_000)).toMatchObject({
      status: "invalid",
      problem: "its commit wrote no page (applied/lease_lapsed)",
    });
    // A committed page of the served bytes whose own step ended running is refused for its end.
    restartTrace();
    committed(10, 5_000, 3, 7);
    line(11, "data.sync_next", { when: "after", state: "running" });
    expect(p2IterationSelection(p2WitnessAt(0), 5_000).problem).toBe(
      `its step did not end idle (${trace[1]})`,
    );
  });

  it("case: two commits of different sizes and times: the first is selected; another page's bytes, or a missing value, fail the iteration", () => {
    line(2, "data.sync_tick", { why: "now", coalesced: false });
    committed(10, 4_000, 3, 7);
    line(11, "data.sync_next", { when: "after", state: "idle" });
    committed(20, 5_000, 30, 70);
    line(21, "data.sync_next", { when: "after", state: "idle" });
    expect(p2IterationSelection(p2WitnessAt(0), 5_000).problem).toBe(
      "its commit is 4000 bytes, not the served 5000",
    );
    restartTrace();
    line(10, "data.sync_commit", {
      bytes: 5_000,
      scan_ms: 3,
      commit_ms: 7,
      kind: "applied",
    });
    line(11, "data.sync_next", { when: "after", state: "idle" });
    expect(p2IterationSelection(p2WitnessAt(0), 5_000).problem).toBe(
      "its commit wrote no page (applied/no value)",
    );
  });

  it("case (revision 18, invariants 2/3): the lifetime, the served body, the slice and the timings each refuse the iteration with their own reason; zero-duration timings are valid", () => {
    line(2, "data.sync_tick", { why: "now", coalesced: false });
    committed(10, 5_000, 0, 0);
    line(11, "data.sync_next", { when: "after", state: "idle" });
    const w = p2WitnessAt(0);
    const sel = (edit: (x: P2Witness) => void, bytes = 5_000) => {
      const x = structuredClone(w);
      edit(x);
      return p2IterationSelection(x, bytes);
    };
    expect(sel(() => {}).status).toBe("complete");
    expect(sel((x) => (x.read.page = "page-2")).problem).toBe(
      "the page was replaced during the iteration",
    );
    // REVISION 18 ADAPTATION (A18-T1): the page instance is the lifetime; a time origin that moved on it (WebKit's follows the wall clock)
    // is the same page.
    expect(sel((x) => (x.read.time_origin += 1)).status).toBe("complete");
    expect(
      sel((x) => {
        x.read.page = "page-2";
        x.read.time_origin += 1;
      }).problem,
    ).toBe("the page was replaced during the iteration");
    expect(sel((x) => (x.read.epochs += 1)).problem).toBe(
      "the engine was started again during the iteration",
    );
    expect(sel((x) => (x.read.generation += 1)).problem).toBe(
      "the engine was started again during the iteration",
    );
    expect(sel((x) => (x.read.at = x.mark.at - 0.001)).problem).toBe(
      "its read does not follow its mark",
    );
    expect(sel((x) => x.lines.pop()).problem).toBe(
      "its trace slice is not the trace from its mark to its read",
    );
    expect(sel((x) => (x.served = 0)).problem).toBe(
      "its body was answered 0 times, not once: the commit is not its page's",
    );
    expect(sel((x) => (x.served = 2)).problem).toMatch(/answered 2 times/);
    expect(sel((x) => (x.pending = 1)).problem).toBe(
      "1 scripted answer(s) are still queued: another request took this iteration's place",
    );
    expect(
      sel((x) => ((x.mark as { generation: unknown }).generation = null))
        .problem,
    ).toBe("its mark is malformed");
    for (const bad of [-1, Number.NaN, "3"]) {
      const x = structuredClone(w);
      x.lines[1] = `10ms data.sync_commit ${JSON.stringify({ bytes: 5_000, scan_ms: bad, commit_ms: 0, kind: "applied", value: "committed" })}`;
      expect(p2IterationSelection(x, 5_000).problem).toBe(
        "its commit records no scan_ms",
      );
    }
  });

  it("control: a step that ended without a commit (a stop) before the iteration's commit does not move its selection (review 18's boundary question; no new rule)", () => {
    line(2, "data.sync_tick", { why: "now", coalesced: false });
    line(3, "data.sync_next", { when: "after", state: "running" });
    line(4, "data.sync_tick", { why: "now", coalesced: false });
    committed(10, 5_000, 3, 7);
    line(11, "data.sync_next", { when: "after", state: "idle" });
    expect(p2IterationSelection(p2WitnessAt(0), 5_000)).toMatchObject({
      status: "complete",
      selected: { commit: 3, end: 4 },
    });
  });

  it("control: the sequence rule: a mark on the same lifetime at or after the previous read is valid; a replaced page, a restarted engine or an earlier mark is not", () => {
    const read = {
      page: "page-1",
      time_origin: 5,
      epochs: 1,
      generation: 1,
      to: 10,
      at: 20,
    };
    const mark = {
      page: "page-1",
      time_origin: 5,
      epochs: 1,
      generation: 1,
      from: 10,
      at: 20,
    };
    expect(p2SequenceProblem(read, mark)).toBeNull();
    expect(p2SequenceProblem(read, { ...mark, page: "page-2" })).toBe(
      "the page was replaced between iterations",
    );
    expect(
      p2SequenceProblem(read, { ...mark, time_origin: mark.time_origin + 1 }),
    ).toBeNull();
    expect(p2SequenceProblem(read, { ...mark, epochs: 2, generation: 2 })).toBe(
      "the engine was started again between iterations",
    );
    expect(p2SequenceProblem(read, { ...mark, from: 9 })).toBe(
      "its mark does not follow the previous iteration's read",
    );
    expect(p2SequenceProblem(read, { ...mark, at: 19.999 })).toBe(
      "its mark does not follow the previous iteration's read",
    );
  });
});

/**
 * The P-2 writer's port over the harness double (revision 18): the scripted page above, a scripted `/sync` queue the steps serve from, the
 * writer's idle wait (a commit at or after the mark and the engine's last step end idle; the scripted engine takes one action per poll) and
 * the page clock as the wall clock. `p2Step` is one nudge's engine work: its tick, its request (serving the next queued body: its bytes;
 * none queued: the empty page's 72), its commit and its end; `lapsed` exhausts its admission rounds (applied/lease_lapsed, ending running),
 * then the engine's paced retry asks again, is answered empty and commits idle.
 */
let p2Queue: Array<{ body: string; served: number }> = [];
let p2Enqueues = 0;
const p2Port = (limit = 60): P2Port => ({
  ...scripted(limit),
  enqueue(body) {
    p2Enqueues += 1;
    const entry = { body, served: 0 };
    p2Queue.push(entry);
    return { served: () => entry.served };
  },
  pending: () => p2Queue.length,
  async settle(from) {
    for (let n = 0; n < limit; n += 1) {
      // The engine's state as the trace shows it: running from a step's tick until its end publishes the next state.
      const steps = trace.filter((l) =>
        /^\d+ms data\.sync_(tick|next|step_failed) /.test(l),
      );
      if (
        trace.slice(from).some((l) => l.includes("data.sync_commit")) &&
        steps.at(-1)?.includes('"state":"idle"')
      )
        return;
      await Promise.resolve();
      actions.shift()?.();
    }
    throw new Error(`expect.poll: Timeout ${limit} polls exceeded`);
  },
  now: () => pageClock,
});
let p2Scan = 0;
const p2Serve = () => {
  const next = p2Queue.shift();
  if (next) next.served += 1;
  return next ? new TextEncoder().encode(next.body).length : 72;
};
const p2Step = (o: { lapsed?: boolean } = {}) => {
  at += 100;
  const t = at;
  let bytes = 0;
  p2Scan += 1;
  const scan = p2Scan;
  const tail = o.lapsed
    ? [
        () =>
          line(t + 400, "data.sync_tick", { why: "timer", coalesced: false }),
        () => {
          const empty = p2Serve();
          committed(t + 402, empty, 0.1, 0.9);
        },
        () => line(t + 403, "data.sync_next", { when: "after", state: "idle" }),
      ]
    : [];
  return [
    () => line(t, "data.sync_tick", { why: "now", coalesced: false }),
    () => {
      bytes = p2Serve();
    },
    () =>
      line(t + 10, "data.sync_commit", {
        bytes,
        scan_ms: scan,
        commit_ms: scan + 0.5,
        kind: "applied",
        value: o.lapsed ? "lease_lapsed" : "committed",
      }),
    () =>
      line(t + 11, "data.sync_next", {
        when: "after",
        state: o.lapsed ? "running" : "idle",
      }),
    ...tail,
  ];
};
const P2_OPTIONS = { longTasks: true, timeout: 30_000, polling: 5 };
/** Two shapes as the writer has them (shape A's body grows with the iteration, shape B's is repeated). */
const P2_SCHEDULE = (): P2Shape[] => [
  {
    name: "A",
    body: (i) => `{"a":${"x".repeat(100 + i)}}`,
    warmup: 2,
    samples: 3,
  },
  {
    name: "B",
    body: () => `{"b":"${"y".repeat(500)}"}`,
    warmup: 1,
    samples: 2,
  },
];

describe("P-2: the shared collector the writer calls, every iteration (revision 18; review 18 R18-P2, design assessment schedule matrix)", () => {
  beforeEach(() => {
    actions = [];
    at = 1_000;
    p2Queue = [];
    p2Enqueues = 0;
    p2Scan = 0;
    (window as unknown as { __long: number[] }).__long = [];
  });

  it("control: every warm-up and sample of every shape is validated and kept, in order; only the measured iterations give values, each its own commit's timings, each mark after the previous read", async () => {
    harness.onNudge = () => actions.push(...p2Step());
    const c = await collectP2Iterations(p2Port(), P2_SCHEDULE(), P2_OPTIONS);
    expect(c.failure).toBeNull();
    expect(c.iterations.map((e) => [e.shape, e.index])).toEqual([
      ["A", 0],
      ["A", 1],
      ["A", 2],
      ["A", 3],
      ["A", 4],
      ["B", 0],
      ["B", 1],
      ["B", 2],
    ]);
    expect([harness.nudges, p2Enqueues, p2Queue.length]).toEqual([8, 8, 0]);
    // Steps 1-2 and 6 were warm-ups: their scan times (1, 2, 6) are in no series.
    expect(c.series.A?.scan).toEqual([3, 4, 5]);
    expect(c.series.A?.commit).toEqual([3.5, 4.5, 5.5]);
    expect(c.series.B?.scan).toEqual([7, 8]);
    expect(c.series.A?.wall).toHaveLength(3);
    expect(c.series.A?.long).toEqual([0, 0, 0]);
    for (const [k, e] of c.iterations.entries()) {
      expect(e.served).toBe(1);
      expect(e.bytes).toBe(
        new TextEncoder().encode(
          P2_SCHEDULE()
            .find((x) => x.name === e.shape)
            ?.body(e.index) ?? "",
        ).length,
      );
      const previous = c.iterations[k - 1];
      if (previous) expect(p2SequenceProblem(previous.read, e.mark)).toBeNull();
      expect(
        p2IterationSelection(
          {
            mark: e.mark,
            read: e.read,
            lines: trace.slice(e.mark.from, e.read.to),
            served: e.served,
            pending: e.pending,
          },
          e.bytes,
        ).selected,
      ).toEqual(e.selected);
    }
  });

  it("control: a wall time is the nudge to the idle wait, unchanged (the clock read after the body is queued and before the nudge, then after the wait); an engine without a long-task observer is never read for one", async () => {
    harness.onNudge = () => actions.push(...p2Step());
    const port = p2Port();
    const events: string[] = [];
    let wall = 0;
    const { run, enqueue, settle } = port;
    port.run = async (fn, arg) => {
      events.push(
        fn.toString() === markP2Iteration.toString()
          ? "mark"
          : fn.toString() === nudgeP2Iteration.toString()
            ? "nudge"
            : fn.toString() === readP2Iteration.toString()
              ? "read"
              : "other",
      );
      return run(fn, arg);
    };
    port.poll = async (fn, arg, o) => {
      events.push("poll");
      return scripted().poll(fn, arg, o);
    };
    port.enqueue = (body) => {
      events.push("enqueue");
      return enqueue(body);
    };
    port.settle = async (from) => {
      events.push("settle");
      await settle(from);
      wall += 7;
    };
    port.now = () => {
      events.push("now");
      wall += 1_000;
      return wall;
    };
    const c = await collectP2Iterations(port, P2_SCHEDULE().slice(0, 1), {
      ...P2_OPTIONS,
      longTasks: false,
    });
    expect(c.failure).toBeNull();
    const iteration = [
      "mark",
      "enqueue",
      "now",
      "nudge",
      "settle",
      "now",
      "poll",
    ];
    expect(events).toEqual(Array.from({ length: 5 }, () => iteration).flat());
    // Each measured wall time is the second clock reading less the first: the wait's own 7 plus the second reading's 1,000.
    expect(c.series.A?.wall).toEqual([1_007, 1_007, 1_007]);
    // No long-task read ("other") ever ran.
    expect(c.series.A?.long).toEqual([]);
    expect(events).not.toContain("other");
  });

  for (const [title, failing, warmup] of [
    ["the FIRST warm-up (review 18's schedule)", 1, true],
    ["the LAST warm-up of the first shape", 2, true],
    ["the first measured iteration", 3, false],
    ["a measured iteration after healthy ones", 5, false],
    ["the later shape's warm-up (its index restarts at 0)", 6, true],
  ] as const)
    it(`case (R18-P2): a lapsed page at ${title}, retried empty into idle, stops the WHOLE collection there with its witness and phase; nothing further is enqueued or nudged`, async () => {
      let n = 0;
      harness.onNudge = () => {
        n += 1;
        actions.push(...p2Step({ lapsed: n === failing }));
      };
      const c = await collectP2Iterations(p2Port(), P2_SCHEDULE(), P2_OPTIONS);
      const order = [
        ["A", 0],
        ["A", 1],
        ["A", 2],
        ["A", 3],
        ["A", 4],
        ["B", 0],
        ["B", 1],
        ["B", 2],
      ];
      const [shape, index] = order[failing - 1] ?? [];
      expect(c.iterations.map((e) => [e.shape, e.index])).toEqual(
        order.slice(0, failing - 1),
      );
      expect(c.failure).toMatchObject({
        shape,
        index,
        warmup,
        phase: "selection",
        problem: "its commit wrote no page (applied/lease_lapsed)",
      });
      expect([harness.nudges, p2Enqueues]).toEqual([failing, failing]);
      const w = c.failure?.witness as P2Witness;
      expect(w.served).toBe(1);
      expect(w.lines.map((l) => l.split(" ")[1])).toContain("data.sync_commit");
      // The empty retry reached idle, so the idle wait was satisfied; it never repaired the iteration and no measured value came from it.
      expect(trace.at(-1)).toContain('"state":"idle"');
      const values = [...(c.series.A?.scan ?? []), ...(c.series.B?.scan ?? [])];
      expect(values).not.toContain(failing);
      expect(values.every((x) => x < failing)).toBe(true);
    });

  it("case: each awaited phase that rejects or times out stops the collection with its phase and the support so far: mark, nudge, the idle wait, the read and the long-task read", async () => {
    const phases: Array<[P2Phase, (port: P2Port, n: number) => void, RegExp]> =
      [
        [
          "mark",
          (port, n) => {
            const run = port.run;
            port.run = async (fn, arg) => {
              if (fn.toString() === markP2Iteration.toString() && n === 0)
                throw new Error("Target closed");
              return run(fn, arg);
            };
          },
          /^no mark could be set \(Error: Target closed\)$/,
        ],
        [
          "nudge",
          (port) => {
            const run = port.run;
            port.run = async (fn, arg) => {
              if (fn.toString() === nudgeP2Iteration.toString())
                throw new Error("Execution context was destroyed");
              return run(fn, arg);
            };
          },
          /^the nudge failed/,
        ],
        [
          "settle",
          (port) => {
            port.settle = async () => {
              throw new Error("expect.poll: Timeout 120000ms exceeded");
            };
          },
          /^no commit and idle engine followed the nudge/,
        ],
        [
          "read",
          (port) => {
            port.poll = async () => {
              throw new Error("Timeout");
            };
            const run = port.run;
            port.run = async (fn, arg) => {
              if (fn.toString() === readP2Iteration.toString())
                throw new Error("Target closed");
              return run(fn, arg);
            };
          },
          /^the iteration could not be read/,
        ],
        [
          "long_tasks",
          (port) => {
            const run = port.run;
            port.run = async (fn, arg) => {
              if (fn.toString() === readP2LongTasks.toString())
                throw new Error("Target closed");
              return run(fn, arg);
            };
          },
          /^its long tasks could not be read/,
        ],
      ];
    for (const [phase, sabotage, problem] of phases) {
      restartTrace();
      actions = [];
      p2Queue = [];
      p2Enqueues = 0;
      harness.nudges = 0;
      harness.onNudge = () => actions.push(...p2Step());
      const port = p2Port();
      sabotage(port, 0);
      const c = await collectP2Iterations(port, P2_SCHEDULE(), P2_OPTIONS);
      expect(c.failure?.phase, phase).toBe(phase);
      expect(c.failure?.problem, phase).toMatch(problem);
      expect(c.failure?.shape).toBe("A");
      // The mark fails before anything is queued; the long-task read only follows a measured iteration's own validation.
      expect(c.failure?.index, phase).toBe(phase === "long_tasks" ? 2 : 0);
      expect(p2Enqueues, phase).toBe(
        phase === "mark" ? 0 : phase === "long_tasks" ? 3 : 1,
      );
      expect(c.iterations).toHaveLength(phase === "long_tasks" ? 3 : 0);
    }
  });

  it("case: an iteration whose step never ends is read once more at the time-out and fails as pending; its witness keeps the commit", async () => {
    harness.onNudge = () => actions.push(...p2Step().slice(0, 3));
    const port = p2Port();
    port.settle = async () => {};
    const c = await collectP2Iterations(port, P2_SCHEDULE(), P2_OPTIONS);
    expect(c.failure).toMatchObject({
      index: 0,
      warmup: true,
      phase: "selection",
      problem: "its step has not ended within 30000 ms",
    });
    expect(harness.nudges).toBe(1);
  });

  it("case (invariant 3): a replaced page or a restarted engine during an iteration, or between two, is a failure, never spliced into the collection", async () => {
    const during = async (change: () => void, problem: string) => {
      restartTrace();
      actions = [];
      p2Queue = [];
      p2Enqueues = 0;
      harness.page = "page-1";
      harness.engineEpochs = [{ generation: 1, run: 1, trace: 0 }];
      let n = 0;
      harness.onNudge = () => {
        n += 1;
        const step = p2Step();
        // The second iteration's page or engine changes after its commit and before its end.
        actions.push(
          ...(n === 2 ? [...step.slice(0, 3), change, ...step.slice(3)] : step),
        );
      };
      const c = await collectP2Iterations(p2Port(), P2_SCHEDULE(), P2_OPTIONS);
      expect(c.failure).toMatchObject({
        index: 1,
        phase: "selection",
        problem,
      });
      expect(c.iterations).toHaveLength(1);
      expect(p2Enqueues).toBe(2);
    };
    await during(() => {
      harness.page = "page-2";
    }, "the page was replaced during the iteration");
    await during(() => {
      harness.engineEpochs.push({ generation: 2, run: 2, trace: trace.length });
    }, "the engine was started again during the iteration");
    // Between iterations: the engine starts again after the first read; the second mark is not on the previous read's engine.
    restartTrace();
    actions = [];
    p2Queue = [];
    p2Enqueues = 0;
    harness.engineEpochs = [{ generation: 1, run: 1, trace: 0 }];
    harness.onNudge = () => actions.push(...p2Step());
    const port = p2Port();
    const run = port.run;
    let marks = 0;
    port.run = async (fn, arg) => {
      if (fn.toString() === markP2Iteration.toString() && ++marks === 2)
        harness.engineEpochs.push({
          generation: 2,
          run: 2,
          trace: trace.length,
        });
      return run(fn, arg);
    };
    const c = await collectP2Iterations(port, P2_SCHEDULE(), P2_OPTIONS);
    expect(c.failure).toMatchObject({
      index: 1,
      phase: "sequence",
      problem: "the engine was started again between iterations",
    });
    expect(c.iterations).toHaveLength(1);
    // The failed mark queued nothing.
    expect(p2Enqueues).toBe(1);
    // REVISION 18 (A18-T1): the lifetime is the page instance. A time origin that moves on it during an iteration and between two (macOS
    // WebKit's follows the disciplined wall clock: +1 ms every 92 s on one still page, measured) is the same lifetime; the collection completes.
    restartTrace();
    actions = [];
    p2Queue = [];
    p2Enqueues = 0;
    harness.page = "page-1";
    harness.engineEpochs = [{ generation: 1, run: 1, trace: 0 }];
    let origin = 1_000_000;
    vi.spyOn(performance, "timeOrigin", "get").mockImplementation(() => origin);
    let drifts = 0;
    harness.onNudge = () => {
      drifts += 1;
      const step = p2Step();
      actions.push(
        ...(drifts === 2
          ? [...step.slice(0, 3), () => (origin += 1), ...step.slice(3)]
          : step),
      );
    };
    const drifting = p2Port();
    const drift = drifting.run;
    let driftMarks = 0;
    drifting.run = async (fn, arg) => {
      if (fn.toString() === markP2Iteration.toString() && ++driftMarks === 4)
        origin += 1;
      return drift(fn, arg);
    };
    const moved = await collectP2Iterations(
      drifting,
      P2_SCHEDULE(),
      P2_OPTIONS,
    );
    expect(moved.failure).toBeNull();
    expect(moved.iterations).toHaveLength(8);
    expect(
      [
        moved.iterations[1]?.mark,
        moved.iterations[1]?.read,
        moved.iterations[3]?.mark,
      ].map((f) => f?.time_origin),
    ).toEqual([1_000_000, 1_000_001, 1_000_002]);
  });

  it("case (design assessment: another request takes the scripted body): a body served to no step, or a stale body still queued, fails the iteration", async () => {
    // A request before the mark took the queued body and left the step an empty page: the commit is not this iteration's body.
    let n = 0;
    harness.onNudge = () => {
      n += 1;
      if (n === 2) p2Queue.unshift({ body: "{}", served: 0 });
      actions.push(...p2Step());
    };
    const c = await collectP2Iterations(p2Port(), P2_SCHEDULE(), P2_OPTIONS);
    expect(c.failure).toMatchObject({
      index: 1,
      phase: "selection",
      problem:
        "its body was answered 0 times, not once: the commit is not its page's",
    });
  });
});
