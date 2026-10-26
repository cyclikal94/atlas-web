import { contrastRatio } from "../../src/design/contrast";
import { tokens } from "../../src/design/tokens";
import {
  evidencePath,
  expect,
  fixturePageReady,
  runAxe,
  test,
} from "./helpers";

/**
 * Q17 (input-border sweep), in a real browser: the shared controls are measured with the colours actually painted,
 * in both themes, and in forced-colours mode. The gallery is a fixture page; it is never packaged.
 */
const hex = (rgb: string): string => {
  const [r, g, b] = (rgb.match(/\d+/g) ?? []).slice(0, 3).map(Number) as [
    number,
    number,
    number,
  ];
  return `#${[r, g, b].map((n) => n.toString(16).padStart(2, "0")).join("")}`.toUpperCase();
};

for (const scheme of ["dark", "light"] as const) {
  test.describe(`controls (${scheme})`, () => {
    test.use({ colorScheme: scheme, viewport: { width: 900, height: 1400 } });

    test("an empty input's border is the input edge and reaches 3:1 against the surface it sits on (Q17)", async ({
      page,
    }) => {
      await page.goto("/__controls");
      await fixturePageReady(page);
      await expect(
        page.getByRole("heading", { level: 1, name: "Controls" }),
      ).toBeVisible();
      for (const testId of ["input-canvas", "input-panel"]) {
        const painted = await page.getByTestId(testId).evaluate((element) => {
          const style = getComputedStyle(element);
          const parent = getComputedStyle(
            element.closest("section") as Element,
          );
          return {
            border: style.borderTopColor,
            width: style.borderTopWidth,
            fill: style.backgroundColor,
            surround: parent.backgroundColor,
          };
        });
        expect(painted.width).toBe("1px");
        expect(hex(painted.border)).toBe(tokens[scheme].input);
        // The visible boundary is between the border and what surrounds the input, and between the border and the fill.
        expect(
          contrastRatio(hex(painted.border), hex(painted.surround)),
        ).toBeGreaterThanOrEqual(3);
        expect(
          contrastRatio(hex(painted.border), hex(painted.fill)),
        ).toBeGreaterThanOrEqual(3);
        expect(hex(painted.border)).not.toBe(tokens[scheme].border);
      }
    });

    test("the input's fill is background or card, never muted or secondary (finding F1)", async ({
      page,
    }) => {
      await page.goto("/__controls");
      await fixturePageReady(page);
      const fills = await page
        .locator("input")
        .evaluateAll((elements) =>
          elements.map((element) => getComputedStyle(element).backgroundColor),
        );
      for (const fill of fills)
        expect([tokens[scheme].background, tokens[scheme].card]).toContain(
          hex(fill),
        );
    });

    test("placeholder text is muted-foreground and readable on its fill", async ({
      page,
    }) => {
      await page.goto("/__controls");
      await fixturePageReady(page);
      const colour = await page
        .getByPlaceholder("Type here")
        .evaluate(
          (element) => getComputedStyle(element, "::placeholder").color,
        );
      expect(hex(colour)).toBe(tokens[scheme]["muted-foreground"]);
      expect(
        contrastRatio(hex(colour), tokens[scheme].card),
      ).toBeGreaterThanOrEqual(4.5);
    });

    test("the radio card's unselected ring is the input edge (finding F5), and selection is a ring with a dot", async ({
      page,
    }) => {
      await page.goto("/__controls");
      await fixturePageReady(page);
      const ring = await page
        .getByRole("radio", { name: "Second" })
        .locator("span[aria-hidden]")
        .last()
        .evaluate((element) => getComputedStyle(element).borderTopColor);
      expect(hex(ring)).toBe(tokens[scheme].input);
      await expect(
        page
          .getByRole("radio", { name: "First" })
          .locator('[data-state="checked"]'),
      ).toBeVisible();
    });

    test("a disabled button shows its reason beside it", async ({ page }) => {
      await page.goto("/__controls");
      await fixturePageReady(page);
      const button = page.getByRole("button", { name: "Send now" });
      await expect(button).toBeDisabled();
      await expect(
        page.getByText("You are offline, so this cannot be sent yet."),
      ).toBeVisible();
    });

    test("every shared control passes axe with real layout and colour-contrast", async ({
      page,
    }) => {
      await page.goto("/__controls");
      await fixturePageReady(page);
      expect(await runAxe(page)).toEqual([]);
      await page.screenshot({
        path: evidencePath(`A4/controls-${scheme}.png`),
        fullPage: true,
      });
    });
  });
}

test.describe("forced colours", () => {
  test.use({ viewport: { width: 900, height: 1400 } });

  test("inputs keep a visible border and the focus ring uses system colours", async ({
    page,
  }) => {
    await page.emulateMedia({ forcedColors: "active" });
    await page.goto("/__controls");
    await fixturePageReady(page);
    const input = page.getByTestId("input-canvas");
    const style = await input.evaluate((element) => {
      const s = getComputedStyle(element);
      return {
        width: s.borderTopWidth,
        style: s.borderTopStyle,
        colour: s.borderTopColor,
      };
    });
    expect(style.width).toBe("1px");
    expect(style.style).toBe("solid");
    expect(style.colour).not.toBe("rgba(0, 0, 0, 0)");
    await input.focus();
    const outline = await input.evaluate(
      (element) => getComputedStyle(element).outlineStyle,
    );
    expect(outline).toBe("solid");
  });
});

test.describe("reduced motion", () => {
  test("transitions are removed", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/__controls");
    await fixturePageReady(page);
    const duration = await page
      .getByRole("button", { name: "Primary" })
      .evaluate((element) => getComputedStyle(element).transitionDuration);
    expect(duration).toBe("0s");
  });
});
