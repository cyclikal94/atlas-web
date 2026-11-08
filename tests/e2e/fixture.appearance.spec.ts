import { DARK, expect, LIGHT, runAxe, test } from "./helpers";

const KEY = "atlas.appearance.v1";

test.describe("WF-SETTINGS-05 Appearance (B15, fixture)", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test("Match system is selected by default, and a light device shows the light theme", async ({
    browser,
  }) => {
    const context = await browser.newContext({
      colorScheme: "light",
      viewport: { width: 1280, height: 800 },
    });
    const page = await context.newPage();
    await page.goto("/settings/appearance");
    await expect(
      page.getByRole("radio", { name: "Match system" }),
    ).toBeChecked();
    await expect(page.locator("html")).not.toHaveAttribute("data-theme", /.+/);
    expect(
      await page.evaluate(
        () => getComputedStyle(document.body).backgroundColor,
      ),
    ).toBe(LIGHT.canvas);
    await context.close();
  });

  test("focus starts on the selected choice", async ({ page }) => {
    await page.goto("/settings/appearance");
    await expect(
      page.getByRole("radio", { name: "Match system" }),
    ).toBeFocused();
  });

  test("Light and Dark override the device, apply immediately and survive a reload", async ({
    browser,
  }) => {
    const context = await browser.newContext({
      colorScheme: "dark",
      viewport: { width: 1280, height: 800 },
    });
    const page = await context.newPage();
    await page.goto("/settings/appearance");
    expect(
      await page.evaluate(
        () => getComputedStyle(document.body).backgroundColor,
      ),
    ).toBe(DARK.canvas);
    await page.getByRole("radio", { name: "Light" }).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    expect(
      await page.evaluate(
        () => getComputedStyle(document.body).backgroundColor,
      ),
    ).toBe(LIGHT.canvas);
    expect(await page.evaluate((key) => localStorage.getItem(key), KEY)).toBe(
      "light",
    );
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    await expect(page.getByRole("radio", { name: "Light" })).toBeChecked();
    await page.getByRole("radio", { name: "Match system" }).click();
    await expect(page.locator("html")).not.toHaveAttribute("data-theme", /.+/);
    expect(
      await page.evaluate((key) => localStorage.getItem(key), KEY),
    ).toBeNull();
    expect(
      await page.evaluate(
        () => getComputedStyle(document.body).backgroundColor,
      ),
    ).toBe(DARK.canvas);
    await context.close();
  });

  test("Auto follows the device while the page is open", async ({ page }) => {
    await page.emulateMedia({ colorScheme: "dark" });
    await page.goto("/settings");
    expect(
      await page.evaluate(
        () => getComputedStyle(document.body).backgroundColor,
      ),
    ).toBe(DARK.canvas);
    await page.emulateMedia({ colorScheme: "light" });
    await expect
      .poll(() =>
        page.evaluate(() => getComputedStyle(document.body).backgroundColor),
      )
      .toBe(LIGHT.canvas);
    await expect
      .poll(() =>
        page.evaluate(() =>
          document
            .querySelector('meta[name="theme-color"]')
            ?.getAttribute("content"),
        ),
      )
      .toBe("#F7F7FA");
  });

  test("a choice made in one tab reaches another tab, and is device-local (not sent to any server)", async ({
    context,
  }) => {
    const requests: string[] = [];
    const first = await context.newPage();
    const second = await context.newPage();
    for (const page of [first, second])
      page.on("request", (request) => {
        if (
          request.method() !== "GET" ||
          /\/(api|health|ready|auth|oidc)(\/|$|\?)/.test(
            new URL(request.url()).pathname,
          )
        ) {
          requests.push(`${request.method()} ${request.url()}`);
        }
      });
    await first.goto("/settings/appearance");
    await second.goto("/settings");
    await first.getByRole("radio", { name: "Dark" }).click();
    await expect(second.locator("html")).toHaveAttribute("data-theme", "dark");
    // Nothing was written or sent: no non-GET request and no request to a backend path.
    expect(requests).toEqual([]);
  });

  test("when storage is blocked the choice still applies and the dialog says it will not last", async ({
    page,
  }) => {
    await page.addInitScript(() => {
      Storage.prototype.setItem = () => {
        throw new DOMException("blocked", "SecurityError");
      };
    });
    await page.goto("/settings/appearance");
    await page.getByRole("radio", { name: "Light" }).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    await expect(
      page.getByText(
        "This browser can't save your choice, so it will reset when you reload.",
      ),
    ).toBeVisible();
    await page.reload();
    await expect(page.locator("html")).not.toHaveAttribute("data-theme", /.+/);
  });

  test("a corrupt stored value is treated as Match system", async ({
    page,
  }) => {
    await page.addInitScript((key) => localStorage.setItem(key, "{oops"), KEY);
    await page.goto("/settings/appearance");
    await expect(
      page.getByRole("radio", { name: "Match system" }),
    ).toBeChecked();
  });

  test("radio keyboard: arrows move and select (a real key is held for a moment), one tab stop", async ({
    page,
  }) => {
    await page.goto("/settings/appearance");
    const dark = page.getByRole("radio", { name: "Dark" });
    const light = page.getByRole("radio", { name: "Light" });
    const auto = page.getByRole("radio", { name: "Match system" });
    await expect(auto).toBeFocused();
    await page.keyboard.press("ArrowLeft", { delay: 60 });
    await expect(light).toBeFocused();
    await expect(light).toBeChecked();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    await page.keyboard.press("ArrowLeft", { delay: 60 });
    await expect(dark).toBeChecked();
    await page.keyboard.press("ArrowRight", { delay: 60 });
    await page.keyboard.press("ArrowRight", { delay: 60 });
    await expect(auto).toBeChecked();
    await expect(page.locator("html")).not.toHaveAttribute("data-theme", /.+/);
  });

  test("the accepted copy is present and the designer's annotation is not", async ({
    page,
  }) => {
    await page.goto("/settings/appearance");
    await expect(
      page.getByText(
        "Saved for this browser only, so a shared computer doesn't inherit your choice.",
      ),
    ).toBeVisible();
    await expect(page.getByText(/dark mode is deferred/)).toHaveCount(0);
  });

  test("a page of its own: the Settings link leads back and the home's heading takes the focus", async ({
    page,
  }) => {
    // Appearance is a page like every other Settings section (8 November 2026), not a dialog over the home.
    await page.goto("/settings/appearance");
    await expect(
      page.getByRole("heading", { level: 1, name: "Appearance" }),
    ).toBeVisible();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await page
      .getByRole("main")
      .getByRole("link", { name: "Settings" })
      .click();
    await expect(page).toHaveURL(/\/settings$/);
    await expect(
      page.getByRole("heading", { level: 1, name: "Settings" }),
    ).toBeFocused();
  });

  test("opened from the Settings link, the selected choice takes the focus; Tab leaves the page's controls in order", async ({
    page,
  }) => {
    await page.goto("/settings");
    await page.getByRole("link", { name: "Appearance" }).click();
    await expect(
      page.getByRole("heading", { level: 1, name: "Appearance" }),
    ).toBeVisible();
    await expect(
      page.getByRole("radio", { name: "Match system" }),
    ).toBeFocused();
    // The radio group is one tab stop; Shift+Tab reaches the way back.
    await page.keyboard.press("Shift+Tab");
    await expect(
      page.getByRole("main").getByRole("link", { name: "Settings" }),
    ).toBeFocused();
  });

  test("choosing a theme is not colour alone: a ring and a dot mark the selection", async ({
    page,
  }) => {
    await page.goto("/settings/appearance");
    const dot = page
      .getByRole("radio", { name: "Match system" })
      .locator('[data-state="checked"]');
    await expect(dot).toBeVisible();
    expect((await dot.boundingBox())?.width).toBeGreaterThan(4);
  });

  for (const scheme of ["dark", "light"] as const) {
    test(`no axe violations in the dialog with each choice (${scheme})`, async ({
      browser,
    }) => {
      const context = await browser.newContext({
        colorScheme: scheme,
        viewport: { width: 1280, height: 800 },
      });
      const page = await context.newPage();
      // Colour transitions (140 ms) are removed so axe measures settled colours, not a frame mid-fade.
      await page.emulateMedia({ colorScheme: scheme, reducedMotion: "reduce" });
      await page.goto("/settings/appearance");
      for (const name of ["Dark", "Light", "Match system"]) {
        await page.getByRole("radio", { name }).click();
        expect(await runAxe(page), `${name} on a ${scheme} device`).toEqual([]);
      }
      await context.close();
    });
  }
});

test.describe("fonts in the shell (B9, fixture)", () => {
  test("Geist and Geist Mono both load from the origin with every other request blocked", async ({
    browser,
    baseURL,
  }) => {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
    });
    const page = await context.newPage();
    const blocked: string[] = [];
    await page.route("**/*", (route) => {
      if (
        new URL(route.request().url()).origin ===
        new URL(baseURL as string).origin
      )
        return route.continue();
      blocked.push(route.request().url());
      return route.abort();
    });
    await page.goto("/today?pending=2&synced=2026-09-28T11:58:00Z");
    await expect(
      page.getByRole("heading", { level: 1, name: "Today" }),
    ).toBeVisible();
    const result = await page.evaluate(async () => {
      await document.fonts.ready;
      const sans = await document.fonts.load(
        '600 26px "Geist Variable"',
        "Today 0123",
      );
      const mono = await document.fonts.load(
        '400 11px "Geist Mono Variable"',
        "2 waiting 0123",
      );
      const monoUsed = getComputedStyle(
        document.querySelector(".font-num") as Element,
      ).fontFamily;
      return {
        sans: sans.map((face) => face.status),
        mono: mono.map((face) => face.status),
        monoUsed,
        numeric: getComputedStyle(
          document.querySelector(".font-num") as Element,
        ).fontVariantNumeric,
      };
    });
    expect(blocked).toEqual([]);
    expect(result.sans.length).toBeGreaterThan(0);
    expect(result.sans.every((status) => status === "loaded")).toBe(true);
    expect(result.mono.length).toBeGreaterThan(0);
    expect(result.mono.every((status) => status === "loaded")).toBe(true);
    expect(result.monoUsed).toContain("Geist Mono Variable");
    expect(result.numeric).toContain("tabular-nums");
    await context.close();
  });
});
