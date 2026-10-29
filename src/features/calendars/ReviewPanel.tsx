import { Link } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { useAnnouncer } from "../../components/ui/announcer";
import { Button } from "../../components/ui/button";
import { List } from "../../components/ui/list";
import {
  type CacheRow,
  type ListedResource,
  useCachedResources,
  useDataActions,
  useOptionalDataEnv,
  useResourceList,
  useResourceView,
} from "../../data";
import { refusalMessage } from "./AddSourceDialog";
import {
  A_TASK,
  ACKNOWLEDGE,
  ACKNOWLEDGE_AGAIN,
  ACKNOWLEDGE_KEEP,
  ACKNOWLEDGE_QUEUED,
  ACKNOWLEDGE_REJECTED,
  ACKNOWLEDGED,
  CANCELLED_BODY,
  CANT_ACKNOWLEDGE,
  cancelledTitle,
  DISMISS_REVIEW,
  followedTitle,
  INELIGIBLE_BODY,
  ITS_CALENDAR,
  ineligibleTitle,
  MISSING_BODY,
  missingTitle,
  movedTitle,
  NO_LONGER_AVAILABLE,
  NOT_SAVED_REVIEW,
  OPEN_TASK,
  PRIVATE_GENERIC,
  PRIVATE_TITLE,
  previously,
  proposed,
  REVIEW_CHANGED,
  REVIEW_CONFLICT,
  REVIEW_LOADING,
  REVIEW_MOVE,
  REVIEWS_HEADING,
  SHOW_MORE_REVIEWS,
  SHOW_PREVIOUS_REVIEWS,
  TASK_NOT_HERE,
  UNREADABLE,
  workStartedBody,
} from "./copy-review";
import {
  anchorKeyReference,
  parseReview,
  proposedMove,
  type ReviewValue,
  resolveReviewRequest,
} from "./model/review";

const RESOLVE_REVIEW = "resolve_review";
const VIEW_KINDS = { settings: RESOLVE_REVIEW };
/** How many unresolved reviews a step of "Show more reviews" adds. */
const STEP = 20;
/** How many cached reviews one page reads. */
const PAGE = 100;

/** A slot as the card says it: "Wed 9 Sep 2026 at 18:00", the time only when the slot has one. */
function slotWords(slot: ReviewValue["slot"]): string {
  if (slot?.date == null) return "";
  const day = new Intl.DateTimeFormat("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${slot.date}T00:00:00Z`));
  return slot.intended_time === null
    ? day
    : `${day} at ${slot.intended_time.slice(0, 5)}`;
}

/** The value a card's occurrence carries that it needs: the task's id and the slot key (the anchor's reference). */
function occurrenceFacts(
  row: CacheRow | null | undefined,
): { taskId: string; slotKey: string } | null {
  const v = (row?.value ?? null) as Record<string, unknown> | null;
  const slot = v?.slot as Record<string, unknown> | undefined;
  return typeof v?.task_id === "string" && typeof slot?.key === "string"
    ? { taskId: v.task_id, slotKey: slot.key }
    : null;
}

/**
 * "Anchor review needed" (WEB-13b §4.5; the wireframe's review panel): this account's UNRESOLVED anchor reviews from the cache (they are
 * private to the binding's author, so the cache holds only the ones this account may see), a page (100) at a time, the first 20 of it
 * shown and "Show more reviews" for the rest, then the next page; "Show previous reviews" goes back a page (R4), showing all of its
 * unresolved reviews, so every one stays reachable in both directions. Each card offers Acknowledge (queued `resolve_review`, offline included) and, for a review
 * whose occurrence was NOT moved because work had started, "Review this move…", which opens the task's one-day correction with the
 * proposed date and time filled in (it never resolves the review).
 *
 * A review the person was shown that then leaves the cache (deleted, or access lost) stays as "This review is no longer available to you."
 * with both actions disabled until the screen is left; one published resolved simply goes.
 */
export function ReviewPanel() {
  const [cursors, setCursors] = useState<Array<string | null>>([null]);
  const after = cursors[cursors.length - 1] ?? null;
  const page = useResourceList({ kind: "review", after, limit: PAGE });
  const [shownCount, setShownCount] = useState(STEP);
  const rows: ListedResource[] = page.status === "ready" ? page.value.rows : [];
  const unresolved = useMemo(
    () =>
      rows.filter((row) => {
        const value = parseReview(row.base.value);
        // An unreadable review is shown as such; a resolved one (as the server published it) is not shown at all.
        return value === null || !value.resolved;
      }),
    [rows],
  );
  // The reviews this mount showed on this page, so one that leaves the cache is said to be gone, not silently dropped.
  const seenByPage = useRef(
    new Map<string | null, Map<string, ListedResource>>(),
  );
  let seen = seenByPage.current.get(after);
  if (seen === undefined) {
    seen = new Map();
    seenByPage.current.set(after, seen);
  }
  const present = new Set(rows.map((row) => row.base.id));
  const gone =
    page.status === "ready"
      ? [...seen.values()].filter((row) => !present.has(row.base.id))
      : [];
  useEffect(() => {
    const own = seenByPage.current.get(after);
    if (own === undefined || page.status !== "ready") return;
    for (const row of unresolved) own.set(row.base.id, row);
    // A review still in the cache but resolved now was settled (by this device or another): it is not "gone".
    for (const row of rows)
      if (!unresolved.includes(row)) own.delete(row.base.id);
  }, [rows, unresolved, after, page.status]);
  const shown = unresolved.slice(0, shownCount);
  const next = page.status === "ready" ? page.value.next : null;
  // A later page is kept on screen even with nothing to show on it, so the way back is never lost.
  if (
    shown.length === 0 &&
    gone.length === 0 &&
    next === null &&
    cursors.length === 1
  )
    return null;
  return (
    <section aria-labelledby="reviews-heading" className="flex flex-col gap-2">
      <h2 id="reviews-heading" className="text-[13.5px] font-medium text-ink-1">
        {REVIEWS_HEADING}
      </h2>
      <List className="flex flex-col gap-2">
        {shown.map((row) => (
          <ReviewCard key={row.base.id} row={row} />
        ))}
        {gone.map((row) => (
          <li
            key={`gone:${row.base.id}`}
            data-review={row.base.id}
            data-review-state="gone"
            className="list-none rounded-row border border-hairline-strong bg-panel p-3.5"
          >
            <p className="text-[13.5px] text-ink-1">{NO_LONGER_AVAILABLE}</p>
            <div className="mt-2 flex flex-wrap gap-2">
              <Button disabled reason={NO_LONGER_AVAILABLE}>
                {ACKNOWLEDGE}
              </Button>
            </div>
          </li>
        ))}
      </List>
      {unresolved.length > shownCount || next !== null || cursors.length > 1 ? (
        <div className="flex flex-wrap gap-2">
          {cursors.length > 1 ? (
            <Button
              variant="quiet"
              onClick={() => {
                setCursors((list) => list.slice(0, -1));
                // The page left was shown in full before its next page was asked for.
                setShownCount(PAGE);
              }}
            >
              {SHOW_PREVIOUS_REVIEWS}
            </Button>
          ) : null}
          {unresolved.length > shownCount ? (
            <Button
              variant="quiet"
              onClick={() => setShownCount((n) => n + STEP)}
            >
              {SHOW_MORE_REVIEWS}
            </Button>
          ) : next !== null ? (
            <Button
              variant="quiet"
              onClick={() => {
                setCursors((list) => [...list, next]);
                setShownCount(STEP);
              }}
            >
              {SHOW_MORE_REVIEWS}
            </Button>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

/**
 * One review's card. The list row only says WHICH review it is; everything the card shows about the review (its reason, slot, privacy,
 * parent, resolved state and whether it may be acknowledged) and everything Acknowledge saves (base, observation, the conflict it
 * replaces) come from the card's own ONE read of it (`useResourceView`). The list and that read are published separately, so a card
 * drawn from the list could show an older review than the one its acknowledgement resolves (WEB-13b review 13, R8).
 */
function ReviewCard({ row }: { row: ListedResource }) {
  const env = useOptionalDataEnv();
  const actions = useDataActions();
  const announcer = useAnnouncer();
  const id = row.base.id;
  // The card's own read of the review: what it shows, what Acknowledge is built from and checked against (its observation), its waiting
  // changes.
  const view = useResourceView(id, VIEW_KINDS);
  const shownRow = view.status === "ready" ? view.value.base : null;
  const value =
    view.status === "ready" && view.value.merged !== null
      ? parseReview(view.value.merged.value)
      : null;
  const base = shownRow === null ? null : parseReview(shownRow.value);
  const generic = base?.reason === "context_unavailable";
  // The occurrence (the review's parent), then its task and the reference its slot key names; nothing for a generic review.
  const occurrenceId = shownRow?.parent_id ?? null;
  const occurrences = useCachedResources(
    occurrenceId === null || generic ? [] : [occurrenceId],
  );
  const occurrence =
    occurrenceId !== null && occurrences.status === "ready"
      ? (occurrences.value[occurrenceId]?.merged ?? null)
      : null;
  const facts = occurrenceFacts(occurrence);
  const reference = facts === null ? null : anchorKeyReference(facts.slotKey);
  const related = useCachedResources(
    facts === null || generic
      ? []
      : [facts.taskId, ...(reference === null ? [] : [reference])],
  );
  const task =
    facts !== null && related.status === "ready"
      ? (related.value[facts.taskId]?.merged ?? null)
      : null;
  const event =
    reference !== null && related.status === "ready"
      ? (related.value[reference]?.merged ?? null)
      : null;
  const sources = useCachedResources(
    event?.kind === "event" && event.parent_id !== null
      ? [event.parent_id]
      : [],
  );
  const source =
    event?.kind === "event" &&
    event.parent_id !== null &&
    sources.status === "ready"
      ? (sources.value[event.parent_id]?.merged.label ?? null)
      : null;
  const [message, setMessage] = useState<string | null>(null);
  const keys = useRef(new Map<string, string>());
  const acting = useRef(false);

  const outstanding = view.status === "ready" ? view.value.outstanding : null;
  const n = (status: string) =>
    (outstanding?.byStatus as Record<string, number> | undefined)?.[status] ??
    0;
  const queued = n("queued") + n("in_flight") > 0;
  const confirming = n("acknowledged") > 0;
  const conflicted = n("version_conflict") > 0;
  const rejected =
    n("rejected") > 0 && outstanding?.latest?.status === "rejected"
      ? outstanding.latest
      : null;
  const conflictId =
    conflicted && outstanding?.latest?.status === "version_conflict"
      ? outstanding.latest.local_id
      : null;

  const acknowledge = async (supersede: string | null) => {
    if (acting.current) return;
    const outbox = env?.outbox() ?? null;
    if (view.status !== "ready" || outbox === null) return;
    if (view.value.base === null) {
      setMessage(NO_LONGER_AVAILABLE);
      return;
    }
    acting.current = true;
    setMessage(null);
    // The same press repeated after a local refusal keeps its identity (a save whose completion was lost is not made twice).
    const what = `${view.value.base.version}:${supersede ?? ""}`;
    let key = keys.current.get(what);
    if (key === undefined) {
      key = crypto.randomUUID();
      keys.current.set(what, key);
    }
    const request = resolveReviewRequest(
      view.value.base,
      key,
      view.value.observation,
    );
    try {
      const outcome =
        supersede === null
          ? await outbox.enqueue(request)
          : await outbox.supersede(supersede, request);
      if (outcome.kind === "queued" || outcome.kind === "superseded") {
        // A stored acknowledgement's identity is spent (R2's rule): pressing again later is a new operation.
        keys.current.delete(what);
        announcer.announce(ACKNOWLEDGE_QUEUED);
      } else if (outcome.reason === "changed") setMessage(REVIEW_CHANGED);
      else if (outcome.reason === "denied") setMessage(CANT_ACKNOWLEDGE);
      else setMessage(refusalMessage(outcome.reason));
    } catch {
      setMessage(NOT_SAVED_REVIEW);
    } finally {
      acting.current = false;
    }
  };

  const frame =
    "list-none rounded-row border border-hairline-strong bg-panel p-3.5";
  // Not read yet (or no open database): the list's copy of the review is not shown in its place, and nothing can be pressed.
  if (view.status !== "ready")
    return (
      <li
        data-review={id}
        data-review-state="loading"
        aria-busy={view.status === "loading"}
        className={frame}
      >
        <p className="text-[13.5px] text-ink-2">
          {view.status === "loading" ? REVIEW_LOADING : UNREADABLE}
        </p>
      </li>
    );
  // The review left the cache (deleted, or access lost) before the list said so: the panel's "gone" treatment, never the older copy.
  if (shownRow === null || view.value.merged === null)
    return (
      <li data-review={id} data-review-state="gone" className={frame}>
        <p className="text-[13.5px] text-ink-1">{NO_LONGER_AVAILABLE}</p>
        <div className="mt-2 flex flex-wrap gap-2">
          <Button disabled reason={NO_LONGER_AVAILABLE}>
            {ACKNOWLEDGE}
          </Button>
        </div>
      </li>
    );
  // Published resolved (by this device or another) before the list said so: the card goes, as it does once the list shows it.
  if (base?.resolved === true) return null;
  const taskName = task?.label ?? A_TASK;
  let title: string;
  let body: string | null = null;
  if (value === null || base === null) title = UNREADABLE;
  else
    switch (base.reason) {
      case "work_started":
        title = movedTitle(taskName);
        body = `${workStartedBody(source ?? ITS_CALENDAR)} ${proposed(slotWords(base.slot))}`;
        break;
      case "moved":
        title = followedTitle(taskName);
        body = previously(slotWords(base.slot));
        break;
      case "cancelled":
        title = cancelledTitle(taskName);
        body = CANCELLED_BODY;
        break;
      case "missing":
        title = missingTitle(taskName);
        body = MISSING_BODY;
        break;
      case "no_longer_eligible":
        title = ineligibleTitle(taskName);
        body = INELIGIBLE_BODY;
        break;
      default:
        // Private and generic: no date, no title, no task name (docs/calendars.md: it does not reveal the new date or title).
        title = PRIVATE_TITLE;
        body = PRIVATE_GENERIC;
    }
  const move = base === null ? null : proposedMove(base);
  const canAct = view.value.merged.can_edit;
  const acknowledged = value?.resolved === true;
  const state = acknowledged
    ? "acknowledged"
    : queued
      ? "queued"
      : conflicted
        ? "conflict"
        : rejected !== null
          ? "rejected"
          : "open";
  return (
    <li
      data-review={id}
      data-review-reason={base?.reason ?? "unreadable"}
      data-review-state={state}
      className={frame}
    >
      <div className="flex flex-col gap-0.5">
        <span className="break-words text-[14px] text-ink-1">{title}</span>
        {body !== null ? (
          <span className="text-[12.5px] leading-[1.6] text-ink-2">{body}</span>
        ) : null}
        {queued ? (
          <span data-status-line="" className="text-[12.5px] text-ink-2">
            {ACKNOWLEDGE_QUEUED}
          </span>
        ) : acknowledged || confirming ? (
          <span data-status-line="" className="text-[12.5px] text-ink-2">
            {ACKNOWLEDGED}
          </span>
        ) : null}
        {conflicted ? (
          <span data-status-line="" className="text-[12.5px] text-ink-1">
            {REVIEW_CONFLICT}
          </span>
        ) : null}
        {rejected !== null ? (
          <span data-status-line="" className="text-[12.5px] text-ink-1">
            {ACKNOWLEDGE_REJECTED}
          </span>
        ) : null}
        {message !== null ? (
          <span data-review-message="" className="text-[12.5px] text-ink-1">
            {message}
          </span>
        ) : null}
      </div>
      {base === null ? null : (
        <div className="mt-2 flex flex-wrap items-start gap-2">
          {move !== null ? (
            task !== null &&
            occurrence !== null &&
            facts !== null &&
            occurrenceId !== null ? (
              // A navigation, so a link (WEB-13b: `useNavigate` in this chunk splits router modules out of the first load).
              <Link
                to="/tasks/$taskId"
                params={{ taskId: facts.taskId }}
                search={{ occurrence: occurrenceId, move } as never}
                className="atlas-transition inline-flex min-h-11 items-center rounded-control border border-hairline-strong bg-raised px-4 text-[13.5px] text-ink-1 hover:bg-row-hover"
              >
                {REVIEW_MOVE}
              </Link>
            ) : (
              <Button disabled reason={TASK_NOT_HERE}>
                {REVIEW_MOVE}
              </Button>
            )
          ) : null}
          {base.reason !== "work_started" && !generic ? (
            task !== null && occurrenceId !== null ? (
              <Link
                to="/tasks/$taskId"
                params={{ taskId: task.id }}
                search={{ occurrence: occurrenceId }}
                className="atlas-transition inline-flex min-h-11 items-center rounded-control border border-hairline-strong bg-raised px-4 text-[13.5px] text-ink-1 hover:bg-row-hover"
              >
                {OPEN_TASK}
              </Link>
            ) : (
              <Button disabled reason={TASK_NOT_HERE}>
                {OPEN_TASK}
              </Button>
            )
          ) : null}
          {conflictId !== null && canAct ? (
            <Button onClick={() => void acknowledge(conflictId)}>
              {ACKNOWLEDGE_AGAIN}
            </Button>
          ) : rejected !== null ? (
            <Button
              variant="quiet"
              onClick={() =>
                void actions.discard(rejected.local_id).then(
                  () => undefined,
                  () => undefined,
                )
              }
            >
              {DISMISS_REVIEW}
            </Button>
          ) : !canAct ? (
            <Button disabled reason={CANT_ACKNOWLEDGE}>
              {base.reason === "work_started" ? ACKNOWLEDGE_KEEP : ACKNOWLEDGE}
            </Button>
          ) : acknowledged || queued || confirming ? null : (
            <Button onClick={() => void acknowledge(null)}>
              {base.reason === "work_started" ? ACKNOWLEDGE_KEEP : ACKNOWLEDGE}
            </Button>
          )}
        </div>
      )}
    </li>
  );
}
