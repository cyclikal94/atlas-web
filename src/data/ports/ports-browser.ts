import { createBroadcastSyncChannel } from "../engine/sync-channel";
import { createDexieOpener } from "../store/dexie-adapter";
import type { DatabaseHost } from "../store/host";
import { type ConnectionRegistry, createRegistry } from "../store/registry";
import { createPortsImpl } from "./ports-impl";

/**
 * The browser assembly of `ports-impl` (plan 5.3.1): this is the module the static shims import ONCE, lazily, so Dexie stays out
 * of the initial chunk. Each port call opens the account's existing database under its own private registry (see `ports-impl`).
 */
export function createBrowserPortsImpl(shared: {
  host: DatabaseHost;
  registry: ConnectionRegistry;
}) {
  return createPortsImpl({
    async openExisting(account) {
      // A private registry per call: the latch of the PAGE's registry (set when a wipe closes this page's service) must not
      // refuse a port, and a port's short-lived connection must not be counted as the page's.
      const scoped = createDexieOpener({ registry: createRegistry("port") });
      const opened = await scoped.open(account, {
        create: false,
        single: true,
        incarnation: crypto.randomUUID(),
      });
      return opened.kind === "opened" ? opened.store : null;
    },
    channel: createBroadcastSyncChannel(),
    registry: shared.registry,
    clock: {
      now: () => Date.now(),
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    },
    ids: { uuid: () => crypto.randomUUID() },
  });
}
