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
  restOfWeek: "Rest of week",
  restOfWeekSub: "a line per task, routine ones folded",
  nextWeek: "Next week",
  nextWeekSub: "routine tasks folded",
  /**
   * What the sticky bar says while a block of the days ahead is under it: "Tomorrow · Monday 9 November", "Rest of week · Tuesday 10
   * November", "Next week · Monday 16 November", "November · 23–29 Nov", "December · 1–6 Dec".
   */
  bar: (block: string, detail: string) => `${block} · ${detail}`,
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
/** Focus mode from the day (the Final design): one thing at a time. */
export const FOCUS_MODE = "Focus on one thing at a time";
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
  turn: "Turn",
  repeat: "Repeats",
  carry: "If missed",
  goal: "Goal",
  timer: "Timer",
  streak: "Streak",
  follows: "Follows",
  seenBy: "Seen by",
} as const;
/** The task page's summary line (the Final design): "18:30 today · every Monday · your turn". */
export const SUMMARY_LINE = {
  anyTime: "Any time",
  today: "today",
  tomorrow: "tomorrow",
  yourTurn: "your turn",
  theirTurn: (name: string) => `${name}'s turn`,
  justYou: "just you",
} as const;
/** A number of seconds as a short duration ("20 min", "1 h 30 min", "45 s"). */
export const DURATION = (seconds: string): string => {
  const n = Number(seconds);
  if (!Number.isFinite(n)) return `${seconds} s`;
  const h = Math.floor(n / 3600);
  const m = Math.round((n % 3600) / 60);
  if (h > 0) return m > 0 ? `${h} h ${m} min` : `${h} h`;
  if (m > 0) return `${m} min`;
  return `${Math.round(n)} s`;
};
/** The goal as one short phrase for the facts strip; a goal in seconds (a timer) reads as a duration. */
export const GOAL_FACT = (goal: Goal): string => {
  if (goal.kind === "checkbox") return "Tick it off";
  if (goal.kind === "checklist")
    return goal.items.length === 1 ? "1 item" : `${goal.items.length} items`;
  const timed = goal.unit === "seconds";
  const amount = (value: string) =>
    timed ? DURATION(value) : `${value} ${goal.unit}`;
  return goal.minimum !== null && goal.maximum !== null
    ? timed
      ? `${DURATION(goal.minimum)} to ${DURATION(goal.maximum)}`
      : `${goal.minimum} to ${goal.maximum} ${goal.unit}`
    : goal.minimum !== null
      ? `At least ${amount(goal.minimum)}`
      : goal.maximum !== null
        ? `At most ${amount(goal.maximum)}`
        : timed
          ? "Any length of time"
          : `Any amount of ${goal.unit}`;
};
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

/** Quick add from the day (the Final design, 8 November 2026): the row at the end of the day and the search pill's "Add". */
export const QUICK_ADD = {
  placeholder: (dayLabel: string) => `Add to ${dayLabel}…`,
  label: "Add a task",
  added: (title: string) => `Added “${title}”. Not sent yet.`,
  review:
    "Added. Review who gets this task in the sync queue before it's sent.",
  saving: "Adding…",
} as const;

/** The search pill and its palette (the Final design): one place to find a task, a list or a person, or add a task to the day. */
export const PALETTE = {
  placeholder: "Search or add anything…",
  label: "Search or add",
  title: "Search or add",
  tasks: "Tasks",
  lists: "Lists",
  people: "People",
  add: (text: string, day: string) => `Add “${text}” to ${day}`,
  newTask: "New task with every option",
  empty: "Type to search your tasks, lists and people, or to add a task.",
  none: (query: string) => `Nothing matches “${query}”.`,
  shortcut: "⌘K",
} as const;

/** Recording from a row (the Final design): an amount or a checklist is logged on the day, without leaving it. */
export const LOG_AMOUNT = "Log an amount";
export const TICK_ITEMS = "Tick off items";
export const JUST_CHECKED = "Just checked";
export const CLOSE_RECORDER = "Done logging";
export const AMOUNT_LABEL = (unit: string) => `Amount (${unit})`;
