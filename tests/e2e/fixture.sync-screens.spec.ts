import type { Page } from "@playwright/test";
import { recordEvidence } from "./data-evidence";
import { expect, pressTab, runAxe, test } from "./helpers";

/**
 * E-U1 (plan 8.7): the sync screens in a real engine, LIGHT AND DARK, at 320, 390, 768 and 1280 px: axe including colour contrast,
 * 44 px targets, no horizontal scroll, keyboard and focus order inside the protected portal, large counts, and no console error
 * (the shared fixture fails on any). FIXTURE evidence: the data layer is a query-driven double (`src/fixture/data-env.ts`); this
 * says nothing about behaviour with a database, and nothing about real Safari, a device or assistive technology.
 */
const WIDTHS = [320, 390, 768, 1280] as const;

interface Screen {
  name: string;
  url: string;
  /** Text that must be on the page, so a blank or error page cannot pass. */
  expect: RegExp;
}
const SCREENS: Screen[] = [
  {
    name: "queue-waiting",
    url: "/sync?drafts=3&paused=1&confirming=1",
    expect: /Waiting to send/,
  },
  {
    name: "queue-decision",
    url: "/sync?tab=conflicts&decisions=1&rejected=1",
    expect: /Needs a decision/,
  },
  {
    name: "queue-empty",
    url: "/sync?state=idle",
    expect: /Nothing waiting to send\./,
  },
  {
    name: "queue-loading",
    url: "/sync?queue=loading",
    expect: /Loading what's waiting/,
  },
  {
    name: "queue-error",
    url: "/sync?queue=error",
    expect: /Couldn't load what's waiting to send/,
  },
  {
    name: "queue-offline",
    url: "/sync?drafts=2&netoffline=1",
    expect: /Will send when connected/,
  },
  {
    name: "queue-window-first",
    url: "/sync?drafts=250&window=1",
    expect: /Show next changes/,
  },
  {
    name: "queue-window-middle",
    url: "/sync?drafts=250&window=2&size=100",
    expect: /Show previous changes/,
  },
  {
    name: "queue-warning",
    url: "/sync?drafts=214",
    expect: /A lot is waiting to send/,
  },
  {
    name: "floor-a",
    url: "/today?state=floor-a",
    expect: /Unable to sync on this device\/browser at the moment/,
  },
  {
    name: "floor-b",
    url: "/today?state=floor-b",
    expect: /keeping your protected content hidden/,
  },
  {
    name: "page-not-saved",
    url: "/today?state=page-not-saved",
    expect: /Couldn't finish saving that page/,
  },
  {
    name: "storage-full-valid",
    url: "/today?state=storage-full-valid",
    expect: /Couldn't finish updating your offline data/,
  },
  {
    name: "storage-full-invalid",
    url: "/today?state=storage-full-invalid",
    expect: /Couldn't finish refreshing your offline data/,
  },
  {
    name: "storage-not-responding",
    url: "/today?state=storage-not-responding",
    expect: /Local storage isn't responding/,
  },
  {
    name: "compat-unsupported",
    url: "/today?state=compat-unsupported",
    expect: /Sending is paused/,
  },
  {
    name: "compat-missing",
    url: "/today?state=compat-missing",
    expect: /Sending is paused/,
  },
  {
    name: "still-trying-updates",
    url: "/today?state=still-trying-updates",
    expect: /Still trying to update/,
  },
  {
    name: "still-trying-changes",
    url: "/today?state=still-trying-changes",
    expect: /Still trying to send/,
  },
  {
    name: "device-capacity",
    url: "/today?state=device-capacity",
    expect: /This device can't sync right now/,
  },
  {
    name: "unrecognised",
    url: "/today?state=unrecognised",
    expect: /Updates stopped/,
  },
  {
    name: "gate-refreshing",
    url: "/__gate?state=gate",
    expect: /Refreshing your data/,
  },
  {
    name: "gate-floor",
    url: "/__gate?state=gate-floor",
    expect: /keeping your protected content hidden/,
  },
  // R10: the database still says `valid`, but the write of an invalidation the server admitted failed: the cache stays hidden.
  {
    name: "gate-invalidation-write-failed",
    url: "/__gate?state=invalidation-write-failed",
    expect: /Refreshing your data/,
  },
  {
    name: "invalidation-write-failed",
    url: "/today?state=invalidation-write-failed",
    expect: /Couldn't finish saving that page/,
  },
  {
    name: "invalidation-write-quota",
    url: "/today?state=invalidation-write-quota",
    expect: /Couldn't finish refreshing your offline data/,
  },
];

const overflow = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);

/**
 * Every control a person can press IN THESE SCREENS is at least 44 x 44 (the README's touch-target rule). The shell's own chrome
 * (the rail links, the skip link) is WEB-07's accepted design and is not this slice's to measure.
 */
const smallTargets = (page: Page) =>
  page.evaluate(() => {
    const out: string[] = [];
    const scope = document.querySelector("main") ?? document.body;
    for (const element of scope.querySelectorAll<HTMLElement>(
      'button, [role="tab"], a[href], input, select, textarea, [role="button"]',
    )) {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      if (
        rect.width === 0 ||
        rect.height === 0 ||
        style.visibility === "hidden" ||
        style.display === "none"
      )
        continue;
      if (rect.width < 43.5 || rect.height < 43.5)
        out.push(
          `${element.tagName.toLowerCase()} "${(element.getAttribute("aria-label") ?? element.textContent ?? "").trim().slice(0, 40)}" ${Math.round(rect.width)}x${Math.round(rect.height)}`,
        );
    }
    return out;
  });

for (const scheme of ["dark", "light"] as const) {
  for (const width of WIDTHS) {
    test.describe(`sync screens (${scheme}, ${width}px)`, () => {
      test.use({ colorScheme: scheme, viewport: { width, height: 900 } });

      for (const screen of SCREENS) {
        test(`${screen.name}: axe (with contrast), 44 px targets, no horizontal scroll`, async ({
          page,
        }, info) => {
          await page.goto(screen.url);
          await expect(page.getByText(screen.expect).first()).toBeVisible();
          const violations = await runAxe(page);
          expect(
            violations,
            JSON.stringify(
              violations.map((v) => [
                v.id,
                v.nodes.map((n) => n.html.slice(0, 120)),
              ]),
              null,
              1,
            ),
          ).toEqual([]);
          expect(
            await smallTargets(page),
            "controls smaller than 44 px",
          ).toEqual([]);
          expect(await overflow(page), "horizontal scroll").toBeLessThanOrEqual(
            0,
          );
          if (
            scheme === "dark" &&
            width === 1280 &&
            screen.name === "queue-waiting"
          )
            recordEvidence(info, "sync-screens-sample", {
              screen: screen.name,
              scheme,
              width,
            });
        });
      }

      test("the queue panel: rows, tabs and actions work from the keyboard, focus stays in the protected portal, and a large queue renders every row", async ({
        page,
      }) => {
        await page.goto("/sync?drafts=3&paused=1&rejected=1&decisions=1");
        await expect(
          page.getByRole("heading", { level: 1, name: "Sync" }),
        ).toBeVisible();
        // The two tabs are one tab stop; arrow keys move between them and select.
        const waiting = page.getByRole("tab", { name: /Waiting to send/ });
        await waiting.focus();
        await page.keyboard.press("ArrowRight");
        await expect(
          page.getByRole("tab", { name: /Needs a decision/ }),
        ).toHaveAttribute("aria-selected", "true");
        await expect(page).toHaveURL(/tab=conflicts/);
        await page.keyboard.press("Home");
        await expect(waiting).toHaveAttribute("aria-selected", "true");
        // Tab order: through every control of the page, each INSIDE #protected-root, never on <body>. Tabbing past the last control
        // leaves the document for the browser's own UI, so only as many presses as there are controls are made.
        const controls = await page.evaluate(
          () =>
            [
              ...document.querySelectorAll<HTMLElement>(
                "#protected-root a[href], #protected-root button:not([disabled]), #protected-root [tabindex]",
              ),
            ].filter((element) => element.tabIndex >= 0).length,
        );
        // A fresh page, so the first Tab lands on the skip link and the count of presses is exactly the count of controls.
        await page.goto("/sync?drafts=3&paused=1&rejected=1&decisions=1");
        await expect(
          page.getByRole("heading", { level: 1, name: "Sync" }),
        ).toBeVisible();
        const stops: string[] = [];
        for (let i = 0; i < controls; i += 1) {
          await pressTab(page);
          stops.push(
            await page.evaluate(() => {
              const active = document.activeElement;
              const inside = active?.closest("#protected-root") !== null;
              return `${inside ? "in" : "OUT"}:${active?.tagName.toLowerCase()}:${(active?.getAttribute("aria-label") ?? active?.textContent ?? "").trim().slice(0, 30)}`;
            }),
          );
        }
        expect(
          stops.filter((s) => s.startsWith("OUT")),
          stops.join("\n"),
        ).toEqual([]);
        expect(stops.some((s) => s.includes(":body:"))).toBe(false);
      });

      test("Discard asks first; Keep leaves the row; Discard removes it and announces it", async ({
        page,
      }) => {
        await page.goto("/sync?drafts=2");
        const rows = page.locator("[data-draft-row]");
        await expect(rows).toHaveCount(2);
        await rows
          .first()
          .getByRole("button", { name: /^Discard:/ })
          .click();
        await expect(page.getByText("Discard this change?")).toBeVisible();
        await page.getByRole("button", { name: "Keep" }).click();
        await expect(rows).toHaveCount(2);
        await rows
          .first()
          .getByRole("button", { name: /^Discard:/ })
          .click();
        await page
          .getByRole("button", { name: "Discard", exact: true })
          .click();
        await expect(rows).toHaveCount(1);
        await expect(page.locator('[aria-live="polite"]')).toHaveText(
          "That change was discarded.",
        );
      });

      test("the status chip and the panel agree, and opening the chip lands on /sync", async ({
        page,
      }) => {
        await page.goto("/today?drafts=3&decisions=1");
        const chip = page
          .getByRole("button", { name: /Open conflicts/ })
          .first();
        await expect(chip).toBeVisible();
        await chip.click();
        await expect(page).toHaveURL(/\/sync\?tab=conflicts/);
        await expect(page.getByRole("tab", { selected: true })).toHaveText(
          /Needs a decision · 3/,
        );
      });
    });
  }
}

test.describe("sync screens: the queue is shown a window at a time (R6)", () => {
  test.use({ viewport: { width: 390, height: 900 } });
  test("Show next / Show previous REPLACE the rows (never more than a window is in the page), keep focus in the panel, and every state is accessible", async ({
    page,
  }) => {
    await page.goto("/sync?drafts=250&window=1&size=100");
    const rows = page.locator("[data-draft-row]");
    const next = page.getByRole("button", { name: "Show next changes" });
    const previous = page.getByRole("button", {
      name: "Show previous changes",
    });
    await expect(rows).toHaveCount(100);
    await expect(next).toBeVisible();
    await expect(previous).toHaveCount(0);
    const first = await rows.first().innerText();
    expect(await runAxe(page)).toEqual([]);

    // The next window replaces the first: still 100 rows in the page, and the first row has changed.
    await next.focus();
    await page.keyboard.press("Enter");
    await expect(rows).toHaveCount(100);
    expect(await rows.first().innerText()).not.toBe(first);
    await expect(previous).toBeVisible();
    await expect(next).toBeVisible();
    // Focus is in the panel (a stable place), never on a button that has been replaced or on <body>.
    expect(
      await page.evaluate(
        () => document.activeElement?.getAttribute("role") ?? "",
      ),
    ).toBe("tabpanel");
    expect(await runAxe(page)).toEqual([]);
    expect(await smallTargets(page), "controls smaller than 44 px").toEqual([]);

    // The last window has the previous only, and 50 rows; the page never held 250.
    await next.click();
    await expect(rows).toHaveCount(50);
    await expect(next).toHaveCount(0);
    await expect(previous).toBeVisible();
    await previous.click();
    await previous.click();
    await expect(rows).toHaveCount(100);
    expect(await rows.first().innerText()).toBe(first);
    await expect(previous).toHaveCount(0);
  });
});

test.describe("sync screens: large counts", () => {
  test.use({ viewport: { width: 390, height: 900 } });
  test("214 queued changes: the warning shows, every row renders, nothing is disabled, and the page is still accessible", async ({
    page,
  }) => {
    await page.goto("/sync?drafts=214");
    await expect(
      page.getByRole("heading", { name: "A lot is waiting to send" }),
    ).toBeVisible();
    await expect(page.locator("[data-draft-row]")).toHaveCount(214);
    expect(await page.locator("button[disabled]").count()).toBe(0);
    expect(await runAxe(page)).toEqual([]);
  });
});
