import type { Page } from "@playwright/test";
import { expect, test } from "./helpers";
import { checkSurface, expectPaintedContrast, WIDTHS } from "./surface-checks";

/**
 * WEB-08b, A2 / A3 / A4 (Layer A, rendered): the account card (WF-SETTINGS-01), "Signing in" (WF-SETTINGS-03) and the
 * reauthenticate sign-in form, at 320, 390, 768 and 1280 px in dark and light, in each engine, from the fixture shell and its
 * canned session (query-string driven). Design and accessibility evidence only: not Kieran's visual or copy sign-off, not
 * assistive-technology evidence and not integration evidence. Screenshots (Chromium) go to .agtx/evidence/WEB-08b/design/.
 */
const EVIDENCE = ".agtx/evidence/WEB-08b/design";

interface Surface {
  name: string;
  path: string;
  region: string;
  prepare?(page: Page): Promise<void>;
  /** Undo what `prepare` did to the browser context (the connection), before the next width loads its page. */
  cleanup?(page: Page): Promise<void>;
  focusHeading?: boolean;
}

const card = (page: Page) => page.locator("[data-account-card]");
const dialog = (page: Page) => page.getByRole("dialog", { name: "Signing in" });
const loaded = async (page: Page) => {
  await dialog(page).getByLabel("Current password").waitFor();
};
const filled = async (page: Page) => {
  await loaded(page);
  await dialog(page).getByLabel("Current password").fill("old-password-1");
  await dialog(page).getByLabel("New password").fill("a-brand-new-password");
  await dialog(page).getByRole("button", { name: "Change password" }).click();
};

/** Real offline emulation, then wait for the page to have been told (the property and the event). */
const goOffline = async (page: Page) => {
  await page.context().setOffline(true);
  await expect.poll(() => page.evaluate(() => navigator.onLine)).toBe(false);
};
const goOnline = async (page: Page) => {
  await page.context().setOffline(false);
  await expect.poll(() => page.evaluate(() => navigator.onLine)).toBe(true);
};

const SURFACES: Surface[] = [
  {
    name: "account-card",
    path: "/settings?fresh=1",
    region: "main",
    prepare: async (page) => {
      await card(page).getByText("kieran").waitFor();
      await card(page)
        .getByText(/^Signed in since/)
        .waitFor();
    },
  },
  {
    name: "account-card-loading",
    path: "/settings?account=slow",
    region: "main",
    prepare: async (page) => {
      await card(page).locator("[aria-busy='true']").waitFor();
    },
  },
  {
    name: "account-card-error",
    path: "/settings?error=account",
    region: "main",
    prepare: async (page) => {
      await card(page).locator("[data-load-error]").waitFor();
    },
  },
  {
    name: "account-card-hostile",
    path: "/settings?account=hostile",
    region: "main",
    prepare: async (page) => {
      await card(page)
        .getByText("a-very-long-username", { exact: false })
        .waitFor();
    },
  },
  {
    name: "signing-in-password",
    path: "/settings/signing-in?fresh=1",
    region: "[role=dialog]",
    prepare: loaded,
  },
  {
    name: "signing-in-linked",
    path: "/settings/signing-in?account=sso&fresh=1",
    region: "[role=dialog]",
    prepare: async (page) => {
      await loaded(page);
      await dialog(page).getByText("sso.example.org").waitFor();
    },
  },
  {
    name: "signing-in-linked-stale-session",
    path: "/settings/signing-in?account=sso",
    region: "[role=dialog]",
    prepare: async (page) => {
      await loaded(page);
      await dialog(page).getByText("sso.example.org").waitFor();
      await expect(
        dialog(page).getByRole("button", { name: "Remove" }),
      ).toBeDisabled();
    },
  },
  {
    name: "signing-in-no-password",
    path: "/settings/signing-in?account=nopw&fresh=1",
    region: "[role=dialog]",
    prepare: async (page) => {
      await dialog(page)
        .getByRole("heading", { name: "No password at all?" })
        .waitFor();
    },
  },
  {
    name: "signing-in-hostile",
    path: "/settings/signing-in?account=hostile&fresh=1",
    region: "[role=dialog]",
    prepare: async (page) => {
      await loaded(page);
      await dialog(page).locator("[data-issuer]").first().waitFor();
    },
  },
  {
    name: "signing-in-unconfirmed",
    path: "/settings/signing-in?password=unconfirmed&fresh=1",
    region: "[role=dialog]",
    prepare: async (page) => {
      await filled(page);
      await dialog(page)
        .getByText(/couldn't confirm that/)
        .waitFor();
    },
  },
  {
    name: "signing-in-refused",
    path: "/settings/signing-in?password=refuse&fresh=1",
    region: "[role=dialog]",
    prepare: async (page) => {
      await filled(page);
      await dialog(page)
        .getByText("Check the details and try again.")
        .waitFor();
    },
  },
  {
    // Review R7: the connection is lost with the dialog open; the three actions are disabled with their reasons.
    name: "signing-in-offline",
    path: "/settings/signing-in?account=sso&fresh=1",
    region: "[role=dialog]",
    prepare: async (page) => {
      await loaded(page);
      await dialog(page).getByText("sso.example.org").waitFor();
      await dialog(page).getByLabel("Current password").fill("old-password-1");
      await dialog(page)
        .getByLabel("New password")
        .fill("a-brand-new-password");
      await goOffline(page);
      await expect(
        dialog(page).getByRole("button", { name: "Change password" }),
      ).toBeDisabled();
    },
    cleanup: (page) => goOnline(page),
  },
  {
    name: "signing-in-link-not-set-up",
    path: "/settings/signing-in?sso=unset&fresh=1",
    region: "[role=dialog]",
    prepare: async (page) => {
      await loaded(page);
      await dialog(page)
        .getByRole("button", { name: "Link single sign-on" })
        .click();
      await dialog(page)
        .getByText(/Single sign-on isn't set up/)
        .waitFor();
    },
  },
  {
    name: "signing-in-load-error",
    path: "/settings/signing-in?error=account",
    region: "[role=dialog]",
    prepare: async (page) => {
      await dialog(page).locator("[data-load-error]").waitFor();
    },
  },
  {
    name: "sign-in-again",
    path: "/__neutral?state=1b&form=1",
    region: "main",
    focusHeading: true,
    prepare: async (page) => {
      await page
        .getByRole("heading", { level: 1, name: "Sign in again" })
        .waitFor();
    },
  },
];

for (const scheme of ["dark", "light"] as const) {
  test.describe(`WEB-08b settings and sign-in rendered checks, ${scheme}`, () => {
    test.use({ colorScheme: scheme });
    for (const surface of SURFACES) {
      test(surface.name, async ({ page }, testInfo) => {
        const engine = testInfo.project.name.replace("fixture-", "");
        for (const [width, height] of WIDTHS) {
          await page.goto("about:blank");
          await page.setViewportSize({ width, height });
          await page.goto(surface.path);
          await surface.prepare?.(page);
          await checkSurface(page, {
            label: `${surface.name} at ${width}px, ${scheme}, ${engine}`,
            region: surface.region,
            engine,
            evidence: EVIDENCE,
            name: surface.name,
            width,
            scheme,
            focusHeading: surface.focusHeading,
          });
          await surface.cleanup?.(page);
        }
      });
    }
  });
}

test.describe("Signing in is a keyboard loop and the account card is reachable", () => {
  test("Escape closes the Signing in dialog back to Settings, and focus returns to its link", async ({
    page,
  }) => {
    await page.goto("/settings?fresh=1");
    await page.getByRole("heading", { level: 1, name: "Settings" }).waitFor();
    await page.locator('[data-settings-link="signing-in"]').click();
    await dialog(page).getByLabel("Current password").waitFor();
    await page.keyboard.press("Escape");
    await expect(dialog(page)).toHaveCount(0);
    await expect(page).toHaveURL(/\/settings$/);
    await expect(
      page.locator('[data-settings-link="signing-in"]'),
    ).toBeFocused();
  });

  test("the dialog renders inside the protected portal container, never outside it", async ({
    page,
  }) => {
    await page.goto("/settings/signing-in?fresh=1");
    await loaded(page);
    expect(
      await page.evaluate(
        () =>
          document
            .querySelector("[role=dialog]")
            ?.closest("[data-portal-root]") !== null,
      ),
    ).toBe(true);
  });

  test("the account card's Sign out opens the warning, with 'Stay logged in' focused first", async ({
    page,
  }) => {
    await page.goto("/settings?fresh=1");
    await card(page).getByRole("button", { name: "Sign out" }).click();
    await page.getByRole("dialog", { name: "Log out?" }).waitFor();
    await expect(
      page.getByRole("button", { name: "Stay logged in" }),
    ).toBeFocused();
  });
});

// WF-SETTINGS-03 (states.md, "Removed"): the sign-out-everywhere consequence is associated with Remove through
// `aria-describedby`, on mobile as well as desktop. axe does not check that the association exists (review R4).
test.describe("Remove is described by the sign-out consequence (review R4)", () => {
  for (const [name, width] of [
    ["mobile", 320],
    ["desktop", 1280],
  ] as const) {
    test(`at ${width}px (${name})`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto("/settings/signing-in?account=sso&fresh=1");
      await loaded(page);
      const remove = dialog(page).getByRole("button", {
        name: "Remove sso.example.org",
        exact: true,
      });
      await expect(remove).toBeEnabled();
      await expect(
        dialog(page).getByText("Removing this also signs you out everywhere."),
      ).toBeVisible();
      await expect(remove).toHaveAccessibleDescription(
        /Removing this also signs you out everywhere/,
      );
    });
  }
});

for (const scheme of ["dark", "light"] as const) {
  test.describe(`A-4 painted contrast in the Signing in dialog, ${scheme}`, () => {
    test.use({ colorScheme: scheme });
    test("the dialog's inputs are field-edge at 3:1 or better against the dialog and their fill; Change password is 4.5:1 or better", async ({
      page,
    }) => {
      await page.goto("/settings/signing-in?fresh=1");
      await loaded(page);
      await expectPaintedContrast(
        dialog(page).getByLabel("New password"),
        dialog(page).getByRole("button", { name: "Change password" }),
        scheme,
        `Signing in dialog (${scheme})`,
      );
    });
  });
}

// Review R6: a gateway can answer 502 after the backend committed a credential change and revoked the session, so a 5xx cannot show
// the change was not made. It enters the same unconfirmed state as a lost answer (never "try again shortly", never a refusal).
test.describe("a gateway error after a credential change is UNCONFIRMED, a refusal is not (review R6)", () => {
  test("a password change answered 502", async ({ page }) => {
    await page.goto("/settings/signing-in?password=gateway&fresh=1");
    await filled(page);
    const unconfirmed = dialog(page).locator("[data-unconfirmed]");
    await expect(unconfirmed).toBeVisible();
    await expect(unconfirmed).toContainText("We couldn't confirm that.");
    await expect(
      unconfirmed.getByRole("button", { name: "Check now" }),
    ).toBeEnabled();
    await expect(dialog(page)).not.toContainText("Try again shortly");
    await expect(dialog(page).locator("[data-error]")).toHaveCount(0);
    await expect(dialog(page).getByLabel("Current password")).toHaveValue("");
    await expect(dialog(page).getByLabel("New password")).toHaveValue("");
  });

  test("an unlink answered 502", async ({ page }) => {
    await page.goto("/settings/signing-in?account=sso&unlink=gateway&fresh=1");
    await loaded(page);
    await dialog(page)
      .getByRole("button", { name: "Remove sso.example.org", exact: true })
      .click();
    const unconfirmed = dialog(page).locator("[data-unconfirmed]");
    await expect(unconfirmed).toBeVisible();
    await expect(unconfirmed).toContainText("We couldn't confirm that.");
    await expect(dialog(page)).not.toContainText("Can't remove this identity");
    await expect(dialog(page).locator("[data-error]")).toHaveCount(0);
  });

  test("an unlink refused with 409 is still a refusal, with no unconfirmed state", async ({
    page,
  }) => {
    await page.goto("/settings/signing-in?account=sso&unlink=refuse&fresh=1");
    await loaded(page);
    await dialog(page)
      .getByRole("button", { name: "Remove sso.example.org", exact: true })
      .click();
    await expect(dialog(page)).toContainText("Can't remove this identity");
    await expect(dialog(page).locator("[data-unconfirmed]")).toHaveCount(0);
  });
});

// Review R7: credential operations need a connection, so while the browser reports none the three actions are disabled with a visible,
// described reason instead of failing on press. Real offline emulation, with the dialog already open and values already typed.
test.describe("connection-required controls are disabled while offline, and return with the connection (review R7)", () => {
  // The mobile sheet and the desktop dialog are one component: lose and regain the connection with each already open.
  for (const [name, width] of [
    ["mobile sheet", 320],
    ["desktop dialog", 1280],
  ] as const)
    test(`Change password, Remove and Link single sign-on, with the ${name} already open (${width}px)`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto("/settings/signing-in?account=sso&fresh=1");
      await loaded(page);
      await dialog(page).getByText("sso.example.org").waitFor();
      await dialog(page).getByLabel("Current password").fill("old-password-1");
      await dialog(page)
        .getByLabel("New password")
        .fill("a-brand-new-password");
      const controls = {
        change: dialog(page).getByRole("button", { name: "Change password" }),
        remove: dialog(page).getByRole("button", { name: /^Remove/ }),
        link: dialog(page).getByRole("button", { name: "Link single sign-on" }),
      };
      for (const control of Object.values(controls))
        await expect(control).toBeEnabled();

      await goOffline(page);
      const reasons = {
        change: "Changing your password needs a connection.",
        remove: "Removing a single sign-on link needs a connection.",
        link: "Linking single sign-on needs a connection.",
      } as const;
      for (const key of ["change", "remove", "link"] as const) {
        await expect(controls[key], `${key} is disabled`).toBeDisabled();
        await expect(dialog(page).getByText(reasons[key])).toBeVisible();
        await expect(controls[key]).toHaveAccessibleDescription(
          new RegExp(reasons[key]),
        );
      }
      // Remove keeps its consequence as a description beside the reason.
      await expect(controls.remove).toHaveAccessibleDescription(
        /Removing this also signs you out everywhere/,
      );
      // What was typed is kept, and nothing was sent.
      await expect(dialog(page).getByLabel("Current password")).toHaveValue(
        "old-password-1",
      );
      await expect(dialog(page).getByLabel("New password")).toHaveValue(
        "a-brand-new-password",
      );

      await goOnline(page);
      for (const key of ["change", "remove", "link"] as const) {
        await expect(controls[key], `${key} is enabled again`).toBeEnabled();
        await expect(dialog(page).getByText(reasons[key])).toHaveCount(0);
      }
      await expect(dialog(page).getByLabel("New password")).toHaveValue(
        "a-brand-new-password",
      );
    });

  test("a dialog that opens while offline is disabled from the start", async ({
    page,
  }) => {
    await page.goto("/settings?fresh=1");
    await page.getByRole("heading", { level: 1, name: "Settings" }).waitFor();
    await goOffline(page);
    await page.locator('[data-settings-link="signing-in"]').click();
    await loaded(page);
    await expect(
      dialog(page).getByRole("button", { name: "Change password" }),
    ).toBeDisabled();
    await expect(
      dialog(page).getByText("Changing your password needs a connection."),
    ).toBeVisible();
  });

  test("'Check now' waits for the connection too", async ({ page }) => {
    await page.goto("/settings/signing-in?password=unconfirmed&fresh=1");
    await filled(page);
    const unconfirmed = dialog(page).locator("[data-unconfirmed]");
    await expect(unconfirmed).toBeVisible();
    await goOffline(page);
    const check = unconfirmed.getByRole("button", { name: "Check now" });
    await expect(check).toBeDisabled();
    await expect(
      unconfirmed.getByText("Checking needs a connection."),
    ).toBeVisible();
    await goOnline(page);
    await expect(check).toBeEnabled();
  });
});

// Review R8: Remove and Link need a session younger than five minutes (less a 30 s margin). The window is a property of the clock, so
// a dialog opened soon after signing in and left open must stop offering them when it ends. The fixture's current session is created
// one minute before the page loads (`fresh=1`), so the window has about 3 min 30 s left; Playwright's clock moves time in the page.
test.describe("Remove and Link disable when the five-minute window ends with the dialog still open (review R8)", () => {
  // The whole reason, matched exactly: the Link hint ("This needs a sign-in from the last few minutes.") is always on screen.
  const STALE =
    "Needs a sign-in from the last few minutes. Sign out and in again first.";
  const reasons = (page: Page) =>
    dialog(page).getByText(STALE, { exact: true });
  const open = async (page: Page, query: string) => {
    await page.clock.install({ time: Date.now() });
    await page.goto(`/settings/signing-in?${query}`);
    await loaded(page);
    await dialog(page).getByText("sso.example.org").waitFor();
  };
  const controls = (page: Page) => ({
    remove: dialog(page).getByRole("button", { name: /^Remove/ }),
    link: dialog(page).getByRole("button", { name: "Link single sign-on" }),
  });

  // The mobile sheet and the desktop dialog are one component: let the window end with each already open.
  for (const [name, width] of [
    ["mobile sheet", 320],
    ["desktop dialog", 1280],
  ] as const)
    test(`timers run through the deadline, with the ${name} open (${width}px)`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 900 });
      await open(page, "account=sso&fresh=1");
      await dialog(page).getByLabel("Current password").fill("old-password-1");
      const { remove, link } = controls(page);
      await expect(remove).toBeEnabled();
      await expect(link).toBeEnabled();

      // 3 min of the 3 min 30 s: still inside the window.
      await page.clock.runFor(180_000);
      await expect(remove).toBeEnabled();
      await expect(link).toBeEnabled();
      await expect(reasons(page)).toHaveCount(0);

      // 3 min 40 s in all: past it, with nothing pressed and nothing reopened.
      await page.clock.runFor(40_000);
      await expect(remove).toBeDisabled();
      await expect(link).toBeDisabled();
      await expect(reasons(page)).toHaveCount(2);
      await expect(remove).toHaveAccessibleDescription(
        new RegExp(`${STALE}.*Removing this also signs you out everywhere`),
      );
      await expect(link).toHaveAccessibleDescription(STALE);
      // The dialog is the one that was open: what was typed is still there.
      await expect(dialog(page).getByLabel("Current password")).toHaveValue(
        "old-password-1",
      );
    });

  test("a device that was asleep (the clock jumps and each due timer runs once) is disabled on waking", async ({
    page,
  }) => {
    await open(page, "account=sso&fresh=1");
    const { remove, link } = controls(page);
    await expect(remove).toBeEnabled();
    await page.clock.fastForward(6 * 60_000);
    await expect(remove).toBeDisabled();
    await expect(link).toBeDisabled();
    await expect(reasons(page)).toHaveCount(2);
  });

  test("an activation after the clock has passed the deadline, before any timer ran, starts nothing and shows why", async ({
    page,
  }) => {
    // `unlink=refuse` and `sso=unset` answer a request that does start with a visible message, so a request cannot go unnoticed.
    await open(page, "account=sso&unlink=refuse&sso=unset&fresh=1");
    const { remove, link } = controls(page);
    await expect(remove).toBeEnabled();
    // The time moves; no timer is run (a hidden tab, a suspended device).
    await page.clock.setSystemTime(new Date(Date.now() + 6 * 60_000));
    await remove.click();
    await expect(reasons(page)).toHaveCount(2);
    await expect(dialog(page).locator("[data-error]")).toHaveCount(0);
    await expect(dialog(page).locator("[data-unconfirmed]")).toHaveCount(0);
    await expect(dialog(page)).not.toContainText("Can't remove this identity");
    await expect(link).toBeDisabled();
    await expect(controls(page).remove).toBeDisabled();
  });

  test("the same for Link", async ({ page }) => {
    await open(page, "account=sso&sso=unset&fresh=1");
    const { link } = controls(page);
    await expect(link).toBeEnabled();
    await page.clock.setSystemTime(new Date(Date.now() + 6 * 60_000));
    await link.click();
    await expect(reasons(page)).toHaveCount(2);
    await expect(dialog(page).locator("[data-error]")).toHaveCount(0);
    await expect(dialog(page)).not.toContainText("isn't set up");
    await expect(controls(page).link).toBeDisabled();
  });

  test("a session whose start could not be read never expires: the server decides", async ({
    page,
  }) => {
    await open(page, "account=sso&error=sessions&fresh=1");
    const { remove, link } = controls(page);
    await expect(remove).toBeEnabled();
    await page.clock.runFor(10 * 60_000);
    await expect(remove).toBeEnabled();
    await expect(link).toBeEnabled();
    await expect(reasons(page)).toHaveCount(0);
  });
});
