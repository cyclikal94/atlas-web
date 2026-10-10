import { enforceContainerPolicy, violations } from "./csp";
import { expect, test } from "./helpers";

test.describe("content security policy (B10, production build)", () => {
  test("the neutral app raises zero violations, and the compatibility screen too", async ({
    page,
  }) => {
    await enforceContainerPolicy(page);
    // REVISION 13: the neutral app's compatibility check (`GET /health`) is issued a few milliseconds AFTER the heading is visible (about
    // 60 ms and 48 ms after the navigation, in the accepted base and in the candidate alike). The second navigation below used to come at
    // once, while that request was still in flight, and WebKit reports a fetch that a navigation cancels as a page error ("Fetch API
    // cannot load .../health due to access control checks"): a race in this spec between its own two navigations, lost about 2.5 % of the
    // time by the candidate (a few milliseconds slower to boot than the base, which lost it 0 times in 360) and by nothing in the page.
    // The first page's check now finishes first. No assertion of the spec is changed.
    const compatibilityChecked = page.waitForResponse(
      (response) => new URL(response.url()).pathname === "/health",
    );
    await page.goto("/");
    await expect(
      page.getByRole("heading", { level: 1, name: "Atlas" }),
    ).toBeVisible();
    await compatibilityChecked;
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
