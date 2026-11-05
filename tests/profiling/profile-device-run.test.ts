import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { DataHarness } from "../../src/fixture/data-harness/main";

/**
 * The device page's engine run (WEB-09c revision 12; review 12 R2, design assessment DA-D1, Q2): the ACTUAL `runEngine` of
 * src/fixture/data-harness/profile-page.ts over a fake harness whose engine publishes and traces in the production order
 * (src/data/engine/sync-engine.ts: the start publishes waiting, a step traces its tick, publishes running, asks the transport, traces its
 * commit with the plan's `value`, publishes the state it ends in, and the loop traces `data.sync_next` with the state published last;
 * after a lapsed hold the step ends `running` and a paced retry asks again). Revision 11's run took the first non-running state as the
 * verdict and the first commit as the measured one, so the lapsed page followed by the transport's empty page was recorded admitted.
 * Expected outcomes, reasons and effects are written here by hand. Not a browser test: the native counterpart is the device-page spec.
 */

const { runEngine } = await import(
  "../../src/fixture/data-harness/profile-page"
);
const { deviceRunOutcomeProblems } = await import(
  "../../scripts/lib/profile-outcome-rules.mjs"
);

type State = { kind: string; [key: string]: unknown };
const A = "00000000-0000-4000-8000-00000000000a";
const B = "00000000-0000-4000-8000-00000000000b";
const row = (id: string, version: number) => ({
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
// Three changes, two surviving rows (A rewritten): written out by hand.
const BODY = JSON.stringify({
  phase: "delta",
  batches: [
    {
      revision: 1,
      changes: [
        { kind: "upsert", resource: row(A, 1) },
        { kind: "upsert", resource: row(B, 1) },
        { kind: "upsert", resource: row(A, 2) },
      ],
    },
  ],
  next_cursor: "w-cursor",
  has_more: false,
});
const BYTES = new TextEncoder().encode(BODY);
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const EXPECTED = {
  rows: 2,
  entries_sha256: sha([`${A}@2`, `${B}@1`].join("\n")),
};

/** What a step does with the response it was given: its commit payload, the rows it writes and the state it ends in. */
type Step = (answer: string) => {
  commit: Record<string, unknown> | null;
  rows?: object[];
  end: State;
  next?: "retry";
};

function fakeHarness(steps: Step[], options: { rowsFault?: string } = {}) {
  const engineTrace: string[] = [];
  const engineStates: Array<{
    run: number;
    generation: number;
    at: number;
    trace: number;
    state: State;
  }> = [];
  const engineEpochs: Array<{
    generation: number;
    run: number;
    trace: number;
  }> = [];
  let current: State | null = null;
  let cache: object[] = [];
  let stopped = false;
  const calls: string[] = [];
  let clock = 0;
  const publish = (state: State) => {
    if (JSON.stringify(current) === JSON.stringify(state)) return;
    current = state;
    clock += 1;
    engineStates.push({
      run: 1,
      generation: 1,
      at: clock,
      trace: engineTrace.length,
      state,
    });
  };
  const trace = (event: string, data?: unknown) => {
    clock += 1;
    engineTrace.push(
      `${clock}ms ${event} ${data === undefined ? "" : JSON.stringify(data)}`,
    );
  };
  const data = {
    page: "device-page-1",
    engineTrace,
    engineStates,
    engineEpochs,
    engineState: () => current,
    async startSyncLocal(
      _account: string,
      options: { transport: (r: Request) => Promise<Response> },
    ) {
      calls.push("start");
      engineEpochs.push({ generation: 1, run: 1, trace: engineTrace.length });
      publish({ kind: "waiting", reason: "cache_not_valid" });
      // The engine runs on after the start returns, one step per macrotask.
      void (async () => {
        for (const step of steps) {
          await new Promise((r) => setTimeout(r, 5));
          if (stopped) return;
          trace("data.sync_tick", { why: "start", coalesced: false });
          publish({ kind: "running", catchingUp: true });
          const response = await options.transport(
            new Request(
              "http://device.invalid/api/experimental/v1/sync?limit=200",
            ),
          );
          const out = step(await response.text());
          if (out.commit) trace("data.sync_commit", out.commit);
          if (out.rows) cache = out.rows;
          publish(out.end);
          trace("data.sync_next", {
            when: out.next === "retry" ? "after" : "event",
            state: current?.kind,
          });
        }
      })();
    },
    stopSync() {
      calls.push("stop");
      stopped = true;
    },
    async syncState() {
      calls.push("syncState");
      return { cursor: "w-cursor" };
    },
    async rows() {
      calls.push(`rows:${stopped ? "stopped" : "RUNNING"}`);
      if (options.rowsFault) throw new Error(options.rowsFault);
      return cache.map((r) => ({ ...r, kind_date: null }));
    },
  };
  return { data: data as unknown as DataHarness, calls };
}

const base = {
  workload: "W-test",
  run: 1,
  cold: true as const,
  sha256: "0".repeat(64),
  sha256_verified: true,
  bytes: BYTES.length,
  heap_baseline_bytes: null,
  user_agent: "test",
  at: "2026-10-13T00:00:00.000Z",
};
const committed = (bytes: number) => ({
  bytes,
  scan_ms: 3,
  commit_ms: 9,
  kind: "applied",
  value: "committed",
});
const idle = { kind: "idle", lastSyncedAt: "t" };
const measured = (answer: string) => {
  expect(answer).toBe(BODY);
  return {
    commit: committed(BYTES.length),
    rows: [row(A, 2), row(B, 1)],
    end: idle,
  };
};
const run = (steps: Step[], options?: { rowsFault?: string }) => {
  const h = fakeHarness(steps, options);
  return runEngine(h.data, BYTES, "admitted", {
    ...base,
    expected: "admitted",
  } as never).then((r) => ({ r, calls: h.calls }));
};

describe("runEngine (the device page's actual engine run, deterministic schedules)", () => {
  it("control: the served page committed and idle is admitted, with its observation, the effects of a stopped engine and the validator's agreement", async () => {
    const { r, calls } = await run([measured]);
    expect(r.outcome).toBe("admitted");
    expect(r.detail).toBe(JSON.stringify(idle));
    expect(r.observation?.method).toBe("engine-state-log/3");
    expect(r.first_commit).toEqual(committed(BYTES.length));
    expect(r.effects).toEqual({ method: "cache-rows/1", ...EXPECTED });
    expect(r.changes_written).toBe(2);
    expect(r.cursor_after).toBe("w-cursor");
    // The engine is stopped BEFORE its cache is read.
    expect(calls.indexOf("stop")).toBeLessThan(calls.indexOf("rows:stopped"));
    expect(calls).not.toContain("rows:RUNNING");
    expect(
      deviceRunOutcomeProblems(r as never, { expectedEffects: EXPECTED }),
    ).toEqual([]);
  });

  it("case (review 12, DA-D1): a measured lease_lapsed page, then the transport's empty page committed to idle, is an error, never the workload's admission", async () => {
    const { r } = await run([
      () => ({
        commit: { ...committed(BYTES.length), value: "lease_lapsed" },
        end: { kind: "running", catchingUp: true },
        next: "retry",
      }),
      (answer) => {
        expect(JSON.parse(answer).batches).toEqual([]);
        return { commit: committed(answer.length), end: idle };
      },
    ]);
    expect(r.outcome).toBe("error");
    expect(r.detail).toMatch(
      /^the measured page was not written \(value lease_lapsed\) and the engine asked again/,
    );
    expect(r.effects).toEqual({
      method: "cache-rows/1",
      rows: 0,
      entries_sha256: sha(""),
    });
    expect(r.changes_written).toBe(0);
  });

  it("control: applied/not_ready waiting for a valid cache is a genuine refusal with its diagnostic commit", async () => {
    const { r } = await run([
      () => ({
        commit: { ...committed(BYTES.length), value: "not_ready" },
        end: { kind: "waiting", reason: "cache_not_valid" },
      }),
    ]);
    expect(r.outcome).toBe("refused");
    expect(r.first_commit?.value).toBe("not_ready");
    expect(
      deviceRunOutcomeProblems({ ...r, expected: "refused" } as never, {
        expectedEffects: EXPECTED,
      }),
    ).toEqual([]);
  });

  it("case: a committed idle run whose cache is not the served page's (another row survived) is an error", async () => {
    const { r } = await run([
      () => ({
        commit: committed(BYTES.length),
        rows: [row(A, 1), row(B, 1)],
        end: idle,
      }),
    ]);
    expect(r.outcome).toBe("error");
    expect(r.detail).toMatch(
      /^the cache's rows are not the ones the served page leaves/,
    );
  });

  it("case: an idle run whose cache cannot be read is an error, its engine stopped", async () => {
    const { r, calls } = await run([measured], { rowsFault: "quota" });
    expect(r.outcome).toBe("error");
    expect(r.effects).toBeNull();
    expect(r.detail).toMatch(/effects not read: Error: quota/);
    expect(calls).toContain("stop");
  });
});
