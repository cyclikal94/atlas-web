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

/**
 * t0/t1 of matrix T4/T22: the page is hidden (a real `visibilitychange`), then, in Chromium, frozen over the DevTools protocol
 * (`Page.setWebLifecycleState`). Returns `resume()`, which unfreezes, shows the page and reports the state SYNCHRONOUSLY after the `visible`
 * event, before any task of the page has run: the first frame.
 */
export async function hideThenShow(
  page: Page,
  browserName: string,
): Promise<(options?: { holdAuthMs?: number }) => Promise<FirstFrame>> {
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
    return page.evaluate((holdAuthMs) => {
      // T22's held local check, armed in the SAME task as the `visible` event (see `holdableAuth` below).
      if (holdAuthMs > 0)
        (window as unknown as { __holdAuthUntil: number }).__holdAuthUntil =
          performance.now() + holdAuthMs;
      (window as unknown as { __visibility: string }).__visibility = "visible";
      document.dispatchEvent(new Event("visibilitychange"));
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
    }, options.holdAuthMs ?? 0);
  };
}

/**
 * TEST-ONLY (T22's "local check delayed"): while `performance.now()` is before `window.__holdAuthUntil`, every `atlas-auth` transaction
 * created has its completion delivered no earlier than that instant, so the resume's local check (whichever transaction decides it) is held
 * for the window, and no transaction waits longer than the window from its creation. A window of 4 s stays inside the kernel's own 5 s
 * cover-stall bound (`coverStallMs`); a longer wait is a STALLED store, which fails closed (finding O-3). No product hook exists.
 */
export async function holdableAuth(context: BrowserContext) {
  await context.addInitScript(() => {
    const w = window as unknown as {
      __holdAuthUntil?: number;
      __heldAuth?: number;
    };
    const transaction = IDBDatabase.prototype.transaction;
    IDBDatabase.prototype.transaction = function (
      this: IDBDatabase,
      ...args: Parameters<IDBDatabase["transaction"]>
    ) {
      const tx = transaction.apply(this, args);
      const until = w.__holdAuthUntil ?? 0;
      if (this.name !== "atlas-auth" || performance.now() >= until) return tx;
      w.__heldAuth = (w.__heldAuth ?? 0) + 1;
      let handler: ((this: IDBTransaction, event: Event) => unknown) | null =
        null;
      tx.addEventListener("complete", (event) => {
        setTimeout(
          () => handler?.call(tx, event),
          Math.max(0, until - performance.now()),
        );
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
