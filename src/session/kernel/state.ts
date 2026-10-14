import type { SessionConfig } from "../constants";
import { EMPTY_MEMORY, type NeutralMemory } from "../model/neutral-state";
import type {
  AccountId,
  AuthRecords,
  AuthState,
  ClosedReason,
  Epoch,
  LeaseId,
  OperationId,
} from "../model/types";
import type { ConsentTicket, Identity, SessionView } from "../model/view";
import type { Clock, Ids } from "../ports/clock";
import type { DeletionPorts } from "../ports/deletion";
import type { HintChannel } from "../ports/hints";
import type { LockHandle, LockPort } from "../ports/locks";
import type { PageEnv } from "../ports/page";
import type { AuthStore, Rmw } from "../ports/store";
import type { ProtectedSurface } from "../ports/surface";
import type { Trace } from "../ports/trace";
import type { IssueTransport, UnstampedApi } from "../ports/transport";
import type { Activity, ActivityState, CancelReason } from "./types";

/** Everything the kernel touches outside itself. The fake world and the browser each supply one of these. */
export interface SessionPorts {
  store: AuthStore;
  locks: LockPort;
  hints: HintChannel;
  clock: Clock;
  ids: Ids;
  page: PageEnv;
  surface: ProtectedSurface;
  transport: IssueTransport;
  unstamped: UnstampedApi;
  deletion: DeletionPorts;
  trace: Trace;
}

/** A tiny observable used for the public stores. */
export class MutableStore<T> {
  private listeners = new Set<() => void>();
  constructor(private value: T) {}
  get = (): T => this.value;
  set(next: T): void {
    if (Object.is(next, this.value)) return;
    this.value = next;
    for (const listener of [...this.listeners]) listener();
  }
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
}

export type DisplayState =
  | { kind: "gated" }
  | { kind: "displaying"; account: AccountId; epoch: Epoch };

/** The concrete activity. `n` is the page-local identity that is never reused (Ex5). */
export class ActivityImpl implements Activity {
  state: ActivityState = "COVERING";
  m: LeaseId | null = null;
  leaseHandle: LockHandle | null = null;
  issueHandle: LockHandle | null = null;
  /** Set by `cancel` for the audit trail. */
  cancelReason: CancelReason | null = null;
  /** Every cover iteration's lease id, so the audit can find each one. */
  readonly leases: LeaseId[] = [];
  private readonly controller = new AbortController();
  constructor(
    readonly n: number,
    readonly kind: "exposure" | "request",
    readonly klass: Activity["klass"],
    readonly account: AccountId,
    readonly epoch: Epoch,
    private readonly onCancel: (
      activity: ActivityImpl,
      reason: CancelReason,
    ) => void,
  ) {}
  get signal(): AbortSignal {
    return this.controller.signal;
  }
  get terminal(): boolean {
    return (
      this.state === "CANCELLED" ||
      this.state === "ENDED" ||
      this.state === "ACTED"
    );
  }
  abortWaits(): void {
    if (!this.controller.signal.aborted) this.controller.abort();
  }
  cancel(reason: CancelReason): void {
    this.onCancel(this, reason);
  }
}

/** Page-local, memory-only state (matrix 3.6.2 Terms). Never persisted, never read by another page. */
export class PageMemory {
  closing = 0;
  exposure: ActivityImpl | null = null;
  readonly unsent = new Map<AccountId, Set<ActivityImpl>>();
  readonly holds = new Map<AccountId, Set<string>>();
  readonly released = new Set<LeaseId>();
  /** Issue locks (ordinary and recovery requests of other pages) that have been granted to this page. */
  readonly releasedIssue = new Set<LeaseId>();
  display: DisplayState = { kind: "gated" };
  /** The account whose protected tree is mounted in this page (possibly inert behind the level-0 gate). */
  mountedAccount: AccountId | null = null;
  /** Where this page last decided a foreign lease was unresolved, so the flag is re-derived after a new settlement. */
  unresolvedKnownFor: { account: AccountId; epoch: Epoch } | null = null;
  activitySeq = 0;
  /** Numbers the release checks of this page (`checkAtTheRecord`), so the trace can pair a check with its release. */
  responseChecks = 0;
  /** Numbers the decodes a public call has finished (`sealResult`), so the trace can pair a final check with the decode it follows. */
  decodes = 0;
  /** CSRF tokens tagged (account, epoch); memory only. */
  readonly csrf = new Map<string, string>();
  /** Foreign request leases this page knows of, for the displaying page's watch. */
  readonly knownForeign = new Set<LeaseId>();
  readonly watching = new Set<LeaseId>();
  /**
   * The renewed-consent prompt this page is showing (page memory only). The view carries its opaque ticket; the account,
   * the operation and the consent digest stay here, so a choice is applied to exactly the prompt the person saw.
   */
  consentPrompt: {
    ticket: ConsentTicket;
    account: AccountId;
    operationId: OperationId;
    digest: string | null;
  } | null = null;
  /** This page's copy of the settled identity, as of its last read. The act guard checks it (Ex5). */
  settled: { account: AccountId; epoch: Epoch; sessionId: string } | null =
    null;

  constructor(readonly bootId: string) {}

  csrfKey = (account: AccountId, epoch: Epoch): string => `${account}|${epoch}`;
  hasHold = (account: AccountId): boolean =>
    (this.holds.get(account)?.size ?? 0) > 0;
  addHold(account: AccountId, id: string): void {
    let set = this.holds.get(account);
    if (!set) {
      set = new Set();
      this.holds.set(account, set);
    }
    set.add(id);
  }
  releaseHold(account: AccountId, id: string): void {
    const set = this.holds.get(account);
    if (!set) return;
    set.delete(id);
    if (set.size === 0) this.holds.delete(account);
  }
  register(activity: ActivityImpl): void {
    if (activity.kind === "request") {
      if (activity.klass === "ordinary" || activity.klass === "recovery") {
        let set = this.unsent.get(activity.account);
        if (!set) {
          set = new Set();
          this.unsent.set(activity.account, set);
        }
        set.add(activity);
      }
    } else {
      this.exposure = activity;
    }
  }
  unregister(activity: ActivityImpl): void {
    if (activity.kind === "request") {
      const set = this.unsent.get(activity.account);
      set?.delete(activity);
      if (set && set.size === 0) this.unsent.delete(activity.account);
    } else if (this.exposure === activity) {
      this.exposure = null;
    }
  }
}

/**
 * The seams that would otherwise make the kernel modules import each other in a cycle. `session.ts` (the
 * composition root) assigns the real implementations; the defaults do nothing so a module can be tested alone.
 */
export interface KernelHooks {
  /** Synchronous: this page stops displaying the account (unmount, neutral state). */
  closeDisplay(account: AccountId, cause: string): void;
  /** Re-read the record and decide what this page should show. Single flight. */
  evaluate(reason: string): void;
  startCredentialVerification(account: AccountId, epoch: Epoch): void;
  /** The level-0 gate aborts an in-flight `activate` in the same task (matrix 3.4 step 3). */
  abortActivation(): void;
  /** Called after every read of the record, with what it showed, so attempts, operations and recovery can react. */
  onRecord(records: AuthRecords): void;
  /** Obtain this page's own CSRF token for (account, epoch) from a leased verification. */
  ensureCsrf(account: AccountId, epoch: Epoch): Promise<boolean>;
  verifyUnresolved(
    account: AccountId,
    epoch: Epoch,
    unresolved: ReadonlySet<LeaseId>,
  ): Promise<"ran" | "in_flight">;
  closeFromCover(
    account: AccountId,
    outcome:
      | { kind: "CLOSED"; reason: ClosedReason; record?: AuthState }
      | {
          kind: "CLOSED_UNRESOLVED";
          unresolved: ReadonlySet<LeaseId>;
          record?: AuthState;
        },
  ): void;
}

const noopHooks: KernelHooks = {
  closeDisplay() {},
  evaluate() {},
  startCredentialVerification() {},
  abortActivation() {},
  onRecord() {},
  async ensureCsrf() {
    return false;
  },
  async verifyUnresolved() {
    return "ran" as const;
  },
  closeFromCover() {},
};

/** The shared context every kernel module receives. */
export class Kernel {
  readonly memory: PageMemory;
  disposed = false;
  readonly cleanups: Array<() => void> = [];
  /** Wakes every sleeping retry loop early (an `online` event or a user retry). */
  private nudgers = new Set<() => void>();
  /** The record as last read by this page: a hint for the view, NEVER a permission. */
  lastRecord: AuthState | null = null;
  hooks: KernelHooks = noopHooks;
  readonly view = new MutableStore<SessionView>({ kind: "booting" });
  readonly identity = new MutableStore<Identity | null>(null);
  readonly notices = new MutableStore<
    readonly { id: string; kind: "remained_signed_in" }[]
  >([]);
  neutral: NeutralMemory = { ...EMPTY_MEMORY };

  constructor(
    readonly ports: SessionPorts,
    readonly config: SessionConfig,
  ) {
    this.memory = new PageMemory(ports.page.bootId);
  }

  get bootId(): string {
    return this.memory.bootId;
  }
  emit(event: string, data?: Record<string, unknown>): void {
    this.ports.trace.emit(event, data);
  }

  /** Sleep on the clock; resolves early on a nudge. Resolves `false` when nudged, `true` when the time elapsed. */
  sleep(ms: number, signal?: AbortSignal): Promise<boolean> {
    return new Promise((resolve) => {
      let done = false;
      const finish = (value: boolean) => {
        if (done) return;
        done = true;
        this.ports.clock.clearTimeout(timer);
        this.nudgers.delete(nudge);
        signal?.removeEventListener("abort", abort);
        resolve(value);
      };
      const nudge = () => finish(false);
      const abort = () => finish(true);
      const timer = this.ports.clock.setTimeout(() => finish(true), ms);
      this.nudgers.add(nudge);
      signal?.addEventListener("abort", abort, { once: true });
    });
  }
  nudge(): void {
    for (const nudge of [...this.nudgers]) nudge();
  }
  backoff(attempt: number): number {
    return Math.min(
      this.config.backoffInitialMs * 2 ** attempt,
      this.config.backoffMaxMs,
    );
  }

  /**
   * Race a promise against the stall interval. Resolves the string "stalled" when no answer came in time.
   *
   * The bound is HARD (matrix §3.6.2 step 1, Ex5; WEB-08c R4 of the review of 11 October 2026): whichever the page observes first decides.
   * An answer delivered after the bound's timer has run is late, however close it was due; a later completion never revives the activity
   * the caller has already ended (an ordinary cover is then not sent, a recording is retried). No grace, and nothing is backdated from a
   * requested timer delay.
   */
  async withStall<T>(work: Promise<T>, ms: number): Promise<T | "stalled"> {
    return new Promise<T | "stalled">((resolve, reject) => {
      const timer = this.ports.clock.setTimeout(() => resolve("stalled"), ms);
      work.then(
        (value) => {
          this.ports.clock.clearTimeout(timer);
          resolve(value);
        },
        (error) => {
          this.ports.clock.clearTimeout(timer);
          reject(error);
        },
      );
    });
  }

  /** Run one store transaction; resolves its result, rejecting on failure. */
  transact<T>(
    body: (records: Readonly<AuthRecords>) => Rmw<T>,
    label: string,
    strict = true,
  ): Promise<T> {
    return this.ports.store.transact(body, {
      durability: strict ? "strict" : "default",
      label,
    }).complete;
  }
}
