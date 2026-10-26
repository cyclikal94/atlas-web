import type { Page } from "@playwright/test";
import {
  API,
  ENABLED,
  expect,
  exposeSession,
  ORIGIN,
  proxy,
  proxyMark,
  records,
  type SettledLike,
  signIn,
  test,
  untilRequestsRetired,
  untilView,
  view,
} from "./helpers";

/**
 * I-U2 (WEB-14a; the WEB-08a I-13 residual "real offline reload with a service worker"), against the RELEASED backend behind the delaying
 * proxy, with the build that ships the worker (`scripts/integration/run.mjs --app dist-pwa/fixture-a -- tests/integration/integration.pwa.spec.ts`).
 * A person signs in for real; the app's own worker controls the page; the device goes offline; a reload shows the settled account from the
 * precache and the local records, and NOTHING reaches the proxy. Without `--app` (the ordinary integration run, whose build has no worker)
 * it skips itself.
 *
 * Offline: Chromium and Firefox with `context.setOffline(true)`. WebKit (qualification probe Q-P0: its Playwright build fails a worker-served
 * navigation under `setOffline`) is told it is offline (`navigator.onLine` false from the first script on), and the proxy holds anything that
 * still arrives, so a request would be SEEN in the log; the assertion is the same.
 */
const PWA = (process.env.ATLAS_INTEGRATION_APP ?? "").includes("dist-pwa");

async function openSticky(page: Page): Promise<void> {
  await page.goto(`${ORIGIN}/__session?sticky=1&route=/today`);
  await exposeSession(page);
}

/**
 * Revision 37 (R41): the readers a displayed Today document issues as its display lifts (accepted WEB-10a: `/daily` twice and the sharing
 * defaults). A document's retirement is counted only once these have been issued and answered for it (`untilRequestsRetired`).
 */
const TODAY_READERS = [/\/daily(\?|$)/, /\/defaults\/snapshot(\?|$)/];

const settledOf = async (page: Page): Promise<SettledLike> => {
  const settled = (await records(page)).auth_state.settled;
  if (settled === null) throw new Error("setup: no settled session");
  return settled as SettledLike;
};

/**
 * Revision 37 (R41; design assessment Q9/Q10): TEST INSTRUMENTATION for the unfinished-request control only. Pages loaded from now on hold
 * the DELIVERY of the native answer to `/daily` (the response object, after the proxy has answered) until `__releaseAnswers()`, so a
 * request lease stays unretired while the proxy shows nothing in flight. The production session, worker and backend are unchanged.
 */
const holdDailyAnswers = (page: Page) =>
  page.context().addInitScript(() => {
    const scope = window as unknown as {
      __heldAnswers: Array<() => void>;
      __releaseAnswers: () => void;
    };
    scope.__heldAnswers = [];
    scope.__releaseAnswers = () => {
      for (const release of scope.__heldAnswers.splice(0)) release();
    };
    const native = window.fetch.bind(window);
    window.fetch = async (...args: Parameters<typeof fetch>) => {
      const response = await native(...args);
      if (new URL(response.url, location.href).pathname.endsWith("/daily"))
        await new Promise<void>((resolve) => scope.__heldAnswers.push(resolve));
      return response;
    };
  });

test("I-U2: signed in for real, the worker controls the page; offline, a reload shows the settled account with no request reaching the proxy", async ({
  context,
  page,
  browserName,
}, info) => {
  test.skip(
    !ENABLED || !PWA,
    "needs the worker-enabled build: scripts/integration/run.mjs --app dist-pwa/fixture-a",
  );
  const first = await proxyMark();
  await openSticky(page);
  expect((await signIn(page, "alice")).kind).toBe("settled");
  await untilView(page, "displaying");
  // The app registered its worker; the next load is controlled by it.
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  const settled = await settledOf(page);
  // Revision 37 (R41): the first document goes only once its own requests are retired in the session record, not when the proxy is idle.
  await info.attach("premise-initial-document", {
    body: JSON.stringify(
      await untilRequestsRetired(page, settled, {
        since: first,
        readers: TODAY_READERS,
        label: "I-U2 initial document before the worker-controlled reload",
      }),
    ),
    contentType: "application/json",
  });
  const controlledFrom = await proxyMark();
  await page.reload();
  await exposeSession(page);
  await untilView(page, "displaying");
  expect(
    await page.evaluate(() => navigator.serviceWorker.controller !== null),
  ).toBe(true);
  // Let the page's own reads after display finish before the network goes (WebKit reports a cancelled fetch as a page error).
  await expect
    .poll(async () => {
      const log = await proxy.log();
      return log.filter((entry) => entry.status === undefined).length;
    })
    .toBe(0);
  // Revision 37 (R41): proxy completion is transport evidence only; the premise of the offline reload is the record's retirement.
  await info.attach("premise-controlled-document", {
    body: JSON.stringify(
      await untilRequestsRetired(page, settled, {
        since: controlledFrom,
        readers: TODAY_READERS,
        label: "I-U2 controlled document before the offline reload",
      }),
    ),
    contentType: "application/json",
  });

  if (browserName === "webkit") {
    await context.addInitScript(() => {
      Object.defineProperty(navigator, "onLine", {
        configurable: true,
        get: () => false,
      });
    });
    await proxy.addRule({ action: "hold_request" });
  } else await context.setOffline(true);
  const before = (await proxy.log()).length;

  await page.reload();
  await exposeSession(page);
  await untilView(page, "displaying");
  expect(
    await page.evaluate(() => window.__s.identity.get()?.account_id ?? null),
  ).not.toBeNull();
  await expect(
    page.getByRole("heading", { level: 1, name: "Today" }),
  ).toBeVisible();
  await page.waitForTimeout(1_000);
  const reached = (await proxy.log()).slice(before);
  expect(
    reached.map((entry) => `${entry.method} ${entry.path}`),
    "nothing may reach the proxy while offline",
  ).toEqual([]);
  // Not even the shell or an asset: the worker answered them from its precache.
  expect(reached.some((entry) => entry.path.startsWith(API))).toBe(false);
});

test("I-U2 control (revision 37, R41): a request answered at the proxy but not delivered to the page is unfinished: the premise refuses it, and offline the reload is neutral with no request", async ({
  context,
  page,
  browserName,
  tolerates,
}, info) => {
  test.skip(
    !ENABLED || !PWA,
    "needs the worker-enabled build: scripts/integration/run.mjs --app dist-pwa/fixture-a",
  );
  const first = await proxyMark();
  await openSticky(page);
  expect((await signIn(page, "alice")).kind).toBe("settled");
  await untilView(page, "displaying");
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  const settled = await settledOf(page);
  await untilRequestsRetired(page, settled, {
    since: first,
    readers: TODAY_READERS,
    label: "control: initial document before the worker-controlled reload",
  });
  await holdDailyAnswers(page);
  // ADAPTATION (labelled for review): with its `/daily` answer held, the controlled document cannot show Today, and the neutral document
  // after it never runs the protected tree: WebKit reports their preloaded chunks as unused a few seconds after load. Only these
  // warnings, only in WebKit, only in this control; each is attached to the report (`tolerated-console-messages`).
  if (browserName === "webkit")
    tolerates(
      /^The resource \S+\/assets\/\S+\.js was preloaded using link preload but not used within a few seconds from the window's load event\./,
    );
  const controlledFrom = await proxyMark();
  await page.reload();
  await exposeSession(page);
  await untilView(page, "displaying");
  await page.waitForFunction(
    () =>
      (window as unknown as { __heldAnswers: unknown[] }).__heldAnswers
        .length >= 1,
  );
  // The proxy has answered everything; the page has not handled the held answer, so its request lease is still live.
  await expect
    .poll(
      async () =>
        (await proxy.log()).filter((entry) => entry.status === undefined)
          .length,
    )
    .toBe(0);
  const live = Object.values((await records(page)).auth_state.leases).filter(
    (lease) => lease.class !== "exposure",
  );
  expect(
    live.length,
    "a request lease outlives the proxy's answer",
  ).toBeGreaterThan(0);
  // The premise refuses this document (within its bound), naming the unretired request.
  await expect(
    untilRequestsRetired(page, settled, {
      since: controlledFrom,
      readers: TODAY_READERS,
      label: "control: controlled document with an undelivered answer",
      timeout: 3_000,
    }),
  ).rejects.toThrow(/were not retired/);
  await info.attach("premise-refused", {
    body: JSON.stringify({ leases: live.map((lease) => lease.class) }),
    contentType: "application/json",
  });
  // Offline with the request unfinished: the next document cannot verify it and stays neutral; nothing reaches the proxy. WebKit is told it
  // is offline and the proxy holds anything that still arrives, as in I-U2 above.
  if (browserName === "webkit") {
    await context.addInitScript(() => {
      Object.defineProperty(navigator, "onLine", {
        configurable: true,
        get: () => false,
      });
    });
    await proxy.addRule({ action: "hold_request" });
  } else await context.setOffline(true);
  const before = (await proxy.log()).length;
  await page.reload();
  await exposeSession(page);
  await untilView(page, "neutral", "1e.interrupted_offline");
  await page.waitForTimeout(1_000);
  const reached = (await proxy.log()).slice(before);
  expect(
    reached.map((entry) => `${entry.method} ${entry.path}`),
    "nothing may reach the proxy while offline",
  ).toEqual([]);
  expect((await view(page)).kind).toBe("neutral");
});
