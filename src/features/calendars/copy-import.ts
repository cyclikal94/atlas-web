import { IMPORT_LIMITS } from "./model/import";

/**
 * The words of the import journey (WEB-13b). VERBATIM from `wireframes/q21/calendar-journeys.html` where the wireframe draws them (marked
 * "verbatim"); everything else is PROVISIONAL, collected for the working-app checkpoint and WEB-15's copy review (STAGED-ACCEPTANCE-20261011).
 * Nothing here names a schema field, an endpoint or a code. Loaded with the calendar screen only (never the first load).
 */

// ---- the row action and the drop zone -------------------------------------------------------------------------------------------------
/** Verbatim. */
export const IMPORT_EVENTS = "Import events";
export const importEventsName = (label: string): string =>
  `Import events into ${label}`;
/** Verbatim. */
export const DROP_CLASS = "Import — offline-queueable";
export const DROP_PROMPT = "Drop an .ics file, or";
export const BROWSE = "browse";
export const BOUNDS = "Up to 730 days coverage · 1 MiB · 20,000 lines";
/** Provisional: the reasons "Import events" is unavailable. */
export const VIEW_ONLY_IMPORT =
  "Only people who can edit this calendar can import into it.";
export const TURNED_OFF_IMPORT = "Turn this calendar on to import into it.";
export const NO_SOURCE_YET = "Add a calendar source first.";

// ---- the dialog ---------------------------------------------------------------------------------------------------------------------
/** Provisional. */
export const IMPORT_TITLE = "Import events";
export const SOURCE = "Calendar";
export const FILE = "File";
/** Verbatim (the date range panel's two ends). */
export const FROM = "From";
export const THROUGH = "Through";
export const IMPORT = "Import";
export const CHOOSE_FILE = "Choose a file…";
export const CHANGE_FILE = "Choose another file…";
/** Verbatim. */
export const DIALOG_BOUNDS =
  "Bounded to 730 days of coverage, 1 MiB, 20,000 lines and 256 components — a range exceeding these limits is rejected before it's ever sent, not after upload. If a send is retried after a lost response, it won't create a duplicate import.";
/** Provisional. */
export const fileSummary = (
  name: string,
  bytes: number,
  events: number,
): string =>
  `${name} · ${formatBytes(bytes)} · ${events === 1 ? "1 event" : `${events.toLocaleString("en-GB")} events`}`;
export const READING = "Checking the file…";
/** Provisional: why Import waits while the file just chosen is being read. */
export const WAIT_FOR_FILE =
  "Import is available once the file has been checked.";
export const FILE_REQUIRED = "Choose an .ics file to import.";
export const SOURCE_GONE = "This calendar source can no longer be shown.";
export const IMPORT_QUEUED = "Import queued.";
/** Provisional: an import was queued as it was submitted, and what was changed in the dialog meanwhile is still there, not saved. */
export const IMPORT_QUEUED_NEWER =
  "Import queued as it was when you pressed Import. Your newer changes are still here.";
export const IMPORT_CLOSED_REFRESHING =
  "Import closed while your calendar sources are brought up to date.";
export const NO_SOURCES_TO_IMPORT =
  "There's no calendar here you can import into.";

/** Provisional: why a chosen file was refused on this device (nothing was stored or sent). */
export const FILE_PROBLEMS: Readonly<Record<string, string>> = {
  not_utf8: "This file isn't a text calendar Atlas can read (it isn't UTF-8).",
  too_large: `This file is larger than ${formatBytes(IMPORT_LIMITS.bytes)}.`,
  too_many_lines: "This file has more than 20,000 lines.",
  too_many_events: "This file has more than 256 events.",
  not_calendar: "This file isn't a calendar (.ics) file.",
  unreadable: "Couldn't read this file — choose it again.",
  envelope:
    "This file is too large to send once it's packaged — split it into smaller files.",
};

/** Provisional: the window's field messages. */
export const WINDOW_FORMAT = "Enter a date, e.g. 2026-01-01";
export const WINDOW_RANGE = "Enter a date between 1900 and 9999";
export const WINDOW_SPAN =
  "The end must be on or after the start, and no more than 730 days later";

// ---- the Imports panel --------------------------------------------------------------------------------------------------------------
/** Provisional. */
export const IMPORTS_HEADING = "Imports";
export const UNKNOWN_SOURCE = "a calendar source that's no longer shown";
export const queuedAt = (when: string): string => `Queued ${when}`;
/** Verbatim (the status sequence). */
export const STATUS_QUEUED = "Queued — waiting to send, or sending now.";
export const STATUS_SENT = "Sent — waiting for the server to confirm.";
/** Provisional. */
export const STATUS_RETRYING = "Trying again…";
export const STATUS_PAUSED = "Sent — couldn't confirm yet.";
export const OPEN_QUEUE = "Open Waiting to send";
/** Verbatim (the success panel). */
export const STATUS_ACCEPTED = "Import accepted.";
export const STATUS_SYNCING =
  "Its events will appear here shortly, once this device has synced them.";
/** Verbatim (the rejected panel), with the reason in the middle. */
export const rejectedImport = (reason: string): string =>
  `Couldn't import this file — ${reason}. Nothing changed: your existing events for this source are exactly as before.`;
export const DISMISS_IMPORT = "Dismiss";
export const SHOW_NEXT_IMPORTS = "Show next imports";
export const SHOW_PREVIOUS_IMPORTS = "Show previous imports";

/** Provisional: the reasons the server gave (§5.3 of the plan), by code; `other` when it gave another. */
export const IMPORT_REASONS: Readonly<Record<string, string>> = {
  invalid_ics: "the file isn't a valid calendar",
  unsupported_calendar_rule: "it uses a repeat rule Atlas doesn't support",
  unsupported_calendar_timezone: "it uses a time zone Atlas doesn't recognise",
  calendar_limit:
    "it's over Atlas's limits (730 days, 1 MiB, 20,000 lines, 256 events or 2,048 repeats)",
  fetch_failed:
    "it contains something Atlas can't read, such as an event title over 300 characters or a date outside 1900–9999",
  stale_refresh:
    "another update to this calendar finished first — import the file again",
  invalid_value: "this calendar is turned off, or the request was invalid",
  forbidden: "you can no longer change this calendar",
  not_found: "this calendar no longer exists, or you can no longer see it",
  dependency_rejected:
    "an earlier change to this calendar wasn't accepted, so this import wasn't sent — import the file again",
  other: "the server turned it down",
};
/** Provisional: an import the server could not store for lack of room (`slice_capacity`): never "your account is full" (case 7(c)). */
export const IMPORT_CAPACITY =
  "Atlas has run out of room for new items on this server, so these events couldn't be added. Nothing changed. Your administrator may need to free space; you can retry from Waiting to send.";

// ---- the queue ----------------------------------------------------------------------------------------------------------------------
/** Provisional (content-free). */
export const DESCRIBE_IMPORT = "Import calendar events";

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.ceil(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(bytes % (1024 * 1024) === 0 ? 0 : 1)} MiB`;
}
