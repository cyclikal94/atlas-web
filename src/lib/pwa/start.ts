import type { Session } from "../../session";
import { pageFormRegistry } from "../form-recovery/registry";
import {
  type AppUpdateCoordinator,
  type ContainerLike,
  type PageSignal,
  type RegistrationLike,
  startAppUpdates,
} from "./coordinator";
import { onNavigation } from "./navigation";
import { UPDATE_CHANNEL } from "./protocol";
import { onDataSuperseded } from "./signals";
import { appUpdates } from "./store";

/**
 * The BROWSER composition of the app-update coordinator (WEB-14a). A lazy chunk: `boot.tsx` imports it after `session.start()` has been
 * called, in the builds that ship the service worker (production and the `pwa-fixture` test build) and in no other.
 */
let running: AppUpdateCoordinator | null = null;

/** This page's own hashed entry script, by path: the build it runs, which the worker maps to a generation. */
export function pageEntry(doc: Document = document): string | null {
  const script = doc.querySelector<HTMLScriptElement>(
    'script[type="module"][src]',
  );
  if (!script?.src) return null;
  try {
    return new URL(script.src, location.href).pathname;
  } catch {
    return null;
  }
}

export function startBrowserAppUpdates(session: Session): AppUpdateCoordinator {
  if (running) return running;
  const on = (signal: PageSignal, listener: () => void): (() => void) => {
    if (signal === "visible") {
      const handler = () => {
        if (document.visibilityState === "visible") listener();
      };
      document.addEventListener("visibilitychange", handler);
      return () => document.removeEventListener("visibilitychange", handler);
    }
    window.addEventListener(signal, listener);
    return () => window.removeEventListener(signal, listener);
  };
  running = startAppUpdates({
    container:
      "serviceWorker" in navigator
        ? (navigator.serviceWorker as unknown as ContainerLike)
        : null,
    entry: pageEntry(),
    page: { on, isVisible: () => document.visibilityState === "visible" },
    clock: {
      now: () => Date.now(),
      setTimeout: (fn, ms) => window.setTimeout(fn, ms),
      clearTimeout: (handle) => window.clearTimeout(handle as number),
    },
    ids: { uuid: () => crypto.randomUUID() },
    channel: () =>
      typeof BroadcastChannel === "undefined"
        ? null
        : (new BroadcastChannel(UPDATE_CHANNEL) as never),
    messageChannel: () => {
      if (typeof MessageChannel === "undefined") return null;
      const pair = new MessageChannel();
      return { port: pair.port1 as never, transfer: pair.port2 };
    },
    forms: pageFormRegistry,
    compat: session.compat,
    onDataSuperseded,
    onNavigation,
    reload: () => location.reload(),
    publish: (state, actions) => appUpdates.set(state, actions),
  });
  return running;
}

/**
 * The page's service-worker registration, for WEB-14b's push and notification work: the one the coordinator made, or null where there is
 * none (no worker in this build, or registration failed).
 */
export function getAppRegistration(): Promise<ServiceWorkerRegistration | null> {
  return (running?.registration() ?? Promise.resolve(null)) as Promise<
    (RegistrationLike & ServiceWorkerRegistration) | null
  >;
}
