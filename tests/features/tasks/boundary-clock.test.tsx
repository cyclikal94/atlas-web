import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { CacheRow } from "../../../src/data";
import {
  type BoundaryClock,
  type BoundaryWindow,
  useBoundaryClock,
} from "../../../src/features/tasks/clock";
import { forgetAllCorrections } from "../../../src/features/tasks/detail/CorrectionDialog";
import { forgetTaskMemory } from "../../../src/features/tasks/memory";
import { installMatchMedia } from "../../helpers/match-media";
import { draftRow } from "../../support/data/rows";
import { ME, mountTasks, seededTask } from "../../support/tasks/world";

/**
 * R8 of the review of 13 October 2026 (revision 2; family `task-detail-window-revalidation`, design assessment C3, schedules T1/T2): the
 * screens' time-dependent results follow the window boundaries of what they show, without data changes or user actions. The clock itself
 * under a controlled clock (fake timers: deterministic scheduling, not device sleep); the detail over the production data controller with
 * real windows a few seconds ahead of the real clock. No production duration is shortened.
 */
installMatchMedia({ width: 1440 });
afterEach(() => {
  cleanup();
  forgetTaskMemory();
  forgetAllCorrections();
  vi.useRealTimers();
});

function Probe({
  windows,
  out,
}: {
  windows: BoundaryWindow[];
  out: { clock: BoundaryClock | null; renders: number };
}) {
  const clock = useBoundaryClock(() => Date.now(), windows);
  out.clock = clock;
  out.renders += 1;
  return null;
}
const at = (iso: string) => new Date(iso).getTime();
const sec = (ms: number) => Math.floor(ms / 1000);

describe("useBoundaryClock: wakes at boundaries, re-arms, and re-reads the clock on resume (C3)", () => {
  test("wakes at the opening, then at the closing: each boundary moves the epoch", async () => {
    vi.useFakeTimers();
    const t0 = at("2026-10-12T10:00:00Z");
    vi.setSystemTime(t0);
    const out = { clock: null as BoundaryClock | null, renders: 0 };
    render(
      <Probe
        windows={[{ opens_at: sec(t0) + 10, closes_at: sec(t0) + 20 }]}
        out={out}
      />,
    );
    expect(out.clock?.epoch).toBe(0);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_100);
    });
    expect(out.clock?.epoch).toBe(1);
    expect(out.clock?.now).toBeGreaterThanOrEqual((sec(t0) + 10) * 1000);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(out.clock?.epoch).toBe(2);
    // Nothing further to wait for: no timer is left (no zero-delay loop).
    expect(vi.getTimerCount()).toBe(0);
  });

  test("a boundary thirteen hours ahead is reached through capped waits that arm themselves", async () => {
    vi.useFakeTimers();
    const t0 = at("2026-10-12T08:00:00Z");
    vi.setSystemTime(t0);
    const out = { clock: null as BoundaryClock | null, renders: 0 };
    render(
      <Probe
        windows={[{ opens_at: null, closes_at: sec(t0) + 13 * 3600 }]}
        out={out}
      />,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(13 * 3_600_000 + 100);
    });
    expect(out.clock?.epoch).toBe(1);
  });

  test("control: no boundary ahead arms no timer and never moves the epoch", async () => {
    vi.useFakeTimers();
    const t0 = at("2026-10-12T10:00:00Z");
    vi.setSystemTime(t0);
    const out = { clock: null as BoundaryClock | null, renders: 0 };
    render(
      <Probe
        windows={[{ opens_at: sec(t0) - 20, closes_at: sec(t0) - 10 }]}
        out={out}
      />,
    );
    expect(vi.getTimerCount()).toBe(0);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(out.clock?.epoch).toBe(0);
  });

  for (const event of ["focus", "pageshow", "visibilitychange"] as const)
    test(`a device that slept past the close re-reads the clock on '${event}'`, async () => {
      vi.useFakeTimers();
      const t0 = at("2026-10-12T10:00:00Z");
      vi.setSystemTime(t0);
      const out = { clock: null as BoundaryClock | null, renders: 0 };
      render(
        <Probe
          windows={[{ opens_at: null, closes_at: sec(t0) + 3600 }]}
          out={out}
        />,
      );
      // The device sleeps: the clock jumps past the close and the pending timer keeps its distance (it does not fire).
      vi.setSystemTime(t0 + 2 * 3_600_000);
      await act(async () => undefined);
      expect(out.clock?.epoch).toBe(0);
      await act(async () => {
        if (event === "visibilitychange")
          document.dispatchEvent(new Event(event));
        else window.dispatchEvent(new Event(event));
      });
      expect(out.clock?.epoch).toBe(1);
      expect(out.clock?.now).toBe(t0 + 2 * 3_600_000);
    });

  test("a clock moved BACKWARDS moves the epoch (what was derived for a later instant is asked again)", async () => {
    vi.useFakeTimers();
    const t0 = at("2026-10-12T10:00:00Z");
    vi.setSystemTime(t0);
    const out = { clock: null as BoundaryClock | null, renders: 0 };
    render(<Probe windows={[]} out={out} />);
    vi.setSystemTime(t0 - 3_600_000);
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    expect(out.clock?.epoch).toBe(1);
  });

  test("new data whose boundary passed since the clock was last read is evaluated at once (a late answer)", async () => {
    vi.useFakeTimers();
    const t0 = at("2026-10-12T10:00:00Z");
    vi.setSystemTime(t0);
    const out = { clock: null as BoundaryClock | null, renders: 0 };
    const view = render(<Probe windows={[]} out={out} />);
    // Five seconds pass with nothing to wait for; then a window that closed two seconds ago arrives.
    vi.setSystemTime(t0 + 5_000);
    view.rerender(
      <Probe
        windows={[{ opens_at: null, closes_at: sec(t0) + 2 }]}
        out={out}
      />,
    );
    await act(async () => undefined);
    expect(out.clock?.epoch).toBe(1);
    expect(out.clock?.now).toBe(t0 + 5_000);
  });
});

describe("the task detail follows its day's window (T1)", () => {
  const SLOW = { timeout: 20_000 };
  const pill = () =>
    document
      .querySelector("[data-detail-pill]")
      ?.getAttribute("data-detail-pill");
  const waitReal = (ms: number) =>
    act(async () => {
      await new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
    });
  async function upperBound(occurrence: {
    opens_at?: number;
    closes_at: number;
  }) {
    const summary = {
      outcome: "provisional" as const,
      amount: "2",
      checked: [],
    };
    return seededTask({
      definition: {
        goal: { kind: "numeric", minimum: null, maximum: "5", unit: "cups" },
      },
      progress: { action: summary, period: summary },
      occurrence,
    });
  }

  test(
    "left open offline across the close, the day becomes Done with no data change or user action",
    SLOW,
    async () => {
      const closes = Math.floor(Date.now() / 1000) + 3;
      const task = await upperBound({ closes_at: closes });
      const t = await mountTasks({
        path: `/tasks/${task.taskId}?occurrence=${task.occurrenceId}`,
        rows: task.rows,
        env: { online: false },
      });
      await t.until(() => pill() === "on_track");
      expect(pill()).toBe("on_track");
      await waitReal(closes * 1000 - Date.now() + 400);
      await t.settle();
      expect(pill()).toBe("done");
    },
  );

  test(
    "a day that opens while the detail is shown becomes recordable at the opening",
    SLOW,
    async () => {
      const opens = Math.floor(Date.now() / 1000) + 3;
      // A checkbox day with nothing recorded: "Not open yet" until it opens, then "To do".
      const task = await seededTask({
        occurrence: { opens_at: opens, closes_at: opens + 3600 },
      });
      const t = await mountTasks({
        path: `/tasks/${task.taskId}?occurrence=${task.occurrenceId}`,
        rows: task.rows,
        env: { online: false },
      });
      await t.until(() => pill() === "not_open");
      expect(pill()).toBe("not_open");
      await waitReal(opens * 1000 - Date.now() + 400);
      await t.settle();
      expect(pill()).toBe("to_do");
    },
  );

  test(
    "the window a queued correction gives the day is the one followed",
    SLOW,
    async () => {
      const task = await upperBound({
        closes_at: Math.floor(Date.now() / 1000) + 3600,
      });
      const corrected = Math.floor(Date.now() / 1000) + 3;
      const occurrence = task.rows[2] as CacheRow;
      const t = await mountTasks({
        path: `/tasks/${task.taskId}?occurrence=${task.occurrenceId}`,
        rows: task.rows,
        env: { online: false },
        drafts: [
          draftRow({
            local_id: "cccccccc-0000-4000-8000-00000000c001",
            created_seq: 1,
            kind: "revise_occurrence",
            endpoint: "/task-commands",
            account_id: ME,
            target_resource_ids: [task.occurrenceId],
            index_targets: [task.occurrenceId],
            display_patch: {
              [task.occurrenceId]: { value: { closes_at: corrected } },
            },
            command: {
              command: {
                kind: "revise_occurrence",
                id: task.occurrenceId,
                expected_version: occurrence.version,
              },
            },
          }),
        ],
      });
      await t.until(() => pill() === "on_track");
      expect(pill()).toBe("on_track");
      await waitReal(corrected * 1000 - Date.now() + 400);
      await t.settle();
      expect(pill()).toBe("done");
    },
  );
});
