import type { BrowserContext, Page } from "@playwright/test";
import {
  displayed,
  exempt,
  expect,
  goOffline,
  navigate,
  openApp,
  quiet,
  reloadQuietly,
  seedAccount,
  test,
  workerActive,
} from "./pwa-world";

/**
 * WEB-14a P-O1 and P-O2: offline navigation (Q10; WEB-03 3.7a) with the app's OWN registration of the worker, and the WEB-08a I-13 residual
 * at fixture level ("real offline reload with a service worker"). Once the worker controls the origin: a reload of an open tab, a cold start
 * (every tab closed) and a deep link never visited all open offline, and a settled account is shown with no network request at all; the
 * backend paths (the API, `/health`, `/ready`, `/auth`, `/oidc` and the OIDC callback) are never answered with the shell, online or
 * offline, and the worker never asks for them itself. Installation and offline loading do not depend on notification permission (it is
 * DENIED here in Chromium, and never granted in the others). FIXTURE evidence: the real-backend counterpart is I-P2.
 *
 * The offline method per engine is qualification probe Q-P0's (`goOffline`): WebKit's offline is the server going dark.
 */
const BACKEND = [
  "/api",
  "/api/experimental/v1/tasks",
  "/health?probe=1",
  "/ready",
  "/auth?return_to=x",
  "/oidc/callback?code=c&state=s",
];

async function denyNotifications(
  context: BrowserContext,
  page: Page,
  browserName: string,
): Promise<string> {
  if (browserName === "chromium") {
    const cdp = await context.newCDPSession(page);
    await cdp.send("Browser.setPermission", {
      permission: { name: "notifications" },
      setting: "denied",
    });
  }
  return page.evaluate(() =>
    "Notification" in window ? Notification.permission : "unsupported",
  );
}

test("offline: reload, cold start and an unvisited deep link open from the precache, and a settled account is shown with no request", async ({
  context,
  generations,
  browserName,
}) => {
  await seedAccount(context, generations);
  const first = await openApp(context, generations, { form: false });
  const permission = await denyNotifications(context, first, browserName);
  expect(permission).not.toBe("granted");
  if (browserName === "chromium") expect(permission).toBe("denied");
  await workerActive(first);
  await reloadQuietly(first);
  expect(
    await first.evaluate(() => navigator.serviceWorker.controller !== null),
  ).toBe(true);
  await quiet(first);

  await goOffline(context, generations, browserName);
  await generations.clearLog();

  // An open tab reloads.
  await first.reload();
  await displayed(first);
  await expect(
    first.getByRole("heading", { level: 1, name: "Today" }),
  ).toBeVisible();

  // An unvisited deep link, opened from that tab (an opener-copied tab keeps the harness).
  const [deep] = await Promise.all([
    context.waitForEvent("page"),
    first.evaluate(() => {
      window.open("/tasks/never-visited");
    }),
  ]);
  await displayed(deep);
  expect(new URL(deep.url()).pathname).toBe("/tasks/never-visited");

  // A cold start: every tab closed, then the app is opened again.
  await deep.close();
  await first.close();
  const cold = await openApp(context, generations, { form: false });
  await expect(
    cold.getByRole("heading", { level: 1, name: "Today" }),
  ).toBeVisible();
  await cold.waitForTimeout(500);

  // Nothing reached the server while offline: not the shell, not an asset, not the API.
  expect(await generations.log()).toEqual([]);
});

test("backend paths and the OIDC callback are never answered with the shell, online or offline, and the worker never asks for them", async ({
  context,
  generations,
  browserName,
  requests,
}) => {
  await seedAccount(context, generations);
  const app = await openApp(context, generations, { form: false });
  await workerActive(app);
  // Revision 43: observed from the app's reload on, so the first probe window always holds the reloaded app's own reads (in every engine,
  // not only when they happen to be late): ordinary page traffic is checked to be told apart, not merely absent.
  let observing = await requests.open();
  await reloadQuietly(app);
  // A page of the same origin, controlled by the worker, used ONLY to navigate to the backend paths (exempt: the browser's messages about
  // a backend's 404 document are not the app's).
  const probe = await context.newPage();
  exempt(probe);
  await navigate(probe, `${generations.url}/__neutral`);
  await probe.waitForLoadState("load");
  expect(
    await probe.evaluate(() => navigator.serviceWorker.controller !== null),
  ).toBe(true);

  // Online: each navigation reaches the server (the worker passed it on), once, and the answer is the backend's, never the shell.
  //
  // ADAPTED in revision 43 (F-FRESH-2, labelled). Revision 2's oracle compared the server's WHOLE log with `[path]`, so it assumed nothing
  // else could ask the server anything during a probe; but the signed-in Today tab (`app`) stays open and legitimately reads its sharing
  // defaults and both daily scopes after its reload (review r42 fresh: Darwin Firefox failed here with exactly those reads, from the app's
  // page, while the probe's `/api` answer was the correct 404). The intent is unchanged and now checked per request instead of inferred:
  // in consecutive windows that leave no gap, each probe navigation reaches the server exactly once, from the probe page, answered by
  // the server (not by a worker's fetch handler) with the expected status; every other request in the window is a page's own (the app's
  // reads), except exactly the browser's own `/sw.js` update check and `/favicon.ico` (revision 2's labelled exclusion); a worker's
  // request, a worker-answered backend request, a duplicate, an unfinished or an unattributable request fails
  // (tests/e2e/request-origin-judge.ts).
  //
  // Revision 44 (review r43, F-FRESH-2 incomplete_fix): every request admitted to a window must also END inside its bound (a browser
  // request still pending, failed without a server receipt or of unknown origin is a problem, not a pass), and the last online window is
  // FINAL: it has no successor to hand unfinished work to, and is closed before the offline half begins.
  let appReads = 0;
  for (const [index, path] of BACKEND.entries()) {
    const status = path.startsWith("/health") || path === "/ready" ? 200 : 404;
    const response = await probe.goto(`${generations.url}${path}`);
    const body = (await response?.text()) ?? "";
    expect(body, path).not.toContain("protected-root");
    expect(response?.status(), path).toBe(status);
    const judged = await requests.close(observing, {
      scope: "all",
      probe: { page: requests.labelOf(probe), path, status },
      final: index === BACKEND.length - 1,
    });
    expect(judged.problems, path).toEqual([]);
    expect(judged.complete, `${path}: every request of the window ended`).toBe(
      true,
    );
    appReads += judged.pageBackend.filter((attributed) =>
      attributed.seen.some((record) => record.page === requests.labelOf(app)),
    ).length;
    if (judged.next !== null) observing = judged.next;
  }
  expect(appReads, "the app's own backend reads, told apart").toBeGreaterThan(
    0,
  );

  // Offline: the same navigations fail; none is answered with the shell.
  await probe.goto(`${generations.url}/__neutral`);
  await probe.waitForLoadState("load");
  await quiet(app);
  await goOffline(context, generations, browserName);
  for (const path of BACKEND) {
    const response = await probe
      .goto(`${generations.url}${path}`)
      .catch(() => null);
    expect(response, `${path} must not be answered offline`).toBeNull();
  }
});

/**
 * WEB-14a revision 57 (Review 57, F-R57-3; design assessment of 6 November 2026, RC-H3, C-O1, Q-O2): the forcing control of the offline
 * transition. On the merged tree "offline: reload, cold start …" failed in Chromium about half the time because Today's reads (its lazy
 * screen mounting after `quiet()` was satisfied, measured) were on their way when `goOffline` cut the network: the browser logged each
 * failure. This case makes that ordering certain instead of likely: a Today read is HELD in the page once the person goes back to Today,
 * and released only when the page is told it is offline. With the old transition (the network first, the pages told after) the released
 * read meets a dead network in every run; with the corrected one (the pages first, the network once nothing is in flight) it is answered
 * by the live server and nothing fails. The hold is test instrumentation at the page's own `fetch`, counted in flight while held; the read
 * itself is the product's. Nothing reaches the server after the cut, as P-O1 asserts.
 */
test("offline transition (forcing control): a Today read on its way when the device goes offline is answered before the network goes; nothing fails, nothing reaches the server after", async ({
  context,
  generations,
  browserName,
}) => {
  await context.addInitScript(() => {
    const scope = window as unknown as {
      __inflight: number;
      __holdDaily?: boolean;
      __heldDaily?: { state: string; status?: number; online?: boolean };
    };
    const inner = window.fetch.bind(window);
    window.fetch = (...args: Parameters<typeof fetch>) => {
      const [input] = args;
      const url =
        typeof input === "string"
          ? input
          : input instanceof Request
            ? input.url
            : String(input);
      if (!scope.__holdDaily || !url.includes("/api/experimental/v1/daily"))
        return inner(...args);
      scope.__holdDaily = false;
      const held: { state: string; status?: number; online?: boolean } = {
        state: "held",
      };
      scope.__heldDaily = held;
      scope.__inflight += 1;
      return new Promise<Response>((resolve, reject) => {
        const go = () => {
          scope.__inflight -= 1;
          held.state = "sent";
          held.online = navigator.onLine;
          inner(...args).then(
            (response) => {
              held.state = "answered";
              held.status = response.status;
              resolve(response);
            },
            (error: unknown) => {
              held.state = "failed";
              reject(error);
            },
          );
        };
        if (!navigator.onLine) go();
        else window.addEventListener("offline", go, { once: true });
      });
    };
  });
  await seedAccount(context, generations);
  const page = await openApp(context, generations, { form: false });
  await workerActive(page);
  await reloadQuietly(page);
  await quiet(page);
  const nav = page.getByRole("navigation").first();
  await nav.getByRole("link", { name: "Tasks", exact: true }).click();
  await expect(
    page.getByRole("heading", { level: 1, name: "Tasks", exact: true }),
  ).toBeVisible();
  await quiet(page);
  // Back to Today: its screen mounts again and reads the day, the first of those reads held until the page is told it is offline.
  await page.evaluate(() => {
    (window as unknown as { __holdDaily: boolean }).__holdDaily = true;
  });
  await nav.getByRole("link", { name: "Today", exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as unknown as { __heldDaily?: { state: string } }).__heldDaily
            ?.state ?? null,
      ),
    )
    .toBe("held");

  await goOffline(context, generations, browserName);
  await generations.clearLog();
  const held = await page.evaluate(
    () =>
      (
        window as unknown as {
          __heldDaily?: { state: string; status?: number };
        }
      ).__heldDaily,
  );
  expect(
    held,
    "the held read was answered by the live server, before the network went",
  ).toEqual(expect.objectContaining({ state: "answered", status: 200 }));
  // Offline from now on: the open tab reloads from the precache, and nothing reaches the server.
  await page.reload();
  await displayed(page);
  await expect(
    page.getByRole("heading", { level: 1, name: "Today" }),
  ).toBeVisible();
  expect(await generations.log()).toEqual([]);
});
