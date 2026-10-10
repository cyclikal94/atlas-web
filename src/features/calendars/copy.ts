/**
 * The words of the calendar screens (WEB-13a). VERBATIM from `wireframes/q21/calendar-journeys.html` where the wireframe draws them
 * (marked "verbatim"); everything else is PROVISIONAL and listed for Kieran's copy and visual review (marked "provisional"). Nothing
 * here names a schema field, an endpoint or a code: those are in the engineering notes of the wireframe, not in its copy.
 */

// ---- the screen ------------------------------------------------------------------------------------------------------------------
/** Verbatim ("SETTINGS · CALENDARS Calendar sources"). */
export const SCREEN_EYEBROW = "Settings · Calendars";
export const SCREEN_HEADING = "Calendar sources";
/** Verbatim: the two entry points and their class labels. */
export const ADD_SOURCE = "Add source";
export const ADD_SOURCE_CLASS = "Offline-queueable";
export const LINK_CALENDAR = "Link a calendar…";
export const ONLINE_ONLY = "Online-only";
/** Provisional: the empty list. */
export const EMPTY = "No calendars yet.";
/** Provisional: the skeleton's accessible name. */
export const LOADING = "Loading your calendars…";
/** Provisional: the group of creates this device has saved and the server has not confirmed yet. */
export const WAITING_GROUP = "Waiting to be created";
/** Provisional: no database on this device yet (until the first sync; WEB-09b). */
export const NO_DATABASE =
  "Calendars you add here appear once this device has synced. You can still link a calendar while you're online.";
/** Provisional: the list could not be read. */
export const LOAD_FAILED = "Couldn't load your calendars.";
export const LOAD_FAILED_ACTION = "Try again";
export const SHOW_NEXT = "Show next calendars";
export const SHOW_PREVIOUS = "Show previous calendars";

// ---- reasons a control is unavailable ---------------------------------------------------------------------------------------------
/** Verbatim (the Offline (O) card and the Manage form's offline state). */
export const NEEDS_CONNECTION = "Needs a connection";
/** Provisional (D-13a-9). */
export const NEEDS_DATABASE = "Available once this device has synced";
/** Provisional (B2: writes are compatibility-gated). */
export const COMPAT_PAUSED =
  "Paused — this version of Atlas isn't compatible with the server";
/** Provisional (D-13a-8). */
export const WAITING_CHANGES_FIRST =
  "Send or discard this calendar's waiting changes first";
/** Provisional (D-13a-8): the waiting changes have not been read yet. */
export const CHECKING_CHANGES = "Checking for changes waiting to send…";
/** Provisional (D-13a-8). */
export const WAITING_LAST_CHANGE = "Waiting for your last change to sync";
/** Provisional. */
export const TURNED_OFF_REASON = "Turn this calendar on to refresh it";
/** Provisional. */
export const NOT_CREATED_REASON = "Available once this calendar is created";
/** Provisional. */
export const VIEW_ONLY_REASON = "You can view this calendar but not change it";
/** Provisional. */
export const REFRESHING_REASON = "Refreshing…";

// ---- a row --------------------------------------------------------------------------------------------------------------------------
export const REFRESH = "Refresh";
export const MANAGE = "Manage";
/** Verbatim ("Pending — will create when back online"); the online form is provisional. */
export const PENDING_OFFLINE = "Pending — will create when back online";
export const PENDING_ONLINE = "Pending — sending…";
/** Verbatim (the Manage source states), capitalised as a status line. */
export const QUEUED = "Queued — will apply once synced";
export const SAVING = "Saving — will confirm on next sync";
/** Provisional. */
export const NEEDS_DECISION = "Needs a decision";
export const TURNED_OFF = "Turned off";
/** Provisional: the synced health as historical context, never as the result of a request just made. */
export const NOT_REFRESHED_YET = "Not refreshed yet";
export const lastSuccess = (when: string): string => `Last success ${when}`;
export const lastRefresh = (what: string): string => `Last refresh: ${what}`;
/** Provisional (D-13a-11): a non-owner's queued settings change was refused. */
export const OWNER_ONLY =
  "Only the person who added this calendar can change its settings.";
/** Provisional: a rejected save, with the generic Discard. */
export const REJECTED = "This change couldn't be saved.";
export const DISCARD = "Discard";
export const REVIEW = "Review";
export const DISCARDED = "Change discarded.";
export const DISCARD_FAILED = "Couldn't discard this change — try again.";

// ---- Add source (queued) ------------------------------------------------------------------------------------------------------------
/** Verbatim (panel "Add source — credential-free (offline-queueable)"). */
export const ADD_TITLE = "Add source";
export const LABEL = "Label";
export const TIMEZONE = "Timezone";
export const CREATE_SOURCE = "Create source";
export const ADD_HELP =
  "No connection details here at all, so there's nothing sensitive to keep out of the offline queue.";
/** Provisional. */
export const ADDED_OFFLINE =
  "Calendar added. It will be created when you're back online.";
export const ADDED = "Calendar added.";
export const LABEL_REQUIRED = "Enter a label.";
export const LABEL_TOO_LONG = "Keep the label to 300 characters or fewer.";
/** Verbatim (the Manage-source field validation). */
export const TIMEZONE_INVALID =
  "Enter a valid IANA timezone, e.g. Europe/Vienna";

// ---- Link a calendar… / Replace… / Remove… (online-only) ----------------------------------------------------------------------------
export const LINK_TITLE = "Link a calendar…";
export const URL_LABEL = "URL (required)";
export const BEARER_LABEL = "Bearer token (optional)";
export const CONNECT = "Connect";
/** Verbatim. */
export const SECRET_HELP =
  "Both fields are held in memory only while this form is open — neither is ever queued offline, saved for recovery, or logged. If submission fails, retry from this open form; reloading requires re-entering both.";
/** Verbatim (Replace…). */
export const URL_REQUIRED_FOR_REPLACE =
  "A URL is required to replace this connection.";
/** Provisional. */
export const URL_REQUIRED = "Enter the calendar's address.";
export const URL_INVALID =
  "Enter a full web address that starts with https:// or http://";
export const BEARER_TOO_LONG = "The token can be at most 4,096 characters.";
/** Provisional: the server's own refusals of an address. */
export const URL_REFUSED = "Atlas can't fetch a calendar from that address.";
export const URL_NOT_ALLOWED =
  "This server isn't allowed to fetch calendars from that address.";
export const VALUE_REFUSED = "Check the details and try again.";
/** Verbatim (Failed submit — retry). */
export const SAVE_FAILED =
  "Couldn't save — check your connection and try again";
export const RETRY = "Retry";
/** Provisional (D-13a-7): a live read that says whether an uncertain save landed. */
export const CHECK = "Check";
export const CHECK_NOT_FOUND =
  "We couldn't confirm that this saved yet. Retry is safe: it won't make a copy.";
export const CHECK_FAILED = "Couldn't check right now — try again.";
/** Verbatim (Manage source / anchor — conflict). */
export const CONFLICT =
  "This source's settings changed elsewhere — review the current values before saving again";
/** Verbatim (Access lost mid-edit). */
export const ACCESS_LOST = "You no longer have access to make this change";
/** Provisional (D-13a-11): kept on the row after the session's re-check of a 403 remounted the screen. */
export const ACCESS_LOST_NOTICE =
  "You no longer have access to make this change. Only the person who added this calendar can change its connection.";
export const DISMISS = "Dismiss";
/** Provisional. */
export const SOURCE_GONE =
  "This calendar source is no longer available to you.";
/** Provisional. */
export const LINKED = "Calendar linked.";
export const REPLACED = "Connection replaced.";
export const REMOVED = "Connection removed.";

// ---- Manage (queued settings; online connection) -----------------------------------------------------------------------------------
export const manageTitle = (label: string): string => `Manage — ${label}`;
/** Verbatim ("— set at creation, not editable here"). */
export const LABEL_READ_ONLY = "— set at creation, not editable here";
export const CONNECTION = "Connection";
/** Provisional: the projection does not say whether a connection is stored, so nothing about one is shown. */
export const CONNECTION_NOT_SHOWN = "Connection details are never shown here.";
export const REPLACE = "Replace…";
export const REMOVE = "Remove…";
/** Verbatim. */
export const REPLACE_ROTATE_NOTE =
  "Rotating only the token still requires re-entering the full URL — the stored URL is never redisplayed above.";
export const REPLACE_KEEP_NOTE =
  'Leaving both fields untouched and closing "Replace…" keeps the existing connection exactly as it is.';
/** Provisional. */
export const REPLACE_SUBMIT = "Replace connection";
export const REMOVE_CONFIRM =
  "Remove this calendar's connection? It stops refreshing until you add one again. Its events stay.";
export const REMOVE_SUBMIT = "Remove connection";
export const CLOSE_PANEL = "Keep connection";
export const ENABLED = "Enabled";
export const SAVE = "Save";
export const CANCEL = "Cancel";
/** Verbatim. */
export const MANAGE_HELP =
  'Timezone and Enabled save immediately, even offline — they don\'t touch the connection above, which is never affected by an edit that leaves it alone. "Replace…"/"Remove…" are the separate, online-only paths for changing the connection itself.';
/** Provisional. */
export const SETTINGS_SAVED = "Settings saved.";
export const NOTHING_CHANGED = "Nothing to save.";
/** Provisional: announced when an open Manage closes because the cache is being brought up to date (its content is hidden). */
export const MANAGE_CLOSED_REFRESHING =
  "Manage closed while your calendar sources are brought up to date.";
/** Provisional: announced when an open Manage closes because its source is no longer in the cache (or its waiting create was removed). */
export const MANAGE_CLOSED_GONE =
  "Manage closed: this calendar source can no longer be shown.";

// ---- not saved locally (the facade's refusals) ----------------------------------------------------------------------------------
/** Provisional: the outbox refused to store the change (quota, storage, the fence, a closed database). */
export const NOT_SAVED_QUOTA =
  "Not saved — this device is out of space for changes.";
export const NOT_SAVED_STORAGE =
  "Not saved — local storage isn't responding. Try again.";
export const NOT_SAVED_FENCED =
  "Not saved — this device is signing out or retiring.";
export const NOT_SAVED = "Not saved — try again.";

// ---- refresh (online-only; B8's six causes) ----------------------------------------------------------------------------------------
/** Provisional. */
export const REFRESHING = "Refreshing…";
export const REFRESHED = "Refreshed. New events appear after the next sync.";
export const STILL_REFRESHING = "Still refreshing — check again shortly.";
export const CHECK_AGAIN = "Check again";
/** Verbatim: cause 1. */
export const CAUSE_CONNECTION =
  "This source needs its connection details re-entered.";
export const UPDATE_CONNECTION = "Update connection";
/** Verbatim: cause 2. */
export const CAUSE_FETCH = "Couldn't reach the calendar provider just now.";
/** Verbatim: cause 3. */
export const CAUSE_UNCONFIGURED =
  "This server can't process calendar connections right now — contact your administrator.";
/** Provisional: cause 4 (no newer refresh is running). */
export const CAUSE_SUPERSEDED =
  "A newer change replaced this refresh — refresh again to get the latest.";
/** Verbatim: cause 5. */
export const CAUSE_LEASE = "Couldn't finish refreshing this source — try again";
/** Verbatim: cause 6a. */
export const CAUSE_TURNED_OFF =
  "This source is turned off — turn it back on to resume refreshing.";
export const TURN_ON = "Turn on";
/** Verbatim: cause 6b. */
export const CAUSE_UNAVAILABLE = SOURCE_GONE;
/** Provisional: the feed was read and refused (an unreadable or unsupported calendar). */
export const feedUnreadable = (why: string): string =>
  `This calendar's feed couldn't be read: ${why}. Your existing events are unchanged.`;
export const FEED_REASONS: Readonly<Record<string, string>> = {
  invalid_ics: "it isn't a valid calendar file",
  unsupported_calendar_rule: "it uses a repeat rule Atlas doesn't support",
  unsupported_calendar_timezone: "it uses a time zone Atlas doesn't support",
  calendar_limit: "it's larger than Atlas can keep",
};
/** Provisional: a transient failure (a 5xx, a busy server, the network). */
export const REFRESH_TRANSIENT = "Couldn't refresh right now — try again.";
/** Provisional: an answer that says nothing usable (never resent). */
export const REFRESH_UNCONFIRMED = "We couldn't confirm this refresh.";
/** Provisional: a successor's own result (B8 item 4). */
export const successorFinished = (what: string): string =>
  `The newer refresh finished: ${what}`;
export const SUCCESSOR_HEALTHY = "it succeeded.";

/** The synced health values, as words (historical context only). Provisional except where they reuse a cause's verbatim copy. */
export const HEALTH_WORDS: Readonly<Record<string, string>> = {
  pending: NOT_REFRESHED_YET,
  healthy: "refreshed",
  fetch_failed: "couldn't refresh just now — try again shortly",
  invalid_ics: "the feed isn't a valid calendar file",
  unsupported_calendar_rule: "the feed uses an unsupported repeat rule",
  unsupported_calendar_timezone: "the feed uses an unsupported time zone",
  calendar_limit: "the feed is larger than Atlas can keep",
  connection_unavailable: "connection details need re-entering",
  integration_unconfigured: "this server can't process calendar connections",
};

// ---- registry -----------------------------------------------------------------------------------------------------------------------
/** Provisional: content-free descriptions for the queue (`/sync`). */
export const DESCRIBE_CREATE = "Add a calendar";
export const DESCRIBE_CONFIGURE = "Change calendar settings";
