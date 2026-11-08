/**
 * Every visible sentence of WEB-12b's household screens. PROPOSED copy (D-12b-16): it follows the accepted Sharing frames and wireframes
 * (WF-SHARING-01/02/05, `q21/household-invitations.html`) where they have wording, and is UK English, sentence case. It is recorded in
 * `docs/sharing.md` for the connected-app checkpoint and WEB-15's sign-off; nothing here is approved copy.
 */

// ---- the page ----------------------------------------------------------------------------------------------------------------------
export const SUBTITLE = "Households, and what gets shared by default";
export const INVITATIONS_ACTION = (n: number | null) =>
  n === null || n === 0 ? "Invitations" : `Invitations (${n})`;
export const DEFAULT_SHARING_ACTION = "Default sharing";
export const NEW_HOUSEHOLD_ACTION = "New household";
export const NEEDS_CONNECTION = "Needs a connection.";
export const DEFAULTS_SECTION = "Default sharing for new things";

// ---- the households pane (WF-SHARING-01) -------------------------------------------------------------------------------------------
export const PANE_HEADING = "Your households";
export const BACK_TO_HOUSEHOLDS = "Households";
export const PEOPLE = (n: number) => (n === 1 ? "1 person" : `${n} people`);
export const YOU_MANAGE = "you manage it";
export const MEMBER = "member";
export const MAIN_BADGE = "Main";
export const CAPACITY = (n: number) =>
  `You belong to ${n} of up to 32 households.`;
export const AT_CAPACITY =
  "You're in 32 households, the most Atlas allows. Leave one to create or join another.";
export const EMPTY = "You're not in a household";
export const EMPTY_BODY =
  "Create one, or accept an invitation from Invitations above.";
export const OFFLINE_NEVER =
  "Offline, and this device hasn't synced yet — connect to see your households.";
export const LOADING = "Loading your households…";
export const FAILED = "Couldn't load your households.";
export const LAST_READ = (when: string) =>
  `You're offline. Your households as last read ${when}.`;
export const FROM_SNAPSHOT =
  "You're offline. These are the households your last sharing defaults named, not necessarily every household you're in.";
export const SNAPSHOT_NONE =
  "You're offline. Your last sharing defaults named no households; connect to see every household you're in.";

// ---- the detail --------------------------------------------------------------------------------------------------------------------
export const MAIN_NOTE = (name: string) =>
  `${name} is your main household, so it decides the default for anything new.`;
export const NOT_MAIN_NOTE =
  "Your main household decides the default for anything new.";
export const MAKE_MAIN = "Make this my main household";
export const STOP_MAIN = "Stop using a main household";
export const STOP_MAIN_CONFIRM = (name: string) =>
  `Stop using ${name} as your main household? New things then start from your own sharing setting.`;
export const MAIN_WAIT = "Wait until your main household is known.";
export const MAIN_SET = (name: string) => `${name} is now your main household.`;
export const MAIN_CLEARED = "You no longer have a main household.";
export const MAIN_CHANGED =
  "Your main household changed elsewhere. It has been read again; try again if you still want this.";
export const MEMBERS_HEADING = "Members";
export const MEMBERS_AS_OF = (when: string) => `Last read ${when}`;
export const YOU = "you";
export const ROLE: Readonly<Record<"manager" | "member", string>> = {
  manager: "Manager",
  member: "Member",
};
export const MEMBERS_CANT_MANAGE =
  "Managers can invite and remove people; members can't.";
export const RENAME = "Rename";
export const INVITE_PEOPLE = "Invitations";
export const SIGNUP_ENTRY = "Signup links";
export const EDIT_DEFAULTS = "Default sharing";
export const PROMOTE = "Make manager";
export const DEMOTE = "Make member";
export const REMOVE = "Remove";
export const LEAVE = "Leave";
export const LAST_MANAGER = (name: string) =>
  `You can't leave ${name} while you're its only manager. Promote someone else first, and the Leave option becomes available.`;
export const LAST_MANAGER_DEMOTE =
  "You're the only manager. Promote someone else first.";
export const SOLE_MEMBER = (name: string) =>
  `You're the only member of ${name}, so you can't leave it.`;
export const LEAVE_CONFIRM = (name: string, main: boolean) =>
  main
    ? `Leave ${name}? You lose access to what's shared with it, and you'll no longer have a main household.`
    : `Leave ${name}? You lose access to what's shared with it.`;
export const REMOVE_CONFIRM = (who: string, name: string) =>
  `Remove ${who} from ${name}? They lose access to what's shared with ${name}, and their invitations for it are revoked.`;
export const DEMOTE_SELF_CONFIRM = (name: string) =>
  `Stop managing ${name}? You can no longer invite or remove people, and your signup links for it are revoked.`;
export const DEMOTE_CONFIRM = (who: string) =>
  `Make ${who} a member? Their signup links for this household are revoked.`;
export const CONFIRM = "Confirm";
export const CANCEL_ACTION = "Cancel";
export const CLOSE = "Done";
/** The signup dialog's own close: its issued link already has a "Done". */
export const CLOSE_SIGNUP = "Close";
export const LEFT = (name: string) => `You left ${name}.`;
export const REMOVED = (who: string) => `${who} was removed.`;
export const PROMOTED = (who: string) => `${who} is now a manager.`;
export const DEMOTED = (who: string) => `${who} is now a member.`;
export const NOT_IN_IT =
  "You're no longer in this household, or it doesn't exist.";
export const NOT_IN_IT_LINK = "Back to your households";
export const WAITING_HEADING = "Invited by you, waiting";
export const WAITING_NONE = "Nobody you invited is waiting to answer.";

// ---- new household and rename ------------------------------------------------------------------------------------------------------
export const NEW_TITLE = "New household";
export const NAME_LABEL = "Household name";
export const CREATE = "Create household";
export const NAME_REASON = "Enter a name of 1 to 300 characters.";
export const LIST_WAIT = "Wait until your households have loaded.";
/** New household's Create while the list it checks (the 32 cap, the same-name guard) could not be read: the banner above has Try again. */
export const LIST_FAILED_REASON =
  "Your households couldn't be loaded. Try again above first.";
export const SAME_NAME = (name: string) =>
  `You already belong to a household called ${name}. Create another?`;
export const CREATE_ANOTHER = "Create another";
export const CREATED = (name: string) => `${name} was created.`;
export const RENAME_TITLE = (name: string) => `Rename ${name}`;
export const SAVE_NAME = "Save name";
export const RENAMED = (name: string) => `Renamed to ${name}.`;
export const SAME_AS_NOW = "That's its name already.";

// ---- refusals ----------------------------------------------------------------------------------------------------------------------
export const CAPACITY_REFUSED =
  "Atlas didn't do this: you're already in 32 households, the most allowed.";
/** `invite_to_household`'s `slice_capacity`: the RECIPIENT already has as many pending invitations as the server allows (200 at 0.31). */
export const INVITE_CAPACITY_REFUSED =
  "Atlas didn't send this invitation: the person you invited already has as many invitations waiting as Atlas allows. They need to answer some first.";
/** A `slice_capacity` on any other command (none is known at 0.31): a limit, said without guessing which. */
export const LIMIT_REFUSED = "Atlas didn't do this: a limit was reached.";
export const LAST_MANAGER_REFUSED =
  "Atlas didn't do this: a household needs at least one other manager first.";
export const FORBIDDEN =
  "Atlas didn't do this: you don't manage this household (any more). It has been read again.";
export const CHANGED_ELSEWHERE =
  "This household changed since it was shown. It has been read again; try again.";
export const NOT_FOUND =
  "That's no longer there. The list has been read again.";
export const LOST_MANAGER =
  "You no longer manage this household, so you can only see it.";

// ---- invitations (WF-SHARING-02) ---------------------------------------------------------------------------------------------------
export const INVITATIONS_TITLE = "Invitations";
export const INVITATIONS_TITLE_FOR = (name: string) => `Invitations — ${name}`;
export const FOR_YOU = "For you";
export const FOR_YOU_NONE = "No pending invitations";
export const FOR_YOU_LOADING = "Loading your invitations…";
export const FOR_YOU_FAILED = "Couldn't load your invitations.";
export const INVITED_YOU = (name: string, days: number | null) =>
  days === null
    ? `${name} — invited you`
    : `${name} — invited you · ${days === 1 ? "1 day" : `${days} days`} left`;
export const ACCEPT = "Accept";
export const DECLINE = "Decline";
export const ACCEPTED = (name: string) => `You joined ${name}.`;
export const DECLINED = (name: string) => `You declined ${name}'s invitation.`;
export const INVITE_HEADING = (name: string) => `Invite someone to ${name}`;
export const USERNAME_LABEL = "Their username";
export const INVITE = "Invite";
export const FIND_ACCOUNT = "Find an account";
export const INVITE_REASON = "Enter their username.";
export const INVITE_RULE =
  "They'll have 7 days to accept. Managers can invite and remove people; members can't.";
export const INVITE_SELF = "That's your own account.";
export const INVITED = (who: string) => `${who} was invited.`;
export const INVITE_CONFLICT: Readonly<
  Record<"member" | "invited" | "changed", (who: string) => string>
> = {
  member: (who) => `${who} is already a member of this household.`,
  invited: (who) =>
    `You've already invited ${who}, and they haven't answered yet.`,
  changed: () =>
    "This household changed since it was shown. It has been read again; try again.",
};
export const INVITE_MANAGERS_ONLY =
  "Only a manager of this household can invite people.";
export const SENT_HEADING = "Sent by you";
export const SENT_NOTE = "Invitations other managers sent aren't listed here.";
export const SENT_NONE = "You haven't sent any invitations.";
export const SENT_LOADING = "Loading what you sent…";
export const SENT_FAILED = "Couldn't load the invitations you sent.";
export const SENT_TRUNCATED =
  "Older invitations you sent aren't shown here (only the first 2,000).";
export const STATUS = {
  pending: (days: number | null) =>
    days === null
      ? "Waiting"
      : `Waiting · ${days === 1 ? "1 day" : `${days} days`} left`,
  accepted: "Accepted",
  declined: "Declined",
  revoked: "Revoked",
  expired: "Expired",
} as const;
export const REVOKE = "Revoke";
export const SENT_REVOKED = (who: string) =>
  `The invitation to ${who} was revoked.`;
export const MANAGED_ELSEWHERE = (name: string) =>
  `To invite someone, open ${name}'s invitations.`;

// ---- signup invitations (Q21 group 2) ----------------------------------------------------------------------------------------------
export const SIGNUP_TITLE = (name: string) => `Invite people to ${name}`;
export const SIGNUP_BODY = (name: string) =>
  `Anyone with the link can create an account and join ${name}. Deliver it yourself — Atlas does not send it for you. Up to 20 unredeemed invitations at once.`;
export const SIGNUP_NEW = "New invitation";
export const SIGNUP_ISSUED =
  "Copy and send this link now — it is shown once and can't be retrieved again.";
export const SIGNUP_LINK_LABEL = "Invitation link";
export const SIGNUP_COPY = "Copy link";
export const SIGNUP_COPIED = "Link copied.";
export const SIGNUP_COPY_FALLBACK =
  "Couldn't copy automatically. The link is selected: copy it now.";
export const SIGNUP_DONE = "Done";
export const SIGNUP_READY = "Invitation link ready to copy";
export const SIGNUP_LIST_HEADING = "Active invitations";
export const SIGNUP_NONE = "No active signup invitations.";
export const SIGNUP_LOADING = "Loading the active invitations…";
export const SIGNUP_FAILED = "Couldn't load the active invitations.";
export const SIGNUP_LIST_NOTE =
  "This lists active invitations only: one disappears once it is used, revoked or expires.";
export const SIGNUP_COL_ID = "Invitation";
export const SIGNUP_COL_EXPIRES = "Expires";
export const SIGNUP_COL_STATUS = "Status";
export const SIGNUP_ACTIVE = "Active";
/** An invitation's id as the wireframe draws it (`inv_8f2c…e91a`): its first 8 and last 4 characters, so two rows never read the same. */
export const SIGNUP_ID = (id: string) => `${id.slice(0, 8)}…${id.slice(-4)}`;
export const SIGNUP_MAYBE_NEW =
  "May have just been created — its link can't be shown again. Revoke it if you don't have the link.";
export const SIGNUP_LIMIT =
  "Atlas didn't create an invitation: you may already have 20 waiting, or too many requests were made. Revoke one or try again shortly.";
export const SIGNUP_UNCERTAIN =
  "We couldn't confirm whether an invitation was created. It is not sent again: the list has been read again instead.";
export const SIGNUP_REVOKE = (id: string) => `Revoke invitation ${id}`;
export const SIGNUP_REVOKED = "Invitation revoked.";
export const SIGNUP_GONE =
  "That invitation was already used, revoked or expired.";
export const SIGNUP_REVOKE_UNCERTAIN =
  "We couldn't confirm it was revoked. Revoke again is safe.";
export const SIGNUP_LIST_WAIT = "Wait until the list has loaded.";
export const SIGNUP_ROLE_LOST =
  "You no longer manage this household — its pending signup invitations were revoked automatically.";
export const SIGNUP_MANAGERS_ONLY =
  "Only a manager of this household can create signup links.";
