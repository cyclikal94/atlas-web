import type { Captured, SyncStateRow } from "./types";

/**
 * The commit guard (plan 5.2). A response that is APPLIED (a sync page, a receipt, a profile, a device verification) carries a
 * `Captured` value taken when its request was issued, and the transaction that applies it decides, from the durable
 * `sync_state` singleton it reads in the SAME transaction, whether to apply it at all. Pure: nothing here reads a clock, a
 * browser global or the session.
 *
 * "Check the stamp inside the atomic commit" cannot be literal: `auth_state` lives in `atlas-auth`, the commit lives in
 * `atlas-<account>`, and IndexedDB transactions never span two databases. So the guard is LAYERED (G1 to G4 of the plan), and
 * this module is the part that runs inside the data transaction (G3). The residual window is stated in
 * `docs/data-layer.md` and tested as a characterised property (F-S4); it is never described as "inside the atomic commit".
 *
 * Each guard is a separate, separately named statement so that removing any ONE of them is a distinct mutation (MU-03 to MU-08)
 * that a distinct test must catch.
 */
export type GuardName =
  | "INC"
  | "CLS"
  | "CAS"
  | "GEN"
  | "OWN"
  | "EPO"
  /** The draft fence refuses a new draft or an in-place edit of a queued command (enforced by the enqueue and edit plans). */
  | "FEN";

export type DropReason =
  | "identity_changed"
  | "incarnation"
  | "closing"
  | "position"
  | "generation"
  | "owner"
  | "epoch_superseded"
  | "closed"
  /**
   * The identity could not be verified in time: the session record could not be read, or the persistence hold could not be had
   * while a settlement was under way. Nothing was applied, and it is not an answer about identity: the caller asks again.
   */
  | "unverified";

/** The part of `Captured` a plan that has no request (an enqueue) can still carry: the incarnation of the handle it holds. */
export type GuardInput = Pick<Captured, "incarnationId"> & Partial<Captured>;

/**
 * G3-INC: the handle that issued this plan was opened on a different incarnation of the database than the one it now finds (the
 * database was deleted and re-created since). Shared by `checkGuards` and by plans that carry only their handle's incarnation,
 * so one mutation of this function removes the guard everywhere (MU-03).
 */
export function incarnationMismatch(
  sync: SyncStateRow,
  incarnationId: string,
): boolean {
  return sync.incarnation_id !== incarnationId;
}

/**
 * The first guard that refuses, or `null`. The order is fixed: a different database, then a closing one, then the position
 * of the page, then the epoch. A drop writes NOTHING and changes no `auth_state` (matrix 3.7.3, M:2708).
 */
export function checkGuards(
  sync: SyncStateRow | undefined,
  captured: GuardInput,
  guards: readonly GuardName[],
): DropReason | null {
  // A missing singleton can only mean the database was damaged or replaced: nothing is applied to it.
  if (sync === undefined) return "incarnation";
  if (guards.includes("INC")) {
    if (incarnationMismatch(sync, captured.incarnationId)) return "incarnation";
  }
  if (guards.includes("CLS")) {
    if (sync.draft_fence?.closing === true) return "closing";
  }
  if (guards.includes("CAS")) {
    if (sync.cursor !== (captured.expectedPosition ?? null)) return "position";
  }
  if (guards.includes("GEN")) {
    if (sync.recovery_generation !== (captured.recoveryGeneration ?? 0))
      return "generation";
  }
  if (guards.includes("OWN")) {
    if (
      (sync.owner?.ownership_token ?? null) !==
      (captured.ownershipToken ?? null)
    )
      return "owner";
  }
  if (guards.includes("EPO")) {
    // The published epoch mirror: drop iff a LATER epoch of this account has already been published to this database.
    if (
      sync.stamp !== null &&
      captured.epoch !== undefined &&
      sync.stamp.epoch > captured.epoch
    )
      return "epoch_superseded";
  }
  return null;
}

/**
 * The epoch mirror after an apply (G3-EPO): monotone `max`, written in the same transaction, so the FIRST page that learns a
 * new epoch protects every page's later commits. `null` when nothing changes.
 */
export function publishEpoch(
  sync: SyncStateRow,
  epoch: number | undefined,
): SyncStateRow["stamp"] | null {
  if (epoch === undefined) return null;
  if (sync.stamp !== null && sync.stamp.epoch >= epoch) return null;
  return { epoch };
}
