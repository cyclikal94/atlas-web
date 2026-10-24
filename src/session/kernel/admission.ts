import { leasesOfOthers } from "../model/records";
import { recoveryEligible } from "../model/reducers/cover";
import type { AccountId, AuthRecords, Epoch } from "../model/types";
import { isGating } from "../model/types";
import { readRecords } from "./evaluate";
import type { Kernel } from "./state";

/** What `probeAdmission` found: an opaque revision of the inputs, and whether one of them refuses the request now. */
export interface RequestAdmission {
  readonly revision: string;
  readonly blocked: boolean;
}

/**
 * WEB-09b (R3 of the review of 10 October 2026, second cycle): a READ of the inputs that decide whether an ordinary or recovery
 * request for (account, epoch) would be admitted by the send loop, for a caller that was refused and waits for them to change.
 *
 * The durable inputs are read from the record (the settled stamp, a gating attempt, the account's fence entries and `fence_seq`, the
 * other pages' request leases of the account); the page-local ones from this page's memory (a hold, a closing write, its CSRF token).
 * The revision also covers `latest_epoch`, which only increases: an attempt that began and ended between two probes leaves the record
 * otherwise as it was, and a waiter that was refused because of it must still see a change (WEB-08c K-2).
 * `blocked` is true when one of them refuses the request now, by the same rules as the cover (`recoveryEligible` for the recovery
 * class; no fence and no gating attempt for the ordinary one), a hold or a closing write. Foreign leases and the token are part of the
 * revision only: the send loop itself waits for, or resolves, both.
 *
 * Nothing is written, no lease is taken, no lock is waited for and nothing is verified: it is a hint, never a permission (the cover
 * decides, in its own transaction). A record that cannot be read in time is null (unknown). The revision is a digest, so it carries no
 * record content out of the session.
 */
export async function probeAdmission(
  k: Kernel,
  klass: "ordinary" | "recovery",
  account: AccountId,
  epoch: Epoch,
): Promise<RequestAdmission | null> {
  const records = await readRecords(k);
  if (records === null) return null;
  return admissionFrom(k, records, klass, account, epoch);
}

/** The admission of one read of the record (with this page's memory as it is now): `probeAdmission`, and `recovery.begin`'s refusal. */
export function admissionFrom(
  k: Kernel,
  records: Readonly<AuthRecords>,
  klass: "ordinary" | "recovery",
  account: AccountId,
  epoch: Epoch,
): RequestAdmission {
  const state = records.auth_state;
  const settled = state.settled;
  const stamp =
    settled !== null &&
    settled.account_id === account &&
    settled.epoch === epoch;
  const gating = isGating(state.attempt);
  const fences = (state.fences[account] ?? [])
    .map((fence) => `${fence.kind}:${fence.epoch}`)
    .sort();
  const foreign = leasesOfOthers(state, account, k.bootId)
    .filter(([, lease]) => lease.class !== "exposure")
    .map(([id]) => id)
    .sort();
  const hold = k.memory.hasHold(account);
  const closing = k.memory.closing > 0;
  const csrf = k.memory.csrf.has(k.memory.csrfKey(account, epoch));
  const open =
    klass === "recovery"
      ? recoveryEligible(state, account, epoch)
      : stamp && !gating && fences.length === 0;
  return {
    revision: digest(
      JSON.stringify([
        stamp,
        gating,
        state.latest_epoch,
        state.fence_seq,
        fences,
        foreign,
        hold,
        closing,
        csrf,
      ]),
    ),
    blocked: !stamp || !open || hold || closing,
  };
}

/** Two 32-bit FNV-1a hashes with different offsets: 64 bits, enough to tell one set of inputs from the next. */
function digest(text: string): string {
  let a = 0x811c9dc5;
  let b = 0x01000193 ^ 0x5bd1e995;
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193) >>> 0;
    b = Math.imul(b ^ c, 0x01000193) >>> 0;
  }
  return `${a.toString(16).padStart(8, "0")}${b.toString(16).padStart(8, "0")}`;
}
