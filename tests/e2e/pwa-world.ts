import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { BrowserContext, Page } from "@playwright/test";
import { test as base, expect } from "./helpers";

/**
 * The PWA browser checks' world (WEB-14a): each test gets its OWN generation server (scripts/serve-generations.mjs over dist-pwa/, loopback,
 * OS-chosen ports), so a test can deploy a newer version under open tabs, take the server away and read every request it served. The pages
 * run the real composition (`/__session`: the production boot, the session, the data layer, the app-update coordinator and the real worker
 * of the `pwa-fixture` build). FIXTURE evidence: there is no backend; `/health` and the identity read are the server's stubs.
 *
 * The network is taken away per engine as qualification probe Q-P0 decided (.agtx/evidence/WEB-14a/qualification/q-p0.json): Chromium and
 * Firefox with `context.setOffline(true)`; WebKit, whose Playwright build fails a worker-served navigation under `setOffline` ("WebKit
 * encountered an internal error"), by the server destroying every connection (`dark`). WebKit's page then still believes it is online.
 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const DIST = join(ROOT, "dist-pwa");

export interface LogEntry {
  method: string;
  path: string;
  at: number;
  status: number;
}

export interface Generations {
  url: string;
  serve(generation: string): Promise<void>;
  dark(on: boolean): Promise<void>;
  health(body: unknown | { status: number }): Promise<void>;
  identity(value: { account: string; session: string } | null): Promise<void>;
  /**
   * Revision 13 (F-8): holds every identity read (`browser-sessions/current`) unanswered (`true`), or answers every held one and stops
   * holding (`false`). Answers how many were held when it was called.
   */
  holdIdentity(on: boolean): Promise<number>;
  log(): Promise<LogEntry[]>;
  clearLog(): Promise<void>;
  /** The files of a built generation, by path, with their SHA-256 (dist-pwa/generations.json). */
  files(generation: string): Record<string, string>;
  entry(generation: string): string;
}

const manifest = (): Record<
  string,
  { entry: string; files: Record<string, string> }
> => {
  const file = join(DIST, "generations.json");
  if (!existsSync(file))
    throw new Error(
      "dist-pwa/ is missing: run `pnpm build && node scripts/build-pwa-generations.mjs` before the PWA specs",
    );
  return JSON.parse(readFileSync(file, "utf8"));
};

async function startGenerations(
  generation: string,
): Promise<{ world: Generations; stop(): void }> {
  manifest();
  const child: ChildProcess = spawn(
    process.execPath,
    [
      join(ROOT, "scripts/serve-generations.mjs"),
      "--generation",
      generation,
      // EVERY production header, Cross-Origin-Opener-Policy included, in every engine (revision 1, R9). Revision 0 omitted COOP for Firefox;
      // the first navigation of a fresh Firefox page is made by `navigate` below instead.
    ],
    { cwd: ROOT, stdio: ["ignore", "pipe", "inherit"] },
  );
  const urls = await new Promise<{ url: string; control: string }>(
    (resolveUrls, reject) => {
      child.stdout?.once("data", (chunk) =>
        resolveUrls(JSON.parse(String(chunk))),
      );
      child.once("exit", (code) =>
        reject(new Error(`the generation server exited (${code})`)),
      );
    },
  );
  const post = async (path: string, body?: string) => {
    const response = await fetch(`${urls.control}${path}`, {
      method: "POST",
      ...(body === undefined ? {} : { body }),
    });
    if (!response.ok)
      throw new Error(
        `control ${path}: ${response.status} ${await response.text()}`,
      );
    return response.json();
  };
  const world: Generations = {
    url: urls.url,
    serve: async (name) => {
      await post(`/generation?name=${encodeURIComponent(name)}`);
    },
    dark: async (on) => {
      await post(`/dark?on=${on ? 1 : 0}`);
    },
    health: async (body) => {
      if (
        typeof body === "object" &&
        body !== null &&
        "status" in body &&
        typeof (body as { status: unknown }).status === "number"
      )
        await post(`/health?status=${(body as { status: number }).status}`);
      else await post("/health", JSON.stringify(body));
    },
    identity: async (value) => {
      await post("/identity", value === null ? "" : JSON.stringify(value));
    },
    holdIdentity: async (on) =>
      ((await post(`/identity/hold?on=${on ? 1 : 0}`)) as { held: number })
        .held,
    log: async () =>
      (await (
        await fetch(`${urls.control}/log`, { method: "GET" })
      ).json()) as LogEntry[],
    clearLog: async () => {
      await post("/log/clear");
    },
    files: (name) => manifest()[name]?.files ?? {},
    entry: (name) => manifest()[name]?.entry ?? "",
  };
  return { world, stop: () => child.kill("SIGTERM") };
}

/**
 * The ONE console message these specs allow, recorded and attached to the report rather than failing the test: Firefox's warning that the
 * shell's preloaded primary font (WEB-07's `<link rel="preload" as="font">`) "was not used within a few seconds", which Firefox logs several
 * seconds after a worker controller change, in the tab whose controller changed and in the tab that reloaded onto the new version.
 * Reproduced with the production build and no test harness (.agtx/evidence/WEB-14a/qualification/firefox-font-preload.md). It is a
 * warning about a hint and changes nothing a person sees; it is reported as finding F-2 for the owner of the preload. Nothing else is
 * allowed, in any engine.
 */
const ALLOWED: ReadonlyArray<{ browser: string; pattern: RegExp }> = [
  {
    browser: "firefox",
    pattern:
      /^\[JavaScript Warning: "The resource at “http:\/\/127\.0\.0\.1:\d+\/assets\/geist-latin-wght-normal-[A-Za-z0-9_-]+\.woff2” preloaded with link preload was not used within a few seconds\. Make sure all attributes of the preload tag are set correctly\." \{file: "http:\/\/127\.0\.0\.1:\d+\/[^"]*" line: 0\}\]$/,
  },
];

export const test = base.extend<{
  generations: Generations;
  /** The generation the server starts with (`test.use({ firstGeneration: "production-a" })` for the production build). */
  firstGeneration: string;
}>({
  firstGeneration: ["fixture-a", { option: true }],
  generations: async (
    { context, browserName, firstGeneration },
    use,
    testInfo,
  ) => {
    const allowed: string[] = [];
    const probes: string[] = [];
    // The suites' console guard covers the default page only; these specs open several pages, so EVERY page of the context is held to
    // the same rule: no console error or warning, no page error.
    const problems: string[] = [];
    let pages = 0;
    const began = Date.now();
    context.on("page", (page) => {
      const tab = `tab ${++pages}`;
      page.on("console", (message) => {
        if (exempted.has(page)) {
          probes.push(
            `${tab} ${page.url()} ${message.type()}: ${message.text()}`,
          );
          return;
        }
        if (
          message.type() === "warning" &&
          ALLOWED.some(
            (entry) =>
              entry.browser === browserName &&
              entry.pattern.test(message.text()),
          )
        ) {
          allowed.push(`${tab} ${message.text()}`);
          return;
        }
        if (message.type() === "error" || message.type() === "warning")
          problems.push(
            `${tab} +${Date.now() - began} ms ${page.url()} ${message.type()}: ${message.text()}`,
          );
      });
      page.on("pageerror", (error) =>
        (exempted.has(page) ? probes : problems).push(
          `${tab} +${Date.now() - began} ms ${page.url()} pageerror: ${error.message}`,
        ),
      );
    });
    // TEST INSTRUMENTATION: every page counts its fetches in flight, so a test waits for quiet before an action that reloads a tab
    // (Playwright WebKit reports a fetch a navigation cancels as a page error: .agtx memory, WEB-09a thirteenth revision).
    await context.addInitScript(() => {
      const counted = window as unknown as { __inflight: number };
      counted.__inflight = 0;
      const original = window.fetch.bind(window);
      window.fetch = (...args: Parameters<typeof fetch>) => {
        counted.__inflight += 1;
        return original(...args).finally(() => {
          counted.__inflight -= 1;
        });
      };
    });
    const started = await startGenerations(firstGeneration);
    try {
      await use(started.world);
      // The pages go before the server does: a server that stops under a live page fails its requests in flight.
      for (const page of context.pages())
        await page.close().catch(() => undefined);
    } finally {
      started.stop();
    }
    if (probes.length > 0)
      await testInfo.attach("probe-page-console-messages", {
        body: probes.join("\n"),
        contentType: "text/plain",
      });
    if (allowed.length > 0)
      await testInfo.attach("allowed-console-messages", {
        body: allowed.join("\n"),
        contentType: "text/plain",
      });
    expect(problems, "console errors and warnings in any page").toEqual([]);
  },
});
export { expect };

/**
 * THE FIRST NAVIGATION OF A FRESH PAGE (revision 1, R9). Playwright's Firefox (155) sometimes never reports a navigation it has made when
 * the document carries the production `Cross-Origin-Opener-Policy: same-origin` and the page starts at `about:blank` (a browsing-context
 * group switch): `page.goto` waits for an event that does not come, although the page loaded in under 0.1 s (status 200, `readyState`
 * complete, the app running, the same page object answering). Measured on this server: 4, 6 and 10 stalls in 80 fresh-page `goto`s with
 * COOP, none without it, none in 234 same-origin reloads with it, and none in 160 first navigations made by the page itself and read from the
 * page's own state (.agtx/evidence/WEB-14a/revision-1/firefox-coop.md). So in Firefox a fresh page navigates ITSELF (`location.assign`),
 * and the navigation is finished when the page's own navigation entry names the URL with status 200 and the document is `complete` (what
 * `goto` waits for); a navigation that fails or answers anything else never satisfies it, and the test fails at the timeout. Every other
 * navigation, and every navigation in Chromium and WebKit, is `page.goto`. The headers are the production ones throughout.
 */
export async function navigate(page: Page, url: string): Promise<void> {
  const engine = page.context().browser()?.browserType().name();
  if (engine !== "firefox" || page.url() !== "about:blank") {
    await page.goto(url);
    return;
  }
  await page.evaluate((target) => location.assign(target), url);
  await page.waitForFunction(
    (target) => {
      const entry = performance.getEntriesByType("navigation")[0] as
        | (PerformanceNavigationTiming & { responseStatus?: number })
        | undefined;
      // WEB-14a revision 2 (harness, labelled): while the page is still at about:blank, Firefox names its navigation entry "document",
      // which `new URL` refuses; a poll that lands before the navigation commits threw, and the throw reached the page as a page error
      // (driver attempt 7, run 2026-10-10T23-10-15.198Z-f3d7f9de). Such an entry is simply not the requested page yet.
      let requested = false;
      try {
        requested =
          entry !== undefined &&
          new URL(entry.name).href === new URL(target).href;
      } catch {
        requested = false;
      }
      return (
        entry !== undefined &&
        requested &&
        (entry.responseStatus === undefined || entry.responseStatus === 200) &&
        document.readyState === "complete"
      );
    },
    url,
    { polling: 50, timeout: 30_000 },
  );
}

const iso = () => new Date().toISOString();
export const settled = (account: string, epoch: number, session: string) => ({
  schema: 1,
  latest_epoch: epoch,
  fence_seq: 0,
  attempt: null,
  settled: {
    account_id: account,
    epoch,
    settled_at: iso(),
    session_id: session,
  },
  fences: {},
  leases: {},
});

/**
 * A signed-in account as an earlier visit left it: the settled record in `atlas-auth`, the account's database (created through the
 * production adapter on the data harness page), and the server's identity read answering for its session.
 */
export async function seedAccount(
  context: BrowserContext,
  world: Generations,
  account = "acct-a",
  session = "s1",
): Promise<void> {
  await world.identity({ account, session });
  const page = await context.newPage();
  await navigate(page, `${world.url}/__session?boot=off`);
  await page.waitForFunction(
    () => window.__atlasFixture?.session !== undefined,
  );
  await page.evaluate(
    (state) => window.__atlasFixture?.session?.seedAuthState(state),
    settled(account, 1, session),
  );
  // HARNESS (WEB-14a revision 7): the harness page imports its data labs without awaiting them; leaving it while one is still loading makes
  // WebKit (and Firefox) report the cancelled import as a page error, which the console guard rightly fails. Diagnosed with the order
  // forced (`.agtx/evidence/WEB-14a/revision-7/diag-seed`): leave only once the page's network is idle. No product code is involved.
  await page.waitForLoadState("networkidle");
  await page.goto(`${world.url}/__data`);
  await page.waitForFunction(() => window.__atlasData !== undefined);
  const created = await page.evaluate(async (id) => {
    const data = window.__atlasData;
    if (!data) throw new Error("the data harness is not loaded");
    data.setIdentity(id);
    const result = await data.open(id, { create: true });
    data.close(id);
    return result;
  }, account);
  expect(created).toBe("created");
  await page.close();
}

/** Opens the app (the production composition) on `route`, with the recoverable test form, and waits until the account is displayed. */
export async function openApp(
  context: BrowserContext,
  world: Generations,
  options: { route?: string; form?: boolean } = {},
): Promise<Page> {
  const page = await context.newPage();
  const query = new URLSearchParams({
    // A reload (the app's own, after an update) keeps the tab the harness.
    sticky: "1",
    route: options.route ?? "/today",
    ...(options.form === false ? {} : { form: "1" }),
  });
  await navigate(page, `${world.url}/__session?${query}`);
  await displayed(page);
  return page;
}

export async function displayed(page: Page): Promise<void> {
  // Nothing is asked of the page before it has loaded (Firefox warns of a layout forced by an early evaluation).
  await page.waitForLoadState("load");
  await expect
    .poll(() =>
      page.evaluate(() => {
        const root = document.getElementById("protected-root");
        return root !== null && !root.hasAttribute("inert");
      }),
    )
    .toBe(true);
}

/** Waits until the origin has an ACTIVE worker (the first installation finished). */
export async function workerActive(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
}

export const controlled = (page: Page) =>
  page.evaluate(() => navigator.serviceWorker.controller !== null);

/** The build a page runs (`data-atlas-build`, the generation's label). */
export const build = (page: Page) =>
  page.evaluate(() => document.documentElement.dataset.atlasBuild ?? null);

/** Marks the page's current document, so a test can tell that it was NOT reloaded (the mark survives) or was (it is gone). */
export async function mark(page: Page): Promise<void> {
  await page.evaluate(() => {
    (window as unknown as { __pwaMark?: number }).__pwaMark = 1;
  });
}
export const marked = (page: Page) =>
  page.evaluate(
    () => (window as unknown as { __pwaMark?: number }).__pwaMark === 1,
  );

/** Asks the page's registration to look for a newer worker (what a tab's own update check does). */
export const checkForUpdate = (page: Page) =>
  page.evaluate(async () => {
    const registration = await navigator.serviceWorker.getRegistration();
    await registration?.update();
  });

/**
 * The network goes away. In EVERY engine the server destroys every connection (nothing can reach it: Chromium's and Firefox's offline
 * emulation does not cover the worker's own script check or a request the worker passes on, which reached the server in the first run of
 * this spec), and the device says it is offline: Chromium and Firefox with `context.setOffline(true)`; WebKit, whose Playwright build fails a
 * worker-served navigation under `setOffline` (qualification probe Q-P0), by `navigator.onLine` reporting false in every page (an init
 * script for pages loaded from now on, and the same plus an `offline` event in the pages already open).
 */
export async function goOffline(
  context: BrowserContext,
  world: Generations,
  browserName: string,
): Promise<void> {
  await world.dark(true);
  // A page loaded from now on knows at once that it is offline (a reloaded Chromium page was seen asking `/health` before the emulation
  // reached it), and every open page is told.
  await context.addInitScript(() => {
    Object.defineProperty(navigator, "onLine", {
      configurable: true,
      get: () => false,
    });
  });
  if (browserName !== "webkit") await context.setOffline(true);
  else
    for (const page of context.pages())
      await page.evaluate(() => {
        Object.defineProperty(navigator, "onLine", {
          configurable: true,
          get: () => false,
        });
        window.dispatchEvent(new Event("offline"));
      });
}

const exempted = new WeakSet<Page>();
/**
 * A page that only PROBES what the server and the worker answer for a navigation (a backend path's 404 document): the browser's own
 * messages about that document (a 404, the policy refusing its user-agent style) are not the app's, so they are attached to the report
 * instead of failing the test. Never for a page that runs the app.
 */
export function exempt(page: Page): void {
  exempted.add(page);
}

/** Every precache generation cache the origin holds. */
export const precaches = (page: Page) =>
  page.evaluate(async () =>
    (await caches.keys()).filter((name) => name.startsWith("atlas-precache-")),
  );

/**
 * Waits until the page has no fetch in flight (before an action that reloads it), and brings it to the front: Firefox paints only the
 * front tab, so a tab reloaded in the background never uses the shell's preloaded font and warns that the preload went unused.
 */
export async function quiet(page: Page): Promise<void> {
  await page.bringToFront();
  // Bringing a tab to the front fires `focus` and `visibilitychange`, which may start reads a moment later: quiet is three samples in a
  // row, 100 ms apart, with nothing in flight.
  let quietSamples = 0;
  await expect
    .poll(
      async () => {
        const inflight = await page.evaluate(
          () => (window as unknown as { __inflight?: number }).__inflight ?? 0,
        );
        quietSamples = inflight === 0 ? quietSamples + 1 : 0;
        return quietSamples >= 3;
      },
      { intervals: [100] },
    )
    .toBe(true);
}

/** The test reloads the page (after quiet), and waits until the account is displayed again. */
export async function reloadQuietly(page: Page): Promise<void> {
  await page.bringToFront();
  await quiet(page);
  await page.reload();
  await displayed(page);
}

/** Dispatches a return to the page (the coordinator listens for `focus`). */
export const focus = (page: Page) =>
  page.evaluate(() => window.dispatchEvent(new Event("focus")));

/** The update banner's region (the announcer's live region repeats its text, so text is looked for here). */
export const updateRegion = (page: Page) =>
  page.getByRole("region", { name: "Update" });

export const BANNER = {
  available: "A new version of Atlas is available.",
  elsewhere: "Atlas updated in another tab.",
  superseded:
    "Atlas was updated in another tab and needs to reload here to keep working.",
} as const;
