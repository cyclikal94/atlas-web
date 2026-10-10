import { expect, type Page, test } from "@playwright/test";
import { recordEvidence } from "./data-evidence";
import {
  ACCOUNT,
  bootSession,
  dataPage,
  seedSettled,
  startLeader,
  stubNetwork,
} from "./data-sync-helpers";

/**
 * E-C15 (revision 12, R26 and R27), in Chromium, Firefox and WebKit: the ownership seam of the PRODUCTION sync engine and the
 * eligibility of a step at the moment it issues, over REAL IndexedDB, real timers and a real `AbortSignal`, on the data harness page
 * (no session: the harness's own runtime and identity, and a transport this spec supplies inside the page). FIXTURE evidence: no backend
 * is behind it, the transport is a script, and the engine is started by the fixture's TEST LEADER (production starts no engine until
 * WEB-09b supplies leadership).
 *
 * R26: an ownership signal's abort cleared the engine's shared timer whichever run had installed it. After a restart, aborting the
 * signal that was replaced ended the NEW run's back-off deadline, and nothing asked again until some unrelated wake. The back-off here
 * is the server's own `Retry-After: 3` (3 seconds of real time; no production constant is shortened).
 *
 * R27: the engine's last `alive` test preceded the quota read, so a `stop()` or a lost ownership during that read still issued the
 * request when it resolved. The quota read is held by the fixture (`holdQuota`), as a slow `navigator.storage.estimate()` would hold it.
 */
declare global {
  interface Window {
    __calls?: string[];
  }
}

const calls = (page: Page) => page.evaluate(() => window.__calls?.length ?? 0);
const state = (page: Page) =>
  page.evaluate(() => window.__atlasData?.engineState() ?? null);

/** Starts the engine over a scripted transport: every request is counted; `backoff` answers 503 with `Retry-After: 3`. */
async function start(page: Page, mode: "backoff" | "empty"): Promise<void> {
  await page.evaluate(
    async ({ account, mode }) => {
      const data = window.__atlasData;
      if (data === undefined) throw new Error("no harness");
      window.__calls = [];
      await data.startSyncLocal(account, {
        seedCursor: "c0",
        transport: (request) => {
          window.__calls?.push(request.url);
          const n = window.__calls?.length ?? 0;
          if (mode === "backoff")
            return Promise.resolve(
              new Response(
                JSON.stringify({
                  code: "temporarily_unavailable",
                  message: "m",
                  request_id: "11111111-1111-4111-8111-111111111111",
                  details: [],
                }),
                {
                  status: 503,
                  headers: {
                    "content-type": "application/json",
                    "retry-after": "3",
                  },
                },
              ),
            );
          return Promise.resolve(
            new Response(
              JSON.stringify({
                phase: "delta",
                batches: [],
                next_cursor: `c${n}`,
                has_more: false,
              }),
              { status: 200, headers: { "content-type": "application/json" } },
            ),
          );
        },
      });
    },
    { account: ACCOUNT, mode },
  );
}

test.describe("E-C15 (R26): an obsolete ownership signal never ends the current run's back-off", () => {
  test("a restart, then the replaced signal aborts: the back-off deadline (3 s) still brings the next request", async ({
    context,
  }, info) => {
    const page = await dataPage(context);
    await start(page, "backoff");
    await expect.poll(() => calls(page), { timeout: 10_000 }).toBe(1);
    await page.evaluate(() => window.__atlasData?.restartSync());
    // The new run's first step asks at once and is told to wait 3 s: its deadline is set.
    await expect.poll(() => calls(page), { timeout: 10_000 }).toBe(2);
    await expect
      .poll(() => state(page), { timeout: 10_000 })
      .toMatchObject({
        kind: "backing_off",
      });
    // NOW the signal that was replaced fires (an ownership change that reaches the page late). It is not the current owner's.
    await page.evaluate(() => window.__atlasData?.abortReplacedOwnership());
    // The deadline stands: before the fix this stayed at 2 until some unrelated wake.
    await expect
      .poll(() => calls(page), { timeout: 12_000 })
      .toBeGreaterThanOrEqual(3);
    recordEvidence(info, "r26-restart-old-abort", {
      calls: await calls(page),
      state: await state(page),
    });
    await page.evaluate(() => window.__atlasData?.stopSync());
    await page.close();
  });

  test("control: a restart with no late abort makes the same request at the same deadline", async ({
    context,
  }) => {
    const page = await dataPage(context);
    await start(page, "backoff");
    await expect.poll(() => calls(page), { timeout: 10_000 }).toBe(1);
    await page.evaluate(() => window.__atlasData?.restartSync());
    await expect.poll(() => calls(page), { timeout: 10_000 }).toBe(2);
    await expect
      .poll(() => calls(page), { timeout: 12_000 })
      .toBeGreaterThanOrEqual(3);
    await page.evaluate(() => window.__atlasData?.stopSync());
    await page.close();
  });

  test("control: the CURRENT owner's abort still ends the run (no request at the deadline)", async ({
    context,
  }) => {
    const page = await dataPage(context);
    await start(page, "backoff");
    await expect.poll(() => calls(page), { timeout: 10_000 }).toBe(1);
    await page.evaluate(() => window.__atlasData?.loseSyncOwnership());
    // Past the 3 s deadline, with margin: nothing is asked by an engine whose owner is gone.
    await page.waitForTimeout(5_000);
    expect(await calls(page)).toBe(1);
    await page.evaluate(() => window.__atlasData?.stopSync());
    await page.close();
  });
});

/** The engine's first step has begun (a tick was traced) and had time to reach the held quota read. */
const atTheHold = async (page: Page): Promise<void> => {
  await expect
    .poll(
      () =>
        page.evaluate(
          () =>
            window.__atlasData?.engineTrace.some((line) =>
              line.includes("data.sync_tick"),
            ) ?? false,
        ),
      { timeout: 10_000 },
    )
    .toBe(true);
  await page.waitForTimeout(500);
};

test.describe("E-C15 (R27): a step that is no longer eligible when its quota read returns issues nothing", () => {
  for (const [name, act] of [
    ["stop()", () => window.__atlasData?.stopSync()],
    ["a lost ownership", () => window.__atlasData?.loseSyncOwnership()],
  ] as const)
    test(`${name} during the quota read: no request when it resolves`, async ({
      context,
    }, info) => {
      const page = await dataPage(context);
      await page.evaluate(() => window.__atlasData?.holdQuota());
      await start(page, "empty");
      await atTheHold(page);
      expect(await calls(page)).toBe(0);
      await page.evaluate(act);
      await page.evaluate(() => window.__atlasData?.releaseQuota());
      await page.waitForTimeout(1_500);
      expect(await calls(page)).toBe(0);
      recordEvidence(info, `r27-${name}`, { calls: await calls(page) });
      await page.evaluate(() => window.__atlasData?.stopSync());
      await page.close();
    });

  test("control: the same hold, released with nothing changed, issues the request once", async ({
    context,
  }) => {
    const page = await dataPage(context);
    await page.evaluate(() => window.__atlasData?.holdQuota());
    await start(page, "empty");
    await atTheHold(page);
    expect(await calls(page)).toBe(0);
    await page.evaluate(() => window.__atlasData?.releaseQuota());
    await expect.poll(() => calls(page), { timeout: 10_000 }).toBe(1);
    await page.evaluate(() => window.__atlasData?.stopSync());
    await page.close();
  });
});

test.describe("E-C15 (R27, production composition): over the REAL session's stamped wrapper", () => {
  // The wrapper validates the account and the epoch, and may refuse a call whose identity moved. It knows nothing of the engine's own
  // lifetime: a `stop()` or a lost ownership is not a session identity change, so only the engine can refuse the request.
  for (const [name, act] of [
    ["stop()", () => window.__atlasData?.stopSync()],
    ["a lost ownership", () => window.__atlasData?.loseSyncOwnership()],
  ] as const)
    test(`${name} during the quota read, with the real session present: no /sync request reaches the network`, async ({
      context,
    }, info) => {
      const net = await stubNetwork(context);
      await seedSettled(context);
      const page = await bootSession(context);
      await page.evaluate(() => window.__atlasData?.holdQuota());
      await startLeader(page);
      await atTheHold(page);
      expect(net.requests).toHaveLength(0);
      await page.evaluate(act);
      await page.evaluate(() => window.__atlasData?.releaseQuota());
      await page.waitForTimeout(1_500);
      expect(net.requests).toHaveLength(0);
      recordEvidence(info, `r27-session-${name}`, {
        syncRequests: net.requests.length,
      });
      await page.evaluate(() => window.__atlasData?.stopSync());
    });

  test("control: the same hold over the real session, released with nothing changed, sends exactly one /sync request", async ({
    context,
  }) => {
    const net = await stubNetwork(context);
    await seedSettled(context);
    const page = await bootSession(context);
    await page.evaluate(() => window.__atlasData?.holdQuota());
    await startLeader(page);
    await atTheHold(page);
    expect(net.requests).toHaveLength(0);
    await page.evaluate(() => window.__atlasData?.releaseQuota());
    await expect.poll(() => net.requests.length, { timeout: 10_000 }).toBe(1);
    await page.evaluate(() => window.__atlasData?.stopSync());
  });
});
