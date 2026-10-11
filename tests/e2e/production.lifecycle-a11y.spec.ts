import type { BrowserContext, Page } from "@playwright/test";
import { test } from "./auth-helpers";
import { AuthStub } from "./auth-stub";
import { expect } from "./helpers";
import {
  allowFreeze,
  displayedAs,
  hideThenShow,
  holdableAuth,
  missHintsWhileHidden,
  newMarker,
  passwordOf,
  publicSignIn,
} from "./lifecycle-browser";

/**
 * WEB-08c, the AUTOMATED counterpart of matrix T22 (`docs/accessibility.md`, "T22: the resume gate with a screen reader"), on the PRODUCTION
 * build with a STUBBED network, in Chromium, Firefox and WebKit. It is NOT assistive-technology evidence: it checks what a screen reader
 * would be given (the accessibility tree, focus, the polite status) and Tab order, not NVDA, VoiceOver or TalkBack themselves, which are the
 * manual runs of the script (OD-1).
 *
 * Setup per run: account C displays the "Signing in" dialog (a PROTECTED MODAL dialog) with keyboard focus in its keyed "Current password"
 * field and unsaved text. t0 the page is hidden; t1 frozen (Chromium; elsewhere it stays hidden); t2 in another page (i) another account
 * settles, (ii) C is invalidated, or (iii) nothing changes; t3 the page is shown with the LOCAL CHECK HELD for the approved 5 s (a
 * test-only delay of every `atlas-auth` transaction created in the window, injected by an init script, qualified by the no-hold control
 * below: no product hook exists); t4 for the whole hold only the gate is exposed and "Checking your account" is announced politely once;
 * t5 the branch's outcome, focus and (iii) scroll. R4 of the review of 11 October 2026 restored the 5 s and these assertions (an earlier
 * version held 4 s and accepted no announcement and the reopened dialog of branch i).
 */
async function newStub(context: BrowserContext, ...names: string[]) {
  const stub = new AuthStub();
  for (const name of names) stub.addAccount(name, passwordOf(name));
  await stub.install(context);
  return stub;
}

/** What keyboard and assistive technology can reach now, from inside the page. */
const reach = (page: Page) =>
  page.evaluate(() => {
    const root = document.getElementById("protected-root");
    const active = document.activeElement;
    return {
      at: performance.now(),
      gateOpen: document.querySelector("dialog#resume-gate[open]") !== null,
      inert: root?.hasAttribute("inert") ?? false,
      ariaHidden: root?.getAttribute("aria-hidden") === "true",
      focusInProtected: Boolean(active && root?.contains(active)),
      focusKey:
        (active as HTMLElement | null)
          ?.closest("[data-focus-key]")
          ?.getAttribute("data-focus-key") ?? "",
      focusTag: active?.tagName ?? "",
      focusInMainHeading: Boolean(
        active && root?.querySelector("h1") === active,
      ),
      scrollY: window.scrollY,
    };
  });

/** T22's held local check: the approved five seconds (matrix T22 t4). Never shortened. */
const T22_HOLD_MS = 5_000;

/**
 * Every text written into a polite live region or `role="status"` element (and its time), from the first script of every page: what a
 * screen reader would be given to announce.
 */
async function recordAnnouncements(context: BrowserContext) {
  await context.addInitScript(() => {
    const log: Array<{ at: number; text: string; polite: boolean }> = [];
    (window as unknown as { __announced: typeof log }).__announced = log;
    new MutationObserver((records) => {
      for (const record of records) {
        const target =
          record.target.nodeType === Node.ELEMENT_NODE
            ? (record.target as Element)
            : record.target.parentElement;
        const live = target?.closest(
          '[role="status"],[role="alert"],[aria-live]',
        );
        if (!live) continue;
        const text = (live.textContent ?? "").trim();
        if (text === "") continue;
        const polite =
          live.getAttribute("role") === "status" ||
          live.getAttribute("aria-live") === "polite";
        log.push({ at: performance.now(), text, polite });
      }
    }).observe(document, {
      subtree: true,
      childList: true,
      characterData: true,
    });
  });
}
const announcedSince = (page: Page, since: number) =>
  page.evaluate(
    (from) =>
      (
        window as unknown as {
          __announced: Array<{ at: number; text: string; polite: boolean }>;
        }
      ).__announced.filter((entry) => entry.at >= from),
    since,
  );

/**
 * Page one shows C's "Signing in" dialog with focus and unsaved text in its keyed field, over a Settings page scrolled down (so a restored
 * scroll position is observable). Every OTHER page is opened first: a page that boots makes every page of the origin check its session and
 * mount its tree again (WEB-14a finding F-1), which would drop that focus and text before the run begins.
 */
async function setUp(
  context: BrowserContext,
  c: string,
  others = 0,
  options: { dialog?: boolean } = {},
) {
  await allowFreeze(context);
  await holdableAuth(context);
  await missHintsWhileHidden(context);
  await recordAnnouncements(context);
  // The OTHER pages boot first, so one of them is the origin's sync leader and page one (the tab with the form) is not: a leader's own
  // poll, due while page one is frozen, would otherwise run at the unfreeze and learn branch (ii) from its own request before the test
  // can make the page visible (campaign 2026-10-11T12-38-28.025Z-504f2adc). Page one then learns the outcome only through the held
  // local check, as T22 describes.
  const pages: Page[] = [];
  for (let i = 0; i < others; i += 1) {
    const other = await context.newPage();
    await other.goto("/");
    pages.push(other);
  }
  const one = await context.newPage();
  await one.setViewportSize({ width: 1280, height: 280 });
  await one.goto("/");
  await publicSignIn(one, c);
  await displayedAs(one, c);
  for (const other of pages) await displayedAs(other, c);
  await displayedAs(one, c);
  await one
    .getByRole("navigation")
    .getByRole("link", { name: "Settings" })
    .first()
    .click();
  await expect(one.locator("[data-account-card]")).toBeVisible();
  // Scrolled once the page is tall enough (its rows load after the card) AND the position holds: the navigation's own completion can
  // still reset it just after the card appears (WebKit, campaign 2026-10-11T13-15-09.385Z-3b55398a), so the position must survive 500 ms.
  await expect
    .poll(
      async () => {
        await one.evaluate(() => window.scrollTo(0, 120));
        await one.waitForTimeout(500);
        return one.evaluate(() => window.scrollY);
      },
      { timeout: 15_000 },
    )
    .toBeGreaterThan(100);
  const scrollY = await one.evaluate(() => window.scrollY);
  // Without the protected modal dialog: the Settings page itself, scrolled (a modal dialog locks the window's scroll).
  if (options.dialog === false) return { one, pages, scrollY };
  await one.getByRole("link", { name: /Signing in/ }).click();
  const field = one
    .getByRole("dialog", { name: "Signing in" })
    .getByLabel("Current password");
  await field.click();
  await field.fill("unsaved-text-4410");
  await field.evaluate((el) => el.setAttribute("data-old-tree", "C"));
  await expect(field).toBeFocused();
  return { one, pages, scrollY };
}

for (const branch of ["i", "ii", "iii"] as const)
  test(`T22 (${branch}) automated counterpart: the local check held for the approved 5 s keeps only the gate exposed for the whole hold, 'Checking your account' is announced politely once, and ${branch === "i" ? "focus goes to the NEW account's main heading with one polite 'different account' line and no name" : branch === "ii" ? "focus goes to the 1b heading" : "focus, the unsaved text and the scroll position return to the SAME account's keyed field"}`, async ({
    context,
    browserName,
    provokes,
  }) => {
    test.setTimeout(90_000);
    provokes(401);
    const c = newMarker("carol");
    const y = newMarker("yanni");
    const stub = await newStub(context, c, y);
    const { one, pages, scrollY } = await setUp(context, c, 1);
    const two = pages[0] as Page;
    // t0/t1.
    const resume = await hideThenShow(one, browserName);
    const hidden = await reach(one);
    expect(hidden.inert && hidden.ariaHidden, "t0: inert and hidden").toBe(
      true,
    );
    expect(hidden.focusInProtected, "t0: focus left the protected tree").toBe(
      false,
    );
    // t2.
    if (branch === "i") {
      await two.getByRole("button", { name: `${c}, switch account` }).click();
      await two
        .getByRole("dialog", { name: "Switch account" })
        .getByRole("option")
        .last()
        .click();
      const dialog = two.getByRole("dialog", {
        name: "Sign in to another account",
      });
      await dialog.getByLabel("Username").fill(y);
      await dialog.getByLabel("Password").fill(passwordOf(y));
      await dialog
        .getByRole("button", { name: "Sign in", exact: true })
        .click();
      await displayedAs(two, y);
    } else if (branch === "ii") {
      for (const id of [...stub.sessions.keys()]) stub.sessions.delete(id);
      // Page two's next request detects it (its sync leader may get there before this click: then the navigation is already gone).
      await two
        .getByRole("navigation")
        .getByRole("link", { name: "Settings" })
        .first()
        .click({ timeout: 2_000 })
        .catch(() => undefined);
      await expect(
        two.getByRole("heading", { level: 1, name: "Reconnect to keep going" }),
      ).toBeVisible({ timeout: 20_000 });
    }
    // t3: shown, with the local check held for the approved 5 s.
    const shownAt = await one.evaluate(() => performance.now());
    const first = await resume({ holdAuthMs: T22_HOLD_MS });
    expect(
      first.inert && first.ariaHidden,
      "t3: the first frame is inert and hidden",
    ).toBe(true);
    expect(first.reachable, "t3: nothing protected is focusable").toEqual([]);
    // The page missed the hints while hidden (as a frozen tab does) and is not the sync leader, so nothing has told it the outcome: its
    // gate is up from the first frame in every branch and engine.
    expect(first.gateOpen, "t3: the gate is up").toBe(true);
    test.info().annotations.push({
      type: "t22-first-frame",
      description: JSON.stringify({ browserName, branch, ...first }),
    });
    if (first.gateOpen) {
      // t4: for the WHOLE hold, only the gate is exposed: Tab and Shift+Tab reach nothing protected, the tree exposes nothing of C.
      const keys = ["Tab", "Shift+Tab", "Tab", "Tab"];
      for (;;) {
        const now = await reach(one);
        if (now.at - shownAt >= T22_HOLD_MS - 200) break;
        expect(now.gateOpen, "t4: the gate stays up").toBe(true);
        expect(now.inert && now.ariaHidden, "t4: inert and hidden").toBe(true);
        expect(now.focusInProtected, "t4: nothing protected has focus").toBe(
          false,
        );
        const key = keys.shift();
        if (key) await one.keyboard.press(key);
        const tree = await one.locator("body").ariaSnapshot();
        expect(tree).not.toContain(c);
        expect(tree).not.toContain("unsaved-text-4410");
        await one.waitForTimeout(400);
      }
      const checking = (await announcedSince(one, shownAt)).filter(
        (entry) =>
          entry.polite &&
          entry.text === "Checking your account" &&
          entry.at - shownAt < T22_HOLD_MS,
      );
      expect(
        checking.length,
        "t4: 'Checking your account' is announced politely once",
      ).toBe(1);
    }
    expect(
      await one.evaluate(
        () => (window as unknown as { __heldAuth?: number }).__heldAuth ?? 0,
      ),
      "the local check was held",
    ).toBeGreaterThanOrEqual(1);
    // t5.
    if (branch === "i") {
      // Y's shell, at its own start (nothing of C's location survives), with focus on its main heading.
      await expect(one.locator("#protected-root:not([inert])")).toHaveCount(1, {
        timeout: 30_000,
      });
      await expect
        .poll(async () => (await reach(one)).focusInMainHeading, {
          timeout: 10_000,
        })
        .toBe(true);
      expect(new URL(one.url()).pathname).not.toMatch(/^\/settings/);
      await expect(one.getByRole("dialog", { name: "Signing in" })).toHaveCount(
        0,
      );
      // Y's verified name is drawn once its own label is read (G-9); then nothing of C is anywhere.
      await expect
        .poll(
          () => one.evaluate(() => document.documentElement.textContent ?? ""),
          { timeout: 15_000 },
        )
        .toContain(y);
      const text = await one.evaluate(
        () => document.documentElement.textContent ?? "",
      );
      expect(text).not.toContain(c);
      expect(text).not.toContain("unsaved-text-4410");
      expect(
        await one.evaluate(
          () => document.querySelector('[data-old-tree="C"]') === null,
        ),
        "C's tree is gone",
      ).toBe(true);
      await expect
        .poll(async () =>
          (await announcedSince(one, shownAt)).filter(
            (entry) =>
              entry.polite &&
              entry.text === "This window now shows a different account.",
          ),
        )
        .toHaveLength(1);
      const spoken = (await announcedSince(one, shownAt)).map((e) => e.text);
      expect(spoken.join(" | ")).not.toContain(y);
      expect(spoken.join(" | ")).not.toContain(c);
    } else if (branch === "ii") {
      const heading = one.getByRole("heading", {
        level: 1,
        name: "Reconnect to keep going",
      });
      await expect(heading).toBeVisible({ timeout: 30_000 });
      await expect(heading).toBeFocused({ timeout: 10_000 });
      expect(
        await one.evaluate(() => document.documentElement.textContent ?? ""),
      ).not.toContain("unsaved-text-4410");
    } else {
      const field = one
        .getByRole("dialog", { name: "Signing in" })
        .getByLabel("Current password");
      await expect(field).toBeFocused({ timeout: 30_000 });
      await expect(field).toHaveValue("unsaved-text-4410");
      const after = await reach(one);
      expect(after.inert).toBe(false);
      expect(after.focusKey).toBe("password-current");
      // No extra announcement on a lift (3.7.2 step 3): nothing about an account is written after the hold.
      expect(
        (await announcedSince(one, shownAt))
          .filter((entry) => entry.at - shownAt >= T22_HOLD_MS)
          .map((entry) => entry.text)
          .filter((text) => /account/i.test(text)),
      ).toEqual([]);
    }
    test.info().annotations.push({
      type: "t22-missed-hints",
      description: String(
        await one.evaluate(
          () =>
            (window as unknown as { __missedHints?: number }).__missedHints ??
            0,
        ),
      ),
    });
    void scrollY;
  });

test("T22 (iii) scroll: the same account's page, scrolled, with the local check held for the approved 5 s: the gate stays up for the whole hold and the scroll position is restored", async ({
  context,
  browserName,
}) => {
  test.setTimeout(60_000);
  const c = newMarker("carol");
  await newStub(context, c);
  const { one, scrollY } = await setUp(context, c, 0, { dialog: false });
  expect(scrollY, "the Settings page is scrolled").toBeGreaterThan(0);
  const resume = await hideThenShow(one, browserName);
  const shownAt = await one.evaluate(() => performance.now());
  const first = await resume({ holdAuthMs: T22_HOLD_MS });
  expect(first.gateOpen).toBe(true);
  for (;;) {
    const now = await reach(one);
    if (now.at - shownAt >= T22_HOLD_MS - 200) break;
    expect(now.gateOpen, "the gate stays up").toBe(true);
    await one.waitForTimeout(400);
  }
  await expect(one.locator("#protected-root:not([inert])")).toHaveCount(1, {
    timeout: 30_000,
  });
  // Within a pixel: an engine may report the restored position with a sub-pixel remainder (Firefox: 120.2 for 120).
  await expect
    .poll(async () => Math.abs((await reach(one)).scrollY - scrollY), {
      timeout: 5_000,
    })
    .toBeLessThanOrEqual(1);
  expect((await reach(one)).focusInProtected).toBe(true);
});

test("T22 hook qualification (control): the same resume with NO hold lifts at once, so the 5 s gate above is the held local check's", async ({
  context,
  browserName,
}) => {
  test.setTimeout(60_000);
  const c = newMarker("carol");
  await newStub(context, c);
  const { one } = await setUp(context, c);
  const resume = await hideThenShow(one, browserName);
  const shownAt = await one.evaluate(() => performance.now());
  const first = await resume({ holdAuthMs: 0 });
  expect(first.gateOpen).toBe(true);
  const field = one
    .getByRole("dialog", { name: "Signing in" })
    .getByLabel("Current password");
  await expect(field).toBeFocused({ timeout: 2_000 });
  const lifted = await reach(one);
  expect(lifted.gateOpen).toBe(false);
  expect(lifted.at - shownAt, "lifted well inside the 5 s hold").toBeLessThan(
    T22_HOLD_MS / 2,
  );
  expect(
    await one.evaluate(
      () => (window as unknown as { __heldAuth?: number }).__heldAuth ?? 0,
    ),
  ).toBe(0);
});

test("O-3: a local check held BEYOND the kernel's 5 s cover-stall bound is a stalled store: it fails closed (nothing protected is exposed at any point) and the account is displayed again through a new exposure; focus is not restored into the closed tree", async ({
  context,
  browserName,
}) => {
  test.setTimeout(90_000);
  const c = newMarker("carol");
  await newStub(context, c);
  const { one } = await setUp(context, c);
  const resume = await hideThenShow(one, browserName);
  const first = await resume({ holdAuthMs: 5_500 });
  expect(first.inert && first.ariaHidden).toBe(true);
  const samples: Array<{ inert: boolean; focusInProtected: boolean }> = [];
  for (let i = 0; i < 12; i += 1) {
    samples.push(await reach(one));
    await one.waitForTimeout(500);
  }
  expect(samples.every((now) => now.inert || !now.focusInProtected)).toBe(true);
  await expect(one.locator("#protected-root:not([inert])")).toHaveCount(1, {
    timeout: 30_000,
  });
  const after = await reach(one);
  test
    .info()
    .annotations.push({ type: "o-3", description: JSON.stringify(after) });
  // CORRECTED (R4 of the review of 11 October 2026): this compared the focused element's DOM id with "password-current", which is the
  // field's `data-focus-key`, so it could never fail. It now checks the keyed control and the unsaved text.
  expect(after.focusKey).not.toBe("password-current");
  expect(
    await one.evaluate(() => document.documentElement.textContent ?? ""),
  ).not.toContain("unsaved-text-4410");
});
