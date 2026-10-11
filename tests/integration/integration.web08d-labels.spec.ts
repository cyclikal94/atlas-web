import type { BrowserContext, Page } from "@playwright/test";
import { runAxe } from "../e2e/helpers";
import {
  ACCOUNTS,
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
  type Who,
} from "./helpers";
import { credentialsWork, strongPassword } from "./web08b-support";

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

  test("I-8d-9 (review R1, revision 2): a name saved, then its dialog dismissed while the committed answer is held, is shown in both lists; nothing is announced; a dialog left open is the control", async ({
    context,
  }) => {
    await rawSignIn("kate", "kate-phone", { userAgent: SAFARI_IPHONE });
    const page = await settled(context, "kate");
    const main = page.locator("main");
    const device = main.locator("[data-device-row=other]");
    const session = main.locator("[data-session-row=other]");
    const polite = main.page().locator("[aria-live=polite]").first();
    // The actual public answers, as the screen received them (observed, never invented).
    await page.evaluate(() => {
      const operations = window.__s.operations;
      const original = operations.nameDevice.bind(operations);
      window.__t.named = [];
      operations.nameDevice = async (...args) => {
        const result = await original(...args);
        (window.__t.named as unknown[]).push(result);
        return result;
      };
    });

    // Control: the dialog left open says so, closes itself, and both lists show the name.
    await device.getByRole("button", { name: /^Name / }).click();
    await page
      .getByRole("dialog")
      .getByLabel("Device name")
      .fill("Kate's phone");
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Save name" })
      .click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(device.locator("bdi[data-device-name]")).toHaveText(
      "Kate's phone",
    );
    await expect(session.locator("[data-device-name] bdi")).toHaveText(
      "Kate's phone",
    );

    // Rename, then Cancel while the server's answer is held (the proxy holds the response: the server has applied it).
    for (const [how, value, method] of [
      ["Cancel", "Dismissed phone", "PUT"],
      ["Close", null, "DELETE"],
    ] as const) {
      const rule = await proxy.addRule({
        method,
        path: NAME_PATH,
        action: "hold",
        ordinal: 1,
      });
      await device.getByRole("button", { name: /^Rename / }).click();
      const dialog = page.getByRole("dialog");
      if (value === null)
        await dialog.getByRole("button", { name: "Remove name" }).click();
      else {
        await dialog.getByLabel("Device name").fill(value);
        await dialog.getByRole("button", { name: "Save name" }).click();
      }
      await untilHeld(rule.id);
      const announced = await polite.textContent();
      await dialog.getByRole("button", { name: how, exact: true }).click();
      await expect(dialog).toHaveCount(0);
      await proxy.release(rule.id);
      await expect
        .poll(() => page.evaluate(() => (window.__t.named as unknown[]).at(-1)))
        .toEqual({ ok: true, value: value === null ? "cleared" : "named" });
      const server = (await devicesOf(page)).devices.find(
        (d) => d.id === "kate-phone",
      );
      expect(server?.name ?? null).toBe(value);
      if (value === null) {
        await expect(device.locator("bdi[data-device-name]")).toHaveCount(0);
        await expect(session.locator("[data-device-name]")).toHaveCount(0);
      } else {
        await expect(device.locator("bdi[data-device-name]")).toHaveText(value);
        await expect(session.locator("[data-device-name] bdi")).toHaveText(
          value,
        );
      }
      // Nothing was said for a dialog that had gone.
      expect(await polite.textContent()).toBe(announced);
      await expect(page.getByRole("dialog")).toHaveCount(0);
    }
  });

  test("I-8d-10 (review R3, revision 2): a retirement refused before sending is not tried again after Keep, over the whole bounded retry schedule; a dialog left open retries once and retires (control)", async ({
    context,
  }) => {
    await rawSignIn("liam", "liam-phone-a", { userAgent: SAFARI_IPHONE });
    await rawSignIn("liam", "liam-phone-b", { userAgent: FIREFOX_WINDOWS });
    const page = await settled(context, "liam");
    const main = page.locator("main");
    // The first call of each round answers `not_sent` when the test says so (a SYNTHETIC public `not_sent`: the kernel's own admission
    // boundary is F-WD in operations-withdraw.test.ts); every later call is the real operation against the released backend.
    await page.evaluate(() => {
      const operations = window.__s.operations;
      const original = operations.retireOtherDevice.bind(operations);
      window.__t.round = { calls: 0, results: [] as unknown[] };
      operations.retireOtherDevice = async (...args) => {
        const round = window.__t.round as {
          calls: number;
          results: unknown[];
          refuse?: () => void;
        };
        round.calls += 1;
        if (round.calls === 1)
          return new Promise((resolve) => {
            round.refuse = () => resolve({ ok: false, error: "not_sent" });
          });
        const result = await original(...args);
        round.results.push(result);
        return result;
      };
    });
    const round = () =>
      page.evaluate(() => {
        const r = window.__t.round as { calls: number; results: unknown[] };
        return { calls: r.calls, results: r.results };
      });
    const start = () =>
      page.evaluate(() => {
        window.__t.round = { calls: 0, results: [] };
      });
    const ids = async () => (await devicesOf(page)).devices.map((d) => d.id);

    // Control: left open, the retry is made once (the unchanged 50 ms delay) and applies.
    await start();
    await main
      .locator("[data-device-row=other]", { hasText: "Safari on iOS" })
      .getByRole("button", { name: /^Retire / })
      .click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Retire device", exact: true })
      .click();
    await expect.poll(async () => (await round()).calls).toBe(1);
    await page.evaluate(() =>
      (window.__t.round as { refuse: () => void }).refuse(),
    );
    await expect(page.getByRole("dialog")).toHaveCount(0);
    expect(await round()).toEqual({
      calls: 2,
      results: [{ ok: true, value: "confirmed_applied" }],
    });
    expect(await ids()).not.toContain("liam-phone-a");
    await expect(
      main.locator("[data-device-row=other]", { hasText: "Safari on iOS" }),
    ).toHaveCount(0);

    // Dismissed with Keep before the refusal arrives: no further call over the whole bounded schedule, and the device stays.
    await start();
    await main
      .locator("[data-device-row=other]", { hasText: "Firefox on Windows" })
      .getByRole("button", { name: /^Retire / })
      .click();
    const dialog = page.getByRole("dialog");
    await dialog
      .getByRole("button", { name: "Retire device", exact: true })
      .click();
    await expect.poll(async () => (await round()).calls).toBe(1);
    await dialog
      .getByRole("button", { name: "Keep this device", exact: true })
      .click();
    await expect(dialog).toHaveCount(0);
    await page.evaluate(() =>
      (window.__t.round as { refuse: () => void }).refuse(),
    );
    // Only the OTHER rows are named here: Playwright's desktop Firefox reports Windows, so this engine's own rows read "Firefox on
    // Windows" too (driver run 1 of revision 2 matched the current row).
    // The helper's retry budget is bounded (NOT_SENT_DELAYS_MS, 5,550 ms in all, production values): observing past its whole
    // schedule, not a short silence window, is what shows no retry can still come.
    await page.waitForTimeout(6_500);
    expect(await round()).toEqual({ calls: 1, results: [] });
    expect(await ids()).toContain("liam-phone-b");
    await expect(
      main.locator("[data-device-row=other]", {
        hasText: "Firefox on Windows",
      }),
    ).toHaveCount(1);
  });

  test("I-8d-11 (review R3, revision 2): an older retirement's late answer updates both lists but never closes or changes a newer dialog (this device's retirement, another device's retirement, a naming dialog)", async ({
    context,
  }) => {
    const UAS = [SAFARI_IPHONE, FIREFOX_WINDOWS, SAMSUNG_ANDROID] as const;
    for (const [index, ua] of UAS.entries())
      await rawSignIn("mia", `mia-old-${index}`, { userAgent: ua });
    const page = await settled(context, "mia");
    const main = page.locator("main");
    const rows = main.locator("[data-device-row]");
    await expect(rows).toHaveCount(4);
    const cases = [
      {
        target: "Safari on iOS",
        id: "mia-old-0",
        open: () =>
          main
            .locator("[data-device-row=current]")
            .getByRole("button", { name: /^Retire / })
            .click(),
        newer: page.getByRole("dialog", { name: "Retire this device?" }),
        close: "Stay logged in",
      },
      {
        target: "Firefox on Windows",
        id: "mia-old-1",
        open: () =>
          main
            .locator("[data-device-row=other]", {
              hasText: "Firefox on Windows",
            })
            .getByRole("button", { name: /^Retire / })
            .click(),
        newer: page.getByRole("dialog", { name: "Retire Firefox on Windows?" }),
        close: "Keep this device",
      },
      {
        target: "Samsung Internet on Android",
        id: "mia-old-2",
        open: async () => {
          await main
            .locator("[data-device-row=current]")
            .getByRole("button", { name: /^Name / })
            .click();
          await page
            .getByRole("dialog")
            .getByLabel("Device name")
            .fill("New draft");
        },
        newer: page.getByRole("dialog", { name: "Name this device" }),
        close: "Cancel",
      },
    ];
    let listed = 4;
    for (const step of cases) {
      const rule = await proxy.addRule({
        method: "DELETE",
        path: `/api/experimental/v1/devices/${step.id}`,
        action: "hold",
        ordinal: 1,
      });
      await main
        .locator("[data-device-row=other]", { hasText: step.target })
        .getByRole("button", { name: /^Retire / })
        .click();
      const older = page.getByRole("dialog");
      await older
        .getByRole("button", { name: "Retire device", exact: true })
        .click();
      await untilHeld(rule.id);
      await older
        .getByRole("button", { name: "Keep this device", exact: true })
        .click();
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await step.open();
      await expect(step.newer).toBeVisible();
      await proxy.release(rule.id);
      listed -= 1;
      // The server applied it; the lists behind the newer dialog follow.
      await expect(rows).toHaveCount(listed);
      expect((await devicesOf(page)).devices.map((d) => d.id)).not.toContain(
        step.id,
      );
      await expect(
        main.locator("[data-session-row=other]", { hasText: step.target }),
      ).toHaveCount(0);
      // The newer dialog is still the only one, untouched.
      await expect(page.getByRole("dialog")).toHaveCount(1);
      await expect(step.newer).toBeVisible();
      await expect(step.newer.locator("[data-refusal]")).toHaveCount(0);
      if (step.close === "Cancel")
        await expect(step.newer.getByLabel("Device name")).toHaveValue(
          "New draft",
        );
      await step.newer
        .getByRole("button", { name: step.close, exact: true })
        .click();
      await expect(page.getByRole("dialog")).toHaveCount(0);
    }
  });

  /**
   * Review R4 (revision 3): a password change, or a "Check now", belongs to the Signing in form that made it. The first call of a round
   * answers when the test says so; a SYNTHETIC public `not_sent` (as the review's own probe, and I-8d-10): the kernel's admission
   * boundary is F-WD in operations-withdraw.test.ts. Every later call is the real operation against the released backend.
   */
  async function openSigningIn(context: BrowserContext, who: Who) {
    const page = await bootHarness(context, "/settings/signing-in");
    expect((await signIn(page, who)).kind).toBe("settled");
    await untilView(page, "displaying");
    const dialog = page.getByRole("dialog", { name: "Signing in" });
    await expect(dialog.getByLabel("Current password")).toBeVisible();
    await page.evaluate(() => {
      const operations = window.__s.operations;
      const original = operations.changePassword.bind(operations);
      window.__t.password = { calls: 0 };
      operations.changePassword = async (...args) => {
        const round = window.__t.password as {
          calls: number;
          answer?: unknown;
          release?: () => void;
        };
        round.calls += 1;
        if (round.calls === 1 && round.answer !== undefined)
          return new Promise((resolve) => {
            round.release = () => resolve(round.answer as never);
          });
        return original(...args);
      };
    });
    return { page, dialog };
  }
  /** The next round: its first call is held and then answered `answer`. */
  const holdPassword = (page: Page, answer: unknown) =>
    page.evaluate((value) => {
      window.__t.password = { calls: 0, answer: value };
    }, answer);
  const passwordCalls = (page: Page) =>
    page.evaluate(() => (window.__t.password as { calls: number }).calls);
  const releasePassword = (page: Page) =>
    page.evaluate(() =>
      (window.__t.password as { release: () => void }).release(),
    );
  /** Two animation frames: the announcer writes a region on the frame after it is asked to. */
  const frames = (page: Page) =>
    page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
  const sentPasswords = async () =>
    (await proxy.log()).filter(
      (e) => e.method === "POST" && /\/password$/.test(e.path),
    ).length;

  test("I-8d-12 (review R4, revision 3): a password change refused before sending, then Signing in closed: nothing is announced, nothing more is sent and the password is unchanged; a form opened again meanwhile keeps its values, its message and its focus", async ({
    context,
  }) => {
    const { page, dialog } = await openSigningIn(context, "olga");
    const assertive = page.locator("[aria-live=assertive]");
    const sentBefore = await sentPasswords();

    // Closed, then the refusal: silence, over the whole bounded retry schedule.
    await holdPassword(page, { ok: false, error: "not_sent" });
    await dialog.getByLabel("Current password").fill(ACCOUNTS.olga.password);
    await dialog.getByLabel("New password").fill(strongPassword());
    await dialog
      .getByRole("button", { name: "Change password", exact: true })
      .click();
    await expect.poll(() => passwordCalls(page)).toBe(1);
    await dialog.getByRole("button", { name: "Close", exact: true }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await releasePassword(page);
    // The helper's retry budget is bounded (NOT_SENT_DELAYS_MS, 5,550 ms in all, production values): observe past all of it.
    await page.waitForTimeout(6_500);
    await frames(page);
    expect(await passwordCalls(page)).toBe(1);
    expect(await assertive.textContent()).toBe("");
    await expect(page.getByRole("dialog")).toHaveCount(0);

    // Closed, opened again, and the NEW form says something of its own; then the old form's refusal arrives.
    await holdPassword(page, { ok: false, error: "not_sent" });
    await page.locator('[data-settings-link="signing-in"]').click();
    const first = page.getByRole("dialog", { name: "Signing in" });
    await first.getByLabel("Current password").fill(ACCOUNTS.olga.password);
    await first.getByLabel("New password").fill(strongPassword());
    await first
      .getByRole("button", { name: "Change password", exact: true })
      .click();
    await expect.poll(() => passwordCalls(page)).toBe(1);
    await first.getByRole("button", { name: "Close", exact: true }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await page.locator('[data-settings-link="signing-in"]').click();
    const reopened = page.getByRole("dialog", { name: "Signing in" });
    await reopened.getByLabel("Current password").fill("typed-again");
    await reopened.getByLabel("New password").fill("short");
    await reopened
      .getByRole("button", { name: "Change password", exact: true })
      .click();
    const message = "Use at least 12 characters.";
    await expect(assertive).toHaveText(message);
    await expect(reopened.getByLabel("New password")).toBeFocused();
    await releasePassword(page);
    await page.waitForTimeout(6_500);
    await frames(page);
    expect(await passwordCalls(page)).toBe(1);
    expect(await assertive.textContent()).toBe(message);
    await expect(page.getByRole("dialog")).toHaveCount(1);
    await expect(reopened.getByLabel("Current password")).toHaveValue(
      "typed-again",
    );
    await expect(reopened.getByLabel("New password")).toHaveValue("short");
    await expect(reopened.getByLabel("New password")).toBeFocused();
    await expect(reopened.locator("[data-error]")).toHaveText([message]);

    // Nothing was put on the wire and the password still works.
    expect(await sentPasswords()).toBe(sentBefore);
    expect(
      await credentialsWork(ACCOUNTS.olga.username, ACCOUNTS.olga.password),
    ).toBe(true);
    await untilView(page, "displaying");
  });

  test("I-8d-13 (review R4, revision 3, control): a password change refused before sending, its form left open, is tried again once and applies", async ({
    context,
  }) => {
    const { page, dialog } = await openSigningIn(context, "pete");
    const next = strongPassword();
    await holdPassword(page, { ok: false, error: "not_sent" });
    await dialog.getByLabel("Current password").fill(ACCOUNTS.pete.password);
    await dialog.getByLabel("New password").fill(next);
    await dialog
      .getByRole("button", { name: "Change password", exact: true })
      .click();
    await expect.poll(() => passwordCalls(page)).toBe(1);
    await releasePassword(page);
    await expect.poll(() => passwordCalls(page)).toBe(2);
    await untilView(page, "neutral");
    expect(await credentialsWork(ACCOUNTS.pete.username, next)).toBe(true);
  });

  test("I-8d-14 (review R4, revision 3): a password change already sent, whose committed answer is held while Signing in is closed, still ends the session everywhere; the closed form says nothing", async ({
    context,
  }) => {
    const { page, dialog } = await openSigningIn(context, "bob");
    // Read without waiting: once the committed change has revoked this session (which another request of the page can observe
    // before the held answer is released), the protected tree and its live regions are gone. A region that is gone says nothing.
    const assertive = () =>
      page.evaluate(
        () =>
          document.querySelector("[aria-live=assertive]")?.textContent ?? "",
      );
    const next = strongPassword();
    const rule = await proxy.addRule({
      method: "POST",
      path: "/api/experimental/v1/password",
      action: "hold",
      ordinal: 1,
    });
    await dialog.getByLabel("Current password").fill(ACCOUNTS.bob.password);
    await dialog.getByLabel("New password").fill(next);
    await dialog
      .getByRole("button", { name: "Change password", exact: true })
      .click();
    await untilHeld(rule.id);
    await dialog.getByRole("button", { name: "Close", exact: true }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    expect(await assertive()).toBe("");
    await proxy.release(rule.id);
    // The session observes what the request did: the change committed, so every session ended, this one included.
    await untilView(page, "neutral");
    await frames(page);
    expect(await assertive()).toBe("");
    expect(await passwordCalls(page)).toBe(1);
    expect(await credentialsWork(ACCOUNTS.bob.username, next)).toBe(true);
  });

  test("I-8d-15 (design assessment A4, revision 3): a Check now whose answer comes after Signing in was closed says nothing; a form left open says the change is still unconfirmed (control)", async ({
    context,
  }) => {
    const { page, dialog } = await openSigningIn(context, "alice");
    const polite = page.locator("[aria-live=polite]");
    // The change's outcome is unknown (a SYNTHETIC `offline` answer; nothing is sent), and the next account read the test holds.
    await page.evaluate(() => {
      const operations = window.__s.operations;
      operations.changePassword = async () => ({
        ok: false,
        error: "offline",
      });
      const read = operations.readAccount.bind(operations);
      window.__t.check = { armed: false, reads: 0 };
      operations.readAccount = async (...args) => {
        const check = window.__t.check as {
          armed: boolean;
          reads: number;
          release?: () => void;
        };
        if (!check.armed) return read(...args);
        check.armed = false;
        check.reads += 1;
        await new Promise<void>((resolve) => {
          check.release = resolve;
        });
        return read(...args);
      };
    });
    const arm = () =>
      page.evaluate(() => {
        (window.__t.check as { armed: boolean }).armed = true;
      });
    const release = () =>
      page.evaluate(() =>
        (window.__t.check as { release: () => void }).release(),
      );
    const unknown = async (form: typeof dialog) => {
      await form.getByLabel("Current password").fill(ACCOUNTS.alice.password);
      await form.getByLabel("New password").fill(strongPassword());
      await form
        .getByRole("button", { name: "Change password", exact: true })
        .click();
      await expect(form.locator("[data-unconfirmed]")).toBeVisible();
    };

    // Closed while checking: the read is answered (the session still works), and nothing is said.
    await unknown(dialog);
    await arm();
    await dialog
      .getByRole("button", { name: "Check now", exact: true })
      .click();
    await expect
      .poll(() =>
        page.evaluate(() => (window.__t.check as { reads: number }).reads),
      )
      .toBe(1);
    await dialog.getByRole("button", { name: "Close", exact: true }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await frames(page);
    const before = await polite.textContent();
    await release();
    await frames(page);
    expect(await polite.textContent()).toBe(before);
    expect(before).not.toContain("still signed in");

    // Control: opened again, left open, the same answer is shown and said.
    await page.locator('[data-settings-link="signing-in"]').click();
    const reopened = page.getByRole("dialog", { name: "Signing in" });
    await unknown(reopened);
    await arm();
    await reopened
      .getByRole("button", { name: "Check now", exact: true })
      .click();
    await expect
      .poll(() =>
        page.evaluate(() => (window.__t.check as { reads: number }).reads),
      )
      .toBe(2);
    await release();
    const still = reopened.locator("[data-still-unconfirmed]");
    await expect(still).toBeVisible();
    await frames(page);
    expect(await polite.textContent()).toBe(await still.textContent());
    await untilView(page, "displaying");
  });
});
