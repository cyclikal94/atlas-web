import { CalendarX2, ChevronLeft, ChevronRight } from "lucide-react";
import { Fragment, useEffect, useId, useMemo, useRef, useState } from "react";
import { Button } from "../../../components/ui/button";
import { EmptyState } from "../../../components/ui/empty-state";
import { inputClass } from "../../../components/ui/input";
import { List } from "../../../components/ui/list";
import { NativeSelect } from "../../../components/ui/native-select";
import { Skeleton } from "../../../components/ui/skeleton";
import { cn } from "../../../lib/utils";
import { useTaskActions } from "../actions";
import * as copy from "../copy";
import { useTasksEnv } from "../env";
import {
  compareRows,
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
import type { RowModel } from "../view";
import { gapLabel, RailFold, RailGap, RailLabel, RailNow } from "./rail";
import { TodayRow } from "./TodayRow";
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
function useCurrentSection(
  root: HTMLElement | null,
  bar: HTMLElement | null,
): string | null {
  const [current, setCurrent] = useState<string | null>(null);
  useEffect(() => {
    if (root === null || bar === null) return;
    let frame = 0;
    const measure = () => {
      frame = 0;
      const limit = bar.getBoundingClientRect().bottom + 4;
      let found: string | null = null;
      for (const heading of root.querySelectorAll<HTMLElement>(
        "[data-rail-heading]",
      )) {
        if (heading.getBoundingClientRect().top <= limit)
          found = heading.dataset.railHeading ?? null;
        else break;
      }
      setCurrent(found);
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
 * the filters, the summary and the states loading / empty / error / offline, and the `pending_tasks` notice (D-10a-6). The rail runs on
 * past the day into "Upcoming" (the fold; open at `/upcoming`). Choosing another day changes only what is read; nothing is ever deleted
 * by a day change.
 */
export function TodayPage({
  day,
  zone,
  dayGiven,
  section = "today",
  onChange,
}: {
  day: string;
  zone: string;
  /** The day came from the address (otherwise it is today, and rolls over at local midnight). */
  dayGiven: boolean;
  /** `/upcoming` opens the fold and starts there. */
  section?: "today" | "upcoming";
  onChange(next: { day?: string; zone?: string }): void;
}) {
  const env = useTasksEnv();
  const view = useTodayView(day, zone);
  const actions = useTaskActions();
  const [filter, setFilter] = useState<Filter>("all");
  const [ahead, setAhead] = useState(section === "upcoming");
  const filterName = useId();
  const zoneId = useId();
  const dayId = useId();
  const upcomingId = useId();
  const [root, setRoot] = useState<HTMLElement | null>(null);
  const [bar, setBar] = useState<HTMLElement | null>(null);
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

  // `/upcoming` starts at the fold: once the day has rendered, the days ahead are brought to the top.
  const scrolled = useRef(false);
  useEffect(() => {
    if (section !== "upcoming" || scrolled.current || view.loading) return;
    const target = document.getElementById(upcomingId);
    if (target === null) return;
    scrolled.current = true;
    if (typeof target.scrollIntoView === "function")
      target.scrollIntoView({ block: "start" });
  }, [section, view.loading, upcomingId]);

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
      className="atlas-enter flex max-w-[880px] flex-col"
      data-today-page=""
    >
      {/* The page's heading is the route's (`features/today/route.tsx`), the eyebrow above this date. */}
      <header className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
        <div className="flex min-w-0 flex-col gap-1.5">
          <p
            className="text-3xl font-semibold leading-[1.05] tracking-[-0.03em] text-foreground tablet:text-[40px]"
            data-today-date=""
          >
            {longDayLabel(day)}
          </p>
          <p
            className="text-[15px] text-muted-foreground"
            data-today-summary=""
          >
            {copy.SUMMARY(
              counts.done,
              counts.total,
              counts.toDo,
              counts.notKnown,
            )}
          </p>
        </div>
        <div
          className="flex flex-wrap items-center gap-1"
          data-today-controls=""
        >
          <Button
            variant="ghost"
            size="icon"
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
            className={cn(inputClass, "w-auto font-num")}
          />
          <Button
            variant="ghost"
            size="icon"
            aria-label={copy.NEXT_DAY}
            onClick={() => onChange({ day: addDays(day, 1) })}
          >
            <ChevronRight aria-hidden="true" />
          </Button>
          {dayGiven && !isToday ? (
            <Button variant="ghost" onClick={() => onChange({ day: today })}>
              {copy.BACK_TO_TODAY}
            </Button>
          ) : null}
          <label className="sr-only" htmlFor={zoneId}>
            {copy.ZONE_LABEL}
          </label>
          <NativeSelect
            id={zoneId}
            value={zone}
            onChange={(event) => onChange({ zone: event.target.value })}
            className="w-[180px]"
            wrapperClassName="w-auto"
            aria-description={copy.ZONE_HINT(zone)}
          >
            {(zones.includes(zone) ? zones : [zone, ...zones]).map((z) => (
              <option key={z} value={z}>
                {z}
              </option>
            ))}
          </NativeSelect>
        </div>
      </header>
      <div
        ref={setBar}
        data-today-bar=""
        className="sticky top-[var(--shell-inset-top,0px)] z-20 -mx-4 mt-4 flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-border/70 bg-background/90 px-4 py-2 backdrop-blur tablet:-mx-9 tablet:px-9 desktop:-mx-12 desktop:px-12"
      >
        <p
          className="min-w-0 flex-1 truncate text-sm font-semibold text-foreground"
          data-current-section=""
        >
          {current ?? longDayLabel(day)}
        </p>
        <fieldset className="flex flex-wrap gap-1.5">
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
      </div>
      <div className="flex flex-col gap-4 py-4">
        {view.pendingTasks.length > 0 ? (
          <p
            data-pending-tasks=""
            className="max-w-[620px] rounded-lg border border-warning/35 bg-warning/10 px-3.5 py-2.5 text-sm leading-relaxed text-foreground"
          >
            {copy.PENDING_TASKS}
          </p>
        ) : null}
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
      <RailFold
        label={copy.FOLD_UPCOMING}
        expanded={ahead}
        controls={upcomingId}
        onToggle={() => setAhead((open) => !open)}
      />
      {ahead ? (
        <div data-rail-heading={copy.FOLD_UPCOMING}>
          <Upcoming day={day} zone={zone} now={view.now} id={upcomingId} />
        </div>
      ) : (
        <div id={upcomingId} hidden />
      )}
    </div>
  );
}
