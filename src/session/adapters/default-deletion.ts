import type { AccountId } from "../model/types";
import type {
  AccountDatabasePort,
  DeletionPorts,
  LocalWorkPort,
  WipeCoordinationPort,
} from "../ports/deletion";
import type { AuthStore } from "../ports/store";
import { createStoreLedger } from "./deletion-ledger";

/**
 * "No local stores yet" defaults for the canonical wipe's data ports (decision D-14). WEB-08a owns the procedure; the
 * drafts and `form_recovery` stores, and so the real adapters, arrive with WEB-09a, which registers its own.
 *
 * The default must never let the procedure conclude "nothing to delete, nothing unsynced" about data it cannot see. So
 * `exists` looks for the per-account database with `indexedDB.databases()` (which never creates one); when it finds one it
 * REFUSES, and the wipe reports `adapter_missing` and keeps the ledger entry rather than deleting or claiming anything.
 * Only when no such database exists does it answer `false`, which is true today.
 */
export const ACCOUNT_DATABASE_PREFIX = "atlas-";
export const accountDatabaseName = (account: AccountId): string =>
  `${ACCOUNT_DATABASE_PREFIX}${account}`;

export class AdapterMissingError extends Error {
  constructor(what: string) {
    super(`no ${what} adapter is registered but the account database exists`);
    this.name = "AdapterMissingError";
  }
}

export function createDefaultDatabasePort(
  factory: Pick<IDBFactory, "databases"> | undefined = typeof indexedDB ===
  "undefined"
    ? undefined
    : indexedDB,
): AccountDatabasePort {
  const refuse = (): never => {
    throw new AdapterMissingError("account database");
  };
  return {
    async exists(account) {
      // `databases()` may be missing or reject; either way the answer is unknown, and unknown is never "absent".
      if (!factory || typeof factory.databases !== "function") return refuse();
      const found = await factory.databases();
      const present = found.some(
        (entry) => entry.name === accountDatabaseName(account),
      );
      return present ? refuse() : false;
    },
    readIncarnation: async () => refuse(),
    closeOwnConnections: async () => undefined,
    delete: async () => refuse(),
  };
}

export const defaultLocalWorkPort: LocalWorkPort = {
  async summarise() {
    return { count: 0, items: [], digest: "0" };
  },
};

export const defaultCoordinationPort: WipeCoordinationPort = {
  async setDraftFence() {
    return { consentDigest: "0" };
  },
  broadcastImminent() {},
  async waitForClosure() {},
  async setClosing() {},
  async liveDigest() {
    return "0";
  },
  async liveCount() {
    return 0;
  },
  async baselineDigest() {
    return "0";
  },
  async releaseFence() {},
};

export function createDefaultDeletionPorts(
  store: AuthStore,
  overrides: Partial<Omit<DeletionPorts, "ledger">> = {},
): DeletionPorts {
  return {
    ledger: createStoreLedger(store),
    database: overrides.database ?? createDefaultDatabasePort(),
    localWork: overrides.localWork ?? defaultLocalWorkPort,
    coordination: overrides.coordination ?? defaultCoordinationPort,
  };
}
