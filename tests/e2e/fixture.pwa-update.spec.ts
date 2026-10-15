import type { Page } from "@playwright/test";
import {
  BANNER,
  build,
  checkForUpdate,
  controlled,
  displayed,
  expect,
  focus,
  mark,
  marked,
  openApp,
  quiet,
  reloadQuietly,
  seedAccount,
  test,
  updateRegion,
  workerActive,
} from "./pwa-world";

/**
 * WEB-14a P-U1 and P-U2: capability rows 400 ("Service worker update while a tab is open, across multiple tabs: manual update banner") and
 * 473 ("Service worker update available: non-auto-reloading banner"), WEB-04 8 and wireframe 6, in a real engine with the real worker of
 * the `pwa-fixture` build and the production composition on `/__session`. FIXTURE evidence (no backend; the generation server's stubs).
 *
 * Three tabs on generation A; B is deployed and ONE tab checks for it. Every tab shows the banner (including the two that did not check),
 * none reloads on its own, a dismissed banner comes back on the next return to the page or in-app navigation (revision 17, R24), accepting
 * in one tab reloads that tab only onto B, and the others say "Atlas updated in another tab" until each reloads itself.
 */
test.describe("P-U1/P-U2: the update banner across tabs", () => {
  test("every tab is told; nothing reloads unasked; only the accepting tab reloads onto B; the others say it was updated elsewhere", async ({
    context,
    generations,
  }) => {
    await seedAccount(context, generations);
    const first = await openApp(context, generations, { form: false });
    await workerActive(first);
    // The first installation controls pages from their next navigation (no clients.claim()).
    expect(await controlled(first)).toBe(false);
    await reloadQuietly(first);
    const second = await openApp(context, generations, { form: false });
    const third = await openApp(context, generations, { form: false });
    const tabs = [first, second, third];
    for (const tab of tabs) {
      expect(await controlled(tab)).toBe(true);
      expect(await build(tab)).toBe("a");
      await mark(tab);
    }

    await generations.serve("fixture-b");
    // Only the third tab looks for the update.
    await checkForUpdate(third);
    for (const tab of tabs)
      await expect(updateRegion(tab).getByText(BANNER.available)).toBeVisible();
    // Non-auto-reloading: some time later, no tab has reloaded.
    await first.waitForTimeout(2_000);
    for (const tab of tabs) expect(await marked(tab)).toBe(true);

    // Dismissed until the next return to the page.
    await second.getByRole("button", { name: "Not now" }).click();
    await expect(updateRegion(second).getByText(BANNER.available)).toBeHidden();
    await focus(second);
    await expect(
      updateRegion(second).getByText(BANNER.available),
    ).toBeVisible();

    // The first tab accepts: it alone reloads, onto B.
    await quiet(first);
    await first.getByRole("button", { name: "Reload", exact: true }).click();
    await expect.poll(() => marked(first).catch(() => false)).toBe(false);
    await displayed(first);
    await expect.poll(() => build(first)).toBe("b");
    await expect(updateRegion(first).getByText(BANNER.available)).toBeHidden();
    await expect(updateRegion(first).getByText(BANNER.elsewhere)).toBeHidden();

    // The other two were updated elsewhere: they say so, and have not reloaded.
    for (const tab of [second, third]) {
      await expect(updateRegion(tab).getByText(BANNER.elsewhere)).toBeVisible();
      expect(await marked(tab)).toBe(true);
      expect(await build(tab)).toBe("a");
    }

    // "Reload here" reloads that tab only.
    await quiet(second);
    await second.getByRole("button", { name: "Reload here" }).click();
    await expect.poll(() => marked(second).catch(() => false)).toBe(false);
    await displayed(second);
    await expect.poll(() => build(second)).toBe("b");
    expect(await marked(third)).toBe(true);
    await expect(updateRegion(third).getByText(BANNER.elsewhere)).toBeVisible();
  });

  test("R24: a dismissed banner comes back on the next in-app navigation, in the same document, for both variants", async ({
    context,
    generations,
  }) => {
    // WEB-04 wireframe 6: a dismissed banner reappears on the next natural navigation or app focus (revision 17, R24). The focus path is
    // the test above; here no focus is dispatched, and the page stays the same document throughout (`mark`).
    const frames = (page: Page) =>
      page.evaluate(
        () =>
          new Promise((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(resolve)),
          ),
      );
    const primary = (page: Page) =>
      page.getByRole("navigation", { name: "Primary" });
    await seedAccount(context, generations);
    const acting = await openApp(context, generations, { form: false });
    await workerActive(acting);
    await reloadQuietly(acting);
    const tab = await openApp(context, generations, { form: false });
    await tab.bringToFront();
    await mark(tab);
    await generations.serve("fixture-b");
    await checkForUpdate(tab);
    const available = updateRegion(tab).getByText(BANNER.available);
    await expect(available).toBeVisible();

    await tab.getByRole("button", { name: "Not now" }).click();
    await expect(available).toBeHidden();
    // The control: a click on the destination already shown is no navigation, and the banner stays dismissed.
    await primary(tab)
      .getByRole("link", { name: "Today", exact: true })
      .click();
    await frames(tab);
    await expect(available).toBeHidden();
    await primary(tab)
      .getByRole("link", { name: "Tasks", exact: true })
      .click();
    await expect(
      tab.getByRole("heading", { level: 1, name: "Tasks", exact: true }),
    ).toBeVisible();
    await expect(available).toBeVisible();
    expect(await marked(tab)).toBe(true);

    // Another tab accepts: this one is updated elsewhere, dismisses that too, and only its own navigation brings it back.
    await mark(acting);
    await quiet(acting);
    await acting.getByRole("button", { name: "Reload", exact: true }).click();
    await expect.poll(() => marked(acting).catch(() => false)).toBe(false);
    await displayed(acting);
    await expect.poll(() => build(acting)).toBe("b");
    await tab.bringToFront();
    const elsewhere = updateRegion(tab).getByText(BANNER.elsewhere);
    await expect(elsewhere).toBeVisible();
    await tab.getByRole("button", { name: "Not now" }).click();
    await expect(elsewhere).toBeHidden();
    // The acting tab navigates (a DOM click: Playwright's own click could bring that tab to the front, and this one back later).
    await acting.evaluate(() =>
      document
        .querySelector<HTMLAnchorElement>(
          'nav[aria-label="Primary"] a[href="/people"]',
        )
        ?.click(),
    );
    await expect(
      acting.getByRole("heading", { level: 1, name: "People", exact: true }),
    ).toBeVisible();
    await frames(tab);
    await expect(elsewhere).toBeHidden();
    await primary(tab)
      .getByRole("link", { name: "People", exact: true })
      .click();
    await expect(
      tab.getByRole("heading", { level: 1, name: "People", exact: true }),
    ).toBeVisible();
    await expect(elsewhere).toBeVisible();
    expect(await marked(tab)).toBe(true);
    expect(await build(tab)).toBe("a");
  });

  test("a version already waiting when a tab opens is shown there at once, and the worker sent no backend request", async ({
    context,
    generations,
  }) => {
    await seedAccount(context, generations);
    const first = await openApp(context, generations, { form: false });
    await workerActive(first);
    // Controlled, so B waits for it (with no controlled page the browser activates B at once).
    await reloadQuietly(first);
    expect(await controlled(first)).toBe(true);
    await generations.serve("fixture-b");
    await checkForUpdate(first);
    await expect(updateRegion(first).getByText(BANNER.available)).toBeVisible();
    const late = await openApp(context, generations, { form: false });
    await expect(updateRegion(late).getByText(BANNER.available)).toBeVisible();
    // The worker's own requests are its installations (`Cache.addAll` of its static files), never a backend path: every backend request
    // the server saw is one of the pages' own reads (the API-version check and the identity, profile and device reads), and all are GETs.
    const backend = (await generations.log()).filter((entry) =>
      /^\/(?:api|health|ready|auth|oidc)(?:[/?]|$)/.test(entry.path),
    );
    expect(backend.length).toBeGreaterThan(0);
    for (const entry of backend) {
      expect(entry.method).toBe("GET");
      expect([
        "/health",
        "/api/experimental/v1/browser-sessions/current",
        "/api/experimental/v1/me",
        "/api/experimental/v1/sessions",
      ]).toContain(entry.path);
    }
  });

  test("P-U6: a FROZEN tab that misses the broadcast and the controller change finds out when it comes back, and does not reload", async ({
    context,
    generations,
    browserName,
  }) => {
    test.skip(
      browserName !== "chromium",
      "freezing a page needs Chrome DevTools Protocol's Page.setWebLifecycleState; the other engines are covered by the coordinator's unit model (a missed change found by the report on return)",
    );
    await seedAccount(context, generations);
    const acting = await openApp(context, generations, { form: false });
    await workerActive(acting);
    await reloadQuietly(acting);
    const frozen = await openApp(context, generations, { form: false });
    await generations.serve("fixture-b");
    await checkForUpdate(acting);
    await expect(
      updateRegion(frozen).getByText(BANNER.available),
    ).toBeVisible();
    await mark(frozen);
    await quiet(frozen);
    const cdp = await context.newCDPSession(frozen);
    await cdp.send("Page.setWebLifecycleState", { state: "frozen" });
    await mark(acting);
    await quiet(acting);
    await updateRegion(acting)
      .getByRole("button", { name: "Reload", exact: true })
      .click();
    await expect.poll(() => marked(acting).catch(() => false)).toBe(false);
    await displayed(acting);
    await expect.poll(() => build(acting)).toBe("b");
    await cdp.send("Page.setWebLifecycleState", { state: "active" });
    await frozen.bringToFront();
    await focus(frozen);
    await expect(
      updateRegion(frozen).getByText(BANNER.elsewhere),
    ).toBeVisible();
    expect(await marked(frozen)).toBe(true);
    expect(await build(frozen)).toBe("a");
  });
});
