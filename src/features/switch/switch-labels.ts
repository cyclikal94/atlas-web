/**
 * The two switch strings that the EAGER entry points need (the rail's account control and "Switch account" on the account card), kept
 * apart from the rest of the catalogue so that the protected shell does not carry the picker's words (WEB-08c, D-8c-05: the journey is
 * a lazily loaded chunk). `switch-copy.ts` re-exports both and remains the one catalogue its test checks.
 */

/** [W][D] the picker's title and the entry points' visible label. */
export const SWITCH_TITLE = "Switch account";

/** [P] the rail control's accessible name: the verified username, then what it does. */
export const slotLabel = (name: string): string => `${name}, switch account`;
