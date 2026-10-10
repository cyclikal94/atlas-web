import {
  createWriteFailureMarkers,
  type WriteFailureMarkers,
} from "../engine/write-failure-marker";
// From their own module, not `local-work.ts`: that module would be placed whole in the initial chunk (R61, revision 39).
import {
  UNREADABLE_BASELINE,
  UNREADABLE_LIVE,
  UNREADABLE_SUMMARY,
} from "../model/unreadable-digests";
import type { DatabaseHost } from "../store/host";
import { createIdbHost } from "../store/idb-host";
import { type ConnectionRegistry, getPageRegistry } from "../store/registry";
import { createAccountDatabasePort } from "./account-database";
import type { createPortsImpl } from "./ports-impl";
import type { DataDeletionPorts } from "./types";

/**
 * The STATIC shims registered at boot (`browserPorts({ deletion: createDataDeletionPorts() })`, plan 5.3.1).
 *
 * - `database` is implemented with RAW IndexedDB and the static registry, so it works before the Dexie chunk has loaded and
 *   adds almost nothing to the initial bundle;
 * - `localWork` and `coordination` are thin shims that import `ports-browser` once (memoised) and delegate. Every method whose
 *   caller does not catch a rejection is TOTAL here too: a chunk that fails to load becomes the same conservative value the
 *   real adapter would give, never a rejection and never a silent "nothing to do".
 *
 * `createDefaultDeletionPorts` (the session's refusing default) is untouched. A test proves that, with these ports registered,
 * `adapter_missing` is unreachable while a database exists, and that removing the registration from `boot.tsx` fails.
 */
type Impl = ReturnType<typeof createPortsImpl>;

export interface DeletionPortsOptions {
  host?: DatabaseHost;
  registry?: ConnectionRegistry;
  markers?: WriteFailureMarkers;
  now?: () => number;
  /** Test seam: supply the lazy implementation directly. */
  loadImpl?: (shared: {
    host: DatabaseHost;
    registry: ConnectionRegistry;
  }) => Promise<Impl>;
}

export function createDataDeletionPorts(
  options: DeletionPortsOptions = {},
): DataDeletionPorts {
  const host = options.host ?? createIdbHost();
  const registry = options.registry ?? getPageRegistry();
  // This shim only removes a deleted account's markers: it takes no directory slot of its own (`locks: null`), which a page's writers do.
  const markers =
    options.markers ??
    createWriteFailureMarkers(undefined, undefined, { locks: null });
  const database = createAccountDatabasePort({
    host,
    registry,
    markers,
    now: options.now ?? (() => Date.now()),
  });

  const loader =
    options.loadImpl ??
    (async (shared) =>
      (await import("./ports-browser")).createBrowserPortsImpl(shared));
  let memo: Promise<Impl> | null = null;
  let loaded: Impl | null = null;
  const load = (): Promise<Impl> => {
    memo ??= loader({ host, registry }).then(
      (impl) => {
        loaded = impl;
        return impl;
      },
      (error: unknown) => {
        // A failed load is retried on the next call (offline, a chunk that was not cached yet).
        memo = null;
        throw error;
      },
    );
    return memo;
  };

  // `broadcastImminent` is synchronous in the port, but the kernel calls `setClosing` straight after it: the intent must have
  // been recorded by then, so `setClosing` waits for the chain.
  let intent: Promise<void> = Promise.resolve();

  return {
    database,

    localWork: {
      async summarise(account) {
        try {
          return await (await load()).localWork.summarise(account);
        } catch {
          return { count: 0, items: [], digest: UNREADABLE_SUMMARY };
        }
      },
    },

    coordination: {
      // May reject: `initiate()` maps it to `refused/storage_unavailable`.
      setDraftFence: async (account, operationId) =>
        (await load()).coordination.setDraftFence(account, operationId),

      broadcastImminent(account, operationId) {
        if (loaded) {
          try {
            loaded.coordination.broadcastImminent(account, operationId);
          } catch {
            // Fire-and-forget.
          }
          return;
        }
        intent = intent
          .then(() => load())
          .then((impl) =>
            impl.coordination.broadcastImminent(account, operationId),
          )
          .catch(() => undefined);
      },

      async setClosing(account) {
        try {
          await intent;
          return await (await load()).coordination.setClosing(account);
        } catch {
          // Total, and honest (R12): a chunk that did not load is not a closed fence. The wipe does not go on without one.
          return "unconfirmed";
        }
      },

      async waitForClosure(account, boundedMs) {
        try {
          await intent;
          await (await load()).coordination.waitForClosure(account, boundedMs);
        } catch {
          // Total: a frozen tab is not waited for beyond the bound.
        }
      },

      async liveDigest(account) {
        try {
          return await (await load()).coordination.liveDigest(account);
        } catch {
          return UNREADABLE_LIVE;
        }
      },

      async liveCount(account) {
        try {
          return await (await load()).coordination.liveCount(account);
        } catch {
          return 0;
        }
      },

      async baselineDigest(account) {
        try {
          return await (await load()).coordination.baselineDigest(account);
        } catch {
          return UNREADABLE_BASELINE;
        }
      },

      async releaseFence(account, operationId) {
        try {
          await (await load()).coordination.releaseFence(account, operationId);
        } catch {
          // Idempotent, ownership-scanning, never throws.
        }
      },
    },
  };
}
