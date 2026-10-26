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
    return {
      sync: {
        ...sync,
        timer_copy: copy,
        timer_fence: Math.max(floor, copy?.order ?? 0),
      },
      result: { written: true, stored: copy },
    };
  },
});

/**
 * A correction of the copy by a read of ONE occurrence's sessions (`order` from `issueTimerOrder`): the rows `drop` names are removed
 * (`newer`: the read was issued after the copy's own, so what it does not list may be decided by absence; the slice decides), and the
 * fence moves to `order` either way, so an answer issued before this read can no longer replace the copy. A correction older than the
 * fence changes nothing; one of the fence's own order is a later page of the same read. It only removes rows (never adds), so it is not admitted through the quota ledger.
 */
export const reconcileTimerCopy = guardedPlan<
  {
    captured: Captured;
    order: number;
    drop(row: JsonObject, newer: boolean): boolean;
  },
  null,
  { removed: number; applied: boolean }
>({
  name: "data.reconcileTimerCopy",
  meta: { writer: "W28", guards: ["INC", "CLS", "EPO"], quota: null },
  scope: [],
  durability: "default",
  read: async () => null,
  decide: ({ sync, input }) => {
    const floor = floorOf(sync);
    // The same order again is the same read's later page (its traversal keeps its first page's place).
    if (!Number.isSafeInteger(input.order) || input.order < floor)
      return { result: { removed: 0, applied: false } };
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
        ...sync,
        ...(stored !== null && kept !== null && removed > 0
          ? { timer_copy: { ...stored, running: kept } }
          : {}),
        timer_fence: input.order,
      },
      result: { removed, applied: true },
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
