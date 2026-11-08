import { addDays } from "../model/time";

/**
 * The calendar's pure arithmetic: months, Monday-based weeks, ISO week numbers and the labels of both, all on `YYYY-MM-DD` strings
 * (the contract's dates) and UTC (a date has no zone of its own; the display zone decides which date a task falls on upstream).
 */
/** The month, the week, or the week as lanes of who does what ("people"); the last two share the week's arithmetic. */
export type CalendarView = "month" | "week" | "people";

const utc = (day: string) => new Date(`${day}T00:00:00Z`);
const monthFormat = new Intl.DateTimeFormat("en-GB", {
  month: "long",
  year: "numeric",
  timeZone: "UTC",
});
const monthShort = new Intl.DateTimeFormat("en-GB", {
  month: "short",
  timeZone: "UTC",
});
const monthLong = new Intl.DateTimeFormat("en-GB", {
  month: "long",
  timeZone: "UTC",
});

/** "November 2026". */
export const monthLabel = (month: string): string =>
  monthFormat.format(utc(`${month}-01`));
/** The last day of a month ("2026-11-30"). */
export function monthEnd(month: string): string {
  const [y, m] = month.split("-").map(Number) as [number, number];
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${month}-${String(last).padStart(2, "0")}`;
}
/** The month `by` months after a month ("2026-12" + 1 = "2027-01"). */
export function shiftMonth(month: string, by: number): string {
  const [y, m] = month.split("-").map(Number) as [number, number];
  const date = new Date(Date.UTC(y, m - 1 + by, 1));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}
/** The Monday-based weekday of a date (0 Monday … 6 Sunday). */
export const weekdayIndex = (day: string): number =>
  (utc(day).getUTCDay() + 6) % 7;
/** The Monday of a date's week. */
export const mondayOf = (day: string): string =>
  addDays(day, -weekdayIndex(day));
/** Whole days from `a` to `b` (negative when `b` is earlier). */
export const daysBetween = (a: string, b: string): number =>
  Math.round((utc(b).getTime() - utc(a).getTime()) / 86_400_000);
/** The ISO 8601 week number of a date (weeks start on Monday; week 1 holds the year's first Thursday). */
export function isoWeek(day: string): number {
  const date = utc(day);
  const thursday = new Date(date.getTime());
  thursday.setUTCDate(date.getUTCDate() + 3 - weekdayIndex(day));
  const firstThursday = new Date(Date.UTC(thursday.getUTCFullYear(), 0, 4));
  return (
    1 +
    Math.round(
      ((thursday.getTime() - firstThursday.getTime()) / 86_400_000 -
        3 +
        weekdayIndex(`${firstThursday.getUTCFullYear()}-01-04`)) /
        7,
    )
  );
}
/** "9 – 15 November", "27 Oct – 2 Nov" across a month, "29 Dec 2025 – 4 Jan 2026" across a year. */
export function weekLabel(monday: string): string {
  const sunday = addDays(monday, 6);
  const a = utc(monday);
  const b = utc(sunday);
  if (a.getUTCFullYear() !== b.getUTCFullYear())
    return `${a.getUTCDate()} ${monthShort.format(a)} ${a.getUTCFullYear()} – ${b.getUTCDate()} ${monthShort.format(b)} ${b.getUTCFullYear()}`;
  if (a.getUTCMonth() !== b.getUTCMonth())
    return `${a.getUTCDate()} ${monthShort.format(a)} – ${b.getUTCDate()} ${monthShort.format(b)}`;
  return `${a.getUTCDate()} – ${b.getUTCDate()} ${monthLong.format(a)}`;
}
/** The block a day belongs to in a view: its month, or the Monday of its week. */
export const blockKeyOf = (day: string, view: CalendarView): string =>
  view === "month" ? day.slice(0, 7) : mondayOf(day);
/** The first day of a block. */
export const blockStart = (key: string, view: CalendarView): string =>
  view === "month" ? `${key}-01` : key;
/** The block `by` blocks after a block. */
export const shiftBlock = (
  key: string,
  view: CalendarView,
  by: number,
): string => (view === "month" ? shiftMonth(key, by) : addDays(key, by * 7));
/** A block's title: "November 2026" or "9 – 15 November". */
export const blockTitle = (key: string, view: CalendarView): string =>
  view === "month" ? monthLabel(key) : weekLabel(key);
/** The days of a block, first to last. */
export function blockDays(key: string, view: CalendarView): string[] {
  const start = blockStart(key, view);
  const end = view === "month" ? monthEnd(key) : addDays(key, 6);
  const out: string[] = [];
  for (let d = start; d <= end; d = addDays(d, 1)) out.push(d);
  return out;
}
/** The block keys of a view across a window of whole months, first to last. */
export function blocksIn(
  start: string,
  end: string,
  view: CalendarView,
): string[] {
  const out: string[] = [];
  if (view === "month")
    for (let m = start.slice(0, 7); m <= end.slice(0, 7); m = shiftMonth(m, 1))
      out.push(m);
  else for (let d = mondayOf(start); d <= end; d = addDays(d, 7)) out.push(d);
  return out;
}
/**
 * A month's weeks as rows of its days: a cell is a day of the month or null (a day of the month before or after, kept so the columns
 * line up). Without weekends only Monday to Friday are kept, and a row that held only weekend days is left out.
 */
export function monthRows(
  month: string,
  weekends: boolean,
): Array<Array<string | null>> {
  const start = `${month}-01`;
  const end = monthEnd(month);
  const cells: Array<string | null> = [];
  for (let n = 0; n < weekdayIndex(start); n += 1) cells.push(null);
  for (let d = start; d <= end; d = addDays(d, 1)) cells.push(d);
  while (cells.length % 7 !== 0) cells.push(null);
  const rows: Array<Array<string | null>> = [];
  for (let i = 0; i < cells.length; i += 7) {
    const week = cells.slice(i, i + 7);
    const kept = weekends ? week : week.slice(0, 5);
    if (kept.some((day) => day !== null)) rows.push(kept);
  }
  return rows;
}
