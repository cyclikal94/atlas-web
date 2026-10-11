/**
 * The words of WF-SWITCH-01 (the account picker) and WF-SWITCH-02 ("Sign in as …"), in one closed catalogue (WEB-08c). Provenance
 * of each string, as in `outcome-copy.ts`: [W] verbatim from the accepted wireframes (`wireframes/gaps/switch-01-desktop.html`,
 * `switch-01-mobile.html`, `switch-02-desktop.html`, `wireframes/switch/states.md`), [D] verbatim from the accepted Claude Design
 * board (`Atlas Sync Screens.dc.html`), [P] provisional (no accepted text exists; Kieran's copy acceptance is open for each).
 * `tests/features/switch/switch-copy.test.ts` compares every [W]/[D] string with the staged files and lists every [P].
 *
 * Nothing here names an account except through the parameters, and those come only from VERIFIED profile data: the current
 * account's label for the current epoch, or a retained account's own last verified username (decision D-8c-01).
 */
import { SWITCH_TITLE } from "./switch-labels";

export const SWITCH_COPY = {
  /** [W][D] the picker's title and the entry points' visible label (`switch-labels.ts`). */
  title: SWITCH_TITLE,
  /** [W][D] the current account's row. */
  signedInNow: "Signed in now",
  /** [W][D] (desktop wording) a retained account's row: a local record, never a live session. */
  usedBefore: "Used on this computer before",
  /** [W][D] the row that opens WF-SWITCH-02 with an empty username. */
  differentAccount: "Use a different account",
  /** [W][D] the model note, before any row. */
  note: "You'll need to sign in — this isn't a quick swap. Doing it here also changes the account in any other Atlas tab you have open.",
  /** [W] states.md E: only the current account has a database here. */
  onlyOne: "Only one account is linked — nothing to switch to",
  /** [W] states.md E: the action in the empty state. */
  addAnother: "Add another account",
  /** [P] the listing could not be read (indexedDB.databases() unavailable or refused): never "no other accounts". */
  unknownListing:
    "Atlas couldn't check which other accounts have used this computer. You can still sign in to another account.",
  /** [P] the skeleton's accessible text. */
  loading: "Loading accounts used on this computer…",
  /** [P] a current row whose label is not verified for this sign-in yet (no name is ever guessed). */
  thisAccount: "This account",
  /** [P] a retained account whose database holds no verified username (D-8c-01). */
  unnamedRetained: "An account used on this computer before",
  /** [W][D] "Before you switch" heading of the queued caution. */
  cautionHeading: "Before you switch",
  /** [P] WF-SWITCH-02's heading for "Use a different account" (the wireframe draws only the named case). */
  signInOther: "Sign in to another account",
} as const;

/** [W][D] "2 waiting" on a row (a text tag, never colour alone). */
export const waitingTag = (count: number): string => `${count} waiting`;

/** [W][D] WF-SWITCH-02's heading and primary control, "Sign in as sam". */
export const signInAs = (name: string): string => `Sign in as ${name}`;

/** [W][D] the cancel control, "Cancel — stay as kieran". */
export const stayAs = (current: string): string =>
  `Cancel — stay as ${current}`;

/**
 * [W][D] the queued caution, "kieran has 2 items still waiting to send. They stay saved, but they can't send until kieran signs in on
 * this computer again." The count is the CURRENT account's live queue; the note is shown only when it is above zero.
 */
export const cautionText = (current: string, count: number): string =>
  `${current} has ${count} ${count === 1 ? "item" : "items"} still waiting to send. They stay saved, but they can't send until ${current} signs in on this computer again.`;

/** [P] the rail control's accessible name: the verified username, then what it does (in `switch-labels.ts`, for the eager entry points). */
export { slotLabel } from "./switch-labels";
