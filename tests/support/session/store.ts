import {
  checkInvariants,
  envelopesPreserved,
} from "../../../src/session/model/invariants";
import { initialRecords } from "../../../src/session/model/records";
import type { AuthRecords } from "../../../src/session/model/types";
import {
  type AuthStore,
  type PendingTransaction,
  type Rmw,
  StoreError,
} from "../../../src/session/ports/store";
import type { World } from "./world";

/**
 * The IndexedDB double (plan 13.1). One shared store for the whole origin with EXPLICIT CREATION ORDER: a
 * transaction's body runs only when every earlier-created transaction has finished, and sees exactly their committed
 * effects (IndexedDB 2.7.2); commit is atomic; `complete` is delivered later (delay knob D0). Every body receives a
 * structured clone, so no page shares a live object. Faults are injectable per predicate.
 */
export type InjectMode =
  | "abort"
  | "error"
  | "quota"
  | "closed"
  /** Created and never committed; later transactions proceed (the model's "pending recording"). */
  | "pending"
  /** Created and never committed; later transactions are blocked behind it (a stuck transaction). */
  | "pending_blocking"
  /** Commits, but `complete` is never delivered to the page. */
  | "commit_then_lose_completion";

export interface TxInfo {
  page: string;
  label: string;
  durability: "strict" | "default";
  order: number;
}
export interface Injection {
  match: (tx: TxInfo) => boolean;
  mode: InjectMode;
  /** Apply to at most this many matching transactions (default: all). */
  times?: number;
}

interface Tx<T = unknown> extends TxInfo {
  body: (records: Readonly<AuthRecords>) => Rmw<T>;
  mode: InjectMode | null;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
  started: boolean;
  /** The page was destroyed and the test chose "abort": the transaction never runs. */
  dropped?: boolean;
}

export class SharedStore {
  records: AuthRecords = initialRecords();
  private queue: Tx[] = [];
  private running: Tx | null = null;
  /** A started transaction that will never finish (`pending_blocking`). */
  private stuck: Tx | null = null;
  private counter = 0;
  private injections: Injection[] = [];
  /** Invariant violations found at any commit (property P-F). */
  readonly violations: string[] = [];
  /**
   * The premise of the persistence hold (docs/session.md, revision 5): every change of `auth_state.settled` is made by a page that
   * holds `atlas-auth` EXCLUSIVELY. A harness that has a lock manager sets this; a commit that changes `settled` without it is a
   * violation, so every scenario of every matrix is also a check that no settlement can slip past a shared hold.
   */
  holdsSettlementLock: ((page: string) => boolean) | null = null;

  constructor(private readonly world: World) {}

  inject(injection: Injection): () => void {
    this.injections.push(injection);
    return () => {
      this.injections = this.injections.filter((entry) => entry !== injection);
    };
  }
  clearInjections(): void {
    this.injections = [];
  }

  private modeFor(info: TxInfo): InjectMode | null {
    for (const injection of this.injections) {
      if (injection.times !== undefined && injection.times <= 0) continue;
      if (injection.match(info)) {
        if (injection.times !== undefined) injection.times -= 1;
        return injection.mode;
      }
    }
    return null;
  }

  create<T>(
    page: string,
    body: (records: Readonly<AuthRecords>) => Rmw<T>,
    options: { durability?: "strict" | "default"; label?: string } | undefined,
  ): PendingTransaction<T> {
    const info: TxInfo = {
      page,
      label: options?.label ?? "unlabelled",
      durability: options?.durability ?? "default",
      order: ++this.counter,
    };
    const mode = this.modeFor(info);
    let resolve!: (value: T) => void;
    let reject!: (reason: unknown) => void;
    const complete = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    complete.catch(() => undefined);
    this.world.log({
      type: "store.create",
      page,
      label: info.label,
      order: info.order,
      mode,
    });
    if (mode === "pending") {
      // Never runs, never completes, and does not hold up later transactions.
      return { complete };
    }
    if (mode === "closed") {
      this.world.schedule(
        "D0",
        page,
        { label: info.label, tx: info.order },
        () => reject(new StoreError("closed")),
      );
      return { complete };
    }
    const tx: Tx<T> = {
      ...info,
      body,
      mode,
      resolve,
      reject,
      started: false,
    };
    this.queue.push(tx as Tx);
    this.kick();
    return { complete };
  }

  private kick(): void {
    if (this.running !== null || this.queue.length === 0) return;
    const head = this.queue[0] as Tx;
    this.running = head;
    // The body runs in a later task, never inside `transact`, so the caller's continuation always comes first.
    this.world.schedule(
      "store_start",
      null,
      { label: head.label, tx: head.order, txPage: head.page },
      () => {
        this.start(head);
      },
    );
  }

  private start(tx: Tx): void {
    this.queue.shift();
    tx.started = true;
    if (tx.dropped) {
      this.world.log({
        type: "store.dropped",
        page: tx.page,
        label: tx.label,
        order: tx.order,
      });
      this.running = null;
      this.kick();
      return;
    }
    if (tx.mode === "pending_blocking") {
      // Stuck: never finishes, so nothing behind it starts.
      this.world.log({
        type: "store.stuck",
        page: tx.page,
        label: tx.label,
        order: tx.order,
      });
      this.stuck = tx;
      return;
    }
    const finish = () => {
      this.running = null;
      this.kick();
    };
    if (tx.mode === "abort" || tx.mode === "error" || tx.mode === "quota") {
      const cause =
        tx.mode === "abort" ? "abort" : tx.mode === "quota" ? "quota" : "error";
      this.world.log({
        type: "store.fail",
        page: tx.page,
        label: tx.label,
        order: tx.order,
        cause,
      });
      this.world.schedule(
        "D0",
        tx.page,
        { label: tx.label, tx: tx.order },
        () => tx.reject(new StoreError(cause)),
      );
      finish();
      return;
    }
    const before = structuredClone(this.records.auth_state);
    const outcome = tx.body(structuredClone(this.records));
    let wrote = false;
    if (outcome.write) {
      const write = structuredClone(outcome.write);
      this.records = { ...this.records, ...write };
      wrote = true;
    }
    if (
      wrote &&
      this.holdsSettlementLock !== null &&
      JSON.stringify(before.settled) !==
        JSON.stringify(this.records.auth_state.settled) &&
      !this.holdsSettlementLock(tx.page)
    )
      this.violations.push(
        `${tx.label}#${tx.order}: settled changed while page ${tx.page} did not hold atlas-auth exclusively`,
      );
    if (wrote) {
      for (const violation of checkInvariants(this.records.auth_state))
        this.violations.push(`${tx.label}#${tx.order}: ${violation}`);
      for (const violation of envelopesPreserved(
        before,
        this.records.auth_state,
      ))
        this.violations.push(`${tx.label}#${tx.order}: ${violation}`);
    }
    this.world.log({
      type: "store.commit",
      page: tx.page,
      label: tx.label,
      order: tx.order,
      wrote,
      durability: tx.durability,
      result: outcome.result as unknown,
    });
    if (tx.mode !== "commit_then_lose_completion") {
      this.world.schedule(
        "D0",
        tx.page,
        { label: tx.label, tx: tx.order },
        () => tx.resolve(outcome.result),
      );
    }
    finish();
  }

  /**
   * A page is destroyed with transactions of its own not yet started: in `commit` mode they still run (the
   * specification is silent on whether a pending transaction commits at unload); in `abort` mode they are dropped.
   */
  destroyPage(page: string, pending: "commit" | "abort"): void {
    if (pending === "abort") {
      for (const tx of this.queue) if (tx.page === page) tx.dropped = true;
    }
    // A stuck transaction of the destroyed page is resolved either way: it commits (running its body once) or aborts.
    const stuck = this.stuck;
    if (stuck && stuck.page === page) {
      this.stuck = null;
      if (pending === "commit") {
        const outcome = stuck.body(structuredClone(this.records));
        if (outcome.write)
          this.records = { ...this.records, ...structuredClone(outcome.write) };
        this.world.log({
          type: "store.commit",
          page: stuck.page,
          label: stuck.label,
          order: stuck.order,
          wrote: !!outcome.write,
          durability: stuck.durability,
          result: outcome.result as unknown,
        });
      } else {
        this.world.log({
          type: "store.fail",
          page: stuck.page,
          label: stuck.label,
          order: stuck.order,
          cause: "abort",
        });
      }
      this.running = null;
      this.kick();
    }
  }
}

/** One page's handle to the shared store. */
export class FakeAuthStore implements AuthStore {
  constructor(
    private readonly shared: SharedStore,
    private readonly page: string,
  ) {}
  transact<T>(
    body: (records: Readonly<AuthRecords>) => Rmw<T>,
    options?: { durability?: "strict" | "default"; label?: string },
  ): PendingTransaction<T> {
    return this.shared.create(this.page, body, options);
  }
}
