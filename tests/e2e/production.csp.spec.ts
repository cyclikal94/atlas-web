import { enforceContainerPolicy, violations } from "./csp";
import { expect, test } from "./helpers";

test.describe("content security policy (B10, production build)", () => {
  test("the neutral app raises zero violations, and the compatibility screen too", async ({
    page,
  }) => {
    await enforceContainerPolicy(page);
    await page.goto("/");
    await expect(
      page.getByRole("heading", { level: 1, name: "Atlas" }),
    ).toBeVisible();
    expect(await violations(page)).toEqual([]);
    await page.addInitScript(() =>
      Object.defineProperty(navigator, "locks", {
        value: undefined,
        configurable: true,
      }),
    );
    await page.goto("/");
    await expect(
      page.getByRole("heading", {
        level: 1,
        name: "Atlas can't open in this browser",
      }),
    ).toBeVisible();
    expect(await violations(page)).toEqual([]);
  });
});
