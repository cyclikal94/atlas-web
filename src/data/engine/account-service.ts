import {
  type Identity,
  type Persistence,
  type PersistenceHold,
  type Store,
  type Trace,
  unrevokedHold,
} from "../../session";
import type { DropReason } from "../model/guards";
import type { AccountId, Captured, Epoch } from "../model/types";
import type { Guarded } from "../plans/builders";
import { publishEpochPlan } from "../plans/epoch";
import type { OpenOutcome } from "../store/open";
import {
  type AccountStore,
  isStoreFailure,
  type Plan,
  StoreFailure,
} from "../store/port";
import type { ConnectionRegistry } from "../store/registry";

/**
 * The per-account service (plan 5.2.2, guards G1 to G5) and the per-page runtime that owns them.
 *
 * "Check the stamp inside the atomic commit" cannot be literal here: `auth_state` lives in `atlas-auth`, the commit lives in
 * `atlas-<account>`, and IndexedDB transactions never span two databases. So the check is LAYERED, and the layer that is
 * authoritative is an ORDERING, not a read:
 *
 * - G1  the target database is chosen by the request's STAMPED account, never by `session.identity` at commit time;
 * - G2  a SYNCHRONOUS comparison with this page's identity immediately before the transaction is created (a hint-level check:
 *       this page's copy of another page's transition is never the authority);
 * - G5  THE PERSISTENCE HOLD (`session.persistence.hold`, docs/session.md obligation 4, revision 6): a shared `atlas-auth` lock
 *       plus the verdict at the durable record, kept until the data transaction has completed. Every settlement of the record is
 *       made under that lock held exclusively, so a transition is either seen by the verdict (the commit is refused, whatever this
 *       page has been told) or ordered after the commit has persisted. No notice or broadcast takes part. A hold that runs out is
 *       REVOKED, not merely released: the transaction is handed the hold's signal (the store aborts it wherever it is: queued,
 *       reading, applying), the decision refuses once the hold is invalid, and the lock is kept until the transaction has settled,
 *       with no deadline (a transaction that is already committing cannot be aborted, and from this page cannot be told from a
 *       durable one whose completion has not arrived). So a commit is `applied` only if its transaction completed while the lock
 *       was still held, and no settlement of the record can be ordered ahead of it;
 * - G3  inside the transaction (`checkGuards`): incarnation, closing, cursor compare-and-set, generation, ownership and the
 *       PUBLISHED EPOCH MIRROR, all read from the same database in the same transaction;
 * - G4  close-on-transition: when this page's identity leaves the account the service closes its connections synchronously,
 *       and when the epoch changes within the account it PUBLISHES the new epoch, so the first page that learns of it
 *       protects every page's later commits.
 *
 * What remains is stated in docs/data-layer.md and characterised by tests; the commit is never described as "inside the atomic
 * commit" of the record, because nothing can make it so.
 */
/**
 * Why a service ended: the page's identity left the account, the page closed it itself, or something else already latched the
 * account (a wipe, another tab's deletion or upgrade) and its latch is left exactly as it was.
 */
export type EndReason = "identity" | "closed" | "latched";

export type CommitOutcome<O> =
  | { kind: "applied"; value: O }
  | { kind: "dropped"; reason: DropReason }
  | { kind: "failed"; failure: StoreFailure };

export interface AccountService {
  readonly account: AccountId;
  readonly incarnationId: string;
  /** The raw store, for plans that are not response-derived (their own guard is the incarnation). */
  readonly store: AccountStore;
  /** True until the page's identity leaves the account or the service is closed. */
  readonly live: boolean;
  /**
   * True once the service has ENDED (R59, revision 37): its end has been announced to every `onEnd` listener it had, and it never lives
   * again. A listener added after that is never called, so a consumer handed a service late (an open's result delivered after a closure)
   * asks this rather than waiting for an end that has already happened. Not the same as `!live`, which is also true while the account is
   * latched for a service that has not ended.
   */
  readonly ended: boolean;
  /** The value a request carries from the moment it is issued to the moment its answer is committed. */
  capture(
    epoch: Epoch,
    extra?: Partial<Omit<Captured, "account" | "epoch" | "incarnationId">>,
  ): Captured;
  /** G1 + G2, then the plan's own G3. Never throws. */
  commit<I extends { captured: Captured }, R, O>(
    plan: Plan<I, R, Guarded<O>>,
    input: I,
  ): Promise<CommitOutcome<O>>;
  /** Observers of the end of the service (the identity left, or a connection closed). */
  onEnd(listener: (reason: EndReason) => void): () => void;
  /** Idempotent. */
  dispose(reason: EndReason): void;
}

/**
 * A persistence gate that orders nothing. It is for a page with no session record to order against (a test world, a fixture page
 * with a double of the session): production composition passes `session.persistence`, and a boundary test keeps it that way.
 */
export const unorderedPersistence: Persistence = {
  // Never revoked: there is no lock to run out of.
  hold: async () => unrevokedHold(),
};

export interface RuntimeDeps {
  /** `session.identity`: a FACT for consumers, never a permission. */
  identity: Store<Identity | null>;
  /** `session.persistence`: orders every response-derived commit against every settlement of the session record (G5). */
  persistence: Persistence;
  registry: ConnectionRegistry;
  /**
   * `abandoned` is true once the runtime has been disposed (R35). An implementation that honours it (`openAccountData`) starts no native
   * open for a disposed runtime and lets go of what it opened; one that does not is still safe, because the runtime releases the store
   * of any outcome that arrives after its disposal (below).
   */
  open(
    account: AccountId,
    options: { create: boolean; abandoned?: () => boolean },
  ): Promise<OpenOutcome>;
  trace?: Trace;
}

class Service implements AccountService {
  private finished = false;
  private readonly listeners = new Set<(reason: EndReason) => void>();
  /** The highest epoch of this account this page has published or seen. */
  lastEpoch: Epoch;
  constructor(
    readonly account: AccountId,
    readonly store: AccountStore,
    private readonly deps: RuntimeDeps,
    private readonly forget: () => void,
    epoch: Epoch,
  ) {
    this.lastEpoch = epoch;
  }

  get incarnationId(): string {
    return this.store.incarnationId;
  }
  get live(): boolean {
    return !this.finished && this.deps.registry.latch(this.account) === "open";
  }
  get ended(): boolean {
    return this.finished;
  }

  capture(
    epoch: Epoch,
    extra: Partial<Omit<Captured, "account" | "epoch" | "incarnationId">> = {},
  ): Captured {
    return {
      account: this.account,
      epoch,
      incarnationId: this.incarnationId,
      requestSeq: extra.requestSeq ?? null,
      ownershipToken: extra.ownershipToken ?? null,
      recoveryGeneration: extra.recoveryGeneration ?? 0,
      expectedPosition: extra.expectedPosition ?? null,
    };
  }

  async commit<I extends { captured: Captured }, R, O>(
    plan: Plan<I, R, Guarded<O>>,
    input: I,
  ): Promise<CommitOutcome<O>> {
    const { captured } = input;
    // G1: this service is the stamped account's, by construction. A request stamped with another account never reaches here.
    if (captured.account !== this.account)
      return this.drop("identity_changed", "g1");
    // G2: synchronous, a hint. It saves taking the lock for a commit this page already knows is stale; it is not the authority.
    const identity = this.deps.identity.get();
    if (
      identity === null ||
      identity.account_id !== captured.account ||
      identity.epoch !== captured.epoch
    )
      return this.drop("identity_changed", "g2");
    if (!this.live) return this.drop("closed", "latch");
    // G5: the authority. The hold is kept until the data transaction has completed (or failed), so no settlement of the session
    // record can be ordered between the verdict and the persistence.
    let hold: PersistenceHold;
    try {
      hold = await this.deps.persistence.hold(captured.account, captured.epoch);
    } catch {
      return this.drop("unverified", "g5");
    }
    if (hold.kind === "stale") return this.drop("identity_changed", "g5");
    if (hold.kind === "unavailable") return this.drop("unverified", "g5");
    try {
      // The wait for the hold took time: the account may have been closed on this page meanwhile.
      if (!this.live) return this.drop("closed", "latch");
      // The hold may have run out already (it is revoked at its bound, whatever this page is doing): the verdict is not vouched
      // for any longer, so nothing is started. Checked in the SAME synchronous step as the transaction is created and registered
      // (`track`), so a revocation cannot fall between them: either the check sees it, or the hold waits for this transaction.
      if (!hold.valid()) return this.drop("unverified", "g5");
      const running = this.store.run(
        this.withHoldCheck(plan, captured, hold),
        input,
        { signal: hold.revoked },
      );
      hold.track(running);
      const result = await running;
      if (result.kind === "dropped") return this.drop(result.reason, "g3");
      return { kind: "applied", value: result.value };
    } catch (error) {
      const failure = isStoreFailure(error) ? error : new StoreFailure("error");
      if (failure.cause === "closed") return this.drop("closed", "run");
      // The hold ran out and the transaction was abandoned (or refused to start): nothing of it is durable, and it is not a
      // failure of the store. The caller asks again, paced, and counts nothing.
      if (failure.cause === "abort" && !hold.valid())
        return this.drop("unverified", "g5_revoked");
      return { kind: "failed", failure };
    } finally {
      hold.release();
    }
  }

  /**
   * G2b: the same hint-level comparison as G2, made AGAIN at the moment the transaction body decides. A transaction created
   * before this page learnt of a same-account re-authentication can start after it (IndexedDB runs transactions in creation
   * order, and the epoch publication is created later), and only a comparison made inside the body sees that. It reads page
   * memory synchronously, inside the decision, so it adds no await. It is never the authority (G3 is).
   *
   * G5b: the hold's own validity, read at the same moment. The store aborts the transaction when the hold is revoked
   * (`RunOptions.signal`), and this is the second layer of the same rule, for a store that did not: a decision made after the
   * revocation writes nothing, and the streaming apply refuses to start, whatever the engine did with the queue. It is a
   * synchronous read of a flag the kernel sets in the same step as it fires the signal.
   */
  private withHoldCheck<I, R, O>(
    plan: Plan<I, R, Guarded<O>>,
    captured: Captured,
    hold: { valid(): boolean },
  ): Plan<I, R, Guarded<O>> {
    const current = (): boolean => {
      const identity = this.deps.identity.get();
      return (
        identity !== null &&
        identity.account_id === captured.account &&
        identity.epoch === captured.epoch
      );
    };
    const apply = plan.apply;
    return {
      ...plan,
      decide: (reads, input) => {
        if (!hold.valid())
          return {
            writes: [],
            result: { kind: "dropped", reason: "unverified" },
          };
        return current()
          ? plan.decide(reads, input)
          : {
              writes: [],
              result: { kind: "dropped", reason: "identity_changed" },
            };
      },
      ...(apply
        ? {
            apply: (sink, decision, reads, input, reader) => {
              if (decision.result.kind === "dropped")
                return Promise.resolve(decision.result);
              // Between the decision and the streaming apply the transaction has awaited its own writes: abandon it if the hold
              // has run out since (an `abort` of the transaction, so nothing already written is kept).
              if (!hold.valid()) throw new StoreFailure("abort");
              return apply(sink, decision, reads, input, reader);
            },
          }
        : {}),
    };
  }

  private drop<O>(reason: DropReason, stage: string): CommitOutcome<O> {
    // A drop writes NOTHING and changes no `auth_state` (matrix 3.7.3). The trace carries a fixed vocabulary only.
    this.deps.trace?.emit("data.commit_dropped", { reason, stage });
    return { kind: "dropped", reason };
  }

  onEnd(listener: (reason: EndReason) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  dispose(reason: EndReason): void {
    if (this.finished) return;
    this.finished = true;
    this.forget();
    // Latch FIRST and close SYNCHRONOUSLY: a plan that starts in this turn sees the latch and refuses.
    if (reason !== "latched")
      this.deps.registry.closeAll(this.account, {
        latch:
          reason === "identity" ? "closed_for_identity" : "closed_for_deletion",
      });
    this.store.close();
    for (const listener of [...this.listeners]) listener(reason);
    this.listeners.clear();
  }

  /** G4 (b): the epoch of this account changed. Best effort: a failure here is only a longer residual window. */
  async publish(epoch: Epoch): Promise<void> {
    if (epoch > this.lastEpoch) this.lastEpoch = epoch;
    try {
      const result = await this.store.run(publishEpochPlan, {
        incarnationId: this.incarnationId,
        epoch,
      });
      if (result.published)
        this.deps.trace?.emit("data.epoch_published", { epoch });
    } catch {
      // The window is longer for this account until the next page publishes; nothing else is lost.
    }
  }
}

export type RuntimeOpen =
  | { kind: "opened"; service: AccountService; created: boolean }
  | Exclude<OpenOutcome, { kind: "opened" }>;

/**
 * The per-page runtime: one service per open account, kept in step with `session.identity` (G4).
 *
 * DISPOSAL IS TERMINAL (R35, revision 20). `dispose()` ends every service, stops following the identity and the latches, and makes
 * the runtime refuse every later `open` with `abandoned`; it can never be undone, and a page that wants a runtime again builds a new
 * one (the provider does, on every start). An open that was PENDING when the runtime was disposed is part of the same lifetime: when
 * it finishes it installs no service, publishes no epoch and touches no latch, and it lets go of exactly the handles it opened
 * (`store.close()`, which closes that open's own two connections and removes only their entries from the page's registry). It never
 * calls `registry.closeAll`: the registry is the PAGE's, a healthy replacement runtime may have opened the same account since, and
 * a late completion of the old lifetime must not close the replacement's connections.
 *
 * AN OPEN HAS A LIFETIME TOO (R37, revision 21). It begins when `open` is asked and a closure of the account on the page (the registry's
 * `generation`: a wipe, another tab's deletion or upgrade, the identity leaving) ends it: the result of such an open is refused
 * `closed`, installs no service and leaves the latch as the closure set it. A NEW open begun after the closure is authorised afresh.
 */
export class DataRuntime {
  private readonly services = new Map<AccountId, Service>();
  private readonly unsubscribe: () => void;
  private readonly unlatch: () => void;
  private disposed = false;

  constructor(private readonly deps: RuntimeDeps) {
    this.unsubscribe = deps.identity.subscribe(() => this.follow());
    // A latch set from OUTSIDE the service (a wipe's `closeOwnConnections`, a `versionchange` from another tab's deletion or
    // upgrade, the wipe responder) ends the service too, so nothing keeps a handle to a database that is going away.
    this.unlatch = deps.registry.onLatch((account, latch) => {
      if (latch === "open") return;
      this.services.get(account)?.dispose("latched");
    });
  }

  /** The open service for an account, or null. Never the "current identity's": callers name the account they stamped. */
  serviceFor(account: AccountId): AccountService | null {
    const service = this.services.get(account);
    return service?.live ? service : null;
  }

  async open(
    account: AccountId,
    options: { create?: boolean } = {},
  ): Promise<RuntimeOpen> {
    if (this.disposed) return { kind: "refused", reason: "abandoned" };
    const existing = this.services.get(account);
    if (existing?.live)
      return { kind: "opened", service: existing, created: false };
    // This open's LIFETIME begins here (R37): a closure of the account on the page after this point ends it, whatever the opener did.
    const born = this.deps.registry.generation(account);
    const outcome = await this.deps.open(account, {
      create: options.create === true,
      abandoned: () => this.disposed,
    });
    if (outcome.kind !== "opened") return outcome;
    // R35: the runtime may have been disposed while the database was being opened. Whatever the open did, it belongs to a lifetime
    // that has ended: its own handles are let go (and only those: see the class comment), no service is installed and no epoch is
    // published. An implementation that did not look at `abandoned` is caught here.
    if (this.disposed) {
      outcome.store.close();
      return { kind: "refused", reason: "abandoned" };
    }
    // R37: a closure of the account (a wipe, another tab's deletion or upgrade, the identity leaving) may have ended this open while its
    // result was on its way. The result of an open that a closure ended is neither a service nor a reason to lift the latch: its own handles
    // are let go (and only those), and the latch stays as the closure set it. Checked here as well as in `openAccountData`, so an
    // implementation of `RuntimeDeps.open` that knows nothing of closures cannot undo one. It comes BEFORE the identity check: a logout
    // that latched the account must not have its latch replaced by the identity's.
    if (this.deps.registry.generation(account) !== born) {
      outcome.store.close();
      return { kind: "refused", reason: "closed" };
    }
    // The page's identity may have moved while the database was being opened: refuse to hand out a service for an account
    // the page has left (and close what was just opened).
    const identity = this.deps.identity.get();
    if (identity === null || identity.account_id !== account) {
      outcome.store.close();
      this.deps.registry.closeAll(account, { latch: "closed_for_identity" });
      return { kind: "refused", reason: "identity" };
    }
    // Another open of the same account, begun before this one finished, installed its service first: the runtime keeps ONE service
    // per account, so this open's duplicate store is let go (its own handles only) and the standing service is handed out.
    const standing = this.services.get(account);
    if (standing?.live) {
      outcome.store.close();
      return { kind: "opened", service: standing, created: outcome.created };
    }
    const service = new Service(
      account,
      outcome.store,
      this.deps,
      () => {
        if (this.services.get(account) === service)
          this.services.delete(account);
      },
      identity.epoch,
    );
    this.services.set(account, service);
    // G4 (b): whichever page first learns of an epoch protects every page's later commits.
    void service.publish(identity.epoch);
    return { kind: "opened", service, created: outcome.created };
  }

  /** G4: keep every service in step with the page's identity. Synchronous: closing cannot wait for a microtask. */
  private follow(): void {
    const identity = this.deps.identity.get();
    for (const service of [...this.services.values()]) {
      if (identity === null || identity.account_id !== service.account) {
        service.dispose("identity");
      } else if (identity.epoch > service.lastEpoch) {
        void service.publish(identity.epoch);
      }
    }
  }

  /** Ends every service (the page is going away, or a test is over). Terminal and idempotent: see the class comment. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribe();
    this.unlatch();
    for (const service of [...this.services.values()])
      service.dispose("closed");
  }
}
