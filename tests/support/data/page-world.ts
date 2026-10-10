import type { AccountService } from "../../../src/data/engine/account-service";
import { digestOf } from "../../../src/data/model/canonical";
import { accountDatabaseName } from "../../../src/data/model/schema";
import type {
  AccountId,
  CacheRow,
  Captured,
  SyncStateRow,
} from "../../../src/data/model/types";
import type { CommitPageInput } from "../../../src/data/plans/commit-page";
import { commitPage } from "../../../src/data/plans/commit-page";
import { scanSyncPage } from "../../../src/data/scan/scan";
import {
  createKeyDerivers,
  createValueValidators,
} from "../../../src/data/scan/validate";
import { type Identity, type Store, unrevokedHold } from "../../../src/session";
import { DataTestWorld, type PageEnv } from "./env";
import { cacheRow } from "./rows";
import { bytesOf, type PageSpec, pageJson } from "./sync-pages";

/**
 * A page-commit scenario world: one account database in the delta phase with a valid cache, one service, and helpers to build a
 * page's bytes, capture a request the way the engine does, and commit. Everything runs through the PRODUCTION plan.
 */
export const ACCOUNT: AccountId = "11111111-1111-4111-8111-111111111111";
export const NAME = accountDatabaseName(ACCOUNT);

/**
 * The persistence gate of a test page: what `session.persistence.hold` answers next, and every hold it granted. `held` (default)
 * grants; `stale` answers that the record names another identity; `unavailable` that the lock or the record could not be had.
 */
export interface TestGate {
  mode: "held" | "stale" | "unavailable";
  /** Holds granted and not yet released. */
  open: number;
  /** Every request, in order, with its answer (`queued` while `queue` is on: the test answers it later, through `waiting`). */
  requests: Array<{ account: string; epoch: number; answer: string }>;
  /**
   * When true every `hold` WAITS for the test (R42, revision 23): the request is added to `waiting` and answered by the entry's
   * `answer(kind)`, in any order, so a page's commit can be held between the crash-loop marker's write and its decision, and two
   * pages' commits can be answered in the order a schedule needs. `answer()` without a kind uses `mode` as it stands then.
   */
  queue: boolean;
  waiting: Array<{
    account: string;
    epoch: number;
    answer(kind?: "held" | "stale" | "unavailable"): void;
  }>;
}

export interface PageWorld {
  /** The persistence gate of this page (see `TestGate`). */
  gate: TestGate;
  /** The page's identity as the runtime and the engine see it. `move` changes it and notifies, as the session would. */
  identity: Store<Identity | null> & {
    move(next: { account: AccountId | null; epoch: number }): void;
  };
  env: DataTestWorld;
  page: PageEnv;
  service: AccountService;
  sync(): SyncStateRow;
  /**
   * Seeds rows. A draft that carries a `command` (as `draftRow()` builds it) is split into its `drafts` header and its
   * `draft_commands` body, as the enqueue plan writes them.
   */
  put(
    store:
      | "cache"
      | "drafts"
      | "draft_commands"
      | "pending_effects"
      | "resource_versions",
    rows: object[],
  ): void;
  rows(
    store:
      | "cache"
      | "drafts"
      | "draft_commands"
      | "pending_effects"
      | "resource_versions"
      | "sync_state",
  ): object[];
  cache(): CacheRow[];
  /** The body of a draft, from its own store (`draft_commands`), or undefined. */
  commandOf(localId: string): object | undefined;
  /**
   * The invariant of decision D-23, checked after every settle of the outbox and engine worlds: a body never outlives its draft.
   * Throws with the orphan ids, so every scenario test is also a test that no plan leaves one behind.
   */
  assertNoOrphanBodies(): void;
  /** The state of every store, for byte-for-byte comparisons. */
  snapshot(): Record<string, object[]> | null;
  /** Sets fields of the singleton directly (arranging a scenario). */
  setSync(patch: Partial<SyncStateRow>): void;
  capture(over?: Partial<Captured>): Captured;
  input(
    spec: PageSpec | string,
    over?: Partial<CommitPageInput>,
  ): CommitPageInput;
  commit(input: CommitPageInput): ReturnType<AccountService["commit"]>;
}

export async function pageWorld(
  options: {
    cursor?: string | null;
    phase?: "snapshot" | "delta";
    cacheStatus?: "valid" | "invalid" | "empty";
    epoch?: number;
  } = {},
): Promise<PageWorld> {
  const env = new DataTestWorld();
  env.idb.autoDrive = true;
  const page = env.page("A");
  page.identity.account = ACCOUNT;
  page.identity.epoch = options.epoch ?? 1;
  const listeners = new Set<() => void>();
  const identity = {
    get: (): Identity | null =>
      page.identity.account === null
        ? null
        : {
            account_id: page.identity.account,
            epoch: page.identity.epoch,
            session_id: "s",
          },
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  const gate: TestGate = {
    mode: "held",
    open: 0,
    requests: [],
    queue: false,
    waiting: [],
  };
  const runtime = new env.modules.accountService.DataRuntime({
    identity,
    persistence: {
      hold: async (account, epoch) => {
        gate.requests.push({
          account,
          epoch,
          answer: gate.queue ? "queued" : gate.mode,
        });
        const answer = gate.queue
          ? await new Promise<TestGate["mode"]>((resolve) => {
              gate.waiting.push({
                account,
                epoch,
                answer: (kind = gate.mode) => resolve(kind),
              });
            })
          : gate.mode;
        if (answer !== "held") return { kind: answer };
        gate.open += 1;
        let released = false;
        return unrevokedHold(() => {
          if (released) return;
          released = true;
          gate.open -= 1;
        });
      },
    },
    registry: page.registry,
    open: (a, o) => page.open(a, o),
  });
  const opened = await runtime.open(ACCOUNT, { create: true });
  if (opened.kind !== "opened") throw new Error(`setup: ${opened.kind}`);
  const service = opened.service;
  await env.settle();
  const world: PageWorld = {
    gate,
    identity: Object.assign(identity, {
      move(next: { account: AccountId | null; epoch: number }) {
        page.identity.account = next.account;
        page.identity.epoch = next.epoch;
        for (const listener of [...listeners]) listener();
      },
    }),
    env,
    page,
    service,
    sync: () => env.idb.peek(NAME, "sync_state", "singleton") as SyncStateRow,
    // `FakeIdb.seed` splits a draft that carries a `command` into its header and its body (decision D-23).
    put: (store, rows) => env.idb.seed(NAME, store, rows as never),
    rows: (store) => (env.idb.snapshot(NAME)?.[store] ?? []) as object[],
    cache: () => (env.idb.snapshot(NAME)?.cache ?? []) as CacheRow[],
    assertNoOrphanBodies() {
      const snapshot = env.idb.snapshot(NAME);
      const headers = new Set(
        ((snapshot?.drafts ?? []) as Array<{ local_id: string }>).map(
          (row) => row.local_id,
        ),
      );
      const orphans = (
        (snapshot?.draft_commands ?? []) as Array<{ local_id: string }>
      )
        .map((row) => row.local_id)
        .filter((id) => !headers.has(id));
      if (orphans.length > 0)
        throw new Error(`orphan draft bodies: ${orphans.join(", ")}`);
    },
    commandOf: (localId) =>
      (
        (env.idb.snapshot(NAME)?.draft_commands ?? []) as Array<{
          local_id: string;
          command: object;
        }>
      ).find((row) => row.local_id === localId)?.command,
    snapshot: () => env.idb.snapshot(NAME),
    setSync(patch) {
      env.idb.seed(NAME, "sync_state", [{ ...world.sync(), ...patch }]);
    },
    capture(over = {}) {
      const s = world.sync();
      return service.capture(page.identity.epoch, {
        requestSeq: s.request_seq,
        ownershipToken: s.owner?.ownership_token ?? null,
        recoveryGeneration: s.recovery_generation,
        expectedPosition: s.cursor,
        ...over,
      });
    },
    input(spec, over = {}) {
      const text = typeof spec === "string" ? spec : pageJson(spec);
      const bytes = bytesOf(text);
      const scan = scanSyncPage(bytes);
      if (!scan.ok)
        throw new Error(`the test page does not scan: ${scan.reason}`);
      return {
        captured: world.capture(),
        bytes,
        scan,
        now: "2026-10-01T12:00:00.000Z",
        decode: {
          validators: createValueValidators(),
          derivers: createKeyDerivers(),
        },
        ...over,
      };
    },
    commit: (input) => service.commit(commitPage, input),
  };
  world.setSync({
    phase: options.phase ?? "delta",
    cache_status: options.cacheStatus ?? "valid",
    cursor: options.cursor === undefined ? "cursor-0" : options.cursor,
  });
  return world;
}

export { cacheRow, digestOf };
