import type { Captured, JsonObject } from "../model/types";
import { guardedPlan, readPlan } from "./builders";

/**
 * W28 (WEB-10c, D-10c-4): a bounded copy of the displayed account's running timer sessions, as the last COMPLETE first page of
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
 * nothing. A copy older than the stored one (two reads landing out of order) is not written over it.
 */
export const TIMER_COPY_ROWS = 50;

export interface TimerCopyRecord {
  format: 1;
  /** ms, the device clock of the read's ISSUE (the order of two reads). */
  read_at: number;
  /** The page ended the running list (no cursor): the copy is every running session the read could see. */
  complete: boolean;
  running: JsonObject[];
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The stored copy, read tolerantly: absent, another format or damage is "no copy". */
export function parseTimerCopy(value: unknown): TimerCopyRecord | null {
  if (!isObject(value) || value.format !== 1) return null;
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
    format: 1,
    read_at: value.read_at,
    complete: value.complete,
    running: value.running as JsonObject[],
  };
}

export const writeTimerCopy = guardedPlan<
  {
    captured: Captured;
    /** The replacement copy, or `null` to remove it. */
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
    if (copy !== null && parseTimerCopy(copy) === null)
      return { result: { written: false, stored } };
    if (copy !== null && stored !== null && stored.read_at > copy.read_at)
      return { result: { written: false, stored } };
    if (input.leaseLive !== undefined && !input.leaseLive())
      return { result: { written: false, stored, lapsed: true } };
    return {
      sync: { ...sync, timer_copy: copy },
      result: { written: true, stored: copy },
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
