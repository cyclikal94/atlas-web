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
import type { RecoveryPhase, SyncChannel } from "../engine/sync-channel";
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
  /** Publishes the page's leadership for the status model (the page host). */
  publish(attachment: LeaderAttachment): void;
  elapsed?: () => number;
  trace?: Trace;
  config?: Partial<typeof DATA_CONFIG>;
}

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
   * `atlas-sync`). The leading page now announces each report for the identity it serves, as a HINT; a page that does not lead shows the
   * same card when the hint names exactly its own (account, epoch), and asks for the standing report when it starts or its identity
   * changes. The hint changes only which neutral card is shown: what may be displayed is decided by the record and the exposure protocol.
   */
  let announced: {
    account: AccountId;
    epoch: number;
    phase: RecoveryPhase;
  } | null = null;
  /**
   * The latest report the leading page announced for THIS page's identity (a hint, kept), and the report this page's session was last
   * given. A report only chooses between the recovery cards (2 and 3), and every `recovery.report` makes the session evaluate again, so a
   * page is given a report only while it SHOWS card 2 or 3 and only when it changes it. A page that is gated, hidden, frozen or displaying
   * is never woken by a hint (found by T22 (i): a hidden page that adopted the switching leader's report evaluated and closed its display
   * before the resume; a frozen Chromium page receives queued broadcasts on unfreeze, before `visible`); it takes the kept report when it
   * comes to show the card.
   */
  let hinted: {
    account: AccountId;
    epoch: number;
    phase: "catching_up" | "failed" | null;
  } | null = null;
  let applied: "catching_up" | "failed" | null = null;
  let asked: string | null = null;
  const showingRecoveryCard = (): boolean => {
    const view = deps.view.get();
    return (
      view.kind === "neutral" && (view.state === "2" || view.state === "3")
    );
  };
  const applyHinted = (): void => {
    if (leading()) return;
    const identity = deps.identity.get();
    const kept = hinted;
    const next =
      kept !== null &&
      identity !== null &&
      kept.account === identity.account_id &&
      kept.epoch === identity.epoch
        ? kept.phase
        : null;
    if (next === applied) return;
    // Not showing the recovery card: nothing to change, nothing woken. (Withdrawing one is always allowed: it follows the evaluation that
    // changed the identity, or the leader's own report.)
    if (next !== null && !showingRecoveryCard()) return;
    applied = next;
    deps.recovery.report(next);
  };
  const recovery: SyncLeaderDeps["recovery"] = {
    begin: (account) => deps.recovery.begin(account),
    finish: (handle) => deps.recovery.finish(handle),
    report(phase) {
      deps.recovery.report(phase);
      const identity = deps.identity.get();
      if (identity === null) return;
      announced = {
        account: identity.account_id,
        epoch: identity.epoch,
        phase: phase ?? "none",
      };
      deps.channel.post({ type: "recovery_state", ...announced });
    },
  };
  const adoptReport = (message: {
    account: AccountId;
    epoch: number;
    phase: RecoveryPhase;
  }): void => {
    const identity = deps.identity.get();
    if (
      identity === null ||
      identity.account_id !== message.account ||
      identity.epoch !== message.epoch
    )
      return;
    hinted = {
      account: message.account,
      epoch: message.epoch,
      phase: message.phase === "none" ? null : message.phase,
    };
    applyHinted();
  };
  /** A page that does not lead: follow the kept report (its card or identity may have changed), and ask once per identity for it. */
  const askForReport = (): void => {
    applyHinted();
    const identity = deps.identity.get();
    const key =
      identity === null ? null : `${identity.account_id}:${identity.epoch}`;
    if (identity === null || key === asked) return;
    asked = key;
    deps.channel.post({
      type: "recovery_state_query",
      account: identity.account_id,
      epoch: identity.epoch,
    });
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
      asked = null;
      hinted = null;
      if (applied !== null) {
        applied = null;
        deps.recovery.report(null);
      }
    } else askForReport();
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
      deps.channel.post({
        type: "retry_requested",
        account: target.account,
        epoch: target.epoch,
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
            const standing = announced;
            if (
              leading() &&
              standing !== null &&
              // No report is the asking page's default: nothing to send.
              standing.phase !== "none" &&
              standing.account === message.account &&
              standing.epoch === message.epoch
            )
              deps.channel.post({ type: "recovery_state", ...standing });
            return;
          }
          if (message.type === "retry_requested") {
            retryHere({ account: message.account, epoch: message.epoch });
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
      unbind();
      deps.election.dispose();
      deps.publish({ role: "none" });
    },
  };
}
