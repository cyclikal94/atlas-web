import { RouterProvider } from "@tanstack/react-router";
import { act, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { ProtectedProviders } from "../../src/app/providers";
import { createAppRouter } from "../../src/app/router";
import { ShellEnvProvider } from "../../src/app/shell/env";
import {
  type CacheRow,
  createCommandRegistry,
  createDataEnv,
  type DataEnv,
  DataEnvProvider,
  DataProvider,
  type DraftWithCommand,
  useDataEnv,
} from "../../src/data";
import { createQuotaGuard } from "../../src/data/engine/quota-guard";
import type { SyncChannel } from "../../src/data/engine/sync-channel";
import { createPageDataHost } from "../../src/data/leader/page-host";
import { snapshotPageOperation } from "../../src/data/model/recovery";
import { accountDatabaseName } from "../../src/data/model/schema";
import type { SyncStateRow } from "../../src/data/model/types";
import {
  acquireOwnership,
  activateSnapshot,
  captureRecoveryRequest,
} from "../../src/data/plans/recovery-writers";
import { invalidateRecoveryPosition } from "../../src/data/plans/sync-writers";
import { scanSyncPage } from "../../src/data/scan/scan";
import {
  createKeyDerivers,
  createValueValidators,
} from "../../src/data/scan/validate";
import { w as writes } from "../../src/data/store/port";
import { forgetImportSessions } from "../../src/features/calendars/import-kept";
import { forgetIdentityMemories } from "../../src/features/calendars/memory";
import { registerCalendarCommands } from "../../src/features/calendars/register";
import { documentRouteChanges } from "../../src/lib/route-changes";
import type { SyncStatusModel } from "../../src/lib/sync-chip";
import {
  type ApiCompatibility,
  type Identity,
  SessionProvider,
  type Store,
} from "../../src/session";
import { sessionDouble } from "../helpers/session-double";
import { DataTestWorld } from "./data/env";
import { bytesOf, pageJson } from "./data/sync-pages";

/**
 * The calendar screens' test world (WEB-13a): the PRODUCTION controller (`createDataEnv`), plans and outbox facade over the double of
 * IndexedDB, with the calendar commands registered; the session double with a programmable typed client that records every request;
 * and the application's router, so the screen is reached at `/settings/calendars` exactly as in the app. FIXTURE evidence.
 */
export const ACCOUNT = "11111111-1111-4111-8111-111111111111";
export const DB = accountDatabaseName(ACCOUNT);

export class Cell<T> implements Store<T> {
  private listeners = new Set<() => void>();
  constructor(private value: T) {}
  get() {
    return this.value;
  }
  set(next: T) {
    this.value = next;
    for (const l of [...this.listeners]) l();
  }
  subscribe(l: () => void) {
    this.listeners.add(l);
    return () => {
      this.listeners.delete(l);
    };
  }
}

export interface WireCall {
  method: "GET" | "POST";
  path: string;
  key?: string;
  /** The JSON body as the client was asked to send it. */
  body?: unknown;
  id?: string;
  query?: unknown;
}

export type WireReply =
  | { status: number; json?: unknown; contentType?: string }
  | { throws: unknown }
  /** Revision 2: the answer is HELD until the test resolves the promise (a request already sent whose answer arrives later). */
  | { wait: Promise<WireReply> };

export const atlasBody = (
  code: string,
  extra: Record<string, unknown> = {},
) => ({
  code,
  message: "m",
  request_id: "22222222-2222-4222-8222-222222222222",
  details: [],
  ...extra,
});

export interface CalendarWorld {
  world: DataTestWorld;
  /** The controller mounted now (revision 7: with `production`, every mount builds a new one). */
  env: DataEnv;
  /** Revision 7 (R7): every controller a mount used, in order (one, unless `production`). */
  controllers(): DataEnv[];
  online: Cell<boolean>;
  compat: Cell<ApiCompatibility>;
  identity: Cell<Identity | null>;
  calls: WireCall[];
  /** Replies by path, consumed in order; a path with none answers its default. */
  replies: Map<string, WireReply[]>;
  settle(): Promise<void>;
  rows<K extends "cache" | "drafts" | "draft_commands" | "resource_versions">(
    store: K,
  ): object[];
  snapshot(): Record<string, object[]> | null;
  /**
   * Revision 5 (R11): the protected tree unmounted and mounted again at the SAME address under the same identity, as the session's
   * re-check of a `403` does (a new router, a new screen; the per-identity memory and the document stay). Settles after.
   */
  remount(): Promise<void>;
  /**
   * Revision 6 (R13): the two halves of `remount`, so that the document can move while NO tree is mounted (the session's protective
   * closure). `detach` unmounts the tree; `attach` mounts a new one (a new router) wherever the document is now. Both settle after.
   */
  detach(): Promise<void>;
  attach(): Promise<void>;
  /** Revision 5: an in-app navigation (the router's own), then settles. */
  navigate(to: string): Promise<void>;
  /**
   * Revision 6 (R13): the browser's own history traversal (`history.go`: Back is -1, Forward 1), mounted or not; resolves after its
   * `popstate`, then settles.
   */
  traverse(delta: number): Promise<void>;
  /** Revision 6 (R13): an address written straight into the document's history, by no router (`pushState` or `replaceState`). */
  write(how: "push" | "replace", to: string): Promise<void>;
  /** Revision 5: the current address of the mounted tree's router (revision 6: the document's, when no tree is mounted). */
  path(): string;
  /**
   * Commits a change to the account database through the production store, as a sync or a recovery would (one transaction), then
   * settles: `put` rows into `cache` or `sync_state`, or `remove` cache rows by id. Live queries observe it as they observe any write.
   */
  commit(change: {
    put?: { store: "cache" | "sync_state"; rows: object[] };
    remove?: string[];
    /**
     * Revision 2: rows of `resource_versions` written in the SAME transaction (a publication sets the version the outbox assumes), and
     * drafts retired with their bodies in it (`local_id`s): what a delta page that publishes a receipted create does at once (W1).
     */
    versions?: object[];
    retire?: string[];
  }): Promise<void>;
  /**
   * Revision 7 (R7; design assessment C4): the PRODUCTION ordinary-phase invalidation (W18, as a `410 resync_required` makes it): the cache
   * `invalid`, its cursor dropped, its generation moved on. Then settles. Needs an open database (the page's runtime, mounted or not).
   */
  invalidate(): Promise<void>;
  /**
   * Revision 7 (R7): the PRODUCTION recovery of an invalid cache, in its own writers: the ownership (W20, a restart), the capture (W21), and
   * one final snapshot page activated with `rows` (W23: the cache replaced and `valid`, the generation kept). Then settles.
   */
  recover(rows: CacheRow[]): Promise<void>;
  /** Revision 7: the durable `sync_state` singleton. */
  sync(): SyncStateRow;
}

export function sourceRow(over: Partial<CacheRow> = {}): CacheRow {
  return {
    id: over.id ?? "00000000-0000-4000-8000-0000000000a1",
    kind: "calendar_source",
    parent_id: null,
    label: "Family calendar",
    value: {
      health: "healthy",
      last_success: 1_790_000_000,
      coverage_start: null,
      coverage_end: null,
      timezone: "Europe/Vienna",
    },
    version: 3,
    can_edit: true,
    archived: false,
    kind_date: null,
    ...over,
  };
}

export async function calendarWorld(
  options: {
    database?: boolean;
    online?: boolean;
    cache?: CacheRow[];
    drafts?: DraftWithCommand[];
    route?: string;
    calendarLinks?: boolean;
    /** Revision 4: answers queued BEFORE the screen mounts (its first live read is made as it opens). */
    replies?: ReadonlyArray<readonly [string, WireReply[]]>;
    compat?: ApiCompatibility;
    /**
     * WEB-13b revision 6 (R7): the shell's sync control navigates as production's protected tree does (`/sync`, `tab` queue or
     * conflicts), instead of doing nothing.
     */
    productionSync?: boolean;
    /** The shell's sync status (default: synced, nothing pending): conflicts send the sync control to the conflicts tab. */
    syncModel?: SyncStatusModel;
    /**
     * Revision 7 (R7; design assessment C4): the PRODUCTION provider (`DataProvider`) over the page's runtime (`PageDataHost.runtime`, as
     * the page's leader composes it): every mount of the tree builds a NEW controller and its unmount disposes it, as the protected tree's
     * remount does in production. Without it, every mount shares ONE controller (`DataEnvProvider env={env}`), which a remount keeps alive.
     */
    production?: boolean;
    /**
     * Revision 7 (R7): the cache as the first snapshot left it (`valid`, in the delta phase at a cursor), as every cache that holds rows is
     * in production. Without it the world's cache rows sit in a cache whose status is still `empty`, which production never shows rows of.
     */
    validCache?: boolean;
  } = {},
): Promise<CalendarWorld> {
  // The per-identity memory outlives a mount by design (`memory.ts`); each test starts without one.
  forgetIdentityMemories();
  // Revision 6 (R7): nor a kept import session (page memory that outlives a mount by design, `import-kept.ts`).
  forgetImportSessions();
  const world = new DataTestWorld();
  world.idb.autoDrive = true;
  const page = world.page("A");
  page.identity.account = ACCOUNT;
  if (options.database !== false) {
    const created = await page.open(ACCOUNT, { create: true });
    if (created.kind !== "opened") throw new Error("setup");
    if (options.cache) world.idb.seed(DB, "cache", options.cache);
    if (options.drafts) world.idb.seed(DB, "drafts", options.drafts);
    if (options.validCache)
      world.idb.seed(DB, "sync_state", [
        {
          ...(world.idb.peek(DB, "sync_state", "singleton") as SyncStateRow),
          cache_status: "valid",
          phase: "delta",
          cursor: "delta-0",
        },
      ]);
  }
  const identity = new Cell<Identity | null>({
    account_id: ACCOUNT,
    epoch: 1,
    session_id: "s",
  });
  const online = new Cell(options.online ?? true);
  const compat = new Cell<ApiCompatibility>(
    options.compat ?? {
      status: "supported",
      version: "0.27.0",
    },
  );
  const runtime = new world.modules.accountService.DataRuntime({
    identity,
    persistence: world.modules.accountService.unorderedPersistence,
    registry: page.registry,
    open: (a, o) => page.open(a, o),
  });
  const channel: SyncChannel = {
    post: () => undefined,
    subscribe: () => () => undefined,
  };
  const commands = createCommandRegistry();
  registerCalendarCommands(commands);
  const shared = createDataEnv({
    identity,
    loadRuntime: async () => runtime,
    online,
    quota: createQuotaGuard({ storage: undefined, now: () => 0 }),
    ids: { uuid: () => crypto.randomUUID() },
    clock: { iso: () => new Date().toISOString(), now: () => 0 },
    fence: () => ({ hasPendingOperation: false, sessionStarted: true }),
    readMe: async () => ({ kind: "closed" }),
    currentDeviceId: async () => ({ kind: "closed" }),
    onOnline: () => () => undefined,
    channel,
    commands,
  });
  let env = shared;
  const controllers: DataEnv[] = options.production ? [] : [shared];
  // The page's runtime, as a production leader composes it: the provider uses it and never disposes it (`createProductionEnv`).
  const host = createPageDataHost();
  if (options.production) {
    shared.dispose();
    host.setRuntime({ runtime, channel });
  }
  /** Records the controller the production provider built for this mount. */
  function Mounted() {
    const mounted = useDataEnv();
    if (controllers.at(-1) !== mounted) controllers.push(mounted);
    env = mounted;
    return null;
  }

  const calls: WireCall[] = [];
  const replies = new Map<string, WireReply[]>(
    (options.replies ?? []).map(([path, queue]) => [path, [...queue]]),
  );
  const reply = async (call: WireCall) => {
    calls.push(call);
    const queue = replies.get(call.path);
    let next: WireReply =
      queue?.shift() ??
      (call.path === "/notification-capabilities"
        ? {
            status: 200,
            json: { calendar_links: options.calendarLinks ?? true },
          }
        : call.path === "/calendar-sources"
          ? { status: 200, json: { items: [], next_after: null } }
          : { status: 200, json: { revision: 1 } });
    while ("wait" in next) next = await next.wait;
    if ("throws" in next) throw next.throws;
    const response = new Response(null, {
      status: next.status,
      headers: { "content-type": next.contentType ?? "application/json" },
    });
    return next.status < 300
      ? { data: next.json, response }
      : { error: next.json, response };
  };
  const client = {
    POST: (
      path: string,
      init: {
        params: { header: Record<string, string>; path?: { id: string } };
        body?: unknown;
      },
    ) =>
      reply({
        method: "POST",
        path,
        key: init.params.header["Idempotency-Key"],
        body: init.body,
        id: init.params.path?.id,
      }),
    GET: (path: string, init?: { params?: { query?: unknown } }) =>
      reply({ method: "GET", path, query: init?.params?.query }),
  };
  const session = sessionDouble(
    {},
    {
      identity,
      compat,
      api: { client: () => client, fetchFor: () => fetch } as never,
    },
  );
  // Revision 6 (R13): the document's real history, as production: the route record is installed before the first router (as
  // `createProtectedTree` does), every router is a browser-history router over this document, and the address starts where asked.
  documentRouteChanges();
  window.history.replaceState(null, "", options.route ?? "/settings/calendars");
  let router = createAppRouter();
  const data = (children: ReactNode) =>
    options.production ? (
      <DataProvider session={session} host={host} commands={commands}>
        <Mounted />
        {children}
      </DataProvider>
    ) : (
      <DataEnvProvider env={shared}>{children}</DataEnvProvider>
    );
  const tree = () => (
    <SessionProvider session={session}>
      <ProtectedProviders>
        {data(
          <ShellEnvProvider
            value={{
              syncModel: options.syncModel ?? {
                phase: "synced",
                pendingCount: 0,
                conflictCount: 0,
              },
              onOpenSync: options.productionSync
                ? (destination) => {
                    void router.navigate({
                      to: "/sync",
                      search: {
                        tab:
                          destination === "conflicts" ? "conflicts" : "queue",
                      },
                    });
                  }
                : () => {},
            }}
          >
            <RouterProvider router={router} />
          </ShellEnvProvider>,
        )}
      </ProtectedProviders>
    </SessionProvider>
  );
  let mounted: ReturnType<typeof render> | null = render(tree());
  const settle = async () => {
    await act(async () => {
      for (let i = 0; i < 20; i += 1) {
        await world.settle();
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    });
  };
  await screen.findByRole("heading", { level: 1, name: "Calendar sources" });
  await settle();
  const service = () => {
    const open = runtime.serviceFor(ACCOUNT);
    if (open === null || !open.live) throw new Error("no account database");
    return open;
  };
  const sync = () =>
    world.idb.peek(DB, "sync_state", "singleton") as SyncStateRow;
  return {
    world,
    get env() {
      return env;
    },
    controllers: () => [...controllers],
    sync,
    async invalidate() {
      const s = sync();
      const open = service();
      await act(async () => {
        const out = await open.commit(invalidateRecoveryPosition, {
          captured: open.capture(identity.get()?.epoch ?? 1, {
            requestSeq: s.request_seq,
            ownershipToken: s.owner?.ownership_token ?? null,
            recoveryGeneration: s.recovery_generation,
            expectedPosition: s.cursor,
          }),
          reason: "resync_required",
        });
        if (out.kind !== "applied") throw new Error(`W18: ${out.kind}`);
      });
      await settle();
    },
    async recover(rows) {
      const open = service();
      const token = crypto.randomUUID();
      await act(async () => {
        const owned = await open.store.run(acquireOwnership, {
          incarnationId: open.incarnationId,
          tabId: "tab-a",
          token,
          now: Date.now(),
        });
        if (owned.kind !== "owned") throw new Error(`W20: ${owned.kind}`);
        const asked = await open.store.run(captureRecoveryRequest, {
          incarnationId: open.incarnationId,
          token,
          path: "snapshot",
          now: Date.now(),
          signals: { hasStorageEstimate: true },
        });
        if (asked.kind !== "captured") throw new Error(`W21: ${asked.kind}`);
        const s = sync();
        const bytes = bytesOf(
          pageJson({
            phase: "snapshot",
            hasMore: false,
            nextCursor: "delta-recovered",
            batches: [
              {
                revision: 90,
                changes: rows.map(({ kind_date: _k, ...resource }) => ({
                  kind: "upsert" as const,
                  resource: resource as never,
                })),
              },
            ],
          }),
        );
        const scan = scanSyncPage(bytes);
        if (!scan.ok) throw new Error(`page: ${scan.reason}`);
        const captured = open.capture(identity.get()?.epoch ?? 1, {
          requestSeq: s.request_seq,
          ownershipToken: s.owner?.ownership_token ?? null,
          recoveryGeneration: s.recovery_generation,
          expectedPosition: s.staging_position,
        });
        const operation = snapshotPageOperation(captured.expectedPosition);
        const out = await open.commit(activateSnapshot, {
          captured,
          bytes,
          scan,
          decode: {
            validators: createValueValidators(),
            derivers: createKeyDerivers(),
          },
          operation,
          now: new Date().toISOString(),
          mode: "ordinary",
          activateOperation: operation,
        });
        if (out.kind !== "applied" || out.value.kind !== "activated")
          throw new Error(`W23: ${JSON.stringify(out)}`);
      });
      await settle();
    },
    online,
    compat,
    identity,
    calls,
    replies,
    settle,
    rows: (store) => world.idb.snapshot(DB)?.[store] ?? [],
    snapshot: () => world.idb.snapshot(DB),
    async remount() {
      act(() => mounted?.unmount());
      router = createAppRouter();
      mounted = render(tree());
      await settle();
    },
    async detach() {
      act(() => mounted?.unmount());
      mounted = null;
      await settle();
    },
    async attach() {
      if (mounted !== null) throw new Error("a tree is mounted");
      router = createAppRouter();
      mounted = render(tree());
      await settle();
    },
    async navigate(to) {
      await act(async () => {
        await router.navigate({ to: to as never });
      });
      await settle();
    },
    async traverse(delta) {
      const popped = new Promise<void>((resolve) =>
        window.addEventListener("popstate", () => resolve(), { once: true }),
      );
      await act(async () => {
        window.history.go(delta);
        await popped;
      });
      await settle();
    },
    async write(how, to) {
      act(() => {
        if (how === "push") window.history.pushState(null, "", to);
        else window.history.replaceState(null, "", to);
      });
      await settle();
    },
    path: () =>
      mounted === null
        ? window.location.pathname
        : router.history.location.pathname,
    async commit(change) {
      const service = env.service();
      if (service === null) throw new Error("no account database");
      const scope = [
        ...(change.put ? [change.put.store] : []),
        ...(change.remove ? (["cache"] as const) : []),
        ...(change.versions ? (["resource_versions"] as const) : []),
        ...(change.retire ? (["drafts", "draft_commands"] as const) : []),
      ];
      await act(async () => {
        await service.store.run(
          {
            name: "test.calendars.commit",
            scope: [...new Set(scope)],
            mode: "readwrite",
            durability: "strict",
            read: async () => null,
            decide: () => ({
              writes: [
                ...(change.put?.rows ?? []).map((row) =>
                  writes.put(change.put?.store ?? "cache", row as never),
                ),
                ...(change.remove ?? []).map((id) =>
                  writes.delete("cache", id),
                ),
                ...(change.versions ?? []).map((row) =>
                  writes.put("resource_versions", row as never),
                ),
                ...(change.retire ?? []).flatMap((id) => [
                  writes.delete("drafts", id),
                  writes.delete("draft_commands", id),
                ]),
              ],
              result: null,
            }),
          },
          {},
        );
      });
      await settle();
    },
  };
}
