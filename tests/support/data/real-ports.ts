import {
  createWriteFailureMarkers,
  type MarkerStorage,
} from "../../../src/data/engine/write-failure-marker";
import { accountDatabaseName } from "../../../src/data/model/schema";
import type {
  DraftRow,
  FormRecoveryRow,
  SyncStateRow,
} from "../../../src/data/model/types";
import { createAccountDatabasePort } from "../../../src/data/ports/account-database";
import { createPortsImpl } from "../../../src/data/ports/ports-impl";
import { createRegistry } from "../../../src/data/store/registry";
import type { DeletionPorts } from "../../../src/session/ports/deletion";
import { EPOCH_BASE } from "../session/env";
import type { World } from "../session/world";
import { FakeIdb } from "./fake-idb";
import { draftRow, recoveryRow } from "./rows";
import { FakeSyncBus } from "./sync-bus";

/**
 * The REAL data-layer ports (database, local work, wipe coordination) over the data layer's IndexedDB double, in the shape the
 * 08a fixture registers (`FixtureOptions.dataPorts`). The 08a fakes held "work" as a count and a digest per account; here the work
 * is real rows in the account's database, and the counts and digests are computed by the production code. Each port call is
 * recorded (`calls`) in the vocabulary the 08a regressions use (`delete:<account>`, `releaseFence:<account>`, ...).
 */
export class RealData {
  idb!: FakeIdb;
  bus!: FakeSyncBus;
  world!: World;
  readonly calls: string[] = [];
  readonly markerStorage = new Map<string, string>();
  /** Runs once after the next `setDraftFence` completes: work that changed after the person's confirmation. */
  afterSetDraftFence: (() => void) | null = null;
  /** Runs once when the wipe procedure announces the closure (step 3a): work that appeared before `closing` was written. */
  onBroadcastImminent: (() => void) | null = null;
  private idCounter = 0;

  private nextId(): string {
    this.idCounter += 1;
    return `00000000-0000-4000-8000-${String(this.idCounter).padStart(12, "0")}`;
  }

  attach(world: World): void {
    this.world = world;
    this.idb = new FakeIdb(world);
    this.bus = new FakeSyncBus(world);
  }

  readonly dataPorts = (page: {
    id: string;
    world: World;
  }): Omit<DeletionPorts, "ledger"> => {
    const id = page.id;
    const registry = createRegistry(`tab-${id}`);
    const storage: MarkerStorage = {
      get length() {
        return markerStorage.size;
      },
      key: (index) => [...markerStorage.keys()][index] ?? null,
      getItem: (key) => markerStorage.get(key) ?? null,
      setItem: (key, value) => {
        markerStorage.set(key, value);
      },
      removeItem: (key) => {
        markerStorage.delete(key);
      },
    };
    const markerStorage = this.markerStorage;
    const now = () => EPOCH_BASE + this.world.time;
    const database = createAccountDatabasePort({
      host: this.idb.hostForPage(id),
      registry,
      markers: createWriteFailureMarkers(storage, undefined, { ownSlot: 0 }),
      now,
    });
    const impl = createPortsImpl({
      openExisting: async (account) => {
        const opener = this.idb.openerForPage(id, createRegistry("port"));
        const opened = await opener.open(account, {
          create: false,
          single: true,
          incarnation: "unused",
        });
        return opened.kind === "opened" ? opened.store : null;
      },
      channel: this.bus.channelFor(id),
      registry,
      clock: {
        now,
        sleep: (ms) =>
          new Promise((resolve) => {
            this.world.schedule(
              "timer",
              id,
              { what: "sleep", ms },
              resolve,
              ms,
            );
          }),
      },
      ids: {
        uuid: () => this.nextId(),
      },
      graceMs: 0,
    });
    const record =
      <A extends unknown[], R>(name: string, fn: (...args: A) => R) =>
      (...args: A): R => {
        this.calls.push(`${name}:${String(args[0])}`);
        return fn(...args);
      };
    return {
      database: {
        exists: record("exists", (a: string) => database.exists(a)),
        readIncarnation: record("incarnation", (a: string) =>
          database.readIncarnation(a),
        ),
        closeOwnConnections: record("close", (a: string) =>
          database.closeOwnConnections(a),
        ),
        delete: record("delete", (a: string) => database.delete(a)),
      },
      localWork: {
        summarise: record("summarise", (a: string) =>
          impl.localWork.summarise(a),
        ),
      },
      coordination: {
        setDraftFence: record(
          "setDraftFence",
          async (a: string, op: string) => {
            const result = await impl.coordination.setDraftFence(a, op);
            const hook = this.afterSetDraftFence;
            this.afterSetDraftFence = null;
            hook?.();
            return result;
          },
        ),
        broadcastImminent: record(
          "broadcastImminent",
          (a: string, op: string) => {
            const hook = this.onBroadcastImminent;
            this.onBroadcastImminent = null;
            hook?.();
            impl.coordination.broadcastImminent(a, op);
          },
        ),
        waitForClosure: record("waitForClosure", (a: string, ms: number) =>
          impl.coordination.waitForClosure(a, ms),
        ),
        setClosing: record("setClosing", (a: string) =>
          impl.coordination.setClosing(a),
        ),
        liveDigest: record("liveDigest", (a: string) =>
          impl.coordination.liveDigest(a),
        ),
        liveCount: record("liveCount", (a: string) =>
          impl.coordination.liveCount(a),
        ),
        baselineDigest: record("baselineDigest", (a: string) =>
          impl.coordination.baselineDigest(a),
        ),
        releaseFence: record("releaseFence", (a: string, op: string) =>
          impl.coordination.releaseFence(a, op),
        ),
      },
    };
  };

  // ---- arranging and inspecting local data (never used by the code under test) ----------------------------------------------
  /** Creates the account's database with its singleton, as the data layer would, and `incarnation`. */
  async createAccountDb(account: string, incarnation: string): Promise<void> {
    const opener = this.idb.openerForPage("arrange", createRegistry("arrange"));
    const opened = await opener.open(account, {
      create: true,
      incarnation,
      single: true,
    });
    if (opened.kind === "opened") opened.store.close();
  }
  /** Removes the draft fence record as a writer that does not take the lock could (or as "Keep for now" does). */
  clearFence(account: string): void {
    const sync = this.sync(account);
    if (sync)
      this.idb.seed(accountDatabaseName(account), "sync_state", [
        { ...sync, draft_fence: null },
      ]);
  }
  hasDb(account: string): boolean {
    return this.idb.has(accountDatabaseName(account));
  }
  addDrafts(
    account: string,
    count: number,
    over: Partial<DraftRow> = {},
  ): DraftRow[] {
    const rows = Array.from({ length: count }, () =>
      draftRow({ account_id: account, ...over }),
    );
    this.idb.seed(accountDatabaseName(account), "drafts", rows);
    return rows;
  }
  addRecovery(account: string, over: Partial<FormRecoveryRow> = {}): void {
    this.idb.seed(accountDatabaseName(account), "form_recovery", [
      recoveryRow(over),
    ]);
  }
  drafts(account: string): number {
    return (this.idb.snapshot(accountDatabaseName(account))?.drafts ?? [])
      .length;
  }
  sync(account: string): SyncStateRow | undefined {
    return this.idb.peek(
      accountDatabaseName(account),
      "sync_state",
      "singleton",
    );
  }
  fenceOf(account: string): SyncStateRow["draft_fence"] {
    return this.sync(account)?.draft_fence ?? null;
  }
  deletes(): string[] {
    return this.calls.filter((call) => call.startsWith("delete:"));
  }
  callsOf(name: string, account: string): string[] {
    return this.calls.filter((call) => call === `${name}:${account}`);
  }
}
