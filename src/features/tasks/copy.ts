import type { Carry, Outcome, Participation } from "./model/contract";
import type { Filter, Pill } from "./model/row-state";
import type { PendingMark } from "./view";

/**
 * Every sentence of the task screens (provisional copy: STAGED-ACCEPTANCE-20261011 collects it for the connected-app checkpoint; the words
 * beyond the drawings are listed in docs/tasks.md). UK English.
 */
export { TASKS_TITLE, TODAY_TITLE } from "./titles";

export const FILTER_LABEL: Readonly<Record<Filter, string>> = {
  all: "All",
  to_do: "To do",
  done: "Done",
  missed: "Missed",
};
export const FILTERS_NAME = "Show";

export const PILL: Readonly<Record<Pill, string>> = {
  conflict: "Conflict",
  excluded: "Excluded",
  done: "Done",
  done_late: "Done late",
  covered: "Waiting on an earlier day",
  closed: "Closed, not completed",
  missed: "Missed",
  on_track: "On track",
  to_do: "To do",
  not_open: "Not open yet",
  unavailable: "Not available offline",
  unknown: "Not known",
};

export const PENDING: Readonly<Record<PendingMark, string>> = {
  queued: "Not sent yet",
  sending: "Sending…",
  waiting: "Waiting for the server",
};
export const PROVISIONAL = "provisional";
export const STALE =
  "Waiting for the server to check the full history of this day.";

export const GROUPS = {
  morning: "Morning",
  afternoon: "Afternoon",
  evening: "Evening",
  any: "Any time today",
} as const;

export const SUMMARY = (
  done: number,
  total: number,
  toDo: number,
  notKnown: number,
) =>
  `${done} of ${total} done · ${toDo} still to do${notKnown > 0 ? ` · ${notKnown} not known` : ""}`;
export const EMPTY = (filter: Filter) =>
  filter === "all"
    ? "Nothing due on this day."
    : `Nothing ${FILTER_LABEL[filter].toLowerCase()} on this day.`;
export const LOADING = "Loading this day";
export const ERROR_TITLE = "Couldn't load this day";
export const ERROR_BODY = "Atlas couldn't get this day's list from the server.";
export const KEPT_CHANGING = "The list kept changing while loading.";
export const SHOWING_DEVICE = "Showing what's on this device.";
/** Revision 3 (R9): this device's own saved tasks could not be read whole. Provisional copy (docs/tasks.md checkpoint list). */
export const LOCAL_ERROR_TITLE = "Couldn't read this device's tasks";
export const LOCAL_FAILED =
  "Atlas couldn't read the tasks saved on this device.";
export const LOCAL_UNSTABLE =
  "The tasks saved on this device kept changing while they were read.";
export const SHOWING_LAST_READ = "Showing what was last read on this device.";
export const TRY_AGAIN = "Try again";
export const REQUEST_ID = (id: string) => `Request ID: ${id}`;
export const PENDING_TASKS =
  "Some repeating tasks haven't been brought up to date, so today's list may be missing items.";
export const DAY_LABEL = "Day";
export const ZONE_LABEL = "Time zone";
export const ZONE_HINT = (zone: string) => `Times are shown in ${zone}.`;
export const PREVIOUS_DAY = "Previous day";
export const NEXT_DAY = "Next day";
export const BACK_TO_TODAY = "Back to today";
export const FROM_DAY = (label: string) => `From ${label}`;
export const UNTITLED = "Untitled task";
export const UNREADABLE = "This item can't be shown on this device.";
export const WHY_AT = (time: string) => `Why is this at ${time}?`;
export const WHY_BODY = (zone: string) =>
  `This task is scheduled in ${zone}. Daylight-saving changes and your display time zone change when it shows, never which day it belongs to.`;

export const MARK_DONE = "Mark done";
export const MARK_NOT_DONE = "Mark not done";
export const RECORD = "Record";
export const SAVING = "Saving on this device…";
export const NOT_OPEN_UNTIL = (label: string) => `Not open until ${label}`;
export const DAY_CLOSED = "This day is closed";
export const ONLY_PARTICIPANTS = "Only participants can record this";
export const NOT_WRITABLE =
  "Atlas can't save changes until this app is updated.";
export const COVERED_REASON = "An earlier day of this task is still open";
export const RESOLVED_REASON = "This day was closed without completing";

export const ANNOUNCE_DONE = "Marked done. Not sent yet.";
export const ANNOUNCE_NOT_DONE = "Marked not done. Not sent yet.";
export const ANNOUNCE_SAVED =
  "Saved on this device. It will be sent when Atlas can.";

/** Enqueue refusals, never shown as saved (§4.6). `null`: say nothing (the gate has taken over). */
export function refusalMessage(reason: string): string | null {
  switch (reason) {
    case "fenced":
    case "closing":
      return "Saving isn't possible while signing out.";
    case "quota":
      return "There isn't enough storage space on this device to save this.";
    case "no_base":
      return "This isn't available on this device yet.";
    case "denied":
      return "You can't change this. Nothing was saved.";
    case "closed":
    case "identity_changed":
      return null;
    default:
      return "Couldn't save on this device. Try again.";
  }
}
export const NO_DATABASE = "This isn't available on this device yet.";

export const CARRY: Readonly<Record<Carry, { label: string; line: string }>> = {
  close_incomplete: {
    label: "Close it",
    line: "If it isn't done in time, the day closes as missed.",
  },
  retain_one: {
    label: "Keep one open",
    line: "If it isn't done, it stays open and later days wait for it.",
  },
  accumulate: {
    label: "Let them add up",
    line: "If it isn't done, it stays open alongside the next days.",
  },
};

export const PARTICIPATION: Readonly<Record<Participation, string>> = {
  personal: "Just me",
  anyone: "Anyone",
  everyone: "Everyone",
  pooled: "Pooled",
};
/** Who takes part (Q8): "You" only for someone known to take part (R28, revision 15); names are WEB-11a's. */
export const WHO = {
  you: "You",
  youAnd: (n: number) => `You and ${n} other${n === 1 ? "" : "s"}`,
  people: (n: number) => `${n} ${n === 1 ? "person" : "people"}`,
} as const;
export const PARTICIPATION_LINE: Readonly<Record<Participation, string>> = {
  personal: "Only you do this.",
  anyone: "Done when anyone does it.",
  everyone: "Done when everyone has done their part.",
  pooled: "Everyone adds to one shared total.",
};

export const OUTCOME: Readonly<Record<Outcome, string>> = {
  unknown: "Not known",
  incomplete: "Not done yet",
  provisional: "On track",
  complete: "Done",
  missed: "Missed",
  excluded: "Excluded",
};

export const JOINT = {
  heading: "Shared result",
  withheld:
    "Withheld — Shared total hidden: someone's part isn't shared with you",
  anyoneUnknown: "No one has finished it yet that you can see",
  notKnown: "Shared result not known yet",
  offline: "Not available offline",
  server: (outcome: Outcome, at: string) => `${OUTCOME[outcome]} (as of ${at})`,
  lastChecked: (outcome: Outcome, at: string) =>
    `Shared result: ${OUTCOME[outcome]}, last checked ${at}`,
} as const;
