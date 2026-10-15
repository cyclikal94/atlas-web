import type { BrowserContext, Page, Route } from "@playwright/test";

/**
 * Shared helpers for the real-engine sync specs: the production session with the network stubbed, a scriptable `/sync`, and the
 * fixture-only test leader of the data harness. FIXTURE evidence: there is no backend behind any of it.
 */
export const ACCOUNT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const iso = () => new Date().toISOString();

export const settled = (account: string, session = "s1") => ({
  schema: 1,
  latest_epoch: 1,
  fence_seq: 0,
  attempt: null,
  settled: {
    account_id: account,
    epoch: 1,
    settled_at: iso(),
    session_id: session,
  },
  fences: {},
  leases: {},
});

/** One command request as the stubbed network saw it. */
export interface CommandRequest {
  path: string;
  key: string | null;
  contentType: string | null;
  body: string;
}
/** What a scripted command answer does: a status and body, or a lost response (the connection is reset after the server "applied" it). */
export type CommandAnswer =
  | { status: number; body: string; headers?: Record<string, string> }
  | { abort: true };

export interface SyncStub {
  /** Every command request, in order, and what answers them next (when empty: `200 {revision}` with a rising revision). */
  commands: CommandRequest[];
  commandScript: Array<(request: CommandRequest) => CommandAnswer>;
  /** The pages (or errors) `/sync` answers next, in order; when empty, an empty page. */
  script: Array<
    (url: URL) => {
      status: number;
      body: string;
      headers?: Record<string, string>;
    }
  >;
  requests: URL[];
  other: string[];
}

export async function stubNetwork(
  context: BrowserContext,
  account = ACCOUNT,
): Promise<SyncStub> {
  const stub: SyncStub = {
    script: [],
    requests: [],
    other: [],
    commands: [],
    commandScript: [],
  };
  let revision = 100;
  await context.route("**/health", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ status: "ok", api_version: "0.29.0" }),
    }),
  );
  await context.route("**/api/experimental/v1/**", async (route: Route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith("/browser-sessions/current"))
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          account_id: account,
          session_id: "s1",
          expires_at: new Date(Date.now() + 86_400_000).toISOString(),
          csrf_token: "csrf.s1",
        }),
      });
    if (url.pathname.endsWith("/sync")) {
      stub.requests.push(url);
      const next = stub.script.shift();
      const answer = next
        ? next(url)
        : {
            status: 200,
            body: JSON.stringify({
              phase: "delta",
              batches: [],
              next_cursor: `cursor-${stub.requests.length}`,
              has_more: false,
            }),
          };
      return route.fulfill({
        status: answer.status,
        contentType: "application/json",
        headers: answer.headers,
        body: answer.body,
      });
    }
    if (/\/(?:commands|task-commands|reminder-commands)$/.test(url.pathname)) {
      const headers = route.request().headers();
      const request: CommandRequest = {
        path: url.pathname.replace("/api/experimental/v1", ""),
        key: headers["idempotency-key"] ?? null,
        contentType: headers["content-type"] ?? null,
        body: route.request().postData() ?? "",
      };
      stub.commands.push(request);
      const next = stub.commandScript.shift();
      revision += 1;
      const answer: CommandAnswer = next
        ? next(request)
        : { status: 200, body: JSON.stringify({ revision }) };
      if ("abort" in answer) return route.abort("connectionreset");
      return route.fulfill({
        status: answer.status,
        contentType: "application/json",
        headers: answer.headers,
        body: answer.body,
      });
    }
    stub.other.push(`${route.request().method()} ${url.pathname}`);
    return route.fulfill({
      status: 404,
      contentType: "application/json",
      body: "{}",
    });
  });
  return stub;
}

export async function seedSettled(
  context: BrowserContext,
  account = ACCOUNT,
): Promise<void> {
  const page = await context.newPage();
  await page.goto("/__session?boot=off");
  await page.waitForFunction(
    () =>
      window.__atlasFixture?.session !== undefined &&
      window.__atlasData !== undefined,
  );
  await page.evaluate(async (state) => {
    await window.__atlasFixture?.session?.seedAuthState(state);
  }, settled(account));
  await page.close();
}

/**
 * A booted session page (the production composition) with the data harness attached.
 *
 * `holdIdentityReadMs` is a FIXTURE LATENCY INJECTION (R43, revision 24): this page's FIRST identity read (`GET /browser-sessions/current`,
 * the cookie-capable VERIFICATION request that every other page of the origin sees as a foreign lease while it is in flight) is
 * answered that many milliseconds later than the shared stub would. It is the schedule that a loaded machine gives the stub's answer (a
 * round trip through the test process), made deliberate: with it, the order that used to start page A's outbox and boot page B
 * afterwards closed A's registry in about a third of its runs (see `twoPages`).
 */
export async function bootSession(
  context: BrowserContext,
  options: { holdIdentityReadMs?: number } = {},
): Promise<Page> {
  const page = await context.newPage();
  const hold = options.holdIdentityReadMs ?? 0;
  if (hold > 0) {
    let held = false;
    await page.route(
      "**/api/experimental/v1/browser-sessions/current",
      async (route) => {
        if (!held) {
          held = true;
          await new Promise((resolve) => setTimeout(resolve, hold));
        }
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            account_id: ACCOUNT,
            session_id: "s1",
            expires_at: new Date(Date.now() + 86_400_000).toISOString(),
            csrf_token: "csrf.s1",
          }),
        });
      },
    );
  }
  await page.goto("/__session?route=%2Ftoday");
  await page.waitForFunction(
    () => window.__atlasFixture?.session?.booted !== undefined,
  );
  await page.evaluate(() => window.__atlasFixture?.session?.ready);
  await page.waitForFunction(() => window.__atlasData !== undefined);
  return page;
}

/**
 * A booted session page whose boot is held until the test has installed its fault injection in the LIVE page and has checked it
 * (R34, revision 19). `install` runs on the loaded page (the harnesses are attached, the production session is not started: `?boot=manual`);
 * only then does the session start, so the application's first request cannot come before the injection is in force, and a page whose
 * injection is not in force is a failure of `install` (which says so), not a product result. The page that comes back is booted exactly as
 * `bootSession` leaves it.
 */
export async function bootSessionAfter(
  context: BrowserContext,
  install: (page: Page) => Promise<void>,
): Promise<Page> {
  const page = await context.newPage();
  await page.goto("/__session?route=%2Ftoday&boot=manual");
  await page.waitForFunction(
    () =>
      window.__atlasFixture?.session !== undefined &&
      window.__atlasData !== undefined,
  );
  await install(page);
  await page.evaluate(() => window.__atlasFixture?.session?.start());
  await page.evaluate(() => window.__atlasFixture?.session?.ready);
  await page.waitForFunction(() => window.__atlasData !== undefined);
  return page;
}

/** What `untilTreeSettled` found, for the evidence. */
export interface Settled {
  waitedMs: number;
  openCount: number;
  leases: number;
  closes: number;
  traceEvents: number;
}

/**
 * Waits until the page's production session and protected tree are QUIET (R34, revision 19), by what the page shows and not by its age:
 * the session has finished booting, its tree has bound the account (the page's registry holds the controller's two connections), no
 * request lease of any page stands unresolved in the `atlas-auth` records, and for `quietMs` nothing has happened that could end a
 * service: no new connection, no `closeAll` of the registry (`gateDiagnostics().closes`), no kernel event. A page that has not settled
 * by `timeoutMs` is an error that says what it saw. This replaces `quiet()`'s guess ("a page boots in about 1.5 s"): the tree binds, hands
 * over and remounts when the session's own steps finish, which depends on the machine and on every OTHER page of the origin (a page that
 * closes releases locks the others were waiting for), and a harness outbox started before that shares the page's connection registry with
 * a controller that may still close it.
 */
export async function untilTreeSettled(
  page: Page,
  options: {
    account?: string;
    quietMs?: number;
    timeoutMs?: number;
    /**
     * The connections the page's registry must hold before the page counts as settled: 2 is the production tree's controller bound to an
     * existing database (the default), 0 a page whose account has no database yet (nothing to wait for but the session and the quiet),
     * 4 the tree's controller and a harness outbox over the same database.
     */
    connections?: number;
  } = {},
): Promise<Settled> {
  return page.evaluate(
    async ({ account, quietMs, timeoutMs, connections }) => {
      const data = window.__atlasData;
      const session = window.__atlasFixture?.session;
      if (!data || !session) throw new Error("no session harness on this page");
      const began = performance.now();
      const signature = () =>
        JSON.stringify([
          data.openCount(account),
          data.gateDiagnostics().closes.length,
          session.trace.length,
        ]);
      let last = signature();
      let since = performance.now();
      for (;;) {
        const records = (await session.readRecords()) as {
          auth_state?: { leases?: Record<string, unknown> };
        };
        const leases = Object.keys(records?.auth_state?.leases ?? {}).length;
        const now = performance.now();
        const current = signature();
        if (current !== last) {
          last = current;
          since = now;
        }
        const openCount = data.openCount(account);
        const found = {
          waitedMs: Math.round(now - began),
          openCount,
          leases,
          closes: data.gateDiagnostics().closes.length,
          traceEvents: session.trace.length,
        };
        if (
          session.booted !== null &&
          openCount >= connections &&
          leases === 0 &&
          now - since >= quietMs
        )
          return found;
        if (now - began > timeoutMs)
          throw new Error(
            `the page's session and tree did not settle in ${timeoutMs} ms: ${JSON.stringify({ ...found, booted: session.booted !== null, quietForMs: Math.round(now - since) })}`,
          );
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    },
    {
      account: options.account ?? ACCOUNT,
      quietMs: options.quietMs ?? 300,
      timeoutMs: options.timeoutMs ?? 20_000,
      connections: options.connections ?? 2,
    },
  );
}

/**
 * What a page's session, registry and connections did (R43, revision 23), on the PAGE'S clock (`dateOffset` converts it to `Date.now()`).
 * `closes` and `latches` are the harness's own logs from the page's first moment (every `closeAll` of the page's connection registry
 * with the top of its stack, and every latch it set): a service of the page's registry stops being live ONLY through a `closeAll`, so a
 * store or an outbox that ended has its cause here. `views` and `identity` are recorded from `recordLifetime` on (the session's view
 * and the identity it displays), `connections` the transitions of the registry's open count and latch (sampled every 20 ms), and
 * `episodes` the stretches in which the session view was not `displaying`: the protected tree is torn down while the session is
 * neutral and mounted again when it displays, and its disposal is what closes the registry.
 */
export interface Lifetime {
  ms: number;
  dateOffset: number | null;
  openCount: number;
  latch: string;
  closes: Array<[number, string, string, string]>;
  latches: Array<[number, string, string]>;
  views: Array<[number, string]>;
  identity: Array<[number, string | null, number | null]>;
  episodes: Array<[number, number | null]>;
  connections: Array<[number, number, string]>;
  /**
   * The opens of the account database this page made (R43, revision 24): `[ms, "request" | "success" | "error", "began <ms>"]`. A
   * production tree's LOOK for the database is an open with `create: false`; one that has completed when the tree is disposed has bound
   * the database (its connections stand in the registry), one that is still pending when it is disposed closes nothing.
   */
  opens: Array<[number, string, string]>;
}

/** Installs the recorder of `readLifetime` in a booted session page. Idempotent; it records only, and changes nothing the page does. */
export async function recordLifetime(
  page: Page,
  account = ACCOUNT,
): Promise<void> {
  await page.evaluate((acct) => {
    const w = window as unknown as {
      __lifetime?: unknown;
      __atlasFixture?: {
        session?: {
          booted?: {
            session?: {
              view: { get(): unknown; subscribe(l: () => void): () => void };
              identity: {
                get(): { account_id: string; epoch: number } | null;
                subscribe(l: () => void): () => void;
              };
            };
          };
        };
      };
    };
    if (w.__lifetime !== undefined) return;
    const session = w.__atlasFixture?.session?.booted?.session;
    const data = window.__atlasData;
    if (session === undefined || data === undefined)
      throw new Error("no booted session and data harness on this page");
    const stamp = () => Math.round(performance.now());
    const text = () => {
      try {
        return JSON.stringify(session.view.get()).slice(0, 90);
      } catch {
        return "unreadable";
      }
    };
    const life = {
      dateOffset: Date.now() - performance.now(),
      views: [[stamp(), text()]] as Array<[number, string]>,
      identity: [] as Array<[number, string | null, number | null]>,
      connections: [] as Array<[number, number, string]>,
      opens: [] as Array<[number, string, string]>,
    };
    // Every open of the account database, request and outcome (it records only: the request is returned as it came).
    const databaseName = `atlas-${acct}`;
    const nativeOpen = indexedDB.open.bind(indexedDB);
    indexedDB.open = (name: string, version?: number) => {
      const request = nativeOpen(name, version);
      if (name === databaseName) {
        const began = stamp();
        life.opens.push([began, "request", `began ${began}`]);
        request.addEventListener("success", () =>
          life.opens.push([stamp(), "success", `began ${began}`]),
        );
        request.addEventListener("error", () =>
          life.opens.push([stamp(), "error", `began ${began}`]),
        );
      }
      return request;
    };
    const note = () => {
      const id = session.identity.get();
      life.identity.push([stamp(), id?.account_id ?? null, id?.epoch ?? null]);
    };
    note();
    session.view.subscribe(() => life.views.push([stamp(), text()]));
    session.identity.subscribe(note);
    let last = "";
    const sample = () => {
      const count = data.openCount(acct);
      const latch = data.latch(acct);
      if (`${count}|${latch}` !== last) {
        last = `${count}|${latch}`;
        life.connections.push([stamp(), count, latch]);
      }
    };
    sample();
    window.setInterval(sample, 20);
    w.__lifetime = life;
  }, account);
}

/** What the page has recorded since `recordLifetime`, with the harness's own logs (see `Lifetime`). */
export async function readLifetime(
  page: Page,
  account = ACCOUNT,
): Promise<Lifetime> {
  return page.evaluate((acct) => {
    const w = window as unknown as {
      __lifetime?: {
        dateOffset: number;
        views: Array<[number, string]>;
        identity: Array<[number, string | null, number | null]>;
        connections: Array<[number, number, string]>;
        opens: Array<[number, string, string]>;
      };
    };
    const data = window.__atlasData;
    const diagnostics = data?.gateDiagnostics();
    const life = w.__lifetime;
    const episodes: Array<[number, number | null]> = [];
    let begun: number | null = null;
    for (const [at, text] of life?.views ?? []) {
      const displaying = text.includes('"displaying"');
      if (!displaying && begun === null) begun = at;
      if (displaying && begun !== null) {
        episodes.push([begun, at]);
        begun = null;
      }
    }
    if (begun !== null) episodes.push([begun, null]);
    return {
      ms: Math.round(performance.now()),
      dateOffset: life?.dateOffset ?? null,
      openCount: data?.openCount(acct) ?? -1,
      latch: data?.latch(acct) ?? "unknown",
      closes: diagnostics?.closes ?? [],
      latches: diagnostics?.latches ?? [],
      views: life?.views ?? [],
      identity: life?.identity ?? [],
      episodes,
      connections: life?.connections ?? [],
      opens: life?.opens ?? [],
    };
  }, account);
}

/** A page with the data harness only. */
export async function dataPage(context: BrowserContext): Promise<Page> {
  const page = await context.newPage();
  await page.goto("/__data");
  await page.waitForFunction(() => window.__atlasData !== undefined);
  return page;
}

/** Generates a `/sync` page as JSON text. `changes` is an array of change objects. */
export function pageText(
  changes: unknown[][],
  nextCursor: string,
  hasMore = false,
): string {
  return JSON.stringify({
    phase: "delta",
    batches: changes.map((c, i) => ({ revision: i + 1, changes: c })),
    next_cursor: nextCursor,
    has_more: hasMore,
  });
}

export const uuid = (n: number): string =>
  `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;

export const projection = (
  n: number,
  value: Record<string, unknown> | null,
  kind = "task",
) => ({
  id: uuid(n),
  kind,
  parent_id: null,
  label: `Resource ${n}`,
  value,
  version: 1,
  can_edit: true,
  archived: false,
});

export const upsert = (
  n: number,
  value: Record<string, unknown> | null,
  kind = "task",
) => ({ kind: "upsert", resource: projection(n, value, kind) });

/** W1-like: a dense checklist (many items per task). The exact approved W1 fixture is built by the profiling programme. */
export function denseChecklist(changes: number, items: number): unknown[] {
  return Array.from({ length: changes }, (_, c) =>
    upsert(c + 1, {
      checklist: Array.from({ length: items }, (_, i) => ({
        id: `i${c}-${i}`,
        text: `Checklist item ${i} of task ${c}: water the plants`,
        done: i % 3 === 0,
      })),
    }),
  );
}

export async function waitForState(
  page: Page,
  kind: string,
  timeout = 60_000,
): Promise<void> {
  await page.waitForFunction(
    (k) => window.__atlasData?.engineState()?.kind === k,
    kind,
    { timeout },
  );
}

export async function startLeader(
  page: Page,
  account = ACCOUNT,
  cursor = "cursor-0",
  options: { deviceMemoryGiB?: number } = {},
): Promise<void> {
  await page.evaluate(
    async ({ acct, cur, opts }) => {
      const data = window.__atlasData;
      if (!data) throw new Error("no data harness");
      // Open (creating) the account's database through the session's own facts, then arrange the delta phase.
      await data.startSync(acct, { ...opts, seedCursor: cur });
    },
    { acct: account, cur: cursor, opts: options },
  );
}

/** The error body of the contract (`Error`): what a refusal looks like on the wire. */
export const atlasError = (code: string): string =>
  JSON.stringify({
    code,
    message: "m",
    request_id: "11111111-1111-4111-8111-111111111111",
    details: [],
  });

/** Starts the fixture-only test leader of the OUTBOX on a booted session page (the delta database is arranged first). */
export async function startOutbox(
  page: Page,
  account = ACCOUNT,
  options: {
    start?: boolean;
    estimateFreeBytes?: number;
    originLedger?: boolean;
    /** FIXTURE clock injection: the outbox's guard reads `Date.now()` this far ahead (the holds of another page look lapsed to it). */
    quotaClockOffsetMs?: number;
    /** FIXTURE estimate injection (R28, revision 17): the estimate shows a write only to a request made a lifetime after it landed. */
    estimateLagsWrites?: boolean;
    /** FIXTURE clock injection (R28, revision 17): the guard has the page's monotonic clock, so a clock offset is a STEP of the wall clock. */
    quotaMonotonic?: boolean;
  } = {},
): Promise<void> {
  await page.evaluate(
    async ({ acct, opts }) => {
      const data = window.__atlasData;
      if (!data) throw new Error("no data harness");
      await data.startOutbox(acct, { seedCursor: "cursor-0", ...opts });
    },
    { acct: account, opts: options },
  );
}
