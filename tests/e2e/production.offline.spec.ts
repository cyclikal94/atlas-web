import type { Page } from "@playwright/test";
import { test as declared } from "./auth-helpers";
import {
  exempt,
  expect,
  goOffline,
  navigate,
  quiet,
  test,
  workerActive,
} from "./pwa-world";

/**
 * Layer B. The precached app shell serves a deep link offline and backend paths never receive it (Q10), with the worker the PRODUCTION
 * app registers itself (WEB-14a; before WEB-14a this spec registered the worker from the test).
 *
 * ADAPTATION (WEB-14a, A-2, for the reviewer): the original ran against the `vite preview` of `dist` on the production project's port,
 * registered `/sw.js` from the test, and skipped WebKit ("Playwright WebKit cannot emulate offline for service-worker navigations"). It now
 * runs against a byte copy of `dist` (`dist-pwa/production-a`) on the generation server (the reference nginx configuration's semantics and
 * the production headers), relies on the app's own registration, and runs in WebKit too, by the method qualification probe Q-P0 found to
 * work there (the server goes dark and the page is told it is offline; `goOffline`). The backend paths are navigated in a separate probe
 * page of the same origin (WebKit logs each failed offline navigation, which is the browser's message, not the app's). Every original
 * assertion is kept.
 */
async function rootReady(page: Page) {
  await expect(
    page.getByRole("heading", { level: 1, name: "Sign in to Atlas" }),
  ).toBeVisible();
  await expect(page.locator("#protected-root")).toHaveAttribute("inert", "");
}

test.use({ firstGeneration: "production-a" });

test("a cached deep link opens offline, and backend paths never receive the shell", async ({
  page,
  context,
  generations,
  browserName,
}) => {
  await navigate(page, `${generations.url}/`);
  await expect(
    page.getByRole("heading", { level: 1, name: "Sign in to Atlas" }),
  ).toBeVisible();
  await expect(page.locator("#protected-root")).toHaveAttribute("inert", "");
  // The app registered the worker; the next load is controlled by it.
  await workerActive(page);
  await quiet(page);
  await page.reload();
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
  await rootReady(page);
  await quiet(page);
  await goOffline(context, generations, browserName);
  await page.goto(`${generations.url}/tasks/example`);
  await expect(
    page.getByRole("heading", { level: 1, name: "Sign in to Atlas" }),
  ).toBeVisible();
  await expect(page.locator("#protected-root")).toHaveAttribute("inert", "");
  await expect(page.locator("#protected-root")).toHaveAttribute(
    "aria-hidden",
    "true",
  );
  // The offline page is the same neutral shell, styled and with its fonts.
  expect(
    await page.evaluate(() => getComputedStyle(document.body).backgroundColor),
  ).toMatch(/^rgb\(/);
  // The backend paths are navigated in a probe page of the same origin and worker: a navigation that fails offline is logged by WebKit as
  // a failed resource, which is the browser's message about the probe, not the app's (`exempt`).
  const probe = await context.newPage();
  exempt(probe);
  for (const path of [
    "/health?probe=1",
    "/ready?probe=1",
    "/auth?return_to=x",
    "/api/experimental/v1/tasks",
    "/oidc/callback",
  ]) {
    const response = await probe
      .goto(`${generations.url}${path}`)
      .catch(() => null);
    expect(
      response,
      `${path} must not be answered with the offline shell`,
    ).toBeNull();
  }
});

/**
 * E-25 (WEB-08b): the invitation link opens offline. The service worker serves the shell for `/join` (it is not a backend path), the
 * fragment is stripped as ever, and the page says it could not load the invitation instead of showing a form it cannot submit. The
 * token stays in page memory, so "Try again" works when the connection returns.
 */
declared(
  "an invitation link opens offline: the shell loads, the token leaves the address, and the page says it could not open the invitation",
  async ({ page, context, browserName, provokes }) => {
    // The browser logs the one request that cannot succeed offline (the preview) as a console error; this test declares it.
    provokes("abort");
    declared.skip(
      browserName === "webkit",
      "Playwright WebKit cannot emulate offline for service-worker navigations",
    );
    await page.goto("/");
    await rootReady(page);
    await page.evaluate(async () => {
      await navigator.serviceWorker.register("/sw.js");
      await navigator.serviceWorker.ready;
    });
    await page.reload();
    await page.waitForFunction(
      () => navigator.serviceWorker.controller !== null,
    );
    // WEB-14a revision 2 (readiness, labelled): the reloaded page still loads its lazy chunks (the update banner and the form registry)
    // after "load"; going offline and navigating away while one is in flight aborts it, and Firefox logs that abort as "A ServiceWorker
    // intercepted the request and encountered an unexpected error" (driver attempt 6, run 2026-10-10T22-59-09.801Z-ac97c236: the old
    // page's request was the one aborted; the new page loaded the same chunk from the worker). The page settles first; nothing is relaxed.
    await rootReady(page);
    await page.waitForLoadState("networkidle");
    await context.setOffline(true);
    const token = "d".repeat(64);
    await page.goto(`/join#t=${token}`);
    await expect(
      page.getByRole("heading", {
        level: 1,
        name: "We couldn't open this invitation",
      }),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();
    expect(page.url()).not.toContain(token);
    await expect(page.locator("#protected-root")).toHaveAttribute("inert", "");
  },
);
