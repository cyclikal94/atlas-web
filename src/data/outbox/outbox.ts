import type { Store } from "../../session";
import type { AccountService } from "../engine/account-service";
import type {
  DispatcherState,
  OutboxDispatcher,
} from "../engine/outbox-dispatcher";
import type { QuotaGuard, QuotaReservation } from "../engine/quota-guard";
import {
  LOCAL_WRITE_STOPS_STORE,
  type SyncChannel,
} from "../engine/sync-channel";
import type { SyncOwnership } from "../engine/sync-engine";
import {
  createLocalStops,
  recordStop,
  retireStops,
  type StopWitness,
  type WriteFailureMarkers,
  witnessStops,
} from "../engine/write-failure-marker";
import { DATA_CONFIG, type DataConfig } from "../model/config";
import {
  type EnqueueRequest,
  estimateDraftBytes,
  snapshotRequest,
  validateRequest,
} from "../model/outbox";
import type { QueueSummary } from "../model/queue-summary";
import { draftOperations, operationDraft } from "../model/retry";
import {
  confirmationPath,
  confirmationRequest,
  isReviewedDraft,
  type ReviewConfirmation,
} from "../model/review-confirmation";
import type { LocalId } from "../model/types";
import { readReviewDraft } from "../plans/defaults";
import { reconcileStaleFence } from "../plans/fence";
import {
  type ConflictPage,
  type DiscardResult,
  discardDraft,
  type EnqueueResult,
  editQueuedDraft,
  enqueueDraft,
  type LocalWriteRecord,
  type QueuePage,
  type Readmit,
  readConflicts,
  readLocalWriteStops,
  readQueuePage,
  readQueueSummary,
  supersedeDraft,
} from "../plans/outbox";
import { recordLocalWriteOutcome } from "../plans/retry-state";
import {
  isStoreFailure,
  type StoreFailure,
  type Watchable,
} from "../store/port";

/**
 * The outbox a feature slice talks to (plan 5.5.1): the GENERIC draft machinery. It knows endpoints, wire shapes and the store
 * rules; it does not know what any command means. A write the person makes is never refused by lifecycle state except by the
 * wipe's draft fence, the quota reserve, a latched database and a storage failure (matrix AMB-1), and a refusal is a typed result
 * the UI turns into "not saved": a failed local write is NEVER shown as saved, because the answer is the transaction's own
 * success (D:5298-5301).
 */
export type RefusalReason =
  | "fenced"
  | "closing"
  | "closed"
  | "no_base"
  | "quota"
  | "storage"
  | "identity_changed"
  /**
   * The request stated what its caller saw (`EnqueueRequest.observed`) and the resource has changed since: nothing was stored. The
   * caller reads the resource again and the person decides again (WEB-13a revision 2); it is never resubmitted on their behalf.
   */
  | "changed"
  /**
   * The request needs write access to a resource that this device last read as `can_edit: false` (`TargetSpec.requiresEdit`, WEB-10a
   * R30), as the writing transaction found it: nothing was stored. The server, not this device, grants access; a later read may.
   */
  | "denied";

export type EnqueueOutcome =
  | { kind: "queued"; localId: LocalId; createdSeq: number }
  | { kind: "refused"; reason: RefusalReason };

export type EditOutcome =
  | { kind: "edited"; localId: LocalId }
  | {
      kind: "refused";
      reason:
        | RefusalReason
        | "not_found"
        | "not_queued"
        | "retargeted"
        /** The request's `expectDraft` refused the draft as it is stored now: nothing was written. */
        | "draft_changed";
    };

export type DiscardOutcome =
  | {
      kind: "discarded";
      outcome: "removed" | "retained" | "dismissed";
      affected: number;
    }
  | {
      kind: "refused";
      reason:
        | "not_found"
        | "in_flight"
        | "acknowledged"
        | "dependant_in_flight"
        | "closed"
        | "storage"
        | "identity_changed";
    };

export type SupersedeOutcome =
  | { kind: "superseded"; localId: LocalId; paused: LocalId[] }
  | {
      kind: "refused";
      reason:
        | RefusalReason
        | "not_found"
        | "not_supersedable"
        /** The replacement's `localId` already names a draft (the old one's included): a replacement needs a fresh identity (R24). */
        | "key_in_use"
        /** The request's `expectDraft` refused the old draft as it is stored now: nothing was written. */
        | "draft_changed"
        /**
         * No order of the queue lets the replacement and the drafts around it all be sent (R45): it would have to wait for a newer draft
         * (or for one of its own dependants) while another draft waits for it, or it raises a version one of the old draft's dependants
         * counted. Nothing was changed: the old draft is still there, and the person can discard it or save the change as a new draft.
         */
        | "order_conflict";
    };

/**
 * The defaults review's confirmation (WEB-12a, D-12a-6). `confirmed`: the draft was edited in place (`edited`: it was queued and blocked
 * locally, never sent) or superseded by a new draft (`superseded`: it was sent and refused with `defaults_changed`), carrying the reviewed
 * revision and context and no review block. A refusal changed nothing: `not_reviewing` (the draft has no defaults review, or is no longer
 * queued or in flight), `rebuild_refused` (the versions it was built on have moved, or its body cannot be rebuilt generically: it is
 * reviewed from its own feature's screen), or a refusal of the edit or the supersession itself.
 */
export type ConfirmReviewOutcome =
  | {
      kind: "confirmed";
      how: "edited" | "superseded";
      localId: LocalId;
      paused: LocalId[];
    }
  | {
      kind: "refused";
      reason:
        | RefusalReason
        | "not_found"
        | "not_reviewing"
        | "rebuild_refused"
        | "not_queued"
        | "retargeted"
        | "not_supersedable"
        | "key_in_use"
        | "order_conflict"
        /** The draft is no longer the one the person reviewed (edited elsewhere, or its review changed): review it again. */
        | "draft_changed";
    };

export interface Outbox {
  enqueue(request: EnqueueRequest): Promise<EnqueueOutcome>;
  /** The body of a `queued` draft only; the change of anything else is a new draft. */
  editQueued(localId: LocalId, next: EnqueueRequest): Promise<EditOutcome>;
  discard(localId: LocalId): Promise<DiscardOutcome>;
  /**
   * New `local_id`, dependants retargeted (version-conflict supersession pauses them for review). The replacement's `localId` must be
   * FRESH: one that already names a draft is refused (`key_in_use`) without changing anything. A retry with the same `localId` after a
   * lost completion is recognised (the old draft is gone and the draft under the key is that replacement) and answers `superseded`
   * again, writing nothing.
   *
   * The replacement keeps the old draft's place in the queue unless it now waits for a draft that is newer than that place (a target it
   * did not have, now used by a later save): it then goes to the END of the queue, where its bases already put it, provided no dependant
   * of the old draft has to stay behind it. When no order keeps every draft sendable the answer is `refused / order_conflict` and nothing
   * is written (R45). A dependant is paused for review (`paused`) when the replacement leaves a different version from the one it assumed.
   */
  supersede(
    oldLocalId: LocalId,
    next: EnqueueRequest,
  ): Promise<SupersedeOutcome>;
  /**
   * The person confirmed the audience in the defaults review (WEB-12a): the draft's stored command is rebuilt with ONLY its top-level
   * `defaults_revision` replaced by the reviewed revision, its context replaced and its review block cleared, through `editQueued` (a draft
   * blocked locally) or `supersede` (a draft refused with `defaults_changed`; pass the same `replacementId` on a retry). It never rebuilds a
   * body on versions the draft was not built on. Nothing else unblocks a defaults review: a background fetch is not approval.
   */
  confirmDefaultsReview(
    localId: LocalId,
    confirmation: ReviewConfirmation,
  ): Promise<ConfirmReviewOutcome>;
  /**
   * "Retry now" for a paused draft or a blocked one; without an id, every paused draft. It also lifts the local-write stops of the
   * draft it names (its two operations, matched EXACTLY by id) or, without an id, of every draft, and permits another attempt: it
   * does not say anything was written. The storage warning stays while any other operation remains stopped (R47).
   */
  retry(localId?: LocalId): void;
  /** Exact counts by status, from the indexes (never the queue): what the chip, the tabs and the warning say. */
  readonly summary: Watchable<QueueSummary>;
  /**
   * The visible queue, ONE WINDOW at a time (Q9: 100 rows, further records through pagination). The window is the working set: it
   * is what is held and kept live, and moving to another window REPLACES it, so what is held does not grow with the windows visited
   * (R6). Nothing reads the rows until something subscribes to this, so a page that never shows the queue never loads it.
   */
  readonly queue: Watchable<QueuePage>;
  /** The next window of the queue replaces the one shown (a no-op when there is none). */
  showNext(): void;
  /** The previous window replaces the one shown (a no-op on the first). */
  showPrevious(): void;
  /** The drafts that need a decision, oldest first, a bounded page; loaded only while something subscribes. */
  readonly conflicts: Watchable<ConflictPage>;
  /** The dispatcher's state, plus whether the outbox's own writes have stopped being answered. */
  readonly state: Store<DispatcherState>;
  /**
   * `true` while any operation stands stopped: three consecutive durable failures of one save, or a stop recorded in the account's
   * fallback marker or held in this tab ("local storage isn't responding", manual "Try again"). It is DERIVED from those records
   * (R47), so it survives a reload, stays up while any other operation remains stopped, and ends only when none does.
   */
  readonly storageNotResponding: Store<boolean>;
  /**
   * `true` while that stop is held in this tab alone: neither the durable streak nor the account's fallback marker could record
   * it, so it will not survive a reload (the notice says so plainly).
   */
  readonly storageMemoryOnly: Store<boolean>;
  /** The dispatcher; the same leader as sync (WEB-09b supplies the ownership). */
  start(ownership: SyncOwnership): void;
  stop(): void;
  /**
   * Ends this facade's OBSERVATION of the stop records (R55, revision 36): the paced look that follows a look which could not read every
   * record, any look under way (it publishes nothing), and its subscriptions to the markers, the channel and the page's stops. Idempotent.
   * It is not `stop()` (which stops the dispatcher, and leaves a facade that is not the leader observing) and it closes nothing shared:
   * the service, the markers and the page's memory of stops belong to others. The end of the service ends the observation too. The
   * facade still saves after it; its warning then changes only with its own writes.
   */
  disposeObservation(): void;
}

export interface OutboxDeps {
  service: AccountService;
  quota: QuotaGuard;
  ids: { uuid(): string };
  clock: { iso(): string; now(): number };
  /** The session's fact about operations, for the stale-fence reconciliation (decision D-06). */
  fence(): { hasPendingOperation: boolean; sessionStarted: boolean };
  /** Absent on a page that is not the leader: the facade still saves, edits and discards; nothing is sent from here. */
  dispatcher?: OutboxDispatcher;
  channel?: SyncChannel;
  /**
   * The account's write-failure markers (`localStorage`) and, with them, the PAGE's memory of the stops that no store could hold. Every
   * writer of one page (this facade, any other facade, the dispatcher, and the controller that composes them) must be given the SAME
   * markers object, which is what makes a memory-only stop one stop for all of them (R46, revision 27). Absent: a stop that could not be
   * counted is held in the dispatcher's record when one is given, and otherwise in a record of this facade's own.
   */
  markers?: WriteFailureMarkers;
  config?: Partial<DataConfig>;
  /** The timers of the paced look after a look that could not read every record (R55, revision 36): the page's own when omitted. */
  timers?: {
    setTimeout(fn: () => void, ms: number): unknown;
    clearTimeout(handle: unknown): void;
  };
}

/** What a write took when it was issued (see `issue`). */
interface Issued {
  readonly seen: StopWitness;
  readonly failures: number;
  /**
   * The version of the durable failure that stood under each operation, as this facade had seen it when the act began (R53, revision
   * 32). Only the person's "Try again" uses it: its reset of a durable streak ends that failure and no other.
   */
  readonly durable: ReadonlyMap<string, number>;
}

/** How many times a write is admitted at the size it turned out to have before it is refused (see `admitted`). */
const SIZE_ROUNDS = 3;
/** Added to a size learned from a built command when its write is admitted again: another tab may move a base by a digit meanwhile. */
const SIZE_SLACK_BYTES = 1024;

const NOT_STARTED: Store<DispatcherState> = {
  get: () => ({ kind: "not_started" }),
  subscribe: () => () => undefined,
};

class Flag implements Store<boolean> {
  private listeners = new Set<() => void>();
  constructor(private value = false) {}
  get(): boolean {
    return this.value;
  }
  set(next: boolean): void {
    if (next === this.value) return;
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

/**
 * The visible queue as a watchable over ONE WINDOW: a cursor (the `created_seq` the window starts after) and the cursors of the
 * windows before it, which are numbers, not rows. Moving to the next or the previous window replaces the live query with one over the
 * other window, so the rows held, and the rows a change of the store re-reads, are one window's, however far the person has gone.
 * The underlying live query exists only while something is subscribed (the adapter starts it on the first listener).
 *
 * A window that has come to hold nothing (everything in it was sent or discarded meanwhile) while an earlier one exists falls back to
 * the previous window, and from the first to nothing, rather than showing an empty queue with a way back.
 */
function createPagedQueue(
  service: AccountService,
  pageSize: number,
): {
  watchable: Watchable<QueuePage>;
  showNext(): void;
  showPrevious(): void;
} {
  let after: number | null = null;
  const trail: Array<number | null> = [];
  const make = (): Watchable<QueuePage> =>
    service.store.watch(readQueuePage, {
      incarnationId: service.incarnationId,
      limit: pageSize,
      after,
    });
  let inner = make();
  let off: (() => void) | null = null;
  const listeners = new Set<() => void>();
  const notify = (): void => {
    for (const listener of [...listeners]) listener();
  };
  const attach = (): void => {
    off = inner.subscribe(() => {
      const state = inner.get();
      if (
        state.status === "ready" &&
        state.value.rows.length === 0 &&
        trail.length > 0
      ) {
        move(() => {
          after = trail.pop() ?? null;
        });
        return;
      }
      notify();
    });
  };
  const move = (change: () => void): void => {
    const active = listeners.size > 0;
    off?.();
    off = null;
    change();
    inner = make();
    if (active) attach();
    notify();
  };
  return {
    watchable: {
      get: () => inner.get(),
      subscribe(listener) {
        listeners.add(listener);
        if (listeners.size === 1) attach();
        return () => {
          listeners.delete(listener);
          if (listeners.size === 0) {
            off?.();
            off = null;
          }
        };
      },
    },
    showNext() {
      const state = inner.get();
      if (state.status !== "ready" || !state.value.more) return;
      const cursor = state.value.next;
      if (cursor === null) return;
      move(() => {
        trail.push(after);
        after = cursor;
      });
    },
    showPrevious() {
      if (trail.length === 0) return;
      move(() => {
        after = trail.pop() ?? null;
      });
    },
  };
}

export function createOutbox(deps: OutboxDeps): Outbox {
  const { service } = deps;
  const config = { ...DATA_CONFIG, ...deps.config };
  const pagedQueue = createPagedQueue(service, config.queueWorkingSet);
  const storage = new Flag(false);
  const memoryOnly = new Flag(false);
  /**
   * The saves whose last durable write failed here and whose failure state is not yet known to have ended (a retry reaches exactly
   * those, even below the stop's bound). It is bookkeeping and nothing more: the STOP is what the record, the markers and the page's
   * memory say, and a success ends it whether or not this facade saw the failure (R46).
   */
  const failed = new Set<string>();
  /**
   * What a write takes when it is ISSUED, and a success uses when its result is delivered (R50, revision 31): the stops that stand for
   * the operations the success will end, by instance (the page's memory and the markers), and how many failures this facade had
   * recorded. A stop recorded after the write was issued, by this facade, the dispatcher or another page, is a newer failure than any
   * state this write can have left behind, and its late result does not end it: the awaited result says that an earlier transaction
   * succeeded, not that the stop it finds now predates it.
   */
  let failureCount = 0;
  /** The count of this facade's failures at which each operation last failed. */
  const failedAt = new Map<string, number>();
  /**
   * The version of the durable failure that stands under each draft operation, as this facade last SAW it: from the transaction that
   * counted its own failure and from the last look at the records (R53, revision 32). A reset decided on it names that version, so it
   * ends that failure and no other: a newer failure, from this page or another, has a version of its own. An operation with no entry
   * is one this facade has not seen a failure of, and a reset decided on that ends nothing but an absent streak.
   */
  const observed = new Map<string, number>();
  const issue = (operations: readonly string[]): Issued => ({
    seen: witnessStops(deps.markers, stops, service, operations),
    failures: failureCount,
    durable: new Map(),
  });
  /**
   * The stops the page holds in memory alone are the PAGE's, not this facade's (R46, revision 27): the dispatcher and any other facade
   * write the same operations (`draft:<id>` is the save and the claim), so there is one record, shared through the markers. A
   * facade composed with a dispatcher and given no markers shares the dispatcher's; one with neither has a record of its own.
   */
  const stops =
    deps.markers?.stops ?? deps.dispatcher?.stops ?? createLocalStops();
  /** The announcer this facade is on the page's board (`LocalStops.announce`). */
  const self = {};
  /** The outbox's operations among those the page holds in memory (the dispatcher's own read of the queue is not a draft's). */
  const memoryDrafts = (): string[] =>
    stops
      .operations(service)
      .filter((operation) => operationDraft(operation) !== null);
  const showMemoryOnly = (): void => memoryOnly.set(memoryDrafts().length > 0);
  /**
   * The markers of the OUTBOX's operations (a draft's, a receipt's) that the account has now, and whether the read was complete. A read
   * that could not list the markers returns the ones this page has established and says it is not `known` (R47, revision 28): an operation
   * that is not in it may still carry a marker that nobody here has seen, so it is never read as "no marker".
   */
  const markedDrafts = (): { operations: string[]; known: boolean } => {
    const read = deps.markers?.inspect(service);
    return {
      operations: (read?.operations ?? [])
        .filter((operation) => operationDraft(operation) !== null)
        .sort(),
      known: read?.known ?? true,
    };
  };
  /**
   * What a read of those markers says, as this facade compares it: the operations AND whether the read was complete (R55, revision 36).
   * The same operations read completely and read from an enumeration that failed are two different observations: the second leaves the
   * facade unsure, and the first is what ends that.
   */
  const signatureOf = (read: {
    operations: string[];
    known: boolean;
  }): string => JSON.stringify([read.operations, read.known]);
  /**
   * What the last look this facade PUBLISHED saw of those markers (`null` before the first). A marker another tab sets or removes is heard
   * through the markers' feed, which names a KEY and so says nothing of what the key means to this facade: the facade looks again only
   * when its own operations' markers, or the completeness of their read, are not what that look saw. A marker for a page, a capture, an
   * invalidation or another account changes nothing it shows, and costs no look (R15: the cache gate's markers are the gate's, not the
   * outbox warning's). Only a look that publishes sets it: a read that a newer signal made obsolete, or a read made for "Try again",
   * says nothing of what is shown (R55, revision 36).
   */
  let marked: string | null = null;
  /**
   * What the markers' read of the look under way saw, while that look is the latest: the state the facade will publish unless something
   * changes. A marker event is news when the markers are not what THAT read saw (or, with no look under way, what the last published
   * look saw), so a change made after a look has read the markers and before it publishes is heard, and makes that look obsolete.
   */
  let reading: { look: number; signature: string } | null = null;

  /**
   * The operations whose stop a reload must restore: three durable failures, a fallback marker, or the page's memory. `known` is false
   * when ANY record that can hold a stop could not be read (the database, or the markers' enumeration), so what is found is not the
   * whole of what stands (R47, revision 28): the memory of the page alone is what can then be known, with the markers this page has
   * established. It changes nothing of the facade: its caller decides what to publish.
   */
  const stoppedOperations = async (
    /** Told, before anything is awaited, what the read saw of the markers. */
    seen?: (signature: string) => void,
  ): Promise<{
    operations: string[];
    known: boolean;
    /** The durable failures the read found (all of them, below the bound too), when it could be made. */
    records: LocalWriteRecord[] | null;
    /** What the read saw of the markers (`signatureOf`). */
    signature: string;
  }> => {
    const markers = markedDrafts();
    const signature = signatureOf(markers);
    seen?.(signature);
    const found = new Set<string>([...markers.operations, ...memoryDrafts()]);
    let known = markers.known;
    let records: LocalWriteRecord[] | null = null;
    try {
      records = await service.store.run(readLocalWriteStops, {
        incarnationId: service.incarnationId,
      });
      for (const record of records)
        if (record.streak >= config.localWritePauseAfter)
          found.add(record.operation);
    } catch {
      known = false;
    }
    return { operations: [...found], known, records, signature };
  };

  /**
   * The warning is DERIVED from every record of a stop (R47): the account's database, its fallback markers and the page's memory. A
   * look is made at the start, after a stop is lifted, after a success while it is shown or the facade is unsure, whenever another writer
   * says that a stop changed, and, paced, for as long as the last look could not read every record (`pace`, R55 revision 36); the latest
   * look decides (`looks`), so an older read never overrides a stop recorded since.
   *
   * What a look could not read it does not forget (R47, revisions 27 and 28). A record that cannot be read is UNKNOWN, not empty, and
   * that holds for EVERY record a stop can be in: the database, the markers' enumeration (a marker this page established stays
   * established; `markers.inspect`) and the page's memory (which cannot fail to read). The stops this page knew of stand until a read
   * establishes that they ended (or this page ends them), whatever else it reads or does in the meantime, so that "Try again" for one
   * operation, a save of another, an offline event or a hint never hides a stop that nothing has retired. It also never says recovered
   * on a read it could not make.
   */
  let looks = 0;
  /**
   * Whether the last look this facade published could NOT read every record (and, before any has, `true`): the facade is unsure, as at a
   * cold start, so every hint, announcement and success looks again (R47), and a paced look is due (`pace`). It follows each look both
   * ways (R55, revision 36): a later outage makes the facade unsure again, and a look that reads everything ends it, whether or not the
   * operations it found changed.
   */
  let unsure = true;
  /**
   * Whether ANY look of this facade has read every record (what `starting` said before revision 36, kept for the one decision that
   * rests on it): the person's "Try again" takes the warning down at once only on a page that has once known the whole of what stood, so
   * a cold start that could never read the records does not claim a recovery; a later outage does not take that back (R47).
   */
  let everKnown = false;
  /** The operations whose stop this page knows of: what the last look found, and what it has recorded since (R47). */
  let standing = new Set<string>();
  /**
   * The lifetime of this facade's observation (R55, revision 36): it ends with `disposeObservation` or with the service. A look begun
   * before its end publishes nothing, and nothing is read or scheduled after it. A facade made over a service that has ALREADY ended
   * (R59, revision 37) never observes: that end was announced before the facade could hear it, so it subscribes to nothing, reads
   * nothing and schedules nothing.
   */
  let observing = !service.ended;
  async function look(): Promise<void> {
    // Checked BEFORE the read as well as after it (R59, revision 37): a service that is no longer live has nothing to read.
    if (!observing || !service.live) return;
    looks += 1;
    const mine = looks;
    let read: Awaited<ReturnType<typeof stoppedOperations>>;
    try {
      read = await stoppedOperations((signature) => {
        reading = { look: mine, signature };
      });
    } catch {
      if (reading?.look === mine) reading = null;
      // A read that threw (rather than reporting what it could not read) is a read that could not be made: try again later.
      if (mine === looks && observing && service.live) pace(false);
      return;
    }
    if (reading?.look === mine) reading = null;
    // A look that a newer signal made obsolete (a stop recorded or announced, a marker that changed, the act of "Try again"), or whose
    // observation ended while it waited, publishes nothing: what follows it decides.
    if (mine !== looks || !observing || !service.live) return;
    const { operations, known, records, signature } = read;
    marked = signature;
    // What the read saw of the durable failures is what the facade has seen of them: an operation it does not list has none now.
    if (records !== null) {
      for (const operation of [...observed.keys()])
        if (operationDraft(operation) !== null) observed.delete(operation);
      for (const record of records)
        observed.set(record.operation, record.version);
    }
    // A look that could not read every record leaves the facade unsure, as it was at the start: what it found is kept, nothing it knew is
    // forgotten, and it looks again, paced, until a look reads everything (R55, revision 36). A hint, an announcement or a save of its own
    // looks again sooner.
    unsure = !known;
    if (known) everKnown = true;
    standing = known
      ? new Set(operations)
      : new Set([...standing, ...operations]);
    showMemoryOnly();
    if (standing.size > 0) storage.set(true);
    else if (known) storage.set(false);
    pace(known);
  }

  /**
   * The paced look after a look that could not read every record (R55, revision 36). Nothing notifies this facade when a record becomes
   * readable again: a `storage` event is another page's change, an access that was refused raises none when it is granted, and the
   * database says nothing when a transaction that failed would now succeed. So a facade that is unsure looks again by itself, at the pace
   * of the sync facts' re-read (`factsReadRetryMs` doubling to `factsReadRetryMaxMs`), until a look reads everything: a stop that stood
   * all along is then shown, and an absence is then established. One timer at most; a look that reads everything ends it and the pace
   * starts over, and a healthy facade schedules nothing. A signal does not postpone it. It reads the page's own storage only, sends
   * nothing, and is not "Try again": it ends no stop.
   */
  const setTimer =
    deps.timers?.setTimeout ??
    ((fn: () => void, ms: number): unknown => setTimeout(fn, ms));
  const clearTimer =
    deps.timers?.clearTimeout ??
    ((handle: unknown): void => clearTimeout(handle as never));
  let paceTimer: unknown = null;
  let paced = 0;
  const cancelPace = (): void => {
    if (paceTimer !== null) clearTimer(paceTimer);
    paceTimer = null;
  };
  function pace(known: boolean): void {
    if (known || !observing) {
      cancelPace();
      paced = 0;
      return;
    }
    if (paceTimer !== null) return;
    const wait = Math.min(
      config.factsReadRetryMaxMs,
      config.factsReadRetryMs * 2 ** Math.min(paced, 16),
    );
    paced += 1;
    paceTimer = setTimer(() => {
      paceTimer = null;
      if (observing && service.live) void reconcile();
    }, wait);
  }

  /**
   * Look again from the records, ONE look at a time however many ask (R55, revision 36: the start, a signal of another writer, the paced
   * look). The person's own acts (a success, "Try again") make a look of their own instead, which supersedes the one under way rather
   * than waiting behind a read that may be slow to be answered. A request made while a look is under way is
   * answered by a look begun after it, and the promise returned settles when that look has been made, so a caller that awaits it has a
   * current answer. A request that brings NEWS (`invalidate`: a stop recorded or ended by another writer of the page, the markers of this
   * facade's operations changed) also makes the look under way obsolete before it can publish, so an older read never takes down a stop
   * that was recorded since; a hint that only may matter (another tab's change of the database) does not, so a stream of hints cannot keep
   * every look from publishing.
   *
   * Another writer is heard only when that can make this facade wrong: a stop recorded (it may have one more to show), or one that ended
   * (it may be showing it). A database change another tab announced is heard while this facade shows or is unsure of a stop; otherwise
   * only one that names the record of durable stops (`LOCAL_WRITE_STOPS_STORE`, which a writer names when it records or ends one, R60) is
   * heard, because what this facade last read cannot say that no other page has recorded a stop since. Every other change is not heard.
   */
  let pass: Promise<void> | null = null;
  let again = false;
  const reconcile = (invalidate = false): Promise<void> => {
    showMemoryOnly();
    if (!observing) return Promise.resolve();
    if (invalidate) looks += 1;
    if (pass !== null) {
      again = true;
      return pass;
    }
    pass = passes();
    return pass;
  };
  /** The looks of one pass: the first, and one more for every request made while a look was under way. */
  async function passes(): Promise<void> {
    try {
      do {
        again = false;
        await look();
      } while (again && observing);
    } finally {
      // Always after `pass` was set: a look yields before it settles.
      pass = null;
    }
  }
  /** What this observation subscribed to, let go of when it ends. */
  const hearing: Array<() => void> = [];
  const disposeObservation = (): void => {
    if (!observing) return;
    observing = false;
    // A look under way publishes nothing, and nothing is asked again.
    looks += 1;
    again = false;
    cancelPace();
    for (const off of hearing.splice(0)) off();
  };
  // An observation that never began (R59, revision 37) subscribes to nothing: its service's end was announced before it could hear it.
  if (observing) {
    hearing.push(service.onEnd(disposeObservation));
    // Another tab's growth of the stores is part of the origin's usage: read the free space again before the next admission. What it
    // wrote may also have ended a stop this page shows, or recorded one (R60, revision 37): a change of the record of durable stops
    // (`LOCAL_WRITE_STOPS_STORE`, which a writer names when it records or ends one) is read whatever this facade shows, because what it
    // last read cannot say that no other page has recorded a stop since. Any other change is read only while a stop is shown or unsure.
    const stopListening = deps.channel?.subscribe((message) => {
      if (
        message.type !== "data_changed" ||
        message.account !== service.account
      )
        return;
      deps.quota.invalidate();
      if (storage.get() || unsure || standing.size > 0) void reconcile();
      else if (message.stores.includes(LOCAL_WRITE_STOPS_STORE))
        void reconcile();
    });
    if (stopListening) hearing.push(stopListening);
    const stopHearingMarkers = deps.markers?.subscribe((change) => {
      if (!observing || !change.touches(service.account)) return;
      const expected =
        reading !== null && reading.look === looks ? reading.signature : marked;
      if (signatureOf(markedDrafts()) === expected) return;
      void reconcile(true);
    });
    if (stopHearingMarkers) hearing.push(stopHearingMarkers);
    hearing.push(
      stops.subscribe((scope, from, news) => {
        if (
          from === self ||
          scope.account !== service.account ||
          scope.incarnationId !== service.incarnationId
        )
          return;
        if (
          (news.recorded?.length ?? 0) > 0 ||
          (news.ended ?? []).some((operation) => standing.has(operation))
        )
          void reconcile(true);
        else if (unsure) void reconcile();
        else showMemoryOnly();
      }),
    );
  }
  // Cold start: a stop recorded before a reload, or by a writer of this page, is shown again without waiting for the save to be
  // retried by some other trigger. Over a service that is no longer live a look publishes nothing and schedules nothing.
  showMemoryOnly();
  void reconcile();

  const identityChanged = (): boolean => !service.live;

  const changed = (): void => {
    deps.channel?.post({
      type: "data_changed",
      account: service.account,
      stores: ["drafts", "resource_versions"],
    });
  };

  /**
   * A durable stop was recorded here, or a durable failure this page saw was ended (R60, revision 37): the record in `sync_state` changed,
   * and no other page hears that from the database. Every other page of the account is told, and reads its own records (a hint, never
   * the record). A stop held in a fallback marker is heard through the markers' feed, and one held in this page's memory exists nowhere
   * another page could read it.
   */
  const stopsChanged = (): void => {
    deps.channel?.post({
      type: "data_changed",
      account: service.account,
      stores: [LOCAL_WRITE_STOPS_STORE],
    });
  };

  /** A stop was just recorded (in the record, a marker or the page's memory): the warning is up now, and no older look may take it down. */
  const stopped = (operation: string): void => {
    looks += 1;
    standing.add(operation);
    storage.set(true);
    showMemoryOnly();
    stops.announce(service, self, { recorded: [operation] });
    // A look that was outstanding was told it is out of date; the stop above is what this page knows, and what another writer ended
    // meanwhile is read again.
    void reconcile();
  };

  /** Maps a failed local write to a refusal; a failure that is not a quota counts toward the local-write streak. */
  async function refuse(
    failure: unknown,
    operation: string,
  ): Promise<"quota" | "closed" | "identity_changed" | "storage"> {
    const cause = isStoreFailure(failure)
      ? (failure as StoreFailure).cause
      : "error";
    if (cause === "closed")
      return identityChanged() ? "identity_changed" : "closed";
    if (cause === "quota") return "quota";
    failed.add(operation);
    failureCount += 1;
    failedAt.set(operation, failureCount);
    try {
      const result = await service.store.run(recordLocalWriteOutcome, {
        incarnationId: service.incarnationId,
        operation,
        outcome: { kind: "failure" },
      });
      // The service may have ended while the counter was being written (R56): what follows belongs to a lifetime that is over, and is
      // neither shown nor recorded. A stop it nonetheless COMMITTED is in the record all the same (a result is delivered only after its
      // transaction completed): the account's other pages are told, and read their own records (R60, revision 38). The hint carries
      // nothing of this page's authority, and nothing else of the act is done.
      if (!service.live) {
        if (result.stop) stopsChanged();
        return "identity_changed";
      }
      if (result.version !== null) observed.set(operation, result.version);
      if (result.stop) {
        stopped(operation);
        stopsChanged();
      }
    } catch {
      // The streak itself could not be written: stop at once, with no counting, and record the stop in the fallback marker of this
      // database's lifetime so a reload finds it. When that cannot be written either, the stop is held in the page's memory, where
      // the dispatcher finds it too, and says so. A callback that outlived its service records nothing (R56).
      const recorded = recordStop(
        deps.markers,
        service,
        operation,
        () => service.live,
        {
          hold: () => {
            stops.hold(service, operation);
          },
        },
      );
      if (recorded === "obsolete") return "identity_changed";
      stopped(operation);
    }
    return "storage";
  }

  /**
   * The operations' own write landed, or the person abandoned them (R46). The plan that wrote it ended their durable streaks in the
   * SAME transaction, whether or not this page ever saw them fail (a reload loses `failed`, not the record); what is left to end is
   * what the page keeps: its memory of them, whichever writer held it, and their fallback markers. Exactly the named operations end,
   * whatever else is stopped. The warning is then looked at again from the records (R47), so another operation's stop keeps it up,
   * and the page's other writers are told, so that the dispatcher releases a draft it was holding back and another facade takes its
   * warning down. A marker that cannot be removed is still a stop, and the next success or retry tries again.
   *
   * It ends the stops the write could have recovered and no others (R50, revision 31): the instances that stood when the write was
   * ISSUED (`issued`), however late its result is delivered. A stop recorded since, by this facade, by the dispatcher or by another
   * page, is a newer failure; the awaited result says that an earlier transaction succeeded and says nothing about it. A marker that
   * could not be read or named when the write was issued is not ended here (a success cannot show that it predates the write): the
   * person's "Try again" ends it.
   */
  async function ended(
    operations: readonly string[],
    issued: Issued,
    abandoned: readonly string[] = [],
  ): Promise<void> {
    const warned = storage.get();
    for (const operation of operations)
      if ((failedAt.get(operation) ?? 0) <= issued.failures) {
        failed.delete(operation);
        standing.delete(operation);
      }
    retireStops(deps.markers, stops, issued.seen, {
      operations: operations.filter((o) => !abandoned.includes(o)),
    });
    // The operations of a draft that was ABANDONED end whether or not their marker could be read: a stop of a draft that no longer
    // exists protects nothing, and nothing can be sent for it. (A marker that can be read is still ended only if it is the instance
    // that stood when the write was issued.)
    retireStops(deps.markers, stops, issued.seen, {
      operations: operations.filter((o) => abandoned.includes(o)),
      explicit: true,
    });
    showMemoryOnly();
    stops.announce(service, self, { ended: operations });
    // The act's own look, made now and superseding any look under way (never queued behind a read that is still to be answered).
    if (warned || unsure) await look();
  }

  /**
   * "Try again" for one operation: lifts its stop (its memory, its marker and its durable streak) and nothing of any other
   * operation. The durable streak is a write that can fail; the operation then stays in `failed` and in `standing`, and the record
   * still says it is stopped, so the warning does not claim a recovery that did not happen (R47) and the next retry tries the write
   * again.
   *
   * It lifts what the act saw and no more (R52 and R53, revision 32). The marker is ended by its exact key, whatever another page
   * wrote since and whether or not it can be read now. The durable streak is reset on the VERSION of the failure the act saw: a
   * failure recorded while the retry waited on another operation (or on its own transaction) has a version of its own, the reset
   * leaves it, and the operation stays stopped. A marker the act could not name when it began cannot be ended by it (the next retry,
   * made when a read lands, does).
   */
  async function lift(operation: string, issued: Issued): Promise<void> {
    const unnamed = issued.seen.stood.get(operation)?.marker.kind === "unread";
    retireStops(deps.markers, stops, issued.seen, {
      operations: [operation],
      explicit: true,
    });
    try {
      const result = await service.store.run(recordLocalWriteOutcome, {
        incarnationId: service.incarnationId,
        operation,
        outcome: {
          kind: "success",
          expect: issued.durable.get(operation) ?? null,
        },
      });
      if (!result.cleared) {
        // A failure the act did not see stands: the operation is still stopped, and says so.
        if (result.version !== null) observed.set(operation, result.version);
        return;
      }
      observed.delete(operation);
      // A durable failure the act saw has ended: another page that shows it reads its records again (R60, revision 37).
      if (issued.durable.has(operation)) stopsChanged();
      // What the act ended is bookkeeping about the failures it covered; a failure recorded since is a newer stop.
      if (!unnamed && (failedAt.get(operation) ?? 0) <= issued.failures) {
        failed.delete(operation);
        standing.delete(operation);
      }
    } catch {
      // Still recorded: it stays in `failed`, and in `standing` while a read cannot say it ended.
    }
  }

  /**
   * The quota reserve refuses a person's input LAST (plan 5.4.6). The write's own size is judged and held against the estimate
   * while it is in flight, and a write that lands makes the next check read the origin's free space again, so successive large
   * saves near exhaustion cannot all be admitted by one stale figure. EVERY path that grows the stores asks: enqueue, an edit
   * that replaces a body, and a supersession (which stores a new command).
   *
   * What is reserved is a BOUND on the write (R25, revision 12). The estimate is made before the transaction, and the bases a command
   * is built from are read inside it, so the estimate can be too small (a builder that needs its bases, an estimate that could not be
   * made). The plan therefore measures the command it really built against the bound and writes NOTHING when it is larger, saying how
   * large it is; the write is then admitted AGAIN at that size (plus a small slack, for a base that another tab moved by a digit), by
   * the same overlapping-reservation rule as any other, a bounded number of times. A command is never stored at a size smaller than the
   * one it was admitted at. `attempt` settles the reservation it is given.
   *
   * The reservation is a lease the guard keeps renewing, and the write may begin only while the hold stands (R28, revision 14): the
   * plan reads the reservation's `live()` in the step that decides what it writes, and a write whose hold has ended writes nothing and
   * comes back here to be admitted afresh, against everything that was admitted and written meanwhile. Every re-admission, for either
   * reason, spends one of the same bounded rounds.
   */
  async function admitted<T extends { kind: string }>(
    request: EnqueueRequest,
    localId: LocalId,
    attempt: (
      reservation: QuotaReservation,
      maxBytes: number,
    ) => Promise<T | Readmit>,
  ): Promise<T | { kind: "refused"; reason: "quota" }> {
    let bound = estimateDraftBytes(request, {
      localId,
      accountId: service.account,
    });
    for (let round = 1; ; round += 1) {
      const reservation = await deps.quota.reserve("input", bound);
      if (reservation.verdict === "refuse")
        return { kind: "refused", reason: "quota" };
      const result = await attempt(reservation, bound);
      if (result.kind !== "too_large" && result.kind !== "lease_lapsed")
        return result as T;
      if (round >= SIZE_ROUNDS) return { kind: "refused", reason: "quota" };
      if (result.kind === "too_large")
        bound = (result as { bytes: number }).bytes + SIZE_SLACK_BYTES;
    }
  }

  /** A fence that is stale (older than `fenceStaleMs`, no pending operation, session started) is reconciled once and the save retried. */
  async function reconcileFence(): Promise<boolean> {
    const context = deps.fence();
    try {
      const out = await service.store.run(reconcileStaleFence, {
        incarnationId: service.incarnationId,
        now: deps.clock.now(),
        staleMs: config.fenceStaleMs,
        hasPendingOperation: context.hasPendingOperation,
        sessionStarted: context.sessionStarted,
      });
      return out.cleared;
    } catch {
      return false;
    }
  }

  async function enqueue(given: EnqueueRequest): Promise<EnqueueOutcome> {
    // The request is copied before anything is awaited: what is validated is what is stored (R39, revision 22).
    const request = snapshotRequest(given);
    validateRequest(request);
    if (!service.live)
      return {
        kind: "refused",
        reason: identityChanged() ? "identity_changed" : "closed",
      };
    const localId = request.localId ?? deps.ids.uuid();
    const operation = `draft:${localId}`;
    return admitted<EnqueueOutcome>(
      request,
      localId,
      async (reservation, maxBytes) => {
        let written = false;
        const issued = issue([operation]);
        const run = (): Promise<EnqueueResult> =>
          service.store.run(enqueueDraft, {
            incarnationId: service.incarnationId,
            request,
            localId,
            accountId: service.account,
            now: deps.clock.iso(),
            maxBytes,
            leaseLive: () => reservation.live(),
          });
        try {
          let result = await run();
          if (result.kind === "refused" && result.reason === "fenced")
            if (await reconcileFence()) result = await run();
          if (result.kind === "too_large" || result.kind === "lease_lapsed")
            return result;
          if (result.kind === "invalid")
            throw new TypeError(
              `the save could not be built or measured as JSON: ${result.reason}`,
            );
          if (result.kind === "refused")
            return { kind: "refused", reason: result.reason };
          // A duplicate (a retry of a save whose completion was lost) adds nothing.
          written = result.kind === "queued" && !result.duplicate;
          await ended([operation], issued);
          changed();
          deps.dispatcher?.wake();
          return {
            kind: "queued",
            localId: result.localId,
            createdSeq: result.createdSeq,
          };
        } catch (error) {
          if (error instanceof TypeError) throw error;
          return { kind: "refused", reason: await refuse(error, operation) };
        } finally {
          reservation.settle(written ? "written" : "not_written");
        }
      },
    );
  }

  async function editQueued(
    localId: LocalId,
    given: EnqueueRequest,
  ): Promise<EditOutcome> {
    const next = snapshotRequest(given);
    validateRequest(next);
    if (!service.live)
      return {
        kind: "refused",
        reason: identityChanged() ? "identity_changed" : "closed",
      };
    const operation = `draft:${localId}`;
    return admitted<EditOutcome>(
      next,
      localId,
      async (reservation, maxBytes) => {
        let written = false;
        const issued = issue([operation]);
        const run = () =>
          service.store.run(editQueuedDraft, {
            incarnationId: service.incarnationId,
            localId,
            request: next,
            maxBytes,
            leaseLive: () => reservation.live(),
          });
        try {
          let result = await run();
          if (result.kind === "refused" && result.reason === "fenced")
            if (await reconcileFence()) result = await run();
          if (result.kind === "too_large" || result.kind === "lease_lapsed")
            return result;
          if (result.kind === "invalid")
            throw new TypeError(
              `the save could not be built or measured as JSON: ${result.reason}`,
            );
          if (result.kind === "refused")
            return { kind: "refused", reason: result.reason };
          written = true;
          await ended([operation], issued);
          changed();
          // A draft whose own stop this ended (the dispatcher's, which this page's warning does not show) may be sent again now.
          deps.dispatcher?.wake();
          return { kind: "edited", localId: result.localId };
        } catch (error) {
          if (error instanceof TypeError) throw error;
          return { kind: "refused", reason: await refuse(error, operation) };
        } finally {
          reservation.settle(written ? "written" : "not_written");
        }
      },
    );
  }

  async function discard(localId: LocalId): Promise<DiscardOutcome> {
    if (!service.live)
      return {
        kind: "refused",
        reason: identityChanged() ? "identity_changed" : "closed",
      };
    const issued = issue(draftOperations(localId));
    try {
      const result: DiscardResult = await service.store.run(discardDraft, {
        incarnationId: service.incarnationId,
        localId,
      });
      // A draft that is gone has no operation left either: its plan ended them with the refusal (R46).
      if (result.kind === "refused") {
        if (result.reason !== "not_found") return result;
        const { endedStreak = 0, ...refusal } = result;
        // A STOP among them is a change of the record of durable stops that no other answer of this act announces (no draft changed):
        // the account's other pages are told, and read their own records (R60, revision 38).
        if (endedStreak >= config.localWritePauseAfter) stopsChanged();
        await ended(draftOperations(localId), issued, draftOperations(localId));
        return refusal;
      }
      await ended(draftOperations(localId), issued, draftOperations(localId));
      changed();
      deps.dispatcher?.wake();
      return result;
    } catch (error) {
      const reason = await refuse(error, `draft:${localId}`);
      return {
        kind: "refused",
        reason: reason === "quota" ? "storage" : reason,
      };
    }
  }

  async function supersede(
    oldLocalId: LocalId,
    given: EnqueueRequest,
  ): Promise<SupersedeOutcome> {
    const next = snapshotRequest(given);
    validateRequest(next);
    if (!service.live)
      return {
        kind: "refused",
        reason: identityChanged() ? "identity_changed" : "closed",
      };
    const localId = next.localId ?? deps.ids.uuid();
    // A supersession stores a new command, so it grows the stores like an enqueue and is held to the same reserve.
    return admitted<SupersedeOutcome>(
      next,
      localId,
      async (reservation, maxBytes) => {
        let written = false;
        const issued = issue([
          `draft:${localId}`,
          ...draftOperations(oldLocalId),
        ]);
        const run = () =>
          service.store.run(supersedeDraft, {
            incarnationId: service.incarnationId,
            oldLocalId,
            request: next,
            localId,
            accountId: service.account,
            now: deps.clock.iso(),
            maxBytes,
            leaseLive: () => reservation.live(),
          });
        try {
          let result = await run();
          if (result.kind === "refused" && result.reason === "fenced")
            if (await reconcileFence()) result = await run();
          if (result.kind === "too_large" || result.kind === "lease_lapsed")
            return result;
          if (result.kind === "invalid")
            throw new TypeError(
              `the save could not be built or measured as JSON: ${result.reason}`,
            );
          if (result.kind === "refused")
            return { kind: "refused", reason: result.reason };
          // A retry of a supersession that had already been made wrote nothing.
          written = !result.duplicate;
          // The replacement's own success, and the abandonment of the draft it replaces (R46).
          await ended(
            [`draft:${localId}`, ...draftOperations(oldLocalId)],
            issued,
            draftOperations(oldLocalId),
          );
          changed();
          deps.dispatcher?.wake();
          return {
            kind: "superseded",
            localId: result.localId,
            paused: result.paused,
          };
        } catch (error) {
          if (error instanceof TypeError) throw error;
          return {
            kind: "refused",
            reason: await refuse(error, `draft:${localId}`),
          };
        } finally {
          reservation.settle(written ? "written" : "not_written");
        }
      },
    );
  }

  async function confirmDefaultsReview(
    localId: LocalId,
    confirmation: ReviewConfirmation,
  ): Promise<ConfirmReviewOutcome> {
    if (!service.live)
      return {
        kind: "refused",
        reason: identityChanged() ? "identity_changed" : "closed",
      };
    let found: Awaited<ReturnType<typeof readStoredForReview>>;
    try {
      found = await readStoredForReview(localId);
    } catch (error) {
      // A READ that failed is not a failed save: nothing is counted towards a stop.
      const closed =
        isStoreFailure(error) && (error as StoreFailure).cause === "closed";
      return {
        kind: "refused",
        reason: closed
          ? identityChanged()
            ? "identity_changed"
            : "closed"
          : "storage",
      };
    }
    if (found === null) return { kind: "refused", reason: "not_found" };
    const path = confirmationPath(found.draft);
    if (path === null) return { kind: "refused", reason: "not_reviewing" };
    // What the person reviewed must still be what is stored (and is checked again in the writing transaction, `expectDraft`).
    if (!isReviewedDraft(found.draft, confirmation.reviewed))
      return { kind: "refused", reason: "draft_changed" };
    const request = confirmationRequest(
      found.draft,
      found.command,
      new Map(found.basis),
      confirmation,
    );
    try {
      if (path === "edit") {
        const out = await editQueued(localId, request);
        return out.kind === "edited"
          ? { kind: "confirmed", how: "edited", localId, paused: [] }
          : out;
      }
      const out = await supersede(localId, request);
      return out.kind === "superseded"
        ? {
            kind: "confirmed",
            how: "superseded",
            localId: out.localId,
            paused: out.paused,
          }
        : out;
    } catch (error) {
      // The build refused the versions it was handed (they moved since the draft was made), or the body could not be rebuilt: nothing
      // was written, and the draft is reviewed from its own screen.
      if (error instanceof TypeError)
        return { kind: "refused", reason: "rebuild_refused" };
      throw error;
    }
  }

  function readStoredForReview(localId: LocalId) {
    return service.store.run(readReviewDraft, {
      incarnationId: service.incarnationId,
      localId,
    });
  }

  return {
    enqueue,
    editQueued,
    discard,
    supersede,
    confirmDefaultsReview,
    retry(localId) {
      // "Try again" lifts the stops of the operations it covers: those of this page's own saves, those the records name (read first: the
      // database, the markers and the page's memory, the dispatcher's included) and those the last look found, the two operations of
      // one draft matched EXACTLY by its id (R47). The warning is then derived again from what remains, so another draft's stop keeps it up;
      // the dispatcher resumes the drafts.
      const covers = (operation: string): boolean =>
        localId === undefined || operationDraft(operation) === localId;
      // The act begins NOW, and what stands now is what it lifts (R50, revision 31): the stops this page knows of, the markers and the
      // memory it can read, and the two operations of the draft the person names, whose marker may be one this page cannot read. A stop
      // recorded while the retry is under way (it waits on the database, one operation at a time) is newer than the person's
      // decision, and is not lifted by it.
      // The operations this page knew had failed when the person asked (not those it learns of while the retry is under way).
      const knew = [...failed, ...standing].filter(covers);
      const acted: Issued = {
        seen: witnessStops(
          deps.markers,
          stops,
          service,
          [
            ...failed,
            ...standing,
            ...memoryDrafts(),
            ...markedDrafts().operations,
            ...(localId === undefined ? [] : draftOperations(localId)),
          ].filter(covers),
        ),
        failures: failureCount,
        // The durable failures this facade has seen, as they stand now: the act's entitlement, which nothing learned later enlarges.
        durable: new Map(observed),
      };
      // Nothing else is known to stand: the person's "Try again" takes the warning down at once, as it always has. The look below
      // puts it back if a stop remains that this page did not know of (a clearing that could not be written, another tab's).
      if (everKnown && [...standing].every(covers)) {
        looks += 1;
        storage.set(false);
      }
      void (async () => {
        const restored = (await stoppedOperations()).operations;
        // The draft the person names may carry a marker that this page cannot list (a reload with the store unreadable, R47, revision
        // 29): nothing here has named it, so the act ends nothing of it (R52, revision 32: a record is ended by naming it, and what a
        // listing finds later may be a failure newer than the person's decision). The dispatcher holds the draft, and it goes when a
        // listing lands and finds nothing; one that finds a stop is lifted by the person's next retry like any other.
        const lifted: string[] = [];
        // What stood when the act began (the stops the page knew of) and what the records say now; a stop this page learned of since is
        // not in the first, and its memory and marker are not the act's to end.
        // Only what the act has a claim on: a stop recorded after it began (one the read finds now and the act never saw) is a newer
        // failure than the person's decision, and is not theirs to end (R53, revision 32).
        for (const operation of new Set([...knew, ...restored]))
          if (
            covers(operation) &&
            (acted.seen.stood.has(operation) || acted.durable.has(operation))
          ) {
            lifted.push(operation);
            await lift(operation, acted);
          }
        showMemoryOnly();
        stops.announce(service, self, { ended: lifted });
        await look();
      })();
      deps.dispatcher?.retry(localId);
    },
    summary: service.store.watch(readQueueSummary, {
      incarnationId: service.incarnationId,
    }),
    queue: pagedQueue.watchable,
    showNext: pagedQueue.showNext,
    showPrevious: pagedQueue.showPrevious,
    conflicts: service.store.watch(readConflicts, {
      incarnationId: service.incarnationId,
      limit: config.queueWorkingSet,
    }),
    state: deps.dispatcher?.state ?? NOT_STARTED,
    storageNotResponding: storage,
    storageMemoryOnly: memoryOnly,
    start: (ownership) => deps.dispatcher?.start(ownership),
    stop: () => deps.dispatcher?.stop(),
    disposeObservation,
  };
}
