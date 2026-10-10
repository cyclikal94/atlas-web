import type { CapabilityIssue } from "../app/capabilities";
import type { createApiClient } from "../lib/api-client";
import type { AtlasError } from "../lib/api-client/problem";
import type { StampedFailure } from "./kernel/types";
import type { NeutralStateId } from "./model/neutral-state";
import type {
  AccountId,
  AttemptMethod,
  DeviceId,
  DeviceSummary,
  Epoch,
  IsoInstant,
  OperationId,
  Seq,
  SessionId,
} from "./model/types";
import type {
  ApiCompatibility,
  ConsentTicket,
  Identity,
  SessionView,
} from "./model/view";
import type { LocalWorkSummary } from "./ports/deletion";

export { StampedRequestError } from "./kernel/types";
/** The public types of the session module (plan section 6). Nothing here is implementation. */
export type {
  ApiCompatibility,
  CapabilityIssue,
  ConsentTicket,
  Identity,
  LocalWorkSummary,
  NeutralStateId,
  SessionView,
  StampedFailure,
};

export interface Store<T> {
  get(): T;
  subscribe(listener: () => void): () => void;
}

// ---- the stamped wrapper (decision D-06) --------------------------------------------------------------------------
export type RequestClass = "ordinary" | "recovery"; // verification and operation are internal
export type StampedFetch = (request: Request) => Promise<Response>;
export interface StampedApi {
  /**
   * Every call is one request with its own activity, lease and (ordinary and recovery) issue lock. It resolves to a
   * Response, or throws StampedRequestError from a closed set. Network errors, aborts and time-outs rethrow as the
   * platform's own error.
   */
  /**
   * The typed client. Each call resolves with its result, decoded, only if the durable record still names `account` and
   * `epoch` AFTER that decode (the client library decodes the Response after the stamped fetch returns it, and that is
   * asynchronous); otherwise it rejects with `StampedRequestError("stale")`. A caller that asks for `parseAs: "stream"`
   * reads the body itself, after the call.
   */
  client(
    klass: RequestClass,
    account: AccountId,
    epoch: Epoch,
  ): ReturnType<typeof createApiClient>;
  /**
   * A stamped `fetch`: the Response it returns has been read in full and was validated against the record when it was
   * handed back. Decoding it (`json()` is asynchronous) is the caller's work, so a caller that applies the decoded value
   * checks the stamp again inside its own atomic commit (docs/session.md, obligation 4).
   */
  fetchFor(klass: RequestClass, account: AccountId, epoch: Epoch): StampedFetch;
  /**
   * WEB-09b: the FINAL validation of a caller's own interpretation of `fetchFor` responses (its decode, parse and any further
   * asynchronous work), the same check the typed client applies after its decode. `pending` is the caller's whole result; the record is
   * read only after it has settled, in the step that decides, and the result is handed back with nothing asynchronous in between. It
   * rejects with `StampedRequestError("stale")` when the durable record no longer names `account` and `epoch`, cannot be read in time,
   * or the session was disposed meanwhile; a rejected `pending` is passed on untouched.
   */
  seal<T>(
    account: AccountId,
    epoch: Epoch,
    pending: Promise<T> | T,
  ): Promise<T>;
  /**
   * WEB-09b: a READ of what decides whether a request of `klass` for (account, epoch) would be admitted now, for a caller whose request
   * was refused before it was sent and that waits for that to change. `revision` is opaque (a digest of the settled stamp, a gating
   * attempt, the account's fences, the other pages' request leases, and this page's hold, closing write and CSRF token); `blocked` says
   * whether one of them refuses the request now. A hint, never a permission: the cover still decides. Null when the record cannot be
   * read in time. It writes nothing, takes no lease and waits for no lock.
   */
  admission(
    klass: RequestClass,
    account: AccountId,
    epoch: Epoch,
  ): Promise<RequestAdmission | null>;
}

/** The answer of `StampedApi.admission`. */
export interface RequestAdmission {
  readonly revision: string;
  readonly blocked: boolean;
}

// ---- attempts (WEB-08b builds registration and OIDC on this; the password method is delivered here) -----------------
export type BeginResult =
  | { kind: "started"; handle: AttemptHandle }
  /** A gating attempt exists: it is resolved first (offline: state 1c's offline variant). */
  | { kind: "resolving" }
  /** Waited 20 s for atlas-auth: "Another tab is finishing a sign-in. Try again." */
  | { kind: "lock_timeout" }
  | { kind: "storage_unavailable" };
export interface AttemptHandle {
  readonly epoch: Epoch;
  readonly method: AttemptMethod;
  /** Never the verifier. */
  readonly challenge: string;
}
export type ExchangeResult =
  | {
      kind: "grant";
      grant: string;
      grant_expires_at: IsoInstant;
      account_id: AccountId;
    }
  | { kind: "error"; error: AtlasError | null; status: number }
  | { kind: "network_failure" };
export type AttemptOutcome =
  /** `method` is the attempt's own (K-2): a page that completes an `oidc_link` landing can tell the person that linking worked. */
  | {
      kind: "settled";
      account_id: AccountId;
      epoch: Epoch;
      method: AttemptMethod;
    }
  /**
   * An Atlas 4xx or 503 device_capacity: definitive. `stage` says which request was refused (K-3): `exchange` (login,
   * registration; nothing was activated) or `activation` (the grant was good and the account exists, but `activate` was
   * refused: for a registration the invitation is spent and the person signs in with the credentials they chose).
   */
  | {
      kind: "refused";
      error: AtlasError;
      definitive: true;
      stage: "exchange" | "activation";
    }
  /** The exchange (login, registration) failed before any activation: nothing was sent that could set a cookie. */
  | { kind: "exchange_failed"; status: number | null }
  /** Discarded silently: the epoch is no longer the latest. */
  | { kind: "superseded" }
  /** indeterminate or verifying: resolution continues. */
  | { kind: "gating" }
  | {
      kind: "not_started";
      reason:
        | "hidden"
        | "lock_timeout"
        | "closing_write_gave_up"
        | "attempt_gone"
        | "wipe_pending";
    };
/** What the person typed on the join form. Never logged, never stored; the token comes from the join link's fragment. */
export interface RegistrationInput {
  /** 64 lower-case hexadecimal characters. */
  readonly token: string;
  /** 1 to 100 characters of `[a-z0-9_.-]`. */
  readonly username: string;
  /** 12 to 1,024 BYTES. */
  readonly password: string;
}

export type InvitationPreview =
  | {
      kind: "ok";
      /** Null for a standalone invitation. The preview names no inviter and no member count. */
      household: { id: string; name: string } | null;
      expires_at: IsoInstant;
    }
  /** `401 unauthenticated`: unknown, expired, already used or revoked. The server does not say which. */
  | { kind: "unavailable" }
  /** Any other Atlas error: 403, 404 (browser sessions not configured), 422, 429, 5xx with an Atlas body. */
  | { kind: "refused"; error: AtlasError; status: number }
  /** No answer, a time-out, or an answer that is not an Atlas body. */
  | { kind: "network_failure" };

export type OidcStartOutcome =
  /** The attempt is durably `redirected` (verifier stored, owner lock released). The caller navigates at once. */
  | { kind: "redirect"; authorization_url: string }
  /** A definitive Atlas error: 401, 403, 404 (not configured), 422, 429, 502 `oidc_unavailable`. */
  | { kind: "refused"; error: AtlasError; status: number }
  /** A network failure, a non-Atlas body, or a malformed or unsafe 200. */
  | { kind: "exchange_failed"; status: number | null }
  /** A newer attempt exists: do not navigate. */
  | { kind: "superseded" }
  /**
   * Only for `oidc_link`, which is an ordinary stamped request: the session it needs has ended (a `401` is an OBSERVATION, never
   * a refusal of the link) or moved on. The neutral state takes over; there is nothing for the form to say.
   */
  | { kind: "session_ended" }
  | { kind: "not_started"; reason: "attempt_gone" | "not_settled" };

export interface Attempts {
  begin(method: AttemptMethod): Promise<BeginResult>;
  /** Password path: runs step 2 (exchange) then continues to steps 3 to 5. Never returns the password or verifier. */
  signInWithPassword(
    handle: AttemptHandle,
    credentials: { username: string; password: string },
  ): Promise<AttemptOutcome>;
  /**
   * `POST /registration/preview`. Not an attempt: no epoch, no lock, no record, and safe while anyone is signed in. The token
   * goes in the request BODY and nowhere in a URL.
   */
  previewInvitation(
    token: string,
    signal?: AbortSignal,
  ): Promise<InvitationPreview>;
  /**
   * Step 2 for method "registration": the exchange, then steps 3 to 5 as for a password grant. The browser's `device_id`
   * never leaves the kernel. Throws a TypeError when `handle.method` is not "registration".
   */
  registerWithInvitation(
    handle: AttemptHandle,
    input: RegistrationInput,
  ): Promise<AttemptOutcome>;
  /**
   * Step 2 for "oidc" and "oidc_link": `POST /oidc/start`, then the attempt is durably `redirected` and its owner lock
   * released BEFORE this returns `redirect`; the caller then navigates at once. Throws a TypeError for any other method.
   *
   * `oidc` is a login-family exchange (no session, no stamp). `oidc_link` is authenticated by the settled session's cookie and so
   * carries its CSRF token: it is sent as an ORDINARY stamped request, with the cover, the lease and the identity checks of any
   * other, and a `401` is an observation that fails closed like a password change's (the released backend answers it when the
   * session is older than five minutes).
   */
  startOidc(handle: AttemptHandle): Promise<OidcStartOutcome>;
  /** Feed a result the caller obtained itself. Registration and OIDC start have their own methods above. */
  completeExchange(
    handle: AttemptHandle,
    result: ExchangeResult,
  ): Promise<AttemptOutcome>;
  /** OIDC: phase `redirected`, releases atlas-attempt-<epoch>. */
  markRedirected(handle: AttemptHandle): Promise<void>;
  /** A stale grant is discarded with no effect. */
  landing(fragment: {
    grant: string;
    attempt: string;
    account: string;
  }): Promise<AttemptOutcome>;
  /** The person cancelled before activation; only for non-gating phases. */
  cancel(handle: AttemptHandle): Promise<void>;
}

// ---- operations --------------------------------------------------------------------------------------------------
export interface SessionSummary {
  id: SessionId;
  device_id: DeviceId;
  created_at: IsoInstant;
  expires_at: IsoInstant;
  authentication: "local" | "oidc";
  current: boolean;
}
export interface DeviceRow {
  id: DeviceId;
  last_synced_at: IsoInstant | null;
  active_sessions: number;
  current: boolean;
  state_token: string;
  summary: DeviceSummary;
}
export interface DevicesRead {
  devices: readonly DeviceRow[];
}
export type OperationStart =
  | { kind: "started"; operation_id: OperationId }
  /** The recount at confirmation differs from what the person saw (D-18); nothing is fenced. */
  | { kind: "reconfirm"; unsynced: LocalWorkSummary }
  | {
      kind: "refused";
      reason:
        | "operation_pending"
        | "not_settled"
        | "attempt_gating"
        | "no_current_device"
        | "offline"
        | "fence_exists"
        | "closing_write_gave_up"
        | "storage_unavailable";
    };
export type Result<T> =
  | { ok: true; value: T }
  | {
      ok: false;
      error: "offline" | "auth_state" | "not_sent" | "closed" | "http";
      status?: number;
      atlasError?: AtlasError;
    };
/** `GET /me`: the contract's own fields and nothing else (no display name, no link date). */
export interface AccountSummary {
  readonly id: AccountId;
  readonly username: string;
  readonly has_password: boolean;
  readonly oidc_issuers: readonly string[];
}
export interface Operations {
  /**
   * How many unsynced changes and recovery copies this browser holds for the settled account, as the confirmation dialog
   * shows them (a count, and a digest that `logout` and `retireThisDevice` recheck). Null when nobody is settled.
   * WEB-09a supplies the real port; until then the default reports none.
   */
  summariseLocalWork(): Promise<LocalWorkSummary | null>;
  readDevices(): Promise<Result<DevicesRead>>;
  listSessions(): Promise<Result<{ sessions: readonly SessionSummary[] }>>;
  /** An ordinary DELETE without a key; refuses `settled.session_id` (use `logout`). */
  revokeOtherSession(id: SessionId): Promise<Result<"revoked" | "gone">>;
  retireOtherDevice(
    read: DeviceRow,
  ): Promise<Result<"confirmed_applied" | "superseded" | "rejected_stale">>;
  /** Both raise the fence and envelope in ONE closing-write transaction, then send. The person has confirmed. */
  logout(confirmation: { unsynced: LocalWorkSummary }): Promise<OperationStart>;
  retireThisDevice(confirmation: {
    read: DeviceRow;
    unsynced: LocalWorkSummary;
  }): Promise<OperationStart>;
  changePassword(input: {
    current: string;
    next: string;
  }): Promise<Result<"changed">>;
  /**
   * An ordinary GET `/me`, sealed like `listSessions`: nothing is returned for an identity that is no longer settled.
   * Never cached by this module.
   */
  readAccount(): Promise<Result<AccountSummary>>;
  /** `DELETE /oidc/identities` with the body `{ issuer }` the contract requires; the issuer is taken verbatim from `readAccount`. */
  unlinkOidc(issuer: string): Promise<Result<"unlinked">>;
  /** Re-drives every operation fence: at boot, on online, on becoming visible, after a settlement. */
  resume(options?: { force?: boolean }): void;
  readonly pending: Store<
    readonly {
      account_id: AccountId;
      op: "logout" | "retire_device";
      operation_id: OperationId;
    }[]
  >;
}

// ---- recovery (WEB-09b) ------------------------------------------------------------------------------------------
export interface RecoveryHandle {
  readonly account: AccountId;
  readonly epoch: Epoch;
  readonly s: Seq;
}
export type RecoveryBegin =
  | { kind: "eligible"; handle: RecoveryHandle }
  | {
      kind: "ineligible";
      reason:
        | "no_fence"
        | "operation_pending"
        | "credential_unverified"
        | "current_epoch_entry"
        | "attempt_gating"
        | "unresolved_lease"
        | "stale"
        | "offline";
    };
export interface Recovery {
  begin(account: AccountId): Promise<RecoveryBegin>;
  finish(
    handle: RecoveryHandle,
  ): Promise<
    | "cleared"
    | "not_eligible"
    | "rerun"
    | "superseded"
    | "lock_timeout"
    | "failed"
  >;
  /** WEB-09b reports the job's phase so the neutral states 2 and 3 can show; it changes no protection. */
  report(phase: "catching_up" | "failed" | null): void;
  /**
   * WEB-09b: the person pressed the neutral state's "Try again" (`actions.retry`). The sync leader of the page listens, so that state 3
   * ("Couldn't finish catching up") reaches the recovery job that owns the attempt (on this page, or the leading page through
   * `atlas-sync`). It is a request, never a permission: it changes no protection, and the job's own checks decide what it resets.
   */
  onRetry(listener: () => void): () => void;
}

// ---- the canonical deletion procedure (WEB-04 7.8) -----------------------------------------------------------------
export type WipeOutcome =
  | { kind: "deleted" }
  | { kind: "absent" }
  | { kind: "superseded_incarnation" }
  | { kind: "awaiting_consent"; count: number }
  /** The prompt the choice was made on is no longer the current one (resolved, replaced or changed): nothing was applied. */
  | { kind: "prompt_superseded" }
  | {
      kind: "retry_later";
      /**
       * `closing_unconfirmed`: the durable closing flag could not be set (after the bounded attempts), so nothing was deleted and
       * no digest was read. The entry, the fence and the work stay; the next entry repeats step 3a and recomputes the population.
       */
      reason:
        | "delete_error"
        | "blocked"
        | "adapter_missing"
        | "closing_unconfirmed";
    };
export interface Wipe {
  /** Runs the canonical procedure inside atlas-delete:<account>. Re-enterable at step 0; idempotent. */
  run(account: AccountId, operationId: OperationId): Promise<WipeOutcome>;
  /**
   * The person's answer to the renewed-consent prompt they were shown, named by the ticket in the view. It is applied only
   * while that prompt is still the page's current one and its ledger entry is unchanged (same account, same operation, same
   * consent digest); otherwise nothing is applied, the prompt is re-derived and `prompt_superseded` is returned.
   */
  resolveConsent(
    ticket: ConsentTicket,
    choice: "delete" | "keep",
  ): Promise<WipeOutcome>;
  /** Boot: re-enter every outstanding ledger entry. */
  recoverPending(): Promise<void>;
}

/** A fact the person should be told, once (the UI shows it and dismisses it). Carries no account data. */
export type SessionNotice = {
  id: string;
  /** A logout or retirement was confirmed applied while the person had signed in again to recover: still signed in. */
  kind: "remained_signed_in";
};

/**
 * Ordering of a persistence commit against the session's own settlements (revision 5 of docs/session.md, obligation 4). The
 * consumer that persists a response, a receipt or a page asks `hold(account, epoch)`, persists ONLY on `held`, and releases when its
 * transaction has completed. See `kernel/persistence.ts` for the protocol and its limits.
 */
export interface Persistence {
  hold(account: AccountId, epoch: Epoch): Promise<PersistenceHold>;
}

import type { PersistenceHold } from "./kernel/persistence";

export type { PersistenceHold };

export interface Session {
  readonly bootId: string;
  readonly notices: Store<readonly SessionNotice[]>;
  dismissNotice(id: string): void;
  start(options?: { beforeStart?: () => void }): Promise<void>;
  /** Tests and HMR only. */
  dispose(): void;
  readonly view: Store<SessionView>;
  readonly identity: Store<Identity | null>;
  readonly api: StampedApi;
  readonly attempts: Attempts;
  readonly operations: Operations;
  readonly recovery: Recovery;
  readonly wipe: Wipe;
  readonly compat: Store<ApiCompatibility>;
  /** Actions the neutral states offer. */
  readonly actions: NeutralActions;
  /** The persistence hold: orders a commit in an account's own database against every settlement of the session record. */
  readonly persistence: Persistence;
}

export interface NeutralActions {
  /** Ask the composition root to lead to a sign-in surface (WEB-08b); until then it explains that none exists yet. */
  signIn(): void;
  /** Re-run whatever the state is waiting on (a user retry resets the back-off). */
  retry(): void;
  reload(): void;
  reviewDevice(): void;
  /** The choice on the renewed-consent prompt; `ticket` is the one the view carried with that prompt. */
  consent(choice: "delete" | "keep", ticket: ConsentTicket): void;
}
