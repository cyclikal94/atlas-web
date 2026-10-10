import type {
  ConflictPage,
  DataActions,
  DataEnv,
  DraftRow,
  Loadable,
  QueuePage,
  QueueSummary,
  StatusInputs,
} from "../../../src/data";
import { summariseQueue } from "../../../src/data/model/queue-summary";
import { createCommandRegistry } from "../../../src/data/outbox/registries";
import type { Identity, Store } from "../../../src/session";

/**
 * A hand-built `DataEnv` for the screen tests: the stores the screens read are plain observable cells, and every action a screen can
 * call is recorded. It is the component layer's double of the controller (the controller itself is tested through its own file), so a
 * screen test says exactly what the screen does with each input and nothing about IndexedDB.
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

export const BASE_INPUTS: StatusInputs = {
  online: true,
  engine: null,
  recovery: { registered: false, active: false },
  cache: "unknown",
  lastSyncedAt: null,
  summary: null,
  outbox: null,
  storageNotResponding: false,
};

export interface StubEnv extends DataEnv {
  /** Merges into the status inputs (and recomputes the summary from the queue when `drafts` is given). */
  set(patch: Partial<StatusInputs>): void;
  setDrafts(drafts: DraftRow[]): void;
  setQueue(value: Loadable<QueuePage>): void;
  setConflicts(value: Loadable<ConflictPage>): void;
  setLabel(label: string | null): void;
  setIdentity(identity: Identity | null): void;
  calls: Array<{ action: string; args: unknown[] }>;
  /** What `discard` answers next (default: discarded). */
  discardResult: { kind: string; [key: string]: unknown };
}

export function stubEnv(
  options: { drafts?: DraftRow[]; inputs?: Partial<StatusInputs> } = {},
): StubEnv {
  const drafts = options.drafts ?? [];
  const inputs = new Cell<StatusInputs>({
    ...BASE_INPUTS,
    summary: summariseQueue(drafts),
    ...options.inputs,
  });
  const pageOf = (list: DraftRow[]): QueuePage => {
    const dependants: Record<string, number> = {};
    for (const row of list)
      for (const id of row.depends_on)
        dependants[id] = (dependants[id] ?? 0) + 1;
    return {
      rows: list,
      more: false,
      previous: false,
      next: list[list.length - 1]?.created_seq ?? null,
      dependants,
    };
  };
  const queue = new Cell<Loadable<QueuePage>>({
    status: "ready",
    value: pageOf(drafts),
  });
  const conflictsOf = (list: DraftRow[]): ConflictPage => ({
    rows: list
      .flatMap((draft): ConflictPage["rows"] =>
        draft.status === "version_conflict" ||
        draft.status === "operation_conflict"
          ? [{ draft, kind: draft.status }]
          : (draft.status === "in_flight" || draft.status === "queued") &&
              draft.review_block !== null
            ? [{ draft, kind: "defaults_review" }]
            : [],
      )
      .sort((a, b) => a.draft.created_seq - b.draft.created_seq),
    more: false,
  });
  const conflicts = new Cell<Loadable<ConflictPage>>({
    status: "ready",
    value: conflictsOf(drafts),
  });
  const summary = new Cell<Loadable<QueueSummary>>({
    status: "ready",
    value: summariseQueue(drafts),
  });
  const identity = new Cell<Identity | null>({
    account_id: "11111111-1111-4111-8111-111111111111",
    epoch: 1,
    session_id: "s",
  });
  const label = new Cell<string | null>(null);
  const calls: StubEnv["calls"] = [];
  const record =
    (action: string) =>
    (...args: unknown[]) => {
      calls.push({ action, args });
    };
  const actions: DataActions = {
    retryUpdates: record("retryUpdates"),
    retryChanges: record("retryChanges"),
    retryLoad: record("retryLoad"),
    showNextQueue: record("showNextQueue"),
    showPreviousQueue: record("showPreviousQueue"),
    discard: async (localId) => {
      calls.push({ action: "discard", args: [localId] });
      return env.discardResult as never;
    },
  };
  const profile = {
    profile: { get: () => null, subscribe: () => () => undefined } as never,
    labelFor: (id: Identity | null) => (id === null ? null : label.get()),
    start: () => () => undefined,
  };
  const env: StubEnv = {
    inputs,
    identity,
    queue,
    conflicts,
    summary,
    profile,
    commands: createCommandRegistry(),
    actions,
    outbox: () => null,
    service: () => null,
    serviceStore: new Cell(null),
    attachLeader: () => () => undefined,
    start: () => undefined,
    dispose: () => undefined,
    calls,
    discardResult: { kind: "discarded", outcome: "removed", affected: 0 },
    set(patch) {
      inputs.set({ ...inputs.get(), ...patch });
    },
    setDrafts(next) {
      queue.set({ status: "ready", value: pageOf(next) });
      conflicts.set({ status: "ready", value: conflictsOf(next) });
      const value = summariseQueue(next);
      summary.set({ status: "ready", value });
      inputs.set({ ...inputs.get(), summary: value });
    },
    setQueue(value) {
      queue.set(value);
    },
    setConflicts(value) {
      conflicts.set(value);
    },
    setLabel(next) {
      label.set(next);
    },
    setIdentity(next) {
      identity.set(next);
    },
  };
  // The profile store notifies label changes to `useAccountLabel`.
  (profile as { profile: Store<unknown> }).profile = label as never;
  return env;
}
