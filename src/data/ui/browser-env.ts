import { raiseDataSuperseded } from "../../lib/pwa/signals";
import { createWebLocksPort, type Session } from "../../session";
import { DataRuntime } from "../engine/account-service";
import {
  createBroadcastSyncChannel,
  type SyncChannel,
} from "../engine/sync-channel";
import { attachWipeResponder } from "../engine/wipe-responder";
import type { AccountId } from "../model/types";
import { createDexieOpener } from "../store/dexie-adapter";
import { createIdbHost } from "../store/idb-host";
import { type OpenDeps, openAccountData } from "../store/open";
import type { AccountStore } from "../store/port";
import { createRecoveryStore } from "../store/recovery-store";
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
  /**
   * The recovery connection of an account whose database another tab's newer build upgraded (WEB-14a revision 1, R7), for the incarnation
   * this page last had open; null unless the account is latched `upgrade_pending` (a deletion's or an identity change's closure is never
   * stood in for). One store per account and incarnation, so the port's order of captures continues across calls.
   */
  recoveryStore(account: AccountId, incarnationId: string): AccountStore | null;
  dispose(): void;
}

export function createBrowserRuntime(session: Session): BrowserRuntime {
  const registry = getPageRegistry();
  const host = createIdbHost();
  const opener = createDexieOpener({
    registry,
    // Another tab's newer build upgraded an account database (WEB-14a D-P8): this page asks to be reloaded. A deletion is the wipe's,
    // which reports itself.
    onVersionChange: (_account, kind) => {
      if (kind === "upgraded") raiseDataSuperseded();
    },
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
  const recoveryStores = new Map<string, AccountStore>();
  const superseded = (account: AccountId): boolean =>
    registry.latch(account) === "upgrade_pending";
  return {
    runtime,
    channel,
    recoveryStore(account, incarnationId) {
      if (!superseded(account)) return null;
      const key = JSON.stringify([account, incarnationId]);
      let store = recoveryStores.get(key);
      if (!store) {
        store = createRecoveryStore({
          account,
          incarnationId,
          admitted: () =>
            superseded(account) && identity.get()?.account_id === account,
        });
        recoveryStores.set(key, store);
      }
      return store;
    },
    dispose() {
      stopResponder();
      runtime.dispose();
      // The channel this composition opened is let go with it (R29): nothing keeps listening after the page stops.
      channel.close();
    },
  };
}
