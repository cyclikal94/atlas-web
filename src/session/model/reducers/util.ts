import { clone } from "../records";
import type {
  AccountId,
  AuthRecords,
  AuthState,
  Fence,
  InvalidReason,
  LeaseId,
} from "../types";

/** A working copy of `auth_state`: a reducer reads only its `records` argument and never mutates it (rule 10). */
export const draft = (records: Readonly<AuthRecords>): AuthState =>
  clone(records.auth_state);

export const nextSeq = (state: AuthState): number => {
  state.fence_seq += 1;
  return state.fence_seq;
};

export function pushFence(
  state: AuthState,
  account: AccountId,
  fence: Fence,
): void {
  const list = state.fences[account] ?? [];
  list.push(fence);
  state.fences[account] = list;
}

export const hasObservation = (
  state: AuthState,
  account: AccountId,
  obsId: string,
): boolean => (state.fences[account] ?? []).some((f) => f.obs_id === obsId);

export const hasSameKindAndEpoch = (
  state: AuthState,
  account: AccountId,
  kind: "invalid_session" | "drift",
  epoch: number,
): boolean =>
  (state.fences[account] ?? []).some(
    (f) => f.kind === kind && f.epoch === epoch,
  );

export function deleteLeases(state: AuthState, ids: Iterable<LeaseId>): void {
  for (const id of ids) delete state.leases[id];
}

export function removeAccountFences(
  state: AuthState,
  account: AccountId,
): void {
  delete state.fences[account];
}

export function tidyFences(state: AuthState, account: AccountId): void {
  if ((state.fences[account] ?? []).length === 0) delete state.fences[account];
}

export const invalidSession = (
  seq: number,
  epoch: number,
  obsId: string,
  reason: InvalidReason,
  now: string,
): Fence => ({
  seq,
  epoch,
  obs_id: obsId,
  kind: "invalid_session",
  reason,
  created_at: now,
});
