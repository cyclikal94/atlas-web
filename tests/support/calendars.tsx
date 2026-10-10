import { RouterProvider } from "@tanstack/react-router";
import { act, render, screen } from "@testing-library/react";
import { ProtectedProviders } from "../../src/app/providers";
import { createAppRouter } from "../../src/app/router";
import { ShellEnvProvider } from "../../src/app/shell/env";
import {
  type CacheRow,
  createCommandRegistry,
  createDataEnv,
  type DataEnv,
  DataEnvProvider,
  type DraftWithCommand,
} from "../../src/data";
import { createQuotaGuard } from "../../src/data/engine/quota-guard";
import type { SyncChannel } from "../../src/data/engine/sync-channel";
import { accountDatabaseName } from "../../src/data/model/schema";
import { w as writes } from "../../src/data/store/port";
import { forgetIdentityMemories } from "../../src/features/calendars/memory";
import { registerCalendarCommands } from "../../src/features/calendars/register";
import {
  type ApiCompatibility,
  type Identity,
  SessionProvider,
  type Store,
} from "../../src/session";
import { sessionDouble } from "../helpers/session-double";
import { DataTestWorld } from "./data/env";

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
  | { throws: unknown };

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
  env: DataEnv;
  online: Cell<boolean>;
  compat: Cell<ApiCompatibility>;
  identity: Cell<Identity | null>;
  calls: WireCall[];
  /** Replies by path, consumed in order; a path with none answers its default. */
  replies: Map<string, WireReply[]>;
  settle(): Promise<void>;
  rows<K extends "cache" | "drafts" | "draft_commands">(store: K): object[];
  snapshot(): Record<string, object[]> | null;
  /**
   * Commits a change to the account database through the production store, as a sync or a recovery would (one transaction), then
   * settles: `put` rows into `cache` or `sync_state`, or `remove` cache rows by id. Live queries observe it as they observe any write.
   */
  commit(change: {
    put?: { store: "cache" | "sync_state"; rows: object[] };
    remove?: string[];
  }): Promise<void>;
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
  } = {},
): Promise<CalendarWorld> {
  // The per-identity memory outlives a mount by design (`memory.ts`); each test starts without one.
  forgetIdentityMemories();
  const world = new DataTestWorld();
  world.idb.autoDrive = true;
  const page = world.page("A");
  page.identity.account = ACCOUNT;
  if (options.database !== false) {
    const created = await page.open(ACCOUNT, { create: true });
    if (created.kind !== "opened") throw new Error("setup");
    if (options.cache) world.idb.seed(DB, "cache", options.cache);
    if (options.drafts) world.idb.seed(DB, "drafts", options.drafts);
  }
  const identity = new Cell<Identity | null>({
    account_id: ACCOUNT,
    epoch: 1,
    session_id: "s",
  });
  const online = new Cell(options.online ?? true);
  const compat = new Cell<ApiCompatibility>({
    status: "supported",
    version: "0.27.0",
  });
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
  const env = createDataEnv({
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

  const calls: WireCall[] = [];
  const replies = new Map<string, WireReply[]>();
  const reply = async (call: WireCall) => {
    calls.push(call);
    const queue = replies.get(call.path);
    const next: WireReply =
      queue?.shift() ??
      (call.path === "/notification-capabilities"
        ? {
            status: 200,
            json: { calendar_links: options.calendarLinks ?? true },
          }
        : call.path === "/calendar-sources"
          ? { status: 200, json: { items: [], next_after: null } }
          : { status: 200, json: { revision: 1 } });
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
  const router = createAppRouter({
    initialPath: options.route ?? "/settings/calendars",
  });
  render(
    <SessionProvider session={session}>
      <ProtectedProviders>
        <DataEnvProvider env={env}>
          <ShellEnvProvider
            value={{
              syncModel: { phase: "synced", pendingCount: 0, conflictCount: 0 },
              onOpenSync: () => {},
            }}
          >
            <RouterProvider router={router} />
          </ShellEnvProvider>
        </DataEnvProvider>
      </ProtectedProviders>
    </SessionProvider>,
  );
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
  return {
    world,
    env,
    online,
    compat,
    identity,
    calls,
    replies,
    settle,
    rows: (store) => world.idb.snapshot(DB)?.[store] ?? [],
    snapshot: () => world.idb.snapshot(DB),
    async commit(change) {
      const service = env.service();
      if (service === null) throw new Error("no account database");
      const scope = [
        ...(change.put ? [change.put.store] : []),
        ...(change.remove ? (["cache"] as const) : []),
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
