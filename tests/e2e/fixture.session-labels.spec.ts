import type { Page } from "@playwright/test";
import {
  DARK,
  evidencePath,
  expect,
  LIGHT,
  pressTab,
  runAxe,
  test,
} from "./helpers";

/**
 * WEB-08d L-1 to L-6: recognisable sessions and devices, both capacities, naming and the named confirmations, rendered in each engine at
 * 320, 390, 768 and 1280 px in dark and light (and Auto). FIXTURE evidence (the canned 0.28-shaped session double): it shows the screens
 * render, reflow and pass axe with real layout and contrast. It is not integration evidence (integration.web08d-labels.spec.ts), not
 * assistive-technology evidence and not Kieran's visual or copy sign-off.
 */
const WIDTHS: Array<[number, number]> = [
  [320, 640],
  [390, 844],
  [768, 1024],
  [1280, 800],
];
const isolate = (text: string) => `\u2068${text}\u2069`;
const rows = (page: Page, kind: "session" | "device") =>
  page.locator(`[data-${kind}-row]`);
const ready = async (page: Page) => {
  await rows(page, "device").first().waitFor();
  await rows(page, "session").first().waitFor();
  await page.locator("[data-capacity=devices]").waitFor();
};

/** No horizontal scroll, axe (contrast included) and 44 px targets in `region`; a focus ring on the first control. */
async function checkSurface(page: Page, label: string, region: string) {
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
    `${label}: axe ${JSON.stringify(
      violations.map((v) =>
        v.nodes.map((n) => (n as { failureSummary?: string }).failureSummary),
      ),
    )}`,
  ).toEqual([]);
  const small = await page.evaluate((selector) => {
    const scope = document.querySelector(selector);
    if (!scope) return ["region missing"];
    return Array.from(
      scope.querySelectorAll<HTMLElement>("button, a[href], input"),
    )
      .filter(
        (el) =>
          el.getBoundingClientRect().height > 0 &&
          !el.hasAttribute("disabled") &&
          el.getBoundingClientRect().height < 43.5,
      )
      .map(
        (el) =>
          `${el.tagName.toLowerCase()} "${(el.textContent ?? "").trim().slice(0, 30)}"`,
      );
  }, region);
  expect(small, `${label}: targets under 44px`).toEqual([]);
}

for (const scheme of ["dark", "light"] as const) {
  test.describe(`L-1 recognisable rows, ${scheme}`, () => {
    test.use({ colorScheme: scheme });
    test("labels, names, one indicator per current row, both capacities; no scroll, axe and targets at every width", async ({
      page,
    }, testInfo) => {
      const engine = testInfo.project.name.replace("fixture-", "");
      for (const [width, height] of WIDTHS) {
        await page.setViewportSize({ width, height });
        await page.goto("/settings/sessions");
        await ready(page);
        const label = `L-1 at ${width}px, ${scheme}, ${engine}`;
        const current = page.locator("[data-session-row=current]");
        await expect(current).toContainText("Chrome on macOS");
        await expect(current.locator("[data-current-tag]")).toHaveText(
          "This browser",
        );
        await expect(
          page.locator("[data-session-row=other] [data-current-tag]"),
        ).toHaveCount(0);
        await expect(
          page.locator("[data-session-row=other] [data-device-name] bdi"),
        ).toHaveText("Kieran's phone");
        await expect(
          page.locator("[data-device-row=current] [data-current-tag]"),
        ).toHaveText("This device");
        await expect(
          page.locator("[data-device-row=other] [data-current-tag]"),
        ).toHaveCount(0);
        await expect(page.locator("bdi[data-device-name]")).toHaveText(
          "Kieran's phone",
        );
        await expect(page.locator("[data-device-label]")).toHaveText(
          "Atlas app on iOS",
        );
        await expect(page.locator("[data-capacity=sessions]")).toHaveText(
          "2 of 10 sign-ins in use.",
        );
        // Three devices are listed and two hold a place for syncing: the line is the server's count, not the list's length.
        await expect(page.locator("[data-capacity=devices]")).toHaveText(
          "2 of 10 places for syncing in use.",
        );
        await expect(page.locator("main")).not.toContainText(
          /dev-\d|sess-\d|v1\./,
        );
        await checkSurface(page, label, "main");
        if (engine === "chromium")
          await page.screenshot({
            path: evidencePath(`session-labels/L1-${width}-${scheme}.png`),
            fullPage: true,
          });
      }
    });
  });
}

test.describe("L-2 hostile and long names", () => {
  // The viewport is tall enough for the whole page: at 320 x 640 the shell's sticky bottom tab bar lies over whichever row the
  // viewport happens to cut at scroll 0, and axe's target-size rule then measures that overlap, not the layout under test.
  for (const [width, height] of [
    [320, 2400],
    [1280, 2400],
  ] as const) {
    test(`markup is text, RTL names are isolated, 64 emoji wrap, an invalid name falls back, at ${width}px`, async ({
      page,
    }, testInfo) => {
      await page.setViewportSize({ width, height });
      await page.goto("/settings/sessions?labels=hostile");
      await ready(page);
      const main = page.locator("main");
      await expect(main.locator("img, script")).toHaveCount(0);
      await expect(
        main
          .getByText("<img src=x onerror=alert(1)>", { exact: false })
          .first(),
      ).toBeVisible();
      // Every name sits in its own <bdi>: the current device's Hebrew name, the markup and the 64 emoji (rows), plus the
      // markup again as the other session's device.
      await expect(main.locator("[data-device-row] bdi")).toHaveCount(3);
      await expect(
        main.locator("[data-session-row=other] [data-device-name] bdi"),
      ).toHaveCount(1);
      // The right-to-left override is never shown: the device falls back to its label.
      await expect(main).not.toContainText("\u202E");
      await expect(rows(page, "device").nth(3)).toContainText(
        "Edge on Windows",
      );
      await expect(
        page.getByRole("button", {
          name: `Retire this device, ${isolate("המחשב של קירן")}`,
        }),
      ).toBeVisible();
      const scheme = testInfo.project.use.colorScheme ?? "light";
      await checkSurface(page, `L-2 at ${width}px`, "main");
      if (testInfo.project.name === "fixture-chromium")
        await page.screenshot({
          path: evidencePath(
            `session-labels/L2-hostile-${width}-${scheme}.png`,
          ),
          fullPage: true,
        });
    });
  }

  test("legacy rows (null labels) and an older server (no members) keep WEB-08a's fallbacks", async ({
    page,
  }) => {
    await page.goto("/settings/sessions?labels=legacy");
    await ready(page);
    await expect(page.locator("[data-session-row=other]")).toContainText(
      "Another sign-in",
    );
    await expect(page.locator("[data-device-row=other]").first()).toContainText(
      "Another device",
    );
    await expect(
      page.getByRole("button", { name: /^Name / }).first(),
    ).toBeVisible();
    await page.goto("/settings/sessions?labels=absent");
    await rows(page, "device").first().waitFor();
    await expect(page.locator("[data-capacity=sessions]")).toHaveText(
      "We can't show how many sign-ins this account can have.",
    );
    await expect(page.locator("[data-capacity=devices]")).toHaveText(
      "We can't show how many devices can sync.",
    );
    await expect(
      page.getByRole("button", { name: /^(Re)?[Nn]ame / }),
    ).toHaveCount(0);
  });

  test("labels from a later API version read as unknown, never raw", async ({
    page,
  }) => {
    await page.goto("/settings/sessions?labels=future");
    await ready(page);
    const devices = rows(page, "device");
    await expect(devices.nth(0)).toContainText("A browser on macOS");
    await expect(devices.nth(1)).toContainText("Unknown app or browser");
    await expect(devices.nth(2)).toContainText("Chrome");
    await expect(page.locator("main")).not.toContainText(
      /brave|harmonyos|plan9|\btv\b/,
    );
  });

  test("duplicate titles get one hint", async ({ page }) => {
    await page.goto("/settings/sessions?labels=duplicate");
    await ready(page);
    await expect(page.locator("[data-duplicate-hint]")).toHaveText(
      "Some devices look the same here. Give them names to tell them apart.",
    );
  });
});

test.describe("L-3 capacity", () => {
  for (const [variant, sessions, devices] of [
    [
      "full",
      "2 of 2 sign-ins in use. A new sign-in won't work until you sign one out.",
      "2 of 2 places for syncing in use. A new device can't start syncing until you retire one.",
    ],
    [
      "unlimited",
      "2 sign-ins in use. This server sets no limit.",
      "2 places for syncing in use. This server sets no limit.",
    ],
    [
      "unavailable",
      "We can't show how many sign-ins this account can have.",
      "We can't show how many devices can sync.",
    ],
    [
      "inconsistent",
      "We can't show how many sign-ins this account can have.",
      "We can't show how many devices can sync.",
    ],
  ] as const)
    test(`capacity=${variant}`, async ({ page }) => {
      await page.setViewportSize({ width: 320, height: 640 });
      await page.goto(`/settings/sessions?capacity=${variant}`);
      await rows(page, "device").first().waitFor();
      await expect(page.locator("[data-capacity=sessions]")).toHaveText(
        sessions,
      );
      await expect(page.locator("[data-capacity=devices]")).toHaveText(devices);
      await checkSurface(page, `L-3 ${variant}`, "main");
    });

  test("no capacity line while the lists load", async ({ page }) => {
    await page.goto("/settings/sessions?load=slow");
    await page.getByText("Loading your devices…").waitFor();
    await expect(page.locator("[data-capacity]")).toHaveCount(0);
    await ready(page);
    await expect(page.locator("[data-capacity]")).toHaveCount(2);
  });
});

test.describe("L-4 naming", () => {
  const dialog = (page: Page) => page.getByRole("dialog");
  const live = (page: Page) => page.locator("[aria-live=polite]");

  test("validate, save the exact value, hear it, see the new title; then remove it", async ({
    page,
  }) => {
    await page.goto("/settings/sessions");
    await ready(page);
    await page
      .getByRole("button", { name: "Name Firefox on Windows, never synced" })
      .click();
    await expect(dialog(page)).toHaveAccessibleName("Name a device");
    const field = dialog(page).getByLabel("Device name");
    await field.fill("Den ");
    await dialog(page).getByRole("button", { name: "Save name" }).click();
    await expect(
      dialog(page).getByText("Remove the space at the start or end."),
    ).toBeVisible();
    await expect(field).toHaveAttribute("aria-invalid", "true");
    await expect(field).toBeFocused();
    await field.fill("Den  PC");
    await dialog(page).getByRole("button", { name: "Save name" }).click();
    await expect(live(page)).toHaveText("Name saved.");
    await expect(dialog(page)).toHaveCount(0);
    const renamed = rows(page, "device").nth(2);
    await expect(renamed.locator("bdi[data-device-name]")).toHaveText(
      "Den  PC",
    );
    await expect(renamed.locator("[data-device-label]")).toHaveText(
      "Firefox on Windows",
    );
    await renamed.getByRole("button", { name: /^Rename / }).click();
    await expect(dialog(page)).toHaveAccessibleName(
      /^Rename \u2068Den\s+PC\u2069$/,
    );
    await expect(dialog(page).getByLabel("Device name")).toHaveValue("Den  PC");
    await dialog(page).getByRole("button", { name: "Remove name" }).click();
    await expect(live(page)).toHaveText("Name removed.");
    await expect(rows(page, "device").nth(2)).toContainText(
      "Firefox on Windows",
    );
    await expect(rows(page, "device").nth(2).locator("bdi")).toHaveCount(0);
  });

  test("gone, refused and unconfirmed answers say so in the dialog", async ({
    page,
  }) => {
    for (const [variant, text] of [
      [
        "gone",
        "That device isn't listed any more, so its name wasn't changed.",
      ],
      [
        "refuse",
        "Atlas didn't accept that name. Check it and try again. Request ID: 3b7e-91c4-fixture",
      ],
      [
        "lost",
        "We couldn't confirm the change. The list has been refreshed — check it, and try again if needed.",
      ],
    ] as const) {
      await page.goto(`/settings/sessions?name=${variant}`);
      await ready(page);
      await page
        .getByRole("button", { name: "Name Firefox on Windows, never synced" })
        .click();
      await dialog(page).getByLabel("Device name").fill("Den");
      await dialog(page).getByRole("button", { name: "Save name" }).click();
      await expect(dialog(page).getByText(text)).toBeVisible();
      await expect(
        page.locator("[aria-live=assertive]"),
        `${variant}: announced`,
      ).toHaveText(text);
      const violations = await runAxe(page, "[role=dialog]");
      expect(
        violations.map((v) => v.id),
        `${variant}: axe`,
      ).toEqual([]);
    }
  });

  test("real offline: Name and Rename are disabled with the reason; with the dialog open, Save is too", async ({
    page,
  }) => {
    await page.goto("/settings/sessions");
    await ready(page);
    await page
      .getByRole("button", { name: "Name Firefox on Windows, never synced" })
      .click();
    await dialog(page).getByLabel("Device name").fill("Den");
    await page.context().setOffline(true);
    await expect.poll(() => page.evaluate(() => navigator.onLine)).toBe(false);
    await expect(
      dialog(page).getByRole("button", { name: "Save name" }),
    ).toBeDisabled();
    await expect(
      dialog(page).getByText("Naming a device needs a connection."),
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog(page)).toHaveCount(0);
    const naming = page.getByRole("button", { name: /^(Re)?[Nn]ame / });
    await expect(naming).toHaveCount(3);
    for (const button of await naming.all())
      await expect(button).toBeDisabled();
    await expect(
      page.getByText("Naming a device needs a connection."),
    ).toHaveCount(3);
    // Nothing was named while offline.
    await expect(page.locator("bdi[data-device-name]")).toHaveText(
      "Kieran's phone",
    );
    await page.context().setOffline(false);
    await expect.poll(() => page.evaluate(() => navigator.onLine)).toBe(true);
    for (const button of await naming.all()) await expect(button).toBeEnabled();
  });
});

test.describe("L-5 the named confirmations", () => {
  for (const scheme of ["dark", "light"] as const)
    for (const [width, height] of [
      [320, 640],
      [1280, 800],
    ] as const)
      test(`retire another, retire this, log out at ${width}px, ${scheme}`, async ({
        page,
      }, testInfo) => {
        await page.emulateMedia({ colorScheme: scheme });
        await page.setViewportSize({ width, height });
        await page.goto("/settings/sessions");
        await ready(page);
        const steps: Array<[string, () => Promise<void>, string]> = [
          [
            "retire-other",
            () =>
              page
                .getByRole("button", {
                  name: `Retire ${isolate("Kieran's phone")}, last synced 3 hours ago`,
                })
                .click(),
            `Retire ${isolate("Kieran's phone")}?`,
          ],
          [
            "retire-this",
            () =>
              page
                .getByRole("button", {
                  name: "Retire this device, Chrome on macOS",
                })
                .click(),
            "Retire this device?",
          ],
          [
            "logout",
            () =>
              page
                .getByRole("button", {
                  name: "Sign out of this browser, Chrome on macOS",
                })
                .click(),
            "Log out?",
          ],
        ];
        for (const [name, open, title] of steps) {
          await open();
          const dialog = page.getByRole("dialog", { name: title });
          await dialog.waitFor();
          if (name === "retire-this")
            await expect(dialog.locator("[data-identity]")).toHaveText(
              "This device: Chrome on macOS",
            );
          if (name === "logout")
            await expect(dialog.locator("[data-identity]")).toHaveText(
              "This browser: Chrome on macOS",
            );
          await checkSurface(
            page,
            `L-5 ${name} ${width}px ${scheme}`,
            "[role=dialog]",
          );
          await pressTab(page);
          if (testInfo.project.name === "fixture-chromium")
            await page.screenshot({
              path: evidencePath(
                `session-labels/L5-${name}-${width}-${scheme}.png`,
              ),
              fullPage: true,
            });
          await page.keyboard.press("Escape");
          await expect(dialog).toHaveCount(0);
        }
      });
});

test.describe("L-6 Auto", () => {
  test("with Appearance on Match system, the labelled screen follows the device's scheme without a reload", async ({
    page,
  }) => {
    // Colour transitions (140 ms) are removed so axe measures settled colours, not a frame mid-fade (as the appearance spec does).
    await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
    await page.goto("/settings/sessions");
    await ready(page);
    const canvas = () =>
      page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    const panel = () =>
      page.evaluate(
        () =>
          getComputedStyle(
            document.querySelector("[data-device-row]") as HTMLElement,
          ).backgroundColor,
      );
    expect(await canvas()).toBe(DARK.canvas);
    const darkPanel = await panel();
    await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
    await expect.poll(canvas).toBe(LIGHT.canvas);
    await expect.poll(panel).not.toBe(darkPanel);
    const violations = await runAxe(page);
    expect(violations.map((v) => v.id)).toEqual([]);
  });
});
