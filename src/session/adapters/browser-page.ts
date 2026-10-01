import type { Clock, Ids } from "../ports/clock";
import type { PageEnv, PageEvent } from "../ports/page";

const base64url = (bytes: Uint8Array): string => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
};

export function createBrowserClock(): Clock {
  return {
    now: () => Date.now(),
    iso: () => new Date().toISOString(),
    setTimeout: (fn, ms) => window.setTimeout(fn, ms),
    clearTimeout: (id) => window.clearTimeout(id),
    abortAfter: (ms) => AbortSignal.timeout(ms),
  };
}

export function createBrowserIds(): Ids {
  return {
    uuid: () => crypto.randomUUID(),
    verifier: () => base64url(crypto.getRandomValues(new Uint8Array(32))),
    async challenge(verifier) {
      const digest = await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(verifier),
      );
      return base64url(new Uint8Array(digest));
    },
  };
}

/**
 * One page: visibility, connectivity, the lifecycle events the protocol listens for, and the render scheduler. `bootId`
 * is a random UUID from the moment the page's script starts (matrix 3.3 `boot_id`).
 */
export function createBrowserPage(
  win: Window & typeof globalThis = window,
  doc: Document = document,
): PageEnv {
  const bootId = crypto.randomUUID();
  const channel = new MessageChannel();
  const tasks: Array<() => void> = [];
  channel.port1.onmessage = () => {
    const task = tasks.shift();
    task?.();
  };
  return {
    bootId,
    isVisible: () => doc.visibilityState === "visible",
    isOnline: () => win.navigator.onLine,
    on(event: PageEvent, listener: () => void) {
      const add = (
        target: EventTarget,
        name: string,
        when?: () => boolean,
      ): (() => void) => {
        const handler = () => {
          if (!when || when()) listener();
        };
        target.addEventListener(name, handler);
        return () => target.removeEventListener(name, handler);
      };
      switch (event) {
        case "visible":
          return add(
            doc,
            "visibilitychange",
            () => doc.visibilityState === "visible",
          );
        case "hidden":
          return add(
            doc,
            "visibilitychange",
            () => doc.visibilityState === "hidden",
          );
        case "pageshow":
          return add(win, "pageshow");
        case "pagehide":
          return add(win, "pagehide");
        case "focus":
          return add(win, "focus");
        case "resume":
          // The Page Lifecycle `resume` event (Chromium); other engines return through `visibilitychange`/`pageshow`.
          return add(doc, "resume");
        case "online":
          return add(win, "online");
        case "offline":
          return add(win, "offline");
      }
    },
    queueTask(task) {
      // A macrotask that a hidden tab's timer throttling does not delay. The task is queued, never run inline, so the
      // tree mount and the lock release in `act` stay one synchronous step.
      tasks.push(task);
      channel.port2.postMessage(0);
    },
  };
}
