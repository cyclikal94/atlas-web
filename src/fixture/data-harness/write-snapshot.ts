import { DataRuntime } from "../../data/engine/account-service";
import {
  createQuotaGuard,
  type QuotaGuard,
} from "../../data/engine/quota-guard";
import { canonicalJson, digestOf } from "../../data/model/canonical";
import { DATA_CONFIG } from "../../data/model/config";
import { draftWriteBytes, type EnqueueRequest } from "../../data/model/outbox";
import type { DraftRow, JsonObject } from "../../data/model/types";
import { createOutbox, type Outbox } from "../../data/outbox/outbox";
import { createDexieOpener } from "../../data/store/dexie-adapter";
import { type Plan, w } from "../../data/store/port";
import { createRegistry } from "../../data/store/registry";
import { type Identity, type Store, unrevokedHold } from "../../session";

/**
 * FIXTURE ONLY (R39 and R40, revision 22). The write-snapshot harness: the PRODUCTION outbox (`createOutbox`), quota guard, runtime and
 * Dexie adapter over REAL IndexedDB in a real engine, with a caller that edits the graph its `build` returned, or its request, at a named
 * instant, and a read of what the ENGINE stored afterwards. It reproduces the independent review's schedule: the first native
 * `IDBObjectStore.put` of a `drafts` row is wrapped, and where it returns (the engine has cloned the header; the body's put has not been
 * called) a microtask carries out the caller's edit. Production timers, native request results and the adapter are unchanged: the wrapper
 * observes and queues, it fails nothing and delays nothing.
 *
 * - `write(path, shape, schedule)`: one save by `enqueue`, `editQueued` or `supersede`, under a quota that admits `room` bytes of input,
 *   with the caller's graph handed over as itself (`direct`), as a fresh root over the nested value the caller still holds (`fresh-root`) or
 *   as a deep copy (`deep-copy`, the control); the edit lands `after-header` (between the two native puts) or `before-plan` (while the
 *   reservation is awaited: the plan then reads the grown graph and that is the save).
 * - `interval()`: the CONTROL that the injection is real in this engine: a hand-made plan that writes a graph the caller still owns, by
 *   reference, shows the edit in what the engine stored, and a header edited the instant the put returns does not.
 * - `request(path)`: the caller edits its REQUEST (the endpoint and a target) while the quota reservation is awaited.
 * - `sparse(mode)`: the review's R40 schedule: supersede a conflict with the empty-list command, then the same local id with the empty
 *   list (`same`), `[null]` (`dense`) or a one-hole list (`sparse`), and a direct enqueue of the same command.
 *
 * Every run uses a database of its own and ends by disposing what it built. A passing run is fixture evidence for THIS ENGINE ON THIS
 * MACHINE: not genuine quota exhaustion (the free space is an injected estimate), not a device, not real Safari.
 */
export type WritePath = "enqueue" | "edit" | "supersede";
export type Shape = "direct" | "fresh-root" | "deep-copy";
export type Schedule = "after-header" | "before-plan";

export interface WriteResult {
  path: WritePath;
  shape: Shape;
  schedule: Schedule;
  outcome: unknown;
  /** The injected edit was queued by the native put's return / by the reservation, and it ran. */
  observed: boolean;
  mutated: boolean;
  /** Every size the guard was asked to hold, in order. */
  reserved: number[];
  storedTextLength: number | null;
  storedLabel: string | null;
  digestMatches: boolean | null;
  actualBytes: number | null;
  /** Every row of the three stores, as JSON, before and after: the same for a refusal. */
  untouched: boolean;
  /** The caller's own graph at the end (the later edit), so a test can tell the schedule really changed it. */
  callerTextLength: number;
  latch: string;
}

export interface IntervalResult {
  observed: boolean;
  storedTextLength: number | null;
  storedHeaderEndpoint: string | null;
}

export interface RequestResult {
  path: WritePath;
  outcome: unknown;
  storedEndpoint: string | null;
  storedTargets: string[] | null;
}

export interface SparseResult {
  mode: "same" | "dense" | "sparse";
  first: unknown;
  next: unknown;
  /** What the direct enqueue of the same command did: its outcome, or the name of the error it threw. */
  direct: { outcome: unknown } | { threw: string };
  canonical: string;
  json: string;
  digestOriginal: string;
  digestChanged: string | null;
  storedLength: number | null;
  storedHasElement: boolean | null;
  storedDigestMatchesWire: boolean | null;
}

export interface WriteSnapshotHarness {
  write(
    path: WritePath,
    shape: Shape,
    schedule: Schedule,
    room: number,
  ): Promise<WriteResult>;
  interval(): Promise<IntervalResult>;
  request(path: WritePath): Promise<RequestResult>;
  sparse(mode: "same" | "dense" | "sparse"): Promise<SparseResult>;
}

const LATER = 900_000;
const HALF_RESERVE = DATA_CONFIG.quotaReserveBytes / 2;
const cell = <T>(value: T): Store<T> => ({
  get: () => value,
  subscribe: () => () => undefined,
});

interface Rows {
  drafts: DraftRow[];
  bodies: Array<{ local_id: string; command: JsonObject }>;
  versions: unknown[];
}
const readAll: Plan<null, Rows, Rows> = {
  name: "fixture.writeSnapshot.readAll",
  scope: ["drafts", "draft_commands", "resource_versions"],
  mode: "readonly",
  durability: "default",
  read: async (reader) => ({
    drafts: (await reader.list("drafts")) as DraftRow[],
    bodies: (await reader.list("draft_commands")) as Rows["bodies"],
    versions: await reader.list("resource_versions"),
  }),
  decide: (reads) => ({ writes: [], result: reads }),
};

/** A save's world: a real runtime over a database of its own, the production outbox over a guard that admits `room` bytes of input. */
async function build(room: number) {
  const registry = createRegistry("write-snapshot");
  const account = crypto.randomUUID();
  const opener = createDexieOpener({ registry });
  const identity: Store<Identity | null> = cell({
    account_id: account,
    epoch: 1,
    session_id: "fixture",
  } as Identity);
  const runtime = new DataRuntime({
    registry,
    identity,
    // No session record to order against on a fixture page: a hold that is never revoked (the saves under test take none).
    persistence: { hold: async () => unrevokedHold() },
    open: (a, o) => opener.open(a, { ...o, incarnation: crypto.randomUUID() }),
  });
  const opened = await runtime.open(account, { create: true });
  if (opened.kind !== "opened") throw new Error("the database was not opened");
  const service = opened.service;
  const guard: QuotaGuard = createQuotaGuard({
    storage: {
      estimate: async () => ({ usage: 0, quota: HALF_RESERVE + room }),
    },
    now: () => Date.now(),
  });
  const reserved: number[] = [];
  let onReserve: (() => void) | null = null;
  const quota: QuotaGuard = {
    ...guard,
    reserve: async (kind, bytes) => {
      reserved.push(bytes);
      onReserve?.();
      return guard.reserve(kind, bytes);
    },
  };
  const outbox: Outbox = createOutbox({
    service,
    quota,
    ids: { uuid: () => crypto.randomUUID() },
    clock: { iso: () => new Date().toISOString(), now: () => Date.now() },
    fence: () => ({ hasPendingOperation: false, sessionStarted: true }),
  });
  return {
    registry,
    account,
    service,
    outbox,
    reserved,
    reserveHook(hook: (() => void) | null): void {
      onReserve = hook;
    },
    rows: (): Promise<Rows> =>
      service.store.run(readAll, null) as Promise<Rows>,
    /** Another connection marks a draft as in conflict (nothing in the public API makes one without a server). */
    async conflict(id: string): Promise<void> {
      const request = indexedDB.open(`atlas-${account}`);
      const db: IDBDatabase = await new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction("drafts", "readwrite");
        const store = tx.objectStore("drafts");
        const got = store.get(id);
        got.onsuccess = () =>
          store.put({ ...got.result, status: "version_conflict" });
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
      db.close();
    },
    dispose(): void {
      guard.close?.();
      outbox.disposeObservation();
      runtime.dispose();
      registry.closeAll(account);
    },
  };
}

interface Graph {
  kind: string;
  text: string;
  nested: { label: string };
}

/**
 * Wraps the native `put`: for the first `drafts` row, `sync` runs in the turn the native call returns (the engine has cloned the row at the
 * call) and `later` is queued as a microtask (before the engine can deliver the request's result, so before the adapter's next write).
 */
function afterHeaderPut(
  later: () => void,
  sync?: () => void,
): { restore(): void; fired(): boolean } {
  const original = IDBObjectStore.prototype.put;
  let fired = false;
  IDBObjectStore.prototype.put = function (
    this: IDBObjectStore,
    ...args: Parameters<IDBObjectStore["put"]>
  ) {
    const result = Reflect.apply(original, this, args) as IDBRequest;
    if (!fired && this.name === "drafts") {
      fired = true;
      sync?.();
      queueMicrotask(later);
    }
    return result;
  } as typeof original;
  return {
    restore: () => {
      IDBObjectStore.prototype.put = original;
    },
    fired: () => fired,
  };
}

function createHarness(): WriteSnapshotHarness {
  return {
    async write(path, shape, schedule, room) {
      const world = await build(room);
      let restore = (): void => undefined;
      try {
        const oldId = crypto.randomUUID();
        const freshId = crypto.randomUUID();
        if (path !== "enqueue")
          await world.outbox.enqueue({
            localId: oldId,
            endpoint: "/commands",
            targets: [],
            build: () => ({ command: { kind: "create", text: "prior" } }),
          });
        if (path === "supersede") await world.conflict(oldId);
        const graph: Graph = {
          kind: "create",
          text: "small",
          nested: { label: "original" },
        };
        let mutated = false;
        const edit = (): void => {
          graph.text = "x".repeat(LATER);
          graph.nested.label = "later edit";
          mutated = true;
        };
        const id = path === "edit" ? oldId : freshId;
        const request: EnqueueRequest = {
          localId: id,
          endpoint: "/commands",
          targets: [],
          build: () => ({
            command: (shape === "direct"
              ? graph
              : shape === "fresh-root"
                ? { ...graph }
                : structuredClone(graph)) as unknown as JsonObject,
          }),
        };
        const before = JSON.stringify(await world.rows());
        world.reserved.length = 0;
        let observed = false;
        if (schedule === "after-header") {
          const probe = afterHeaderPut(edit);
          restore = probe.restore;
          const outcome = await (path === "enqueue"
            ? world.outbox.enqueue(request)
            : path === "edit"
              ? world.outbox.editQueued(oldId, request)
              : world.outbox.supersede(oldId, request));
          observed = probe.fired();
          restore();
          restore = () => undefined;
          return await finish(outcome);
        }
        // before-plan: the first reservation is the estimate's; the caller grows its graph while it is awaited
        let calls = 0;
        world.reserveHook(() => {
          calls += 1;
          if (calls === 1) {
            observed = true;
            edit();
          }
        });
        const outcome = await (path === "enqueue"
          ? world.outbox.enqueue(request)
          : path === "edit"
            ? world.outbox.editQueued(oldId, request)
            : world.outbox.supersede(oldId, request));
        return await finish(outcome);

        async function finish(outcome: unknown): Promise<WriteResult> {
          const rows = await world.rows();
          const header = rows.drafts.find((row) => row.local_id === id);
          const body = rows.bodies.find((row) => row.local_id === id)
            ?.command as
            | { text?: string; nested?: { label?: string } }
            | undefined;
          const bytes =
            header && body
              ? draftWriteBytes({
                  draft: header,
                  command: body as unknown as JsonObject,
                  versionPuts: rows.versions as never,
                })
              : null;
          return {
            path,
            shape,
            schedule,
            outcome,
            observed,
            mutated,
            reserved: [...world.reserved],
            storedTextLength: body?.text?.length ?? null,
            storedLabel: body?.nested?.label ?? null,
            digestMatches:
              header && body ? header.command_digest === digestOf(body) : null,
            actualBytes: bytes,
            untouched: JSON.stringify(rows) === before,
            callerTextLength: graph.text.length,
            latch: world.registry.latch(world.account),
          };
        }
      } finally {
        restore();
        world.dispose();
      }
    },

    async interval() {
      const world = await build(1024 * 1024);
      try {
        const id = crypto.randomUUID();
        const caller = { kind: "create", text: "small" };
        const header: DraftRow = {
          local_id: id,
          account_id: world.account,
          endpoint: "/commands",
          target_id: null,
          kind: "create",
          command_digest: digestOf(caller),
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
          created_seq: 1,
          created_at: new Date().toISOString(),
        };
        // The header is edited in the turn the native put RETURNS (the engine cloned it at the call, so this must not reach what was
        // stored), and the graph the body refers to a microtask later (before the body's put is called, so this must).
        const probe = afterHeaderPut(
          () => {
            caller.text = "later edit";
          },
          () => {
            header.endpoint = "/changed-after-the-put";
          },
        );
        try {
          await world.service.store.run(
            {
              name: "fixture.writeSnapshot.ownedByReference",
              scope: ["drafts", "draft_commands"],
              mode: "readwrite",
              durability: "strict",
              read: async () => null,
              decide: () => ({
                writes: [
                  w.put("drafts", header),
                  w.put("draft_commands", { local_id: id, command: caller }),
                ],
                result: null,
              }),
            } satisfies Plan<null, null, null>,
            null,
          );
        } finally {
          probe.restore();
        }
        const rows = await world.rows();
        const stored = rows.bodies.find((row) => row.local_id === id)
          ?.command as { text?: string } | undefined;
        return {
          observed: probe.fired(),
          storedTextLength: stored?.text?.length ?? null,
          storedHeaderEndpoint:
            rows.drafts.find((row) => row.local_id === id)?.endpoint ?? null,
        };
      } finally {
        world.dispose();
      }
    },

    async request(path) {
      const world = await build(1024 * 1024);
      try {
        const target = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
        const oldId = crypto.randomUUID();
        const freshId = crypto.randomUUID();
        if (path !== "enqueue")
          await world.outbox.enqueue({
            localId: oldId,
            endpoint: "/commands",
            targets: [],
            build: () => ({ command: { kind: "create", text: "prior" } }),
          });
        if (path === "supersede") await world.conflict(oldId);
        const id = path === "edit" ? oldId : freshId;
        const request: EnqueueRequest = {
          localId: id,
          endpoint: "/commands",
          targets:
            path === "enqueue"
              ? [
                  {
                    resourceId: target,
                    role: "primary",
                    basis: "resource",
                    versionChecked: false,
                    seedIfUntracked: 1,
                  },
                ]
              : [],
          build: () => ({ command: { kind: "create", text: "small" } }),
        };
        world.reserveHook(() => {
          // The caller changes its request after it was handed over and validated, while the reservation is awaited.
          request.endpoint = "/../escape";
          if (request.targets[0]) request.targets[0].resourceId = "another";
        });
        const outcome = await (path === "enqueue"
          ? world.outbox.enqueue(request)
          : path === "edit"
            ? world.outbox.editQueued(oldId, request)
            : world.outbox.supersede(oldId, request));
        const rows = await world.rows();
        const header = rows.drafts.find((row) => row.local_id === id);
        return {
          path,
          outcome,
          storedEndpoint: header?.endpoint ?? null,
          storedTargets: header?.index_targets ?? null,
        };
      } finally {
        world.dispose();
      }
    },

    async sparse(mode) {
      const world = await build(100 * 1024 * 1024);
      try {
        const old = crypto.randomUUID();
        const fresh = crypto.randomUUID();
        await world.outbox.enqueue({
          localId: old,
          endpoint: "/commands",
          targets: [],
          build: () => ({
            command: { kind: "create", items: ["original"] },
          }),
        });
        await world.conflict(old);
        const originalBody = { kind: "create", items: [] as unknown[] };
        const first = await world.outbox.supersede(old, {
          localId: fresh,
          endpoint: "/commands",
          targets: [],
          build: () => ({ command: originalBody as JsonObject }),
        });
        const items: unknown[] =
          mode === "same" ? [] : mode === "dense" ? [null] : new Array(1);
        const changed = { kind: "create", items };
        const next = await world.outbox.supersede(old, {
          localId: fresh,
          endpoint: "/commands",
          targets: [],
          build: () => ({ command: changed as JsonObject }),
        });
        const directId = crypto.randomUUID();
        let direct: SparseResult["direct"];
        try {
          direct = {
            outcome: await world.outbox.enqueue({
              localId: directId,
              endpoint: "/commands",
              targets: [],
              build: () => ({ command: changed as JsonObject }),
            }),
          };
        } catch (error) {
          direct = {
            threw: error instanceof Error ? error.constructor.name : "other",
          };
        }
        const rows = await world.rows();
        const header = rows.drafts.find((row) => row.local_id === directId);
        const body = rows.bodies.find((row) => row.local_id === directId)
          ?.command as { items?: unknown[] } | undefined;
        let changedDigest: string | null = null;
        try {
          changedDigest = digestOf(changed);
        } catch {
          changedDigest = null;
        }
        return {
          mode,
          first,
          next,
          direct,
          canonical: (() => {
            try {
              return canonicalJson(changed);
            } catch {
              return "throws";
            }
          })(),
          json: JSON.stringify(changed),
          digestOriginal: digestOf(originalBody),
          digestChanged: changedDigest,
          storedLength: body?.items?.length ?? null,
          storedHasElement: body?.items ? Object.hasOwn(body.items, 0) : null,
          storedDigestMatchesWire:
            header && body
              ? header.command_digest ===
                digestOf(JSON.parse(JSON.stringify(body)))
              : null,
        };
      } finally {
        world.dispose();
      }
    },
  };
}

declare global {
  interface Window {
    __atlasWriteSnapshot?: WriteSnapshotHarness;
  }
}
window.__atlasWriteSnapshot = createHarness();
