import { useState } from "react";
import { Button } from "../../components/ui/button";
import { type CacheRow, useResourceList } from "../../data";
import { SHOW_NEXT_CALENDARS, SHOW_PREVIOUS_CALENDARS } from "./copy-anchor";

/** How many cached sources one page of a chooser reads (the Calendars list's own page). */
const PAGE = 100;

export interface SourcePage {
  /** The page's sources as the cache shows them (merged), or null while it is read. */
  rows: CacheRow[] | null;
  /** Whether this is a later page than the first, or there is one after it: some sources are not on this page. */
  partial: boolean;
  previous: (() => void) | null;
  next: (() => void) | null;
}

/**
 * The cached calendar sources a chooser offers (the event picker's calendar, the drop zone's import dialog), ONE bounded page (100) at a
 * time, as the Calendars list reads them (WEB-13b R4): "Show next calendars" and "Show previous calendars" reach every source this device
 * holds without reading more than a page. Paging never changes the choice: a source chosen on another page stays the chosen one (the
 * chooser keeps it as an option) until the person picks another.
 */
export function useSourcePage(): SourcePage {
  const [cursors, setCursors] = useState<Array<string | null>>([null]);
  const after = cursors[cursors.length - 1] ?? null;
  const page = useResourceList({ kind: "calendar_source", after, limit: PAGE });
  const next = page.status === "ready" ? page.value.next : null;
  return {
    rows: page.status === "ready" ? page.value.rows.map((r) => r.merged) : null,
    partial: cursors.length > 1 || next !== null,
    previous:
      cursors.length > 1 ? () => setCursors((list) => list.slice(0, -1)) : null,
    next: next === null ? null : () => setCursors((list) => [...list, next]),
  };
}

/**
 * The page's "Show previous calendars" / "Show next calendars", when there is another page. `onPage` is told first: a chooser showing
 * its default (the page's first source) fixes it there, so paging does not change what is chosen.
 */
export function SourcePages({
  page,
  onPage,
}: {
  page: SourcePage;
  onPage?(): void;
}) {
  const { previous, next } = page;
  if (previous === null && next === null) return null;
  return (
    <div className="flex flex-wrap gap-2">
      {previous !== null ? (
        <Button
          variant="ghost"
          onClick={() => {
            onPage?.();
            previous();
          }}
        >
          {SHOW_PREVIOUS_CALENDARS}
        </Button>
      ) : null}
      {next !== null ? (
        <Button
          variant="ghost"
          onClick={() => {
            onPage?.();
            next();
          }}
        >
          {SHOW_NEXT_CALENDARS}
        </Button>
      ) : null}
    </div>
  );
}
