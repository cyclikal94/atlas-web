import {
  ledgerClear,
  ledgerCreate,
  ledgerSetStatus,
} from "../model/reducers/misc";
import type { DeletionLedger } from "../ports/deletion";
import type { AuthStore } from "../ports/store";

/**
 * The `atlas-auth`-backed deletion ledger (decision D-03). The record lives beside `auth_state` so the ledger entry
 * and the operation's envelope can be cleared in ownership-checked transactions of one store. Every mutation
 * compares `operation_id`: a mismatch changes nothing.
 */
export function createStoreLedger(store: AuthStore): DeletionLedger {
  return {
    async read(account) {
      return store.transact(
        (records) => ({
          write: null,
          result: structuredClone(records.pending_deletions[account] ?? null),
        }),
        { label: "ledger:read" },
      ).complete;
    },
    async create(entry, options) {
      const result = await store.transact(
        (records) =>
          ledgerCreate(records, {
            entry,
            operation_live: options?.operationLive,
          }),
        { durability: "strict", label: "ledger:create" },
      ).complete;
      return result === "OK";
    },
    async setStatus(account, operationId, patch, expect) {
      const result = await store.transact(
        (records) =>
          ledgerSetStatus(records, {
            account_id: account,
            operation_id: operationId,
            patch,
            expect,
          }),
        { durability: "strict", label: "ledger:status" },
      ).complete;
      return result === "OK";
    },
    async clear(account, operationId) {
      const result = await store.transact(
        (records) =>
          ledgerClear(records, {
            account_id: account,
            operation_id: operationId,
          }),
        { durability: "strict", label: "ledger:clear" },
      ).complete;
      return result === "OK";
    },
    async list() {
      return store.transact(
        (records) => ({
          write: null,
          result: structuredClone(Object.values(records.pending_deletions)),
        }),
        { label: "ledger:list" },
      ).complete;
    },
  };
}
