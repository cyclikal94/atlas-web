/**
 * WEB-19's strings ("Recent changes" on the person detail). Every one is PROVISIONAL: this card's addition to WF-PEOPLE-02 (the People 02
 * mock's rail), collected for the connected-app copy checkpoint like the rest of the People copy; nothing here is approved by being
 * written down. UK English, sentence case. The mock's sharing row ("narrowed … to only you") has no string: sharing changes are not
 * recorded (Kieran, 1 November 2026).
 */
export const HEADING = "Recent changes"; // PROVISIONAL
export const CHECKING = "Checking recent changes…"; // PROVISIONAL
export const OFFLINE = "Recent changes are shown when you're online."; // PROVISIONAL
export const FAILED = "Couldn't load recent changes."; // PROVISIONAL
export const TRY_AGAIN = "Try again";
export const GONE = "You can no longer see this person's changes."; // PROVISIONAL
export const MERGED =
  "This profile was merged. Its changes are shown on the person it was merged into."; // PROVISIONAL
export const OPEN_MERGED = "Open that person"; // PROVISIONAL
export const EMPTY = (since: string) => `No changes recorded since ${since}.`; // PROVISIONAL
export const RECORDED_SINCE = (since: string) => `Recorded since ${since}.`; // PROVISIONAL
export const START_REACHED = "Earlier changes weren't recorded."; // PROVISIONAL
export const SCOPE_NOTE =
  "Shows changes to what you can see now, with current names."; // PROVISIONAL
export const SHOW_ALL = "Show all changes"; // PROVISIONAL
export const SHOW_OLDER = "Show older changes"; // PROVISIONAL
export const SHOW_FEWER = "Show fewer"; // PROVISIONAL
export const LOADING_OLDER = "Loading older changes…"; // PROVISIONAL
export const OLDER_FAILED = "Couldn't load older changes."; // PROVISIONAL
export const OLDER_SHOWN = (count: number) =>
  count === 1 ? "1 older change shown." : `${count} older changes shown.`; // PROVISIONAL
export const CAP = (count: number) =>
  `Showing the ${count} most recent changes.`; // PROVISIONAL
export const TAG_ARCHIVED = "Archived"; // PROVISIONAL
export const TAG_MERGED = "Merged profile"; // PROVISIONAL

// ---- sentences (`describe.ts`): the actor, then these parts ------------------------------------------------------------------------
export const ACTOR_YOU = "You"; // PROVISIONAL
export const ACTOR_SOMEONE_ELSE = "Someone else"; // PROVISIONAL
export const THIS_PERSON = "this person"; // PROVISIONAL
export const VERB_ADDED = "added"; // PROVISIONAL
export const VERB_RENAMED = "renamed"; // PROVISIONAL
export const VERB_ARCHIVED = "archived"; // PROVISIONAL
export const VERB_RESTORED = "restored"; // PROVISIONAL
export const VERB_LINKED = "linked"; // PROVISIONAL
export const VERB_UNLINKED = "unlinked"; // PROVISIONAL
export const VERB_MERGED = "merged"; // PROVISIONAL
export const VERB_CHANGED_NAME = "changed the name of"; // PROVISIONAL
export const VERB_CHANGED_VALUE = "changed the value of"; // PROVISIONAL
export const VERB_CHANGED_NAME_AND_VALUE = "changed the name and value of"; // PROVISIONAL
export const ANOTHER_PROFILE = "another profile"; // PROVISIONAL
export const INTO = "into"; // PROVISIONAL
export const TO_ACCOUNT = (account: string) => `to ${account}`; // PROVISIONAL
export const FROM_ACCOUNT = (account: string) => `from ${account}`; // PROVISIONAL
export const YOUR_ACCOUNT = "your account"; // PROVISIONAL
export const THEIR_ACCOUNT = "their account"; // PROVISIONAL
export const ANOTHER_ACCOUNT = "another account"; // PROVISIONAL
export const ACCOUNT_OF = (username: string) => `${username}'s account`; // PROVISIONAL
