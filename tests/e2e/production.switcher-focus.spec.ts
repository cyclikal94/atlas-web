import type { Locator, Page } from "@playwright/test";
import { expect, test } from "./auth-helpers";
import { AuthStub } from "./auth-stub";
import { displayedAs, passwordOf, publicSignIn } from "./lifecycle-browser";

/**
 * R10 of the review of 15 October 2026 (WEB-02 accessibility.md §1.2, ia.md §3, plan §2.2): closing the account switcher returns focus to
 * the entry control that is still there, and moving between its steps never pulls focus out of the step that follows. PRODUCTION build,
 * stubbed network (AuthStub), Chromium, Firefox and WebKit at the desktop and a 390 × 844 viewport. Device emulation in desktop engines,
 * not physical iOS/Android or assistive-technology evidence.
 *
 * Entries: the desktop rail's account control (it stays, so it takes focus back), the mobile More sheet's account control (it closes with
 * the sheet, so focus returns to More, the failure the review reproduced) and Settings' persistent "Switch account". Closes: Escape and the
 * Close button on the picker; Escape on the credential step; Back from the credential step, then Close. The review's assertion messages
 * are kept as they were.
 */
const NAME = "focusreviewten";

type Entry = "rail" | "more" | "settings";
type Path = "picker-escape" | "picker-close" | "credentials-escape" | "back";

/** Signs in on the public route, then opens the picker from the entry; returns the control focus must return to. */
async function openFrom(page: Page, entry: Entry): Promise<Locator> {
  await page.goto("/");
  await publicSignIn(page, NAME);
  await displayedAs(page, NAME);
  const account = page.getByRole("button", { name: `${NAME}, switch account` });
  if (entry === "rail") {
    await account.click();
    return account;
  }
  await page.setViewportSize({ width: 390, height: 844 });
  const more = page.getByRole("button", { name: "More", exact: true });
  await more.click();
  const sheet = page.getByRole("dialog", { name: "More", exact: true });
  if (entry === "more") {
    await sheet
      .getByRole("button", { name: `${NAME}, switch account` })
      .click();
    return more;
  }
  await sheet.getByRole("link", { name: "Settings", exact: true }).click();
  const control = page
    .locator("[data-account-card]")
    .getByRole("button", { name: "Switch account", exact: true });
  await control.click();
  return control;
}

/** Lets every timer the page queued so far run (Radix returns a closed dialog's focus on one), so a theft would have happened by now. */
async function afterQueuedTimers(page: Page) {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        setTimeout(() => setTimeout(resolve, 0), 50),
      ),
  );
}

async function pickerFocused(page: Page): Promise<Locator> {
  const picker = page.getByRole("dialog", {
    name: "Switch account",
    exact: true,
  });
  await expect(picker).toBeVisible();
  await expect(picker.getByRole("listbox")).toBeFocused();
  return picker;
}

for (const entry of ["rail", "more", "settings"] as const)
  for (const path of [
    "picker-escape",
    "picker-close",
    "credentials-escape",
    "back",
  ] as const satisfies readonly Path[])
    test(`R10 switcher focus: ${entry} entry, ${path}`, async ({
      page,
      context,
    }, info) => {
      const stub = new AuthStub();
      stub.addAccount(NAME, passwordOf(NAME));
      await stub.install(context);
      const restore = await openFrom(page, entry);
      let picker = await pickerFocused(page);
      if (path !== "picker-escape" && path !== "picker-close") {
        // With no other account kept on this computer the only other row is "Add another account".
        await picker
          .getByRole("option", { name: "Add another account", exact: true })
          .click();
        const form = page.getByRole("dialog", {
          name: "Sign in to another account",
        });
        await expect(form).toBeVisible();
        await expect(page.getByLabel("Username")).toBeFocused();
        await afterQueuedTimers(page);
        await expect(
          page.getByLabel("Username"),
          "The closed picker does not take focus from the credential step",
        ).toBeFocused();
        if (path === "back") {
          await form
            .getByRole("button", { name: `Cancel — stay as ${NAME}` })
            .click();
          picker = await pickerFocused(page);
          await afterQueuedTimers(page);
          await expect(
            picker.getByRole("listbox"),
            "The closed credential step does not take focus from the picker",
          ).toBeFocused();
        }
      }
      if (path === "picker-close" || path === "back")
        await page
          .getByRole("dialog")
          .getByRole("button", { name: "Close", exact: true })
          .click();
      else await page.getByRole("dialog").press("Escape");
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await info.attach("after-close-focus", {
        body: JSON.stringify(
          await page.evaluate(() => ({
            active: document.activeElement?.outerHTML.slice(0, 300),
            rootInert: document.getElementById("protected-root")?.inert,
          })),
        ),
        contentType: "application/json",
      });
      await expect(
        restore,
        "Closing the switcher returns focus to the still-available entry control",
      ).toBeFocused();
    });
