import type { DatabaseHost, ProbeResult } from "./host";

/**
 * The browser `DatabaseHost` over raw IndexedDB. It never imports Dexie, so it is part of the small static port shims that
 * boot loads (plan 5.3.1) and adds almost nothing to the initial bundle.
 *
 * It is the ONLY file in `src/` that calls `deleteDatabase` for an account database (lint rule R16; the capability probe's
 * throwaway database is the other, separate use).
 */
export function createIdbHost(
  factory: IDBFactory | undefined = typeof indexedDB === "undefined"
    ? undefined
    : indexedDB,
): DatabaseHost {
  return {
    async list() {
      if (!factory || typeof factory.databases !== "function")
        throw new Error("indexedDB.databases() is not available");
      const found = await factory.databases();
      return found.flatMap((entry) => (entry.name ? [entry.name] : []));
    },

    probe(name, timeoutMs) {
      return new Promise<ProbeResult>((resolve, reject) => {
        if (!factory) {
          reject(new Error("indexedDB is not available"));
          return;
        }
        let settled = false;
        let vanished = false;
        const finish = (action: () => void): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          action();
        };
        const timer = setTimeout(
          () =>
            finish(() => {
              reject(new Error("the probe of the account database timed out"));
            }),
          timeoutMs,
        );
        let request: IDBOpenDBRequest;
        try {
          // No version: opening an existing database never upgrades it.
          request = factory.open(name);
        } catch (error) {
          finish(() => reject(error));
          return;
        }
        request.onupgradeneeded = () => {
          // The database vanished between `databases()` and this open. Abort the creating upgrade: the engine then discards
          // the new database, so a probe can never create one.
          vanished = true;
          try {
            request.transaction?.abort();
          } catch {
            // Already aborted.
          }
        };
        request.onerror = () =>
          finish(() => {
            if (vanished) resolve({ kind: "absent" });
            else reject(request.error ?? new Error("probe failed"));
          });
        request.onsuccess = () => {
          const db = request.result;
          if (settled) {
            // A late success after a time-out: close and say nothing.
            db.close();
            return;
          }
          if (!db.objectStoreNames.contains("sync_state")) {
            db.close();
            finish(() => resolve({ kind: "present", incarnation: null }));
            return;
          }
          try {
            const read = db
              .transaction("sync_state", "readonly")
              .objectStore("sync_state")
              .get("singleton");
            read.onsuccess = () => {
              const row = read.result as
                | { incarnation_id?: unknown }
                | undefined;
              const incarnation =
                typeof row?.incarnation_id === "string"
                  ? row.incarnation_id
                  : null;
              db.close();
              finish(() => resolve({ kind: "present", incarnation }));
            };
            read.onerror = () => {
              db.close();
              finish(() =>
                reject(read.error ?? new Error("probe read failed")),
              );
            };
          } catch (error) {
            db.close();
            finish(() => reject(error));
          }
        };
        request.onblocked = () => {
          // An open with no version is never blocked; if an engine reports it, the time-out decides.
        };
      });
    },

    delete(name) {
      return new Promise((resolve) => {
        if (!factory) {
          resolve("error");
          return;
        }
        let blocked = false;
        let request: IDBOpenDBRequest;
        try {
          request = factory.deleteDatabase(name);
        } catch {
          resolve("error");
          return;
        }
        // `blocked` stays pending: it is NEVER reported as success. The kernel holds the account's lock for as long as the
        // delete is blocked, which is why every tab closes its connections on `versionchange`.
        request.onblocked = () => {
          blocked = true;
        };
        request.onsuccess = () =>
          resolve(blocked ? "blocked_then_deleted" : "deleted");
        request.onerror = () => resolve("error");
      });
    },
  };
}
