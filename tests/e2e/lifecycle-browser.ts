import type { BrowserContext, Page } from "@playwright/test";
import { expect } from "./helpers";

/**
 * Helpers for WEB-08c's real-browser lifecycle specs (`production.lifecycle-browser.spec.ts`, `production.lifecycle-a11y.spec.ts`). Test
 * code only: a spec MAY call `navigator.locks.query()` to SHOW that a real lock is held (product code never does, lint R2), and the
 * visibility override is the stated limitation of headless engines (D-8c-06).
 */
export const passwordOf = (name: string) => `${name}-pw-9271`;
export const newMarker = (stem: string) =>
  `${stem}${Math.random().toString(36).slice(2, 8)}`.replace(/[^a-z0-9]/g, "x");

/** The public sign-in form: filled until both values hold (WebKit can draw it once more as it appears), then submitted. */
export async function publicSignIn(page: Page, username: string) {
  const user = page.getByLabel("Username");
  const secret = page.getByLabel("Password");
  await expect(async () => {
    await user.fill(username);
    await secret.fill(passwordOf(username));
    await expect(user).toHaveValue(username, { timeout: 250 });
    await expect(secret).toHaveValue(passwordOf(username), { timeout: 250 });
  }).toPass({ timeout: 10_000 });
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
}

export async function displayedAs(
  page: Page,
  username: string,
  timeout = 20_000,
) {
  await expect(
    page.locator("#protected-root:not([inert])").getByRole("button", {
      name: `${username}, switch account`,
    }),
  ).toBeVisible({ timeout });
}

/**
 * Every page of the context reads its visibility from `window.__visibility` ("visible" by default), so a test can hide and show it with a
 * real `visibilitychange` event. A headless engine cannot background a page natively; this is the stated limitation.
 */
export async function allowFreeze(context: BrowserContext) {
  await context.addInitScript(() => {
    const w = window as unknown as { __visibility: "visible" | "hidden" };
    w.__visibility = "visible";
    Object.defineProperty(document, "visibilityState", {
      get: () => w.__visibility,
      configurable: true,
    });
    Object.defineProperty(document, "hidden", {
      get: () => w.__visibility === "hidden",
      configurable: true,
    });
  });
}

export interface FirstFrame {
  inert: boolean;
  ariaHidden: boolean;
  gateOpen: boolean;
  /** Focusable elements of the protected tree that are NOT inside an inert subtree (must be none). */
  reachable: string[];
  title: string;
}

export interface ResumeOptions {
  /**
   * T22 (revision 2): hold ONLY the display check's record read, the `atlas-auth` transaction the session's `visible` handler creates
   * synchronously inside the `visibilitychange` dispatch, so that its completion is delivered `holdDisplayReadMs` after that transaction
   * was CREATED. Nothing else is held. See `holdableAuth`.
   */
  holdDisplayReadMs?: number;
  /**
   * HISTORICAL (revision 1 and HF-9's original schedule only; never T22 evidence): every `atlas-auth` transaction created before
   * `performance.now() + holdAuthWindowMs` has its completion delivered no earlier than that instant.
   */
  holdAuthWindowMs?: number;
}

/**
 * t0/t1 of matrix T4/T22: the page is hidden (a real `visibilitychange`), then, in Chromium, frozen over the DevTools protocol
 * (`Page.setWebLifecycleState`). Returns `resume()`, which unfreezes, shows the page and reports the state SYNCHRONOUSLY after the `visible`
 * event, before any task of the page has run: the first frame. `window.__visibleAt` records the instant the `visible` event was dispatched.
 */
export async function hideThenShow(
  page: Page,
  browserName: string,
): Promise<(options?: ResumeOptions) => Promise<FirstFrame>> {
  await page.evaluate(() => {
    (window as unknown as { __visibility: string }).__visibility = "hidden";
    document.dispatchEvent(new Event("visibilitychange"));
  });
  const cdp =
    browserName === "chromium"
      ? await page.context().newCDPSession(page)
      : null;
  if (cdp) await cdp.send("Page.setWebLifecycleState", { state: "frozen" });
  return async (options = {}) => {
    if (cdp) await cdp.send("Page.setWebLifecycleState", { state: "active" });
    return page.evaluate(
      ({ readMs, windowMs }) => {
        const w = window as unknown as {
          __holdAuthUntil?: number;
          __holdDisplayRead?: { ms: number; armed: boolean } | null;
          __visibleAt?: number;
          __visibility: string;
        };
        // Armed in the SAME task as the `visible` event and disarmed when its dispatch returns (see `holdableAuth` below).
        if (windowMs > 0) w.__holdAuthUntil = performance.now() + windowMs;
        w.__holdDisplayRead = readMs > 0 ? { ms: readMs, armed: true } : null;
        w.__visibility = "visible";
        w.__visibleAt = performance.now();
        document.dispatchEvent(new Event("visibilitychange"));
        if (w.__holdDisplayRead) w.__holdDisplayRead.armed = false;
        const root = document.getElementById("protected-root");
        const gate = document.querySelector("dialog[open]");
        const focusable = root
          ? [
              ...root.querySelectorAll<HTMLElement>(
                "a[href], button, input, textarea, select, [tabindex]",
              ),
            ].filter((el) => !el.closest("[inert]"))
          : [];
        return {
          inert: root?.hasAttribute("inert") ?? false,
          ariaHidden: root?.getAttribute("aria-hidden") === "true",
          gateOpen: gate !== null,
          reachable: focusable.map((el) => el.outerHTML.slice(0, 80)),
          title: document.title,
        };
      },
      {
        readMs: options.holdDisplayReadMs ?? 0,
        windowMs: options.holdAuthWindowMs ?? 0,
      },
    );
  };
}

/** One `atlas-auth` transaction held by `holdableAuth`'s display-read hold. */
export interface HeldRead {
  /** `performance.now()` when the transaction was created. */
  created: number;
  /** When the engine's own `complete` event reached the hook (null: not yet). */
  nativeComplete: number | null;
  /** When the hook delivered it to the store's `oncomplete` (null: not yet). */
  delivered: number | null;
  /** `put`/`delete` calls made on its object store (a record read makes none). */
  writes: number;
}

/**
 * TEST-ONLY (T22's "local check delayed"). Revision 2: the hold targets the IDENTIFIED read. The session's `visible` handler starts the display
 * check synchronously, and `transact` creates its transaction synchronously (`idb-auth-store.ts`), so the transaction created on
 * `atlas-auth` while `window.__holdDisplayRead.armed` is true (only inside `resume()`'s `visibilitychange` dispatch) IS the display check's
 * record read. Its native completion is kept and delivered `ms` after the transaction was CREATED: what the store and kernel observe as
 * "the read answered" is that delivery. Every held transaction is logged in `window.__heldReads` (creation, native completion, delivery,
 * writes); a spec asserts exactly one, with no writes, so a hold that hit another transaction fails its setup. No product hook exists.
 *
 * `holdAuthWindowMs` keeps the revision-1 window hold for the historical HF-9 schedule only (`window.__heldAuth` counts it).
 */
export async function holdableAuth(context: BrowserContext) {
  await context.addInitScript(() => {
    const w = window as unknown as {
      __holdAuthUntil?: number;
      __heldAuth?: number;
      __holdDisplayRead?: { ms: number; armed: boolean } | null;
      __heldReads?: Array<{
        created: number;
        nativeComplete: number | null;
        delivered: number | null;
        writes: number;
      }>;
    };
    w.__heldReads = [];
    const transaction = IDBDatabase.prototype.transaction;
    IDBDatabase.prototype.transaction = function (
      this: IDBDatabase,
      ...args: Parameters<IDBDatabase["transaction"]>
    ) {
      const tx = transaction.apply(this, args);
      if (this.name !== "atlas-auth") return tx;
      const created = performance.now();
      const display = w.__holdDisplayRead;
      const windowUntil = w.__holdAuthUntil ?? 0;
      let deliverAt: number;
      let entry: NonNullable<typeof w.__heldReads>[number] | null = null;
      if (display?.armed) {
        deliverAt = created + display.ms;
        entry = { created, nativeComplete: null, delivered: null, writes: 0 };
        w.__heldReads?.push(entry);
        const objectStore = tx.objectStore.bind(tx);
        tx.objectStore = (name: string) => {
          const store = objectStore(name);
          for (const method of ["put", "delete"] as const) {
            const original = store[method].bind(store) as (
              ...a: unknown[]
            ) => IDBRequest;
            (store as unknown as Record<string, unknown>)[method] = (
              ...a: unknown[]
            ) => {
              if (entry) entry.writes += 1;
              return original(...a);
            };
          }
          return store;
        };
      } else if (created < windowUntil) {
        deliverAt = windowUntil;
        w.__heldAuth = (w.__heldAuth ?? 0) + 1;
      } else return tx;
      let handler: ((this: IDBTransaction, event: Event) => unknown) | null =
        null;
      tx.addEventListener("complete", (event) => {
        if (entry) entry.nativeComplete = performance.now();
        // A timer may fire slightly EARLY against `performance.now()` (Chromium, campaign 2026-10-13T21-05-25.391Z-08a4ecef: a "5 s" hold
        // delivered at 4,999.x ms), so delivery waits until the deadline has really passed.
        const deliver = () => {
          const left = deliverAt - performance.now();
          if (left > 0) {
            setTimeout(deliver, Math.ceil(left));
            return;
          }
          if (entry) entry.delivered = performance.now();
          handler?.call(tx, event);
        };
        deliver();
      });
      Object.defineProperty(tx, "oncomplete", {
        configurable: true,
        get: () => handler,
        set: (fn) => {
          handler = fn;
        },
      });
      return tx;
    } as typeof transaction;
  });
}

/** The display-read hold's log (`holdableAuth`). */
export const heldReads = (page: Page) =>
  page.evaluate(
    () => (window as unknown as { __heldReads?: HeldRead[] }).__heldReads ?? [],
  );

/**
 * Every change of the resume gate (`dialog#resume-gate` open) and of `#protected-root`'s `inert`, with its `performance.now()` instant, from
 * the first script of every page: the gate's whole history, so an early lift between two samples cannot go unseen.
 */
export async function recordGateTransitions(context: BrowserContext) {
  await context.addInitScript(() => {
    const log: Array<{ at: number; gateOpen: boolean; inert: boolean }> = [];
    (window as unknown as { __gateLog: typeof log }).__gateLog = log;
    const snapshot = () => {
      const gateOpen =
        document.querySelector("dialog#resume-gate[open]") !== null;
      // A page whose protected root does not exist yet exposes nothing: recorded as inert.
      const inert =
        document.getElementById("protected-root")?.hasAttribute("inert") ??
        true;
      const last = log[log.length - 1];
      if (!last || last.gateOpen !== gateOpen || last.inert !== inert)
        log.push({ at: performance.now(), gateOpen, inert });
    };
    new MutationObserver(snapshot).observe(document, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["open", "inert"],
    });
  });
}

export interface GateTransition {
  at: number;
  gateOpen: boolean;
  inert: boolean;
}
export const gateLog = (page: Page) =>
  page.evaluate(
    () =>
      (window as unknown as { __gateLog?: GateTransition[] }).__gateLog ?? [],
  );

/**
 * The first instant at or after `from` when the protected tree was exposed (gate closed AND root not inert), or null. A pure function of
 * the transition log, so a spec can also show that it detects an early lift (the sensitivity case).
 */
export function firstExposure(
  log: GateTransition[],
  from: number,
): number | null {
  let current: GateTransition | undefined;
  for (const entry of log) if (entry.at <= from) current = entry;
  if (current && !current.gateOpen && !current.inert) return from;
  for (const entry of log)
    if (entry.at > from && !entry.gateOpen && !entry.inert) return entry.at;
  return null;
}

/**
 * TEST-ONLY (T22 t2, "the frozen tab receives no broadcast"): while the page reports itself hidden (`allowFreeze`'s `window.__visibility`),
 * a session hint on `atlas-auth-hints` is dropped and counted (`window.__missedHints`). A frozen Chromium page delivers the hints it queued
 * the moment it is resumed, before the test can make it visible, and Firefox and WebKit cannot freeze a page at all; without this the
 * resumed page has already learned branch (i) or (ii) and never runs the held local check the trace is about. The matrix's own rule is that
 * a page resumed after MISSING the hint is decided by the record (3.7.2 step 3), which is what this exercises. Nothing else is dropped.
 */
export async function missHintsWhileHidden(context: BrowserContext) {
  await context.addInitScript(() => {
    const w = window as unknown as {
      __visibility?: string;
      __missedHints?: number;
    };
    const handler = Object.getOwnPropertyDescriptor(
      BroadcastChannel.prototype,
      "onmessage",
    );
    if (!handler?.set || !handler.get) return;
    const { get, set } = handler;
    Object.defineProperty(BroadcastChannel.prototype, "onmessage", {
      configurable: true,
      enumerable: handler.enumerable ?? false,
      get() {
        return get.call(this);
      },
      set(this: BroadcastChannel, fn: unknown) {
        if (this.name !== "atlas-auth-hints" || typeof fn !== "function")
          return set.call(this, fn);
        const deliver = fn as (this: BroadcastChannel, e: MessageEvent) => void;
        set.call(this, function (this: BroadcastChannel, event: MessageEvent) {
          if (w.__visibility === "hidden") {
            w.__missedHints = (w.__missedHints ?? 0) + 1;
            return;
          }
          deliver.call(this, event);
        });
      },
    });
  });
}

/** The `atlas-lease-<id>` locks held in this origin now (a TEST may use `query()` to show a real lock exists). */
export async function findLeaseLocks(page: Page): Promise<string[]> {
  await expect
    .poll(
      () =>
        page.evaluate(async () =>
          ((await navigator.locks.query()).held ?? [])
            .map((lock) => lock.name ?? "")
            .filter((name) => name.startsWith("atlas-lease-")),
        ),
      { timeout: 15_000 },
    )
    .not.toEqual([]);
  return page.evaluate(async () =>
    ((await navigator.locks.query()).held ?? [])
      .map((lock) => lock.name ?? "")
      .filter((name) => name.startsWith("atlas-lease-")),
  );
}

/** A pending `navigator.locks.request(name)` from `page` (never `ifAvailable`): resolves when granted. */
export async function waiterFor(page: Page, name: string) {
  await page.evaluate((lock) => {
    const w = window as unknown as { __grantedAt: number | null };
    w.__grantedAt = null;
    void navigator.locks.request(lock, () => {
      w.__grantedAt = performance.timeOrigin + performance.now();
    });
  }, name);
  const readAt = () =>
    page.evaluate(
      () => (window as unknown as { __grantedAt: number | null }).__grantedAt,
    );
  return {
    async granted(withinMs: number): Promise<boolean> {
      const deadline = Date.now() + withinMs;
      while (Date.now() < deadline) {
        if ((await readAt()) !== null) return true;
        await page.waitForTimeout(100);
      }
      return (await readAt()) !== null;
    },
    async grantedAt(withinMs: number): Promise<number | null> {
      const deadline = Date.now() + withinMs;
      while (Date.now() < deadline) {
        const at = await readAt();
        if (at !== null) return at;
        await page.waitForTimeout(25);
      }
      return readAt();
    },
  };
}
