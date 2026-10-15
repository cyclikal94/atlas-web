import {
  BEARER_TOO_LONG,
  LABEL_REQUIRED,
  LABEL_TOO_LONG,
  TIMEZONE_INVALID,
  URL_INVALID,
  URL_REQUIRED,
  URL_REQUIRED_FOR_REPLACE,
} from "../copy";

/**
 * Field validation for the calendar forms (contract bounds of `CalendarCommand` and `CalendarConnection`). Each returns the message to
 * show under the field, or null. The entered text is never changed or cleared by a failed validation; the server remains the
 * authority (a `422` it returns is shown at the field too).
 */
export const LABEL_MAX = 300;
export const BEARER_MAX = 4096;

/** Characters as JSON Schema counts them (code points), not UTF-16 units. */
const length = (value: string): number => [...value].length;

export function labelError(label: string): string | null {
  const trimmed = label.trim();
  if (trimmed === "") return LABEL_REQUIRED;
  if (length(trimmed) > LABEL_MAX) return LABEL_TOO_LONG;
  return null;
}

/**
 * A timezone the browser recognises as an IANA name. The server (`chrono_tz`) is the authority; a name it does not know is a `422`
 * the form shows at the field.
 */
export function timezoneError(timezone: string): string | null {
  const name = timezone.trim();
  if (name === "") return TIMEZONE_INVALID;
  try {
    new Intl.DateTimeFormat("en", { timeZone: name });
    return null;
  } catch {
    return TIMEZONE_INVALID;
  }
}

/** The browser's own zone: the default of a new source. */
export function defaultTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

export function urlError(
  url: string,
  purpose: "link" | "replace" = "link",
): string | null {
  const value = url.trim();
  if (value === "")
    return purpose === "replace" ? URL_REQUIRED_FOR_REPLACE : URL_REQUIRED;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return URL_INVALID;
  }
  return parsed.protocol === "https:" || parsed.protocol === "http:"
    ? null
    : URL_INVALID;
}

export function bearerError(bearer: string): string | null {
  return length(bearer) > BEARER_MAX ? BEARER_TOO_LONG : null;
}
