/**
 * The words of task anchors (WEB-13b): the anchor-configuration panel, its pickers, the task's anchor section and the new-task form's
 * section. VERBATIM from `wireframes/q21/calendar-journeys.html` where it draws them; everything else PROVISIONAL (STAGED-ACCEPTANCE-20261011).
 * Loaded with the screens that use them only.
 */

// ---- the panel ----------------------------------------------------------------------------------------------------------------------
/** Provisional. */
export const ANCHOR_TITLE = "Anchor to a calendar";
/** Verbatim. */
export const REFERENCE = "Reference";
export const EVENT_SERIES = "Event series";
export const PERSON_DATE = "Person date";
export const CHANGE_EVENT = "Change event…";
export const CHOOSE_FIELD = "Choose field…";
export const REPEATS_ANNUALLY = "repeats annually";
export const SELECTED = "Selected";
/** Provisional: nothing chosen yet. */
export const NO_EVENT = "No event chosen";
/** Verbatim ("Person date — no field selected"). */
export const NO_FIELD = "no field selected";
/** Verbatim. */
export const OFFSET = "Offset — days, at a time (optional)";
export const CALENDAR_DAYS = "calendar day(s), at";
export const CLEAR_TIME = "Clear time";
export const OR_SECONDS =
  "or seconds before/after (requires a timed anchor, not date-only)";
export const SECONDS = "seconds before/after";
/** Provisional. */
export const DAYS_LABEL = "Days before (−) or after (+)";
export const TIME_LABEL = "Time (optional)";
export const SECONDS_LABEL = "Seconds before (−) or after (+)";
export const USE_DAYS = "Use days";
export const USE_SECONDS = "Use seconds";
export const NEEDS_TIMED_EVENT = "Needs a timed event";
/** Verbatim. */
export const WEEKDAYS =
  "Eligible weekdays (optional — all seven, not a working-week subset)";
export const TITLE_CONTAINS =
  "Title contains (optional — event series only, see note above)";
export const SAVE_ANCHOR = "Save anchor";
export const REMOVE_ANCHOR = "Remove anchor";
export const REMOVE_HELP =
  "Removing an anchor stops automation and keeps existing occurrences — it does not delete history.";
export const REPEATS_ITSELF =
  "This task repeats on its own schedule — remove its recurrence before anchoring it to a calendar";
/** Verbatim (the field messages). */
export const WHOLE_NUMBER = "Enter a whole number of days (or seconds)";
export const VALID_TIME = "Enter a valid 24-hour time, e.g. 18:00";
/** Provisional: the other field messages. */
export const DAYS_RANGE = "Enter a number of days from −366 to 366";
export const SECONDS_RANGE =
  "Enter a number of seconds from −31,622,400 to 31,622,400";
export const TITLE_TOO_LONG = "Keep this to 100 bytes or fewer";
export const CHOOSE_REFERENCE = "Choose an event or a date field first";
/** Provisional: the weekday toggles' names (their visible letters are verbatim). */
export const WEEKDAY_NAMES = [
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
  "Sunday",
] as const;
export const WEEKDAY_LETTERS = ["M", "T", "W", "T", "F", "S", "S"] as const;

// ---- the pickers --------------------------------------------------------------------------------------------------------------------
/** Provisional. */
export const PICK_EVENT_TITLE = "Choose an event";
export const PICK_FIELD_TITLE = "Choose a date field";
export const CALENDAR = "Calendar";
export const SEARCH_TITLES = "Search event titles";
export const SEARCH_FIELDS = "Search fields";
export const NO_EVENTS_YET = "No events yet";
export const NO_MATCHES = "Nothing matches";
export const NO_DATE_FIELDS = "No date fields on this device yet";
export const SEARCH_FURTHER = "Search further";
export const SHOW_NEXT_EVENTS = "Show next events";
export const SHOW_PREVIOUS_EVENTS = "Show previous events";
export const SHOW_NEXT_FIELDS = "Show next fields";
export const SHOW_PREVIOUS_FIELDS = "Show previous fields";
export const CHOOSE = "Choose";
export const BACK = "Back";
export const EVENT_CANCELLED = "Cancelled";
export const EVENT_MISSING = "No longer in the calendar";
export const ALL_DAY = "all day";

// ---- the task's section -------------------------------------------------------------------------------------------------------------
/** Provisional. */
export const SECTION_HEADING = "Calendar anchor";
export const ANCHOR_ACTION = "Anchor…";
export const CHANGE_ANCHOR = "Change anchor…";
export const anchoredTo = (description: string): string =>
  `Anchored to ${description}`;
export const AUTOMATION_OFF = "Automation is off";
export const NOT_ANCHORED = "Not anchored to a calendar.";
/** Verbatim (case 3). */
export const BINDING_OFFLINE = "Binding details need a connection.";
/** Provisional. */
export const BINDING_OFFLINE_EDIT =
  "The current anchor couldn't be read without a connection.";
export const BINDING_READING = "Reading the anchor…";
export const BINDING_FAILED = "Couldn't load the anchor";
export const TRY_AGAIN = "Try again";
/** Verbatim (the Manage source / anchor states, capitalised as a status line). */
export const ANCHOR_QUEUED = "Anchor change waiting to send";
export const ANCHOR_SAVING = "Saving — will confirm on next sync";
/** Provisional. */
export const ANCHOR_CONFLICT =
  "This task changed elsewhere — check the anchor before saving again.";
export const anchorRejected = (reason: string): string =>
  `Couldn't anchor this task — ${reason}`;
export const ANCHOR_REASONS: Readonly<Record<string, string>> = {
  recurrence: "it repeats on its own schedule",
  untimed: "seconds offsets need a timed event",
  unavailable:
    "the calendar or date field is no longer available to everyone who can see this task",
  other: "the server turned it down",
};
export const REVIEW_ANCHOR = "Review";
export const DISMISS_ANCHOR = "Dismiss";
export const ANCHOR_SAVED = "Anchor change saved.";
export const ANCHOR_REMOVED = "Anchor removal saved.";
export const ANCHOR_NOT_SAVED_CHANGED =
  "This task changed while you were editing — check the anchor and save again.";
export const ANCHOR_NOT_SAVED_DENIED = "You can't change this task.";

// ---- the new-task form ----------------------------------------------------------------------------------------------------------------
/** Verbatim ("Anchor to a calendar event"). */
export const FORM_SECTION = "Anchor to a calendar event";
/** Provisional. */
export const FORM_NONE = "Not anchored.";
export const FORM_ANCHOR = "Anchor…";
export const FORM_CHANGE = "Change…";
export const FORM_REMOVE = "Remove";

// ---- descriptions -------------------------------------------------------------------------------------------------------------------
/** Provisional: the queue's content-free description. */
export const DESCRIBE_SET_ANCHOR = "Anchor a task to a calendar";
/** Provisional: an anchor's summary pieces. */
export const daysWords = (days: number): string =>
  days === 0
    ? "on the day"
    : `${Math.abs(days)} day${Math.abs(days) === 1 ? "" : "s"} ${days < 0 ? "before" : "after"}`;
export const secondsWords = (seconds: number): string =>
  seconds === 0
    ? "at the event's time"
    : `${Math.abs(seconds).toLocaleString("en-GB")} second${Math.abs(seconds) === 1 ? "" : "s"} ${seconds < 0 ? "before" : "after"}`;
export const atTime = (time: string): string => `at ${time}`;
export const ANNUALLY = "every year";
export const AN_EVENT = "a calendar event";
export const A_DATE = "a date field";
