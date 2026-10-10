import type {
  AccountId,
  Epoch,
  ObservationKind,
  OperationId,
} from "../model/types";
import type { IssueStep } from "../ports/transport";
import { createActivity, retireLease } from "./activity";
import { type CoverOutcome, cover, waitForLocks } from "./cover";
import {
  classify403,
  cleanRelease,
  detectInvalidation,
  holdIdFor,
  type InFlight,
  recordAndHold,
  releaseHoldAndReevaluate,
  type SelfRevoking,
  surrenderLock,
} from "./observation";
import { combineSignals } from "./signals";
import type { ActivityImpl, Kernel } from "./state";
import { StampedRequestError } from "./types";

/**
 * The send loop (matrix 3.6.2 step 1, transcribed statement for statement). Its FIRST statement creates the
 * activity (lint rule R11); the TOP GUARD runs at the start of every iteration; the send boundary is
 * `IssueTransport.issue`, one synchronous function that the kernel reaches with an `IssueStep` whose `refuses()`
 * and `releaseIssueLock()` are closures over the activity. Nothing here reads display state (lint rule R12).
 */
export type RequestClass =
  | "ordinary"
  | "verification"
  | "operation"
  | "recovery";

export interface SendSpec<R> {
  klass: RequestClass;
  account: AccountId;
  epoch: Epoch;
  request: Request;
  identityRead?: boolean;
  selfRevoking?: SelfRevoking;
  callerSignal?: AbortSignal;
  /** An operation cover requires the operation fence of THIS envelope. */
  operationId?: OperationId;
  /**
   * Return a DEFER to the caller instead of waiting for the locks. The OBSERVE step runs under `atlas-auth` and must
   * never wait for a lease lock while holding it (matrix 3.4.2): it leaves, waits outside, and enters again.
   */
  returnDefer?: boolean;
  /**
   * Called synchronously when the cover has committed and before the boundary: true means "do not send" (a
   * verification with nothing left to resolve). The lease is retired exactly as a refused request's is.
   */
  skipIssue?(cover: { unresolved: ReadonlySet<string> }): boolean;
  /** The handler for the answer. It MUST begin with `surrenderLock` (R9). */
  onAnswer(k: Kernel, inflight: InFlight, response: Response): Promise<R>;
}

export type NotIssued =
  | "not_sent"
  | "stale"
  | "closed"
  | "closed_unresolved"
  | "not_covered";

export type SendOutcome<R> =
  | { kind: "answered"; value: R }
  /** The cover found another page's activity outstanding and the spec asked to be told (`returnDefer`). */
  | { kind: "defer"; ids: readonly string[] }
  /** The cover committed and the spec chose not to send; the lease was retired. */
  | { kind: "skipped"; unresolved: ReadonlySet<string> }
  /** Network error, time-out or abort: a CLEAN outcome; the lease is retired. */
  | { kind: "failed"; error: unknown }
  | { kind: NotIssued; cover?: CoverOutcome };

export async function send<R>(
  k: Kernel,
  spec: SendSpec<R>,
): Promise<SendOutcome<R>> {
  const activity = createActivity(
    k,
    "request",
    spec.klass,
    spec.account,
    spec.epoch,
  );
  const queued = spec.klass === "ordinary" || spec.klass === "recovery";
  const callerAborted = () => spec.callerSignal?.aborted === true;
  const onCallerAbort = () => activity.cancel("caller_abort");
  spec.callerSignal?.addEventListener("abort", onCallerAbort, { once: true });
  const giveUp = k.ports.clock.abortAfter(k.config.stampedRequestTimeoutMs);
  const csrfKey = k.memory.csrfKey(spec.account, spec.epoch);

  try {
    for (;;) {
      // The TOP GUARD: the start of EVERY iteration, so again after every DEFER wait. No other permission is consulted.
      if (
        activity.state === "CANCELLED" ||
        callerAborted() ||
        (queued && (k.memory.hasHold(spec.account) || k.memory.closing > 0))
      )
        return finish(k, activity, { kind: "not_sent" });

      if (spec.identityRead !== true && !k.memory.csrf.has(csrfKey)) {
        // This page's own token, from a leased verification (never from another page).
        const ok = await k.hooks.ensureCsrf(spec.account, spec.epoch);
        if (!ok) return finish(k, activity, { kind: "not_sent" });
        continue;
      }

      const c = await cover(k, activity, { operationId: spec.operationId });
      switch (c.kind) {
        case "CANCELLED":
          return finish(k, activity, { kind: "not_sent" });
        case "STALE":
          return finish(k, activity, { kind: "stale", cover: c });
        case "CLOSED":
          k.hooks.closeFromCover(spec.account, c);
          return finish(k, activity, { kind: "closed", cover: c });
        case "CLOSED_UNRESOLVED":
          k.hooks.closeFromCover(spec.account, c);
          if (k.ports.page.isOnline())
            k.hooks.verifyUnresolved(spec.account, spec.epoch, c.unresolved);
          return finish(k, activity, { kind: "closed_unresolved", cover: c });
        case "NOT_COVERED":
          return finish(k, activity, { kind: "not_covered", cover: c });
        case "DEFER": {
          if (spec.returnDefer)
            return finish(k, activity, { kind: "defer", ids: c.ids });
          const waited = await waitForLocks(k, activity, c.ids, giveUp);
          if (waited === "granted") continue;
          if (waited === "failed") {
            activity.cancel("cover_timeout");
            return finish(k, activity, { kind: "not_covered" });
          }
          activity.cancel(
            waited === "gave_up" ? "cover_timeout" : "caller_abort",
          );
          return finish(k, activity, { kind: "not_sent" });
        }
        case "COVERED": {
          // ---- THE SEND BOUNDARY (Ex5, Ex6): guard, issue and release of the issue lock are ONE synchronous step.
          const inflight: InFlight = {
            activity,
            lease: c.lease,
            account: spec.account,
            epoch: spec.epoch,
            klass: spec.klass,
            identityRead: spec.identityRead === true,
            selfRevoking: spec.selfRevoking ?? null,
            unresolved: c.unresolved,
            fenceSeq: c.fenceSeq,
          };
          if (spec.skipIssue?.(c)) {
            const held = activity.leaseHandle;
            activity.leaseHandle = null;
            const issue = activity.issueHandle;
            activity.issueHandle = null;
            issue?.release();
            void retireLease(k, c.lease, held);
            return finish(k, activity, {
              kind: "skipped",
              unresolved: c.unresolved,
            });
          }
          const step = boundaryStep(
            k,
            spec,
            activity,
            queued,
            csrfKey,
            callerAborted,
          );
          let pending: Promise<Response> | null;
          try {
            pending = k.ports.transport.issue(step);
          } catch (error) {
            // fetch threw synchronously: a clean network failure; the lease is deleted, never left unresolved.
            return failClean(k, inflight, error);
          }
          if (pending === null) {
            // retire_unused: the issue lock was released by the boundary; delete the lease THEN release its lock.
            const handle = activity.leaseHandle;
            activity.leaseHandle = null;
            void retireLease(k, c.lease, handle);
            k.emit("request.not_sent", { n: activity.n, lease: c.lease });
            return finish(k, activity, { kind: "not_sent" });
          }
          k.emit("request.issued", {
            n: activity.n,
            lease: c.lease,
            klass: spec.klass,
            account: spec.account,
            epoch: spec.epoch,
          });
          let response: Response;
          try {
            response = await pending;
          } catch (error) {
            return failClean(k, inflight, error);
          }
          const value = await spec.onAnswer(k, inflight, response);
          return finish(k, activity, { kind: "answered", value });
        }
      }
    }
  } finally {
    spec.callerSignal?.removeEventListener("abort", onCallerAbort);
  }
}

function boundaryStep<R>(
  k: Kernel,
  spec: SendSpec<R>,
  activity: ActivityImpl,
  queued: boolean,
  csrfKey: string,
  callerAborted: () => boolean,
): IssueStep {
  return {
    request: spec.request,
    identityRead: spec.identityRead === true,
    csrf:
      spec.identityRead === true ? null : (k.memory.csrf.get(csrfKey) ?? null),
    signal: combineSignals(
      k.ports.clock.abortAfter(k.config.stampedRequestTimeoutMs),
      spec.callerSignal,
    ),
    refuses: () =>
      activity.state === "CANCELLED" ||
      callerAborted() ||
      (queued && (k.memory.hasHold(spec.account) || k.memory.closing > 0)),
    markIssued: () => {
      activity.state = "ISSUED";
      k.memory.unregister(activity);
    },
    releaseIssueLock: () => {
      const handle = activity.issueHandle;
      activity.issueHandle = null;
      handle?.release();
    },
  };
}

/** A clean failure (network error, time-out, abort): the lease is deleted BEFORE its lock is released. */
function failClean<R>(
  k: Kernel,
  inflight: InFlight,
  error: unknown,
): SendOutcome<R> {
  const handle = inflight.activity.leaseHandle;
  inflight.activity.leaseHandle = null;
  void retireLease(k, inflight.lease, handle).then(() => {
    k.ports.hints.post({ type: "auth_state_changed" });
  });
  k.emit("request.failed", { n: inflight.activity.n, lease: inflight.lease });
  return finish(k, inflight.activity, { kind: "failed", error });
}

/** `finish(s, r)` ends a request's activity (matrix 3.6.2): ENDED unless already terminal, and forgotten by the page. */
function finish<R>(
  k: Kernel,
  activity: ActivityImpl,
  outcome: SendOutcome<R>,
): SendOutcome<R> {
  if (!activity.terminal) activity.state = "ENDED";
  k.memory.unregister(activity);
  return outcome;
}

// ---- the ordinary answer handler --------------------------------------------------------------------------------

export type OrdinaryAnswer =
  | { kind: "response"; response: Response }
  | { kind: "auth_state"; observation: ObservationKind };

/**
 * The handler for an ordinary or recovery request's answer. The surrender is the FIRST statement and the hold and
 * cancellation are the second (lint rule R9): nothing is awaited, read or stored before them.
 */
export async function handleOrdinaryAnswer(
  k: Kernel,
  inflight: InFlight,
  response: Response,
): Promise<OrdinaryAnswer> {
  const surrendered = surrenderLock(k, inflight, response.status);
  detectInvalidation(k, inflight, surrendered);
  if (!surrendered) {
    // A clean answer: delete the lease, then release its lock (E1).
    cleanRelease(k, inflight);
    return { kind: "response", response };
  }
  const holdId = holdIdFor(inflight.lease);
  const observe = (
    kind: ObservationKind,
    reason?: "password_changed" | "unlinked",
  ) => {
    void recordAndHold(k, {
      obs_id: k.ports.ids.uuid(),
      lease_id: inflight.lease,
      account: inflight.account,
      epoch: inflight.epoch,
      kind,
      reason,
      hold_id: holdId,
    });
  };
  if (response.status === 401) {
    observe("unauthenticated");
    return { kind: "auth_state", observation: "unauthenticated" };
  }
  if (response.status === 403) {
    const verdict = await classify403(response);
    if (verdict === "credential_mismatch") {
      observe("credential_mismatch");
      return { kind: "auth_state", observation: "credential_mismatch" };
    }
    // An ordinary refusal is NOT an observation: delete this request's lease, post on complete, clear the hold.
    cleanRelease(k, inflight);
    releaseHoldAndReevaluate(k, inflight.account, holdId);
    return { kind: "response", response };
  }
  // The 2xx of a self-revoking request (password change, OIDC unlink): the session just ended (O14).
  observe(
    "password_changed",
    inflight.selfRevoking === "unlink" ? "unlinked" : "password_changed",
  );
  return { kind: "response", response };
}

/**
 * Whether the identity a request was stamped with (account, epoch) is still the one THIS PAGE believes is settled. It reads
 * the page's own copy of the settled identity, which the page updates in the step that settles and on every read of the
 * record, so it is synchronous. It is a HINT about another page's transition, never the authority: a hint can be delayed,
 * queued behind a read or never delivered. It is used only for the cheap early exit that saves decoding a body nobody will
 * receive; the authority is `checkAtTheRecord`.
 */
export function stampIsStale(
  k: Kernel,
  account: AccountId,
  epoch: Epoch,
): boolean {
  const settled = k.memory.settled;
  return (
    settled === null || settled.account !== account || settled.epoch !== epoch
  );
}

/** What the release check found in the transaction that read the record (`checkAtTheRecord`). */
export type ReleaseVerdict =
  | { kind: "current"; n: number }
  | { kind: "moved"; durable: { account: AccountId; epoch: Epoch } | null }
  | { kind: "unreadable" };

/**
 * Where a validated answer goes. `caller`: the buffered Response of `fetchFor`, which its consumer decodes (that work is the
 * consumer's, and WEB-09a checks the stamp again inside its commit). `library`: the typed client's own `fetch`; the library
 * decodes the Response after it, so this is not yet the application's answer. `result`: what a public call hands the
 * application, validated AFTER the call's last decode (`sealResult`): the typed client's result and the public operations'.
 */
export type ReleaseTarget = "caller" | "library" | "result";

/**
 * The durable authority for "is this still the settled identity", and the ONLY place a verdict is taken: inside the body of
 * the store transaction that reads the record. The body runs once, synchronously, in the step that reads; this function
 * resolves `decided` from it, so the verdict is taken, and the answer released, in that one step and not at the later
 * delivery of the transaction's `complete` to a page that may be busy. Nothing can separate the read from the release:
 * IndexedDB runs transactions on the store in creation order (a write another page created later waits for this one to
 * finish, so it is ordered after the release and cannot commit between them), and this page's own settlement is such a
 * transaction too. A transition ordered BEFORE the read is seen by it; a transition ordered after it happens after the
 * answer was released. The body is created after every transaction already queued, so it sees their effects, and it neither
 * depends on a notice of another page's transition (which can be delayed or absent) nor on when its own completion arrives.
 *
 * The stamp was checked against the record when the request was covered; this is the same question asked where the answer
 * is HANDED BACK (G4: "its result is dropped if the identity has since changed"; matrix 3.7.2: a response arriving after a
 * transition is dropped).
 *
 * A record that cannot be read in time is not evidence. `open` is cleared when the page gives up, so a body that runs after
 * that releases nothing. `decoded` is the number of the decode a final check follows (`sealResult`), or null.
 */
export async function checkAtTheRecord(
  k: Kernel,
  account: AccountId,
  epoch: Epoch,
  decoded: number | null,
  /** The trace event of the check: a release is `response.check`; a persistence hold's is its own, so the two never pair up. */
  event: "response.check" | "persistence.check" = "response.check",
): Promise<ReleaseVerdict> {
  const n = ++k.memory.responseChecks;
  let open = true;
  let decide!: (verdict: ReleaseVerdict) => void;
  const decided = new Promise<ReleaseVerdict>((resolve) => {
    decide = resolve;
  });
  void k
    .transact(
      (records) => {
        if (open) {
          const settled = records.auth_state.settled;
          const durable = settled
            ? { account: settled.account_id, epoch: settled.epoch }
            : null;
          // THE RELEASE: the record and the page's copy are read and the verdict handed over in this one step.
          const current =
            durable !== null &&
            durable.account === account &&
            durable.epoch === epoch;
          decide(current ? { kind: "current", n } : { kind: "moved", durable });
          k.emit(event, {
            n,
            account,
            epoch,
            durable,
            current,
            decoded,
          });
        }
        return { write: null, result: null };
      },
      "response_check",
      false,
    )
    .catch(() => decide({ kind: "unreadable" }));
  try {
    const outcome = await k.withStall(decided, k.config.recordingStallMs);
    return outcome === "stalled" ? { kind: "unreadable" } : outcome;
  } finally {
    open = false;
  }
}

/**
 * Take the verdict at the record and either return (the identity is still the one the call was made under: the answer is
 * released) or throw `stale`. A record that names another identity makes this page re-read at once instead of waiting for a
 * notice; a record that cannot be read in time is `stale` too.
 */
async function confirmCurrent(
  k: Kernel,
  account: AccountId,
  epoch: Epoch,
  to: ReleaseTarget,
  decoded: number | null,
): Promise<void> {
  const verdict = await checkAtTheRecord(k, account, epoch, decoded);
  if (verdict.kind === "current") {
    k.emit("response.released", {
      n: verdict.n,
      account,
      epoch,
      to,
      decoded,
    });
    return;
  }
  if (verdict.kind === "unreadable") {
    void k.hooks.evaluate("response_unverified");
  } else {
    const local = k.memory.settled;
    const { durable } = verdict;
    if (
      durable === null
        ? local !== null
        : local === null ||
          local.account !== durable.account ||
          local.epoch !== durable.epoch
    )
      void k.hooks.evaluate("response_stale");
  }
  throw new StampedRequestError("stale");
}

const NULL_BODY_STATUSES = new Set([101, 204, 205, 304]);

export interface ReleaseOptions {
  /**
   * Read the body before the check (the default). A caller that decodes the body would otherwise do so after the answer was
   * released, across a transition. A caller that needs only the status sets this to false and the body is discarded.
   */
  readBody?: boolean;
  /** Where the answer goes (default `caller`); the typed client's own `fetch` passes `library`. */
  to?: "caller" | "library";
}

/**
 * Hand a clean answer to its caller only if the stamp is still current, judged against the durable record in the step that
 * releases it. The body is read here, inside the stamped call, because reading it is asynchronous: a transition that
 * completes while it runs would otherwise be applied by the caller under the new identity. The record is then read and the
 * verdict taken in one step (`checkAtTheRecord`), after the last asynchronous step the answer needs, and the caller receives
 * a complete, already-read response, so nothing between the check and its use is asynchronous except the caller's own work.
 *
 * That holds for a caller that uses the Response as it is (`fetchFor`), whose own decode and persistence are its work: the
 * persistence consumer checks the stamp again inside its own atomic commit (docs/session.md). It does NOT hold for a public
 * call that decodes the Response itself, because decoding a buffered body is still asynchronous (a fetch task): the typed
 * client and the public operations therefore validate AGAIN, after their last decode, with `sealResult`; this check then
 * only spares them decoding an answer nobody will receive.
 *
 * A record that cannot be read in time, or that names another identity, is `stale`; when it differs from this page's copy the
 * page re-reads at once instead of waiting for a notice. Every clean answer a caller receives from a stamped request passes
 * here: the typed client and the public operations alike.
 */
export async function releaseResponse(
  k: Kernel,
  account: AccountId,
  epoch: Epoch,
  response: Response,
  options: ReleaseOptions = {},
): Promise<Response> {
  // A change this page already knows of saves decoding a body nobody will receive.
  if (stampIsStale(k, account, epoch)) {
    void response.body?.cancel().catch(() => undefined);
    throw new StampedRequestError("stale");
  }
  let body: ArrayBuffer | null = null;
  if (options.readBody === false)
    void response.body?.cancel().catch(() => undefined);
  else body = await response.arrayBuffer();
  const released = new Response(
    body === null || NULL_BODY_STATUSES.has(response.status) ? null : body,
    {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    },
  );
  await confirmCurrent(k, account, epoch, options.to ?? "caller", null);
  return released;
}

/**
 * The FINAL validation of a public call. `pending` is the call's last asynchronous step: for the typed client the library's
 * own decode of the Response it was handed (`response.json()` is a promise, and its processing is queued as a fetch task even
 * for a body that is already in memory), for the public operations their decode of the released Response. The identity is
 * read at the record only AFTER it, in the step that decides, and the result goes back to the caller with nothing between
 * the verdict and the caller's promise but microtasks, so no other page's write, notice or completion can be ordered
 * between them. A transition ordered before that read is `stale`; one ordered after it happens after the result was handed
 * back. `decoded` and the paired trace events let property V7 check the order.
 *
 * A call that rejects (a network error, a protocol error from the stamped fetch) is passed on untouched: it carries no
 * payload of an identity.
 */
export async function sealResult<T>(
  k: Kernel,
  account: AccountId,
  epoch: Epoch,
  pending: Promise<T> | T,
): Promise<T> {
  const result = await pending;
  const decoded = ++k.memory.decodes;
  k.emit("response.decoded", { d: decoded, account, epoch });
  // A change this page already knows of needs no read: the copy is only ever assigned after a durable commit or a read.
  if (stampIsStale(k, account, epoch)) throw new StampedRequestError("stale");
  await confirmCurrent(k, account, epoch, "result", decoded);
  return result;
}

/** The stamped `fetch`: a Response, or a StampedRequestError from the closed set of protocol outcomes (D-06). */
export function createStampedFetch(
  k: Kernel,
  klass: "ordinary" | "recovery",
  account: AccountId,
  epoch: Epoch,
  to: "caller" | "library" = "caller",
): (request: Request) => Promise<Response> {
  return async (request) => {
    const outcome = await send<OrdinaryAnswer>(k, {
      klass,
      account,
      epoch,
      request,
      callerSignal: request.signal,
      onAnswer: handleOrdinaryAnswer,
    });
    switch (outcome.kind) {
      case "answered": {
        const { value } = outcome;
        // The answer was handled first (surrender, hold, lease retirement, recording: those are stamp-checked where they
        // commit). What the CALLER receives is dropped if the identity has changed since. A successful answer carries a
        // payload, so it is released only against the record (`releaseResponse`). An invalidating answer hands back nothing:
        // its hold is already set and its recording is stamp-checked where it commits (a stale one is discarded there, and
        // fences neither account), so it is classified by the page's own copy, which keeps the caller's pause prompt even
        // when the record is slow or stuck behind another transaction.
        if (value.kind !== "response") {
          if (stampIsStale(k, account, epoch))
            throw new StampedRequestError("stale");
          throw new StampedRequestError("auth_state", {
            observation: value.observation,
          });
        }
        return releaseResponse(k, account, epoch, value.response, { to });
      }
      case "failed":
        throw outcome.error;
      case "skipped":
      case "defer":
        throw new StampedRequestError("not_sent");
      default:
        throw new StampedRequestError(outcome.kind);
    }
  };
}
