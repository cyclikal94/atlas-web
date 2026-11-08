import { useId, useMemo, useState } from "react";
import { Button } from "../../components/ui/button";
import { List } from "../../components/ui/list";
import {
  type CacheRow,
  type JsonObject,
  useCachedResources,
  useResourceList,
} from "../../data";
import {
  ALL_DAY,
  BACK,
  CALENDAR,
  EVENT_CANCELLED,
  EVENT_MISSING,
  EVENTS_LOADING,
  FIELDS_LOADING,
  NO_DATE_FIELDS,
  NO_EVENTS_YET,
  NO_MATCHES,
  PICK_EVENT_TITLE,
  PICK_FIELD_TITLE,
  PICKER_UNREADABLE,
  SEARCH_FIELDS,
  SEARCH_TITLES,
  SHOW_NEXT_EVENTS,
  SHOW_NEXT_FIELDS,
  SHOW_PREVIOUS_EVENTS,
  SHOW_PREVIOUS_FIELDS,
} from "./copy-anchor";
import { Field } from "./fields";
import type { PickedEvent, PickedField } from "./model/anchor";
import { SourcePages, useSourcePage } from "./source-pages";

/**
 * The anchor panel's two pickers (WEB-13b §4.3): the cached events of a calendar source and the cached date fields of people. Both read
 * this device's cache only, a page (100) at a time, and both are filtered by a search over the page shown ("Show next" reads on); the
 * event picker's calendars are paged the same way (`source-pages.tsx`, R4), so every cached source and event can be reached. A
 * picker never invents a name or a date: an event shows its own title and start; a field shows its person's name only when the person
 * is cached here. People screens are WEB-11a's; nothing here edits a person or a field.
 */

/** A cached `event` row's value (`CalendarEvent`), read strictly; null when it is not one. */
export interface EventFacts {
  uid: string;
  title: string;
  date: string;
  time: string | null;
  status: "present" | "cancelled" | "missing";
}

export function parseEvent(value: JsonObject | null): EventFacts | null {
  const v = (value ?? {}) as Record<string, unknown>;
  const start = v.start as Record<string, unknown> | null | undefined;
  if (
    typeof v.uid !== "string" ||
    v.uid === "" ||
    typeof v.title !== "string" ||
    typeof start !== "object" ||
    start === null ||
    typeof start.date !== "string" ||
    (start.time !== null && typeof start.time !== "string") ||
    (v.status !== "present" &&
      v.status !== "cancelled" &&
      v.status !== "missing")
  )
    return null;
  return {
    uid: v.uid,
    title: v.title,
    date: start.date,
    time: typeof start.time === "string" ? start.time : null,
    status: v.status,
  };
}

/** A cached `field` row's date value (`{kind: "date", year?, month, day}`), read strictly; null for any other field. */
export function parseDateField(
  value: JsonObject | null,
): { year: number | null; month: number; day: number } | null {
  const v = (value ?? {}) as Record<string, unknown>;
  if (v.kind !== "date") return null;
  const { year, month, day } = v;
  if (
    (year !== null && year !== undefined && !Number.isInteger(year)) ||
    !Number.isInteger(month) ||
    !Number.isInteger(day) ||
    (month as number) < 1 ||
    (month as number) > 12 ||
    (day as number) < 1 ||
    (day as number) > 31
  )
    return null;
  return {
    year: typeof year === "number" ? year : null,
    month: month as number,
    day: day as number,
  };
}

/**
 * F40-2 (review 40; design assessment P2): a page that is not READY claims nothing. While its read has not answered (`loading`, every
 * opening and every "Show next/previous" move) the list says it is loading; a database that cannot be read (`unavailable`) says so. Only
 * a ready page with no rows says there are none.
 */
function PageState({
  status,
  loading,
}: {
  status: "loading" | "unavailable";
  loading: string;
}) {
  return status === "loading" ? (
    <div data-picker-state="loading" aria-busy="true">
      <p className="text-sm text-muted-foreground">{loading}</p>
    </div>
  ) : (
    <p
      data-picker-state="unavailable"
      className="text-sm text-muted-foreground"
    >
      {PICKER_UNREADABLE}
    </p>
  );
}

const matches = (text: string, search: string): boolean =>
  search.trim() === "" ||
  text.toLowerCase().includes(search.trim().toLowerCase());

function Pages({
  cursors,
  next,
  labels,
  onPrevious,
  onNext,
}: {
  cursors: number;
  next: string | null;
  labels: { next: string; previous: string };
  onPrevious(): void;
  onNext(): void;
}) {
  if (cursors <= 1 && next === null) return null;
  return (
    <div className="flex flex-wrap gap-2">
      {cursors > 1 ? (
        <Button variant="ghost" onClick={onPrevious}>
          {labels.previous}
        </Button>
      ) : null}
      {next !== null ? (
        <Button variant="ghost" onClick={onNext}>
          {labels.next}
        </Button>
      ) : null}
    </div>
  );
}

/** "Change event…": a source, then one of its cached events; choosing an event chooses its series (`uid`). */
export function EventPicker({
  initialSource,
  onPick,
  onBack,
}: {
  initialSource: string | null;
  onPick(event: PickedEvent, names: { source: string; event: string }): void;
  onBack(): void;
}) {
  const selectId = useId();
  // A page of sources at a time, with its own "Show previous/next calendars" (R4): every cached source can be chosen.
  const sourcePage = useSourcePage();
  const pageRows: CacheRow[] = sourcePage.rows ?? [];
  const [chosen, setChosen] = useState<string | null>(initialSource);
  const sourceId = chosen ?? pageRows[0]?.id ?? null;
  // The chosen source stays an option while another page is shown (its row read on its own), so the select never shows a source other
  // than the one whose events are listed.
  const offPage =
    sourceId !== null && !pageRows.some((row) => row.id === sourceId);
  const chosenRow = useCachedResources(
    offPage && sourceId !== null ? [sourceId] : [],
  );
  const offPageRow =
    offPage && sourceId !== null && chosenRow.status === "ready"
      ? (chosenRow.value[sourceId]?.merged ?? null)
      : null;
  const sourceRows: CacheRow[] =
    offPageRow === null ? pageRows : [offPageRow, ...pageRows];
  const sourceLabel =
    sourceRows.find((row) => row.id === sourceId)?.label ?? "";
  const [cursors, setCursors] = useState<Array<string | null>>([null]);
  const after = cursors[cursors.length - 1] ?? null;
  const page = useResourceList({
    kind: "event",
    parentId: sourceId ?? "",
    after,
    limit: 100,
  });
  const [search, setSearch] = useState("");
  const events = useMemo(() => {
    if (page.status !== "ready") return [];
    const seen = new Set<string>();
    const out: Array<{ id: string; facts: EventFacts }> = [];
    for (const row of page.value.rows) {
      const facts = parseEvent(row.merged.value);
      if (facts === null || seen.has(facts.uid)) continue;
      seen.add(facts.uid);
      out.push({ id: row.base.id, facts });
    }
    return out;
  }, [page]);
  const shown = events.filter((event) => matches(event.facts.title, search));
  return (
    <div data-anchor-picker="event" className="flex flex-col gap-4">
      <h3 className="text-sm font-medium text-foreground">
        {PICK_EVENT_TITLE}
      </h3>
      <div className="flex flex-col gap-1.5">
        <label
          htmlFor={selectId}
          className="text-sm font-medium text-foreground"
        >
          {CALENDAR}
        </label>
        <select
          id={selectId}
          data-field-edge=""
          value={sourceId ?? ""}
          onChange={(event) => {
            setChosen(event.target.value);
            setCursors([null]);
          }}
          className="atlas-transition box-border min-h-11 w-full rounded-md border border-input bg-background px-3 py-2.5 text-sm text-foreground"
        >
          {sourceRows.map((row) => (
            <option key={row.id} value={row.id}>
              {row.label}
            </option>
          ))}
        </select>
        <SourcePages
          page={sourcePage}
          onPage={() => {
            if (chosen === null && sourceId !== null) setChosen(sourceId);
          }}
        />
      </div>
      <Field
        label={SEARCH_TITLES}
        name="search"
        type="search"
        value={search}
        onChange={(event) => setSearch(event.target.value)}
      />
      {page.status !== "ready" ? (
        <PageState status={page.status} loading={EVENTS_LOADING} />
      ) : events.length === 0 ? (
        <p className="text-sm text-muted-foreground">{NO_EVENTS_YET}</p>
      ) : shown.length === 0 ? (
        <p className="text-sm text-muted-foreground">{NO_MATCHES}</p>
      ) : (
        <List className="flex flex-col gap-2">
          {shown.map(({ id, facts }) => (
            <li key={id} className="list-none">
              <button
                type="button"
                data-event-uid={facts.uid}
                onClick={() =>
                  sourceId !== null &&
                  onPick(
                    { sourceId, uid: facts.uid, timed: facts.time !== null },
                    { source: sourceLabel, event: facts.title },
                  )
                }
                className="atlas-transition flex min-h-11 w-full flex-col items-start gap-0.5 rounded-lg border border-border bg-card p-3 text-left hover:bg-accent"
              >
                <span className="break-words text-sm text-foreground">
                  {facts.title}
                </span>
                <span className="text-xs text-muted-foreground">
                  {facts.date} · {facts.time?.slice(0, 5) ?? ALL_DAY}
                  {facts.status === "cancelled"
                    ? ` · ${EVENT_CANCELLED}`
                    : facts.status === "missing"
                      ? ` · ${EVENT_MISSING}`
                      : ""}
                </span>
              </button>
            </li>
          ))}
        </List>
      )}
      <Pages
        cursors={cursors.length}
        next={page.status === "ready" ? page.value.next : null}
        labels={{ next: SHOW_NEXT_EVENTS, previous: SHOW_PREVIOUS_EVENTS }}
        onPrevious={() => setCursors((list) => list.slice(0, -1))}
        onNext={() => {
          const next = page.status === "ready" ? page.value.next : null;
          if (next !== null) setCursors((list) => [...list, next]);
        }}
      />
      <span className="flex">
        <Button variant="ghost" onClick={onBack}>
          {BACK}
        </Button>
      </span>
    </div>
  );
}

/** "Choose field…": the cached date fields, labelled "{person} — {field}" when the person is cached here. */
export function FieldPicker({
  onPick,
  onBack,
}: {
  onPick(field: PickedField, names: { field: string }): void;
  onBack(): void;
}) {
  const [cursors, setCursors] = useState<Array<string | null>>([null]);
  const after = cursors[cursors.length - 1] ?? null;
  const page = useResourceList({ kind: "field", after, limit: 100 });
  const fields = useMemo(() => {
    if (page.status !== "ready") return [];
    return page.value.rows.flatMap((row) => {
      const date = parseDateField(row.merged.value);
      return date === null ? [] : [{ row: row.merged, date }];
    });
  }, [page]);
  const parents = useMemo(
    () => [
      ...new Set(
        fields
          .map(({ row }) => row.parent_id)
          .filter((id): id is string => id !== null),
      ),
    ],
    [fields],
  );
  const people = useCachedResources(parents);
  const nameOf = (row: CacheRow): string => {
    const person =
      row.parent_id !== null && people.status === "ready"
        ? people.value[row.parent_id]?.merged.label
        : undefined;
    return person ? `${person} — ${row.label}` : row.label;
  };
  const [search, setSearch] = useState("");
  const shown = fields.filter(({ row }) => matches(nameOf(row), search));
  return (
    <div data-anchor-picker="field" className="flex flex-col gap-4">
      <h3 className="text-sm font-medium text-foreground">
        {PICK_FIELD_TITLE}
      </h3>
      <Field
        label={SEARCH_FIELDS}
        name="search"
        type="search"
        value={search}
        onChange={(event) => setSearch(event.target.value)}
      />
      {page.status !== "ready" ? (
        <PageState status={page.status} loading={FIELDS_LOADING} />
      ) : fields.length === 0 ? (
        <p className="text-sm text-muted-foreground">{NO_DATE_FIELDS}</p>
      ) : shown.length === 0 ? (
        <p className="text-sm text-muted-foreground">{NO_MATCHES}</p>
      ) : (
        <List className="flex flex-col gap-2">
          {shown.map(({ row, date }) => (
            <li key={row.id} className="list-none">
              <button
                type="button"
                data-field-id={row.id}
                onClick={() =>
                  onPick(
                    { fieldId: row.id, hasYear: date.year !== null },
                    { field: nameOf(row) },
                  )
                }
                className="atlas-transition flex min-h-11 w-full flex-col items-start gap-0.5 rounded-lg border border-border bg-card p-3 text-left hover:bg-accent"
              >
                <span className="break-words text-sm text-foreground">
                  {nameOf(row)}
                </span>
              </button>
            </li>
          ))}
        </List>
      )}
      <Pages
        cursors={cursors.length}
        next={page.status === "ready" ? page.value.next : null}
        labels={{ next: SHOW_NEXT_FIELDS, previous: SHOW_PREVIOUS_FIELDS }}
        onPrevious={() => setCursors((list) => list.slice(0, -1))}
        onNext={() => {
          const next = page.status === "ready" ? page.value.next : null;
          if (next !== null) setCursors((list) => [...list, next]);
        }}
      />
      <span className="flex">
        <Button variant="ghost" onClick={onBack}>
          {BACK}
        </Button>
      </span>
    </div>
  );
}
