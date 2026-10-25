/**
 * The words of the "Anchor review needed" panel (WEB-13b). VERBATIM from `wireframes/q21/calendar-journeys.html` where it draws them;
 * everything else PROVISIONAL (STAGED-ACCEPTANCE-20261011). A private (generic) review never shows a date, a title or a task name.
 */
/** Verbatim. */
export const REVIEWS_HEADING = "Anchor review needed";
export const movedTitle = (task: string): string => `“${task}” moved`;
export const workStartedBody = (source: string): string =>
  `Anchored to ${source}. Started work exists on the current occurrence, so its timing wasn't moved automatically — review and decide.`;
export const REVIEW_MOVE = "Review this move…";
export const ACKNOWLEDGE_KEEP = "Acknowledge (keep current timing)";
export const NO_LONGER_AVAILABLE = "This review is no longer available to you.";
export const PRIVATE_GENERIC =
  "The schedule may have changed — check the source directly.";
/** Verbatim (the Missing/eligibility failure state). */
export const MISSING_BODY =
  "This task's calendar link is missing — its timing is kept as last known and a review was created";

/** Provisional. */
export const followedTitle = (task: string): string =>
  `“${task}” was moved to follow its calendar`;
export const previously = (when: string): string => `Previously ${when}.`;
export const proposed = (when: string): string => `Proposed: ${when}`;
export const cancelledTitle = (task: string): string =>
  `“${task}”: its calendar event was cancelled`;
export const CANCELLED_BODY =
  "Its timing is kept as last known and a review was created";
export const missingTitle = (task: string): string =>
  `“${task}”: its calendar link is missing`;
export const ineligibleTitle = (task: string): string =>
  `“${task}”: its calendar event no longer matches the anchor`;
export const INELIGIBLE_BODY =
  "Its timing is kept as last known — check the anchor's weekdays or title filter";
export const PRIVATE_TITLE = "A task's schedule may have changed";
export const UNREADABLE = "This review can't be shown on this device.";
export const A_TASK = "a task";
export const TASK_NOT_HERE = "This task isn't on this device yet.";
export const OPEN_TASK = "Open task";
export const ACKNOWLEDGE = "Acknowledge";
export const ACKNOWLEDGED = "Acknowledged — will confirm on next sync";
export const ACKNOWLEDGE_QUEUED = "Acknowledged — waiting to send";
export const REVIEW_CHANGED =
  "This review changed — check it and acknowledge again.";
export const REVIEW_CONFLICT = "This review changed elsewhere";
export const ACKNOWLEDGE_AGAIN = "Acknowledge again";
export const CANT_ACKNOWLEDGE = "You can't acknowledge this review.";
export const ACKNOWLEDGE_REJECTED = "Couldn't acknowledge this review.";
export const DISMISS_REVIEW = "Dismiss";
export const SHOW_MORE_REVIEWS = "Show more reviews";
export const NOT_SAVED_REVIEW = "Couldn't save — try again.";
/** Provisional: a calendar this device does not hold. */
export const ITS_CALENDAR = "its calendar";
/** Provisional: the correction dialog's line when it was opened from a review. */
export const FROM_REVIEW =
  "This came from a calendar review. Saving doesn't resolve the review — acknowledge it afterwards.";

/** Provisional: the queue's content-free description. */
export const DESCRIBE_RESOLVE_REVIEW = "Acknowledge a calendar review";
