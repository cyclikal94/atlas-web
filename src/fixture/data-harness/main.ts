import {
  type AccountService,
  DataRuntime,
  unorderedPersistence,
} from "../../data/engine/account-service";
import {
  createOutboxDispatcher,
  type DispatcherState,
  type OutboxDispatcher,
} from "../../data/engine/outbox-dispatcher";
import {
  createQuotaGuard,
  type QuotaGuard,
} from "../../data/engine/quota-guard";
import { defaultRecoverySeam } from "../../data/engine/recovery-seam";
import {
  createBroadcastSyncChannel,
  type SyncMessage,
} from "../../data/engine/sync-channel";
import {
  createSyncEngine,
  type EngineState,
  type SyncEngine,
} from "../../data/engine/sync-engine";
import { createWriteFailureMarkers } from "../../data/engine/write-failure-marker";
import { DATA_CONFIG, type DataConfig } from "../../data/model/config";
import type { EnqueueRequest, TargetSpec } from "../../data/model/outbox";
import type { QueueSummary } from "../../data/model/queue-summary";
import type { StoreName } from "../../data/model/schema";
import { accountDatabaseName, DEXIE_SCHEMA_V1 } from "../../data/model/schema";
import {
  captureDefaults,
  type DefaultsCapture,
  type DefaultsRecord,
  parseSharingSnapshot,
  type TemplateKind,
} from "../../data/model/sharing-snapshot";
import {
  type CacheState,
  deriveGate,
  deriveNotices,
  type GateState,
  type Notice,
} from "../../data/model/status";
import { initialSyncState } from "../../data/model/sync-state";
import type {
  AccountId,
  DraftRow,
  JsonObject,
  JsonValue,
  ProjectionPatch,
} from "../../data/model/types";
import { createOutbox, type Outbox } from "../../data/outbox/outbox";
import { createConflictHandlerRegistry } from "../../data/outbox/registries";
import { readDefaults, writeDefaults } from "../../data/plans/defaults";
import { readSyncFacts } from "../../data/plans/facts";
import {
  releaseFence,
  setClosing,
  setDraftFence,
} from "../../data/plans/fence";
import { saveFormRecovery } from "../../data/plans/form-recovery";
import {
  enqueueDraft,
  readLocalWriteStops,
  readQueueSummary,
} from "../../data/plans/outbox";
import { recordReadOutcome } from "../../data/plans/retry-state";
import { createDataDeletionPorts } from "../../data/ports/deletion-ports";
import { createFormRecoveryPort } from "../../data/ports/form-recovery";
import {
  createKeyDerivers,
  createValueValidators,
} from "../../data/scan/validate";
import { createDexieOpener } from "../../data/store/dexie-adapter";
import type { DatabaseHost } from "../../data/store/host";
import { createIdbHost } from "../../data/store/idb-host";
import {
  type EngineOpener,
  type OpenDeps,
  type OpenOutcome,
  openAccountData,
} from "../../data/store/open";
import type { AccountStore, Plan } from "../../data/store/port";
import { StoreFailure, w } from "../../data/store/port";
import { createRegistry, getPageRegistry } from "../../data/store/registry";
import { createDataEnv, type DataEnv } from "../../data/ui/env";
import { readDefaultsSnapshotThrough } from "../../data/ui/identity-reads";
import { createProductionQuota } from "../../data/ui/production-quota";
import { NOT_SENT_DELAYS_MS } from "../../features/settings/sessions-devices/until-sent";
import { apiUrl } from "../../lib/api-client/wire";
import type { FormRecoveryPort } from "../../lib/form-recovery/port";
import type { Session } from "../../session";
import {
  createWebLocksPort,
  type Identity,
  openHold,
  StampedRequestError,
  type Store,
} from "../../session";
import {
  type Assert,
  blockerPlan,
  CONFORMANCE_CASES,
  type ConformanceWorld,
  listPlan,
  putPlan,
} from "./conformance";

/**
 * FIXTURE ONLY. The data harness (`/__data`): the PRODUCTION Dexie adapter, raw-IndexedDB host, registry and open predicate in a
 * real browser engine, with no session and no backend. It exists because the store double is only trusted once the real
 * engines have passed the same conformance suite, and because the account-database behaviours (create, never-create,
 * versionchange, deletion) can only be proved in an engine. A passing run is fixture evidence for THIS ENGINE ON THIS MACHINE:
 * not real Safari, not a device, and not quota (a real engine cannot be made to raise `QuotaExceededError` on request).
 *
 * The identity facts the open predicate reads are the harness's own (`setIdentity`, `setPending`): there is no session here.
 */
export interface ConformanceResult {
  id: string;
  title: string;
  ok: boolean;
  error?: string;
}

export interface DataHarness {
  tabId: string;
  host: DatabaseHost;
  opener: EngineOpener;
  /** The registry's view, for assertions about latches. */
  latch(account: AccountId): string;
  openCount(account: AccountId): number;
  setIdentity(account: AccountId | null): void;
  setPending(account: AccountId, pending: boolean): void;
  open(account: AccountId, options?: { create?: boolean }): Promise<string>;
  /** The stores held by the harness, by account (opened through `open`). */
  stores: Map<AccountId, AccountStore>;
  run<I, R, O>(account: AccountId, plan: Plan<I, R, O>, input: I): Promise<O>;
  runConformance(): Promise<ConformanceResult[]>;
  /** Generic helpers over a store of an open account (the conformance plans). */
  put(account: AccountId, store: StoreName, rows: object[]): Promise<number>;
  rows(account: AccountId, store: StoreName): Promise<object[]>;
  /** Closes this page's handle for an account without latching (an ordinary close). */
  close(account: AccountId): void;
  /** Calls the ENGINE opener directly with `create: false`, bypassing the `databases()` probe: the race where a database vanishes between probe and open. */
  openDirect(account: AccountId): Promise<string>;
  /** The incarnation the open handle captured. */
  incarnation(account: AccountId): string | null;
  /** Runs a plan that fails with its `cause`, or returns "ok". */
  tryRows(account: AccountId, store: StoreName): Promise<string>;
  /** What the engine itself says about the database: store names, index definitions, singleton present. */
  describe(account: AccountId): Promise<DatabaseDescription | null>;
  list(): Promise<string[]>;
  /** External damage: remove the singleton row with raw IndexedDB, as another tool could. */
  removeSingleton(account: AccountId): Promise<void>;
  /**
   * Creates the account's database EXACTLY as version 1 of the schema made it (raw IndexedDB, Dexie's version 1 is IndexedDB version
   * 10), with drafts whose `command` is still inside the row: what a browser that ran the earlier build holds. The upgrade spec then
   * opens it with the production adapter.
   */
  createLegacyV1(
    account: AccountId,
    drafts: Array<{ local_id: string; created_seq: number; command: object }>,
  ): Promise<void>;
  versionChanges: Array<{ account: AccountId; kind: string }>;
  /** The production deletion ports, exactly as `boot` registers them. */
  ports: ReturnType<typeof createDataDeletionPorts>;
  /** The write-failure markers (the only `localStorage` user of the data layer). */
  markers: ReturnType<typeof createWriteFailureMarkers>;
  /** A per-page runtime over the harness's own identity (there is no session here), and what goes with it. */
  runtime: DataRuntime;
  /** Sets the identity the runtime follows; returns nothing. A transition ends services of other accounts (G4). */
  setRuntimeIdentity(next: { account: AccountId; epoch: number } | null): void;
  openService(
    account: AccountId,
    options?: { create?: boolean },
  ): Promise<string>;
  /** A response-applying commit (a read failure recorded for a caller) stamped with the given epoch, through G1 to G3. */
  commitProbe(
    account: AccountId,
    epoch: number,
    caller: string,
  ): Promise<string>;
  /**
   * The recovery port over the account's real store. `estimateFreeBytes` (FIXTURE quota injection, R33, revision 18: a real engine cannot be
   * made to raise `QuotaExceededError` on request) gives it the PRODUCTION quota guard (`createProductionQuota`: the origin's IndexedDB ledger
   * and the page's Web Locks) over an estimate of that many free bytes, instead of no guard at all. Each call replaces the previous guard.
   */
  formRecovery(
    account: AccountId,
    options?: { estimateFreeBytes?: number },
  ): FormRecoveryPort;
  /**
   * E-R2: overlapping recovery ports over one real service (R1, revision 6). An older port's capture is held in its quota estimate
   * while a replacement port saves newer text; then the older capture is let go. The newer text must stand, and the older capture
   * must be one refused write, reported as not saved.
   */
  recoveryOverlap(account: AccountId): Promise<{
    replacement: string;
    older: string;
    final: string | undefined;
    row: { writer_gen?: number; capture_seq: number } | undefined;
  }>;
  /**
   * E-R3 (R1, revision 19): named recovery ports over this page's real account store, for the schedules in which a capture must WAIT in its
   * quota admission (which a real engine cannot be asked to do) while the same form is claimed by another real page context. The port is the
   * PRODUCTION one over the real store; the admission is the one injection: with `held`, the port's first estimate waits until
   * `recoveryRelease`, and everything else is admitted at once (a gate that controls SCHEDULING, not quota; fixture only, named in every
   * report that uses it). The form is `RECOVERY_ORDER_FORM` and the tab `RECOVERY_ORDER_TAB`. `recoveryStart` makes the calls in order,
   * without waiting (a call's place in the order, and its writer's claim, are fixed at the call); `recoveryReached` resolves when the first
   * admission is waiting; `recoveryResults` waits for every started call and answers `saved`/`failed`/`refused` for a save and `done` for a
   * discard.
   */
  recoveryRun(
    account: AccountId,
    name: string,
    options: { held: boolean },
  ): void;
  recoveryStart(
    name: string,
    calls: Array<{ kind: "save"; text: string } | { kind: "discard" }>,
  ): void;
  recoveryReached(name: string): Promise<void>;
  recoveryRelease(name: string): void;
  recoveryResults(name: string): Promise<string[]>;
  recoveryLoad(account: AccountId): Promise<string | null>;
  /**
   * E-P2: a persistence hold that RUNS OUT (R2, revision 6), with real components where they matter: the kernel's own hold
   * lifecycle (`openHold`) over real Web Locks and `AbortSignal.timeout`, the production Dexie adapter, a real transaction queued
   * behind a real long one, and a real exclusive request for `atlas-auth` standing for a settlement. There is no session record on
   * this page, so the verdict is "current"; what is shown is the ORDER: whether the queued commit can persist after the lock has
   * been given up. `blockerMs` is how long the long transaction stays open; shorter than `holdMs` is the control.
   */
  holdExpiry(options: {
    account: AccountId;
    holdMs: number;
    stallMs: number;
    blockerMs: number;
  }): Promise<{
    outcome: string;
    /** Milliseconds from the settlement's request to its grant, or null if it never was. */
    settlementGrantedAfterMs: number | null;
    /** Milliseconds from the commit's start to its answer. */
    commitAnsweredAfterMs: number;
    trace: string[];
    /** Whether the commit's row is durable. */
    written: boolean;
  }>;
  /** Direct raw read of a sync_state field, for assertions. */
  syncState(account: AccountId): Promise<Record<string, unknown> | null>;
  /** Sets `draft_fence.closing` through this page's own handle, WITHOUT the broadcast the real port also posts. */
  markClosing(account: AccountId): Promise<void>;
  /**
   * The TEST LEADER (fixture only; production starts no engine until WEB-09b supplies leadership). Runs the production sync engine
   * against the production session's stamped wrapper, for the account the session has settled. The database must exist in the
   * delta phase with a valid cache: `seedDelta` arranges that (the real first snapshot is WEB-09b's).
   */
  startSync(
    account: AccountId,
    options?: {
      deviceMemoryGiB?: number;
      seedCursor?: string;
      /** FIXTURE: the yield between pages, for the P-9 comparison. */
      yieldPolicy?: YieldPolicy;
    },
  ): Promise<void>;
  /**
   * The same engine with NO session: the harness's own runtime and identity, and a transport the caller supplies (the device profiling
   * page, where the real stamped wrapper is not present). FIXTURE ONLY.
   */
  startSyncLocal(
    account: AccountId,
    options: {
      transport: (request: Request) => Promise<Response>;
      seedCursor?: string;
      deviceMemoryGiB?: number;
    },
  ): Promise<void>;
  stopSync(): void;
  /**
   * FIXTURE (R42, revision 23): what the persistence hold of this page's OWN runtime (`startSyncLocal`'s) answers. `none`: the hold
   * that orders nothing (the default, a page with no session record). `unavailable`: the answer a hold that could not be had gives
   * (`AccountService.commit` DROPS the commit, as `unverified`): a NAMED injection of the port's outcome, not a claim about real lock
   * contention. `pending`: the hold never answers, so a commit stays in flight for as long as the page lives (a page that is then closed
   * is a crash mid-attempt, the one case the crash-loop marker exists for).
   */
  setPersistenceFault(mode: "none" | "unavailable" | "pending"): void;
  /** FIXTURE (R26): the engine is started again WITHOUT being stopped, under a new ownership signal; the signal it replaced is kept. */
  restartSync(): void;
  /** FIXTURE (R26): the signal that the last `restartSync` replaced is aborted now, as an ownership change that reaches this page late would. */
  abortReplacedOwnership(): void;
  /** FIXTURE: the engine's current ownership signal is aborted (leadership lost) and nothing else happens. */
  loseSyncOwnership(): void;
  /** FIXTURE (R27): the engine's NEXT quota check is held, as a slow `navigator.storage.estimate()` would hold it, until `releaseQuota`. */
  holdQuota(): void;
  /** FIXTURE: the number of session notifications (view, identity, visibility) the sync engine started by `startSync` has been told of. */
  wakeNotifications(): number;
  releaseQuota(): void;
  seedDelta(account: AccountId, cursor: string): Promise<void>;
  engineState(): EngineState | null;
  retrySync(): void;
  /** Asks the running engine to look now (the live-edge poll is a minute away): FIXTURE-only trigger for the integration specs. */
  nudgeSync(): void;
  /**
   * The admitted invalidations whose write is outstanding in this page's engine (R10, revision 9): `invalidate:<cursor>`, whatever
   * the engine is doing, whatever recorded the failure and whether or not a retry has run. FIXTURE.
   */
  invalidationHolds(): string[];
  /**
   * Builds the PRODUCTION controller (`createDataEnv`) over this page's runtime and identity, with the test leader's engine attached,
   * so `gate()` and `gateNotices()` are what a screen would derive from it. The controller never creates a database. FIXTURE ONLY:
   * production attaches no leader until WEB-09b.
   */
  startGate(
    account: AccountId,
    options?: {
      established?: boolean;
      isolated?: boolean;
      /**
       * WEB-12a review 4 (R10): the controller reads the sharing defaults through the production reader (`GET /defaults/snapshot` on the
       * session's stamped client), so a spec can drive its PRODUCTION defaults source over real IndexedDB.
       */
      defaults?: boolean;
    },
  ): Promise<void>;
  /**
   * WEB-12a review 4 (R10): the defaults source of the controller of `startGate({ defaults: true })` and the incarnation of the database
   * it is bound to (null: none bound). FIXTURE.
   */
  gateDefaults(): {
    boundary: DataEnv["defaults"]["boundary"];
    acquire: DataEnv["defaults"]["acquire"];
    revision: () => string | null;
  } | null;
  gateIncarnation(): string | null;
  /**
   * The reads of the sync facts that the controller of `startGate` has made itself, since it was started (R49, revision 30): `starts` is
   * the live queries it began (a bind, or a re-read after a marker or a failure), `emissions` the results they delivered, and `calls` EVERY
   * plan the controller (and the outbox facade it builds) starts through its store, a live query or a `run` of any plan: an unrelated
   * marker must cost none, whichever component would read. Counted at the controller's own store, so no other reader of the page (the
   * production tree's controller, the outbox, another runtime) is in it; a live query that Dexie runs AGAIN after a write is an
   * emission and no call.
   */
  gateFactsReads(): { starts: number; emissions: number; calls: number };
  /** `null` until `startGate` has run. */
  gate(): GateState | null;
  /** The controller's cache state as the gate reads it (`unverified` until its first read of the facts lands, R13). */
  gateCache(): CacheState | null;
  /**
   * Every change of the controller's cache state since `startGate` (or since `resetGateHistory`), in order: the exact transitions a
   * screen could have rendered, which polling `gateCache()` cannot show (R15: a follower that never reads `valid` again).
   */
  gateHistory(): CacheState[];
  resetGateHistory(): void;
  /**
   * Why this page's connection registry and the controller's service changed, with the page's clock: every latch the registry set
   * (`[ms, account, latch]`) and every end of a service the gate controller followed (`[ms, reason]`). FIXTURE diagnostics: a spec
   * that sees a binding end can say why.
   */
  gateDiagnostics(): {
    latches: Array<[number, string, string]>;
    ends: Array<[number, string]>;
    /**
     * Every `closeAll` that anything made on this page's connection registry (R34, revision 19): `[ms, account, latch or "", the top of
     * the call stack]`. A close of the registry ends EVERY connection of the account on the page, the production tree's controller's and
     * this harness's second runtime's alike, so a spec that finds its store closed can say who closed it and when.
     */
    closes: Array<[number, string, string, string]>;
  };
  gateNotices(): Notice[];
  /** Detaches and drops the controller of `startGate` (a reload does this by itself). */
  stopGate(): void;
  /** Every `atlas-sync` message this page's engine posted, and every message it received. */
  syncPosted: SyncMessage[];
  syncReceived: SyncMessage[];
  /** The engine's own trace events (fixed vocabulary), for assertions about why a step ran. */
  engineTrace: string[];
  /** Listen on `atlas-sync` in this page (a follower). */
  follow(): void;
  /**
   * The fixture-only TEST LEADER for the outbox (production starts no dispatcher until WEB-09b supplies leadership): the
   * production dispatcher and facade against the production session's stamped wrapper and compatibility fact.
   */
  startOutbox(
    account: AccountId,
    options?: {
      config?: Partial<DataConfig>;
      start?: boolean;
      /** Arranges a delta database with a valid cache at this cursor first (FIXTURE; the real first snapshot is WEB-09b's). */
      seedCursor?: string;
      /**
       * FIXTURE quota injection (a real engine cannot be made to raise `QuotaExceededError` on request): the outbox's quota guard reads
       * THIS as the origin's free bytes instead of `navigator.storage.estimate()`. Named in every report that uses it.
       */
      estimateFreeBytes?: number;
      /**
       * Builds the outbox's guard with the PRODUCTION factory (`createProductionQuota`), whose ledger is the origin's IndexedDB record that
       * every page of the origin shares (R28), instead of the in-page ledger. The free space is still the named injection above.
       */
      originLedger?: boolean;
      /**
       * FIXTURE clock injection (with `originLedger`): the outbox's guard reads `Date.now()` this many milliseconds ahead. The holds that
       * ANOTHER page made then look as though their leases are over from this page's point of view, which is what a page whose clock has
       * moved (or whose neighbour has been suspended) sees; whether the hold is nevertheless honoured is what the owner's real Web Lock
       * decides. A real engine cannot freeze a page on request, so this is the named injection, and every report that uses it says so.
       */
      quotaClockOffsetMs?: number;
      /**
       * FIXTURE estimate injection (R28, revision 17; with `estimateFreeBytes`): the injected estimate LAGS like the browser's, showing a
       * write that `noteLanded` told it of only to a request made one estimate lifetime (`quotaEstimateTtlMs`, real time) after the
       * write landed, and answering what was true when the request BEGAN. Without it the injected estimate never shows a write. A real
       * engine cannot be made to lag on request; this is the named injection and every report that uses it says so.
       */
      estimateLagsWrites?: boolean;
      /**
       * FIXTURE clock injection (R28, revision 17; with `originLedger`): gives the guard the page's own monotonic clock
       * (`performance.now()`), as the production default does, so that `setQuotaClockOffset` is a STEP of the wall clock (the monotonic
       * clock does not move with it) instead of the whole clock moving, which is what the maximum-age cases rely on.
       */
      quotaMonotonic?: boolean;
    },
  ): Promise<void>;
  /**
   * FIXTURE snapshot seeder for the integration specs: opens (creating) the account's database, reads the account's REAL snapshot
   * through the stamped wrapper page by page, writes its projections to `cache` and leaves the database in the delta phase at the
   * server's own cursor, so later ordinary pages are real. The real first snapshot is WEB-09b's; nothing production calls this.
   */
  prepareAccount(
    account: AccountId,
  ): Promise<{ pages: number; resources: number; cursor: string }>;
  /** Starts the dispatcher of an outbox that was started with `start: false` (queue first, send after). */
  beginOutbox(): void;
  stopOutbox(): void;
  outboxState(): DispatcherState | null;
  /**
   * FIXTURE diagnostics (R57, revision 33): what this page's harness outbox is bound to NOW. The facade is built over ONE service, captured
   * when `startOutbox` ran; a registry that is closed afterwards (the protected tree's disposal when another page boots) ends that service
   * for good, and the aggregate numbers a spec waits on (the registry's open count, the leases, the quiet) cannot say so, because the tree
   * opens its own connections again. `live` is the captured service's, `sameService` whether it is still the page's current service of the
   * account, and `closes` the registry's last closes with the top of their stacks. `null`: this page has no harness outbox.
   */
  outboxBinding(): OutboxBinding | null;
  /**
   * FIXTURE (R57): builds the harness outbox again over the page's CURRENT service, with the options it was started with (a cursor that
   * `seedCursor` arranged is not arranged again), after a transition ended the first binding. Resolves when the new facade is bound.
   */
  rebindOutbox(): Promise<void>;
  /**
   * FIXTURE (R57): ends the service the harness outbox is bound to, and nothing else (the registry keeps its connections and the tree its
   * own), as a transition that ended the captured service would. The deliberate dead-service control of the peer-readiness helper.
   */
  endOutboxService(): void;
  /**
   * FIXTURE diagnostics (R57, revision 34): the state a failed schedule needs to be read at its failing boundary, collected on demand and
   * changing nothing. The page's clock, the identity the harness follows, what the harness outbox is bound to (the captured service, its
   * lifetime, the registry's open count and latch), the registry's last closes and latches, the services' ends with their reasons, the
   * harness outbox's own refusals (`enqueue` and `editQueued` answers that were `refused`, each with the binding at that moment), the
   * dispatcher's state and the raw keys of the fallback markers. A spec that fails has this attached to its report by the test fixture.
   */
  diagnostics(): HarnessDiagnostics;
  /**
   * FIXTURE (R47, revision 27): the facade's next `times` reads of the record of local-write stops fail (the dispatcher's reads are
   * not touched). `stopReadFaultsLeft()` says how many are still to come, so a case waits for the reads it made to have happened.
   */
  failStopReads(times: number): void;
  stopReadFaultsLeft(): number;
  /**
   * FIXTURE (R46, revision 28): the answer of the NEXT run of the dispatcher's plan `plan` (`data.readDispatchWindow`, the queue read, or
   * `data.markInFlight`, the claim) is held: the plan runs at once, over the real database, and its answer is delivered to the
   * dispatcher only when `releaseOutboxPlan()` is called, as a read made before another writer's write and told of after it. One hold at a
   * time, and it applies once. `outboxPlanHeld()` says the answer is being held now.
   *
   * WEB-08d revision 21 (review r20 R20-N1): one hold at a time is ENFORCED (arming while a hold is armed or held throws), and the arm
   * returns a token naming this document and the arm. `releaseOutboxPlan(token)` delivers the real answer of a consumed hold, DISARMS a
   * hold that was never reached (so no later operation is held after a case's cleanup), is harmless when repeated, and does nothing
   * (`stale`) for the token of another document or an earlier arm. Without a token it acts on the current hold.
   */
  holdOutboxPlan(
    plan:
      | "data.readDispatchWindow"
      | "data.markInFlight"
      | "data.editQueuedDraft"
      | "data.enqueueDraft"
      | "data.discardDraft"
      | "data.supersedeDraft"
      | "data.recordLocalWriteOutcome",
  ): HoldToken;
  outboxPlanHeld(): boolean;
  releaseOutboxPlan(token?: HoldToken): HoldRelease;
  /**
   * FIXTURE (R51, revision 31): the answer of the NEXT commit of the plan `plan` that the leader's ENGINE makes (`data.commitPage`, a page
   * applied) is held: the commit runs at once, over the real database, and its answer is delivered to the engine only when
   * `releaseEnginePlan()` is called, as a completion that arrives after another page's write. One hold at a time, and it applies once.
   * `enginePlanHeld()` says the answer is being held now. Tokens and release outcomes as for `holdOutboxPlan` (revision 21).
   */
  holdEnginePlan(
    plan: "data.commitPage" | "data.recordLocalWriteOutcome",
  ): HoldToken;
  enginePlanHeld(): boolean;
  releaseEnginePlan(token?: HoldToken): HoldRelease;
  /**
   * FIXTURE (R46, R47): what the facade says about local storage, as the status model reads it ("local storage isn't responding", and
   * whether that stop is held in this tab alone), or `null` while no outbox runs on this page.
   */
  outboxStorage(): { notResponding: boolean; memoryOnly: boolean } | null;
  /** Through the facade (quota, fence reconciliation, streaks). */
  enqueue(spec: HarnessEnqueue): Promise<HarnessOutcome>;
  /** WEB-12a: the account's persisted sharing-defaults record (`sync_state.defaults`, read through W14's reader), or null. */
  defaultsRecord(account: AccountId): Promise<DefaultsRecord | null>;
  /**
   * WEB-12a: W14 `writeDefaults` run DIRECTLY on the account's real store for a captured `(account, epoch)`, so its own guards (EPO,
   * CLS, INC) and the later-issued rule are exercised in a real engine. FIXTURE: the product path goes through the account service's commit.
   */
  writeDefaultsProbe(
    account: AccountId,
    input: { epoch: number; issuedAt: number; snapshot: unknown },
  ): Promise<string>;
  /** WEB-12a: `captureDefaults` over the persisted record, as a queued create's builder would call it (FIXTURE: no product caller exists). */
  captureDefaults(
    account: AccountId,
    kinds: TemplateKind[],
  ): Promise<DefaultsCapture>;
  editQueued(localId: string, spec: HarnessEnqueue): Promise<HarnessOutcome>;
  /** A replacement with a fresh `localId` (`spec.localId`): through the facade, so the quota reserve and the key rule apply. */
  supersede(oldLocalId: string, spec: HarnessEnqueue): Promise<HarnessOutcome>;
  /**
   * FIXTURE: takes a reservation of `bytes` from the outbox's own quota guard and NEVER settles it, as a page that dies mid-save would
   * (R28): the hold is then the origin ledger's to expire. Returns the guard's verdict. `begin` also reads the reservation's `live()`,
   * which is what a writer does in the step that begins its transaction (R28, revision 16): the guard then treats the write as possibly
   * running, so no maximum age revokes it.
   */
  reserveQuota(bytes: number, begin?: boolean): Promise<string>;
  /**
   * FIXTURE clock injection (R28, revision 16): moves the clock of the outbox's production guard (see `quotaClockOffsetMs`) to read
   * `Date.now()` this many milliseconds ahead FROM NOW ON, so that a reservation made earlier is, at the guard's next renewal tick,
   * `quotaHoldMaxAgeMs` old. A real engine cannot make ten minutes pass on request; this is the named injection and every report that
   * uses it says so. The renewal tick itself is the production timer, a third of the lease.
   */
  setQuotaClockOffset(ms: number): void;
  /**
   * FIXTURE (R28, revision 17): `bytes` of a write have landed NOW, in real time, in the origin: the injected estimate (with
   * `estimateLagsWrites`) will show them to a request made one estimate lifetime from now. The browser's estimate is the origin's, so a
   * test that saved on another page tells every page's harness. Nothing is written by this call.
   */
  noteLanded(bytes: number): void;
  /** FIXTURE (R28, revision 17): the real instants (`Date.now()`) at which the injected estimate was asked, in order. */
  estimateRequests(): number[];
  discardDraft(localId: string): Promise<HarnessOutcome>;
  retryOutbox(localId?: string): void;
  /** Straight to the plan, bypassing the facade: the E-O1 race has no dispatcher and no quota in it. */
  enqueueDirect(
    account: AccountId,
    spec: HarnessEnqueue,
    options?: { held?: boolean },
  ): Promise<{ kind: string; reason?: string }>;
  /** Keeps a reference to the account's service store, as a late writer (an in-flight continuation) would hold one. */
  holdStore(account: AccountId): boolean;
  summary(account: AccountId): Promise<QueueSummary>;
  queue(account: AccountId): Promise<QueueRow[]>;
  fence(account: AccountId, operationId: string): Promise<string>;
  unfence(account: AccountId, operationId: string): Promise<string>;
  outboxTrace: string[];
  /**
   * PROFILING (P-3): the latency, in milliseconds, of `count` writes of one kind through the production plan with its durability
   * set to `durability` (a copy of the plan: the registered plan is not changed). The hint reaches the engine through Dexie's
   * `chromeTransactionDurability` option; whether Firefox and WebKit act on it was not determined, and the results say so.
   */
  timeWrites(
    account: AccountId,
    kind: "draft" | "fence" | "form_recovery",
    durability: "strict" | "default",
    count: number,
  ): Promise<number[]>;
}

/** A flat outcome of the facade, so a Playwright `evaluate` does not have to carry the recursive row types. */
export interface HarnessOutcome {
  kind: string;
  reason?: string;
  localId?: string;
  outcome?: string;
  affected?: number;
  paused?: string[];
}

/** The fields of a draft the specs assert on. */
export interface QueueRow {
  local_id: string;
  status: string;
  created_seq: number;
  expected_version: number | null;
  depends_on: string[];
  target_resource_ids: string[];
  attempts: number;
  held_pending_cache: boolean;
  unavailable_outcome: boolean;
  review_block: boolean;
  retry_state: string | null;
  last_error_stage: string | null;
}

export const flat = (out: object): HarnessOutcome => {
  const o = out as Record<string, unknown>;
  return {
    kind: String(o.kind),
    ...(typeof o.reason === "string" ? { reason: o.reason } : {}),
    ...(typeof o.localId === "string" ? { localId: o.localId } : {}),
    ...(typeof o.outcome === "string" ? { outcome: o.outcome } : {}),
    ...(typeof o.affected === "number" ? { affected: o.affected } : {}),
    ...(Array.isArray(o.paused) ? { paused: o.paused as string[] } : {}),
  };
};

/** A declarative enqueue: `{ "$base": "<id>" }` anywhere in `command` is replaced by the base the transaction read for `<id>`. */
export interface HarnessEnqueue {
  endpoint: string;
  targetId?: string;
  targets: TargetSpec[];
  /** Plain data (not the recursive `JsonObject`, which Playwright's serialisation types cannot instantiate). */
  command: { [key: string]: unknown };
  displayPatch?: Record<string, ProjectionPatch>;
  localId?: string;
  /** `EnqueueRequest.dependsOnExtra`: the caller's explicit dependencies (R45: where they stand decides a replacement's place). */
  dependsOn?: string[];
  /**
   * The builder reads its bases STRICTLY, as `expected_version: bases[id]` does: a base that is not there is an `undefined` member, which
   * canonical JSON refuses. So the command cannot be built before the transaction has read the bases (R25).
   */
  requiresBases?: boolean;
  /**
   * No estimate can be made before the transaction has read the bases: the builder throws for no bases AND for any base above 1,000 (so
   * both of the estimate's probes fail), and builds only from a plausible real one. The plan's own measure is then what protects the quota (R25).
   */
  unsizeable?: boolean;
  /**
   * `BuildResult.defaultsContext`: opaque, caller-sized data that the draft's header stores (R25, revision 13). The facade must charge
   * the quota reserve for it like any other part of the write.
   */
  defaultsContext?: { [key: string]: unknown };
  /** `BuildResult.defaultsRevision` (WEB-12a): what a capture gives a queued create. */
  defaultsRevision?: string | null;
  /** `BuildResult.defaultsReview` (WEB-12a): a non-empty list stores the draft blocked on a defaults review. */
  defaultsReview?: string[];
}

export interface DatabaseDescription {
  version: number;
  stores: Record<
    string,
    {
      keyPath: string | string[] | null;
      indexes: Array<{
        name: string;
        keyPath: string | string[];
        multiEntry: boolean;
      }>;
    }
  >;
  singleton: { incarnation_id: string; cache_status: string } | null;
}

const facts: { account: AccountId | null; pending: Set<AccountId> } = {
  account: null,
  pending: new Set(),
};

const registry = getPageRegistry();
const versionChanges: DataHarness["versionChanges"] = [];
const host = createIdbHost();
const opener = createDexieOpener({
  registry,
  onVersionChange: (account, kind) => versionChanges.push({ account, kind }),
});
let engineRuntime: DataRuntime | null = null;
const stores = new Map<AccountId, AccountStore>();
/** The open handle for an account: the one this harness opened, or a service's (the test leader's, or the page runtime's). */
const storeFor = (account: AccountId): AccountStore | undefined =>
  stores.get(account) ??
  engineRuntime?.serviceFor(account)?.store ??
  runtime.serviceFor(account)?.store ??
  isolatedRuntime?.serviceFor(account)?.store;
const locks = createWebLocksPort(navigator.locks);
// FIXTURE: a spec that must take a named directory slot (the takeover of a slot a closed page owned) fixes where the page starts looking for
// one by an init script that sets `__fixtureSlotStart`. Production composes the random start only.
const markers = createWriteFailureMarkers(undefined, undefined, {
  slotStart: () =>
    (globalThis as { __fixtureSlotStart?: number })
      .__fixtureSlotStart as number,
});
// This page publishes durable failures: it takes its directory slot at once, as a running controller does.
void markers.prepare();
const ports = createDataDeletionPorts({ host, registry, markers });

// The runtime follows an identity of the harness's own.
const identityListeners = new Set<() => void>();
let runtimeIdentity: Identity | null = null;
const identityStore: Store<Identity | null> = {
  get: () => runtimeIdentity,
  subscribe(listener) {
    identityListeners.add(listener);
    return () => {
      identityListeners.delete(listener);
    };
  },
};
/** FIXTURE (R42): the answer the harness runtime's persistence hold gives next (see `setPersistenceFault`). */
let persistenceFault: "none" | "unavailable" | "pending" = "none";
const faultablePersistence: typeof unorderedPersistence = {
  hold: (account, epoch) =>
    persistenceFault === "unavailable"
      ? Promise.resolve({ kind: "unavailable" as const })
      : persistenceFault === "pending"
        ? new Promise(() => undefined)
        : unorderedPersistence.hold(account, epoch),
};
const runtime = new DataRuntime({
  identity: identityStore,
  // The harness page that has no session of its own (the raw store specs) has no record to order against.
  persistence: faultablePersistence,
  registry,
  open: (account, options) => openAccountData(openDeps, account, options),
});

const openDeps: OpenDeps = {
  host,
  opener,
  registry,
  locks,
  identityAccount: () => runtimeIdentity?.account_id ?? facts.account,
  operationPending: (account) => facts.pending.has(account),
  // FIXTURE: a spec that must name a lifetime before the database exists (the keys of a marker name it, R56) fixes the incarnation of the
  // databases this page creates by an init script that sets `__fixtureIncarnation`. Production composes `crypto.randomUUID()` only.
  newIncarnation: () =>
    (globalThis as { __fixtureIncarnation?: string }).__fixtureIncarnation ??
    crypto.randomUUID(),
  lockWaitMs: 20_000,
  abortAfter: (ms) => AbortSignal.timeout(ms),
};

async function describeDatabase(
  account: AccountId,
): Promise<DatabaseDescription | null> {
  const name = accountDatabaseName(account);
  if (!(await host.list()).includes(name)) return null;
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      const out: DatabaseDescription = {
        version: db.version,
        stores: {},
        singleton: null,
      };
      const names = [...db.objectStoreNames];
      if (names.length === 0) {
        db.close();
        resolve(out);
        return;
      }
      const tx = db.transaction(names, "readonly");
      for (const storeName of names) {
        const store = tx.objectStore(storeName);
        out.stores[storeName] = {
          keyPath: store.keyPath as string | string[] | null,
          indexes: [...store.indexNames].map((indexName) => {
            const index = store.index(indexName);
            return {
              name: indexName,
              keyPath: index.keyPath as string | string[],
              multiEntry: index.multiEntry,
            };
          }),
        };
      }
      if (names.includes("sync_state")) {
        const read = tx.objectStore("sync_state").get("singleton");
        read.onsuccess = () => {
          const row = read.result as
            | { incarnation_id: string; cache_status: string }
            | undefined;
          out.singleton = row
            ? {
                incarnation_id: row.incarnation_id,
                cache_status: row.cache_status,
              }
            : null;
        };
      }
      tx.oncomplete = () => {
        db.close();
        resolve(out);
      };
      tx.onerror = () => {
        db.close();
        reject(tx.error);
      };
    };
  });
}

// ---- the fixture-only test leader -----------------------------------------------------------------------------------
let engine: SyncEngine | null = null;
let engineAbort: AbortController | null = null;
/** FIXTURE (R26): the ownership signal that the last `restartSync` replaced. */
let replacedAbort: AbortController | null = null;
/** FIXTURE (R27): while set, the engine's next quota check does not answer until it is released. */
let quotaHold: Promise<void> | null = null;
let quotaRelease: (() => void) | null = null;
const syncPosted: SyncMessage[] = [];
const syncReceived: SyncMessage[] = [];
const engineTrace: string[] = [];

let gateEnv: DataEnv | null = null;
let gateSeen: CacheState[] = [];
/**
 * The runtime of an ISOLATED gate controller (R49, revision 30) and the reads of the facts that controller makes. The page's production
 * tree and this fixture's controller are two runtimes over ONE connection registry and ONE identity, so every closure of the registry
 * by the tree (it closes every connection of the account when it is disposed) and every republish of the session's identity reaches the
 * controller a spec is measuring, which then binds and reads again through no fault of what is under test. An isolated controller has a
 * registry, an opener and a frozen identity of its own: nothing but the markers' own feed and its own timers can make it read.
 */
let isolatedRuntime: DataRuntime | null = null;
let gateFacts = { starts: 0, emissions: 0, calls: 0 };
const latchLog: Array<[number, string, string]> = [];
const endLog: Array<[number, string]> = [];
const closeLog: Array<[number, string, string, string]> = [];
{
  const closeAll = registry.closeAll.bind(registry);
  registry.closeAll = (account, options) => {
    // The first frames after this one: enough to tell the account service's disposal from the wipe responder, the identity refusal in
    // `DataRuntime.open` and the Dexie `versionchange` handler (a minified build keeps chunk names and positions, not function names).
    const stack = (new Error().stack ?? "")
      .split("\n")
      .slice(2, 5)
      .map((line) => line.trim().replace(/^at /, ""))
      .join(" < ");
    closeLog.push([
      Math.round(performance.now()),
      account,
      options?.latch ?? "",
      stack.slice(0, 300),
    ]);
    closeAll(account, options);
  };
}
registry.onLatch((account, latch) =>
  latchLog.push([Math.round(performance.now()), account, latch]),
);

const sessionOf = (): Session => {
  const session = window.__atlasFixture?.session?.booted?.session;
  if (!session)
    throw new Error("the production session is not running on this page");
  return session;
};

const macrotask = (): Promise<void> =>
  new Promise((resolve) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => {
      channel.port1.close();
      resolve();
    };
    channel.port2.postMessage(null);
  });

/**
 * The yield between pages (plan 5.4.2). The policies the programme compares (P-9): `none` (no yield: the next page starts in the same
 * task), `macrotask` (a MessageChannel task), `scheduler_yield` (`scheduler.yield()`, falling back to a macrotask where the engine
 * has none, and the result says which), `idle` (`requestIdleCallback`, bounded at 50 ms, falling back to a timer). `platform` is what
 * the harness always did: `scheduler.yield` where it exists, else a macrotask. FIXTURE ONLY: production supplies its own at WEB-09b.
 */
export type YieldPolicy =
  | "platform"
  | "none"
  | "macrotask"
  | "scheduler_yield"
  | "idle";
const schedulerOf = () =>
  (globalThis as { scheduler?: { yield?: () => Promise<void> } }).scheduler;
const yieldFor = (policy: YieldPolicy): (() => Promise<void>) => {
  switch (policy) {
    case "none":
      return () => Promise.resolve();
    case "macrotask":
      return macrotask;
    case "scheduler_yield":
      return () => schedulerOf()?.yield?.() ?? macrotask();
    case "idle":
      return () =>
        new Promise<void>((resolve) => {
          const idle = (
            globalThis as {
              requestIdleCallback?: (
                callback: () => void,
                options?: { timeout: number },
              ) => number;
            }
          ).requestIdleCallback;
          if (idle) idle(() => resolve(), { timeout: 50 });
          else setTimeout(resolve, 0);
        });
    default:
      return () => schedulerOf()?.yield?.() ?? macrotask();
  }
};
let engineYield: YieldPolicy = "platform";
const yieldToEventLoop = (): Promise<void> => yieldFor(engineYield)();

const outboxTrace: string[] = [];
const held = new Map<AccountId, AccountStore>();
/** FIXTURE: how many notifications of the session (its view, its identity, visibility) the leader's engine has been told of. */
let wakeNotifications = 0;
let outbox: Outbox | null = null;
/** What `outboxBinding` describes: the service the facade of this page was built over, and the options it was started with (R57). */
export interface OutboxBinding {
  account: string;
  incarnationId: string;
  live: boolean;
  /** The captured service is still the one the page's runtime would use for the account now. */
  sameService: boolean;
  /** The page's current service for the account (null: none is live). */
  currentIncarnationId: string | null;
  openCount: number;
  latch: string;
  /** The registry's last closes, newest last: `[ms, account, latch or "", the top of the stack]`. */
  closes: Array<[number, string, string, string]>;
}
interface OutboxBound {
  account: AccountId;
  service: AccountService;
  options: Parameters<DataHarness["startOutbox"]>[1];
}
let outboxBound: OutboxBound | null = null;
/**
 * The harness outbox's answers that were refused, newest last (bounded): what a failed schedule's first refusal was, and the binding then.
 *
 * R57 (revision 35): every field describes the facade that was INVOKED, captured synchronously when the action was entered, never the
 * page's binding at the moment the answer is read (a rebuild of the outbox while the action awaited would otherwise describe a facade
 * that never answered). `entry` is that facade's binding as the action began, `binding` the same captured service's binding when the
 * answer arrived, and `rebound` whether the page's outbox had been rebuilt in between; `entryMs` and `at` bound the action in time.
 */
const refusals: Array<{
  at: number;
  entryMs: number;
  operation: string;
  reason: string;
  entry: OutboxBinding | null;
  binding: OutboxBinding | null;
  rebound: boolean;
}> = [];
/** What `diagnostics` answers (see the interface). */
export interface HarnessDiagnostics {
  at: { performanceMs: number; epochMs: number };
  tabId: string;
  identity: { account: string; epoch: number } | null;
  followedAccount: string | null;
  outbox: OutboxBinding | null;
  gate: {
    latches: Array<[number, string, string]>;
    ends: Array<[number, string]>;
    closes: Array<[number, string, string, string]>;
  };
  refusals: typeof refusals;
  dispatcher: DispatcherState | null;
  markerKeys: string[];
}
/**
 * FIXTURE (R47, revision 27): how many of the FACADE's next reads of the record of local-write stops fail. The read is made through the
 * real plan over the real database, and the transaction is then aborted, as a read that fails after it has started would be.
 */
let stopReadFaults = 0;
/** FIXTURE (revision 21, R20-N1): names one arm of one hold in one document, so a stale cleanup cannot release a successor. */
export interface HoldToken {
  document: string;
  generation: number;
}
/**
 * What a release did, and the hold's state after it: `released` delivered a consumed hold's real answer, `disarmed` removed an arm that was
 * never reached, `stale` was given another document's or an earlier arm's token and did nothing, `idle` found nothing to release.
 */
export interface HoldRelease {
  outcome: "released" | "disarmed" | "stale" | "idle";
  armed: boolean;
  held: boolean;
}
interface PlanHold {
  plan: string | null;
  held: boolean;
  release: () => void;
  generation: number;
}
/** This document, for the tokens of its holds (a reloaded page is another document, whose holds begin again). */
const holdDocument = crypto.randomUUID();
/** FIXTURE (R46, revision 28): the plan whose next answer is held (`holdOutboxPlan`), whether it is held now, and how to deliver it. */
const planHold: PlanHold = {
  plan: null,
  held: false,
  release: () => undefined,
  generation: 0,
};
/** FIXTURE (R51, revision 31): the commit of the engine whose answer is held (`holdEnginePlan`), whether it is held now, and how to deliver it. */
const engineHold: PlanHold = {
  plan: null,
  held: false,
  release: () => undefined,
  generation: 0,
};
/** Revision 21: one hold at a time, enforced: a second arm while one is armed or held is a misuse of the seam, not a replacement. */
const armHold = (hold: PlanHold, plan: string): HoldToken => {
  if (hold.plan !== null || hold.held)
    throw new Error(
      `a hold is already ${hold.held ? "held" : `armed for ${hold.plan}`}: one hold at a time`,
    );
  hold.generation += 1;
  hold.plan = plan;
  return { document: holdDocument, generation: hold.generation };
};
const releaseHold = (hold: PlanHold, token?: HoldToken): HoldRelease => {
  const stale =
    token !== undefined &&
    (token.document !== holdDocument || token.generation !== hold.generation);
  let outcome: HoldRelease["outcome"] = "idle";
  if (stale) outcome = "stale";
  else if (hold.held) {
    const deliver = hold.release;
    hold.release = () => undefined;
    deliver();
    outcome = "released";
  } else if (hold.plan !== null) {
    hold.plan = null;
    outcome = "disarmed";
  }
  return { outcome, armed: hold.plan !== null, held: hold.held };
};
const heldServices = new WeakMap<object, AccountService>();
/** The engine's view of its service: `commit` of the plan under `engineHold` answers only when released; everything else is the service's. */
const heldEngineService = <T extends AccountService | null | undefined>(
  service: T,
): T => {
  if (service === null || service === undefined) return service;
  const known = heldServices.get(service);
  if (known !== undefined) return known as T;
  // The raw store of the service, whose `run` can be held too (R56, revision 33: the failure counter's answer, a rejection when the counter
  // transaction has failed, is delivered late). One view per store.
  const storeView = new Proxy(service.store, {
    get(target, key) {
      if (key !== "run") return Reflect.get(target, key, target);
      return (
        plan: Plan<never, never, never>,
        input: never,
        options: never,
      ) => {
        const answer = target.run(plan, input, options);
        if (engineHold.plan === null || plan.name !== engineHold.plan)
          return answer;
        engineHold.plan = null;
        engineHold.held = true;
        // The plan has run and may have FAILED: its rejection is delivered on release, and is not unhandled before then.
        answer.catch(() => undefined);
        return new Promise((resolve, reject) => {
          engineHold.release = () => {
            engineHold.held = false;
            void answer.then(resolve, reject);
          };
        });
      };
    },
  });
  const view = new Proxy(service, {
    get(target, key) {
      if (key === "store") return storeView;
      if (key !== "commit") return Reflect.get(target, key, target);
      return (plan: Plan<never, never, never>, input: never) => {
        const answer = target.commit(plan, input);
        if (engineHold.plan === null || plan.name !== engineHold.plan)
          return answer;
        // Held once: the plan has run, and its answer is delivered when the spec says. A rejection is delivered on release (revision 21:
        // observed now, as the store's is, so a case that ends while it is held leaves no unhandled rejection in the page).
        engineHold.plan = null;
        engineHold.held = true;
        answer.catch(() => undefined);
        return new Promise((resolve, reject) => {
          engineHold.release = () => {
            engineHold.held = false;
            void answer.then(resolve, reject);
          };
        });
      };
    },
  });
  heldServices.set(service, view);
  return view as T;
};
/** The quota guard the outbox was built with (the fixture reserves from it directly to model a page that dies mid-save). */
let outboxQuota: QuotaGuard | null = null;
/** The guard of the recovery port a spec asked for with an injected estimate (R33, revision 18). */
let recoveryQuota: QuotaGuard | null = null;
/** E-R3 (R1, revision 19): the named recovery runs of this page (`recoveryRun`). */
const RECOVERY_ORDER_FORM = "mixed-claims";
const RECOVERY_ORDER_TAB = "tab-m";
const recoveryRuns = new Map<
  string,
  {
    port: FormRecoveryPort;
    release: () => void;
    reached: Promise<void>;
    results: Array<Promise<string>>;
  }
>();
/** The named clock injection of the outbox's production guard (`quotaClockOffsetMs`, `setQuotaClockOffset`): milliseconds ahead of `Date.now()`. */
let quotaClockOffset = 0;
/** FIXTURE (R28, revision 17): the writes the lagging injected estimate will show (`noteLanded`), and when the estimate was asked. */
let landedWrites: Array<{ at: number; bytes: number }> = [];
let estimateAsked: number[] = [];
let dispatcher: OutboxDispatcher | null = null;
let outboxAbort: AbortController | null = null;

const resolveBases = (
  value: JsonValue,
  bases: Readonly<Record<string, number>>,
  strict = false,
): JsonValue => {
  if (Array.isArray(value))
    return value.map((item) => resolveBases(item as JsonValue, bases, strict));
  if (value !== null && typeof value === "object") {
    const keys = Object.keys(value);
    if (keys.length === 1 && keys[0] === "$base") {
      const base = bases[(value as { $base: string }).$base];
      // Strict: a missing base stays `undefined` (the member canonical JSON refuses), as a builder that reads `bases[id]` leaves it.
      return strict ? (base as JsonValue) : (base ?? null);
    }
    const out: Record<string, JsonValue> = {};
    for (const key of keys)
      out[key] = resolveBases(
        (value as Record<string, JsonValue>)[key] as JsonValue,
        bases,
        strict,
      );
    return out;
  }
  return value;
};

export const requestOf = (spec: HarnessEnqueue): EnqueueRequest => ({
  endpoint: spec.endpoint,
  ...(spec.targetId === undefined ? {} : { targetId: spec.targetId }),
  targets: spec.targets,
  ...(spec.localId === undefined ? {} : { localId: spec.localId }),
  ...(spec.dependsOn === undefined ? {} : { dependsOnExtra: spec.dependsOn }),
  build: (bases) => {
    if (spec.unsizeable === true) {
      const values = Object.values(bases);
      if (values.length === 0 || values.some((value) => value > 1000))
        throw new Error(
          "the command cannot be sized before its bases are read",
        );
    }
    return {
      command: resolveBases(
        spec.command as JsonObject,
        bases,
        spec.requiresBases === true || spec.unsizeable === true,
      ) as JsonObject,
      ...(spec.displayPatch === undefined
        ? {}
        : { displayPatch: spec.displayPatch }),
      ...(spec.defaultsContext === undefined
        ? {}
        : { defaultsContext: spec.defaultsContext }),
      ...(spec.defaultsRevision === undefined
        ? {}
        : { defaultsRevision: spec.defaultsRevision }),
      ...(spec.defaultsReview === undefined
        ? {}
        : { defaultsReview: spec.defaultsReview }),
    };
  },
});

interface EngineWiring {
  account: AccountId;
  service: AccountService;
  identity: Store<Identity | null>;
  fetchFor(
    account: AccountId,
    epoch: number,
  ): (request: Request) => Promise<Response>;
  subscribe(listener: () => void): () => void;
  /** The browser's own `online` event. */
  onOnline(listener: () => void): () => void;
  deviceMemoryGiB?: number;
}

/** The production quota guard, whose next `check` waits while the fixture holds it (R27: the asynchronous gap before a request). */
const heldQuota = (guard: QuotaGuard): QuotaGuard => ({
  ...guard,
  check: async (kind, estimatedBytes) => {
    const hold = quotaHold;
    quotaHold = null;
    const verdict = await guard.check(kind, estimatedBytes);
    if (hold) await hold;
    return verdict;
  },
});

/** Builds and starts the production sync engine with the harness's fixture-only leadership (no token). */
function startEngine(wiring: EngineWiring): void {
  const channel = createBroadcastSyncChannel();
  const posting = {
    ...channel,
    post: (message: SyncMessage) => {
      syncPosted.push(message);
      channel.post(message);
    },
  };
  engineAbort = new AbortController();
  engine = createSyncEngine({
    service: () =>
      heldEngineService(
        engineRuntime?.serviceFor(wiring.account) ??
          runtime.serviceFor(wiring.account) ??
          wiring.service,
      ),
    identity: wiring.identity,
    fetchFor: wiring.fetchFor,
    apiUrl: (path) => apiUrl(path),
    online: () => navigator.onLine,
    subscribe: wiring.subscribe,
    onOnline: wiring.onOnline,
    clock: {
      now: () => Date.now(),
      iso: () => new Date().toISOString(),
      random: () => Math.random(),
      setTimeout: (fn, ms) => window.setTimeout(fn, ms),
      clearTimeout: (handle) => window.clearTimeout(handle as number),
    },
    yield: yieldToEventLoop,
    decode: {
      validators: createValueValidators(),
      derivers: createKeyDerivers(),
    },
    quota: heldQuota(
      createQuotaGuard({ storage: navigator.storage, now: () => Date.now() }),
    ),
    signals: {
      deviceMemoryGiB: wiring.deviceMemoryGiB,
      hasStorageEstimate: true,
    },
    recovery: defaultRecoverySeam,
    channel: posting,
    markers,
    ids: { uuid: () => crypto.randomUUID() },
    elapsed: () => performance.now(),
    trace: {
      emit: (event, data) => {
        engineTrace.push(
          `${Math.round(performance.now())}ms ${event} ${data ? JSON.stringify(data) : ""}`,
        );
      },
    },
  });
  engine.start({ token: null, signal: engineAbort.signal });
}

/** The facts reads of the isolated controller: one store view per store, counting the live queries it starts and what they deliver. */
const countedStore = (store: AccountStore): AccountStore =>
  new Proxy(store, {
    get(target, name) {
      if (name === "run")
        return (
          plan: Plan<never, never, never>,
          input: never,
          options: never,
        ) => {
          gateFacts.calls += 1;
          return target.run(plan, input, options);
        };
      if (name !== "watch") return Reflect.get(target, name, target);
      return (plan: Plan<never, never, never>, input: never) => {
        gateFacts.calls += 1;
        const source = target.watch(plan, input);
        if (plan.name !== readSyncFacts.name) return source;
        gateFacts.starts += 1;
        return new Proxy(source, {
          get(inner, key) {
            if (key !== "subscribe") return Reflect.get(inner, key, inner);
            return (listener: () => void) =>
              inner.subscribe(() => {
                gateFacts.emissions += 1;
                listener();
              });
          },
        });
      };
    },
  });

/**
 * A runtime that belongs to ONE gate controller (see `isolatedRuntime`): its own registry, its own opener, and `frozen` as the identity
 * (the identity the page displays when the gate starts, never republished). It never creates a database (the gate only looks), and every
 * store it opens is counted.
 */
const isolatedGateRuntime = (
  session: Session,
  frozen: Store<Identity | null>,
): DataRuntime => {
  const privateRegistry = createRegistry(crypto.randomUUID());
  const privateOpener = createDexieOpener({ registry: privateRegistry });
  const privateDeps: OpenDeps = {
    ...openDeps,
    opener: privateOpener,
    registry: privateRegistry,
    identityAccount: () => frozen.get()?.account_id ?? null,
    operationPending: () => false,
  };
  isolatedRuntime = new DataRuntime({
    identity: frozen,
    persistence: session.persistence,
    registry: privateRegistry,
    open: async (a, o) => {
      const outcome = await openAccountData(privateDeps, a, o);
      return outcome.kind === "opened"
        ? { ...outcome, store: countedStore(outcome.store) }
        : outcome;
    },
  });
  return isolatedRuntime;
};

/** What a refused open says (R57, revision 33): the kind AND the reason, so that a refusal is read from its message and not guessed. */
const openFailure = (opened: { kind: string; reason?: string }): string =>
  `could not open the account: ${opened.kind}${opened.reason === undefined ? "" : ` (${opened.reason})`}`;

const ensureRuntime = (session: Session): DataRuntime => {
  if (engineRuntime) return engineRuntime;
  engineRuntime = new DataRuntime({
    identity: session.identity,
    // The engines of a harness page with a real session: the same ordering production has.
    persistence: session.persistence,
    registry,
    open: (a, o) =>
      openAccountData(
        {
          ...openDeps,
          identityAccount: () => session.identity.get()?.account_id ?? null,
          operationPending: (id) =>
            session.operations.pending.get().some((op) => op.account_id === id),
        },
        a,
        o,
      ),
  });
  return engineRuntime;
};

/**
 * FIXTURE: the facade's view of the service, whose reads of the record of local-write stops can be made to fail (`failStopReads`). Every
 * other plan, and every property, is the real service's.
 */
const faultableViews = new WeakMap<AccountService, AccountService>();
/** One view per service, so that the dispatcher (which asks for its service on every step) and the facade each see a stable object. */
const viewOf = (service: AccountService): AccountService => {
  const known = faultableViews.get(service);
  if (known !== undefined) return known;
  const made = faultableService(service);
  faultableViews.set(service, made);
  return made;
};
const faultableService = (service: AccountService): AccountService => {
  // One store view for the service's life (a property read twice must give the same object), over the real store.
  const store = new Proxy(service.store, {
    get(target, name) {
      if (name !== "run") return Reflect.get(target, name, target);
      return (
        plan: Plan<never, never, never>,
        input: never,
        options: never,
      ) => {
        const answer = ((): Promise<unknown> => {
          if (plan.name !== readLocalWriteStops.name || stopReadFaults <= 0)
            return target.run(plan, input, options);
          stopReadFaults -= 1;
          return target.run(
            {
              ...plan,
              decide: () => {
                throw new StoreFailure("abort");
              },
            },
            input,
            options,
          );
        })();
        if (planHold.plan === null || plan.name !== planHold.plan)
          return answer;
        // Held once: the plan has run, and its answer is delivered when the spec says. The plan may have FAILED (R56): its rejection is
        // delivered on release and is not an unhandled one before then.
        planHold.plan = null;
        planHold.held = true;
        answer.catch(() => undefined);
        return new Promise((resolve, reject) => {
          planHold.release = () => {
            planHold.held = false;
            void answer.then(resolve, reject);
          };
        });
      };
    },
  });
  return new Proxy(service, {
    get(target, key) {
      return key === "store" ? store : Reflect.get(target, key, target);
    },
  });
};

/** The binding of a captured outbox (`bound`, and the facade built over it), read now. */
const bindingOf = (
  bound: OutboxBound,
  facade: Outbox | null,
): OutboxBinding | null => {
  if (facade === null) return null;
  // The outbox's runtime is the page's engine runtime (`ensureRuntime`), not the harness's first one.
  const current = engineRuntime?.serviceFor(bound.account) ?? null;
  return {
    account: bound.account,
    incarnationId: bound.service.incarnationId,
    live: bound.service.live,
    sameService: current === bound.service,
    currentIncarnationId: current?.incarnationId ?? null,
    openCount: registry.openCount(bound.account),
    latch: registry.latch(bound.account),
    closes: closeLog.slice(-8),
  };
};

/** What one action of the harness outbox was invoked on, captured synchronously as it began (R57, revision 35). */
interface ActionEntry {
  facade: Outbox;
  bound: OutboxBound;
  entry: OutboxBinding | null;
  entryMs: number;
}
const enterAction = (facade: Outbox): ActionEntry | null => {
  const bound = outboxBound;
  if (bound === null) return null;
  return {
    facade,
    bound,
    entry: bindingOf(bound, facade),
    entryMs: Math.round(performance.now()),
  };
};

/**
 * Records (bounded, observation only) a refusal of the harness outbox: the binding of the facade that was INVOKED, at entry and at the
 * answer, and whether the page's outbox was rebuilt meanwhile (R57, revision 35). The answer is not touched.
 */
const noteRefusal = (
  operation: string,
  answer: HarnessOutcome,
  action: ActionEntry | null,
): void => {
  if (answer.kind !== "refused") return;
  refusals.push({
    at: Math.round(performance.now()),
    entryMs: action?.entryMs ?? -1,
    operation,
    reason: answer.reason ?? "",
    entry: action?.entry ?? null,
    binding: action === null ? null : bindingOf(action.bound, action.facade),
    rebound:
      action !== null &&
      (outboxBound !== action.bound || outbox !== action.facade),
  });
  if (refusals.length > 16) refusals.shift();
};

const harness: DataHarness = {
  tabId: registry.tabId,
  outboxTrace,
  async startOutbox(account, options) {
    const session = sessionOf();
    const runtime_ = ensureRuntime(session);
    const opened = await runtime_.open(account, { create: true });
    if (opened.kind !== "opened") throw new Error(openFailure(opened));
    const service = opened.service;
    outboxBound = { account, service, options };
    // Arranged only when asked: a real cursor (`prepareAccount`) must never be overwritten.
    if (options?.seedCursor !== undefined)
      await harness.seedDelta(account, options.seedCursor);
    const channel = createBroadcastSyncChannel();
    outboxAbort = new AbortController();
    dispatcher = createOutboxDispatcher({
      service: () => viewOf(runtime_.serviceFor(account) ?? service),
      identity: session.identity,
      fetchFor: (a, e) => session.api.fetchFor("ordinary", a, e),
      apiUrl: (path) => apiUrl(path),
      online: () => navigator.onLine,
      compat: session.compat,
      subscribe: (listener) => {
        // Every notification the engine is told of is counted (FIXTURE, for E-C13: a step must be explained by a notification it heard).
        const hear = (): void => {
          wakeNotifications += 1;
          listener();
        };
        const offs = [
          session.view.subscribe(hear),
          session.identity.subscribe(hear),
        ];
        document.addEventListener("visibilitychange", hear);
        return () => {
          for (const off of offs) off();
          document.removeEventListener("visibilitychange", hear);
        };
      },
      onOnline: (listener) => {
        window.addEventListener("online", listener);
        return () => window.removeEventListener("online", listener);
      },
      clock: {
        now: () => Date.now(),
        iso: () => new Date().toISOString(),
        random: () => Math.random(),
        setTimeout: (fn, ms) => window.setTimeout(fn, ms),
        clearTimeout: (handle) => window.clearTimeout(handle as number),
      },
      yield: yieldToEventLoop,
      conflicts: createConflictHandlerRegistry(),
      // A recorded receipt makes the sync engine look soon (the post-receipt poll), when one is running on this page.
      receipt: () => engine?.nudge("receipt"),
      channel,
      markers,
      config: options?.config,
      trace: {
        emit: (event, data) => {
          outboxTrace.push(
            `${Math.round(performance.now())}ms ${event} ${data ? JSON.stringify(data) : ""}`,
          );
        },
      },
    });
    landedWrites = [];
    estimateAsked = [];
    const quotaStorage =
      options?.estimateFreeBytes === undefined
        ? navigator.storage
        : {
            estimate: async () => {
              // What was true when the request BEGAN, whenever it is delivered; the lagging model shows a write a lifetime after it landed.
              const began = Date.now();
              estimateAsked.push(began);
              let usage = 0;
              if (options.estimateLagsWrites === true)
                for (const write of landedWrites)
                  if (write.at + DATA_CONFIG.quotaEstimateTtlMs <= began)
                    usage += write.bytes;
              return { usage, quota: options.estimateFreeBytes };
            },
          };
    quotaClockOffset = options?.quotaClockOffsetMs ?? 0;
    outboxQuota = options?.originLedger
      ? createProductionQuota({
          storage: quotaStorage,
          now: () => Date.now() + quotaClockOffset,
          ...(options.quotaMonotonic
            ? { monotonic: () => performance.now() }
            : {}),
        })
      : createQuotaGuard({ storage: quotaStorage, now: () => Date.now() });
    outbox = createOutbox({
      service: faultableService(service),
      quota: outboxQuota,
      ids: { uuid: () => crypto.randomUUID() },
      clock: { iso: () => new Date().toISOString(), now: () => Date.now() },
      fence: () => ({
        hasPendingOperation: session.operations.pending
          .get()
          .some((op) => op.account_id === account),
        sessionStarted: true,
      }),
      dispatcher,
      channel,
      markers,
      config: options?.config,
    });
    if (options?.start !== false)
      dispatcher.start({ token: null, signal: outboxAbort.signal });
  },
  async prepareAccount(account) {
    const session = sessionOf();
    const rt = ensureRuntime(session);
    const opened = await rt.open(account, { create: true });
    if (opened.kind !== "opened") throw new Error(openFailure(opened));
    const identity = session.identity.get();
    if (identity?.account_id !== account)
      throw new Error("the session has not settled this account");
    const fetchPage = session.api.fetchFor("ordinary", account, identity.epoch);
    let cursor: string | null = null;
    let pages = 0;
    const rows: object[] = [];
    for (;;) {
      const url = apiUrl("/sync");
      if (cursor !== null) url.searchParams.set("cursor", cursor);
      url.searchParams.set("limit", "50");
      // `not_sent` is "nothing went out for a moment" (the resume verification just after display): the stamped-call contract
      // says call again, and the wait is bounded, exactly as the Settings screens do it.
      let response: Response | null = null;
      for (let attempt = 0; response === null; attempt += 1) {
        try {
          response = await fetchPage(new Request(url, { method: "GET" }));
        } catch (error) {
          const delay = NOT_SENT_DELAYS_MS[attempt];
          if (
            !(error instanceof StampedRequestError) ||
            error.kind !== "not_sent" ||
            delay === undefined
          )
            throw error;
          await new Promise((done) => setTimeout(done, delay));
        }
      }
      if (response.status !== 200)
        throw new Error(`snapshot page ${pages + 1}: HTTP ${response.status}`);
      const page = (await response.json()) as {
        batches: Array<{
          changes: Array<{
            kind: string;
            resource?: Record<string, unknown>;
            id?: string;
          }>;
        }>;
        next_cursor: string;
        has_more: boolean;
        phase: string;
      };
      pages += 1;
      for (const batch of page.batches)
        for (const change of batch.changes)
          if (change.kind === "upsert" && change.resource)
            rows.push({ kind_date: null, ...change.resource });
      cursor = page.next_cursor;
      if (!page.has_more) break;
      if (pages > 200) throw new Error("the snapshot did not end");
    }
    if (rows.length > 0) await harness.put(account, "cache", rows);
    await harness.seedDelta(account, cursor as string);
    return { pages, resources: rows.length, cursor: cursor as string };
  },
  beginOutbox() {
    if (!dispatcher || !outboxAbort)
      throw new Error("the outbox is not running on this page");
    dispatcher.start({ token: null, signal: outboxAbort.signal });
  },
  stopOutbox() {
    dispatcher?.stop();
    // The facade this page made is let go of with it: its observation of the stop records ends too (R55, revision 36).
    outbox?.disposeObservation();
    outboxAbort?.abort();
    dispatcher = null;
    outbox = null;
  },
  outboxState: () => dispatcher?.state.get() ?? null,
  outboxBinding() {
    const bound = outboxBound;
    if (bound === null || outbox === null) return null;
    return bindingOf(bound, outbox);
  },
  async rebindOutbox() {
    const bound = outboxBound;
    if (bound === null)
      throw new Error("the outbox is not running on this page");
    harness.stopOutbox();
    // The cursor `seedCursor` arranged is a real one by now: it is never arranged again.
    const { seedCursor: _arranged, ...rest } = bound.options ?? {};
    await harness.startOutbox(bound.account, rest);
  },
  endOutboxService() {
    if (outboxBound === null)
      throw new Error("the outbox is not running on this page");
    outboxBound.service.dispose("closed");
  },
  diagnostics() {
    const markerKeys: string[] = [];
    try {
      for (
        let n = 0;
        n < localStorage.length && markerKeys.length < 64;
        n += 1
      ) {
        const key = localStorage.key(n);
        if (key?.startsWith("atlas-write-")) markerKeys.push(key);
      }
    } catch {
      markerKeys.push("(the origin's keys cannot be listed)");
    }
    return {
      at: { performanceMs: Math.round(performance.now()), epochMs: Date.now() },
      tabId: registry.tabId,
      identity:
        runtimeIdentity === null
          ? null
          : {
              account: runtimeIdentity.account_id,
              epoch: runtimeIdentity.epoch,
            },
      followedAccount: facts.account,
      outbox: harness.outboxBinding(),
      gate: {
        latches: latchLog.slice(-8),
        ends: endLog.slice(-8),
        closes: closeLog.slice(-8),
      },
      refusals: [...refusals],
      dispatcher: dispatcher?.state.get() ?? null,
      markerKeys: markerKeys.sort(),
    };
  },
  failStopReads(times) {
    stopReadFaults = times;
  },
  stopReadFaultsLeft: () => stopReadFaults,
  holdOutboxPlan: (plan) => armHold(planHold, plan),
  outboxPlanHeld: () => planHold.held,
  releaseOutboxPlan: (token) => releaseHold(planHold, token),
  holdEnginePlan: (plan) => armHold(engineHold, plan),
  enginePlanHeld: () => engineHold.held,
  releaseEnginePlan: (token) => releaseHold(engineHold, token),
  outboxStorage: () =>
    outbox === null
      ? null
      : {
          notResponding: outbox.storageNotResponding.get(),
          memoryOnly: outbox.storageMemoryOnly.get(),
        },
  async defaultsRecord(account) {
    const store = runtime.serviceFor(account)?.store ?? storeFor(account);
    if (!store) throw new Error(`no open store for ${account}`);
    return store.run(readDefaults, { incarnationId: store.incarnationId });
  },
  async writeDefaultsProbe(account, input) {
    const store = runtime.serviceFor(account)?.store ?? storeFor(account);
    if (!store) throw new Error(`no open store for ${account}`);
    const snapshot = parseSharingSnapshot(input.snapshot);
    if (snapshot === null) throw new Error("not a sharing snapshot");
    const out = await store.run(writeDefaults, {
      captured: {
        account,
        epoch: input.epoch,
        incarnationId: store.incarnationId,
        requestSeq: null,
        ownershipToken: null,
        recoveryGeneration: 0,
        expectedPosition: null,
      },
      snapshot,
      issuedAt: input.issuedAt,
      now: Date.now(),
    });
    return out.kind === "dropped"
      ? `dropped:${out.reason}`
      : out.value.written
        ? "written"
        : "kept";
  },
  async captureDefaults(account, kinds) {
    return captureDefaults(await harness.defaultsRecord(account), kinds);
  },
  async enqueue(spec) {
    if (!outbox) throw new Error("the outbox is not running on this page");
    // The facade and its binding are captured before anything is awaited: the record describes the action that was made (R57).
    const facade = outbox;
    const action = enterAction(facade);
    try {
      const answer = flat(await facade.enqueue(requestOf(spec)));
      noteRefusal("enqueue", answer, action);
      return answer;
    } catch {
      return { kind: "invalid" };
    }
  },
  async editQueued(localId, spec) {
    if (!outbox) throw new Error("the outbox is not running on this page");
    const facade = outbox;
    const action = enterAction(facade);
    const answer = flat(await facade.editQueued(localId, requestOf(spec)));
    noteRefusal("editQueued", answer, action);
    return answer;
  },
  async reserveQuota(bytes, begin = false) {
    if (outboxQuota === null) throw new Error("no outbox is running");
    const reservation = await outboxQuota.reserve("input", bytes);
    // The writer begins (and never finishes): `live()` is the step that creates its transaction.
    if (begin) reservation.live();
    return reservation.verdict;
  },
  setQuotaClockOffset(ms) {
    quotaClockOffset = ms;
  },
  noteLanded(bytes) {
    landedWrites.push({ at: Date.now(), bytes });
  },
  estimateRequests: () => [...estimateAsked],
  async supersede(oldLocalId, spec) {
    if (!outbox) throw new Error("the outbox is not running on this page");
    try {
      return flat(await outbox.supersede(oldLocalId, requestOf(spec)));
    } catch {
      return { kind: "invalid" };
    }
  },
  async discardDraft(localId) {
    if (!outbox) throw new Error("the outbox is not running on this page");
    return flat(await outbox.discard(localId));
  },
  retryOutbox: (localId) => outbox?.retry(localId),
  holdStore(account) {
    const store = runtime.serviceFor(account)?.store ?? storeFor(account);
    if (!store) return false;
    held.set(account, store);
    return true;
  },
  async enqueueDirect(account, spec, options) {
    const store = options?.held ? held.get(account) : storeFor(account);
    if (!store) throw new Error(`no open store for ${account}`);
    try {
      const out = await store.run(enqueueDraft, {
        incarnationId: store.incarnationId,
        request: requestOf(spec),
        localId: spec.localId ?? crypto.randomUUID(),
        accountId: account,
        now: new Date().toISOString(),
      });
      return out.kind === "refused" || out.kind === "invalid"
        ? { kind: out.kind, reason: out.reason }
        : { kind: out.kind };
    } catch (error) {
      // A store failure is a fixed cause (`closed` after a wipe), never a message.
      return {
        kind: "store_failure",
        reason: (error as { cause?: string }).cause ?? "error",
      };
    }
  },
  async timeWrites(account, kind, durability, count) {
    const store = storeFor(account);
    if (!store) throw new Error(`no open store for ${account}`);
    const out: number[] = [];
    for (let i = 0; i < count; i += 1) {
      const started = performance.now();
      if (kind === "draft") {
        const id = crypto.randomUUID();
        await store.run(
          { ...enqueueDraft, durability },
          {
            incarnationId: store.incarnationId,
            request: requestOf({
              endpoint: "/commands",
              targets: [
                {
                  resourceId: id,
                  role: "primary",
                  basis: "resource",
                  versionChecked: false,
                  seedIfUntracked: 1,
                },
              ],
              command: {
                commands: [{ kind: "create_person", id, name: `P-3 ${i}` }],
              },
            }),
            localId: crypto.randomUUID(),
            accountId: account,
            now: new Date().toISOString(),
          },
        );
      } else if (kind === "fence") {
        await store.run(
          { ...setDraftFence, durability },
          {
            incarnationId: store.incarnationId,
            now: Date.now(),
            token: "p3",
            operationId: `p3-${i}`,
          },
        );
      } else {
        await store.run(
          { ...saveFormRecovery, durability },
          {
            incarnationId: store.incarnationId,
            row: {
              form_context: "p3-form",
              tab_instance_id: "p3-tab",
              fields: { title: `draft ${i}` },
              redacted: [],
              saved_at: new Date().toISOString(),
              capture_seq: i + 1,
              terminal: false,
              content_digest: `p3-${i}`,
            },
          },
        );
      }
      out.push(performance.now() - started);
    }
    return out;
  },
  async summary(account) {
    const store = storeFor(account);
    if (!store) throw new Error(`no open store for ${account}`);
    return store.run(readQueueSummary, { incarnationId: store.incarnationId });
  },
  async queue(account) {
    const rows = (await harness.rows(account, "drafts")) as DraftRow[];
    return rows
      .sort((a, b) => a.created_seq - b.created_seq)
      .map((row) => ({
        local_id: row.local_id,
        status: row.status,
        created_seq: row.created_seq,
        expected_version: row.expected_version ?? null,
        depends_on: [...row.depends_on],
        target_resource_ids: [...row.target_resource_ids],
        attempts: row.attempts,
        held_pending_cache: row.held_pending_cache,
        unavailable_outcome: row.unavailable_outcome,
        review_block: row.review_block !== null,
        retry_state: row.retry_state?.state ?? null,
        last_error_stage: row.last_error?.stage ?? null,
      }));
  },
  async fence(account, operationId) {
    const store = storeFor(account);
    if (!store) throw new Error(`no open store for ${account}`);
    const out = await store.run(setDraftFence, {
      incarnationId: store.incarnationId,
      now: Date.now(),
      token: crypto.randomUUID(),
      operationId,
    });
    return out.kind;
  },
  async unfence(account, operationId) {
    const store = storeFor(account);
    if (!store) throw new Error(`no open store for ${account}`);
    const out = await store.run(releaseFence, {
      incarnationId: store.incarnationId,
      operationId,
    });
    return out.kind;
  },
  syncPosted,
  syncReceived,
  engineTrace,
  follow() {
    createBroadcastSyncChannel().subscribe((message) => {
      syncReceived.push(message);
    });
  },
  async seedDelta(account, cursor) {
    const store =
      engineRuntime?.serviceFor(account)?.store ??
      stores.get(account) ??
      runtime.serviceFor(account)?.store;
    if (!store) throw new Error(`no open store for ${account}`);
    await store.run(
      {
        name: "fixture.seedDelta",
        scope: ["sync_state"],
        mode: "readwrite",
        durability: "strict",
        read: (reader) => reader.get("sync_state", "singleton"),
        decide: (row) => ({
          writes: row
            ? [
                w.put("sync_state", {
                  ...row,
                  phase: "delta",
                  cache_status: "valid",
                  cursor,
                }),
              ]
            : [],
          result: null,
        }),
      },
      null,
    );
  },
  async startSync(account, options) {
    const session = sessionOf();
    // The runtime is shared with the outbox leader on this page: one service per account, one set of connections.
    const leaderRuntime = ensureRuntime(session);
    const opened = await leaderRuntime.open(account, { create: true });
    if (opened.kind !== "opened") throw new Error(openFailure(opened));
    const service = opened.service;
    // Arranged BEFORE the engine starts, so the first step already sees a delta database (no race with a second trigger).
    if (options?.seedCursor !== undefined)
      await harness.seedDelta(account, options.seedCursor);
    engineYield = options?.yieldPolicy ?? "platform";
    startEngine({
      account,
      service,
      identity: session.identity,
      fetchFor: (a, e) => session.api.fetchFor("ordinary", a, e),
      subscribe: (listener) => {
        const offs = [
          session.view.subscribe(listener),
          session.identity.subscribe(listener),
        ];
        document.addEventListener("visibilitychange", listener);
        return () => {
          for (const off of offs) off();
          document.removeEventListener("visibilitychange", listener);
        };
      },
      onOnline: (listener) => {
        window.addEventListener("online", listener);
        return () => window.removeEventListener("online", listener);
      },
      deviceMemoryGiB: options?.deviceMemoryGiB,
    });
  },
  async startSyncLocal(account, options) {
    // No session on this page (the device profiling page): the harness's own runtime and identity, and a transport the caller supplies.
    harness.setRuntimeIdentity({ account, epoch: 1 });
    const opened = await runtime.open(account, { create: true });
    if (opened.kind !== "opened") throw new Error(openFailure(opened));
    if (options.seedCursor !== undefined)
      await harness.seedDelta(account, options.seedCursor);
    startEngine({
      account,
      service: opened.service,
      identity: identityStore,
      fetchFor: () => options.transport,
      subscribe: (listener) => identityStore.subscribe(listener),
      onOnline: () => () => undefined,
      deviceMemoryGiB: options.deviceMemoryGiB,
    });
  },
  setPersistenceFault(mode) {
    persistenceFault = mode;
  },
  stopSync() {
    engine?.stop();
    engineAbort?.abort();
    engine = null;
  },
  restartSync() {
    if (!engine) throw new Error("no engine is running on this page");
    replacedAbort = engineAbort;
    engineAbort = new AbortController();
    engine.start({ token: null, signal: engineAbort.signal });
  },
  abortReplacedOwnership() {
    replacedAbort?.abort();
  },
  loseSyncOwnership() {
    engineAbort?.abort();
  },
  wakeNotifications() {
    return wakeNotifications;
  },
  holdQuota() {
    quotaHold = new Promise<void>((resolve) => {
      quotaRelease = resolve;
    });
  },
  releaseQuota() {
    quotaRelease?.();
    quotaRelease = null;
  },
  engineState: () => engine?.state.get() ?? null,
  retrySync: () => engine?.retryNow(),
  nudgeSync: () => engine?.nudge("now"),
  invalidationHolds: () =>
    engine?.invalidations.get().map((hold) => hold.operation) ?? [],
  async startGate(account, options = {}) {
    const session = sessionOf();
    isolatedRuntime?.dispose();
    isolatedRuntime = null;
    gateFacts = { starts: 0, emissions: 0, calls: 0 };
    let gateIdentity: Store<Identity | null> = session.identity;
    if (options.isolated === true) {
      const shown = session.identity.get();
      if (shown === null || shown.account_id !== account)
        throw new Error(`an isolated gate needs ${account} to be displayed`);
      gateIdentity = { get: () => shown, subscribe: () => () => undefined };
    }
    const gateRuntime =
      options.isolated === true
        ? isolatedGateRuntime(session, gateIdentity)
        : ensureRuntime(session);
    gateEnv?.dispose();
    const onlineListeners = new Set<() => void>();
    const emit = () => {
      for (const listener of [...onlineListeners]) listener();
    };
    window.addEventListener("online", emit);
    window.addEventListener("offline", emit);
    const env = createDataEnv({
      identity: gateIdentity,
      loadRuntime: async () => gateRuntime,
      online: {
        get: () => navigator.onLine,
        subscribe(listener) {
          onlineListeners.add(listener);
          return () => {
            onlineListeners.delete(listener);
          };
        },
      },
      quota: createQuotaGuard({
        storage: navigator.storage,
        now: () => Date.now(),
      }),
      ids: { uuid: () => crypto.randomUUID() },
      clock: { now: () => Date.now(), iso: () => new Date().toISOString() },
      fence: () => ({ hasPendingOperation: false, sessionStarted: true }),
      // This harness composes the controller without a session: there is nothing to ask.
      readMe: async () => ({ kind: "closed" }),
      currentDeviceId: async () => ({ kind: "closed" }),
      onOnline: (listener) => {
        window.addEventListener("online", listener);
        return () => window.removeEventListener("online", listener);
      },
      markers,
      ...(options.defaults === true
        ? { readDefaultsSnapshot: readDefaultsSnapshotThrough(session) }
        : {}),
    });
    gateEnv = env;
    gateSeen = [];
    env.serviceStore.subscribe(() => {
      const followed = env.service();
      if (followed !== null)
        followed.onEnd((reason) =>
          endLog.push([Math.round(performance.now()), reason]),
        );
    });
    env.inputs.subscribe(() => {
      const cache = env.inputs.get().cache;
      if (gateEnv === env && gateSeen.at(-1) !== cache) gateSeen.push(cache);
    });
    if (engine !== null) env.attachLeader({ engine });
    // The controller opens the account's database asynchronously (it never creates one), and then reads the sync facts: until that
    // first read lands its cache state is `unverified`, which a gate reads as hidden (R13). Wait for BOTH, so that a gate read after
    // this call is the controller's answer on an ESTABLISHED state and not its answer-so-far. A test of the unestablished state
    // itself passes `established: false` and reads the gate at once.
    for (let i = 0; i < 1500 && env.service() === null; i += 1)
      await new Promise((resolve) => setTimeout(resolve, 10));
    if (env.service() === null)
      throw new Error(`the controller has no database for ${account}`);
    if (options.established === false) return;
    const unestablished = (): boolean =>
      env.inputs.get().cache === "unknown" ||
      env.inputs.get().cache === "unverified";
    for (let i = 0; i < 1500 && unestablished(); i += 1)
      await new Promise((resolve) => setTimeout(resolve, 10));
    if (unestablished())
      throw new Error(`the controller never read the facts of ${account}`);
  },
  gate: () => (gateEnv === null ? null : deriveGate(gateEnv.inputs.get())),
  gateDefaults: () => {
    const defaults = gateEnv?.defaults;
    return defaults === undefined
      ? null
      : {
          boundary: () => defaults.boundary(),
          acquire: (after) => defaults.acquire(after),
          revision: () =>
            defaults.record.get()?.snapshot.defaults.revision ?? null,
        };
  },
  gateIncarnation: () => gateEnv?.service()?.incarnationId ?? null,
  gateCache: () => (gateEnv === null ? null : gateEnv.inputs.get().cache),
  gateHistory: () => [...gateSeen],
  resetGateHistory() {
    gateSeen = [];
  },
  gateDiagnostics: () => ({
    latches: [...latchLog],
    ends: [...endLog],
    closes: [...closeLog],
  }),
  gateNotices: () =>
    gateEnv === null ? [] : deriveNotices(gateEnv.inputs.get()),
  stopGate() {
    gateEnv?.dispose();
    gateEnv = null;
    isolatedRuntime?.dispose();
    isolatedRuntime = null;
  },
  gateFactsReads: () => ({ ...gateFacts }),
  host,
  opener,
  stores,
  versionChanges,
  latch: (account) => registry.latch(account),
  openCount: (account) => registry.openCount(account),
  setIdentity(account) {
    facts.account = account;
  },
  setPending(account, pending) {
    if (pending) facts.pending.add(account);
    else facts.pending.delete(account);
  },
  async open(account, options) {
    const outcome: OpenOutcome = await openAccountData(
      openDeps,
      account,
      options,
    );
    if (outcome.kind === "opened") {
      stores.get(account)?.close();
      stores.set(account, outcome.store);
      return outcome.created ? "created" : "opened";
    }
    return outcome.kind === "refused" ? `refused:${outcome.reason}` : "absent";
  },
  run(account, plan, input) {
    const store = storeFor(account);
    if (!store) throw new Error(`no open store for ${account}`);
    return store.run(plan, input);
  },
  async runConformance() {
    const assert: Assert = {
      ok(value, message) {
        if (!value) throw new Error(`not ok: ${message}`);
      },
      equal(actual, expected, message) {
        if (actual !== expected)
          throw new Error(
            `${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
          );
      },
      deepEqual(actual, expected, message) {
        const a = JSON.stringify(actual);
        const b = JSON.stringify(expected);
        if (a !== b) throw new Error(`${message}: expected ${b}, got ${a}`);
      },
    };
    const world: ConformanceWorld = {
      async fresh() {
        const account = crypto.randomUUID();
        facts.account = account;
        const outcome = await openAccountData(openDeps, account, {
          create: true,
        });
        if (outcome.kind !== "opened")
          throw new Error(`could not create: ${outcome.kind}`);
        return outcome.store;
      },
      async second(of) {
        const outcome = await opener.open(of.account, {
          create: false,
          incarnation: crypto.randomUUID(),
        });
        if (outcome.kind !== "opened") throw new Error("could not reopen");
        return outcome.store;
      },
      async blocker(store) {
        // A real transaction that stays open by reading in a loop until it is told to end.
        let released = false;
        void store
          .run(
            blockerPlan(() => released),
            null,
          )
          .catch(() => undefined);
        await new Promise((resolve) => setTimeout(resolve, 20));
        return {
          release: () => {
            released = true;
          },
        };
      },
    };
    const results: ConformanceResult[] = [];
    for (const testCase of CONFORMANCE_CASES) {
      try {
        await testCase.run(world, assert);
        results.push({ id: testCase.id, title: testCase.title, ok: true });
      } catch (error) {
        results.push({
          id: testCase.id,
          title: testCase.title,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return results;
  },
  async put(account, store, rows) {
    const handle = storeFor(account);
    if (!handle) throw new Error(`no open store for ${account}`);
    return handle.run(
      putPlan(store) as never,
      rows as never,
    ) as Promise<number>;
  },
  async rows(account, store) {
    const handle = storeFor(account);
    if (!handle) throw new Error(`no open store for ${account}`);
    return (await handle.run(
      listPlan(store) as never,
      undefined as never,
    )) as object[];
  },
  close(account) {
    stores.get(account)?.close();
    stores.delete(account);
  },
  async openDirect(account) {
    const outcome = await opener.open(account, {
      create: false,
      incarnation: crypto.randomUUID(),
    });
    if (outcome.kind === "opened") {
      outcome.store.close();
      return "opened";
    }
    return "absent";
  },
  incarnation: (account) => stores.get(account)?.incarnationId ?? null,
  async tryRows(account, store) {
    const handle = storeFor(account);
    if (!handle) return "no_handle";
    try {
      await handle.run(listPlan(store) as never, undefined as never);
      return "ok";
    } catch (error) {
      return error instanceof Error && "cause" in error
        ? String((error as { cause: unknown }).cause)
        : "error";
    }
  },
  ports,
  markers,
  runtime,
  setRuntimeIdentity(next) {
    runtimeIdentity = next
      ? { account_id: next.account, epoch: next.epoch, session_id: "harness" }
      : null;
    facts.account = next?.account ?? null;
    for (const listener of [...identityListeners]) listener();
  },
  async openService(account, options) {
    const outcome = await runtime.open(account, options);
    return outcome.kind === "opened"
      ? outcome.created
        ? "created"
        : "opened"
      : outcome.kind === "refused"
        ? `refused:${outcome.reason}`
        : "absent";
  },
  async commitProbe(account, epoch, caller) {
    const service = runtime.serviceFor(account);
    if (!service) return "no_service";
    const outcome = await service.commit(recordReadOutcome, {
      captured: service.capture(epoch),
      caller,
      outcome: { kind: "failure" },
      now: Date.now(),
    });
    return outcome.kind === "applied"
      ? "applied"
      : outcome.kind === "dropped"
        ? `dropped:${outcome.reason}`
        : `failed:${outcome.failure.cause}`;
  },
  formRecovery(account, options) {
    recoveryQuota?.close?.();
    const free = options?.estimateFreeBytes;
    recoveryQuota =
      free === undefined
        ? null
        : createProductionQuota({
            storage: { estimate: async () => ({ usage: 0, quota: free }) },
          });
    return createFormRecoveryPort({
      service: () => runtime.serviceFor(account),
      now: () => new Date().toISOString(),
      ...(recoveryQuota === null ? {} : { quota: recoveryQuota }),
    });
  },
  async recoveryOverlap(account) {
    const snap = (text: string) => ({
      formContext: "overlap",
      tabInstanceId: "tab-o",
      values: { text },
      savedAt: "2026-10-01T09:00:00.000Z",
    });
    const service = () => runtime.serviceFor(account);
    const normal = () =>
      createFormRecoveryPort({
        service,
        now: () => new Date().toISOString(),
      });
    const seed = normal();
    await seed.save(snap("one"));
    await seed.save(snap("two"));
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const reached = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const held = {
      reserve: async () => {
        entered();
        await gate;
        return {
          verdict: "ok",
          live: () => true,
          settle: () => undefined,
        };
      },
    } as unknown as QuotaGuard;
    const older = createFormRecoveryPort({
      service,
      now: () => new Date().toISOString(),
      quota: held,
    });
    const delayed = older.save(snap("older capture"));
    await reached;
    const replacement = normal();
    const replaced = await replacement.save(snap("newer capture"));
    release();
    const olderResult = await delayed;
    const loaded = await replacement.load("overlap", "tab-o");
    const rows = (await harness.rows(account, "form_recovery")) as Array<{
      form_context: string;
      writer_gen?: number;
      capture_seq: number;
    }>;
    return {
      replacement: replaced,
      older: olderResult,
      final: loaded?.values.text,
      row: rows.find((row) => row.form_context === "overlap"),
    };
  },
  recoveryRun(account, name, options) {
    let release!: () => void;
    let entered!: () => void;
    const opened = new Promise<void>((resolve) => {
      release = resolve;
    });
    const reached = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let first = options.held;
    const quota = {
      reserve: async () => {
        if (first) {
          first = false;
          entered();
          await opened;
        }
        return { verdict: "ok", live: () => true, settle: () => undefined };
      },
    } as unknown as QuotaGuard;
    recoveryRuns.set(name, {
      port: createFormRecoveryPort({
        service: () => runtime.serviceFor(account),
        now: () => new Date().toISOString(),
        quota,
      }),
      release,
      reached: options.held ? reached : Promise.resolve(),
      results: [],
    });
  },
  recoveryStart(name, calls) {
    const run = recoveryRuns.get(name);
    if (!run) throw new Error(`no recovery run ${name}`);
    for (const call of calls)
      run.results.push(
        call.kind === "save"
          ? run.port.save({
              formContext: RECOVERY_ORDER_FORM,
              tabInstanceId: RECOVERY_ORDER_TAB,
              values: { text: call.text },
              savedAt: new Date().toISOString(),
            })
          : run.port
              .discard(RECOVERY_ORDER_FORM, RECOVERY_ORDER_TAB)
              .then(() => "done"),
      );
  },
  recoveryReached(name) {
    const run = recoveryRuns.get(name);
    if (!run) throw new Error(`no recovery run ${name}`);
    return run.reached;
  },
  recoveryRelease(name) {
    recoveryRuns.get(name)?.release();
  },
  async recoveryResults(name) {
    const run = recoveryRuns.get(name);
    if (!run) throw new Error(`no recovery run ${name}`);
    return Promise.all(run.results);
  },
  async recoveryLoad(account) {
    const loaded = await createFormRecoveryPort({
      service: () => runtime.serviceFor(account),
      now: () => new Date().toISOString(),
    }).load(RECOVERY_ORDER_FORM, RECOVERY_ORDER_TAB);
    return loaded?.values.text ?? null;
  },
  async holdExpiry({ account, holdMs, stallMs, blockerMs }) {
    const trace: string[] = [];
    harness.setRuntimeIdentity({ account, epoch: 1 });
    const scenario = new DataRuntime({
      identity: identityStore,
      persistence: {
        // The kernel's own lifecycle over real locks and a real timer; the verdict at the record is not part of this page.
        async hold() {
          const lock = await locks.acquireShared("atlas-auth", {
            signal: AbortSignal.timeout(10_000),
          });
          if (lock === null) return { kind: "unavailable" };
          return openHold(lock, {
            clock: { abortAfter: (ms) => AbortSignal.timeout(ms) },
            holdMs,
            stallMs,
            emit: (event) => trace.push(event),
          });
        },
      },
      registry,
      open: (a, options) => openAccountData(openDeps, a, options),
    });
    const opened = await scenario.open(account, { create: true });
    if (opened.kind !== "opened") throw new Error(`setup: ${opened.kind}`);
    const service = opened.service;
    const pause = (ms: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, ms));
    // A real transaction that stays open, by reading in a loop, until it is told to end; the commit queues behind it.
    let released = false;
    const blocker = service.store
      .run(
        blockerPlan(() => released),
        null,
      )
      .catch(() => undefined);
    await pause(50);
    const started = performance.now();
    let answered = 0;
    const commit = service
      .commit(recordReadOutcome, {
        captured: service.capture(1),
        caller: "e-p2",
        outcome: { kind: "failure" },
        now: Date.now(),
      })
      .then((result) => {
        // When the commit ANSWERED, not when this scenario got round to looking.
        answered = performance.now() - started;
        return result;
      });
    // The settlement: a real exclusive request for the lock every settlement of the session record is made under.
    await pause(20);
    const requested = performance.now();
    let granted: number | null = null;
    const settlement = navigator.locks.request("atlas-auth", async () => {
      granted = performance.now() - requested;
      await pause(10);
    });
    await pause(blockerMs);
    released = true;
    await blocker;
    const outcome = await commit;
    await settlement;
    // Through the scenario's own service (its runtime is not the harness's, so `harness.rows` does not know the account).
    const state = (await service.store.run(
      listPlan("sync_state"),
      undefined,
    )) as unknown as Array<{ read_retry_states?: Record<string, unknown> }>;
    scenario.dispose();
    return {
      outcome:
        outcome.kind === "applied"
          ? "applied"
          : outcome.kind === "dropped"
            ? `dropped:${outcome.reason}`
            : `failed:${outcome.failure.cause}`,
      settlementGrantedAfterMs: granted,
      commitAnsweredAfterMs: answered,
      trace,
      written: state[0]?.read_retry_states?.["e-p2"] !== undefined,
    };
  },
  async markClosing(account) {
    const store = storeFor(account);
    if (!store) throw new Error(`no open store for ${account}`);
    await store.run(setClosing, {
      incarnationId: store.incarnationId,
      now: Date.now(),
      token: crypto.randomUUID(),
    });
  },
  async syncState(account) {
    const rows = (await harness.rows(account, "sync_state")) as Array<
      Record<string, unknown>
    >;
    return rows[0] ?? null;
  },
  describe: describeDatabase,
  list: async () => [...(await host.list())],
  async createLegacyV1(account, drafts) {
    const name = accountDatabaseName(account);
    const dexieVersion1 = 10;
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open(name, dexieVersion1);
      request.onerror = () => reject(request.error);
      request.onupgradeneeded = () => {
        const db = request.result;
        for (const [store, definition] of Object.entries(DEXIE_SCHEMA_V1)) {
          const [primary, ...indexes] = definition
            .split(",")
            .map((part) => part.trim());
          const keyPath = (text: string): string | string[] =>
            text.startsWith("[") ? text.slice(1, -1).split("+") : text;
          const objectStore = db.createObjectStore(store, {
            keyPath: keyPath(primary as string),
          });
          for (const index of indexes) {
            const multiEntry = index.startsWith("*");
            const bare = multiEntry ? index.slice(1) : index;
            objectStore.createIndex(bare, keyPath(bare), { multiEntry });
          }
        }
      };
      request.onsuccess = () => {
        const db = request.result;
        const tx = db.transaction(["sync_state", "drafts"], "readwrite");
        tx.objectStore("sync_state").put(
          initialSyncState("legacy-incarnation"),
        );
        for (const draft of drafts)
          tx.objectStore("drafts").put({
            local_id: draft.local_id,
            account_id: account,
            endpoint: "/commands",
            target_id: null,
            command: draft.command,
            command_digest: `d-${draft.local_id}`,
            defaults_revision: null,
            target_resource_ids: [],
            side_effect_bases: {},
            index_targets: [],
            bases: {},
            bumped: [],
            defaults_context: null,
            review_block: null,
            depends_on: [],
            status: "queued",
            held_pending_cache: false,
            unavailable_outcome: false,
            retry_state: null,
            attempts: 0,
            last_attempt_at: null,
            last_error: null,
            display_patch: null,
            receipt_revision: null,
            created_seq: draft.created_seq,
            created_at: "2026-10-01T09:00:00.000Z",
          });
        tx.oncomplete = () => {
          db.close();
          resolve();
        };
        tx.onerror = () => {
          db.close();
          reject(tx.error);
        };
      };
    });
  },
  async removeSingleton(account) {
    const name = accountDatabaseName(account);
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open(name);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result;
        const tx = db.transaction("sync_state", "readwrite");
        tx.objectStore("sync_state").delete("singleton");
        tx.oncomplete = () => {
          db.close();
          resolve();
        };
        tx.onerror = () => {
          db.close();
          reject(tx.error);
        };
      };
    });
  },
};

declare global {
  interface Window {
    __atlasData?: DataHarness;
  }
}
window.__atlasData = harness;
// The provider-lifetime harness (R35, revision 20): the production provider over real IndexedDB, attached to the same page.
void import("./provider-lifetime");

// The open-closure harness (R36 and R37, revision 21): the production runtime over real IndexedDB, with a fact or the database changed while an
// open is under way.
void import("./open-closure");

// The write-snapshot harness (R39 and R40, revision 22): the production outbox over real IndexedDB, with the caller's graph or request edited
// at a named instant of a save.
void import("./write-snapshot");

// The durable-failure lab (R55 and R58, revision 34): the production markers and stop helpers over real `localStorage` and real Web Locks,
// with a lock's delivery held, or the page's slot confined to one name.
void import("./durable-lab");
