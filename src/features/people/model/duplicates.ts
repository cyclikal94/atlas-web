/**
 * The duplicate suggestions of one person, as pages are read (WF-PEOPLE-04, PPL-3). PURE.
 *
 * `GET /people/{id}/duplicates` scans at most `limit` visible, non-archived people per page in id order, so a page can have NO items and
 * still a `next_after` (the scan was full and found nothing similar). Completeness is claimed ONLY after a page whose `next_after` is
 * null; an empty page with a cursor says "nothing so far", never "nothing". Pages are read when the person asks ("Check more"), not
 * automatically (Q9's bounded reads).
 *
 * "Not the same" hides a pair for the displayed identity for the life of the page (D-11a-9): no command exists for it, and nothing is
 * stored.
 */
export interface DuplicateHint {
  id: string;
  label: string;
}

export interface DuplicatesState {
  /** The hints read so far, in the order the pages gave them, without repeats. */
  hints: DuplicateHint[];
  /** The cursor of the next page; null once a page said there is none (`exhausted`), or before the first read. */
  cursor: string | null;
  /** How many pages have been read. */
  pages: number;
  exhausted: boolean;
}

export const initialDuplicates = (): DuplicatesState => ({
  hints: [],
  cursor: null,
  pages: 0,
  exhausted: false,
});

/** Folds one page in. */
export function addPage(
  state: DuplicatesState,
  page: { items: readonly DuplicateHint[]; next_after: string | null },
  self: string,
): DuplicatesState {
  const seen = new Set(state.hints.map((hint) => hint.id));
  const hints = [...state.hints];
  for (const item of page.items) {
    if (item.id === self || seen.has(item.id)) continue;
    seen.add(item.id);
    hints.push({ id: item.id, label: item.label });
  }
  return {
    hints,
    cursor: page.next_after,
    pages: state.pages + 1,
    exhausted: page.next_after === null,
  };
}

/** What the page says about completeness. */
export type DuplicatesSummary =
  | { kind: "not_read" }
  | { kind: "none_at_all" }
  | { kind: "none_so_far" }
  | { kind: "some"; complete: boolean };

export function summarise(
  state: DuplicatesState,
  dismissed: ReadonlySet<string>,
): DuplicatesSummary {
  if (state.pages === 0) return { kind: "not_read" };
  const shown = visibleHints(state, dismissed);
  if (shown.length > 0) return { kind: "some", complete: state.exhausted };
  return state.exhausted ? { kind: "none_at_all" } : { kind: "none_so_far" };
}

export const visibleHints = (
  state: DuplicatesState,
  dismissed: ReadonlySet<string>,
): DuplicateHint[] => state.hints.filter((hint) => !dismissed.has(hint.id));

/**
 * The count "Possible duplicates" shows from the first page: "2", or "2+" when more pages follow. Null when the first page found nothing
 * but more remain to be checked (PPL-3): no count is claimed then, not even "0".
 */
export function firstPageCount(page: {
  items: readonly unknown[];
  next_after: string | null;
}): string | null {
  if (page.next_after === null) return String(page.items.length);
  return page.items.length === 0 ? null : `${page.items.length}+`;
}
