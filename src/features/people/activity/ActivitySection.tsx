import { Link } from "@tanstack/react-router";
import {
  type RefObject,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import {
  type Announcement,
  useAnnouncer,
} from "../../../components/ui/announcer";
import { Button } from "../../../components/ui/button";
import { GroupedSection } from "../../../components/ui/grouped";
import { List } from "../../../components/ui/list";
import {
  type ListedResource,
  useCachedResource,
  useCachedResources,
} from "../../../data";
import type { PersonActivityEvent } from "../model/activity";
import * as copy from "./copy";
import { type ActivityPart, describeActivity } from "./describe";
import { formatSince, formatWhen, isoOf } from "./format";
import { ACTIVITY_MAX, ACTIVITY_PREVIEW, ACTIVITY_STEP } from "./timeline";
import {
  type ActivityShown,
  type ActivityView,
  useActivity,
} from "./useActivity";

/**
 * WEB-19: "Recent changes" on the person detail (D-19-1, after "Shared with"), from `GET /people/{id}/activity` while online
 * (`timeline.ts`, `useActivity.ts`). A compact preview of the newest 5 events, "Show all changes" (50), then "Show older changes" (50 more
 * each, at most 500), "Show fewer".
 *
 *  - Each event says who (as the server may name them), what, and when, naming the item by its CURRENT label. A field is a link only
 *    while it is the current, unarchived field of this person on this device, and a profile merged into this person only while this device
 *    holds it (D-19-6); everything else is plain, with its tags.
 *  - Honest coverage: "Recorded since …" from the server's `coverage_started_at`, never from the oldest event; nothing is made up from this
 *    device's own saves; a note says only changes the reader can see now are listed, with current names (shown to every reader alike).
 *  - While a re-read is on its way, the earlier answer stays (busy), but a field row whose field this device no longer holds is withheld at
 *    once (D-19-3): access changes arrive by sync before the re-read answers. It stays as the same tree (R-1): its items, controls,
 *    keyboard focus and the announcement survive every refresh (a synced change, a receipt, the 60-second tick, a return to the tab).
 */
export function ActivitySection({ personId }: { personId: string }) {
  const heading = useId();
  const view = useActivity(personId);
  return (
    <GroupedSection
      aria-labelledby={heading}
      data-activity={view.status}
      heading={<h3 id={heading}>{copy.HEADING}</h3>}
    >
      <Body view={view} personId={personId} />
    </GroupedSection>
  );
}

const note = "text-xs text-muted-foreground break-words";

function Body({ view, personId }: { view: ActivityView; personId: string }) {
  switch (view.status) {
    case "offline":
      return <p className={note}>{copy.OFFLINE}</p>;
    case "failed":
      return (
        <p className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
          {copy.FAILED}
          <Button variant="ghost" onClick={view.retry}>
            {copy.TRY_AGAIN}
          </Button>
        </p>
      );
    case "gone":
      return <p className="text-sm text-muted-foreground">{copy.GONE}</p>;
    case "merged":
      return <MergedNote canonicalId={view.canonicalId} />;
    case "loading":
      // R-1: the earlier answer is the SAME `Ready` element as the answer it will become (one type at one position), so React keeps its
      // tree across `ready -> loading -> ready`: the list's nodes, keyboard focus, the controls and the per-press state survive a re-read.
      return view.previous === null ? (
        <p aria-busy="true" className={note} data-activity-checking="">
          {copy.CHECKING}
        </p>
      ) : (
        <Ready view={view.previous} refreshing personId={personId} />
      );
    case "ready":
      return <Ready view={view} refreshing={false} personId={personId} />;
  }
}

/**
 * A shown timeline: the answer now, or (`refreshing`) the earlier one while a re-read is on its way, marked busy, its field rows withheld
 * once this device no longer holds the field (D-19-3). Its controls stay while refreshing; a press then moves the depth the re-read
 * reads to (`extendActivity`).
 */
function Ready({
  view,
  refreshing,
  personId,
}: {
  view: ActivityShown;
  refreshing: boolean;
  personId: string;
}) {
  const items = view.timeline.items;
  const listRef = useRef<HTMLDivElement>(null);
  const controlsRef = useRef<HTMLDivElement>(null);
  const announcer = useAnnouncer();
  const said = useRef<Announcement | null>(null);
  const busy = refreshing || view.extending;
  // "Show older changes" moves focus to the first event it shows, and says how many it showed (once the read is over, whichever read
  // it was: its own step, or a re-read that arrived meanwhile and read to the new depth), through the page's one polite live region
  // (lint R6).
  const [asked, setAsked] = useState<number | null>(null);
  const [refocus, setRefocus] = useState(false);
  useEffect(() => {
    if (asked === null || busy) return;
    setAsked(null);
    said.current?.retract();
    if (view.extendFailed) {
      said.current = announcer.announce(copy.OLDER_FAILED, "polite");
      return;
    }
    const shown = items.length - asked;
    if (shown <= 0) return;
    said.current = announcer.announce(copy.OLDER_SHOWN(shown), "polite");
    listRef.current
      ?.querySelectorAll<HTMLElement>("[data-activity-event]")
      [asked]?.focus();
  }, [asked, busy, view.extendFailed, items.length, announcer]);
  useEffect(() => () => said.current?.retract(), []);
  useEffect(() => {
    if (!refocus) return;
    setRefocus(false);
    // "Show fewer" is gone once pressed: focus goes to the control that shows more again.
    controlsRef.current
      ?.querySelector<HTMLElement>("[data-activity-extend]")
      ?.focus();
  }, [refocus]);
  const extend = () => {
    setAsked(items.length);
    view.extend();
  };
  return (
    <div
      aria-busy={busy ? "true" : undefined}
      className="flex min-w-0 flex-col gap-2"
    >
      {items.length === 0 ? (
        <>
          <p className={note} data-activity-empty="">
            {copy.EMPTY(formatSince(view.timeline.coverageStartedAt))}
          </p>
          <p className={note}>{copy.SCOPE_NOTE}</p>
        </>
      ) : (
        <>
          <Events
            events={items}
            personId={personId}
            withhold={refreshing}
            listRef={listRef}
          />
          <Coverage
            since={view.timeline.coverageStartedAt}
            startReached={view.startReached}
          />
          {view.atCap ? (
            <p className={note} data-activity-cap="">
              {copy.CAP(ACTIVITY_MAX)}
            </p>
          ) : null}
          {view.extending || (refreshing && asked !== null) ? (
            <p className={note} data-activity-status="loading">
              {copy.LOADING_OLDER}
            </p>
          ) : view.extendFailed ? (
            <p className={note} data-activity-status="failed">
              {copy.OLDER_FAILED}
            </p>
          ) : null}
          <div ref={controlsRef} className="flex flex-wrap items-center gap-2">
            {view.canExtend ? (
              <Button variant="ghost" onClick={extend} data-activity-extend="">
                {view.extendFailed
                  ? copy.TRY_AGAIN
                  : view.depth < ACTIVITY_STEP
                    ? copy.SHOW_ALL
                    : copy.SHOW_OLDER}
              </Button>
            ) : null}
            {view.depth > ACTIVITY_PREVIEW ? (
              <Button
                variant="ghost"
                onClick={() => {
                  view.collapse();
                  setRefocus(true);
                }}
              >
                {copy.SHOW_FEWER}
              </Button>
            ) : null}
          </div>
        </>
      )}
    </div>
  );
}

function Coverage({
  since,
  startReached = false,
}: {
  since: number;
  startReached?: boolean;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      {startReached ? (
        <p className={note} data-activity-start="">
          {copy.START_REACHED}
        </p>
      ) : null}
      <p className={note} data-activity-coverage="">
        {copy.RECORDED_SINCE(formatSince(since))}
      </p>
      <p className={note}>{copy.SCOPE_NOTE}</p>
    </div>
  );
}

type CachedRows = Readonly<Record<string, ListedResource | null>>;

/** The ids the events read from this device's cache: their targets, except the person itself, each once, as they first appear. */
const targetsOf = (
  events: readonly PersonActivityEvent[],
  personId: string,
): string[] => [
  ...new Set(
    events
      .filter(
        (event) =>
          event.target.kind === "field" || event.target.id !== personId,
      )
      .map((event) => event.target.id),
  ),
];

/**
 * The events, in ONE list (an item never moves between parents when newer events push it down, so it keeps its node and any focus in
 * it: R-1). This device's cached rows of their targets are read at most 50 targets at a time (one cached read each, under the store's
 * working set of 100; each target in exactly one read) and kept here by id: a read that restarts (its targets changed) keeps what it last
 * said of each id until it answers, so a link does not flash out on a refresh, while every answer that says a field is gone applies at
 * once.
 */
function Events({
  events,
  personId,
  withhold = false,
  listRef,
}: {
  events: readonly PersonActivityEvent[];
  personId: string;
  /** An earlier answer shown while a re-read is on its way: rows about a field this device no longer holds are withheld. */
  withhold?: boolean;
  listRef?: RefObject<HTMLDivElement | null>;
}) {
  const [rows, setRows] = useState<ReadonlyMap<string, ListedResource | null>>(
    () => new Map(),
  );
  const learn = useCallback(
    (answer: CachedRows) =>
      setRows((known) => {
        const entries = Object.entries(answer);
        if (
          entries.every(([id, row]) => known.has(id) && known.get(id) === row)
        )
          return known;
        const next = new Map(known);
        for (const [id, row] of entries) next.set(id, row);
        return next;
      }),
    [],
  );
  // Each target is read by exactly one of them (its targets in the order they first appear, 50 to a read).
  const targets = targetsOf(events, personId);
  const reads: string[][] = [];
  for (let start = 0; start < targets.length; start += ACTIVITY_STEP)
    reads.push(targets.slice(start, start + ACTIVITY_STEP));
  return (
    <div ref={listRef} className="min-w-0">
      <List className="flex min-w-0 flex-col gap-2">
        {events.map((event) => {
          const row = rows.get(event.target.id)?.merged ?? null;
          // D-19-3: while an earlier answer is shown, a field this device no longer holds (or cannot say it holds) is not shown.
          if (
            withhold &&
            event.target.kind === "field" &&
            (row === null || row.kind !== "field")
          )
            return null;
          return (
            <EventItem
              key={event.id}
              event={event}
              personId={personId}
              linkable={
                isCurrentField(event, row, personId) ||
                isCachedAlias(event, row, personId)
              }
            />
          );
        })}
      </List>
      {reads.map((ids, index) => (
        <CachedRowsOf
          // A read is a position in the list (its first 50, its next 50…), not a page of a read.
          // biome-ignore lint/suspicious/noArrayIndexKey: the slice's position is its identity
          key={index}
          ids={ids}
          onRows={learn}
        />
      ))}
    </div>
  );
}

/** One cached read of a slice's targets; says what it found before paint (an answer that a field is gone withholds it at once). */
function CachedRowsOf({
  ids,
  onRows,
}: {
  ids: readonly string[];
  onRows(rows: CachedRows): void;
}) {
  const cached = useCachedResources(ids);
  useLayoutEffect(() => {
    if (cached.status === "ready") onRows(cached.value);
    // No database (absent, closed, failed): nothing is held.
    else if (cached.status === "unavailable")
      onRows(Object.fromEntries(ids.map((id) => [id, null])));
  }, [cached, ids, onRows]);
  return null;
}

/** The current, unarchived field of this person, as the server and this device both say: its editor can be opened. */
const isCurrentField = (
  event: PersonActivityEvent,
  row: { kind: string; archived: boolean; parent_id: string | null } | null,
  personId: string,
): boolean =>
  event.target.kind === "field" &&
  event.target.state === "current" &&
  !event.target.archived &&
  row !== null &&
  row.kind === "field" &&
  !row.archived &&
  row.parent_id === personId;

/** A profile merged into this person, which this device holds (its alias detail can be opened). */
const isCachedAlias = (
  event: PersonActivityEvent,
  row: { kind: string } | null,
  personId: string,
): boolean =>
  event.target.kind === "person" &&
  event.target.state === "merged" &&
  event.target.id !== personId &&
  row !== null &&
  row.kind === "person";

function EventItem({
  event,
  personId,
  linkable,
}: {
  event: PersonActivityEvent;
  personId: string;
  linkable: boolean;
}) {
  const description = describeActivity(event, { personId });
  return (
    <li
      tabIndex={-1}
      data-activity-event={event.id}
      data-activity-type={event.type}
      className="flex min-w-0 list-none flex-col gap-0.5 rounded-md outline-none focus-visible:ring-2"
    >
      <p className="text-sm leading-[1.5] break-words text-foreground">
        {description.actor}
        {description.parts.map((part) => (
          <Part
            key={part.key}
            part={part}
            event={event}
            personId={personId}
            linkable={linkable}
          />
        ))}
        .
      </p>
      <span className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
        {tagsOf(event).map((tag) => (
          <span
            key={tag}
            data-activity-tag={tag}
            className="inline-flex rounded-md border border-border px-1.5 text-[11px]"
          >
            {tag}
          </span>
        ))}
        <time dateTime={isoOf(event.occurred_at)}>
          {formatWhen(event.occurred_at)}
        </time>
      </span>
    </li>
  );
}

/** The target's tags (shown beside the time, after the sentence): a merged profile, or an archived item, as it is NOW. */
const tagsOf = (event: PersonActivityEvent): string[] => [
  ...(event.target.state === "merged" ? [copy.TAG_MERGED] : []),
  ...(event.target.state === "current" && event.target.archived
    ? [copy.TAG_ARCHIVED]
    : []),
];

function Part({
  part,
  event,
  personId,
  linkable,
}: {
  part: ActivityPart;
  event: PersonActivityEvent;
  personId: string;
  linkable: boolean;
}) {
  if (part.kind === "text") return <> {part.text}</>;
  if (part.of === "source")
    return (
      <>
        {" "}
        <strong className="font-medium">{part.label}</strong>
      </>
    );
  const target = event.target;
  const label = <strong className="font-medium">{part.label}</strong>;
  return (
    <>
      {" "}
      {linkable ? (
        target.kind === "field" ? (
          <Link
            to="/people/$personId/fields/$fieldId"
            params={{ personId, fieldId: target.id }}
            data-activity-link={target.id}
            className="text-foreground underline hover:text-muted-foreground"
          >
            {label}
          </Link>
        ) : (
          <Link
            to="/people/$personId"
            params={{ personId: target.id }}
            data-activity-link={target.id}
            className="text-foreground underline hover:text-muted-foreground"
          >
            {label}
          </Link>
        )
      ) : (
        label
      )}
    </>
  );
}

/** D-19-7: the route's person was merged into another; its changes are on that person (linked when this device holds them). */
function MergedNote({ canonicalId }: { canonicalId: string }) {
  const canonical = useCachedResource(canonicalId);
  const held =
    canonical.status === "ready" && canonical.value.merged?.kind === "person";
  return (
    <p
      className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground"
      data-activity-merged={canonicalId}
    >
      {copy.MERGED}
      {held ? (
        <Link
          to="/people/$personId"
          params={{ personId: canonicalId }}
          className="atlas-transition inline-flex min-h-11 items-center text-sm text-foreground underline hover:text-muted-foreground"
        >
          {copy.OPEN_MERGED}
        </Link>
      ) : null}
    </p>
  );
}
