import type { DefaultsRecord } from "../../../data";

/**
 * The defaults review's "Now" (WEB-04 §5.7; D-12a-6). PURE.
 *
 * "Now" is shown, and Confirm offered, ONLY from a snapshot whose request was issued after the review opened: a persisted record, or one a
 * page read earlier, is what the device last saw, not the current audience, and confirming against it would send the draft under a
 * revision the person did not see fetched. A record issued before the review opened is never "Now".
 */
export function freshForReview(
  record: DefaultsRecord | null,
  openedAt: number,
): DefaultsRecord | null {
  return record !== null && record.issued_at >= openedAt ? record : null;
}
