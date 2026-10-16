import type { Page } from "@playwright/test";
import {
  evidencePath,
  expect,
  expectFocusLoop,
  fixturePageReady,
  pressTab,
  runAxe,
  test,
} from "./helpers";

/**
 * S-NEUTRAL / A2 (plan 12.1, 13.5): the rendered checks of every neutral state, the level-0 gate, the Settings screens and the
 * three confirmation dialogs, at 320, 390, 768 and 1280 px, in dark and light, in each engine: no horizontal scroll, axe clean
 * INCLUDING colour contrast in real layout, 44 px targets in the content, a visible focus ring, the right focus target.
 * Screenshots (Chromium) go to this invocation's evidence directory. FIXTURE evidence: it says the screens render as designed. It is
 * not Kieran's visual sign-off and not assistive-technology evidence (T22, WEB-08c). The light theme of the gap frames was
 * unverified in the design files (G-11); this is where it is measured. WEB-08d: the default fixture is 0.28-shaped (labelled rows), so the
 * readiness waits find rows by their `data-*` role, not by WEB-08a's fallback titles; the assertions are unchanged.
 */
const WIDTHS: Array<[number, number]> = [
  [320, 640],
  [390, 844],
  [768, 1024],
  [1280, 800],
];

const NEUTRAL_STATES = [
  "1a.confirming",
  "1a.checking",
  "1a.device_changed",
  "1a.ended_elsewhere",
  "1b",
  "1c.finishing",
  "1c.offline",
  "1c.lock_wait",
  "1c.superseded",
  "1c.resolving",
  "1c.ended",
  "1d",
  "1e.checking",
  "1e.session_online",
  "1e.session_offline",
  "1e.read_failure",
  "1e.interrupted_online",
  "1e.interrupted_offline",
  "1e.waiting",
  "2",
  "3",
  "wipe.consent",
] as const;

interface Surface {
  name: string;
  path: string;
  /** Where the content lives, for the target-size check. */
  region: string;
  /** Drive the page into the state under test (open a dialog, wait for data). */
  prepare?(page: Page): Promise<void>;
  /** The heading that should hold focus once the surface has settled. */
  focusHeading?: boolean;
}

const settingsReady = async (page: Page) => {
  await page.getByRole("heading", { level: 1 }).first().waitFor();
};
const openLogout = async (page: Page) => {
  await page.getByRole("button", { name: "Sign out" }).first().click();
  await page.getByRole("dialog", { name: "Log out?" }).waitFor();
  await page.getByRole("button", { name: /^Log out/ }).waitFor();
};

const SURFACES: Surface[] = [
  ...NEUTRAL_STATES.map((state) => ({
    name: `neutral-${state}`,
    path: `/__neutral?state=${state}&count=4`,
    region: "main",
    focusHeading: true,
    prepare: fixturePageReady,
  })),
  {
    name: "gate",
    path: "/__neutral?state=gate",
    region: "#resume-gate",
    prepare: fixturePageReady,
  },
  {
    name: "settings-home",
    path: "/settings",
    region: "main",
    prepare: settingsReady,
  },
  {
    name: "sessions-devices",
    path: "/settings/sessions",
    region: "main",
    prepare: async (page) => {
      await page.locator("[data-device-row=other]").first().waitFor();
      await page.locator("[data-session-row=other]").first().waitFor();
    },
  },
  {
    name: "sessions-devices-only-own",
    path: "/settings/sessions?only=1",
    region: "main",
    prepare: async (page) => {
      await page.locator("[data-device-row=current]").waitFor();
    },
  },
  {
    name: "sessions-devices-errors",
    path: "/settings/sessions?error=sessions",
    region: "main",
    prepare: async (page) => {
      await page.locator("[data-load-error]").waitFor();
      await page.locator("[data-device-row=other]").first().waitFor();
    },
  },
  {
    name: "your-data",
    path: "/settings/data?pending=2",
    region: "main",
    prepare: async (page) => {
      await page.getByText("2 items right now").waitFor();
    },
  },
  {
    name: "dialog-logout",
    path: "/settings/sessions",
    region: "[role=dialog]",
    prepare: async (page) => {
      await page.locator("[data-device-row=other]").first().waitFor();
      await openLogout(page);
    },
  },
  {
    name: "dialog-logout-unsynced",
    path: "/settings/sessions?unsynced=3",
    region: "[role=dialog]",
    prepare: async (page) => {
      await page.locator("[data-device-row=other]").first().waitFor();
      await openLogout(page);
      await page.getByText("3 changes haven't finished syncing yet:").waitFor();
    },
  },
  {
    name: "dialog-logout-reconfirm",
    path: "/settings/sessions?unsynced=3&reconfirm=4",
    region: "[role=dialog]",
    prepare: async (page) => {
      await page.locator("[data-device-row=other]").first().waitFor();
      await openLogout(page);
      await page.getByRole("button", { name: "Log out anyway →" }).click();
      await page.getByText("Actually 4 changes — still log out?").waitFor();
    },
  },
  {
    name: "dialog-retire-this-device",
    path: "/settings/sessions?unsynced=2",
    region: "[role=dialog]",
    prepare: async (page) => {
      await page.locator("[data-device-row=other]").first().waitFor();
      await page.getByRole("button", { name: "Retire this device" }).click();
      await page.getByRole("dialog", { name: "Retire this device?" }).waitFor();
      await page
        .getByText("Retiring this device signs you out here, right now.")
        .waitFor();
    },
  },
  {
    name: "dialog-retire-other-device",
    path: "/settings/sessions",
    region: "[role=dialog]",
    prepare: async (page) => {
      await page.locator("[data-device-row=other]").first().waitFor();
      // WEB-08d: the button and the dialog name the device (the first other row is the fixture's named phone).
      await page
        .locator("[data-device-row=other]")
        .first()
        .getByRole("button", { name: /^Retire / })
        .click();
      await page.getByRole("dialog", { name: /^Retire .+\?$/ }).waitFor();
    },
  },
  {
    name: "notice-still-signed-in",
    path: "/settings/data?notice=1",
    region: "[data-notice]",
    prepare: async (page) => {
      await page.locator("[data-notice]").waitFor();
    },
  },
  {
    name: "compatibility-api",
    path: "/__neutral?state=1b",
    region: "main",
    prepare: fixturePageReady,
  },
];

for (const scheme of ["dark", "light"] as const) {
  test.describe(`A2 rendered checks, ${scheme}`, () => {
    test.use({ colorScheme: scheme });
    for (const surface of SURFACES) {
      if (surface.name === "compatibility-api") continue; // covered by the component test; no fixture route
      test(`${surface.name}`, async ({ page }, testInfo) => {
        const engine = testInfo.project.name.replace("fixture-", "");
        for (const [width, height] of WIDTHS) {
          await page.setViewportSize({ width, height });
          await page.goto(surface.path);
          await surface.prepare?.(page);
          const label = `${surface.name} at ${width}px, ${scheme}, ${engine}`;

          // 1. No horizontal scrolling.
          expect(
            await page.evaluate(
              () =>
                document.documentElement.scrollWidth <=
                document.documentElement.clientWidth,
            ),
            `${label}: horizontal scroll`,
          ).toBe(true);

          // 2. axe, including colour contrast in the real layout.
          const violations = await runAxe(page);
          expect(
            violations.map(
              (v) =>
                `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`,
            ),
            `${label}: axe`,
          ).toEqual([]);

          // 3. Targets in the content are at least 44 px high.
          const small = await page.evaluate((region) => {
            const scope = document.querySelector(region);
            if (!scope) return ["region missing"];
            const targets = scope.querySelectorAll<HTMLElement>(
              "button, a[href], input, [role=radio]",
            );
            return Array.from(targets)
              .filter(
                (el) =>
                  el.getBoundingClientRect().height > 0 &&
                  !el.hasAttribute("disabled"),
              )
              .filter((el) => el.getBoundingClientRect().height < 43.5)
              .map(
                (el) =>
                  `${el.tagName.toLowerCase()} "${(el.textContent ?? "").trim().slice(0, 30)}" ${Math.round(el.getBoundingClientRect().height)}px`,
              );
          }, surface.region);
          expect(small, `${label}: targets under 44px`).toEqual([]);

          // 4. The programmatic focus target of a neutral state is its heading.
          if (surface.focusHeading)
            expect(
              await page.evaluate(() => document.activeElement?.tagName),
              `${label}: focus target`,
            ).toBe("H1");

          // 5. A visible focus ring on the first control reached by keyboard.
          const controls = await page
            .locator(`${surface.region} :is(button, a[href]):visible`)
            .count();
          if (controls > 0 && surface.name !== "gate") {
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
            await page.screenshot({
              path: evidencePath(
                `session-neutral/${surface.name}-${width}-${scheme}.png`,
              ),
              fullPage: true,
            });
          }
        }
      });
    }
  });
}

test.describe("the confirmation dialog is a keyboard loop with the safe default", () => {
  test("Tab and Shift+Tab stay inside the logout dialog; 'Stay logged in' has focus first; Escape closes without acting", async ({
    page,
  }) => {
    await page.goto("/settings/sessions?unsynced=3");
    await page.locator("[data-device-row=other]").first().waitFor();
    await openLogout(page);
    const dialog = page.getByRole("dialog", { name: "Log out?" });
    await expect(
      page.getByRole("button", { name: "Stay logged in" }),
    ).toBeFocused();
    await expectFocusLoop(page, dialog);
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
  });

  test("the dialog renders inside #protected-root's portal container, never outside it", async ({
    page,
  }) => {
    await page.goto("/settings/sessions");
    await page.locator("[data-device-row=other]").first().waitFor();
    await openLogout(page);
    const outside = await page.evaluate(() => {
      const dialog = document.querySelector("[role=dialog]");
      return dialog?.closest("[data-portal-root]") === null;
    });
    expect(outside).toBe(false);
  });
});
