/**
 * Every user-facing string of the people screens (WEB-11a). The accepted export (`Atlas People Screens.dc.html`) owns the drawn copy, the
 * Q21 wireframes (`profile-rename-unlink.html`, `archive-restore.html`) their additions, and design-coverage §9 row 2 the corrected
 * offline-audience caveat. Strings marked PROVISIONAL are this card's additions or deviations (plan §9): they are collected for the
 * connected-app copy checkpoint (STAGED-ACCEPTANCE-20261011 §5) and do not block, but nothing here is approved by being written down.
 */

// ---- list (WF-PEOPLE-01) --------------------------------------------------------------------------------------------------------------
export { PAGE_TITLE } from "./titles";
export const PAGE_SUBHEAD =
  "Everyone you've added, plus anyone shared with you";
export const NEW_PERSON = "New person";
export const SEARCH = "Search people";
export const FILTER_LABEL = "Show"; // PROVISIONAL
export const FILTER_ALL = "All";
export const FILTER_IN_HOME = "In Home";
export const FILTER_SHARED_WITH_ME = "Shared with me";
export const FILTER_NOT_LINKED = "Not linked";
export const FILTER_ARCHIVED = "Archived"; // PROVISIONAL: an addition beside the drawn chips (archived people, Q21)
export const EMPTY =
  "No one here yet. People appear once you add them, or once someone shares one with you.";
export const EMPTY_ARCHIVED = "Nobody is archived."; // PROVISIONAL
export const OFFLINE_FIRST_VISIT =
  "You're offline and this device hasn't synced yet, so there may be people it can't show.";
export const NOT_SYNCED_YET =
  "This device hasn't synced yet, so there may be people it can't show."; // PROVISIONAL (online, before the first sync)
export const LOAD_FAILED = "Couldn't load people on this device.";
export const TRY_AGAIN = "Try again";
export const NO_MATCH = (query: string) => `No one matches “${query}”.`; // PROVISIONAL
// Bounded steps with a continuation (Q9; finding 7 of the review of 13 October): every record stays reachable.
export const NEXT_PEOPLE = "Next people"; // PROVISIONAL
export const PREVIOUS_PEOPLE = "Previous people"; // PROVISIONAL
export const KEEP_SEARCHING = "Keep searching"; // PROVISIONAL
export const SEARCH_PARTIAL = (n: number) =>
  `Showing ${n} so far. There may be more further on.`; // PROVISIONAL
export const NO_MATCH_YET = (query: string) =>
  `No one matches “${query}” so far. There are more people to check.`; // PROVISIONAL
export const NEXT_FIELDS = "Next fields"; // PROVISIONAL
export const PREVIOUS_FIELDS = "Previous fields"; // PROVISIONAL
export const NEXT_ITEMS = "Next items"; // PROVISIONAL
export const PREVIOUS_ITEMS = "Previous items"; // PROVISIONAL
export const OUTSTANDING_CAPPED =
  "More unsent changes are waiting than this page shows. All of them are in Sync."; // PROVISIONAL
export const COLUMN_PERSON = "Person";
export const COLUMN_ACCOUNT = "Account";
export const COLUMN_DETAILS = "Details";
export const COLUMN_VISIBLE_TO = "Visible to";
export const ADDED_BY_YOU = "Added by you";
export const SHARED_BY = (owner: string) => `Shared with you by ${owner}`;
// The viewer-safe summaries (finding 8, API 0.29): online-only display data, never shown offline or as live.
export const VISIBLE_TO = (audience: string) => `Visible to: ${audience}`; // PROVISIONAL (a labelled line: the list shares the screen with the detail)
export const SUMMARY_CHECKING = "Checking who can see these people…"; // PROVISIONAL
export const SUMMARY_OFFLINE =
  "Who can see each person and their account links are checked when you're online."; // PROVISIONAL
export const SUMMARY_FAILED = "Couldn't check who can see these people."; // PROVISIONAL
export const SUMMARY_AS_OF = (time: string) =>
  `Sharing checked at ${time}. Atlas checks again every minute while you're online.`; // PROVISIONAL (never presented as live)
export const PARTIAL_NOTE =
  "For people someone else owns, you see only how they're shared with you. The owner may have shared them more widely."; // PROVISIONAL (product decision 2, 14 October)
export const VIEW_OFFLINE =
  "This view needs a connection. All and Archived work offline."; // PROVISIONAL
export const VIEW_FAILED = "Couldn't load this view."; // PROVISIONAL
export const IN_HOME_NO_HOME =
  "You haven't chosen a primary household, so nobody is In Home. Everyone you can see is still under All."; // PROVISIONAL (product decision 3)
export const IN_HOME_EMPTY = (home: string) =>
  `Nobody is shared with ${home} yet.`; // PROVISIONAL
export const SHARED_WITH_ME_EMPTY = "Nobody has shared a person with you yet."; // PROVISIONAL
export const NOT_LINKED_EMPTY = "Everyone here is linked to an account."; // PROVISIONAL
export const FIELD_COUNT = (n: number) => `${n} field${n === 1 ? "" : "s"}`;
export const ARCHIVED_TAG = "Archived";
export const YOU = "You";
export const SELECT_PERSON = "Choose someone to see their details."; // PROVISIONAL (desktop detail pane before a selection)
export const BACK_TO_PEOPLE = "People";

// ---- linkage (D-11a-2) ------------------------------------------------------------------------------------------------------------------
export const LINK_SELF = "This is you — you control this profile";
export const LINK_OTHER = (name: string) =>
  `Linked to their own account — ${name} controls this name, not you`;
export const LINK_NONE = "Not linked to an account";
export const LINK_UNKNOWN =
  "Who controls this profile isn't known on this device"; // PROVISIONAL
export const LINK_UNKNOWN_REASON = {
  offline: "It's checked when you're online.",
  loading: "Checking…",
  failed: "Atlas couldn't check just now.",
  refused: "Atlas can't check this person for you.",
  pending: "It's checked once this person has reached the server.",
} as const; // PROVISIONAL
/** The facts strip of a person's page (the Final design, 8 November 2026). */
export const FACTS = {
  linked: "Linked",
  visibleTo: "Visible to",
  fields: "Fields",
  added: "Added",
} as const;
export const FACT_LINK_SELF = "To you";
export const FACT_LINK_OTHER = "To their account";
export const FACT_LINK_NONE = "Not linked";
export const ROW_LINK_SELF = "Linked to your account";
export const ROW_LINK_OTHER = "Linked · they control their name";
export const ROW_LINK_NONE = "Not linked to an account";

// ---- pending marks (§4.3) ---------------------------------------------------------------------------------------------------------------
export const PENDING = {
  not_sent: "Not sent yet",
  sending: "Sending…",
  waiting: "Waiting for the server",
  reviewing: "Waiting for your review",
} as const; // PROVISIONAL

// ---- new person (§4.2) ------------------------------------------------------------------------------------------------------------------
export const NEW_PERSON_TITLE = "New person"; // PROVISIONAL (dialog not drawn)
export const NAME = "Name";
export const PERSON_SHARING = "Who can see this person";
export const USE_DEFAULTS = (resolved: string | null) =>
  resolved === null
    ? "Use my defaults — not loaded yet"
    : `Use my defaults — ${resolved}`;
export const ONLY_YOU = "Only you";
export const ADD_FIRST_NOTE = "Add a first note";
export const HIDE_NOTE = "Don't add a note"; // PROVISIONAL
export const FIRST_NOTE = "First note";
export const SAVE = "Save";
export const CANCEL = "Cancel";
export const SAVING = "Saving…";
export const SAVED_NOT_SENT = "Saved. Not sent yet.";
export const SAVED_REVIEW =
  "Saved. Review who can see this person in the sync queue before it's sent.";
export const SAVED_FIELD_REVIEW =
  "Saved. Review who can see this field in the sync queue before it's sent."; // PROVISIONAL
export const DEFAULTS_LOADING_REASON = "Loading your sharing defaults…";
export const LATER_EDITS_KEPT =
  "Saved. Your later changes are still here and aren't saved yet."; // PROVISIONAL

// ---- person detail (WF-PEOPLE-02) -------------------------------------------------------------------------------------------------------
export const MANAGE_SHARING = "Manage sharing";
export const POSSIBLE_DUPLICATES = "Possible duplicates";
export const RENAME = "Rename";
export const UNLINK = "Unlink account";
export const ARCHIVE = "Archive";
export const RESTORE = "Restore";
export const NOT_ON_DEVICE =
  "This person isn't on this device. They may not have synced yet, or you may no longer have access."; // PROVISIONAL
// A read that failed (or could not be completed) is never "not on this device" or "no fields" (review 6, finding 2).
export const PERSON_READ_FAILED = "Couldn't read this person on this device."; // PROVISIONAL
export const PERSON_UNCONFIRMED =
  "Couldn't read every unsent change on this device, so this person can't be shown."; // PROVISIONAL
export const EDITOR_CHANGES_UNREAD =
  "Couldn't read every unsent change on this device, so this field can't be edited yet."; // PROVISIONAL (review 7)
export const EDITOR_CHANGES_CAPPED =
  "More unsent changes are waiting than this page reads, so this field can't be edited yet. Sync them first."; // PROVISIONAL (review 7)
export const EDITOR_FIELD_UNREAD =
  "Couldn't read this field on this device, so it can't be edited yet."; // PROVISIONAL (review 9)
export const EDITOR_PERSON_UNREAD =
  "Couldn't read this person on this device, so this field can't be edited yet."; // PROVISIONAL (review 9)
export const FIELD_NOT_ON_DEVICE =
  "This field isn't on this device. It may not have synced yet, or you may no longer have access."; // PROVISIONAL (review 9)
export const FIELD_FALLBACK_NAME = "field"; // PROVISIONAL (an editor title when the field can't be read)
export const CHANGES_READ_FAILED =
  "Couldn't read every unsent change on this device. What's shown may not include them."; // PROVISIONAL
export const FIELDS_READ_FAILED =
  "Couldn't read every field of this person on this device. Anything that could be read is listed."; // PROVISIONAL
export const WAIT_FOR_SYNC_PERSON = "Wait for this person to finish syncing"; // PROVISIONAL
export const WAIT_FOR_SYNC_FIELD =
  "Wait for this field to finish syncing before editing it"; // PROVISIONAL
export const DUPLICATES_OFFLINE = "Checking for duplicates needs a connection";
export const NEEDS_CONNECTION = "Needs a connection";
export const READ_ONLY_COMPAT = "Saving is paused until Atlas is updated."; // PROVISIONAL (compatibility not supported)
export const ARCHIVED_PERSON =
  "Archived. Its history and fields stay. Restore to show it in People again."; // PROVISIONAL
export const ARCHIVE_CONFLICT =
  "This changed since it was archived — reload and try again";
export const FIELDS = "Fields";
export const COLUMN_FIELD = "Field";
export const COLUMN_VALUE = "Value";
export const COLUMN_AUDIENCE = "Who can see it";
export const EDIT = "Edit";
export const ADD_FIELD = "Add a field";
export const NO_FIELDS = "No fields yet."; // PROVISIONAL
export const CANNOT_EDIT_FIELD = "You can't edit this field";
export const UNREADABLE_VALUE = "This value can't be shown on this device"; // PROVISIONAL
export const SHOW_MORE = "Show more";
export const SHOW_LESS = "Show less";
export const OPENS_NEW_TAB = "(opens in a new tab)";
export const OF_TOTAL = (n: number) => `of ${n}`;
export const AUDIENCE_UNKNOWN = "Who can see it?"; // PROVISIONAL (D-11a-13)
export const FIELD_CONFLICT =
  "Someone else changed this field. Open it to see the current value.";
export const CREATE_BLOCKED_REVIEW =
  "Review who can see this person in the sync queue first"; // PROVISIONAL
export const NEW_FIELDS_START_AS = "New fields start as";
export const DEFAULTS_EXPLAIN = (home: string) =>
  `That's what your ${home} template currently sets. It's a default you can change in Sharing, not a fixed rule.`;
export const DEFAULTS_UNKNOWN = "Isn't known yet: the defaults haven't loaded";
export const ARCHIVED_FIELDS = (n: number) => `Archived fields (${n})`;
export const CHOOSE_WHO = "Choose who can see it"; // PROVISIONAL (after a private save)
export const FIELDS_SUMMARY_OFFLINE =
  "Who can see each field is checked when you're online."; // PROVISIONAL
export const FIELDS_SUMMARY_FAILED = "Couldn't check who can see these fields."; // PROVISIONAL
export const FIELDS_SUMMARY_CHECKING = "Checking who can see these fields…"; // PROVISIONAL
export const FIELDS_PARTIAL_NOTE =
  "For fields someone else owns, you see only how they're shared with you. The owner may have shared them more widely."; // PROVISIONAL (product decision 2)
export const FIELD_AUDIENCE_PARTIAL =
  "The owner may have shared it more widely."; // PROVISIONAL (product decision 2)
export const FIELD_AUDIENCE_UPPER = (person: string) =>
  `Only people who can also see ${person} can see it.`; // PROVISIONAL (a field's own sharing is an upper bound)

// ---- "Shared with" (WF-PEOPLE-02 rail; finding 8) ---------------------------------------------------------------------------------------
export const SHARED_WITH = "Shared with";
export const OWNER_ROLE = "owner";
export const CAN_VIEW = "can view";
export const CAN_EDIT = "can edit";
export const HOUSEHOLD_SIZE = (n: number) =>
  `${n} member${n === 1 ? "" : "s"} in the household`; // PROVISIONAL (household size, never an audience count)
export const HOUSEHOLD_LEFT = "A household you've left"; // PROVISIONAL (redacted: the owner is no longer a member)
export const EXCLUDED_MEMBER = "can't see it"; // PROVISIONAL (excluded by the owner)
export const EXCLUDED_ACCOUNTS = (names: string) => `Excluded: ${names}`; // PROVISIONAL
export const ONLY_YOU_RAIL = "Only you can see this person."; // PROVISIONAL
export const RAIL_PARTIAL = (owner: string) =>
  `${owner} owns this person. You see only how it's shared with you; ${owner} may have shared it more widely.`; // PROVISIONAL (product decision 2)
export const RAIL_OFFLINE =
  "Who it's shared with is checked when you're online."; // PROVISIONAL
export const RAIL_CHECKING = "Checking who it's shared with…"; // PROVISIONAL
export const RAIL_FAILED = "Couldn't check who it's shared with."; // PROVISIONAL
export const RAIL_NOT_FOUND =
  "Atlas can't show who this person is shared with."; // PROVISIONAL

// ---- rename and unlink (Q21 gap 6) ----------------------------------------------------------------------------------------------------
export const RENAME_OTHER_OWNS = (name: string) => `${name} owns this name`;
export const RENAME_UNKNOWN =
  "Needs a connection to check who controls this name"; // PROVISIONAL
export const RENAME_CANNOT_EDIT = "You can't edit this person"; // PROVISIONAL
export const UNLINK_OTHER = (name: string) =>
  `Only ${name} (the linked account) can unlink this profile`;
export const CONFLICT =
  "Someone else already changed this — reload and try again.";
export const RELOAD = "Reload";
export const FORBIDDEN_PROFILE = "You can't change this profile any more"; // PROVISIONAL
export const UNCERTAIN =
  "We couldn't confirm this was saved. Try again — it won't be applied twice."; // PROVISIONAL
export const UPDATING = "Updating…"; // PROVISIONAL
export const UNLINK_TITLE = "Unlink your account from this profile?"; // PROVISIONAL (dialog described, not drawn)
export const UNLINK_BODY =
  "Your past contributions and who can see them stay exactly as they are. Only the link between your account and this profile is removed. To link it again later, a link request is needed."; // PROVISIONAL
export const UNLINKED = "Unlinked."; // PROVISIONAL
export const RENAMED = "Renamed."; // PROVISIONAL

// ---- field editor (WF-PEOPLE-03) ------------------------------------------------------------------------------------------------------
export const ADD_FIELD_TITLE = "Add a field";
export const EDIT_FIELD_TITLE = (name: string) => `Edit ${name}`;
export const FIELD_NAME = "Name";
export const FIELD_TYPE = "Type";
export const FIELD_VALUE = "Value";
export const KIND_LABEL = {
  text: "Text",
  quantity: "Amount",
  date: "Date",
  url: "Link",
  boolean: "Yes or no",
  choices: "Choices",
  checklist: "Checklist",
} as const; // PROVISIONAL (types not drawn)
export const AMOUNT = "Amount";
export const UNIT = "Unit";
export const DAY = "Day";
export const MONTH = "Month";
export const YEAR = "Year (optional)";
export const YEAR_HINT =
  "Leave the year blank for a date that repeats every year.";
export const LINK = "Link";
export const YES = "Yes";
export const NO = "No";
export const OPTIONS = "Options";
export const ADD_OPTION = "Add an option";
export const OPTION_N = (n: number) => `Option ${n}`;
export const SELECTED = "Selected";
export const ITEMS = "Items";
export const ADD_ITEM = "Add an item";
export const ITEM_N = (n: number) => `Item ${n}`;
export const DONE = "Done";
export const REMOVE = "Remove";
export const CHARACTERS = (n: number, max: number) =>
  `${n} of ${max} characters`;
export const AUDIENCE = "Who can see it";
export const HOME_VIEW = (home: string) => `${home} · can view`;
export const CHOOSE_PEOPLE = "Choose people…";
export const CUSTOM = (summary: string) => `Custom (${summary})`;
export const SHARED_NEEDS_CONNECTION = "Sharing a new field needs a connection";
export const NO_PRIMARY_HOUSEHOLD = "You don't have a primary household"; // PROVISIONAL
export const AUDIENCE_OWNER_ONLY =
  "Only the owner can change who can see this field";
export const AUDIENCE_LOADING = "Checking who can see this field…"; // PROVISIONAL
export const AUDIENCE_LOAD_FAILED = "Couldn't check who can see this field."; // PROVISIONAL
export const AUDIENCE_CHANGED =
  "Who can see this field changed since you opened it. Check the change above before saving yours."; // PROVISIONAL (review 23, R23.1)
export const AUDIENCE_RECHECK =
  "Who can see this field may have changed. It's checked again when you're online."; // PROVISIONAL (review 23, R23.1)
export const SAVED_AFTER_SYNC = "Saved. It'll appear here once it has synced.";
export const SHARING_CHANGED =
  "The sharing changed since you opened this. Review who can see it, then save again.";
export const IDENTITY_GRANT =
  "Someone in that audience can't see this person, so they can't be given this field."; // PROVISIONAL
export const ARCHIVED_FIELD_NOTE = "Archived."; // PROVISIONAL
export const READ_ONLY_FIELD = "You can't edit this field";
export const CHOOSE_AFTER_SAVE =
  "Save it as Only you first; then choose who can see it from the field's row."; // PROVISIONAL (D-11a-7)

// offline audience change (export + design-coverage §9 row 2)
export const OFFLINE_HEADING =
  "You're offline, so the audience can't change yet";
export const OFFLINE_BODY = (name: string) =>
  `Changing who can see a field always needs a connection. Your edit to the ${name} doesn't. Pick which you'd rather do:`;
export const SAVE_NOW_TITLE = (name: string, audience: string) =>
  `Save the ${name} now — ${audience} will still see it`;
export const SAVE_NOW_BODY =
  "Sends as soon as you're online, under the current audience.";
export const HOLD_TITLE = "Hold it as a draft until I'm online";
export const HOLD_BODY = (name: string) =>
  `Nothing sends now. When you reconnect, Atlas changes the audience first and only sends the ${name} once that's confirmed. Kept on this device until then, even if you reload or switch accounts.`; // PROVISIONAL (durable, finding 6)
export const HOLD_CAVEAT = (name: string) =>
  `Atlas checks the sharing policy hasn't changed before sending — if it has, you'll be asked to review and resend rather than the ${name} landing under a changed audience.`;
export const HOLD_CAVEAT_2 =
  "If the policy changed, your held draft stays saved here until you resend it.";
export const ESCAPE_DISCARDS = "Escape discards this edit.";
export const HOLD_AS_DRAFT = "Hold as draft";
export const SAVE_NOW = "Save now";
export const CURRENT_AUDIENCE_UNKNOWN = "the current audience";
export const HELD_WAITING = (name: string) =>
  `Waiting to change who can see ${name}`; // PROVISIONAL
export const HELD_RUNNING = (name: string) => `Changing who can see ${name}…`; // PROVISIONAL
export const HELD_STOPPING = (name: string) =>
  `Stopping the held change to ${name}…`; // PROVISIONAL
export const HELD_STOPPED = (name: string) =>
  `The held change to ${name} was discarded. Nothing was sent.`; // PROVISIONAL
export const HELD_POLICY_DONE = (name: string) =>
  `Who can see ${name} had already changed when you discarded it. Your edit wasn't saved.`; // PROVISIONAL
export const HELD_POLICY_UNCERTAIN = (name: string) =>
  `The change to who can see ${name} may already have been made. Check it on the field's row; your edit wasn't saved.`; // PROVISIONAL
// Review 2 of 22 October 2026 (finding 2, D1: a recovered hold waits for "Send now"; every outcome is the store's own)
export const HELD_RECOVERED = (name: string) =>
  `Waiting to change who can see ${name}. Send it when you're ready.`; // PROVISIONAL (D1)
export const SEND_NOW = "Send now"; // PROVISIONAL (D1)
export const HELD_DISCARDING = (name: string) =>
  `Discarding the held change to ${name}…`; // PROVISIONAL
export const HELD_DISCARD_FAILED =
  "Couldn't discard it on this device. It's still kept. Try again."; // PROVISIONAL
export const HELD_CHANGED_ELSEWHERE =
  "This held change was updated in another window. Check it, then try again."; // PROVISIONAL
export const HELD_CONTENT_MAYBE = (name: string) =>
  `Your edit to ${name} may already be queued. Check Sync to keep or discard it.`; // PROVISIONAL
export const HELD_NOT_ENDED =
  "Saved, but the held copy is still on this device. Try again to finish it."; // PROVISIONAL
export const HELD_MORE = "Show more held changes"; // PROVISIONAL (finding 4)
export const HELD_FIRST = "Back to the first held changes"; // PROVISIONAL
export const HELD_MORE_EMPTY = "More held changes may be kept on this device."; // PROVISIONAL
export const HELD_CHECKING = "Checking held changes…"; // PROVISIONAL
export const HELD_LIST_FAILED =
  "Couldn't read the held changes on this device."; // PROVISIONAL
export const HELD_KEPT_EARLIER = (name: string) =>
  `An earlier held change to who can see ${name} is still kept. Check it on the person's page.`; // PROVISIONAL
export const HELD_UNREADABLE =
  "A held change on this device can't be read any more. Discard it."; // PROVISIONAL
export const HELD_SAVE_FAILED =
  "Couldn't keep this on the device. Try again, or save it now."; // PROVISIONAL
// Review 3 of 22 October 2026 (findings 1 and 2; the design assessment's C3b/C3c and C6)
export const HELD_BUSY =
  "Another change to this field is being saved or sent. Try again in a moment."; // PROVISIONAL
export const HELD_REPLACED = (name: string) =>
  `A later held change to who can see ${name} replaced this one.`; // PROVISIONAL
export const HELD_UNRESOLVED = (name: string) =>
  `An earlier change to who can see ${name} may already have been made. Check it to be sure.`; // PROVISIONAL
export const CHECK_NOW = "Check now"; // PROVISIONAL
// Review 4 of 23 October 2026 (finding 4): a check says what the audience IS now, never what the earlier attempt did.
export const HELD_CHECKED_UNCHANGED = (name: string) =>
  `Checked: who can see ${name} hasn't changed since this was asked for, so it may still be made. It stays here until you discard it.`; // PROVISIONAL
export const HELD_CHECKED_MATCHES = (name: string) =>
  `Checked: who can see ${name} is now what this asked for. Whether this change made it can't be told from here.`; // PROVISIONAL
export const HELD_CHECKED_OTHER = (name: string) =>
  `Checked: who can see ${name} has changed since to something else, so this can't be made any more.`; // PROVISIONAL
// Review 4 (the assessment's C9/C10): an earlier shape is never sent; an attempt that could not be looked up blocks a fresh one.
export const HELD_LEGACY = (name: string) =>
  `A held change to who can see ${name} from an earlier version of Atlas is kept on this device. It can't be sent from here: discard it, or make the change again.`; // PROVISIONAL
// Review 12 (R12.1; the decision of 24 October 2026): a hold that never recorded the save its value was typed over is reviewed, never sent.
export const HELD_UNBOUND = (name: string) =>
  `This held change to ${name} was kept before Atlas recorded what it was typed over, so it won't be sent. Edit the field to review it and save it again, or discard it.`; // PROVISIONAL
export const HELD_UNBOUND_POLICY_MAYBE = (name: string) =>
  `The change to who can see ${name} may already have been made.`; // PROVISIONAL
export const HELD_UNBOUND_POLICY_DONE = (name: string) =>
  `Who can see ${name} was already changed as asked.`; // PROVISIONAL
export const HELD_ATTEMPT_UNKNOWN =
  "Couldn't check this device for an earlier try of this change. Try again."; // PROVISIONAL
export const HELD_CHECK_FAILED = "Couldn't check it now. Try again."; // PROVISIONAL
export const AUDIENCE_CHECKED_AT = (time: string) => `Checked at ${time}`; // PROVISIONAL (C6: a page's own policy read, never live)
export const HELD_FAILED: Record<string, string> = {
  changed: SHARING_CHANGED,
  conflict: SHARING_CHANGED,
  content_changed:
    "Someone else changed this field. Open it to see the current value.",
  gone: "This field isn't on this device any more.",
  forbidden: AUDIENCE_OWNER_ONLY,
  uncertain: UNCERTAIN,
  not_saved: "Couldn't save on this device. Try again.",
  needs_review:
    "This change can't be sent as it is. Edit the field to review it and save it again.",
}; // PROVISIONAL
export const DISCARD = "Discard";

// conflicts (§4.4)
export const CONFLICT_TITLE = "Someone else changed this field";
export const CONFLICT_CURRENT = "Current";
export const CONFLICT_MINE = "Yours"; // PROVISIONAL (finding 3: the conflicted save's own content)
export const CONFLICT_AUDIENCE_NOW = (audience: string) =>
  `Who can see it now: ${audience}`; // PROVISIONAL
export const CONFLICT_AUDIENCE_UNKNOWN =
  "Who can see it changed since you saved. Check it before saving yours again."; // PROVISIONAL
export const CONFLICT_NEEDS_AUDIENCE =
  "Check who can see it first: that needs a connection"; // PROVISIONAL
export const LOADING_MINE = "Loading your saved change…"; // PROVISIONAL
export const STALE_NOT_SAVED =
  "Nothing was saved. Check the current value, then save yours on it or discard it."; // PROVISIONAL
export const CREATE_CHANGED =
  "This field was changed in another window since you opened it. Close it and open it again to see the change; nothing was saved."; // PROVISIONAL (review 2, finding 3)
export const STALE_TITLE = "This field changed since you opened it"; // PROVISIONAL (finding 1)
export const POLICY_MOVED_TITLE =
  "Who can see this field changed since you opened it"; // PROVISIONAL (review 23, R23.1)
export const POLICY_AHEAD =
  "Who can see it now is shown here once this field has finished syncing."; // PROVISIONAL (review 23, R23.1)
export const PUBLISHED_TITLE = "This field has finished syncing"; // PROVISIONAL (review 10, finding 1)
export const PUBLISHED_NOT_SAVED =
  "Your change isn't saved yet. Check the field as it is now, then save yours on it or discard it."; // PROVISIONAL (review 10, finding 1)
export const PUBLISHED_REVIEW_FIRST =
  "Check the field as it is now before saving your change"; // PROVISIONAL (review 10, finding 1)
export const PUBLISHED_AUDIENCE_UNKNOWN =
  "Who can see it now isn't known on this device yet."; // PROVISIONAL (review 10, finding 1)
export const PUBLISHED_AUDIENCE_OWNER_ONLY =
  "Only the field's owner can check who can see it, so yours can't be saved on it here"; // PROVISIONAL (review 10, finding 1)
export const CREATE_SENDING =
  "This field is being sent. Your change is kept: save it once the field has finished syncing."; // PROVISIONAL (review 10, finding 1)
export const STALE_RENAME =
  "This person changed since you started. Review the name, then save again."; // PROVISIONAL
export const SAVE_MINE = "Save mine on the current version";
export const DISCARD_MINE = "Discard mine";
export const POLICY_CONFLICT =
  "Who can see this field changed. Review it before saving again.";
export const RESTORED_DRAFT = "Your unsaved changes were kept."; // PROVISIONAL

// ---- duplicates (WF-PEOPLE-04) -----------------------------------------------------------------------------------------------------------
export const DUPLICATES_TITLE = (name: string) =>
  `Possible duplicates of “${name}”`;
export const DUPLICATES_SUBHEAD =
  "Atlas checks the people you can see for similar names. It won't catch everything, and it never looks at anyone you don't have access to.";
export const SIMILAR_NAME = "Similar name";
export const NOT_THE_SAME = "Not the same";
export const CHECK_MORE = "Check more"; // PROVISIONAL
export const CHECKING = "Checking…"; // PROVISIONAL
export const NONE_AT_ALL = "Nothing looks like a duplicate right now.";
export const NONE_SO_FAR =
  "No similar names found so far. There are more people to check."; // PROVISIONAL (PPL-3)
export const DUPLICATES_FOOTER =
  "Hiding a pair only affects this list while Atlas is open. It doesn't change either person."; // DEVIATION (D-11a-9)
export const DUPLICATES_GONE = "This person is no longer available"; // PROVISIONAL
export const DUPLICATES_FAILED = "Couldn't check for duplicates."; // PROVISIONAL
export const BACK_TO = (name: string) => name;

// ---- archived items (Settings, Q21 gap 9) ----------------------------------------------------------------------------------------------
export const ARCHIVED_ITEMS = "Archived items";
export const ARCHIVED_ITEMS_DESCRIPTION = "People and fields you've archived."; // PROVISIONAL
export const ARCHIVED_EMPTY =
  "Nothing archived. Archiving hides an item without deleting it — its history stays intact.";
export const ARCHIVED_FAILED =
  "Couldn't read every archived item on this device. Anything that could be read is listed."; // PROVISIONAL (review 4, finding 5)
export const ARCHIVED_NOTE =
  "History, receipts and sync content survive archiving — this list is a reversible-action ledger, not a delete confirmation."; // PROVISIONAL
export const COLUMN_KIND = "Kind";
export const COLUMN_NAME = "Name";
export const KIND_PERSON = "Person";
export const KIND_FIELD = "Field";
export const FIELD_OF = (field: string, person: string) =>
  `${field} · ${person}`;

// ---- enqueue refusals (§4.8) -----------------------------------------------------------------------------------------------------------
export const REFUSED = {
  fenced: "Saving isn't possible while signing out.",
  closing: "Saving isn't possible while signing out.",
  quota: "There isn't enough storage space on this device to save this.",
  storage: "Couldn't save on this device. Try again.",
  no_base: "This isn't available on this device yet.",
  not_ready: "This device isn't ready to save yet. Try again in a moment.", // PROVISIONAL (no database bound yet)
} as const;

// ---- validation (contract bounds) -----------------------------------------------------------------------------------------------------
export const PROBLEM: Record<string, string> = {
  label_missing: "Give the field a name.",
  label_too_long: "Use 300 characters or fewer.",
  name_missing: "Enter a name.",
  name_too_long: "Use 300 characters or fewer.",
  rename_too_long: "Use 200 characters or fewer.",
  note_too_long: "Use 4,096 characters or fewer.",
  text_too_long: "Use 4,096 characters or fewer.",
  amount_missing: "Enter an amount.",
  amount_invalid:
    "Enter a number of 0 or more, with up to 6 decimal places (for example 2.5).",
  unit_missing: "Enter a unit (for example kg).",
  unit_too_long: "Use 40 characters or fewer for the unit.",
  day_missing: "Enter the day as a number.",
  month_missing: "Enter the month as a number.",
  year_invalid: "Enter the year as a number, or leave it blank.",
  year_out_of_range: "Enter a year from 1900 to 9999.",
  date_invalid: "That date doesn't exist.",
  url_missing: "Enter a link.",
  url_invalid:
    "Enter a full http or https link, without a user name or password.",
  boolean_missing: "Choose yes or no.",
  options_missing: "Add at least one option.",
  options_too_many: "Use 100 options or fewer.",
  option_blank: "Every option needs some text.",
  option_too_long: "Use 100 characters or fewer for each option.",
  options_repeated: "Each option must be different.",
  selected_unknown: "Choose only from the options.",
  items_missing: "Add at least one item.",
  items_too_many: "Use 100 items or fewer.",
  item_blank: "Every item needs some text.",
  item_too_long: "Use 300 characters or fewer for each item.",
  item_id_invalid:
    "This checklist can't be saved as it is. Remove and re-add the items.",
  checked_unknown: "Tick only items in the list.",
  value_too_large: "This value is too long to save. Shorten it.",
}; // PROVISIONAL
