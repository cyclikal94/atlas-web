import { isUuid } from "../../../data";

/**
 * The seven `FieldValue` kinds of the pinned contract (`v0.28.0-rc.1`), as a field's value is SENT and as it is SHOWN. PURE.
 *
 * The bounds are the server's own (`crates/core/src/resources/fields.rs` `FieldValue::validate`, `tasks/mod.rs` `Decimal::units` and
 * `Goal::Checklist`, `lib.rs` `identifier`/`content`), not only the OpenAPI schema's, so what the editor allows is what the server
 * accepts:
 *  - text: at most 4,096 CHARACTERS (Unicode scalar values, as Rust's `chars().count()`, not UTF-16 units);
 *  - quantity: a `TaskDecimal` (non-negative, at most 12 whole digits and 6 decimals, or exactly 1,000,000,000,000), and a unit of 1 to 40
 *    characters that is not blank;
 *  - date: month and day, and an optional year 1900–9999; the date must exist, checked against the year 2000 when no year is given (so
 *    29 February is valid without a year, and only in a leap year with one);
 *  - url: parses, `http` or `https`, has a host, and carries no user name or password;
 *  - boolean;
 *  - choices: 1 to 100 unique options, each not blank and at most 100 characters; the selection unique and among the options;
 *  - checklist: 1 to 100 items with unique canonical (lowercase) UUIDs and labels that are not blank and at most 300 characters; the
 *    checked ids unique and among the items;
 *  - the whole value serialised as JSON is at most 8,192 bytes.
 *
 * `parseFieldValue` is STRICT: a stored value that does not match exactly is `null`, and the screen says it can't be shown, never guesses.
 */
export type FieldValue =
  | { kind: "text"; text: string }
  | { kind: "quantity"; amount: string; unit: string }
  | { kind: "date"; year?: number | null; month: number; day: number }
  | { kind: "url"; url: string }
  | { kind: "boolean"; value: boolean }
  | { kind: "choices"; options: string[]; selected: string[] }
  | {
      kind: "checklist";
      items: Array<{ id: string; label: string }>;
      checked: string[];
    };

export type FieldKind = FieldValue["kind"];
export const FIELD_KINDS: readonly FieldKind[] = [
  "text",
  "quantity",
  "date",
  "url",
  "boolean",
  "choices",
  "checklist",
];

export const LIMITS = {
  label: 300,
  text: 4096,
  unit: 40,
  option: 100,
  options: 100,
  item: 300,
  items: 100,
  valueBytes: 8192,
  minYear: 1900,
  maxYear: 9999,
} as const;

/** The number of characters as the server counts them (Unicode scalar values). */
export const charCount = (text: string): number => [...text].length;
const blank = (text: string): boolean => text.trim() === "";

const TASK_DECIMAL =
  /^(?:(?:0|[1-9][0-9]{0,11})(?:\.[0-9]{1,6})?|1000000000000(?:\.0{1,6})?)$/;
/** A non-negative decimal the contract accepts (`TaskDecimal`). */
export const isTaskDecimal = (text: string): boolean => TASK_DECIMAL.test(text);

const isLeap = (year: number): boolean =>
  (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
const DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
/** Whether the date exists; without a year, checked against 2000 (a leap year), as the server does. */
export function isRealDate(
  year: number | null | undefined,
  month: number,
  day: number,
): boolean {
  if (!Number.isInteger(month) || !Number.isInteger(day)) return false;
  if (month < 1 || month > 12 || day < 1) return false;
  const y = year ?? 2000;
  const days =
    month === 2 && isLeap(y) ? 29 : (DAYS[month - 1] as number | undefined);
  return days !== undefined && day <= days;
}

/** A link the server accepts: parses, http or https, a host, no credentials. */
export function isAcceptedUrl(text: string): boolean {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return false;
  }
  return (
    (url.protocol === "http:" || url.protocol === "https:") &&
    url.hostname !== "" &&
    url.username === "" &&
    url.password === ""
  );
}

const unique = (values: readonly string[]): boolean =>
  new Set(values).size === values.length;

export type ValueProblem =
  | "text_too_long"
  | "amount_invalid"
  | "unit_missing"
  | "unit_too_long"
  | "year_out_of_range"
  | "date_invalid"
  | "url_invalid"
  | "options_missing"
  | "options_too_many"
  | "option_blank"
  | "option_too_long"
  | "options_repeated"
  | "selected_unknown"
  | "items_missing"
  | "items_too_many"
  | "item_blank"
  | "item_too_long"
  | "item_id_invalid"
  | "checked_unknown"
  | "value_too_large";

/** Why the server would refuse `value`, or null when it would accept it. The first problem found. */
export function valueProblem(value: FieldValue): ValueProblem | null {
  switch (value.kind) {
    case "text":
      if (charCount(value.text) > LIMITS.text) return "text_too_long";
      break;
    case "quantity":
      if (!isTaskDecimal(value.amount)) return "amount_invalid";
      if (blank(value.unit)) return "unit_missing";
      if (charCount(value.unit) > LIMITS.unit) return "unit_too_long";
      break;
    case "date":
      if (
        value.year !== undefined &&
        value.year !== null &&
        (!Number.isInteger(value.year) ||
          value.year < LIMITS.minYear ||
          value.year > LIMITS.maxYear)
      )
        return "year_out_of_range";
      if (!isRealDate(value.year, value.month, value.day))
        return "date_invalid";
      break;
    case "url":
      if (!isAcceptedUrl(value.url)) return "url_invalid";
      break;
    case "boolean":
      break;
    case "choices":
      if (value.options.length === 0) return "options_missing";
      if (
        value.options.length > LIMITS.options ||
        value.selected.length > LIMITS.options
      )
        return "options_too_many";
      if (value.options.some(blank)) return "option_blank";
      if (value.options.some((o) => charCount(o) > LIMITS.option))
        return "option_too_long";
      if (!unique(value.options) || !unique(value.selected))
        return "options_repeated";
      if (value.selected.some((s) => !value.options.includes(s)))
        return "selected_unknown";
      break;
    case "checklist": {
      if (value.items.length === 0) return "items_missing";
      if (value.items.length > LIMITS.items) return "items_too_many";
      const ids = value.items.map((item) => item.id);
      if (ids.some((id) => !isUuid(id)) || !unique(ids))
        return "item_id_invalid";
      if (value.items.some((item) => blank(item.label))) return "item_blank";
      if (value.items.some((item) => charCount(item.label) > LIMITS.item))
        return "item_too_long";
      if (!unique(value.checked) || value.checked.some((c) => !ids.includes(c)))
        return "checked_unknown";
      break;
    }
  }
  if (
    new TextEncoder().encode(JSON.stringify(value)).length > LIMITS.valueBytes
  )
    return "value_too_large";
  return null;
}

/** A field name the server accepts: not blank, at most 300 characters. */
export const labelProblem = (
  label: string,
): "label_missing" | "label_too_long" | null =>
  blank(label)
    ? "label_missing"
    : charCount(label) > LIMITS.label
      ? "label_too_long"
      : null;

// ---- strict parsing of a stored value ---------------------------------------------------------------------------------------------
type Obj = Record<string, unknown>;
const isObject = (value: unknown): value is Obj =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const keysAre = (value: Obj, required: string[], optional: string[] = []) =>
  required.every((key) => Object.hasOwn(value, key)) &&
  Object.keys(value).every(
    (key) => required.includes(key) || optional.includes(key),
  );
const isStrings = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

/**
 * A stored field value, exactly as the contract describes it and the server would accept it, or null. Nothing is coerced: a value of
 * another shape (a newer contract, a damaged row) is not shown as something it may not be.
 */
export function parseFieldValue(raw: unknown): FieldValue | null {
  if (!isObject(raw) || typeof raw.kind !== "string") return null;
  let value: FieldValue | null = null;
  switch (raw.kind) {
    case "text":
      if (keysAre(raw, ["kind", "text"]) && typeof raw.text === "string")
        value = { kind: "text", text: raw.text };
      break;
    case "quantity":
      if (
        keysAre(raw, ["kind", "amount", "unit"]) &&
        typeof raw.amount === "string" &&
        typeof raw.unit === "string"
      )
        value = { kind: "quantity", amount: raw.amount, unit: raw.unit };
      break;
    case "date":
      if (
        keysAre(raw, ["kind", "month", "day"], ["year"]) &&
        typeof raw.month === "number" &&
        typeof raw.day === "number" &&
        (raw.year === undefined ||
          raw.year === null ||
          typeof raw.year === "number")
      )
        value = {
          kind: "date",
          ...(raw.year === undefined
            ? {}
            : { year: raw.year as number | null }),
          month: raw.month,
          day: raw.day,
        };
      break;
    case "url":
      if (keysAre(raw, ["kind", "url"]) && typeof raw.url === "string")
        value = { kind: "url", url: raw.url };
      break;
    case "boolean":
      if (keysAre(raw, ["kind", "value"]) && typeof raw.value === "boolean")
        value = { kind: "boolean", value: raw.value };
      break;
    case "choices":
      if (
        keysAre(raw, ["kind", "options", "selected"]) &&
        isStrings(raw.options) &&
        isStrings(raw.selected)
      )
        value = {
          kind: "choices",
          options: [...raw.options],
          selected: [...raw.selected],
        };
      break;
    case "checklist":
      if (
        keysAre(raw, ["kind", "items", "checked"]) &&
        Array.isArray(raw.items) &&
        raw.items.every(
          (item) =>
            isObject(item) &&
            keysAre(item, ["id", "label"]) &&
            typeof item.id === "string" &&
            typeof item.label === "string",
        ) &&
        isStrings(raw.checked)
      )
        value = {
          kind: "checklist",
          items: (raw.items as Array<{ id: string; label: string }>).map(
            (item) => ({ id: item.id, label: item.label }),
          ),
          checked: [...raw.checked],
        };
      break;
  }
  return value !== null && valueProblem(value) === null ? value : null;
}

// ---- display ----------------------------------------------------------------------------------------------------------------------
const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

/** "3 March" without a year, "3 March 2027" with one (UK order; the month named, so it is never ambiguous). */
export function formatDate(value: {
  year?: number | null;
  month: number;
  day: number;
}): string {
  const month = MONTHS[value.month - 1] ?? String(value.month);
  return value.year === undefined || value.year === null
    ? `${value.day} ${month}`
    : `${value.day} ${month} ${value.year}`;
}

/** A one-line summary of a value, for a table cell or a list; the detail views render more (links, checklist items). */
export function formatValue(value: FieldValue): string {
  switch (value.kind) {
    case "text":
      return value.text;
    case "quantity":
      return `${value.amount} ${value.unit}`;
    case "date":
      return formatDate(value);
    case "url":
      return value.url;
    case "boolean":
      return value.value ? "Yes" : "No";
    case "choices":
      return value.selected.length === 0
        ? `None selected of ${value.options.length}`
        : `${value.selected.join(", ")} (of ${value.options.length})`;
    case "checklist":
      return `${value.checked.length} of ${value.items.length} done`;
  }
}
