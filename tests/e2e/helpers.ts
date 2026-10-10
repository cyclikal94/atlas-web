import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import {
  test as base,
  expect,
  type Locator,
  type Page,
} from "@playwright/test";

import { claimEvidencePath } from "./evidence-run";

const require = createRequire(import.meta.url);
const axeSource = readFileSync(require.resolve("axe-core/axe.min.js"), "utf8");

/**
 * Every browser test fails on any console error or warning, page error or failed same-origin request: the shell must
 * be quiet. There is no opt-out: a test that provokes a message on purpose must catch it in the page instead.
 */
export const test = base.extend<{
  consoleGuard: undefined;
  harnessDiagnostics: undefined;
}>({
  /**
   * R57 (revision 34): a spec that FAILS has the state of every data-harness page of its context attached to its report: the clock, the
   * identity, what the harness outbox is bound to (the captured service's lifetime and incarnation, the registry's open count and latch),
   * the registry's last closes and latches, the services' ends, the outbox's refusals with the binding at each, the dispatcher's state and
   * the fallback markers' raw keys. It is collected after the test body, reads and changes nothing, and is skipped for a page that is
   * gone; a failure that is not about a harness page has nothing to attach.
   */
  harnessDiagnostics: [
    async ({ context }, use, testInfo) => {
      await use(undefined);
      if (testInfo.status === testInfo.expectedStatus) return;
      let index = 0;
      for (const page of context.pages()) {
        index += 1;
        try {
          if (page.isClosed()) continue;
          const found = await page.evaluate(
            () =>
              (
                window as unknown as {
                  __atlasData?: { diagnostics?: () => unknown };
                }
              ).__atlasData?.diagnostics?.() ?? null,
          );
          if (found !== null)
            await testInfo.attach(`harness-diagnostics-page-${index}`, {
              body: JSON.stringify(found, null, 2),
              contentType: "application/json",
            });
        } catch {
          // A page that cannot be asked has nothing to say.
        }
      }
    },
    { auto: true },
  ],
  consoleGuard: [
    async ({ page }, use) => {
      const problems: string[] = [];
      page.on("console", (message) => {
        if (message.type() === "error" || message.type() === "warning")
          problems.push(`${message.type()}: ${message.text()}`);
      });
      page.on("pageerror", (error) =>
        problems.push(`pageerror: ${error.message}`),
      );
      await use(undefined);
      expect(problems, "console errors and warnings").toEqual([]);
    },
    { auto: true },
  ],
});
export { expect };

interface AxeViolation {
  id: string;
  impact: string | null;
  nodes: Array<{ target: unknown[]; html: string }>;
}

/** Runs axe-core in the real page, with real layout, so colour-contrast is evaluated (jsdom cannot). */
export async function runAxe(
  page: Page,
  context?: string,
): Promise<AxeViolation[]> {
  await page.evaluate(axeSource);
  return page.evaluate(async (selector) => {
    const axe = (
      window as unknown as {
        axe: {
          run(
            context: unknown,
            options: unknown,
          ): Promise<{ violations: unknown[] }>;
        };
      }
    ).axe;
    const result = await axe.run(selector ?? document, {
      runOnly: {
        type: "tag",
        values: [
          "wcag2a",
          "wcag2aa",
          "wcag21a",
          "wcag21aa",
          "wcag22aa",
          "best-practice",
        ],
      },
      rules: { "color-contrast": { enabled: true } },
    });
    return result.violations;
  }, context) as Promise<AxeViolation[]>;
}

export const DARK = { canvas: "rgb(8, 9, 10)" };
export const LIGHT = { canvas: "rgb(247, 248, 249)" };

/** Screenshots share the invocation's isolated evidence tree and refuse duplicates. */
export function evidencePath(name: string): string {
  return claimEvidencePath(base.info(), name);
}

/**
 * Presses Tab (or Shift+Tab). Safari on macOS does not Tab to links or buttons unless Option is held ("Press Tab to highlight each
 * item" is off by default), and Playwright's macOS WebKit behaves the same. Linux and Windows WebKit builds, and every other
 * engine, Tab to everything, so CI needs no special case.
 */
export const isMacWebKit = (page: Page) =>
  process.platform === "darwin" &&
  page.context().browser()?.browserType().name() === "webkit";

export async function pressTab(page: Page, options: { shift?: boolean } = {}) {
  const macWebKit = isMacWebKit(page);
  const modifiers = [
    options.shift ? "Shift" : "",
    macWebKit ? "Alt" : "",
  ].filter(Boolean);
  await page.keyboard.press([...modifiers, "Tab"].join("+"));
}

/** The focused element as a short label: its tag and accessible name, or a marker when it is not the page's own control. */
export const focusedLabel = (page: Page) =>
  page.evaluate(() => {
    const active = document.activeElement;
    if (!active) return "none";
    if (active.hasAttribute("data-radix-focus-guard")) return "focus-guard";
    const name = active.getAttribute("aria-label") ?? active.textContent ?? "";
    return `${active.tagName.toLowerCase()}:${name.trim().slice(0, 40)}`;
  });

/**
 * A dialog is a keyboard loop (ia.md 3, accessibility.md 1.2): starting from wherever focus is inside it, Tab visits every control
 * and comes back to the start, Shift+Tab visits them in exactly the reverse order, and at no step is focus on the page behind,
 * on a focus guard, or on the body. There is no exception for any engine: macOS WebKit is driven with Option+Tab (pressTab), which
 * is the keystroke a Safari user needs to reach links and buttons.
 * `reverse: false` skips the reverse turn; the one caller says why. Returns the ring in forward order, ending at the start.
 */
export async function expectFocusLoop(
  page: Page,
  dialog: Locator,
  { reverse: checkReverse = true }: { reverse?: boolean } = {},
) {
  const inside = () =>
    dialog.evaluate((element) => element.contains(document.activeElement));
  expect(await inside(), "focus starts inside the dialog").toBe(true);
  const start = await focusedLabel(page);
  const forward: string[] = [];
  for (let step = 1; step <= 24; step += 1) {
    await pressTab(page);
    expect(await inside(), `Tab ${step} stays in the dialog`).toBe(true);
    const label = await focusedLabel(page);
    forward.push(label);
    if (label === start) break;
  }
  expect(forward.at(-1), "Tab returns to where it began").toBe(start);
  expect(new Set(forward).size, "every stop is visited once").toBe(
    forward.length,
  );
  if (!checkReverse) return forward;
  const reverse: string[] = [];
  for (let step = 1; step <= forward.length; step += 1) {
    await pressTab(page, { shift: true });
    expect(await inside(), `Shift+Tab ${step} stays in the dialog`).toBe(true);
    reverse.push(await focusedLabel(page));
  }
  const back = [...forward].reverse();
  expect(reverse, "Shift+Tab is the exact reverse of Tab").toEqual([
    ...back.slice(1),
    back[0],
  ]);
  return forward;
}
