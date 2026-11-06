/**
 * WEB-19: when an activity event happened and since when changes were recorded, in UK English (`en-GB`), in the reader's own time zone.
 * Local to the people chunk on purpose: importing the tasks slice's formatting would pull another chunk in (the WEB-11b chunk-split trap).
 */
const WHEN = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});
const SINCE = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  year: "numeric",
});

/** "5 Nov 2026, 14:05" for Unix seconds. */
export const formatWhen = (seconds: number): string =>
  WHEN.format(new Date(seconds * 1000));
/** "4 Nov 2026" for Unix seconds. */
export const formatSince = (seconds: number): string =>
  SINCE.format(new Date(seconds * 1000));
/** The machine-readable instant (`<time dateTime>`). */
export const isoOf = (seconds: number): string =>
  new Date(seconds * 1000).toISOString();
