import type { Identity, Store, Trace } from "../../session";
import { utf8Length } from "../model/outbox";
import {
  type DefaultsRecord,
  parseSharingSnapshot,
} from "../model/sharing-snapshot";
import type { AccountId, Epoch } from "../model/types";
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
 *  - The record shown is the CURRENT identity's: from this page's own reads, or from the open database (written by this page earlier or
 *    by another). A late answer for an earlier `(account, epoch)` is dropped; a body that is not the contract's snapshot is an
 *    unrecognised answer, never persisted and never shown. Of two answers the one ASKED later stands (`issued_at`), here and in W14.
 */
export type RefreshOutcome = "fetched" | "failed" | "offline" | "closed";

export interface DefaultsSource {
  /** The displayed account's record, or null (none fetched, none persisted, no identity). */
  readonly record: Store<DefaultsRecord | null>;
  /** Whether a database or memory look for the current identity has finished (false while it is still being read). */
  readonly settled: Store<boolean>;
  /** One read now, for the current identity. Concurrent calls share the read under way. */
  refresh(): Promise<RefreshOutcome>;
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

interface Held {
  account: AccountId;
  record: DefaultsRecord;
}

export function createDefaultsSource(deps: DefaultsSourceDeps): DefaultsSource {
  const held = new MutableStore<Held | null>(null);
  const settled = new MutableStore<boolean>(false);

  const current = (): Identity | null => deps.identity.get();
  const isCurrent = (identity: Identity): boolean => {
    const now = current();
    return (
      now?.account_id === identity.account_id && now.epoch === identity.epoch
    );
  };
  /** Keeps `record` if it is the account's and was asked for no earlier than what is held (the later-issued answer stands). */
  const offer = (account: AccountId, record: DefaultsRecord): void => {
    const now = held.get();
    if (
      now !== null &&
      now.account === account &&
      now.record.issued_at > record.issued_at
    )
      return;
    held.set({ account, record });
  };

  const record: Store<DefaultsRecord | null> = {
    get() {
      const identity = current();
      const value = held.get();
      return identity !== null && value?.account === identity.account_id
        ? value.record
        : null;
    },
    subscribe(listener) {
      const offs = [
        held.subscribe(listener),
        deps.identity.subscribe(listener),
      ];
      return () => {
        for (const off of offs) off();
      };
    },
  };

  /** Writes a verified snapshot only if the database already exists; what is stored afterwards (it may be newer) is what is shown. */
  const persist = async (
    identity: Identity,
    fetched: DefaultsRecord,
  ): Promise<void> => {
    const service = deps.service(identity.account_id);
    if (!service?.live) return;
    let reservation: QuotaReservation | null = null;
    let written = false;
    try {
      // A cache write: admitted before it is committed, and refused before any of the person's input would be (R28).
      reservation = await deps.quota.reserve(
        "cache",
        utf8Length(JSON.stringify(fetched)),
      );
      if (reservation.verdict === "refuse") return;
      if (!isCurrent(identity) || !service.live) return;
      const lease = reservation;
      const out = await service.commit(writeDefaults, {
        captured: service.capture(identity.epoch),
        snapshot: fetched.snapshot,
        issuedAt: fetched.issued_at,
        now: fetched.fetched_at,
        leaseLive: () => lease.live(),
      });
      if (out.kind !== "applied") return;
      written = out.value.written;
      if (out.value.stored !== null && isCurrent(identity))
        offer(identity.account_id, out.value.stored);
    } catch {
      // Not persisted: memory still holds the verified snapshot for this page.
    } finally {
      reservation?.settle(written ? "written" : "not_written");
    }
  };

  /** Reads the persisted record of the current identity's open database, used only while that identity and service stand. */
  const hydrate = async (identity: Identity): Promise<void> => {
    const service = deps.service(identity.account_id);
    if (!service?.live) {
      if (deps.databasePending?.(identity.account_id) !== true)
        settled.set(true);
      return;
    }
    try {
      const stored = await service.store.run(readDefaults, {
        incarnationId: service.incarnationId,
      });
      if (
        !isCurrent(identity) ||
        !service.live ||
        deps.service(identity.account_id) !== service
      )
        return;
      if (stored !== null) offer(identity.account_id, stored);
    } catch {
      // Nothing readable is persisted: the next read is the source.
    }
    if (isCurrent(identity)) settled.set(true);
  };

  /** One read for `identity`. The outcome classes are those of the retry table; nothing here retries. */
  const read = async (
    identity: Identity,
  ): Promise<{ outcome: TaskOutcome; fetched: boolean }> => {
    if (deps.readSnapshot === undefined)
      return { outcome: "wait", fetched: false };
    const issuedAt = deps.clock.now();
    const result = await deps.readSnapshot(identity.account_id, identity.epoch);
    // The identity may have moved while the request was in flight: an answer for another (account, epoch) is discarded.
    if (!isCurrent(identity)) return { outcome: "wait", fetched: false };
    if (result.kind !== "ok")
      return { outcome: unreadOutcome(result), fetched: false };
    const snapshot = parseSharingSnapshot(result.value);
    if (snapshot === null) {
      deps.trace?.emit("data.defaults_rejected");
      return { outcome: "unrecognised", fetched: false };
    }
    const fetched: DefaultsRecord = {
      format: 1,
      snapshot,
      fetched_at: deps.clock.now(),
      issued_at: issuedAt,
      epoch: identity.epoch,
    };
    offer(identity.account_id, fetched);
    await persist(identity, fetched);
    return { outcome: "done", fetched: true };
  };

  let refreshing: { key: string; running: Promise<RefreshOutcome> } | null =
    null;
  const refresh = (): Promise<RefreshOutcome> => {
    const identity = current();
    if (identity === null || deps.readSnapshot === undefined)
      return Promise.resolve("closed");
    if (!deps.online()) return Promise.resolve("offline");
    const key = `${identity.account_id}:${identity.epoch}`;
    if (refreshing?.key === key) return refreshing.running;
    const entry: { key: string; running: Promise<RefreshOutcome> } = {
      key,
      running: Promise.resolve("failed"),
    };
    entry.running = (async (): Promise<RefreshOutcome> => {
      try {
        const { outcome, fetched } = await read(identity);
        if (fetched) return "fetched";
        return outcome === "wait" ? "closed" : "failed";
      } catch {
        return "failed";
      } finally {
        if (refreshing === entry) refreshing = null;
      }
    })();
    refreshing = entry;
    return entry.running;
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
    const task = followIdentity({
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
      run: async (identity) => (await read(identity)).outcome,
    });
    let shownFor: string | null = null;
    const show = (): void => {
      const identity = current();
      if (identity === null) return;
      void hydrate(identity);
    };
    const onIdentity = (): void => {
      const identity = current();
      const key =
        identity === null ? null : `${identity.account_id}:${identity.epoch}`;
      if (key === shownFor) return;
      shownFor = key;
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
      if (stopForgetting === null) {
        forgetOnChange();
        stopForgetting = deps.identity.subscribe(forgetOnChange);
      }
      reconsider();
      return () => {
        started = false;
        stopForgetting?.();
        stopForgetting = null;
        reconsider();
      };
    },
  };
}
