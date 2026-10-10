import {
  type BrowserContext,
  test as base,
  expect,
  type Page,
  type TestInfo,
} from "@playwright/test";
import type { Session } from "../../src/session";

/**
 * Part C (plan 14): helpers for the integration specs. They run the session module and its PRODUCTION adapters in a real engine
 * (through the fixture-only harness page) against the RELEASED backend on a disposable SQLite database, behind the delaying proxy.
 * They skip themselves, and are reported as not run, unless scripts/integration/run.mjs started that stack.
 */
export const ENABLED = Boolean(process.env.ATLAS_INTEGRATION_URL);
export type Who =
  | "alice"
  | "bob"
  | "carol"
  | "dave"
  | "erin"
  | "frank"
  | "grace"
  | "heidi"
  | "ivan"
  | "judy"
  | "kate"
  | "liam"
  | "mia"
  | "nora"
  | "olga"
  | "pete"
  | "quinn";
export const ACCOUNTS: Record<Who, { username: string; password: string }> =
  JSON.parse(process.env.ATLAS_INTEGRATION_ACCOUNTS ?? "{}");
/** Standalone signup invitations made by the released backend's own `invite` command; each token works once. */
export const INVITATIONS: Array<{
  id: string;
  token: string;
  expires_at: string;
}> = JSON.parse(process.env.ATLAS_INTEGRATION_INVITATIONS || "[]");
/** The stub OpenID Connect provider, when the stack configured it (the backend is then configured with its issuer). */
export const OIDC: {
  issuer: string;
  control: string;
  client_id: string;
} | null = process.env.ATLAS_INTEGRATION_OIDC
  ? JSON.parse(process.env.ATLAS_INTEGRATION_OIDC)
  : null;
const CONTROL = process.env.ATLAS_INTEGRATION_CONTROL ?? "";
export const ORIGIN = process.env.ATLAS_INTEGRATION_URL ?? "";
export const BACKEND = process.env.ATLAS_INTEGRATION_BACKEND ?? "";
export const API = `${ORIGIN}/api/experimental/v1`;

export interface ProxyRule {
  id?: string;
  method?: string;
  path?: string;
  ordinal?: number;
  action:
    | "hold"
    | "hold_request"
    | "buffer_request"
    | "delay"
    | "drop_after_forward"
    | "rewrite_status"
    | "rewrite_json"
    | "swap";
  ms?: number;
  status?: number;
  set?: Record<string, unknown>;
  delete?: string[];
}
export interface ProxyLogEntry {
  id: number;
  method: string;
  path: string;
  status?: number;
  rule?: string;
  events: Array<{ t: number; event: string; status?: number }>;
}
async function call<T>(
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const response = await fetch(`${CONTROL}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return (await response.json()) as T;
}
export const proxy = {
  reset: () => call("POST", "/reset"),
  addRule: (rule: ProxyRule) => call<{ id: string }>("POST", "/rules", rule),
  removeRule: (id: string) => call("DELETE", `/rules/${id}`),
  release: (id: string) => call<{ released: number }>("POST", `/release/${id}`),
  held: () => call<Record<string, number>>("GET", "/held"),
  log: () => call<ProxyLogEntry[]>("GET", "/log"),
};

/** The stub provider's control port (hold, release, deny, choose the approved subject). Throws when the stack has no provider. */
async function providerCall<T>(
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  if (!OIDC)
    throw new Error(
      "this stack did not configure the stub OpenID Connect provider",
    );
  const response = await fetch(`${OIDC.control}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return (await response.json()) as T;
}
export const provider = {
  /** The subject the next authorisations approve. Unique per test: an identity links to ONE account. */
  subject: (sub: string) => providerCall("POST", "/subject", { sub }),
  hold: (on = true) => providerCall("POST", "/hold", { on }),
  deny: (on = true) => providerCall("POST", "/deny", { on }),
  release: () => providerCall<{ released: number }>("POST", "/release"),
  waiting: async () =>
    (await providerCall<{ waiting: number }>("GET", "/waiting")).waiting,
  reset: async () => {
    await providerCall("POST", "/hold", { on: false });
    await providerCall("POST", "/deny", { on: false });
  },
};

const allowedStatuses = new WeakMap<TestInfo, Set<number>>();
/** The console guard of tests/e2e/helpers.ts, with the one thing an integration run needs: a test DECLARES the HTTP statuses it provokes. */
export const test = base.extend<{
  provokes: (...statuses: number[]) => void;
  guard: undefined;
  stack: undefined;
}>({
  // An AUTO fixture, not a beforeEach: a hook declared in a shared module attaches only to the first spec file that loads it.
  stack: [
    async ({ page: _page }, use) => {
      test.skip(
        !ENABLED,
        "not run: scripts/integration/run.mjs did not start the backend, the proxy and the preview",
      );
      if (ENABLED) await proxy.reset();
      if (ENABLED && OIDC) await provider.reset();
      await use(undefined);
    },
    { auto: true },
  ],
  provokes: async ({ page: _page }, use, info) => {
    const allowed = new Set<number>();
    allowedStatuses.set(info, allowed);
    await use((...statuses) => {
      for (const status of statuses) allowed.add(status);
    });
  },
  guard: [
    async ({ page, provokes: _provokes }, use, info) => {
      const problems: string[] = [];
      page.on("console", (message) => {
        if (message.type() !== "error" && message.type() !== "warning") return;
        const text = message.text();
        const allowed = allowedStatuses.get(info) ?? new Set<number>();
        const status = /status of (\d{3})/.exec(text)?.[1];
        // Chromium reports an HTTP 4xx/5xx as a console error; a test that provokes one says which.
        if (status && allowed.has(Number(status))) return;
        // Firefox and WebKit name the resource instead of the status.
        if (
          allowed.size > 0 &&
          /Failed to load resource|NetworkError|the server responded/i.test(
            text,
          )
        )
          return;
        problems.push(`${message.type()}: ${text}`);
      });
      page.on("pageerror", (error) =>
        problems.push(`pageerror: ${error.message}`),
      );
      await use(undefined);
      // A failing run keeps the kernel's own trace from every page, so a flake can be read, not guessed at.
      if (info.status !== info.expectedStatus) {
        let index = 0;
        for (const candidate of page.context().pages()) {
          const trace = await candidate
            .evaluate(() => window.__atlasFixture?.session?.trace ?? [])
            .catch(() => []);
          if (trace.length > 0)
            await info.attach(`kernel-trace-page-${index}`, {
              body: JSON.stringify(trace, null, 1),
              contentType: "application/json",
            });
          index += 1;
        }
      }
      expect(
        problems,
        "console errors and warnings (other than the statuses this test provokes)",
      ).toEqual([]);
    },
    { auto: true },
  ],
});
export { expect };

declare global {
  interface Window {
    __t: Record<string, unknown>;
    /** The booted session of the harness page, set by `bootHarness`. */
    __s: Session;
    /**
     * Retry a stamped call that comes back NOT_SENT: it was refused before it counted as an attempt (a hold, or a closing write,
     * was in force for a moment: the settlement's, or the resume verification's interim hold). A queue retries exactly so.
     */
    __retry: <T extends { ok: boolean; error?: string }>(
      call: () => Promise<T>,
    ) => Promise<T>;
  }
}

/** Load the session harness (the PRODUCTION composition), wait for boot to finish, and expose the session as `window.__s`. */
export async function bootHarness(
  context: BrowserContext,
  route = "/today",
  hash = "",
): Promise<Page> {
  const page = await context.newPage();
  // `hash` is the URL fragment a link carries (an invitation token). It is kept in the address, as in production, until boot's
  // first statement reads and strips it.
  await page.goto(`/__session?route=${encodeURIComponent(route)}${hash}`);
  await exposeSession(page);
  return page;
}

/** Wait for boot on an already-navigated harness page and expose `window.__s`, `window.__t` and `window.__retry`. */
export async function exposeSession(page: Page): Promise<void> {
  await page.waitForFunction(
    () => window.__atlasFixture?.session !== undefined,
  );
  await page.evaluate(async () => {
    const booted = await window.__atlasFixture?.session?.ready;
    if (!booted)
      throw new Error(
        "the harness did not boot a session (the compatibility screen replaced the app)",
      );
    window.__s = booted.session;
    window.__t = {};
    window.__retry = async (call) => {
      let last = await call();
      for (let i = 1; i < 60 && !last.ok && last.error === "not_sent"; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        last = await call();
      }
      return last;
    };
  });
}

export function signIn(page: Page, who: Who) {
  const credentials = ACCOUNTS[who];
  return page.evaluate(async (c) => {
    const begun = await window.__s.attempts.begin("password");
    if (begun.kind !== "started")
      return { kind: `begin:${begun.kind}` } as {
        kind: string;
        [key: string]: unknown;
      };
    return (await window.__s.attempts.signInWithPassword(begun.handle, c)) as {
      kind: string;
      [key: string]: unknown;
    };
  }, credentials);
}

export interface AuthStateLike {
  latest_epoch: number;
  fence_seq: number;
  attempt: {
    epoch: number;
    phase: string;
    observations_deferred: number | null;
    verifier: string;
  } | null;
  settled: { account_id: string; epoch: number; session_id: string } | null;
  fences: Record<
    string,
    Array<{
      seq: number;
      epoch: number;
      kind: string;
      reason?: string;
      envelope?: Record<string, unknown>;
    }>
  >;
  leases: Record<string, { account_id: string; epoch: number; class: string }>;
}
export interface RecordsLike {
  auth_state: AuthStateLike;
  device: { device_id: string } | null;
  boot: unknown;
  pending_deletions: Record<string, { status: string; operation_id: string }>;
}
export const records = (page: Page) =>
  page.evaluate(() =>
    window.__atlasFixture?.session?.readRecords(),
  ) as Promise<RecordsLike>;

/** Poll until `predicate` holds for the durable record, or fail with the last record. */
export async function untilRecord(
  page: Page,
  predicate: (state: AuthStateLike) => boolean,
  message: string,
  timeout = 30_000,
) {
  await expect
    .poll(async () => predicate((await records(page)).auth_state), {
      message,
      timeout,
    })
    .toBe(true);
}

/** A raw client for the API through the preview origin (the same origin the browser uses), with the Origin header a browser sends. */
export async function raw(
  method: string,
  path: string,
  options: {
    body?: unknown;
    cookie?: string;
    headers?: Record<string, string>;
    /** The Origin header: the preview origin by default, a different one to test the check, `null` to send none. */
    origin?: string | null;
  } = {},
) {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: {
      ...(options.origin === null ? {} : { origin: options.origin ?? ORIGIN }),
      ...(options.body !== undefined
        ? { "content-type": "application/json" }
        : {}),
      ...(options.cookie ? { cookie: options.cookie } : {}),
      ...options.headers,
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    redirect: "manual",
  });
  const text = await response.text();
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    // not JSON
  }
  return {
    status: response.status,
    json,
    setCookie: response.headers.getSetCookie(),
    headers: response.headers,
  };
}

export const challengeFor = async (verifier: string) => {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier),
  );
  return Buffer.from(digest).toString("base64url");
};
/** A fresh verifier: the backend refuses a challenge it has seen before, so a spec never reuses one across runs. */
export const freshVerifier = () =>
  Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");

export interface RawSession {
  cookieName: string;
  cookieValue: string;
  cookie: string;
  csrf: string;
  sessionId: string;
  accountId: string;
}
/** Sign in as `who` with raw HTTP (no browser): a second, independent session of the same origin. */
export async function rawSignIn(
  who: Who,
  deviceId = `raw-${freshVerifier().slice(0, 10)}`,
): Promise<RawSession> {
  const verifier = freshVerifier();
  const exchange = await raw("POST", "/browser-sessions", {
    body: {
      username: ACCOUNTS[who].username,
      password: ACCOUNTS[who].password,
      attempt_challenge: await challengeFor(verifier),
      device_id: deviceId,
    },
  });
  if (exchange.status !== 200)
    throw new Error(`raw exchange for ${who}: ${exchange.status}`);
  const grant = (exchange.json as { grant: string }).grant;
  const activated = await raw("POST", "/browser-sessions/activate", {
    body: { grant, verifier },
  });
  if (activated.status !== 200)
    throw new Error(`raw activate for ${who}: ${activated.status}`);
  const [pair] = (activated.setCookie[0] ?? "").split(";");
  const [cookieName = "", ...rest] = (pair ?? "").split("=");
  const cookieValue = rest.join("=");
  const cookie = `${cookieName}=${cookieValue}`;
  const current = await raw("GET", "/browser-sessions/current", {
    cookie,
    headers: { "x-atlas-session": "1" },
  });
  const body = current.json as {
    csrf_token: string;
    session_id: string;
    account_id: string;
  };
  return {
    cookieName,
    cookieValue,
    cookie,
    csrf: body.csrf_token,
    sessionId: body.session_id,
    accountId: body.account_id,
  };
}

/** Put a raw session's cookie into a browser context, replacing the one the page holds (the cookie is HttpOnly). */
export async function swapCookie(
  context: BrowserContext,
  session: RawSession,
): Promise<void> {
  await context.addCookies([
    {
      name: session.cookieName,
      value: session.cookieValue,
      domain: "127.0.0.1",
      path: "/",
      httpOnly: true,
      secure: false,
      sameSite: "Lax",
    },
  ]);
}

/** Begin a password sign-in in the page WITHOUT waiting for it (the proxy may hold one of its answers). */
export async function startSignIn(page: Page, who: Who): Promise<void> {
  await page.evaluate((credentials) => {
    window.__t.signin = (async () => {
      const begun = await window.__s.attempts.begin("password");
      if (begun.kind !== "started") return { kind: `begin:${begun.kind}` };
      return window.__s.attempts.signInWithPassword(begun.handle, credentials);
    })();
  }, ACCOUNTS[who]);
}
export const finishSignIn = (page: Page) =>
  page.evaluate(
    () =>
      window.__t.signin as Promise<{ kind: string; [key: string]: unknown }>,
  );

/** Wait until the proxy holds `count` responses for a rule. */
export async function untilHeld(ruleId: string, count = 1): Promise<void> {
  await expect
    .poll(async () => (await proxy.held())[ruleId] ?? 0, {
      message: `the proxy holds ${count} response(s) for ${ruleId}`,
      timeout: 15_000,
    })
    .toBeGreaterThanOrEqual(count);
}

/** The view kind and neutral state, as the person would get them. */
export const view = (page: Page) =>
  page.evaluate(
    () => window.__s.view.get() as { kind: string; state?: string },
  );
export async function untilView(
  page: Page,
  kind: string,
  state?: string,
  timeout = 30_000,
): Promise<void> {
  await expect
    .poll(
      async () => {
        const v = await view(page);
        return `${v.kind}${state ? `/${v.state ?? ""}` : ""}`;
      },
      {
        message: `the view becomes ${kind}${state ? `/${state}` : ""}`,
        timeout,
      },
    )
    .toBe(`${kind}${state ? `/${state}` : ""}`);
}

/**
 * A stamped call that comes back NOT_SENT was refused before it counted as an attempt (a hold or a closing write was in force for a
 * moment: the settlement's, or the resume verification's interim hold). It is retried, exactly as a queue would retry it. A call
 * that returns anything else is returned as it is.
 */
export async function untilSent<T extends { ok: boolean; error?: string }>(
  call: () => Promise<T>,
  attempts = 40,
): Promise<T> {
  let last = await call();
  for (
    let i = 1;
    i < attempts && !last.ok && last.error === "not_sent";
    i += 1
  ) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    last = await call();
  }
  return last;
}

/** Drive `visibilitychange` by overriding `document.visibilityState` (LIMITATION: not the engine's own event; see docs/browser-support.md). */
export const setVisibility = (page: Page, state: "hidden" | "visible") =>
  page.evaluate((next) => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => next,
    });
    document.dispatchEvent(new Event("visibilitychange"));
  }, state);

/** True once `#protected-root` has been lifted (not inert) at any time since this call; use with `everLifted`. */
export const watchLift = (page: Page) =>
  page.evaluate(() => {
    window.__t ??= {};
    window.__t.lifted = 0;
    window.__t.liftedAt = null;
    const root = document.getElementById("protected-root");
    const check = () => {
      if (root && !root.hasAttribute("inert") && window.__t.liftedAt === null) {
        window.__t.lifted = 1;
        window.__t.liftedAt = Date.now();
      }
    };
    new MutationObserver(check).observe(root as Node, {
      attributes: true,
      attributeFilter: ["inert"],
    });
    check();
  });
export const liftedAt = (page: Page) =>
  page.evaluate(() => window.__t.liftedAt as number | null);

/**
 * Append a measurement to the profiling evidence. The directory is `ATLAS_MEASUREMENTS_DIR` (the runner sets it beside the
 * evidence directory it was given), so a task's measurements never land in an earlier task's folder; the WEB-08a path is the
 * default only for a run that does not say.
 */
import { appendFileSync, mkdirSync } from "node:fs";
export function recordMeasurement(
  name: string,
  value: Record<string, unknown>,
): void {
  const dir =
    process.env.ATLAS_MEASUREMENTS_DIR || ".agtx/evidence/WEB-08a/profiling";
  mkdirSync(dir, { recursive: true });
  // The engine that produced the figure, so three engines' lines are never mistaken for one (`test.info()` exists only in a test).
  let engine: string | undefined;
  try {
    engine = test.info().project.name.replace("integration-", "");
  } catch {
    engine = undefined;
  }
  appendFileSync(
    `${dir}/measurements.jsonl`,
    `${JSON.stringify({ name, engine, at: new Date().toISOString(), ...value })}\n`,
  );
}
