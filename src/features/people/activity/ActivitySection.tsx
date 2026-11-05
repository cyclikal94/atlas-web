import { Link } from "@tanstack/react-router";
import { type RefObject, useEffect, useId, useRef, useState } from "react";
import {
  type Announcement,
  useAnnouncer,
} from "../../../components/ui/announcer";
import { Button } from "../../../components/ui/button";
import { List } from "../../../components/ui/list";
import { useCachedResource, useCachedResources } from "../../../data";
import type { PersonActivityEvent } from "../model/activity";
import * as copy from "./copy";
import { type ActivityPart, describeActivity } from "./describe";
import { formatSince, formatWhen, isoOf } from "./format";
import { ACTIVITY_MAX, ACTIVITY_PREVIEW, ACTIVITY_STEP } from "./timeline";
import { type ActivityView, useActivity } from "./useActivity";

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
 *    once (D-19-3): access changes arrive by sync before the re-read answers.
 */
export function ActivitySection({ personId }: { personId: string }) {
  const heading = useId();
  const view = useActivity(personId);
  return (
    <section
      aria-labelledby={heading}
      data-activity={view.status}
      className="flex max-w-[620px] min-w-0 flex-col gap-2 rounded-row border border-hairline bg-panel p-3.5"
    >
      <h3 id={heading} className="text-[13px] font-medium text-ink-1">
        {copy.HEADING}
      </h3>
      <Body view={view} personId={personId} />
    </section>
  );
}

const note = "text-[12.5px] text-ink-2 break-words";

function Body({ view, personId }: { view: ActivityView; personId: string }) {
  switch (view.status) {
    case "offline":
      return <p className={note}>{copy.OFFLINE}</p>;
    case "failed":
      return (
        <p className="flex flex-wrap items-center gap-2 text-[13px] text-ink-2">
          {copy.FAILED}
          <Button variant="quiet" onClick={view.retry}>
            {copy.TRY_AGAIN}
          </Button>
        </p>
      );
    case "gone":
      return <p className="text-[13px] text-ink-2">{copy.GONE}</p>;
    case "merged":
      return <MergedNote canonicalId={view.canonicalId} />;
    case "loading":
      return view.previous === null ? (
        <p aria-busy="true" className={note} data-activity-checking="">
          {copy.CHECKING}
        </p>
      ) : (
        <div aria-busy="true" className="flex min-w-0 flex-col gap-2">
          <Events
            events={view.previous.timeline.items}
            personId={personId}
            withhold
          />
          <Coverage since={view.previous.timeline.coverageStartedAt} />
        </div>
      );
    case "ready":
      return <Ready view={view} personId={personId} />;
  }
}

function Ready({
  view,
  personId,
}: {
  view: Extract<ActivityView, { status: "ready" }>;
  personId: string;
}) {
  const items = view.timeline.items;
  const listRef = useRef<HTMLDivElement>(null);
  const controlsRef = useRef<HTMLDivElement>(null);
  const announcer = useAnnouncer();
  const said = useRef<Announcement | null>(null);
  // "Show older changes" moves focus to the first event it shows, and says how many it showed (once the read is over), through the
  // page's one polite live region (lint R6).
  const [asked, setAsked] = useState<number | null>(null);
  const [refocus, setRefocus] = useState(false);
  useEffect(() => {
    if (asked === null || view.extending) return;
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
  }, [asked, view.extending, view.extendFailed, items.length, announcer]);
  useEffect(() => () => said.current?.retract(), []);
  useEffect(() => {
    if (!refocus) return;
    setRefocus(false);
    // "Show fewer" is gone once pressed: focus goes to the control that shows more again.
    controlsRef.current
      ?.querySelector<HTMLElement>("[data-activity-extend]")
      ?.focus();
  }, [refocus]);
  if (items.length === 0)
    return (
      <>
        <p className={note} data-activity-empty="">
          {copy.EMPTY(formatSince(view.timeline.coverageStartedAt))}
        </p>
        <p className={note}>{copy.SCOPE_NOTE}</p>
      </>
    );
  const extend = () => {
    setAsked(items.length);
    view.extend();
  };
  return (
    <div
      aria-busy={view.extending ? "true" : undefined}
      className="flex min-w-0 flex-col gap-2"
    >
      <Events events={items} personId={personId} listRef={listRef} />
      <Coverage
        since={view.timeline.coverageStartedAt}
        startReached={view.startReached}
      />
      {view.atCap ? (
        <p className={note} data-activity-cap="">
          {copy.CAP(ACTIVITY_MAX)}
        </p>
      ) : null}
      {view.extending ? (
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
          <Button variant="quiet" onClick={extend} data-activity-extend="">
            {view.extendFailed
              ? copy.TRY_AGAIN
              : view.depth < ACTIVITY_STEP
                ? copy.SHOW_ALL
                : copy.SHOW_OLDER}
          </Button>
        ) : null}
        {view.depth > ACTIVITY_PREVIEW ? (
          <Button
            variant="quiet"
            onClick={() => {
              view.collapse();
              setRefocus(true);
            }}
          >
            {copy.SHOW_FEWER}
          </Button>
        ) : null}
      </div>
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

/** The events, a slice of at most 50 at a time (one cached read of each slice's items, under the store's working set of 100). */
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
  const slices: PersonActivityEvent[][] = [];
  for (let start = 0; start < events.length; start += ACTIVITY_STEP)
    slices.push(events.slice(start, start + ACTIVITY_STEP));
  return (
    <div ref={listRef} className="min-w-0">
      <List className="flex min-w-0 flex-col gap-2">
        {slices.map((slice, index) => (
          <Slice
            // A slice is a position in the list (its first 50, its next 50…), not a page of a read.
            // biome-ignore lint/suspicious/noArrayIndexKey: the slice's position is its identity
            key={index}
            events={slice}
            personId={personId}
            withhold={withhold}
          />
        ))}
      </List>
    </div>
  );
}

function Slice({
  events,
  personId,
  withhold,
}: {
  events: readonly PersonActivityEvent[];
  personId: string;
  withhold: boolean;
}) {
  const ids = [
    ...new Set(
      events
        .filter(
          (event) =>
            event.target.kind === "field" || event.target.id !== personId,
        )
        .map((event) => event.target.id),
    ),
  ];
  const cached = useCachedResources(ids);
  const rows = cached.status === "ready" ? cached.value : null;
  return (
    <>
      {events.map((event) => {
        const row = rows?.[event.target.id]?.merged ?? null;
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
    </>
  );
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
      className="flex min-w-0 list-none flex-col gap-0.5 rounded-control outline-none focus-visible:ring-2"
    >
      <p className="text-[13.5px] leading-[1.5] break-words text-ink-1">
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
      <span className="flex flex-wrap items-center gap-1.5 text-[12px] text-ink-2">
        {tagsOf(event).map((tag) => (
          <span
            key={tag}
            data-activity-tag={tag}
            className="inline-flex rounded-control border border-hairline px-1.5 text-[11.5px]"
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
            className="text-ink-1 underline hover:text-ink-2"
          >
            {label}
          </Link>
        ) : (
          <Link
            to="/people/$personId"
            params={{ personId: target.id }}
            data-activity-link={target.id}
            className="text-ink-1 underline hover:text-ink-2"
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
      className="flex flex-wrap items-center gap-2 text-[13px] text-ink-2"
      data-activity-merged={canonicalId}
    >
      {copy.MERGED}
      {held ? (
        <Link
          to="/people/$personId"
          params={{ personId: canonicalId }}
          className="atlas-transition inline-flex min-h-11 items-center text-[13.5px] text-ink-1 underline hover:text-ink-2"
        >
          {copy.OPEN_MERGED}
        </Link>
      ) : null}
    </p>
  );
}
