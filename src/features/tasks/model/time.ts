import type { Schedule, Slot, TaskDefinition } from "./contract";
import { slotKey } from "./ids";

/**
 * Wall time, days and windows, as the server computes them (`schedule.rs` `resolve`, `lifecycle.rs` `windows`), from the device's
 * `Intl` time-zone data. Instants are Unix SECONDS (the contract's `instant`, `opens_at`, `closes_at`, `happened_at`); `now` arguments
 * are milliseconds (`Date.now()`).
 *
 * Atlas wall-time rules: in a fold (a time that happens twice) the EARLIER instant; in a gap (a time that never happens) the wall time
 * moves forward by the size of the gap (Europe/Vienna 02:30 on the spring change is 03:30; Australia/Lord_Howe 02:15 is 02:45). The slot's
 * intended date and key never change. The device's zone data can differ from the server's bundled data: whenever the server's own value
 * is at hand (a synced slot, a `/daily` answer) it wins.
 */

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(zone: string): Intl.DateTimeFormat {
  let f = formatters.get(zone);
  if (f === undefined) {
    f = new Intl.DateTimeFormat("en-GB", {
      timeZone: zone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatters.set(zone, f);
  }
  return f;
}

interface Wall {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

/** The wall clock in `zone` at `epochSeconds`. */
export function wallAt(zone: string, epochSeconds: number): Wall {
  const parts = formatter(zone).formatToParts(new Date(epochSeconds * 1000));
  const get = (type: string) =>
    Number(parts.find((p) => p.type === type)?.value ?? "0");
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: get("hour") % 24,
    minute: get("minute"),
    second: get("second"),
  };
}

const wallSeconds = (w: Wall): number =>
  Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second) / 1000;

/** The zone's offset from UTC at an instant, in seconds. */
export function offsetAt(zone: string, epochSeconds: number): number {
  return wallSeconds(wallAt(zone, epochSeconds)) - epochSeconds;
}

/** Every instant whose wall clock in `zone` is exactly `wall` (seconds of a naive wall time): none (a gap), one, or two (a fold). */
function instantsOf(zone: string, wall: number): number[] {
  const offsets = new Set<number>([
    offsetAt(zone, wall - 2 * 86_400),
    offsetAt(zone, wall + 2 * 86_400),
    offsetAt(zone, wall),
  ]);
  for (const o of [...offsets]) offsets.add(offsetAt(zone, wall - o));
  const out: number[] = [];
  for (const o of offsets) {
    const t = wall - o;
    if (wallSeconds(wallAt(zone, t)) === wall && !out.includes(t)) out.push(t);
  }
  return out.sort((a, b) => a - b);
}

function parseWall(date: string, time: string): number {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const [hh, mm, ss] = time.split(":").map(Number) as [number, number, number];
  return Date.UTC(y, m - 1, d, hh, mm, ss) / 1000;
}

/** `resolve` of the server: the instant (Unix seconds) of a wall time `date` `time` in `zone`. */
export function resolveWallTime(
  zone: string,
  date: string,
  time: string,
): number {
  const wall = parseWall(date, time);
  const found = instantsOf(zone, wall);
  if (found.length > 0) return found[0] as number;
  // A gap: find the nearest valid wall times on either side, minute by minute (as the server does), and move by the change of offset.
  for (let minute = 1; minute <= 2880; minute += 1) {
    const before = instantsOf(zone, wall - minute * 60)[0];
    const after = instantsOf(zone, wall + minute * 60)[0];
    if (before !== undefined && after !== undefined) {
      const gap = offsetAt(zone, after) - offsetAt(zone, before);
      const shifted = instantsOf(zone, wall + gap)[0];
      if (shifted === undefined) break;
      return shifted;
    }
  }
  throw new RangeError("this wall time cannot be resolved");
}

const two = (n: number) => String(n).padStart(2, "0");
const dateText = (w: Pick<Wall, "year" | "month" | "day">) =>
  `${String(w.year).padStart(4, "0")}-${two(w.month)}-${two(w.day)}`;

/** The calendar date (`YYYY-MM-DD`) in `zone` at an instant (seconds). */
export const dateIn = (epochSeconds: number, zone: string): string =>
  dateText(wallAt(zone, epochSeconds));

/** `HH:MM` in `zone` at an instant (seconds). */
export function timeIn(epochSeconds: number, zone: string): string {
  const w = wallAt(zone, epochSeconds);
  return `${two(w.hour)}:${two(w.minute)}`;
}

/** The hour (0 to 23) in `zone` at an instant (seconds). */
export const hourIn = (epochSeconds: number, zone: string): number =>
  wallAt(zone, epochSeconds).hour;

/** Today in `zone` (`now` in milliseconds). */
export const todayIn = (zone: string, nowMs: number): string =>
  dateIn(Math.floor(nowMs / 1000), zone);

/** A date `days` later (or earlier, negative) on the calendar. */
export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const at = new Date(Date.UTC(y, m - 1, d + days));
  return dateText({
    year: at.getUTCFullYear(),
    month: at.getUTCMonth() + 1,
    day: at.getUTCDate(),
  });
}

/** The first instant AFTER `day` in `zone`: local midnight of the next day (the server's `day_end`). */
export const dayEnd = (day: string, zone: string): number =>
  resolveWallTime(zone, addDays(day, 1), "00:00:00");

/** The instant local midnight starts `day` in `zone`. */
export const dayStart = (day: string, zone: string): number =>
  resolveWallTime(zone, day, "00:00:00");

/** The window of a slot (`lifecycle.rs` `windows`): local midnight of date − open_days_before to local midnight of date + close_days_after. */
export function windows(
  slot: Pick<Slot, "date" | "timezone">,
  definition: Pick<TaskDefinition, "open_days_before" | "close_days_after">,
): { opens_at: number | null; closes_at: number | null } {
  if (slot.date === null) return { opens_at: null, closes_at: null };
  return {
    opens_at: resolveWallTime(
      slot.timezone,
      addDays(slot.date, -definition.open_days_before),
      "00:00:00",
    ),
    closes_at: resolveWallTime(
      slot.timezone,
      addDays(slot.date, definition.close_days_after),
      "00:00:00",
    ),
  };
}

/** The slot a schedule has on `date` (or the undated slot), with its instant resolved. */
export function slotOn(schedule: Schedule, date: string | null): Slot {
  if (date === null)
    return {
      key: "once",
      date: null,
      intended_time: null,
      timezone: schedule.timezone,
      instant: null,
    };
  return {
    key: slotKey(schedule, date),
    date,
    intended_time: schedule.time,
    timezone: schedule.timezone,
    instant:
      schedule.time === null
        ? null
        : resolveWallTime(schedule.timezone, date, schedule.time),
  };
}

/**
 * The occurrence `create_task` makes at once (`commands.rs`): the EARLIEST slot not after today in the task's zone, which is the start-date
 * slot (or `once` for an undated or after-completion task), and none when the start date is still in the future. Fixed recurrence makes no
 * further occurrence by itself: that is `materialise` (WEB-10c).
 */
export function firstSlot(
  definition: Pick<TaskDefinition, "schedule">,
  nowMs: number,
): Slot | null {
  const { schedule } = definition;
  if (schedule.start_date === null) return slotOn(schedule, null);
  const today = todayIn(schedule.timezone, nowMs);
  if (schedule.start_date > today) return null;
  return slotOn(schedule, schedule.start_date);
}

/** Whether the server would shift this slot's wall time (a gap): the instant's wall time in the slot's zone is not the intended time. */
export function gapShifted(slot: Slot): boolean {
  if (slot.instant === null || slot.intended_time === null) return false;
  const w = wallAt(slot.timezone, slot.instant);
  return (
    `${two(w.hour)}:${two(w.minute)}:${two(w.second)}` !== slot.intended_time ||
    dateText(w) !== slot.date
  );
}
