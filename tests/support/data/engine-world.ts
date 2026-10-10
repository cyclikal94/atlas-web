import {
  createQuotaGuard,
  type QuotaGuard,
} from "../../../src/data/engine/quota-guard";
import {
  defaultRecoverySeam,
  type RecoverySeam,
} from "../../../src/data/engine/recovery-seam";
import type {
  SyncChannel,
  SyncMessage,
} from "../../../src/data/engine/sync-channel";
import {
  createSyncEngine,
  type EngineDeps,
  type EngineState,
  type SyncEngine,
  type SyncOwnership,
} from "../../../src/data/engine/sync-engine";
import type { WriteFailureMarkers } from "../../../src/data/engine/write-failure-marker";
import type { DeviceSignals } from "../../../src/data/model/sizing";
import {
  createKeyDerivers,
  createValueValidators,
} from "../../../src/data/scan/validate";
import type { StampedRequestError } from "../../../src/session";
import { EPOCH_BASE } from "../session/env";
import { FakeMarkerStorage, pageMarkers } from "./marker-storage";
import { type PageWorld, pageWorld } from "./page-world";
import { bytesOf, type PageSpec, pageJson } from "./sync-pages";

/**
 * The engine's world: the page world (production plans over the double of IndexedDB), a scriptable `/sync` server, fake-world
 * timers for the engine's schedule, and every piece of the page's eligibility under test control.
 */
export type Scripted =
  | Response
  | Error
  | StampedRequestError
  | (() => Response | Error | Promise<Response | Error>);

export interface EngineWorld extends PageWorld {
  engine: SyncEngine;
  /** Every `GET /sync` the engine issued, in order. */
  requests: URL[];
  /** What the server answers next, in order; when empty, an empty page that keeps the cursor moving. */
  script: Scripted[];
  posted: SyncMessage[];
  yields: number;
  online: boolean;
  signals: DeviceSignals;
  recovery: RecoverySeam;
  quota: QuotaGuard;
  freeBytes: number | null;
  /** The account's write-failure markers over a `localStorage` double that outlives a restart of the engine. */
  markers: WriteFailureMarkers;
  markerStorage: FakeMarkerStorage;
  ownership: { token: string | null; abort(): void; value: SyncOwnership };
  /** The world's timers (fake time), for the controller's paced re-read of the sync facts. */
  timers: {
    setTimeout(fn: () => void, ms: number): unknown;
    clearTimeout(handle: unknown): void;
  };
  /** Fires the engine's eligibility subscription (the session view changed, `online`, visibility). */
  fire(): void;
  /** The browser comes back online: the `online` flag turns true, the `online` event fires, and every other listener wakes. */
  goOnline(): void;
  state(): EngineState;
  /**
   * A SECOND engine, of ANOTHER PAGE, over the same database, identity, quota, scripted server and fake time (R51, revision 31): its own
   * markers over the world's `localStorage` as `name` sees it, so that what it records reaches the first page as a `storage` event and
   * what it reads is what that page wrote. It is built, not started: `start` it with an ownership of its own.
   */
  fork(name: string): SyncEngine;
  /** Runs the world until nothing more is due now (timers due at the current time included). */
  settle(): Promise<void>;
  /** Advances fake time, delivering everything that falls due, and settles. */
  advance(ms: number): Promise<void>;
  start(): void;
  /**
   * A page reload: the engine is stopped and a NEW one is built over the SAME database, markers and page. Every in-memory fact of
   * the old engine is lost (`stop()` then `start()` of one engine is an ownership change in a tab that stays alive, not a reload).
   * `markers`: the new page's own markers object (`"fresh"`: a new one over the same `localStorage` double, which has read and
   * established nothing, as a page that reloads has not; or one built another way, R47 revision 29).
   */
  reload(options?: { markers?: WriteFailureMarkers | "fresh" }): void;
  json(spec: PageSpec): Response;
  emptyPage(cursor?: string, hasMore?: boolean): Response;
  status(
    code: number,
    init?: { headers?: Record<string, string>; body?: unknown },
  ): Response;
}

export async function engineWorld(
  options: {
    signals?: DeviceSignals;
    config?: EngineDeps["config"];
    recovery?: RecoverySeam;
    ownerToken?: string | null;
    cursor?: string | null;
    /** The kind registries the page's decoding consults (default: empty ones). R44 registers a validator that fails. */
    decode?: EngineDeps["decode"];
  } = {},
): Promise<EngineWorld> {
  const base = await pageWorld({ cursor: options.cursor });
  const { env } = base;
  const world = env.world;
  const listeners = new Set<() => void>();
  const onlineListeners = new Set<() => void>();
  const cancelled = new Set<number>();
  let timerSeq = 0;
  const abort = new AbortController();
  const ownership = {
    token: options.ownerToken ?? null,
    abort: () => abort.abort(),
    value: {
      token: options.ownerToken ?? null,
      signal: abort.signal,
    } as SyncOwnership,
  };
  const markerStorage = new FakeMarkerStorage();
  const out = {
    ...base,
    markerStorage,
    markers: pageMarkers(markerStorage),
    requests: [] as URL[],
    script: [] as Scripted[],
    posted: [] as SyncMessage[],
    yields: 0,
    online: true,
    signals: options.signals ?? { hasStorageEstimate: true },
    recovery: options.recovery ?? defaultRecoverySeam,
    freeBytes: (500 * 1024 * 1024) as number | null,
    ownership,
  } as unknown as EngineWorld;

  const channel: SyncChannel = {
    post: (message) => {
      out.posted.push(message);
    },
    subscribe: () => () => undefined,
  };
  out.quota = createQuotaGuard({
    storage: {
      estimate: async () =>
        out.freeBytes === null ? {} : { usage: 0, quota: out.freeBytes },
    },
    now: () => EPOCH_BASE + world.time,
  });

  const fetchFor =
    () =>
    async (request: Request): Promise<Response> => {
      const url = new URL(request.url);
      out.requests.push(url);
      const next = out.script.shift();
      const resolved = typeof next === "function" ? await next() : next;
      if (resolved instanceof Error) throw resolved;
      if (resolved) return resolved;
      return out.emptyPage(`cursor-${out.requests.length}`);
    };

  const deps: EngineDeps = {
    service: () => base.service,
    identity: base.identity,
    fetchFor,
    apiUrl: (path) => new URL(`http://localhost/api/experimental/v1${path}`),
    online: () => out.online,
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
    yield: () => {
      out.yields += 1;
      return new Promise<void>((resolve) =>
        world.schedule("misc", "A", { what: "yield" }, resolve),
      );
    },
    decode: options.decode ?? {
      validators: createValueValidators(),
      derivers: createKeyDerivers(),
    },
    quota: out.quota,
    get signals() {
      return out.signals;
    },
    get recovery() {
      return out.recovery;
    },
    channel,
    markers: out.markers,
    ids: { uuid: () => crypto.randomUUID() },
    elapsed: () => world.time,
    config: options.config,
  };
  out.engine = createSyncEngine(deps);
  out.fork = (name) => {
    const page = markerStorage.page(name);
    return createSyncEngine({
      ...deps,
      markers: pageMarkers(page),
    });
  };

  out.timers = {
    setTimeout: (fn, ms) => deps.clock.setTimeout(fn, ms),
    clearTimeout: (handle) => deps.clock.clearTimeout(handle),
  };
  out.goOnline = () => {
    out.online = true;
    for (const listener of [...onlineListeners]) listener();
    for (const listener of [...listeners]) listener();
  };
  out.fire = () => {
    for (const listener of [...listeners]) listener();
  };
  out.state = () => out.engine.state.get();
  out.settle = async () => {
    for (let i = 0; i < 60; i += 1) await world.runUntilIdle();
    out.assertNoOrphanBodies();
  };
  out.advance = async (ms) => {
    await world.advance(ms);
    await out.settle();
  };
  out.start = () => out.engine.start(ownership.value);
  out.reload = (options) => {
    out.engine.stop();
    if (options?.markers !== undefined) {
      out.markers =
        options.markers === "fresh"
          ? pageMarkers(markerStorage)
          : options.markers;
      deps.markers = out.markers;
    }
    out.engine = createSyncEngine(deps);
  };
  out.json = (spec) =>
    new Response(pageJson(spec), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  out.emptyPage = (cursor = "cursor-x", hasMore = false) =>
    out.json({ phase: "delta", hasMore, nextCursor: cursor, batches: [] });
  out.status = (code, init = {}) =>
    new Response(init.body === undefined ? "{}" : JSON.stringify(init.body), {
      status: code,
      headers: { "content-type": "application/json", ...(init.headers ?? {}) },
    });
  void bytesOf;
  return out;
}
