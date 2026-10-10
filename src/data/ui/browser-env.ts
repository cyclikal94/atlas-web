import { createWebLocksPort, type Session } from "../../session";
import { DataRuntime } from "../engine/account-service";
import {
  createBroadcastSyncChannel,
  type SyncChannel,
} from "../engine/sync-channel";
import { attachWipeResponder } from "../engine/wipe-responder";
import { createDexieOpener } from "../store/dexie-adapter";
import { createIdbHost } from "../store/idb-host";
import { type OpenDeps, openAccountData } from "../store/open";
import { getPageRegistry } from "../store/registry";

/**
 * The BROWSER composition of the data layer's UI controller (plan 6.1): the one module of `src/data/ui` that reaches Dexie. It is
 * loaded by a dynamic import from the provider, inside the protected-tree chunk, so Dexie never enters the initial bundle.
 *
 * It composes the page's runtime over the PRODUCTION host, open predicate and registry, and attaches the `atlas-sync` responder
 * every tab with an open account database needs (it closes this page's connections on `wipe_imminent` and acknowledges). Nothing
 * here starts a sync engine or a dispatcher.
 */
export interface BrowserRuntime {
  runtime: DataRuntime;
  channel: SyncChannel;
  dispose(): void;
}

export function createBrowserRuntime(session: Session): BrowserRuntime {
  const registry = getPageRegistry();
  const host = createIdbHost();
  const opener = createDexieOpener({
    registry,
    onVersionChange: () => undefined,
  });
  const locks = createWebLocksPort(navigator.locks);
  const identity = session.identity;
  const deps: OpenDeps = {
    host,
    opener,
    registry,
    locks,
    identityAccount: () => identity.get()?.account_id ?? null,
    operationPending: (account) =>
      session.operations.pending.get().some((op) => op.account_id === account),
    newIncarnation: () => crypto.randomUUID(),
    lockWaitMs: 20_000,
    abortAfter: (ms) => AbortSignal.timeout(ms),
  };
  const runtime = new DataRuntime({
    identity,
    // Every response-derived commit is ordered against every settlement of the session record (G5, obligation 4).
    persistence: session.persistence,
    registry,
    open: (account, options) => openAccountData(deps, account, options),
  });
  const channel = createBroadcastSyncChannel();
  const stopResponder = attachWipeResponder({ channel, registry });
  return {
    runtime,
    channel,
    dispose() {
      stopResponder();
      runtime.dispose();
      // The channel this composition opened is let go with it (R29): nothing keeps listening after the page stops.
      channel.close();
    },
  };
}
