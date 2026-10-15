import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  draftWitnessSelection,
  syncWitnessSelection,
} from "../../scripts/lib/profile-sample-rules.mjs";
import {
  closeDraftSample,
  collectDraftSamples,
  collectSyncSamples,
  type DraftWitness,
  draftCompletionReady,
  p2SampleProblems,
  prepareDraftSample,
  prepareSyncSample,
  readDraftSample,
  readSyncSample,
  type SamplePage,
  type SyncMark,
  selectP2Sample,
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
const line = (ms: number, event: string, data?: unknown) =>
  trace.push(
    `${ms}ms ${event} ${data === undefined ? "" : JSON.stringify(data)}`,
  );
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

describe("P-2: the sample's own page (selectP2Sample, p2SampleProblems)", () => {
  it("control: the first commit after the sample's start, committed, of the served bytes, ending idle, is the sample", () => {
    line(1, "data.sync_next", { when: "after", state: "idle" });
    const from = trace.length;
    line(2, "data.sync_tick", { why: "now", coalesced: false });
    committed(10, 5_000, 3, 7);
    line(11, "data.sync_next", { when: "after", state: "idle" });
    const s = selectP2Sample(from);
    expect(s).toEqual({
      commit: { trace: 2, line: trace[2] },
      end: { trace: 3, line: trace[3] },
    });
    expect(p2SampleProblems(s as never, 5_000)).toEqual([]);
  });

  it("control: the end not yet traced is no sample yet (polled again)", () => {
    line(2, "data.sync_tick", { why: "now", coalesced: false });
    committed(10, 5_000, 3, 7);
    expect(selectP2Sample(0)).toBeNull();
  });

  it("case (review 12, DA-M1): a lapsed measured page retried into an empty one: the sample is the lapsed commit and fails; the retry's timings are never taken", () => {
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
    const s = selectP2Sample(0);
    expect(s?.commit.trace).toBe(1);
    expect(p2SampleProblems(s as never, 5_000)).toEqual([
      "its commit wrote no page (applied/lease_lapsed)",
      `its step did not end idle (${trace[2]})`,
    ]);
    // What revision 11 recorded for this sample: the LAST commit (the empty retry), labelled with the 5,000-byte shape.
    const last = trace.filter((l) => l.includes("data.sync_commit")).at(-1);
    expect(JSON.parse(last?.slice(last.indexOf("{")) ?? "{}")).toMatchObject({
      bytes: 80,
      scan_ms: 0.1,
    });
  });

  it("case: two commits of different sizes and times: the first is selected; another page's bytes, or a missing value, fail the sample", () => {
    line(2, "data.sync_tick", { why: "now", coalesced: false });
    committed(10, 4_000, 3, 7);
    line(11, "data.sync_next", { when: "after", state: "idle" });
    committed(20, 5_000, 30, 70);
    line(21, "data.sync_next", { when: "after", state: "idle" });
    const s = selectP2Sample(0);
    expect(s?.commit.trace).toBe(1);
    expect(p2SampleProblems(s as never, 5_000)).toEqual([
      "its commit is 4000 bytes, not the served 5000",
    ]);
    trace = [];
    line(10, "data.sync_commit", {
      bytes: 5_000,
      scan_ms: 3,
      commit_ms: 7,
      kind: "applied",
    });
    line(11, "data.sync_next", { when: "after", state: "idle" });
    expect(p2SampleProblems(selectP2Sample(0) as never, 5_000)).toEqual([
      "its commit wrote no page (applied/no value)",
    ]);
  });
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
const witnessOf = (m: SyncMark, force = false) =>
  inPage.readSyncSample({ mark: m, force });
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
    trace = [];
    m = mark();
    line(100, "data.sync_tick", { why: "now", coalesced: false });
    line(105, "data.sync_commit", { kind: "applied", value: "committed" });
    line(106, "data.sync_commit", { kind: "applied", value: "committed" });
    line(107, "data.sync_next", { when: "after", state: "idle" });
    expect(select(m).problem).toBe("the sample's step traced two commits");
    trace = [];
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

  it("case: a reload (another page instance or time origin) or an engine start since the mark makes the read return at once, invalid", () => {
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
    expect(
      syncWitnessSelection(witnessOf({ ...m, time_origin: m.time_origin + 1 }))
        .problem,
    ).toBe("the page was reloaded or replaced during the sample");
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
  ];
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
    trace = [];
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
      [
        "entry outside",
        () => {
          const r = resources.find((e) => e.name === COMMANDS);
          if (r) r.responseEnd += 40;
        },
        "a /commands request overlaps the sample's operation without lying inside it",
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
});
