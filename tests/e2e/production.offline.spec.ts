import { test as declared } from "./auth-helpers";
import { expect, test } from "./helpers";

/**
 * Layer B. The service worker is registered here by the test only: registration and update UX belong to WEB-14a.
 * This proves the precached app shell serves a deep link offline and that backend paths never receive it (Q10).
 */
test("a cached deep link opens offline, and backend paths never receive the shell", async ({
  page,
  context,
  browserName,
}) => {
  // Playwright's WebKit blocks a service-worker-served navigation under setOffline ("WebKit encountered an internal
  // error"), so this is not verified in WebKit here. Real Safari offline behaviour is release evidence (WEB-14a, WEB-15).
  test.skip(
    browserName === "webkit",
    "Playwright WebKit cannot emulate offline for service-worker navigations",
  );
  await page.goto("/");
  await expect(
    page.getByRole("heading", { level: 1, name: "Sign in to Atlas" }),
  ).toBeVisible();
  await expect(page.locator("#protected-root")).toHaveAttribute("inert", "");
  await page.evaluate(async () => {
    await navigator.serviceWorker.register("/sw.js");
    await navigator.serviceWorker.ready;
  });
  await page.reload();
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
  await context.setOffline(true);
  await page.goto("/tasks/example");
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
  for (const path of [
    "/health?probe=1",
    "/ready?probe=1",
    "/auth?return_to=x",
    "/api/experimental/v1/tasks",
    "/oidc/callback",
  ]) {
    const response = await page.goto(path).catch(() => null);
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
    await page.evaluate(async () => {
      await navigator.serviceWorker.register("/sw.js");
      await navigator.serviceWorker.ready;
    });
    await page.reload();
    await page.waitForFunction(
      () => navigator.serviceWorker.controller !== null,
    );
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
