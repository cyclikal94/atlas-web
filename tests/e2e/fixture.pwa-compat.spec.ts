import type { BrowserContext, Page } from "@playwright/test";
import {
  armReload,
  build,
  expect,
  type Generations,
  mark,
  marked,
  navigate,
  quiet,
  test,
  workerActive,
} from "./pwa-world";

/**
 * WEB-14a P-C1: the `api_version` gate's client side, delivery-slices cases 1-3, each as a FIXTURE test (the server's `/health` is the
 * generation server's stub; the real backend's is I-P1/I-11/I-O3). Signed out, so the API compatibility screen shows (D-08):
 *
 *  1. MISSING: paused, "can't be sure"; the paced re-check (30 s, a production constant, waited for in real time) lifts it once the
 *     server reports a supported version ("Atlas will keep checking").
 *  2. MATCHING: no screen, the ordinary entry.
 *  3. MISMATCHED (0.30.0): paused; the coordinator looks for a newer client at once, finds B, and the screen offers "Reload to update";
 *     reloading onto B (whose range is the same: no build with another range is made) still shows the mismatch, and the gate lifts when the
 *     server reports a version in range again, at the next reconnect, without a reload.
 *
 * What is NOT shown here: that queued drafts are sent exactly once after the lift (the dispatcher's pause is WEB-09a's and is covered by
 * `tests/data/outbox-answers.test.ts`, and against the real backend by I-O3 and I-P1).
 */
const MISSING =
  "This server didn't say which version it is, so Atlas can't be sure it is safe to use. Ask whoever runs Atlas for you to check it.";
const UNSUPPORTED =
  "This copy of Atlas doesn't work with the version of the server it is talking to. Ask whoever runs Atlas for you to update one of them.";
const ENTRY = "Sign in to Atlas";

async function openSignedOut(
  context: BrowserContext,
  world: Generations,
): Promise<Page> {
  const page = await context.newPage();
  await navigate(page, `${world.url}/__session?sticky=1&route=/today`);
  await page.waitForLoadState("load");
  return page;
}

/** A reconnect: Chromium and Firefox go offline and back (the engine's own events); WebKit's emulation cannot, so `online` is dispatched. */
async function reconnect(
  context: BrowserContext,
  page: Page,
  browserName: string,
): Promise<void> {
  if (browserName === "webkit")
    await page.evaluate(() => window.dispatchEvent(new Event("online")));
  else {
    await context.setOffline(true);
    await context.setOffline(false);
  }
}

test("case 1, missing: paused and checking; the paced re-check lifts it once the server reports a supported version", async ({
  context,
  generations,
}) => {
  test.setTimeout(90_000);
  await generations.health({ status: "ok" });
  const page = await openSignedOut(context, generations);
  await expect(page.getByText(MISSING)).toBeVisible();
  await generations.health({ status: "ok", api_version: "0.29.0" });
  // Nothing else happens on the page: the session's own paced re-check (first after 30 s) finds the supported version.
  await expect(page.getByText(ENTRY)).toBeVisible({ timeout: 45_000 });
  await expect(page.getByText(MISSING)).toHaveCount(0);
});

test("case 2, matching: no pause, the ordinary entry", async ({
  context,
  generations,
}) => {
  const page = await openSignedOut(context, generations);
  await expect(page.getByText(ENTRY)).toBeVisible();
  const health = (await generations.log()).filter(
    (entry) => entry.path === "/health",
  );
  expect(health.length).toBeGreaterThanOrEqual(1);
});

test("case 3, mismatched: paused; a newer client is looked for and offered; the gate lifts at a reconnect once the server is in range", async ({
  context,
  generations,
  browserName,
}) => {
  const page = await openSignedOut(context, generations);
  await expect(page.getByText(ENTRY)).toBeVisible();
  await workerActive(page);
  await quiet(page);
  await page.reload();
  await page.waitForLoadState("load");
  await expect(page.getByText(ENTRY)).toBeVisible();

  // The server moves to 0.30.0, and a newer client (B) is deployed with it.
  await generations.health({ status: "ok", api_version: "0.30.0" });
  await generations.serve("fixture-b");
  await reconnect(context, page, browserName);
  await expect(page.getByText(UNSUPPORTED)).toBeVisible();
  // The coordinator looked for a newer client because the server is unsupported, and the screen offers it.
  const reload = page.getByRole("button", { name: "Reload to update" });
  await expect(reload).toBeVisible();
  await expect(
    page.getByText("A new version of Atlas is ready."),
  ).toBeVisible();
  await mark(page);
  await quiet(page);
  const pageReload = await armReload(page);
  await reload.click();
  await pageReload.loaded();
  await page.waitForLoadState("load");
  await expect.poll(() => build(page)).toBe("b");
  // B's range is the same as A's: still paused, and nothing more to offer.
  await expect(page.getByText(UNSUPPORTED)).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Reload to update" }),
  ).toHaveCount(0);

  // The server is in range again: the next reconnect lifts the gate without a reload.
  await generations.health({ status: "ok", api_version: "0.29.3" });
  await mark(page);
  await reconnect(context, page, browserName);
  await expect(page.getByText(ENTRY)).toBeVisible();
  expect(await marked(page)).toBe(true);
});
