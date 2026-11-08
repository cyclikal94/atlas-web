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
 * What one panel saw of the reviews under one account service. Ids and versions only: no copy of a review is kept.
 * - `byPage`: the ids of the reviews each page actually showed, by the page's cursor. One review can have been shown on several pages
 *   (an earlier review inserted ahead of it moves it on), so it can be in several of these sets at once.
 * - `latest`: the newest version of each review this panel saw published by any of its readings, and whether it was resolved then.
 */
interface Seen {
  byPage: Map<string | null, Set<string>>;
  latest: Map<string, { version: number; resolved: boolean }>;
}

/** The panel's memory as its cards and departed slots use it (revision 24, review 28 F28-1). */
interface Memory {
  /** A card drew its own reading of this unresolved (or unreadable) review, at this version, on the current page. */
  remember(id: string, version: number): void;
  /** A PUBLISHED base said this review is resolved, at this version: it leaves the history of EVERY page that showed it. */
  retire(id: string, version: number): void;
  /** Whether this panel saw the review published resolved at this version or a later one (at any version when `version` is null). */
  settled(id: string, version: number | null): boolean;
  /** Whether a card on the CURRENT page drew this review (revision 25, review 29 F29-1): only then can it be said to be gone. */
  shown(id: string): boolean;
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
 *
 * Revision 23 (review 27 F27-1): a page is a bounded slice of the cache, so a review missing from it has NOT necessarily left the cache;
 * an earlier review inserted ahead of it moves it to the next page. So:
 * - only a card that was actually shown (its own reading drawn on screen) is remembered, never every row the page fetched;
 * - a remembered review missing from its page is asked for by its id (`Departed`); only the cache's answer that it holds no such row
 *   makes it "no longer available"; a review still cached elsewhere shows nothing here (it is on its page), one published resolved is
 *   forgotten, and while the answer is not known nothing is claimed;
 * - what is remembered belongs to this panel and the account service it was shown under; another service starts with nothing.
 *
 * Revision 24 (review 28 F28-1): a review can have been shown on more than one page (shown on page one, then moved onto page two and
 * shown there). A published resolution seen by any of this panel's readings (a page's list, a card's own reading, a departed review's id
 * read) retires the review from EVERY page that showed it, so a later deletion is not "no longer available" on any of them. The panel
 * also keeps the version it saw resolved: an older reading of that review still arriving (a slower list or card reading) neither shows it
 * again nor remembers it, and a card whose reading then finds no row says nothing. A NEWER unresolved version (reopened) is shown and
 * remembered as before. A local acknowledgement waiting to be sent or confirmed is still not a resolution.
 *
 * Revision 25 (review 29 F29-1): the card's own reading can find no row while the list still names the review (the two are published
 * separately). That says "no longer available" only when this page's history holds the review (`shown`), the same rule a departed review
 * follows; a review whose card was only ever loading (inserted and deleted before its first reading arrived) was never shown, so it goes.
 */
export function ReviewPanel() {
  const env = useOptionalDataEnv();
  const [cursors, setCursors] = useState<Array<string | null>>([null]);
  const after = cursors[cursors.length - 1] ?? null;
  const page = useResourceList({ kind: "review", after, limit: PAGE });
  const [shownCount, setShownCount] = useState(STEP);
  const [, changed] = useState(0);
  const rows: ListedResource[] = page.status === "ready" ? page.value.rows : [];
  // What this panel saw, per account service (a new service, account or database incarnation remembers nothing of the old one's).
  const [byService] = useState(() => new WeakMap<object, Seen>());
  const service = env?.service() ?? null;
  let seen: Seen | null = null;
  if (service !== null) {
    seen = byService.get(service) ?? null;
    if (seen === null) {
      seen = { byPage: new Map(), latest: new Map() };
      byService.set(service, seen);
    }
  }
  let shownHere = seen?.byPage.get(after) ?? null;
  if (seen !== null && shownHere === null) {
    shownHere = new Set();
    seen.byPage.set(after, shownHere);
  }
  const memory = useMemo<Memory>(
    () => ({
      // Called only for a drawn card, which an older reading than a resolution this panel saw never is (`superseded`).
      remember(id, version) {
        if (seen === null || shownHere === null) return;
        const known = seen.latest.get(id);
        if (known === undefined || version > known.version)
          seen.latest.set(id, { version, resolved: false });
        shownHere.add(id);
      },
      retire(id, version) {
        if (seen === null) return;
        const known = seen.latest.get(id);
        // Older than a reading this panel already saw (one reopened since, say): it settles nothing.
        if (known !== undefined && version < known.version) return;
        let retired = false;
        if (known?.resolved !== true || version > known.version) {
          seen.latest.set(id, { version, resolved: true });
          retired = true;
        }
        // Every page that showed it, each one asked (no stopping at the first that held it).
        for (const members of seen.byPage.values())
          if (members.delete(id)) retired = true;
        if (retired) changed((n) => n + 1);
      },
      settled(id, version) {
        const known = seen?.latest.get(id);
        return (
          known?.resolved === true &&
          (version === null || version <= known.version)
        );
      },
      shown: (id) => shownHere?.has(id) === true,
    }),
    [seen, shownHere],
  );
  const unresolved = useMemo(
    () =>
      rows.filter((row) => {
        const value = parseReview(row.base.value);
        // An unreadable review is shown as such; a resolved one (as the server published it) is not shown at all.
        return value === null || !value.resolved;
      }),
    [rows],
  );
  const present = new Set(rows.map((row) => row.base.id));
  // Shown here earlier, not on this page now: asked for by id before anything is said about them.
  const departed =
    page.status === "ready" && shownHere !== null
      ? [...shownHere].filter((id) => !present.has(id))
      : [];
  useEffect(() => {
    if (page.status !== "ready") return;
    // A review still in the cache but resolved now was settled (by this device or another): it is not "gone", on any page.
    for (const row of rows)
      if (parseReview(row.base.value)?.resolved === true)
        memory.retire(row.base.id, row.base.version);
  }, [rows, page.status, memory]);
  const shown = unresolved.slice(0, shownCount);
  const next = page.status === "ready" ? page.value.next : null;
  // A later page is kept on screen even with nothing to show on it, so the way back is never lost.
  if (
    shown.length === 0 &&
    departed.length === 0 &&
    next === null &&
    cursors.length === 1
  )
    return null;
  return (
    <section aria-labelledby="reviews-heading" className="flex flex-col gap-2">
      <h2 id="reviews-heading" className="text-sm font-medium text-foreground">
        {REVIEWS_HEADING}
      </h2>
      <List className="flex flex-col gap-2">
        {shown.map((row) => (
          <ReviewCard key={row.base.id} row={row} memory={memory} />
        ))}
        {departed.map((id) => (
          <Departed key={`gone:${id}`} id={id} memory={memory} />
        ))}
      </List>
      {unresolved.length > shownCount || next !== null || cursors.length > 1 ? (
        <div className="flex flex-wrap gap-2">
          {cursors.length > 1 ? (
            <Button
              variant="ghost"
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
              variant="ghost"
              onClick={() => setShownCount((n) => n + STEP)}
            >
              {SHOW_MORE_REVIEWS}
            </Button>
          ) : next !== null ? (
            <Button
              variant="ghost"
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

const FRAME = "list-none rounded-lg border border-border bg-card p-3.5";

/** "No longer available": nothing of the review is said, and nothing can be pressed or followed. */
function GoneItem({ id }: { id: string }) {
  return (
    <li data-review={id} data-review-state="gone" className={FRAME}>
      <p className="text-sm text-foreground">{NO_LONGER_AVAILABLE}</p>
      <div className="mt-2 flex flex-wrap gap-2">
        <Button disabled reason={NO_LONGER_AVAILABLE}>
          {ACKNOWLEDGE}
        </Button>
      </div>
    </li>
  );
}

/**
 * A review this page showed that the page no longer lists (revision 23, review 27 F27-1). Leaving a bounded page is not leaving the
 * cache, so the review is asked for by its id: the cache's answer that it holds no such row (deleted, or access lost) makes it "no longer
 * available"; a review it still holds is on another page and shows nothing here; one published resolved is retired from every page that
 * showed it (revision 24). Until that answer (loading, no open database, a closed service, an id the answer does not cover) nothing is
 * claimed either way. The answer is only membership: nothing is shown from it and nothing is saved from it (a card's acknowledgement
 * comes from the card's own reading).
 */
function Departed({ id, memory }: { id: string; memory: Memory }) {
  const read = useCachedResources([id]);
  const known =
    read.status === "ready" && Object.hasOwn(read.value, id)
      ? read.value[id]
      : undefined;
  // Published resolved: the base the server sent, not a local acknowledgement waiting to be sent or confirmed.
  const resolvedAt =
    known !== undefined &&
    known !== null &&
    parseReview(known.base.value)?.resolved === true
      ? known.base.version
      : null;
  const { retire } = memory;
  useEffect(() => {
    if (resolvedAt !== null) retire(id, resolvedAt);
  }, [resolvedAt, id, retire]);
  return known === null ? <GoneItem id={id} /> : null;
}

/**
 * One review's card. The list row only says WHICH review it is; everything the card shows about the review (its reason, slot, privacy,
 * parent, resolved state and whether it may be acknowledged) and everything Acknowledge saves (base, observation, the conflict it
 * replaces) come from the card's own ONE read of it (`useResourceView`). The list and that read are published separately, so a card
 * drawn from the list could show an older review than the one its acknowledgement resolves (WEB-13b review 13, R8).
 */
function ReviewCard({ row, memory }: { row: ListedResource; memory: Memory }) {
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

  // This panel already saw the review published resolved, at this reading's version or later (by this card, the list or another page):
  // an older reading still arriving shows nothing, and a reading that finds no row is not "no longer available" (revision 24).
  const superseded =
    view.status === "ready" &&
    memory.settled(id, shownRow === null ? null : shownRow.version);
  // Shown: the card drew its own reading of an unresolved (or unreadable) review. Only that is remembered (review 27 F27-1), so a
  // review the page fetched but never showed, or showed only as loading, is never later said to be gone.
  const drawnAt =
    view.status === "ready" &&
    shownRow !== null &&
    view.value.merged !== null &&
    base?.resolved !== true &&
    !superseded
      ? shownRow.version
      : null;
  // Published resolved, as the card's own reading of the BASE says (never the overlay of a local acknowledgement).
  const settledAt =
    view.status === "ready" && shownRow !== null && base?.resolved === true
      ? shownRow.version
      : null;
  const { remember, retire } = memory;
  useEffect(() => {
    if (drawnAt !== null) remember(id, drawnAt);
  }, [drawnAt, id, remember]);
  useEffect(() => {
    if (settledAt !== null) retire(id, settledAt);
  }, [settledAt, id, retire]);

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

  const frame = FRAME;
  // Not read yet (or no open database): the list's copy of the review is not shown in its place, and nothing can be pressed.
  if (view.status !== "ready")
    return (
      <li
        data-review={id}
        data-review-state="loading"
        aria-busy={view.status === "loading"}
        className={frame}
      >
        <p className="text-sm text-muted-foreground">
          {view.status === "loading" ? REVIEW_LOADING : UNREADABLE}
        </p>
      </li>
    );
  // Seen published resolved by this panel: it goes, even once it has also left the cache or while an older reading of it arrives.
  if (superseded) return null;
  // The review left the cache (deleted, or access lost) before the list said so: the panel's "gone" treatment, never the older copy, but
  // only for a review this page actually showed. One whose card was only ever loading was never shown, so it simply goes (review 29 F29-1).
  if (shownRow === null || view.value.merged === null)
    return memory.shown(id) ? <GoneItem id={id} /> : null;
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
        <span className="break-words text-sm text-foreground">{title}</span>
        {body !== null ? (
          <span className="text-xs leading-[1.6] text-muted-foreground">
            {body}
          </span>
        ) : null}
        {queued ? (
          <span data-status-line="" className="text-xs text-muted-foreground">
            {ACKNOWLEDGE_QUEUED}
          </span>
        ) : acknowledged || confirming ? (
          <span data-status-line="" className="text-xs text-muted-foreground">
            {ACKNOWLEDGED}
          </span>
        ) : null}
        {conflicted ? (
          <span data-status-line="" className="text-xs text-foreground">
            {REVIEW_CONFLICT}
          </span>
        ) : null}
        {rejected !== null ? (
          <span data-status-line="" className="text-xs text-foreground">
            {ACKNOWLEDGE_REJECTED}
          </span>
        ) : null}
        {message !== null ? (
          <span data-review-message="" className="text-xs text-foreground">
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
                className="atlas-transition inline-flex min-h-11 items-center rounded-md border border-border bg-card px-4 text-sm text-foreground hover:bg-accent"
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
                className="atlas-transition inline-flex min-h-11 items-center rounded-md border border-border bg-card px-4 text-sm text-foreground hover:bg-accent"
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
              variant="ghost"
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
