import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  createPageDataHost,
  type LeaderAttachment,
} from "../../src/data/leader/page-host";
import {
  markLeaderStarted,
  resetLeaderStarted,
} from "../../src/data/leader/presence";
import {
  deriveGate,
  deriveNotices,
  derivePhase,
  type StatusInputs,
} from "../../src/data/model/status";
import {
  type BrowserComposition,
  DataProvider,
  useStatusInputs,
} from "../../src/data/ui/react";
import { sessionDouble } from "../helpers/session-double";
import { BASE_INPUTS } from "../support/data/ui-env";

/**
 * FS-1 to FS-4 (P-11) and the provider's attachment (P-3, P-4): a FOLLOWER page derives its status from the durable facts it re-reads,
 * never "Updates stopped" merely because another page leads; the durable blocked budget is shown on every page; and a provider on a
 * page whose production leader was started uses the PAGE's runtime (never disposing it) and attaches the page's leadership itself.
 */
const at = (over: Partial<StatusInputs>): StatusInputs => ({
  ...BASE_INPUTS,
  ...over,
});

describe("FS: the follower's status", () => {
  test("FS-1 a valid cache that has synced is up to date, not 'Updates stopped'", () => {
    const inputs = at({
      follower: true,
      cache: "valid",
      lastSyncedAt: "2026-10-10T10:00:00Z",
      recovery: { registered: true, active: false },
    });
    expect(derivePhase(inputs, 0)).toBe("synced");
    expect(derivePhase({ ...inputs, follower: undefined }, 0)).toBe(
      "interrupted",
    );
  });

  test("FS-2 a cache that is not valid is being brought back by the leader: 'Catching up', and it stays hidden", () => {
    for (const cache of ["invalid", "empty", "unverified"] as const) {
      const inputs = at({ follower: true, cache });
      expect(derivePhase(inputs, 0), cache).toBe("resyncing");
    }
    expect(deriveGate(at({ follower: true, cache: "invalid" }))).toBe(
      "refreshing",
    );
  });

  test("FS-3 the durable blocked budget is shown on every page, follower or leader", () => {
    const inputs = at({
      follower: true,
      cache: "invalid",
      recoveryBlocked: true,
    });
    expect(derivePhase(inputs, 0)).toBe("interrupted");
    expect(deriveNotices(inputs)).toContainEqual({ kind: "sync_blocked" });
  });

  test("FS-4 the job's own states: running is 'Catching up', a stop or a pause is 'Updates stopped' with its notice", () => {
    const job = (state: object, active = false) =>
      at({
        engine: { kind: "not_started" },
        cache: "invalid",
        recovery: { registered: true, active, state: state as never },
      });
    expect(
      derivePhase(
        job({ kind: "running", mode: "ordinary", path: "snapshot" }, true),
        0,
      ),
    ).toBe("resyncing");
    expect(derivePhase(job({ kind: "stopped", cause: "floor" }), 0)).toBe(
      "interrupted",
    );
    expect(deriveGate(job({ kind: "stopped", cause: "floor" }))).toBe("floor");
    expect(
      deriveNotices(job({ kind: "stopped", cause: "floor" })),
    ).toContainEqual({
      kind: "floor",
      variant: "b",
    });
    expect(
      deriveNotices(job({ kind: "stopped", cause: "device_capacity" })),
    ).toContainEqual({
      kind: "device_capacity",
    });
  });
});

describe("the provider on a page with a production leader", () => {
  beforeEach(() => {
    Object.defineProperty(navigator, "onLine", {
      value: false,
      configurable: true,
    });
  });
  afterEach(() => {
    cleanup();
    resetLeaderStarted();
    vi.restoreAllMocks();
    Object.defineProperty(navigator, "onLine", {
      value: true,
      configurable: true,
    });
  });

  function Probe({ out }: { out: { inputs: StatusInputs | null } }) {
    out.inputs = useStatusInputs();
    return null;
  }

  test("it waits for and uses the PAGE's runtime, never builds or disposes one, and follows the page's leadership", async () => {
    markLeaderStarted();
    const host = createPageDataHost();
    const loadBrowser = vi.fn(async (): Promise<BrowserComposition> => {
      throw new Error("the provider must not build a runtime of its own");
    });
    const runtime = {
      open: vi.fn(async () => ({ kind: "absent" as const })),
      dispose: vi.fn(),
    };
    const out: { inputs: StatusInputs | null } = { inputs: null };
    const view = render(
      <DataProvider
        session={sessionDouble()}
        loadBrowser={loadBrowser}
        host={host}
      >
        <Probe out={out} />
      </DataProvider>,
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    // The page runtime arrives after the tree mounted (the leader's chunk loads later).
    host.setRuntime({
      runtime: runtime as never,
      channel: { post: () => undefined, subscribe: () => () => undefined },
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(loadBrowser).not.toHaveBeenCalled();
    expect(runtime.open).toHaveBeenCalledWith("acct", { create: false });
    // Another page leads: the status says so (a follower), not "no leader".
    act(() => host.setLeader({ role: "follower" } satisfies LeaderAttachment));
    expect(out.inputs?.follower).toBe(true);
    expect(out.inputs?.recovery.registered).toBe(true);
    view.unmount();
    expect(runtime.dispose).not.toHaveBeenCalled();
  });

  test("without a production leader on the page it builds and disposes its own runtime, exactly as before", async () => {
    const host = createPageDataHost();
    const dispose = vi.fn();
    const loadBrowser = vi.fn(
      async (): Promise<BrowserComposition> =>
        ({
          createBrowserRuntime: () => ({
            runtime: { open: vi.fn(async () => ({ kind: "absent" })) },
            channel: {
              post: () => undefined,
              subscribe: () => () => undefined,
            },
            dispose,
          }),
        }) as never,
    );
    const view = render(
      <DataProvider
        session={sessionDouble()}
        loadBrowser={loadBrowser}
        host={host}
      >
        <span />
      </DataProvider>,
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(loadBrowser).toHaveBeenCalledTimes(1);
    view.unmount();
    expect(dispose).toHaveBeenCalledTimes(1);
  });
});

/**
 * R6 of the review of 10 October 2026 (finding family follower-durable-sync-status): a follower reads the leader's DURABLE stops from
 * `sync_state` (the production facts plan over the IndexedDB double) and says so, rather than "Up to date". The reviewer's probe
 * (`.agtx/evidence/review-1/probes/follower-status-review.test.ts`) is the origin of the first case; the healthy control is kept beside it.
 */
describe("R6: a follower's status follows the durable sync stops", () => {
  async function followerPhase(
    patch: Partial<import("../../src/data/model/types").SyncStateRow>,
  ) {
    const { pageWorld } = await import("../support/data/page-world");
    const { readSyncFacts } = await import("../../src/data/plans/facts");
    const w = await pageWorld({
      cursor: "d1",
      phase: "delta",
      cacheStatus: "valid",
    });
    w.setSync({ last_synced_at: "2026-10-10T00:00:00Z", ...patch });
    const facts = await w.service.store.run(readSyncFacts, {
      incarnationId: w.service.incarnationId,
    });
    if (facts === null) throw new Error("no facts");
    const inputs = at({
      follower: true,
      cache: facts.cacheStatus,
      lastSyncedAt: facts.lastSyncedAt,
      recoveryBlocked: facts.recoveryBlocked,
      followerStops: facts.syncStops,
      recovery: { registered: true, active: false },
    });
    return {
      phase: derivePhase(inputs, 3_600_000),
      notices: deriveNotices(inputs),
      gate: deriveGate(inputs),
    };
  }

  test("control: a healthy follower whose cache has synced is up to date, with no notice", async () => {
    const out = await followerPhase({});
    expect(out.phase).toBe("synced");
    expect(out.notices).toEqual([]);
  });

  test("R6: a durably PAUSED `sync` read caller is not 'Up to date': it is interrupted, with 'Retry now'", async () => {
    const { initialReadRetry } = await import("../../src/data/model/retry");
    const out = await followerPhase({
      read_retry_states: {
        sync: { ...initialReadRetry(), paused: true, backing_off_since: 0 },
      },
    });
    expect(out.phase).toBe("interrupted");
    expect(out.notices).toContainEqual({
      kind: "still_trying",
      scope: "updates",
      count: 1,
    });
  });

  for (const operation of [
    "page:d1",
    "snapshot-page:start",
    "snapshot-page:at:s-2",
    "invalidate:d1",
    "capture",
    "recovery-capture",
    "recovery-budget",
  ])
    test(`R6: a sync writer's local write stopped at its bound (${operation}) is shown with 'Retry applying changes'`, async () => {
      const out = await followerPhase({
        local_write_streaks: { [operation]: 3 },
      });
      expect(out.phase).toBe("interrupted");
      expect(out.notices).toContainEqual({
        kind: "page_not_saved",
        memoryOnly: false,
      });
    });

  test("control: the outbox's own stops (a draft, the queue) and a streak below the bound are not the sync writers' stops", async () => {
    const out = await followerPhase({
      local_write_streaks: {
        "00000000-0000-4000-8000-000000000001": 3,
        queue: 3,
        "page:d1": 2,
      },
    });
    expect(out.phase).toBe("synced");
    expect(out.notices).not.toContainEqual(
      expect.objectContaining({ kind: "page_not_saved" }),
    );
  });

  test("R6: the Q23 floor is shown on a follower (state (a) with the cache still shown)", async () => {
    const out = await followerPhase({
      sizing: { limit: 1, class: "constrained", floor_hits: 3, attempt: null },
    });
    expect(out.phase).toBe("interrupted");
    expect(out.notices).toContainEqual({ kind: "floor", variant: "a" });
    expect(out.gate).toBe("open");
  });

  test("the follower's list of sync-writer operations is the writers' own constants", async () => {
    const { SYNC_WRITER_OPERATIONS } = await import(
      "../../src/data/model/recovery"
    );
    const writers = await import("../../src/data/plans/sync-writers");
    const recovery = await import("../../src/data/plans/recovery-writers");
    expect([...SYNC_WRITER_OPERATIONS].sort()).toEqual(
      [
        writers.CAPTURE_OPERATION,
        writers.READ_RETRY_OPERATION,
        writers.SIZING_OPERATION,
        recovery.RECOVERY_CAPTURE_OPERATION,
        recovery.RECOVERY_BUDGET_OPERATION,
      ].sort(),
    );
  });
});
