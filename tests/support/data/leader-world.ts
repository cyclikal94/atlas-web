import type { DataRuntime } from "../../../src/data/engine/account-service";
import { createQuotaGuard } from "../../../src/data/engine/quota-guard";
import type { SyncMessage } from "../../../src/data/engine/sync-channel";
import { createLeaderElection } from "../../../src/data/leader/election";
import {
  createSyncLeader,
  type SyncLeader,
} from "../../../src/data/leader/leader";
import type { LeaderAttachment } from "../../../src/data/leader/page-host";
import { DATA_CONFIG } from "../../../src/data/model/config";
import { accountDatabaseName } from "../../../src/data/model/schema";
import type { AccountId, SyncStateRow } from "../../../src/data/model/types";
import { createConflictHandlerRegistry } from "../../../src/data/outbox/registries";
import {
  createKeyDerivers,
  createValueValidators,
} from "../../../src/data/scan/validate";
import {
  type ApiCompatibility,
  type Identity,
  type RecoveryBegin,
  type SessionView,
  unrevokedHold,
} from "../../../src/session";
import { EPOCH_BASE } from "../session/env";
import { DataTestWorld, type PageEnv } from "./env";
import { FakeMarkerStorage, pageMarkers } from "./marker-storage";
import { type PageSpec, pageJson } from "./sync-pages";

/**
 * Production leadership over the deterministic world: any number of PAGES of one browser, each with its own registry, identity, session
 * view, data runtime and leader, sharing the double of IndexedDB, the fake Web Locks (through the REAL `createWebLocksPort`), one
 * scripted server that records which page asked what, and fake time. A page can be destroyed (the platform releases its locks).
 */
export const A: AccountId = "11111111-1111-4111-8111-111111111111";
export const B: AccountId = "22222222-2222-4222-8222-222222222222";

export interface ServerRequest {
  page: string;
  klass: "ordinary" | "recovery";
  method: string;
  path: string;
  cursor: string | null;
  account: AccountId;
  epoch: number;
  key: string | null;
}
export type Answer = Response | Promise<Response> | Error;

export interface LeaderPage {
  id: string;
  env: PageEnv;
  runtime: DataRuntime;
  leader: SyncLeader;
  attachments: LeaderAttachment[];
  view: { get(): SessionView; set(next: SessionView): void };
  identity: {
    get(): Identity | null;
    move(account: AccountId | null, epoch?: number): void;
  };
  begins: Array<RecoveryBegin>;
}

export interface LeaderWorld {
  env: DataTestWorld;
  /** Posts a message on `atlas-sync` as a page that is not one of the leader pages (another facade, another tab). */
  hint(message: SyncMessage): void;
  /** Answers each request; the default answers `/sync` with an empty delta page that keeps the cursor. */
  server: (request: ServerRequest) => Answer;
  requests: ServerRequest[];
  pages: Map<string, LeaderPage>;
  page(id: string, account?: AccountId | null): LeaderPage;
  settle(): Promise<void>;
  advance(ms: number): Promise<void>;
  /** The page goes away: its leader is gone and the platform releases its locks. */
  destroy(id: string): void;
  sync(account?: AccountId): SyncStateRow | undefined;
  json(spec: PageSpec): Response;
  status(code: number, body?: unknown): Response;
  leaderName: string;
}

export function leaderWorld(): LeaderWorld {
  const env = new DataTestWorld();
  // `atlas-sync` between pages: a message reaches every OTHER page's subscribers (never the sender's own), as BroadcastChannel does.
  const bus = new Map<string, Set<(message: SyncMessage) => void>>();
  const channelFor = (page: string) => ({
    post(message: SyncMessage) {
      for (const [other, listeners] of bus)
        if (other !== page)
          for (const listener of [...listeners]) listener(message);
    },
    subscribe(listener: (message: SyncMessage) => void) {
      let set = bus.get(page);
      if (!set) {
        set = new Set();
        bus.set(page, set);
      }
      set.add(listener);
      return () => {
        set?.delete(listener);
      };
    },
  });
  env.idb.autoDrive = true;
  const world = env.world;
  const pages = new Map<string, LeaderPage>();
  const markerStorage = new FakeMarkerStorage();
  const out: LeaderWorld = {
    env,
    requests: [],
    pages,
    hint: (message) => channelFor("outside").post(message),
    leaderName: DATA_CONFIG.syncLeaderLock,
    server: (request) =>
      request.path === "/sync"
        ? out.json({
            phase: "delta",
            hasMore: false,
            nextCursor: request.cursor ?? "delta-0",
            batches: [],
          })
        : out.status(404),
    page(id, account = A) {
      const existing = pages.get(id);
      if (existing) return existing;
      const pageEnv = env.page(id);
      pageEnv.identity.account = account;
      const listeners = new Set<() => void>();
      let view: SessionView =
        account === null
          ? { kind: "signed_out", state: null }
          : { kind: "displaying", account_id: account, epoch: 1 };
      const notify = (): void => {
        for (const listener of [...listeners]) listener();
      };
      const identity = {
        get: (): Identity | null =>
          pageEnv.identity.account === null
            ? null
            : {
                account_id: pageEnv.identity.account,
                epoch: pageEnv.identity.epoch,
                session_id: "s",
              },
        subscribe: (listener: () => void) => {
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
          };
        },
        move(next: AccountId | null, epoch = 1) {
          pageEnv.identity.account = next;
          pageEnv.identity.epoch = epoch;
          view =
            next === null
              ? { kind: "signed_out", state: null }
              : { kind: "displaying", account_id: next, epoch };
          notify();
        },
      };
      const runtime = new env.modules.accountService.DataRuntime({
        identity,
        persistence: { hold: async () => unrevokedHold() },
        registry: pageEnv.registry,
        open: (a, o) => pageEnv.open(a, o),
      });
      const cancelled = new Set<number>();
      let timerSeq = 0;
      const compat = {
        get: (): ApiCompatibility => ({
          status: "supported",
          version: "0.27.0",
        }),
        subscribe: () => () => undefined,
      };
      const begins: RecoveryBegin[] = [];
      const attachments: LeaderAttachment[] = [];
      const leader = createSyncLeader({
        election: createLeaderElection({
          locks: pageEnv.locks,
          name: DATA_CONFIG.syncLeaderLock,
        }),
        runtime,
        tabId: pageEnv.registry.tabId,
        identity,
        view: {
          get: () => view,
          subscribe: (listener: () => void) => {
            listeners.add(listener);
            return () => {
              listeners.delete(listener);
            };
          },
        },
        compat,
        fetchFor: (klass, account_, epoch) => async (request) => {
          const url = new URL(request.url);
          const record: ServerRequest = {
            page: id,
            klass,
            method: request.method,
            path: url.pathname.replace("/api/experimental/v1", ""),
            cursor: url.searchParams.get("cursor"),
            account: account_,
            epoch,
            key: request.headers.get("idempotency-key"),
          };
          out.requests.push(record);
          const answer = out.server(record);
          if (answer instanceof Error) throw answer;
          return answer;
        },
        recovery: {
          begin: async (a) =>
            begins.shift() ?? {
              kind: "eligible",
              handle: { account: a, epoch: pageEnv.identity.epoch, s: 1 },
            },
          finish: async () => "cleared",
          report: () => undefined,
        },
        // Nothing in this world refuses a request before it is sent: the admission probe always finds it open (R3's waits are the
        // recovery world's and the native cases').
        admission: async () => ({ revision: "open", blocked: false }),
        operationPending: (a) => pageEnv.pending.has(a),
        apiUrl: (path) =>
          new URL(`http://localhost/api/experimental/v1${path}`),
        online: () => true,
        subscribe: (listener) => {
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
          };
        },
        onOnline: () => () => undefined,
        clock: {
          now: () => EPOCH_BASE + world.time,
          iso: () => new Date(EPOCH_BASE + world.time).toISOString(),
          random: () => 0.5,
          setTimeout: (fn, ms) => {
            timerSeq += 1;
            const timer = timerSeq;
            world.schedule(
              "timer",
              id,
              { timer },
              () => {
                if (!cancelled.has(timer)) fn();
              },
              ms,
            );
            return timer;
          },
          clearTimeout: (handle) => {
            cancelled.add(handle as number);
          },
        },
        yield: () =>
          new Promise<void>((resolve) =>
            world.schedule("misc", id, { what: "yield" }, resolve),
          ),
        decode: {
          validators: createValueValidators(),
          derivers: createKeyDerivers(),
        },
        quota: createQuotaGuard({
          storage: { estimate: async () => ({ usage: 0, quota: 1 << 30 }) },
          now: () => EPOCH_BASE + world.time,
        }),
        signals: { hasStorageEstimate: true },
        channel: channelFor(id),
        markers: pageMarkers(markerStorage.page(id)),
        conflicts: createConflictHandlerRegistry(),
        ids: { uuid: () => crypto.randomUUID() },
        publish: (attachment) => attachments.push(attachment),
        elapsed: () => world.time,
      });
      const page: LeaderPage = {
        id,
        env: pageEnv,
        runtime,
        leader,
        attachments,
        view: {
          get: () => view,
          set(next) {
            view = next;
            notify();
          },
        },
        identity,
        begins,
      };
      pages.set(id, page);
      leader.start();
      return page;
    },
    async settle() {
      for (let i = 0; i < 80; i += 1) await world.runUntilIdle();
    },
    async advance(ms) {
      await world.advance(ms);
      await out.settle();
    },
    destroy(id) {
      const page = pages.get(id);
      if (!page) return;
      // The page's code stops with it: its timers and engines do nothing more, and the platform releases its locks.
      page.leader.dispose();
      page.runtime.dispose();
      env.lockManager.destroyPage(id);
      pages.delete(id);
    },
    sync: (account = A) =>
      env.idb.peek(accountDatabaseName(account), "sync_state", "singleton") as
        | SyncStateRow
        | undefined,
    json: (spec) =>
      new Response(pageJson(spec), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    status: (code, body = {}) =>
      new Response(JSON.stringify(body), {
        status: code,
        headers: { "content-type": "application/json" },
      }),
  };
  return out;
}
