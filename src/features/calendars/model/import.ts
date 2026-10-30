/**
 * The local checks of an `.ics` import (WEB-13b, §4.1 of the plan): the released server's bounds (`v0.29.0-rc.1`,
 * `crates/core/src/calendars/ics.rs` `parse`), checked on this device before anything is stored, so a file that cannot be accepted is
 * refused at once and honestly ("rejected before it's ever sent", the wireframe). They are pre-checks: the server stays authoritative,
 * and what is not checked here (time zones, repeat rules, instances, UIDs) comes back as the server's own refusal.
 *
 *  - Size: UTF-8 BYTES of the decoded text (`input.len()`), at most 1 MiB. A byte-order mark is removed by the decoder and never sent.
 *  - Lines: Rust `str::lines` of the text BEFORE unfolding: split on `\n`, a final empty segment not counted. At most 20,000.
 *  - Events: `VEVENT` components, overrides included, recognised on the parser's UNFOLDED content lines (below). At most 256.
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

/*
 * Components are recognised as the server's parser reads them (review 15 R12): `ical` 0.11.0's `LineReader` and `PropertyParser`, which
 * `ics.rs` runs AFTER its byte and line bounds. A component begins on a logical content line, not a physical one: `BEGIN:` folded onto
 * the next line, `BEGIN:VEVENT ` with trailing white space, `BEGIN::VEVENT` and `BEGIN;X-A=1:VEVENT` are all one more event to the
 * server. The text itself is never changed: what was checked is what is stored and sent.
 */

/** Rust `char::is_whitespace` (Unicode White_Space), which the parser trims with. Not JavaScript's `trim`: it also removes U+FEFF and keeps U+0085. */
const isSpace = (code: number): boolean =>
  code === 0x20 ||
  (code >= 0x09 && code <= 0x0d) ||
  code === 0x85 ||
  code === 0xa0 ||
  code === 0x1680 ||
  (code >= 0x2000 && code <= 0x200a) ||
  code === 0x2028 ||
  code === 0x2029 ||
  code === 0x202f ||
  code === 0x205f ||
  code === 0x3000;

function trimEnd(text: string): string {
  let end = text.length;
  while (end > 0 && isSpace(text.charCodeAt(end - 1))) end -= 1;
  return text.slice(0, end);
}

function trim(text: string): string {
  let start = 0;
  while (start < text.length && isSpace(text.charCodeAt(start))) start += 1;
  return trimEnd(text.slice(start));
}

/** Rust `BufRead::lines`: split on `\n`, one `\r` before it removed; a final empty segment is not a line. */
function physicalLines(text: string): string[] {
  const out = text.split("\n");
  const last = out.pop() as string;
  for (let n = 0; n < out.length; n += 1) {
    const line = out[n] as string;
    if (line.endsWith("\r")) out[n] = line.slice(0, -1);
  }
  if (last !== "") out.push(last);
  return out;
}

/** Where the parser's line reader yields nothing but carries on reading after it (see `contentLines`). */
const GAP = null;

/**
 * `LineReader::next_line`, line by line. A line starting with a space or tab continues the one before it, that one character removed;
 * empty lines are skipped, even between a line and its continuation; each part loses its trailing white space, and a new line (not the
 * first) its leading white space too. A new line that is only white space, with no continuation, reads as nothing: a GAP.
 */
function contentLines(text: string): Array<string | typeof GAP> {
  const physical = physicalLines(text);
  const out: Array<string | typeof GAP> = [];
  let at = 0;
  let saved: string | undefined;
  for (;;) {
    const parts: string[] = [];
    if (saved !== undefined) {
      parts.push(saved);
      saved = undefined;
    } else
      while (at < physical.length) {
        const line = physical[at++] as string;
        if (line !== "") {
          parts.push(trimEnd(line));
          break;
        }
      }
    while (at < physical.length) {
      const line = physical[at++] as string;
      if (line === "") continue;
      const first = line.charCodeAt(0);
      if (first === 0x20 || first === 0x09) parts.push(trimEnd(line.slice(1)));
      else {
        saved = trim(line);
        break;
      }
    }
    const content = parts.join("");
    if (content !== "") out.push(content);
    else if (saved === undefined) return out;
    else out.push(GAP);
  }
}

const find = (text: string, char: string): number => {
  const at = text.indexOf(char);
  return at === -1 ? Number.POSITIVE_INFINITY : at;
};

function trimStartOf(text: string, char: string): string {
  let start = 0;
  while (text[start] === char) start += 1;
  return text.slice(start);
}

/**
 * `PropertyParser::parse` of one content line: its name (up to the first `;` or `:`) and its value, after any parameters (a quoted
 * parameter value may hold `:`) with EVERY leading `:` removed. Null where the parser fails; the server then refuses the whole file.
 */
function contentLine(
  line: string,
): { name: string; value: string | null } | null {
  const param = find(line, ";");
  const value = find(line, ":");
  let end: number;
  if (param < value && param !== 0) end = param;
  else if (value !== Number.POSITIVE_INFINITY && value !== 0) end = value;
  else return null;
  const name = line.slice(0, end);
  let rest = line.slice(end);
  if (
    find(rest, ";") !== Number.POSITIVE_INFINITY &&
    find(rest, ":") > find(rest, ";")
  )
    while (rest.startsWith(";")) {
      rest = trimStartOf(rest, ";");
      const equals = rest.indexOf("=");
      if (equals <= 0) return null;
      rest = rest.slice(equals + 1);
      for (let values = 10; values > 0; ) {
        values -= 1;
        if (rest.startsWith('"')) {
          const close = rest.indexOf('"', 1);
          if (close === -1) return null;
          rest = rest.slice(close + 1);
        } else {
          const nextParam = find(rest, ";");
          const nextValue = find(rest, ":");
          const nextListed = find(rest, ",");
          if (nextListed < nextValue && nextListed < nextParam)
            rest = rest.slice(nextListed);
          else if (nextParam < nextValue && nextParam < nextListed)
            rest = rest.slice(nextParam);
          else if (nextValue !== Number.POSITIVE_INFINITY)
            rest = rest.slice(nextValue);
          else return null;
        }
        if (!rest.startsWith(",")) break;
        rest = trimStartOf(rest, ",");
      }
    }
  rest = trimStartOf(rest, ":");
  return { name, value: rest === "" ? null : rest };
}

/** The checks of a decoded file's text (pure). */
export function checkImportText(ics: string): ImportFileCheck {
  const bytes = utf8Bytes(ics);
  if (bytes > IMPORT_LIMITS.bytes) return { ok: false, reason: "too_large" };
  const count = lineCount(ics);
  if (count > IMPORT_LIMITS.lines)
    return { ok: false, reason: "too_many_lines" };
  // Names and values are compared in upper case, as before: the parser matches `vevent` (or a lower-case header) only as a refusal of
  // the whole file, so counting it can refuse nothing the server accepts. Every `BEGIN:VEVENT` counts wherever it is: the parser allows
  // one only directly in the calendar and refuses the file otherwise. The one place it stops reading early is a GAP straight after the
  // calendar's END (it then takes nothing after it); anywhere else the file is refused, and counting on is the cautious answer.
  let calendar = false;
  let events = 0;
  let depth = 0;
  let closed = false;
  for (const line of contentLines(ics)) {
    if (line === GAP) {
      if (closed) break;
      continue;
    }
    closed = false;
    const property = contentLine(line);
    if (property === null) continue;
    const name = property.name.toUpperCase();
    if (name === "END") {
      // The parser ends the open component at any END, whatever it names.
      if (depth > 0) {
        depth -= 1;
        closed = depth === 0;
      }
    } else if (name === "BEGIN" && property.value !== null) {
      const component = property.value.toUpperCase();
      if (component === "VCALENDAR") calendar = true;
      else if (component === "VEVENT") events += 1;
      depth += 1;
    }
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
