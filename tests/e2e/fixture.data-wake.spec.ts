import { type BrowserContext, expect, type Page, test } from "@playwright/test";
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
 * E-C13 (revision 10, R22: a wake that arrives while a step runs is not lost), in Chromium, Firefox and WebKit: the PRODUCTION sync
 * engine, plans and guards over REAL IndexedDB and real timers, on the data harness page (no session: the harness's own runtime and
 * identity, and a transport this spec supplies inside the page). FIXTURE evidence: no backend is behind it, and the transport is a
 * script. The dispatcher's late-enqueue schedule needs a read of the queue to be held while a save commits, which a real engine cannot
 * be made to do on request, so it is held over the double (`tests/data/pending-wake.test.ts`); here the SYNC engine's schedule runs in
 * three real engines.
 *
 * The production composition of the notifications: the second describe starts the engine over the REAL session of the fixture (its
 * view and identity stores, visibility and `online` are the engine's wake sources, as WEB-09b will wire them), with a second real tab
 * open (every request one tab sends writes a lease the other hears, and each hint makes the session publish a new identity object).
 * A wake that arrives while a step runs counts only if what the step reads has changed, so those republished identities cannot make
 * the engine ask again: the review's "do not restore a feedback loop", measured in three real engines.
 *
 * The schedule: the engine's first request is outstanding; the page's sign-in moves to epoch 2 and notifies; the response then
 * arrives. The stale page is dropped, which leaves nothing scheduled (the engine waits for the identity), and the wake that announced
 * the new sign-in had already been delivered, while the step ran. Before the fix the engine then slept for good (the review: one request
 * only, an hour later); now it evaluates once more from the current facts.
 */
declare global {
  interface Window {
    __calls?: string[];
    __release?: () => void;
  }
}

const calls = (page: Page) => page.evaluate(() => window.__calls?.length ?? 0);

/** Starts the engine over a transport whose FIRST request is held until `window.__release()`. */
async function startHeld(page: Page): Promise<void> {
  await page.evaluate(async (account) => {
    const data = window.__atlasData;
    if (data === undefined) throw new Error("no harness");
    window.__calls = [];
    const empty = (cursor: string) =>
      new Response(
        JSON.stringify({
          phase: "delta",
          batches: [],
          next_cursor: cursor,
          has_more: false,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    await data.startSyncLocal(account, {
      seedCursor: "c0",
      transport: (request) => {
        window.__calls?.push(request.url);
        const n = window.__calls?.length ?? 0;
        if (n > 1) return Promise.resolve(empty(`c${n}`));
        return new Promise<Response>((resolve) => {
          window.__release = () => resolve(empty("c1"));
        });
      },
    });
  }, ACCOUNT);
  await expect.poll(() => calls(page), { timeout: 10_000 }).toBe(1);
}

/** How many notifications of the session (its view, its identity, visibility) the engine has been told of; the `atlas-sync` hints are not among them. Evidence only. */
const heard = (page: Page) =>
  page.evaluate(() => window.__atlasData?.wakeNotifications() ?? 0);

/**
 * Serves `GET /me` and `GET /sessions` (the profile read and the device mirror) successfully, as a healthy backend does. Call it AFTER
 * `stubNetwork`: the route registered last answers first, and the stub answers every other request of the API with a 404.
 */
async function serveHealthyIdentityReads(
  context: BrowserContext,
): Promise<void> {
  const now = Date.now();
  await context.route("**/api/experimental/v1/me", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ id: ACCOUNT, username: "alice" }),
    }),
  );
  await context.route("**/api/experimental/v1/sessions", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        sessions: [
          {
            id: "s1",
            device_id: "dev-1",
            created_at: new Date(now - 60_000).toISOString(),
            expires_at: new Date(now + 86_400_000).toISOString(),
            authentication: "password",
            current: true,
          },
        ],
      }),
    }),
  );
}

const state = (page: Page) =>
  page.evaluate(() => window.__atlasData?.engineState() ?? null);

test.describe("E-C13: a wake that arrives while a step runs is not lost (R22)", () => {
  test("the sign-in moves to a new epoch while a page is outstanding: the stale page is dropped and the engine asks again under the new one", async ({
    context,
  }, info) => {
    const page = await dataPage(context);
    await startHeld(page);
    await page.evaluate((account) => {
      window.__atlasData?.setRuntimeIdentity({ account, epoch: 2 });
    }, ACCOUNT);
    await page.evaluate(() => window.__release?.());
    await expect
      .poll(() => calls(page), { timeout: 15_000 })
      .toBeGreaterThanOrEqual(2);
    recordEvidence(info, "r22-engine-epoch-during-step", {
      calls: await calls(page),
      state: await state(page),
    });
    // And then quiet: the healthy page schedules the idle poll, a minute away.
    await page.waitForTimeout(2_000);
    expect(await calls(page)).toBe(2);
    await page.evaluate(() => window.__atlasData?.stopSync());
    await page.close();
  });

  test("the control: the same move AFTER the step has settled also starts fresh work", async ({
    context,
  }, info) => {
    const page = await dataPage(context);
    await startHeld(page);
    await page.evaluate(() => window.__release?.());
    await expect
      .poll(async () => (await state(page))?.kind, { timeout: 10_000 })
      .toBe("idle");
    expect(await calls(page)).toBe(1);
    await page.evaluate((account) => {
      window.__atlasData?.setRuntimeIdentity({ account, epoch: 2 });
    }, ACCOUNT);
    await expect
      .poll(() => calls(page), { timeout: 15_000 })
      .toBeGreaterThanOrEqual(2);
    recordEvidence(info, "r22-engine-epoch-after-step", {
      calls: await calls(page),
    });
    await page.evaluate(() => window.__atlasData?.stopSync());
    await page.close();
  });

  test("a notification that changes nothing during the step is not news: one request, then the idle poll", async ({
    context,
  }, info) => {
    const page = await dataPage(context);
    await startHeld(page);
    await page.evaluate((account) => {
      for (let i = 0; i < 5; i += 1)
        window.__atlasData?.setRuntimeIdentity({ account, epoch: 1 });
    }, ACCOUNT);
    await page.evaluate(() => window.__release?.());
    await expect
      .poll(async () => (await state(page))?.kind, { timeout: 10_000 })
      .toBe("idle");
    await page.waitForTimeout(3_000);
    recordEvidence(info, "r22-engine-no-change", { calls: await calls(page) });
    expect(await calls(page)).toBe(1);
    await page.evaluate(() => window.__atlasData?.stopSync());
    await page.close();
  });
});

/** Steps the engine began, by why: `now` is a step that a PENDING wake (or the step's own `now`) asked for, `wake` a notification delivered while idle. */
const steps = (page: Page) =>
  page.evaluate(() => {
    const out = { started: 0, now: 0, wake: 0, coalesced: 0 };
    for (const line of window.__atlasData?.engineTrace ?? []) {
      if (!line.includes("data.sync_tick")) continue;
      if (line.includes('"coalesced":true')) out.coalesced += 1;
      else {
        out.started += 1;
        if (line.includes('"why":"now"')) out.now += 1;
        if (line.includes('"why":"wake"')) out.wake += 1;
      }
    }
    return out;
  });

/** Waits until the number of requests has not changed for `quiet` ms (the session's own notifications of its start have died down). */
async function untilQuiet(
  page: Page,
  count: () => number,
  quiet = 3_000,
): Promise<void> {
  let last = -1;
  let since = Date.now();
  for (let i = 0; i < 60; i += 1) {
    const now = count();
    if (now !== last) {
      last = now;
      since = Date.now();
    } else if (Date.now() - since >= quiet) return;
    await page.waitForTimeout(250);
  }
  // An ASSERTION, not a crash (revision 13): an engine that never goes quiet is the defect this waiting is there to show.
  expect(false, "the engine never went quiet").toBe(true);
}

test.describe("E-C13: the real session's notifications cannot feed the engine (R22, production composition)", () => {
  // Which notifications START a step while the engine is IDLE is not this revision's change (a wake is "eligibility may have
  // changed: look now", and a real session with a second tab publishes a few at its start): what is asserted is that the wakes that
  // arrive while a step RUNS add no step of their own (no `now` step), that the engine goes quiet, and that it stays quiet.
  test("a healthy engine beside a second real tab: the session's notifications die down, no step is asked for by a pending wake, and it stays quiet", async ({
    context,
  }, info) => {
    const stub = await stubNetwork(context);
    // REVISION 13: a HEALTHY backend answers the identity reads. The shared stub answers neither `/me` nor `/sessions` (404), so the page's
    // profile read and device mirror (this tab's and the second tab's) retry on their back-off for ever, each failed attempt writes a
    // durable retry record and posts an `atlas-sync` hint, and every hint wakes the idle engine: the "late notifications" the three-second
    // lull in requests could not tell from a loop (root cause of the WebKit failure of revision 12, `requests: 5, settled: 4`). The
    // assertions below are the original ones, unchanged.
    await serveHealthyIdentityReads(context);
    await seedSettled(context);
    const leader = await bootSession(context);
    const other = await bootSession(context);
    await startLeader(leader);
    await expect.poll(() => stub.requests.length).toBeGreaterThanOrEqual(1);
    await untilQuiet(leader, () => stub.requests.length);
    const settled = stub.requests.length;
    const counted = await steps(leader);
    const heardAtSettle = await heard(leader);
    await leader.waitForTimeout(5_000);
    recordEvidence(info, "r22-engine-real-session-healthy", {
      requests: stub.requests.length,
      settled,
      steps: counted,
      sessionNotificationsAfterSettle: (await heard(leader)) - heardAtSettle,
    });
    expect(settled).toBeLessThanOrEqual(10);
    expect(stub.requests.length).toBe(settled);
    expect(counted.now).toBe(0);
    await leader.evaluate(() => window.__atlasData?.stopSync());
    await other.close();
    await leader.close();
  });

  test("a failing engine beside a second real tab: the back-off is the schedule, and the engine goes quiet within it", async ({
    context,
  }, info) => {
    const stub = await stubNetwork(context);
    for (let i = 0; i < 60; i += 1)
      stub.script.push(() => ({
        status: 503,
        body: JSON.stringify({
          code: "temporarily_unavailable",
          message: "stub",
          request_id: "11111111-1111-4111-8111-111111111111",
          details: [],
        }),
      }));
    await seedSettled(context);
    const leader = await bootSession(context);
    const other = await bootSession(context);
    await startLeader(leader);
    await expect.poll(() => stub.requests.length).toBeGreaterThanOrEqual(1);
    await leader.waitForTimeout(12_000);
    const counted = await steps(leader);
    recordEvidence(info, "r22-engine-real-session-failing", {
      requests: stub.requests.length,
      steps: counted,
    });
    // The back-off (2 s, 4 s, 8 s) gives about four requests in twelve seconds, and a few notifications of the session's start may add
    // as many: never a request per notification for ever, and no step asked for by a pending wake.
    expect(stub.requests.length).toBeLessThanOrEqual(12);
    expect(counted.now).toBe(0);
    const before = stub.requests.length;
    await leader.waitForTimeout(6_000);
    expect(stub.requests.length - before).toBeLessThanOrEqual(2);
    await leader.evaluate(() => window.__atlasData?.stopSync());
    await other.close();
    await leader.close();
  });

  test("`online` and visibility signals are bounded: each visibility change at most one step, `online` at most one more, never a loop", async ({
    context,
  }, info) => {
    const stub = await stubNetwork(context);
    await seedSettled(context);
    const leader = await bootSession(context);
    await startLeader(leader);
    await expect.poll(() => stub.requests.length).toBeGreaterThanOrEqual(1);
    await untilQuiet(leader, () => stub.requests.length);
    const before = stub.requests.length;
    for (let i = 0; i < 20; i += 1)
      await leader.evaluate(() =>
        document.dispatchEvent(new Event("visibilitychange")),
      );
    await untilQuiet(leader, () => stub.requests.length, 2_000);
    const afterVisibility = stub.requests.length;
    await leader.evaluate(() => window.dispatchEvent(new Event("online")));
    await untilQuiet(leader, () => stub.requests.length, 2_000);
    recordEvidence(info, "r22-engine-real-session-signals", {
      before,
      afterVisibility,
      afterOnline: stub.requests.length,
    });
    expect(afterVisibility - before).toBeLessThanOrEqual(21);
    expect(stub.requests.length - afterVisibility).toBeLessThanOrEqual(2);
    await leader.evaluate(() => window.__atlasData?.stopSync());
    await leader.close();
  });
});
