import type { Identity, Store, Trace } from "../../session";
import { utf8Length } from "../model/outbox";
import {
  type DefaultsRecord,
  parseSharingSnapshot,
} from "../model/sharing-snapshot";
import type { AccountId, Captured, Epoch } from "../model/types";
import { readDefaults, writeDefaults } from "../plans/defaults";
import type { AccountService } from "./account-service";
import {
  followIdentity,
  type IdentityTaskDeps,
  type ReadResult,
  type TaskOutcome,
  unreadOutcome,
} from "./identity-task";
import type { QuotaGuard, QuotaReservation } from "./quota-guard";

/**
 * The sharing defaults of the displayed account (WEB-12a; B5): `GET /defaults/snapshot` through the stamped client, parsed strictly,
 * held in memory and, only when the account's database already exists, persisted as ONE record through W14 (`writeDefaults`). It
 * never opens, and so never creates, a database.
 *
 *  - DEMAND-DRIVEN. Nothing is asked until a screen uses the defaults (`use()`, which `useSharingDefaults` calls): no request is added to
 *    the boot path or to a page that never shows sharing. While used, it reads once per `(account, epoch)` inside the data layer's
 *    per-caller retry budget (caller `defaults`, plan 5.6), exactly as the profile read does. A page that never used it captures from
 *    the persisted record, or, with none, queues blocked on review: the safe direction (WEB-04 §5.7).
 *  - `refresh()` asks once more now (a person opened an editor or a review, or saved a change that moves the revision) and resolves to
 *    the outcome of THAT read. It is the person's act, so it is not counted in the budget and never repeats by itself.
 *  - `acquire(boundary)` is the refresh of a caller whose answer must be NEWER than a moment it marked with `boundary()`: a review that
 *    opened, a change that was just saved (WEB-12a review 2, R7). It shares a refresh under way only if that one was issued after the
 *    boundary; otherwise it issues its own (it never waits for the older one), and it resolves with the record ITS read fetched, so the
 *    caller shows and confirms exactly that snapshot. `refresh()` may share any read under way: it is for callers that only need one.
 *  - The record shown is the CURRENT identity's: from this page's own reads, or from the open database (written by this page earlier or
 *    by another). A late answer for an earlier `(account, epoch)` is dropped; a body that is not the contract's snapshot is an
 *    unrecognised answer, never persisted and never shown. Of two answers the one ASKED later stands (`issued_at`), here and in W14.
 *  - An answer belongs to the DATABASE BINDING it was asked under (WEB-12a review 4, R10). In the turn that asks, the read takes its
 *    context: the identity, this source's lifetime, the open service (or none) and that service's stamp (`capture`). The answer is shown,
 *    persisted (with that stamp, through that service) and returned only while all of them still stand: an answer asked before the
 *    database was deleted and opened again (a new incarnation), before its service ended or was replaced, or before the controller was
 *    stopped is no one's, and is asked again under the binding that stands. A read asked with no database open is kept in memory only,
 *    for as long as none is open; it is never written to one that opens later. What memory holds carries the same context, so it is not
 *    shown (nor captured from) once its binding is gone.
 */
export type RefreshOutcome = "fetched" | "failed" | "offline" | "closed";

/** A moment in this source's explicit reads, for one `(account, epoch)`: a read qualifies for it only if issued after it. Opaque. */
export interface RequestBoundary {
  readonly identity: string;
  readonly issued: number;
}

/** What `acquire` obtained: the record its qualifying read fetched, or why there is none. */
export type Acquisition =
  | { outcome: "fetched"; record: DefaultsRecord }
  | { outcome: "failed" | "offline" | "closed"; record: null };

export interface DefaultsSource {
  /** The displayed account's record, or null (none fetched, none persisted, no identity). */
  readonly record: Store<DefaultsRecord | null>;
  /** Whether a database or memory look for the current identity has finished (false while it is still being read). */
  readonly settled: Store<boolean>;
  /** One read now, for the current identity. Concurrent calls share the read under way. */
  refresh(): Promise<RefreshOutcome>;
  /** The current identity's boundary now (null: no identity): what `acquire` must answer from a read issued after. */
  boundary(): RequestBoundary | null;
  /**
   * One read issued AFTER `boundary`, for the identity it was taken for: shared with a refresh under way only if that one was issued
   * after it. `closed` if the identity is no longer the boundary's (or there is none), or moves before the answer is kept.
   */
  acquire(boundary: RequestBoundary | null): Promise<Acquisition>;
  /** A screen uses the defaults: while any does (and the source is started), the identity is followed. Returns the release. */
  use(): () => void;
  /** The controller's lifetime (`DataEnv.start`/`dispose`). Returns the stop. */
  start(): () => void;
}

export interface DefaultsSourceDeps
  extends Pick<
    IdentityTaskDeps,
    | "online"
    | "onOnline"
    | "onService"
    | "databasePending"
    | "timers"
    | "config"
  > {
  identity: Store<Identity | null>;
  /** `GET /defaults/snapshot` through `session.api.client("ordinary", account, epoch)`, classified. Absent: nothing is ever asked. */
  readSnapshot?(account: AccountId, epoch: Epoch): Promise<ReadResult<unknown>>;
  /** The OPEN service of an account, or null: this source never opens (and so never creates) a database. */
  service(account: AccountId): AccountService | null;
  /** The origin's quota guard: the record's growth is admitted as a cache write before it is committed (R28). */
  quota: Pick<QuotaGuard, "reserve">;
  clock: { now(): number; random?(): number };
  trace?: Trace;
}

class MutableStore<T> implements Store<T> {
  private listeners = new Set<() => void>();
  constructor(private value: T) {}
  get(): T {
    return this.value;
  }
  set(next: T): void {
    if (Object.is(next, this.value)) return;
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
 * Where a read was asked (R10): the identity, this source's lifetime and the database binding of the turn that asked, with the stamp
 * taken then. Its answer is the binding's only while `stands` says so.
 */
interface Context {
  readonly key: string;
  readonly account: AccountId;
  readonly epoch: Epoch;
  /** The source's lifetime (`start`/`stop`) when it was asked. */
  readonly lifetime: number;
  /** The open service it was asked under, or null: none was open (there is none, or the page has not finished looking for it). */
  readonly service: AccountService | null;
  /** The stamp of `service` taken with the request: the only one its answer is ever committed with (null without a service). */
  readonly captured: Captured | null;
  /** The binding as this source saw it: with no service, a database that opened since (even one that ended again) makes it obsolete. */
  readonly binding: number;
}

interface Held {
  context: Context;
  record: DefaultsRecord;
}

export function createDefaultsSource(deps: DefaultsSourceDeps): DefaultsSource {
  const held = new MutableStore<Held | null>(null);
  const settled = new MutableStore<boolean>(false);

  const current = (): Identity | null => deps.identity.get();
  const keyOf = (identity: Identity) =>
    `${identity.account_id}:${identity.epoch}`;

  // ---- the context of a read (R10) ---------------------------------------------------------------------------------------------------
  let lifetime = 0;
  /** Counts the changes of the binding this source has seen (any service, or none, that differs from the one seen before). */
  let binding = 0;
  let seen: AccountService | null = null;
  const bindingOf = (
    account: AccountId,
  ): { service: AccountService | null; at: number } => {
    const service = deps.service(account);
    if (service !== seen) {
      seen = service;
      binding += 1;
    }
    return { service, at: binding };
  };
  /** Taken synchronously in the turn that asks, before the request: never after its answer. */
  const contextOf = (identity: Identity): Context => {
    const { service, at } = bindingOf(identity.account_id);
    return {
      key: keyOf(identity),
      account: identity.account_id,
      epoch: identity.epoch,
      lifetime,
      service,
      captured: service === null ? null : service.capture(identity.epoch),
      binding: at,
    };
  };
  /**
   * Whether what was asked in `context` is still this page's to show, write or return: the same identity and lifetime, and the same
   * live service (or, asked with none, still none and no database opened since). A replacement service, of the same incarnation or not,
   * is never the authority for an answer asked before it existed.
   */
  const stands = (context: Context): boolean => {
    const identity = current();
    if (
      identity === null ||
      keyOf(identity) !== context.key ||
      context.lifetime !== lifetime
    )
      return false;
    const { service, at } = bindingOf(context.account);
    return context.service === null
      ? service === null && at === context.binding
      : service === context.service && service.live;
  };
  /** What a read whose context no longer stands reports: another identity's work is not this one's; the same identity asks again. */
  const obsolete = (context: Context): TaskOutcome => {
    const identity = current();
    return identity !== null && keyOf(identity) === context.key
      ? "quiet"
      : "wait";
  };

  /** Keeps `record` (whose context stands) unless what is held for the same identity still stands and was asked for later. */
  const offer = (context: Context, record: DefaultsRecord): void => {
    const now = held.get();
    if (
      now !== null &&
      now.context.key === context.key &&
      stands(now.context) &&
      now.record.issued_at > record.issued_at
    )
      return;
    held.set({ context, record });
  };

  const record: Store<DefaultsRecord | null> = {
    get() {
      const value = held.get();
      return value !== null && stands(value.context) ? value.record : null;
    },
    subscribe(listener) {
      const offs = [
        held.subscribe(listener),
        deps.identity.subscribe(listener),
        // A binding that ends or is replaced takes what was held under it out of view at once.
        deps.onService?.(listener) ?? (() => undefined),
      ];
      return () => {
        for (const off of offs) off();
      };
    },
  };

  /**
   * Writes a verified snapshot only if a database was open when it was ASKED, through that service and with the stamp taken then;
   * what is stored afterwards (it may be newer) is what is shown.
   */
  const persist = async (
    context: Context,
    fetched: DefaultsRecord,
  ): Promise<void> => {
    const { service, captured } = context;
    if (service === null || captured === null || !stands(context)) return;
    let reservation: QuotaReservation | null = null;
    let written = false;
    try {
      // A cache write: admitted before it is committed, and refused before any of the person's input would be (R28).
      reservation = await deps.quota.reserve(
        "cache",
        utf8Length(JSON.stringify(fetched)),
      );
      if (reservation.verdict === "refuse") return;
      // The admission took time: the binding the read was asked under may have ended or been replaced meanwhile (R10).
      if (!stands(context)) return;
      const lease = reservation;
      const out = await service.commit(writeDefaults, {
        captured,
        snapshot: fetched.snapshot,
        issuedAt: fetched.issued_at,
        now: fetched.fetched_at,
        leaseLive: () => lease.live(),
      });
      if (out.kind !== "applied") return;
      written = out.value.written;
      if (out.value.stored !== null && stands(context))
        offer(context, out.value.stored);
    } catch {
      // Not persisted: memory still holds the verified snapshot for this page.
    } finally {
      reservation?.settle(written ? "written" : "not_written");
    }
  };

  /** Reads the persisted record of the current identity's open database: shown, and the look settled, only while that binding stands. */
  const hydrate = async (identity: Identity): Promise<void> => {
    const context = contextOf(identity);
    const service = context.service;
    if (service === null) {
      if (deps.databasePending?.(identity.account_id) !== true)
        settled.set(true);
      return;
    }
    let stored: DefaultsRecord | null = null;
    try {
      stored = await service.store.run(readDefaults, {
        incarnationId: service.incarnationId,
      });
    } catch {
      // Nothing readable is persisted: the next read is the source.
    }
    // A look at a binding that ended or was replaced (or of an identity that moved) shows nothing and settles nothing: the look of the
    // binding that stands does.
    if (!stands(context)) return;
    if (stored !== null) offer(context, stored);
    settled.set(true);
  };

  /** One read, asked in `context`. The outcome classes are those of the retry table; nothing here retries. */
  const read = async (
    context: Context,
  ): Promise<{ outcome: TaskOutcome; fetched: DefaultsRecord | null }> => {
    if (deps.readSnapshot === undefined)
      return { outcome: "wait", fetched: null };
    const issuedAt = deps.clock.now();
    const result = await deps.readSnapshot(context.account, context.epoch);
    // The identity, the binding or the lifetime may have moved while the request was in flight: its answer is no one's (R10).
    if (!stands(context)) return { outcome: obsolete(context), fetched: null };
    if (result.kind !== "ok")
      return { outcome: unreadOutcome(result), fetched: null };
    const snapshot = parseSharingSnapshot(result.value);
    if (snapshot === null) {
      deps.trace?.emit("data.defaults_rejected");
      return { outcome: "unrecognised", fetched: null };
    }
    const fetched: DefaultsRecord = {
      format: 1,
      snapshot,
      fetched_at: deps.clock.now(),
      issued_at: issuedAt,
      epoch: context.epoch,
    };
    offer(context, fetched);
    await persist(context, fetched);
    // Its binding may have gone while it was admitted or committed: what memory holds of it is out of view, and it answers no one.
    if (!stands(context)) return { outcome: obsolete(context), fetched: null };
    return { outcome: "done", fetched };
  };

  /**
   * The explicit reads under way, each with its place in issue order. Several can run at once (a boundary that an earlier one predates
   * issues its own), and each removes only itself when it settles, whatever its outcome.
   */
  interface Refreshing {
    context: Context;
    issued: number;
    running: Promise<Acquisition>;
  }
  const refreshing = new Set<Refreshing>();
  let issued = 0;
  const closed: Acquisition = { outcome: "closed", record: null };

  /**
   * The latest explicit read under way for `identity` issued after `after` (any, without) whose context still stands, or a new one: a
   * read asked under a binding that has gone is never shared (R10).
   */
  const explicitRead = (
    identity: Identity,
    after: number | null,
  ): Promise<Acquisition> => {
    const key = keyOf(identity);
    let shared: Refreshing | null = null;
    for (const entry of refreshing)
      if (
        entry.context.key === key &&
        stands(entry.context) &&
        (after === null || entry.issued > after) &&
        (shared === null || entry.issued > shared.issued)
      )
        shared = entry;
    if (shared !== null) return shared.running;
    issued += 1;
    const context = contextOf(identity);
    const entry: Refreshing = {
      context,
      issued,
      running: Promise.resolve(closed),
    };
    entry.running = (async (): Promise<Acquisition> => {
      try {
        const { outcome, fetched } = await read(context);
        // Kept only while the identity and binding it was asked under stand: one that moved while it was persisted has no answer here.
        if (fetched !== null && stands(context))
          return { outcome: "fetched", record: fetched };
        return outcome === "wait" || !stands(context)
          ? closed
          : { outcome: "failed", record: null };
      } catch {
        return { outcome: "failed", record: null };
      } finally {
        refreshing.delete(entry);
      }
    })();
    refreshing.add(entry);
    return entry.running;
  };

  const refresh = async (): Promise<RefreshOutcome> => {
    const identity = current();
    if (identity === null || deps.readSnapshot === undefined) return "closed";
    if (!deps.online()) return "offline";
    return (await explicitRead(identity, null)).outcome;
  };

  const boundary = (): RequestBoundary | null => {
    const identity = current();
    return identity === null ? null : { identity: keyOf(identity), issued };
  };

  const acquire = async (
    after: RequestBoundary | null,
  ): Promise<Acquisition> => {
    const identity = current();
    if (
      after === null ||
      identity === null ||
      keyOf(identity) !== after.identity ||
      deps.readSnapshot === undefined
    )
      return closed;
    if (!deps.online()) return { outcome: "offline", record: null };
    return explicitRead(identity, after.issued);
  };

  /**
   * Memory belongs to ONE sign-in. Any change of `(account, epoch)` forgets it: what the next identity shows comes from its own reads
   * or its own database, so nothing this page held survives a sign-out (a confirmed deletion included) into a later sign-in.
   */
  let heldFor: string | null = null;
  const forgetOnChange = (): void => {
    const identity = current();
    const key =
      identity === null ? null : `${identity.account_id}:${identity.epoch}`;
    if (key === heldFor) return;
    heldFor = key;
    held.set(null);
    settled.set(false);
  };

  // ---- lifetime: following runs only while the controller is started AND a screen uses the defaults ------------------------------
  let started = false;
  let stopForgetting: (() => void) | null = null;
  let users = 0;
  let stopFollowing: (() => void) | null = null;

  const follow = (): (() => void) => {
    // The automatic read this follower completed, with the context it was asked in (R10).
    let completed: Context | null = null;
    const begin = () =>
      followIdentity({
        caller: "defaults",
        identity: deps.identity,
        online: deps.online,
        onOnline: deps.onOnline,
        service: deps.service,
        clock: deps.clock,
        ...(deps.onService ? { onService: deps.onService } : {}),
        ...(deps.databasePending
          ? { databasePending: deps.databasePending }
          : {}),
        ...(deps.timers ? { timers: deps.timers } : {}),
        ...(deps.config ? { config: deps.config } : {}),
        run: async (identity) => {
          const context = contextOf(identity);
          const { outcome } = await read(context);
          if (outcome === "done") completed = context;
          return outcome;
        },
      });
    let task = begin();
    let shownFor: string | null = null;
    let shownService: AccountService | null | undefined;
    const show = (): void => {
      const identity = current();
      if (identity === null) return;
      const service = deps.service(identity.account_id);
      if (service !== shownService) {
        shownService = service;
        // Another binding: its look has not finished yet.
        settled.set(false);
      }
      // The identity's automatic read was asked under a binding that has gone (its database ended or was replaced, or one opened where
      // there was none): what it found is out of view, so it is read again under the binding that stands, from that binding's own
      // budget, and only once the look for a database has finished (R10).
      if (
        completed !== null &&
        completed.key === keyOf(identity) &&
        !stands(completed)
      ) {
        completed = null;
        task.stop();
        task = begin();
      }
      void hydrate(identity);
    };
    const onIdentity = (): void => {
      const identity = current();
      const key =
        identity === null ? null : `${identity.account_id}:${identity.epoch}`;
      if (key === shownFor) return;
      shownFor = key;
      completed = null;
      // What was held is another identity's: it is not shown, and the new identity's look starts unsettled.
      settled.set(false);
      show();
    };
    const offs = [
      deps.identity.subscribe(onIdentity),
      deps.onService?.(show) ?? (() => undefined),
    ];
    onIdentity();
    return () => {
      task.stop();
      for (const off of offs) off();
    };
  };
  const reconsider = (): void => {
    const wanted = started && users > 0;
    if (wanted && stopFollowing === null) stopFollowing = follow();
    else if (!wanted && stopFollowing !== null) {
      stopFollowing();
      stopFollowing = null;
    }
  };

  return {
    record,
    settled,
    refresh,
    boundary,
    acquire,
    use() {
      users += 1;
      reconsider();
      let released = false;
      return () => {
        if (released) return;
        released = true;
        users -= 1;
        reconsider();
      };
    },
    start() {
      started = true;
      // A new lifetime: nothing asked in an earlier one answers, is shared with or writes for this one (R10).
      lifetime += 1;
      if (stopForgetting === null) {
        forgetOnChange();
        const offs = [
          deps.identity.subscribe(forgetOnChange),
          // Every change of the binding is seen as it happens, so a database that opens and ends again between two looks still counts.
          deps.onService?.(() => {
            const identity = current();
            if (identity !== null) bindingOf(identity.account_id);
          }) ?? (() => undefined),
        ];
        stopForgetting = () => {
          for (const off of offs) off();
        };
      }
      reconsider();
      return () => {
        started = false;
        lifetime += 1;
        stopForgetting?.();
        stopForgetting = null;
        reconsider();
        // What this lifetime held is no one's now.
        held.set(null);
      };
    },
  };
}
