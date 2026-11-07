import type { BrowserContext, Page } from "@playwright/test";
import { test as workerAllowed } from "./auth-helpers";
import { AuthStub } from "./auth-stub";
import { expect, test } from "./intercepted-auth";
import {
  displayedAs,
  newMarker,
  passwordOf,
  publicSignIn,
} from "./lifecycle-browser";

/**
 * R37 (WEB-14a revision 34): the boundary every AuthStub suite now relies on, shown in each engine on the PRODUCTION build with the
 * stubbed network. Under `test` from ./intercepted-auth no application document is ever controlled by the shipped worker: not the first
 * page, not a peer page opened later, not a reloaded page and not a page of a context the test creates itself, and each of those
 * documents' identity reads reaches the stub (its `/me` arrivals grow), never the preview's 404 through a worker. The app's own
 * registration attempt is observed to settle first, so "no registration" is never read before the app tried. Playwright's "block"
 * lets `register()` resolve without creating a registration (checked in all three engines), so its outcome alone proves nothing: the
 * registrations and the controller are what count.
 *
 * The control: the same probe, with registration allowed (auth-helpers' worker-neutral `test`, as production.offline.spec.ts uses), sees
 * the app's registration succeed and the reloaded page controlled. Without that control a probe that never saw a worker would pass
 * vacuously. This is harness evidence about the test topology, not worker, offline or integration evidence.
 */

type Attempt = "resolved" | "rejected" | "unavailable";
interface Control {
  attempts: Attempt[];
  controlled: boolean;
  registrations: number;
}

/** Records, from each document's first script, what became of the app's own `navigator.serviceWorker.register` calls. */
async function recordRegistrations(context: BrowserContext) {
  await context.addInitScript(() => {
    const scope = window as unknown as { __swAttempts: string[] };
    scope.__swAttempts = [];
    const container = navigator.serviceWorker;
    if (!container) {
      scope.__swAttempts.push("unavailable");
      return;
    }
    const register = container.register.bind(container);
    container.register = (...args: Parameters<typeof register>) => {
      const attempt = register(...args);
      attempt.then(
        () => scope.__swAttempts.push("resolved"),
        () => scope.__swAttempts.push("rejected"),
      );
      return attempt;
    };
  });
}

/** The page's worker state once the app's registration attempt has settled. */
async function controlOf(page: Page): Promise<Control> {
  await page.waitForFunction(
    () =>
      (window as unknown as { __swAttempts: string[] }).__swAttempts.length > 0,
    undefined,
    { timeout: 20_000 },
  );
  return page.evaluate(async () => ({
    attempts: (window as unknown as { __swAttempts: Attempt[] }).__swAttempts,
    controlled: navigator.serviceWorker?.controller != null,
    registrations:
      (await navigator.serviceWorker?.getRegistrations())?.length ?? 0,
  }));
}

function expectUncontrolled(control: Control, where: string) {
  expect(control.controlled, `${where}: controlled by a worker`).toBe(false);
  expect(control.registrations, `${where}: registrations`).toBe(0);
}

async function signedIn(context: BrowserContext, page: Page) {
  const a = newMarker("alice");
  const stub = new AuthStub();
  stub.addAccount(a, passwordOf(a));
  await stub.install(context);
  await recordRegistrations(context);
  const fromWorker: string[] = [];
  context.on("response", (response) => {
    if (
      response.url().includes("/api/experimental/v1/") &&
      response.fromServiceWorker()
    )
      fromWorker.push(response.url());
  });
  await page.goto("/");
  await publicSignIn(page, a);
  await displayedAs(page, a);
  return { a, stub, fromWorker };
}

test.describe("R37: intercepted authentication never meets a worker-controlled document", () => {
  test("the first page, a peer page, a reload and a context the test creates are uncontrolled, and each one's identity read reaches the stub", async ({
    page,
    context,
    browser,
  }) => {
    const { a, stub, fromWorker } = await signedIn(context, page);
    expectUncontrolled(await controlOf(page), "first page");

    let reads = stub.recordsFor("/me").length;
    const peer = await context.newPage();
    await peer.goto("/");
    await displayedAs(peer, a);
    expectUncontrolled(await controlOf(peer), "peer page");
    await expect
      .poll(() => stub.recordsFor("/me").length, {
        message: "the peer's identity read reached the stub",
      })
      .toBeGreaterThan(reads);

    reads = stub.recordsFor("/me").length;
    await page.reload();
    await displayedAs(page, a);
    expectUncontrolled(await controlOf(page), "reloaded page");
    await expect
      .poll(() => stub.recordsFor("/me").length, {
        message: "the reloaded page's identity read reached the stub",
      })
      .toBeGreaterThan(reads);
    expect(fromWorker, "API responses a worker served").toEqual([]);

    // A context the test owns, created without options: Playwright 1.63 copies the fixture's `serviceWorkers` into it.
    const own = await browser.newContext();
    try {
      const ownPage = await own.newPage();
      const owned = await signedIn(own, ownPage);
      expectUncontrolled(await controlOf(ownPage), "test-created context");
      expect(owned.stub.recordsFor("/me").length).toBeGreaterThan(0);
      expect(owned.fromWorker, "API responses a worker served").toEqual([]);
    } finally {
      await own.close();
    }
  });
});

workerAllowed.describe(
  "R37 control: the same probe with worker registration allowed",
  () => {
    workerAllowed(
      "the app's registration succeeds and the reloaded page is controlled, so the probe above can see a worker",
      async ({ page, context }) => {
        await recordRegistrations(context);
        await page.goto("/");
        await expect(page.getByText("Sign in to Atlas")).toBeVisible();
        expect((await controlOf(page)).attempts).toEqual(["resolved"]);
        await page.evaluate(async () => {
          await navigator.serviceWorker.ready;
        });
        await page.reload();
        await page.waitForFunction(
          () => navigator.serviceWorker.controller !== null,
        );
        expect(
          await page.evaluate(
            async () =>
              (await navigator.serviceWorker.getRegistrations()).length,
          ),
        ).toBe(1);
      },
    );
  },
);
