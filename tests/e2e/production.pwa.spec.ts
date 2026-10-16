import type { Page } from "@playwright/test";
import {
  BANNER,
  build,
  checkForUpdate,
  expect,
  type Generations,
  mark,
  marked,
  navigate,
  quiet,
  test,
  updateRegion,
  workerActive,
} from "./pwa-world";

/**
 * WEB-14a, the PRODUCTION build (`dist-pwa/production-a`: a byte copy of `dist`; `production-b`: the same build with another label),
 * served with the reference nginx configuration's semantics and the production security headers by scripts/serve-generations.mjs.
 *
 *  P-P1 the app registers the worker itself (no test registration), and the next navigation is controlled;
 *  P-P2 the neutral update banner (signed out), its announcement through the neutral live region (revision 1, R8), and the reload onto B;
 *  P-P3 the API compatibility screen offers the update when a newer client is waiting;
 *  P-P4 installability in Chromium (`Page.getInstallabilityErrors` empty; the manifest and its icons are fetched);
 *  P-P5 the production content security policy: no violation, no console message, with the worker and the manifest.
 *
 * FIXTURE evidence about the built client (no backend: `/health` is the server's stub).
 */
test.use({ firstGeneration: "production-a" });

const ENTRY = "Sign in to Atlas";

/** Records every content security policy violation the page reports, from its first script on. */
async function openNeutral(page: Page, world: Generations): Promise<void> {
  await page.addInitScript(() => {
    const scope = window as unknown as { __csp: string[] };
    scope.__csp = [];
    document.addEventListener("securitypolicyviolation", (event) => {
      scope.__csp.push(`${event.violatedDirective} ${event.blockedURI}`);
    });
  });
  await navigate(page, `${world.url}/`);
  await page.waitForLoadState("load");
  await expect(page.getByText(ENTRY)).toBeVisible();
}
const violations = (page: Page) =>
  page.evaluate(() => (window as unknown as { __csp: string[] }).__csp);

test("P-P1, P-P5: the production app registers the worker itself; the next load is controlled; no policy violation", async ({
  page,
  generations,
}) => {
  await openNeutral(page, generations);
  // No test code registers anything: the app did.
  await workerActive(page);
  const registration = await page.evaluate(async () => {
    const found = await navigator.serviceWorker.getRegistration();
    return {
      scope: found?.scope ?? null,
      script: found?.active?.scriptURL ?? null,
    };
  });
  expect(registration.scope).toBe(`${generations.url}/`);
  expect(registration.script).toBe(`${generations.url}/sw.js`);
  await quiet(page);
  await page.reload();
  await page.waitForLoadState("load");
  await expect(page.getByText(ENTRY)).toBeVisible();
  expect(
    await page.evaluate(() => navigator.serviceWorker.controller !== null),
  ).toBe(true);
  expect(await violations(page)).toEqual([]);
});

test("P-P2: signed out, the neutral banner offers B and 'Reload' reloads onto it", async ({
  page,
  generations,
}) => {
  await openNeutral(page, generations);
  await workerActive(page);
  await quiet(page);
  await page.reload();
  await page.waitForLoadState("load");
  expect(await build(page)).toBeNull();
  await generations.serve("production-b");
  await checkForUpdate(page);
  await expect(updateRegion(page).getByText(BANNER.available)).toBeVisible();
  await mark(page);
  await quiet(page);
  await updateRegion(page)
    .getByRole("button", { name: "Reload", exact: true })
    .click();
  await expect.poll(() => marked(page).catch(() => false)).toBe(false);
  await page.waitForLoadState("load");
  await expect.poll(() => build(page)).toBe("b");
  await expect(page.getByText(ENTRY)).toBeVisible();
  expect(await violations(page)).toEqual([]);
});

test("P-P2 (revision 1, R8): signed out, the update is announced exactly once through the neutral live region, and focus does not move", async ({
  page,
  generations,
}) => {
  await openNeutral(page, generations);
  await workerActive(page);
  await quiet(page);
  await page.reload();
  await page.waitForLoadState("load");
  // The neutral root's region is there, empty, BEFORE anything is offered (a region inserted with its message is not reliably read).
  const region = page.locator("[data-neutral-live-region]");
  await expect(region).toHaveCount(1);
  await expect(region).toHaveAttribute("role", "status");
  await expect(region).toHaveAttribute("aria-live", "polite");
  await expect(region).toHaveText("");
  // Every text the region takes, from now on, and where focus is.
  await page.evaluate(() => {
    const scope = window as unknown as { __said: string[] };
    scope.__said = [];
    const element = document.querySelector("[data-neutral-live-region]");
    if (!element) throw new Error("no neutral live region");
    new MutationObserver(() => {
      const text = element.textContent ?? "";
      if (text !== "") scope.__said.push(text);
    }).observe(element, {
      childList: true,
      characterData: true,
      subtree: true,
    });
  });
  // Where focus is now (compared by identity: the element itself).
  await page.evaluate(() => {
    (window as unknown as { __focused: Element | null }).__focused =
      document.activeElement;
  });
  await generations.serve("production-b");
  await checkForUpdate(page);
  await expect(updateRegion(page).getByText(BANNER.available)).toBeVisible();
  await expect(region).toHaveText(BANNER.available);
  await page.waitForTimeout(500);
  expect(
    await page.evaluate(
      () => (window as unknown as { __said: string[] }).__said,
    ),
  ).toEqual([BANNER.available]);
  // One region announces it: no other live region in the page holds the message.
  await expect(
    page.locator('[aria-live], [role="status"], [role="alert"]', {
      hasText: BANNER.available,
    }),
  ).toHaveCount(1);
  expect(
    await page.evaluate(
      () =>
        document.activeElement ===
        (window as unknown as { __focused: Element | null }).__focused,
    ),
  ).toBe(true);
});

test("P-P3: the API compatibility screen offers the update when the server is newer and a newer client is waiting", async ({
  page,
  generations,
}) => {
  await openNeutral(page, generations);
  await workerActive(page);
  await generations.health({ status: "ok", api_version: "0.30.0" });
  await generations.serve("production-b");
  await quiet(page);
  await page.reload();
  await page.waitForLoadState("load");
  await expect(
    page.getByRole("heading", {
      level: 1,
      name: "Atlas can't work with this server yet",
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Reload to update" }),
  ).toBeVisible();
});

test("P-P4: installable in Chromium: no installability error, and the manifest and its icons are served", async ({
  page,
  generations,
  browserName,
  context,
}) => {
  test.skip(
    browserName !== "chromium",
    "Page.getInstallabilityErrors is Chromium's (Chrome DevTools Protocol); Safari and Firefox installation is WEB-15 release evidence",
  );
  await openNeutral(page, generations);
  await workerActive(page);
  await quiet(page);
  await page.reload();
  await page.waitForLoadState("load");
  const cdp = await context.newCDPSession(page);
  const { installabilityErrors } = await cdp.send(
    "Page.getInstallabilityErrors",
  );
  expect(installabilityErrors).toEqual([]);
  const manifest = await cdp.send("Page.getAppManifest");
  expect(manifest.errors).toEqual([]);
  expect(manifest.url).toBe(`${generations.url}/manifest.webmanifest`);
  const parsed = JSON.parse(manifest.data ?? "{}") as {
    name?: string;
    icons?: Array<{ src: string }>;
  };
  expect(parsed.name).toBe("Atlas");
  for (const icon of parsed.icons ?? []) {
    const response = await page.request.get(`${generations.url}${icon.src}`);
    expect(response.status(), icon.src).toBe(200);
  }
});
