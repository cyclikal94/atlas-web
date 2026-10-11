/**
 * The smallest contract checks (a date, a time, a known zone), in a module of their own so a route's search validation does not pull the
 * task parsers into the initial bundle.
 */
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
/** A contract date (`YYYY-MM-DD`, a real calendar day, years 1900 to 9999 as the server accepts). */
export function isContractDate(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = DATE.exec(value);
  if (match === null) return false;
  const [year, month, day] = [
    Number(match[1]),
    Number(match[2]),
    Number(match[3]),
  ];
  if (year < 1900 || year > 9999) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}
const TIME = /^(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]$/;
export const isContractTime = (value: unknown): value is string =>
  typeof value === "string" && TIME.test(value);

/** Whether this device knows the IANA zone (the server validates against its own bundled database). */
export function isKnownZone(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0) return false;
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}
