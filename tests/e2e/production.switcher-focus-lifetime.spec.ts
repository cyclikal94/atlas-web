import type { ElementHandle, Locator, Page } from "@playwright/test";
import { expect, test } from "./auth-helpers";
import { AuthStub } from "./auth-stub";
import {
  displayedAs,
  newMarker,
  passwordOf,
  publicSignIn,
} from "./lifecycle-browser";

/**
 * DA-F1 of the design assessment of 15 October 2026 (`switcher-mobile-focus-return`, an incomplete fix of R10): the switch flow can outlive
 * the DOM element that opened it. Closing the switcher must return focus to the entry control of the SAME account that is in the page NOW
 * (WEB-02 accessibility.md §1.2, ia.md §3 "focus returns to the control that opened it"), not to a removed element (focus would fall to the
 * body). PRODUCTION build, stubbed network (AuthStub), Chromium, Firefox and WebKit; device emulation in desktop engines only.
 *
 * Schedule A (S6): the layout changes while the flow is open, so the navigation that held the entry is replaced (mobile More ↔ the rail).
 * Schedule B (S9): a switch refused at its ACTIVATION returns the outgoing account in a NEW protected tree with the flow kept (its refusal
 * shown in the credential step), so every element of the old tree is gone. Controls: the width changes without replacing the entry (the
 * Settings control and the desktop → tablet rail), and a refusal at the EXCHANGE, which leaves the tree in place.
 *
 * Each case first establishes its precondition (the original entry element is or is not disconnected) before it asserts focus, so a case
 * that did not reach its schedule fails at the precondition, never as a focus verdict.
 */
const API = "/api/experimental/v1/browser-sessions";

const DESKTOP = { width: 1280, height: 900 };
const TABLET = { width: 900, height: 900 };
const MOBILE = { width: 390, height: 844 };

type Entry = "rail" | "more" | "settings";

async function signedIn(page: Page, name: string) {
  await page.setViewportSize(DESKTOP);
  await page.goto("/");
  await publicSignIn(page, name);
  await displayedAs(page, name);
}

/**
 * The entry controls, found whether or not the page behind a dialog is inert (a modal makes it inert; the rail's account control sits
 * outside its navigation landmark, and with the More sheet closed it is the only control of that name).
 */
const railControl = (page: Page, name: string) =>
  page.getByRole("button", {
    name: `${name}, switch account`,
    exact: true,
    includeHidden: true,
  });
const moreButton = (page: Page) =>
  page.getByRole("button", { name: "More", exact: true, includeHidden: true });
const settingsControl = (page: Page) =>
  page.locator("[data-account-card]").getByRole("button", {
    name: "Switch account",
    exact: true,
    includeHidden: true,
  });

/** Opens the picker from the entry at the current width; returns the element focus must return to while nothing is replaced. */
async function openFrom(
  page: Page,
  name: string,
  entry: Entry,
): Promise<Locator> {
  if (entry === "rail") {
    await railControl(page, name).click();
    return railControl(page, name);
  }
  if (entry === "more") {
    await moreButton(page).click();
    await page
      .getByRole("dialog", { name: "More", exact: true })
      .getByRole("button", { name: `${name}, switch account` })
      .click();
    return moreButton(page);
  }
  await settingsControl(page).click();
  return settingsControl(page);
}

async function openSettingsPage(page: Page) {
  await page
    .getByRole("navigation")
    .getByRole("link", { name: "Settings" })
    .first()
    .click();
  await expect(page.locator("[data-account-card]")).toBeVisible({
    timeout: 30_000,
  });
}

async function pickerOpen(page: Page) {
  const picker = page.getByRole("dialog", {
    name: "Switch account",
    exact: true,
  });
  await expect(picker).toBeVisible();
  await expect(picker.getByRole("listbox")).toBeFocused();
  return picker;
}

async function toCredentials(page: Page) {
  const picker = await pickerOpen(page);
  await picker.getByRole("option").last().click();
  const form = page.getByRole("dialog", {
    name: "Sign in to another account",
  });
  await expect(form).toBeVisible();
  await expect(form.getByLabel("Username")).toBeFocused();
  return form;
}

const connected = (handle: ElementHandle) =>
  handle.evaluate((element) => element.isConnected);

/** What holds focus after the close, for the failure message (never a value: the element's tag, its label and the start of its text). */
async function focusNow(page: Page): Promise<string> {
  return JSON.stringify(
    await page.evaluate(() => {
      const active = document.activeElement;
      return {
        tag: active?.tagName ?? null,
        label: active?.getAttribute("aria-label") ?? null,
        text: active?.textContent?.slice(0, 60) ?? null,
        rootInert: document.getElementById("protected-root")?.inert ?? null,
      };
    }),
  );
}

async function closeWithEscape(page: Page) {
  await page.getByRole("dialog").press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.locator("#protected-root:not([inert])")).toHaveCount(1);
}

/** Schedule A: the entry's navigation is replaced while the flow is open, at the picker or the credential step. */
const replacements = [
  { entry: "more", from: MOBILE, to: DESKTOP, destination: "rail" },
  { entry: "rail", from: DESKTOP, to: MOBILE, destination: "more" },
] as const;

for (const { entry, from, to, destination } of replacements)
  for (const step of ["picker", "credentials"] as const)
    test(`DA-F1 S6: ${entry} entry at ${from.width} px, the layout changes to ${to.width} px at the ${step} step, Escape: focus returns to the account entry of the new layout (${destination === "rail" ? "the rail's account control" : "More"})`, async ({
      page,
      context,
    }) => {
      const name = newMarker("lifetime");
      const stub = new AuthStub();
      stub.addAccount(name, passwordOf(name));
      await stub.install(context);
      await signedIn(page, name);
      await page.setViewportSize(from);
      const opener = await openFrom(page, name, entry);
      const original = await opener.elementHandle();
      if (!original) throw new Error("the entry control was not found");
      if (step === "picker") await pickerOpen(page);
      else await toCredentials(page);
      await page.setViewportSize(to);
      const target =
        destination === "rail" ? railControl(page, name) : moreButton(page);
      await expect(target).toBeAttached();
      expect(
        await connected(original),
        "precondition: the control that opened the flow was removed with its navigation",
      ).toBe(false);
      await expect(page.getByRole("dialog")).toHaveCount(1);
      await closeWithEscape(page);
      await expect(
        target,
        `Closing the switcher returns focus to the account entry that is in the page now (after the close: ${await focusNow(page)})`,
      ).toBeFocused();
    });

/** Controls for schedule A: the width changes but the entry control stays in the page, so it takes focus back itself. */
const keeps = [
  { entry: "settings", from: MOBILE, to: DESKTOP },
  { entry: "rail", from: DESKTOP, to: TABLET },
] as const;

for (const { entry, from, to } of keeps)
  test(`DA-F1 S6 control: ${entry} entry at ${from.width} px, the width changes to ${to.width} px at the picker, Escape: the same control, still in the page, takes focus back`, async ({
    page,
    context,
  }) => {
    const name = newMarker("lifetime");
    const stub = new AuthStub();
    stub.addAccount(name, passwordOf(name));
    await stub.install(context);
    await signedIn(page, name);
    if (entry === "settings") await openSettingsPage(page);
    await page.setViewportSize(from);
    const opener = await openFrom(page, name, entry);
    const original = await opener.elementHandle();
    if (!original) throw new Error("the entry control was not found");
    await pickerOpen(page);
    await page.setViewportSize(to);
    await expect(page.getByRole("dialog")).toHaveCount(1);
    expect(
      await connected(original),
      "precondition: the control that opened the flow is still in the page",
    ).toBe(true);
    await closeWithEscape(page);
    await expect(
      opener,
      `Closing the switcher returns focus to the still-available entry control (after the close: ${await focusNow(page)})`,
    ).toBeFocused();
    expect(
      await original.evaluate((element) => element === document.activeElement),
      "the very element that opened the flow",
    ).toBe(true);
  });

/**
 * Schedule B: the switch to another account is refused at the ACTIVATION with the supported definitive `503 device_capacity`, answered
 * before the stub processes it (as E-L11b). The outgoing account renders again in a NEW tree with the refusal in the credential step;
 * Escape closes the flow. The exchange refusal is the control: the tree is never replaced.
 */
for (const entry of ["rail", "more", "settings"] as const)
  for (const stage of ["exchange", "activation"] as const)
    test(`DA-F1 S9${stage === "exchange" ? " control" : ""}: ${entry} entry, a switch refused at the ${stage}, Escape after the refusal: focus returns to the ${entry === "more" ? "More button" : entry === "rail" ? "rail's account control" : "Settings control"} of the displayed tree`, async ({
      page,
      context,
      provokes,
    }) => {
      provokes(503);
      const a = newMarker("alice");
      const b = newMarker("bobby");
      const stub = new AuthStub();
      stub.addAccount(a, passwordOf(a));
      stub.addAccount(b, passwordOf(b));
      await stub.install(context);
      await signedIn(page, a);
      if (entry === "settings") await openSettingsPage(page);
      if (entry === "more") await page.setViewportSize(MOBILE);
      const original = stub.cookie;
      let refused = 0;
      await page.route(
        `**${stage === "exchange" ? API : `${API}/activate`}`,
        async (route) => {
          if (route.request().method() !== "POST") return route.fallback();
          refused += 1;
          await route.fulfill({
            status: 503,
            contentType: "application/json",
            body: JSON.stringify({
              code: "device_capacity",
              message: "device_capacity",
              request_id: "req-da-f1",
              details: [],
            }),
          });
        },
      );
      const opener = await openFrom(page, a, entry);
      const old = await opener.elementHandle();
      if (!old) throw new Error("the entry control was not found");
      const form = await toCredentials(page);
      await form.getByLabel("Username").fill(b);
      await form.getByLabel("Password").fill(passwordOf(b));
      await form.getByRole("button", { name: "Sign in", exact: true }).click();
      await expect.poll(() => refused).toBe(1);
      const back = page.getByRole("dialog", {
        name: "Sign in to another account",
      });
      await expect(back).toContainText(
        "This device has too many active sign-ins for this account.",
        { timeout: 15_000 },
      );
      await expect(page.locator("#protected-root:not([inert])")).toHaveCount(
        1,
        { timeout: 15_000 },
      );
      expect(stub.cookie, "nothing changed").toBe(original);
      expect(
        await connected(old),
        stage === "exchange"
          ? "precondition: a refused exchange leaves the tree (and the entry control) in place"
          : "precondition: the refused activation returned the account in a NEW tree (the old entry control is gone)",
      ).toBe(stage === "exchange");
      await closeWithEscape(page);
      // At 390 px the account control is inside the closed More sheet: A's displayed tree is shown by its More button instead.
      if (entry === "more")
        await expect(
          page.locator("#protected-root:not([inert])").getByRole("button", {
            name: "More",
            exact: true,
          }),
        ).toBeVisible();
      else await displayedAs(page, a);
      await expect(
        opener,
        `Closing the switcher returns focus to the entry control of the tree that is displayed (after the close: ${await focusNow(page)})`,
      ).toBeFocused();
    });
