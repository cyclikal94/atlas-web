import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { apiUrl } from "../../lib/api-client/wire";
import type { SyncStatusModel } from "../../lib/sync-chip";
import type { Session } from "../../session";
import type { DataRuntime } from "../engine/account-service";
import type {
  Acquisition,
  RefreshOutcome,
  RequestBoundary,
} from "../engine/defaults-source";
import { createBroadcastSyncChannel } from "../engine/sync-channel";
import { getPageDataHost, type PageDataHost } from "../leader/page-host";
import { leaderStarted } from "../leader/presence";
import type { MergedResource } from "../model/overlay";
import type { QueueSummary } from "../model/queue-summary";
import type { DefaultsRecord } from "../model/sharing-snapshot";
import {
  deriveGate,
  deriveNotices,
  deriveSyncStatus,
  type GateState,
  type Notice,
  type StatusInputs,
} from "../model/status";
import type { DraftRow, ResourceId, ResourceKind } from "../model/types";
import type { CommandRegistry } from "../outbox/registries";
import {
  type QueuePage,
  type ResourcePage,
  readMerged,
  readResourceList,
} from "../plans/outbox";
import {
  type Outstanding,
  type PendingCreatesPage,
  type ResourceView,
  readOutstanding,
  readPendingCreates,
  readResourceView,
} from "../plans/pending-reads";
import type { Loadable, Watchable } from "../store/port";
import { createDataEnv, type DataActions, type DataEnv } from "./env";
import {
  currentDeviceThrough,
  readDefaultsSnapshotThrough,
  readMeThrough,
} from "./identity-reads";
import { createProductionQuota } from "./production-quota";

/**
 * The React face of the data layer (plan 5.7): a provider that owns ONE controller for the protected tree, and the hooks the
 * screens and the shell read. Every hook that reads the database returns `{ status: "unavailable" }` when there is none (a page
 * that never saved or synced anything) or it is latched, and NONE of them creates it.
 *
 * `DataEnvProvider` takes a ready controller (tests and the fixture); `DataProvider` builds the production one over the session,
 * loading the browser composition (Dexie) lazily so it stays out of the initial bundle.
 */
const DataEnvContext = createContext<DataEnv | null>(null);

export function DataEnvProvider({
  env,
  children,
}: {
  env: DataEnv;
  children: ReactNode;
}) {
  return (
    <DataEnvContext.Provider value={env}>{children}</DataEnvContext.Provider>
  );
}

/** The browser composition (Dexie, the host, the open predicate): loaded lazily, so it stays out of the initial bundle. */
export type BrowserComposition = Pick<
  typeof import("./browser-env"),
  "createBrowserRuntime"
>;

export function DataProvider({
  session,
  children,
  loadBrowser = () => import("./browser-env"),
  commands,
  host = getPageDataHost(),
}: {
  session: Session;
  children: ReactNode;
  /** The lazy load of the browser composition. Only a test names its own, to decide WHEN the import arrives; production leaves the default. */
  loadBrowser?: () => Promise<BrowserComposition>;
  /**
   * What the feature slices registered about their commands (descriptions, projected creates). The application passes ONE registry,
   * filled once per page host (`src/app/commands.ts`), so a remount or a Strict Mode replay never registers twice. Absent: the
   * page host's registry.
   */
  commands?: CommandRegistry;
  /** The page's shared writer state (P-4): the page's own when omitted. A test supplies its own. */
  host?: PageDataHost;
}) {
  // CONSTRUCTION IS INERT (R29): a state initialiser runs in render, and development Strict Mode runs it twice and keeps one, so
  // whatever it builds must hold nothing (no subscription, no timer, no channel) and may be dropped without a cleanup. The controller
  // starts in the effect and stops in its cleanup, which is the PAIR React replays (mount, cleanup, mount) and runs at unmount, so a
  // replay leaves the same live controller, never a disposed one, and nothing outlives the tree.
  const [env] = useState<DataEnv>(() =>
    createProductionEnv(session, loadBrowser, host, commands),
  );
  useEffect(() => {
    env.start();
    return () => env.dispose();
  }, [env]);
  return <DataEnvProvider env={env}>{children}</DataEnvProvider>;
}

/**
 * The production controller over the session. Everything here is light (no Dexie): connectivity, the quota estimate, the stamped
 * `GET /me`, the sessions list, `atlas-sync`. The ONE heavy part, the runtime and its Dexie adapter, is a dynamic import made the
 * first time an identity is displayed, so it is a separate chunk and never part of the initial bundle.
 */
function createProductionEnv(
  session: Session,
  loadBrowser: () => Promise<BrowserComposition>,
  host: PageDataHost,
  commands?: CommandRegistry,
): DataEnv {
  let browser: { dispose(): void } | null = null;
  /**
   * Counts every start and every stop. A runtime is built after an asynchronous import, so it belongs to the lifetime that asked for it:
   * one that arrives after a stop (an unmount, or the cleanup of a replayed effect) is disposed at once and never kept.
   */
  let lifetime = 0;
  let running = false;
  const online = onlineStore();
  const channel = createBroadcastSyncChannel();
  // What is promised and what has just landed is the ORIGIN's (R28): every page of the origin judges against one ledger. It is opened on
  // first use, so building this holds nothing.
  const quota = createProductionQuota();
  const env = createDataEnv(
    {
      identity: session.identity,
      loadRuntime: async () => {
        const asked = lifetime;
        // A production leader runs on this page (P-3): the tree uses the PAGE's runtime, which the leader composed and which lives as long
        // as the page. It is never disposed here, so unmounting the tree (every fence) closes none of the page's connections. Until it is
        // there (the leader's chunk is loading) the look waits for it rather than building a second runtime over the same registry.
        if (leaderStarted() || host.runtime.get() !== null) {
          const shared = await pageRuntime(host);
          if (asked !== lifetime)
            throw new Error("the data layer was disposed");
          return shared;
        }
        const module = await loadBrowser();
        const built = module.createBrowserRuntime(session);
        if (asked !== lifetime) {
          built.dispose();
          throw new Error("the data layer was disposed");
        }
        browser?.dispose();
        browser = built;
        return built.runtime;
      },
      online,
      quota,
      ids: { uuid: () => crypto.randomUUID() },
      clock: {
        iso: () => new Date().toISOString(),
        now: () => Date.now(),
        random: () => Math.random(),
      },
      fence: (account) => ({
        hasPendingOperation: session.operations.pending
          .get()
          .some((op) => op.account_id === account),
        sessionStarted: true,
      }),
      readMe: readMeThrough(session),
      readDefaultsSnapshot: readDefaultsSnapshotThrough(session),
      currentDeviceId: currentDeviceThrough(session),
      // R7: WF-QUEUE-02's authorised current-state read is an ORDINARY stamped request of the displayed account and epoch.
      fetchOrdinary: (account, epoch) =>
        session.api.fetchFor("ordinary", account, epoch),
      apiUrl: (path) => apiUrl(path),
      // R7 (second cycle): the read's whole interpreted result is validated against the durable record before it is handed back.
      seal: (account, epoch, pending) =>
        session.api.seal(account, epoch, pending),
      onOnline: (listener) => {
        window.addEventListener("online", listener);
        return () => window.removeEventListener("online", listener);
      },
      channel,
      // The page's ONE markers object (R46, P-4), leased: the controller's start takes a lease and its stop gives it back.
      markers: host.markers,
      commands: commands ?? host.commands,
    },
    { start: false },
  );
  const start = env.start.bind(env);
  const dispose = env.dispose.bind(env);
  // The page's leadership, attached while the controller runs (P-4): the status follows the page's engine, outbox and job, or says
  // that another page leads (P-11).
  let detachLeader: (() => void) | null = null;
  let offLeader: (() => void) | null = null;
  const followLeader = (): void => {
    detachLeader?.();
    detachLeader = null;
    const attachment = host.leader.get();
    if (attachment.role === "leader")
      detachLeader = env.attachLeader({
        engine: attachment.engine,
        ...(attachment.outbox ? { outbox: attachment.outbox } : {}),
        recovery: attachment.recovery,
      });
    else if (attachment.role === "follower")
      detachLeader = env.attachFollower();
  };
  return {
    ...env,
    start() {
      // A start that is already running is not a new lifetime: it must not make a runtime that is still loading obsolete.
      if (running) return;
      running = true;
      lifetime += 1;
      start();
      offLeader = host.leader.subscribe(followLeader);
      followLeader();
    },
    dispose() {
      if (!running) return;
      running = false;
      lifetime += 1;
      offLeader?.();
      offLeader = null;
      detachLeader?.();
      detachLeader = null;
      dispose();
      browser?.dispose();
      browser = null;
      // What this controller opened is closed with it; the next start opens what it needs again (all of it opens on first use).
      channel.close();
      quota.close?.();
    },
  };
}

/** The page runtime the leader composes, once it is there. */
function pageRuntime(host: PageDataHost): Promise<DataRuntime> {
  const now = host.runtime.get();
  if (now !== null) return Promise.resolve(now.runtime);
  return new Promise<DataRuntime>((resolve) => {
    const off = host.runtime.subscribe(() => {
      const next = host.runtime.get();
      if (next === null) return;
      off();
      resolve(next.runtime);
    });
  });
}

/** Connectivity as the page knows it. */
function onlineStore() {
  const listeners = new Set<() => void>();
  const notify = (): void => {
    for (const listener of [...listeners]) listener();
  };
  return {
    get: () => (typeof navigator === "undefined" ? true : navigator.onLine),
    subscribe(listener: () => void) {
      listeners.add(listener);
      if (listeners.size === 1) {
        window.addEventListener("online", notify);
        window.addEventListener("offline", notify);
      }
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) {
          window.removeEventListener("online", notify);
          window.removeEventListener("offline", notify);
        }
      };
    },
  };
}

/** The controller, or null when no provider is mounted (the shell and its tests render without one and then show nothing of it). */
export function useOptionalDataEnv(): DataEnv | null {
  return useContext(DataEnvContext);
}

export function useDataEnv(): DataEnv {
  const env = useContext(DataEnvContext);
  if (!env) throw new Error("useDataEnv must be used inside a DataProvider");
  return env;
}

/** A store is read through closures over the store itself: the stores are class instances, and a detached method loses `this`. */
function useStore<T>(store: {
  get(): T;
  subscribe(listener: () => void): () => void;
}): T {
  const subscribe = useCallback(
    (listener: () => void) => store.subscribe(listener),
    [store],
  );
  const get = useCallback(() => store.get(), [store]);
  return useSyncExternalStore(subscribe, get, get);
}

// ---- the status model ----------------------------------------------------------------------------------------------------------
export function useStatusInputs(): StatusInputs {
  return useStore(useDataEnv().inputs);
}

/**
 * The model the chip reads. A transient back-off keeps the phase shown last, so it is remembered across renders; the object is
 * stable while its fields are unchanged, so a consumer that memoises on it does not re-render for nothing.
 */
export function useSyncStatusModel(): SyncStatusModel {
  const inputs = useStatusInputs();
  const previous = useRef<SyncStatusModel | null>(null);
  const next = deriveSyncStatus(
    { ...inputs, previous: previous.current?.phase },
    Date.now(),
  );
  const last = previous.current;
  if (
    last !== null &&
    last.phase === next.phase &&
    last.pendingCount === next.pendingCount &&
    last.conflictCount === next.conflictCount &&
    last.lastSyncedAt === next.lastSyncedAt
  )
    return last;
  previous.current = next;
  return next;
}

export function useNotices(): Notice[] {
  const inputs = useStatusInputs();
  return useMemo(() => deriveNotices(inputs), [inputs]);
}

export function useCacheGate(): GateState {
  const inputs = useStatusInputs();
  return useMemo(() => deriveGate(inputs), [inputs]);
}

// ---- the queue --------------------------------------------------------------------------------------------------------------------
export function useQueueSummary(): Loadable<QueueSummary> {
  return useStore(useDataEnv().summary);
}

/**
 * The visible queue, a page at a time: the rows, whether more follow, and the number of drafts that depend on each. Subscribing to
 * it is what loads the rows; the counts a screen needs for a heading come from `useQueueSummary`, never from the rows.
 */
export function useDraftQueue(): Loadable<QueuePage> {
  return useStore(useDataEnv().queue);
}

/** One entry of the conflict inbox: a draft that needs a decision, with the kind of decision (read-only: no screen resolves it here). */
export interface ConflictRow {
  draft: DraftRow;
  kind: "version_conflict" | "operation_conflict" | "defaults_review";
}

/**
 * The conflict inbox (plan 3.3, D-17): the drafts that wait for a decision the person has not made, in queue order, each with its
 * kind, a bounded page read by index (the conflicts and the reviewing drafts, never the whole queue). The screens that resolve them
 * (WF-CONFLICT-01/02) are unowned and not built in this slice, so this carries no action; a rejected or capacity-blocked draft is not
 * a conflict (it has its own review, with Discard and Retry).
 */
export function useConflictInbox(): Loadable<ConflictRow[]> {
  const page = useStore(useDataEnv().conflicts);
  return useMemo(
    () =>
      page.status === "ready"
        ? ({ status: "ready", value: page.value.rows } as Loadable<
            ConflictRow[]
          >)
        : (page as Loadable<ConflictRow[]>),
    [page],
  );
}

export function useDataActions(): DataActions {
  return useDataEnv().actions;
}

/** A generic, content-free description of a draft from the registered kind, or null when none is registered. */
export function useCommandDescription(): (draft: DraftRow) => string | null {
  const { commands } = useDataEnv();
  return (draft) => commands.describe(draft);
}

// ---- the account label (HO-9) ----------------------------------------------------------------------------------------------------
/** The verified username, only while it is verified for the CURRENT epoch; otherwise null. Never derived from the account id. */
export function useAccountLabel(): string | null {
  const env = useDataEnv();
  useStore(env.profile.profile);
  const identity = useStore(env.identity);
  return env.profile.labelFor(identity);
}

// ---- the sharing defaults (WEB-12a, B5) ------------------------------------------------------------------------------------------
/**
 * The displayed account's sharing defaults: the persisted or freshly read B5 record, and `refresh()` (one read now, for an editor or a
 * review that opened). Using this hook is what makes the data layer read them at all (`DefaultsSource.use`): nothing is asked on the
 * boot path or by a page that never shows sharing. `status`: `loading` while the account's record is still being looked for, `ready`
 * with a record, `none` when no record exists (never fetched on this device): a queued create then captures `never_fetched`.
 * `boundary()` and `acquire(boundary)` are for a caller that needs a snapshot asked for AFTER a moment (a review that opened, a change
 * just saved): see `DefaultsSource.acquire`.
 */
export function useSharingDefaults(): {
  record: DefaultsRecord | null;
  status: "loading" | "ready" | "none";
  refresh(): Promise<RefreshOutcome>;
  boundary(): RequestBoundary | null;
  acquire(boundary: RequestBoundary | null): Promise<Acquisition>;
} {
  const env = useDataEnv();
  useEffect(() => env.defaults.use(), [env]);
  const record = useStore(env.defaults.record);
  const settled = useStore(env.defaults.settled);
  return useMemo(
    () => ({
      record,
      status: record !== null ? "ready" : settled ? "none" : "loading",
      refresh: () => env.defaults.refresh(),
      boundary: () => env.defaults.boundary(),
      acquire: (boundary: RequestBoundary | null) =>
        env.defaults.acquire(boundary),
    }),
    [record, settled, env],
  );
}

// ---- cache reads (never create a database) ------------------------------------------------------------------------------------
const ABSENT: Loadable<never> = { status: "unavailable", reason: "absent" };

export function useWatch<T>(
  make: (env: DataEnv) => Watchable<T> | null,
  deps: readonly unknown[],
): Loadable<T> {
  const env = useDataEnv();
  const service = useStore(env.serviceStore);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the watch is rebuilt when the service or the caller's inputs change
  const watchable = useMemo(
    () => (service ? make(env) : null),
    [service, env, ...deps],
  );
  // Stable functions per watchable: a new `subscribe` every render would resubscribe, which re-evaluates the live query, which renders.
  const subscribe = useCallback(
    (listener: () => void) =>
      watchable?.subscribe(listener) ?? (() => undefined),
    [watchable],
  );
  const read = useCallback(
    () => (watchable ? watchable.get() : (ABSENT as Loadable<T>)),
    [watchable],
  );
  return useSyncExternalStore(subscribe, read, () => ABSENT as Loadable<T>);
}

/**
 * One resource with the overlay of its admitted changes (plan 5.5.6). For a resource the cache does not hold yet, `creates` is the
 * OLDEST window (100) of the changes saved against it and `createsNext` says where the next window begins: pass it back as `after`
 * to read on (R21, revision 10). A screen that shows only the resource passes nothing and gets the first window, which holds the
 * create that introduces it.
 */
export function useCachedResource(
  id: string,
  after?: number | null,
): Loadable<MergedResource> {
  return useWatch(
    (env) => {
      const service = env.service();
      return service
        ? service.store.watch(readMerged, {
            incarnationId: service.incarnationId,
            id,
            ...(after === undefined || after === null ? {} : { after }),
          })
        : null;
    },
    [id, after],
  );
}

/**
 * A PAGE of the cached resources of one kind (optionally under one parent), each with its overlay applied (R14): at most `limit` rows
 * (default and largest 100, Q9) after the cursor `after`. The page says where the next one begins (`next`, null on the last); a screen
 * keeps the cursors it has visited and passes one back to move, so what it holds is one page whichever it shows.
 */
export function useResourceList(options: {
  kind: ResourceKind;
  parentId?: string;
  after?: string | null;
  limit?: number;
}): Loadable<ResourcePage> {
  return useWatch(
    (env) => {
      const service = env.service();
      return service
        ? service.store.watch(readResourceList, {
            incarnationId: service.incarnationId,
            kind: options.kind,
            ...(options.parentId === undefined
              ? {}
              : { parentId: options.parentId }),
            ...(options.after === undefined ? {} : { after: options.after }),
            ...(options.limit === undefined ? {} : { limit: options.limit }),
          })
        : null;
    },
    [options.kind, options.parentId, options.after, options.limit],
  );
}

/**
 * This device's saves that CREATE a resource of one command kind which the cache does not hold yet (a queued create has no
 * overlay until it is claimed, so `useResourceList` cannot show it): the oldest window (100) with the exact total and the cursor of
 * the next window (`after`). Unsettled drafts only; see `readPendingCreates`.
 */
export function usePendingCreates(
  kind: string,
  after?: number | null,
): Loadable<PendingCreatesPage> {
  return useWatch(
    (env) => {
      const service = env.service();
      return service
        ? service.store.watch(readPendingCreates, {
            incarnationId: service.incarnationId,
            kind,
            ...(typeof after === "number" ? { after } : {}),
          })
        : null;
    },
    [kind, after],
  );
}

/**
 * The unsettled drafts that target one resource: exact counts by status and the newest of them (see `readOutstanding`); with `kind`,
 * also the newest of that kind that is still expected to apply (`latestOfKind`).
 */
export function useOutstanding(
  id: ResourceId,
  kind?: string,
): Loadable<Outstanding> {
  return useWatch(
    (env) => {
      const service = env.service();
      return service
        ? service.store.watch(readOutstanding, {
            incarnationId: service.incarnationId,
            id,
            ...(kind === undefined ? {} : { kind }),
          })
        : null;
    },
    [id, kind],
  );
}

/**
 * One resource as ONE read saw it (`readResourceView`): its cached and merged rows, its outstanding drafts, its newest create and the
 * observation a save made from it states. For a dialog that edits the resource: nothing it shows or saves mixes two moments.
 */
export function useResourceView(
  id: ResourceId,
  kinds: { create?: string; settings?: string } = {},
): Loadable<ResourceView> {
  const { create, settings } = kinds;
  return useWatch(
    (env) => {
      const service = env.service();
      return service
        ? service.store.watch(readResourceView, {
            incarnationId: service.incarnationId,
            id,
            ...(create === undefined ? {} : { createKind: create }),
            ...(settings === undefined ? {} : { settingsKind: settings }),
          })
        : null;
    },
    [id, create, settings],
  );
}
