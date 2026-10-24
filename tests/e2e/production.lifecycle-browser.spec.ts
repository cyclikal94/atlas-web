import { writeFileSync } from "node:fs";
import type { BrowserContext, Page } from "@playwright/test";
import { test } from "./auth-helpers";
import { AuthStub } from "./auth-stub";
import { evidencePath, expect } from "./helpers";
import {
  allowFreeze,
  displayedAs,
  findLeaseLocks,
  hideThenShow,
  newMarker,
  passwordOf,
  publicSignIn,
  waiterFor,
} from "./lifecycle-browser";

/**
 * WEB-08c, Layer 5: real-browser lifecycle and Web Locks on the PRODUCTION build with a STUBBED network (frontend-plan §WEB-08c,
 * "Real-browser requirements"; matrix §3.6.3 item 1, T4, T15, T23 A–D). What Playwright's desktop engines can and cannot show is stated per
 * case (decision D-8c-06): a CDP freeze exists in Chromium only; headless Firefox and WebKit cannot background a page natively (the
 * `visibilitychange` sequence is driven by overriding `document.visibilityState`, as in the other real-engine suites); the back/forward
 * cache is probed, never assumed. Mobile, real Safari and native backgrounding are WEB-09d's (a Q12 release blocker), with this script.
 * Measurements (`@measure`) are recorded, never asserted against a threshold. The product's own 20 s lock-wait message is the released-
 * backend I-23d (cited); here the lock itself is shown held, never stolen.
 */
const ACTIVATE = "/browser-sessions/activate";
const _isActivate = (r: { method: string; path: string }) =>
  r.method === "POST" && r.path === ACTIVATE;
const isMe = (r: { method: string; path: string }) =>
  r.method === "GET" && r.path === "/me";

async function newStub(context: BrowserContext, ...names: string[]) {
  const stub = new AuthStub();
  for (const name of names) stub.addAccount(name, passwordOf(name));
  await stub.install(context);
  return stub;
}
async function signInAndDisplay(page: Page, username: string) {
  await page.goto("/");
  await publicSignIn(page, username);
  await displayedAs(page, username);
}
/**
 * A TEST page of the same origin (the static `/favicon.svg` document: it boots no application) that holds a Web Lock whose callback never
 * resolves: matrix T23 A–D's own method ("hold `atlas-auth` with a test page whose lock callback never resolves").
 */
async function holdLockForever(context: BrowserContext, name: string) {
  const holder = await context.newPage();
  await holder.goto("/favicon.svg");
  await holder.evaluate(
    (lock) =>
      new Promise<void>((granted) => {
        void navigator.locks.request(lock, () => {
          granted();
          return new Promise<void>(() => undefined);
        });
      }),
    name,
  );
  return holder;
}

test.describe("T4 and the resume gate: a hidden-then-frozen (Chromium) or hidden (Firefox, WebKit) page whose identity changed meanwhile", () => {
  test("the first frame after resume is neutral and inert (nothing of A reachable by keyboard or assistive technology); the page never shows A again and then shows B", async ({
    context,
    browserName,
  }) => {
    const a = newMarker("alice");
    const b = newMarker("bobby");
    const stub = await newStub(context, a, b);
    await allowFreeze(context);
    const one = await context.newPage();
    const two = await context.newPage();
    await signInAndDisplay(one, a);
    await two.goto("/");
    await displayedAs(two, a);
    // t0: page one is hidden (the level-0 gate closes over it synchronously), then frozen where the engine can freeze (t1).
    const resume = await hideThenShow(one, browserName);
    // t2: page two settles B (a switch through WF-SWITCH-02).
    await two.getByRole("button", { name: `${a}, switch account` }).click();
    await two
      .getByRole("dialog", { name: "Switch account" })
      .getByRole("option")
      .last()
      .click();
    const dialog = two.getByRole("dialog", {
      name: "Sign in to another account",
    });
    await dialog.getByLabel("Username").fill(b);
    await dialog.getByLabel("Password").fill(passwordOf(b));
    await dialog.getByRole("button", { name: "Sign in", exact: true }).click();
    await displayedAs(two, b);
    // t3: page one resumes. Its FIRST frame (synchronously after `visible`, before any of its tasks): the protected root inert and hidden.
    const first = await resume();
    test.info().annotations.push({
      type: "first-frame",
      description: JSON.stringify(first),
    });
    expect(first.inert, "protected root inert at the first frame").toBe(true);
    expect(
      first.ariaHidden,
      "protected root aria-hidden at the first frame",
    ).toBe(true);
    expect(first.reachable, "nothing protected is focusable").toEqual([]);
    expect(first.title, "the neutral title").not.toContain(a);
    expect(await one.locator("body").ariaSnapshot()).not.toContain(a);
    await displayedAs(one, b, 30_000);
    expect(
      await one.evaluate(() => document.documentElement.textContent ?? ""),
    ).not.toContain(a);
    expect(stub.count("POST", ACTIVATE)).toBe(2);
  });
});

test.describe("A held atlas-auth never stolen; an observation is never delayed by it (T15, T23 A–D)", () => {
  test("a page frozen INSIDE its atlas-auth callback (a test page whose callback never resolves; Chromium also freezes it over CDP) makes another page's sign-in wait the full 20 s and then say 'Another tab is finishing a sign-in'; nothing steals the lock; once the holder is gone the sign-in works", async ({
    context,
    browserName,
  }) => {
    test.setTimeout(90_000);
    const a = newMarker("alice");
    await newStub(context, a);
    const two = await context.newPage();
    await two.goto("/");
    await expect(two.getByLabel("Username")).toBeVisible();
    const holder = await holdLockForever(context, "atlas-auth");
    if (browserName === "chromium") {
      const cdp = await context.newCDPSession(holder);
      await cdp.send("Page.setWebLifecycleState", { state: "frozen" });
    }
    const began = Date.now();
    await publicSignIn(two, a);
    await expect(
      two.getByText("Another tab is finishing a sign-in", { exact: false }),
    ).toBeVisible({
      timeout: 40_000,
    });
    // The wait is the production 20 s, never shortened.
    expect(
      Date.now() - began,
      "waited the full lock wait",
    ).toBeGreaterThanOrEqual(19_500);
    // Nothing stole the lock: the holder still holds it.
    expect(
      await two.evaluate(
        async () =>
          ((await navigator.locks.query()).held ?? []).filter(
            (l) => l.name === "atlas-auth",
          ).length,
      ),
    ).toBe(1);
    await holder.close();
    await publicSignIn(two, a);
    await displayedAs(two, a, 30_000);
  });

  test("T23 A–D: atlas-auth held by a test page whose lock callback never resolves; page two's detected 401 is RECORDED at once (1b well inside any 20 s lock wait), survives page two's closure, and a new page finds it", async ({
    context,
    provokes,
  }) => {
    test.setTimeout(90_000);
    provokes(401);
    const a = newMarker("alice");
    const stub = await newStub(context, a);
    const two = await context.newPage();
    await signInAndDisplay(two, a);
    await two.waitForTimeout(1_000);
    const holder = await holdLockForever(context, "atlas-auth");
    // A's session ends on the server; page two's next own request (the account card's /me) is answered 401.
    for (const id of [...stub.sessions.keys()]) stub.sessions.delete(id);
    const started = Date.now();
    // The click is only a trigger: a background read can meet the 401 first (then the rail is already gone).
    const reconnect = two.getByRole("heading", {
      level: 1,
      name: "Reconnect to keep going",
    });
    await two
      .getByRole("navigation")
      .getByRole("link", { name: "Settings" })
      .first()
      .click({ timeout: 5_000 })
      .catch(async (error: unknown) => {
        if (!(await reconnect.isVisible())) throw error;
      });
    await expect(reconnect).toBeVisible({ timeout: 15_000 });
    expect(
      Date.now() - started,
      "recorded well inside a 20 s lock wait",
    ).toBeLessThan(15_000);
    await two.close();
    const three = await context.newPage();
    await three.goto("/");
    await expect(
      three.getByRole("heading", { level: 1, name: "Reconnect to keep going" }),
    ).toBeVisible({ timeout: 30_000 });
    expect(
      await three.evaluate(() => document.documentElement.textContent ?? ""),
    ).not.toContain(a);
    // The holder still holds the lock: nothing above needed it.
    expect(
      await holder.evaluate(async () =>
        ((await navigator.locks.query()).held ?? []).some(
          (l) => l.name === "atlas-auth",
        ),
      ),
    ).toBe(true);
  });
});

test.describe("P-lock-a / P-lock-c: another page's pending request for a page's atlas-lease-<id> (never query() in product code)", () => {
  test("P-lock-a (liveness, close): the owner holding a lease for a request held at the network is CLOSED: a pending navigator.locks.request for that lease from another page is granted", async ({
    context,
  }) => {
    const a = newMarker("alice");
    const stub = await newStub(context, a);
    const owner = await context.newPage();
    await signInAndDisplay(owner, a);
    await owner.waitForTimeout(1_000);
    const held = stub.hold(isMe, 1);
    await owner
      .getByRole("navigation")
      .getByRole("link", { name: "Settings" })
      .first()
      .click();
    await expect
      .poll(() => stub.recordsFor("/me").length, { timeout: 15_000 })
      .toBeGreaterThan(1);
    const waiter = await context.newPage();
    await waiter.goto("/favicon.svg");
    const leases = await findLeaseLocks(waiter);
    expect(leases.length, "the owner holds a lease lock").toBeGreaterThan(0);
    const pending = await waiterFor(waiter, leases[0] as string);
    expect(
      await pending.granted(1_000),
      "not granted while the owner lives",
    ).toBe(false);
    await owner.close();
    expect(await pending.granted(15_000), "granted after the owner went").toBe(
      true,
    );
    held.stop();
  });

  test("P-lock-a (liveness, crash, Chromium CDP Page.crash): after the owner's renderer is killed, a request for its lease lock is granted (the waiter is opened after the crash: same-site pages share the renderer, and a waiter open at the crash is killed with it)", async ({
    context,
    browserName,
  }) => {
    // Observed twice in this environment (Playwright 1.63, Chromium): after `Page.crash` the shared browser context is disposed (a
    // protocol error on the next page) or hangs, so no page of the same storage partition survives to observe the lock. P-lock-a after a
    // process kill is therefore UNAVAILABLE here and handed to WEB-09d (devices); the close case above is the liveness evidence.
    test.skip(
      true,
      "P-lock-a after a crash cannot be observed under Playwright's desktop engines (the CDP crash disposes or hangs the context)",
    );
    test.skip(
      browserName !== "chromium",
      "only Chromium can kill a page renderer from the test (CDP): recorded as unavailable",
    );
    const a = newMarker("alice");
    const stub = await newStub(context, a);
    const owner = await context.newPage();
    await signInAndDisplay(owner, a);
    await owner.waitForTimeout(1_000);
    const held = stub.hold(isMe, 1);
    await owner
      .getByRole("navigation")
      .getByRole("link", { name: "Settings" })
      .first()
      .click();
    await expect
      .poll(() => stub.recordsFor("/me").length, { timeout: 15_000 })
      .toBeGreaterThan(1);
    const leases = await findLeaseLocks(owner);
    expect(leases.length, "the owner holds a lease lock").toBeGreaterThan(0);
    const cdp = await context.newCDPSession(owner);
    await cdp.send("Page.crash").catch(() => undefined);
    let waiter: Page;
    try {
      waiter = await context.newPage();
    } catch (error) {
      // Observed in Playwright's Chromium: the CDP crash disposes the browser context, so no page of the same storage partition is left
      // to observe the lock. Recorded as UNAVAILABLE in this environment (never passed); a renderer kill on a device is WEB-09d's.
      test.info().annotations.push({
        type: "unavailable",
        description: `P-lock-a crash: ${String((error as Error).message).slice(0, 120)}`,
      });
      held.stop();
      test.skip(
        true,
        "the CDP crash disposed the browser context: P-lock-a after a crash cannot be observed here",
      );
      return;
    }
    await waiter.goto("/favicon.svg");
    const pending = await waiterFor(waiter, leases[0] as string);
    expect(
      await pending.granted(15_000),
      "granted after the owner's renderer died",
    ).toBe(true);
    held.stop();
  });

  test("P-lock-c (held while frozen, Chromium CDP): the waiter is NOT granted while the owner is frozen; it is granted once the owner's request ends", async ({
    context,
    browserName,
  }) => {
    test.skip(
      browserName !== "chromium",
      "only Chromium can freeze a page (CDP Page.setWebLifecycleState): recorded as unavailable",
    );
    const a = newMarker("alice");
    const stub = await newStub(context, a);
    const owner = await context.newPage();
    await signInAndDisplay(owner, a);
    await owner.waitForTimeout(1_000);
    const held = stub.hold(isMe, 1);
    await owner
      .getByRole("navigation")
      .getByRole("link", { name: "Settings" })
      .first()
      .click();
    await expect
      .poll(() => stub.recordsFor("/me").length, { timeout: 15_000 })
      .toBeGreaterThan(1);
    const waiter = await context.newPage();
    await waiter.goto("/favicon.svg");
    const leases = await findLeaseLocks(waiter);
    expect(leases.length).toBeGreaterThan(0);
    const cdp = await context.newCDPSession(owner);
    await cdp.send("Page.setWebLifecycleState", { state: "frozen" });
    const pending = await waiterFor(waiter, leases[0] as string);
    expect(
      await pending.granted(3_000),
      "not granted while the owner is frozen",
    ).toBe(false);
    await cdp.send("Page.setWebLifecycleState", { state: "active" });
    held.release();
    expect(
      await pending.granted(15_000),
      "granted once the owner's request ended",
    ).toBe(true);
  });

  test("the back/forward cache, probed: where the engine restores a page from it, the first frame is neutral; where it does not, recorded as unavailable (never passed)", async ({
    page,
    context,
    browserName,
    toleratesNavigationAbort,
  }) => {
    // HF-2: Firefox warns that a transaction of the page was aborted by the navigation this probe makes on purpose (nothing commits from an
    // aborted IndexedDB transaction). Exactly that warning, in Firefox only.
    toleratesNavigationAbort(
      "firefox",
      /^\[JavaScript Warning: "An IndexedDB transaction that was not yet complete has been aborted due to page navigation\." \{file: "http:\/\/127\.0\.0\.1:\d+\/assets\/[\w.-]+\.js" line: \d+\}\]$/,
    );
    // HF-4: WebKit reports a same-origin API fetch that this probe's own navigation cancelled as a page error ("… due to access control
    // checks"; seen for the leader's `/sync` read, whichever request happens to be in flight). Exactly that form, in WebKit only.
    toleratesNavigationAbort(
      "webkit",
      /^\/127\.0\.0\.1:\d+\/api\/experimental\/v1\/[\w/-]+(\?[\w=&%.-]*)? due to access control checks\.$/,
    );
    const a = newMarker("alice");
    await newStub(context, a);
    await signInAndDisplay(page, a);
    await page.evaluate(() => {
      sessionStorage.setItem("probe", "1");
    });
    await page.addInitScript(() => {
      window.addEventListener("pageshow", (event) => {
        (window as unknown as { __restored: boolean }).__restored =
          event.persisted;
      });
    });
    await page.goto("/favicon.svg");
    await page.goBack();
    const restored = await page
      .evaluate(
        () =>
          (window as unknown as { __restored?: boolean }).__restored === true,
      )
      .catch(() => false);
    test.info().annotations.push({
      type: "bfcache",
      description: JSON.stringify({
        engine: browserName,
        restoredFromBfcache: restored,
      }),
    });
    // Restored or not, the page shows A again only through the session (a fresh load, or the resume gate of a restored page).
    await displayedAs(page, a, 30_000);
  });
});

test.describe("@measure P-lock-b (a measurement, not a threshold)", () => {
  test("@measure P-lock-b: from the owner's 401 answer to the grant of a waiter's request for the owner's lease lock", async ({
    browser,
    browserName,
  }) => {
    test.setTimeout(180_000);
    const samples: number[] = [];
    for (let i = 0; i < 5; i += 1) {
      const context = await browser.newContext();
      const a = newMarker(`plb${i}`);
      const stub = await newStub(context, a);
      const page = await context.newPage();
      await signInAndDisplay(page, a);
      await page.waitForTimeout(1_000);
      stub.answerNext(isMe, {
        status: 401,
        body: {
          code: "unauthenticated",
          message: "x",
          request_id: "r",
          details: [],
        },
      });
      const held = stub.hold(isMe, 1);
      const before = stub.recordsFor("/me").length;
      await page
        .getByRole("navigation")
        .getByRole("link", { name: "Settings" })
        .first()
        .click();
      await expect
        .poll(() => stub.recordsFor("/me").length, { timeout: 15_000 })
        .toBeGreaterThan(before);
      const waiter = await context.newPage();
      await waiter.goto("/favicon.svg");
      const leases = await findLeaseLocks(waiter);
      const pending = await waiterFor(waiter, leases[0] as string);
      const released = await waiter.evaluate(
        () => performance.timeOrigin + performance.now(),
      );
      held.release();
      const at = await pending.grantedAt(15_000);
      if (at !== null) samples.push(Math.round((at - released) * 10) / 10);
      await context.close();
    }
    const record = {
      measure: "P-lock-b",
      what: "the owner's 401 answer released by the stub, to the grant of another page's pending request for the owner's lease lock",
      engine: browserName,
      version: browser.version(),
      unit: "ms",
      samples,
      note: "a latency measurement that bounds the notification interval, not a safety threshold (matrix 3.6.3 item 1)",
    };
    test.info().annotations.push({
      type: "measurement",
      description: JSON.stringify(record),
    });
    writeFileSync(
      evidencePath(`p-lock-b-${browserName}.json`),
      `${JSON.stringify(record, null, 2)}\n`,
    );
    expect(samples.length, "every sample was taken").toBe(5);
  });
});

test.describe("§2.6: the waits against a frozen owner with a request outstanding (Chromium CDP; a measurement and a liveness check)", () => {
  test("@measure a FROZEN page holding an outstanding request: another page that opens defers its display ('Waiting for another window' after 2 s), never displays on the held lease, and displays once the owner resumes and its request ends; the deferral after the end is measured", async ({
    context,
    browserName,
  }) => {
    test.skip(
      browserName !== "chromium",
      "only Chromium can freeze a page (CDP): recorded as unavailable; mobile and real Safari are WEB-09d's",
    );
    test.setTimeout(90_000);
    const a = newMarker("alice");
    const stub = await newStub(context, a);
    const owner = await context.newPage();
    await signInAndDisplay(owner, a);
    await owner.waitForTimeout(1_000);
    const held = stub.hold(isMe, 1);
    await owner
      .getByRole("navigation")
      .getByRole("link", { name: "Settings" })
      .first()
      .click();
    await expect
      .poll(() => stub.recordsFor("/me").length, { timeout: 15_000 })
      .toBeGreaterThan(1);
    const cdp = await context.newCDPSession(owner);
    await cdp.send("Page.setWebLifecycleState", { state: "frozen" });
    const other = await context.newPage();
    await other.goto("/");
    await expect(
      other.getByRole("heading", {
        level: 1,
        name: "Waiting for another window",
      }),
    ).toBeVisible({ timeout: 15_000 });
    await other.waitForTimeout(5_000);
    expect(
      await other.locator("#protected-root:not([inert])").count(),
      "never displayed on the held lease",
    ).toBe(0);
    await cdp.send("Page.setWebLifecycleState", { state: "active" });
    const ended = await other.evaluate(
      () => performance.timeOrigin + performance.now(),
    );
    held.release();
    await displayedAs(other, a, 30_000);
    const shown = await other.evaluate(
      () => performance.timeOrigin + performance.now(),
    );
    const record = {
      measure: "deferral after a frozen owner's request ends",
      engine: browserName,
      version: context.browser()?.version() ?? "",
      unit: "ms",
      upperBound: Math.round(shown - ended),
      note: "an upper bound (includes the test's own polling); a measurement, not a threshold",
    };
    test.info().annotations.push({
      type: "measurement",
      description: JSON.stringify(record),
    });
    writeFileSync(
      evidencePath(`frozen-owner-deferral-${browserName}.json`),
      `${JSON.stringify(record, null, 2)}\n`,
    );
  });
});
