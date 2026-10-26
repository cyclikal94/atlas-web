import { createHash } from "node:crypto";
import type { BrowserContext, Page, Route } from "@playwright/test";
import {
  ACCOUNT,
  pageText,
  type SyncStub,
  startLeader,
  waitForState,
} from "./data-sync-helpers";

/**
 * Helpers of the WEB-10a native specs (FIXTURE evidence: the task reads are answered by `page.route`, not a backend). Ids are the
 * contract's deterministic UUIDv5s, computed here with Node's SHA-1 so a spec can name what the page will compute.
 */
export const API = "/api/experimental/v1";
export const OTHER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

export function uuidV5(namespace: string, name: string): string {
  const ns = Buffer.from(namespace.replaceAll("-", ""), "hex");
  const hash = createHash("sha1")
    .update(Buffer.concat([ns, Buffer.from(name, "utf8")]))
    .digest();
  const b = Buffer.from(hash.subarray(0, 16));
  b[6] = ((b[6] as number) & 0x0f) | 0x50;
  b[8] = ((b[8] as number) & 0x3f) | 0x80;
  const h = b.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
export const occurrenceIdOf = (task: string, key: string) =>
  uuidV5(task, `atlas-occurrence-v1:${key}`);
export const progressIdOf = (occurrence: string, account = ACCOUNT) =>
  uuidV5(occurrence, `atlas-progress-v1:${account}`);

export const todayUtc = (): string => new Date().toISOString().slice(0, 10);
export const midnight = (date: string, plusDays = 0): number =>
  Date.UTC(
    Number(date.slice(0, 4)),
    Number(date.slice(5, 7)) - 1,
    Number(date.slice(8, 10)) + plusDays,
  ) / 1000;

export interface TaskSpec {
  n: number;
  title: string;
  date?: string | null;
  time?: string | null;
  zone?: string;
  goal?: Record<string, unknown>;
  participation?: string;
  allowExclusions?: boolean;
  carry?: string;
  archived?: boolean;
  stream?: boolean;
  action?: Record<string, unknown>;
  opensAt?: number | null;
  closesAt?: number | null;
  instant?: number | null;
  slotKey?: string;
}

export interface BuiltTask {
  taskId: string;
  executionId: string;
  occurrenceId: string;
  progressId: string;
  data: Record<string, unknown>;
  upserts: unknown[];
}

const hexN = (n: number, prefix: string) =>
  `${prefix}-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;

export function buildTask(spec: TaskSpec): BuiltTask {
  const taskId = hexN(spec.n, "70000000");
  const executionId = hexN(spec.n, "71000000");
  const date = spec.date === undefined ? todayUtc() : spec.date;
  const zone = spec.zone ?? "UTC";
  const key = spec.slotKey ?? "once";
  const occurrenceId = occurrenceIdOf(taskId, key);
  const progressId = progressIdOf(occurrenceId);
  const definition = {
    schedule: {
      start_date: date,
      time: spec.time ?? null,
      timezone: zone,
      repeat: null,
    },
    goal: spec.goal ?? { kind: "checkbox" },
    carry: spec.carry ?? "close_incomplete",
    participation: spec.participation ?? "personal",
    open_days_before: 0,
    close_days_after: 1,
    allow_streak_exclusions: spec.allowExclusions ?? false,
  };
  const data = {
    task_id: taskId,
    definition,
    slot: {
      key,
      date,
      intended_time: spec.time ?? null,
      timezone: zone,
      instant: spec.instant ?? null,
    },
    opens_at:
      spec.opensAt !== undefined
        ? spec.opensAt
        : date === null
          ? null
          : midnight(date),
    closes_at:
      spec.closesAt !== undefined
        ? spec.closesAt
        : date === null
          ? null
          : midnight(date, 1),
    participants: [ACCOUNT],
    covered_by: null,
    resolved: false,
  };
  const empty = { outcome: "unknown", amount: null, checked: [] };
  const base = { can_edit: true, archived: false, policy_version: 1 };
  const upserts: unknown[] = [
    {
      kind: "upsert",
      resource: {
        id: taskId,
        kind: "task",
        parent_id: null,
        label: spec.title,
        value: null,
        version: 1,
        ...base,
        archived: spec.archived ?? false,
      },
    },
    {
      kind: "upsert",
      resource: {
        id: executionId,
        kind: "execution",
        parent_id: taskId,
        label: "Task details",
        value: definition,
        version: 1,
        ...base,
      },
    },
    {
      kind: "upsert",
      resource: {
        id: occurrenceId,
        kind: "occurrence",
        parent_id: executionId,
        label: "Occurrence",
        value: data,
        version: 1,
        ...base,
      },
    },
  ];
  if (spec.stream !== false)
    upserts.push({
      kind: "upsert",
      resource: {
        id: progressId,
        kind: "progress",
        parent_id: occurrenceId,
        label: "Progress",
        value: {
          subject_account_id: ACCOUNT,
          recent_entries: [],
          entry_count: 0,
          excluded: false,
          action: spec.action ?? empty,
          period: spec.action ?? empty,
          aggregate_consent: true,
        },
        version: 1,
        ...base,
      },
    });
  return { taskId, executionId, occurrenceId, progressId, data, upserts };
}

/** One `/sync` delta page carrying the tasks, delivered through the fixture leader (the cache now holds them). */
export async function cacheTasks(
  page: Page,
  net: SyncStub,
  tasks: BuiltTask[],
): Promise<void> {
  net.script.push(() => ({
    status: 200,
    body: pageText([tasks.flatMap((t) => t.upserts)], "cursor-1"),
  }));
  await startLeader(page);
  await waitForState(page, "idle");
}

export interface TaskReads {
  /** `GET /defaults/snapshot`: the B5 record (private defaults) unless set to an error. */
  snapshot: { status: number; body: unknown };
  daily: Array<{
    scope: string;
    after: string | null;
    revision: string | null;
  }>;
  /** The answer to a `/daily` read (default: an empty page). */
  respond: (q: {
    scope: string;
    after: string | null;
    revision: string | null;
  }) => { status: number; body: unknown };
  presets: number;
  presetsAnswer: { status: number; body: unknown };
  other: string[];
  /**
   * While set, a `/daily` read is DELIVERED only when this settles (revision 2): its answer is the one `respond` gave when the read arrived
   * (as of dispatch), and `dispatched` records when each read arrived. A read delivered after a boundary was still evaluated before it.
   * A read waits for the gate that was set when it arrived.
   */
  gate: Promise<void> | null;
  dispatched: number[];
}

export const view = (task: BuiltTask, over: Record<string, unknown> = {}) => ({
  id: task.occurrenceId,
  version: 1,
  can_edit: true,
  data: task.data,
  outcome: "incomplete",
  period_outcome: "incomplete",
  actionable: true,
  ...over,
});
export const dailyPage = (
  items: unknown[],
  over: Record<string, unknown> = {},
) => ({
  status: 200,
  body: { items, next_after: null, revision: 5, pending_tasks: [], ...over },
});

/** Serves the task READS (call AFTER `stubNetwork`: a later route wins); everything else falls back to the stub. */
export async function serveTaskReads(
  context: BrowserContext,
): Promise<TaskReads> {
  const reads: TaskReads = {
    snapshot: {
      status: 200,
      body: {
        defaults: {
          revision: `${"0".repeat(63)}1`,
          preferences_version: 1,
          primary_household_id: null,
          person: { kind: "private" },
          field: { kind: "private" },
          task: { kind: "private" },
          list: { kind: "private" },
          progress: { kind: "private" },
        },
        households: [],
      },
    },
    daily: [],
    respond: () => dailyPage([]),
    presets: 0,
    gate: null,
    dispatched: [],
    presetsAnswer: {
      status: 503,
      body: {
        code: "temporarily_unavailable",
        message: "m",
        request_id: "11111111-1111-4111-8111-111111111111",
        details: [],
      },
    },
    other: [],
  };
  await context.route(`**${API}/**`, async (route: Route) => {
    const url = new URL(route.request().url());
    const path = url.pathname.replace(API, "");
    if (path === "/daily") {
      const q = {
        scope: url.searchParams.get("scope") ?? "joint",
        after: url.searchParams.get("after"),
        revision: url.searchParams.get("revision"),
      };
      reads.daily.push(q);
      reads.dispatched.push(Date.now());
      // The answer is what the server would say when the read is DISPATCHED; a gate delays only its delivery.
      const answer = reads.respond(q);
      const gate = reads.gate;
      if (gate !== null) await gate;
      return route.fulfill({
        status: answer.status,
        contentType: "application/json",
        body: JSON.stringify(answer.body),
      });
    }
    if (path === "/defaults/snapshot")
      return route.fulfill({
        status: reads.snapshot.status,
        contentType: "application/json",
        body: JSON.stringify(reads.snapshot.body),
      });
    if (path === "/task-presets") {
      reads.presets += 1;
      return route.fulfill({
        status: reads.presetsAnswer.status,
        contentType: "application/json",
        body: JSON.stringify(reads.presetsAnswer.body),
      });
    }
    if (
      /^\/tasks\/[^/]+\/enrolment$/.test(path) ||
      /^\/progress\/[^/]+\/entries$/.test(path) ||
      /^\/tasks\/[^/]+$/.test(path)
    ) {
      reads.other.push(path);
      return route.fulfill({
        status: 404,
        contentType: "application/json",
        body: JSON.stringify({
          code: "not_found",
          message: "m",
          request_id: "11111111-1111-4111-8111-111111111111",
          details: [],
        }),
      });
    }
    return route.fallback();
  });
  return reads;
}

/** Offline at the app's boundary (assets stay loadable): `navigator.onLine` is false until `goOnlineAtBoundary`, with the events. */
export async function goOfflineAtBoundary(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __offline?: boolean };
    w.__offline = true;
    Object.defineProperty(Navigator.prototype, "onLine", {
      configurable: true,
      get: () => w.__offline !== true,
    });
    window.dispatchEvent(new Event("offline"));
  });
}
export async function goOnlineAtBoundary(page: Page): Promise<void> {
  await page.evaluate(() => {
    (window as unknown as { __offline?: boolean }).__offline = false;
    window.dispatchEvent(new Event("online"));
  });
}

/** The account's drafts and bodies as stored in real IndexedDB, oldest first. */
export async function draftsOf(page: Page): Promise<
  Array<{
    local_id: string;
    kind: string;
    status: string;
    created_seq: number;
    target_resource_ids: string[];
  }>
> {
  const rows = (await page.evaluate(
    (acct) => window.__atlasData?.rows(acct, "drafts"),
    ACCOUNT,
  )) as Array<{
    local_id: string;
    kind: string;
    status: string;
    created_seq: number;
    target_resource_ids: string[];
  }>;
  return [...rows].sort((a, b) => a.created_seq - b.created_seq);
}
export async function bodiesOf(
  page: Page,
): Promise<
  Array<{ local_id: string; command: { command: Record<string, unknown> } }>
> {
  return (await page.evaluate(
    (acct) => window.__atlasData?.rows(acct, "draft_commands"),
    ACCOUNT,
  )) as never;
}

// ---- WEB-10b: lists -------------------------------------------------------------------------------------------------------------
export const listIdOf = (n: number) => hexN(n, "72000000");

/** A list projection as `/sync` upserts it (`service.rs` 296-303): `{task_ids}` are the ids the reader can see, by id. */
export function listUpsert(
  n: number,
  name: string,
  taskIds: readonly string[],
  over: Record<string, unknown> = {},
): { id: string; upsert: unknown } {
  const id = listIdOf(n);
  return {
    id,
    upsert: {
      kind: "upsert",
      resource: {
        id,
        kind: "list",
        parent_id: null,
        label: name,
        value: { task_ids: [...taskIds].sort() },
        version: 2,
        can_edit: true,
        archived: false,
        policy_version: 1,
        ...over,
      },
    },
  };
}

/** One `/sync` delta page carrying tasks and lists, through the fixture leader. */
export async function cacheTasksAndLists(
  page: Page,
  net: SyncStub,
  tasks: BuiltTask[],
  lists: Array<{ upsert: unknown }>,
): Promise<void> {
  net.script.push(() => ({
    status: 200,
    body: pageText(
      [[...tasks.flatMap((t) => t.upserts), ...lists.map((l) => l.upsert)]],
      "cursor-1",
    ),
  }));
  await startLeader(page);
  await waitForState(page, "idle");
}
