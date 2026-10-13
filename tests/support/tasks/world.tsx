import { RouterProvider } from "@tanstack/react-router";
import { act, render } from "@testing-library/react";
import { ProtectedProviders } from "../../../src/app/providers";
import { createAppRouter } from "../../../src/app/router";
import { ShellEnvProvider } from "../../../src/app/shell/env";
import {
  type CacheRow,
  createDataEnv,
  type DataEnv,
  DataEnvProvider,
  type DraftRow,
} from "../../../src/data";
import { createQuotaGuard } from "../../../src/data/engine/quota-guard";
import type { SyncChannel } from "../../../src/data/engine/sync-channel";
import { accountDatabaseName } from "../../../src/data/model/schema";
import type { SyncStateRow } from "../../../src/data/model/types";
import { commitPage } from "../../../src/data/plans/commit-page";
import { scanSyncPage } from "../../../src/data/scan/scan";
import {
  createKeyDerivers,
  createValueValidators,
} from "../../../src/data/scan/validate";
import type { TasksApi, TasksResult } from "../../../src/features/tasks/api";
import {
  type TasksEnv,
  TasksEnvProvider,
} from "../../../src/features/tasks/env";
import type {
  OccurrenceData,
  OccurrencePage,
  ProgressState,
  TaskDefinition,
} from "../../../src/features/tasks/model/contract";
import {
  occurrenceId,
  progressId,
} from "../../../src/features/tasks/model/ids";
import {
  slotOn,
  todayIn,
  windows,
} from "../../../src/features/tasks/model/time";
import type { Identity, Store } from "../../../src/session";
import { DataTestWorld } from "../data/env";
import { cacheRow } from "../data/rows";
import { bytesOf, pageJson } from "../data/sync-pages";

/**
 * The task screens' world (FIXTURE evidence): the PRODUCTION data controller, plans and outbox over the double of IndexedDB, the app's own
 * router inside the protected providers, and a scriptable `TasksApi` for the online reads. Nothing here talks to a backend.
 */
export const ME = "11111111-1111-4111-8111-111111111111";
export const OTHER = "22222222-2222-4222-8222-222222222222";
const NAME = accountDatabaseName(ME);

class Cell<T> implements Store<T> {
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
    return () => this.listeners.delete(l);
  }
}

export const TODAY = todayIn("UTC", Date.now());

export function definition(over: Partial<TaskDefinition> = {}): TaskDefinition {
  return {
    schedule: { start_date: TODAY, time: null, timezone: "UTC", repeat: null },
    goal: { kind: "checkbox" },
    carry: "close_incomplete",
    participation: "personal",
    open_days_before: 0,
    close_days_after: 1,
    allow_streak_exclusions: false,
    ...over,
  };
}

export interface SeededTask {
  taskId: string;
  executionId: string;
  occurrenceId: string;
  progressId: string;
  data: OccurrenceData;
  rows: CacheRow[];
}

let seq = 0;
const id = () => {
  seq += 1;
  return `aaaaaaaa-0000-4000-8000-${String(seq).padStart(12, "0")}`;
};

/** A task with its details, its one occurrence on `date` and (unless `stream: false`) my progress stream, as synced rows. */
export async function seededTask(
  options: {
    title?: string;
    definition?: Partial<TaskDefinition>;
    date?: string | null;
    stream?: boolean;
    progress?: Partial<ProgressState>;
    archived?: boolean;
    participants?: string[];
    occurrence?: Partial<OccurrenceData>;
    canEdit?: boolean;
  } = {},
): Promise<SeededTask> {
  const def = definition({
    ...options.definition,
    schedule: {
      ...definition().schedule,
      start_date: options.date === undefined ? TODAY : options.date,
      ...options.definition?.schedule,
    },
  });
  const taskId = id();
  const executionId = id();
  const slot = slotOn(def.schedule, def.schedule.start_date);
  const occ = await occurrenceId(taskId, slot.key);
  const prog = await progressId(occ, ME);
  const w = windows(slot, def);
  const data: OccurrenceData = {
    task_id: taskId,
    definition: def,
    slot,
    opens_at: w.opens_at,
    closes_at: w.closes_at,
    participants: options.participants ?? [ME],
    covered_by: null,
    resolved: false,
    ...options.occurrence,
  };
  const empty = { outcome: "unknown" as const, amount: null, checked: [] };
  const rows: CacheRow[] = [
    cacheRow({
      id: taskId,
      kind: "task",
      label: options.title ?? "Brush your teeth",
      version: 1,
      policy_version: 1,
      archived: options.archived ?? false,
    }),
    cacheRow({
      id: executionId,
      kind: "execution",
      parent_id: taskId,
      label: "Task details",
      value: def as never,
    }),
    cacheRow({
      id: occ,
      kind: "occurrence",
      parent_id: executionId,
      label: "Occurrence",
      value: data as never,
      can_edit: options.canEdit ?? true,
    }),
  ];
  if (options.stream !== false)
    rows.push(
      cacheRow({
        id: prog,
        kind: "progress",
        parent_id: occ,
        label: "Progress",
        value: {
          subject_account_id: ME,
          recent_entries: [],
          entry_count: 0,
          excluded: false,
          action: empty,
          period: empty,
          aggregate_consent: true,
          ...options.progress,
        } as never,
      }),
    );
  return {
    taskId,
    executionId,
    occurrenceId: occ,
    progressId: prog,
    data,
    rows,
  };
}

export interface FakeApi extends TasksApi {
  calls: Record<string, number>;
  /** Scripted `/daily` answers by scope; a function may hold. Default: an empty page. */
  daily: {
    joint: Array<
      TasksResult<OccurrencePage> | (() => Promise<TasksResult<OccurrencePage>>)
    >;
    personal: Array<
      TasksResult<OccurrencePage> | (() => Promise<TasksResult<OccurrencePage>>)
    >;
  };
  queries: Array<{ scope: string; after?: string; revision?: number }>;
  /** An answer chosen by the query itself (robust to a remount that repeats a read); used before the scripted queue. */
  respond:
    | ((q: {
        scope: string;
        after?: string;
        revision?: number;
      }) => TasksResult<OccurrencePage> | undefined)
    | null;
}

export function fakeApi(over: Partial<TasksApi> = {}): FakeApi {
  const calls: Record<string, number> = {};
  const count = (name: string) => {
    calls[name] = (calls[name] ?? 0) + 1;
  };
  const empty: OccurrencePage = {
    items: [],
    next_after: null,
    revision: 1,
    pending_tasks: [],
  };
  const api: FakeApi = {
    calls,
    daily: { joint: [], personal: [] },
    queries: [],
    respond: null,
    readDaily: async (q) => {
      count("readDaily");
      const asked = {
        scope: q.scope,
        ...(q.after ? { after: q.after } : {}),
        ...(q.revision !== undefined ? { revision: q.revision } : {}),
      };
      api.queries.push(asked);
      const chosen = api.respond?.(asked);
      if (chosen !== undefined) return chosen;
      const next = api.daily[q.scope].shift();
      if (next === undefined) return { ok: true, value: empty };
      return typeof next === "function" ? next() : next;
    },
    readPresets: async () => {
      count("readPresets");
      return { ok: false, kind: "uncertain" };
    },
    readTask: async () => {
      count("readTask");
      return { ok: false, kind: "uncertain" };
    },
    readEnrolment: async () => {
      count("readEnrolment");
      return { ok: false, kind: "uncertain" };
    },
    readJournal: async () => {
      count("readJournal");
      return { ok: true, value: { entries: [], next_after: null } };
    },
    listProgress: async () => {
      count("listProgress");
      return { ok: true, value: [] };
    },
    enrol: async () => {
      count("enrol");
      return { ok: false, kind: "uncertain" };
    },
    ...over,
  };
  return api;
}

export function tasksEnv(
  api: TasksApi,
  over: Partial<TasksEnv> = {},
): TasksEnv {
  return {
    api,
    accountId: ME,
    identity: `${ME}:1`,
    online: true,
    writable: true,
    now: () => Date.now(),
    newId: () => crypto.randomUUID(),
    dailyPageSize: 200,
    ...over,
  };
}

export interface Mounted {
  world: DataTestWorld;
  data: DataEnv;
  api: FakeApi;
  router: ReturnType<typeof createAppRouter>;
  settle(): Promise<void>;
  /** Settles until `ready()` holds (the cache walk and related reads take several turns), at most 20 rounds. */
  until(ready: () => boolean): Promise<void>;
  drafts(): DraftRow[];
  bodies(): Array<{
    local_id: string;
    command: { command: Record<string, unknown> };
  }>;
  rerender(env: TasksEnv): void;
  unmount(): void;
  /**
   * Commits ONE delta sync page carrying `rows` through the PRODUCTION `commitPage` plan, as the leader does: the cache changes and its
   * position (`page_seq`) moves, which every live read hears (a seeded row is not heard). `removed` ids are removed by the same page.
   */
  commitSync(rows: CacheRow[], removed?: string[]): Promise<void>;
}

export async function mountTasks(options: {
  path: string;
  rows?: CacheRow[];
  /** Drafts seeded before the screens mount (a draft carrying `command` is split into its header and body, as the enqueue writes them). */
  drafts?: object[];
  api?: FakeApi;
  env?: Partial<TasksEnv>;
  database?: boolean;
}): Promise<Mounted> {
  // The routes load the screens lazily; loading the module first makes the lazy components resolve at once.
  await import("../../../src/features/tasks/screens");
  const world = new DataTestWorld();
  world.idb.autoDrive = true;
  const page = world.page("A");
  page.identity.account = ME;
  if (options.database !== false) {
    const created = await page.open(ME, { create: true });
    if (created.kind !== "opened") throw new Error("setup");
    if (options.rows?.length) world.idb.seed(NAME, "cache", options.rows);
    if (options.drafts?.length)
      world.idb.seed(NAME, "drafts", options.drafts as never);
  }
  const identity = new Cell<Identity | null>({
    account_id: ME,
    epoch: 1,
    session_id: "s",
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
  const data = createDataEnv({
    identity,
    loadRuntime: async () => runtime,
    online: new Cell(options.env?.online ?? true),
    quota: createQuotaGuard({ storage: undefined, now: () => 0 }),
    ids: { uuid: () => crypto.randomUUID() },
    clock: { iso: () => new Date().toISOString(), now: () => Date.now() },
    fence: () => ({ hasPendingOperation: false, sessionStarted: true }),
    readMe: async () => ({ kind: "closed" }),
    currentDeviceId: async () => ({ kind: "closed" }),
    onOnline: () => () => undefined,
    channel,
  });
  const api = options.api ?? fakeApi();
  const router = createAppRouter({ initialPath: options.path });
  const tree = (env: TasksEnv) => (
    <ProtectedProviders>
      <ShellEnvProvider
        value={{
          syncModel: { phase: "synced", pendingCount: 0, conflictCount: 0 },
          onOpenSync: () => undefined,
        }}
      >
        <DataEnvProvider env={data}>
          <TasksEnvProvider value={env}>
            <RouterProvider router={router} />
          </TasksEnvProvider>
        </DataEnvProvider>
      </ShellEnvProvider>
    </ProtectedProviders>
  );
  const view = render(tree(tasksEnv(api, options.env)));
  const settle = async () => {
    await act(async () => {
      for (let i = 0; i < 60; i += 1) {
        await world.settle();
        await new Promise((r) => setTimeout(r, i % 5 === 4 ? 10 : 0));
      }
    });
  };
  await settle();
  return {
    world,
    data,
    api,
    router,
    settle,
    until: async (ready) => {
      for (let i = 0; i < 20 && !ready(); i += 1) await settle();
    },
    drafts: () =>
      ((world.idb.snapshot(NAME)?.drafts ?? []) as DraftRow[]).sort(
        (a, b) => a.created_seq - b.created_seq,
      ),
    bodies: () => (world.idb.snapshot(NAME)?.draft_commands ?? []) as never,
    rerender: (env) => view.rerender(tree(env)),
    unmount: () => view.unmount(),
    commitSync: async (rows, removed = []) => {
      const service = data.service();
      if (service === null) throw new Error("commitSync: no open service");
      const before = world.idb.peek(NAME, "sync_state", "singleton") as
        | SyncStateRow
        | undefined;
      if (before === undefined) throw new Error("commitSync: no sync state");
      world.idb.seed(NAME, "sync_state", [
        {
          ...before,
          phase: "delta",
          cache_status: "valid",
          cursor: before.cursor ?? "cursor-0",
        },
      ]);
      const s = world.idb.peek(NAME, "sync_state", "singleton") as SyncStateRow;
      const bytes = bytesOf(
        pageJson({
          batches: [
            {
              revision: (s.applied_revision ?? 0) + 1,
              changes: [
                ...removed.map((id) => ({ kind: "remove" as const, id })),
                ...rows.map((row) => ({
                  kind: "upsert" as const,
                  resource: {
                    id: row.id,
                    kind: row.kind,
                    parent_id: row.parent_id,
                    label: row.label,
                    value: row.value as Record<string, unknown> | null,
                    version: row.version,
                    can_edit: row.can_edit,
                    archived: row.archived,
                    ...(row.policy_version === undefined
                      ? {}
                      : { policy_version: row.policy_version }),
                  },
                })),
              ],
            },
          ],
          nextCursor: `cursor-${s.page_seq + 1}`,
        }),
      );
      const scan = scanSyncPage(bytes);
      if (!scan.ok) throw new Error(`commitSync: ${scan.reason}`);
      let outcome: unknown;
      await act(async () => {
        outcome = await service.commit(commitPage, {
          captured: service.capture(1, {
            requestSeq: s.request_seq,
            ownershipToken: s.owner?.ownership_token ?? null,
            recoveryGeneration: s.recovery_generation,
            expectedPosition: s.cursor,
          }),
          bytes,
          scan,
          now: new Date().toISOString(),
          decode: {
            validators: createValueValidators(),
            derivers: createKeyDerivers(),
          },
        });
      });
      const committed = world.idb.peek(NAME, "sync_state", "singleton") as
        | SyncStateRow
        | undefined;
      if (committed === undefined || committed.page_seq === s.page_seq)
        throw new Error(
          `commitSync: the page was not committed (${JSON.stringify(outcome)})`,
        );
      await settle();
    },
  };
}
