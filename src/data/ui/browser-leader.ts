import { apiUrl } from "../../lib/api-client/wire";
import { createWebLocksPort, type Session, type Trace } from "../../session";
import { createLeaderElection } from "../leader/election";
import { createSyncLeader, type SyncLeader } from "../leader/leader";
import { getPageDataHost } from "../leader/page-host";
import { DATA_CONFIG } from "../model/config";
import { createKeyDerivers, createValueValidators } from "../scan/validate";
import { getPageRegistry } from "../store/registry";
import { createBrowserRuntime } from "./browser-env";
import { createProductionQuota } from "./production-quota";

/**
 * The BROWSER composition of the production sync leader (P-3, P-13). Loaded by a dynamic import from the boot shim
 * (`startDataLeader`), so neither Dexie nor the engines enter the initial chunk.
 *
 * It composes ONE data runtime for the page (the page registry, `session.persistence`, the `atlas-sync` channel and its wipe responder)
 * and hands it to the page host, so the protected tree's provider uses the same runtime instead of building its own: the tree is
 * unmounted under every fence, and a runtime it owned would close the page's connections (and with them the leader's) each time. The
 * page runtime lives as long as the page. The leader's markers, conflict registry and channel are the page's own.
 */
export interface BrowserLeader {
  readonly leader: SyncLeader;
  dispose(): void;
}

export function startBrowserLeader(
  session: Session,
  options: { trace?: Trace } = {},
): BrowserLeader {
  const host = getPageDataHost();
  const browser = createBrowserRuntime(session);
  host.setRuntime({ runtime: browser.runtime, channel: browser.channel });
  const markers = host.markers;
  void markers.prepare();
  const navigatorWithMemory = navigator as Navigator & {
    deviceMemory?: number;
  };
  const leader = createSyncLeader({
    election: createLeaderElection({
      locks: createWebLocksPort(navigator.locks),
      name: DATA_CONFIG.syncLeaderLock,
    }),
    runtime: browser.runtime,
    tabId: getPageRegistry().tabId,
    identity: session.identity,
    view: session.view,
    compat: session.compat,
    fetchFor: (klass, account, epoch) =>
      session.api.fetchFor(klass, account, epoch),
    recovery: session.recovery,
    admission: (klass, account, epoch) =>
      session.api.admission(klass, account, epoch),
    operationPending: (account) =>
      session.operations.pending.get().some((op) => op.account_id === account),
    apiUrl: (path) => apiUrl(path),
    online: () => navigator.onLine,
    subscribe: (listener) => {
      const offs = [
        session.view.subscribe(listener),
        session.identity.subscribe(listener),
        // A logout or retirement that resolves (or begins) changes whether the account may be opened (row 3).
        session.operations.pending.subscribe(listener),
      ];
      document.addEventListener("visibilitychange", listener);
      return () => {
        for (const off of offs) off();
        document.removeEventListener("visibilitychange", listener);
      };
    },
    onOnline: (listener) => {
      window.addEventListener("online", listener);
      return () => window.removeEventListener("online", listener);
    },
    clock: {
      now: () => Date.now(),
      iso: () => new Date().toISOString(),
      random: () => Math.random(),
      setTimeout: (fn, ms) => window.setTimeout(fn, ms),
      clearTimeout: (handle) => window.clearTimeout(handle as number),
    },
    yield: () => new Promise<void>((resolve) => setTimeout(resolve, 0)),
    decode: {
      validators: createValueValidators(),
      derivers: createKeyDerivers(),
    },
    quota: createProductionQuota(),
    signals: {
      deviceMemoryGiB: navigatorWithMemory.deviceMemory,
      hasStorageEstimate: typeof navigator.storage?.estimate === "function",
    },
    channel: browser.channel,
    markers,
    conflicts: host.conflicts,
    ids: { uuid: () => crypto.randomUUID() },
    publish: (attachment) => host.setLeader(attachment),
    elapsed: () => performance.now(),
    ...(options.trace ? { trace: options.trace } : {}),
  });
  leader.start();
  // The neutral state 3's "Try again" (the session's `actions.retry`) is the recovery job's act too (R2 of the review of 10 October
  // 2026): this page's job when it leads the displayed identity's account, else the leading page's, asked on `atlas-sync`.
  const offRetry = session.recovery.onRetry(() => {
    const identity = session.identity.get();
    if (identity !== null)
      leader.retryUpdates({
        account: identity.account_id,
        epoch: identity.epoch,
      });
  });
  return {
    leader,
    dispose() {
      offRetry();
      leader.dispose();
      host.setRuntime(null);
      markers.release();
      browser.dispose();
    },
  };
}
