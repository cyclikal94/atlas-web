import { mkdirSync } from "node:fs";
import type { Locator, Page } from "@playwright/test";
import { contrastRatio } from "../../src/design/contrast";
import { tokens } from "../../src/design/tokens";
import { expect, pressTab, runAxe } from "./helpers";

/** The widths of the design pass (WEB-08a and WEB-08b): 320, 390, 768 and 1280 px. */
export const WIDTHS: Array<[number, number]> = [
  [320, 640],
  [390, 844],
  [768, 1024],
  [1280, 800],
];

/**
 * The rendered checks every surface gets in a real engine, at one width: no horizontal scroll, axe clean INCLUDING colour
 * contrast in real layout, 44 px targets in `region`, the heading as the focus target where asked, a visible focus ring on the
 * first control reached by keyboard, and (Chromium) a screenshot for the evidence folder. Design and accessibility evidence only.
 */
export async function checkSurface(
  page: Page,
  options: {
    label: string;
    region: string;
    engine: string;
    evidence: string;
    name: string;
    width: number;
    scheme: string;
    focusHeading?: boolean;
  },
) {
  const { label, region, engine } = options;
  expect(
    await page.evaluate(
      () =>
        document.documentElement.scrollWidth <=
        document.documentElement.clientWidth,
    ),
    `${label}: horizontal scroll`,
  ).toBe(true);

  const violations = await runAxe(page);
  expect(
    violations.map(
      (v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`,
    ),
    `${label}: axe`,
  ).toEqual([]);

  const small = await page.evaluate((selector) => {
    const scope = document.querySelector(selector);
    if (!scope) return ["region missing"];
    return Array.from(
      scope.querySelectorAll<HTMLElement>(
        "button, a[href], input, [role=radio]",
      ),
    )
      .filter((el) => el.getBoundingClientRect().height > 0)
      .filter((el) => el.getBoundingClientRect().height < 43.5)
      .map(
        (el) =>
          `${el.tagName.toLowerCase()} "${(el.textContent ?? "").trim().slice(0, 30)}" ${Math.round(el.getBoundingClientRect().height)}px`,
      );
  }, region);
  expect(small, `${label}: targets under 44px`).toEqual([]);

  if (options.focusHeading)
    expect(
      await page.evaluate(() => document.activeElement?.tagName),
      `${label}: focus target`,
    ).toBe("H1");

  if (
    (await page
      .locator(`${region} :is(button, a[href], input):visible:enabled`)
      .count()) > 0
  ) {
    await pressTab(page);
    const ring = await page.evaluate(() => {
      const active = document.activeElement as HTMLElement | null;
      if (!active || active === document.body) return null;
      const style = getComputedStyle(active);
      return {
        outline:
          style.outlineStyle !== "none" &&
          Number.parseFloat(style.outlineWidth) >= 2,
        shadow: style.boxShadow !== "none",
      };
    });
    expect(
      ring && (ring.outline || ring.shadow),
      `${label}: focus ring`,
    ).toBeTruthy();
  }

  if (engine === "chromium") {
    mkdirSync(`${options.evidence}/chromium`, { recursive: true });
    await page.screenshot({
      path: `${options.evidence}/chromium/${options.name}-${options.width}-${options.scheme}.png`,
      fullPage: true,
    });
  }
}

const toHex = (rgb: string): string => {
  const [r, g, b] = (rgb.match(/\d+/g) ?? []).slice(0, 3).map(Number) as [
    number,
    number,
    number,
  ];
  return `#${[r, g, b].map((n) => n.toString(16).padStart(2, "0")).join("")}`.toUpperCase();
};

/**
 * A-4 in a real browser: the colours actually PAINTED. An input's border must be the `field-edge` token and reach 3:1 against what
 * surrounds the input and against its own fill (non-text contrast, WCAG 1.4.11); a primary button's label must reach 4.5:1 against
 * its fill. `surround` is the nearest ancestor that paints a background.
 */
export async function expectPaintedContrast(
  input: Locator,
  button: Locator,
  scheme: "dark" | "light",
  label: string,
) {
  const painted = await input.evaluate((element) => {
    const style = getComputedStyle(element);
    let node: Element | null = element.parentElement;
    let surround = "rgba(0, 0, 0, 0)";
    while (node) {
      const background = getComputedStyle(node).backgroundColor;
      if (background !== "rgba(0, 0, 0, 0)" && background !== "transparent") {
        surround = background;
        break;
      }
      node = node.parentElement;
    }
    return {
      border: style.borderTopColor,
      width: style.borderTopWidth,
      fill: style.backgroundColor,
      surround,
    };
  });
  expect(painted.width, `${label}: border width`).toBe("1px");
  expect(toHex(painted.border), `${label}: border is field-edge`).toBe(
    tokens[scheme]["field-edge"],
  );
  expect(
    contrastRatio(toHex(painted.border), toHex(painted.surround)),
    `${label}: border against its surround`,
  ).toBeGreaterThanOrEqual(3);
  expect(
    contrastRatio(toHex(painted.border), toHex(painted.fill)),
    `${label}: border against its fill`,
  ).toBeGreaterThanOrEqual(3);
  const action = await button.evaluate((element) => {
    const style = getComputedStyle(element);
    return { text: style.color, fill: style.backgroundColor };
  });
  expect(
    contrastRatio(toHex(action.text), toHex(action.fill)),
    `${label}: primary action text`,
  ).toBeGreaterThanOrEqual(4.5);
  return {
    border: toHex(painted.border),
    surround: toHex(painted.surround),
    fill: toHex(painted.fill),
    action,
  };
}
