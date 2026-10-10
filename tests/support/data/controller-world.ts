import { unorderedPersistence } from "../../../src/data/engine/account-service";
import type { WriteFailureMarkers } from "../../../src/data/engine/write-failure-marker";
import {
  deriveGate,
  deriveNotices,
  type GateState,
  type Notice,
} from "../../../src/data/model/status";
import { createDataEnv, type DataEnv } from "../../../src/data/ui/env";
import type { EngineWorld } from "./engine-world";

import { pageMarkers } from "./marker-storage";
/**
 * The PRODUCTION controller (`createDataEnv`) over an engine world: the same runtime, store plans, markers and engine the page uses,
 * over the double of IndexedDB. What the screens see is `gate()` and `notices()`, derived from the controller's own inputs exactly as
 * `useCacheGate` and the banners derive them.
 *
 * `leader: true` attaches the world's CURRENT engine as the controller's leader (the fixture's test leader, and later WEB-09b's).
 * `leader: false` is a FOLLOWER tab, or the controller of a page that has reloaded and has no engine: it sees only what is durable
 * (the facts of `sync_state`) and the account's fallback markers. Build a new one after `w.reload()` to model a reload: nothing the
 * old controller held in memory comes with it.
 *
 * A follower is its OWN page over the world's `localStorage`: a marker the engine's page writes or removes reaches it as a `storage`
 * event (R15), as the browser delivers one, and its own writes reach the engine's page. The leader's controller shares the engine's
 * page, which hears only the other pages' changes. `page` names a follower's page (several followers may share one name only if
 * they are meant to be one page).
 */
export interface ControllerProbe {
  readonly ui: DataEnv;
  gate(): GateState;
  notices(): Notice[];
  /** The browser loses connectivity: the world's flag, the controller's `online` store, and a wake of the engine. */
  offline(): void;
  /** The browser is back: the `online` event, the controller's store, and a wake of the engine. */
  online(): void;
  dispose(): void;
}

let followers = 0;

export async function controllerProbe(
  w: EngineWorld,
  options: {
    leader: boolean;
    page?: string;
    /** The page's own markers object, for a page whose storage was obtained another way (a getter that threw, R47 revision 29). */
    markers?: WriteFailureMarkers;
  },
): Promise<ControllerProbe> {
  followers += 1;
  const page = options.leader
    ? null
    : w.markerStorage.page(options.page ?? `follower-${followers}`);
  const listeners = new Set<() => void>();
  const onlineListeners = new Set<() => void>();
  const online = {
    get: () => w.online,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  const runtime = new w.env.modules.accountService.DataRuntime({
    identity: w.identity,
    persistence: unorderedPersistence,
    registry: w.page.registry,
    open: (account, openOptions) => w.page.open(account, openOptions),
  });
  const ui = createDataEnv({
    identity: w.identity,
    loadRuntime: async () => runtime,
    online,
    quota: w.quota,
    ids: { uuid: () => crypto.randomUUID() },
    clock: { now: () => Date.now(), iso: () => new Date().toISOString() },
    fence: () => ({ hasPendingOperation: false, sessionStarted: true }),
    readMe: async () => ({ kind: "closed" }),
    currentDeviceId: async () => ({ kind: "closed" }),
    onOnline: (listener) => {
      onlineListeners.add(listener);
      return () => {
        onlineListeners.delete(listener);
      };
    },
    markers: options.markers ?? (page === null ? w.markers : pageMarkers(page)),
    timers: w.timers,
  });
  if (options.leader)
    ui.attachLeader({ engine: w.engine, recovery: w.recovery });
  await w.settle();
  if (ui.service() === null)
    throw new Error("setup: the controller has no database");
  return {
    ui,
    gate: () => deriveGate(ui.inputs.get()),
    notices: () => deriveNotices(ui.inputs.get()),
    offline() {
      w.online = false;
      for (const listener of [...listeners]) listener();
      w.fire();
    },
    online() {
      w.online = true;
      for (const listener of [...listeners]) listener();
      for (const listener of [...onlineListeners]) listener();
      w.goOnline();
    },
    dispose: () => ui.dispose(),
  };
}
