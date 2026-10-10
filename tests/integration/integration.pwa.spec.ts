import type { Page } from "@playwright/test";
import {
  API,
  ENABLED,
  expect,
  exposeSession,
  ORIGIN,
  proxy,
  signIn,
  test,
  untilView,
} from "./helpers";

/**
 * I-U2 (WEB-14a; the WEB-08a I-13 residual "real offline reload with a service worker"), against the RELEASED backend behind the delaying
 * proxy, with the build that ships the worker (`scripts/integration/run.mjs --app dist-pwa/fixture-a -- tests/integration/integration.pwa.spec.ts`).
 * A person signs in for real; the app's own worker controls the page; the device goes offline; a reload shows the settled account from the
 * precache and the local records, and NOTHING reaches the proxy. Without `--app` (the ordinary integration run, whose build has no worker)
 * it skips itself.
 *
 * Offline: Chromium and Firefox with `context.setOffline(true)`. WebKit (qualification probe Q-P0: its Playwright build fails a worker-served
 * navigation under `setOffline`) is told it is offline (`navigator.onLine` false from the first script on), and the proxy holds anything that
 * still arrives, so a request would be SEEN in the log; the assertion is the same.
 */
const PWA = (process.env.ATLAS_INTEGRATION_APP ?? "").includes("dist-pwa");

async function openSticky(page: Page): Promise<void> {
  await page.goto(`${ORIGIN}/__session?sticky=1&route=/today`);
  await exposeSession(page);
}

test("I-U2: signed in for real, the worker controls the page; offline, a reload shows the settled account with no request reaching the proxy", async ({
  context,
  page,
  browserName,
}) => {
  test.skip(
    !ENABLED || !PWA,
    "needs the worker-enabled build: scripts/integration/run.mjs --app dist-pwa/fixture-a",
  );
  await openSticky(page);
  expect((await signIn(page, "alice")).kind).toBe("settled");
  await untilView(page, "displaying");
  // The app registered its worker; the next load is controlled by it.
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await page.reload();
  await exposeSession(page);
  await untilView(page, "displaying");
  expect(
    await page.evaluate(() => navigator.serviceWorker.controller !== null),
  ).toBe(true);
  // Let the page's own reads after display finish before the network goes (WebKit reports a cancelled fetch as a page error).
  await expect
    .poll(async () => {
      const log = await proxy.log();
      return log.filter((entry) => entry.status === undefined).length;
    })
    .toBe(0);

  if (browserName === "webkit") {
    await context.addInitScript(() => {
      Object.defineProperty(navigator, "onLine", {
        configurable: true,
        get: () => false,
      });
    });
    await proxy.addRule({ action: "hold_request" });
  } else await context.setOffline(true);
  const before = (await proxy.log()).length;

  await page.reload();
  await exposeSession(page);
  await untilView(page, "displaying");
  expect(
    await page.evaluate(() => window.__s.identity.get()?.account_id ?? null),
  ).not.toBeNull();
  await expect(
    page.getByRole("heading", { level: 1, name: "Today" }),
  ).toBeVisible();
  await page.waitForTimeout(1_000);
  const reached = (await proxy.log()).slice(before);
  expect(
    reached.map((entry) => `${entry.method} ${entry.path}`),
    "nothing may reach the proxy while offline",
  ).toEqual([]);
  // Not even the shell or an asset: the worker answered them from its precache.
  expect(reached.some((entry) => entry.path.startsWith(API))).toBe(false);
});
