import type { Captured, JsonObject } from "../model/types";
import { guardedPlan, readPlan } from "./builders";

/**
 * W28 (WEB-10c, D-10c-4): a bounded copy of the displayed account's running timer sessions, as the last first page of
 * `GET /timer-sessions?state=running` answered them, persisted as ONE record in `sync_state.timer_copy` (the precedent of W14's
 * `sync_state.defaults`; optional, so no migration). The rows are opaque here: the task slice parses each one strictly when it reads them,
 * so a damaged row is shown as nothing, never guessed.
 *
 * RESPONSE-DERIVED, so the full guard set (INC, CLS, EPO, and the service's G1/G2/G5 through `AccountService.commit`): an answer of a
 * former account, epoch or database incarnation, or one that lands while a wipe is closing, writes nothing. The copy lives in the
 * account's own database, so it is per account and per incarnation by construction, and the wipe removes it with the database.
 *
 * GROWTH IS ADMITTED like a cache page (R28): the rows are server-sized (titles of up to 300 characters), so the caller reserves the
 * record's bytes through the quota ledger ("cache") and passes the reservation's `live()`, read where this decides. A lapsed hold writes
 * nothing.
 *
 * ORDER (WEB-10c revision 2, review R10 and design assessment DA-T1/DA-T2): every timer read that may change the copy is given its place
 * in this database's observation order BEFORE it is sent (`issueTimerOrder`: `sync_state.timer_order`, a counter moved in its own
 * transaction, so two tabs never share a number and a clock that ties or goes back decides nothing). The copy carries the order of the
 * read it was written from, and `sync_state.timer_fence` the latest order already applied to it: a replacement or a correction of an
 * EARLIER read than one applied is refused, so a slow answer can never restore a session a later read retired, in this page, another tab
 * or after a reload. `read_at` (the device clock) is shown ("last checked"), never compared.
 *
 * SCOPES (WEB-10c revision 3, review R14 and design assessment DA-T3): a day's read also publishes what it OBSERVED of that day, in
 * `sync_state.timer_scopes[occurrence]` (`TimerScopeRecord`): the place of its latest COMPLETE read and the sessions that read listed
 * running, and the sessions any read of the day listed finished. A read kept in another tab's page memory (or this one's, after a
 * remount) is judged against it, so a later correction of the day retires what an earlier read saw, while a correction of another day
 * decides nothing about it. Each scope has its own order (`seen`), so the copy's global fence never hides a day's observation. Bounded:
 * at most `TIMER_SCOPES` days, `TIMER_SCOPE_IDS` sessions each way; whatever is NOT kept (an evicted day, a list beyond the bound, a growth
 * the quota ledger did not admit) raises `sync_state.timer_scope_floor` to the order it concerned instead, and a day's read issued before
 * the floor is no longer trusted for a session it saw running (it may have been retired by what was lost). Authority is never dropped
 * silently, so nothing a later read retired can come back.
 *
 * ACCOUNT AND FINISHED (WEB-10c revision 5, review R23): the latest COMPLETE account observation is kept apart from the copy
 * (`sync_state.timer_account`: its order and the sessions it listed), so a later partial first page, which replaces the copy, never
 * erases what the complete one proved; and every session a read listed FINISHED (a page of the account's history, a day's read) is
 * kept in `sync_state.timer_ended`, with the order handed out when it was recorded, and taken out of the copy at once. A finished
 * session never runs again, whatever order a positive of it has (unknown included), so these decide for every source: the copy, the
 * account's live list, a day's read now or kept, in any tab and after a reload or going offline. Bounded (`TIMER_ENDED_IDS`): the
 * oldest finished session beyond it goes, and the floor rises to the order handed out when it was recorded (every positive that may
 * have listed it was issued before), and `lost` is set (a positive whose order is unknown is then no longer trusted). A growth the
 * quota ledger did not admit records the same loss instead, at every order handed out so far.
 */
export const TIMER_COPY_ROWS = 50;

export interface TimerCopyRecord {
  format: 2;
  /**
   * The place of the read it was written from in the observation order (`issueTimerOrder`). A copy stored before the order existed
   * (format 1) reads as 0: older than every ordered read, so the first one replaces or corrects it without trusting its clock.
   */
  order: number;
  /** ms, the device clock of the read's ISSUE: shown ("last checked"), never an order. */
  read_at: number;
  /** The page ended the running list (no cursor): the copy is every running session the read could see. */
  complete: boolean;
  running: JsonObject[];
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const orderOf = (value: unknown): number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : 0;

/**
 * The stored copy, read tolerantly: absent, an unknown format or damaged rows are "no copy"; a format-1 copy, or an order that does not
 * read, is order 0 (older than every ordered read: the safe side, since any ordered read then replaces or corrects it).
 */
export function parseTimerCopy(value: unknown): TimerCopyRecord | null {
  if (!isObject(value) || (value.format !== 1 && value.format !== 2))
    return null;
  if (typeof value.read_at !== "number" || !Number.isFinite(value.read_at))
    return null;
  if (typeof value.complete !== "boolean") return null;
  if (
    !Array.isArray(value.running) ||
    value.running.length > TIMER_COPY_ROWS ||
    !value.running.every(isObject)
  )
    return null;
  return {
    format: 2,
    order: value.format === 2 ? orderOf(value.order) : 0,
    read_at: value.read_at,
    complete: value.complete,
    running: value.running as JsonObject[],
  };
}

/** The latest order already applied to the copy: a write of this order or an earlier one is refused. */
const floorOf = (sync: { timer_fence?: unknown; timer_copy?: unknown }) =>
  Math.max(
    orderOf(sync.timer_fence),
    parseTimerCopy(sync.timer_copy)?.order ?? 0,
  );

/** At most this many days keep a scope; the one seen longest ago is evicted (its order raises the floor). */
export const TIMER_SCOPES = 100;
/** At most this many sessions a scope lists running, and finished; beyond it the floor is raised instead. */
export const TIMER_SCOPE_IDS = 100;

/** What reads of ONE day observed (DA-T3). */
export interface TimerScopeRecord {
  /** The latest order of any read of the day recorded here. */
  seen: number;
  /** The order of the day's latest COMPLETE read (0: none): every session it did not list running was not running then. */
  order: number;
  /** The sessions that complete read listed running. */
  running: string[];
  /** Sessions a read of the day listed finished (a finished session never runs again), until a complete read at least as late. */
  ended: string[];
  /** The latest order an `ended` entry was recorded at. */
  ended_at: number;
}

const isIds = (value: unknown, max: number): value is string[] =>
  Array.isArray(value) &&
  value.length <= max &&
  value.every((id) => typeof id === "string" && id.length <= 64);

/** One day's scope as stored, tolerantly: one that does not read is "none" (and the floor protects what it held). */
export function parseTimerScope(value: unknown): TimerScopeRecord | null {
  if (!isObject(value)) return null;
  const seen = orderOf(value.seen);
  const order = orderOf(value.order);
  if (seen === 0 || order > seen) return null;
  if (
    !isIds(value.running, TIMER_SCOPE_IDS) ||
    !isIds(value.ended, TIMER_SCOPE_IDS)
  )
    return null;
  return {
    seen,
    order,
    running: value.running,
    ended: value.ended,
    ended_at: orderOf(value.ended_at),
  };
}

/**
 * A scope that does not read held authority nobody can see now: nothing it may have retired is trusted, up to its own `seen`, or, when
 * even that does not read, every order handed out so far (`issued`, `sync_state.timer_order`).
 */
const lostAt = (raw: unknown, issued: number): number =>
  orderOf(isObject(raw) ? raw.seen : undefined) || issued;

/**
 * The floor a scopes map that is present but not a map leaves (revision 4): every scope it held is lost, so every order handed out so far
 * (`issued`). An absent map is "none recorded yet".
 */
const mapLost = (raw: unknown, issued: number): number =>
  raw !== undefined && raw !== null && !isObject(raw) ? issued : 0;

/** At most this many finished sessions are kept in `timer_ended`; the one recorded longest ago goes first. */
export const TIMER_ENDED_IDS = 200;

/** The latest complete observation of the account's running sessions (revision 5, R23). */
export interface TimerAccountRecord {
  order: number;
  running: string[];
}

/** Sessions listed finished (revision 5, R23), each with the order handed out when it was recorded; `lost`: one was not kept. */
export interface TimerEndedRecord {
  lost: boolean;
  ids: Array<[string, number]>;
}

export function parseTimerAccount(value: unknown): TimerAccountRecord | null {
  if (!isObject(value) || orderOf(value.order) === 0) return null;
  if (!isIds(value.running, TIMER_COPY_ROWS)) return null;
  return { order: orderOf(value.order), running: value.running };
}

export function parseTimerEnded(value: unknown): TimerEndedRecord | null {
  if (!isObject(value) || typeof value.lost !== "boolean") return null;
  const ids = value.ids;
  if (
    !Array.isArray(ids) ||
    ids.length > TIMER_ENDED_IDS ||
    !ids.every(
      (e) =>
        Array.isArray(e) &&
        e.length === 2 &&
        typeof e[0] === "string" &&
        e[0].length <= 64 &&
        Number.isSafeInteger(e[1]) &&
        (e[1] as number) >= 0,
    )
  )
    return null;
  return { lost: value.lost, ids: ids as Array<[string, number]> };
}

/**
 * What the stored finished sessions and account observation leave as authority (revision 5, R23), and the floor whatever of them does
 * not read raises: an unreadable record held authority nobody can see now, so every order handed out so far (`issued`), and `lost`.
 */
function endedOf(
  sync: { timer_ended?: unknown; timer_account?: unknown },
  issued: number,
): {
  ended: TimerEndedRecord;
  account: TimerAccountRecord | null;
  floor: number;
} {
  const rawEnded = sync.timer_ended;
  const rawAccount = sync.timer_account;
  const ended =
    rawEnded === undefined || rawEnded === null
      ? { lost: false, ids: [] }
      : parseTimerEnded(rawEnded);
  const account =
    rawAccount === undefined || rawAccount === null
      ? null
      : parseTimerAccount(rawAccount);
  const accountLost =
    rawAccount !== undefined && rawAccount !== null && account === null;
  return {
    ended: ended ?? { lost: true, ids: [] },
    account,
    floor: ended === null || accountLost ? issued : 0,
  };
}

/** Session ids as a read listed them: strings of at most 64 characters, once each (anything else is not a session id). */
const idsOf = (ids: readonly unknown[]): string[] => [
  ...new Set(
    ids.filter((id): id is string => typeof id === "string" && id.length <= 64),
  ),
];

/**
 * `ids` added to the finished sessions (pure; revision 5, R23), recorded at `issued`: kept newest last, at most `TIMER_ENDED_IDS`. The
 * ones that do not fit go oldest first, raising the floor to the order handed out when each was recorded (every positive that may list
 * it was issued no later), and set `lost`.
 */
function withEnded(
  held: TimerEndedRecord,
  ids: readonly string[],
  issued: number,
): { ended: TimerEndedRecord; floor: number } {
  const fresh = new Set(ids);
  const all: Array<[string, number]> = [
    ...held.ids.filter(([id]) => !fresh.has(id)),
    ...ids.map((id): [string, number] => [id, issued]),
  ];
  let floor = 0;
  let lost = held.lost;
  while (all.length > TIMER_ENDED_IDS) {
    const gone = all.shift() as [string, number];
    floor = Math.max(floor, gone[1]);
    lost = true;
  }
  return { ended: { lost, ids: all }, floor };
}

/** The copy without the sessions `finished` names (a removal: never a growth). `null`: nothing to change. */
function copyWithout(
  sync: { timer_copy?: unknown },
  finished: ReadonlySet<string>,
): { copy: TimerCopyRecord; removed: number } | null {
  const stored = parseTimerCopy(sync.timer_copy ?? null);
  if (stored === null || finished.size === 0) return null;
  const running = stored.running.filter(
    (row) => !(typeof row.id === "string" && finished.has(row.id)),
  );
  const removed = stored.running.length - running.length;
  return removed === 0 ? null : { copy: { ...stored, running }, removed };
}

/** What a read of one day observed, for its scope: `running`/`ended` as listed by every page accepted so far. */
export interface TimerScopeObservation {
  occurrence_id: string;
  complete: boolean;
  running: string[];
  ended: string[];
}

/**
 * The scopes after a read of `order` observed `seen` (pure): the day's scope merged (a complete read at least as late as the recorded one
 * replaces its running list; finished sessions are added); then the bound applied. Returns the floor that whatever could not be kept
 * raised.
 */
function observe(
  scopes: Record<string, unknown>,
  floor: number,
  issued: number,
  order: number,
  seen: TimerScopeObservation,
): { scopes: Record<string, TimerScopeRecord>; floor: number } {
  const out: Record<string, TimerScopeRecord> = {};
  for (const [id, raw] of Object.entries(scopes)) {
    const scope = parseTimerScope(raw);
    if (scope !== null) out[id] = scope;
    else floor = Math.max(floor, lostAt(raw, issued));
  }
  const held = out[seen.occurrence_id] ?? {
    seen: 0,
    order: 0,
    running: [],
    ended: [],
    ended_at: 0,
  };
  const next: TimerScopeRecord = {
    ...held,
    seen: Math.max(held.seen, order),
  };
  let recorded = false;
  if (seen.complete && order >= held.order) {
    if (seen.running.length > TIMER_SCOPE_IDS) floor = Math.max(floor, order);
    else {
      recorded = true;
      next.order = order;
      next.running = [...seen.running];
      // Finished sessions recorded no later than this complete read are said by its running list as well.
      if (held.ended_at <= order) {
        next.ended = [];
        next.ended_at = 0;
      }
    }
  }
  // A recorded complete read's finished sessions are said by its running list already.
  const ended = [...new Set([...next.ended, ...(recorded ? [] : seen.ended)])];
  if (ended.length > next.ended.length) {
    if (ended.length > TIMER_SCOPE_IDS) floor = Math.max(floor, order);
    else {
      next.ended = ended;
      next.ended_at = Math.max(next.ended_at, order);
    }
  }
  out[seen.occurrence_id] = next;
  const ids = Object.keys(out);
  if (ids.length > TIMER_SCOPES) {
    // The day seen longest ago goes; what it observed is covered by the floor from now on.
    ids.sort((a, b) => (out[a]?.seen ?? 0) - (out[b]?.seen ?? 0));
    for (const id of ids.slice(0, ids.length - TIMER_SCOPES)) {
      floor = Math.max(floor, out[id]?.seen ?? 0);
      delete out[id];
    }
  }
  return { scopes: out, floor };
}

/**
 * A place in the observation order for a read about to be sent (fixed-size: one counter in the singleton, so not admitted through the
 * quota ledger). Issue-time, but guarded like the response it orders: a former account, epoch or incarnation is given none.
 */
export const issueTimerOrder = guardedPlan<
  { captured: Captured },
  null,
  { order: number | null }
>({
  name: "data.issueTimerOrder",
  meta: { writer: "W28", guards: ["INC", "CLS", "EPO"], quota: null },
  scope: [],
  durability: "default",
  read: async () => null,
  decide: ({ sync }) => {
    const order = Math.max(orderOf(sync.timer_order), floorOf(sync)) + 1;
    if (!Number.isSafeInteger(order)) return { result: { order: null } };
    return { sync: { ...sync, timer_order: order }, result: { order } };
  },
});

export const writeTimerCopy = guardedPlan<
  {
    captured: Captured;
    /** The replacement copy, or `null` to remove it (the fence stays). */
    copy: TimerCopyRecord | null;
    /** The quota reservation's `live()`; absent: not admitted through the ledger (a test of the plan alone). */
    leaseLive?: () => boolean;
  },
  null,
  { written: boolean; stored: TimerCopyRecord | null; lapsed?: true }
>({
  name: "data.writeTimerCopy",
  meta: { writer: "W28", guards: ["INC", "CLS", "EPO"], quota: "cache" },
  scope: [],
  durability: "default",
  read: async () => null,
  decide: ({ sync, input }) => {
    const stored = parseTimerCopy(sync.timer_copy ?? null);
    const copy = input.copy;
    const floor = floorOf(sync);
    if (copy !== null && parseTimerCopy(copy) === null)
      return { result: { written: false, stored } };
    if (copy !== null && copy.order <= floor)
      return { result: { written: false, stored } };
    if (input.leaseLive !== undefined && !input.leaseLive())
      return { result: { written: false, stored, lapsed: true } };
    // A complete copy is also the account's latest complete observation (revision 5, R23), kept when a later partial page replaces it;
    // only while every row names its session (otherwise what it listed is not known).
    const ids = copy?.complete ? idsOf(copy.running.map((row) => row.id)) : [];
    const account =
      copy?.complete && ids.length === copy.running.length
        ? { timer_account: { order: copy.order, running: ids } }
        : {};
    return {
      sync: {
        ...sync,
        timer_copy: copy,
        timer_fence: Math.max(floor, copy?.order ?? 0),
        ...account,
      },
      result: { written: true, stored: copy },
    };
  },
});

/**
 * A correction of the copy by a read of ONE occurrence's sessions (`order` from `issueTimerOrder`): the rows `drop` names are removed
 * (`newer`: the read was issued after the copy's own, so what it does not list may be decided by absence; the slice decides), and the
 * fence moves up to `order`, so an answer issued before this read can no longer replace the copy. Removing rows needs no admission.
 *
 * Revision 4 (review R19): the correction applies to the copy WHATEVER the fence. The fence is the latest order of ANY read applied, so a
 * later read of ANOTHER day says nothing about this one: an earlier read of this day that lands after it still retires what it did not
 * list from an older copy (`newer` is decided against the copy's own order, never the fence), and the fence never moves back.
 *
 * The same read's `scope` is recorded in `timer_scopes` under the day's OWN order (revision 3, DA-T3), whatever the copy's fence: that
 * record grows the singleton, so the caller admits it through the quota ledger and passes the reservation's `live()` (`leaseLive`); a
 * refusal (`admitted: false`) or a lapsed hold records the floor instead (a few bytes, in place). Absent `scope`: only the copy.
 */
export const reconcileTimerCopy = guardedPlan<
  {
    captured: Captured;
    order: number;
    drop(row: JsonObject, newer: boolean): boolean;
    scope?: TimerScopeObservation;
    /** The quota ledger refused the scope's growth: the floor is raised instead. */
    admitted?: boolean;
    leaseLive?: () => boolean;
  },
  null,
  { removed: number; applied: boolean; scoped: boolean }
>({
  name: "data.reconcileTimerCopy",
  meta: { writer: "W28", guards: ["INC", "CLS", "EPO"], quota: "cache" },
  scope: [],
  durability: "default",
  read: async () => null,
  decide: ({ sync, input }) => {
    if (!Number.isSafeInteger(input.order) || input.order <= 0)
      return { result: { removed: 0, applied: false, scoped: false } };
    let next = sync;
    let scoped = false;
    if (input.scope !== undefined) {
      const floor = Math.max(
        orderOf(sync.timer_scope_floor),
        mapLost(sync.timer_scopes, orderOf(sync.timer_order)),
      );
      const admitted =
        input.admitted !== false &&
        (input.leaseLive === undefined || input.leaseLive());
      // The day's finished sessions are the account's too (revision 5, R23): kept with the scope, under the same admission.
      const issued = orderOf(sync.timer_order);
      const held = endedOf(sync, issued);
      const finished = idsOf(input.scope.ended);
      if (admitted) {
        const out = observe(
          isObject(sync.timer_scopes) ? sync.timer_scopes : {},
          Math.max(floor, held.floor),
          issued,
          input.order,
          input.scope,
        );
        const ended =
          finished.length === 0
            ? null
            : withEnded(held.ended, finished, Math.max(issued, input.order));
        next = {
          ...next,
          timer_scopes: out.scopes,
          timer_scope_floor: Math.max(out.floor, ended?.floor ?? 0),
          ...(ended === null ? {} : { timer_ended: ended.ended }),
        };
        scoped = true;
      } else
        next = {
          ...next,
          timer_scope_floor: Math.max(floor, held.floor, input.order),
          ...(finished.length === 0
            ? {}
            : { timer_ended: { ...held.ended, lost: true } }),
        };
    }
    const fence = floorOf(sync);
    const stored = parseTimerCopy(sync.timer_copy ?? null);
    const kept =
      stored === null
        ? null
        : stored.running.filter(
            (row) => !input.drop(row, input.order > stored.order),
          );
    const removed =
      stored === null || kept === null
        ? 0
        : stored.running.length - kept.length;
    return {
      sync: {
        ...next,
        ...(stored !== null && kept !== null && removed > 0
          ? { timer_copy: { ...stored, running: kept } }
          : {}),
        timer_fence: Math.max(fence, input.order),
      },
      result: { removed, applied: true, scoped },
    };
  },
});

/**
 * Revision 5 (review R23): sessions a read of the account's HISTORY (`state=stopped`) listed, recorded as finished (`timer_ended`) and
 * taken out of the copy in the same transaction. Needs no order (a finished session never runs again) but the read's stamp at issue
 * (INC, CLS, EPO): an answer of a former account, epoch or incarnation records nothing. The record grows the singleton, so the caller
 * admits it through the quota ledger (`leaseLive`); a refusal or a lapsed hold still takes the sessions out of the copy (a removal), and
 * records the loss instead (the floor at every order handed out so far, and `lost`).
 */
export const recordTimerEnded = guardedPlan<
  {
    captured: Captured;
    ids: readonly string[];
    /** The quota ledger refused the record's growth. */
    admitted?: boolean;
    leaseLive?: () => boolean;
  },
  null,
  { recorded: boolean; removed: number }
>({
  name: "data.recordTimerEnded",
  meta: { writer: "W28", guards: ["INC", "CLS", "EPO"], quota: "cache" },
  scope: [],
  durability: "default",
  read: async () => null,
  decide: ({ sync, input }) => {
    const ids = idsOf(input.ids);
    if (ids.length === 0) return { result: { recorded: true, removed: 0 } };
    const issued = orderOf(sync.timer_order);
    const held = endedOf(sync, issued);
    const out = copyWithout(sync, new Set(ids));
    const floor = Math.max(orderOf(sync.timer_scope_floor), held.floor);
    const admitted =
      input.admitted !== false &&
      (input.leaseLive === undefined || input.leaseLive());
    const ended = admitted ? withEnded(held.ended, ids, issued) : null;
    return {
      sync: {
        ...sync,
        ...(out === null ? {} : { timer_copy: out.copy }),
        timer_ended: ended?.ended ?? { ...held.ended, lost: true },
        timer_scope_floor: Math.max(floor, ended?.floor ?? issued),
      },
      result: { recorded: ended !== null, removed: out?.removed ?? 0 },
    };
  },
});

export const readTimerCopy = readPlan<
  { incarnationId: string },
  null,
  TimerCopyRecord | null
>({
  name: "data.readTimerCopy",
  scope: [],
  read: async () => null,
  decide: ({ sync }) => parseTimerCopy(sync?.timer_copy ?? null),
});

/**
 * Revision 4 (review R19): everything that decides whether a server-derived running session still stands, read in ONE transaction so
 * every consumer judges against the same moment: the copy, every day's scope and the floor (raised by every scope that does not read, as
 * `readTimerScope` does; a scopes map that is not a map loses every order handed out so far). The scopes are bounded (`TIMER_SCOPES`).
 */
export interface TimerAuthorityRecord {
  copy: TimerCopyRecord | null;
  scopes: Record<string, TimerScopeRecord>;
  floor: number;
  /** Revision 5 (R23): the latest complete account observation, and the sessions listed finished (`lost`: one was not kept). */
  account: TimerAccountRecord | null;
  ended: string[];
  endedLost: boolean;
}
export const readTimerAuthority = readPlan<
  { incarnationId: string },
  null,
  TimerAuthorityRecord
>({
  name: "data.readTimerAuthority",
  scope: [],
  read: async () => null,
  decide: ({ sync }) => {
    const issued = orderOf(sync?.timer_order);
    const raw: unknown = sync?.timer_scopes;
    let floor = Math.max(
      orderOf(sync?.timer_scope_floor),
      mapLost(raw, issued),
    );
    const scopes: Record<string, TimerScopeRecord> = {};
    for (const [id, value] of Object.entries(isObject(raw) ? raw : {})) {
      const scope = parseTimerScope(value);
      if (scope !== null) scopes[id] = scope;
      else floor = Math.max(floor, lostAt(value, issued));
    }
    const held = endedOf(sync ?? {}, issued);
    return {
      copy: parseTimerCopy(sync?.timer_copy ?? null),
      scopes,
      floor: Math.max(floor, held.floor),
      account: held.account,
      ended: held.ended.ids.map(([id]) => id),
      endedLost: held.ended.lost,
    };
  },
});

/** One day's scope (DA-T3) and the floor below which a day's read is no longer trusted for what it saw running. */
export const readTimerScope = readPlan<
  { incarnationId: string; occurrenceId: string },
  null,
  { scope: TimerScopeRecord | null; floor: number }
>({
  name: "data.readTimerScope",
  scope: [],
  read: async () => null,
  decide: ({ sync, input }) => {
    const scopes = isObject(sync?.timer_scopes) ? sync.timer_scopes : {};
    const raw = scopes[input.occurrenceId];
    const scope = raw === undefined ? null : parseTimerScope(raw);
    return {
      scope,
      floor: Math.max(
        orderOf(sync?.timer_scope_floor),
        mapLost(sync?.timer_scopes, orderOf(sync?.timer_order)),
        // A scope stored but unreadable: its authority is lost, so nothing it may have retired is trusted.
        raw !== undefined && scope === null
          ? lostAt(raw, orderOf(sync?.timer_order))
          : 0,
      ),
    };
  },
});
