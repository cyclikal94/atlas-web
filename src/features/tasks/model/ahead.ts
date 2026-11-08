import type { Schedule, TaskDefinition } from "./contract";
import { addDays } from "./time";

/**
 * The look-ahead of the days ahead (the Final design's "Upcoming", 8 November 2026). The server makes an occurrence only when it is asked
 * to (`materialise`; `catchup/`), and Today asks only through today, so a day ahead holds nothing until it comes. The fold asks the
 * page's runner, once a day, to bring every task this device knows of up to date through `AHEAD_DAYS` ahead (inside the server's
 * 31-day horizon in any zone), so what is particular to the weeks ahead is there to read. PURE: which tasks and through which day.
 *
 * The server's position after a `materialise` is the LAST SLOT IT MADE, never the day asked for, so a task is asked for through its own
 * last slot on or before the horizon (`lastSlotOnOrBefore`): a one-off (no `repeat`) through its day, a repeating task through the last
 * day its cadence lands on (asking for a later day would read as "no progress" once that slot exists). One with no date (its slot exists
 * from the start), with nothing to make after today (Today's catch-up covers it), starting beyond the horizon or repeating after
 * completion (the server makes the next one as each is done) is not asked for at all. An archived task is never asked for (the server
 * refuses it).
 *
 * The cadence arithmetic mirrors the server's (observed against v0.31.0-rc.1, 8 November 2026): daily and weekly step from the start
 * date; monthly and yearly keep the start's day of the month and SKIP a month that has no such day (a monthly task from the 31st has no
 * November slot).
 */
export const AHEAD_DAYS = 30;

export interface AheadTarget {
  taskId: string;
  /** `YYYY-MM-DD`: the day to bring the task up to date through. */
  throughDate: string;
}

export interface AheadSource {
  taskId: string;
  definition: TaskDefinition | null;
  archived: boolean;
}

/** The day the look-ahead reaches from `today`. */
export const aheadHorizon = (today: string): string =>
  addDays(today, AHEAD_DAYS);

const parts = (date: string): [number, number, number] =>
  date.split("-").map(Number) as [number, number, number];
const text = (y: number, m: number, d: number): string =>
  `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
const daysInMonth = (y: number, m: number): number =>
  new Date(Date.UTC(y, m, 0)).getUTCDate();
/** `months` months after `date` on the same day of the month, or `null` when that month has no such day (the server skips it). */
export function sameDayMonthsLater(
  date: string,
  months: number,
): string | null {
  const [y, m, d] = parts(date);
  const total = y * 12 + (m - 1) + months;
  const year = Math.floor(total / 12);
  const month = (total % 12) + 1;
  return d > daysInMonth(year, month) ? null : text(year, month, d);
}

/**
 * The last day a schedule lands on, on or before `horizon` (`null` when nothing lands by then). A one-off's only slot is its start date;
 * a task that repeats after completion has no slot to foresee.
 */
export function lastSlotOnOrBefore(
  schedule: Schedule,
  horizon: string,
): string | null {
  const start = schedule.start_date;
  if (start === null || start > horizon) return null;
  const repeat = schedule.repeat;
  if (repeat === null) return start;
  if (repeat.frequency === "after_completion") return null;
  if (repeat.frequency === "daily" || repeat.frequency === "weekly") {
    const step = repeat.interval * (repeat.frequency === "weekly" ? 7 : 1);
    const span = Math.round(
      (Date.parse(`${horizon}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) /
        86_400_000,
    );
    return addDays(start, Math.floor(span / step) * step);
  }
  const months = repeat.interval * (repeat.frequency === "yearly" ? 12 : 1);
  let last = start;
  for (let k = 1; ; k += 1) {
    const next = sameDayMonthsLater(start, k * months);
    if (next === null) continue;
    if (next > horizon) return last;
    last = next;
  }
}

/** Which tasks to bring up to date, through which day, from what this device holds; sorted by task id (one answer per input). */
export function aheadTargets(
  sources: readonly AheadSource[],
  today: string,
): AheadTarget[] {
  const horizon = aheadHorizon(today);
  const out = new Map<string, AheadTarget>();
  for (const source of sources) {
    if (source.archived || source.definition === null) continue;
    if (out.has(source.taskId)) continue;
    const through = lastSlotOnOrBefore(source.definition.schedule, horizon);
    // Nothing to make after today: a slot on or before today is Today's catch-up's.
    if (through === null || through <= today) continue;
    out.set(source.taskId, { taskId: source.taskId, throughDate: through });
  }
  return [...out.values()].sort((a, b) =>
    a.taskId < b.taskId ? -1 : a.taskId > b.taskId ? 1 : 0,
  );
}

/** One string for a plan, so a screen can tell when what it asks for changed. */
export const aheadDigest = (targets: readonly AheadTarget[]): string =>
  targets.map((t) => `${t.taskId}|${t.throughDate}`).join(",");
