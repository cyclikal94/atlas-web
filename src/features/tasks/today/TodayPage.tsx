import { Link } from "@tanstack/react-router";
import {
  CalendarX2,
  ChevronLeft,
  ChevronRight,
  Crosshair,
  Globe,
  Plus,
} from "lucide-react";
import {
  Fragment,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { useLayoutMode } from "../../../app/shell/layout-mode";
import { Button } from "../../../components/ui/button";
import { EmptyState } from "../../../components/ui/empty-state";
import { inputClass } from "../../../components/ui/input";
import { List } from "../../../components/ui/list";
import { NativeSelect } from "../../../components/ui/native-select";
import { PageHeader, TitleText } from "../../../components/ui/page-header";
import { PageHeading } from "../../../components/ui/page-heading";
import { Skeleton } from "../../../components/ui/skeleton";
import { cn } from "../../../lib/utils";
import { useTaskActions } from "../actions";
import { useCatchUpService } from "../catchup/useCatchUp";
import * as copy from "../copy";
import { useTasksEnv } from "../env";
import {
  compareRows,
  dayLabel,
  GROUP_ORDER,
  type Group,
  groupOf,
  longDayLabel,
} from "../format";
import {
  countRows,
  FILTERS,
  type Filter,
  inFilter,
  type RowInputs,
} from "../model/row-state";
import { addDays, timeIn, todayIn } from "../model/time";
import { TODAY_TITLE } from "../titles";
import type { RowModel } from "../view";
import { AddRow } from "./AddRow";
import { CatchUpBanner } from "./CatchUpBanner";
import { SearchPill } from "./CommandPalette";
import { gapLabel, RailFold, RailGap, RailLabel, RailNow } from "./rail";
import { usePullToReveal } from "./reveal";
import { type RowOpen, TodayRow } from "./TodayRow";
import { Upcoming } from "./Upcoming";
import { useTodayView } from "./useTodayView";

/** Every IANA zone this device knows, for the display-zone chip (never silently the browser's: the chip shows it, ARCH 6155). */
export function knownZones(): string[] {
  try {
    return (
      Intl as unknown as { supportedValuesOf(k: string): string[] }
    ).supportedValuesOf("timeZone");
  } catch {
    return ["UTC"];
  }
}

const inputsOf = (row: RowModel, now: number): RowInputs => ({
  data: row.data,
  outcome: row.outcome,
  periodOutcome: row.periodOutcome,
  unavailable: row.unavailable,
  actionable: row.actionable,
  attention: row.attention !== null,
  nowMs: now,
});

/** "Any time" under the date, then the times of day (the Final design). */
const SECTION_ORDER: readonly Group[] = [
  "any",
  ...GROUP_ORDER.filter((g) => g !== "any"),
];
/** Two hours or more between two timed tasks is said on the rail. */
const GAP_SECONDS = 2 * 3600;

/**
 * The section whose heading has scrolled under the sticky bar, so the bar can say where the reader is ("Evening", "Tomorrow").
 * Measured from layout on scroll; a layout engine without geometry (jsdom) never reports one.
 */
interface CurrentSection {
  label: string;
  section: "today" | "upcoming";
  /** The block's count ("6 things"), for the header's summary line while the block is under it. */
  summary: string | null;
}
function useCurrentSection(
  root: HTMLElement | null,
  bar: HTMLElement | null,
): CurrentSection | null {
  const [current, setCurrent] = useState<CurrentSection | null>(null);
  useEffect(() => {
    if (root === null || bar === null) return;
    let frame = 0;
    const measure = () => {
      frame = 0;
      // A layout engine without geometry (jsdom) reports no block: the header stays the day's.
      if (root.getBoundingClientRect().height === 0) return;
      const limit = bar.getBoundingClientRect().bottom + 4;
      let found: CurrentSection | null = null;
      for (const heading of root.querySelectorAll<HTMLElement>(
        "[data-rail-heading]",
      )) {
        if (heading.getBoundingClientRect().top <= limit)
          found = {
            label: heading.dataset.railHeading ?? "",
            section:
              heading.dataset.railSection === "upcoming" ? "upcoming" : "today",
            summary: heading.dataset.railSummary ?? null,
          };
        else break;
      }
      setCurrent((previous) =>
        previous?.label === found?.label &&
        previous?.section === found?.section &&
        previous?.summary === found?.summary
          ? previous
          : found,
      );
    };
    const onScroll = () => {
      if (frame === 0) frame = requestAnimationFrame(measure);
    };
    measure();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      if (frame !== 0) cancelAnimationFrame(frame);
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
    };
  }, [root, bar]);
  return current;
}

/**
 * WF-TODAY-01 on the Final design: the day as one rail, "Any time" under the date, then Morning, Afternoon and Evening, the present
 * marked in red, gaps of two hours or more said on a dotted rail, the day's tasks for the displayed account in the display zone, with
 * the filters, the summary and the states loading / empty / error / offline, and the `pending_tasks` catch-up banner (WEB-10c,
 * `CatchUpBanner`). The rail runs on past the day into "Upcoming" (the fold; open at `/upcoming`). Choosing another day changes only
 * what is read; nothing is ever deleted by a day change.
 */
export function TodayPage({
  day,
  zone,
  dayGiven,
  section = "today",
  onSection,
  onChange,
  open,
  newTask,
}: {
  day: string;
  zone: string;
  /** The day came from the address (otherwise it is today, and rolls over at local midnight). */
  dayGiven: boolean;
  /** `#upcoming` opens the fold and starts there. */
  section?: "today" | "upcoming";
  /** The reader scrolled from the day into the days ahead, or back: the address's hash (and so the navigation) follows. */
  onSection?(section: "today" | "upcoming"): void;
  onChange(next: { day?: string; zone?: string }): void;
  /** Where a row's title leads when the task opens beside the day (the "How tasks open" setting). */
  open?: (row: RowModel) => RowOpen;
  /** Where "New task" leads when the form opens in the same container. */
  newTask?: RowOpen;
}) {
  const env = useTasksEnv();
  // The page's catch-up service, live on every task screen (review R8): the banner uses it only while tasks are pending.
  useCatchUpService();
  const view = useTodayView(day, zone);
  const actions = useTaskActions();
  const [filter, setFilter] = useState<Filter>("all");
  // The fold is closed to begin with (the day reads as one page, the Final design revised 8 November 2026): `#upcoming` opens it, as
  // does a pull past the end of the day, or the fold's pill.
  const [ahead, setAhead] = useState(section === "upcoming");
  const filterName = useId();
  const zoneId = useId();
  const dayId = useId();
  const upcomingId = useId();
  const [root, setRoot] = useState<HTMLElement | null>(null);
  const [bar, setBar] = useState<HTMLElement | null>(null);
  const mode = useLayoutMode();
  // The phone's compact header (the Final design, phase 13): once the big header has scrolled away, a slim bar with the date and
  // the count sticks at the top; from the tablet up the big header itself stays.
  const [compact, setCompact] = useState(false);
  useEffect(() => {
    if (mode !== "mobile" || bar === null) {
      setCompact(false);
      return;
    }
    if (typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(
      ([entry]) => setCompact(entry ? !entry.isIntersecting : false),
      { threshold: 0 },
    );
    io.observe(bar);
    return () => io.disconnect();
  }, [mode, bar]);
  const [zoneOpen, setZoneOpen] = useState(false);
  const zoneRowId = useId();
  const current = useCurrentSection(root, bar);
  const zones = useMemo(knownZones, []);
  const today = todayIn(zone, view.now);
  const isToday = day === today;
  const all = view.rows;
  const counts = countRows(all.map((row) => inputsOf(row, view.now)));
  const shown = all.filter((row) => inFilter(filter, inputsOf(row, view.now)));
  const groups = new Map<Group, RowModel[]>();
  for (const row of shown) {
    const group = groupOf(row, day, zone);
    groups.set(group, [...(groups.get(group) ?? []), row]);
  }
  for (const [group, rows] of groups) groups.set(group, rows.sort(compareRows));

  // The reader's scrolling and the page's own: a scroll the page makes itself (landing on `#upcoming`, revealing the days ahead) is not
  // the reader's, so the navigation does not follow it (`programmaticUntil`); a wheel, a touch or a key is the reader's at once.
  const sectionRef = useRef(section);
  sectionRef.current = section;
  // The page's own glides outlive a render: they read the latest `onSection` here, not through an effect's dependencies.
  const onSectionRef = useRef(onSection);
  onSectionRef.current = onSection;
  const userScrolled = useRef(false);
  // Counts the reader's moves, so a landing or a reveal can tell a move made after it from the one that asked for it.
  const userMoves = useRef(0);
  const programmaticUntil = useRef(0);
  useEffect(() => {
    const byHand = () => {
      userScrolled.current = true;
      userMoves.current += 1;
      programmaticUntil.current = 0;
    };
    const onScroll = () => {
      if (Date.now() < programmaticUntil.current) return;
      userScrolled.current = true;
      userMoves.current += 1;
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("wheel", byHand, { passive: true });
    window.addEventListener("touchmove", byHand, { passive: true });
    window.addEventListener("keydown", byHand);
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("wheel", byHand);
      window.removeEventListener("touchmove", byHand);
      window.removeEventListener("keydown", byHand);
    };
  }, []);
  // The days ahead brought under the sticky bar: their first block ("Tomorrow"), so the bar names it at once (the bar's height kept
  // clear); the fold itself while they are still being read.
  const scrollToFold = useCallback(
    (behavior: ScrollBehavior) => {
      const region = document.getElementById(upcomingId);
      if (region === null) return;
      const target =
        region.querySelector<HTMLElement>('[data-rail-section="upcoming"]') ??
        region;
      const offset = (bar?.getBoundingClientRect().height ?? 0) - 2;
      programmaticUntil.current = Date.now() + 1200;
      try {
        window.scrollTo({
          top: target.getBoundingClientRect().top + window.scrollY - offset,
          behavior,
        });
      } catch {
        // No scrolling here (a layout engine without geometry).
      }
    },
    [upcomingId, bar],
  );
  const scrollToFoldRef = useRef(scrollToFold);
  scrollToFoldRef.current = scrollToFold;
  // `#upcoming` opens the fold (the rail's "Upcoming" while on the day does the same); leaving it lets a later `#upcoming` land again.
  const scrolled = useRef(false);
  useEffect(() => {
    if (section === "upcoming") setAhead(true);
    else scrolled.current = false;
  }, [section]);
  // `#upcoming` from elsewhere (a landing, the rail, the old address) starts at the fold: once the day has rendered, the days ahead are
  // brought to the top and take the focus (the route's own focus leaves a hash to its page), and kept there while the day's rows settle
  // (they can still be arriving), until the reader scrolls. A hash this page set itself (the follow, the reveal) has nothing to land.
  useEffect(() => {
    if (section !== "upcoming" || scrolled.current || view.loading || !ahead)
      return;
    scrolled.current = true;
    scrollToFoldRef.current("auto");
    document.getElementById(upcomingId)?.focus({ preventScroll: true });
    const since = userMoves.current;
    const timers = [120, 360, 800].map((ms) =>
      window.setTimeout(() => {
        if (userMoves.current === since) scrollToFoldRef.current("auto");
      }, ms),
    );
    return () => {
      for (const timer of timers) window.clearTimeout(timer);
    };
  }, [section, view.loading, ahead, upcomingId]);
  // Revealing the days ahead (a pull past the end of the day, or the fold's pill): the fold opens, the page glides to it and the
  // navigation moves to Upcoming; folding it away from there brings the navigation back to Today.
  const revealing = useRef(false);
  const reveal = useCallback(() => {
    revealing.current = true;
    setAhead(true);
  }, []);
  useEffect(() => {
    if (!ahead || !revealing.current) return;
    revealing.current = false;
    scrolled.current = true;
    scrollToFoldRef.current("auto");
    if (sectionRef.current !== "upcoming") onSectionRef.current?.("upcoming");
    // The days ahead may still be being read: once their first block is there, land on it (unless the reader has moved on since).
    const since = userMoves.current;
    const timers = [120, 360, 800].map((ms) =>
      window.setTimeout(() => {
        if (
          userMoves.current === since &&
          document.querySelector("[data-upcoming-loading]") === null
        )
          scrollToFoldRef.current("auto");
      }, ms),
    );
    return () => {
      for (const timer of timers) window.clearTimeout(timer);
    };
  }, [ahead]);
  usePullToReveal(!ahead && !view.loading, reveal);
  const titleText =
    current !== null && current.section === "upcoming"
      ? current.label
      : mode === "mobile"
        ? dayLabel(day)
        : longDayLabel(day);
  // The navigation follows the reader's scroll (Today and Upcoming are one page): the section under the sticky bar names the address's
  // hash; above every heading it is the day's. Only the reader's scrolling: the first measure (a landing, a layout engine without
  // geometry) and the page's own scrolls move nothing.
  // Only a change of the block under the bar moves the hash (never a new `onSection` identity after a navigation: the router hands
  // out a new navigate function with each one, and following it would undo the rail's own "Upcoming" at once).
  useEffect(() => {
    const onSectionNow = onSectionRef.current;
    if (onSectionNow === undefined || !userScrolled.current) return;
    if (Date.now() < programmaticUntil.current) return;
    const next = current?.section ?? "today";
    if (next === sectionRef.current) return;
    // The reader is there already: the hash it sets must not land the page at the fold again.
    if (next === "upcoming") scrolled.current = true;
    onSectionNow(next);
  }, [current]);

  // The rail's extra marks: the present between the rows whose times bracket it, and a gap label before a row two hours or more after
  // the timed row before it (across the times of day: the rail is one line). A mark that falls before a section's first row is drawn
  // before the section's label, so the label sits with its rows.
  const nowSeconds = Math.floor(view.now / 1000);
  const marks = useMemo(() => {
    const out = new Map<
      string,
      { gap: string | null; nowBefore: boolean; nowAfter: boolean }
    >();
    const timed = (row: RowModel) =>
      row.data.slot.instant !== null && groupOf(row, day, zone) !== "any";
    const ordered = SECTION_ORDER.flatMap((g) => groups.get(g) ?? []);
    const timedRows = ordered.filter(timed);
    const lastTimed = timedRows[timedRows.length - 1];
    let previous: number | null = null;
    let nowPlaced = !isToday || timedRows.length === 0;
    for (const row of ordered) {
      if (!timed(row)) continue;
      const instant = row.data.slot.instant as number;
      const gap =
        previous !== null && instant - previous >= GAP_SECONDS
          ? gapLabel(instant - previous)
          : null;
      previous = instant;
      let nowBefore = false;
      if (!nowPlaced && instant > nowSeconds) {
        nowBefore = true;
        nowPlaced = true;
      }
      const nowAfter = !nowPlaced && row === lastTimed;
      if (nowAfter) nowPlaced = true;
      out.set(row.id, { gap, nowBefore, nowAfter });
    }
    return out;
  }, [groups, day, zone, isToday, nowSeconds]);
  const nowMark = (as: "li" | "div") => (
    <RailNow
      as={as}
      time={timeIn(nowSeconds, zone)}
      label={copy.NOW_LABEL(timeIn(nowSeconds, zone))}
    />
  );

  const chip =
    "atlas-transition inline-flex h-9 cursor-pointer items-center rounded-full border px-3 text-xs has-[:checked]:border-primary/40 has-[:checked]:bg-accent has-[:checked]:font-medium has-[:checked]:text-accent-foreground has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-ring hover:bg-accent hover:text-accent-foreground border-border bg-card text-foreground";

  return (
    <div
      ref={setRoot}
      className="atlas-enter flex min-w-0 flex-col"
      data-today-page=""
    >
      {/* The page's one header, and it STAYS (the Final design, revised 8 November 2026): the eyebrow (the page's h1), the large title,
          the summary line and the controls, then the day's controls. Scrolled into the days ahead, the title becomes the block under
          the header ("Tomorrow · Monday 9 November") with its count, and the eyebrow says Upcoming; the day is written once. */}
      <div
        ref={setBar}
        data-today-bar=""
        // On the phone the header scrolls with the page (stuck, it would take half the screen); from the tablet up it stays.
        className="z-20 -mt-4 flex flex-col gap-2.5 border-b border-border/70 bg-background/92 pt-4 pb-2 backdrop-blur tablet:sticky tablet:top-[var(--shell-inset-top,0px)] tablet:-mt-9 tablet:pt-9 tablet:pb-2.5"
      >
        <PageHeader
          eyebrow={
            <PageHeading eyebrow>
              {current?.section === "upcoming"
                ? copy.FOLD_UPCOMING
                : TODAY_TITLE}
            </PageHeading>
          }
          title={
            <TitleText data-today-date="" data-current-section="">
              {/* Keyed on the words: a new block under the header swaps in with a little motion. */}
              <span key={titleText} className="atlas-swap">
                {titleText}
              </span>
            </TitleText>
          }
          summary={
            <span data-today-summary="">
              {current !== null && current.section === "upcoming"
                ? (current.summary ?? "")
                : copy.SUMMARY(
                    counts.done,
                    counts.total,
                    counts.toDo,
                    counts.notKnown,
                  )}
            </span>
          }
          actions={
            // The Final design: the search pill (search, or add a task to the day), Focus, and the way to the full form.
            <>
              <SearchPill
                day={day}
                zone={zone}
                className="min-w-0 flex-1 tablet:w-[320px] tablet:flex-none"
              />
              <Button asChild variant="outline" size="icon">
                <Link
                  to="/focus"
                  search={{ ...(dayGiven ? { day } : {}), tz: zone }}
                  aria-label={copy.FOCUS_MODE}
                  data-today-focus=""
                >
                  <Crosshair aria-hidden="true" strokeWidth={2} />
                </Link>
              </Button>
              <Button asChild variant="outline" size="icon">
                <Link
                  to={newTask?.to ?? "/tasks/new"}
                  params={newTask?.params}
                  search={newTask?.search ?? {}}
                  aria-label={copy.NEW_TASK}
                  data-today-new-task=""
                >
                  <Plus aria-hidden="true" strokeWidth={2.25} />
                </Link>
              </Button>
            </>
          }
          data-today-controls=""
        />
        <div
          className="flex flex-wrap items-center gap-x-3 gap-y-2"
          data-today-day-row=""
        >
          {/* The day's controls, quiet on the bar: the arrows and the date, with the time zone behind a toggle on the phone. */}
          <div className="flex items-center gap-0.5" data-today-day-controls="">
            <Button
              variant="ghost"
              size="icon"
              className="size-9"
              aria-label={copy.PREVIOUS_DAY}
              onClick={() => onChange({ day: addDays(day, -1) })}
            >
              <ChevronLeft aria-hidden="true" />
            </Button>
            <label className="sr-only" htmlFor={dayId}>
              {copy.DAY_LABEL}
            </label>
            <input
              id={dayId}
              type="date"
              value={day}
              data-field-edge=""
              onChange={(event) => {
                if (event.target.value) onChange({ day: event.target.value });
              }}
              className={cn(
                inputClass,
                "h-9 w-auto min-w-0 rounded-full border-border bg-card px-3 font-num text-xs",
              )}
            />
            <Button
              variant="ghost"
              size="icon"
              className="size-9"
              aria-label={copy.NEXT_DAY}
              onClick={() => onChange({ day: addDays(day, 1) })}
            >
              <ChevronRight aria-hidden="true" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="size-9 tablet:hidden"
              aria-label={copy.ZONE_TOGGLE}
              aria-expanded={zoneOpen}
              aria-controls={zoneRowId}
              data-zone-toggle=""
              onClick={() => setZoneOpen((open) => !open)}
            >
              <Globe aria-hidden="true" />
            </Button>
            {dayGiven && !isToday ? (
              <Button
                variant="ghost"
                size="sm"
                className="rounded-full text-xs"
                onClick={() => onChange({ day: today })}
              >
                {copy.BACK_TO_TODAY}
              </Button>
            ) : null}
          </div>
          <fieldset className="flex max-w-full gap-1.5 overflow-x-auto [scrollbar-width:none] tablet:flex-wrap">
            <legend className="sr-only" id={filterName}>
              {copy.FILTERS_NAME}
            </legend>
            {FILTERS.map((f) => (
              <label key={f} className={chip}>
                <input
                  type="radio"
                  name={filterName}
                  value={f}
                  checked={filter === f}
                  onChange={() => setFilter(f)}
                  className="sr-only"
                />
                {copy.FILTER_LABEL[f]}
              </label>
            ))}
          </fieldset>
          <div
            id={zoneRowId}
            className={cn(
              "w-full tablet:block tablet:w-auto",
              zoneOpen ? "block" : "hidden",
            )}
          >
            <label className="sr-only" htmlFor={zoneId}>
              {copy.ZONE_LABEL}
            </label>
            <NativeSelect
              id={zoneId}
              value={zone}
              onChange={(event) => onChange({ zone: event.target.value })}
              className="h-9 w-full rounded-full border-border bg-card text-xs tablet:w-[180px]"
              wrapperClassName="w-full tablet:w-auto"
              aria-description={copy.ZONE_HINT(zone)}
            >
              {(zones.includes(zone) ? zones : [zone, ...zones]).map((z) => (
                <option key={z} value={z}>
                  {z}
                </option>
              ))}
            </NativeSelect>
          </div>
        </div>
      </div>
      {compact ? (
        <div
          className="atlas-bar sticky top-[var(--shell-inset-top,0px)] z-20 -mx-4 flex items-center gap-3 border-b border-border/70 bg-background/92 px-4 py-2 backdrop-blur"
          data-today-compact=""
        >
          <span className="min-w-0 truncate text-[15px] font-semibold text-foreground">
            {titleText}
          </span>
          <span className="min-w-0 truncate text-xs text-muted-foreground">
            {current !== null && current.section === "upcoming"
              ? (current.summary ?? "")
              : copy.SUMMARY(
                  counts.done,
                  counts.total,
                  counts.toDo,
                  counts.notKnown,
                )}
          </span>
        </div>
      ) : null}
      <div className="flex flex-col gap-4 py-4">
        {/* WEB-10c: the tasks Today's current answer lists in `pending_tasks` are brought up to date automatically (D-10c-5). */}
        <CatchUpBanner pendingTasks={view.pendingTasks} />
        {view.error !== null ? (
          <section
            data-today-error={view.error.kind}
            aria-labelledby={`${filterName}-error`}
            className="flex max-w-[620px] flex-col gap-2 rounded-xl border border-destructive/35 bg-card p-4 shadow-sm"
          >
            <h2
              id={`${filterName}-error`}
              className="text-sm font-medium text-foreground"
            >
              {copy.ERROR_TITLE}
            </h2>
            <p className="text-sm text-muted-foreground">
              {view.error.kind === "kept_changing"
                ? copy.KEPT_CHANGING
                : copy.ERROR_BODY}
            </p>
            {view.error.kind === "failed" && view.error.requestId ? (
              <p className="select-all font-num text-xs text-muted-foreground">
                {copy.REQUEST_ID(view.error.requestId)}
              </p>
            ) : null}
            {all.length > 0 ? (
              <p className="text-xs text-muted-foreground">
                {copy.SHOWING_DEVICE}
              </p>
            ) : null}
            <span>
              <Button onClick={view.retry}>{copy.TRY_AGAIN}</Button>
            </span>
          </section>
        ) : null}
        {view.localError !== null ? (
          <section
            data-today-local-error={view.localError}
            aria-labelledby={`${filterName}-local-error`}
            className="flex max-w-[620px] flex-col gap-2 rounded-xl border border-destructive/35 bg-card p-4 shadow-sm"
          >
            <h2
              id={`${filterName}-local-error`}
              className="text-sm font-medium text-foreground"
            >
              {copy.LOCAL_ERROR_TITLE}
            </h2>
            <p className="text-sm text-muted-foreground">
              {view.localError === "unstable"
                ? copy.LOCAL_UNSTABLE
                : copy.LOCAL_FAILED}
            </p>
            {view.stale ? (
              <p className="text-xs text-muted-foreground">
                {copy.SHOWING_LAST_READ}
              </p>
            ) : null}
            <span>
              <Button onClick={view.retry}>{copy.TRY_AGAIN}</Button>
            </span>
          </section>
        ) : null}
      </div>
      {view.loading ? (
        <div
          aria-busy="true"
          data-today-loading=""
          className="flex flex-col gap-2 pl-[94px]"
        >
          <span className="sr-only">{copy.LOADING}</span>
          {[0, 1, 2].map((n) => (
            <Skeleton key={n} className="min-h-12 rounded-lg" />
          ))}
        </div>
      ) : shown.length === 0 && view.unreadable.length === 0 ? (
        // Unknown is not empty: a day whose saved tasks could not be read says so above, never "nothing due" (R9, revision 3).
        view.localError === null && (view.error === null || all.length > 0) ? (
          <EmptyState icon={CalendarX2} data-today-empty="">
            {copy.EMPTY(filter)}
          </EmptyState>
        ) : null
      ) : (
        <div
          className="flex flex-col"
          data-today-refreshing={view.refreshing ? "" : undefined}
          data-today-stale={view.stale ? "" : undefined}
        >
          {SECTION_ORDER.filter((g) => groups.has(g)).map((group) => {
            const rows = groups.get(group) ?? [];
            const first = rows[0] === undefined ? null : marks.get(rows[0].id);
            return (
              <section
                key={group}
                aria-labelledby={`${filterName}-${group}`}
                data-today-group={group}
              >
                {first?.gap ? <RailGap as="div" label={first.gap} /> : null}
                {first?.nowBefore ? nowMark("div") : null}
                <RailLabel
                  heading={
                    <h2
                      id={`${filterName}-${group}`}
                      data-rail-heading={`${longDayLabel(day)} · ${copy.GROUPS[group]}`}
                    >
                      {copy.GROUPS[group]}
                    </h2>
                  }
                />
                <List className="atlas-stagger flex flex-col">
                  {rows.map((row, index) => {
                    const mark = index === 0 ? undefined : marks.get(row.id);
                    return (
                      <Fragment key={row.id}>
                        {mark?.gap ? <RailGap label={mark.gap} /> : null}
                        {mark?.nowBefore ? nowMark("li") : null}
                        <TodayRow
                          row={row}
                          day={day}
                          zone={zone}
                          now={view.now}
                          actions={actions}
                          writable={env.writable}
                          me={env.accountId}
                          {...(open ? { open } : {})}
                        />
                        {marks.get(row.id)?.nowAfter ? nowMark("li") : null}
                      </Fragment>
                    );
                  })}
                </List>
              </section>
            );
          })}
          {view.unreadable.length > 0 ? (
            <p
              className="py-2 pl-[94px] text-xs text-muted-foreground"
              data-today-unreadable={view.unreadable.length}
            >
              {copy.UNREADABLE}
            </p>
          ) : null}
        </div>
      )}
      {/* The row that adds to the day (the Final design): after the day's last row, on the same rail. */}
      {view.loading || view.localError !== null ? null : (
        <AddRow
          day={day}
          dayLabel={isToday ? "today" : dayLabel(day)}
          zone={zone}
          writable={env.writable}
        />
      )}
      <RailFold
        label={copy.FOLD_UPCOMING}
        expanded={ahead}
        controls={upcomingId}
        onToggle={() => {
          if (!ahead) {
            reveal();
            return;
          }
          setAhead(false);
          if (sectionRef.current === "upcoming") onSection?.("today");
        }}
      />
      {ahead ? (
        <div
          data-rail-heading={copy.FOLD_UPCOMING}
          data-rail-section="upcoming"
        >
          <Upcoming
            day={day}
            zone={zone}
            now={view.now}
            id={upcomingId}
            {...(open ? { open } : {})}
          />
        </div>
      ) : (
        <div id={upcomingId} hidden />
      )}
    </div>
  );
}
