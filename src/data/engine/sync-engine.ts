import {
  type Identity,
  StampedRequestError,
  type Store,
  type Trace,
} from "../../session";
import { DATA_CONFIG, maxResponseBytesFor } from "../model/config";
import {
  INVALIDATE_PREFIX,
  initialReadRetry,
  invalidateOperation,
  isFailureStatus,
  nextDelay,
  onReadFailure,
  onUnrecognised,
  resumeOnOnline,
} from "../model/retry";
import {
  type DeviceSignals,
  isAllocationError,
  type SizingAction,
  type SizingOutcome,
} from "../model/sizing";
import type {
  AccountId,
  Captured,
  ReadRetryState,
  SizingState,
} from "../model/types";
import { type CommitPageResult, commitPage } from "../plans/commit-page";
import {
  recordLocalWriteOutcome,
  recordReadOutcome,
  resumeReadCaller,
  resumeReadCallerOnOnline,
} from "../plans/retry-state";
import {
  CAPTURE_OPERATION,
  captureRequest,
  type GateReason,
  type InvalidationReason,
  invalidateRecoveryPosition,
  READ_RETRY_OPERATION,
  recordSizingAttempt,
  recordSizingOutcome,
  resetSizingFloor,
  retireSizingAttempt,
  SIZING_OPERATION,
} from "../plans/sync-writers";
import { type ScanOk, type ScanResult, scanSyncPage } from "../scan/scan";
import type { DecodeDeps } from "../scan/validate";
import { isAllocationFailure } from "../store/failure";
import { isStoreFailure } from "../store/port";
import type { AccountService, CommitOutcome } from "./account-service";
import { createPendingWake } from "./pending-wake";
import type { QuotaGuard } from "./quota-guard";
import type { RecoverySeam } from "./recovery-seam";
import type { SyncChannel } from "./sync-channel";
import {
  type MarkerSeen,
  markerStateOf,
  recordStop,
  type WriteFailureMarkers,
} from "./write-failure-marker";

/**
 * What the capture gate saw of each operation's marker when it decided (R51, revision 31): the instance, taken in the transaction that
 * admitted the request. A success that is delivered later (a page applied, an invalidation written) ends the markers the request was
 * admitted over and no newer one: a marker recorded after the gate decided, by another engine or another page, is a failure that this
 * request's answer says nothing about, even at the very position the request was made for.
 */
type GateSaw = ReadonlyMap<string, MarkerSeen>;

/** How many times one page is admitted when the hold it was admitted under ends before its commit begins (the outbox's bound, R28). */
const ADMISSION_ROUNDS = 3;

/**
 * Ordinary delta sync (plan 5.4). One step: gate and capture, request, dispatch on the outcome, one atomic page commit, yield.
 *
 * The engine owns NO decisions about what is safe to store: the plans do (`commitPage` and its guards). It owns the SCHEDULE and
 * the OUTCOME TABLE of `GET /sync` (5.4.3), and nothing about display. In particular:
 *  - an unsent request is not an attempt: `not_sent`, `not_covered`, `closed`, `closed_unresolved`, `stale` and `auth_state`
 *    increment no streak and no back-off;
 *  - the one request path is `session.api.fetchFor("ordinary", account, epoch)`, so every request crosses the write-ahead lease
 *    and the send boundary; the post-decode stamp check is the plan's, inside the commit (docs/session.md, obligation 4);
 *  - ordinary sync reads are NOT paused by the API-compatibility gate (decision D-22): the pause is for queued writes.
 */
export interface SyncOwnership {
  /** WEB-09b's leader election supplies it. `null`: this page is not an elected leader (production, until 09b). */
  readonly token: string | null;
  /** Aborts when leadership is lost. */
  readonly signal: AbortSignal;
}

export type StopCause =
  | "floor"
  | "storage_full"
  | "local_storage"
  | "device_capacity"
  | "unrecognised"
  | "no_recovery";

export type EngineState = (
  | { kind: "not_started" }
  | {
      kind: "waiting";
      reason: "cache_not_valid" | "paused_by_session" | "offline";
    }
  /** A step is in flight. `catchingUp`: the cache may be behind (the first step after a start, and every step after a page with `has_more`). */
  | { kind: "running"; catchingUp: boolean }
  | { kind: "idle"; lastSyncedAt: string | null }
  | { kind: "backing_off"; since: number }
  | { kind: "paused"; since: number }
  /**
   * `memoryOnly`: the stop could be recorded neither durably nor in the account's fallback marker, so it is held in this tab alone
   * and will not survive a reload (the notice says so plainly).
   */
  | {
      kind: "stopped";
      cause: StopCause;
      memoryOnly?: true;
    }
) & {
  /**
   * `invalidating` (R10): the cache is KNOWN to be invalid although the database may still say `valid`, because the write of an
   * invalidation the server ADMITTED (`410`, or `400`/`422` on a sent cursor) is outstanding. The cache gate hides the cache for as
   * long as it holds. It is the engine's `invalidations` as the state reports them, so it does NOT depend on what the engine is doing:
   * on a `stopped` state (the failed write's own stop) and on every other state of a running engine for the displayed service (an
   * offline wake, a retry in flight, a paced wait for a persistence hold that could not verify the commit).
   */
  invalidating?: true;
};

export interface EngineDeps {
  /** The displayed account's service, or null when there is none. */
  service(): AccountService | null;
  identity: Store<Identity | null>;
  /** `session.api.fetchFor("ordinary", account, epoch)`. */
  fetchFor(
    account: AccountId,
    epoch: number,
  ): (request: Request) => Promise<Response>;
  /** The URL of an API path. */
  apiUrl(path: string): URL;
  online(): boolean;
  /** Fires when the page's eligibility may have changed: the session view, the identity, visibility. */
  subscribe(listener: () => void): () => void;
  /**
   * Fires on the browser's own `online` EVENT (not on a reading of `online()`): one of the two triggers that end the sync caller's
   * back-off or pause (the other is its own "Retry now"). An engine that never saw the `offline` that preceded it (a page that was
   * frozen or discarded in between) must still resume, so it is the event that counts, as for the dispatcher.
   */
  onOnline(listener: () => void): () => void;
  clock: {
    now(): number;
    iso(): string;
    random(): number;
    setTimeout(fn: () => void, ms: number): unknown;
    clearTimeout(handle: unknown): void;
  };
  /** Yields to the event loop between pages, outside any transaction (M:1886). */
  yield(): Promise<void>;
  decode: DecodeDeps;
  quota: QuotaGuard;
  signals: DeviceSignals;
  recovery: RecoverySeam;
  channel?: SyncChannel;
  /**
   * The account's write-failure markers (`localStorage`): the fallback record of a local-write stop whose counter could not be
   * written. Absent: such a stop is held in memory only, and says so.
   */
  markers?: WriteFailureMarkers;
  trace?: Trace;
  ids: { uuid(): string };
  elapsed?: () => number;
  /** Overrides for tests (the provisional constants otherwise). */
  config?: Partial<typeof DATA_CONFIG>;
}

/**
 * An invalidation the server ADMITTED (`410`, or `400`/`422` on a sent cursor) that this tab has not been able to write yet (R10,
 * revision 9): the cache at that position is KNOWN to be invalid, whatever the database says. Keyed by the account, the database's
 * incarnation and the operation (`invalidate:<cursor>`), so a hold can only ever hide the position it was admitted for.
 */
export interface InvalidationHold {
  readonly account: AccountId;
  readonly incarnationId: string;
  readonly operation: string;
}

export interface SyncEngine {
  readonly state: Store<EngineState>;
  /**
   * The admitted invalidations whose write is outstanding, for as long as they are: from the first failed write until the guarded
   * write succeeds or the position is superseded by an admitted state change. NOT a function of the engine's execution state, of the
   * failure counter or of a retry: an offline wake, an explicit retry and a persistence hold that cannot verify the commit leave it
   * as it is. The cache gate reads it (keyed by the current position), so the cache stays hidden even when the durable record could
   * be written nowhere (the stop is then held in this tab alone, and a reload loses it: the disclosed limitation).
   */
  readonly invalidations: Store<readonly InvalidationHold[]>;
  start(ownership: SyncOwnership): void;
  stop(): void;
  /** "Retry now" / "Retry applying changes" / "Try again". */
  retryNow(): void;
  /** Something may have changed that sync should look at soon (a receipt was recorded, a follower's hint). */
  nudge(after?: "receipt" | "now"): void;
  /** Resolves once the engine is idle, waiting or stopped (a test hook; also what a caller awaits after `retryNow`). */
  settled(): Promise<void>;
}

class MutableStore<T> implements Store<T> {
  private listeners = new Set<() => void>();
  constructor(private value: T) {}
  get(): T {
    return this.value;
  }
  set(next: T): void {
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

/** Why a step began (a fixed vocabulary, for the trace). */
type TickReason =
  | "start"
  | "timer"
  | "wake"
  | "online"
  | "retry"
  | "nudge"
  | "now";

type Next =
  /** Run another step immediately (after a yield). */
  | { when: "now" }
  /** After this long. */
  | { when: "after"; ms: number }
  /** Only an event (online, a new identity, `retryNow`) wakes it. */
  | { when: "event" };

const sameStop = (a: EngineState, b: EngineState): boolean =>
  JSON.stringify(a) === JSON.stringify(b);

export function createSyncEngine(deps: EngineDeps): SyncEngine {
  const config = { ...DATA_CONFIG, ...deps.config };
  const store = new MutableStore<EngineState>({ kind: "not_started" });
  // The hold on the cache as the state reports it (R10): decided here, once, for every state the engine ever shows, so that no
  // transition (an offline wake, a retry, a wait for the persistence hold) can forget it. A `stopped` state of the failed write names
  // it itself; `not_started` is no engine and reports nothing (the controller reads the keyed `invalidations` for what it knew).
  const withHold = (next: EngineState): EngineState => {
    if (next.kind === "stopped" || next.kind === "not_started") return next;
    const { invalidating: _previous, ...plain } = next;
    const service = deps.service();
    return service !== null && operationsOf(holds.keys(), service).length > 0
      ? { ...plain, invalidating: true }
      : plain;
  };
  const setState = (next: EngineState): void => {
    const shown = withHold(next);
    // A held condition is decided under one service (R23, revision 11): see `holding`.
    if (isHeld(shown)) heldUnder = serviceKey();
    if (!sameStop(store.get(), shown)) store.set(shown);
  };
  /** A hold was added or ended: the state reports it from now on (or no longer), without waiting for the next transition. */
  const republish = (): void => {
    const current = store.get();
    const shown = withHold(current);
    if (!sameStop(current, shown)) store.set(shown);
  };

  // The service (account and incarnation) under which the engine last decided a held condition, or null (R23, revision 11): see `holding`.
  let heldUnder: string | null = null;
  const serviceKey = (): string | null => {
    const service = deps.service();
    return service?.live === true
      ? JSON.stringify([service.account, service.incarnationId])
      : null;
  };
  /**
   * The two conditions that nothing durable re-asserts and that only a deadline, an explicit act or a connectivity change may end
   * (R23, revision 11): a BACK-OFF (a failed read, and the server's `Retry-After`: the deadline is the timer the step set), and the
   * blocking `device_capacity` stop (the server's answer that this device may not sync until one is retired: no automatic retry).
   * Every other pause or stop is held by the durable record or the capture gate, which the next step reads again (a stop of one
   * operation ends when that operation is no longer the current one; a durable pause stays paused), so a step that finds one
   * asks the server for nothing.
   */
  const isHeld = (state: EngineState): boolean =>
    state.kind === "backing_off" ||
    (state.kind === "stopped" && state.cause === "device_capacity");
  /**
   * Whether the engine is under such a condition now. An ORDINARY wake (a notification that something may have changed, an immediate
   * nudge, a receipt) is no evidence that the server has recovered or that a device was retired, so it neither starts a step nor
   * shortens the wait. The condition is the state of ONE service: a service that has ended or been replaced (another account, another
   * incarnation) holds nothing, and the next wake evaluates again.
   */
  const holding = (): boolean =>
    isHeld(store.get()) && heldUnder !== null && heldUnder === serviceKey();

  let ownership: SyncOwnership | null = null;
  let generation = 0;
  let timer: unknown = null;
  let busy = false;
  // A wake that arrived while a step ran (R22): see `pending-wake.ts` and `settle`.
  const wakes = createPendingWake();
  // A receipt nudge that arrived while a step ran: the step's own `schedule` would have cleared the timer it set.
  let receiptNudged = false;
  // An explicit "Retry now" that arrived while a step ran: the one wake that can lift a stop (see `settle`).
  let retried = false;
  let unsubscribe: Array<() => void> = [];
  // The connectivity this engine last READ. The `online` event is the signal (`cameOnline`); an offline-to-online change that was seen
  // only as a reading at a wake (a page whose `online` listener was not the one that woke it) counts as the same signal.
  let lastOnline = true;
  let waiters: Array<() => void> = [];
  // In-memory only: they shape the schedule, never a decision about data.
  let failures = 0;
  let notSent = 0;
  let notCovered = 0;
  let staleRun = 0;
  /** Consecutive steps that found the record of a stop unreadable (R47, revision 29): they pace the next look, and a landed read ends the run. */
  let unreadableRun = 0;
  /** The operations the last step found unreadable (R47, revision 29), so that "Try again" removes the record of exactly those. */
  let unreadableOperations: string[] = [];
  // Commits the persistence hold could not verify in time (a settlement under way): paced, never counted as a failure.
  let unverified = 0;
  /**
   * What this page counted of the `sync` caller's failures that the DATABASE DOES NOT HOLD (R20, revision 9): the write of the retry
   * record failed or could not be verified in time. The bound of the caller (the sustained duration, three unrecognised answers) is
   * enforced from here as long as it stands, so a failing counter never removes it, and the next write that lands carries it into the
   * record (`known`). Keyed by the account and the incarnation it was counted for. Cleared by what ends the caller's trouble in the
   * record too: a page that applied, `online` (a duration pause only), the caller's own explicit retry.
   */
  let unsaved: {
    account: AccountId;
    incarnationId: string;
    state: ReadRetryState;
  } | null = null;
  const unsavedFor = (service: AccountService): ReadRetryState | null =>
    unsaved !== null &&
    unsaved.account === service.account &&
    unsaved.incarnationId === service.incarnationId
      ? unsaved.state
      : null;
  // Whether the cache may be behind the server: true from a start until a page says `has_more: false` (the chip's "Catching up").
  let behind = true;
  // The operation a local-write stop belongs to (`page:<cursor>`, `capture`), so "Try again" clears exactly that one.
  let stoppedOperation: string | null = null;
  /**
   * The version of the durable failure that stood under each operation when this engine last SAW it: from the transaction that counted
   * its own failure and from the capture gate's snapshot (R53, revision 32). The person's "Try again" resets the streak on the version
   * it saw when it was made, so it ends that failure and no other; an operation with no entry is one whose durable streak this engine
   * has not seen, and a reset decided on that ends nothing but an absent streak.
   */
  const stoppedVersions = new Map<string, number>();
  /**
   * Local-write stops that could be recorded NOWHERE durable: neither in the streak nor in the account's fallback marker. This tab's
   * memory is all that holds them, so they are held for as long as the tab lives: across every wake, connectivity signal and receipt
   * nudge, and across a stop and a start of this engine, and they are lifted only by an explicit retry of that very operation (a
   * stop of a PAGE's commit cannot be lifted by that operation's own success, because the gate sends nothing while it stands). A
   * reload loses them: the disclosed limitation. Keyed by account, incarnation and operation, so a deleted and re-created database
   * does not inherit one.
   */
  const memoryStops = new Map<string, number>();
  let memoryHolds = 0;
  const memoryStopKey = (service: AccountService, operation: string): string =>
    JSON.stringify([service.account, service.incarnationId, operation]);
  /**
   * Holds the stop of `operation` in this tab's memory, when its marker could not be written: a stop recorded again is a newer
   * failure (its hold has a number of its own). The hold ends with the operation's recovery, never by a marker arriving late: a
   * marker is written in the step that records the stop (R58), so none can arrive.
   */
  const holdMemory = (key: string): void => {
    memoryHolds += 1;
    memoryStops.set(key, memoryHolds);
  };
  /** The operations among `keys` (built by `memoryStopKey`) that belong to this service's account and incarnation. */
  const operationsOf = (
    keys: Iterable<string>,
    service: AccountService,
  ): string[] =>
    [...keys]
      .map((key) => JSON.parse(key) as [string, string, string])
      .filter(
        ([account, incarnation]) =>
          account === service.account && incarnation === service.incarnationId,
      )
      .map(([, , operation]) => operation);
  /**
   * The admitted invalidations whose write is outstanding (R10, revision 9), published as `invalidations`. A hold is added when the
   * write first fails or its commit cannot be verified, whatever else could or could not be recorded, and removed ONLY when the guarded
   * write succeeds or the position
   * is superseded by an admitted state change (`clearInvalidationRecord`, `gated`). It does not depend on the failure counter, on the
   * stop, on the engine's state or on a retry, and a stop and a start of this engine keep it, as they keep `memoryStops`.
   */
  const holds = new Map<string, InvalidationHold>();
  const holdStore = new MutableStore<readonly InvalidationHold[]>([]);
  const addHold = (service: AccountService, operation: string): void => {
    const key = memoryStopKey(service, operation);
    if (holds.has(key)) return;
    holds.set(key, {
      account: service.account,
      incarnationId: service.incarnationId,
      operation,
    });
    holdStore.set([...holds.values()]);
    republish();
  };
  const dropHolds = (
    service: AccountService,
    only: string | null = null,
  ): void => {
    let changed = false;
    for (const operation of operationsOf(holds.keys(), service))
      if (only === null || operation === only)
        changed = holds.delete(memoryStopKey(service, operation)) || changed;
    if (changed) {
      holdStore.set([...holds.values()]);
      republish();
    }
  };
  /**
   * The stops of an admitted invalidation that an explicit retry has lifted for ONE bounded cycle, with the attempts that cycle has
   * left. The retry does not erase the stop's record (streak, marker, memory stop): it is also what hides the cache, and a retry is not
   * evidence that the cache is valid. It lets the capture gate through (`liftedOperations`) for `localWritePauseAfter` failed writes,
   * and the invalidation's own transaction clears the streak when the write succeeds. In memory only: a stop, a start or a reload ends
   * the cycle, and the next explicit retry begins another.
   */
  const lifted = new Map<string, number>();
  /**
   * The invalidation the server admitted that this page could not write (R10), kept with the stamp it was admitted under. The next
   * step retries the WRITE of exactly that, without asking the server again, and the plan's own guards (the cursor compare-and-set,
   * the recovery generation, the epoch) drop it if the position, the generation or the identity moved on meanwhile, so a stale
   * invalidating response can never hide a newer valid cache. In memory only: a reload finds the failure's durable record (the streak,
   * the fallback marker) instead, which hides the cache and makes the first step ask again.
   */
  let retained: {
    account: AccountId;
    incarnationId: string;
    captured: Captured;
    reason: InvalidationReason;
  } | null = null;
  /**
   * The attempt (R42, revision 23) this page SAW end without landing its page and whose crash-loop marker it could not retire: the
   * retirement's own write failed, or the service had gone. One id per account (the marker is a single slot, so only the newest
   * attempt's can still stand; an id is a fresh UUID, so a stale one can never match another attempt's marker). The next capture of
   * that account's database offers it, and the plan clears a marker that carries it without counting a tab that did not survive. In
   * memory only: a reload cannot know, and reads the marker as it always did (the disclosed limitation of a retirement and a reload
   * that both fail).
   */
  const endedAttempts = new Map<AccountId, string>();

  const alive = (id: number): boolean =>
    id === generation && ownership !== null && !ownership.signal.aborted;

  /**
   * The service a callback was made for ended while it waited (R56): it records nothing and holds nothing of a lifetime that is over.
   * The engine's state is touched only when this run is still the current one (a replacement run's state is its own).
   */
  const lifetimeOver = (id: number): Next => {
    if (alive(id)) setState({ kind: "waiting", reason: "paused_by_session" });
    return { when: "event" };
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

  /**
   * The ownership signal's cleanup belongs to the run that installed it (R26, revision 12). The timer and the waiters it clears are the
   * CURRENT run's, so a signal that has been replaced (a restart, with a new signal or the same one) or stopped must not touch them:
   * its listener is removed when its run ends, and the handler is bound to its generation besides, for a signal that fires while it
   * is being replaced. An already-aborted signal never fires, so it is handled at once.
   */
  let releaseAbort: (() => void) | null = null;
  const unbindAbort = (): void => {
    releaseAbort?.();
    releaseAbort = null;
  };
  const bindAbort = (id: number, signal: AbortSignal): void => {
    unbindAbort();
    const aborted = (): void => {
      if (id !== generation) return;
      clearTimer();
      resolveWaiters();
    };
    if (signal.aborted) {
      aborted();
      return;
    }
    signal.addEventListener("abort", aborted, { once: true });
    releaseAbort = () => signal.removeEventListener("abort", aborted);
  };

  const schedule = (id: number, next: Next): void => {
    clearTimer();
    if (!alive(id)) return;
    if (next.when === "event") {
      resolveWaiters();
      return;
    }
    const ms = next.when === "now" ? 0 : next.ms;
    timer = deps.clock.setTimeout(() => {
      timer = null;
      void tick(id, next.when === "now" ? "now" : "timer");
    }, ms);
    if (next.when === "after") resolveWaiters();
  };

  /**
   * What a step reads to decide whether it may run: the service (account, incarnation, liveness), the identity (account, epoch) and
   * connectivity. A notification that does not change it is not news (`pending-wake.ts`).
   */
  const eligibility = (): string => {
    const service = deps.service();
    const identity = deps.identity.get();
    return [
      service?.account,
      service?.incarnationId,
      service?.live,
      identity?.account_id,
      identity?.epoch,
      deps.online(),
    ].join("|");
  };

  /**
   * The step's own schedule, adjusted for what arrived while it ran (R22, revision 10). A wake that arrives while a step runs cannot
   * start another, and the step may already have read the facts it announced. So it is remembered, and honoured here, once:
   *
   *   * the step left NOTHING scheduled (`event`: it sleeps until the next event, so a dropped wake would be lost for good): evaluate
   *     again now, from the current facts, as an ordinary step (the latch is clean, so only a new wake can ask for another);
   *   * the step set a deadline of its own (a back-off after a failure, the idle poll, a paced retry): the deadline STANDS. It
   *     re-evaluates from the facts it finds then, and a wake never ends a back-off early (that is `online` and "Retry now", which
   *     resume the caller in the record and cost one request each, never two);
   *   * a RECEIPT nudge (a command was accepted: look soon) is the exception that shortens a quiet wait, because the response of the
   *     request that was in flight when the receipt was recorded may not show it; it never shortens a back-off;
   *   * a STOP the step decided (`stopped`) is left only by an explicit retry, whatever else arrives: a notification, `online` or a
   *     nudge that arrived while it was decided changes nothing, and evaluating again would only replace a stop that nothing durable
   *     holds (`no_recovery`: the invalidation landed and no recovery job is registered) by the capture gate's own word for the same
   *     facts (`waiting / cache_not_valid`), so the state would depend on how many wakes happened to arrive (found by E-C6, which pins
   *     the state the landed write leaves). A "Retry now" that arrived during the step is the explicit act, and is evaluated.
   *
   * A wake that arrives while NO step runs is admitted by `admitted` (R23): the deadline of a back-off and the blocking
   * `device_capacity` stop stand there too.
   */
  const settle = (next: Next): Next => {
    const woken = wakes.take();
    const receipt = receiptNudged;
    const retry = retried;
    receiptNudged = false;
    retried = false;
    if (next.when === "event") {
      const stopped = store.get().kind === "stopped";
      if (woken && (retry || !stopped)) return { when: "now" };
      if (receipt && !stopped)
        return { when: "after", ms: config.syncReceiptMs };
      return next;
    }
    if (
      receipt &&
      next.when === "after" &&
      next.ms > config.syncReceiptMs &&
      store.get().kind === "idle"
    )
      return { when: "after", ms: config.syncReceiptMs };
    return next;
  };

  /**
   * Whether a wake may start a step now (R23, revision 11), decided in ONE place for every source, from the condition the engine is in
   * (`holding`) and not from what happens to wake it:
   *
   *   * the engine's own continuations (`start`, a `timer` or `now` it scheduled) and the person's "Retry now" always run: they ARE
   *     the deadline, or the explicit act that ends a hold;
   *   * `online` runs while a back-off stands, because it is one of the two acts that end one (`cameOnline` has resumed the caller in
   *     the record); it does not leave the capacity stop, which only the person's retry leaves;
   *   * a notification (`wake`) and a nudge (`nudge`, the receipt's included) run only when nothing is held. A back-off's `Retry-After`
   *     stands, and a blocking answer is not retried by anything but the person.
   *
   * A wake that is not admitted is dropped, not remembered: what ends the hold (the deadline, `online`, the retry) evaluates from the
   * facts it finds then. A wake that arrives DURING a step is remembered and judged when the step ends (`settle`).
   */
  function admitted(why: TickReason): boolean {
    switch (why) {
      case "wake":
      case "nudge":
        return !holding();
      case "online":
        return !(holding() && store.get().kind === "stopped");
      default:
        return true;
    }
  }

  async function tick(id: number, why: TickReason): Promise<void> {
    if (!alive(id)) return;
    if (busy) {
      deps.trace?.emit("data.sync_tick", { why, coalesced: true });
      // Remembered, not dropped (R22): the step may have read its facts before this wake. A timer and a start are not wakes: the step's
      // own schedule is the timer's answer, and a start while a step of the old run unwinds is handed over below.
      if (why === "wake") wakes.notify(eligibility());
      else if (why !== "timer" && why !== "now" && why !== "start") {
        wakes.signal();
        if (why === "retry") retried = true;
      }
      return;
    }
    // An idle wake is admitted by the same rule as one that arrives during a step (R23, revision 11).
    if (!admitted(why)) {
      deps.trace?.emit("data.sync_wake_held", {
        why,
        state: store.get().kind,
      });
      return;
    }
    deps.trace?.emit("data.sync_tick", { why, coalesced: false });
    busy = true;
    wakes.begin(eligibility());
    try {
      const stepped = await step(id);
      deps.trace?.emit("data.sync_next", {
        when: stepped.when,
        state: store.get().kind,
      });
      if (!alive(id)) return;
      const next = settle(stepped);
      if (next.when === "now") await deps.yield();
      if (!alive(id)) return;
      // A wake that arrived while the step ran is honoured by `settle`; the step's own schedule is always set (revision 9: the loop
      // that stood here left without scheduling what the step had decided, a draft's back-off included).
      schedule(id, next);
    } catch {
      // A defect in a step must never kill the loop silently or spin: stop visibly.
      deps.trace?.emit("data.sync_step_failed");
      setState({ kind: "stopped", cause: "local_storage" });
      schedule(id, { when: "event" });
    } finally {
      busy = false;
      // A `stop()` then `start()` while this loop's step was still waiting (a held response) coalesced the NEW generation's first
      // tick into a loop it does not belong to, and this one then unwound without scheduling anything. Hand over:
      // the current generation runs now, so a restart never depends on an unrelated wake to make progress.
      if (id !== generation && alive(generation))
        void tick(generation, "start");
    }
  }

  // ---- one step -------------------------------------------------------------------------------------------------------------
  async function step(id: number): Promise<Next> {
    const service = deps.service();
    if (!service?.live) {
      setState({ kind: "waiting", reason: "cache_not_valid" });
      return { when: "event" };
    }
    if (!deps.online()) {
      setState({ kind: "waiting", reason: "offline" });
      return { when: "event" };
    }
    const identity = deps.identity.get();
    if (!identity || identity.account_id !== service.account) {
      setState({ kind: "waiting", reason: "paused_by_session" });
      return { when: "event" };
    }

    // The caller's bound as this page counted it, where the database does not hold it (the write of the retry record failed): a pause
    // that only this page's memory holds is still a pause.
    const counted = unsavedFor(service);
    if (counted?.paused === true) {
      setState(
        counted.unrecognised_streak >= config.unrecognisedPauseAfter
          ? { kind: "stopped", cause: "unrecognised" }
          : {
              kind: "paused",
              since: counted.backing_off_since ?? deps.clock.now(),
            },
      );
      return { when: "event" };
    }

    // 1 and 2: the local gate, and the capture of the request (request_seq is incremented when it is captured for issue).
    let capture: Awaited<ReturnType<typeof runCapture>>;
    const gateSaw = new Map<string, MarkerSeen>();
    try {
      capture = await runCapture(service, gateSaw);
    } catch (error) {
      // A step whose run has ended (a stop, a restart, a lost ownership) publishes nothing into the state of the run that stands (R27).
      if (!alive(id)) return { when: "event" };
      return localFailure(id, service, error, CAPTURE_OPERATION);
    }
    if (!alive(id)) return { when: "event" };
    if (capture.kind === "gated")
      return gated(
        service,
        capture.reason,
        capture.operation,
        capture.operations,
        capture.version,
      );
    unreadableRun = 0;
    unreadableOperations = [];

    // A hold at a position the cache is no longer at was superseded by an admitted state change (another page's commit, a recovery):
    // it hides nothing and is forgotten. (The gate keys a hold by the CURRENT position, so it never hid a newer cache meanwhile.)
    for (const operation of operationsOf(holds.keys(), service))
      if (operation !== invalidateOperation(capture.cursor))
        dropHolds(service, operation);

    // An admitted invalidation this page has not written yet comes BEFORE any new request: the position is known to be invalid, so
    // the write is retried (bounded by the same stop as any local write) and nothing is asked of the server meanwhile.
    if (retained !== null) {
      const held = retained;
      if (
        held.account === service.account &&
        held.incarnationId === service.incarnationId &&
        held.captured.epoch === identity.epoch
      )
        return invalidate(id, service, held.captured, held.reason, gateSaw);
      // Another account, another incarnation, or an identity that has moved to a newer epoch since the response was admitted: the
      // stamp can never be applied again (the plan's own guards refuse it), so it is let go here and the server is asked again under
      // the current one, rather than parked until some other wake. The HOLD stays: the cache is hidden meanwhile, and the new answer
      // (a fresh invalidation, or a page that supersedes the position) is what ends it.
      retained = null;
    }

    const captured = service.capture(identity.epoch, {
      requestSeq: capture.requestSeq,
      ownershipToken: ownership?.token ?? null,
      recoveryGeneration: capture.recoveryGeneration,
      expectedPosition: capture.cursor,
    });

    // The quota reserve: data writes refuse BEFORE atlas-auth writes could fail.
    const verdict = await deps.quota.check(
      "cache",
      maxResponseBytesFor(capture.limit),
    );

    // The last test before the request, and the quota read above is an asynchronous gap that everything this step decided before it may
    // have crossed (R27, revision 12): the run (a stop, a restart, a lost ownership), the service, the identity and connectivity are
    // judged again NOW, with only synchronous code between this test and the call. A step whose run has ended publishes nothing (a
    // `running` over a `not_started`); one whose eligibility moved evaluates again from the facts it finds.
    const eligible = mayIssue(id, service, identity.epoch);
    if (eligible !== "yes")
      return { when: eligible === "ended" ? "event" : "now" };
    if (verdict === "refuse") {
      setState({ kind: "stopped", cause: "storage_full" });
      return { when: "event" };
    }

    setState({ kind: "running", catchingUp: behind });

    // 3: the request.
    const url = deps.apiUrl("/sync");
    if (capture.cursor !== null) url.searchParams.set("cursor", capture.cursor);
    url.searchParams.set("limit", String(capture.limit));
    let response: Response;
    try {
      response = await deps.fetchFor(
        service.account,
        identity.epoch,
      )(new Request(url, { method: "GET" }));
    } catch (error) {
      // A request of a run that has ended changes nothing of the run that stands: no state, and none of its counters (R27).
      if (!alive(id)) return { when: "event" };
      return requestError(id, service, captured, error);
    }
    if (!alive(id)) return { when: "event" };
    notSent = 0;
    notCovered = 0;
    staleRun = 0;
    return dispatch(id, service, captured, capture.limit, response, gateSaw);
  }

  /**
   * Whether the request may be issued, re-evaluated in the SYNCHRONOUS step that issues it (the outbox dispatcher's `mayIssue`): reads
   * page memory only and never awaits. `ended`: the run is not the one that stands (a stop, a restart, the ownership signal aborted);
   * `moved`: the run stands but the service, the connectivity or the identity (account and epoch) is no longer what the step captured.
   */
  function mayIssue(
    id: number,
    service: AccountService,
    epoch: number,
  ): "yes" | "ended" | "moved" {
    if (!alive(id)) return "ended";
    if (!service.live || !deps.online()) return "moved";
    const identity = deps.identity.get();
    return identity !== null &&
      identity.account_id === service.account &&
      identity.epoch === epoch
      ? "yes"
      : "moved";
  }

  async function runCapture(
    service: AccountService,
    saw: Map<string, MarkerSeen>,
  ) {
    return service.store.run(captureRequest, {
      incarnationId: service.incarnationId,
      signals: deps.signals,
      // The attempt this page saw end and could not retire: the capture clears its marker without counting a crash (R42).
      endedAttempt: endedAttempts.get(service.account) ?? null,
      // The stops held in this tab's memory alone (they do not survive a reload, but they last as long as the tab does). The gate
      // enforces the operations of THIS engine's step, the capture write, the current page's commit and the write of an admitted
      // invalidation at this position; the dispatcher's drafts and receipts (`draft:`, `receipt:`) are its own and stop nothing here.
      stoppedOperations: operationsOf(memoryStops.keys(), service).filter(
        (operation) =>
          operation === CAPTURE_OPERATION ||
          operation === READ_RETRY_OPERATION ||
          operation === SIZING_OPERATION ||
          operation.startsWith("page:") ||
          operation.startsWith(INVALIDATE_PREFIX),
      ),
      // The account's fallback markers (they survive a reload), asked of exactly the operations the gate names: it names the page
      // and the invalidation by the position it reads in the transaction, which the engine cannot know here. The answer is the
      // markers' own, so a marker that cannot be read is `unknown`, not absent (R47, revision 29): the enumeration of the account's
      // markers is not how a stop is found, and a failed one concealed the stop of every operation (`unreadable` gate below).
      markerState: (operation) => {
        // The read the decision is made on is the instance a later success may end (R51, revision 31).
        const seen = deps.markers?.witness(service, operation);
        if (seen === undefined) return "unmarked";
        saw.set(operation, seen);
        return markerStateOf(seen);
      },
      // The stop of an admitted invalidation that an explicit retry lifted for this cycle: let through, never erased (R10).
      liftedOperations: operationsOf(lifted.keys(), service),
    });
  }

  function gated(
    service: AccountService,
    reason: GateReason,
    operation?: string,
    unread: readonly string[] = [],
    version: number | null = null,
  ): Next {
    if (reason !== "unreadable") {
      unreadableRun = 0;
      unreadableOperations = [];
    }
    // A gate that says the position is no longer the one an admitted invalidation was for (the cache is already invalid, a wipe is
    // under way, there is no database) settles it: the durable state is what the view reads now. A stop, a pause or the floor leaves
    // it where it is.
    if (
      reason === "phase" ||
      reason === "cache_status" ||
      reason === "closing" ||
      reason === "absent"
    )
      retained = null;
    // The hold goes with it, but not for a wipe: `closing` says nothing about the cache being valid, so what is hidden stays hidden.
    if (reason === "phase" || reason === "cache_status" || reason === "absent")
      dropHolds(service);
    switch (reason) {
      case "paused":
        setState({ kind: "paused", since: deps.clock.now() });
        return { when: "event" };
      case "unrecognised":
        // The durable pause survives a reload and a wake: it keeps its own state and its own explicit retry.
        setState({ kind: "stopped", cause: "unrecognised" });
        return { when: "event" };
      case "local_storage": {
        // The durable (or marker) stop of the current page's operation, restored on a cold start and kept through every wake.
        stoppedOperation = operation ?? null;
        if (operation !== undefined) {
          if (version === null) stoppedVersions.delete(operation);
          else stoppedVersions.set(operation, version);
        }
        // A restored stop of an admitted invalidation is a hold from this first wake, whatever recorded it.
        if (operation?.startsWith(INVALIDATE_PREFIX) === true)
          addHold(service, operation);
        // The quota stop of an admitted invalidation is recorded in the same marker; while this tab shows it as the quota stop that
        // it is (the more useful notice), a wake does not turn it into a different one.
        const held = store.get();
        if (
          held.kind === "stopped" &&
          held.cause === "storage_full" &&
          held.invalidating === true &&
          operation?.startsWith(INVALIDATE_PREFIX) === true
        )
          return { when: "event" };
        setState({
          kind: "stopped",
          cause: "local_storage",
          // A stop that only this tab's memory holds says so, on every wake, not only on the step that recorded it.
          ...(operation !== undefined &&
          memoryStops.has(memoryStopKey(service, operation))
            ? { memoryOnly: true as const }
            : {}),
          // A restored stop of an admitted invalidation hides the cache from the first wake after a reload.
          ...(operation?.startsWith(INVALIDATE_PREFIX) === true
            ? { invalidating: true as const }
            : {}),
        });
        return { when: "event" };
      }
      case "unreadable": {
        // The record of a stop of the current operation cannot be read, and nothing this page established says what it holds (R47,
        // revision 29): nothing is sent (an ordinary request at this position would pass a stop that may stand), the person is told local
        // storage is not responding, and the record is asked about again, paced, so a store that can be read again resumes the sync
        // without anyone's act. An explicit retry removes the record of the operation it names, which is the person's act and not proof
        // that the record is gone (another page may record a NEW stop after it, R47 revision 30): the gate asks again at the next step
        // and passes only on a read that lands. An admitted invalidation's is never lifted by a retry, because a retry is not evidence
        // that the cache is valid.
        stoppedOperation = null;
        unreadableOperations = [...unread];
        setState({ kind: "stopped", cause: "local_storage" });
        const wait = Math.min(60_000, 1_000 * 2 ** Math.min(unreadableRun, 6));
        unreadableRun += 1;
        return { when: "after", ms: wait };
      }
      case "floor":
        setState({ kind: "stopped", cause: "floor" });
        return { when: "event" };
      case "closing":
        setState({ kind: "waiting", reason: "paused_by_session" });
        return { when: "event" };
      default:
        // `phase`, `cache_status`, `absent`: no request. The recovery job is WEB-09b's.
        setState({ kind: "waiting", reason: "cache_not_valid" });
        return { when: "event" };
    }
  }

  // ---- a request that did not produce a response -----------------------------------------------------------------------------
  async function requestError(
    id: number,
    service: AccountService,
    captured: Captured,
    error: unknown,
  ): Promise<Next> {
    if (error instanceof StampedRequestError) {
      switch (error.kind) {
        case "not_sent": {
          // Quiet, bounded, NEVER counted: nothing was sent.
          const schedule_ = config.notSentBackoffMs;
          if (notSent < schedule_.length) {
            const ms = schedule_[notSent] as number;
            notSent += 1;
            return { when: "after", ms };
          }
          notSent = 0;
          setState({ kind: "waiting", reason: "paused_by_session" });
          return { when: "event" };
        }
        case "not_covered": {
          setState({ kind: "waiting", reason: "paused_by_session" });
          const ms = nextDelay(notCovered + 1, deps.clock.random(), config);
          notCovered += 1;
          return { when: "after", ms };
        }
        case "closed":
        case "closed_unresolved":
        case "auth_state":
          // The session has already switched to a neutral state, or is about to. Resume when the view returns; never spin.
          setState({ kind: "waiting", reason: "paused_by_session" });
          return { when: "event" };
        case "stale": {
          // Dropped silently; the durable record is re-read on the next step. A run of them is paced, not spun.
          staleRun += 1;
          return staleRun > 2 ? { when: "after", ms: 1_000 } : { when: "now" };
        }
      }
    }
    // A network error, an abort or the 30 s time-out: a counted failure of a read.
    return failRead(id, service, captured, "failure");
  }

  // ---- a response ---------------------------------------------------------------------------------------------------------------
  async function dispatch(
    id: number,
    service: AccountService,
    captured: Captured,
    limit: number,
    response: Response,
    saw: GateSaw,
  ): Promise<Next> {
    const status = response.status;
    if (status === 200)
      return applyPage(id, service, captured, limit, response, saw);
    if (status === 410)
      return invalidate(id, service, captured, "resync_required", saw);
    if (status === 400 || status === 422)
      return invalidate(id, service, captured, "construction_defect", saw);
    if (status === 503) {
      const code = await errorCode(response);
      // The body was read asynchronously: a run that ended meanwhile publishes nothing (R27).
      if (!alive(id)) return { when: "event" };
      if (code === "device_capacity") {
        // Blocking, no retry: the person is directed to retire a device (online).
        setState({ kind: "stopped", cause: "device_capacity" });
        return { when: "event" };
      }
      return failRead(id, service, captured, "failure", retryAfter(response));
    }
    // The whole `5xx` family is the one network/5xx class (contract-hygiene item 3: no status-specific branch): a gateway's `502` or
    // `504` is an outage like a `500`, backed off by duration and then paused, never an unrecognised answer. `429` is the same class.
    if (isFailureStatus(status))
      return failRead(id, service, captured, "failure", retryAfter(response));
    // `409 access_changed` in the delta phase, `403 forbidden`, any other status: D's "unrecognised response". Treated like a lost
    // response: never a success, never terminal on its own.
    return failRead(id, service, captured, "unrecognised");
  }

  async function applyPage(
    id: number,
    service: AccountService,
    captured: Captured,
    limit: number,
    response: Response,
    saw: GateSaw,
  ): Promise<Next> {
    const declared = Number(response.headers.get("content-length"));
    const ceiling = maxResponseBytesFor(limit, config);
    if (Number.isFinite(declared) && declared > ceiling)
      return invalidPage(id, service, captured, "oversize");
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await response.arrayBuffer());
    } catch (error) {
      if (isAllocationError(error))
        return sizingFailure(id, service, { kind: "allocation_failed" });
      return failRead(id, service, captured, "failure");
    }
    if (bytes.length > ceiling)
      return invalidPage(id, service, captured, "oversize");
    const scanStarted = deps.elapsed?.();
    let scan: ScanResult;
    try {
      scan = scanSyncPage(bytes, config);
    } catch (error) {
      // The scan's allocation failures (its offset arrays, their growth and trimmed copies, the decoding of a key or the cursor) are the
      // device's, exactly like the body's above (R44): the ladder steps down and the same position is asked for again, a smaller page.
      // Nothing was written and no attempt marker exists yet, so there is nothing to retire. Anything else the scan throws is a defect
      // in a step, and reaches the loop's stop.
      if (isAllocationError(error))
        return sizingFailure(id, service, { kind: "allocation_failed" });
      throw error;
    }
    const scanMs =
      scanStarted === undefined || deps.elapsed === undefined
        ? undefined
        : deps.elapsed() - scanStarted;
    if (!scan.ok || scan.phase !== "delta")
      return invalidPage(id, service, captured, "invalid");

    // The page's growth is admitted HERE, against the response it really is, and held through its commit (R28, revision 14). The request
    // was only CHECKED against the largest page the limit allows (which holds nothing, and is a cheap early refusal): input saves made
    // while the response was outstanding used the same free space, and a page committed without a growth admission of its own could take
    // it from under them. The admission is one atomic change of the origin's ledger, like theirs, and the cache is refused first.
    const admitted = await admitAndCommit(
      id,
      service,
      captured,
      limit,
      bytes,
      scan,
    );
    if (admitted === "ended") return { when: "event" };
    if (admitted === "refused") {
      setState({ kind: "stopped", cause: "storage_full" });
      return { when: "event" };
    }
    // The origin's accounting could not be established (R28, revision 15): nothing is known to be full, so this is NOT a storage stop.
    // Nothing was applied and nothing is counted as a failure; the page is requested again, paced like a commit whose identity could not
    // be verified.
    if (admitted === "unestablished") return dropped("unverified");
    const { outcome, commitMs } = admitted;
    if (!alive(id)) return { when: "event" };
    deps.trace?.emit("data.sync_commit", {
      // Measurement only (the profiling programme): present when the host supplies a monotonic clock, as the fixture harness does.
      ...(scanMs === undefined ||
      commitMs === undefined ||
      deps.elapsed === undefined
        ? {}
        : {
            bytes: bytes.length,
            scan_ms: Math.round(scanMs * 1000) / 1000,
            commit_ms: Math.round((commitMs ?? 0) * 1000) / 1000,
          }),
      kind: outcome.kind,
      ...(outcome.kind === "applied"
        ? { value: outcome.value.kind }
        : outcome.kind === "failed"
          ? { cause: outcome.failure.cause, ...(outcome.failure.detail ?? {}) }
          : { reason: outcome.reason }),
    });

    if (outcome.kind === "applied") {
      const value = outcome.value;
      if (value.kind === "not_ready") {
        setState({ kind: "waiting", reason: "cache_not_valid" });
        return { when: "event" };
      }
      // The hold the page was admitted under ended on every one of its admissions: nothing was applied and nothing is counted as a
      // failure, and the page is requested again, paced like a commit whose identity could not be verified.
      if (value.kind === "lease_lapsed") return dropped("unverified");
      failures = 0;
      unverified = 0;
      unsaved = null;
      behind = value.hasMore;
      // This page's operation succeeded: its durable streak went with the commit; the fallback marker of the failure the request was
      // admitted over goes here, and no newer one (R51, revision 31).
      retireMarker(service, `page:${captured.expectedPosition ?? ""}`, saw);
      // The position moved on, or the server accepted it again: the admitted invalidation this request was made over is superseded
      // (the plan cleared its streak). One recorded after the gate decided is a newer answer of the server at the same position, and is
      // not: the page's late completion says nothing about it, whether or not the position moved (an accepted empty page keeps its
      // cursor).
      clearInvalidationRecord(
        service,
        invalidateOperation(captured.expectedPosition),
        saw,
      );
      deps.quota.invalidate();
      deps.channel?.post({
        type: "data_changed",
        account: service.account,
        stores: ["cache", "sync_state"],
      });
      if (value.hasMore) return { when: "now" };
      setState({ kind: "idle", lastSyncedAt: deps.clock.iso() });
      return { when: "after", ms: config.syncIdleMs };
    }
    if (outcome.kind === "dropped") return dropped(outcome.reason);
    return commitFailure(id, service, captured, outcome.failure);
  }

  /**
   * Admits a page's growth and commits it under the hold (R28, revision 14): reserves the page's bytes ("cache": refused before any
   * input), commits, and settles the reservation by what happened (`written` only for a page that was applied). The commit begins only
   * while the hold stands (the plan reads `live()` where it decides what to write), and a page whose hold ended is admitted again, a
   * bounded number of times. The reservation is an asynchronous gap like any other (R27): a run that ended meanwhile commits nothing.
   * `commitMs` times the commit alone, for the profiling trace; the admission is not part of it.
   */
  async function admitAndCommit(
    id: number,
    service: AccountService,
    captured: Captured,
    limit: number,
    bytes: Uint8Array,
    scan: ScanOk,
  ): Promise<
    | "ended"
    | "refused"
    | "unestablished"
    | { outcome: CommitOutcome<CommitPageResult>; commitMs: number | undefined }
  > {
    for (let round = 1; ; round += 1) {
      const reservation = await deps.quota.reserve("cache", bytes.length);
      if (!alive(id)) {
        reservation.settle("not_written");
        return "ended";
      }
      if (reservation.verdict === "refuse") {
        // A refusal for want of space is a quota outcome, never a tab that did not survive: no attempt of THIS round has begun, and the
        // marker of an earlier round of this page was retired when that round's hold ended.
        return reservation.unestablished === true ? "unestablished" : "refused";
      }
      let written = false;
      try {
        // The crash-loop marker comes AFTER the admission, inside the hold: a page the quota refuses was never attempted, so it leaves
        // no marker for the next start to read as a tab that did not survive (which would step the page size down for want of space).
        // The attempt's id is chosen BEFORE the write: a write that fails may still have landed, and the retirement below is bound to
        // the id and harmless when no marker carries it.
        let attempt: string | null = null;
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
            // The marker is a refinement; a page is not refused for want of it.
          }
        }
        const started = deps.elapsed?.();
        const outcome = await service.commit(commitPage, {
          captured,
          bytes,
          scan,
          now: deps.clock.iso(),
          decode: deps.decode,
          elapsed: deps.elapsed,
          leaseLive: () => reservation.live(),
        });
        const commitMs =
          started === undefined || deps.elapsed === undefined
            ? undefined
            : deps.elapsed() - started;
        written =
          outcome.kind === "applied" && outcome.value.kind === "committed";
        const lapsed =
          outcome.kind === "applied" && outcome.value.kind === "lease_lapsed";
        // The attempt's outcome is KNOWN now (R42): a page that landed cleared its marker in its own transaction, and anything else (a
        // safe drop, `not_ready`, a lapsed hold, a failed commit) wrote nothing and ended normally, so the marker is no longer a claim
        // about an unknown outcome. It is retired here, whatever became of the run (a stopped run's attempt ended too), so the next
        // capture does not read it as a tab that did not survive. A crash never reaches this line, which is what the marker is for.
        if (attempt !== null && !written) await retireAttempt(service, attempt);
        if (!lapsed || round >= ADMISSION_ROUNDS) return { outcome, commitMs };
      } finally {
        reservation.settle(written ? "written" : "not_written");
      }
    }
  }

  /**
   * Retires the crash-loop marker of an attempt whose outcome was seen and landed nothing (R42), bound to the attempt's id. It never
   * throws and never stops the engine: a marker that cannot be retired now (the write failed, or the service had gone) is remembered
   * for the next capture of this database (`endedAttempts`), which clears it without a count; one id per account bounds the memory.
   */
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

  function dropped(reason: string): Next {
    switch (reason) {
      case "identity_changed":
      case "closed":
      case "incarnation":
      case "closing":
        // This page's account moved on, or a wipe is under way: nothing is applied, and sync resumes with the identity.
        setState({ kind: "waiting", reason: "paused_by_session" });
        return { when: "event" };
      case "owner":
        // Leadership is lost: this page stops issuing.
        setState({ kind: "waiting", reason: "paused_by_session" });
        return { when: "event" };
      case "unverified": {
        // The identity could not be verified in time (the session record could not be read, or a settlement holds the lock):
        // nothing was applied, nothing is counted as a failure, and the page is requested again, paced like `not_covered`.
        unverified += 1;
        return {
          when: "after",
          ms: nextDelay(unverified, deps.clock.random(), config),
        };
      }
      default:
        // `position`, `generation`, `epoch_superseded`: another page moved or a newer epoch exists. Re-evaluate from the record.
        return { when: "now" };
    }
  }

  // ---- failures ---------------------------------------------------------------------------------------------------------------
  async function commitFailure(
    id: number,
    service: AccountService,
    captured: Captured,
    failure: import("../store/port").StoreFailure,
  ): Promise<Next> {
    if (failure.cause === "quota") {
      await recordSizing(service, { kind: "quota" });
      setState({ kind: "stopped", cause: "storage_full" });
      return { when: "event" };
    }
    if (failure.cause === "closed") {
      setState({ kind: "waiting", reason: "paused_by_session" });
      return { when: "event" };
    }
    if (failure.cause === "plan_rejected") {
      if (
        failure.detail?.stage === "apply" &&
        failure.detail.reason === "watchdog"
      )
        return sizingFailure(id, service, {
          kind: "watchdog",
          elapsedMs: config.syncApplyWatchdogMs,
        });
      // A page the contract does not allow: nothing was written; not exhaustion, so the ladder does not move.
      return invalidPage(id, service, captured, "invalid");
    }
    if (isAllocationFailure(failure))
      return sizingFailure(id, service, { kind: "allocation_failed" });
    // abort / error: a local write failure. The same page is re-requested (the stamp is fresh) up to the bound.
    await recordSizing(service, {
      kind: "commit_failed",
      cause: failure.cause === "abort" ? "abort" : "error",
    });
    return localFailure(
      id,
      service,
      failure,
      `page:${captured.expectedPosition ?? ""}`,
    );
  }

  async function localFailure(
    id: number,
    service: AccountService,
    error: unknown,
    operation: string,
  ): Promise<Next> {
    if (isStoreFailure(error) && error.cause === "closed") {
      setState({ kind: "waiting", reason: "paused_by_session" });
      return { when: "event" };
    }
    let stop = false;
    let memoryOnly = false;
    const key = memoryStopKey(service, operation);
    try {
      const result = await service.store.run(recordLocalWriteOutcome, {
        incarnationId: service.incarnationId,
        operation,
        outcome: { kind: "failure" },
      });
      // The service may have ended while the counter was being written (R56): what follows belongs to a lifetime that is over, and
      // neither stops nor records anything of the replacement (a page's cursor, the capture or the sizing is reused by it).
      if (!service.live) return lifetimeOver(id);
      stop = result.stop;
      if (result.version !== null)
        stoppedVersions.set(operation, result.version);
      // An explicit retry of an admitted invalidation's write lifted the stop WITHOUT erasing its streak, so the streak is still at or
      // above the bound and says "stop" on the first failure. The cycle's own bound decides instead: the same number of consecutive
      // failures as any local write, counted from the retry.
      const left = lifted.get(key);
      if (left !== undefined) {
        stop = left <= 1;
        if (stop) lifted.delete(key);
        else lifted.set(key, left - 1);
      }
    } catch {
      // The streak itself could not be written: stop at once, with no counting, and record the stop in the fallback marker of this
      // database's lifetime so a reload finds it. When that cannot be written either, the stop is held in this tab alone and says so.
      if (!service.live) return lifetimeOver(id);
      stop = true;
      lifted.delete(key);
      const recorded = recordStop(
        deps.markers,
        service,
        operation,
        () => service.live,
        { hold: () => holdMemory(key) },
      );
      if (recorded === "obsolete") return lifetimeOver(id);
      memoryOnly = recorded === "memory";
    }
    if (stop) {
      stoppedOperation = operation;
      setState({
        kind: "stopped",
        cause: "local_storage",
        ...(memoryOnly ? { memoryOnly: true as const } : {}),
        ...(operation.startsWith(INVALIDATE_PREFIX)
          ? { invalidating: true as const }
          : {}),
      });
      return { when: "event" };
    }
    if (!alive(id)) return { when: "event" };
    return { when: "now" };
  }

  async function invalidPage(
    id: number,
    service: AccountService,
    captured: Captured,
    _why: "oversize" | "invalid",
  ): Promise<Next> {
    // Nothing was written. It is an unrecognised response (a contract violation), NOT resource exhaustion: the ladder is not
    // stepped, and only the marker is cleared.
    await recordSizing(service, { kind: "oversize" });
    return failRead(id, service, captured, "unrecognised");
  }

  async function sizingFailure(
    id: number,
    service: AccountService,
    outcome: SizingOutcome,
  ): Promise<Next> {
    const record = await recordSizing(service, outcome);
    if (!alive(id)) return { when: "event" };
    if (record.kind === "failed") {
      // The ladder cannot step and the floor cannot count, so asking again at the same size would repeat the same download and the same
      // allocation for as long as the record cannot be written, with no bound. The record is the counter of this class: when it cannot
      // be written the stop is immediate and uncounted (the fallback marker, then this tab's memory), and only "Try again" leaves it.
      return bookkeepingStop(service, SIZING_OPERATION, record.error);
    }
    if (record.result?.action === "floor") {
      setState({ kind: "stopped", cause: "floor" });
      return { when: "event" };
    }
    return { when: "now" };
  }

  /**
   * The sizing record of an outcome. A failed write is REPORTED, never swallowed: only a caller whose own bound does not depend on the
   * ladder may ignore it (a quota stop, a counted local write failure, an unrecognised answer: each stops by its own counter), and
   * `sizingFailure` may not.
   */
  async function recordSizing(
    service: AccountService,
    outcome: SizingOutcome,
  ): Promise<
    | {
        kind: "recorded";
        result: { action: SizingAction; sizing: SizingState } | null;
      }
    | { kind: "failed"; error: unknown }
  > {
    try {
      const result = await service.store.run(recordSizingOutcome, {
        incarnationId: service.incarnationId,
        outcome,
      });
      return {
        kind: "recorded",
        result: result.action === "none" ? null : result,
      };
    } catch (error) {
      return { kind: "failed", error };
    }
  }

  /**
   * A counter this step needs to bound itself cannot be written (the sync caller's retry record, the sizing record): the specified
   * local-storage policy (plan 5.4, "Local failure"): the service going away is not a storage failure, a quota failure stops at once as
   * the full storage it is, and anything else stops IMMEDIATELY and uncounted, recorded in the account's fallback marker so a reload
   * finds it, or, when even that cannot be written, in this tab's memory with the notice that it will not survive a reload.
   */
  function bookkeepingStop(
    service: AccountService,
    operation: string,
    error: unknown,
  ): Next {
    const cause = isStoreFailure(error) ? error.cause : "error";
    if (cause === "closed") {
      setState({ kind: "waiting", reason: "paused_by_session" });
      return { when: "event" };
    }
    if (cause === "quota") {
      setState({ kind: "stopped", cause: "storage_full" });
      return { when: "event" };
    }
    lifted.delete(memoryStopKey(service, operation));
    const recorded = recordStop(
      deps.markers,
      service,
      operation,
      () => service.live,
      { hold: () => holdMemory(memoryStopKey(service, operation)) },
    );
    if (recorded === "obsolete") {
      setState({ kind: "waiting", reason: "paused_by_session" });
      return { when: "event" };
    }
    stoppedOperation = operation;
    const memoryOnly = recorded === "memory";
    setState({
      kind: "stopped",
      cause: "local_storage",
      ...(memoryOnly ? { memoryOnly: true as const } : {}),
    });
    return { when: "event" };
  }

  /**
   * A counted failure of a READ: durable back-off state, a paused state after the sustained duration, or an unrecognised bound.
   *
   * The count is made in this page's memory FIRST and merged into the durable record by the same write (`known`), so the bound is
   * enforced whatever the database does with it (R20): a write that could not be verified in time (`unverified`) leaves the count in
   * `unsaved`, which the next step and the next write both honour; a write that FAILED is the counter itself failing, and stops at
   * once under the local-storage policy (`bookkeepingStop`), the count held meanwhile; a drop for any other reason is the identity or
   * the database moving on, which the engine follows.
   */
  async function failRead(
    id: number,
    service: AccountService,
    captured: Captured,
    kind: "failure" | "unrecognised",
    retryAfterMs: number | null = null,
  ): Promise<Next> {
    failures += 1;
    const now = deps.clock.now();
    const known = unsavedFor(service);
    const counted =
      kind === "failure"
        ? onReadFailure(known ?? initialReadRetry(), now, config)
        : onUnrecognised(known ?? initialReadRetry(), config);
    const out = await service.commit(recordReadOutcome, {
      captured,
      caller: "sync",
      outcome: { kind },
      now,
      ...(known === null ? {} : { known }),
    });
    if (!alive(id)) return { when: "event" };
    let state = counted;
    if (out.kind === "applied") {
      // The database holds it, merged with what it already knew: it is the authority again.
      state = out.value.state;
      unsaved = null;
    } else {
      // A drop for the identity, the epoch or the database moving on says nothing about THIS count: it belonged to a stamp that no
      // longer stands, and is not kept.
      if (out.kind === "dropped" && out.reason !== "unverified")
        return dropped(out.reason);
      unsaved = {
        account: service.account,
        incarnationId: service.incarnationId,
        state: counted,
      };
      if (out.kind === "failed")
        return bookkeepingStop(service, READ_RETRY_OPERATION, out.failure);
    }
    const since = state.backing_off_since ?? now;
    if (state.paused && kind === "unrecognised") {
      setState({ kind: "stopped", cause: "unrecognised" });
      return { when: "event" };
    }
    if (state.paused) {
      setState({ kind: "paused", since });
      return { when: "event" };
    }
    setState({ kind: "backing_off", since });
    const wait = Math.max(
      nextDelay(failures, deps.clock.random(), config),
      retryAfterMs ?? 0,
    );
    return { when: "after", ms: Math.min(wait, config.backoffMaxMs) };
  }

  /**
   * The write of an admitted invalidation. `captured` is the stamp it was ADMITTED under, and stays the stamp of every retry of it
   * (R10): the plan's guards drop it if the position, the generation or the identity has moved on, so it can never hide a newer valid
   * cache. A failure is not swallowed: the invalidation is retained, the cache stays hidden (the failure's durable record, and the
   * stop's `invalidating` flag, are what the view reads), and the write is retried within the bound and then stopped with the notice.
   */
  async function invalidate(
    id: number,
    service: AccountService,
    captured: Captured,
    reason: InvalidationReason,
    saw: GateSaw,
  ): Promise<Next> {
    const out = await service.commit(invalidateRecoveryPosition, {
      captured,
      reason,
    });
    if (!alive(id)) return { when: "event" };
    if (out.kind === "dropped") {
      if (out.reason === "unverified") {
        // The server ADMITTED this invalidation, but the commit could not be verified in time (the session record could not be read, or a
        // settlement holds the lock): nothing was decided and nothing is counted as a failure. The cache at this position is nevertheless
        // KNOWN to be invalid, so the invalidation is retained with its stamp and held (hidden) until it is written, and the next paced
        // step writes it without asking the server again, whether or not an earlier write had failed.
        retained = {
          account: service.account,
          incarnationId: service.incarnationId,
          captured,
          reason,
        };
        addHold(service, invalidateOperation(captured.expectedPosition));
      } else {
        retained = null;
        // The position, the generation or the epoch moved on: someone else has settled it (an invalidation another page wrote, a page
        // that committed), so the stop and its record at THIS position are moot. A drop for the identity or a wipe keeps them.
        if (
          out.reason === "position" ||
          out.reason === "generation" ||
          out.reason === "epoch_superseded"
        )
          clearInvalidationRecord(
            service,
            invalidateOperation(captured.expectedPosition),
            saw,
          );
      }
      return dropped(out.reason);
    }
    if (out.kind === "failed")
      return invalidationFailure(id, service, captured, reason, out.failure);
    retained = null;
    clearInvalidationRecord(
      service,
      invalidateOperation(captured.expectedPosition),
      saw,
    );
    deps.recovery.request(reason);
    if (deps.recovery.registered) {
      // Recovery is automatic and the chip reads "Resyncing" from this instant; ordinary sync waits for the cache to be valid.
      setState({ kind: "waiting", reason: "cache_not_valid" });
    } else {
      setState({ kind: "stopped", cause: "no_recovery" });
    }
    return { when: "event" };
  }

  /** An admitted invalidation could not be written. See `invalidate`. */
  async function invalidationFailure(
    id: number,
    service: AccountService,
    captured: Captured,
    reason: InvalidationReason,
    failure: import("../store/port").StoreFailure,
  ): Promise<Next> {
    if (failure.cause === "closed") {
      // The service is going (a wipe, an identity change): the durable state is what the next one reads.
      retained = null;
      setState({ kind: "waiting", reason: "paused_by_session" });
      return { when: "event" };
    }
    const operation = invalidateOperation(captured.expectedPosition);
    retained = {
      account: service.account,
      incarnationId: service.incarnationId,
      captured,
      reason,
    };
    // The cache at this position is KNOWN to be invalid from here until the guarded write succeeds or the position is superseded. That
    // is recorded first and for itself: whatever the counter, the marker or a retry later do or fail to do, this is what hides it.
    addHold(service, operation);
    if (failure.cause === "quota") {
      // Stopped at once and not counted: a counter would need the very space that is missing. The stop is recorded in the account's
      // fallback marker (which survives a reload and is read by the cache gate), or held in this tab alone and says so.
      lifted.delete(memoryStopKey(service, operation));
      const recorded = recordStop(
        deps.markers,
        service,
        operation,
        () => service.live,
        { hold: () => holdMemory(memoryStopKey(service, operation)) },
      );
      if (recorded === "obsolete") {
        setState({ kind: "waiting", reason: "paused_by_session" });
        return { when: "event" };
      }
      stoppedOperation = operation;
      setState({ kind: "stopped", cause: "storage_full", invalidating: true });
      return { when: "event" };
    }
    // abort / error / anything else: the same bounded rule as every local write (three consecutive durable failures stop it, at once
    // when the counter cannot be written), under the invalidation's own operation. A page's sizing ladder is NOT moved: no page was applied.
    return localFailure(id, service, failure, operation);
  }

  /**
   * The invalidation's fallback marker, memory stop, hold and lifted cycle at this position are gone: its write succeeded (the plan
   * cleared its streak in the same transaction that says `invalid`), or the position moved on. This is the ONLY place a hold ends,
   * besides a gate that says the position is settled; a retry, a wake and an engine's execution state never do.
   */
  function clearInvalidationRecord(
    service: AccountService,
    operation: string,
    saw: GateSaw,
  ): void {
    retireMarker(service, operation, saw);
    memoryStops.delete(memoryStopKey(service, operation));
    lifted.delete(memoryStopKey(service, operation));
    dropHolds(service, operation);
    if (stoppedOperation === operation) stoppedOperation = null;
  }

  /**
   * Ends the fallback marker the capture gate saw for `operation` when it admitted the request, if it still stands as that instance
   * (R51, revision 31). A marker the gate did not see (none stood, or it was recorded since, by another engine or another page, or
   * could not be read or named) is left: the answer to this request does not recover what it was not made over.
   */
  function retireMarker(
    service: AccountService,
    operation: string,
    saw: GateSaw,
  ): void {
    deps.markers?.retire(
      service,
      operation,
      saw.get(operation) ?? { kind: "none" },
    );
  }

  // ---- helpers ------------------------------------------------------------------------------------------------------------------
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

  // ---- control ------------------------------------------------------------------------------------------------------------------
  const wake = (): void => {
    if (ownership === null) return;
    const online = deps.online();
    const transition = online && !lastOnline;
    lastOnline = online;
    if (transition) cameOnline();
    else void tick(generation, "wake");
  };

  // The browser's `online` event is one of the two triggers that end the sync caller's back-off or pause (the other is its own
  // "Retry now"). It resumes THIS caller only, and not a stop that unrecognised answers caused.
  const cameOnline = (): void => {
    if (ownership === null) return;
    // The event and the reading are one signal: a wake that follows must not resume a second time.
    lastOnline = deps.online();
    const id = generation;
    // What only this page counted ends the way the record's does: a duration pause or back-off, not three unrecognised answers.
    if (unsaved !== null && resumeOnOnline(unsaved.state, config) !== null)
      unsaved = null;
    void (async () => {
      const service = deps.service();
      if (service) {
        try {
          await service.store.run(resumeReadCallerOnOnline, {
            incarnationId: service.incarnationId,
            caller: "sync",
            unrecognisedAfter: config.unrecognisedPauseAfter,
          });
        } catch {
          // Resuming is best effort; the step below re-reads the record.
        }
      }
      // The resume above is the record's, and stands. What follows belongs to the run that asked: a continuation that outlived its run
      // (a stop and a start while the write was outstanding) neither resets the new run's failure count nor wakes it (R27, revision 12).
      if (!alive(id)) return;
      failures = 0;
      void tick(id, "online");
    })();
  };

  return {
    state: store,
    invalidations: holdStore,

    start(next) {
      generation += 1;
      ownership = next;
      behind = true;
      failures = 0;
      notSent = 0;
      notCovered = 0;
      staleRun = 0;
      unreadableRun = 0;
      unreadableOperations = [];
      unverified = 0;
      stoppedOperation = null;
      retained = null;
      // A receipt nudge and a retry of the run that ended are not the next run's (their step never settled, so nothing else would
      // forget them).
      receiptNudged = false;
      retried = false;
      // An explicit retry's cycle ends with the engine's run (a stop is always followed by a start before anything is attempted): the
      // next retry begins another. The holds stay (memory stops do too).
      lifted.clear();
      lastOnline = deps.online();
      for (const off of unsubscribe) off();
      unsubscribe = [deps.subscribe(wake), deps.onOnline(cameOnline)];
      bindAbort(generation, next.signal);
      setState({ kind: "waiting", reason: "cache_not_valid" });
      void tick(generation, "start");
    },

    stop() {
      generation += 1;
      ownership = null;
      retained = null;
      unbindAbort();
      clearTimer();
      for (const off of unsubscribe) off();
      unsubscribe = [];
      setState({ kind: "not_started" });
      resolveWaiters();
    },

    retryNow() {
      if (ownership === null) return;
      const id = generation;
      const state = store.get();
      // The act begins NOW, and what stands now is what it lifts (R51, revision 31): the markers of the stopped operation and of the
      // operations the last step could not read. One recorded while the retry waits on the database is newer than the person's decision.
      // The same holds for the durable streak (R53, revision 32): the operation is the one stopped now, and its reset names the version
      // of the failure this engine had seen, so a failure recorded after the click is left.
      const target = stoppedOperation;
      const targetVersion =
        target === null ? null : (stoppedVersions.get(target) ?? null);
      const acted = new Map<string, MarkerSeen>();
      {
        const service = deps.service();
        if (service)
          for (const operation of [
            ...(target === null ? [] : [target]),
            ...unreadableOperations,
          ]) {
            const seen = deps.markers?.witness(service, operation);
            if (seen !== undefined) acted.set(operation, seen);
          }
      }
      const lift = (service: AccountService, operation: string): void => {
        deps.markers?.retire(
          service,
          operation,
          acted.get(operation) ?? { kind: "none" },
          { explicit: true },
        );
      };
      void (async () => {
        const service = deps.service();
        if (service) {
          try {
            // An explicit retry is the sync caller's own: it ends a back-off, a pause by duration and a pause by unrecognised
            // answers alike (the stop for unrecognised answers is shown as `stopped`, and must be left by this click).
            if (
              state.kind === "paused" ||
              state.kind === "backing_off" ||
              (state.kind === "stopped" && state.cause === "unrecognised")
            ) {
              // What only this page counted ends the way the record's does.
              unsaved = null;
              await service.store.run(resumeReadCaller, {
                incarnationId: service.incarnationId,
                caller: "sync",
              });
            }
            if (state.kind === "stopped" && state.cause === "floor")
              await service.store.run(resetSizingFloor, {
                incarnationId: service.incarnationId,
              });
            if (
              state.kind === "stopped" &&
              (state.cause === "local_storage" ||
                // The quota stop of an admitted invalidation names its operation; a page's quota stop names none.
                (state.cause === "storage_full" && stoppedOperation !== null))
            ) {
              const operation = target;
              if (operation?.startsWith(INVALIDATE_PREFIX) === true) {
                // The stop of an admitted invalidation's write is LIFTED for one bounded cycle, never erased (R10, revision 9): its
                // streak, fallback marker and memory stop are also what hides the cache, and a retry is not evidence that the cache
                // has become valid. They go when the guarded write succeeds (the plan clears the streak in the same transaction),
                // or when the position is superseded; if connectivity goes, or the persistence hold cannot verify the commit, they
                // are all still there.
                lifted.set(
                  memoryStopKey(service, operation),
                  config.localWritePauseAfter,
                );
              } else if (operation !== null) {
                // "Try again" clears the stopped OPERATION's streak and its fallback marker, not some other operation's.
                if (operation === READ_RETRY_OPERATION) unsaved = null;
                memoryStops.delete(memoryStopKey(service, operation));
                lift(service, operation);
                const reset = await service.store.run(recordLocalWriteOutcome, {
                  incarnationId: service.incarnationId,
                  operation,
                  outcome: { kind: "success", expect: targetVersion },
                });
                // A failure the click did not see stands: the gate's next step reads it and stops again.
                if (reset.cleared) stoppedVersions.delete(operation);
                else if (reset.version !== null)
                  stoppedVersions.set(operation, reset.version);
              }
              if (stoppedOperation === target) stoppedOperation = null;
            }
            // The step found the record of a stop unreadable (R47, revisions 29 and 30): "Try again" removes the record of the operations
            // it named. The removal is not kept as proof that they are gone: the gate's next step asks again, and only a read that lands
            // lets the request through. An admitted invalidation's is never removed by a retry (a retry is not evidence that the cache
            // is valid): only a read that lands, or the write that supersedes it, ends that one.
            if (state.kind === "stopped" && unreadableOperations.length > 0) {
              for (const operation of unreadableOperations)
                if (!operation.startsWith(INVALIDATE_PREFIX))
                  lift(service, operation);
              unreadableOperations = [];
            }
          } catch {
            // Resuming is best effort; the step below re-reads the record.
          }
        }
        failures = 0;
        if (alive(id)) {
          // A stop for storage or contract reasons is left only by an explicit retry.
          if (store.get().kind === "stopped")
            setState({ kind: "waiting", reason: "cache_not_valid" });
          void tick(id, "retry");
        }
      })();
    },

    nudge(after) {
      if (ownership === null) return;
      const id = generation;
      if (after === "receipt") {
        // A step is running: its own `schedule` will clear whatever timer is set now, so the nudge is kept for `settle`.
        if (busy) {
          receiptNudged = true;
          return;
        }
        // A back-off's deadline and the capacity stop stand (R23): the receipt may not replace the timer that holds one.
        if (holding()) return;
        clearTimer();
        timer = deps.clock.setTimeout(() => {
          timer = null;
          void tick(id, "nudge");
        }, config.syncReceiptMs);
        return;
      }
      void tick(id, "nudge");
    },

    settled() {
      if (!busy && timer === null) return Promise.resolve();
      return new Promise<void>((resolve) => waiters.push(resolve));
    },
  };
}
