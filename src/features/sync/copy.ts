/**
 * Every word the sync screens say (plan 5.7). Where the approved design or a wireframe has the copy it is VERBATIM and says where
 * from. Everything else is PROPOSED, REVIEWABLE and NOT ACCEPTED: Kieran's visual and copy sign-off remains open, so a reviewer can
 * change any line here without touching a component. No line promises an automatic retry that does not exist, implies that drafts
 * are at risk when they are not, or tells the person that freeing memory or retrying helps where it does not.
 */

// ---- the Q23 floor: `floor-refusal-state.html` (VERBATIM) ------------------------------------------------------------------------
export const FLOOR_TITLE =
  "Unable to sync on this device/browser at the moment";
/** State (a): the cache was already valid; the content stays visible and only further updates stop. */
export const FLOOR_A_BODY =
  "What's below is what synced last — new updates can't come through here right now. Retrying won't change this for this content on this device. A different device, or this content becoming smaller, may work.";
/** State (b): the cache was already invalid; the content stays hidden and the gate does not lift. */
export const FLOOR_B_BODY =
  "We're keeping your protected content hidden until we can bring it up to date safely — retrying won't change the outcome for this content on this device right now. This is not the usual “Refreshing…” wait; it will not resolve by waiting.";
/** PROPOSED: the wireframe's qualified draft sentence, as a statement of fact that cannot be false when this screen can be seen. */
export const FLOOR_B_DRAFTS =
  "Your unsent changes remain saved on this device.";

// ---- a page that did not save: `sync-recovery-acknowledge.html` (VERBATIM) ----------------------------------------------------------
export const PAGE_NOT_SAVED_TITLE = "Couldn't finish saving that page";
export const PAGE_NOT_SAVED_BODY =
  "The downloaded changes themselves didn't save on this device — not just a marker. Nothing was lost on the server; your view just isn't caught up yet.";
export const PAGE_NOT_SAVED_ACTION = "Retry applying changes";
/**
 * When neither the durable record nor the fallback marker could keep this stop (reconciliation, validation trace 4; PROPOSED copy,
 * not accepted): the warning exists in this tab alone, and the notice says so plainly.
 */
export const MEMORY_ONLY_NOTE =
  "This warning is only kept in this tab. It will not survive a reload, so if you reload or close the tab you won't be told again.";

// ---- the quota reserve: WEB-04 wireframe 7 (VERBATIM); neither claims an automatic retry --------------------------------------------
export const STORAGE_FULL_VALID_TITLE =
  "Couldn't finish updating your offline data";
export const STORAGE_FULL_VALID_BODY =
  "Atlas is still working from the last data it successfully saved — nothing you could already see has been lost.";
export const STORAGE_FULL_INVALID_TITLE =
  "Couldn't finish refreshing your offline data";
export const STORAGE_FULL_INVALID_BODY =
  "Atlas is confirming what you currently have access to; protected details stay hidden until this succeeds.";
export const STORAGE_FULL_ADVICE =
  "Free up some space (clear other sites' data, or storage in general), then tap Retry.";
export const STORAGE_FULL_DISMISS = "Dismiss";
export const STORAGE_FULL_RETRY = "Retry";

// ---- PROPOSED ------------------------------------------------------------------------------------------------------------------------
export const STORAGE_NOT_RESPONDING_TITLE = "Local storage isn't responding";
export const STORAGE_NOT_RESPONDING_BODY =
  "Atlas couldn't save to this device three times in a row. Anything you saved earlier is still here. Try again, and if it keeps happening, restart your browser.";
export const STORAGE_NOT_RESPONDING_ACTION = "Try again";

export const COMPAT_TITLE = "Sending is paused";
export const COMPAT_UNSUPPORTED_BODY =
  "This version of Atlas isn't compatible with the server it's talking to, so your changes are waiting to send. They're saved on this device and nothing is lost. Sending starts again once the versions match.";
export const COMPAT_MISSING_BODY =
  "Atlas can't confirm which version the server is running, so your changes are waiting to send. They're saved on this device and nothing is lost. Atlas will keep checking.";

export const STILL_TRYING_UPDATES_TITLE = "Still trying to update";
export const STILL_TRYING_UPDATES_BODY =
  "Atlas couldn't reach the server for a few minutes, so it paused. What you saved is safe on this device.";
export const STILL_TRYING_CHANGES_TITLE = "Still trying to send";
export const STILL_TRYING_CHANGES_BODY =
  "Some changes couldn't be sent for a few minutes, so Atlas paused. They're saved on this device.";
export const STILL_TRYING_ACTION = "Retry now";

export const DEVICE_CAPACITY_TITLE = "This device can't sync right now";
export const DEVICE_CAPACITY_BODY =
  "This account has reached the number of devices that can sync at once. Sign out another device in Settings, then try again.";

export const UNRECOGNISED_TITLE = "Updates stopped";
export const UNRECOGNISED_BODY =
  "Atlas received a response it didn't expect and stopped updating to keep your data safe.";
export const UNRECOGNISED_ACTION = "Retry now";

// ---- the queue warning: `queue-warning-threshold.html` (VERBATIM) -----------------------------------------------------------------------
export const QUEUE_WARNING_TITLE = "A lot is waiting to send";
export const QUEUE_WARNING_BODY =
  "You can keep working offline — nothing is blocked. This just means it'll take longer to catch up once you're back online.";

// ---- the gate: WEB-04 wireframe 12 (VERBATIM) ------------------------------------------------------------------------------------------
export const GATE_TITLE = "Refreshing your data";
export const GATE_BODY =
  "Atlas is confirming what you currently have access to. Details are temporarily hidden until this finishes — nothing you were shown is currently guaranteed current.";

// ---- the queue panel (WF-QUEUE-01, `Atlas Sync Screens.dc.html`, VERBATIM where quoted) -------------------------------------------------
export const PANEL_HEADING = "Sync";
export const PANEL_SUBTITLE =
  "What's waiting to send, and anything that needs a decision";
export const TAB_WAITING = "Waiting to send";
export const TAB_DECISION = "Needs a decision";
export const EMPTY_WAITING = "Nothing waiting to send.";
export const EMPTY_DECISION = "Nothing needs a decision.";
export const LOADING = "Loading what's waiting…";
export const LOAD_FAILED =
  "Couldn't load what's waiting to send — please try again.";
export const LOAD_FAILED_ACTION = "Try again";
/**
 * The queue is shown a WINDOW at a time (Q9: 100 rows); the next or the previous window REPLACES the one shown, so what the screen
 * holds does not grow with the windows visited. PROPOSED copy, not accepted.
 */
export const SHOW_NEXT = "Show next changes";
export const SHOW_PREVIOUS = "Show previous changes";
export const PAGER_LABEL = "More of the queue";
export const SHOWING_NEXT = "Showing the next changes.";
export const SHOWING_PREVIOUS = "Showing the previous changes.";
export const FOOTER =
  "Sending the same thing twice is safe — Atlas won't double-count it. Items belong to your account, so they stay here if someone else signs in on this computer.";

/** PROPOSED generic fallbacks: the data layer does not know what a command means (a feature slice registers its own wording). */
export const ROW_FALLBACK_TITLE = "A change you made";
export const SAVED_AT = (when: string): string => `Saved here ${when}`;
export const WILL_SEND = "Will send when connected";
export const WAITING = "Waiting to send";
export const SENDING = "Sending";
export const TRYING_AGAIN = "Trying again";
export const PAUSED = "Paused";
export const CONFIRMING = "Sent — confirming";
export const NOT_SHOWING = "Sent — not showing here yet";
export const ATTEMPTS = (n: number): string =>
  n === 0
    ? "no attempts yet"
    : n === 1
      ? "tried once"
      : n === 2
        ? "tried twice"
        : `tried ${n} times`;

export const BADGE_VERSION_CONFLICT = "Edited twice";
export const BADGE_OPERATION_CONFLICT = "Already sent";
export const BADGE_REVIEW = "Sharing changed";
export const BADGE_REJECTED = "Couldn't save";
export const BADGE_BLOCKED = "Waiting for space";
export const CONFLICT_READ_ONLY =
  "Atlas will show how to sort this out in a later release. Your change is kept.";
export const REJECTED_BODY =
  "This change was sent and turned down. Your input is kept here — no further attempt will be made.";
export const BLOCKED_BODY =
  "There isn't room to save this change yet. It's kept here. Make some room, then retry.";

export const ACTION_DISCARD = "Discard";
/** WEB-12a: a defaults review is resolved in the sharing review (WEB-04 §5.7). PROPOSED copy. */
export const ACTION_REVIEW = "Review sharing";
export const DEFAULTS_REVIEW_BODY =
  "Check who this will be shared with before it is sent.";
export const ACTION_RETRY = "Retry now";
export const ACTION_RETRY_BLOCKED = "Retry";
export const ACTION_DISMISS = "Dismiss";
export const DISCARD_CONFIRM = "Discard this change?";
export const DISCARD_CONFIRM_YES = "Discard";
export const DISCARD_CONFIRM_NO = "Keep";
export const DISCARD_DEPENDANTS = (n: number): string =>
  n === 1
    ? "1 other change depends on this and will need your attention."
    : `${n} other changes depend on this and will need your attention.`;
export const DISCARDED = "That change was discarded.";
export const DISCARD_FAILED =
  "Couldn't discard that change — please try again.";
export const CANNOT_DISCARD = "Already sent, so it can't be discarded";
