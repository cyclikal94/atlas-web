import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { BrowserContext, Page } from "@playwright/test";
import { test as base, expect } from "./helpers";
import { armedOn, unsettled } from "./reload-receipt";
import { RequestRecorder } from "./request-origin";

export { armReload, type ReloadReceipt, reloadAfter } from "./reload-receipt";

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
/**
 * The built generations. WEB-14a revision 43 (F-FRESH-2, QUALIFICATION ONLY): `ATLAS_PWA_DIST` serves a disposable copy instead, so a
 * qualification can run the unchanged specs against a deliberately faulty worker (.agtx/evidence/revision-r43-20261102). No ordinary run
 * sets it.
 */
const DIST = process.env.ATLAS_PWA_DIST
  ? resolve(process.env.ATLAS_PWA_DIST)
  : join(ROOT, "dist-pwa");

export interface LogEntry {
  /** The server's unique, increasing request id (also sent as the response's `X-Atlas-Fixture-Request`). */
  id: number;
  method: string;
  path: string;
  at: number;
  status: number;
  /** null while the response is unfinished; "finished" once sent; "closed" if the connection closed first. */
  end: "finished" | "closed" | null;
  /** Revision 56 (C-H2): the path is a backend path (`/api`, `/health`, `/ready`, `/auth`, `/oidc` and below). */
  backend: boolean;
  /** Revision 56 (C-H2): a request for a document (a navigation), not a read a page made (scripts/serve-generations.mjs). */
  document: boolean;
  /** Revision 56 (C-H2): the stub identity was set when the server answered it (false while unanswered). */
  identity: boolean;
}

/**
 * WEB-14a revision 56 (Review 55 F-R55-1, design assessment C-H2): the backend READS a page made that the server answered 404 while the
 * stub identity was set, as `METHOD path` (query included). The stub answers a fixed set of reads for a seeded account
 * (scripts/serve-generations.mjs) and the app's set grows with every base merge, so a read the stub does not know is named here, in
 * every engine: Chromium and WebKit also log such a 404 on the console, without its URL, and Firefox does not log it at all. Not judged:
 * documents (an exempt probe page's navigation to a backend path is designed to meet the 404), requests answered while signed out (the
 * identity read's own 404 is the backend's "no session") and anything that is not a GET or HEAD.
 */
export const unansweredReads = (entries: readonly LogEntry[]): string[] =>
  entries
    .filter(
      (entry) =>
        (entry.method === "GET" || entry.method === "HEAD") &&
        entry.backend &&
        !entry.document &&
        entry.identity &&
        entry.status === 404,
    )
    .map((entry) => `${entry.method} ${entry.path}`);

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
  /**
   * WEB-14a revision 50 (review of revision 49): the server's CANNED READS (`POST /reads` of scripts/serve-generations.mjs): a GET of
   * exactly one of these backend paths answers 200 with its JSON body while the stub identity is set (a seeded person's People reads).
   * Replaces the whole set; `{}`: none, every backend path the backend's 404 again. Never a write.
   */
  reads(answers: Record<string, unknown>): Promise<void>;
  /**
   * WEB-14a revision 55: holds every GET of the canned read `path` unanswered at the server (`true`), or answers every held one and stops
   * holding it (`false`). Answers how many were held when it was called. A server-side barrier: every engine sees it.
   */
  holdRead(path: string, on: boolean): Promise<number>;
  log(): Promise<LogEntry[]>;
  clearLog(): Promise<void>;
  /**
   * WEB-14a revision 43 (F-FRESH-2): the append-only ledger after request `after` (`clearLog` never touches it), and the latest id.
   */
  ledger(
    after: number,
    signal?: AbortSignal,
  ): Promise<{ high: number; entries: LogEntry[] }>;
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
      "--dir",
      DIST,
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
    reads: async (answers) => {
      await post("/reads", JSON.stringify(answers));
    },
    holdRead: async (path, on) =>
      (
        (await post(
          `/reads/hold?path=${encodeURIComponent(path)}&on=${on ? 1 : 0}`,
        )) as { held: number }
      ).held,
    log: async () =>
      (await (
        await fetch(`${urls.control}/log`, { method: "GET" })
      ).json()) as LogEntry[],
    clearLog: async () => {
      await post("/log/clear");
    },
    ledger: async (after, signal) => {
      // Revision 44 (design assessment C5): abortable, so the recorder's bound covers the control read and its body.
      const response = await fetch(`${urls.control}/ledger?after=${after}`, {
        signal,
      });
      if (!response.ok)
        throw new Error(
          `control /ledger: ${response.status} ${await response.text()}`,
        );
      return (await response.json()) as { high: number; entries: LogEntry[] };
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
  /**
   * WEB-14a revision 43 (F-FRESH-2): who made each request the server received, per occurrence (tests/e2e/request-origin.ts). Set up
   * after the server and before the test body, so before any page of the test navigates.
   */
  requests: RequestRecorder;
}>({
  firstGeneration: ["fixture-a", { option: true }],
  requests: async ({ context, generations }, use) => {
    await use(
      new RequestRecorder(
        context,
        new URL(generations.url).origin,
        (after, signal) => generations.ledger(after, signal),
      ),
    );
  },
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
    let unanswered: string[] = [];
    let census: string[] | null = null;
    try {
      await use(started.world);
      // Revision 47 (F-R46-PWA-LOAD): a test that armed a reload receipt joins or cancels it (an unjoined one checked nothing). Only for a
      // test that otherwise passed: a failed test's receipts are left as its failure left them.
      if (testInfo.status === "passed")
        expect(
          unsettled(context),
          "reload receipts armed and never joined or cancelled",
        ).toEqual([]);
      // The pages go before the server does: a server that stops under a live page fails its requests in flight.
      for (const page of context.pages())
        await page.close().catch(() => undefined);
      // Revision 56 (C-H2): read once every page is gone, so the whole test is judged. Asserted below, beside the console guard.
      const entries = (await started.world.ledger(0)).entries;
      unanswered = unansweredReads(entries);
      // Revision 57 (Review 57 F-R57-2; design assessment C-H5, I-R3): the merge-time census. With ATLAS_PWA_READ_CENSUS=1, each test
      // attaches the backend reads its pages made and how they were answered to its OWN report entry (R27: never a shared file), so the
      // next base merge's census can be compared with this one read by read. Observation only: the oracle and the console guard judge.
      if (process.env.ATLAS_PWA_READ_CENSUS)
        census = [
          ...new Set(
            entries
              .filter(
                (entry) =>
                  (entry.method === "GET" || entry.method === "HEAD") &&
                  entry.backend &&
                  !entry.document,
              )
              .map(
                (entry) =>
                  `${entry.method} ${entry.path.split("?")[0]} ${entry.status}${entry.identity ? "" : " (signed out)"}`,
              ),
          ),
        ].sort();
    } finally {
      started.stop();
    }
    if (census !== null)
      await testInfo.attach("backend-reads", {
        body: JSON.stringify(census),
        contentType: "application/json",
      });
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
    expect
      .soft(
        unanswered,
        "backend reads answered 404 while the stub identity was set (scripts/serve-generations.mjs answers none of these)",
      )
      .toEqual([]);
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
  /**
   * WEB-14a revision 37 (R40): the account's empty cache is also VALID (`seedDelta`: the delta phase at `cursor`), so the task screens
   * show their editors as they do for an account that has synced; the real first snapshot is WEB-09b's. Off: the database is only created.
   * WEB-14a revision 50: `rows` are synced resources (sync projections) put into the account's cache first, as the snapshot would.
   */
  options: { validCache?: string; rows?: object[] } = {},
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
  const created = await page.evaluate(
    async ({ id, cursor, rows }) => {
      const data = window.__atlasData;
      if (!data) throw new Error("the data harness is not loaded");
      data.setIdentity(id);
      const result = await data.open(id, { create: true });
      if (rows.length > 0)
        await data.put(
          id,
          "cache",
          rows.map((row) => ({ kind_date: null, ...row })),
        );
      if (cursor !== null) await data.seedDelta(id, cursor);
      data.close(id);
      return result;
    },
    {
      id: account,
      cursor: options.validCache ?? null,
      rows: options.rows ?? [],
    },
  );
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

/**
 * Waits until the page's protected root is shown (not `inert`). PRECONDITION (revision 47, F-R46-PWA-LOAD): the page's CURRENT document is
 * already known to have loaded or to be loading under a navigation Playwright itself awaits: a `goto`/`reload`/`navigate` the test made,
 * a popup's own first load, or a joined reload receipt (`armReload` … `loaded()`) after a reload the APP started. The load wait below only
 * covers the document Playwright already knows: it does NOT wait for a later replacement (the client returns at once while it still holds
 * the old document's load state), so it is never evidence that an app-initiated reload finished. A receipt armed on the page and not yet
 * joined is refused. Same-document callers (a gate lifted again after a peer's identity read) use this unchanged.
 */
export async function displayed(page: Page): Promise<void> {
  if (armedOn(page))
    throw new Error(
      "displayed(): a reload receipt is armed on this page; join it (`loaded()`) before inspecting the replacement",
    );
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
 *
 * WEB-14a revision 57 (Review 57, F-R57-3; design assessment of 6 November 2026, RC-H3, C-O1, I-O1): the device says so FIRST, in every
 * engine, the way a device does (the system announces it, then requests fail), and the network goes only once every open page has nothing
 * in flight. Before, the server went first and the pages were told after, so a read the app had dispatched just before (measured: the
 * lazily loaded Today screen mounting after `quiet()` was satisfied, its first reads racing the cut in Chromium about half the time on the
 * merged tree) failed against a dead network and the browser logged it. Now the condition the product itself acts on decides: once a page
 * knows it is offline, Today, the defaults and every other online-only read schedule nothing (they wait for `online`), and a read already
 * on its way is answered by the live server before the cut (in flight is `__inflight`, the page's own count). No window or timer is
 * shortened, nothing is retried, and nothing that reaches the server after the cut is excused (the specs still assert the log is empty).
 */
export async function goOffline(
  context: BrowserContext,
  world: Generations,
  browserName: string,
): Promise<void> {
  // A page loaded from now on knows at once that it is offline (a reloaded Chromium page was seen asking `/health` before the emulation
  // reached it), and every open page is told now, while the server still answers.
  await context.addInitScript(() => {
    Object.defineProperty(navigator, "onLine", {
      configurable: true,
      get: () => false,
    });
  });
  for (const page of context.pages())
    await page.evaluate(() => {
      Object.defineProperty(navigator, "onLine", {
        configurable: true,
        get: () => false,
      });
      window.dispatchEvent(new Event("offline"));
    });
  // What the pages had already sent is answered (the app sends nothing new once it knows it is offline): three samples in a row with
  // nothing in flight, as `quiet()`, in every open page.
  for (const page of context.pages()) {
    let idle = 0;
    await expect
      .poll(
        async () => {
          const inflight = await page.evaluate(
            () =>
              (window as unknown as { __inflight?: number }).__inflight ?? 0,
          );
          idle = inflight === 0 ? idle + 1 : 0;
          return idle >= 3;
        },
        {
          intervals: [100],
          message:
            "the open pages' reads in flight are answered before the network goes",
        },
      )
      .toBe(true);
  }
  await world.dark(true);
  if (browserName !== "webkit") await context.setOffline(true);
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
