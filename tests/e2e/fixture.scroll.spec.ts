import type { Locator, Page } from "@playwright/test";
import {
  evidencePath,
  expect,
  fixturePageReady,
  pressTab,
  test,
} from "./helpers";

/**
 * R5 (revision review): the navigation and the sync status stay inside the viewport while long content scrolls, at all three
 * layout modes. The rest of the shell suite uses short placeholders, so it cannot see a shell that scrolls away with a long page.
 *
 * "Long content" is a list of plain rows, each with one button, appended inside <main> by the test. It stands in for the routed
 * screens that will supply real long content (WEB-09 onwards), which do not exist yet: it is a stress fixture for the shell's
 * content slot, not evidence about those screens. Fixture-build evidence only.
 *
 * The last block ("text fields") is the third revision's R5 case: a focused 44px text input and its focus ring must be wholly
 * clear of the mobile bars, including under WebKit's native focus scrolling, which reveals the caret rather than the field.
 */

type Mode = "mobile" | "tablet" | "desktop";
interface Layout {
  mode: Mode;
  width: number;
  height: number;
}
const layouts: Layout[] = [
  { mode: "mobile", width: 390, height: 844 },
  { mode: "tablet", width: 834, height: 844 },
  { mode: "desktop", width: 1440, height: 844 },
];
/** Short windows: a landscape phone (tablet width), a short desktop window, and a landscape phone below 768px. */
const shortLayouts: Layout[] = [
  { mode: "tablet", width: 844, height: 390 },
  { mode: "desktop", width: 1280, height: 480 },
  { mode: "mobile", width: 667, height: 375 },
];
const positions = ["top", "middle", "bottom"] as const;
type Position = (typeof positions)[number];

const LONG_PAGE = "/today?phase=offline&pending=3";
const ROWS = 80;
const KEYBOARD_ROWS = 40;
/** Sub-pixel layout rounding. */
const SLACK = 0.5;

const primaryNav = (page: Page) =>
  page.getByRole("navigation", { name: "Primary" });
const syncChip = (page: Page) => page.locator("[data-sync-tone]");
const rows = (page: Page) => page.locator("[data-scroll-stress]");

/** Appends `count` plain rows to <main>, replacing any earlier set. Style is set through the CSSOM, which the policy allows. */
async function fillMain(page: Page, count: number) {
  await page.evaluate((total) => {
    const main = document.getElementById("main");
    if (!main) throw new Error("no main landmark");
    main.querySelector("[data-scroll-stress]")?.remove();
    const list = document.createElement("ul");
    list.setAttribute("data-scroll-stress", "");
    list.style.margin = "0";
    list.style.padding = "0";
    list.style.listStyle = "none";
    for (let index = 1; index <= total; index += 1) {
      const item = document.createElement("li");
      item.style.minHeight = "56px";
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = `Row ${index}`;
      item.append(button);
      list.append(item);
    }
    main.append(list);
  }, count);
}

/**
 * Today has rendered: its heading AND its screen. Labelled adaptation (WEB-10a revision 2): Today's heading is now the route's and shows at
 * once, before the lazy screen below it, so the heading alone no longer says the page has laid out; content added before the screen arrives
 * is pushed down by it (WebKit, 13 of 15). The checks after it are unchanged.
 */
async function todayRendered(page: Page) {
  await expect(
    page.getByRole("heading", { level: 1, name: "Today" }),
  ).toBeVisible();
  await expect(page.locator("[data-today-page]")).toBeVisible();
  await expect(page.locator("[data-today-loading]")).toHaveCount(0);
}

async function openWithLongContent(page: Page, layout: Layout, count = ROWS) {
  await page.setViewportSize({ width: layout.width, height: layout.height });
  await page.goto(LONG_PAGE);
  await todayRendered(page);
  await fillMain(page, count);
  // The stress content must be what makes the page long, or every check below is vacuous.
  const { scrollHeight, innerHeight } = await page.evaluate(() => ({
    scrollHeight: document.documentElement.scrollHeight,
    innerHeight: window.innerHeight,
  }));
  expect(
    scrollHeight,
    "the page is at least twice as tall as the viewport",
  ).toBeGreaterThanOrEqual(innerHeight * 2);
}

async function scrollTo(page: Page, position: Position) {
  await page.evaluate((where) => {
    const root = document.scrollingElement ?? document.documentElement;
    const max = root.scrollHeight - root.clientHeight;
    const top =
      where === "top" ? 0 : where === "middle" ? Math.round(max / 2) : max;
    root.scrollTo({ top, behavior: "instant" });
  }, position);
  // Two frames: sticky and fixed positions are resolved on the frame after the scroll.
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  const { top, max } = await page.evaluate(() => {
    const root = document.scrollingElement ?? document.documentElement;
    return { top: root.scrollTop, max: root.scrollHeight - root.clientHeight };
  });
  if (position === "top") expect(top).toBe(0);
  if (position === "middle") {
    expect(top).toBeGreaterThan(0);
    expect(top).toBeLessThan(max);
  }
  if (position === "bottom") expect(Math.ceil(top)).toBeGreaterThanOrEqual(max);
}

async function boxOf(locator: Locator, what: string) {
  const box = await locator.boundingBox();
  if (!box) throw new Error(`${what} has no box`);
  return box;
}

async function nameOf(locator: Locator) {
  return (
    (await locator.getAttribute("aria-label")) ??
    (await locator.innerText()).trim()
  );
}

/** Inside the viewport (all four edges) and the topmost element at its centre, so nothing is drawn over it. */
async function expectReachable(page: Page, locator: Locator, what: string) {
  const view = page.viewportSize();
  if (!view) throw new Error("no viewport");
  const box = await boxOf(locator, what);
  expect(box.x, `${what}: left edge`).toBeGreaterThanOrEqual(-SLACK);
  expect(box.y, `${what}: top edge`).toBeGreaterThanOrEqual(-SLACK);
  expect(box.x + box.width, `${what}: right edge`).toBeLessThanOrEqual(
    view.width + SLACK,
  );
  expect(box.y + box.height, `${what}: bottom edge`).toBeLessThanOrEqual(
    view.height + SLACK,
  );
  const topmost = await locator.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const hit = document.elementFromPoint(
      rect.left + rect.width / 2,
      rect.top + rect.height / 2,
    );
    return hit !== null && element.contains(hit);
  });
  expect(topmost, `${what}: nothing is drawn over its centre`).toBe(true);
}

/** Every primary navigation control and the sync chip. */
async function expectChromeReachable(page: Page, where: string) {
  const nav = primaryNav(page);
  const controls = [
    ...(await nav.getByRole("link").all()),
    ...(await nav.getByRole("button").all()),
    syncChip(page),
  ];
  expect(
    controls.length,
    "navigation controls and the sync chip",
  ).toBeGreaterThanOrEqual(4);
  for (const control of controls) {
    await expectReachable(page, control, `${await nameOf(control)} (${where})`);
  }
}

/** A real pointer click at the centre of the control, with no scrolling first: Playwright's own click would scroll to it. */
async function pointerClick(page: Page, locator: Locator, what: string) {
  const box = await boxOf(locator, what);
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}

const openedCount = (page: Page) =>
  page.evaluate(
    () =>
      (window as unknown as { __atlasFixture: { opened: string[] } })
        .__atlasFixture.opened.length,
  );

/** The band of the viewport that the sticky bars leave to content: from the header's bottom edge to the tab bar's top edge. */
async function contentBand(page: Page, mode: Mode) {
  const view = page.viewportSize();
  if (!view) throw new Error("no viewport");
  if (mode !== "mobile") return { top: 0, bottom: view.height };
  const header = await boxOf(page.getByRole("banner"), "header");
  const tabs = await boxOf(primaryNav(page), "tab bar");
  return { top: header.y + header.height, bottom: tabs.y };
}

for (const layout of layouts) {
  const { mode, width, height } = layout;
  test.describe(`long content, ${mode} ${width}x${height}`, () => {
    test("navigation and sync status stay in view and operable at the top, middle and bottom", async ({
      page,
    }) => {
      await openWithLongContent(page, layout);
      for (const position of positions) {
        await scrollTo(page, position);
        await expectChromeReachable(page, position);
        const before = await openedCount(page);
        await pointerClick(page, syncChip(page), `sync chip (${position})`);
        expect(await openedCount(page), `sync chip opens at ${position}`).toBe(
          before + 1,
        );
        await page.screenshot({
          path: evidencePath(`R5/${mode}-${width}x${height}-${position}.png`),
        });
      }
      // Navigation works from the bottom of the page, and the chrome is still in view on the page it reaches.
      await scrollTo(page, "bottom");
      await pointerClick(
        page,
        primaryNav(page).getByRole("link", { name: "Tasks" }),
        "Tasks link",
      );
      await expect(page).toHaveURL(/\/tasks/);
      await expectChromeReachable(page, "after navigating from the bottom");
    });

    test("content is not hidden behind the navigation at either end of the page", async ({
      page,
    }) => {
      await openWithLongContent(page, layout);
      const heading = page.getByRole("heading", { level: 1, name: "Today" });

      await scrollTo(page, "top");
      const band = await contentBand(page, mode);
      const headingBox = await boxOf(heading, "page heading");
      expect(
        headingBox.y,
        "heading starts below the header",
      ).toBeGreaterThanOrEqual(band.top - SLACK);
      if (mode !== "mobile") {
        const rail = await boxOf(
          page.getByRole("region", { name: "Workspace" }),
          "rail",
        );
        const main = await boxOf(page.locator("#main"), "main");
        expect(
          main.x,
          "main starts beside the rail, not under it",
        ).toBeGreaterThanOrEqual(rail.x + rail.width - SLACK);
      }

      await scrollTo(page, "bottom");
      const bottomBand = await contentBand(page, mode);
      const last = await boxOf(
        page.getByRole("button", { name: `Row ${ROWS}`, exact: true }),
        "last row",
      );
      expect(
        last.y + last.height,
        "the last row ends above the bottom navigation",
      ).toBeLessThanOrEqual(bottomBand.bottom + SLACK);

      // The bars are opaque, so scrolled content never shows through them.
      const bars =
        mode === "mobile"
          ? [page.getByRole("banner"), primaryNav(page)]
          : [page.getByRole("region", { name: "Workspace" })];
      for (const bar of bars) {
        const background = await bar.evaluate(
          (element) => getComputedStyle(element).backgroundColor,
        );
        expect(background).not.toBe("rgba(0, 0, 0, 0)");
        expect(background).not.toBe("transparent");
      }
    });

    test("Tab and Shift+Tab through long content never leave focus under the navigation", async ({
      page,
    }) => {
      await openWithLongContent(page, layout, KEYBOARD_ROWS);
      await scrollTo(page, "top");
      const focused = rows(page).locator("button:focus");
      const expectClear = async (label: string) => {
        await expect(focused).toHaveText(label);
        const band = await contentBand(page, mode);
        const box = await boxOf(focused, label);
        expect(box.y, `${label}: not under the header`).toBeGreaterThanOrEqual(
          band.top - SLACK,
        );
        expect(
          box.y + box.height,
          `${label}: not under the bottom navigation`,
        ).toBeLessThanOrEqual(band.bottom + SLACK);
      };
      await page.getByRole("button", { name: "Row 1", exact: true }).focus();
      await expectClear("Row 1");
      for (let row = 2; row <= KEYBOARD_ROWS; row += 1) {
        await pressTab(page);
        await expectClear(`Row ${row}`);
      }
      for (let row = KEYBOARD_ROWS - 1; row >= 1; row -= 1) {
        await pressTab(page, { shift: true });
        await expectClear(`Row ${row}`);
      }
    });

    test("the skip link stays clear of the sticky bars, and a route change from the bottom lands on the heading", async ({
      page,
    }) => {
      await openWithLongContent(page, layout);
      const skip = page.getByRole("link", { name: "Skip to main content" });
      for (const position of ["middle", "bottom"] as const) {
        await scrollTo(page, position);
        await skip.focus();
        await expectReachable(page, skip, `skip link (${position})`);
        await page.keyboard.press("Enter");
        await expect(page.locator("main")).toBeFocused();
        expect(new URL(page.url()).hash).toBe("");
      }
      // RouteFocus focuses the new heading, which sits at the top of a page the user has scrolled far away from.
      await scrollTo(page, "bottom");
      await pointerClick(
        page,
        primaryNav(page).getByRole("link", { name: "Tasks" }),
        "Tasks link",
      );
      const heading = page.getByRole("heading", { level: 1, name: "Tasks" });
      await expect(heading).toBeFocused();
      const band = await contentBand(page, mode);
      const box = await boxOf(heading, "Tasks heading");
      expect(box.y, "heading is not under the header").toBeGreaterThanOrEqual(
        band.top - SLACK,
      );
      expect(
        box.y + box.height,
        "heading is not under the bottom navigation",
      ).toBeLessThanOrEqual(band.bottom + SLACK);
    });
  });
}

for (const layout of shortLayouts) {
  const { mode, width, height } = layout;
  test.describe(`long content, short window, ${mode} ${width}x${height}`, () => {
    test("the sync status stays in view, and every destination can still be reached", async ({
      page,
    }) => {
      await openWithLongContent(page, layout);
      for (const position of positions) {
        await scrollTo(page, position);
        await expectReachable(page, syncChip(page), `sync chip (${position})`);
      }
      if (mode === "mobile") {
        const band = await contentBand(page, mode);
        expect(
          band.bottom - band.top,
          "the bars leave room for content",
        ).toBeGreaterThanOrEqual(150);
        for (const link of await primaryNav(page).getByRole("link").all()) {
          await expectReachable(page, link, await nameOf(link));
        }
        return;
      }
      // The rail cannot show every destination at this height: its navigation scrolls, and the status below it does not.
      const nav = primaryNav(page);
      expect(
        await nav.evaluate(
          (element) => element.scrollWidth <= element.clientWidth,
        ),
        "the rail navigation has no horizontal scroll",
      ).toBe(true);
      for (const link of await nav.getByRole("link").all()) {
        await link.focus();
        await expectReachable(page, link, await nameOf(link));
        await expectReachable(page, syncChip(page), "sync chip");
      }
    });
  });
}

/**
 * Text fields. WebKit reveals a focused text field's caret rectangle, not the field, so the root's scroll-padding alone left about
 * 13px of a 44px field and its ring behind the bars (chrome-insets.ts). The fields are labelled and use the shared input's own
 * classes, read from the controls gallery, so their 44px minimum height, border and padding are the shipped component's.
 */
const fieldLayouts: Layout[] = [
  { mode: "mobile", width: 390, height: 844 },
  { mode: "mobile", width: 320, height: 568 },
  { mode: "mobile", width: 667, height: 375 },
  { mode: "mobile", width: 767, height: 400 },
];
const FIELDS = 101;
const START = 50;
/** The focus ring: a 2px outline at a 2px offset (base.css). */
const RING = 4;

/**
 * The shared input's own class list, read from the controls gallery in a second page: navigating one page from the gallery to the
 * shell makes Chromium report the preloaded primary font as unused, which the console guard (rightly) rejects.
 */
async function sharedInputClasses(page: Page) {
  const gallery = await page.context().newPage();
  try {
    await gallery.goto("/__controls");
    await fixturePageReady(gallery);
    const classes = await gallery
      .getByTestId("input-canvas")
      .getAttribute("class");
    expect(classes, "the shared input's minimum height").toMatch(
      /\b(min-)?h-11\b/,
    );
    return classes ?? "";
  } finally {
    await gallery.close();
  }
}

/** Appends `count` labelled fields to <main>, each in its own row with room above and below, as a form's fields would have. */
async function fillFields(
  page: Page,
  count: number,
  tag: "input" | "textarea",
  classes: string,
) {
  await page.evaluate(
    ({ total, element, className }) => {
      const main = document.getElementById("main");
      if (!main) throw new Error("no main landmark");
      main.querySelector("[data-field-stress]")?.remove();
      const group = document.createElement("section");
      group.setAttribute("data-field-stress", "");
      for (let index = 1; index <= total; index += 1) {
        const row = document.createElement("div");
        row.style.padding = "13px 0";
        const label = document.createElement("label");
        label.htmlFor = `field-${index}`;
        label.textContent = `Field ${index}`;
        label.style.display = "block";
        const control = document.createElement(element);
        control.id = `field-${index}`;
        control.className = className;
        control.value = `Entry ${index}`;
        row.append(label, control);
        group.append(row);
      }
      main.append(group);
    },
    { total: count, element: tag, className: classes },
  );
}

async function openWithFields(
  page: Page,
  layout: Layout,
  tag: "input" | "textarea" = "input",
) {
  await page.setViewportSize({ width: layout.width, height: layout.height });
  const classes = await sharedInputClasses(page);
  await page.goto(LONG_PAGE);
  await todayRendered(page);
  await fillFields(page, FIELDS, tag, classes);
  const field = page.getByLabel(`Field ${START}`, { exact: true });
  await expect(field).toBeVisible();
  const box = await boxOf(field, "field");
  if (tag === "input")
    expect(
      box.height,
      "the field is the shared input's 44px",
    ).toBeGreaterThanOrEqual(44);
  return field;
}

/** The document has stopped scrolling: the same offset on several consecutive frames (native focus scrolling can animate). */
async function settle(page: Page) {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        let last = Number.NaN;
        let stable = 0;
        const tick = () => {
          const current = window.scrollY;
          if (current === last) stable += 1;
          else {
            stable = 0;
            last = current;
          }
          if (stable >= 8) resolve();
          else requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      }),
  );
}

/** The field's box and the whole of its focus ring lie between the bottom of the header and the top of the tab bar. */
async function expectFieldClear(page: Page, field: Locator, label: string) {
  await settle(page);
  const header = await boxOf(page.getByRole("banner"), "header");
  const tabs = await boxOf(primaryNav(page), "tab bar");
  const box = await boxOf(field, label);
  expect(
    box.y - RING,
    `${label}: its ring is not under the header`,
  ).toBeGreaterThanOrEqual(header.y + header.height - SLACK);
  expect(
    box.y + box.height + RING,
    `${label}: its ring is not under the bottom tabs`,
  ).toBeLessThanOrEqual(tabs.y + SLACK);
}

/** Scrolls the document so the field's top edge is `top` px from the top of the viewport (instant). */
async function placeField(page: Page, field: Locator, top: number) {
  const box = await boxOf(field, "field");
  await page.evaluate(
    (delta) => window.scrollBy({ top: delta, behavior: "instant" }),
    box.y - top,
  );
  await settle(page);
}

const blurFocus = (page: Page) =>
  page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());

for (const layout of fieldLayouts) {
  const { width, height } = layout;
  test.describe(`text fields, mobile ${width}x${height}`, () => {
    for (const keys of ["Tab", "pressTab"] as const) {
      test(`${keys === "Tab" ? "Tab" : "Tab (Option+Tab on macOS WebKit)"} and Shift+Tab through 44px text inputs never leave a field or its ring under a bar`, async ({
        page,
      }) => {
        const first = await openWithFields(page, layout);
        const press = (shift: boolean) =>
          keys === "Tab"
            ? page.keyboard.press(shift ? "Shift+Tab" : "Tab")
            : pressTab(page, { shift });
        await first.focus();
        await expect(first).toBeFocused();
        await expectFieldClear(page, first, `Field ${START}`);
        // The ring the geometry assumes is the ring that is drawn.
        const ring = await first.evaluate((element) => {
          const style = getComputedStyle(element);
          return (
            Number.parseFloat(style.outlineWidth) +
            Number.parseFloat(style.outlineOffset)
          );
        });
        expect(ring, "outline width plus offset").toBe(RING);

        let current = START;
        for (let step = 0; step < 6; step += 1) {
          await press(false);
          current += 1;
          const field = page.getByLabel(`Field ${current}`, { exact: true });
          await expect(field).toBeFocused();
          await expectFieldClear(page, field, `Field ${current} (forward)`);
        }
        for (let step = 0; step < 12; step += 1) {
          await press(true);
          current -= 1;
          const field = page.getByLabel(`Field ${current}`, { exact: true });
          await expect(field).toBeFocused();
          await expectFieldClear(page, field, `Field ${current} (reverse)`);
        }
      });
    }

    test("focusing or tapping a field that is partly under either bar reveals all of it", async ({
      page,
    }) => {
      const field = await openWithFields(page, layout);
      const header = await boxOf(page.getByRole("banner"), "header");
      const tabs = await boxOf(primaryNav(page), "tab bar");
      const x = (await boxOf(field, "field")).x + 20;
      // 20px of the field sticks out from beneath the bar; the rest is behind it.
      const underTabs = tabs.y - 20;
      const underHeader = header.y + header.height + 20;

      for (const [where, top] of [
        ["under the tabs", underTabs],
        [
          "under the header",
          underHeader - (await boxOf(field, "field")).height,
        ],
      ] as const) {
        await placeField(page, field, top);
        await blurFocus(page);
        await field.focus();
        await expectFieldClear(page, field, `programmatic focus, ${where}`);

        await placeField(page, field, top);
        await blurFocus(page);
        // A real tap on the visible sliver: it must be the field that is hit, not a bar.
        const y =
          where === "under the tabs"
            ? tabs.y - 10
            : header.y + header.height + 10;
        expect(
          await page.evaluate(
            ({ px, py }) => document.elementFromPoint(px, py)?.id,
            { px: x, py: y },
          ),
          `the visible part is the field (${where})`,
        ).toBe(`field-${START}`);
        await page.mouse.click(x, y);
        await expect(field).toBeFocused();
        await expectFieldClear(page, field, `tap, ${where}`);
      }
    });

    test("a multi-line field is kept clear the same way", async ({ page }) => {
      const first = await openWithFields(page, layout, "textarea");
      await first.focus();
      await expectFieldClear(page, first, `Textarea ${START}`);
      let current = START;
      for (let step = 0; step < 6; step += 1) {
        await page.keyboard.press("Tab");
        current += 1;
        const field = page.getByLabel(`Field ${current}`, { exact: true });
        await expect(field).toBeFocused();
        await expectFieldClear(page, field, `Textarea ${current} (forward)`);
      }
      for (let step = 0; step < 6; step += 1) {
        await page.keyboard.press("Shift+Tab");
        current -= 1;
        const field = page.getByLabel(`Field ${current}`, { exact: true });
        await expect(field).toBeFocused();
        await expectFieldClear(page, field, `Textarea ${current} (reverse)`);
      }
    });
  });
}
