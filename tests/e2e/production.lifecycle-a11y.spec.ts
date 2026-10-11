import type { BrowserContext, Page } from "@playwright/test";
import { test } from "./auth-helpers";
import { AuthStub } from "./auth-stub";
import { expect } from "./helpers";
import {
  allowFreeze,
  displayedAs,
  hideThenShow,
  holdableAuth,
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
 * settles, (ii) C is invalidated, or (iii) nothing changes; t3 the page is shown with the LOCAL CHECK HELD 5 s (a test-only delay of every
 * `atlas-auth` transaction's completion, injected by an init script: no product hook exists); t4 during the hold nothing protected is
 * reachable; t5 the branch's outcome and focus.
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
      inert: root?.hasAttribute("inert") ?? false,
      ariaHidden: root?.getAttribute("aria-hidden") === "true",
      focusInProtected: Boolean(active && root?.contains(active)),
      focusId: (active as HTMLElement | null)?.id ?? "",
      focusText: (active?.textContent ?? "").trim().slice(0, 60),
      statuses: [...document.querySelectorAll('[role="status"]')]
        .map((el) => (el.textContent ?? "").trim())
        .filter((text) => text.length > 0),
    };
  });

/**
 * Page one shows C's "Signing in" dialog with focus and unsaved text in its keyed field. Every OTHER page is opened first: a page that boots
 * makes every page of the origin check its session and mount its tree again (WEB-14a finding F-1), which would drop that focus and text
 * before the run begins.
 */
async function setUp(context: BrowserContext, c: string, others = 0) {
  await allowFreeze(context);
  await holdableAuth(context);
  const one = await context.newPage();
  await one.goto("/");
  await publicSignIn(one, c);
  await displayedAs(one, c);
  const pages: Page[] = [];
  for (let i = 0; i < others; i += 1) {
    const other = await context.newPage();
    await other.goto("/");
    await displayedAs(other, c);
    pages.push(other);
  }
  await displayedAs(one, c);
  await one
    .getByRole("navigation")
    .getByRole("link", { name: "Settings" })
    .first()
    .click();
  await one.getByRole("link", { name: /Signing in/ }).click();
  const field = one
    .getByRole("dialog", { name: "Signing in" })
    .getByLabel("Current password");
  await field.click();
  await field.fill("unsaved-text-4410");
  await field.evaluate((el) => el.setAttribute("data-old-tree", "C"));
  await expect(field).toBeFocused();
  return { one, pages };
}

for (const branch of ["i", "ii", "iii"] as const)
  test(`T22 (${branch}) automated counterpart: during the held local check only the gate is exposed, 'Checking your account' is announced politely, and focus ${branch === "iii" ? "returns to the keyed field of the SAME account, with what was typed" : "never returns into the old account"}`, async ({
    context,
    browserName,
    provokes,
  }) => {
    test.setTimeout(90_000);
    provokes(401);
    const c = newMarker("carol");
    const y = newMarker("yanni");
    const stub = await newStub(context, c, y);
    const { one, pages } = await setUp(context, c, 1);
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
    // t3: the local check is held 4 s (inside the 5 s cover-stall bound).
    const first = await resume({ holdAuthMs: 4_000 });
    expect(
      first.inert && first.ariaHidden,
      "t3: the first frame is inert and hidden",
    ).toBe(true);
    expect(first.reachable, "t3: nothing protected is focusable").toEqual([]);
    // t4: during the hold, Tab and Shift+Tab reach nothing protected; the tree exposes nothing of C; the polite status is the gate's.
    // Only while the gate is up: a page that already learned the outcome while hidden (it was not frozen in time, or the engine cannot freeze)
    // shows the neutral card from the first frame, and Tab inside that card is not the protected tree.
    for (const shift of first.gateOpen ? [false, true, false, false] : []) {
      await one.keyboard.press(shift ? "Shift+Tab" : "Tab");
      const now = await reach(one);
      expect(now.focusInProtected, "t4: Tab reached nothing protected").toBe(
        false,
      );
    }
    const during = await reach(one);
    expect(
      during.statuses.filter((text) =>
        /Checking your account|still belongs/.test(text),
      ).length,
    ).toBeLessThanOrEqual(1);
    expect(await one.locator("body").ariaSnapshot()).not.toContain(c);
    expect(await one.locator("body").ariaSnapshot()).not.toContain(
      "unsaved-text-4410",
    );
    expect(
      await one.evaluate(
        () => (window as unknown as { __heldAuth?: number }).__heldAuth ?? 0,
        undefined,
      ),
      "the local check was held",
    ).toBeGreaterThanOrEqual(1);
    await one.waitForTimeout(1_000);
    // t5.
    if (branch === "i") {
      // Y's tree is mounted (at the current URL: the "Signing in" route opens again, now Y's, observation O-4). Nothing of C remains, and
      // focus is not restored into C's closed form.
      await expect(one.locator("#protected-root:not([inert])")).toHaveCount(1, {
        timeout: 30_000,
      });
      await expect
        .poll(() =>
          one.evaluate(() => document.documentElement.textContent ?? ""),
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
      expect(
        await one.evaluate(
          () =>
            (document.activeElement as HTMLInputElement | null)?.value ?? "",
        ),
      ).not.toBe("unsaved-text-4410");
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
      expect((await reach(one)).inert).toBe(false);
    }
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
  expect(after.focusId).not.toBe("password-current");
});
