import { containerHeaders, enforceContainerPolicy, violations } from "./csp";
import { expect, test } from "./helpers";

/**
 * B10 (browser layer): the shell, its dialogs and its tooltips under the strict policy the container sends. Any
 * violation is also a console error, which the console guard in helpers.ts turns into a failure.
 */
test.describe("content security policy (B10, fixture)", () => {
  test("the policy is strict: no unsafe-inline, no unsafe-eval, no external source", () => {
    const policy = containerHeaders()["content-security-policy"] ?? "";
    expect(policy).toContain("default-src 'none'");
    expect(policy).toContain("style-src 'self'");
    expect(policy).toContain("script-src 'self'");
    expect(policy).not.toMatch(/unsafe-inline|unsafe-eval|https?:|\*/);
    expect(containerHeaders()["x-content-type-options"]).toBe("nosniff");
    expect(containerHeaders()["referrer-policy"]).toBe("no-referrer");
  });

  test("navigation, the Appearance dialog, tooltips and the More sheet raise zero violations", async ({
    page,
  }) => {
    await enforceContainerPolicy(page);
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto("/settings?pending=2&conflicts=1");
    await expect(
      page.getByRole("heading", { level: 1, name: "Settings" }),
    ).toBeVisible();
    await page.getByRole("link", { name: "Appearance" }).click();
    await expect(
      page.getByRole("dialog", { name: "Appearance" }),
    ).toBeVisible();
    await page.getByRole("radio", { name: "Light" }).click();
    await page.getByRole("radio", { name: "Dark" }).click();
    await page.getByRole("radio", { name: "Match system" }).click();
    await page.keyboard.press("Escape");
    await page.setViewportSize({ width: 834, height: 1000 });
    await page.getByRole("link", { name: "Tasks" }).hover();
    await expect(page.getByRole("tooltip")).toBeVisible();
    await page.getByRole("link", { name: "People" }).focus();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole("button", { name: "More" }).click();
    await expect(page.getByRole("dialog", { name: "More" })).toBeVisible();
    await page.keyboard.press("Escape");
    await page.evaluate(() =>
      (
        window as unknown as { __atlasFixture: { setSync(m: unknown): void } }
      ).__atlasFixture.setSync({
        phase: "offline",
        pendingCount: 3,
        conflictCount: 1,
      }),
    );
    await page.waitForTimeout(400);
    expect(await violations(page)).toEqual([]);
  });

  test("dialogs do not add a style element, and scroll is locked with attributes and CSSOM only", async ({
    page,
  }) => {
    await enforceContainerPolicy(page);
    await page.goto("/settings");
    const before = await page.locator("style").count();
    await page.getByRole("link", { name: "Appearance" }).click();
    await expect(
      page.getByRole("dialog", { name: "Appearance" }),
    ).toBeVisible();
    expect(await page.locator("style").count()).toBe(before);
    expect(await page.evaluate(() => document.body.style.overflow)).toBe(
      "hidden",
    );
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    expect(await page.evaluate(() => document.body.style.overflow)).toBe("");
  });

  test("the controls gallery raises zero violations", async ({ page }) => {
    await enforceContainerPolicy(page);
    await page.goto("/__controls");
    await expect(
      page.getByRole("heading", { level: 1, name: "Controls" }),
    ).toBeVisible();
    await page.getByRole("radio", { name: "Second" }).click();
    expect(await violations(page)).toEqual([]);
  });
});
