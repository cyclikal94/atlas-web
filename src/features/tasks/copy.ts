import type {
  Cadence,
  Carry,
  Goal,
  Outcome,
  Participation,
} from "./model/contract";
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
  any: "Any time",
} as const;
/** The time column of a row with no time of day. */
export const ALL_DAY = "all day";
export const NOW_LABEL = (time: string) => `Now, ${time}`;
export const THINGS = (n: number) => (n === 1 ? "1 thing" : `${n} things`);
export const FOLD_UPCOMING = "Upcoming";
export const UPCOMING = {
  id: "upcoming",
  tomorrow: "Tomorrow",
  restOfWeek: "Rest of the week",
  restOfWeekSub: "a line per task, routine ones folded",
  nextWeeks: "Next weeks",
  nextWeeksSub: "routine tasks folded",
  later: "Later",
  routine: (n: number) => (n === 1 ? "1 routine task" : `${n} routine tasks`),
  show: "show",
  hide: "hide",
  loading: "Loading the days ahead",
  empty:
    "Nothing particular in the month ahead. Routine tasks carry on as usual.",
  fromDevice:
    "Atlas plans the next 30 days with the server. Anything further off appears as it comes within a month.",
  failed: "Atlas couldn't read the days ahead saved on this device.",
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
/** The phone's toggle for the time zone control (the Final design, 8 November 2026). */
export const ZONE_TOGGLE = "Change the time zone";
/** Today's way to a new task (the Final design, 8 November 2026). */
export const NEW_TASK = "New task";
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
    case "timer_ended":
      return "This timer may already have ended. Nothing was saved.";
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

/** The facts strip of a task's page (the Final design): short labels over short values. */
export const FACTS = {
  day: "Day",
  who: "Who",
  repeat: "Repeats",
  carry: "If missed",
  goal: "Goal",
  streak: "Streak",
} as const;
/** The goal as one short phrase for the facts strip. */
export const GOAL_FACT = (goal: Goal): string =>
  goal.kind === "checkbox"
    ? "Tick it off"
    : goal.kind === "checklist"
      ? goal.items.length === 1
        ? "1 item"
        : `${goal.items.length} items`
      : goal.minimum !== null && goal.maximum !== null
        ? `${goal.minimum} to ${goal.maximum} ${goal.unit}`
        : goal.minimum !== null
          ? `At least ${goal.minimum} ${goal.unit}`
          : goal.maximum !== null
            ? `At most ${goal.maximum} ${goal.unit}`
            : `Any amount of ${goal.unit}`;
export const CADENCE = (repeat: Cadence | null): string => {
  if (repeat === null) return "Once";
  const n = repeat.interval;
  switch (repeat.frequency) {
    case "daily":
      return n === 1 ? "Every day" : `Every ${n} days`;
    case "weekly":
      return n === 1 ? "Every week" : `Every ${n} weeks`;
    case "monthly":
      return n === 1 ? "Every month" : `Every ${n} months`;
    case "yearly":
      return n === 1 ? "Every year" : `Every ${n} years`;
    case "after_completion":
      return n === 1 ? "The day after it's done" : `${n} days after it's done`;
  }
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
  notKnown: "Not known yet",
  offline: "Not available offline",
  server: (outcome: Outcome, at: string) => `${OUTCOME[outcome]} (as of ${at})`,
  // Said after the "Shared result" heading, so it does not repeat it (8 November 2026).
  lastChecked: (outcome: Outcome, at: string) =>
    `${OUTCOME[outcome]}, last checked ${at}`,
} as const;
