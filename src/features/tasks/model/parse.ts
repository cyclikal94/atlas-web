import type { Cadence, Frequency } from "./contract";
import { addDays } from "./time";

/**
 * The create form's natural title (the Final design, FD_Create): dates, times and "every …" typed into the name become chips, and the
 * words they came from leave the name when it is saved. Only what is unambiguous is read: a weekday, "today"/"tomorrow", a day with its
 * month ("30 Oct", "Oct 30", "30/10"), a time ("18:30", "6pm", "at 6"), and a cadence ("every day", "every 2 weeks", "every Monday",
 * "daily"). A bare number is never a date. Nothing is guessed from the rest of the words.
 */
export interface ParsedToken {
  kind: "date" | "time" | "repeat";
  /** The words as typed, prepositions included ("on Friday", "at 6pm"). */
  text: string;
  start: number;
  end: number;
  /** `YYYY-MM-DD`, `HH:MM` or the cadence. */
  value: string | Cadence;
}

export interface ParsedTitle {
  /** The name without the tokens, spaces collapsed. */
  title: string;
  date: string | null;
  time: string | null;
  repeat: Cadence | null;
  tokens: ParsedToken[];
}

const WEEKDAYS = [
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
] as const;
const MONTHS = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
] as const;

const weekdayIndex = (word: string): number =>
  WEEKDAYS.findIndex(
    (name) => name === word || name.slice(0, 3) === word.slice(0, 3),
  );
const monthIndex = (word: string): number =>
  MONTHS.findIndex(
    (name) =>
      name === word || (word.length >= 3 && name.startsWith(word.slice(0, 3))),
  );
/** 0 = Monday … 6 = Sunday, of a `YYYY-MM-DD` day. */
const weekdayOf = (day: string): number =>
  (new Date(`${day}T00:00:00Z`).getUTCDay() + 6) % 7;
const pad = (n: number) => String(n).padStart(2, "0");
const daysIn = (year: number, month: number): number =>
  new Date(Date.UTC(year, month, 0)).getUTCDate();

/** The next day on or after `today` that falls on `weekday` (today itself when it does). */
export function nextWeekday(today: string, weekday: number): string {
  const ahead = (weekday - weekdayOf(today) + 7) % 7;
  return addDays(today, ahead);
}

/** The next `day` of `month` on or after today: this year, or next year when it has passed. A day the month lacks is no date. */
function dayOfMonth(today: string, day: number, month: number): string | null {
  const year = Number(today.slice(0, 4));
  for (const y of [year, year + 1]) {
    if (day < 1 || day > daysIn(y, month)) continue;
    const date = `${y}-${pad(month)}-${pad(day)}`;
    if (date >= today) return date;
  }
  return null;
}

const WD = "(?:mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun)(?:[a-z]*)";
const MO = "(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)(?:[a-z]*)";
const ORD = "(?:st|nd|rd|th)?";

type Rule = {
  kind: ParsedToken["kind"];
  pattern: RegExp;
  read(match: RegExpExecArray, today: string): string | Cadence | null;
};

const RULES: Rule[] = [
  // "every 2 weeks", "every week", "every day"
  {
    kind: "repeat",
    pattern: /\bevery\s+(?:(\d{1,3})\s+)?(day|week|month|year)s?\b/gi,
    read: (m) => ({
      frequency: `${(m[2] as string).toLowerCase()}ly`.replace(
        "dayly",
        "daily",
      ) as Frequency,
      interval: Math.max(1, Number(m[1] ?? "1")),
    }),
  },
  {
    kind: "repeat",
    pattern: /\bdaily\b/gi,
    read: () => ({ frequency: "daily", interval: 1 }),
  },
  {
    kind: "repeat",
    pattern: /\bweekly\b/gi,
    read: () => ({ frequency: "weekly", interval: 1 }),
  },
  {
    kind: "repeat",
    pattern: /\bmonthly\b/gi,
    read: () => ({ frequency: "monthly", interval: 1 }),
  },
  {
    kind: "repeat",
    pattern: /\byearly\b/gi,
    read: () => ({ frequency: "yearly", interval: 1 }),
  },
  // "every Monday": weekly, from the next Monday
  {
    kind: "repeat",
    pattern: new RegExp(`\\bevery\\s+(${WD})\\b`, "gi"),
    read: (m) =>
      weekdayIndex((m[1] as string).toLowerCase()) < 0
        ? null
        : { frequency: "weekly", interval: 1 },
  },
  { kind: "date", pattern: /\b(?:on\s+)?today\b/gi, read: (_, today) => today },
  {
    kind: "date",
    pattern: /\b(?:on\s+)?tomorrow\b/gi,
    read: (_, today) => addDays(today, 1),
  },
  // "30 Oct", "30th October", "Oct 30", "October 30th"
  {
    kind: "date",
    pattern: new RegExp(`\\b(?:on\\s+)?(\\d{1,2})${ORD}\\s+(${MO})\\b`, "gi"),
    read: (m, today) => {
      const month = monthIndex((m[2] as string).toLowerCase());
      return month < 0 ? null : dayOfMonth(today, Number(m[1]), month + 1);
    },
  },
  {
    kind: "date",
    pattern: new RegExp(`\\b(?:on\\s+)?(${MO})\\s+(\\d{1,2})${ORD}\\b`, "gi"),
    read: (m, today) => {
      const month = monthIndex((m[1] as string).toLowerCase());
      return month < 0 ? null : dayOfMonth(today, Number(m[2]), month + 1);
    },
  },
  // "30/10" (day/month)
  {
    kind: "date",
    pattern: /\b(?:on\s+)?(\d{1,2})\/(\d{1,2})\b/gi,
    read: (m, today) => dayOfMonth(today, Number(m[1]), Number(m[2])),
  },
  // "Friday", "on Fri", "Fri 30" (the weekday names the day; a number after it is that day of this or next month)
  {
    kind: "date",
    pattern: new RegExp(
      `\\b(?:on\\s+)?(${WD})\\b(?:\\s+(\\d{1,2})${ORD}\\b(?!\\s*(?:${MO}|:|/)))?`,
      "gi",
    ),
    read: (m, today) => {
      const weekday = weekdayIndex((m[1] as string).toLowerCase());
      if (weekday < 0) return null;
      if (m[2] === undefined) return nextWeekday(today, weekday);
      const day = Number(m[2]);
      const [year, month] = today.split("-").map(Number) as [number, number];
      for (let i = 0; i < 3; i += 1) {
        const date = new Date(Date.UTC(year, month - 1 + i, 1));
        const candidate = dayOfMonth(today, day, date.getUTCMonth() + 1);
        if (
          candidate !== null &&
          candidate.slice(0, 7) ===
            `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}`
        )
          return candidate;
      }
      return null;
    },
  },
  // "18:30", "at 6pm", "6.30pm", "at 6"
  {
    kind: "time",
    pattern: /\b(?:at\s+)?([01]?\d|2[0-3]):([0-5]\d)\b(?!\s*(?:am|pm))/gi,
    read: (m) => `${pad(Number(m[1]))}:${m[2]}`,
  },
  {
    kind: "time",
    pattern: /\b(?:at\s+)?(1[0-2]|0?[1-9])(?:[:.]([0-5]\d))?\s?(am|pm)\b/gi,
    read: (m) => {
      let hour = Number(m[1]) % 12;
      if ((m[3] as string).toLowerCase() === "pm") hour += 12;
      return `${pad(hour)}:${m[2] ?? "00"}`;
    },
  },
  {
    kind: "time",
    pattern: /\bat\s+([01]?\d|2[0-3])\b(?![:./]|\s*(?:am|pm))/gi,
    read: (m) => `${pad(Number(m[1]))}:00`,
  },
];

/** The tokens of `text`, first by position, one per kind (the first of a kind wins); overlapping matches keep the earlier. */
export function parseTitle(text: string, today: string): ParsedTitle {
  const found: ParsedToken[] = [];
  const taken: Array<[number, number]> = [];
  const overlaps = (start: number, end: number) =>
    taken.some(([s, e]) => start < e && end > s);
  for (const rule of RULES) {
    rule.pattern.lastIndex = 0;
    let match: RegExpExecArray | null = rule.pattern.exec(text);
    while (match !== null) {
      const start = match.index;
      const end = start + match[0].length;
      const value = rule.read(match, today);
      if (
        value !== null &&
        !overlaps(start, end) &&
        !found.some((t) => t.kind === rule.kind)
      ) {
        found.push({ kind: rule.kind, text: match[0], start, end, value });
        taken.push([start, end]);
      }
      if (match[0].length === 0) rule.pattern.lastIndex += 1;
      match = rule.pattern.exec(text);
    }
  }
  found.sort((a, b) => a.start - b.start);
  // "every Monday" names the day too: the first Monday on or after today, unless a date was typed.
  const every = found.find((t) => t.kind === "repeat");
  if (every !== undefined && !found.some((t) => t.kind === "date")) {
    const weekday = /^every\s+([a-z]+)$/i.exec(every.text.trim());
    const index = weekday
      ? weekdayIndex((weekday[1] as string).toLowerCase())
      : -1;
    if (index >= 0)
      found.push({
        kind: "date",
        text: "",
        start: every.start,
        end: every.start,
        value: nextWeekday(today, index),
      });
  }
  const date = found.find((t) => t.kind === "date");
  const time = found.find((t) => t.kind === "time");
  const repeat = found.find((t) => t.kind === "repeat");
  return {
    title: stripTokens(text, found),
    date: (date?.value as string | undefined) ?? null,
    time: (time?.value as string | undefined) ?? null,
    repeat: (repeat?.value as Cadence | undefined) ?? null,
    tokens: found.filter((t) => t.text !== ""),
  };
}

/** The text without the tokens' words, spaces collapsed and a trailing comma or dash dropped. */
export function stripTokens(
  text: string,
  tokens: readonly ParsedToken[],
): string {
  let out = "";
  let at = 0;
  for (const token of [...tokens].sort((a, b) => a.start - b.start)) {
    if (token.text === "") continue;
    out += text.slice(at, token.start);
    at = token.end;
  }
  out += text.slice(at);
  return out
    .replace(/\s+/g, " ")
    .replace(/\s*[,–-]\s*$/g, "")
    .trim();
}
