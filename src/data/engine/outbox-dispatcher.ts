import { recogniseAtlasError } from "../../lib/api-client/problem";
import {
  type ApiCompatibility,
  type Identity,
  StampedRequestError,
  type Store,
  type Trace,
} from "../../session";
import { DATA_CONFIG, type DataConfig } from "../model/config";
import { type CommandOutcome, classifyAnswer } from "../model/dispatch";
import { resolveEndpoint, wireBody } from "../model/outbox";
import type { RecordedOutcome } from "../model/outcomes";
import {
  draftOperations,
  nextDelay,
  operationDraft,
  QUEUE_OPERATION,
} from "../model/retry";
import type {
  DraftError,
  DraftRow,
  DraftWithCommand,
  LocalId,
} from "../model/types";
import type { ConflictHandlerRegistry } from "../outbox/registries";
import {
  admitReceipt,
  type ClaimResult,
  markInFlight,
  readDispatchWindow,
  recordFailureOfSend,
  recordOutcome,
  resumeDrafts,
  unclaimDraft,
} from "../plans/outbox";
import { recordLocalWriteOutcome } from "../plans/retry-state";
import { isStoreFailure } from "../store/port";
import type { AccountService } from "./account-service";
import { createPendingWake } from "./pending-wake";
import { LOCAL_WRITE_STOPS_STORE, type SyncChannel } from "./sync-channel";
import type { SyncOwnership } from "./sync-engine";
import {
  createLocalStops,
  type LocalStops,
  recordStop,
  retireStops,
  type StopWitness,
  type WriteFailureMarkers,
  witnessStops,
} from "./write-failure-marker";

/** What a write took when it was issued (see `issue`). */
interface Issued {
  readonly seen: StopWitness;
  readonly failures: number;
  /**
   * The version of the durable failure that stood under each operation, as this dispatcher had seen it when the act began (R53,
   * revision 32): the entitlement of the person's "Try again", whose reset of a durable streak ends that failure and no other.
   */
  readonly durable: ReadonlyMap<string, number>;
}

/**
 * The outbox dispatcher (plan 5.5.3 and 5.5.4): the loop that sends queued drafts, one at a time, and applies each answer.
 *
 * It decides NOTHING about display or about what a command means. It reads the durable queue, picks the oldest eligible draft
 * (`selectCandidate`), claims it (`markInFlight`), sends it through the stamped wrapper with the draft's own `local_id` as the
 * `Idempotency-Key`, and applies the answer through the plans. Eligibility is RE-EVALUATED for every attempt and again in the
 * synchronous step that issues the request: it never decides once and sends later (R24).
 *
 *  - a STOP is part of eligibility, and it is enforced where a send is admitted, from the records as they are then (R46, revision 28):
 *    the queue read holds a stopped draft back, the claim (`markInFlight`) refuses one in its own transaction (the durable streaks it
 *    reads there, and the marker and the page's memory through `heldOutside`) WITHOUT touching the stop, and the step that issues the
 *    request asks again, including the stops another writer of the page announced since the attempt began, giving the claim back when one
 *    stands. No automatic path is the recovery that permits the send: only the person's retry or the operation's own success ends a stop;
 *  - a stop whose record CANNOT BE READ is unknown, never absent (R47, revision 29): a draft whose marker could be neither read nor
 *    believed (this page never established it, and neither the key nor the enumeration can be read: a reload with the store unreadable)
 *    is not sent, as a draft whose stop stands is not. It is held back the way a stopped draft is and asked about again, paced, until a
 *    read LANDS and says the record is gone. A removal (the person's retry, an operation's own success) is never kept as proof of
 *    absence (R47, revision 30): another page may have recorded a NEW stop since, and a notification is not the only protection
 *    against that, so a draft is admitted only on a read made where it is admitted (the claim, the issue), never on what was done earlier;
 *
 *  - an unsent request is not an attempt: `not_sent`, `not_covered`, `closed`, `closed_unresolved` and `auth_state` return the
 *    draft to `queued` (a draft that never reached the wire is not frozen) and count nothing; `stale` drops silently and leaves it
 *    `in_flight`;
 *  - a request that WAS issued and got no answer (a network error, a time-out, an abort) is a counted failure of the draft class:
 *    back-off from 2 s doubling to 60 s, then `paused` after the sustained duration, resumed only by `online` or "Retry now";
 *  - an answer the commit guard drops (the identity moved, a wipe is closing, a later epoch exists) is dropped: the draft stays
 *    `in_flight` and uncounted, and is retried under the same key by whoever is entitled to.
 */
export interface DispatcherDeps {
  /** The displayed account's service, or null when there is none. */
  service(): AccountService | null;
  identity: Store<Identity | null>;
  /** `session.api.fetchFor("ordinary", account, epoch)`. */
  fetchFor(
    account: string,
    epoch: number,
  ): (request: Request) => Promise<Response>;
  apiUrl(path: string): URL;
  online(): boolean;
  /** The API-compatibility fact: queued WRITES are dispatched only while it is `supported` (decision D-21). */
  compat: Store<ApiCompatibility>;
  /** Fires when eligibility may have changed (the session view, the identity, visibility). */
  subscribe(listener: () => void): () => void;
  /** Fires when the browser comes back online: the only event that resumes a paused draft besides "Retry now". */
  onOnline(listener: () => void): () => void;
  clock: {
    now(): number;
    iso(): string;
    random(): number;
    setTimeout(fn: () => void, ms: number): unknown;
    clearTimeout(handle: unknown): void;
  };
  yield(): Promise<void>;
  conflicts: ConflictHandlerRegistry;
  /** A receipt was recorded: ask the sync engine to look soon (`engine.nudge("receipt")`). */
  receipt?: () => void;
  channel?: SyncChannel;
  /**
   * The account's write-failure markers (`localStorage`): the fallback record of a local-write stop whose counter could not be
   * written, and the page's memory of the stop that could be recorded nowhere (`markers.stops`), which every writer of the page shares:
   * pass the SAME object as the facades of this page (R46, revision 27). Absent: such a stop is held in memory only, and says so, in a
   * record of this dispatcher's own (`stops`), which a facade composed with it shares.
   */
  markers?: WriteFailureMarkers;
  trace?: Trace;
  config?: Partial<DataConfig>;
}

export type DispatcherState =
  | { kind: "not_started" }
  | { kind: "idle" }
  | { kind: "sending" }
  | { kind: "waiting"; reason: "offline" | "session" | "no_account" }
  /** `unknown` and `unreachable`: held QUIETLY, nothing is counted, nothing is shown. */
  | { kind: "held"; reason: "compat_unconfirmed" }
  /** `unsupported` and `missing`: paused VISIBLY, drafts kept, nothing sent. */
  | { kind: "paused"; reason: "compat_unsupported" | "compat_missing" }
  /** A draft is backing off (passive): the person is not asked to do anything yet. */
  | { kind: "backing_off" }
  /** At least one draft is paused after a sustained failure: an actionable "Retry now". */
  | { kind: "needs_retry"; count: number }
  /** `memoryOnly`: the stop is held in this tab alone and will not survive a reload (neither store could record it). */
  | {
      kind: "stopped";
      cause: "local_storage" | "storage_full";
      memoryOnly?: true;
    };

export interface OutboxDispatcher {
  readonly state: Store<DispatcherState>;
  /**
   * The record of this page's memory-held stops that the dispatcher reads and writes (the markers' own when it was given markers). A
   * facade composed with this dispatcher and no markers of its own shares it, so that the two see one stop (R46, revision 27).
   */
  readonly stops?: LocalStops;
  start(ownership: SyncOwnership): void;
  stop(): void;
  /** "Retry now" for one draft, or for every paused one. Also clears a "local storage isn't responding" stop. */
  retry(localId?: LocalId): void;
  /** Something may have changed that the dispatcher should look at (an enqueue). */
  wake(): void;
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

type Next = { when: "now" } | { when: "after"; ms: number } | { when: "event" };

/**
 * Why a step was asked for: a `timer` (the step's own schedule), a `start` (a restart hands over), a `signal` (an explicit act: work
 * was saved, `online`, "Retry now") or a `notified` (the session, identity, visibility or compatibility store published).
 */
type TickReason = "timer" | "start" | "signal" | "notified";

const ERROR_BODY_LIMIT = 8 * 1024;
const CODE = /^[a-z][a-z0-9_]{0,63}$/;

const sameState = (a: DispatcherState, b: DispatcherState): boolean =>
  JSON.stringify(a) === JSON.stringify(b);

export function createOutboxDispatcher(deps: DispatcherDeps): OutboxDispatcher {
  const config = { ...DATA_CONFIG, ...deps.config };
  const store = new MutableStore<DispatcherState>({ kind: "not_started" });
  const setState = (next: DispatcherState): void => {
    if (!sameState(store.get(), next)) store.set(next);
  };

  let ownership: SyncOwnership | null = null;
  let generation = 0;
  let timer: unknown = null;
  let busy = false;
  // A wake that arrived while a step ran (R22): see `pending-wake.ts` and `settle`.
  const wakes = createPendingWake();
  let unsubscribe: Array<() => void> = [];
  let waiters: Array<() => void> = [];
  // In memory only: they shape the schedule, never a decision about data.
  const blockedUntil = new Map<LocalId, number>();
  let notSent = 0;
  let notCovered = 0;
  let staleRun = 0;
  /**
   * Consecutive attempts that ended at the claim or just before the request because a stop stood (R46, revision 28). The step that
   * picked the draft and the claim read the same records, so the next step names the stop and the run ends at once; were they ever to
   * disagree (a record read in between), the attempt would be made again and refused again, so a run of them is paced and never spun.
   */
  let refusedRun = 0;
  // Commits the persistence hold could not verify in time (a settlement under way): paced, never counted as a failure.
  let unverified = 0;
  /**
   * Operations whose local write failed and whose failure state this page has not yet been able to end (so a retry reaches exactly
   * those, and a clearing that could not be written is tried again). It is bookkeeping about OUR failures only: the stop itself is
   * whatever the record, the markers and the page's memory (`stops`) say, and a success ends it whether or not this dispatcher saw the
   * failure (R46).
   */
  const failedOperations = new Set<string>();
  /**
   * What a write takes when it is ISSUED and a success uses when its result is delivered (R50, revision 31): the stops that stand for
   * the operation it will end, by instance (the page's memory and the markers), and how many failures this dispatcher had recorded. A
   * stop recorded after the write was issued, by this dispatcher, the facade or another page, is a newer failure, and the late result
   * of an earlier write does not end it.
   */
  let failureCount = 0;
  /** The count of this dispatcher's failures at which each operation last failed. */
  const failedAt = new Map<string, number>();
  /**
   * The version of the durable failure that stands under each operation, as this dispatcher last SAW it: from the transaction that
   * counted its own failure and from the window it read (R53, revision 32). A reset decided on it names that version and ends that
   * failure and no other: a newer failure, from this page or another, has a version of its own. An operation with no entry is one
   * this dispatcher has not seen a durable failure of.
   */
  const observed = new Map<string, number>();
  const issue = (
    service: AccountService,
    operations: Iterable<string>,
  ): Issued => {
    const named = [...operations];
    return {
      seen: witnessStops(deps.markers, stops, service, named),
      failures: failureCount,
      durable: new Map(
        named.flatMap((operation) => {
          const version = observed.get(operation);
          return version === undefined ? [] : [[operation, version] as const];
        }),
      ),
    };
  };
  /**
   * Drafts whose own local writes failed three times in a row (F-O10: "a draft's repeated local abort stops THAT draft only"). They
   * are left alone until "Try again", the rest of the queue goes on, and the visible state says storage is not responding once
   * nothing else is left to do.
   */
  const stalled = new Set<LocalId>();
  /**
   * Drafts held back because a stop of theirs might stand in a record that cannot be read (R47, revision 29): the marker of either of
   * their operations is `unknown` to this page. Not a stop (nothing is known to stand) and not a permission (nothing is known not to):
   * the draft is skipped like a stopped one, so the rest of the queue goes on, and the set is looked at again at every step, which a
   * rescan paces, so a store that can be read again releases them without anyone's act. The person's retry lifts them too, by
   * removing the record, which the markers take as evidence only when the removal returns. Bounded by the queue; in memory only. The
   * value says whether the draft was `in_flight` when it was held (see `admission`).
   */
  const unreadable = new Map<LocalId, boolean>();
  /**
   * Where the previous turn's window of candidates ended when nothing in it could be sent and more follow, so this turn continues
   * from there. Any event (an enqueue, a wake, a retry, a start) forgets it and the next turn begins again at the oldest draft.
   */
  let scanAfter: number | undefined;
  /** Complete passes over the queue that found nothing to send though drafts were waiting behind others: they back off the rescan. */
  let fruitlessCycles = 0;
  /**
   * The stalled operations that could be recorded neither durably nor in a marker: they will not survive a reload, but they last
   * as long as the tab does: through every wake, connectivity signal and nudge, AND through a stop and a start of this dispatcher
   * (an ownership change in the same tab), and they are lifted only by the explicit retry of that operation, or by that operation's
   * own success or abandonment, whichever writer makes it. They are the PAGE's, not this dispatcher's (R46, revision 27): the facade
   * holds and ends the same stops (`draft:<id>` is written by both), so there is one record, and it is read as a marker is.
   */
  const stops = deps.markers?.stops ?? createLocalStops();
  /** The announcer this dispatcher is on the page's board (`LocalStops.announce`). */
  const self = {};
  /**
   * The operations another writer of this page recorded a stop for since the current attempt began, in ANY record (R46, revision 28).
   * The claim reads the durable streaks and the page's own stops when it decides, but a request is issued after the claim has
   * committed, and a stop recorded in that interval is one only the announcement carries: it reaches the step that issues the request
   * through this set. `null` outside an attempt.
   */
  let announced: Set<string> | null = null;

  const alive = (id: number): boolean =>
    id === generation && ownership !== null && !ownership.signal.aborted;

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
    const ms = next.when === "now" ? 0 : Math.max(0, next.ms);
    timer = deps.clock.setTimeout(() => {
      timer = null;
      void tick(id, "timer");
    }, ms);
    if (next.when === "after") resolveWaiters();
  };

  /**
   * What a step reads to decide whether it may run: the service (account, incarnation, liveness), the identity (account, epoch),
   * connectivity and the API-compatibility fact. A notification that does not change it is not news (`pending-wake.ts`).
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
      deps.compat.get().status,
    ].join("|");
  };

  /**
   * The step's own schedule, adjusted for what arrived while it ran (R22, revision 10). A wake that arrives while a step runs cannot
   * start another, and the step may already have read the queue (an empty window, an old identity) before the draft was saved or the
   * identity moved: with nothing scheduled, nothing would ever look again, and a draft saved at that moment waited for good. So the
   * wake is remembered, and the queue is evaluated again now, from the current facts, as an ordinary step (a clean latch: only a NEW
   * wake can ask for another, so there is no loop and one request is in flight). What the step had scheduled is not lost: the
   * re-evaluation sets its own, from what it finds. A re-evaluation cannot send early what a back-off holds: eligibility is
   * per draft (`blockedUntil`, the durable retry state), and one draft's back-off never blocks another's (D-18).
   */
  const settle = (next: Next): Next => {
    if (!wakes.take()) return next;
    // The wake began the queue again, as `wake()` says: from the oldest draft, with the rescan back-off forgotten.
    scanAfter = undefined;
    fruitlessCycles = 0;
    return { when: "now" };
  };

  async function tick(id: number, why: TickReason): Promise<void> {
    if (!alive(id)) return;
    if (busy) {
      // Remembered, not dropped (R22). A timer is not a wake: the step's own schedule answers it; a start while a step of the old
      // run unwinds is handed over below.
      if (why === "signal") wakes.signal();
      else if (why === "notified") wakes.notify(eligibility());
      return;
    }
    busy = true;
    wakes.begin(eligibility());
    try {
      const stepped = await step(id);
      if (!alive(id)) return;
      const next = settle(stepped);
      if (next.when === "now") await deps.yield();
      if (!alive(id)) return;
      // A wake that arrived while the step ran is honoured by `settle`; the step's own schedule is always set (revision 9: the loop
      // that stood here left without scheduling what the step had decided, a draft's back-off included).
      schedule(id, next);
    } catch {
      // A defect in a step must never kill the loop silently or spin: stop visibly.
      deps.trace?.emit("data.outbox_step_failed");
      setState({ kind: "stopped", cause: "local_storage" });
      schedule(id, { when: "event" });
    } finally {
      busy = false;
      // A `stop()` then `start()` while this loop's step was still waiting (a held response) coalesced the NEW generation's first
      // tick into a loop it does not belong to, and this one then unwound without scheduling anything. Hand over:
      // the current generation runs now. It runs only after the old step unwound, so two requests are never in flight at once
      // (`maxInFlight` is 1).
      if (id !== generation && alive(generation))
        void tick(generation, "start");
    }
  }

  // ---- eligibility --------------------------------------------------------------------------------------------------------------
  /** The compat gate, as the state it implies (or null when queued writes may be dispatched). */
  function compatGate(): DispatcherState | null {
    const compat = deps.compat.get();
    switch (compat.status) {
      case "supported":
        return null;
      case "unsupported":
        return { kind: "paused", reason: "compat_unsupported" };
      case "missing":
        return { kind: "paused", reason: "compat_missing" };
      default:
        return { kind: "held", reason: "compat_unconfirmed" };
    }
  }

  /** Re-evaluated in the SYNCHRONOUS step that issues the request. Reads page memory only; never awaits. */
  function mayIssue(
    id: number,
    service: AccountService,
    epoch: number,
  ): boolean {
    if (!alive(id) || !service.live || !deps.online()) return false;
    if (compatGate() !== null) return false;
    const identity = deps.identity.get();
    return (
      identity !== null &&
      identity.account_id === service.account &&
      identity.epoch === epoch
    );
  }

  // ---- one step -----------------------------------------------------------------------------------------------------------------
  async function step(id: number): Promise<Next> {
    const service = deps.service();
    if (!service?.live) {
      setState({ kind: "waiting", reason: "no_account" });
      return { when: "event" };
    }
    if (!deps.online()) {
      setState({ kind: "waiting", reason: "offline" });
      return { when: "event" };
    }
    const identity = deps.identity.get();
    if (!identity || identity.account_id !== service.account) {
      setState({ kind: "waiting", reason: "session" });
      return { when: "event" };
    }
    const gate = compatGate();
    if (gate !== null) {
      setState(gate);
      return { when: "event" };
    }

    releaseReadable(service);
    // The read of the queue is the write that ends a stop of reading it: the stop that stands when it is issued is the one it can end.
    const queueRead = issue(service, [QUEUE_OPERATION]);
    let window: Awaited<ReturnType<typeof readWindow>>;
    try {
      window = await readWindow(service);
    } catch (error) {
      // A step whose run has ended publishes nothing into the state of the run that stands (R27, revision 12).
      if (!alive(id)) return { when: "event" };
      return localFailure(id, service, error, QUEUE_OPERATION);
    }
    if (!alive(id)) return { when: "event" };
    // What the read saw of the durable failures is what this dispatcher has seen of them (its own read of the queue and the stopped
    // drafts' operations: an operation the window does not list has none now).
    observed.delete(QUEUE_OPERATION);
    for (const [operation, version] of Object.entries(window.failureVersions))
      observed.set(operation, version);
    if (window.closing) {
      setState({ kind: "waiting", reason: "session" });
      return { when: "event" };
    }
    // This read landed, so it ends the consecutive failures of reading the queue (R46): three isolated aborts between successful reads
    // are not "three in a row". A clearing that cannot be written is tried again by the next read that sees the count. What it ends is
    // the failure its own snapshot showed (R53, revision 32): one recorded after the read has a version of its own and stays.
    if (
      window.queueFailures > 0 ||
      failedOperations.has(QUEUE_OPERATION) ||
      queueStopped(service)
    )
      await clearStreak(service, QUEUE_OPERATION, queueRead, {
        expect: window.failureVersions[QUEUE_OPERATION] ?? null,
      });
    if (!alive(id)) return { when: "event" };
    // What stands stopped is what the records say (R46): a stop recorded durably (or in the fallback marker) before a reload is
    // restored here, those drafts are left alone, and the visible state says so, without waiting for some other trigger to retry
    // them; and a stop that has ended since (the draft's own success or discard, a retry in another tab) is no longer held. The window
    // above was read with that draft still waiting, so what it picked is not the whole truth: the queue is read again at once.
    if (reconcileStalled(window.stopped)) return { when: "now" };
    if (window.pick === null) {
      // The window was exhausted with no pick and candidates follow: continue from where it stopped on the next turn (carried
      // progress, so a long run of blocked drafts cannot hide one behind it), without touching the visible state in between.
      if (window.next !== null) {
        scanAfter = window.next;
        return { when: "now" };
      }
      scanAfter = undefined;
      refusedRun = 0;
      if (stalled.size > 0 || unreadable.size > 0 || queueStopped(service))
        setState({
          kind: "stopped",
          cause: "local_storage",
          ...(stops.operations(service).length > 0
            ? { memoryOnly: true as const }
            : {}),
        });
      else if (window.selection.paused > 0)
        setState({ kind: "needs_retry", count: window.selection.paused });
      else if (window.selection.backingOff > 0)
        setState({ kind: "backing_off" });
      else setState({ kind: "idle" });
      if (
        window.selection.wakeAt !== null &&
        Number.isFinite(window.selection.wakeAt)
      )
        return {
          when: "after",
          ms: Math.max(50, window.selection.wakeAt - deps.clock.now()),
        };
      // Drafts that wait behind another draft (a shared target, an unfinished dependency, a hold) become sendable when that draft
      // is settled, which another page's commit can do without telling this one: look again, a little later each time that finds
      // nothing, and promptly after any event.
      // The drafts held back as unreadable are asked about again on the same pace: the store may be readable by then.
      if (window.blocked > 0 || unreadable.size > 0) {
        const delay = Math.min(
          config.queueRescanMs * 2 ** Math.min(fruitlessCycles, 4),
          60_000,
        );
        fruitlessCycles += 1;
        return { when: "after", ms: delay };
      }
      return { when: "event" };
    }
    scanAfter = undefined;
    fruitlessCycles = 0;
    unverified = 0;
    announced = new Set();
    try {
      return await attempt(id, service, identity.epoch, window.pick);
    } finally {
      announced = null;
    }
  }

  /**
   * The operations a stop outside the database names for this account: the fallback markers' and the tab's memory (read in the step,
   * never inside a transaction). An ordinary wake honours the memory-held stop of a draft exactly as it honours a marker, whichever
   * writer recorded it (R46, revision 27).
   */
  const markerOperations = (service: AccountService): string[] => [
    ...(deps.markers?.inspect(service).operations ?? []),
    ...stops.operations(service),
  ];

  /**
   * What a stop that the database does not hold says of this draft NOW: `held` when the fallback marker of either of its operations
   * (or one this page established and cannot read again, R47) or the page's memory names it; `unknown` when neither does and the marker
   * of either operation could not be read at all (R47, revision 29: the key and the enumeration both threw, and this page had
   * established nothing); otherwise `free`. Synchronous.
   */
  const admission = (
    service: AccountService,
    localId: LocalId,
    inFlight: boolean,
  ): "free" | "held" | "unknown" => {
    let unknown = false;
    const operations = draftOperations(localId);
    for (const operation of operations) {
      if (stops.has(service, operation)) return "held";
      const state = deps.markers?.probe(service, operation);
      if (state === "marked") return "held";
      // The marker of the draft's RECEIPT is a stop of recording an answer, which only a draft that has been sent can have: a draft that
      // is still `queued` is asked about its own operation alone, so that the success of its edit, which ends exactly that one, is
      // enough to send it once a read lands (R50, revision 31). A draft already `in_flight` (a resend) is asked about both.
      if (state === "unknown" && (inFlight || operation === operations[0]))
        unknown = true;
    }
    return unknown ? "unknown" : "free";
  };
  /**
   * Whether a stop that the database does not hold, or one that cannot be read, stands between this draft and a send NOW. Asked at the
   * two places a send is admitted: in the decision of the claim and in the step that issues the request (R46, revision 28). The window
   * the step picked its draft from was read BEFORE, and another writer may have stopped the draft since.
   */
  const heldOutside = (
    service: AccountService,
    pick: Pick<DraftRow, "local_id" | "status">,
  ): boolean =>
    admission(service, pick.local_id, pick.status === "in_flight") !== "free";
  /** A stop of either of the draft's operations was recorded, in any record, since the attempt began (the announcements of the page). */
  const announcedSince = (localId: LocalId): boolean =>
    draftOperations(localId).some(
      (operation) => announced?.has(operation) === true,
    );

  /** A stop of the dispatcher's own queue read (not of one draft) that a marker or the tab's memory holds. */
  const queueStopped = (service: AccountService): boolean =>
    markerOperations(service).includes(QUEUE_OPERATION);

  function readWindow(service: AccountService) {
    return service.store.run(readDispatchWindow, {
      incarnationId: service.incarnationId,
      now: deps.clock.now(),
      blockedUntil,
      windowSize: config.queueWorkingSet,
      ...(scanAfter === undefined ? {} : { after: scanAfter }),
      markerOperations: markerOperations(service),
    });
  }

  // ---- an attempt -----------------------------------------------------------------------------------------------------------------
  async function attempt(
    id: number,
    service: AccountService,
    epoch: number,
    pick: DraftRow,
  ): Promise<Next> {
    const captured = service.capture(epoch);
    // (1) the claim: one transaction flips `queued` to `in_flight` and creates the candidate rows.
    const claim = await service.commit(markInFlight, {
      captured,
      localId: pick.local_id,
      heldOutside: () => heldOutside(service, pick),
    });
    if (!alive(id)) return { when: "event" };
    if (claim.kind === "dropped") return dropped(claim.reason);
    if (claim.kind === "failed")
      return localFailure(id, service, claim.failure, `draft:${pick.local_id}`);
    const claimed = claim.value;
    // A stop was recorded since the window was read (another writer's, in any of the three records): nothing was claimed and the stop
    // stands. The draft is left alone until its own recovery, exactly as one that was stopped before the read (R46, revision 28).
    if (claimed.kind === "stopped") return withheld(id, service, pick);
    if (claimed.kind !== "claimed") return { when: "now" };
    // The claim landed: its plan ended the draft's BELOW-BOUND failures in the same transaction (R46), so what this dispatcher counted of
    // them ends here. A stop is not among them and is never ended by a claim: the plan refused one that stood, and one recorded since
    // (in the marker or the page's memory, which no transaction holds) is still standing, and is read again below.
    failedOperations.delete(draftOperations(pick.local_id)[0] as string);

    // (2) the request, with only synchronous code between the last eligibility test and the call.
    if (heldOutside(service, pick) || announcedSince(pick.local_id)) {
      // Stopped between the claim's decision and the step that issues the request (in the marker, in the page's memory, or durably by
      // another writer of this page, which only its announcement tells): the claim is given back (nothing was sent) and the stop stands.
      await unclaim(service, claimed);
      if (!alive(id)) return { when: "event" };
      return withheld(id, service, pick);
    }
    if (!mayIssue(id, service, epoch)) {
      await unclaim(service, claimed);
      return { when: "event" };
    }
    // The body travels with the claim: it was read for THIS draft only, in the transaction that claimed it.
    const draft: DraftWithCommand = {
      ...claimed.draft,
      command: claimed.command,
    };
    const path = resolveEndpoint(draft.endpoint, draft.target_id);
    if (path === null)
      // A stored draft that cannot be addressed can never be sent: a local, definitive refusal that keeps its content.
      return record(
        id,
        service,
        captured,
        draft,
        { kind: "rejected" },
        {
          stage: "unaddressable",
        },
      );
    deps.trace?.emit("data.outbox_send", { resend: !claimed.flipped });
    setState({ kind: "sending" });
    let response: Response;
    try {
      response = await deps.fetchFor(
        service.account,
        epoch,
      )(
        new Request(deps.apiUrl(path), {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": draft.local_id,
          },
          body: wireBody(draft),
        }),
      );
    } catch (error) {
      return requestError(id, service, claimed, error);
    }
    // An answer to a run that has ended resets nothing of the run that stands (R27, revision 12).
    if (!alive(id)) return { when: "event" };
    notSent = 0;
    notCovered = 0;
    staleRun = 0;
    refusedRun = 0;
    return answer(id, service, captured, claimed, response);
  }

  async function unclaim(
    service: AccountService,
    claimed: Extract<ClaimResult, { kind: "claimed" }>,
  ): Promise<void> {
    try {
      await service.store.run(unclaimDraft, {
        incarnationId: service.incarnationId,
        localId: claimed.draft.local_id,
        flipped: claimed.flipped,
        created: claimed.created,
      });
    } catch {
      // The draft stays `in_flight`: a retry candidate, never lost, resent under the same key.
    }
  }

  // ---- a request that did not produce a response ----------------------------------------------------------------------------------
  async function requestError(
    id: number,
    service: AccountService,
    claimed: Extract<ClaimResult, { kind: "claimed" }>,
    error: unknown,
  ): Promise<Next> {
    if (error instanceof StampedRequestError) {
      // The draft goes back to `queued` whatever run this was (that is durable), but what is counted, published and scheduled afterwards
      // belongs to the run that stands (R27, revision 12): a request of a run that has ended changes none of it.
      switch (error.kind) {
        case "not_sent": {
          await unclaim(service, claimed);
          if (!alive(id)) return { when: "event" };
          // Quiet, bounded, NEVER counted: nothing was sent.
          const steps = config.notSentBackoffMs;
          if (notSent < steps.length) {
            const ms = steps[notSent] as number;
            notSent += 1;
            return { when: "after", ms };
          }
          notSent = 0;
          setState({ kind: "waiting", reason: "session" });
          return { when: "event" };
        }
        case "not_covered": {
          await unclaim(service, claimed);
          if (!alive(id)) return { when: "event" };
          setState({ kind: "waiting", reason: "session" });
          const ms = nextDelay(notCovered + 1, deps.clock.random(), config);
          notCovered += 1;
          return { when: "after", ms };
        }
        case "closed":
        case "closed_unresolved":
        case "auth_state":
          // The request did not reach the domain (or was refused for its credentials, which executes nothing): the draft goes back
          // to `queued` exactly as it was, nothing is counted, and the queue resumes when the session allows.
          await unclaim(service, claimed);
          if (!alive(id)) return { when: "event" };
          setState({ kind: "waiting", reason: "session" });
          return { when: "event" };
        case "stale":
          // Dropped silently; the draft stays `in_flight` and the durable record is re-read. A run of them is paced, not spun.
          if (!alive(id)) return { when: "event" };
          staleRun += 1;
          return staleRun > 2 ? { when: "after", ms: 1_000 } : { when: "now" };
      }
    }
    // A network error, an abort or the 30 s time-out of the stamped wrapper: the request was issued and got no answer.
    const name = (error as { name?: unknown } | null)?.name;
    const stage =
      name === "TimeoutError"
        ? "timeout"
        : name === "AbortError"
          ? "aborted"
          : "network";
    return failure(id, service, claimed.draft, { stage });
  }

  /** A counted failure with no answer (W8). */
  async function failure(
    id: number,
    service: AccountService,
    draft: DraftRow,
    error: DraftError,
    retryAfterMs: number | null = null,
  ): Promise<Next> {
    let paused = false;
    const issued = issue(service, [draftOperations(draft.local_id)[1]]);
    try {
      const result = await service.store.run(recordFailureOfSend, {
        incarnationId: service.incarnationId,
        localId: draft.local_id,
        error,
        now: deps.clock.now(),
        nowIso: deps.clock.iso(),
      });
      paused = result.kind === "recorded" && result.paused;
      if (result.kind === "recorded") {
        // The record ended the receipt's failures in its own transaction (R46). A STOP among them is a change of the record of durable
        // stops that nothing else of this act announces: the account's other pages are told, whether or not this run still stands
        // (the transaction committed), and read their own records (R60, revision 38).
        if ((result.endedStreak ?? 0) >= config.localWritePauseAfter)
          stopsChanged(service);
        succeeded(service, draftOperations(draft.local_id)[1], issued);
      }
    } catch (caught) {
      return localFailure(id, service, caught, `receipt:${draft.local_id}`);
    }
    if (!alive(id)) return { when: "event" };
    return afterCountedFailure(draft, paused, retryAfterMs);
  }

  function afterCountedFailure(
    draft: DraftRow,
    paused: boolean,
    retryAfterMs: number | null,
  ): Next {
    if (paused) {
      blockedUntil.delete(draft.local_id);
      return { when: "now" };
    }
    const wait = Math.min(
      Math.max(
        nextDelay(draft.attempts + 1, deps.clock.random(), config),
        retryAfterMs ?? 0,
      ),
      config.backoffMaxMs,
    );
    blockedUntil.set(draft.local_id, deps.clock.now() + wait);
    // Another draft may be eligible right now: one entry's back-off never blocks another (D-18).
    return { when: "now" };
  }

  // ---- an answer ---------------------------------------------------------------------------------------------------------------------
  async function answer(
    id: number,
    service: AccountService,
    captured: ReturnType<AccountService["capture"]>,
    claimed: Extract<ClaimResult, { kind: "claimed" }>,
    response: Response,
  ): Promise<Next> {
    const draft: DraftWithCommand = {
      ...claimed.draft,
      command: claimed.command,
    };
    const body = await readBody(response);
    const outcome = classifyAnswer({
      status: response.status,
      error: recogniseAtlasError(response.headers.get("content-type"), body),
      revision:
        body !== null && typeof body === "object"
          ? (body as { revision?: unknown }).revision
          : undefined,
    });
    deps.trace?.emit("data.outbox_answer", { kind: outcome.kind });
    if (!alive(id)) return { when: "event" };

    if (outcome.kind === "receipt") {
      const issued = issue(service, [draftOperations(draft.local_id)[1]]);
      const out = await service.commit(admitReceipt, {
        captured,
        localId: draft.local_id,
        revision: outcome.revision,
      });
      if (!alive(id)) {
        if (out.kind === "applied") answered(service);
        return { when: "event" };
      }
      if (out.kind === "dropped") return dropped(out.reason);
      if (out.kind === "failed")
        return localFailure(
          id,
          service,
          out.failure,
          `receipt:${draft.local_id}`,
        );
      blockedUntil.delete(draft.local_id);
      if (out.value.kind === "admitted")
        succeeded(service, draftOperations(draft.local_id)[1], issued);
      deps.channel?.post({
        type: "data_changed",
        account: service.account,
        stores: ["drafts", "pending_effects", "resource_versions"],
      });
      deps.receipt?.();
      return { when: "now" };
    }

    const decided = decide(outcome, draft, response.status);
    return record(
      id,
      service,
      captured,
      draft,
      decided.recorded,
      decided.error,
      retryAfter(response),
    );
  }

  /** What a non-receipt answer does to the draft, after a registered handler had its say about a `409`. */
  function decide(
    outcome: Exclude<CommandOutcome, { kind: "receipt" }>,
    draft: DraftWithCommand,
    status: number,
  ): { recorded: RecordedOutcome; error: DraftError } {
    const code = (value: string | null): { code?: string } =>
      value !== null && CODE.test(value) ? { code: value } : {};
    switch (outcome.kind) {
      case "conflict":
      case "other_conflict": {
        const handled = deps.conflicts.decide({
          draft,
          status,
          code: outcome.code,
        });
        const error: DraftError = {
          status,
          ...code(outcome.code),
          stage: "conflict",
        };
        if (handled.kind === "reclassify") {
          if (handled.as === "retry")
            return { recorded: { kind: "retry" }, error };
          if (handled.as === "rejected")
            return { recorded: { kind: "rejected" }, error };
          return { recorded: { kind: "conflict", as: handled.as }, error };
        }
        if (outcome.kind === "other_conflict")
          // D's unrecognised rule: stays `in_flight`, retried with the same key under the back-off.
          return { recorded: { kind: "retry" }, error };
        return {
          recorded: {
            kind: "conflict",
            as:
              outcome.code === "operation_conflict"
                ? "operation_conflict"
                : "version_conflict",
          },
          error,
        };
      }
      case "defaults_changed":
        return {
          recorded: { kind: "defaults_changed" },
          error: { status, code: "defaults_changed", stage: "review" },
        };
      case "rejected":
        return {
          recorded: { kind: "rejected" },
          error: { status, ...code(outcome.code), stage: "rejected" },
        };
      case "capacity":
        return {
          recorded: { kind: "capacity" },
          error: { status, code: "slice_capacity", stage: "capacity" },
        };
      default:
        return {
          recorded: { kind: "retry" },
          error: { status, ...code(outcome.code), stage: "unavailable" },
        };
    }
  }

  async function record(
    id: number,
    service: AccountService,
    captured: ReturnType<AccountService["capture"]>,
    draft: DraftRow,
    recorded: RecordedOutcome,
    error: DraftError,
    retryAfterMs: number | null = null,
  ): Promise<Next> {
    const issued = issue(service, [draftOperations(draft.local_id)[1]]);
    const out = await service.commit(recordOutcome, {
      captured,
      localId: draft.local_id,
      outcome: recorded,
      error,
      now: deps.clock.now(),
      nowIso: deps.clock.iso(),
    });
    if (!alive(id)) {
      if (out.kind === "applied") answered(service);
      return { when: "event" };
    }
    if (out.kind === "dropped") return dropped(out.reason);
    if (out.kind === "failed")
      return localFailure(
        id,
        service,
        out.failure,
        `receipt:${draft.local_id}`,
      );
    if (out.value.kind === "recorded")
      succeeded(service, draftOperations(draft.local_id)[1], issued);
    deps.channel?.post({
      type: "data_changed",
      account: service.account,
      stores: ["drafts", "pending_effects", "resource_versions"],
    });
    if (recorded.kind === "retry" && out.value.kind === "recorded")
      return afterCountedFailure(draft, out.value.paused, retryAfterMs);
    return { when: "now" };
  }

  function dropped(reason: string): Next {
    switch (reason) {
      case "identity_changed":
      case "closed":
      case "incarnation":
      case "closing":
        // This page's account moved on, or a wipe is under way: the draft stays `in_flight` and uncounted.
        setState({ kind: "waiting", reason: "session" });
        return { when: "event" };
      case "unverified":
        // The identity could not be verified in time: nothing was applied and nothing is counted. The draft stays as it was
        // (`in_flight`, resent under its own key) and the queue looks again, paced.
        unverified += 1;
        return {
          when: "after",
          ms: nextDelay(unverified, deps.clock.random(), config),
        };
      default:
        // `epoch_superseded` and the sync-only guards: re-evaluate from the durable record.
        return { when: "now" };
    }
  }

  // ---- local write failures ------------------------------------------------------------------------------------------------------
  async function localFailure(
    id: number,
    service: AccountService,
    error: unknown,
    operation: string,
  ): Promise<Next> {
    if (isStoreFailure(error) && error.cause === "closed") {
      setState({ kind: "waiting", reason: "session" });
      return { when: "event" };
    }
    if (isStoreFailure(error) && error.cause === "quota") {
      // A quota failure is not a streak: a full disk is its own visible state ("storage full"), not "local storage isn't
      // responding". The draft stays exactly as it was and is retried when the person asks.
      setState({ kind: "stopped", cause: "storage_full" });
      return { when: "event" };
    }
    failedOperations.add(operation);
    failureCount += 1;
    failedAt.set(operation, failureCount);
    try {
      const result = await service.store.run(recordLocalWriteOutcome, {
        incarnationId: service.incarnationId,
        operation,
        outcome: { kind: "failure" },
      });
      // The service may have ended while the counter was being written (R56): what follows belongs to a lifetime that is over. It
      // stops nothing of the replacement (a draft id or the queue read is reused by it) and records nothing. A stop it nonetheless
      // COMMITTED is in the record all the same: the account's other pages are told, and read their own records (R60, revision 38).
      if (!service.live) {
        if (result.stop) stopsChanged(service);
        return { when: "event" };
      }
      if (result.version !== null) observed.set(operation, result.version);
      if (result.stop) {
        stops.announce(service, self, { recorded: [operation] });
        stopsChanged(service);
        return stall(id, service, operation);
      }
    } catch {
      // The streak itself could not be written: stop at once, with no counting, and record the stop in the fallback marker of this
      // database's lifetime so a reload finds it. When that cannot be written either, the stop is held in the page's memory and says
      // so; the facade, which writes the same operation, sees it there. A callback that outlived its service records nothing (R56).
      const recorded = recordStop(
        deps.markers,
        service,
        operation,
        () => service.live,
        {
          hold: () => {
            stops.hold(service, operation);
          },
        },
      );
      if (recorded === "obsolete") return { when: "event" };
      stops.announce(service, self, { recorded: [operation] });
      return stall(id, service, operation);
    }
    if (!alive(id)) return { when: "event" };
    return { when: "after", ms: 250 };
  }

  /**
   * A draft that may not be sent now: a stop stands (it is stalled, like every stopped draft, and its refusal paced), or the record of
   * a stop cannot be read (it is held back as unreadable, R47 revision 29). The durable stop takes precedence over an unreadable
   * marker: while the record stands the draft is stopped, and the marker is looked at when it ends.
   */
  function withheld(
    id: number,
    service: AccountService,
    pick: Pick<DraftRow, "local_id" | "status">,
  ): Next {
    const localId = pick.local_id;
    const inFlight = pick.status === "in_flight";
    if (admission(service, localId, inFlight) !== "unknown")
      return refused(stall(id, service, `draft:${localId}`));
    unreadable.set(localId, inFlight);
    blockedUntil.set(localId, Number.POSITIVE_INFINITY);
    // Each of these takes a draft out of the candidates, so the next read finds another or none: progress, never a spin, so no pace.
    return alive(id) ? { when: "now" } : { when: "event" };
  }

  /**
   * The drafts held back as unreadable are looked at again at the start of every step (synchronous reads, a few keys each, and only
   * while there are any): one whose records can be read now is let go, and the step that follows decides from what they say.
   */
  function releaseReadable(service: AccountService): void {
    for (const [draft, inFlight] of [...unreadable]) {
      if (admission(service, draft, inFlight) === "unknown") continue;
      unreadable.delete(draft);
      if (blockedUntil.get(draft) === Number.POSITIVE_INFINITY)
        blockedUntil.delete(draft);
    }
  }

  /** A refusal because a stop stands: asked again at once twice, then paced (`refusedRun`). */
  function refused(next: Next): Next {
    refusedRun += 1;
    return next.when === "now" && refusedRun > 2
      ? { when: "after", ms: 1_000 }
      : next;
  }

  /** The operation's streak reached its bound: that draft (when the operation names one) is left alone until "Try again". */
  function stall(id: number, service: AccountService, operation: string): Next {
    const draft = operationDraft(operation);
    if (draft === null) {
      setState({
        kind: "stopped",
        cause: "local_storage",
        ...(stops.has(service, operation) ? { memoryOnly: true as const } : {}),
      });
      return { when: "event" };
    }
    stalled.add(draft);
    blockedUntil.set(draft, Number.POSITIVE_INFINITY);
    if (!alive(id)) return { when: "event" };
    return { when: "now" };
  }

  /**
   * The operation's own write landed (R46). The plan that wrote it ended the durable streak in the SAME transaction, so what is left
   * to end is what this page keeps: its memory of the failure and, when one stands, the operation's fallback marker. A marker that
   * cannot be removed is still a stop (the records are what stands), and the next success tries again.
   *
   * It ends the stops the write could have recovered and no others (R50, revision 31): the instances that stood when it was ISSUED
   * (`issued`), however late its result is delivered. A stop recorded since, by this dispatcher, the facade or another page, is a
   * newer failure, and the result of an earlier transaction says nothing about it. A marker that could not be read or named when the
   * write was issued is left for the person's retry (a success cannot show that it predates the write).
   */
  function succeeded(
    service: AccountService,
    operation: string,
    issued: Issued,
  ): void {
    const knew =
      (failedAt.get(operation) ?? 0) <= issued.failures &&
      failedOperations.delete(operation);
    const ended = retireStops(deps.markers, stops, issued.seen, {
      operations: [operation],
    });
    // Something ended that another writer may be showing (the facade's warning): it looks again. Nothing was heard of on the healthy
    // path, where none of the three held anything, so a healthy dispatch says nothing.
    if (knew || ended.length > 0)
      stops.announce(service, self, { ended: [operation] });
  }

  /**
   * Ends ONE operation's failure state at the person's explicit "Try again", or at the success of the queue read: its durable streak
   * (a write of its own), its fallback marker and this tab's memory of it, and nothing of any other operation (R46).
   *
   * What it ends is what stood when the act began (`issued`, R50, revision 31; R52 and R53, revision 32): a stop recorded while the act
   * is under way (it waits on the database, one operation at a time) is newer than the person's decision or the read, and stays. The
   * marker is ended by its exact key; the durable streak is reset on the VERSION of the failure the act saw (`expect`: the dispatcher's
   * own observation at the click, or the queue read's own snapshot), so a failure recorded after it, from this page or another, is left
   * and the operation stays stopped. `explicit` is the person's retry, whose removal of a marker that cannot be removed is not owed (the
   * person's next act tries again); the success of the queue read is not explicit.
   *
   * The memory and the marker end even when the durable streak cannot be written: a stop that only they held is a stop the person has
   * lifted. What stands afterwards is what the records still say: a durable streak that reached its bound still stops the draft, and
   * the visible state is derived from it again at the next step, so a clearing that failed never shows as recovered. The operation
   * stays in `failedOperations` until its durable streak is ended, so the next retry, and the next successful read of the queue, tries
   * the clearing again: the bookkeeping is not lost before the write that ends it has succeeded.
   */
  async function clearStreak(
    service: AccountService,
    operation: string,
    issued: Issued,
    options: { expect: number | null; explicit?: boolean },
  ): Promise<void> {
    retireStops(deps.markers, stops, issued.seen, {
      operations: [operation],
      explicit: options.explicit === true,
    });
    try {
      const result = await service.store.run(recordLocalWriteOutcome, {
        incarnationId: service.incarnationId,
        operation,
        outcome: { kind: "success", expect: options.expect },
      });
      if (!result.cleared) {
        // A failure this act did not see stands: it is the next retry's (or the next read's) to end, and the operation stays failed.
        if (result.version !== null) observed.set(operation, result.version);
      } else {
        observed.delete(operation);
        if ((failedAt.get(operation) ?? 0) <= issued.failures)
          failedOperations.delete(operation);
        // A durable failure the act saw has ended: another page that shows it reads its records again (R60, revision 37).
        if (options.expect !== null) stopsChanged(service);
      }
    } catch {
      // Still recorded: the operation stays in `failedOperations`, and the next retry or successful read ends it.
    }
    stops.announce(service, self, { ended: [operation] });
  }

  /**
   * A durable stop was recorded here, or a durable failure this dispatcher saw was ended (R60, revision 37): the record in `sync_state`
   * changed, which no other page hears from the database, so every other page of the account is told and reads its own records. A stop
   * held in a fallback marker is heard through the markers' feed; one held in this page's memory exists nowhere else.
   */
  function stopsChanged(service: AccountService): void {
    deps.channel?.post({
      type: "data_changed",
      account: service.account,
      stores: [LOCAL_WRITE_STOPS_STORE],
    });
  }

  /**
   * The record of an answer (a receipt admitted, an outcome recorded) COMMITTED after this run ended (R60, revision 38): it changed the
   * drafts and ended the receipt's failures in its transaction (R46), so the account's other pages are told, as a run that stands tells
   * them, and read their own records. Nothing else of the answer is done here: its schedule, its state and its announcements belong to
   * a run that is over.
   */
  function answered(service: AccountService): void {
    deps.channel?.post({
      type: "data_changed",
      account: service.account,
      stores: ["drafts", "pending_effects", "resource_versions"],
    });
  }

  /**
   * The drafts that stand stopped are those the record, the markers and the page's memory name (`window.stopped`, every one that still
   * exists: the read was given all three). A draft this page stalled whose stop has since ended, by whichever writer's success or
   * abandonment or by a retry in another tab, is released, with the wait that stalling gave it (R46); nothing else of its schedule is
   * touched. Answers whether any draft was released.
   */
  function reconcileStalled(stopped: readonly LocalId[]): boolean {
    const standing = new Set<LocalId>(stopped);
    let released = false;
    for (const draft of [...stalled])
      if (!standing.has(draft)) {
        released = true;
        stalled.delete(draft);
        if (blockedUntil.get(draft) === Number.POSITIVE_INFINITY)
          blockedUntil.delete(draft);
      }
    for (const draft of standing) stalled.add(draft);
    return released;
  }

  // ---- helpers ---------------------------------------------------------------------------------------------------------------------
  async function readBody(response: Response): Promise<unknown> {
    try {
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.length === 0 || bytes.length > ERROR_BODY_LIMIT) return null;
      return JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      return null;
    }
  }

  function retryAfter(response: Response): number | null {
    const raw = response.headers.get("retry-after");
    if (raw === null) return null;
    const seconds = Number(raw);
    return Number.isFinite(seconds) && seconds >= 0
      ? Math.round(seconds * 1000)
      : null;
  }

  // ---- control ---------------------------------------------------------------------------------------------------------------------
  /** Work arrived (the outbox calls this on every save): an explicit act, which counts every time. */
  const wake = (): void => {
    if (ownership === null) return;
    scanAfter = undefined;
    fruitlessCycles = 0;
    void tick(generation, "signal");
  };

  /** The session view, the identity, visibility or the compatibility fact notified: news only if what a step reads changed. */
  const notified = (): void => {
    if (ownership === null) return;
    scanAfter = undefined;
    fruitlessCycles = 0;
    void tick(generation, "notified");
  };

  /**
   * Ends a back-off or a pause of the drafts it covers. `online` (the browser is reachable again) and an explicit "Retry now" /
   * "Try again" both do that; ONLY the explicit one also clears a local-write stop, because a stopped IndexedDB write is not a
   * connectivity problem and nothing but the person's retry (or that operation's own success) is allowed to lift it.
   */
  async function resume(
    localId: LocalId | undefined,
    explicit: boolean,
  ): Promise<void> {
    const id = generation;
    scanAfter = undefined;
    fruitlessCycles = 0;
    const service = deps.service();
    // An explicit retry is an act that begins NOW, and what stands now is what it lifts (R50, revision 31): the operations this
    // dispatcher knows to have failed, the drafts it stalled, the queue read's and the stops the page holds in memory (the facade's
    // included). A stop recorded while the retry is under way (it waits on the database, one operation at a time) is newer than the
    // person's decision, and is not lifted by it. A draft held back because its marker cannot be listed (R47, revision 29) is not among
    // them: the retry names no marker it has not read and removes none (R52, revision 32), so the hold is simply asked about again
    // below, and the draft goes when a listing lands and finds nothing; a listing that finds a stop makes it a stalled draft, which
    // the person's next retry lifts like any other.
    let acted: Issued | null = null;
    let lifting: string[] = [];
    if (explicit && service) {
      const covers = (operation: string): boolean =>
        localId === undefined || operationDraft(operation) === localId;
      const named = new Set<string>([
        ...[...failedOperations].filter(covers),
        ...[...stalled]
          .filter((draft) => localId === undefined || draft === localId)
          .flatMap((draft) => draftOperations(draft)),
        ...(localId === undefined && queueStopped(service)
          ? [QUEUE_OPERATION]
          : []),
        ...stops.operations(service).filter(covers),
      ]);
      acted = issue(service, named);
      lifting = [...named];
    }
    if (service) {
      try {
        await service.store.run(resumeDrafts, {
          incarnationId: service.incarnationId,
          localIds: localId === undefined ? "retrying" : [localId],
        });
        if (acted !== null) {
          const entitled = acted;
          for (const operation of lifting)
            await clearStreak(service, operation, entitled, {
              explicit: true,
              expect: entitled.durable.get(operation) ?? null,
            });
        }
      } catch {
        // Resuming is best effort; the step below re-reads the record.
      }
    }
    if (localId === undefined) {
      for (const draft of [...blockedUntil.keys()])
        if (explicit || (!stalled.has(draft) && !unreadable.has(draft)))
          blockedUntil.delete(draft);
      if (explicit) {
        stalled.clear();
        unreadable.clear();
      }
    } else if (
      explicit ||
      (!stalled.has(localId) && !unreadable.has(localId))
    ) {
      blockedUntil.delete(localId);
      stalled.delete(localId);
      if (explicit) unreadable.delete(localId);
    }
    if (!alive(id)) return;
    if (explicit && store.get().kind === "stopped")
      setState({ kind: "waiting", reason: "session" });
    void tick(id, "signal");
  }

  return {
    state: store,
    stops,

    start(next) {
      generation += 1;
      ownership = next;
      blockedUntil.clear();
      stalled.clear();
      unreadable.clear();
      // A draft whose stop only this tab's memory holds is still stopped: a restart is not a retry, and the tab is still alive. The
      // first step reads that memory with the markers and the record, so the draft is held back before anything is picked.
      scanAfter = undefined;
      fruitlessCycles = 0;
      notSent = 0;
      notCovered = 0;
      staleRun = 0;
      refusedRun = 0;
      for (const off of unsubscribe) off();
      unsubscribe = [
        deps.subscribe(notified),
        deps.compat.subscribe(notified),
        deps.onOnline(() => {
          if (ownership !== null) void resume(undefined, false);
        }),
        // Another writer of the page ended a stop (the facade's save, edit or discard of a draft this dispatcher holds back): look at
        // the queue again, so the draft is released or sent now and not at some later event. Only a dispatcher that holds something
        // back has anything to release, so a healthy page does not step for it.
        stops.subscribe((scope, from, news) => {
          if (from === self) return;
          const service = deps.service();
          if (
            service === null ||
            scope.account !== service.account ||
            scope.incarnationId !== service.incarnationId
          )
            return;
          // A stop another writer records while an attempt is under way is what the step that issues the request must still honour.
          for (const operation of news.recorded ?? [])
            announced?.add(operation);
          if ((news.ended?.length ?? 0) === 0) return;
          if (stalled.size > 0 || store.get().kind === "stopped") wake();
        }),
      ];
      bindAbort(generation, next.signal);
      setState({ kind: "idle" });
      void tick(generation, "start");
    },

    stop() {
      generation += 1;
      ownership = null;
      unbindAbort();
      clearTimer();
      for (const off of unsubscribe) off();
      unsubscribe = [];
      setState({ kind: "not_started" });
      resolveWaiters();
    },

    retry(localId) {
      if (ownership === null) return;
      void resume(localId, true);
    },

    wake,

    settled() {
      if (!busy && timer === null) return Promise.resolve();
      return new Promise<void>((resolve) => waiters.push(resolve));
    },
  };
}
