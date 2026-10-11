import type { Page } from "@playwright/test";
import { runAxe } from "../e2e/helpers";
import {
  API,
  bootHarness,
  engineLabel,
  expect,
  exposeSession,
  proxy,
  raw,
  rawSignIn,
  signIn,
  test,
  untilHeld,
  untilView,
} from "./helpers";

/**
 * I-8d (WEB-08d, plan section 7): recognisable sessions and devices, device names and both capacities against the RELEASED BE-Q25
 * backend (v0.28.0-rc.1, API 0.28.0) behind the delaying proxy, in each engine. Legacy (pre-0.28) rows cannot be made on a fresh 0.28
 * database, so their fallbacks are fixture-only evidence (fixture.session-labels.spec.ts L-2), stated as such.
 */
const FIREFOX_WINDOWS =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:131.0) Gecko/20100101 Firefox/131.0";
/** No Playwright engine presents itself as this, so its row is unique in every engine. */
const SAMSUNG_ANDROID =
  "Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/25.0 Chrome/121.0.0.0 Mobile Safari/537.36";
const SAFARI_IPHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
const NAME_PATH = "/^\\/api\\/experimental\\/v1\\/devices\\/[^/]+\\/name$/";
const isolate = (text: string) => `\u2068${text}\u2069`;

interface Listed {
  sessions: Array<Record<string, unknown>>;
  session_capacity: {
    limit: number | null;
    used: number;
    remaining: number | null;
  };
}
interface Devices {
  devices: Array<Record<string, unknown> & { id: string; current: boolean }>;
  sync_capacity: {
    limit: number | null;
    used: number;
    remaining: number | null;
  };
}
const sessionsOf = (page: Page) =>
  page.evaluate(async () => {
    const read = await window.__retry(() =>
      window.__s.operations.listSessions(),
    );
    if (!read.ok) throw new Error(`listSessions: ${read.error}`);
    return read.value;
  }) as unknown as Promise<Listed>;
const devicesOf = (page: Page) =>
  page.evaluate(async () => {
    const read = await window.__retry(() =>
      window.__s.operations.readDevices(),
    );
    if (!read.ok) throw new Error(`readDevices: ${read.error}`);
    return read.value;
  }) as unknown as Promise<Devices>;
const nameDevice = (page: Page, id: string, name: string | null) =>
  page.evaluate(
    ([target, value]) =>
      window.__retry(() => window.__s.operations.nameDevice(target, value)),
    [id, name] as const,
  );

async function settled(
  context: import("@playwright/test").BrowserContext,
  who: Parameters<typeof signIn>[1],
) {
  const page = await bootHarness(context, "/settings/sessions");
  expect((await signIn(page, who)).kind).toBe("settled");
  await untilView(page, "displaying");
  await page.locator("[data-capacity=devices]").waitFor();
  return page;
}

test.describe("I-8d: BE-Q25 labels, names and capacities against the released backend", () => {
  test("I-8d-1: this engine's own activation is labelled with its real browser and platform; a second sign-in is told apart by its label", async ({
    context,
  }, testInfo) => {
    await rawSignIn("carol", "carol-android", { userAgent: SAMSUNG_ANDROID });
    const page = await settled(context, "carol");
    const own = engineLabel(
      testInfo.project.name,
      await page.evaluate(() => navigator.userAgent),
    );
    const main = page.locator("main");
    await expect(main.locator("[data-session-row=current]")).toContainText(own);
    await expect(
      main.locator("[data-session-row=current] [data-current-tag]"),
    ).toHaveText("This browser");
    await expect(
      main.locator("[data-session-row=other]", {
        hasText: "Samsung Internet on Android",
      }),
    ).toHaveCount(1);
    await expect(
      main.locator("[data-device-row]", {
        hasText: "Samsung Internet on Android",
      }),
    ).toHaveCount(1);
    await expect(main.locator("[data-device-row=current]")).toContainText(own);
    // The wire values themselves: the contract's closed browser and platform, never a raw User-Agent.
    const listed = await sessionsOf(page);
    expect(listed.sessions.find((s) => s.current)?.client).toMatchObject({
      channel: "browser",
    });
    expect(JSON.stringify(listed)).not.toContain("Mozilla/5.0");
  });

  test("I-8d-2 and I-8d-5: two devices named through the screen are told apart; clearing is idempotent; a rename does not stale a retirement, which forgets the name", async ({
    context,
  }) => {
    await rawSignIn("dave", "dave-phone-a", { userAgent: SAFARI_IPHONE });
    await rawSignIn("dave", "dave-phone-b", { userAgent: SAFARI_IPHONE });
    const page = await settled(context, "dave");
    const main = page.locator("main");
    // Two devices with the same label: the hint, then a name for each through the dialog.
    await expect(main.locator("[data-duplicate-hint]")).toBeVisible();
    for (const [index, name] of [
      [0, "Kitchen iPhone"],
      [1, "Hall iPhone"],
    ] as const) {
      await main
        .locator("[data-device-row=other]", {
          hasText: "Safari on iOS",
          // A row already named also shows its label on its metadata line: pick an UNNAMED one.
          hasNot: page.locator("bdi[data-device-name]"),
        })
        .first()
        .getByRole("button", { name: /^Name / })
        .click();
      const dialog = page.getByRole("dialog");
      await dialog.getByLabel("Device name").fill(name);
      await dialog.getByRole("button", { name: "Save name" }).click();
      await expect(dialog).toHaveCount(0);
      await expect(
        main.locator("bdi[data-device-name]", { hasText: name }),
      ).toHaveCount(1);
      expect(index).toBeGreaterThanOrEqual(0);
    }
    await expect(main.locator("[data-duplicate-hint]")).toHaveCount(0);
    expect(await runAxe(page)).toEqual([]);
    const devices = await devicesOf(page);
    const kitchen = devices.devices.find((d) => d.name === "Kitchen iPhone");
    const hall = devices.devices.find((d) => d.name === "Hall iPhone");
    expect(kitchen && hall).toBeTruthy();
    if (!kitchen || !hall) return;
    // The sessions list carries the same name as each session's device_name.
    const sessions = await sessionsOf(page);
    expect(sessions.sessions.map((s) => s.device_name)).toEqual(
      expect.arrayContaining(["Kitchen iPhone", "Hall iPhone"]),
    );
    // Clearing twice is idempotent.
    expect(await nameDevice(page, hall.id, null)).toEqual({
      ok: true,
      value: "cleared",
    });
    expect(await nameDevice(page, hall.id, null)).toEqual({
      ok: true,
      value: "cleared",
    });
    // A rename between the read and the retirement: the token is unchanged and the retirement applies.
    expect(await nameDevice(page, kitchen.id, "Renamed kitchen")).toEqual({
      ok: true,
      value: "named",
    });
    const after = (await devicesOf(page)).devices.find(
      (d) => d.id === kitchen.id,
    );
    expect(after?.state_token).toBe(kitchen.state_token);
    const retired = await page.evaluate(
      (row) =>
        window.__retry(() =>
          window.__s.operations.retireOtherDevice(
            row as unknown as Parameters<
              typeof window.__s.operations.retireOtherDevice
            >[0],
          ),
        ),
      kitchen,
    );
    expect(retired).toEqual({ ok: true, value: "confirmed_applied" });
    // The retired device is no longer listed, so naming it is `gone` (404 not_found).
    expect(await nameDevice(page, kitchen.id, "Ghost")).toEqual({
      ok: true,
      value: "gone",
    });
  });

  test("I-8d-3: hostile names are stored verbatim and rendered as text; a bidi name is refused before sending; the server's 422 for it is real", async ({
    context,
    provokes,
  }) => {
    provokes(422);
    await rawSignIn("erin", "erin-laptop", { userAgent: FIREFOX_WINDOWS });
    const page = await settled(context, "erin");
    const main = page.locator("main");
    const target = (await devicesOf(page)).devices.find(
      (d) => d.id === "erin-laptop",
    );
    if (!target) throw new Error("no erin-laptop");
    for (const name of [
      "<script>alert(1)</script>",
      "\u{1F600}".repeat(64),
      "\u{1F468}\u200D\u{1F469}\u200D\u{1F467} tablet",
    ]) {
      expect(await nameDevice(page, target.id, name)).toEqual({
        ok: true,
        value: "named",
      });
      expect(
        (await devicesOf(page)).devices.find((d) => d.id === target.id)?.name,
      ).toBe(name);
    }
    // The screen reloads on its own only after its own changes: open it afresh to render the stored name.
    await page.goto("/__session?route=%2Fsettings%2Fsessions");
    await exposeSession(page);
    await expect(
      main.locator("bdi[data-device-name]", { hasText: "tablet" }),
    ).toHaveCount(1);
    await expect(main.locator("script, img")).toHaveCount(0);
    // A bidi override is refused by the screen: nothing is sent.
    const before = (await proxy.log()).filter((e) =>
      /\/name$/.test(e.path),
    ).length;
    await main
      .locator("[data-device-row]", { hasText: "tablet" })
      .getByRole("button", { name: /^Rename / })
      .click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Device name").fill("evil\u202Etxt");
    await dialog.getByRole("button", { name: "Save name" }).click();
    await expect(
      dialog.getByText(
        "Remove the hidden or control characters from the name.",
      ),
    ).toBeVisible();
    expect(
      (await proxy.log()).filter((e) => /\/name$/.test(e.path)).length,
    ).toBe(before);
    // The same value sent directly is refused by the released server itself: 422 invalid_value.
    expect(await nameDevice(page, target.id, "evil\u202Etxt")).toMatchObject({
      ok: false,
      error: "http",
      status: 422,
      atlasError: { code: "invalid_value" },
    });
  });

  test("I-8d-4: session capacity counts the listed sessions and follows sign-in and sign-out; sync capacity is the server's own and is not the device count", async ({
    context,
  }) => {
    const page = await settled(context, "frank");
    const first = await sessionsOf(page);
    expect(first.session_capacity.used).toBe(first.sessions.length);
    expect(first.session_capacity.limit).toEqual(expect.any(Number));
    expect(first.session_capacity.remaining).toBe(
      Math.max(
        (first.session_capacity.limit ?? 0) - first.session_capacity.used,
        0,
      ),
    );
    const other = await rawSignIn("frank", "frank-second", {
      userAgent: FIREFOX_WINDOWS,
    });
    const raised = await sessionsOf(page);
    expect(raised.session_capacity.used).toBe(first.session_capacity.used + 1);
    // The screen shows the server's numbers (read again on reload).
    await page.goto("/__session?route=%2Fsettings%2Fsessions");
    await exposeSession(page);
    const main = page.locator("main");
    await expect(main.locator("[data-capacity=sessions]")).toHaveText(
      `${raised.session_capacity.used} of ${raised.session_capacity.limit} sign-ins in use.`,
    );
    const devices = await devicesOf(page);
    // Devices that only have sessions hold no place for syncing: the listed devices outnumber the places in use.
    expect(devices.devices.length).toBeGreaterThan(devices.sync_capacity.used);
    await expect(main.locator("[data-capacity=devices]")).toHaveText(
      `${devices.sync_capacity.used} of ${devices.sync_capacity.limit} places for syncing in use.`,
    );
    // Signing the other session out lowers the count.
    expect(
      (
        await raw("DELETE", `/sessions/${other.sessionId}`, {
          cookie: other.cookie,
          headers: { "x-csrf-token": other.csrf },
        })
      ).status,
    ).toBeLessThan(500);
    const lowered = await sessionsOf(page);
    expect(lowered.session_capacity.used).toBe(first.session_capacity.used);
  });

  test("I-8d-6: a naming answer held across a sign-in as another account is refused (`closed`); nothing is announced and the other account sees nothing of it", async ({
    context,
  }) => {
    await rawSignIn("grace", "grace-laptop", { userAgent: FIREFOX_WINDOWS });
    const page = await settled(context, "grace");
    const rule = await proxy.addRule({
      method: "PUT",
      path: NAME_PATH,
      action: "hold",
      ordinal: 1,
    });
    await page.evaluate(() => {
      window.__t.named = "pending";
      void window.__s.operations
        .nameDevice("grace-laptop", "Grace's secret laptop")
        .then((result) => {
          window.__t.named = result;
        });
    });
    await untilHeld(rule.id);
    expect((await signIn(page, "heidi")).kind).toBe("settled");
    await untilView(page, "displaying");
    await proxy.release(rule.id);
    await expect
      .poll(() => page.evaluate(() => window.__t.named))
      .toEqual({ ok: false, error: "closed" });
    const polite = await page
      .locator("[aria-live=polite]")
      .first()
      .textContent()
      .catch(() => "");
    expect(polite ?? "").not.toContain("Name saved");
    const heidi = await devicesOf(page);
    expect(JSON.stringify(heidi)).not.toContain("Grace's secret laptop");
    expect(JSON.stringify(await sessionsOf(page))).not.toContain("Grace");
    expect(API).toContain("/api/experimental/v1");
    expect(isolate("x")).toBe("\u2068x\u2069");
  });
  test("I-8d-7 (review R1): a change made in one list is shown in the other, for never-synced and synced devices; naming is the control", async ({
    context,
  }) => {
    await rawSignIn("ivan", "ivan-tablet", { userAgent: SAMSUNG_ANDROID });
    await rawSignIn("ivan", "ivan-phone", { userAgent: SAFARI_IPHONE });
    const laptop = await rawSignIn("ivan", "ivan-laptop", {
      userAgent: FIREFOX_WINDOWS,
    });
    // The laptop syncs once (a cookie-authenticated read carries the CSRF token), so it holds a place for syncing and outlives its
    // sessions.
    const synced = await raw("GET", "/sync", {
      cookie: laptop.cookie,
      headers: { "x-csrf-token": laptop.csrf },
    });
    expect(synced.status, JSON.stringify(synced.json)).toBe(200);
    const page = await settled(context, "ivan");
    const main = page.locator("main");
    const sessionRows = main.locator("[data-session-row]");
    const deviceRows = main.locator("[data-device-row]");
    const other = (kind: "session" | "device", text: string) =>
      main.locator(`[data-${kind}-row=other]`, { hasText: text });
    const lines = async () => {
      const sessions = await sessionsOf(page);
      const devices = await devicesOf(page);
      return {
        sessions: `${sessions.session_capacity.used} of ${sessions.session_capacity.limit} sign-ins in use.`,
        devices: `${devices.sync_capacity.used} of ${devices.sync_capacity.limit} places for syncing in use.`,
        counts: [sessions.sessions.length, devices.devices.length],
        synced: devices.devices.find((d) => d.id === "ivan-laptop")?.summary,
      };
    };
    const shows = async (expected: Awaited<ReturnType<typeof lines>>) => {
      await expect(sessionRows).toHaveCount(expected.counts[0] ?? -1);
      await expect(deviceRows).toHaveCount(expected.counts[1] ?? -1);
      await expect(main.locator("[data-capacity=sessions]")).toHaveText(
        expected.sessions,
      );
      await expect(main.locator("[data-capacity=devices]")).toHaveText(
        expected.devices,
      );
    };
    const start = await lines();
    expect(start.counts).toEqual([4, 4]);
    expect(start.synced).toMatchObject({ sync_registered: true });
    await shows(start);

    // Control: naming the tablet shows the name on its device row and its session row.
    await other("device", "Samsung Internet on Android")
      .getByRole("button", { name: /^Name / })
      .click();
    const naming = page.getByRole("dialog");
    await naming.getByLabel("Device name").fill("Ivan's tablet");
    await naming.getByRole("button", { name: "Save name" }).click();
    await expect(naming).toHaveCount(0);
    await expect(other("device", "Ivan's tablet")).toHaveCount(1);
    await expect(other("session", "Ivan's tablet")).toHaveCount(1);

    // Retiring the (never-synced) tablet ends its session: the sessions list and its capacity follow.
    await other("device", "Ivan's tablet")
      .getByRole("button", { name: /^Retire / })
      .click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Retire device", exact: true })
      .click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    const retired = await lines();
    expect(retired.counts).toEqual([3, 3]);
    await shows(retired);
    await expect(other("session", "Ivan's tablet")).toHaveCount(0);

    // Signing out the phone's only session removes the never-synced phone, controls and all.
    await other("session", "Safari on iOS")
      .getByRole("button", { name: /^Sign out / })
      .click();
    // The row leaves only after the confirmed answer: read the server's state after that, not while the DELETE is in flight.
    await expect(other("session", "Safari on iOS")).toHaveCount(0);
    const phoneGone = await lines();
    expect(phoneGone.counts).toEqual([2, 2]);
    await shows(phoneGone);
    await expect(other("device", "Safari on iOS")).toHaveCount(0);

    // Signing out the synced laptop's session keeps the laptop, with its session count read again.
    await other("session", "Firefox on Windows")
      .getByRole("button", { name: /^Sign out / })
      .click();
    await expect(other("session", "Firefox on Windows")).toHaveCount(0);
    const laptopIdle = await lines();
    expect(laptopIdle.counts).toEqual([1, 2]);
    await shows(laptopIdle);
    await expect(other("device", "Firefox on Windows")).toContainText(
      "0 active sessions",
    );

    // Retiring the synced laptop frees its place for syncing.
    await other("device", "Firefox on Windows")
      .getByRole("button", { name: /^Retire / })
      .click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Retire device", exact: true })
      .click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    const laptopRetired = await lines();
    expect(laptopRetired.counts).toEqual([1, 1]);
    expect(laptopRetired.devices).not.toBe(laptopIdle.devices);
    await shows(laptopRetired);
  });

  test("I-8d-8 (review R2): a valid 64-character name with no spaces keeps the Rename and Retire titles, the sync control and Close inside the dialog", async ({
    context,
  }) => {
    await rawSignIn("judy", "judy-phone", { userAgent: SAFARI_IPHONE });
    const page = await settled(context, "judy");
    const LONG = "W".repeat(64);
    const phone = page.locator("main [data-device-row=other]");
    await phone.getByRole("button", { name: /^Name / }).click();
    const naming = page.getByRole("dialog");
    await naming.getByLabel("Device name").fill(LONG);
    await naming.getByRole("button", { name: "Save name" }).click();
    await expect(naming).toHaveCount(0);
    await expect(phone.locator("bdi[data-device-name]")).toHaveText(LONG);
    expect(
      (await devicesOf(page)).devices.find((d) => d.id === "judy-phone")?.name,
    ).toBe(LONG);
    for (const [width, height] of [
      [320, 640],
      [1280, 800],
    ] as const) {
      await page.setViewportSize({ width, height });
      for (const [action, title] of [
        ["Rename", `Rename ${isolate(LONG)}`],
        ["Retire", `Retire ${isolate(LONG)}?`],
      ] as const) {
        await phone
          .getByRole("button", { name: new RegExp(`^${action} `) })
          .click();
        const dialog = page.getByRole("dialog", { name: title });
        await dialog.waitFor();
        const where = `${action} at ${width}x${height}`;
        const geometry = await dialog.evaluate((element) => {
          const d = element.getBoundingClientRect();
          const parts = [
            element.querySelector("h2"),
            element.querySelector('header button:not([aria-label="Close"])'),
            element.querySelector('button[aria-label="Close"]'),
          ] as HTMLElement[];
          return parts.map((part) => {
            const r = part.getBoundingClientRect();
            const hit = document.elementFromPoint(
              (r.left + r.right) / 2,
              (r.top + r.bottom) / 2,
            );
            return {
              inside: r.left >= d.left - 0.5 && r.right <= d.right + 0.5,
              shown: hit !== null && part.contains(hit),
              overflow: part.scrollWidth - part.clientWidth,
            };
          });
        });
        expect(geometry, where).toEqual([
          { inside: true, shown: true, overflow: 0 },
          { inside: true, shown: true, overflow: 0 },
          { inside: true, shown: true, overflow: 0 },
        ]);
        await page.keyboard.press("Escape");
        await expect(dialog).toHaveCount(0);
      }
    }
  });
});
