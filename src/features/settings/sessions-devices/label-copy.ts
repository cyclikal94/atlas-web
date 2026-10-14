/**
 * WEB-08d: the words of recognisable sessions, devices, names and capacity. Provenance is marked per string: [D] follows an accepted
 * Claude Design pattern ("Chrome on macOS"), [W] keeps an accepted WEB-08a/WF-SETTINGS-02 string, and [P] is PROPOSED: no accepted
 * text exists, so Kieran's visual and copy sign-off remains open for every [P] string here. None of them is accepted by this card.
 */

// ---- client labels (BE-Q25 `ClientLabel`) ------------------------------------------------------------------------------------------
/** [P] display names of the contract's closed browser values ("unknown" has none: the label is shortened instead). */
export const BROWSER_TEXT = {
  chrome: "Chrome",
  edge: "Edge",
  firefox: "Firefox",
  safari: "Safari",
  opera: "Opera",
  samsung_internet: "Samsung Internet",
} as const;
/** [P] display names of the contract's closed platform values. */
export const PLATFORM_TEXT = {
  windows: "Windows",
  macos: "macOS",
  ios: "iOS",
  android: "Android",
  linux: "Linux",
  chromeos: "ChromeOS",
} as const;

/** [D] pattern "Chrome on macOS". */
export const browserOn = (browser: string, platform: string): string =>
  `${browser} on ${platform}`;
/** [P] a browser whose family is unknown, on a known platform. */
export const someBrowserOn = (platform: string): string =>
  `A browser on ${platform}`;
/** [P] a browser label with neither value known. */
export const UNKNOWN_BROWSER = "Unknown browser";
/** [P] the native channel ("Atlas for iOS" in the design names a product that may not exist on every platform). */
export const appOn = (platform: string): string => `Atlas app on ${platform}`;
export const APP = "Atlas app";
/** [P] a channel this client does not know (a later MINOR value). */
export const unknownClientOn = (platform: string): string =>
  `Unknown app or browser on ${platform}`;
export const UNKNOWN_CLIENT = "Unknown app or browser";

// ---- fallbacks and indicators ------------------------------------------------------------------------------------------------------
/** [W] WEB-08a's titles, kept as the fallback for a legacy, absent or unusable label. */
export const THIS_BROWSER = "This browser";
export const ANOTHER_SIGN_IN = "Another sign-in";
export const THIS_DEVICE = "This device";
export const ANOTHER_DEVICE = "Another device";
/** The same fallbacks inside a sentence (an accessible name, an announcement). */
export const ANOTHER_SIGN_IN_IN_SENTENCE = "another sign-in";
export const ANOTHER_DEVICE_IN_SENTENCE = "another device";
/** [W] brief: the tag on the current rows. */
export const THIS_BROWSER_TAG = "This browser";
export const THIS_DEVICE_TAG = "This device";

// ---- rows ----------------------------------------------------------------------------------------------------------------------------
/** [P] the hint when two or more devices show the same title. */
export const DUPLICATE_HINT =
  "Some devices look the same here. Give them names to tell them apart.";
/** [P] a session row's device, from `device_name` (the design's device column). */
export const ON_DEVICE = "On";

// ---- naming (D-8d-09, D-8d-10) -------------------------------------------------------------------------------------------------------
export const NAME_ACTION = "Name…"; // [P]
export const RENAME_ACTION = "Rename…"; // [P]
export const NAME_OFFLINE_REASON = "Naming a device needs a connection."; // [P]
export const NAME_LABEL = "Device name"; // [P]
export const NAME_DESCRIPTION =
  "Only people signed in to this account can see it. Up to 64 characters."; // [P]
export const SAVE_NAME = "Save name"; // [P]
export const REMOVE_NAME = "Remove name"; // [P]
export const CANCEL = "Cancel"; // [P]
/** [P] after `gone` ("Close" is the dialog header's own icon button). */
export const DONE = "Done"; // [P]
export const NAME_THIS_DEVICE_TITLE = "Name this device"; // [P]
export const NAME_A_DEVICE_TITLE = "Name a device"; // [P]
export const renameTitle = (isolatedName: string): string =>
  `Rename ${isolatedName}`; // [P]
export const NAME_PROBLEM = {
  empty: "Enter a name, or choose Remove name.",
  too_long: "Use 64 characters or fewer.",
  edge_space: "Remove the space at the start or end.",
  forbidden: "Remove the hidden or control characters from the name.",
} as const; // [P]
export const NAME_SAVED = "Name saved."; // [P]
export const NAME_REMOVED = "Name removed."; // [P]
/** [P] review R6: the earlier request finished while the person was typing; what they typed since stays in the field, unsent. */
export const NAME_SAVED_NEWER_KEPT =
  "The earlier name was saved. What you've typed since hasn't been saved yet."; // [P]
export const NAME_REMOVED_NEWER_KEPT =
  "The name was removed. What you've typed since hasn't been saved yet."; // [P]
export const NAME_GONE =
  "That device isn't listed any more, so its name wasn't changed."; // [P]
export const NAME_REFUSED =
  "Atlas didn't accept that name. Check it and try again."; // [P]
export const NAME_CHANGE_REFUSED =
  "Atlas refused that change, so nothing was changed."; // [P]
export const NAME_UNCONFIRMED =
  "We couldn't confirm the change. The list has been refreshed — check it, and try again if needed."; // [P]
export const NAME_NOT_SENT = "Nothing was changed. Please try again."; // [P]

// ---- capacity (D-8d-11) -----------------------------------------------------------------------------------------------------------
const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);
/** [P] live sessions (`session_capacity`). */
export const sessionsLimited = (used: number, limit: number): string =>
  `${used} of ${limit} sign-ins in use.`;
export const SESSIONS_FULL = "A new sign-in won't work until you sign one out.";
export const sessionsUnlimited = (used: number): string =>
  `${used} ${plural(used, "sign-in", "sign-ins")} in use. This server sets no limit.`;
export const SESSIONS_UNAVAILABLE =
  "We can't show how many sign-ins this account can have.";
/** [P] sync registrations (`sync_capacity`): never the number of listed devices. */
export const syncLimited = (used: number, limit: number): string =>
  `${used} of ${limit} places for syncing in use.`;
export const SYNC_FULL =
  "A new device can't start syncing until you retire one.";
export const syncUnlimited = (used: number): string =>
  `${used} ${plural(used, "place", "places")} for syncing in use. This server sets no limit.`;
export const SYNC_UNAVAILABLE = "We can't show how many devices can sync.";

// ---- confirmations and outcomes (D-8d-12) --------------------------------------------------------------------------------------------
/** [P] retiring another device, named. */
export const retireOtherTitle = (inSentence: string): string =>
  `Retire ${inSentence}?`;
/** [P] the identifying line above the WEB-04 verbatim wipe warning. */
export const thisDeviceLine = (title: string): string =>
  `This device: ${title}`;
export const thisBrowserLine = (title: string): string =>
  `This browser: ${title}`;
/** [P] another session signed out. */
export const signedOut = (inSentence: string): string =>
  `${inSentence.charAt(0).toUpperCase()}${inSentence.slice(1)} was signed out.`;
/** [W] WEB-08a's announcement, kept when the row has no label to name. */
export const SIGN_IN_ENDED = "That sign-in was ended.";
/** [P] the assertive announcement of a failed sign-out, which names the row (the visible line sits in the row itself). */
export const signOutFailed = (inSentence: string): string =>
  `Couldn't sign out ${inSentence} — please try again.`;
