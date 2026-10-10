import type { BrowserContext, Page } from "@playwright/test";
import {
  ACCOUNT,
  leaderNetwork,
  leaderPage,
  seedAuth,
  snapshotPage,
  syncStateOf,
} from "./data-leader-helpers";
import { upsert } from "./data-sync-helpers";
import { expect, test } from "./helpers";

/**
 * WEB-09b's DESIGN MEASUREMENT (plan 10.6): how long the activation (W23: the final snapshot page and the swap, ONE transaction under the
 * 30 s persistence hold, with the 20 s apply watchdog at every window) takes for 10,000 and 50,000 staged rows, in this desktop's real
 * engines. REPORTED FIGURES ONLY, labelled desktop/fixture and handed to WEB-09c: no threshold is asserted beyond "it activated", and
 * nothing here is device evidence. Run only when asked (`ATLAS_DESIGN_MEASURE=1`, one worker, nothing else loading the machine).
 */
test.skip(
  !process.env.ATLAS_DESIGN_MEASURE,
  "the design measurement runs only when asked (ATLAS_DESIGN_MEASURE=1)",
);

const ROWS = [10_000, 50_000];

async function arrangeStaged(context: BrowserContext, rows: number) {
  const page = await context.newPage();
  await page.goto("/__session?boot=off");
  await page.waitForFunction(() => window.__atlasData !== undefined);
  await page.evaluate(
    async ([account, count]) => {
      const data = window.__atlasData;
      if (!data) throw new Error("no harness");
      data.setIdentity(account);
      await data.open(account, { create: true });
      const chunk = 5_000;
      for (let from = 0; from < count; from += chunk) {
        const batch = [];
        for (let n = from; n < Math.min(count, from + chunk); n += 1)
          batch.push({
            id: `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`,
            kind: "task",
            parent_id: null,
            label: `Staged ${n}`,
            value: { n, note: "x".repeat(64) },
            version: 1,
            can_edit: true,
            archived: false,
            kind_date: null,
            recovery_generation: 1,
          });
        await data.put(account, "cache_staging", batch);
      }
      const sync = (await data.syncState(account)) as Record<string, unknown>;
      await data.put(account, "sync_state", [
        {
          ...sync,
          recovery_generation: 1,
          staging_position: "snap-final",
          staging_started_at: Date.now(),
          staging_revision: 10,
          staging_bytes: count * 200,
        },
      ]);
      data.close(account);
    },
    [ACCOUNT, rows] as const,
  );
  await page.close();
}

const commits = (page: Page) =>
  page.evaluate(
    () =>
      (window.__atlasFixture?.session?.trace ?? []).filter(
        (e) => e.event === "data.recovery_commit",
      ) as Array<{ event: string; data?: Record<string, unknown> }>,
  );

for (const rows of ROWS)
  test(`activation of ${rows} staged rows (one transaction, windows of 500): reported, not asserted`, async ({
    context,
  }, info) => {
    info.setTimeout(180_000);
    const net = await leaderNetwork(context);
    await seedAuth(context);
    await arrangeStaged(context, rows);
    net.answer = (call) =>
      call.cursor === "snap-final"
        ? snapshotPage([upsert(999_999, { n: 1 })], "delta-1", false)
        : snapshotPage([], "delta-1", false);
    const started = Date.now();
    const page = await leaderPage(context, net, "one");
    await expect
      .poll(async () => (await syncStateOf(page))?.cache_status, {
        timeout: 150_000,
      })
      .toBe("valid");
    const elapsed = Date.now() - started;
    const final = (await commits(page)).filter((e) => e.data?.final === true);
    const figure = {
      label:
        "WEB-09b design measurement: DESKTOP, FIXTURE (synthetic rows); not device evidence",
      engine: info.project.name,
      rows,
      first_request_cursor: net.calls[0]?.cursor ?? null,
      activation_commit_ms: final.map((e) => e.data?.commit_ms ?? null),
      outcomes: final.map((e) => `${e.data?.outcome}/${e.data?.value ?? ""}`),
      boot_to_valid_ms: elapsed,
      persistence_hold_ms: 30_000,
      apply_watchdog_ms: 20_000,
    };
    await info.attach(`design-snapshot-${rows}`, {
      body: JSON.stringify(figure, null, 2),
      contentType: "application/json",
    });
    console.log(`DESIGN ${JSON.stringify(figure)}`);
    // Only that it activated, adopting the staged attempt: the figures are what is reported.
    expect(figure.first_request_cursor).toBe("snap-final");
  });
