import type { Identity, StampedFetch, Store } from "../../session";
import type { AccountService, DataRuntime } from "../engine/account-service";
import {
  createDefaultsSource,
  type DefaultsSource,
} from "../engine/defaults-source";
import { startDeviceMirror } from "../engine/device-mirror";
import type { ReadResult } from "../engine/identity-task";
import {
  createProfileSource,
  type ProfileSource,
} from "../engine/profile-source";
import type { QuotaGuard } from "../engine/quota-guard";
import {
  defaultRecoverySeam,
  type RecoverySeam,
} from "../engine/recovery-seam";
import type { SyncChannel } from "../engine/sync-channel";
import type { InvalidationHold, SyncEngine } from "../engine/sync-engine";
import type {
  MarkerChange,
  WriteFailureMarkers,
} from "../engine/write-failure-marker";
import { DATA_CONFIG } from "../model/config";
import type { QueueSummary } from "../model/queue-summary";
import type { ReviewConfirmation } from "../model/review-confirmation";
import type { CacheState, StatusInputs } from "../model/status";
import type { AccountId, CacheRow, LocalId } from "../model/types";
import {
  type ConfirmReviewOutcome,
  createOutbox,
  type DiscardOutcome,
  type Outbox,
  type SupersedeOutcome,
} from "../outbox/outbox";
import {
  type CommandRegistry,
  type CurrentRead,
  createCommandRegistry,
} from "../outbox/registries";
import { readDraftWithCommand } from "../plans/draft-detail";
import { readSyncFacts, type SyncFacts } from "../plans/facts";
import type { ConflictPage, QueuePage } from "../plans/outbox";
import type { Loadable, Watchable } from "../store/port";

/**
 * The data layer as the UI sees it (plan 5.7, 6.1): ONE React-free controller per mounted protected tree. It follows the displayed
 * identity, opens that account's database ONLY IF IT ALREADY EXISTS (it never creates one: no screen of this slice has a reason
 * to), keeps the status model's inputs current, and exposes the few commands the screens call.
 *
 * It starts NO sync engine and NO outbox dispatcher: production has no leader until WEB-09b supplies ownership. A leader (the
 * fixture's test leader, and later WEB-09b's) registers itself with `attachLeader`, and the status model then follows its state. With
 * none attached the chip says "Updates stopped", which is true.
 *
 * The runtime is loaded LAZILY (`loadRuntime` is a dynamic import in the browser composition), so the controller itself carries no
 * Dexie and the initial bundle stays within its budget.
 */
export interface DataActions {
  /** "Retry now", "Retry applying changes", "Try again" for updates (the sync engine). */
  retryUpdates(): void;
  /** "Retry now" for one draft or for every paused one; "Try again" after local storage stopped answering. */
  retryChanges(localId?: LocalId): void;
  discard(localId: LocalId): Promise<DiscardOutcome>;
  /**
   * The defaults review's confirmation (WEB-12a): through the leader's facade when one is attached (its dispatcher sends the released
   * draft at once), else this page's. `closed` when no database is bound.
   */
  confirmDefaultsReview(
    localId: LocalId,
    confirmation: ReviewConfirmation,
  ): Promise<ConfirmReviewOutcome>;
  /** The queue could not be read (the data layer did not start): look again. */
  retryLoad(): void;
  /** WEB-09b (Q24): dismisses the "Resyncing" notice; it changes nothing else. */
  acknowledgeResync(id: string): void;
  /**
   * WEB-09b (WF-QUEUE-02, R7 of the review of 10 October 2026): the draft's target as the SERVER holds it now, through the kind's
   * registered authorised read (`CommandSpec.readCurrent`) and an ordinary stamped request of the displayed account and epoch. Never the
   * cache. `failed`/`unavailable` when there is no open account, no draft, or no read registered for its kind. The WHOLE result (the
   * command's decode and any later work) is released only if the durable record still names the account and epoch it was made for
   * (`session.api.seal`) and the call's scope stands (this controller's lifetime, its binding and service, `signal`); otherwise it is
   * `failed`/`unavailable` (review cycle 2, R7).
   */
  readCurrent(localId: LocalId, signal?: AbortSignal): Promise<CurrentRead>;
  /**
   * WEB-09b (WF-QUEUE-02): "Resend as a new operation" / "Review and save as a new attempt". Only for a draft whose kind registered
   * `rebuild`: the new command is built from the draft and `current`, the value the authorised read returned and the dialog showed (`null`
   * when the person explicitly continued without it), and SUPERSEDES the draft (a new operation id). Never rebuilt on the cache.
   * `related`: the other rows that read returned (`CurrentRead.related`), for the rebuild's checks only.
   * `not_rebuildable`: nothing is registered, or the rebuild declined; nothing was changed.
   */
  saveAsNew(
    localId: LocalId,
    current: CacheRow | null,
    related?: readonly CacheRow[],
  ): Promise<SaveAsNewOutcome>;
  /** The next window of the queue replaces the one shown. */
  showNextQueue(): void;
  /** The previous window of the queue replaces the one shown. */
  showPreviousQueue(): void;
}

export type SaveAsNewOutcome =
  | SupersedeOutcome
  | { kind: "refused"; reason: "not_rebuildable" | "closed" };

export interface DataEnv {
  readonly inputs: Store<StatusInputs>;
  /** The session's settled identity: a FACT for the label check, never a permission. */
  readonly identity: Store<Identity | null>;
  /**
   * The visible queue, a page at a time, in queue order (Q9: 100 rows, then the next window). `unavailable` when there is no database
   * (nothing was ever saved here) or it is latched. NOTHING reads the rows until a screen subscribes to this store; the chip, the
   * tab counts and the warning come from `summary`, which counts by index.
   */
  readonly queue: Store<Loadable<QueuePage>>;
  /** The drafts that need a decision (the conflict inbox), a bounded page, loaded only while subscribed. */
  readonly conflicts: Store<Loadable<ConflictPage>>;
  readonly summary: Store<Loadable<QueueSummary>>;
  readonly profile: ProfileSource;
  /** The displayed account's sharing defaults (B5, W14; WEB-12a): read only while a screen uses them, persisted as one record. */
  readonly defaults: DefaultsSource;
  readonly commands: CommandRegistry;
  readonly actions: DataActions;
  /** The facade of the displayed account's outbox, or null (no database yet): for the slices that save drafts. */
  outbox(): Outbox | null;
  /** The displayed account's open service, or null. Read-only views use it through the hooks; nothing here creates it. */
  service(): AccountService | null;
  /** The same, observable: a database that another tab creates later appears here without a reload. */
  readonly serviceStore: Store<AccountService | null>;
  /**
   * A sync leader (and a dispatcher) takes part: the status follows them. Returns a function that detaches THIS attachment (R30): it
   * acts only while this attachment is the leader that stands, and only once. Run late or again, after another leader replaced this one,
   * it does nothing: it never disconnects the replacement.
   */
  attachLeader(leader: {
    engine?: SyncEngine;
    outbox?: Outbox;
    recovery?: RecoverySeam;
  }): () => void;
  /**
   * WEB-09b (P-11): another page of this browser leads sync. The status is derived from the durable facts this controller already
   * re-reads, never "Updates stopped" merely because this page is not the leader. Returns the detacher (once, while it stands).
   */
  attachFollower(): () => void;
  /**
   * Starts following the identity, connectivity, the channel and the markers (R29). Idempotent, and it may follow a `dispose()`: a
   * controller is a start and stop PAIR, so that a provider can start it in an effect and stop it in the effect's cleanup however
   * often React replays them. A controller built with `start: false` does nothing until this is called.
   */
  start(): void;
  /**
   * Stops everything `start` began and lets go of the bound database (idempotent). The controller is not spent: `start()` follows it
   * again from the identity's current state.
   */
  dispose(): void;
}

export interface DataEnvOptions {
  /**
   * Whether the controller starts following at once (the default, for a caller that owns it: a test, the fixture). A React provider
   * passes `false` and starts it in an effect: construction runs in render and in state initialisers, which React may call twice and
   * discard, so it must not subscribe to anything (R29).
   */
  start?: boolean;
}

export interface DataEnvDeps {
  identity: Store<Identity | null>;
  /** Loads the runtime (the browser composition: Dexie, the host, the open predicate). Memoised by the controller. */
  loadRuntime(): Promise<DataRuntime>;
  online: Store<boolean>;
  quota: QuotaGuard;
  ids: { uuid(): string };
  clock: { iso(): string; now(): number; random?(): number };
  /** The session's fact about operations, for the stale-fence reconciliation (decision D-06). */
  fence(account: AccountId): {
    hasPendingOperation: boolean;
    sessionStarted: boolean;
  };
  /**
   * `GET /me` through `session.api.client("ordinary", account, epoch)`, CLASSIFIED: the decoded body, or why there is none (a failed
   * transport or a `5xx` is not an unrecognised status, and a request the session did not send is neither). Never a bare `null`.
   */
  readMe(account: AccountId, epoch: number): Promise<ReadResult<unknown>>;
  /** `session.operations.listSessions()`, classified the same way: the `device_id` of the current session's row. */
  currentDeviceId(): Promise<ReadResult<string>>;
  /**
   * `GET /defaults/snapshot` through the stamped client, classified the same way (WEB-12a). Absent: the sharing defaults are never
   * asked for (a test or harness that does not need them), and only a persisted record is shown.
   */
  readDefaultsSnapshot?(
    account: AccountId,
    epoch: number,
  ): Promise<ReadResult<unknown>>;
  onOnline(listener: () => void): () => void;
  /** The timers of the paced re-read of the sync facts (R13) and of the profile and device reads' schedules: the page's own when omitted. */
  timers?: {
    setTimeout(fn: () => void, ms: number): unknown;
    clearTimeout(handle: unknown): void;
  };
  /** `atlas-sync`: another tab created or changed the database. A hint, never evidence. */
  channel?: SyncChannel;
  /** The account's write-failure markers (`localStorage`): the facade restores a stop recorded before a reload. */
  markers?: WriteFailureMarkers;
  commands?: CommandRegistry;
  /**
   * WEB-09b (R7): the session's ORDINARY stamped fetch for the account and epoch (`session.api.fetchFor("ordinary", …)`) and the API
   * base, for the authorised current-state read of WF-QUEUE-02. Absent: no such read can be made here (`failed`/`unavailable`).
   */
  fetchOrdinary?(account: AccountId, epoch: number): StampedFetch;
  apiUrl?(path: string): URL;
  /**
   * WEB-09b (R7, second cycle): `session.api.seal`, the final validation of the read's WHOLE interpreted result against the durable
   * record (the command's decode and any later work included). Absent, like `fetchOrdinary`: no current read is made here.
   */
  seal?<T>(account: AccountId, epoch: number, pending: Promise<T>): Promise<T>;
}

class MutableStore<T> implements Store<T> {
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

const LOADING: Loadable<never> = { status: "loading" };
const ABSENT: Loadable<never> = { status: "unavailable", reason: "absent" };
const ERROR: Loadable<never> = { status: "unavailable", reason: "error" };

/**
 * A watched read as a store that LOADS NOTHING until it has a subscriber: its source (the facade's paged queue, or the conflict
 * page) is subscribed on the first listener and released on the last, so a protected tree with no queue screen open never re-reads
 * the queue on a change.
 */
class LazyWatch<T> implements Store<Loadable<T>> {
  private value: Loadable<T> = LOADING;
  private readonly listeners = new Set<() => void>();
  private source: Watchable<T> | null = null;
  private off: (() => void) | null = null;

  get(): Loadable<T> {
    return this.value;
  }
  private publish(next: Loadable<T>): void {
    if (Object.is(next, this.value)) return;
    this.value = next;
    for (const listener of [...this.listeners]) listener();
  }
  private attach(): void {
    const source = this.source;
    if (source === null || this.off !== null) return;
    this.off = source.subscribe(() => this.publish(source.get()));
    this.publish(source.get());
  }
  private release(): void {
    this.off?.();
    this.off = null;
  }
  /** Points the store at a facade's queue, or at nothing (`null`), keeping a subscribed screen subscribed. */
  use(source: Watchable<T> | null, fallback: Loadable<never>): void {
    this.release();
    this.source = source;
    this.publish(source === null ? fallback : LOADING);
    if (this.listeners.size > 0) this.attach();
  }
  fail(value: Loadable<never>): void {
    this.release();
    this.source = null;
    this.publish(value);
  }
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    if (this.listeners.size === 1) this.attach();
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) this.release();
    };
  }
}

const INITIAL: StatusInputs = {
  online: true,
  engine: null,
  recovery: { registered: false, active: false },
  cache: "unknown",
  lastSyncedAt: null,
  summary: null,
  outbox: null,
  storageNotResponding: false,
  storageMemoryOnly: false,
};

export function createDataEnv(
  deps: DataEnvDeps,
  options: DataEnvOptions = {},
): DataEnv {
  const inputs = new MutableStore<StatusInputs>({
    ...INITIAL,
    online: deps.online.get(),
  });
  const queue = new LazyWatch<QueuePage>();
  const conflicts = new LazyWatch<ConflictPage>();
  const summary = new MutableStore<Loadable<QueueSummary>>(LOADING);
  const commands = deps.commands ?? createCommandRegistry();
  const serviceStore = new MutableStore<AccountService | null>(null);
  /**
   * Whether this controller has finished LOOKING for the displayed account's database: opened it, or learnt that there is none. Until
   * it has, "no service" means "not known yet", not "there is none", and the profile read and the device mirror ask nothing, because
   * the durable retry budget of an earlier page (a pause, a count) cannot be read yet. It counts up when the answer arrives so the
   * readers wake and ask again.
   *
   * A look that FAILS (the runtime did not load, or the listing or the open rejected) is NOT an answer (R16, revision 10): whether the
   * database exists, and what budget it holds, are still unknown, so the readers keep waiting. Treating the failure as absence let
   * every remount start a fresh in-memory budget over a database that may hold a durable pause. The look is made again, paced, and
   * by `online`, another tab's hint and the person's own "Try again" (`retryLoad`); the screens read the failure meanwhile
   * (`queue`, `conflicts` and `summary` say they could not be read).
   *
   * What a look found belongs to ONE binding (R16, revision 11): it ends with the binding it described (the service ended, was
   * replaced or left for another account) and with the start of any later look, so a look that is pending or fails leaves the answer
   * unknown, never the older one. An older answer cannot say what the database holds NOW: it may have been closed and reopened, or
   * another sign-in may have counted or paused since. Nothing looks again by itself when a binding ends (a reopening here would undo
   * the latch of a wipe that closed it): the identity's next notification, `online`, another tab's hint and `retryLoad` do.
   */
  let lookedFor: AccountId | null = null;
  let attaching: { account: AccountId; id: number } | null = null;
  /** The account whose look failed and has not been made again: it is waited for, not reattached on every notification. */
  let lookFailed: AccountId | null = null;
  let lookFailures = 0;
  let lookTimer: unknown = null;
  const lookedForStore = new MutableStore<number>(0);
  const finishedLooking = (account: AccountId): void => {
    if (attaching?.account === account) attaching = null;
    // The look landed: the failure it followed, its pace and the timer that was going to look again are over.
    if (lookFailed === account) forgetFailedLook();
    if (lookedFor === account) return;
    lookedFor = account;
    lookedForStore.set(lookedForStore.get() + 1);
  };

  let runtime: Promise<DataRuntime> | null = null;
  const load = (): Promise<DataRuntime> => {
    if (runtime === null) {
      const loading: Promise<DataRuntime> = deps
        .loadRuntime()
        .catch((error: unknown) => {
          // A chunk that did not load is tried again on the next call (offline, not cached yet). Only the load that is still the
          // memoised one forgets itself: a load that a stop made obsolete must not erase the newer one a restart began (R29).
          if (runtime === loading) runtime = null;
          throw error;
        });
      runtime = loading;
    }
    return runtime;
  };

  let disposed = false;
  let generation = 0;
  let current: { account: AccountId; service: AccountService } | null = null;
  /**
   * The controller's lifetimes (R7, second cycle): `stop` begins a new one. A current read belongs to the lifetime and the binding it
   * began in, and each in-flight read's scope is aborted when either ends, so a read that outlives them answers nothing (even when its
   * command ignores the signal, and even when a later `start` or binding names the same account again).
   */
  let lifetime = 0;
  const currentReads = new Set<{
    bound: { account: AccountId; service: AccountService };
    scope: AbortController;
  }>();
  const endCurrentReads = (bound?: object): void => {
    for (const read of [...currentReads])
      if (bound === undefined || read.bound === bound) {
        currentReads.delete(read);
        read.scope.abort();
      }
  };
  let outbox: Outbox | null = null;
  let facts: Watchable<SyncFacts | null> | null = null;
  /**
   * What the sync facts of the BOUND database last said, read successfully (R13): the one authority for its display state. A read that
   * is pending or has failed does not replace it and does not erase it, so a cache that was known to be invalid stays hidden through
   * a failed read; with none (a database never read yet, or one whose singleton is missing) the cache is `unverified` and hidden.
   * Belongs to ONE binding (an account, an incarnation): a new binding starts with none.
   */
  let established: SyncFacts | null = null;
  let stopFacts: (() => void) | null = null;
  let rereadTimer: unknown = null;
  let rereadFailures = 0;
  /** Look again now at a failed read of the facts (an `online` event, another tab's hint, the person's "look again"); a no-op otherwise. */
  let rereadFacts: () => void = () => undefined;
  /**
   * Another page changed a marker this binding's display state depends on (R15): what the facts established is no longer trusted, so
   * the cache is hidden (`unverified`) and the facts are read afresh; what that read says, with the markers as they are then, decides.
   * A no-op with no binding.
   */
  let verifyFacts: () => void = () => undefined;
  const setTimer =
    deps.timers?.setTimeout ??
    ((fn: () => void, ms: number): unknown => setTimeout(fn, ms));
  const clearTimer =
    deps.timers?.clearTimeout ??
    ((handle: unknown): void => clearTimeout(handle as never));
  let leader: {
    engine?: SyncEngine;
    outbox?: Outbox;
    recovery?: RecoverySeam;
  } = {};
  let detach: Array<() => void> = [];
  let leaderOffs: Array<() => void> = [];
  /** The `attachLeader` call whose leader stands now (R30): a disposer acts only while the attachment that made it is this one. */
  let attachment: object | null = null;
  /** Another page leads (P-11), as the `attachFollower` call that stands says. */
  let follower: object | null = null;

  const patch = (next: Partial<StatusInputs>): void => {
    const merged = { ...inputs.get(), ...next };
    if (JSON.stringify(merged) !== JSON.stringify(inputs.get()))
      inputs.set(merged);
  };

  /**
   * The admitted invalidations (R10) of a leader that has since been detached, carried so that what the tab knows stays known: when
   * the write and its durable record could be made nowhere, the leader's memory is all that held them. Keyed like the leader's own
   * holds, so a carried hold can only hide the position it was admitted for, and never a newer cache.
   *
   * It belongs to the CONTROLLER, not to one of its lifetimes (R31): `stop` and `start` are a reversible pair (R29), so a stop
   * does not forget it, exactly as a stop of the engine keeps the engine's own holds. A hold ends only on evidence, from a read of
   * the sync facts that landed (`settleCarried`): the position or the database incarnation it was admitted for is not the one the
   * facts name, or the durable state now speaks for itself (the cache is no longer `valid`: the invalidation was written, and
   * whatever `valid` follows is a cache that recovery replaced it with). A reload loses it with the page, as it always did.
   */
  let carried: readonly InvalidationHold[] = [];
  const carry = (engine: SyncEngine | undefined): void => {
    if (engine === undefined) return;
    const next = [...carried];
    for (const hold of engine.invalidations.get())
      if (
        !next.some(
          (other) =>
            other.account === hold.account &&
            other.incarnationId === hold.incarnationId &&
            other.operation === hold.operation,
        )
      )
        next.push(hold);
    carried = next;
  };

  /**
   * What a read of the facts that landed says about the carried holds of ITS account (R31): the facts are the authority, so a hold is
   * kept only while they still describe the cache it was admitted for (the same database incarnation, the same position, still
   * `valid`). Another position or incarnation is another cache; a cache that is no longer `valid` has its invalidation recorded (or has
   * been replaced), so a hold must not outlive it and hide a recovered cache that happens to be named by the same position. Holds of
   * other accounts are not touched: that account's own read decides them. A missing singleton (`null`) is no evidence either way.
   */
  const settleCarried = (
    service: AccountService,
    value: SyncFacts | null,
  ): void => {
    if (value === null || carried.length === 0) return;
    const keep = carried.filter(
      (hold) =>
        hold.account !== service.account ||
        (hold.incarnationId === service.incarnationId &&
          value.cacheStatus === "valid" &&
          hold.operation === value.invalidateOperation),
    );
    if (keep.length !== carried.length) carried = keep;
  };

  /** Whether this tab holds an admitted invalidation of exactly this account, incarnation and position (the engine's, or carried). */
  const heldInMemory = (
    account: AccountId,
    incarnationId: string,
    operation: string,
  ): boolean =>
    [...(leader.engine?.invalidations.get() ?? []), ...carried].some(
      (hold) =>
        hold.account === account &&
        hold.incarnationId === incarnationId &&
        hold.operation === operation,
    );

  /**
   * The cache state the view gates on, for the BOUND database: with no open database nothing is readable and nothing is gated
   * (`unknown`); with one, what its sync facts last said, read successfully (`established`), EXCEPT that a pending or failed read
   * never opens the gate by itself (R13): with no earlier read the display state is `unverified` and the cache stays hidden, and a
   * failed read after a good one leaves that one standing. A cache the server has said is invalid stays hidden for as long as its
   * invalidation is outstanding (R10), whichever record of it survives: the durable failure streak at the position the facts were read
   * at (shared with every tab), the account's fallback marker for it (which survives a reload when even the streak could not be
   * written; one this page has established stays established while it cannot be read, and one it has never been able to read leaves
   * the cache `unverified`, R47), or this tab's engine, which holds it from its first failed write until the guarded write succeeds or the position is
   * superseded, whatever its state, its counter or a retry (so an offline wake, an explicit retry and a persistence hold that cannot
   * verify the commit change nothing). A record or hold at a position that has since moved on is never read: all three are keyed by
   * the position the facts name.
   */
  const cacheOf = (): CacheState => {
    markerUnread = false;
    if (current === null) return "unknown";
    const value = established;
    if (value === null) return "unverified";
    if (value.cacheStatus === "valid") {
      if (value.invalidating) return "invalid";
      const marker = deps.markers?.probe(
        {
          account: current.account,
          incarnationId: current.service.incarnationId,
        },
        value.invalidateOperation,
      );
      if (
        marker === "marked" ||
        heldInMemory(
          current.account,
          current.service.incarnationId,
          value.invalidateOperation,
        )
      )
        return "invalid";
      // A marker that cannot be read is not a marker that is absent (R47, revision 28): with no earlier read of it that landed, the
      // display state is not established, exactly as for a facts read that failed (R13), and the cache stays hidden until one does.
      // A marker this page already established stays established (`probe` says `marked`), so an offline event, a hint or an unrelated
      // write never reopens a cache the server said was invalid.
      if (marker === "unknown") {
        markerUnread = true;
        return "unverified";
      }
    }
    return value.cacheStatus;
  };
  /**
   * Whether the last derivation found the cache's marker unreadable (R47, revision 29), and the pace of the looks that follow: nothing
   * notifies this controller when a store becomes readable again (a `storage` event is another page's change, and an access that was
   * blocked raises none), so a cache hidden for an unreadable marker is derived again, paced like the facts' re-read, until the
   * marker can be read. It is a read of the page's own storage and asks nothing of the network.
   */
  let markerUnread = false;
  let markerTimer: unknown = null;
  let markerLooks = 0;
  const cancelMarkerLook = (): void => {
    if (markerTimer !== null) clearTimer(markerTimer);
    markerTimer = null;
  };
  const lookAtMarker = (): void => {
    if (!markerUnread) {
      cancelMarkerLook();
      markerLooks = 0;
      return;
    }
    if (markerTimer !== null) return;
    const wait = Math.min(
      DATA_CONFIG.factsReadRetryMaxMs,
      DATA_CONFIG.factsReadRetryMs * 2 ** markerLooks,
    );
    markerLooks += 1;
    markerTimer = setTimer(() => {
      markerTimer = null;
      recompute();
    }, wait);
  };

  const recompute = (): void => {
    const engine = leader.engine?.state.get() ?? null;
    const recovery = leader.recovery ?? defaultRecoverySeam;
    const leading = leader.outbox ?? null;
    const readSummary = summary.get();
    patch({
      online: deps.online.get(),
      engine,
      recovery: {
        registered: recovery.registered || follower !== null,
        active: recovery.active.get(),
        // Present only with WEB-09b's job (the default seam and a fixture's test leader have neither).
        ...(recovery.state ? { state: recovery.state.get() } : {}),
        ...(recovery.notice ? { notice: recovery.notice.get() } : {}),
      },
      // Absent (undefined) unless they apply, so a page with no production leader reports exactly what it did before WEB-09b.
      follower:
        follower !== null && leader.engine === undefined ? true : undefined,
      recoveryBlocked: established?.recoveryBlocked === true ? true : undefined,
      ...(follower !== null &&
      leader.engine === undefined &&
      established?.syncStops !== undefined
        ? { followerStops: established.syncStops }
        : {}),
      cache: cacheOf(),
      lastSyncedAt: established?.lastSyncedAt ?? null,
      summary: readSummary.status === "ready" ? readSummary.value : null,
      outbox: leading?.state.get() ?? null,
      storageNotResponding:
        (leading ?? outbox)?.storageNotResponding.get() ?? false,
      storageMemoryOnly: (leading ?? outbox)?.storageMemoryOnly.get() ?? false,
    });
    lookAtMarker();
  };

  const cancelReread = (): void => {
    if (rereadTimer !== null) clearTimer(rereadTimer);
    rereadTimer = null;
  };

  const unbind = (): void => {
    for (const off of detach) off();
    detach = [];
    if (current !== null) endCurrentReads(current);
    cancelReread();
    stopFacts = null;
    established = null;
    rereadFailures = 0;
    current = null;
    outbox = null;
    facts = null;
    // The answer of the look that found this binding ends with it (R16, revision 11), BEFORE the readers are told it is gone: a reader
    // that wakes on the change must find "not known", not the answer about a database it can no longer read.
    lookedFor = null;
    serviceStore.set(null);
    queue.use(null, ABSENT);
    conflicts.use(null, ABSENT);
    summary.set(ABSENT);
    recompute();
  };

  const bind = (account: AccountId, service: AccountService): void => {
    unbind();
    current = { account, service };
    serviceStore.set(service);
    const facade = createOutbox({
      service,
      quota: deps.quota,
      ids: deps.ids,
      clock: deps.clock,
      fence: () => deps.fence(account),
      ...(deps.channel ? { channel: deps.channel } : {}),
      ...(deps.markers ? { markers: deps.markers } : {}),
      // Its paced look after an unreadable record (R55, revision 36) runs on the controller's timers.
      timers: { setTimeout: setTimer, clearTimeout: clearTimer },
    });
    outbox = facade;
    /**
     * The live read of the sync facts. A read that FAILS ends the live query that made it, so it is made again, a little later and
     * then at a doubling pace (`factsReadRetryMs` to `factsReadRetryMaxMs`), until one lands; meanwhile what the last good read said
     * stands, and with none the cache is hidden (R13). Every landing read is the authority and ends the pacing.
     */
    const watchFacts = (): void => {
      stopFacts?.();
      const source = service.store.watch(readSyncFacts, {
        incarnationId: service.incarnationId,
      });
      facts = source;
      const off = source.subscribe(() => {
        if (current?.service !== service || facts !== source) return;
        const read = source.get();
        if (read.status === "ready") {
          established = read.value;
          settleCarried(service, read.value);
          rereadFailures = 0;
          cancelReread();
        } else if (read.status === "unavailable" && read.reason === "error") {
          scheduleReread(service);
        }
        recompute();
      });
      stopFacts = () => {
        off();
        stopFacts = null;
      };
    };
    const scheduleReread = (bound: AccountService): void => {
      if (rereadTimer !== null) return;
      const wait = Math.min(
        DATA_CONFIG.factsReadRetryMaxMs,
        DATA_CONFIG.factsReadRetryMs * 2 ** rereadFailures,
      );
      rereadFailures += 1;
      rereadTimer = setTimer(() => {
        rereadTimer = null;
        if (current?.service === bound && bound.live) watchFacts();
      }, wait);
    };
    rereadFacts = () => {
      const read = facts?.get();
      if (read?.status === "unavailable" && read.reason === "error") {
        cancelReread();
        watchFacts();
      }
    };
    verifyFacts = () => {
      established = null;
      rereadFailures = 0;
      cancelReread();
      watchFacts();
      recompute();
    };
    const syncSummary = (): void => {
      summary.set(facade.summary.get());
      recompute();
    };
    queue.use(facade.queue, ABSENT);
    conflicts.use(facade.conflicts, ABSENT);
    detach = [
      facade.summary.subscribe(syncSummary),
      () => {
        rereadFacts = () => undefined;
        verifyFacts = () => undefined;
        stopFacts?.();
      },
      facade.storageNotResponding.subscribe(recompute),
      facade.storageMemoryOnly.subscribe(recompute),
      service.onEnd(() => {
        if (current?.service === service) unbind();
      }),
      // The facade this binding made is this binding's: its observation (and the paced look it may have scheduled) ends with it, even
      // while the service lives on (a stop, an account switch). A leader's facade is its creator's and is never released here.
      () => facade.disposeObservation(),
    ];
    watchFacts();
    syncSummary();
  };

  const forgetFailedLook = (): void => {
    lookFailed = null;
    lookFailures = 0;
    if (lookTimer !== null) clearTimer(lookTimer);
    lookTimer = null;
  };

  /**
   * The look at `account`'s database failed: it is made again, paced (the facts' re-read pace, `factsReadRetryMs` doubling to
   * `factsReadRetryMaxMs`) for as long as the failure lasts, never faster, and never for an account the page has left. The look is
   * local (a listing of the databases, a chunk): it asks the network for nothing, and it is the only thing a failure schedules.
   */
  const lookAgain = (account: AccountId): void => {
    if (lookFailed !== null && lookFailed !== account) forgetFailedLook();
    lookFailed = account;
    if (lookTimer !== null) return;
    const wait = Math.min(
      DATA_CONFIG.factsReadRetryMaxMs,
      DATA_CONFIG.factsReadRetryMs * 2 ** lookFailures,
    );
    lookFailures += 1;
    lookTimer = setTimer(() => {
      lookTimer = null;
      if (
        !disposed &&
        lookFailed === account &&
        deps.identity.get()?.account_id === account
      )
        void attach(account);
    }, wait);
  };

  const attach = async (account: AccountId): Promise<void> => {
    const mine = ++generation;
    attaching = { account, id: mine };
    // A new look makes every earlier answer unknown (R16, revision 11), whichever account it was about and however it ends: only a
    // look that LANDS (`finishedLooking`) says again what is there. A bound service that is still live answers for itself.
    lookedFor = null;
    // The queue the screens read says so when the data layer could not start: never an empty queue it could not read. And the look is
    // NOT finished: whether the database exists is unknown, so the identity readers keep waiting and it is made again (R16).
    const failed = (): void => {
      if (disposed || mine !== generation) return;
      queue.fail(ERROR);
      conflicts.fail(ERROR);
      summary.set(ERROR);
      recompute();
      if (attaching?.id === mine) attaching = null;
      lookAgain(account);
    };
    let rt: DataRuntime;
    const loading = load();
    try {
      rt = await loading;
    } catch {
      failed();
      return;
    }
    if (disposed || mine !== generation) return;
    let outcome: Awaited<ReturnType<DataRuntime["open"]>>;
    try {
      // NEVER creates: a database exists only because another path (the first sync, a saved draft) made it.
      outcome = await rt.open(account, { create: false });
    } catch {
      failed();
      return;
    }
    if (disposed || mine !== generation) return;
    // A runtime that has been disposed UNDER a live controller (its owner let it go) answers `abandoned`, which says nothing about the
    // database (R35, revision 20): it is a failed look, never an absence (R12, R16). The runtime is dropped, so the next look loads one
    // that has not been disposed. (The provider stops this controller BEFORE it disposes the runtime, so an answer that arrives after
    // that is stale and returned above; this is for an owner that disposes a runtime its controller still uses.)
    if (outcome.kind === "refused" && outcome.reason === "abandoned") {
      if (runtime === loading) runtime = null;
      failed();
      return;
    }
    // An open that a closure of the account ended (a wipe, another tab's deletion or upgrade) says nothing about the database either
    // (R37, revision 21): the account was being closed under it. A failed look, made again on the paced schedule, which then finds the
    // database absent or present as it really is. The runtime is healthy and stays.
    if (outcome.kind === "refused" && outcome.reason === "closed") {
      failed();
      return;
    }
    // An opened result is admitted only while its service is LIVE (R59, revision 37). One delivered after a closure ended it (it was
    // closed, or its account latched, while the result was on its way) has already announced its end, and a binding made from it would
    // never hear it: it would stand over a dead service, and its look would say "finished" about a database nothing can read. Like an open
    // that a closure refused (R37), it says nothing about the database: a failed look, made again on the paced schedule, whose next open
    // is refused or authorised as the latch then says. The readers keep waiting meanwhile.
    if (outcome.kind === "opened" && !outcome.service.live) {
      failed();
      return;
    }
    if (outcome.kind === "opened") bind(account, outcome.service);
    else {
      unbind();
    }
    finishedLooking(account);
  };

  const follow = (): void => {
    const identity = deps.identity.get();
    if (identity === null) {
      generation += 1;
      attaching = null;
      lookedFor = null;
      forgetFailedLook();
      unbind();
      return;
    }
    if (current?.account === identity.account_id && current.service.live)
      return;
    // Already looking for this account's database: the session publishes a new identity object at every evaluation, and starting the
    // look again each time would keep it from ever finishing.
    if (attaching?.account === identity.account_id) return;
    // A look that failed is made again on its own pace (or an event), not on every notification of the same identity.
    if (lookFailed === identity.account_id) return;
    if (lookFailed !== null) forgetFailedLook();
    void attach(identity.account_id);
  };

  // A database another tab creates (the first sync) appears here without a reload: a hint from `atlas-sync`, and `online`.
  const reprobe = (): void => {
    const identity = deps.identity.get();
    // A binding whose service is no longer live is not one (R59, revision 37): the hint looks again, as `follow` does.
    if (identity !== null && (current === null || !current.service.live))
      void attach(identity.account_id);
    else rereadFacts();
  };

  /**
   * Another page wrote or removed one of this account's fallback markers (R15). It is a prompt and never a record: what is shown is
   * decided by a read of the facts begun AFTER the change and by the markers as they are when it lands, so a marker that appeared
   * hides the cache at once, and one that went (the guarded invalidation succeeded, or the position moved on) opens nothing by itself.
   * Only the marker of the position the facts name concerns an established state; with none established nothing is shown, and any
   * marker of the account may be the one the read has to take into account.
   */
  const onMarkerChange = (change: MarkerChange): void => {
    const bound = current;
    if (bound === null) return;
    const value = established;
    const concerns =
      value === null
        ? change.touches(bound.account)
        : change.touches(bound.account, value.invalidateOperation);
    if (concerns) verifyFacts();
  };

  // The profile read and the device mirror run inside the data layer's per-caller retry budget (plan 5.6): a notification of the
  // identity already being worked on starts nothing, and a failed read is asked again on its own schedule.
  const openServiceOf = (account: AccountId): AccountService | null =>
    current?.account === account && current.service.live
      ? current.service
      : null;
  const reads = {
    online: () => deps.online.get(),
    onOnline: deps.onOnline,
    service: openServiceOf,
    // Absence is known only when the look for this account FINISHED and bound nothing (R59, revision 37): a binding whose service is no
    // longer live (its end is on its way) says nothing about what the database holds, so the readers wait rather than take the
    // no-database path over a durable pause they cannot read.
    databasePending: (account: AccountId) =>
      openServiceOf(account) === null &&
      (lookedFor !== account || current !== null),
    onService: (listener: () => void) => {
      const offs = [
        serviceStore.subscribe(listener),
        lookedForStore.subscribe(listener),
      ];
      return () => {
        for (const off of offs) off();
      };
    },
    clock: {
      now: () => deps.clock.now(),
      random: () => deps.clock.random?.() ?? Math.random(),
    },
    timers: { setTimeout: setTimer, clearTimeout: clearTimer },
  };
  const profile = createProfileSource({
    ...reads,
    identity: deps.identity,
    readMe: (account, epoch) => deps.readMe(account, epoch),
  });
  const readDefaultsSnapshot = deps.readDefaultsSnapshot;
  const defaults = createDefaultsSource({
    ...reads,
    identity: deps.identity,
    quota: deps.quota,
    ...(readDefaultsSnapshot
      ? {
          readSnapshot: (account: AccountId, epoch: number) =>
            readDefaultsSnapshot(account, epoch),
        }
      : {}),
  });

  /** Subscribes to the attached leader's stores (and drops the subscriptions of the one before): the status follows them. */
  const followLeader = (): void => {
    for (const off of leaderOffs) off();
    leaderOffs = [
      leader.engine?.state.subscribe(recompute),
      leader.engine?.invalidations.subscribe(recompute),
      leader.outbox?.state.subscribe(recompute),
      leader.outbox?.storageNotResponding.subscribe(recompute),
      leader.outbox?.storageMemoryOnly.subscribe(recompute),
      leader.recovery?.active.subscribe(recompute),
      leader.recovery?.state?.subscribe(recompute),
      leader.recovery?.notice?.subscribe(recompute),
    ].filter((off): off is () => void => typeof off === "function");
  };

  /**
   * What a live controller holds: every subscription below, and the readers that follow the identity. `start` and `stop` are a PAIR
   * and either may be repeated (R29): nothing is subscribed or scheduled until `start`, and `stop` lets go of all of it, so a
   * construction that is discarded (a render React did not keep), a start that React replays and an unmount each leave nothing live.
   */
  let offs: Array<() => void> = [];
  let active = false;
  const start = (): void => {
    if (active) return;
    active = true;
    disposed = false;
    // The page's directory slot for its durable failures is taken while the controller runs and let go of when it stops (R55): a
    // construction that is discarded holds none.
    void deps.markers?.prepare();
    const stopProfile = profile.start();
    const stopDefaults = defaults.start();
    const stopMirror = startDeviceMirror({
      ...reads,
      identity: deps.identity,
      currentDeviceId: () => deps.currentDeviceId(),
    });
    offs = [
      deps.identity.subscribe(follow),
      deps.online.subscribe(() => {
        recompute();
        reprobe();
      }),
      deps.onOnline(reprobe),
      deps.channel?.subscribe((message) => {
        if (message.type === "data_changed") reprobe();
      }) ?? (() => undefined),
      deps.markers?.subscribe(onMarkerChange) ?? (() => undefined),
      stopProfile,
      stopDefaults,
      stopMirror,
    ];
    followLeader();
    // Connectivity and the leader may have moved while nothing was listening (a stop and a start): say what is true now.
    recompute();
    follow();
  };
  const stop = (): void => {
    if (!active) return;
    active = false;
    disposed = true;
    generation += 1;
    lifetime += 1;
    endCurrentReads();
    // The runtime a stopped controller loaded belongs to its owner's disposal; a restart loads its own.
    runtime = null;
    // A look that was under way belongs to the lifetime that began it: left standing, it would make the restart's `follow` believe the
    // database is already being looked for, and nothing would ever look (the stale look itself ends silently, its generation is gone).
    attaching = null;
    forgetFailedLook();
    // `carried` is NOT forgotten (R31): a stop is reversible, and what a detached leader admitted may be recorded nowhere else.
    for (const off of offs) off();
    offs = [];
    for (const off of leaderOffs) off();
    leaderOffs = [];
    unbind();
    deps.markers?.release();
  };

  const actions: DataActions = {
    // The job holds the cache while it stands in a state of its own (a stop, a pause, the blocking budget): its retry is the act; else
    // the engine's.
    retryUpdates: () => {
      // A FOLLOWER has neither the engine nor the job (R2 of the review of 10 October 2026): the act is the leading page's, asked on
      // `atlas-sync` for the account and the epoch this page shows; the leader applies it only if it is bound to exactly those.
      if (follower !== null && leader.engine === undefined) {
        const identity = deps.identity.get();
        if (identity !== null)
          deps.channel?.post({
            type: "retry_requested",
            account: identity.account_id,
            epoch: identity.epoch,
          });
        return;
      }
      const job = leader.recovery;
      const state = job?.state?.get();
      if (
        job?.retryNow !== undefined &&
        (state?.kind === "stopped" ||
          state?.kind === "paused" ||
          state?.kind === "backing_off" ||
          state?.kind === "admission_wait" ||
          established?.recoveryBlocked === true)
      )
        job.retryNow();
      else leader.engine?.retryNow();
    },
    acknowledgeResync: (id) => leader.recovery?.acknowledge?.(id),
    retryChanges: (localId) => (leader.outbox ?? outbox)?.retry(localId),
    retryLoad: () => {
      const identity = deps.identity.get();
      if (identity !== null) void attach(identity.account_id);
    },
    showNextQueue: () => outbox?.showNext(),
    showPreviousQueue: () => outbox?.showPrevious(),
    confirmDefaultsReview: async (localId, confirmation) => {
      const facade = leader.outbox ?? outbox;
      if (facade === null)
        return { kind: "refused", reason: "closed" } as ConfirmReviewOutcome;
      // What the draft's commands need of the person's access, from the slices' registry (WEB-10a DA17-N2).
      return facade.confirmDefaultsReview(localId, confirmation, (draft) =>
        commands.admission(draft),
      );
    },
    discard: async (localId) => {
      const facade = outbox;
      if (facade === null)
        return { kind: "refused", reason: "closed" } as DiscardOutcome;
      return facade.discard(localId);
    },
    readCurrent: async (localId, signal) => {
      const bound = current;
      const identity = deps.identity.get();
      const fetchOrdinary = deps.fetchOrdinary;
      const apiUrl = deps.apiUrl;
      const seal = deps.seal;
      const unavailable: CurrentRead = {
        kind: "failed",
        reason: "unavailable",
      };
      if (
        !active ||
        bound === null ||
        !bound.service.live ||
        identity === null ||
        identity.account_id !== bound.service.account ||
        fetchOrdinary === undefined ||
        apiUrl === undefined ||
        seal === undefined ||
        signal?.aborted === true
      )
        return unavailable;
      // The call's scope (R7, second cycle): the lifetime and the binding it began in, the caller's signal, and an abort of its own
      // that `stop` and `unbind` send. Checked before each step that could send and, synchronously, at release.
      const account = identity.account_id;
      const epoch = identity.epoch;
      const born = lifetime;
      const scope = new AbortController();
      const onCaller = () => scope.abort();
      signal?.addEventListener("abort", onCaller, { once: true });
      const read = { bound, scope };
      currentReads.add(read);
      const live = (): boolean =>
        !scope.signal.aborted &&
        active &&
        lifetime === born &&
        current === bound &&
        bound.service.live;
      try {
        const service = bound.service;
        const draft = await service.store
          .run(readDraftWithCommand, {
            incarnationId: service.incarnationId,
            localId,
          })
          .catch(() => null);
        if (draft === null || !live()) return unavailable;
        const stamped = fetchOrdinary(account, epoch);
        const interpreted = commands.readCurrent(draft, {
          get: (path) =>
            live()
              ? stamped(
                  new Request(apiUrl(path), {
                    method: "GET",
                    signal: scope.signal,
                  }),
                )
              : Promise.reject(
                  new DOMException("the read's scope has ended", "AbortError"),
                ),
          signal: scope.signal,
        });
        // The WHOLE interpretation (the command's decode and whatever it does after it) is sealed against the durable record of the
        // account and epoch the read was made for: a result is released only if that record still names them AFTER the last
        // asynchronous step. Every outcome is sealed, a failure too: an `inaccessible` of an account no longer shown is no answer.
        let result: CurrentRead;
        try {
          result = await seal(account, epoch, interpreted);
        } catch {
          return unavailable;
        }
        // Nothing asynchronous after the record's verdict: the call's own scope is checked synchronously, and the result handed back.
        return live() ? result : unavailable;
      } finally {
        signal?.removeEventListener("abort", onCaller);
        currentReads.delete(read);
      }
    },
    saveAsNew: async (localId, base, related) => {
      const bound = current;
      const facade = leader.outbox ?? outbox;
      if (bound === null || facade === null || !bound.service.live)
        return { kind: "refused", reason: "closed" };
      const service = bound.service;
      const draft = await service.store.run(readDraftWithCommand, {
        incarnationId: service.incarnationId,
        localId,
      });
      if (draft === null || !commands.canRebuild(draft))
        return { kind: "refused", reason: "not_rebuildable" };
      // R7: rebuilt on the value of the authorised current read the person reviewed, never on the cache.
      const next = commands.rebuild(draft, base, related);
      if (next === null) return { kind: "refused", reason: "not_rebuildable" };
      return facade.supersede(localId, next);
    },
  };

  if (options.start !== false) start();

  return {
    inputs,
    identity: deps.identity,
    queue,
    conflicts,
    summary,
    profile,
    defaults,
    commands,
    actions,
    outbox: () => outbox,
    service: () => (current?.service.live ? current.service : null),
    serviceStore,
    attachLeader(next) {
      // A leader that is replaced keeps what it knew of the cache it could not write an invalidation for.
      if (leader.engine !== next.engine) carry(leader.engine);
      leader = next;
      // This call's own identity (R30). `leaderOffs` is the subscriptions of whichever leader stands NOW, so a disposer may only act on
      // them while its own attachment is the one that stands: an obsolete one (its leader was replaced, or it has already run) would
      // otherwise cut the replacement's engine, invalidation, outbox and recovery subscriptions, and the status would stop following
      // a leader that is still there. Compared by the call, never by the leader object: the same object may be attached again.
      const mine = {};
      attachment = mine;
      followLeader();
      recompute();
      return () => {
        if (attachment !== mine) return;
        attachment = null;
        for (const off of leaderOffs) off();
        leaderOffs = [];
        carry(next.engine);
        leader = {};
        recompute();
      };
    },
    attachFollower() {
      const mine = {};
      follower = mine;
      recompute();
      return () => {
        if (follower !== mine) return;
        follower = null;
        recompute();
      };
    },
    start,
    dispose: stop,
  };
}
