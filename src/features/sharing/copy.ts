import type { DefaultsReviewCase } from "../../data";
import { anonymousLabel } from "./model/audience";

/**
 * Every visible sentence of WEB-12a's sharing screens. PROPOSED copy (D-12a-8): it follows the accepted wireframes' wording where they
 * have it (WF-SHARING-03/04/05, `sharing-preview-proposed.html`, WEB-04 §5.7) and is UK English; visual and copy sign-off stay open.
 */

// ---- the page ----------------------------------------------------------------------------------------------------------------------
export const PAGE_TITLE = "Sharing";
export const DEFAULTS_HEADING = "Sharing defaults";
export const DEFAULTS_INTRO =
  "What new records start shared with. Editing a default never changes existing records.";
export const DEFAULTS_EDIT = "Edit defaults";
export const DEFAULTS_NONE_YET =
  "These defaults haven't been loaded on this device yet.";
export const DEFAULTS_LOADING = "Loading your sharing defaults…";
export const AS_OF = (when: string) => `As of ${when}`;
export const ITEM_SHARING_HEADING = "Sharing a single item";
export const ITEM_SHARING_BODY =
  "Each item you own has its own sharing, opened from the item itself. Its policy overrides these defaults.";

// ---- online-only --------------------------------------------------------------------------------------------------------------------
export const REQUIRES_CONNECTION = "Requires a connection.";
export const POLICY_ONLINE_ONLY =
  "Sharing changes are online-only; Save is disabled while offline rather than appearing to work and failing.";
export const DEFAULTS_ONLINE_ONLY =
  "Defaults are changed through an online-only command; Save is disabled while offline rather than appearing to work and failing.";
export const SAVE_OFFLINE_REASON =
  "You're offline. Sharing changes need a connection.";
export const SAVE_NO_CHANGE_REASON = "Nothing has changed yet.";
export const SAVE_BUSY_REASON = "Saving…";
export const SAVE_COMPAT_REASON =
  "This server's version isn't supported, so sharing changes are paused.";
export const OFFLINE_TITLE = "Sharing changes need a connection";
export const OFFLINE_BODY =
  "Connect to see who can see this item and to change it. Nothing about its sharing is stored on this device.";

// ---- the policy editor (WF-SHARING-04) ----------------------------------------------------------------------------------------------
export const POLICY_TITLE = (label: string) => `Sharing — ${label}`;
export const POLICY_UNTITLED = "this item";
export const POLICY_ABSENT =
  "This item isn't available on this device yet. It appears once it has synced.";
export const POLICY_OWNER_ONLY = "Only the owner can change who can see this.";
export const POLICY_GONE = "This item is no longer available.";
export const POLICY_LOADING = "Loading who can see this…";
export const POLICY_LOAD_FAILED = "Couldn't load this item's sharing.";
export const EFFECTIVE_HEADING = "Effective visibility once saved";
export const OWNER_KEEPS =
  "You keep management access as owner regardless of these grants.";
export const EXCLUSION_RULE =
  "Exclusions apply to every grant: a direct grant cannot override an exclusion or remove a household grant.";
export const MEMBERS_AS_OF = (when: string) =>
  `Household members as of ${when}. The server checks membership when someone opens the item.`;
export const PARENT_LIMITED = (parent: string) =>
  `Who can see this is also limited by who can see “${parent}”.`;
export const PARENT_UNNAMED = "the item it belongs to";
export const QUEUED_EDITS = (n: number) =>
  n === 1
    ? "1 unsent change to this item is waiting. Changing its sharing first will make that change need review."
    : `${n} unsent changes to this item are waiting. Changing its sharing first will make them need review.`;
export const CACHE_BEHIND =
  "This device hasn't caught up with the latest sharing of this item yet. Saving uses the version just read from the server.";
export const ACCOUNT_GRANTS = "Account grants";
export const HOUSEHOLD_GRANTS = "Household grants";
export const EXCLUSIONS = "Exclusions";
export const ADD_ACCOUNT = "+ Add account grant";
export const ADD_HOUSEHOLD = "+ Add household grant";
export const ADD_EXCLUSION = "+ Add exclusion";
export const NO_ACCOUNT_GRANTS = "No accounts are granted directly.";
export const NO_HOUSEHOLD_GRANTS = "No households are granted.";
export const NO_EXCLUSIONS = "Nobody is excluded.";
export const READ = "Read";
export const EDIT = "Edit";
export const REMOVE = "Remove";
export const REMOVE_EXCLUSION = "Remove exclusion";
export const EXCLUDED_NOTE = "excluded from every audience grant above";
export const ALREADY_EXCLUDED =
  "Excluded: this grant has no effect until the exclusion is removed.";
export const HOUSEHOLD_UNKNOWN = "A household you're not in";
export const HOUSEHOLD_PICKER = "Choose a household";
export const NO_HOUSEHOLDS_TO_ADD =
  "You're not in any household you could add.";
export const REFUSED_OWNER =
  "You always keep access as owner, so you can't be granted or excluded.";
export const REFUSED_GRANT_LIMIT = "A policy can have at most 100 grants.";
export const REFUSED_EXCLUSION_LIMIT =
  "A policy can have at most 100 exclusions.";
export const NOBODY_ELSE = "Nobody else can see this.";
export const READERS = "Can read";
export const EDITORS = "Can read and edit";
export const UNKNOWN_HOUSEHOLDS = (n: number) =>
  n === 1
    ? "Members of 1 household you're not in"
    : `Members of ${n} households you're not in`;
export const EXCLUDED_PEOPLE = "Excluded";
export const OWNER = (label: string) => `${label} (owner)`;
export const SAVE_POLICY = "Replace policy";
export const CANCEL = "Cancel";
export const CLOSE = "Done";
export const RELOAD = "Reload";
export const TRY_AGAIN = "Try again";
export const SAVED_POLICY = "Sharing saved.";
export const POLICY_CONFLICT =
  "This policy changed since you opened it. Reload to see the current grants before replacing the policy.";
export const OPERATION_CONFLICT =
  "We couldn't confirm this change. Reload to see the current sharing.";
export const UNCERTAIN =
  "We couldn't confirm the change was saved. Try again sends the same change, so it can't be made twice.";
export const NOT_SENT = "Couldn't send the change. Try again.";
export const UNCERTAIN_PENDING =
  "Try the unconfirmed change again, or reload to see whether it was made.";
export const REFUSED = (message: string | undefined) =>
  message
    ? `The server refused this change: ${message}`
    : "The server refused this change.";
export const REQUEST_ID = (id: string) => `Request ID: ${id}`;
export const accountLabel = (id: string, labels: ReadonlyMap<string, string>) =>
  labels.get(id) ?? anonymousLabel(id);

// ---- the directory lookup (WF-SHARING-05) -------------------------------------------------------------------------------------------
export const LOOKUP_TITLE = "Find an account";
export const LOOKUP_SEARCH = "Search by name";
export const LOOKUP_SEARCH_LABEL = "Name";
export const LOOKUP_SEARCH_BUTTON = "Search";
export const LOOKUP_EXACT = "Or look up an exact username";
export const LOOKUP_EXACT_LABEL = "Exact username";
export const LOOKUP_EXACT_BUTTON = "Look up";
export const LOOKUP_CHOOSE = "Choose";
export const LOOKUP_NONE = "No account found";
export const LOOKUP_NONE_EXACT =
  "This lookup only matches an exact username. For anything but a precise match this is the expected outcome, not an error — ask them to check the spelling.";
export const LOOKUP_SELF = "That's your own account.";
export const LOOKUP_NEEDS_CONNECTION = "Needs a connection.";
export const LOOKUP_FAILED = "Couldn't look that up. Try again.";
export const LOOKUP_BACK = "Back";

// ---- the defaults editor (WF-SHARING-03) --------------------------------------------------------------------------------------------
export const DEFAULTS_TITLE = (kind: string) => `Sharing defaults — ${kind}`;
export const CHAIN_LABEL = "Resolution order";
export const CHAIN_APPLICATION = "Application";
export const CHAIN_HOUSEHOLD = (name: string | null) =>
  name === null ? "Primary household" : `Primary household — “${name}”`;
export const CHAIN_PERSONAL = "Personal";
export const CHAIN_EXPLICIT = "Explicit per-record policy";
export const CHAIN_RESOLVES = "resolves here";
export const KINDS_LABEL = "Resource kind";
export const HOUSEHOLD_LAYER = (name: string) =>
  `Household default — “${name}”`;
export const HOUSEHOLD_MANAGER_ONLY = "Manager-only to edit";
export const HOUSEHOLD_EDIT_LABEL = (name: string, kind: string) =>
  `Change ${name}'s default for ${kind}`;
export const NO_PRIMARY =
  "You don't have a primary household, so the application default applies after your personal one.";
export const PERSONAL_LAYER = "Your personal default";
export const PERSONAL_SELF_SERVE = "Self-serve";
export const PERSONAL_EDIT_LABEL = (kind: string) =>
  `Change your personal default for ${kind}`;
export const PERSONAL_INHERITS = (summary: string, version: number) =>
  `No personal override set — inherits ${summary} (version ${version})`;
export const PERSONAL_OVERRIDE = (summary: string, version: number) =>
  `${summary} (your own override, version ${version})`;
export const HOUSEHOLD_CURRENT = (summary: string, version: number) =>
  version > 0
    ? `${summary} (version ${version})`
    : `No household override set — the application default applies (${summary})`;
export const CHOICE_INHERIT_PERSONAL = (summary: string) =>
  `Inherit household default (currently: ${summary})`;
export const CHOICE_INHERIT_HOUSEHOLD =
  "Inherit next layer (remove this override)";
export const CHOICE_PRIVATE = "Private";
export const CHOICE_PRIMARY_READ = "Primary household — read";
export const CHOICE_PRIMARY_EDIT = "Primary household — edit";
export const CHOICE_HOUSEHOLD_READ = "Household · read";
export const CHOICE_HOUSEHOLD_EDIT = "Household · edit";
export const CHOICE_EXPLICIT = "Explicit policy…";
export const PREVIEW_UNCHANGED = "Saving this leaves the default as it is.";
export const PREVIEW_CHANGE = (summary: string) =>
  `New records of this kind would start as: ${summary}. Existing records are never changed by this edit.`;
export const SAVE_DEFAULTS = "Save";
export const SAVED_DEFAULTS = "Default saved.";
export const TEMPLATE_CONFLICT =
  "This template changed since you opened it. Reload to see the current version before saving.";
export const DEFAULTS_OFFLINE_READONLY =
  "You're offline: these are the defaults this device last saw, shown read-only.";
export const TEMPLATES_LOAD_FAILED = "Couldn't load the current templates.";

// ---- the defaults review (WEB-04 §5.7; sharing-preview-proposed.html) ---------------------------------------------------------------
export const REVIEW_TITLE = "Review sharing";
export const REVIEW_ACTION = "Review sharing";
export const REVIEW_HEADINGS: Readonly<Record<DefaultsReviewCase, string>> = {
  never_fetched: "Review who this will be shared with before sending",
  changed_rejected: "Sharing defaults have changed",
  review_unchanged: "Review who this will be shared with before sending",
  changed_never_sent: "Review who this will be shared with before sending",
};
export const REVIEW_BODIES: Readonly<Record<DefaultsReviewCase, string>> = {
  never_fetched:
    "This change was saved before this device had loaded your sharing defaults, so who it would be shared with was never recorded. Check the current audience below before it is sent.",
  changed_rejected:
    "This change was created under different sharing defaults, and the server didn't apply it. Check who it would be shared with now, then send it again or discard it.",
  review_unchanged:
    "Your sharing defaults haven't changed, but this device never confirmed this audience before the change was saved. Check it before it is sent.",
  changed_never_sent:
    "Your sharing defaults appear to have changed since this device last saw them. This change hasn't been sent under either. Check who it would be shared with now.",
};
export const REVIEW_WAS = "Was — as of when this change was saved";
export const REVIEW_WAS_NOTE = (revision: string) =>
  `Defaults revision ${revision.slice(0, 6)}… — the audience recorded at the time, not today's.`;
export const REVIEW_NOT_RECORDED = "Not recorded on this device.";
export const REVIEW_NOW = "Now — current defaults";
export const REVIEW_NOW_NOTE = (when: string) =>
  `Read from the server ${when}. Confirming uses these defaults.`;
export const REVIEW_NOW_NEEDS_CONNECTION =
  "Connect to see the current audience before sending.";
export const REVIEW_NOW_LOADING = "Loading the current defaults…";
export const REVIEW_NOW_FAILED = "Couldn't load the current defaults.";
export const REVIEW_MEMBERS_UNKNOWN = "Members not known on this device";
export const REVIEW_CONFIRM = "Confirm and send";
export const REVIEW_DISCARD = "Discard change";
export const REVIEW_CONFIRMED = "Change confirmed. It will be sent.";
export const REVIEW_DISCARDED = "Change discarded.";
export const REVIEW_CONFIRM_REASON = "Load the current defaults first.";
export const REVIEW_GONE = "This change is no longer waiting for review.";
export const REVIEW_OWN_SCREEN =
  "This change can't be confirmed here because what it was based on has changed. Open it from where you made it to review it.";
export const REVIEW_FAILED = "Couldn't confirm this change. Try again.";
export const REVIEW_DISCARD_FAILED = "Couldn't discard this change. Try again.";
export const REVIEW_ROW_BODY =
  "Check who this will be shared with before it is sent.";

// ---- the households demonstration (WEB-12a's subset; WEB-12b owns WF-SHARING-01/02) ------------------------------------------------
export const HOUSEHOLDS_HEADING = "Your households";
export const HOUSEHOLDS_SUBSET_NOTE =
  "Create a household and invite people to it. Full household management comes later.";
export const HOUSEHOLDS_EMPTY = "You're not in a household.";
export const HOUSEHOLDS_OFFLINE_NONE =
  "Offline, and this device hasn't loaded your households yet.";
export const HOUSEHOLDS_LOADING = "Loading your households…";
export const HOUSEHOLDS_FAILED = "Couldn't load your households.";
export const HOUSEHOLD_ROLE = (role: "manager" | "member") =>
  role === "manager" ? "You manage this household" : "You're a member";
export const HOUSEHOLD_MEMBERS = (n: number) =>
  n === 1 ? "1 member" : `${n} members`;
export const PRIMARY_BADGE = "Primary";
export const CREATE_HEADING = "Create a household";
export const CREATE_NAME = "Household name";
export const CREATE_BUTTON = "Create household";
export const CREATE_NAME_REASON = "Enter a name of 1 to 300 characters.";
export const CREATED = "Household created.";
export const INVITE_LABEL = (name: string) =>
  `Invite to “${name}” by exact username`;
export const INVITE_BUTTON = "Invite";
export const INVITE_REASON = "Enter their exact username.";
export const INVITED = "Invitation sent.";
export const INVITE_NOT_FOUND = "No account has that exact username.";
export const INVITATIONS_HEADING = "Invitations for you";
export const INVITATIONS_EMPTY = "No pending invitations";
export const INVITATION_FROM = (household: string, expires: string) =>
  `To join “${household}” · expires ${expires}`;
export const ACCEPT = "Accept";
export const DECLINE = "Decline";
export const ACCEPTED = "Invitation accepted.";
export const DECLINED = "Invitation declined.";
export const INVITATION_EXPIRED =
  "That invitation expired or was answered since this list was loaded.";
