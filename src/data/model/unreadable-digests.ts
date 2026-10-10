/**
 * Digests that stand for "the work could not be read". The kernel compares the live digest with the baseline using `!==`, so the
 * two fallbacks MUST differ from each other and from every real digest (a SHA-256 hex string): if both fell back to one shared
 * string, an unreadable baseline and an unreadable live digest would compare EQUAL and the wipe would proceed as if nothing had
 * changed. A failure to read therefore always ends in a consent prompt (or a refused operation), never in a deletion.
 *
 * A module of their own (R61, revision 39): the boot path's deletion shim needs only these strings. A module both the boot path and
 * a lazy chunk import is placed whole in the initial chunk, so taking them from `local-work.ts` carried that module and the SHA-256
 * code into it. `local-work.ts` re-exports them.
 */
export const UNREADABLE_SUMMARY = "unreadable-summary";
export const UNREADABLE_BASELINE = "unreadable-baseline";
export const UNREADABLE_LIVE = "unreadable-live";
