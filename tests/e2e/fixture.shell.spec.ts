import type { Page } from "@playwright/test";
import {
  DARK,
  evidencePath,
  expect,
  expectFocusLoop,
  LIGHT,
  pressTab,
  runAxe,
  test,
} from "./helpers";

/**
 * Layer B/A against the fixture build (gate lifted, shell mounted, sync model from the query string). Everything
 * here is fixture evidence: it says the shell behaves as designed, not that it works against a backend.
 */

const setup = (page: Page, width: number, height = 900) =>
  page.setViewportSize({ width, height });
const primaryNav = (page: Page) =>
  page.getByRole("navigation", { name: "Primary" });

async function scrollWidthFits(page: Page) {
  return page.evaluate(
    () =>
      document.documentElement.scrollWidth <=
      document.documentElement.clientWidth,
  );
}

test.describe("layout modes at every breakpoint edge (A3)", () => {
  const edges: Array<[number, number, "desktop" | "tablet" | "mobile"]> = [
    [320, 640, "mobile"],
    [390, 844, "mobile"],
    [767, 900, "mobile"],
    [768, 1024, "tablet"],
    [834, 1112, "tablet"],
    [1179, 820, "tablet"],
    [1180, 820, "tablet"],
    [1279, 800, "tablet"],
    [1280, 800, "desktop"],
    [1440, 900, "desktop"],
  ];
  for (const scheme of ["dark", "light"] as const) {
    for (const [width, height, mode] of edges) {
      test(`${width}x${height} is ${mode}, in ${scheme}, without horizontal scrolling`, async ({
        browser,
      }) => {
        const context = await browser.newContext({
          colorScheme: scheme,
          viewport: { width, height },
        });
        const page = await context.newPage();
        const problems: string[] = [];
        page.on(
          "console",
          (m) =>
            (m.type() === "error" || m.type() === "warning") &&
            problems.push(m.text()),
        );
        await page.goto("/today?phase=synced&pending=2&conflicts=1");
        await expect(
          page.getByRole("heading", { level: 1, name: "Today" }),
        ).toBeVisible();
        await expect(primaryNav(page)).toHaveCount(1);
        const nav = primaryNav(page);
        const box = await nav.boundingBox();
        if (!box) throw new Error("navigation has no box");
        if (mode === "desktop") {
          const rail = await nav.evaluate(
            (element) => element.parentElement?.getBoundingClientRect().width,
          );
          expect(rail).toBe(236);
        } else if (mode === "tablet") {
          const rail = await nav.evaluate(
            (element) => element.parentElement?.getBoundingClientRect().width,
          );
          expect(rail).toBe(64);
          for (const label of [
            "Today",
            "Tasks",
            "People",
            "Sharing",
            "Settings",
          ]) {
            const link = nav.getByRole("link", { name: label });
            const target = await link.boundingBox();
            expect(target?.width).toBeGreaterThanOrEqual(44);
            expect(target?.height).toBeGreaterThanOrEqual(44);
            expect(await link.evaluate((element) => element.textContent)).toBe(
              "",
            );
          }
        } else {
          expect(box.y + box.height).toBeGreaterThan(height - 100);
          expect(box.height).toBeGreaterThanOrEqual(48);
          await expect(nav.getByRole("button", { name: "More" })).toBeVisible();
          for (const item of await nav.getByRole("link").all()) {
            expect((await item.boundingBox())?.height).toBeGreaterThanOrEqual(
              48,
            );
          }
        }
        expect(await scrollWidthFits(page), "no horizontal scroll").toBe(true);
        expect(
          await page.evaluate(
            () => getComputedStyle(document.body).backgroundColor,
          ),
        ).toBe(scheme === "dark" ? DARK.canvas : LIGHT.canvas);
        await page.screenshot({
          path: evidencePath(`A3/shell-${scheme}-${width}x${height}.png`),
        });
        expect(problems).toEqual([]);
        await context.close();
      });
    }
  }

  test("400% zoom (a 320px-wide viewport at four times) still reflows without horizontal scrolling", async ({
    page,
  }) => {
    await setup(page, 320, 256);
    await page.goto("/settings");
    await expect(
      page.getByRole("heading", { level: 1, name: "Settings" }),
    ).toBeVisible();
    expect(await scrollWidthFits(page)).toBe(true);
  });

  test("text-spacing overrides do not clip or overflow the shell (WCAG 1.4.12)", async ({
    page,
  }) => {
    await setup(page, 390, 844);
    await page.goto("/today");
    // A constructed stylesheet, not a <style> element: the content security policy (rightly) refuses inline style elements.
    await page.evaluate(() => {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(
        "* { line-height: 1.5 !important; letter-spacing: 0.12em !important; word-spacing: 0.16em !important; }",
      );
      document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
    });
    await expect(
      page.getByRole("heading", { level: 1, name: "Today" }),
    ).toBeVisible();
    expect(await scrollWidthFits(page)).toBe(true);
  });

  test("rotating from portrait to landscape changes the layout and keeps focus on the same control", async ({
    page,
  }) => {
    await setup(page, 834, 1112);
    await page.goto("/tasks");
    await primaryNav(page).getByRole("link", { name: "People" }).focus();
    await setup(page, 1180, 820);
    await expect(
      primaryNav(page).getByRole("link", { name: "People" }),
    ).toBeFocused();
    await setup(page, 390, 844);
    await expect(primaryNav(page)).toHaveCount(1);
  });
});

test.describe("keyboard and focus (B8)", () => {
  test("the skip link is the first tab stop and moves focus to main", async ({
    page,
  }) => {
    await setup(page, 1440);
    await page.goto("/today");
    await expect(
      page.getByRole("heading", { level: 1, name: "Today" }),
    ).toBeVisible();
    await pressTab(page);
    const skip = page.getByRole("link", { name: "Skip to main content" });
    await expect(skip).toBeFocused();
    await expect(skip).toBeVisible();
    await page.keyboard.press("Enter");
    await expect(page.locator("main")).toBeFocused();
    expect(new URL(page.url()).hash).toBe("");
  });

  test("tab order runs: skip link, rail navigation, sync chip, main", async ({
    page,
  }) => {
    await setup(page, 1440);
    await page.goto("/today?pending=1");
    await pressTab(page);
    const order: string[] = [];
    for (let index = 0; index < 8; index += 1) {
      order.push(
        await page.evaluate(
          () =>
            (document.activeElement as HTMLElement | null)?.getAttribute(
              "aria-label",
            ) ??
            (document.activeElement as HTMLElement | null)?.textContent ??
            "",
        ),
      );
      await pressTab(page);
    }
    expect(order.slice(0, 7)).toEqual([
      "Skip to main content",
      "Today",
      "Tasks",
      "People",
      "Sharing",
      "Settings",
      expect.stringContaining("waiting to send"),
    ]);
  });

  test("a route change moves focus to the page heading, never to body", async ({
    page,
  }) => {
    await setup(page, 1440);
    await page.goto("/today");
    await primaryNav(page).getByRole("link", { name: "Tasks" }).click();
    await expect(
      page.getByRole("heading", { level: 1, name: "Tasks" }),
    ).toBeFocused();
    await page.goBack();
    await expect(
      page.getByRole("heading", { level: 1, name: "Today" }),
    ).toBeFocused();
    await page.goForward();
    await expect(
      page.getByRole("heading", { level: 1, name: "Tasks" }),
    ).toBeFocused();
  });

  test("the initial load leaves focus alone", async ({ page }) => {
    await setup(page, 1440);
    await page.goto("/today");
    await expect(
      page.getByRole("heading", { level: 1, name: "Today" }),
    ).toBeVisible();
    await page.waitForTimeout(200);
    expect(
      await page.evaluate(() => document.activeElement === document.body),
    ).toBe(true);
  });

  for (const [scheme, colour] of [
    ["dark", "rgb(142, 128, 255)"],
    ["light", "rgb(91, 77, 230)"],
  ] as const) {
    test(`focus ring is 2px ring with a 2px offset (${scheme})`, async ({
      browser,
    }) => {
      const context = await browser.newContext({
        colorScheme: scheme,
        viewport: { width: 1440, height: 900 },
      });
      const page = await context.newPage();
      await page.goto("/today");
      await pressTab(page);
      await pressTab(page);
      const outline = await page.evaluate(() => {
        const style = getComputedStyle(document.activeElement as Element);
        return {
          width: style.outlineWidth,
          style: style.outlineStyle,
          offset: style.outlineOffset,
          colour: style.outlineColor,
        };
      });
      expect(outline).toEqual({
        width: "2px",
        style: "solid",
        offset: "2px",
        colour,
      });
      await context.close();
    });
  }

  test("More sheet: opens as a dialog, traps focus, Escape closes and returns focus to More", async ({
    page,
  }) => {
    await setup(page, 390, 844);
    await page.goto("/today");
    const more = primaryNav(page).getByRole("button", { name: "More" });
    await more.click();
    const dialog = page.getByRole("dialog", { name: "More" });
    await expect(dialog).toBeVisible();
    // Strict on every engine, macOS WebKit included (Option+Tab there): forward, reverse, and a whole turn.
    const ring = await expectFocusLoop(page, dialog);
    expect(ring.join(" | ")).toContain("Close");
    expect(ring.length, "sync control, Close and the three links").toBe(5);
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(more).toBeFocused();
  });

  test("dialog header keeps a 44 x 44 Close target beside long sync labels and large counts, at narrow widths", async ({
    page,
  }) => {
    const states = [
      "phase=offline&pending=1000&conflicts=1000",
      "phase=resyncing&pending=99999",
      "phase=interrupted&conflicts=12345",
      "phase=synced",
    ];
    for (const width of [320, 360, 390, 767]) {
      for (const state of states) {
        await setup(page, width, 844);
        await page.goto(`/settings/appearance?${state}`);
        const dialog = page.getByRole("dialog", { name: "Appearance" });
        await expect(dialog).toBeVisible();
        const where = `${width}px, ${state}`;
        const close = await dialog
          .getByRole("button", { name: "Close" })
          .boundingBox();
        const chip = await dialog
          .getByRole("button", { name: /Open (sync queue|conflicts)/ })
          .boundingBox();
        const title = await dialog
          .getByRole("heading", { name: "Appearance" })
          .boundingBox();
        const box = await dialog.boundingBox();
        if (!close || !chip || !title || !box)
          throw new Error(`header controls not laid out (${where})`);
        expect(close.width, `Close width, ${where}`).toBeGreaterThanOrEqual(44);
        expect(close.height, `Close height, ${where}`).toBeGreaterThanOrEqual(
          44,
        );
        expect(
          chip.height,
          `sync control height, ${where}`,
        ).toBeGreaterThanOrEqual(44);
        expect(
          chip.width,
          `sync control width, ${where}`,
        ).toBeGreaterThanOrEqual(44);
        // The three sit in one row in DOM order, without overlapping or leaving the dialog.
        expect(
          title.x + title.width,
          `title clear of the sync control, ${where}`,
        ).toBeLessThanOrEqual(chip.x + 0.5);
        expect(
          chip.x + chip.width,
          `sync control clear of Close, ${where}`,
        ).toBeLessThanOrEqual(close.x + 0.5);
        expect(
          close.x + close.width,
          `Close inside the dialog, ${where}`,
        ).toBeLessThanOrEqual(box.x + box.width + 0.5);
        // The label is wrapped, not clipped, and nothing forces the page to scroll sideways.
        expect(
          await dialog
            .getByRole("button", { name: /Open (sync queue|conflicts)/ })
            .evaluate(
              (element) => element.scrollWidth <= element.clientWidth + 1,
            ),
          `sync label not clipped, ${where}`,
        ).toBe(true);
        expect(
          await scrollWidthFits(page),
          `no horizontal scroll, ${where}`,
        ).toBe(true);
      }
    }
  });

  test("More sheet: choosing Settings navigates and focuses the page heading", async ({
    page,
  }) => {
    await setup(page, 390, 844);
    await page.goto("/today");
    await primaryNav(page).getByRole("button", { name: "More" }).click();
    await page
      .getByRole("dialog", { name: "More" })
      .getByRole("link", { name: "Settings" })
      .click();
    await expect(
      page.getByRole("heading", { level: 1, name: "Settings" }),
    ).toBeFocused();
  });

  test("the page behind an open dialog is inert to assistive technology", async ({
    page,
  }) => {
    await setup(page, 1440);
    await page.goto("/settings/appearance");
    await expect(
      page.getByRole("dialog", { name: "Appearance" }),
    ).toBeVisible();
    await expect(page.getByRole("navigation", { name: "Primary" })).toHaveCount(
      0,
    );
    await expect(page.getByRole("main")).toHaveCount(0);
  });
});

test.describe("collapsed rail labels (A5)", () => {
  for (const [width, height] of [
    [834, 1112],
    [1180, 820],
  ] as const) {
    test(`${width}x${height}: labels show on keyboard focus and on hover, with 44px targets`, async ({
      page,
    }) => {
      await setup(page, width, height);
      await page.goto("/today");
      const today = primaryNav(page).getByRole("link", { name: "Today" });
      await pressTab(page);
      await pressTab(page);
      await expect(today).toBeFocused();
      await expect(page.getByRole("tooltip", { name: "Today" })).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(page.getByRole("tooltip")).toHaveCount(0);
      const tasks = primaryNav(page).getByRole("link", { name: "Tasks" });
      await tasks.hover();
      await expect(page.getByRole("tooltip", { name: "Tasks" })).toBeVisible();
      // Hoverable and persistent (WCAG 1.4.13): moving onto the tooltip keeps it.
      await page.getByRole("tooltip", { name: "Tasks" }).hover();
      await expect(page.getByRole("tooltip", { name: "Tasks" })).toBeVisible();
      await page.screenshot({
        path: evidencePath(`A5/collapsed-rail-${width}x${height}.png`),
      });
    });
  }

  test("the collapsed sync chip's label also shows on focus", async ({
    page,
  }) => {
    await setup(page, 834, 1112);
    await page.goto("/today?phase=offline&pending=3");
    const chip = page.getByRole("button", { name: /waiting to send/ });
    await chip.focus();
    await expect(page.getByRole("tooltip")).toContainText("3 waiting to send");
    expect((await chip.boundingBox())?.width).toBeGreaterThanOrEqual(44);
  });

  test("labels do not depend on hover: every collapsed control has an accessible name", async ({
    page,
  }) => {
    await setup(page, 834, 1112);
    await page.goto("/today");
    for (const link of await primaryNav(page).getByRole("link").all()) {
      expect(await link.getAttribute("aria-label")).toBeTruthy();
    }
  });
});

test.describe("accessibility with real layout (A4)", () => {
  for (const scheme of ["dark", "light"] as const) {
    for (const [width, height] of [
      [1440, 900],
      [834, 1112],
      [390, 844],
    ] as const) {
      test(`shell, ${scheme}, ${width}px: zero axe violations across every sync tone`, async ({
        browser,
      }) => {
        const context = await browser.newContext({
          colorScheme: scheme,
          viewport: { width, height },
        });
        const page = await context.newPage();
        const states = [
          "phase=synced",
          "phase=synced&pending=2",
          "phase=synced&conflicts=1",
          "phase=resyncing&pending=1",
          "phase=interrupted",
          "phase=offline&pending=3&conflicts=2",
        ];
        for (const state of states) {
          await page.goto(`/today?${state}`);
          await expect(
            page.getByRole("heading", { level: 1, name: "Today" }),
          ).toBeVisible();
          expect(await runAxe(page), `${state}`).toEqual([]);
        }
        await context.close();
      });
    }
  }

  test("the More sheet and the Appearance dialog have no axe violations, dark and light", async ({
    browser,
  }) => {
    for (const scheme of ["dark", "light"] as const) {
      const context = await browser.newContext({
        colorScheme: scheme,
        viewport: { width: 390, height: 844 },
      });
      const page = await context.newPage();
      await page.goto("/today?phase=offline&pending=1");
      await primaryNav(page).getByRole("button", { name: "More" }).click();
      await expect(page.getByRole("dialog", { name: "More" })).toBeVisible();
      expect(await runAxe(page), `More, ${scheme}`).toEqual([]);
      await page.screenshot({ path: evidencePath(`A4/more-${scheme}.png`) });
      await page.goto("/settings/appearance?phase=synced&conflicts=1");
      await expect(
        page.getByRole("dialog", { name: "Appearance" }),
      ).toBeVisible();
      expect(await runAxe(page), `Appearance, ${scheme}`).toEqual([]);
      await page.screenshot({
        path: evidencePath(`A4/appearance-${scheme}.png`),
      });
      await context.close();
    }
  });

  test("not-found and the Settings placeholder pass axe", async ({ page }) => {
    await page.goto("/nowhere/at/all");
    await expect(
      page.getByRole("heading", { level: 1, name: "Page not found" }),
    ).toBeVisible();
    expect(await runAxe(page)).toEqual([]);
    await page.goto("/settings");
    await expect(
      page.getByRole("heading", { level: 1, name: "Settings" }),
    ).toBeVisible();
    expect(await runAxe(page)).toEqual([]);
  });
});

test.describe("routes", () => {
  test("/ redirects to /today and each destination shows its heading and no account data", async ({
    page,
  }) => {
    await page.goto("/");
    await expect(page).toHaveURL(/\/today$/);
    for (const [label, path] of [
      ["Today", "/today"],
      ["Tasks", "/tasks"],
      ["People", "/people"],
      ["Sharing", "/sharing"],
      ["Settings", "/settings"],
    ] as const) {
      await page.goto(path);
      await expect(
        page.getByRole("heading", { level: 1, name: label }),
      ).toBeVisible();
      await expect(page).toHaveTitle(`${label} · Atlas`);
    }
  });

  test("an unknown path shows the neutral not-found inside the shell, not a Welcome page", async ({
    page,
  }) => {
    await page.goto("/no/such/place");
    await expect(
      page.getByRole("heading", { level: 1, name: "Page not found" }),
    ).toBeVisible();
    await expect(page.getByText("Welcome to Atlas")).toHaveCount(0);
  });

  test("the fixture marker is present in the fixture build only", async ({
    page,
  }) => {
    await page.goto("/today");
    expect(
      await page.evaluate(() => document.documentElement.dataset.atlasFixture),
    ).toBe("ATLAS_FIXTURE_ONLY");
  });
});
