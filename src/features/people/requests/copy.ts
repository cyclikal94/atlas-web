/**
 * WEB-11b's strings (WF-PEOPLE-05/06; design handoff `Atlas People Screens.dc.html` PEOPLE-05/06, which owns the wording). Strings the
 * design does not draw are PROVISIONAL additions, marked `(provisional)`, listed with their routes in `docs/people.md` §WEB-11b for the
 * connected-app checkpoint (STAGED-ACCEPTANCE-20261011; WEB-15 collects the sign-off). UK English.
 */

// ---- entry points (People 01) ---------------------------------------------------------------------------------------------------
export const REQUESTS = "Requests";
export const REQUESTS_WAITING = (n: number): string =>
  n === 1 ? "1 request waiting for you" : `${n} requests waiting for you`;
/** The badge's count above 99 (provisional). */
export const countText = (n: number): string => (n > 99 ? "99+" : String(n));
export const BACK_TO_PEOPLE = "People";

// ---- the Requests page (WF-PEOPLE-06) --------------------------------------------------------------------------------------------
export const WAITING_FOR_YOU = "Waiting for you";
export const FOR_YOU = (n: number | null): string =>
  n === null ? "For you" : `For you · ${n}`;
export const SENT = "Sent";
export const NEW_REQUEST = "New request";
export const NO_REQUESTS = "No requests waiting for you";
export const NO_SENT = "No sent requests yet"; // provisional (§4c: no device caveat once Q16 landed)
export const REQUESTS_OFFLINE = "Requests need a connection."; // provisional
export const REQUESTS_CHECKING = "Checking for requests…"; // provisional
export const REQUESTS_FAILED = "Atlas couldn't check your requests."; // provisional
export const CHECKED_AT = (time: string): string => `Checked at ${time}`; // provisional
export const REFRESH = "Refresh"; // provisional
export const TRY_AGAIN = "Try again";
export const CLOSE = "Close";
export const CANCEL = "Cancel";
export const RELOAD = "Reload";

export const TIME_LEFT = {
  days: (n: number) => (n === 1 ? "1 day left" : `${n} days left`),
  hours: (n: number) => (n === 1 ? "1 hour left" : `${n} hours left`),
  under_hour: "Less than an hour left", // provisional
  due: "Expires soon", // provisional
} as const;

// Incoming rows. The link row states the ACTUAL consequence (E-3: the recipient takes the person into THEIR profile; the drawn copy said
// the sender's).
export const SOMEONE = "Someone outside your households"; // provisional (D-11b-5)
export const UNNAMED_CAUTION =
  "Atlas can't show who sent this request. Only accept it if you were expecting it."; // provisional (D-11b-5, E-2b)
export const WANTS_TO_LINK = (name: string): string =>
  `wants to link “${name}” to your profile`; // E-3 correction of the drawn "into their own profile"
export const BEFORE_YOU_ACCEPT = "Before you accept";
export const LINK_CONSEQUENCE = (name: string): string =>
  `Linking fixes who can see each of ${name}'s fields, the same way merging does. If you already have a profile, the two become one.`; // E-3
export const WANTS_TO_MERGE = "wants to merge two people with you";
export const DECLINE = "Decline";
export const ACCEPT = "Accept";
export const CONFIRM_ACCEPT = "Confirm accept";
export const SEE_WHAT_CHANGES = "See what changes";
export const LINKED = (name: string): string =>
  `Linked. ${name} is now part of your profile.`; // provisional
export const DECLINED = "Request declined."; // provisional
export const MERGE_ACCEPTED = "Merged."; // provisional
export const ANSWER_RECORDED = "Your answer was recorded."; // provisional

// Sent rows (Q16: authoritative state, every state, no device caveat).
export const SENT_LINK = (username: string, name: string): string =>
  `You asked ${username} to link “${name}”`;
export const SENT_MERGE = (username: string, name: string): string =>
  `You asked ${username} to merge two people as “${name}”`;
export const STATE = {
  accepted: "Accepted",
  declined: "Declined",
  cancelled: "Cancelled",
  expired: "Expired",
} as const;
export const CANCEL_REQUEST = "Cancel request";
export const CANCEL_REQUEST_TO = (username: string): string =>
  `Cancel request to ${username}`;
export const CANCELLED = "Request cancelled."; // provisional
export const PAGE_MORE = "Nothing on this page — there are more to check"; // provisional (WEB-11a's paging rule)
export const NEXT = "Next";
export const PREVIOUS = "Previous";

// ---- New request -----------------------------------------------------------------------------------------------------------------
export const ASK_TO_LINK = "Ask to link";
export const ASK_TO_MERGE = "Ask to merge";
export const LINK_INTRO =
  "Ask someone to take one of your unlinked people into their own account, so they control it from then on.";
export const MERGE_INTRO =
  "Choose one of your people and someone you can see who is the same person. Atlas works out who has to agree."; // provisional
export const WHICH_OF_YOUR_PEOPLE = "Which of your people";
export const ONLY_UNLINKED = "Only people not already linked can be offered.";
export const WHO_TO_ASK = "Who to ask";
export const SEARCH_DIRECTORY = "Search the directory";
export const CHANGE = "change";
export const SEND_REQUEST = "Send request";
export const REQUEST_RULES =
  "Requests expire after 7 days. Only the person you ask can answer it.";
export const ONE_OF_YOUR_PEOPLE = "One of your people"; // provisional
export const THE_SAME_PERSON = "The same person"; // provisional
export const COMPARE = "Compare"; // provisional
export const CHOOSE = "Choose"; // provisional
export const FILTER_PEOPLE = "Filter by name"; // provisional
export const SHOW_MORE = "Show more"; // provisional
export const NO_PEOPLE_TO_OFFER = "None of your people can be offered."; // provisional
export const NO_MATCHES = "No one matches."; // provisional
export const PEOPLE_OFFLINE = "Choosing people needs a connection."; // provisional
export const PEOPLE_FAILED = "Atlas couldn't load your people."; // provisional
export const CHOOSE_PERSON_FIRST = "Choose a person first."; // provisional
export const CHOOSE_RECIPIENT_FIRST = "Choose who to ask first."; // provisional
export const CHOOSE_BOTH_FIRST = "Choose both people first."; // provisional
export const CHECK_LINK_FIRST =
  "Needs a connection to check who controls this profile."; // provisional
export const ALREADY_LINKED = "This person is already linked to an account."; // provisional
export const NOT_YOURS = "Only the person's owner can offer it."; // provisional
export const REQUEST_SENT = (username: string): string =>
  `Request sent to ${username}. It expires in 7 days.`; // provisional
export const ACCOUNT_GONE = "That account no longer exists."; // provisional (D-11b-11)
export const LOOKUP_FAILED = "Atlas couldn't check that account. Try again."; // provisional

// ---- the merge dialog (WF-PEOPLE-05) ---------------------------------------------------------------------------------------------
export const MERGE_TITLE = (source: string, target: string): string =>
  `Merge ${source} into ${target}`;
export const MERGE_TITLE_PLAIN = "Merge two people"; // provisional
export const NAME_AFTER = "Name after merging";
export const FIELD = "Field";
export const KEPT = (name: string): string => `${name} (kept)`;
export const NOT_ON_DEVICE = "Not on this device yet"; // provisional (D-11b-6)
export const NOT_VISIBLE = "Not visible to you"; // provisional
export const NONE = "—";
export const BOTH_HAVE = (label: string, source: string): string =>
  `Both have a ${label}. You'll keep both — the one from ${source} becomes a second entry; nothing is deleted.`;
export const FREEZE_TITLE = "Merging fixes who can see what, permanently";
export const FREEZE_BODY =
  "Right now each field's audience follows your Home settings. After merging, every field keeps exactly the people who can see it today, written in as a fixed list. Changing Home later won't move them — you'd have to change each field.";
export const FREEZE_BLOCKED =
  "Anyone currently blocked from a field stays blocked until you change that field yourself.";
export const OWN_BOTH = "You own both, so this happens straight away.";
export const MERGE_THEM = "Merge them";
export const HAS_TO_ACCEPT = (owner: string): string =>
  `${owner} has to accept this.`;
export const ASK_TO_MERGE_WITH = (owner: string): string =>
  `Ask ${owner} to merge`;
export const THE_OTHER_OWNER = "the other owner"; // provisional
export const EXPIRES_IN_7 = "Expires in 7 days if they don't respond.";
export const MERGED_INTO = (name: string): string => `Merged into ${name}.`; // provisional
export const MERGE_REQUESTED = (owner: string): string =>
  `Request sent to ${owner}.`; // provisional
export const BOTH_LINKED =
  "These two are both linked to Atlas accounts, so they can't be merged."; // provisional (D-11b-7)
export const LINKED_NAME =
  "A profile linked to an account keeps its account's name."; // provisional (D-11b-7)
export const LINKAGE_UNKNOWN =
  "Needs a connection to check who controls these profiles."; // provisional (D-11b-7)
export const PREVIEW_LOADING = "Loading the comparison…"; // provisional
export const LOAD_FIRST = "Load the comparison first."; // provisional
export const PREVIEW_FAILED = "Atlas couldn't load the comparison."; // provisional
export const PREVIEW_OFFLINE = "The comparison needs a connection."; // provisional
export const PREVIEW_NOT_FOUND =
  "One of these people is no longer available to you."; // provisional
export const PREVIEW_FORBIDDEN =
  "You need to own at least one of these people to merge them."; // provisional
export const PREVIEW_INVALID =
  "These two can't be merged: they are the same person, or one is archived."; // provisional
export const COMPARISON_CHANGED = "The comparison changed since it loaded."; // provisional (D-11b-9)

// The recipient's review.
export const ASKED = (sender: string): string => `${sender} asked`;
export const COMPARISON_UNAVAILABLE = "Comparison unavailable";
export const PARTIAL_VIEW = (sender: string): string =>
  `${sender}'s copy of this person has fields you don't have access to, so Atlas can't show you a side-by-side.`;
export const PARTIAL_CHECKS = (sender: string): string =>
  `Both answers stay available — accepting checks both what ${sender} can see and what you can see now. Declining is always safe.`; // replaces the drawn "Accept is checked against what Kieran can see, not what you can" (current contract)
export const STALE = (sender: string): string =>
  `${sender}'s view of this merge changed since they asked. Accepting will probably fail — you can decline or ask them to send it again.`; // provisional
export const REQUEST_EXPIRED = "This request has expired."; // provisional
export const REQUEST_GONE = "This request was already answered or withdrawn."; // provisional
export const MERGE_CHANGED = "This merge changed since you opened it."; // provisional
export const RECIPIENT_BOTH_LINKED =
  "Both of these are linked to Atlas accounts, so accepting will fail. You can decline."; // provisional
export const CANNOT_CHECK_HIDDEN =
  "Atlas can't check who controls the person you can't see. The server checks when you accept."; // provisional

// ---- outcomes (D-11b-9) ----------------------------------------------------------------------------------------------------------
export const UNCERTAIN =
  "Atlas couldn't confirm this. It may already have happened."; // provisional
export const NEEDS_CONNECTION = "Needs a connection";
export const READ_ONLY_COMPAT = "This version of Atlas can only read";
export const SAVING = "Sending…"; // provisional
export const ANSWERED_ELSEWHERE =
  "This request was already answered, cancelled or has expired."; // provisional
export const LINK_OUT_OF_DATE = (sender: string): string =>
  `${sender}'s person changed since they asked. Ask them to send it again.`; // provisional
export const CAPACITY = (username: string): string =>
  `${username} has too many requests waiting. Try again later.`; // provisional
export const OPERATION_CONFLICT =
  "Atlas sent this twice with different details. Nothing more was sent."; // provisional
export const FORBIDDEN = "You can't do this for these people any more."; // provisional
export const INVALID =
  "Atlas couldn't do this: one of these people is archived or they're the same person."; // provisional
export const ANSWER_UNCERTAIN_FIRST =
  "Your earlier answer may already have been recorded. Try it again first."; // provisional (§3.4)
export const PERSON_CHANGED =
  "This person changed since you chose them. Check and send again."; // provisional

// ---- after a merge (D-11b-12) -------------------------------------------------------------------------------------------------------
export const MERGED_ALIAS = (name: string): string => `Merged into ${name}`; // provisional
export const ANOTHER_PERSON = "another person"; // provisional
export const ALIAS_NO_RESTORE =
  "This person was merged into another; restore isn't available."; // provisional
export const ASK_TO_LINK_ENTRY = "Ask to link…";
export const COMPARE_AND_MERGE = "Compare & merge";
