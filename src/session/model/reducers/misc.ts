import type { Rmw } from "../../ports/store";
import { clone, fencesFor } from "../records";
import type {
  AccountId,
  AuthRecords,
  DeviceRecord,
  OperationId,
  PendingDeletion,
  PendingDeletionStatus,
} from "../types";

/** D-02: an atomic get-or-create of the device ID. */
export function deviceGetOrCreate(
  records: Readonly<AuthRecords>,
  input: { device_id: string; now: string },
): Rmw<DeviceRecord> {
  if (records.device) return { write: null, result: clone(records.device) };
  const device: DeviceRecord = {
    device_id: input.device_id,
    created_at: input.now,
  };
  return { write: { device }, result: device };
}

/** 3.7.2 item 3: the boot canary writes only `boot.last_boot_at`. */
export function bootCanary(
  _records: Readonly<AuthRecords>,
  input: { now: string },
): Rmw<"OK"> {
  return { write: { boot: { last_boot_at: input.now } }, result: "OK" };
}

export type LedgerResult<T = "OK"> = T | "NOT_OWNER";

/**
 * D-03: create the deletion record; idempotent for the same operation, refused for another owner.
 *
 * `operation_live` (a confirmed operation recording its own deletion) additionally requires that operation's envelope fence
 * to still be in the record, checked in THIS transaction: "Keep for now" removes the envelope first, so a continuation that
 * was delayed past it can never recreate a `pending` entry for an operation that has already been resolved (WEB-04 7.8:
 * "no later caller can ever recreate a `pending`-status entry under that same, already-resolved operation_id").
 */
export function ledgerCreate(
  records: Readonly<AuthRecords>,
  input: { entry: PendingDeletion; operation_live?: boolean },
): Rmw<"OK" | "NOT_OWNER" | "NOT_LIVE"> {
  const existing = records.pending_deletions[input.entry.account_id];
  if (existing) {
    return {
      write: null,
      result:
        existing.operation_id === input.entry.operation_id ? "OK" : "NOT_OWNER",
    };
  }
  if (
    input.operation_live &&
    !fencesFor(records.auth_state, input.entry.account_id).some(
      (fence) =>
        fence.kind === "operation" &&
        fence.envelope.operation_id === input.entry.operation_id,
    )
  )
    return { write: null, result: "NOT_LIVE" };
  return {
    write: {
      pending_deletions: {
        ...records.pending_deletions,
        [input.entry.account_id]: input.entry,
      },
    },
    result: "OK",
  };
}

/** What the caller saw and is acting on: the update is committed only while the entry is still exactly this. */
export interface LedgerExpectation {
  status: PendingDeletionStatus;
  digest: string | null;
}

export function ledgerSetStatus(
  records: Readonly<AuthRecords>,
  input: {
    account_id: AccountId;
    operation_id: OperationId;
    patch: Partial<
      Pick<PendingDeletion, "status" | "digest" | "approved_digest" | "count">
    >;
    expect?: LedgerExpectation;
  },
): Rmw<"OK" | "NOT_OWNER" | "CHANGED"> {
  const existing = records.pending_deletions[input.account_id];
  if (!existing || existing.operation_id !== input.operation_id)
    return { write: null, result: "NOT_OWNER" };
  // Revalidated where the change is committed: a choice made on a prompt that has since been resolved or replaced applies nothing.
  if (
    input.expect &&
    (existing.status !== input.expect.status ||
      existing.digest !== input.expect.digest)
  )
    return { write: null, result: "CHANGED" };
  return {
    write: {
      pending_deletions: {
        ...records.pending_deletions,
        [input.account_id]: { ...existing, ...input.patch },
      },
    },
    result: "OK",
  };
}

export function ledgerClear(
  records: Readonly<AuthRecords>,
  input: { account_id: AccountId; operation_id: OperationId },
): Rmw<"OK" | "NOT_OWNER"> {
  const existing = records.pending_deletions[input.account_id];
  if (!existing) return { write: null, result: "OK" };
  if (existing.operation_id !== input.operation_id)
    return { write: null, result: "NOT_OWNER" };
  const rest = { ...records.pending_deletions };
  delete rest[input.account_id];
  return { write: { pending_deletions: rest }, result: "OK" };
}
