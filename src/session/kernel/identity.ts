import { apiUrl } from "../../lib/api-client/wire";
import { LOCKS } from "../constants";
import { observeAttempt } from "../model/reducers/attempt";
import { convertStale, verifyOutcome } from "../model/reducers/observation";
import type {
  AccountId,
  Epoch,
  LeaseId,
  ObservationKind,
  SessionId,
} from "../model/types";
import {
  classify403,
  cleanRelease,
  detectInvalidation,
  holdIdFor,
  type InFlight,
  recordAndHold,
  releaseHoldAndReevaluate,
  surrenderLock,
} from "./observation";
import { type SendOutcome, send } from "./send";
import type { Kernel } from "./state";

/**
 * Identity reads (`GET /browser-sessions/current`), every one of them a leased request of class VERIFICATION
 * (matrix 3.6.2 step 1): the OBSERVE step of 3.4.2 (O5), O11 and O12, the verification of unresolved leases (step 4,
 * E3 to E5), the resume verification, and this page's own CSRF token. Any answer to an identity read is possibly
 * invalidating, so its owner surrenders first.
 */
interface BrowserSessionBody {
  account_id: AccountId;
  session_id: SessionId;
  csrf_token: string;
}

function parseBrowserSession(value: unknown): BrowserSessionBody | null {
  if (typeof value !== "object" || value === null) return null;
  const body = value as Record<string, unknown>;
  if (
    typeof body.account_id !== "string" ||
    typeof body.session_id !== "string" ||
    typeof body.csrf_token !== "string"
  )
    return null;
  return {
    account_id: body.account_id,
    session_id: body.session_id,
    csrf_token: body.csrf_token,
  };
}

export type Purpose =
  | {
      kind: "general";
      /** A credential_unverified fence, or a pending clear, wants the release step even with nothing unresolved. */
      expectClear: boolean;
      /** Only verify when captured leases remain: `verify_unresolved` sends nothing when U is empty. */
      onlyIfUnresolved?: boolean;
      /** The session_id this page believes is settled, so a differing one is annotated. */
      knownSessionId?: SessionId | null;
    }
  | {
      /** The OBSERVE step of a `verifying` attempt: runs under `atlas-auth`, writes with `observeAttempt`. */
      kind: "observe";
      attemptEpoch: Epoch;
    };

export type IdentityAnswer =
  | {
      kind: "same_account";
      body: BrowserSessionBody;
      /** Settles when the E3/E4 release under `atlas-auth` has committed (null when none was needed). */
      release: Promise<void> | null;
    }
  | { kind: "observation"; observation: ObservationKind }
  | { kind: "observed"; result: "REOBSERVE" | "DONE" | "SUPERSEDED" }
  | { kind: "incomplete" };

export type IdentityOutcome =
  | { kind: "ok"; session: BrowserSessionBody; release: Promise<void> | null }
  | { kind: "observation"; observation: ObservationKind }
  | { kind: "observed"; result: "REOBSERVE" | "DONE" | "SUPERSEDED" }
  | { kind: "incomplete" }
  | { kind: "nothing_to_resolve" }
  | { kind: "defer"; ids: readonly LeaseId[] }
  | {
      kind:
        | "not_sent"
        | "stale"
        | "closed"
        | "closed_unresolved"
        | "not_covered";
    };

/**
 * The handler for an identity read's answer. The surrender is the first statement (lint rule R9); the body is read
 * only afterwards. Non-invalidating outcomes delete the request's OWN lease; observations hand it over in the
 * recording transaction.
 */
export async function handleIdentityAnswer(
  k: Kernel,
  inflight: InFlight,
  response: Response,
  purpose: Purpose,
): Promise<IdentityAnswer> {
  const surrendered = surrenderLock(k, inflight, response.status);
  detectInvalidation(k, inflight, surrendered);
  const holdId = holdIdFor(inflight.lease);
  const retire = [...inflight.unresolved];
  const record = (kind: ObservationKind) => {
    void recordAndHold(k, {
      obs_id: k.ports.ids.uuid(),
      lease_id: inflight.lease,
      account: inflight.account,
      epoch: inflight.epoch,
      kind,
      // E4: a fence that replaces unresolved leases is `unresolved_response`; otherwise it is an ordinary O12.
      reason:
        kind === "current_401" && retire.length > 0
          ? "unresolved_response"
          : undefined,
      retire,
      // T21 t4b/t4c: this read's answer replaces the credential_unverified entries it was sent to verify (matrix "replaced by").
      replaces_unverified: inflight.fenceSeq,
      hold_id: holdId,
    });
    return { kind: "observation", observation: kind } as const;
  };
  const clean = () => {
    cleanRelease(k, inflight);
    releaseHoldAndReevaluate(k, inflight.account, holdId);
    return { kind: "incomplete" } as const;
  };

  if (purpose.kind === "observe")
    return observeAttemptAnswer(k, inflight, response, purpose, holdId);

  if (response.status === 401) return record("current_401");
  if (response.status === 403) {
    // An identity read carries no CSRF token, so a 403 cannot report a credential mismatch. Fail closed by staying
    // closed and retrying (decision SA-13); recording it would only queue another verification for ever.
    await classify403(response);
    return clean();
  }
  if (response.status !== 200) return clean();
  let parsed: BrowserSessionBody | null = null;
  try {
    parsed = parseBrowserSession(await response.json());
  } catch {
    parsed = null;
  }
  if (parsed === null) return clean();
  if (parsed.account_id !== inflight.account)
    return record("different_account");

  // A 200 for the settled account: clean (E1). The token is refreshed for the SAME account only. HF1-SHARED-CONFIRMATION-20261013: the
  // lease's deletion also records this answer as the session's latest confirmation, with its token, when the record still settles exactly
  // this session (account, epoch, session id), so the origin's other pages need no identity read of their own for 30 s.
  k.memory.csrf.set(
    k.memory.csrfKey(inflight.account, inflight.epoch),
    parsed.csrf_token,
  );
  cleanRelease(k, inflight, {
    account_id: inflight.account,
    epoch: inflight.epoch,
    session_id: parsed.session_id,
    csrf_token: parsed.csrf_token,
    now: k.ports.clock.iso(),
  });
  releaseHoldAndReevaluate(k, inflight.account, holdId);
  const needsRelease =
    inflight.unresolved.size > 0 ||
    purpose.expectClear ||
    (purpose.knownSessionId !== undefined &&
      purpose.knownSessionId !== parsed.session_id);
  const release = needsRelease
    ? releaseUnderAuthLock(k, inflight, parsed)
    : null;
  return { kind: "same_account", body: parsed, release };
}

/** E3/E4 and the same-account branch of O11 are RELEASES: one transaction under `atlas-auth`, retried until it completes. */
export async function releaseUnderAuthLock(
  k: Kernel,
  inflight: InFlight,
  body: BrowserSessionBody,
): Promise<void> {
  let attempt = 0;
  while (!k.disposed) {
    const lock = await k.ports.locks.acquire(LOCKS.auth, {
      signal: k.ports.clock.abortAfter(k.config.lockWaitMs),
    });
    if (lock !== null) {
      try {
        const transaction = k.ports.store.transact(
          (records) =>
            verifyOutcome(records, {
              lease_id: inflight.lease,
              account_id: inflight.account,
              epoch: inflight.epoch,
              session_id: body.session_id,
              captured: [...inflight.unresolved],
              s: inflight.fenceSeq,
              obs_id: k.ports.ids.uuid(),
              now: k.ports.clock.iso(),
            }),
          { durability: "strict", label: "verify_outcome" },
        );
        const result = await k.withStall(
          transaction.complete,
          k.config.recordingStallMs,
        );
        if (result !== "stalled") {
          k.emit("verify.outcome", {
            kind: result.kind,
            retired: result.retired,
            cleared: result.cleared,
          });
          k.ports.hints.post({ type: "auth_state_changed" });
          k.hooks.evaluate("verified");
          return;
        }
      } catch {
        // Retry: the entries simply remain and the account stays closed (fail closed).
      } finally {
        lock.release();
      }
    }
    const elapsed = await k.sleep(k.backoff(attempt));
    attempt = elapsed ? attempt + 1 : 0;
  }
}

/** The OBSERVE answer: we already hold `atlas-auth` (resolve() runs under it); write with `observeAttempt`. */
async function observeAttemptAnswer(
  k: Kernel,
  inflight: InFlight,
  response: Response,
  purpose: Extract<Purpose, { kind: "observe" }>,
  holdId: string,
): Promise<IdentityAnswer> {
  const incomplete = () => {
    cleanRelease(k, inflight);
    releaseHoldAndReevaluate(k, inflight.account, holdId);
    return { kind: "incomplete" } as const;
  };
  let observed:
    | { kind: "401" }
    | { kind: "200"; account_id: AccountId; session_id: SessionId }
    | null = null;
  let csrfToken: string | null = null;
  if (response.status === 401) observed = { kind: "401" };
  else if (response.status === 200) {
    try {
      const body = parseBrowserSession(await response.json());
      if (body) {
        observed = {
          kind: "200",
          account_id: body.account_id,
          session_id: body.session_id,
        };
        csrfToken = body.csrf_token;
      }
    } catch {
      observed = null;
    }
  }
  if (observed === null) return incomplete();
  try {
    const transaction = k.ports.store.transact(
      (records) =>
        observeAttempt(records, {
          epoch: purpose.attemptEpoch,
          lease: inflight.lease,
          s: inflight.fenceSeq,
          observed: observed as NonNullable<typeof observed>,
          captured: [...inflight.unresolved],
          obsId: k.ports.ids.uuid(),
          now: k.ports.clock.iso(),
        }),
      { durability: "strict", label: "observe_attempt" },
    );
    const result = await k.withStall(
      transaction.complete,
      k.config.recordingStallMs,
    );
    if (result === "stalled") return incomplete();
    k.memory.releaseHold(inflight.account, holdId);
    // The token belongs to the same account; it is refreshed for that account only.
    if (
      observed.kind === "200" &&
      observed.account_id === inflight.account &&
      csrfToken !== null
    )
      k.memory.csrf.set(
        k.memory.csrfKey(inflight.account, inflight.epoch),
        csrfToken,
      );
    k.ports.hints.post({ type: "auth_state_changed" });
    return { kind: "observed", result };
  } catch {
    return incomplete();
  }
}

/** Run one identity read as a leased VERIFICATION request. */
export async function readIdentity(
  k: Kernel,
  account: AccountId,
  epoch: Epoch,
  purpose: Purpose,
): Promise<IdentityOutcome> {
  const outcome: SendOutcome<IdentityAnswer> = await send<IdentityAnswer>(k, {
    klass: "verification",
    account,
    epoch,
    request: new Request(apiUrl("/browser-sessions/current"), {
      method: "GET",
    }),
    identityRead: true,
    returnDefer: purpose.kind === "observe",
    skipIssue:
      purpose.kind === "general" && purpose.onlyIfUnresolved
        ? (c) => c.unresolved.size === 0
        : undefined,
    onAnswer: (kernel, inflight, response) =>
      handleIdentityAnswer(kernel, inflight, response, purpose),
  });
  switch (outcome.kind) {
    case "answered": {
      const value = outcome.value;
      if (value.kind === "same_account")
        return { kind: "ok", session: value.body, release: value.release };
      return value;
    }
    case "failed":
      return { kind: "incomplete" };
    case "skipped":
      return { kind: "nothing_to_resolve" };
    case "defer":
      return { kind: "defer", ids: outcome.ids };
    default:
      return { kind: outcome.kind };
  }
}

// ---- single-flight users of identity reads -----------------------------------------------------------------------

const inflightCsrf = new WeakMap<Kernel, Map<string, Promise<boolean>>>();

/** This page's own CSRF token for (account, epoch), obtained from a leased verification. Single flight. */
export function ensureCsrf(
  k: Kernel,
  account: AccountId,
  epoch: Epoch,
): Promise<boolean> {
  const key = k.memory.csrfKey(account, epoch);
  if (k.memory.csrf.has(key)) return Promise.resolve(true);
  let map = inflightCsrf.get(k);
  if (!map) {
    map = new Map();
    inflightCsrf.set(k, map);
  }
  const existing = map.get(key);
  if (existing) return existing;
  const promise = readIdentity(k, account, epoch, {
    kind: "general",
    expectClear: false,
  }).then(
    (outcome) => outcome.kind === "ok" && k.memory.csrf.has(key),
    () => false,
  );
  map.set(key, promise);
  void promise.finally(() => map?.delete(key));
  return promise;
}

const verifying = new WeakMap<Kernel, Set<string>>();
const unresolvedRuns = new WeakMap<Kernel, Map<string, Promise<"ran">>>();

/**
 * The fence is the durable queue for the O11 verification: a page that finds a `credential_unverified` fence for
 * the settled account with no verification in flight IN THIS PAGE starts one. Single flight per page and account;
 * it retries on the back-off until the fence is gone or stale.
 */
export function startCredentialVerification(
  k: Kernel,
  account: AccountId,
  epoch: Epoch,
): void {
  let set = verifying.get(k);
  if (!set) {
    set = new Set();
    verifying.set(k, set);
  }
  const key = `${account}|${epoch}`;
  if (set.has(key)) return;
  set.add(key);
  void (async () => {
    let attempt = 0;
    try {
      while (!k.disposed) {
        if (!k.ports.page.isOnline()) {
          await k.sleep(k.backoff(attempt));
          continue;
        }
        const outcome = await readIdentity(k, account, epoch, {
          kind: "general",
          expectClear: true,
        });
        if (outcome.kind === "ok") {
          // The verification is not over until the release has committed (or the lock is finally obtained).
          await outcome.release;
          return;
        }
        if (outcome.kind === "observation" || outcome.kind === "stale") return;
        const elapsed = await k.sleep(k.backoff(attempt));
        attempt = elapsed ? attempt + 1 : 0;
      }
    } finally {
      set?.delete(key);
    }
  })();
}

/**
 * `verify_unresolved` (matrix 3.6.2 step 4): E5 first (unresolved leases of an OLDER epoch become fences, add-only,
 * no lock, no network), then one leased verification for the rest. Sends nothing when nothing remains.
 */
export function verifyUnresolved(
  k: Kernel,
  account: AccountId,
  epoch: Epoch,
  unresolved: ReadonlySet<LeaseId>,
): Promise<"ran" | "in_flight"> {
  const runs = unresolvedRuns.get(k) ?? new Map<string, Promise<"ran">>();
  unresolvedRuns.set(k, runs);
  const key = `${account}|${epoch}`;
  // Single flight per page and account. A second call starts nothing, and it does not return at once either: it waits for
  // the running verification to END and then says `in_flight` (the run was not its own). Its caller holds an account for
  // the leases it knows of and must be able to look at what that run left unresolved, which it cannot do before the run
  // has finished; one that returned early was never told when to look, so its hold was never released.
  const running = runs.get(key);
  if (running) return running.then(() => "in_flight" as const);
  const run = (async (): Promise<"ran"> => {
    let attempt = 0;
    try {
      await convertOlderEpochLeases(k, account, unresolved);
      while (!k.disposed) {
        if (!k.ports.page.isOnline()) {
          await k.sleep(k.backoff(attempt));
          attempt += 1;
          continue;
        }
        const outcome = await readIdentity(k, account, epoch, {
          kind: "general",
          expectClear: false,
          onlyIfUnresolved: true,
        });
        if (outcome.kind === "ok") {
          await outcome.release;
          return "ran";
        }
        if (
          outcome.kind === "observation" ||
          outcome.kind === "nothing_to_resolve" ||
          outcome.kind === "stale" ||
          outcome.kind === "closed" ||
          outcome.kind === "not_sent"
        )
          return "ran";
        const elapsed = await k.sleep(k.backoff(attempt));
        attempt = elapsed ? attempt + 1 : 0;
      }
      return "ran";
    } finally {
      runs.delete(key);
    }
  })();
  runs.set(key, run);
  return run;
}

/** E5: add-only, no lock, no network. Recovery (WEB-09b) then clears the entry by rule 9. */
export async function convertOlderEpochLeases(
  k: Kernel,
  account: AccountId,
  ids: ReadonlySet<LeaseId>,
): Promise<void> {
  if (ids.size === 0) return;
  try {
    const transaction = k.ports.store.transact(
      (records) =>
        convertStale(records, {
          account_id: account,
          ids: [...ids],
          now: k.ports.clock.iso(),
        }),
      { durability: "strict", label: "convert_stale" },
    );
    const result = await k.withStall(
      transaction.complete,
      k.config.recordingStallMs,
    );
    if (result !== "stalled" && result.ids.length > 0) {
      k.ports.hints.post({ type: "auth_state_changed" });
      k.hooks.evaluate("converted");
    }
  } catch {
    // Add-only and repeatable: the next cover finds the lease again.
  }
}
