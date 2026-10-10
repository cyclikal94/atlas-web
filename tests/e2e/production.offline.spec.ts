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
test.use({ firstGeneration: "production-a" });

test("a cached deep link opens offline, and backend paths never receive the shell", async ({
  page,
  context,
  generations,
  browserName,
}) => {
  await navigate(page, `${generations.url}/`);
  await expect(
    page.getByRole("heading", { level: 1, name: "Atlas" }),
  ).toBeVisible();
  await expect(page.locator("#protected-root")).toHaveAttribute("inert", "");
  // The app registered the worker; the next load is controlled by it.
  await workerActive(page);
  await quiet(page);
  await page.reload();
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
  await quiet(page);
  await goOffline(context, generations, browserName);
  await page.goto(`${generations.url}/tasks/example`);
  await expect(
    page.getByRole("heading", { level: 1, name: "Atlas" }),
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
