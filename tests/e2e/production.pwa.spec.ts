import type { Page } from "@playwright/test";
import { AuthStub } from "./auth-stub";
import {
  armReload,
  BANNER,
  build,
  checkForUpdate,
  expect,
  type Generations,
  mark,
  marked,
  navigate,
  quiet,
  test,
  updateRegion,
  workerActive,
} from "./pwa-world";

/**
 * WEB-14a, the PRODUCTION build (`dist-pwa/production-a`: a byte copy of `dist`; `production-b`: the same build with another label),
 * served with the reference nginx configuration's semantics and the production security headers by scripts/serve-generations.mjs.
 *
 *  P-P1 the app registers the worker itself (no test registration), and the next navigation is controlled;
 *  P-P2 the neutral update banner (signed out), its announcement through the neutral live region (revision 1, R8), and the reload onto B;
 *  P-P3 the API compatibility screen offers the update when a newer client is waiting;
 *  P-P4 installability in Chromium (`Page.getInstallabilityErrors` empty; the manifest and its icons are fetched);
 *  P-P5 the production content security policy: no violation, no console message, with the worker and the manifest;
 *  P-P6/P-P7 (revision 39) unfinished sign-in/join input that no reload brings back stops the update (below);
 *  P-P8 (revision 40, R40-GATE) a sign-in held behind the session's gate while the update is accepted, then refused: its username returns.
 *
 * FIXTURE evidence about the built client (no backend: `/health` is the server's stub).
 */
test.use({ firstGeneration: "production-a" });

const ENTRY = "Sign in to Atlas";

/** Records every content security policy violation the page reports, from its first script on. */
async function openNeutral(page: Page, world: Generations): Promise<void> {
  await recordViolations(page);
  await navigate(page, `${world.url}/`);
  await page.waitForLoadState("load");
  await expect(page.getByText(ENTRY)).toBeVisible();
}
async function recordViolations(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const scope = window as unknown as { __csp: string[] };
    scope.__csp = [];
    document.addEventListener("securitypolicyviolation", (event) => {
      scope.__csp.push(`${event.violatedDirective} ${event.blockedURI}`);
    });
  });
}
const violations = (page: Page) =>
  page.evaluate(() => (window as unknown as { __csp: string[] }).__csp);

test("P-P1, P-P5: the production app registers the worker itself; the next load is controlled; no policy violation", async ({
  page,
  generations,
}) => {
  await openNeutral(page, generations);
  // No test code registers anything: the app did.
  await workerActive(page);
  const registration = await page.evaluate(async () => {
    const found = await navigator.serviceWorker.getRegistration();
    return {
      scope: found?.scope ?? null,
      script: found?.active?.scriptURL ?? null,
    };
  });
  expect(registration.scope).toBe(`${generations.url}/`);
  expect(registration.script).toBe(`${generations.url}/sw.js`);
  await quiet(page);
  await page.reload();
  await page.waitForLoadState("load");
  await expect(page.getByText(ENTRY)).toBeVisible();
  expect(
    await page.evaluate(() => navigator.serviceWorker.controller !== null),
  ).toBe(true);
  expect(await violations(page)).toEqual([]);
});

test("P-P2: signed out, the neutral banner offers B and 'Reload' reloads onto it", async ({
  page,
  generations,
}) => {
  await openNeutral(page, generations);
  await workerActive(page);
  await quiet(page);
  await page.reload();
  await page.waitForLoadState("load");
  expect(await build(page)).toBeNull();
  await generations.serve("production-b");
  await checkForUpdate(page);
  await expect(updateRegion(page).getByText(BANNER.available)).toBeVisible();
  await mark(page);
  await quiet(page);
  const pageReload = await armReload(page);
  await updateRegion(page)
    .getByRole("button", { name: "Reload", exact: true })
    .click();
  await pageReload.loaded();
  await page.waitForLoadState("load");
  await expect.poll(() => build(page)).toBe("b");
  await expect(page.getByText(ENTRY)).toBeVisible();
  expect(await violations(page)).toEqual([]);
});

test("P-P2 (revision 1, R8): signed out, the update is announced exactly once through the neutral live region, and focus does not move", async ({
  page,
  generations,
}) => {
  await openNeutral(page, generations);
  await workerActive(page);
  await quiet(page);
  await page.reload();
  await page.waitForLoadState("load");
  // The neutral root's region is there, empty, BEFORE anything is offered (a region inserted with its message is not reliably read).
  const region = page.locator("[data-neutral-live-region]");
  await expect(region).toHaveCount(1);
  await expect(region).toHaveAttribute("role", "status");
  await expect(region).toHaveAttribute("aria-live", "polite");
  await expect(region).toHaveText("");
  // Every text the region takes, from now on, and where focus is.
  await page.evaluate(() => {
    const scope = window as unknown as { __said: string[] };
    scope.__said = [];
    const element = document.querySelector("[data-neutral-live-region]");
    if (!element) throw new Error("no neutral live region");
    new MutationObserver(() => {
      const text = element.textContent ?? "";
      if (text !== "") scope.__said.push(text);
    }).observe(element, {
      childList: true,
      characterData: true,
      subtree: true,
    });
  });
  // Where focus is now (compared by identity: the element itself).
  await page.evaluate(() => {
    (window as unknown as { __focused: Element | null }).__focused =
      document.activeElement;
  });
  await generations.serve("production-b");
  await checkForUpdate(page);
  await expect(updateRegion(page).getByText(BANNER.available)).toBeVisible();
  await expect(region).toHaveText(BANNER.available);
  await page.waitForTimeout(500);
  expect(
    await page.evaluate(
      () => (window as unknown as { __said: string[] }).__said,
    ),
  ).toEqual([BANNER.available]);
  // One region announces it: no other live region in the page holds the message.
  await expect(
    page.locator('[aria-live], [role="status"], [role="alert"]', {
      hasText: BANNER.available,
    }),
  ).toHaveCount(1);
  expect(
    await page.evaluate(
      () =>
        document.activeElement ===
        (window as unknown as { __focused: Element | null }).__focused,
    ),
  ).toBe(true);
});

test("P-P3: the API compatibility screen offers the update when the server is newer and a newer client is waiting", async ({
  page,
  generations,
}) => {
  await openNeutral(page, generations);
  await workerActive(page);
  await generations.health({ status: "ok", api_version: "0.32.0" });
  await generations.serve("production-b");
  await quiet(page);
  await page.reload();
  await page.waitForLoadState("load");
  await expect(
    page.getByRole("heading", {
      level: 1,
      name: "Atlas can't work with this server yet",
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Reload to update" }),
  ).toBeVisible();
});

test("P-P4: installable in Chromium: no installability error, and the manifest and its icons are served", async ({
  page,
  generations,
  browserName,
  context,
}) => {
  test.skip(
    browserName !== "chromium",
    "Page.getInstallabilityErrors is Chromium's (Chrome DevTools Protocol); Safari and Firefox installation is WEB-15 release evidence",
  );
  await openNeutral(page, generations);
  await workerActive(page);
  await quiet(page);
  await page.reload();
  await page.waitForLoadState("load");
  const cdp = await context.newCDPSession(page);
  const { installabilityErrors } = await cdp.send(
    "Page.getInstallabilityErrors",
  );
  expect(installabilityErrors).toEqual([]);
  const manifest = await cdp.send("Page.getAppManifest");
  expect(manifest.errors).toEqual([]);
  expect(manifest.url).toBe(`${generations.url}/manifest.webmanifest`);
  const parsed = JSON.parse(manifest.data ?? "{}") as {
    name?: string;
    icons?: Array<{ src: string }>;
  };
  expect(parsed.name).toBe("Atlas");
  for (const icon of parsed.icons ?? []) {
    const response = await page.request.get(`${generations.url}${icon.src}`);
    expect(response.status(), icon.src).toBe(200);
  }
});

/**
 * WEB-14a revision 39 (review of revision 38, R40-COMPOSITION; design assessment C1/C3, Q9). Unfinished input that no reload brings back
 * (signing in, joining: their readers and the invitation live in page memory, and no next page is proven to be this tab's) stops the update
 * on the page that holds it: build A stays, with the input, and nothing is written to the tab's storage or sent. Only the person's explicit
 * "Discard and reload anyway", or finishing/clearing the input, moves the tab onto B. The Join preview is a SYNTHETIC response (no backend:
 * not registration evidence); the worker, storage, bootstrap and generations are real. Promoted from the review's
 * `.agtx/evidence/review-r38-20261027/invitation.spec.ts`, whose expected destination (B with the username restored) is replaced by the
 * approved preservation branch; its privacy and no-business-send assertions are kept.
 */
const KEPT_INPUT =
  "Reloading now would lose what you've entered here, so Atlas hasn't reloaded.";
const SECRET = "NeverPersistTheSecret1!";
/** Revision 40 (P-P8): the banner while a save-first reload is being prepared (`UpdateBanner.tsx`, SAVING_TEXT). */
const SAVING = "Saving your unfinished form before reloading…";
const stored = (page: Page) =>
  page.evaluate(() =>
    JSON.stringify([
      Object.entries(sessionStorage),
      Object.entries(localStorage),
    ]),
  );
const businessSends = async (world: Generations) =>
  (await world.log()).filter((e) => e.method !== "GET" && e.method !== "HEAD");

test("P-P6 (revision 39, R40-COMPOSITION): Join's typed username stops the update; A stays with the input; discarding it reloads onto B", async ({
  page,
  generations,
}) => {
  await page.route("**/registration/preview", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        household: null,
        expires_at: "2026-12-31T00:00:00Z",
      }),
    }),
  );
  // The invitation is opened as the FIRST load, which the worker does not control (no clientsClaim): WebKit sends a controlled page's
  // requests through the worker, past Playwright's route (revision 39, pool request-efe459c93fea42648667: the preview reached the
  // generation server, 405, and this premise failed). Another tab of the origin, controlled by A, makes B wait (a worker with no
  // controlled client would activate at once, and nothing would be offered: local diagnostic native-local-2).
  await recordViolations(page);
  await navigate(page, `${generations.url}/join#t=${"a".repeat(64)}`);
  await expect(
    page.getByRole("heading", { name: "You're invited to join Atlas" }),
  ).toBeVisible();
  await workerActive(page);
  expect(
    await page.evaluate(() => navigator.serviceWorker.controller === null),
  ).toBe(true);
  const other = await page.context().newPage();
  await other.goto(`${generations.url}/`);
  await expect(other.getByText(ENTRY)).toBeVisible();
  expect(
    await other.evaluate(() => navigator.serviceWorker.controller !== null),
  ).toBe(true);
  await quiet(page);
  const username = page.getByRole("textbox", { name: "Username", exact: true });
  await username.fill("reviewer-join");
  await page.getByLabel("Password", { exact: true }).fill(SECRET);
  expect(new URL(page.url()).hash).toBe("");
  await quiet(page);
  await generations.serve("production-b");
  await checkForUpdate(page);
  await expect(
    updateRegion(page).getByRole("button", { name: "Reload", exact: true }),
  ).toBeVisible();
  await quiet(page);
  await generations.clearLog();
  await mark(page);
  await updateRegion(page)
    .getByRole("button", { name: "Reload", exact: true })
    .click();
  await expect(updateRegion(page).getByText(KEPT_INPUT)).toBeVisible();
  // The same document, still A, with the person's input (the password too: it never left the page).
  expect(await marked(page)).toBe(true);
  expect(await build(page)).toBeNull();
  await expect(username).toHaveValue("reviewer-join");
  await expect(page.getByLabel("Password", { exact: true })).toHaveValue(
    SECRET,
  );
  const kept = await stored(page);
  expect(kept).not.toContain("reviewer-join");
  expect(kept).not.toContain(SECRET);
  expect(kept).not.toContain("a".repeat(64));
  expect(await businessSends(generations)).toEqual([]);
  // The person's explicit choice.
  await quiet(page);
  const pageReload = await armReload(page);
  await updateRegion(page)
    .getByRole("button", { name: "Discard and reload anyway", exact: true })
    .click();
  await pageReload.loaded();
  await page.waitForLoadState("load");
  await expect.poll(() => build(page)).toBe("b");
  expect(await businessSends(generations)).toEqual([]);
  expect(await violations(page)).toEqual([]);
});

test("P-P7 (revision 39, labelled change from revision 38): public sign-in's typed username stops the update; cleared, 'Reload' moves onto B", async ({
  page,
  generations,
}) => {
  await openNeutral(page, generations);
  await workerActive(page);
  await quiet(page);
  await page.reload();
  const username = page.getByRole("textbox", { name: "Username", exact: true });
  await expect(username).toBeVisible();
  await username.fill("reviewer-alice");
  await page.getByLabel("Password", { exact: true }).fill(SECRET);
  await quiet(page);
  await generations.serve("production-b");
  await checkForUpdate(page);
  await quiet(page);
  await generations.clearLog();
  await mark(page);
  await updateRegion(page)
    .getByRole("button", { name: "Reload", exact: true })
    .click();
  await expect(updateRegion(page).getByText(KEPT_INPUT)).toBeVisible();
  expect(await marked(page)).toBe(true);
  await expect(username).toHaveValue("reviewer-alice");
  const kept = await stored(page);
  expect(kept).not.toContain("reviewer-alice");
  expect(kept).not.toContain(SECRET);
  // Still editable: the freeze was released. Cleared, the input is no longer unfinished.
  await username.fill("");
  await quiet(page);
  const pageReload = await armReload(page);
  await updateRegion(page)
    .getByRole("button", { name: "Reload", exact: true })
    .click();
  await pageReload.loaded();
  await page.waitForLoadState("load");
  await expect.poll(() => build(page)).toBe("b");
  await expect(page.getByLabel("Password", { exact: true })).toHaveValue("");
  expect(await businessSends(generations)).toEqual([]);
  expect(await violations(page)).toEqual([]);
});

/**
 * WEB-14a revision 40 (review of revision 39, R40-GATE; design assessment ae2a506e… C1/C2, Q5): the review's composition in a real
 * engine. A password sign-in is submitted on the public page; the AuthStub (`auth-stub.ts`, a stubbed network: never backend evidence)
 * HOLDS the activation answer, so the real session shows its gate ("Finishing sign-in") and the form is unmounted. The update is accepted
 * meanwhile ("Reload"); the sign-in is outstanding work, so nothing reloads. The held answer is then released as a definitive activation
 * refusal (`device_capacity`), and the same public sign-in surface comes back: the exact username is there (the password is not), the
 * refusal is shown, and the tab stays on A with "Reloading now would lose…". Topology as P-P6: the sign-in page is the FIRST, uncontrolled
 * load (WebKit sends a controlled page's requests through the worker, past Playwright's routes), and another controlled tab makes B wait.
 */
test("P-P8 (revision 40, R40-GATE): a sign-in held behind the gate while the update is accepted; refused, the same username comes back and A stays", async ({
  page,
  generations,
}) => {
  // The activation's definitive refusal is a 503 (`device_capacity`), which the browser logs although the application handles it.
  test.info().annotations.push({ type: "provokes", description: "503" });
  const context = page.context();
  const stub = new AuthStub();
  stub.addAccount("reviewer-alice", SECRET);
  const isActivate = (r: { method: string; path: string }) =>
    r.method === "POST" && r.path === "/browser-sessions/activate";
  stub.answerNext(isActivate, {
    status: 503,
    body: {
      code: "device_capacity",
      message: "capacity",
      request_id: "req-r40-gate",
      details: [],
    },
  });
  const held = stub.hold(isActivate, 1);
  await stub.install(context);
  await openNeutral(page, generations);
  await workerActive(page);
  expect(
    await page.evaluate(() => navigator.serviceWorker.controller === null),
  ).toBe(true);
  const other = await context.newPage();
  await other.goto(`${generations.url}/`);
  await expect(other.getByText(ENTRY)).toBeVisible();
  expect(
    await other.evaluate(() => navigator.serviceWorker.controller !== null),
  ).toBe(true);
  await quiet(page);
  const username = page.getByRole("textbox", { name: "Username", exact: true });
  await username.fill("reviewer-alice");
  await page.getByLabel("Password", { exact: true }).fill(SECRET);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  const gate = page.getByRole("heading", {
    name: "Finishing sign-in",
    exact: true,
  });
  await expect(gate).toBeVisible();
  await expect(username).toHaveCount(0);
  await expect.poll(() => held.caught()).toBe(1);
  await generations.serve("production-b");
  await checkForUpdate(page);
  await expect(
    updateRegion(page).getByRole("button", { name: "Reload", exact: true }),
  ).toBeVisible();
  await mark(page);
  await updateRegion(page)
    .getByRole("button", { name: "Reload", exact: true })
    .click();
  // The accepted update waits for the outstanding sign-in: still A, still the gate.
  await expect(updateRegion(page).getByText(SAVING)).toBeVisible();
  expect(await marked(page)).toBe(true);
  held.release();
  await expect(gate).toHaveCount(0);
  await expect(username).toHaveValue("reviewer-alice");
  await expect(page.getByLabel("Password", { exact: true })).toHaveValue("");
  await expect(
    page.getByRole("alert").filter({ hasText: "req-r40-gate" }),
  ).toBeVisible();
  await expect(updateRegion(page).getByText(KEPT_INPUT)).toBeVisible();
  expect(await marked(page)).toBe(true);
  expect(await build(page)).toBeNull();
  const kept = await stored(page);
  expect(kept).not.toContain("reviewer-alice");
  expect(kept).not.toContain(SECRET);
  expect(stub.count("POST", "/browser-sessions/activate")).toBe(1);
  expect(await businessSends(generations)).toEqual([]);
  // Cleared, the input is no longer unfinished: "Reload" moves onto B.
  await username.fill("");
  await quiet(page);
  const pageReload = await armReload(page);
  await updateRegion(page)
    .getByRole("button", { name: "Reload", exact: true })
    .click();
  await pageReload.loaded();
  await page.waitForLoadState("load");
  await expect.poll(() => build(page)).toBe("b");
  expect(await violations(page)).toEqual([]);
});
