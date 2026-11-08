import { isContractDate, isContractTime } from "./primitives";

/**
 * WEB-13b: the proposed move a calendar review hands to the task's one-day correction (`?move=` on `/tasks/<id>?occurrence=<id>`), read
 * STRICTLY in the lazy task screen (never the entry): `YYYY-MM-DD`, or `YYYY-MM-DDTHH:MM:SS`. Anything else is ignored. It only fills in a
 * NEW correction session; it is removed from the address once the correction has opened.
 */
export interface MoveSeed {
  date: string;
  /** `HH:MM:SS`, or null for a date-only slot. */
  time: string | null;
}

export function parseMove(value: unknown): MoveSeed | null {
  if (typeof value !== "string" || value.length > 19) return null;
  const [date, time, extra] = value.split("T");
  if (extra !== undefined || date === undefined || !isContractDate(date))
    return null;
  if (time === undefined) return { date, time: null };
  return isContractTime(time) && time.length === 8 ? { date, time } : null;
}
