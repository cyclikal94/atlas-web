/**
 * Every sentence of the Lists screens (WEB-10b). Provisional copy: STAGED-ACCEPTANCE-20261011 collects it, with a reviewable route, for the
 * connected-app checkpoint after WEB-10a, WEB-10b, WEB-11a and Settings are integrated (docs/lists.md lists what goes beyond the drawing).
 * UK English.
 */
export const LISTS = {
  pane: "Lists",
  newList: "+ New list",
  newListEmpty: "New list",
  archivedFilter: "Archived",
  more: "More lists",
  first: "First page",
  empty: "No lists yet. Group tasks you check off together.",
  emptyArchived: "No archived lists.",
  noneHere: "No lists here.",
  loading: "Loading your lists",
  choose: "Choose a list to see its tasks.",
  count: (n: number) => `${n} ${n === 1 ? "task" : "tasks"}`,
  countUnknown: "Number of tasks not known",
  attention: "A change to your lists needs your attention in Sync.",
  openSync: "Open Sync",
  toTasks: "Lists",
} as const;

export const DETAIL = {
  back: "‹ Lists",
  rename: "Rename",
  sharing: "Sharing",
  sharingWait: "You can share this list once it has synced.",
  archive: "Archive",
  restore: "Restore",
  archivedNote: "This list is archived.",
  archived: "Archived. Not sent yet.",
  restored: "Restored. Not sent yet.",
  archiveConflict:
    "This list changed on another device before your change was sent. Review it in Sync.",
  noEdit: "You can't change this list",
  absent: "This list isn't on this device.",
  unreadable: "This list can't be shown on this device.",
  loading: "Loading this list",
  add: "Add task to list",
  atLimit: "This list already has 100 tasks, its maximum",
  /** D-10b-9: the drawn caption, corrected for the backend (another person never receives a task they cannot open). */
  caption:
    "Lists don't change who can see a task. People who can see this list see only the tasks they can already open.",
  withheld: "Task you can't open",
  withheldTag: "(withheld)",
  archivedTask: "Archived",
  notSent: "Not sent yet",
  remove: "Remove",
  removeLabel: (title: string) => `Remove ${title}`,
  removeWithheld: "Remove this task",
  removed: (title: string, list: string) =>
    `Removed “${title}” from ${list}. Not sent yet.`,
  removedWithheld: (list: string) =>
    `Removed a task from ${list}. Not sent yet.`,
  empty: "No tasks in this list yet.",
  /**
   * A capacity refusal (D-10b-10, corrected in Running): the server counts tasks the person cannot see, and a refused change holds the
   * list's later changes on this device until it is retried or discarded (the queue keeps a list's changes in order).
   */
  refused: (title: string | null) =>
    `Couldn't add ${title === null ? "a task" : `“${title}”`}: this list is full. It may also hold tasks you can't see. Your other changes to this list wait until you retry or discard this one in Sync.`,
  attention: "A change to this list needs your attention in Sync.",
  openSync: "Open Sync",
} as const;

export const CREATE = {
  title: "Create a list",
  name: "Name",
  placeholder: "e.g. Weekend groceries",
  caption:
    "New lists use your sharing defaults for lists. Choose people later with Sharing.",
  submit: "Create list",
  cancel: "Cancel",
  saved: "List created. Not sent yet.",
  reviewNeeded:
    "List saved on this device. Check who it's shared with in Sync before it's sent.",
} as const;

export const RENAME = {
  title: "Rename a list",
  name: "Name",
  submit: "Save",
  cancel: "Cancel",
  saved: "List renamed. Not sent yet.",
  newer: "Saved. Your newer changes are still here.",
  changedElsewhere:
    "This list's unsent change was edited somewhere else. What you typed is kept here: check it, then save again.",
  waitSync: "You can rename this list once it has synced.",
  unchanged: "Change the name to save it.",
  gone: "This list isn't on this device any more. What you typed is kept here.",
} as const;

export const NAME_PROBLEM = {
  blank: "Give the list a name.",
  too_long: "Use 300 characters or fewer.",
} as const;

export const PICKER = {
  title: "Add task to list",
  search: "Search your tasks…",
  searchLabel: "Search your tasks",
  group: "Tasks",
  caption: "Only tasks you can already see are shown.",
  notSent: "Not sent yet",
  more: "More tasks",
  first: "First page",
  loading: "Loading your tasks",
  chooseFirst: "Choose the tasks to add first.",
  newer: "Saved. Your newer changes are still here.",
  selected: (n: number) => `${n} selected`,
  room: (n: number) => `This list can take ${n} more.`,
  short: (n: number) =>
    `This list can now take only ${n} more. Choose fewer tasks.`,
  submit: "Add selected",
  cancel: "Cancel",
  none: "No tasks to add.",
  noMatch: "No tasks match your search.",
  failed: "Couldn't read this device's tasks.",
  results: (n: number, more: boolean) =>
    `${n} ${n === 1 ? "task" : "tasks"}${more ? " shown, more available" : ""}`,
  added: (n: number, list: string) =>
    `Added ${n} ${n === 1 ? "task" : "tasks"} to ${list}. Not sent yet.`,
  partial: (k: number, n: number, reason: string) =>
    `Added ${k} of ${n}. The others weren't saved: ${reason}`,
} as const;
