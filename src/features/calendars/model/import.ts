/**
 * The local checks of an `.ics` import (WEB-13b, §4.1 of the plan): the released server's bounds (`v0.29.0-rc.1`,
 * `crates/core/src/calendars/ics.rs` `parse`), checked on this device before anything is stored, so a file that cannot be accepted is
 * refused at once and honestly ("rejected before it's ever sent", the wireframe). They are pre-checks: the server stays authoritative,
 * and what is not checked here (time zones, repeat rules, instances, UIDs) comes back as the server's own refusal.
 *
 *  - Size: UTF-8 BYTES of the decoded text (`input.len()`), at most 1 MiB. A byte-order mark is removed by the decoder and never sent.
 *  - Lines: Rust `str::lines` of the text BEFORE unfolding: split on `\n`, a final empty segment not counted. At most 20,000.
 *  - Events: `VEVENT` components, overrides included. At most 256.
 *  - Window: two `YYYY-MM-DD` dates that round-trip, years 1900–9999, `0 ≤ through − from ≤ 730` days (inclusive coverage). A reversed
 *    window is the server's `calendar_limit`; here it is a `span` error.
 *  - Envelope: the JSON body `{ics, from, through}` at most 2 MiB (the route's limit): escaping can take a 1 MiB file over it.
 */
export const IMPORT_LIMITS = {
  bytes: 1_048_576,
  lines: 20_000,
  events: 256,
  spanDays: 730,
  envelopeBytes: 2_097_152,
  minYear: 1900,
  maxYear: 9999,
} as const;

export type ImportFileProblem =
  | "not_utf8"
  | "too_large"
  | "too_many_lines"
  | "too_many_events"
  | "not_calendar"
  | "unreadable";

export type ImportFileCheck =
  | { ok: true; ics: string; bytes: number; lines: number; events: number }
  | { ok: false; reason: ImportFileProblem };

const utf8Bytes = (text: string): number =>
  new TextEncoder().encode(text).length;

/** Rust `str::lines().count()`: `""` → 0, `"a\n"` → 1, `"a\nb"` → 2, `"\n"` → 1. */
export function lineCount(text: string): number {
  if (text === "") return 0;
  let newlines = 0;
  for (let at = text.indexOf("\n"); at !== -1; at = text.indexOf("\n", at + 1))
    newlines += 1;
  return text.endsWith("\n") ? newlines : newlines + 1;
}

/** The text's lines as the parser sees their content: a trailing `\r` removed. */
const lines = (text: string): string[] =>
  text
    .split("\n")
    .map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));

/** The checks of a decoded file's text (pure). */
export function checkImportText(ics: string): ImportFileCheck {
  const bytes = utf8Bytes(ics);
  if (bytes > IMPORT_LIMITS.bytes) return { ok: false, reason: "too_large" };
  const count = lineCount(ics);
  if (count > IMPORT_LIMITS.lines)
    return { ok: false, reason: "too_many_lines" };
  let calendar = false;
  let events = 0;
  for (const line of lines(ics)) {
    const upper = line.toUpperCase();
    if (upper === "BEGIN:VCALENDAR") calendar = true;
    else if (upper === "BEGIN:VEVENT") events += 1;
  }
  if (!calendar) return { ok: false, reason: "not_calendar" };
  if (events > IMPORT_LIMITS.events)
    return { ok: false, reason: "too_many_events" };
  return { ok: true, ics, bytes, lines: count, events };
}

/**
 * Reads a chosen file on this device and checks it. A file larger than the limit (plus a byte-order mark) is refused WITHOUT reading it;
 * the text must be valid UTF-8 (a fatal decode). Nothing is stored or sent here.
 */
export async function readImportFile(file: Blob): Promise<ImportFileCheck> {
  if (file.size > IMPORT_LIMITS.bytes + 3)
    return { ok: false, reason: "too_large" };
  let buffer: ArrayBuffer;
  try {
    buffer = await file.arrayBuffer();
  } catch {
    return { ok: false, reason: "unreadable" };
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    return { ok: false, reason: "not_utf8" };
  }
  return checkImportText(text);
}

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 86_400_000;

/** A `YYYY-MM-DD` date's day number (UTC), or null when it does not round-trip; its year is returned for the range check. */
function dayOf(value: string): { day: number; year: number } | null {
  const match = DATE.exec(value);
  if (match === null) return null;
  const [year, month, day] = [
    Number(match[1]),
    Number(match[2]),
    Number(match[3]),
  ];
  // `Date.UTC` maps years 0–99 to 1900–1999: the year is set on its own so that a year 0050 is that year (out of range, not malformed).
  const date = new Date(Date.UTC(2000, month - 1, day));
  date.setUTCFullYear(year, month - 1, day);
  const at = date.getTime();
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  )
    return null;
  return { day: Math.round(at / DAY_MS), year };
}

export type WindowCheck =
  | { ok: true }
  | {
      ok: false;
      field: "from" | "through";
      reason: "format" | "range" | "span";
    };

/** The coverage window (inclusive): both dates valid, years 1900–9999, `through` 0 to 730 days after `from`. */
export function checkWindow(from: string, through: string): WindowCheck {
  const start = dayOf(from);
  if (start === null) return { ok: false, field: "from", reason: "format" };
  const end = dayOf(through);
  if (end === null) return { ok: false, field: "through", reason: "format" };
  const inRange = (year: number) =>
    year >= IMPORT_LIMITS.minYear && year <= IMPORT_LIMITS.maxYear;
  if (!inRange(start.year))
    return { ok: false, field: "from", reason: "range" };
  if (!inRange(end.year))
    return { ok: false, field: "through", reason: "range" };
  const span = end.day - start.day;
  if (span < 0 || span > IMPORT_LIMITS.spanDays)
    return { ok: false, field: "through", reason: "span" };
  return { ok: true };
}

const iso = (day: number): string =>
  new Date(day * DAY_MS).toISOString().slice(0, 10);

/** The window a new import starts with: today (in the device's zone, as given) through 364 days later. */
export function defaultWindow(today: string): {
  from: string;
  through: string;
} {
  const start = dayOf(today);
  if (start === null) return { from: today, through: today };
  return { from: today, through: iso(start.day + 364) };
}

/** The UTF-8 bytes of the body as it will be sent (`{ics, from, through}` as JSON). */
export function envelopeBytes(input: {
  ics: string;
  from: string;
  through: string;
}): number {
  return utf8Bytes(
    JSON.stringify({
      from: input.from,
      ics: input.ics,
      through: input.through,
    }),
  );
}
