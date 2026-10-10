import type { Session, Store, Trace } from "../../session";
import type { LeaderRole } from "./election";
import { markLeaderStarted } from "./presence";

/**
 * The STATIC boot shim of production leadership (P-3, P-13): `boot.tsx` calls it after `session.start()`. It holds nothing heavy: the
 * leader (Dexie, the engines, the plans) is a dynamic import, so the initial chunk stays within its budget. A chunk that does not load
 * (offline before it was cached) is asked for again, paced, and on the browser's `online` event; until it loads the page leads nothing,
 * which is what the chip says ("Updates stopped").
 */
export interface DataLeaderHandle {
  readonly role: Store<LeaderRole>;
  /** Tests and HMR only. */
  dispose(): void;
}

type Loader = () => Promise<{
  startBrowserLeader(
    session: Session,
    options?: { trace?: Trace },
  ): { leader: { role: Store<LeaderRole> }; dispose(): void };
}>;

export function startDataLeader(
  session: Session,
  options: { trace?: Trace; load?: Loader } = {},
): DataLeaderHandle {
  const load: Loader = options.load ?? (() => import("../ui/browser-leader"));
  markLeaderStarted();
  let role: LeaderRole = { kind: "idle" };
  const listeners = new Set<() => void>();
  const publish = (next: LeaderRole): void => {
    role = next;
    for (const listener of [...listeners]) listener();
  };
  let disposed = false;
  let started: { dispose(): void } | null = null;
  let off: (() => void) | null = null;
  let failures = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const attempt = (): void => {
    if (disposed || started !== null) return;
    void load().then(
      (module) => {
        if (disposed || started !== null) return;
        const browser = module.startBrowserLeader(
          session,
          options.trace ? { trace: options.trace } : {},
        );
        started = browser;
        off = browser.leader.role.subscribe(() =>
          publish(browser.leader.role.get()),
        );
        publish(browser.leader.role.get());
      },
      () => {
        if (disposed) return;
        failures += 1;
        timer ??= setTimeout(
          () => {
            timer = null;
            attempt();
          },
          Math.min(60_000, 1_000 * 2 ** Math.min(failures, 6)),
        );
      },
    );
  };
  const online = (): void => attempt();
  if (typeof window !== "undefined") window.addEventListener("online", online);
  attempt();
  return {
    role: {
      get: () => role,
      subscribe(listener) {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    },
    dispose() {
      disposed = true;
      if (timer !== null) clearTimeout(timer);
      if (typeof window !== "undefined")
        window.removeEventListener("online", online);
      off?.();
      started?.dispose();
      started = null;
      publish({ kind: "idle" });
    },
  };
}
