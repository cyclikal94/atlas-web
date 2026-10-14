import {
  type Identity,
  type Recovery,
  type RecoveryBegin,
  type RecoveryHandle,
  type RequestAdmission,
  type SessionView,
  type StampedFetch,
  StampedRequestError,
  type Store,
  type Trace,
} from "../../session";
import { DATA_CONFIG, maxResponseBytesFor } from "../model/config";
import type { BlockedBy, BudgetEvent } from "../model/recovery";
import { isFailureStatus, nextDelay } from "../model/retry";
import {
  type DeviceSignals,
  isAllocationError,
  type SizingOutcome,
} from "../model/sizing";
import type { AccountId, Captured } from "../model/types";
import { commitPage } from "../plans/commit-page";
import {
  activateSnapshot,
  captureRecoveryRequest,
  commitStagingPage,
  RECOVERY_BUDGET_OPERATION,
  RECOVERY_CAPTURE_OPERATION,
  type RecoveryCapture,
  type RecoveryPath,
  reconcileOwedReceipts,
  recordRecoveryOutcome,
  resetRecoveryBudget,
} from "../plans/recovery-writers";
import {
  recordLocalWriteOutcome,
  recordReadOutcome,
  resumeReadCaller,
  resumeReadCallerOnOnline,
} from "../plans/retry-state";
import {
  recordSizingAttempt,
  recordSizingOutcome,
  resetSizingFloor,
  retireSizingAttempt,
} from "../plans/sync-writers";
import { type ScanResult, scanSyncPage } from "../scan/scan";
import type { DecodeDeps } from "../scan/validate";
import { isAllocationFailure } from "../store/failure";
import { isStoreFailure, type StoreFailure } from "../store/port";
import type { AccountService, CommitOutcome } from "./account-service";
import type { QuotaGuard } from "./quota-guard";
import type { RecoveryReason, RecoverySeam } from "./recovery-seam";
import type { SyncChannel } from "./sync-channel";
import type { StopCause, SyncOwnership } from "./sync-engine";
import {
  type MarkerSeen,
  markerStateOf,
  recordStop,
  type WriteFailureMarkers,
} from "./write-failure-marker";

/**
 * WEB-09b's recovery job (plan P-8; account-lifecycle matrix 3.7.3; WEB-04 design 4.1 to 4.4, 5.11, 5.12): the `RecoverySeam` that
 * WEB-09a's engine asks after an invalidation, and the job that runs while an account is FENCED to bring its cache back.
 *
 * It has TWO MODES over one implementation:
 *  - ORDINARY: the account is displayed and its cache needs a snapshot (a fresh database, an invalidation by `410`/`400`/`422`, a
 *    deleted cache). The snapshot is staged and activated while the cache stays hidden through `cache_status`; requests are ordinary.
 *  - RECOVERY (matrix 3.7.3): the account is fenced after a re-authentication. Only after `session.recovery.begin` says `eligible`, with
 *    recovery-class requests: a catch-up from a valid saved cursor (W1 in recovery mode), else a replacement snapshot; the DATA COMMIT,
 *    then `finish`. Display is decided afterwards by the session's ordinary exposure: the job never mounts or permits anything.
 *
 * It sends only read-only `GET /sync`. It touches no unsent draft, `pending_effects` row of one, or the outbox, and replays nothing (P-7).
 * While it needs the cache the engine is stopped (`exclusive`), so one request is in flight. Its retry budgets are the three
 * recovery-scoped classes (W24, W25), and it CONSUMES WEB-09a's shared mechanisms: the `sync` read caller's back-off, the local-write
 * streaks and their markers, the sizing ladder and the quota guard (P-10).
 */
export type RecoveryMode = "ordinary" | "recovery";
export type RecoveryTrigger =
  | "first_snapshot"
  | RecoveryReason
  | "deleted_cache"
  | "reauthenticated"
  | "adopted";

export type RecoveryJobState =
  | { kind: "idle" }
  /** Recovery mode: `begin` refused, so no request is sent. */
  | {
      kind: "eligible_wait";
      reason: Exclude<RecoveryBegin, { kind: "eligible" }>["reason"];
    }
  /**
   * A request was refused by the session before it was sent (the cover closed, or the page's hold or closing write outlasted the
   * immediate retries): the job waits for what admits it to change (R3 of the review of 10 October 2026, second cycle).
   */
  | { kind: "admission_wait"; mode: RecoveryMode }
  | { kind: "running"; mode: RecoveryMode; path: RecoveryPath }
  | { kind: "backing_off"; mode: RecoveryMode; since: number }
  /** The `sync` read caller is paused after a sustained failure (state 3 in recovery mode). */
  | { kind: "paused"; mode: RecoveryMode; since: number }
  /** The data commit is done; `finish` is pending or being retried. */
  | { kind: "finishing" }
  | {
      kind: "stopped";
      cause: StopCause | "sync_blocked";
      memoryOnly?: true;
      blocked?: Exclude<BlockedBy, null>;
    };

/** The person's dismissible notice of an automatic restart the server instructed (Q24): per generation, page memory only. */
export interface ResyncNotice {
  readonly reason: "resync_required" | "access_changed";
  readonly id: string;
}

export interface RecoveryJob extends RecoverySeam {
  readonly state: Store<RecoveryJobState>;
  /** True while the job needs the cache to itself: the engine is stopped meanwhile (P-8, the leader's mutual exclusion). */
  readonly exclusive: Store<boolean>;
  /** The Q24 notice, or null. `acknowledge` only dismisses it. */
  readonly notice: Store<ResyncNotice | null>;
  acknowledge(id: string): void;
  /** The leader binds the job to one service and ownership; a new binding supersedes the old one (its answers are discarded). */
  bind(
    binding: { service: AccountService; ownership: SyncOwnership } | null,
  ): void;
  /** "Try again" / "Retry applying changes" / "Retry now". */
  retryNow(): void;
  /** Resolves once the job has nothing scheduled now (tests). */
  settled(): Promise<void>;
}

export interface RecoveryJobDeps {
  identity: Store<Identity | null>;
  /** The session's view: a displayed account is ordinary mode; a fenced one asks `recovery.begin`. */
  view: Store<SessionView>;
  /** `session.api.fetchFor(klass, account, epoch)`. */
  fetchFor(
    klass: "ordinary" | "recovery",
    account: AccountId,
    epoch: number,
  ): StampedFetch;
  recovery: Pick<Recovery, "begin" | "finish" | "report">;
  /**
   * `session.api.admission(klass, account, epoch)`: a READ of what admits a request (an opaque revision, and whether a blocker stands
   * now). The job's admission waits compare it; it is never a permission.
   */
  admission(
    klass: "ordinary" | "recovery",
    account: AccountId,
    epoch: number,
  ): Promise<RequestAdmission | null>;
  apiUrl(path: string): URL;
  online(): boolean;
  /** Fires when eligibility may have changed (the session view, the identity, visibility). */
  subscribe(listener: () => void): () => void;
  onOnline(listener: () => void): () => void;
  clock: {
    now(): number;
    iso(): string;
    random(): number;
    setTimeout(fn: () => void, ms: number): unknown;
    clearTimeout(handle: unknown): void;
  };
  yield(): Promise<void>;
  decode: DecodeDeps;
  quota: QuotaGuard;
  signals: DeviceSignals;
  channel?: SyncChannel;
  /** The PAGE's markers (R46: every writer of a page shares one object). */
  markers?: WriteFailureMarkers;
  trace?: Trace;
  ids: { uuid(): string };
  elapsed?: () => number;
  config?: Partial<typeof DATA_CONFIG>;
}

class Cell<T> implements Store<T> {
  private listeners = new Set<() => void>();
  constructor(
    private value: T,
    private readonly same: (a: T, b: T) => boolean = Object.is,
  ) {}
  get(): T {
    return this.value;
  }
  set(next: T): void {
    if (this.same(this.value, next)) return;
    this.value = next;
    for (const listener of [...this.listeners]) listener();
  }
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}

type Next = { when: "now" } | { when: "after"; ms: number } | { when: "event" };

interface Binding {
  readonly id: number;
  readonly service: AccountService;
  readonly ownership: SyncOwnership;
}

/** What one request of a step was made for. */
interface Issued {
  readonly binding: Binding;
  readonly mode: RecoveryMode;
  readonly path: RecoveryPath;
  readonly capture: Extract<RecoveryCapture, { kind: "captured" }>;
  readonly captured: Captured;
  readonly epoch: number;
  /** Recovery mode: the handle of the fenced run this request was issued under (rule 9's `s`); its data commit is what `finish` releases. */
  readonly handle: RecoveryHandle | null;
  /** The markers the gate saw of the page's operations (R51). */
  readonly saw: ReadonlyMap<string, MarkerSeen>;
  /** This request holds the one attempt a page load (or "Try again") permits while blocked, returned if nothing is sent. */
  permit: boolean;
}

/**
 * One episode of refusals before a request was sent (R3 of the review of 10 October 2026, second cycle), for one binding, mode and
 * epoch. `revision` is the session's admission revision last seen; `consumed` says that the one attempt an unblocked, unchanged revision
 * permits has been made, so a refusal that the revision does not show cannot make the job ask again and again.
 */
interface AdmissionEpisode {
  readonly binding: number;
  readonly mode: RecoveryMode;
  readonly epoch: number;
  cause: "begin" | "closed" | "not_sent";
  revision: string | null;
  consumed: boolean;
  /** Read-only probes made since the revision last changed: they pace the reconciliation for a notification that never came. */
  probes: number;
  /**
   * An OPEN, unchanged revision whose attempt was refused anyway (a refusal the probe cannot show: a token that only a new verification
   * can fetch, a hold that came and went) is tried again on a paced, TIME-based back-off (`retryAt`; notifications cannot hasten it).
   */
  retries: number;
  retryAt: number | null;
}

const sameJson = <T>(a: T, b: T): boolean =>
  JSON.stringify(a) === JSON.stringify(b);

export function createRecoveryJob(deps: RecoveryJobDeps): RecoveryJob {
  const config = { ...DATA_CONFIG, ...deps.config };
  const state = new Cell<RecoveryJobState>({ kind: "idle" }, sameJson);
  const exclusive = new Cell<boolean>(false);
  const active = new Cell<boolean>(false);
  const notice = new Cell<ResyncNotice | null>(null, sameJson);
  const setState = (next: RecoveryJobState): void => {
    state.set(next);
    active.set(
      next.kind === "running" ||
        next.kind === "backing_off" ||
        next.kind === "finishing",
    );
  };

  let binding: Binding | null = null;
  let bindings = 0;
  let busy = false;
  let woken = false;
  let timer: unknown = null;
  let waiters: Array<() => void> = [];
  let offs: Array<() => void> = [];
  /** The recovery handle of the current fenced run (rule 9: `s` captured before the first request), or null. */
  let handle: RecoveryHandle | null = null;
  /** Recovery mode reported a phase to the session; `null` is reported when it ends. */
  let reported: "catching_up" | "failed" | null = null;
  /** The phase and the (account, epoch) of the last report (WEB-08c revision 4: a report is scoped; the same phase of another epoch is news). */
  let reportedKey: string | null = null;
  /**
   * WEB-08c revision 4 (DA-N1 of the design assessment of 14 October 2026; WEB08C-T24D-QUOTA-20261014): a recovery-mode QUOTA stop of
   * this binding at this epoch. Only the person's "Try again" (or a new binding, identity or epoch) ends it: a wake, `online`, a hint or a
   * status question never re-enters the job while it stands. The failed page's own stop is ALSO recorded in the account's write-failure
   * marker (`quotaStop`), so a reload or another page's takeover finds it at the capture gate; a marker that cannot be written leaves a
   * stop held in this tab's memory only (RECOVERY-NAVIGATION-ENROLMENT-20261014, D2).
   */
  let quotaStop: { readonly binding: number; readonly epoch: number } | null =
    null;
  /** A page load permits ONE attempt while blocked (reconciliation trace 6); "Try again" permits another. */
  let permitBlocked = true;
  /** The person's "Try again" from a blocking state: the version of the whole-attempt failure it ends. */
  let blockedVersion: number | null = null;
  let blockedSeen: BlockedBy = null;
  /** Counters that pace the schedule (memory only; never a decision about data). */
  let failures = 0;
  let notSent = 0;
  let beginWaits = 0;
  let unverified = 0;
  let finishWaits = 0;
  /** The local-write operation that is stopped now, and the version of its failure, for "Try again". */
  let stoppedOperation: string | null = null;
  let stoppedVersion: number | null = null;
  /** Stops that could be recorded nowhere durable: this tab's memory (keyed by account, incarnation and operation). */
  const memoryStops = new Set<string>();
  const memoryKey = (service: AccountService, operation: string): string =>
    JSON.stringify([service.account, service.incarnationId, operation]);
  /** The attempt whose crash-loop marker this page saw end and could not retire (R42). */
  const endedAttempts = new Map<AccountId, string>();
  /**
   * The data commit is done and `finish` must be asked (again): the next step asks it, and nothing else. It is the PROOF of one data
   * commit, bound to the binding and the exact handle whose request made it (R1 of the review of 10 October 2026): a `finish` that could
   * not take the lock is asked again with that handle alone, and a new handle (a second re-authentication, a `stale` or `rerun` answer)
   * is never finished on an earlier handle's commit. It must make its own catch-up first: the fence entries it covers may need access
   * removals that the earlier catch-up never fetched.
   */
  let commitProof: {
    readonly binding: number;
    readonly handle: RecoveryHandle;
  } | null = null;
  /** The trigger of the current snapshot (for the trace and the Q24 notice). */
  let trigger: RecoveryTrigger | null = null;
  /**
   * The episode of refusals before a request was sent, and whether the job stands in its wait now (a step then only probes the session's
   * admission revision). The episode outlives the attempt a wait lets through, so a repeated refusal finds what was already tried.
   */
  let admission: AdmissionEpisode | null = null;
  let waiting = false;
  const endEpisode = (): void => {
    admission = null;
    waiting = false;
  };

  const alive = (b: Binding): boolean =>
    binding !== null && binding.id === b.id && !b.ownership.signal.aborted;

  /**
   * The job's report, SCOPED to the binding's account and the epoch of the run it describes (WEB-08c revision 4, R9): `epoch` when the
   * caller names it, else the run's handle, else the identity of the step. A delayed callback therefore cannot describe another identity.
   */
  const report = (
    phase: "catching_up" | "failed" | null,
    epoch?: number,
  ): void => {
    const b = binding;
    const at = epoch ?? handle?.epoch ?? deps.identity.get()?.epoch;
    const scope =
      b !== null && at !== undefined
        ? { account: b.service.account, epoch: at }
        : undefined;
    const key =
      phase === null
        ? null
        : JSON.stringify([phase, scope?.account ?? null, scope?.epoch ?? null]);
    if (reportedKey === key && reported === phase) return;
    reported = phase;
    reportedKey = key;
    deps.trace?.emit("data.recovery_report", { phase: phase ?? "none" });
    deps.recovery.report(phase, scope);
  };
  /** A quota stop of the current binding, identity and epoch stands, over an account that is not displayed (DA-N1). */
  const quotaHeld = (): boolean => {
    const b = binding;
    const stop = quotaStop;
    if (b === null || stop === null || stop.binding !== b.id) return false;
    const now = state.get();
    if (now.kind !== "stopped" || now.cause !== "storage_full") return false;
    const identity = deps.identity.get();
    const view = deps.view.get();
    return (
      identity !== null &&
      identity.account_id === b.service.account &&
      identity.epoch === stop.epoch &&
      !(view.kind === "displaying" && view.account_id === b.service.account)
    );
  };

  const clearTimer = (): void => {
    if (timer !== null) deps.clock.clearTimeout(timer);
    timer = null;
  };
  const resolveWaiters = (): void => {
    const done = waiters;
    waiters = [];
    for (const resolve of done) resolve();
  };
  const schedule = (b: Binding, next: Next): void => {
    clearTimer();
    if (!alive(b)) {
      resolveWaiters();
      return;
    }
    if (next.when === "event") {
      resolveWaiters();
      return;
    }
    timer = deps.clock.setTimeout(
      () => {
        timer = null;
        void tick();
      },
      next.when === "now" ? 0 : next.ms,
    );
    if (next.when === "after") resolveWaiters();
  };

  /** What a wake must change before it starts a step: the binding's service, the identity, the view and connectivity. */
  const eligibility = (): string => {
    const b = binding;
    const identity = deps.identity.get();
    const view = deps.view.get();
    return JSON.stringify([
      b?.id,
      b?.service.live,
      identity?.account_id,
      identity?.epoch,
      view.kind,
      view.kind === "displaying" ? view.account_id : null,
      deps.online(),
    ]);
  };
  let lastEligibility = "";

  async function tick(): Promise<void> {
    const b = binding;
    if (b === null || !alive(b)) return;
    if (busy) {
      woken = true;
      return;
    }
    busy = true;
    woken = false;
    lastEligibility = eligibility();
    clearTimer();
    let next: Next;
    try {
      next = await step(b);
    } catch {
      deps.trace?.emit("data.recovery_step_failed");
      setState({ kind: "stopped", cause: "local_storage" });
      next = { when: "event" };
    } finally {
      busy = false;
    }
    if (!alive(b)) {
      // The step belonged to a binding that has been replaced meanwhile (R4 of the review of 10 October 2026): the replacement's own
      // start (`bind` ran while this step was busy) was absorbed by `busy`, so it is scheduled now. Nothing of the old step's outcome is
      // carried over: the new binding begins from the durable record.
      woken = false;
      const current = binding;
      if (current !== null && alive(current))
        schedule(current, { when: "now" });
      else resolveWaiters();
      return;
    }
    // A wake that arrived during the step is honoured once when nothing else is scheduled, or when the job stands in an admission wait
    // (whose next step only probes): a change that came while the refusal was being handled is not lost. A stop is left only by an
    // explicit act.
    if (
      woken &&
      (next.when === "event" || waiting) &&
      state.get().kind !== "stopped"
    )
      next = { when: "now" };
    woken = false;
    if (next.when === "now") await deps.yield();
    if (!alive(b)) {
      const current = binding;
      if (current !== null && alive(current))
        schedule(current, { when: "now" });
      else resolveWaiters();
      return;
    }
    schedule(b, next);
  }

  /** A wake from outside: the session, the identity, `online`. Ignored when nothing it reads has changed. */
  const wake = (): void => {
    if (binding === null) return;
    if (busy) {
      woken = true;
      return;
    }
    // A notification that changes nothing this job reads is not news (the session publishes a new identity object at every evaluation),
    // unless the job stands in an admission wait: what ends one (a gate resolved in the same epoch, a hold released) need change nothing
    // the fingerprint reads, so the next step PROBES the session's admission revision, a read that sends and writes nothing (R3).
    if (eligibility() === lastEligibility && !waiting) return;
    if (timer !== null && state.get().kind === "backing_off") return;
    // WEB-08c revision 4 (DA-N1): a quota stop is left only by "Try again"; a change of connectivity, view or visibility is no retry.
    if (quotaHeld()) return;
    void tick();
  };

  // ---- one step -------------------------------------------------------------------------------------------------------------------
  async function step(b: Binding): Promise<Next> {
    const service = b.service;
    if (!service.live) return quiet();
    const identity = deps.identity.get();
    if (identity === null || identity.account_id !== service.account)
      return quiet();
    const view = deps.view.get();
    const displayed =
      view.kind === "displaying" && view.account_id === service.account;
    if (waiting) {
      const stands = await admitted(
        b,
        displayed ? "ordinary" : "recovery",
        identity.epoch,
      );
      if (stands !== null) return stands;
    }
    let mode: RecoveryMode;
    if (displayed) {
      // The account is displayed: any recovery handle of a fenced run is over (the session cleared the fence).
      handle = null;
      commitProof = null;
      if (reported !== null) report(null);
      mode = "ordinary";
    } else {
      if (!deps.online()) {
        if (handle !== null || reported !== null)
          report("failed", identity.epoch);
        return waitOffline();
      }
      if (handle === null || handle.epoch !== identity.epoch) {
        handle = null;
        commitProof = null;
        const begun = await deps.recovery.begin(service.account);
        deps.trace?.emit("data.recovery_begin", {
          kind: begun.kind,
          ...(begun.kind === "ineligible" ? { reason: begun.reason } : {}),
        });
        if (!alive(b)) return { when: "event" };
        if (begun.kind === "ineligible")
          return ineligible(b, identity.epoch, begun.reason, begun.revision);
        beginWaits = 0;
        handle = begun.handle;
        trigger ??= "reauthenticated";
      }
      mode = "recovery";
      // The data commit has been made UNDER THIS HANDLE: step 2 is all that is left (a `finish` that could not take the lock is asked
      // again, alone). A commit made under another handle proves nothing for this one.
      if (
        commitProof !== null &&
        commitProof.binding === b.id &&
        commitProof.handle === handle
      )
        return finish(b, handle as RecoveryHandle);
      commitProof = null;
      report("catching_up");
    }
    if (!deps.online()) return waitOffline();

    // The path: a catch-up from a valid saved cursor (recovery mode only), else a snapshot (both modes).
    let path: RecoveryPath = "snapshot";
    let capture = await runCapture(b, "snapshot");
    if (!alive(b)) return { when: "event" };
    if (capture.kind === "gated" && capture.reason === "not_needed") {
      if (mode === "ordinary") {
        // R8: the receipt bookkeeping a recovery-mode commit owed is done now, as an ordinary write of the displayed account.
        if (capture.reconcilePending === true)
          return reconcileOwed(b, identity.epoch);
        return idle();
      }
      path = "catch_up";
      capture = await runCapture(b, "catch_up");
      if (!alive(b)) return { when: "event" };
    }
    if (capture.kind === "failed")
      return localFailure(b, capture.error, RECOVERY_CAPTURE_OPERATION);
    if (capture.kind === "gated") return gated(b, capture, mode);
    exclusive.set(true);
    trigger ??= capture.position === null ? "first_snapshot" : "adopted";

    const epoch =
      mode === "recovery" ? (handle as RecoveryHandle).epoch : identity.epoch;
    const captured = service.capture(epoch, {
      requestSeq: capture.requestSeq,
      ownershipToken: b.ownership.token,
      recoveryGeneration: capture.recoveryGeneration,
      expectedPosition: capture.position,
    });
    const saw = new Map<string, MarkerSeen>();
    for (const operation of [capture.operation, capture.activateOperation])
      if (operation !== null) {
        const seen = deps.markers?.witness(service, operation);
        if (seen !== undefined) saw.set(operation, seen);
      }
    const issued: Issued = {
      binding: b,
      mode,
      path,
      capture,
      captured,
      epoch,
      handle: mode === "recovery" ? handle : null,
      saw,
      permit: false,
    };

    const verdict = await deps.quota.check(
      "cache",
      maxResponseBytesFor(capture.limit, config),
    );
    if (!mayIssue(issued)) return { when: alive(b) ? "now" : "event" };
    if (verdict === "refuse") {
      // No request was sent: nothing is recorded, but in recovery mode the stop is still left only by "Try again" (DA-N1).
      if (mode === "recovery") quotaStop = { binding: b.id, epoch };
      return stop({ kind: "stopped", cause: "storage_full" }, mode);
    }
    // The one attempt a page load (or "Try again") permits while blocked is used by a request that is SENT: never by a capture whose
    // request was then withheld here, and it is returned when the session refuses the call before sending it (`not_sent`,
    // `not_covered`, below; found in WebKit by E-B13: the post-display verification's detection hold refused the load's request, and a
    // permission spent anyway left the load with no attempt at all). From here to the call is synchronous.
    issued.permit = permitBlocked;
    permitBlocked = false;

    setState({ kind: "running", mode, path });
    // A fixed vocabulary only: no cursor, no content.
    deps.trace?.emit("data.recovery_request", {
      mode,
      path,
      trigger: trigger ?? "none",
      at: capture.position === null ? "start" : "position",
      seq: capture.requestSeq,
    });
    const url = deps.apiUrl("/sync");
    if (capture.position !== null)
      url.searchParams.set("cursor", capture.position);
    url.searchParams.set("limit", String(capture.limit));
    let response: Response;
    try {
      response = await deps.fetchFor(
        mode === "recovery" ? "recovery" : "ordinary",
        service.account,
        epoch,
      )(new Request(url, { method: "GET", signal: b.ownership.signal }));
    } catch (error) {
      if (!alive(b)) return { when: "event" };
      return requestError(issued, error);
    }
    if (!alive(b)) return { when: "event" };
    notSent = 0;
    endEpisode();
    return answer(issued, response);
  }

  /** R59-style: the run, the service, connectivity and the identity re-read in the synchronous step that issues the request. */
  function mayIssue(issued: Issued): boolean {
    if (!alive(issued.binding)) return false;
    const service = issued.binding.service;
    if (!service.live || !deps.online()) return false;
    const identity = deps.identity.get();
    if (
      identity === null ||
      identity.account_id !== service.account ||
      identity.epoch !== issued.epoch
    )
      return false;
    if (issued.mode === "ordinary") {
      const view = deps.view.get();
      return view.kind === "displaying" && view.account_id === service.account;
    }
    return handle !== null && handle === issued.handle;
  }

  type CaptureOutcome = RecoveryCapture | { kind: "failed"; error: unknown };
  async function runCapture(
    b: Binding,
    path: RecoveryPath,
  ): Promise<CaptureOutcome> {
    const service = b.service;
    try {
      return await service.store.run(captureRecoveryRequest, {
        incarnationId: service.incarnationId,
        token: b.ownership.token ?? "",
        path,
        now: deps.clock.now(),
        signals: deps.signals,
        allowBlocked: permitBlocked,
        stoppedOperations: [...memoryStops]
          .map((key) => JSON.parse(key) as [string, string, string])
          .filter(
            ([account, incarnation]) =>
              account === service.account &&
              incarnation === service.incarnationId,
          )
          .map(([, , operation]) => operation),
        markerState: (operation) => {
          const seen = deps.markers?.witness(service, operation);
          return seen === undefined ? "unmarked" : markerStateOf(seen);
        },
        endedAttempt: endedAttempts.get(service.account) ?? null,
      });
    } catch (error) {
      return { kind: "failed", error };
    }
  }

  /** W26 (R8): the owed receipt bookkeeping, admitted with the displayed epoch's stamp; paced when it cannot be had now. */
  async function reconcileOwed(b: Binding, epoch: number): Promise<Next> {
    const service = b.service;
    const captured = service.capture(epoch, {
      requestSeq: null,
      ownershipToken: b.ownership.token,
      recoveryGeneration: 0,
      expectedPosition: null,
    });
    const out = await service.commit(reconcileOwedReceipts, {
      captured,
      ...(deps.elapsed ? { elapsed: deps.elapsed } : {}),
    });
    if (!alive(b)) return { when: "event" };
    deps.trace?.emit("data.recovery_owed_reconcile", {
      outcome: out.kind,
      ...(out.kind === "applied" ? { value: out.value.kind } : {}),
    });
    if (out.kind === "applied") {
      deps.channel?.post({
        type: "data_changed",
        account: service.account,
        stores: ["drafts", "sync_state"],
      });
      return idle();
    }
    if (out.kind === "dropped") {
      if (out.reason === "unverified") return paced();
      return idle();
    }
    // A failed write leaves it owed: asked again, paced (it is bookkeeping, never a reason to stop sync).
    return paced();
  }

  // ---- admission waits (R3 of the review of 10 October 2026, second cycle) -----------------------------------------------------------
  /**
   * The session refused before anything was sent, for a reason that only a change of its admission inputs ends: `begin` refused on the
   * durable record (a gating attempt, an operation, an unverified credential, a current-epoch entry), the cover closed after `begin` had
   * said eligible (`closed`, `closed_unresolved`: another page added a gate, or a request lease of another page is unresolved), or the
   * page's hold, closing write or token outlasted the immediate retries (`not_sent`). The account, its epoch and a neutral view can stay
   * exactly as they were when any of these ends, so the job does not wait for the fingerprint: it stands in an explicit wait whose steps
   * PROBE the session's admission revision (a read: no capture, no request, no write) on every notification and, paced, without one (a
   * hint can be lost). The wait is installed BEFORE the first probe, so a change that came first is seen by it.
   *
   * A `begin` refusal brings the admission revision of the read it was decided on (`baseline`), and the wait starts from it (WEB-08c
   * K-2, R3 of the review of 11 October 2026). Without it the first probe was the baseline: a gate that ended between `begin`'s read and
   * that probe (an activation refused at once, an operation's outcome) left a blocked record that never changed again (in recovery mode
   * an account with nothing fenced stays blocked), and the job stood in the wait with `failed` reported, keeping state 3 over an account
   * that had nothing to catch up.
   */
  function awaitAdmission(
    b: Binding,
    mode: RecoveryMode,
    epoch: number,
    cause: AdmissionEpisode["cause"],
    baseline?: string,
  ): Next {
    const episode = admission;
    if (
      episode === null ||
      episode.binding !== b.id ||
      episode.mode !== mode ||
      episode.epoch !== epoch
    )
      admission = {
        binding: b.id,
        mode,
        epoch,
        cause,
        revision: null,
        consumed: false,
        probes: 0,
        retries: 0,
        retryAt: null,
      };
    else episode.cause = cause;
    if (baseline !== undefined && admission !== null)
      admission.revision = baseline;
    waiting = true;
    return { when: "now" };
  }

  /**
   * One step of an admission wait: null when the step may go on (the wait is over, or it belongs to a binding, mode or epoch that is no
   * longer the current one: the step then decides afresh), else what the wait schedules next.
   *
   * The step goes on when the probe finds nothing that refuses the request AND either its revision changed (something that admits it
   * moved: a fresh run of immediate retries is permitted) or the episode has not used its one attempt yet (a change that came before the
   * wait was installed, or a refusal the revision does not show, is tried at once), or the paced attempt of an open, unchanged revision
   * has fallen due (a refusal the probe cannot show, such as a CSRF token that only a new verification can fetch, is tried again at
   * 1 s doubling to 60 s: bounded, and no notification hastens it). In recovery mode a changed revision also re-asks `begin`
   * while blocked: `begin` reads the record and returns before any lease work while a gate stands, and its answer keeps the published
   * reason true. An unchanged revision asks nothing, so the job's own reports, its own leases and new identity objects cannot make it
   * ask again (no loop). A record that cannot be read is unknown: nothing is asked, and the next probe is paced.
   */
  async function admitted(
    b: Binding,
    mode: RecoveryMode,
    epoch: number,
  ): Promise<Next | null> {
    const episode = admission;
    if (
      episode === null ||
      episode.binding !== b.id ||
      episode.mode !== mode ||
      episode.epoch !== epoch ||
      !deps.online()
    ) {
      // The situation moved (displayed or fenced now, another epoch, offline): the wait is over; the step decides from what is true now.
      endEpisode();
      return null;
    }
    let probe: RequestAdmission | null;
    try {
      probe = await deps.admission(mode, b.service.account, epoch);
    } catch {
      probe = null;
    }
    if (!alive(b)) return { when: "event" };
    // An explicit act (retry, online) ended the episode while the probe was read: the step goes on.
    if (admission !== episode || !waiting) return null;
    const changed = probe !== null && probe.revision !== episode.revision;
    const seen = episode.revision !== null;
    const now = deps.clock.now();
    const due =
      probe !== null &&
      !probe.blocked &&
      !changed &&
      episode.consumed &&
      episode.retryAt !== null &&
      now >= episode.retryAt;
    if (
      probe !== null &&
      ((!probe.blocked && (changed || !episode.consumed || due)) ||
        (mode === "recovery" && changed && seen))
    ) {
      if (changed && seen) {
        notSent = 0;
        episode.retries = 0;
      }
      if (due) episode.retries += 1;
      episode.retryAt =
        now +
        Math.min(
          config.recoveryBeginRetryMaxMs,
          config.recoveryBeginRetryMs * 2 ** Math.min(episode.retries, 8),
        );
      deps.trace?.emit("data.recovery_admission", {
        phase: "resume",
        cause: episode.cause,
        mode,
        changed: changed && seen,
        paced: due,
        blocked: probe.blocked,
      });
      episode.revision = probe.revision;
      episode.consumed = true;
      episode.probes = 0;
      waiting = false;
      return null;
    }
    if (probe !== null) {
      if (changed) {
        episode.revision = probe.revision;
        episode.probes = 0;
      }
      // A blocker stands: when it goes, the revision changes and the episode may try again.
      if (probe.blocked) episode.consumed = false;
    }
    if (changed || episode.probes === 0)
      deps.trace?.emit("data.recovery_admission", {
        phase: "wait",
        cause: episode.cause,
        mode,
        probe: probe === null ? "unknown" : probe.blocked ? "blocked" : "open",
      });
    episode.probes += 1;
    exclusive.set(true);
    if (state.get().kind !== "eligible_wait")
      setState({ kind: "admission_wait", mode });
    if (mode === "recovery") report("failed", epoch);
    let ms = Math.min(
      config.recoveryBeginRetryMaxMs,
      config.recoveryBeginRetryMs * 2 ** Math.min(episode.probes - 1, 8),
    );
    // An open revision whose attempt was refused is looked at again when its paced attempt falls due.
    if (
      probe !== null &&
      !probe.blocked &&
      episode.consumed &&
      episode.retryAt !== null
    )
      ms = Math.max(1, Math.min(ms, episode.retryAt - now));
    return { when: "after", ms };
  }

  // ---- states without a request -----------------------------------------------------------------------------------------------------
  function quiet(): Next {
    endEpisode();
    exclusive.set(false);
    setState({ kind: "idle" });
    return { when: "event" };
  }
  function idle(): Next {
    endEpisode();
    trigger = null;
    failures = 0;
    exclusive.set(false);
    setState({ kind: "idle" });
    return { when: "event" };
  }
  function waitOffline(): Next {
    setState({ kind: "eligible_wait", reason: "offline" });
    return { when: "event" };
  }
  function ineligible(
    b: Binding,
    epoch: number,
    reason: Exclude<RecoveryBegin, { kind: "eligible" }>["reason"],
    revision?: string,
  ): Next {
    if (reason === "no_fence") {
      // WEB-08c K-2: nothing is fenced, so nothing is left to recover. A failure this job reported while a gate stood (an attempt that
      // was gating, an operation pending) is not true any longer and is withdrawn: otherwise the session kept state 3 ("Couldn't finish
      // catching up") over an account that has nothing to catch up, and a failed switch, an in-place re-authentication or a stale
      // retirement left the page stranded there (the job reports `null` only once the account displays, which state 3 prevents).
      if (reported !== null) report(null);
      return quiet();
    }
    exclusive.set(true);
    setState({ kind: "eligible_wait", reason });
    // A lease or a record that is not settled yet is asked again, paced; offline waits for `online`. A gate of the durable record (a
    // gating attempt, an operation, an unverified credential, a current-epoch entry) is an admission wait: whatever ends it, in this
    // epoch (O11, an attempt resolved, the operation's outcome) or by a re-authentication, the job notices (R3).
    if (reason === "unresolved_lease" || reason === "stale") {
      beginWaits += 1;
      return {
        when: "after",
        ms: Math.min(
          config.recoveryBeginRetryMaxMs,
          config.recoveryBeginRetryMs * 2 ** Math.min(beginWaits - 1, 8),
        ),
      };
    }
    if (reason === "offline") return { when: "event" };
    report("failed", epoch);
    return awaitAdmission(b, "recovery", epoch, "begin", revision);
  }
  function stop(
    next: Extract<RecoveryJobState, { kind: "stopped" }>,
    mode: RecoveryMode,
  ): Next {
    exclusive.set(true);
    setState(next);
    if (mode === "recovery") report("failed");
    return { when: "event" };
  }

  function gated(
    b: Binding,
    capture: Extract<RecoveryCapture, { kind: "gated" }>,
    mode: RecoveryMode,
  ): Next {
    switch (capture.reason) {
      case "absent":
      case "closing":
      case "owner":
        // The database is going, or another binding owns it now: this one asks nothing.
        return quiet();
      case "not_needed":
        return mode === "ordinary" ? idle() : quiet();
      case "blocked":
        blockedSeen = capture.blocked ?? null;
        blockedVersion = capture.budgetVersion ?? null;
        return stop(
          {
            kind: "stopped",
            cause: "sync_blocked",
            ...(capture.blocked ? { blocked: capture.blocked } : {}),
          },
          mode,
        );
      case "paused":
        exclusive.set(true);
        setState({ kind: "paused", mode, since: deps.clock.now() });
        if (mode === "recovery") report("failed");
        return { when: "event" };
      case "unrecognised":
        return stop({ kind: "stopped", cause: "unrecognised" }, mode);
      case "local_storage":
        stoppedOperation = capture.operation ?? null;
        stoppedVersion = capture.version ?? null;
        return stop(
          {
            kind: "stopped",
            cause: "local_storage",
            ...(capture.operation !== undefined &&
            memoryStops.has(memoryKey(b.service, capture.operation))
              ? { memoryOnly: true as const }
              : {}),
          },
          mode,
        );
      case "unreadable":
        stoppedOperation = null;
        exclusive.set(true);
        setState({ kind: "stopped", cause: "local_storage" });
        if (mode === "recovery") report("failed");
        failures += 1;
        return {
          when: "after",
          ms: Math.min(60_000, 1_000 * 2 ** Math.min(failures, 6)),
        };
      case "floor":
        return stop({ kind: "stopped", cause: "floor" }, mode);
    }
  }

  // ---- answers ----------------------------------------------------------------------------------------------------------------------
  async function requestError(issued: Issued, error: unknown): Promise<Next> {
    if (error instanceof StampedRequestError) {
      // Nothing left the page: the attempt it held is still the load's (`stale` and `closed` can follow a send, and end the run).
      if (
        issued.permit &&
        (error.kind === "not_sent" || error.kind === "not_covered")
      )
        permitBlocked = true;
      switch (error.kind) {
        case "not_sent": {
          // A short local refusal (the post-display verification's detection hold, a token being fetched) is retried at once, a few
          // times. One that outlasts them is an admission wait (R3): the counter is NOT reset here, so the one attempt the wait then
          // permits on an unchanged revision is the last; a changed revision permits a fresh run.
          const pace = config.notSentBackoffMs;
          if (notSent < pace.length) {
            const ms = pace[notSent] as number;
            notSent += 1;
            return { when: "after", ms };
          }
          return awaitAdmission(
            issued.binding,
            issued.mode,
            issued.epoch,
            "not_sent",
          );
        }
        case "not_covered":
          failures += 1;
          return {
            when: "after",
            ms: nextDelay(failures, deps.clock.random(), config),
          };
        case "closed":
        case "closed_unresolved":
          // The cover closed after `begin` said eligible (R3, second cycle): another page added a gate, or another page's request lease
          // is unresolved (the session verifies it). `begin`'s answer is no continuing permission, so the handle and any commit proof
          // made under it end (a new `begin` captures a fresh `s` and resolves the leases); the job waits for the admission inputs.
          if (issued.mode === "recovery") {
            handle = null;
            commitProof = null;
          }
          return awaitAdmission(
            issued.binding,
            issued.mode,
            issued.epoch,
            "closed",
          );
        case "auth_state":
          // A recovery-time `401` or `credential_mismatch` recorded a current-epoch entry: nothing is counted, and the run stops for the
          // session; a re-authentication (a new epoch, `begin` eligible again) restarts it (T24 C). The request was answered, so this is
          // a new episode; whatever clears the entry ends its wait (R3).
          handle = null;
          commitProof = null;
          endEpisode();
          if (issued.mode === "recovery") report("failed", issued.epoch);
          setState({ kind: "eligible_wait", reason: "current_epoch_entry" });
          return awaitAdmission(
            issued.binding,
            issued.mode,
            issued.epoch,
            "begin",
          );
        case "stale":
          // A newer settlement: the run starts again from `begin`, with a new `s` (T24 G), and its own catch-up.
          handle = null;
          commitProof = null;
          endEpisode();
          return { when: "now" };
      }
    }
    // Sent and failed (a network error, a time-out): the episode of refusals before sending is over.
    endEpisode();
    return failRead(issued, null);
  }

  async function answer(issued: Issued, response: Response): Promise<Next> {
    const status = response.status;
    if (status === 200) return applyPage(issued, response);
    if (status === 410) return serverRestart(issued, "resync_required");
    if (status === 409) {
      const code = await errorCode(response);
      if (!alive(issued.binding)) return { when: "event" };
      // `access_changed` is a snapshot-phase answer (D 4.4); in the delta phase it is unrecognised.
      if (code === "access_changed" && issued.path === "snapshot")
        return serverRestart(issued, "access_changed");
      return unrecognised(issued);
    }
    if (status === 400 || status === 422)
      return budget(
        issued,
        issued.capture.position === null ? "cursorless_error" : "cursor_defect",
      );
    if (status === 503) {
      const code = await errorCode(response);
      if (!alive(issued.binding)) return { when: "event" };
      if (code === "device_capacity")
        return stop({ kind: "stopped", cause: "device_capacity" }, issued.mode);
      return failRead(issued, retryAfter(response));
    }
    if (isFailureStatus(status)) return failRead(issued, retryAfter(response));
    return unrecognised(issued);
  }

  function unrecognised(issued: Issued): Promise<Next> {
    return budget(
      issued,
      issued.capture.position === null
        ? "cursorless_error"
        : "cursor_unrecognised",
    );
  }

  function serverRestart(
    issued: Issued,
    reason: "resync_required" | "access_changed",
  ): Promise<Next> {
    return budget(issued, "server_restart", reason);
  }

  /**
   * Records what the answer does to the recovery-scoped counters (W24) and follows it. W24 is admitted with the request's own stamp (R5):
   * an answer whose epoch, ownership or generation is no longer current writes nothing, and none of its visible effects (the Q24 notice,
   * the trigger) happen either. They follow the recorded write, never the response alone.
   */
  async function budget(
    issued: Issued,
    event: BudgetEvent,
    restart?: "resync_required" | "access_changed",
  ): Promise<Next> {
    const service = issued.binding.service;
    const out = await service.commit(recordRecoveryOutcome, {
      captured: issued.captured,
      event,
    });
    if (!alive(issued.binding)) return { when: "event" };
    if (out.kind === "failed")
      return bookkeepingStop(issued, RECOVERY_BUDGET_OPERATION, out.failure);
    if (out.kind === "dropped") return dropped(issued, out.reason);
    const recorded = out.value;
    if (restart !== undefined) {
      // Q24: the restart is automatic and the person is told once, per generation.
      notice.set({
        reason: restart,
        id: `${issued.capture.recoveryGeneration}:${restart}`,
      });
      trigger = restart;
    }
    deps.channel?.post({
      type: "data_changed",
      account: service.account,
      stores: ["sync_state"],
    });
    if (recorded.blocked !== null) {
      blockedSeen = recorded.blocked;
      blockedVersion = recorded.budgetVersion;
      return stop(
        { kind: "stopped", cause: "sync_blocked", blocked: recorded.blocked },
        issued.mode,
      );
    }
    if (event === "server_restart") return { when: "now" };
    failures += 1;
    setState({
      kind: "backing_off",
      mode: issued.mode,
      since: deps.clock.now(),
    });
    return {
      when: "after",
      ms: nextDelay(failures, deps.clock.random(), config),
    };
  }

  /** A counted failure of the read (network, `5xx`, `429`): the `sync` caller's durable back-off, then its pause (consumed, P-10). */
  async function failRead(
    issued: Issued,
    retryAfterMs: number | null,
  ): Promise<Next> {
    failures += 1;
    const out = await issued.binding.service.commit(recordReadOutcome, {
      captured: issued.captured,
      caller: "sync",
      outcome: { kind: "failure" },
      now: deps.clock.now(),
    });
    if (!alive(issued.binding)) return { when: "event" };
    if (out.kind === "failed")
      return bookkeepingStop(issued, "retry-state", out.failure);
    if (out.kind === "dropped") return dropped(issued, out.reason);
    exclusive.set(true);
    if (out.value.state.paused) {
      setState({
        kind: "paused",
        mode: issued.mode,
        since: out.value.state.backing_off_since ?? deps.clock.now(),
      });
      if (issued.mode === "recovery") report("failed");
      return { when: "event" };
    }
    setState({
      kind: "backing_off",
      mode: issued.mode,
      since: out.value.state.backing_off_since ?? deps.clock.now(),
    });
    const wait = Math.max(
      nextDelay(failures, deps.clock.random(), config),
      retryAfterMs ?? 0,
    );
    return { when: "after", ms: Math.min(wait, config.backoffMaxMs) };
  }

  async function applyPage(issued: Issued, response: Response): Promise<Next> {
    const limit = issued.capture.limit;
    const ceiling = maxResponseBytesFor(limit, config);
    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > ceiling)
      return unrecognised(issued);
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await response.arrayBuffer());
    } catch (error) {
      if (isAllocationError(error))
        return sizingFailure(issued, { kind: "allocation_failed" });
      return failRead(issued, null);
    }
    if (!alive(issued.binding)) return { when: "event" };
    if (bytes.length > ceiling) return unrecognised(issued);
    let scan: ScanResult;
    try {
      scan = scanSyncPage(bytes, config);
    } catch (error) {
      if (isAllocationError(error))
        return sizingFailure(issued, { kind: "allocation_failed" });
      throw error;
    }
    const expected = issued.path === "snapshot" ? "snapshot" : "delta";
    if (!scan.ok || scan.phase !== expected) return unrecognised(issued);
    const ok = scan;
    const service = issued.binding.service;
    const extra =
      issued.path === "snapshot" && !ok.hasMore
        ? issued.capture.stagingBytes
        : 0;
    for (let round = 1; ; round += 1) {
      const reservation = await deps.quota.reserve(
        "cache",
        bytes.length + extra,
      );
      if (!alive(issued.binding)) {
        reservation.settle("not_written");
        return { when: "event" };
      }
      if (reservation.verdict === "refuse") {
        if (reservation.unestablished === true) return paced();
        return quotaStopped(issued);
      }
      let written = false;
      let attempt: string | null = null;
      try {
        if (bytes.length >= config.markerMinBytes) {
          attempt = deps.ids.uuid();
          try {
            await service.store.run(recordSizingAttempt, {
              incarnationId: service.incarnationId,
              id: attempt,
              limit,
              startedAt: deps.clock.now(),
            });
          } catch {
            // A refinement; a page is not refused for want of it.
          }
        }
        const common = {
          captured: issued.captured,
          bytes,
          scan: ok,
          decode: deps.decode,
          ...(deps.elapsed ? { elapsed: deps.elapsed } : {}),
          leaseLive: () => reservation.live(),
        };
        const commitStarted = deps.elapsed?.();
        const outcome: CommitOutcome<{ kind: string; hasMore?: boolean }> =
          issued.path === "catch_up"
            ? await service.commit(commitPage, {
                ...common,
                now: deps.clock.iso(),
                mode: "recovery",
              })
            : ok.hasMore
              ? await service.commit(commitStagingPage, {
                  ...common,
                  operation: issued.capture.operation,
                })
              : await service.commit(activateSnapshot, {
                  ...common,
                  operation: issued.capture.operation,
                  activateOperation: issued.capture.activateOperation as string,
                  now: deps.clock.iso(),
                  mode: issued.mode,
                });
        const kind = outcome.kind === "applied" ? outcome.value.kind : null;
        written =
          kind === "staged" || kind === "activated" || kind === "committed";
        // Measurement only (a fixed vocabulary, no content): what WEB-09c and the design measurement read about the activation's cost.
        deps.trace?.emit("data.recovery_commit", {
          path: issued.path,
          final: !ok.hasMore,
          outcome: outcome.kind,
          ...(kind === null ? {} : { value: kind }),
          bytes: bytes.length,
          ...(commitStarted === undefined || deps.elapsed === undefined
            ? {}
            : {
                commit_ms:
                  Math.round((deps.elapsed() - commitStarted) * 1000) / 1000,
              }),
        });
        if (attempt !== null && !written) await retireAttempt(service, attempt);
        if (kind === "lease_lapsed" && round < 3) continue;
        return committed(issued, outcome, ok.hasMore);
      } finally {
        reservation.settle(written ? "written" : "not_written");
      }
    }
  }

  async function committed(
    issued: Issued,
    outcome: CommitOutcome<{
      kind: string;
      hasMore?: boolean;
      reason?: string;
    }>,
    hasMore: boolean,
  ): Promise<Next> {
    const b = issued.binding;
    const service = b.service;
    if (!alive(b)) return { when: "event" };
    if (outcome.kind === "dropped") return dropped(issued, outcome.reason);
    if (outcome.kind === "failed")
      return commitFailure(issued, outcome.failure, hasMore);
    const value = outcome.value;
    switch (value.kind) {
      case "lease_lapsed":
        return paced();
      case "revision_mismatch":
        return unrecognised(issued);
      case "not_ready":
        return value.reason === "page_phase" || value.reason === "final"
          ? unrecognised(issued)
          : { when: "now" };
    }
    failures = 0;
    unverified = 0;
    deps.quota.invalidate();
    // The page's operation succeeded: the markers the gate saw of it end (R51); a newer one is left.
    for (const [operation, seen] of issued.saw)
      deps.markers?.retire(service, operation, seen);
    deps.channel?.post({
      type: "data_changed",
      account: service.account,
      stores:
        issued.path === "snapshot" && hasMore
          ? ["sync_state"]
          : ["cache", "sync_state"],
    });
    if (hasMore) {
      setState({ kind: "running", mode: issued.mode, path: issued.path });
      return { when: "now" };
    }
    // The data commit is complete. In ordinary mode the cache is valid now and the engine takes over; in recovery mode `finish` follows.
    trigger = null;
    if (issued.mode === "ordinary") return idle();
    return finish(b, issued.handle);
  }

  /** Step 2 of ending a recovery (matrix 3.7.3): `finish_recovery`'s release transaction, after the data commit. */
  async function finish(b: Binding, of: RecoveryHandle | null): Promise<Next> {
    const current = handle;
    if (current === null || of === null || current !== of) {
      // The run this commit was made for is over (a new handle begins with its own catch-up).
      commitProof = null;
      return { when: "now" };
    }
    commitProof = { binding: b.id, handle: current };
    setState({ kind: "finishing" });
    const result = await deps.recovery.finish(current);
    deps.trace?.emit("data.recovery_finish", { result });
    if (!alive(b)) return { when: "event" };
    switch (result) {
      case "cleared":
        handle = null;
        commitProof = null;
        finishWaits = 0;
        report(null);
        return idle();
      case "rerun":
      case "superseded":
        // A newer fence entry (rerun) or a newer epoch: `begin` again, with a new `s`; a catch-up with nothing to apply finishes at once.
        handle = null;
        commitProof = null;
        return { when: "now" };
      case "not_eligible": {
        // The record is no longer eligible at `finish` (a gate another page added): `begin` again once it changes (R3).
        handle = null;
        commitProof = null;
        report("failed", current.epoch);
        setState({ kind: "eligible_wait", reason: "current_epoch_entry" });
        return awaitAdmission(b, "recovery", current.epoch, "begin");
      }
      case "lock_timeout":
      case "failed":
        finishWaits += 1;
        return {
          when: "after",
          ms: nextDelay(finishWaits, deps.clock.random(), config),
        };
    }
  }

  function paced(): Next {
    unverified += 1;
    return {
      when: "after",
      ms: nextDelay(unverified, deps.clock.random(), config),
    };
  }

  function dropped(issued: Issued, reason: string): Next {
    switch (reason) {
      case "unverified":
        return paced();
      case "owner":
      case "identity_changed":
      case "closed":
      case "incarnation":
      case "closing":
        return quiet();
      default:
        // `position`, `generation`, `epoch_superseded`: another answer moved the record. Re-evaluate from it.
        void issued;
        return { when: "now" };
    }
  }

  async function commitFailure(
    issued: Issued,
    failure: StoreFailure,
    hasMore: boolean,
  ): Promise<Next> {
    const service = issued.binding.service;
    if (failure.cause === "quota") {
      await recordSizing(service, { kind: "quota" });
      if (!alive(issued.binding)) return { when: "event" };
      return quotaStopped(issued);
    }
    if (failure.cause === "closed") return quiet();
    if (failure.cause === "plan_rejected") {
      if (
        failure.detail?.stage === "apply" &&
        failure.detail.reason === "watchdog"
      )
        return sizingFailure(issued, {
          kind: "watchdog",
          elapsedMs: config.syncApplyWatchdogMs,
        });
      return unrecognised(issued);
    }
    if (isAllocationFailure(failure))
      return sizingFailure(issued, { kind: "allocation_failed" });
    await recordSizing(service, {
      kind: "commit_failed",
      cause: failure.cause === "abort" ? "abort" : "error",
    });
    // The WHOLE page is requested again from the same position (Q24, "Retry applying changes"), up to the local-write bound.
    const final =
      issued.path === "snapshot" &&
      issued.capture.activateOperation !== null &&
      !hasMore;
    return localFailure(
      issued.binding,
      failure,
      final
        ? (issued.capture.activateOperation as string)
        : issued.capture.operation,
      issued.mode,
    );
  }

  /**
   * WEB-08c revision 4 (DA-N1; WEB08C-T24D-QUOTA-20261014): a page that could not be committed for want of space. Stopped at once and
   * not counted (a counter would need the very space that is missing). In recovery mode the stop of the page's operation is recorded in
   * the account's write-failure marker, exactly as WEB-09a records the quota stop of an admitted invalidation: it survives a reload and
   * another page's takeover (the capture gate reads it, so nothing is asked again) and only "Try again" retires it. A marker that cannot
   * be written is held in this tab's memory and says so (D2 of RECOVERY-NAVIGATION-ENROLMENT-20261014). Nothing of the page was
   * committed, the cursor and the fence stand.
   */
  function quotaStopped(issued: Issued): Next {
    if (issued.mode !== "recovery")
      return stop({ kind: "stopped", cause: "storage_full" }, issued.mode);
    const service = issued.binding.service;
    const operation = issued.capture.operation;
    const recorded = recordStop(
      deps.markers,
      service,
      operation,
      () => service.live,
      { hold: () => memoryStops.add(memoryKey(service, operation)) },
    );
    if (recorded === "obsolete") return quiet();
    stoppedOperation = operation;
    stoppedVersion = null;
    quotaStop = { binding: issued.binding.id, epoch: issued.epoch };
    deps.trace?.emit("data.recovery_quota_stop", { recorded });
    return stop(
      {
        kind: "stopped",
        cause: "storage_full",
        ...(recorded === "memory" ? { memoryOnly: true as const } : {}),
      },
      "recovery",
    );
  }

  async function sizingFailure(
    issued: Issued,
    outcome: SizingOutcome,
  ): Promise<Next> {
    const record = await recordSizing(issued.binding.service, outcome);
    if (!alive(issued.binding)) return { when: "event" };
    if (record.kind === "failed")
      return bookkeepingStop(issued, "sizing", record.error);
    if (record.action === "floor")
      return stop({ kind: "stopped", cause: "floor" }, issued.mode);
    return { when: "now" };
  }
  async function recordSizing(
    service: AccountService,
    outcome: SizingOutcome,
  ): Promise<
    { kind: "recorded"; action: string } | { kind: "failed"; error: unknown }
  > {
    try {
      const result = await service.store.run(recordSizingOutcome, {
        incarnationId: service.incarnationId,
        outcome,
      });
      return { kind: "recorded", action: result.action };
    } catch (error) {
      return { kind: "failed", error };
    }
  }
  async function retireAttempt(
    service: AccountService,
    attempt: string,
  ): Promise<void> {
    try {
      await service.store.run(retireSizingAttempt, {
        incarnationId: service.incarnationId,
        id: attempt,
      });
    } catch {
      endedAttempts.set(service.account, attempt);
    }
  }

  /** A local write failure of `operation`, counted under its own identity; three stop it, and a counter that cannot be written stops at once. */
  async function localFailure(
    b: Binding,
    error: unknown,
    operation: string,
    mode: RecoveryMode = handle === null ? "ordinary" : "recovery",
  ): Promise<Next> {
    const service = b.service;
    if (isStoreFailure(error) && error.cause === "closed") return quiet();
    let stopNow = false;
    let memoryOnly = false;
    try {
      const result = await service.store.run(recordLocalWriteOutcome, {
        incarnationId: service.incarnationId,
        operation,
        outcome: { kind: "failure" },
      });
      if (!service.live || !alive(b)) return { when: "event" };
      stopNow = result.stop;
      stoppedVersion = result.version;
    } catch {
      if (!service.live || !alive(b)) return { when: "event" };
      stopNow = true;
      stoppedVersion = null;
      const recorded = recordStop(
        deps.markers,
        service,
        operation,
        () => service.live,
        {
          hold: () => memoryStops.add(memoryKey(service, operation)),
        },
      );
      if (recorded === "obsolete") return quiet();
      memoryOnly = recorded === "memory";
    }
    if (stopNow) {
      stoppedOperation = operation;
      deps.channel?.post({
        type: "data_changed",
        account: service.account,
        stores: ["sync_state"],
      });
      return stop(
        {
          kind: "stopped",
          cause: "local_storage",
          ...(memoryOnly ? { memoryOnly: true as const } : {}),
        },
        mode,
      );
    }
    return { when: "now" };
  }

  /** A counter the job needs to bound itself cannot be written: an immediate, uncounted stop (the marker, else this tab's memory). */
  function bookkeepingStop(
    issued: Issued,
    operation: string,
    error: unknown,
  ): Next {
    const service = issued.binding.service;
    const cause = isStoreFailure(error) ? error.cause : "error";
    if (cause === "closed") return quiet();
    if (cause === "quota")
      return stop({ kind: "stopped", cause: "storage_full" }, issued.mode);
    const recorded = recordStop(
      deps.markers,
      service,
      operation,
      () => service.live,
      {
        hold: () => memoryStops.add(memoryKey(service, operation)),
      },
    );
    if (recorded === "obsolete") return quiet();
    stoppedOperation = operation;
    stoppedVersion = null;
    return stop(
      {
        kind: "stopped",
        cause: "local_storage",
        ...(recorded === "memory" ? { memoryOnly: true as const } : {}),
      },
      issued.mode,
    );
  }

  // ---- helpers ----------------------------------------------------------------------------------------------------------------------
  function retryAfter(response: Response): number | null {
    const raw = response.headers.get("retry-after");
    if (raw === null) return null;
    const seconds = Number(raw);
    return Number.isFinite(seconds) && seconds >= 0
      ? Math.round(seconds * 1000)
      : null;
  }
  async function errorCode(response: Response): Promise<string | null> {
    try {
      const body = new Uint8Array(await response.arrayBuffer());
      if (body.length > 8 * 1024) return null;
      const parsed: unknown = JSON.parse(new TextDecoder().decode(body));
      const code = (parsed as { code?: unknown })?.code;
      return typeof code === "string" ? code : null;
    } catch {
      return null;
    }
  }

  const unbind = (): void => {
    for (const off of offs) off();
    offs = [];
    clearTimer();
  };

  return {
    registered: true,
    state,
    exclusive,
    active,
    notice,
    request(reason) {
      // The engine invalidated the cache (W18) and asks for recovery: the snapshot begins at the next step.
      trigger = reason;
      endEpisode();
      if (reason === "resync_required" || reason === "access_changed")
        notice.set({ reason, id: `${deps.clock.now()}:${reason}` });
      if (binding !== null) {
        exclusive.set(true);
        setState({
          kind: "running",
          mode: handle === null ? "ordinary" : "recovery",
          path: "snapshot",
        });
        void tick();
      }
    },
    acknowledge(id) {
      if (notice.get()?.id === id) notice.set(null);
    },
    bind(next) {
      unbind();
      bindings += 1;
      handle = null;
      commitProof = null;
      quotaStop = null;
      endEpisode();
      failures = 0;
      notSent = 0;
      beginWaits = 0;
      unverified = 0;
      finishWaits = 0;
      stoppedOperation = null;
      if (next === null) {
        binding = null;
        exclusive.set(false);
        setState({ kind: "idle" });
        if (reported !== null) report(null);
        resolveWaiters();
        return;
      }
      const b: Binding = {
        id: bindings,
        service: next.service,
        ownership: next.ownership,
      };
      binding = b;
      offs = [
        deps.subscribe(wake),
        deps.onOnline(() => {
          const service = b.service;
          void service.store
            .run(resumeReadCallerOnOnline, {
              incarnationId: service.incarnationId,
              caller: "sync",
              unrecognisedAfter: config.unrecognisedPauseAfter,
            })
            .catch(() => undefined)
            .then(() => {
              // DA-N1: connectivity returning is no "Try again" for a quota stop.
              if (alive(b) && !quotaHeld()) {
                // Connectivity returned: a new opportunity, with its immediate retries (an admission episode ends with it).
                failures = 0;
                notSent = 0;
                endEpisode();
                void tick();
              }
            });
        }),
      ];
      const abort = (): void => {
        if (binding?.id === b.id) {
          clearTimer();
          resolveWaiters();
        }
      };
      next.ownership.signal.addEventListener("abort", abort, { once: true });
      offs.push(() =>
        next.ownership.signal.removeEventListener("abort", abort),
      );
      void tick();
    },
    retryNow() {
      const b = binding;
      if (b === null) return;
      const service = b.service;
      const current = state.get();
      void (async () => {
        try {
          if (current.kind === "stopped" && current.cause === "sync_blocked") {
            // "Try again": a fresh three-attempt budget for the whole attempt (W25, for the failure the person saw); either way one
            // attempt is permitted, subject to the same counters (the cursor-less one is not reset).
            if (blockedSeen === "attempts" && blockedVersion !== null)
              await service.store.run(resetRecoveryBudget, {
                incarnationId: service.incarnationId,
                expect: blockedVersion,
              });
            permitBlocked = true;
          }
          if (
            current.kind === "paused" ||
            current.kind === "backing_off" ||
            (current.kind === "stopped" && current.cause === "unrecognised")
          )
            await service.store.run(resumeReadCaller, {
              incarnationId: service.incarnationId,
              caller: "sync",
            });
          if (current.kind === "stopped" && current.cause === "floor")
            await service.store.run(resetSizingFloor, {
              incarnationId: service.incarnationId,
            });
          if (
            current.kind === "stopped" &&
            (current.cause === "local_storage" ||
              // WEB-08c revision 4 (DA-N1): a recovery quota stop names the page's operation, whose marker this retry retires.
              current.cause === "storage_full") &&
            stoppedOperation !== null
          ) {
            const operation = stoppedOperation;
            memoryStops.delete(memoryKey(service, operation));
            const seen = deps.markers?.witness(service, operation);
            if (seen !== undefined)
              deps.markers?.retire(service, operation, seen, {
                explicit: true,
              });
            await service.store.run(recordLocalWriteOutcome, {
              incarnationId: service.incarnationId,
              operation,
              outcome: { kind: "success", expect: stoppedVersion },
            });
            stoppedOperation = null;
          }
        } catch {
          // Best effort: the next step reads the record again.
        }
        failures = 0;
        quotaStop = null;
        if (alive(b)) {
          // The person's act ends an admission episode too: one fresh attempt, with its immediate retries.
          notSent = 0;
          endEpisode();
          setState({ kind: "idle" });
          void tick();
        }
      })();
    },
    settled() {
      if (!busy && timer === null) return Promise.resolve();
      return new Promise<void>((resolve) => waiters.push(resolve));
    },
  };
}
