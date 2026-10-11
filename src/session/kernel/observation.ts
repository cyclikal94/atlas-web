import { recogniseAtlasError } from "../../lib/api-client/problem";
import { recordObservation as recordObservationReducer } from "../model/reducers/observation";
import type {
  AccountId,
  Epoch,
  InvalidReason,
  LeaseId,
  ObservationKind,
} from "../model/types";
import { retireLease } from "./activity";
import type { ActivityImpl, Kernel } from "./state";

/**
 * Observations and the lock-free recording path (matrix 3.6, 3.6.1; lint rule R9). The handler for a
 * possibly-invalidating answer runs these steps in this order, in ONE synchronous step up to the hold:
 *
 *   1. SURRENDER: settle the promise that holds the lease's lock. Before any `await`, any body read
 *      (`.text()`, `.json()`, `.clone()`) and any storage call.
 *   2. In the same step: set the interim hold for the account and cancel this page's activities for it (Ex6).
 *   3. Classify, then hold and hint, then record in ONE stamp-checked transaction that NEVER requests `atlas-auth`.
 *   4. If the write cannot complete: keep the hold, keep the hint posted, retry without limit, reusing `obs_id`.
 */

export type SelfRevoking = "password" | "unlink" | "logout" | "retire";

/** One issued request, as its answer handler sees it. */
export interface InFlight {
  activity: ActivityImpl;
  lease: LeaseId;
  account: AccountId;
  epoch: Epoch;
  klass: "ordinary" | "verification" | "operation" | "recovery";
  identityRead: boolean;
  selfRevoking: SelfRevoking | null;
  /** The foreign request leases the verification's cover captured (every one released to this page). */
  unresolved: ReadonlySet<LeaseId>;
  /** `fence_seq` at the cover's commit: rule 9's `s`, captured before the request was sent. */
  fenceSeq: number;
}

/** Decided from the status and the request's kind alone, before any body is read (matrix 3.6.2 Terms). */
export function possiblyInvalidating(
  status: number,
  inflight: Pick<InFlight, "identityRead" | "selfRevoking">,
): boolean {
  if (status === 401 || status === 403) return true;
  if (inflight.identityRead) return true;
  return inflight.selfRevoking !== null && status >= 200 && status < 300;
}

/**
 * The owner's first synchronous act on a possibly-invalidating answer: settle the promise that holds the lease's
 * lock. It cannot fail for storage reasons. The lock is never re-acquired. Returns whether it surrendered.
 */
export function surrenderLock(
  k: Kernel,
  inflight: InFlight,
  status: number,
): boolean {
  if (!possiblyInvalidating(status, inflight)) return false;
  const handle = inflight.activity.leaseHandle;
  inflight.activity.leaseHandle = null;
  handle?.release();
  k.emit("surrender", {
    n: inflight.activity.n,
    lease: inflight.lease,
    account: inflight.account,
    epoch: inflight.epoch,
    klass: inflight.klass,
    status,
    identityRead: inflight.identityRead,
  });
  return true;
}

/** The hold's id: one per detection. */
export const holdIdFor = (lease: LeaseId): string => `d:${lease}`;

/**
 * Set the interim hold and cancel this page's activities for the account (Ex6, matrix 3.6.1 step 1a), in the same
 * synchronous step as the surrender: its exposure attempt in whatever state, and every unsent ordinary and recovery
 * request. Requests already ISSUED are untouched: each has its own lease. Closes this page's display of the account.
 */
export function detectInvalidation(
  k: Kernel,
  inflight: InFlight,
  surrendered: boolean,
): void {
  if (!surrendered) return;
  // An identity read is sent by this page's own bookkeeping (decision D-21): its interim hold cancels activities and
  // refuses requests, but an already displaying tree is closed only when the answer is CLASSIFIED as an observation.
  setHold(
    k,
    inflight.account,
    holdIdFor(inflight.lease),
    "detection",
    !inflight.identityRead,
  );
}

/** Setting a hold, for ANY cause, runs the same cancellation and closes the account's display in this page. */
export function setHold(
  k: Kernel,
  account: AccountId,
  id: string,
  cause: string,
  closeDisplay = true,
): void {
  k.memory.addHold(account, id);
  cancelPageActivitiesFor(k, account, "hold");
  k.emit("hold.set", { account, id, cause });
  if (closeDisplay) k.hooks.closeDisplay(account, "hold");
}

export function cancelPageActivitiesFor(
  k: Kernel,
  account: AccountId,
  reason: "hold" | "closing_write",
): void {
  const exposure = k.memory.exposure;
  if (exposure && exposure.account === account) exposure.cancel(reason);
  const unsent = k.memory.unsent.get(account);
  if (unsent) for (const activity of [...unsent]) activity.cancel(reason);
}

export function releaseHoldAndReevaluate(
  k: Kernel,
  account: AccountId,
  id: string,
): void {
  k.memory.releaseHold(account, id);
  k.emit("hold.release", { account, id });
  k.hooks.evaluate("hold_released");
}

/** What the recording path records. */
export interface Observation {
  obs_id: string;
  lease_id: LeaseId;
  account: AccountId;
  epoch: Epoch;
  kind: ObservationKind;
  reason?: InvalidReason;
  retire?: readonly LeaseId[];
  /** An identity read's `fence_seq` at sending: the `credential_unverified` entries its answer replaces (WEB-08c, T21). */
  replaces_unverified?: number;
  /** The hold this recording releases when it completes. */
  hold_id: string;
}

/**
 * Steps 1c and 2 to 4 of matrix 3.6.1: hold, hint, then record. Never waits for `atlas-auth`; never discards an
 * observation for any reason but staleness decided inside the transaction; retries without limit.
 */
export async function recordAndHold(
  k: Kernel,
  observation: Observation,
  options: { announce?: boolean } = {},
): Promise<"DONE" | "STALE" | "disposed"> {
  const { account, epoch } = observation;
  // The hold only ADDS protection and covers this page's own display until the write commits.
  setHold(k, account, observation.hold_id, `observation:${observation.kind}`);
  // A page recording from a hint does not announce it again (no ping-pong between pages).
  if (options.announce !== false)
    k.ports.hints.post({
      type: "observation",
      obs_id: observation.obs_id,
      lease_id: observation.lease_id,
      account_id: account,
      stamp_epoch: epoch,
      kind: observation.kind,
    });
  let attempt = 0;
  while (!k.disposed) {
    k.emit("record.attempt", {
      obs: observation.obs_id,
      kind: observation.kind,
      attempt,
    });
    let outcome: "DONE" | "STALE" | "stalled" | "failed" = "failed";
    try {
      const transaction = k.ports.store.transact(
        (records) =>
          recordObservationReducer(records, {
            lease_id: observation.lease_id,
            account_id: account,
            stamp_epoch: epoch,
            kind: observation.kind,
            obs_id: observation.obs_id,
            now: k.ports.clock.iso(),
            reason: observation.reason,
            retire: observation.retire,
            ...(observation.replaces_unverified === undefined
              ? {}
              : { replaces_unverified: observation.replaces_unverified }),
          }),
        { durability: "strict", label: "record" },
      );
      outcome = await k.withStall(
        transaction.complete,
        k.config.recordingStallMs,
      );
    } catch {
      outcome = "failed";
    }
    if (outcome === "DONE" || outcome === "STALE") {
      k.emit("record.complete", { obs: observation.obs_id, outcome });
      k.ports.hints.post({ type: "auth_state_changed" });
      k.memory.releaseHold(account, observation.hold_id);
      k.emit("hold.release", { account, id: observation.hold_id });
      if (observation.kind === "credential_mismatch" && outcome === "DONE")
        k.hooks.startCredentialVerification(account, epoch);
      k.hooks.evaluate("recorded");
      return outcome;
    }
    // Keep the hold, keep the hint, retry on the back-off. The lease is still in the record and its lock was
    // surrendered, so every other page treats it as unresolved whether this page stays alive or not.
    const elapsed = await k.sleep(k.backoff(attempt));
    attempt = elapsed ? attempt + 1 : 0;
  }
  return "disposed";
}

/**
 * The classification of a `403` (matrix 3.6.1 step 1b): `credential_mismatch` is O10; a body that cannot be read
 * or is not an Atlas error body is treated as `credential_mismatch` (fail closed); any other Atlas `403` (for
 * example `forbidden`) is an ordinary refusal and NOT an observation.
 */
export async function classify403(
  response: Response,
): Promise<"credential_mismatch" | "ordinary"> {
  try {
    const copy = response.clone();
    const contentType = copy.headers.get("content-type");
    const body: unknown = await copy.json();
    const atlas = recogniseAtlasError(contentType, body);
    if (atlas === null) return "credential_mismatch";
    return atlas.code === "credential_mismatch"
      ? "credential_mismatch"
      : "ordinary";
  } catch {
    return "credential_mismatch";
  }
}

/** A non-invalidating answer to a request that surrendered (E1): delete the lease, tell the others, reopen. */
export function cleanRelease(k: Kernel, inflight: InFlight): void {
  // The lease is removed BEFORE its lock is released; a lock already surrendered stays surrendered.
  const handle = inflight.activity.leaseHandle;
  inflight.activity.leaseHandle = null;
  void retireLease(k, inflight.lease, handle).then(() => {
    k.ports.hints.post({ type: "auth_state_changed" });
  });
}
