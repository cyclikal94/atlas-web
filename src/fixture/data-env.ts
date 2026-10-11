import type {
  ConflictPage,
  DataEnv,
  DraftRow,
  Loadable,
  QueuePage,
  StatusInputs,
} from "../data";
import { createCommandRegistry } from "../data";
import { summariseQueue } from "../data/model/queue-summary";
import type { Identity, Store } from "../session";

/**
 * FIXTURE ONLY. A hand-built data env driven by the query string, so the sync screens can be rendered in a real engine without a
 * database, a session or a backend: `?state=floor-a` (and the others below), `?drafts=N` (N queued changes), `?decisions=1`
 * (the conflict kinds), `?rejected=1`, `?netoffline=1`, `?queue=loading|error`, `?window=N` (show the queue in windows of `?size=` rows, default 100, starting at window
 * N, with Show next changes / Show previous changes moving between them, as the data layer's pager does). It says nothing about the data layer's behaviour: a rendered fixture is
 * evidence about layout, contrast, focus and copy, never integration.
 */
class Cell<T> implements Store<T> {
  private listeners = new Set<() => void>();
  constructor(private value: T) {}
  get(): T {
    return this.value;
  }
  set(next: T): void {
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

const STATES: Record<string, Partial<StatusInputs>> = {
  "floor-a": { engine: { kind: "stopped", cause: "floor" }, cache: "valid" },
  "floor-b": { engine: { kind: "stopped", cause: "floor" }, cache: "invalid" },
  "page-not-saved": {
    engine: { kind: "stopped", cause: "local_storage" },
    cache: "valid",
  },
  "storage-full-valid": {
    engine: { kind: "stopped", cause: "storage_full" },
    cache: "valid",
  },
  "storage-full-invalid": {
    engine: { kind: "stopped", cause: "storage_full" },
    cache: "invalid",
  },
  // R10: the cache is KNOWN to be invalid (the server said so) but the write that records it failed, so the database still says `valid`.
  // The stop itself hides the cache and its notice is the "refreshing" one.
  "invalidation-write-failed": {
    engine: { kind: "stopped", cause: "local_storage", invalidating: true },
    cache: "valid",
  },
  "invalidation-write-quota": {
    engine: { kind: "stopped", cause: "storage_full", invalidating: true },
    cache: "valid",
  },
  "storage-not-responding": { storageNotResponding: true },
  "compat-unsupported": {
    outbox: { kind: "paused", reason: "compat_unsupported" },
  },
  "compat-missing": { outbox: { kind: "paused", reason: "compat_missing" } },
  "still-trying-updates": { engine: { kind: "paused", since: 0 } },
  "still-trying-changes": { outbox: { kind: "needs_retry", count: 2 } },
  "device-capacity": { engine: { kind: "stopped", cause: "device_capacity" } },
  unrecognised: { engine: { kind: "stopped", cause: "unrecognised" } },
  gate: { cache: "invalid", engine: { kind: "running", catchingUp: true } },
  "gate-floor": {
    cache: "invalid",
    engine: { kind: "stopped", cause: "floor" },
  },
  idle: {
    cache: "valid",
    engine: { kind: "idle", lastSyncedAt: "2026-10-01T09:00:00.000Z" },
    lastSyncedAt: "2026-10-01T09:00:00.000Z",
  },
};

const draft = (n: number, over: Partial<DraftRow>): DraftRow => ({
  local_id: `fixture-${n}`,
  account_id: "fixture",
  endpoint: "/commands",
  target_id: null,
  kind: "fixture",
  command_digest: `d${n}`,
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
  created_seq: n,
  created_at: "2026-10-01T09:12:00",
  ...over,
});

export interface FixtureData {
  env: DataEnv;
  /** Test hooks: replace the inputs or the drafts while the page is open. */
  set(patch: Partial<StatusInputs>): void;
  setDrafts(rows: DraftRow[]): void;
  calls: Array<{ action: string; args: unknown[] }>;
}

export function fixtureData(params: URLSearchParams): FixtureData {
  const queued = Number(params.get("drafts") ?? 0);
  const rows: DraftRow[] = [];
  for (let i = 1; i <= queued; i += 1)
    rows.push(
      draft(i, {
        created_at: `2026-10-01T09:${String(i % 60).padStart(2, "0")}:00`,
        ...(i === 2
          ? {
              status: "in_flight",
              attempts: 2,
              retry_state: { state: "backing_off", since: 0 },
            }
          : {}),
      }),
    );
  let next = rows.length;
  if (params.get("paused") === "1")
    rows.push(
      draft(++next, {
        status: "in_flight",
        attempts: 6,
        retry_state: { state: "paused", since: 0 },
      }),
    );
  if (params.get("decisions") === "1") {
    rows.push(draft(++next, { status: "version_conflict" }));
    rows.push(draft(++next, { status: "operation_conflict" }));
    rows.push(
      draft(++next, {
        status: "in_flight",
        review_block: { kind: "defaults", kinds: [] },
      }),
    );
  }
  if (params.get("rejected") === "1") {
    rows.push(draft(++next, { status: "rejected" }));
    rows.push(
      draft(++next, { status: "blocked", blocked_reason: "slice_capacity" }),
    );
  }
  if (params.get("confirming") === "1")
    rows.push(
      draft(++next, { status: "acknowledged", held_pending_cache: true }),
    );
  const state = STATES[params.get("state") ?? ""] ?? {};
  const inputs = new Cell<StatusInputs>({
    online: params.get("netoffline") !== "1",
    engine: null,
    recovery: { registered: false, active: false },
    cache: "unknown",
    lastSyncedAt: null,
    summary: summariseQueue(rows),
    outbox: null,
    storageNotResponding: false,
    ...state,
  });
  const queueParam = params.get("queue");
  // `?window=N` shows the queue a WINDOW at a time, as the data layer's pager does (R6): the next or the previous window replaces the
  // one shown. Without it the whole fixture list is one window (the large-count screens render every row on purpose).
  const windowParam = params.get("window");
  const windowSize = Number(params.get("size") ?? 100);
  let windowAt =
    windowParam === null ? 0 : Math.max(0, Number(windowParam) - 1);
  const windowOf = (list: DraftRow[]): DraftRow[] =>
    windowParam === null
      ? list
      : list.slice(windowAt * windowSize, (windowAt + 1) * windowSize);
  const pageOf = (list: DraftRow[]): QueuePage => {
    const shown = windowOf(list);
    const dependants: Record<string, number> = {};
    for (const row of shown)
      for (const id of row.depends_on)
        dependants[id] = (dependants[id] ?? 0) + 1;
    return {
      rows: shown,
      more: windowParam !== null && (windowAt + 1) * windowSize < list.length,
      previous: windowParam !== null && windowAt > 0,
      next: shown[shown.length - 1]?.created_seq ?? null,
      dependants,
    };
  };
  const initialQueue: Loadable<QueuePage> =
    queueParam === "loading"
      ? { status: "loading" }
      : queueParam === "error"
        ? { status: "unavailable", reason: "error" }
        : { status: "ready", value: pageOf(rows) };
  const queue = new Cell<Loadable<QueuePage>>(initialQueue);
  const move = (by: number): void => {
    windowAt = Math.max(0, windowAt + by);
    queue.set({ status: "ready", value: pageOf(rows) });
  };
  const conflicts = new Cell<Loadable<ConflictPage>>({
    status: "ready",
    value: { rows: [], more: false },
  });
  const summary = new Cell({
    status: "ready" as const,
    value: summariseQueue(rows),
  });
  const label = new Cell<string | null>(params.get("label"));
  const identity = new Cell<Identity | null>({
    account_id: "fixture",
    epoch: 1,
    session_id: "s",
  });
  const calls: FixtureData["calls"] = [];
  const env: DataEnv = {
    inputs,
    identity,
    queue,
    conflicts,
    summary,
    profile: {
      profile: label as never,
      labelFor: (id) => (id === null ? null : label.get()),
      start: () => () => undefined,
    },
    // No sharing defaults: the sync screens never read them, and a fixture rendered here asks nothing of a server.
    defaults: {
      record: new Cell(null),
      settled: new Cell(true),
      refresh: async () => "closed",
      boundary: () => null,
      acquire: async () => ({ outcome: "closed", record: null }),
      use: () => () => undefined,
      start: () => () => undefined,
    },
    commands: createCommandRegistry(),
    actions: {
      retryUpdates: () => calls.push({ action: "retryUpdates", args: [] }),
      retryChanges: (id) => calls.push({ action: "retryChanges", args: [id] }),
      retryLoad: () => calls.push({ action: "retryLoad", args: [] }),
      acknowledgeResync: (id) =>
        calls.push({ action: "acknowledgeResync", args: [id] }),
      readCurrent: async (id) => {
        calls.push({ action: "readCurrent", args: [id] });
        return { kind: "failed", reason: "unavailable" };
      },
      saveAsNew: async (id, current) => {
        calls.push({ action: "saveAsNew", args: [id, current] });
        return { kind: "refused", reason: "not_rebuildable" };
      },
      showNextQueue: () => {
        calls.push({ action: "showNextQueue", args: [] });
        move(1);
      },
      showPreviousQueue: () => {
        calls.push({ action: "showPreviousQueue", args: [] });
        move(-1);
      },
      confirmDefaultsReview: async (id, confirmation) => {
        calls.push({
          action: "confirmDefaultsReview",
          args: [id, confirmation],
        });
        return { kind: "refused", reason: "closed" };
      },
      discard: async (id) => {
        calls.push({ action: "discard", args: [id] });
        const current = queue.get();
        if (current.status === "ready") {
          const kept = current.value.rows.filter((row) => row.local_id !== id);
          queue.set({ status: "ready", value: pageOf(kept) });
          const value = summariseQueue(kept);
          summary.set({ status: "ready", value });
          inputs.set({ ...inputs.get(), summary: value });
        }
        return { kind: "discarded", outcome: "removed", affected: 0 } as never;
      },
    },
    outbox: () => null,
    service: () => null,
    serviceStore: new Cell(null),
    attachLeader: () => () => undefined,
    attachFollower: () => () => undefined,
    start: () => undefined,
    dispose: () => undefined,
  };
  return {
    env,
    calls,
    set: (patch) => inputs.set({ ...inputs.get(), ...patch }),
    setDrafts(next) {
      queue.set({ status: "ready", value: pageOf(next) });
      const value = summariseQueue(next);
      summary.set({ status: "ready", value });
      inputs.set({ ...inputs.get(), summary: value });
    },
  };
}
