import type { BrowserContext, Page } from "@playwright/test";
import {
  ACCOUNTS,
  bootHarness,
  challengeFor,
  expect,
  exposeSession,
  finishSignIn,
  freshVerifier,
  INVITATIONS,
  ORIGIN,
  provider,
  proxy,
  raw,
  rawSignIn,
  records,
  startSignIn,
  untilHeld,
  untilView,
  type Who,
} from "./helpers";

/**
 * Shared by the WEB-08b integration specs (I-20 to I-30). Everything here drives the session module and its PRODUCTION adapters in a
 * real engine against the RELEASED backend behind the delaying proxy; nothing here is a stub of the contract.
 */
export const API_PREFIX = "/api/experimental/v1";
export const EXCHANGE = `${API_PREFIX}/browser-sessions`;
export const ACTIVATE = `${API_PREFIX}/browser-sessions/activate`;
export const REGISTRATION = `${API_PREFIX}/browser-registration`;
export const PREVIEW = `${API_PREFIX}/registration/preview`;
export const SESSION_COOKIE = "atlas_session";

export interface Wired {
  method: string;
  path: string;
  status: number;
  setCookie: boolean;
  url: string;
}
/** Every API response a page received, with whether it carried `Set-Cookie` (read from the headers: the cookie is HttpOnly). */
export function wire(page: Page): Wired[] {
  const seen: Wired[] = [];
  page.on("response", async (response) => {
    const url = new URL(response.url());
    if (!url.pathname.startsWith("/api/")) return;
    const headers = await response.allHeaders().catch(() => ({}));
    seen.push({
      method: response.request().method(),
      path: url.pathname,
      status: response.status(),
      setCookie: "set-cookie" in headers,
      url: response.url(),
    });
  });
  return seen;
}

/** The session cookie the browser holds right now (Playwright sees HttpOnly cookies). */
export async function sessionCookie(
  context: BrowserContext,
): Promise<string | null> {
  const cookies = await context.cookies(ORIGIN);
  return cookies.find((c) => c.name === SESSION_COOKIE)?.value ?? null;
}

/**
 * Pin `document.visibilityState` to "visible" for every page of the context. In one headless context an engine may report a page
 * hidden while another is driven, and a hidden page aborts an in-flight activation BY DESIGN (matrix 3.4 step 3), which would turn
 * every ordering trace into a hidden-tab test. Hidden-tab behaviour has its own specs (I-09 to I-15); here the ORDER of answers is
 * the only variable. LIMITATION: this is not the engine's own visibility event.
 */
export async function pinVisible(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    Object.defineProperty(document, "visibilityState", {
      get: () => "visible",
      configurable: true,
    });
    Object.defineProperty(document, "hidden", {
      get: () => false,
      configurable: true,
    });
    document.addEventListener(
      "visibilitychange",
      (event) => event.stopImmediatePropagation(),
      true,
    );
  });
}

/**
 * Record, from the first script of every document, the page's address at each `fetch` and each `history.replaceState` call. The
 * landing page must have stripped the fragment before ANY request it makes (matrix 3.4 step 2).
 */
export async function watchAddress(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    const w = window as unknown as {
      __at?: { urls: string[]; replaces: string[] };
    };
    if (w.__at) return;
    w.__at = { urls: [], replaces: [] };
    const log = w.__at;
    const realFetch = window.fetch.bind(window);
    window.fetch = (...args) => {
      log.urls.push(location.href);
      return realFetch(...args);
    };
    const realReplace = history.replaceState.bind(history);
    history.replaceState = (...args) => {
      log.replaces.push(String(args[2]));
      return realReplace(...args);
    };
  });
}
export const addressLog = (page: Page) =>
  page.evaluate(
    () =>
      (window as unknown as { __at: { urls: string[]; replaces: string[] } })
        .__at,
  );

export const identityOf = (page: Page) =>
  page.evaluate(() => window.__s.identity.get()?.account_id ?? null);

export function startRegistration(
  page: Page,
  input: { token: string; username: string; password: string },
) {
  return page.evaluate((c) => {
    window.__t.signin = (async () => {
      const begun = await window.__s.attempts.begin("registration");
      if (begun.kind !== "started") return { kind: `begin:${begun.kind}` };
      return window.__s.attempts.registerWithInvitation(begun.handle, c);
    })();
  }, input);
}

/** A chosen username that satisfies the registration pattern and is unique per run. */
export const uniqueName = (prefix: string, n: number) =>
  `${prefix}${n}x${Math.random().toString(36).slice(2, 8)}`;
export const strongPassword = () =>
  `pw-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}-0123456789`;

/** A standalone invitation by slot: each slot is used by exactly one test, so no test depends on another's. */
export function invitation(slot: number): string {
  const found = INVITATIONS[slot];
  if (!found)
    throw new Error(
      `the stack made ${INVITATIONS.length} invitations; slot ${slot} does not exist`,
    );
  return found.token;
}

/** `POST /registration/preview`: the invitation is usable (200) or not (401). */
export async function previewStatus(token: string): Promise<number> {
  return (await raw("POST", "/registration/preview", { body: { token } }))
    .status;
}

/** Sign in with raw HTTP using explicit credentials and report whether a session resulted (for "the chosen credentials work"). */
export async function credentialsWork(
  username: string,
  password: string,
): Promise<boolean> {
  const verifier = freshVerifier();
  const exchange = await raw("POST", "/browser-sessions", {
    body: {
      username,
      password,
      attempt_challenge: await challengeFor(verifier),
      device_id: `chk-${verifier.slice(0, 8)}`,
    },
  });
  if (exchange.status !== 200) return false;
  const activated = await raw("POST", "/browser-sessions/activate", {
    body: { grant: (exchange.json as { grant: string }).grant, verifier },
  });
  return activated.status === 200;
}

/** Begin an attempt WITHOUT sending anything; the handle waits in `window.__t.handle`. Returns the epoch (or why not). */
export function beginOnly(
  page: Page,
  method: "password" | "registration" | "oidc" | "oidc_link",
) {
  return page.evaluate(async (m) => {
    const begun = await window.__s.attempts.begin(m);
    if (begun.kind !== "started") return { kind: begun.kind, epoch: null };
    window.__t.handle = begun.handle;
    return { kind: "started", epoch: begun.handle.epoch };
  }, method);
}
/** Send the password exchange of the begun attempt; resolves with the outcome. `password` overrides the account's. */
export function signInWithBegun(page: Page, who: Who, password?: string) {
  return page.evaluate(
    async (c) => {
      const handle = window.__t.handle as Parameters<
        typeof window.__s.attempts.signInWithPassword
      >[0];
      return (await window.__s.attempts.signInWithPassword(handle, c)) as {
        kind: string;
        [key: string]: unknown;
      };
    },
    {
      username: ACCOUNTS[who].username,
      password: password ?? ACCOUNTS[who].password,
    },
  );
}
/** `startSignIn` with a wrong password: begin, send, and leave the outcome in `window.__t.signin`. */
export function startWrongSignIn(page: Page, who: Who) {
  return page.evaluate((c) => {
    window.__t.signin = (async () => {
      const begun = await window.__s.attempts.begin("password");
      if (begun.kind !== "started") return { kind: `begin:${begun.kind}` };
      return window.__s.attempts.signInWithPassword(begun.handle, {
        username: c.username,
        password: `${c.password}-WRONG`,
      });
    })();
  }, ACCOUNTS[who]);
}

/**
 * Link the stub provider's `sub` to `who`'s account with raw HTTP, exactly as a browser would but without one: a session created
 * seconds ago starts a `link` flow, the provider approves `sub`, and the callback (with the session cookie and the binding cookie)
 * inserts the identity. Afterwards a sign-in whose provider approves `sub` is that account's.
 */
export async function linkIdentity(who: Who, sub: string): Promise<void> {
  const session = await rawSignIn(who);
  await provider.subject(sub);
  const verifier = freshVerifier();
  const start = await raw("POST", "/oidc/start", {
    cookie: session.cookie,
    headers: { "x-csrf-token": session.csrf },
    body: {
      device_id: `link-${freshVerifier().slice(0, 8)}`,
      link: true,
      attempt_id: "1",
      attempt_challenge: await challengeFor(verifier),
    },
  });
  if (start.status !== 200)
    throw new Error(
      `link start for ${who}: ${start.status} ${JSON.stringify(start.json)}`,
    );
  const binding = start.setCookie.map((c) => c.split(";")[0]).join("; ");
  const url = (start.json as { authorization_url: string }).authorization_url;
  const authorised = await fetch(url, { redirect: "manual" });
  const callback = authorised.headers.get("location") ?? "";
  const done = await fetch(callback, {
    redirect: "manual",
    headers: { cookie: `${session.cookie}; ${binding}` },
  });
  if (done.status !== 303)
    throw new Error(
      `link callback for ${who}: ${done.status} ${await done.text()}`,
    );
}

/** Begin an OIDC attempt in the page and return the provider URL the module says to navigate to (the page does NOT navigate). */
export function startAtProvider(page: Page, link = false) {
  return page.evaluate(async (isLink) => {
    const begun = await window.__s.attempts.begin(
      isLink ? "oidc_link" : "oidc",
    );
    if (begun.kind !== "started") throw new Error(`begin: ${begun.kind}`);
    const out = await window.__s.attempts.startOidc(begun.handle);
    if (out.kind !== "redirect") throw new Error(`startOidc: ${out.kind}`);
    return out.authorization_url;
  }, link);
}

/**
 * Run an action that leaves the page (a click that goes to the provider and comes back), then wait for a genuinely NEW document
 * of the harness and expose its session. The old document is marked first, so a URL that already matched cannot fool the wait.
 */
export async function followNavigation(
  page: Page,
  action: () => Promise<void>,
): Promise<void> {
  await page.evaluate(() => {
    (window as unknown as { __oldDoc?: boolean }).__oldDoc = true;
  });
  await action();
  await page.waitForFunction(
    () =>
      !(window as unknown as { __oldDoc?: boolean }).__oldDoc &&
      window.__atlasFixture?.session !== undefined,
    undefined,
    { timeout: 45_000 },
  );
  await exposeSession(page);
}

/** Sign in through the real sign-in form and wait for the account to display. */
export async function uiSignIn(page: Page, who: Who, password?: string) {
  await page.getByLabel("Username").fill(ACCOUNTS[who].username);
  await page.getByLabel("Password").fill(password ?? ACCOUNTS[who].password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
}

export type Window =
  | "before-B-starts"
  | "B-exchanging"
  | "B-gating"
  | "after-B-settled";
export type Order = "A-first" | "B-first";
export const CELLS: Array<{ order: Order; window: Window }> = [
  { order: "A-first", window: "before-B-starts" },
  { order: "A-first", window: "B-exchanging" },
  { order: "A-first", window: "B-gating" },
  { order: "A-first", window: "after-B-settled" },
  // B's login cannot be processed before B has started, and B starts only after A's answer was delivered: not an executable cell.
  { order: "B-first", window: "B-exchanging" },
  { order: "B-first", window: "B-gating" },
  { order: "B-first", window: "after-B-settled" },
];

export type AStart =
  | { kind: "password"; who: Who }
  | { kind: "registration"; token: string; username: string; password: string };

export interface CellResult {
  outcomeA: { kind: string; [key: string]: unknown };
  outcomeB: { kind: string; account_id?: string; [key: string]: unknown };
  seen: Wired[];
  cookies: Array<string | null>;
  activations: number;
  tab1: Page;
  tab2: Page;
}

/**
 * One cell of matrix T1 (A a password login) or T16 (A a registration): tab 1 starts attempt A (epoch 1), tab 2 starts attempt B
 * (epoch 2, a password login for `bWho`). `order` says whose request the BACKEND processes first; `window` says when A's answer
 * reaches tab 1. The proxy orders both: `hold` forwards at once and holds the answer; `hold_request` holds the request before the
 * backend sees it. Returns what the assertions need; the caller asserts, so each spec states its own claims.
 */
export async function runOrderingCell(
  context: BrowserContext,
  options: { a: AStart; bWho: Who; order: Order; window: Window },
): Promise<CellResult> {
  const { a, bWho, order, window } = options;
  const tab1 = await bootHarness(context);
  const tab2 = await bootHarness(context);
  const seen1 = wire(tab1);
  const seen2 = wire(tab2);
  const exchangePath = a.kind === "password" ? EXCHANGE : REGISTRATION;
  const cookies: Array<string | null> = [await sessionCookie(context)];
  const startA = () =>
    a.kind === "password"
      ? startSignIn(tab1, a.who)
      : startRegistration(tab1, a);
  const activations = async () =>
    (await proxy.log()).filter(
      (entry) => entry.method === "POST" && entry.path === ACTIVATE,
    ).length;

  let outcomeA: CellResult["outcomeA"];
  let outcomeB: CellResult["outcomeB"];

  if (window === "before-B-starts") {
    // A is still the newest attempt when its answer arrives: it activates and settles; B's later start then supersedes it.
    await startA();
    outcomeA = await finishSignIn(tab1);
    cookies.push(await sessionCookie(context));
    await startSignIn(tab2, bWho);
    outcomeB = await finishSignIn(tab2);
    cookies.push(await sessionCookie(context));
    await untilView(tab1, "displaying");
    return {
      outcomeA,
      outcomeB,
      seen: [...seen1, ...seen2],
      cookies,
      activations: await activations(),
      tab1,
      tab2,
    };
  }

  const ruleA = await proxy.addRule({
    method: "POST",
    path: exchangePath,
    action: order === "A-first" ? "hold" : "hold_request",
    ordinal: 1,
  });
  await startA();
  await untilHeld(ruleA.id);

  const releaseA = async () => {
    await proxy.release(ruleA.id);
    return finishSignIn(tab1);
  };

  if (window === "B-exchanging") {
    const ruleB = await proxy.addRule({
      method: "POST",
      path: EXCHANGE,
      action: "hold",
      ordinal: 1,
    });
    await startSignIn(tab2, bWho);
    await untilHeld(ruleB.id);
    outcomeA = await releaseA();
    // B's attempt is untouched by the discard.
    const during = (await records(tab2)).auth_state.attempt;
    expect(during).toMatchObject({ epoch: 2, phase: "exchanging" });
    await proxy.release(ruleB.id);
    outcomeB = await finishSignIn(tab2);
  } else if (window === "B-gating") {
    const ruleAct = await proxy.addRule({
      method: "POST",
      path: ACTIVATE,
      action: "hold",
      ordinal: 1,
    });
    await startSignIn(tab2, bWho);
    await untilHeld(ruleAct.id);
    const before = (await records(tab2)).auth_state.attempt;
    expect(before).toMatchObject({ epoch: 2, phase: "activating" });
    outcomeA = await releaseA();
    const after = (await records(tab2)).auth_state.attempt;
    expect(after).toEqual(before);
    await proxy.release(ruleAct.id);
    outcomeB = await finishSignIn(tab2);
  } else {
    // B has settled and its attempt record is gone: the worst case.
    if (order === "B-first") {
      // A's request is still held at the proxy; B's login is processed first, then A's request is released.
      await startSignIn(tab2, bWho);
      outcomeB = await finishSignIn(tab2);
    } else {
      await startSignIn(tab2, bWho);
      outcomeB = await finishSignIn(tab2);
    }
    cookies.push(await sessionCookie(context));
    outcomeA = await releaseA();
  }
  cookies.push(await sessionCookie(context));
  await untilView(tab1, "displaying");
  await untilView(tab2, "displaying");
  return {
    outcomeA,
    outcomeB,
    seen: [...seen1, ...seen2],
    cookies,
    activations: await activations(),
    tab1,
    tab2,
  };
}

export { ACCOUNTS };
