import type { AccountId, OperationId, PendingDeletion } from "../model/types";

/** The `atlas-auth`-backed deletion ledger (D-03). Every mutation is ownership-checked by `operation_id`. */
export interface DeletionLedger {
  read(account: AccountId): Promise<PendingDeletion | null>;
  /**
   * Record a deletion. True when the entry now exists under THIS operation (created, or already its own); false when another
   * operation owns the account's entry, or, with `operationLive`, when this operation's envelope fence is no longer in
   * `atlas-auth` (it was resolved: "Keep for now" removes the envelope first) and so nothing may be recreated for it.
   */
  create(
    entry: PendingDeletion,
    options?: { operationLive?: boolean },
  ): Promise<boolean>;
  /**
   * False when the entry is gone, belongs to another operation, or (with `expect`) is no longer exactly what the caller saw:
   * the change is committed only against that state, so a choice made on a resolved or replaced prompt applies nothing.
   */
  setStatus(
    account: AccountId,
    operationId: OperationId,
    patch: Partial<
      Pick<PendingDeletion, "status" | "digest" | "approved_digest" | "count">
    >,
    expect?: { status: PendingDeletion["status"]; digest: string | null },
  ): Promise<boolean>;
  /** False when a different operation_id owns the entry. */
  clear(account: AccountId, operationId: OperationId): Promise<boolean>;
  list(): Promise<PendingDeletion[]>;
}

/** WEB-09a registers the real adapter (D-14). */
export interface AccountDatabasePort {
  /** `indexedDB.databases()`. NEVER `open()`, which creates an absent database. May reject when unsupported. */
  exists(account: AccountId): Promise<boolean>;
  /** Opens an EXISTING database, reads sync_state.incarnation_id, closes. */
  readIncarnation(account: AccountId): Promise<string | null>;
  closeOwnConnections(account: AccountId): Promise<void>;
  /** Awaits onsuccess or onerror; `blocked` stays pending and is never success. */
  delete(
    account: AccountId,
  ): Promise<"deleted" | "blocked_then_deleted" | "error">;
}

export interface LocalWorkSummary {
  count: number;
  items: readonly string[];
  digest: string;
}
export interface LocalWorkPort {
  summarise(account: AccountId): Promise<LocalWorkSummary>;
}

/** Step 3a of the canonical procedure; WEB-09a implements it over draft_fence and form_recovery. */
export interface WipeCoordinationPort {
  /** BEFORE the fence/envelope and the network call (D-18). */
  setDraftFence(
    account: AccountId,
    operationId: OperationId,
  ): Promise<{ consentDigest: string }>;
  broadcastImminent(account: AccountId, operationId: OperationId): void;
  waitForClosure(account: AccountId, boundedMs: number): Promise<void>;
  /** draft_fence.closing = true, in the same transaction as the broadcast. */
  setClosing(account: AccountId): Promise<void>;
  liveDigest(account: AccountId): Promise<string>;
  /** How many unsent changes and recovery copies exist now (a count for the consent prompt). */
  liveCount(account: AccountId): Promise<number>;
  baselineDigest(account: AccountId): Promise<string | null>;
  /** "Keep for now": ownership-scanning release. */
  releaseFence(account: AccountId, operationId: OperationId): Promise<void>;
}

export interface DeletionPorts {
  ledger: DeletionLedger;
  database: AccountDatabasePort;
  localWork: LocalWorkPort;
  coordination: WipeCoordinationPort;
}
