import { expect, test } from "@playwright/test";

test("neutral shell preserves the protected root and loads a cached deep link offline", async ({
  page,
  context,
}) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Atlas" })).toBeVisible();
  await expect(page.locator("#protected-root")).toHaveAttribute("inert", "");
  await expect(page.locator("#protected-root")).toHaveAttribute(
    "aria-hidden",
    "true",
  );
  // Explicit test-only registration. WEB-14a owns production registration/update UX.
  await page.evaluate(async () => {
    await navigator.serviceWorker.register("/sw.js");
    await navigator.serviceWorker.ready;
  });
  await page.reload();
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
  await context.setOffline(true);
  await page.goto("/tasks/example");
  await expect(page.getByRole("heading", { name: "Atlas" })).toBeVisible();
  await expect(page.locator("#protected-root")).toHaveAttribute("inert", "");
  for (const path of [
    "/health?probe=1",
    "/ready?probe=1",
    "/auth?return_to=x",
  ]) {
    const response = await page.goto(path).catch(() => null);
    expect(response).toBeNull();
  }
});
