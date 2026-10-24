import { WHO } from "./copy";
import { dateIn, hourIn, timeIn } from "./model/time";
import type { RowModel } from "./view";

/** Display helpers (en-GB): a day as "Wed 9 Sep", a time as "07:30" in the display zone, a moment as "14:05" or "9 Sep, 14:05". */
const dayFormat = new Intl.DateTimeFormat("en-GB", {
  weekday: "short",
  day: "numeric",
  month: "short",
  timeZone: "UTC",
});
const longDayFormat = new Intl.DateTimeFormat("en-GB", {
  weekday: "long",
  day: "numeric",
  month: "long",
  timeZone: "UTC",
});
const weekdayFormat = new Intl.DateTimeFormat("en-GB", {
  weekday: "long",
  timeZone: "UTC",
});

const utcDate = (day: string) => new Date(`${day}T00:00:00Z`);
export const dayLabel = (day: string): string => dayFormat.format(utcDate(day));
export const longDayLabel = (day: string): string =>
  longDayFormat.format(utcDate(day));
export const weekdayLabel = (day: string): string =>
  weekdayFormat.format(utcDate(day));

export function momentLabel(ms: number, nowMs: number, zone: string): string {
  const seconds = Math.floor(ms / 1000);
  const time = timeIn(seconds, zone);
  return dateIn(seconds, zone) === dateIn(Math.floor(nowMs / 1000), zone)
    ? time
    : `${dayLabel(dateIn(seconds, zone))}, ${time}`;
}

export type Group = "morning" | "afternoon" | "evening" | "any";
export const GROUP_ORDER: readonly Group[] = [
  "morning",
  "afternoon",
  "evening",
  "any",
];

/** D-10a-11: the slot instant in the display zone; date-only, undated and overdue rows are "Any time today". */
export function groupOf(row: RowModel, day: string, zone: string): Group {
  const instant = row.data.slot.instant;
  if (instant === null || dateIn(instant, zone) !== day) return "any";
  const hour = hourIn(instant, zone);
  if (hour < 12) return "morning";
  if (hour < 18) return "afternoon";
  return "evening";
}

/** Within a group: by instant, then title, then id (never the server's UUID order). */
export function compareRows(a: RowModel, b: RowModel): number {
  const ta = a.data.slot.instant ?? Number.MAX_SAFE_INTEGER;
  const tb = b.data.slot.instant ?? Number.MAX_SAFE_INTEGER;
  if (ta !== tb) return ta - tb;
  const la = a.title ?? "";
  const lb = b.title ?? "";
  if (la !== lb) return la < lb ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Whether I take part in this occurrence, by evidence only (R28, revision 15): the roster names me, or my own stream is held or being
 * created here (a queued join or Anyone first record, which puts me on the roster when it lands). Being able to see or share the task is
 * not taking part, and for Anyone a stream this device does not hold says nothing either way, so neither adds me. This is what the words
 * say, never who may record: `recordBlock`/`eligible` keep their own rules (an Anyone task I may edit stays recordable without a stream).
 */
export function takesPart(row: RowModel, me: string): boolean {
  return (
    row.data.participants.includes(me) || row.streamPresent || row.streamPending
  );
}

/** Who takes part, the same on Today and on the task (Q8): "You and 2 others" when I take part, else "3 people", by the roster. */
export function whoLabel(row: RowModel, me: string): string {
  const others = row.data.participants.filter((id) => id !== me).length;
  if (!takesPart(row, me)) return WHO.people(others);
  return others === 0 ? WHO.you : WHO.youAnd(others);
}
