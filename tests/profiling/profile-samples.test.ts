import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  draftWitnessSelection,
  syncWitnessSelection,
} from "../../scripts/lib/profile-sample-rules.mjs";
import {
  collectDraftSamples,
  collectSyncSamples,
  type DraftMark,
  draftStatus,
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
// The page functions (`prepareSyncSample`, `readSyncSample`, `prepareDraftSample`, `readDraftSample`, `draftStatus`), the shared rule
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
  draftStatus: isolated(draftStatus),
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

describe("P-4 draft: one send, its answer and its request per sample (Q4, DA-N1)", () => {
  let clock = 0;
  beforeEach(() => {
    actions = [];
    clock = 5_000;
    vi.spyOn(performance, "now").mockImplementation(() => clock);
  });
  const dispatched = (
    localId: string,
    sends: Array<{ at: number; answered: boolean }>,
  ) => {
    const out: Array<() => void> = [];
    for (const [k, send] of sends.entries()) {
      out.push(() => {
        clock = send.at;
        harness.outbox.push(
          `${send.at}ms data.outbox_send ${JSON.stringify({ resend: k > 0 })}`,
        );
      });
      if (!send.answered) continue;
      out.push(() => {
        resources.push({
          name: "http://127.0.0.1:4100/api/experimental/v1/commands",
          startTime: send.at + 1.5,
          requestStart: send.at + 2,
          responseEnd: send.at + 10,
        });
        clock = send.at + 11;
        harness.outbox.push(
          `${send.at + 11}ms data.outbox_answer ${JSON.stringify({ kind: "receipt" })}`,
        );
      });
    }
    out.push(() => {
      clock += 1;
    });
    out.push(() => {
      const row = harness.rows.find((r) => r.local_id === localId);
      if (row) row.status = "acknowledged";
    });
    return out;
  };

  it("control: one enqueue (1.5 ms), send at +8.5, request 8, answer: enqueue 1.5, claim 8.5, stamping 2, request 8, record 1; the draft's recorded outcome closes it", async () => {
    let next = 5_010;
    (
      window as unknown as { __atlasData: { enqueue: unknown } }
    ).__atlasData.enqueue = async () => {
      const localId = `draft-${harness.rows.length + 1}`;
      harness.rows.push({ local_id: localId, status: "queued" });
      clock += 1.5;
      const send = next;
      next += 100;
      actions.push(...dispatched(localId, [{ at: send, answered: true }]));
      return { kind: "queued", localId };
    };
    clock = 5_000;
    const c = await collectDraftSamples(scripted(), {
      ...OPTIONS,
      warmup: 1,
      samples: 2,
      account: "a",
      person: () => "p",
    });
    expect(c.failure).toBeNull();
    expect(c.samples.map((e) => [e.index, e.settled])).toEqual([
      [1, { local_id: "draft-2", status: "acknowledged" }],
      [2, { local_id: "draft-3", status: "acknowledged" }],
    ]);
    for (const v of c.values) {
      expect(v.enqueue_ms).toBe(1.5);
      expect(v.stamping_ms).toBe(2);
      expect(v.request_ms).toBe(8);
      expect(v.record_ms).toBe(1);
    }
    expect(draftWitnessSelection(c.samples[0]).selected).toEqual(
      c.samples[0]?.selected,
    );
  });

  it("case (DA-N1): enqueue at 1-2, send A at 10 not sent (no answer), send B at 100, request 102-110, answer 111: the sample fails as sent again; 92 ms is never its stamping time", async () => {
    (
      window as unknown as { __atlasData: { enqueue: unknown } }
    ).__atlasData.enqueue = async () => {
      harness.rows.push({ local_id: "draft-1", status: "queued" });
      clock = 2;
      actions.push(
        ...dispatched("draft-1", [
          { at: 10, answered: false },
          { at: 100, answered: true },
        ]),
      );
      return { kind: "queued", localId: "draft-1" };
    };
    clock = 1;
    const c = await collectDraftSamples(scripted(), {
      ...OPTIONS,
      warmup: 0,
      samples: 1,
      account: "a",
      person: () => "p",
    });
    expect(c.values).toEqual([]);
    expect(c.failure).toMatchObject({
      index: 0,
      problem:
        "the draft was sent again before an answer: a first attempt that got no answer cannot donate its send",
    });
    expect(
      (c.failure?.witness as { lines: string[] } | undefined)?.lines,
    ).toHaveLength(2);
  });

  it("case: a draft still waiting from before is waited for (nothing enqueued meanwhile); a draft whose outcome is never recorded fails; an answer with no visible request keeps the page polling", async () => {
    harness.rows.push({ local_id: "old", status: "in_flight" });
    actions.push(
      () => {},
      () => {
        harness.rows[0] = { local_id: "old", status: "acknowledged" };
      },
    );
    (
      window as unknown as { __atlasData: { enqueue: unknown } }
    ).__atlasData.enqueue = async () => {
      harness.rows.push({ local_id: "draft-2", status: "queued" });
      clock += 1;
      actions.push(
        ...dispatched("draft-2", [{ at: clock + 5, answered: true }]).slice(
          0,
          -1,
        ),
      );
      return { kind: "queued", localId: "draft-2" };
    };
    const c = await collectDraftSamples(scripted(), {
      ...OPTIONS,
      polling: 1,
      timeout: 40,
      warmup: 0,
      samples: 1,
      account: "a",
      person: () => "p",
    });
    expect(c.failure?.problem).toBe("the draft's outcome was not recorded");
    expect(
      (c.failure?.witness as { mark: DraftMark } | undefined)?.mark.waiting,
    ).toBe(0);
    // The page function itself: an answer whose /commands entry is not yet visible is not read.
    for (const row of harness.rows) row.status = "acknowledged";
    actions = [];
    const m = (
      await inPage.prepareDraftSample({ account: "a", person: "q", n: 1 })
    )?.mark as DraftMark | undefined;
    expect(m).toBeDefined();
    if (!m) return;
    harness.outbox.push(
      `${Math.ceil(clock) + 2}ms data.outbox_send {"resend":false}`,
    );
    harness.outbox.push(
      `${Math.ceil(clock) + 9}ms data.outbox_answer {"kind":"receipt"}`,
    );
    resources = [];
    expect(inPage.readDraftSample({ mark: m, force: false })).toBeNull();
    expect(await inPage.draftStatus({ account: "a", localId: "nope" })).toBe(
      "absent",
    );
  });
});
