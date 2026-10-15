import {
  createOutboxDispatcher,
  type DispatcherDeps,
  type OutboxDispatcher,
} from "../../../src/data/engine/outbox-dispatcher";
import {
  createQuotaGuard,
  type QuotaGuard,
} from "../../../src/data/engine/quota-guard";
import type {
  SyncChannel,
  SyncMessage,
} from "../../../src/data/engine/sync-channel";
import type { SyncOwnership } from "../../../src/data/engine/sync-engine";
import type { WriteFailureMarkers } from "../../../src/data/engine/write-failure-marker";
import type { DataConfig } from "../../../src/data/model/config";
import type {
  DraftRow,
  PendingEffectRow,
  ResourceVersionRow,
} from "../../../src/data/model/types";
import { createOutbox, type Outbox } from "../../../src/data/outbox/outbox";
import {
  type ConflictHandlerRegistry,
  createConflictHandlerRegistry,
} from "../../../src/data/outbox/registries";
import type {
  ApiCompatibility,
  StampedRequestError,
  Store,
} from "../../../src/session";
import { EPOCH_BASE } from "../session/env";
import { FakeMarkerStorage, pageMarkers } from "./marker-storage";
import { type PageWorld, pageWorld } from "./page-world";

/**
 * The outbox's world: the page world (production plans over the double of IndexedDB), the production dispatcher and facade, a
 * scriptable `/commands` server, fake-world timers, and every piece of the page's eligibility under test control. FIXTURE evidence:
 * nothing here talks to a backend.
 */
export type Answer =
  | Response
  | Error
  | StampedRequestError
  | (() => Response | Error | Promise<Response | Error>);

export interface SentRequest {
  path: string;
  method: string;
  key: string | null;
  contentType: string | null;
  body: string;
}

export interface OutboxWorld extends PageWorld {
  dispatcher: OutboxDispatcher;
  outbox: Outbox;
  quota: QuotaGuard;
  /** Every command request the dispatcher issued, in order. */
  sent: SentRequest[];
  /** What the server answers next, in order; when empty, `200 {revision}` with a rising revision. */
  script: Answer[];
  posted: SyncMessage[];
  receipts: number;
  online: boolean;
  compat: Store<ApiCompatibility> & { set(next: ApiCompatibility): void };
  conflicts: ConflictHandlerRegistry;
  fence: { hasPendingOperation: boolean; sessionStarted: boolean };
  freeBytes: number | null;
  /** The account's write-failure markers over a `localStorage` double that outlives a restart of the dispatcher. */
  markers: WriteFailureMarkers;
  markerStorage: FakeMarkerStorage;
  /** The world's timers (fake time): what the facade's paced look runs on, for another facade a test builds (R55, revision 36). */
  timers: {
    setTimeout(fn: () => void, ms: number): unknown;
    clearTimeout(handle: unknown): void;
  };
  ownership: { abort(): void; value: SyncOwnership };
  fire(): void;
  goOnline(): void;
  /** What the facade subscribed to on `atlas-sync`, and a way to deliver another tab's message to it. */
  channelListeners: Set<(message: SyncMessage) => void>;
  deliver(message: SyncMessage): void;
  /** A new dispatcher and facade in the SAME live page (a change of leader): the same database, markers and page memory of stops. */
  rebuild(): void;
  /**
   * A page reload: a new dispatcher and facade over the SAME database and `localStorage` (every in-memory fact is lost, the page's memory
   * of its stops with it). `markers`: the new page's own markers object, for a page whose storage was obtained another way (a getter
   * that threw, R47 revision 29); omitted, one over the world's `localStorage` double.
   */
  reload(options?: { markers?: WriteFailureMarkers }): void;
  settle(): Promise<void>;
  advance(ms: number): Promise<void>;
  start(): void;
  now(): number;
  drafts(): DraftRow[];
  effects(): PendingEffectRow[];
  versions(): ResourceVersionRow[];
  receipt(revision?: number): Response;
  error(
    status: number,
    code: string,
    headers?: Record<string, string>,
  ): Response;
}

export async function outboxWorld(
  options: {
    config?: Partial<DataConfig>;
    compat?: ApiCompatibility;
    cacheStatus?: "valid" | "invalid" | "empty";
  } = {},
): Promise<OutboxWorld> {
  const base = await pageWorld({ cacheStatus: options.cacheStatus });
  const world = base.env.world;
  const listeners = new Set<() => void>();
  const onlineListeners = new Set<() => void>();
  const cancelled = new Set<number>();
  let timerSeq = 0;
  let revision = 100;
  const abort = new AbortController();
  const markerStorage = new FakeMarkerStorage();
  const out = {
    ...base,
    markerStorage,
    markers: pageMarkers(markerStorage, { events: false }),
    sent: [] as SentRequest[],
    script: [] as Answer[],
    posted: [] as SyncMessage[],
    receipts: 0,
    online: true,
    fence: { hasPendingOperation: false, sessionStarted: true },
    freeBytes: (500 * 1024 * 1024) as number | null,
    ownership: {
      abort: () => abort.abort(),
      value: { token: null, signal: abort.signal } as SyncOwnership,
    },
  } as unknown as OutboxWorld;

  const compatListeners = new Set<() => void>();
  let compatValue: ApiCompatibility = options.compat ?? {
    status: "supported",
    version: "0.29.0",
  };
  out.compat = {
    get: () => compatValue,
    subscribe: (listener) => {
      compatListeners.add(listener);
      return () => compatListeners.delete(listener);
    },
    set(next) {
      compatValue = next;
      for (const listener of [...compatListeners]) listener();
    },
  };
  out.conflicts = createConflictHandlerRegistry();

  out.channelListeners = new Set();
  out.deliver = (message) => {
    for (const listener of [...out.channelListeners]) listener(message);
  };
  const channel: SyncChannel = {
    post: (message) => {
      out.posted.push(message);
    },
    subscribe: (listener) => {
      out.channelListeners.add(listener);
      return () => {
        out.channelListeners.delete(listener);
      };
    },
  };
  out.quota = createQuotaGuard({
    storage: {
      estimate: async () =>
        out.freeBytes === null ? {} : { usage: 0, quota: out.freeBytes },
    },
    now: () => EPOCH_BASE + world.time,
  });

  out.receipt = (r = ++revision) =>
    new Response(JSON.stringify({ revision: r }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  out.error = (status, code, headers = {}) =>
    new Response(
      JSON.stringify({
        code,
        message: "m",
        request_id: "11111111-1111-4111-8111-111111111111",
        details: [],
      }),
      { status, headers: { "content-type": "application/json", ...headers } },
    );

  const fetchFor =
    () =>
    async (request: Request): Promise<Response> => {
      const url = new URL(request.url);
      out.sent.push({
        path: url.pathname.replace("/api/experimental/v1", ""),
        method: request.method,
        key: request.headers.get("Idempotency-Key"),
        contentType: request.headers.get("Content-Type"),
        body: await request.text(),
      });
      const next = out.script.shift();
      const resolved = typeof next === "function" ? await next() : next;
      if (resolved instanceof Error) throw resolved;
      if (resolved) return resolved;
      return out.receipt();
    };

  const deps: DispatcherDeps = {
    service: () => base.service,
    identity: base.identity,
    fetchFor,
    apiUrl: (path) => new URL(`http://localhost/api/experimental/v1${path}`),
    online: () => out.online,
    compat: out.compat,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    onOnline: (listener) => {
      onlineListeners.add(listener);
      return () => {
        onlineListeners.delete(listener);
      };
    },
    clock: {
      now: () => EPOCH_BASE + world.time,
      iso: () => new Date(EPOCH_BASE + world.time).toISOString(),
      random: () => 0.5,
      setTimeout: (fn, ms) => {
        timerSeq += 1;
        const id = timerSeq;
        world.schedule(
          "timer",
          "A",
          { timer: id },
          () => {
            if (!cancelled.has(id)) fn();
          },
          ms,
        );
        return id;
      },
      clearTimeout: (handle) => {
        cancelled.add(handle as number);
      },
    },
    yield: () =>
      new Promise<void>((resolve) =>
        world.schedule("misc", "A", { what: "yield" }, resolve),
      ),
    conflicts: out.conflicts,
    receipt: () => {
      out.receipts += 1;
    },
    channel,
    markers: out.markers,
    config: options.config,
  };
  out.timers = {
    setTimeout: deps.clock.setTimeout,
    clearTimeout: deps.clock.clearTimeout,
  };
  const build = (): void => {
    out.dispatcher = createOutboxDispatcher(deps);
    out.outbox = createOutbox({
      service: base.service,
      quota: out.quota,
      ids: { uuid: () => crypto.randomUUID() },
      clock: {
        iso: () => new Date(EPOCH_BASE + world.time).toISOString(),
        now: () => EPOCH_BASE + world.time,
      },
      fence: () => out.fence,
      dispatcher: out.dispatcher,
      channel,
      markers: out.markers,
      config: options.config,
      // The world's timers: the facade's paced look after an unreadable record (R55, revision 36) runs on fake time.
      timers: out.timers,
    });
  };
  build();
  out.rebuild = () => {
    out.dispatcher.stop();
    // The facade that is replaced stops observing, as a page's owner lets it go (R55, revision 36).
    out.outbox.disposeObservation();
    onlineListeners.clear();
    listeners.clear();
    build();
  };
  out.reload = (options) => {
    out.dispatcher.stop();
    out.outbox.disposeObservation();
    onlineListeners.clear();
    listeners.clear();
    // A reload keeps `localStorage` and loses everything the page held in memory, and the markers' object holds the page's memory of the
    // stops no store could record (R46, revision 27): a new one over the same storage, as a new page would have.
    out.markers =
      options?.markers ?? pageMarkers(markerStorage, { events: false });
    deps.markers = out.markers;
    build();
  };

  out.now = () => EPOCH_BASE + world.time;
  out.fire = () => {
    for (const listener of [...listeners]) listener();
  };
  out.goOnline = () => {
    out.online = true;
    for (const listener of [...onlineListeners]) listener();
    for (const listener of [...listeners]) listener();
  };
  out.settle = async () => {
    for (let i = 0; i < 80; i += 1) await world.runUntilIdle();
    out.assertNoOrphanBodies();
  };
  out.advance = async (ms) => {
    await world.advance(ms);
    await out.settle();
  };
  out.start = () => out.dispatcher.start(out.ownership.value);
  out.drafts = () =>
    (out.rows("drafts") as DraftRow[]).sort(
      (a, b) => a.created_seq - b.created_seq,
    );
  out.effects = () => out.rows("pending_effects") as PendingEffectRow[];
  out.versions = () => out.rows("resource_versions") as ResourceVersionRow[];
  return out;
}
