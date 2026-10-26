import { expect, type Page } from "@playwright/test";
import type { SyncStub } from "./data-sync-helpers";
import { type P2Port, samplePageOf } from "./profile-samples";

/**
 * The P-2 writer's port (WEB-09c revision 18; review 18 R18-P2): the page, the stubbed network's `/sync` script and the writer's
 * nudge-to-idle wait, as fixture.profile-sync.spec.ts and its native qualification (fixture.profile-outcome.spec.ts) both use it, so the
 * diagnostic runs the writer's own composition. The wait is revision 17's, unchanged: a commit traced at or after the mark and the engine
 * idle, polled at 5, 10 then 25 ms for up to 120 s (the wall time ends there). `served()` counts how often the iteration's own scripted
 * body was answered.
 */
export function p2PortOf(page: Page, net: SyncStub): P2Port {
  return {
    ...samplePageOf(page),
    enqueue: (body) => {
      let served = 0;
      net.script.push(() => {
        served += 1;
        return { status: 200, body };
      });
      return { served: () => served };
    },
    pending: () => net.script.length,
    settle: (from) =>
      expect
        .poll(
          () =>
            page.evaluate(
              (n) =>
                (window.__atlasData?.engineTrace ?? [])
                  .slice(n)
                  .some((line) => line.includes("data.sync_commit")) &&
                window.__atlasData?.engineState()?.kind === "idle",
              from,
            ),
          { timeout: 120_000, intervals: [5, 10, 25] },
        )
        .toBe(true),
    now: () => Date.now(),
  };
}
