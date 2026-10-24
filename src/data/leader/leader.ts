import type {
  ApiCompatibility,
  Identity,
  Recovery,
  SessionView,
  StampedFetch,
  Store,
  Trace,
} from "../../session";
import type { AccountService, DataRuntime } from "../engine/account-service";
import {
  createOutboxDispatcher,
  type OutboxDispatcher,
} from "../engine/outbox-dispatcher";
import type { QuotaGuard } from "../engine/quota-guard";
import {
  createRecoveryJob,
  type RecoveryJob,
  type RecoveryJobDeps,
} from "../engine/recovery-job";
import type {
  RecoveryPhase,
  SyncChannel,
  SyncMessage,
} from "../engine/sync-channel";
import {
  createSyncEngine,
  type SyncEngine,
  type SyncOwnership,
} from "../engine/sync-engine";
import type { WriteFailureMarkers } from "../engine/write-failure-marker";
import { DATA_CONFIG } from "../model/config";
import type { DeviceSignals } from "../model/sizing";
import type { AccountId } from "../model/types";
import { createOutbox, type Outbox } from "../outbox/outbox";
import type { ConflictHandlerRegistry } from "../outbox/registries";
import { acquireOwnership } from "../plans/recovery-writers";
import type { DecodeDeps } from "../scan/validate";
import type { LeaderElection, LeaderRole } from "./election";
import type { LeaderAttachment } from "./page-host";

/**
 * The production sync leader of one page (P-1 to P-8): the election, the binding of the leading page to the settled account, the
 * ownership of that account's database, and the three writers that run only in the leader: the sync engine, the outbox dispatcher and
 * the recovery job. React-free; it lives at SESSION level (P-3), outside the protected tree, so it keeps running while the account is
 * fenced and the tree is unmounted, which is exactly when recovery must run (matrix 3.7.1, 3.7.3).
 *
 *  - The lock is the election's and is never released on a transition (P-1): the leader re-points itself by REBINDING.
 *  - A BINDING is (leader, account, incarnation): one `AbortController`, one ownership token (W20), and the engine, dispatcher and job
 *    started with `{ token, signal }`. A new identity, an ended service or a lost lead aborts it; the next binding writes a new token,
 *    so any answer of the old one is dropped by the guards (OWN, GEN, STG, the incarnation).
 *  - An open that is refused, closed or abandoned is UNKNOWN, never absence: the leader looks again on the next notification, paced.
 *  - It NEVER reopens by itself when its service ends (a wipe's latch, another tab's deletion or upgrade): a reopening would lift the
 *    latch of the closure (an existing database is opened without the may-create predicate). Only the session's next notification
 *    looks again, and no database is opened at all while a logout or retirement is pending for the account (row 3).
 *  - While the job needs the cache (`exclusive`) the engine is stopped, so one `/sync` is in flight; it is started again, with the same
 *    ownership, when the job is done. The dispatcher keeps running (its covers are closed under a fence; drafts stay interactive, D 4.1).
 */
export interface SyncLeaderDeps {
  election: LeaderElection;
  runtime: DataRuntime;
  /** The page registry's tab id (`sync_state.owner.tab_id`). */
  tabId: string;
  identity: Store<Identity | null>;
  view: Store<SessionView>;
  compat: Store<ApiCompatibility>;
  fetchFor(
    klass: "ordinary" | "recovery",
    account: AccountId,
    epoch: number,
  ): StampedFetch;
  recovery: Pick<Recovery, "begin" | "finish" | "report">;
  /** `session.api.admission`: the recovery job's admission waits probe it (R3). */
  admission: RecoveryJobDeps["admission"];
  /** `session.operations.pending` names the account (the outbox's stale-fence reconciliation). */
  operationPending(account: AccountId): boolean;
  apiUrl(path: string): URL;
  online(): boolean;
  /** Fires when eligibility may have changed: the session view, the identity, visibility. */
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
  channel: SyncChannel;
  markers: WriteFailureMarkers;
  conflicts: ConflictHandlerRegistry;
  ids: { uuid(): string };
  /**
   * Whether the page is visible (WEB-08c revision 4): a hidden page neither asks for nor applies the recovery report (absent: visible).
   * `subscribe` fires when it changes.
   */
  visible?(): boolean;
  /** Publishes the page's leadership for the status model (the page host). */
  publish(attachment: LeaderAttachment): void;
  elapsed?: () => number;
  trace?: Trace;
  config?: Partial<typeof DATA_CONFIG>;
}

/** WEB-08c revision 4 (R9): the paced recovery-report question of a page that does not lead: first after 1 s, doubling to 30 s. */
export const STATUS_ASK_MS = 1_000;
export const STATUS_ASK_MAX_MS = 30_000;

export interface LeaderBinding {
  readonly account: AccountId;
  readonly incarnationId: string;
  readonly token: string;
}

export interface SyncLeader {
  readonly role: Store<LeaderRole>;
  readonly engine: SyncEngine;
  readonly dispatcher: OutboxDispatcher;
  readonly job: RecoveryJob;
  /** The bound account's facade, for the leader page's own screens; null while unbound. */
  outbox(): Outbox | null;
  /**
   * The person's retry of UPDATES (R2 of the review of 10 October 2026), wherever it was pressed: the recovery job's own retry while it
   * stands in a state of its own (a stop, a pause, a back-off, a refusal of `begin`), else the engine's. Applied only while this page leads
   * and is bound to `account` at `epoch` (the act was made against that account's view); otherwise, from a page that does not lead, it is
   * asked of the leading page on `atlas-sync`. Never a permission: each retry is versioned on the failure that stands.
   */
  retryUpdates(target: { account: AccountId; epoch: number }): void;
  readonly binding: Store<LeaderBinding | null>;
  /** Starts the election (idempotent). */
  start(): void;
  /** Tests and HMR only. */
  dispose(): void;
}

class Cell<T> implements Store<T> {
  private listeners = new Set<() => void>();
  constructor(private value: T) {}
  get(): T {
    return this.value;
  }
  set(next: T): void {
    if (Object.is(next, this.value)) return;
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

interface Bound {
  readonly account: AccountId;
  readonly service: AccountService;
  readonly token: string;
  readonly controller: AbortController;
  readonly ownership: SyncOwnership;
  readonly outbox: Outbox;
  offs: Array<() => void>;
}

export function createSyncLeader(deps: SyncLeaderDeps): SyncLeader {
  const binding = new Cell<LeaderBinding | null>(null);
  let bound: Bound | null = null;
  let attempt = 0;
  let opening: { account: AccountId; id: number } | null = null;
  let retryTimer: unknown = null;
  let retries = 0;
  let engineRunning = false;
  let disposed = false;

  const service = (): AccountService | null =>
    bound?.service.live === true ? bound.service : null;

  /**
   * WEB-08c revision 3 (R5 of the review of 14 October 2026, T24 D; design assessment S9): the recovery job's report ("Catching up",
   * state 2; "Couldn't finish catching up", state 3) was the page memory of the LEADING page only, so every other page of the account kept
   * saying "Catching up" after the recovery had stopped, and offered no "Try again" (which already reaches the leading page on
   * `atlas-sync`). The leading page announces each report for the identity it serves, as a HINT; it changes only which neutral card is
   * shown: what may be displayed is decided by the record and the exposure protocol.
   *
   * WEB-08c revision 4 (R9 of the review of 14 October 2026; design assessment P2/P3, S1-S11): a one-shot hint is not reliable state.
   *  - Completion is never learned from a hint: the session withdraws a report at its own record read once the fence is gone (R9), and a
   *    page that shows state 2 or 3 reads its record again, paced. A lost "none" therefore cannot keep a page gated.
   *  - Every report carries its PRODUCER (this leader) and a sequence: a page ignores an older or repeated report of the same producer, so a
   *    late "failed" or "none" cannot replace a newer one. A producer that no longer leads, or is unbinding, announces nothing: an old owner
   *    never withdraws its successor's report.
   *  - A page that does not lead ASKS for the standing report while it shows state 2 or 3 and is visible, paced (`STATUS_ASK_MS` doubling
   *    to `STATUS_ASK_MAX_MS`), and the leading page answers every matching question with its current report, "none" included. A lost
   *    report, question or answer only delays it. With no working channel at all a follower cannot learn of the failure, nor send its
   *    retry: the accepted limit D1 of RECOVERY-NAVIGATION-ENROLMENT-20261014.
   *  - A report is applied only while the page SHOWS state 2 or 3 and is visible, and only when it changes the card (3 or not 3). A page
   *    that is gated, hidden, frozen or displaying is never woken by one (T22 (i), revision 3); it takes the kept report when it comes to
   *    show the card.
   *  - "failed" names its failure (`failure`); a retry pressed on a follower names the failure it saw, and the leading page applies it only
   *    while that same failure stands (S11).
   */
  const producer = deps.ids.uuid();
  let producerSeq = 0;
  let failureSeq = 0;
  let announced: {
    account: AccountId;
    epoch: number;
    phase: RecoveryPhase;
    failure: string | null;
  } | null = null;
  const postStatus = (): void => {
    const standing = announced;
    if (standing === null) return;
    producerSeq += 1;
    deps.channel.post({
      type: "recovery_state",
      account: standing.account,
      epoch: standing.epoch,
      phase: standing.phase,
      producer,
      seq: producerSeq,
      ...(standing.failure === null ? {} : { failure: standing.failure }),
    });
  };
  /** The latest report of the leading page for THIS page's identity, ordered per producer (a page that does not lead). */
  let status: {
    account: AccountId;
    epoch: number;
    phase: RecoveryPhase;
    failure: string | null;
    producer: string;
    seq: number;
  } | null = null;
  const visible = (): boolean => deps.visible?.() ?? true;
  const showingRecoveryCard = (): boolean => {
    const view = deps.view.get();
    return (
      view.kind === "neutral" && (view.state === "2" || view.state === "3")
    );
  };
  const ownStatus = (): typeof status => {
    const identity = deps.identity.get();
    const kept = status;
    return kept !== null &&
      identity !== null &&
      kept.account === identity.account_id &&
      kept.epoch === identity.epoch
      ? kept
      : null;
  };
  /**
   * What this page last gave its session (phase and identity), while it shows a recovery card: a report is given once, and again only
   * when the card it shows contradicts it (the session withdrew it at its own read). Forgotten when the page shows something else.
   */
  let given: {
    failed: boolean;
    key: string;
  } | null = null;
  /** Gives the session the kept report when it changes the card this visible page shows (3, or not 3). */
  const applyStatus = (): void => {
    if (leading() || !showingRecoveryCard() || !visible()) return;
    const identity = deps.identity.get();
    if (identity === null) return;
    const kept = ownStatus();
    const failed = kept?.phase === "failed";
    const view = deps.view.get();
    const showsFailed = view.kind === "neutral" && view.state === "3";
    if (failed === showsFailed) return;
    const phase = failed
      ? "failed"
      : kept?.phase === "catching_up"
        ? "catching_up"
        : null;
    const key = JSON.stringify([phase, identity.account_id, identity.epoch]);
    // Given already and its evaluation not yet shown: nothing more (an identical report is applied once).
    if (given?.key === key) return;
    given = { failed, key };
    deps.recovery.report(phase, {
      account: identity.account_id,
      epoch: identity.epoch,
    });
  };
  const recovery: SyncLeaderDeps["recovery"] = {
    begin: (account) => deps.recovery.begin(account),
    finish: (handle) => deps.recovery.finish(handle),
    report(phase, scope) {
      deps.recovery.report(phase, scope);
      // Only the producer that leads AND is bound announces: an unbinding or superseded one withdraws nothing on the channel.
      const b = bound;
      if (!leading() || b === null || scope === undefined) return;
      if (scope.account !== b.account) return;
      const same =
        announced !== null &&
        announced.account === scope.account &&
        announced.epoch === scope.epoch;
      let failure: string | null = null;
      if (phase === "failed") {
        // The same failure while it stands; a new one after any other report (a retry, a new run) or identity.
        if (same && announced?.phase === "failed" && announced.failure !== null)
          failure = announced.failure;
        else {
          failureSeq += 1;
          failure = `${producer}:${failureSeq}`;
        }
      }
      announced = {
        account: scope.account,
        epoch: scope.epoch,
        phase: phase ?? "none",
        failure,
      };
      postStatus();
    },
  };
  const adoptReport = (
    message: Extract<SyncMessage, { type: "recovery_state" }>,
  ): void => {
    if (leading()) return;
    const identity = deps.identity.get();
    if (
      identity === null ||
      identity.account_id !== message.account ||
      identity.epoch !== message.epoch
    )
      return;
    const kept = ownStatus();
    if (
      kept !== null &&
      kept.producer === message.producer &&
      message.seq <= kept.seq
    )
      return;
    status = {
      account: message.account,
      epoch: message.epoch,
      phase: message.phase,
      failure: message.failure ?? null,
      producer: message.producer,
      seq: message.seq,
    };
    deps.trace?.emit("data.recovery_status", { phase: message.phase });
    applyStatus();
  };
  /** The paced question of a page that does not lead (one chain at a time, per identity). */
  let asking: { key: string; timer: unknown } | null = null;
  const stopAsking = (): void => {
    if (asking !== null) deps.clock.clearTimeout(asking.timer);
    asking = null;
  };
  const askChain = (key: string, delay: number): void => {
    const identity = deps.identity.get();
    if (identity === null) return;
    deps.channel.post({
      type: "recovery_state_query",
      account: identity.account_id,
      epoch: identity.epoch,
    });
    asking = {
      key,
      timer: deps.clock.setTimeout(() => {
        if (asking?.key !== key) return;
        asking = null;
        followStatus(Math.min(delay * 2, STATUS_ASK_MAX_MS));
      }, delay),
    };
  };
  /**
   * A page that does not lead: apply the kept report, and ask (paced) while it shows state 2 or 3 and is visible. Stops asking when it
   * leads, its identity changes, the card goes or it is hidden.
   */
  const followStatus = (delay = STATUS_ASK_MS): void => {
    if (disposed) return;
    const identity = deps.identity.get();
    if (!showingRecoveryCard()) given = null;
    else if (given !== null) {
      // The card now shows what was given (or the session withdrew it): a later contradiction is news again.
      const view = deps.view.get();
      const showsFailed = view.kind === "neutral" && view.state === "3";
      if (showsFailed === given.failed) given = null;
    }
    if (
      leading() ||
      identity === null ||
      !showingRecoveryCard() ||
      !visible()
    ) {
      stopAsking();
      return;
    }
    applyStatus();
    const key = `${identity.account_id}:${identity.epoch}`;
    if (asking !== null && asking.key === key) return;
    stopAsking();
    askChain(key, delay);
  };

  const job = createRecoveryJob({
    identity: deps.identity,
    view: deps.view,
    fetchFor: deps.fetchFor,
    recovery,
    admission: deps.admission,
    apiUrl: deps.apiUrl,
    online: deps.online,
    subscribe: deps.subscribe,
    onOnline: deps.onOnline,
    clock: deps.clock,
    yield: deps.yield,
    decode: deps.decode,
    quota: deps.quota,
    signals: deps.signals,
    channel: deps.channel,
    markers: deps.markers,
    ids: deps.ids,
    ...(deps.elapsed ? { elapsed: deps.elapsed } : {}),
    ...(deps.trace ? { trace: deps.trace } : {}),
    ...(deps.config ? { config: deps.config } : {}),
  });
  const engine = createSyncEngine({
    service,
    identity: deps.identity,
    fetchFor: (account, epoch) => deps.fetchFor("ordinary", account, epoch),
    apiUrl: deps.apiUrl,
    online: deps.online,
    subscribe: deps.subscribe,
    onOnline: deps.onOnline,
    clock: deps.clock,
    yield: deps.yield,
    decode: deps.decode,
    quota: deps.quota,
    signals: deps.signals,
    recovery: job,
    channel: deps.channel,
    markers: deps.markers,
    ids: deps.ids,
    ...(deps.elapsed ? { elapsed: deps.elapsed } : {}),
    ...(deps.trace ? { trace: deps.trace } : {}),
    ...(deps.config ? { config: deps.config } : {}),
  });
  const dispatcher = createOutboxDispatcher({
    service,
    identity: deps.identity,
    fetchFor: (account, epoch) => deps.fetchFor("ordinary", account, epoch),
    apiUrl: deps.apiUrl,
    online: deps.online,
    compat: deps.compat,
    subscribe: deps.subscribe,
    onOnline: deps.onOnline,
    clock: deps.clock,
    yield: deps.yield,
    conflicts: deps.conflicts,
    receipt: () => engine.nudge("receipt"),
    channel: deps.channel,
    markers: deps.markers,
    ...(deps.trace ? { trace: deps.trace } : {}),
    ...(deps.config ? { config: deps.config } : {}),
  });

  const leading = (): boolean => deps.election.role.get().kind === "leader";

  const retryHere = (target: {
    account: AccountId;
    epoch: number;
    failure?: string;
  }): boolean => {
    const b = bound;
    const identity = deps.identity.get();
    if (
      !leading() ||
      b === null ||
      !b.service.live ||
      b.account !== target.account ||
      identity === null ||
      identity.account_id !== target.account ||
      identity.epoch !== target.epoch
    )
      return false;
    // WEB-08c revision 4 (S11): a retry pressed against a recovery failure acts only while that failure stands (an older one is spent).
    if (
      target.failure !== undefined &&
      (announced === null ||
        announced.phase !== "failed" ||
        announced.failure !== target.failure)
    )
      return true;
    const state = job.state.get();
    if (
      state.kind === "stopped" ||
      state.kind === "paused" ||
      state.kind === "backing_off" ||
      state.kind === "eligible_wait" ||
      state.kind === "admission_wait" ||
      job.exclusive.get()
    )
      job.retryNow();
    else engine.retryNow();
    return true;
  };

  const publish = (): void => {
    if (!leading()) {
      deps.publish(
        deps.election.role.get().kind === "follower"
          ? { role: "follower" }
          : { role: "none" },
      );
      return;
    }
    deps.publish({
      role: "leader",
      engine,
      outbox: bound?.outbox ?? null,
      recovery: job,
    });
  };

  /**
   * The engine and the dispatcher run only while the binding stands AND its account is DISPLAYED (P-8, corrected by the integration run
   * of 10 October 2026): while the account is fenced or not yet exposed, neither may send anything, and a request they try is refused
   * by the session, whose re-evaluation then notifies them again: a loop of refused requests for as long as the fence stands. The
   * recovery job is what reads while fenced. The engine also stops while the job has the cache to itself (`exclusive`).
   */
  const displayed = (account: AccountId): boolean => {
    const view = deps.view.get();
    return view.kind === "displaying" && view.account_id === account;
  };
  let dispatching = false;
  const exclusion = (): void => {
    const b = bound;
    const live = b?.service.live === true && displayed(b.account);
    const sending = live && b !== null;
    if (sending && !dispatching && b !== null) {
      dispatching = true;
      dispatcher.start(b.ownership);
    } else if (!sending && dispatching) {
      dispatching = false;
      dispatcher.stop();
    }
    const wanted = live && !job.exclusive.get();
    if (wanted && b !== null && !engineRunning) {
      engineRunning = true;
      engine.start(b.ownership);
    } else if (!wanted && engineRunning) {
      engineRunning = false;
      engine.stop();
    }
  };

  const unbind = (): void => {
    const b = bound;
    if (b === null) return;
    bound = null;
    for (const off of b.offs) off();
    b.controller.abort();
    job.bind(null);
    if (dispatching) {
      dispatching = false;
      dispatcher.stop();
    }
    if (engineRunning) {
      engineRunning = false;
      engine.stop();
    }
    b.outbox.disposeObservation();
    binding.set(null);
    publish();
  };

  const cancelRetry = (): void => {
    if (retryTimer !== null) deps.clock.clearTimeout(retryTimer);
    retryTimer = null;
  };
  /** An open or an ownership that could not be had is UNKNOWN: look again, paced, never treat it as absence. */
  const retryLater = (): void => {
    if (retryTimer !== null || disposed) return;
    const wait = Math.min(
      DATA_CONFIG.factsReadRetryMaxMs,
      DATA_CONFIG.factsReadRetryMs * 2 ** Math.min(retries, 8),
    );
    retries += 1;
    retryTimer = deps.clock.setTimeout(() => {
      retryTimer = null;
      follow();
    }, wait);
  };

  const bind = async (account: AccountId): Promise<void> => {
    const id = ++attempt;
    opening = { account, id };
    const current = (): boolean =>
      !disposed &&
      id === attempt &&
      leading() &&
      deps.identity.get()?.account_id === account;
    let outcome: Awaited<ReturnType<DataRuntime["open"]>>;
    try {
      // The may-create predicate decides (identity is the account, no logout or retirement pending, R36): the first sync creates it.
      outcome = await deps.runtime.open(account, { create: true });
    } catch {
      if (opening?.id === id) opening = null;
      if (current()) retryLater();
      return;
    }
    if (opening?.id === id) opening = null;
    if (!current()) return;
    if (outcome.kind !== "opened" || !outcome.service.live) {
      // `operation_pending` (row 3: a logout or retirement is unresolved) is waited for on the session's notification: no timer.
      if (outcome.kind !== "refused" || outcome.reason !== "operation_pending")
        retryLater();
      return;
    }
    const service = outcome.service;
    const token = deps.ids.uuid();
    let owned: Awaited<ReturnType<typeof runAcquire>>;
    const runAcquire = () =>
      service.store.run(acquireOwnership, {
        incarnationId: service.incarnationId,
        tabId: deps.tabId,
        token,
        now: deps.clock.now(),
        ...(deps.config ? { config: deps.config } : {}),
      });
    try {
      owned = await runAcquire();
    } catch {
      if (current()) retryLater();
      return;
    }
    if (!current() || !service.live) return;
    if (owned.kind !== "owned") {
      // A closing fence (a wipe under way) or no singleton: no ownership, nothing sent. The session's next notification looks again.
      retryLater();
      return;
    }
    retries = 0;
    cancelRetry();
    unbind();
    const controller = new AbortController();
    const ownership: SyncOwnership = { token, signal: controller.signal };
    const outbox = createOutbox({
      service,
      quota: deps.quota,
      ids: deps.ids,
      clock: deps.clock,
      fence: () => ({
        hasPendingOperation: deps.operationPending(account),
        sessionStarted: true,
      }),
      dispatcher,
      channel: deps.channel,
      markers: deps.markers,
      timers: {
        setTimeout: deps.clock.setTimeout,
        clearTimeout: deps.clock.clearTimeout,
      },
      ...(deps.config ? { config: deps.config } : {}),
    });
    const b: Bound = {
      account,
      service,
      token,
      controller,
      ownership,
      outbox,
      offs: [],
    };
    bound = b;
    b.offs.push(
      service.onEnd(() => {
        // Not followed by a look of its own: whatever closed the service (the identity, a wipe, a deletion, an upgrade) is followed by
        // the session's notifications, and a reopening now would lift a closure's latch.
        if (bound === b) unbind();
      }),
    );
    binding.set({ account, incarnationId: service.incarnationId, token });
    publish();
    job.bind({ service, ownership });
    exclusion();
  };

  const follow = (): void => {
    if (disposed) return;
    if (leading()) {
      // The page leads now: its own job reports; a card adopted from the previous leader is no longer this page's to keep.
      stopAsking();
      const adopted = status !== null;
      status = null;
      const view = deps.view.get();
      if (adopted && view.kind === "neutral" && view.state === "3")
        deps.recovery.report(null);
    } else followStatus();
    if (!leading()) {
      attempt += 1;
      opening = null;
      cancelRetry();
      unbind();
      publish();
      return;
    }
    const identity = deps.identity.get();
    if (identity === null) {
      attempt += 1;
      opening = null;
      cancelRetry();
      unbind();
      return;
    }
    const b = bound;
    if (b !== null && b.account === identity.account_id && b.service.live)
      return;
    if (b !== null) unbind();
    if (opening?.account === identity.account_id) return;
    if (retryTimer !== null) return;
    // Row 3: a logout or retirement is unresolved for this account: no database is opened or created, nothing is sent.
    if (deps.operationPending(identity.account_id)) return;
    void bind(identity.account_id);
  };

  let offs: Array<() => void> = [];
  return {
    role: deps.election.role,
    engine,
    dispatcher,
    job,
    outbox: () => bound?.outbox ?? null,
    retryUpdates(target) {
      if (disposed) return;
      if (retryHere(target)) return;
      // A follower's retry on state 3 names the failure it saw (S11).
      const kept = ownStatus();
      const failure =
        kept !== null &&
        kept.account === target.account &&
        kept.epoch === target.epoch &&
        kept.phase === "failed" &&
        kept.failure !== null &&
        showingRecoveryCard()
          ? kept.failure
          : undefined;
      deps.channel.post({
        type: "retry_requested",
        account: target.account,
        epoch: target.epoch,
        ...(failure === undefined ? {} : { failure }),
      });
    },
    binding,
    start() {
      if (offs.length > 0 || disposed) return;
      offs = [
        deps.election.role.subscribe(() => {
          publish();
          follow();
        }),
        deps.identity.subscribe(follow),
        deps.subscribe(() => {
          follow();
          exclusion();
        }),
        job.exclusive.subscribe(exclusion),
        // A draft saved through ANOTHER facade (this page's screens, or a follower page) is announced on `atlas-sync`; the dispatcher
        // is woken by its own facade only, so the hint is what makes it look now rather than at some unrelated wake.
        deps.channel.subscribe((message) => {
          // Another page's person asked for a retry of updates: this page applies it only if it leads that account at that epoch.
          if (message.type === "recovery_state") {
            adoptReport(message);
            return;
          }
          if (message.type === "recovery_state_query") {
            // Every matching question is answered with the current report, "none" included (R9): only the page that leads and is bound
            // to the account, for its own identity.
            const identity = deps.identity.get();
            if (
              !leading() ||
              bound === null ||
              bound.account !== message.account ||
              identity === null ||
              identity.account_id !== message.account ||
              identity.epoch !== message.epoch
            )
              return;
            if (
              announced === null ||
              announced.account !== message.account ||
              announced.epoch !== message.epoch
            )
              announced = {
                account: message.account,
                epoch: message.epoch,
                phase: "none",
                failure: null,
              };
            postStatus();
            return;
          }
          if (message.type === "retry_requested") {
            retryHere({
              account: message.account,
              epoch: message.epoch,
              ...(message.failure === undefined
                ? {}
                : { failure: message.failure }),
            });
            return;
          }
          if (
            message.type === "data_changed" &&
            bound !== null &&
            message.account === bound.account &&
            message.stores.includes("drafts")
          )
            dispatcher.wake();
        }),
      ];
      publish();
      deps.election.start();
      follow();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const off of offs) off();
      offs = [];
      cancelRetry();
      stopAsking();
      unbind();
      deps.election.dispose();
      deps.publish({ role: "none" });
    },
  };
}
