import { runAxe } from "../e2e/helpers";
import {
  bootHarness,
  expect,
  proxy,
  raw,
  rawSignIn,
  records,
  signIn,
  test,
  untilRecord,
  untilView,
} from "./helpers";

/**
 * I-11 and I-16 (plan 14.3): the API-version check against the real /health, and the Settings screens rendered from real data.
 */
const HEALTH = "/health";

test.describe("I-11: api_version", () => {
  const compat = (page: import("@playwright/test").Page) =>
    page.evaluate(() => window.__s.compat.get());

  test("the released backend reports 0.29.0: supported, and sign-in is offered", async ({
    context,
  }) => {
    const page = await bootHarness(context);
    await expect
      .poll(() => compat(page))
      .toMatchObject({ status: "supported", version: "0.29.0" });
    await expect(
      page.getByRole("heading", { level: 1, name: "Sign in to Atlas" }),
    ).toBeVisible();
    await expect(page.getByLabel("Username")).toBeVisible();
  });

  for (const [version, status] of [
    ["0.30.0", "unsupported"],
    ["0.28.9", "unsupported"],
  ] as const) {
    test(`a proxy that rewrites api_version to ${version}: ${status}; the compatibility screen replaces the sign-in entry`, async ({
      context,
    }) => {
      await proxy.addRule({
        method: "GET",
        path: HEALTH,
        action: "rewrite_json",
        set: { api_version: version },
      });
      const page = await bootHarness(context);
      await expect.poll(() => compat(page)).toMatchObject({ status });
      await expect(
        page.getByRole("heading", {
          level: 1,
          name: "Atlas can't work with this server yet",
        }),
      ).toBeVisible();
      await expect(page.getByLabel("Username")).toHaveCount(0);
    });
  }

  test("api_version removed: missing (also a refusal)", async ({ context }) => {
    await proxy.addRule({
      method: "GET",
      path: HEALTH,
      action: "rewrite_json",
      delete: ["api_version"],
    });
    const page = await bootHarness(context);
    await expect.poll(() => compat(page)).toMatchObject({ status: "missing" });
    await expect(
      page.getByRole("heading", {
        level: 1,
        name: "Atlas can't work with this server yet",
      }),
    ).toBeVisible();
  });

  test("a 502: unreachable, which offers nothing new and hides nothing", async ({
    context,
    provokes,
  }) => {
    provokes(502);
    await proxy.addRule({
      method: "GET",
      path: HEALTH,
      action: "rewrite_status",
      status: 502,
    });
    const page = await bootHarness(context);
    await expect.poll(() => compat(page)).toEqual({ status: "unreachable" });
    await expect(
      page.getByRole("heading", { level: 1, name: "Sign in to Atlas" }),
    ).toBeVisible();
    await expect(page.getByLabel("Username")).toBeVisible();
  });

  test("an unsupported server never hides an account that is already settled (only sign-in is gated)", async ({
    context,
  }) => {
    const first = await bootHarness(context);
    expect((await signIn(first, "bob")).kind).toBe("settled");
    await untilView(first, "displaying");
    await first.close();
    await proxy.addRule({
      method: "GET",
      path: HEALTH,
      action: "rewrite_json",
      set: { api_version: "9.9.9" },
    });
    const second = await bootHarness(context);
    await expect
      .poll(() => compat(second))
      .toMatchObject({ status: "unsupported" });
    await untilView(second, "displaying");
  });
});

test.describe("I-16: the Settings screens with real data", () => {
  test("two real sessions and the real device list render with neutral labels; axe is clean; the dialogs are inside the protected portal", async ({
    context,
    provokes,
  }) => {
    provokes(401);
    const other = await rawSignIn("alice", "second-laptop");
    const page = await bootHarness(context, "/settings/sessions");
    expect((await signIn(page, "alice")).kind).toBe("settled");
    await untilView(page, "displaying");
    const main = page.locator("main");
    await expect(
      main.getByRole("heading", { level: 1, name: "Sessions & devices" }),
    ).toBeVisible();
    await expect(main.locator("[data-session-row=current]")).toContainText(
      "This browser",
    );
    await expect(main.getByText("Another sign-in").first()).toBeVisible();
    await expect(
      main.getByText("Password · Signed in just now").first(),
    ).toBeVisible();
    await expect(main.locator("[data-device-row=current]")).toContainText(
      "This device",
    );
    await expect(main.getByText("Another device").first()).toBeVisible();
    // Nothing the contract cannot supply is invented (gaps G-1 to G-3).
    expect(await main.innerText()).not.toMatch(
      /room for|\bof 5\b|Chrome|macOS|iPhone/,
    );
    expect(await runAxe(page)).toEqual([]);

    // "Sign out" of ANOTHER session calls the ordinary operation and the row goes; the backend really removed it.
    const row = main.locator("[data-session-row=other]").first();
    await row
      .getByRole("button", { name: "Sign out this other sign-in" })
      .click();
    await expect
      .poll(
        async () =>
          (
            await raw("GET", "/browser-sessions/current", {
              cookie: other.cookie,
              headers: { "x-atlas-session": "1" },
            })
          ).status,
      )
      .toBe(401);

    // The logout dialog: a confirmation is always shown, the default is 'Stay logged in', and it is inside the portal container.
    await main
      .locator("[data-session-row=current]")
      .getByRole("button", { name: "Sign out" })
      .click();
    const dialog = page.getByRole("dialog", { name: "Log out?" });
    await expect(dialog).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Stay logged in" }),
    ).toBeFocused();
    expect(
      await dialog.evaluate((el) => el.closest("[data-portal-root]") !== null),
    ).toBe(true);
    expect(await runAxe(page)).toEqual([]);
    await page.getByRole("button", { name: "Stay logged in" }).click();
    await expect(dialog).toHaveCount(0);
  });

  test("retiring ANOTHER device (SA-10) uses the read's own token, removes it, and revokes its sessions", async ({
    context,
  }) => {
    const other = await rawSignIn("bob", "old-laptop");
    const page = await bootHarness(context, "/settings/sessions");
    expect((await signIn(page, "bob")).kind).toBe("settled");
    await untilView(page, "displaying");
    const main = page.locator("main");
    const rows = main.locator("[data-device-row]");
    await expect(rows.first()).toBeVisible();
    // The account has earlier devices from other specs: find THE row of the device this test made, by id, in the list's own order.
    const listing = await page.evaluate(async () => {
      const read = await window.__s.operations.readDevices();
      return read.ok ? read.value.devices.map((d) => d.id) : [];
    });
    const index = listing.indexOf("old-laptop");
    expect(index).toBeGreaterThanOrEqual(0);
    const before = await rows.count();
    await rows
      .nth(index)
      .getByRole("button", { name: "Retire this other device" })
      .click();
    const dialog = page.getByRole("dialog", {
      name: "Retire this other device?",
    });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Retire device" }).click();
    await expect(dialog).toHaveCount(0);
    await expect(rows).toHaveCount(before - 1);
    expect(
      (
        await raw("GET", "/browser-sessions/current", {
          cookie: other.cookie,
          headers: { "x-atlas-session": "1" },
        })
      ).status,
    ).toBe(401);
    expect((await records(page)).auth_state.settled).not.toBeNull(); // this browser's own sign-in is untouched
    await untilRecord(
      page,
      (s) => Object.keys(s.fences).length === 0,
      "no fence",
    );
  });

  test("Your data renders with the real pending count and no request of its own", async ({
    context,
  }) => {
    const page = await bootHarness(context, "/settings/data");
    expect((await signIn(page, "alice")).kind).toBe("settled");
    await untilView(page, "displaying");
    const main = page.locator("main");
    await expect(
      main.getByRole("heading", { level: 1, name: "Your data" }),
    ).toBeVisible();
    await expect(main.getByText("0 items right now")).toBeVisible();
    expect(await runAxe(page)).toEqual([]);
  });
});
