import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  p2SampleProblems,
  readSyncSample,
  selectP2Sample,
  syncSample,
  syncSegments,
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

beforeEach(() => {
  trace = [];
  resources = [];
  (
    window as unknown as { __atlasData: { engineTrace: string[] } }
  ).__atlasData = {
    get engineTrace() {
      return trace;
    },
  };
  vi.spyOn(performance, "getEntriesByType").mockImplementation(
    () => resources as unknown as PerformanceEntryList,
  );
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

describe("P-4/P-10: one sync request per sample (readSyncSample, syncSample, syncSegments)", () => {
  const healthy = () => {
    line(100, "data.sync_tick", { why: "now", coalesced: false });
    resources.push({
      name: SYNC,
      startTime: 101.2,
      requestStart: 102,
      responseEnd: 110.5,
    });
    line(115, "data.sync_commit", {
      kind: "applied",
      value: "committed",
    });
    line(116, "data.sync_next", { when: "after", state: "idle" });
  };

  it("control: the one request between the step start and its commit is the sample; the segments follow from it", () => {
    healthy();
    const read = readSyncSample(0);
    expect(read?.resources).toHaveLength(1);
    const { support, problem } = syncSample(read as never);
    expect(problem).toBeNull();
    expect(syncSegments(support as never)).toEqual({
      pre_issue_ms: 2,
      request_ms: 8.5,
      post_response_ms: 4.5,
      total_ms: 15,
      duration_ms: 110.5 - 101.2,
    });
  });

  it("control: a request-latency sample does not need a written page (a lease_lapsed commit still ends the request's processing)", () => {
    line(100, "data.sync_tick", { why: "now", coalesced: false });
    resources.push({
      name: SYNC,
      startTime: 101,
      requestStart: 102,
      responseEnd: 110,
    });
    line(115, "data.sync_commit", { kind: "applied", value: "lease_lapsed" });
    line(116, "data.sync_next", { when: "after", state: "running" });
    expect(syncSample(readSyncSample(0) as never).problem).toBeNull();
  });

  it("case (DA-M2): a request before the step (an earlier poll) and one after its commit (the next poll) are not the sample's; the latest entry is never taken", () => {
    resources.push({
      name: SYNC,
      startTime: 50,
      requestStart: 51,
      responseEnd: 60,
    });
    healthy();
    resources.push({
      name: SYNC,
      startTime: 117,
      requestStart: 118,
      responseEnd: 140,
    });
    const { support, problem } = syncSample(readSyncSample(0) as never);
    expect(problem).toBeNull();
    expect(support?.request.startTime).toBe(101.2);
    expect(support?.sync_entries).toBe(3);
  });

  it("case (DA-M2): two requests inside one step's start and commit, or none, fail the sample; a coalesced tick is not a step start", () => {
    line(99, "data.sync_tick", { why: "wake", coalesced: true });
    healthy();
    resources.push({
      name: SYNC,
      startTime: 103,
      requestStart: 104,
      responseEnd: 112,
    });
    const read = readSyncSample(0) as NonNullable<
      ReturnType<typeof readSyncSample>
    >;
    expect(syncSample(read).problem).toBe(
      "2 /sync requests lie between the step's start and its commit (2 since the sample began)",
    );
    resources = [];
    expect(syncSample(readSyncSample(0) as never).problem).toBe(
      "0 /sync requests lie between the step's start and its commit (0 since the sample began)",
    );
    trace = [];
    line(99, "data.sync_tick", { why: "wake", coalesced: true });
    line(115, "data.sync_commit", { kind: "applied", value: "committed" });
    line(116, "data.sync_next", { when: "after", state: "idle" });
    expect(syncSample(readSyncSample(0) as never).problem).toBe(
      "no step started after the sample began",
    );
  });

  it("control: until a step end follows a commit, the sample is not read (polled again); another endpoint is not /sync", () => {
    line(100, "data.sync_tick", { why: "now", coalesced: false });
    line(115, "data.sync_commit", { kind: "applied", value: "committed" });
    expect(readSyncSample(0)).toBeNull();
    line(116, "data.sync_next", { when: "after", state: "idle" });
    resources.push({
      name: "http://127.0.0.1:4100/api/experimental/v1/commands",
      startTime: 101,
      requestStart: 102,
      responseEnd: 110,
    });
    expect(readSyncSample(0)?.resources).toEqual([]);
  });
});
