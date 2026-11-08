import { useId, useState } from "react";
import { Button } from "../../../components/ui/button";
import { List } from "../../../components/ui/list";
import { Skeleton } from "../../../components/ui/skeleton";
import { useTaskActions } from "../actions";
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
import { aheadHorizon } from "../model/ahead";
import { addDays, todayIn } from "../model/time";
import type { RowModel } from "../view";
import { Ahead } from "./Ahead";
import { RailFoldLine, RailHeading, RailLabel } from "./rail";
import { type RowOpen, TodayRow } from "./TodayRow";
import { useUpcomingView } from "./useUpcomingView";

/** The Monday-based weekday of a date (0 Monday … 6 Sunday). */
function weekdayIndex(day: string): number {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  return (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7;
}
const monthFormat = new Intl.DateTimeFormat("en-GB", {
  month: "long",
  timeZone: "UTC",
});
const monthYearFormat = new Intl.DateTimeFormat("en-GB", {
  month: "long",
  year: "numeric",
  timeZone: "UTC",
});
const shortDay = new Intl.DateTimeFormat("en-GB", {
  weekday: "short",
  day: "numeric",
  timeZone: "UTC",
});
const utc = (day: string) => new Date(`${day}T00:00:00Z`);
/** "November", or "January 2027" once the year is not the day's. */
const monthLabel = (month: string, yearOf: string) =>
  (month.slice(0, 4) === yearOf.slice(0, 4)
    ? monthFormat
    : monthYearFormat
  ).format(utc(`${month}-01`));
const monthEnd = (month: string) => {
  const [y, m] = month.split("-").map(Number) as [number, number];
  const next =
    m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, "0")}-01`;
  return addDays(next, -1);
};
/** "3–9 Nov", or "27 Oct – 2 Nov" across a month boundary. */
function weekLabel(start: string, end: string): string {
  const a = dayLabel(start).split(" ").slice(1).join(" ");
  const b = dayLabel(end).split(" ").slice(1).join(" ");
  const [ad, am] = a.split(" ");
  const [, bm] = b.split(" ");
  return am === bm ? `${ad}–${b}` : `${a} – ${b}`;
}
const routine = (row: RowModel) => row.data.definition.schedule.repeat !== null;
/** Across days: by date, then as a day orders its rows. */
const compareAhead = (a: RowModel, b: RowModel) => {
  const da = a.data.slot.date ?? "";
  const db = b.data.slot.date ?? "";
  return da === db ? compareRows(a, b) : da < db ? -1 : 1;
};

interface DayBlock {
  key: string;
  label: string;
  sub?: string;
  /** The time column, when the block spans more than one day. */
  byDay: boolean;
  rows: RowModel[];
}
interface MonthBlock {
  key: string;
  label: string;
  count: number;
  weeks: DayBlock[];
}

/**
 * The rows after `day`, in the Final design's groups (revised 8 November 2026): tomorrow, the rest of this week a day at a time, next
 * week a day at a time, then each month a week at a time ("November · 23–29 Nov"). The sticky bar names the block and the day or
 * week under it (`copy.UPCOMING.bar`).
 */
export function groupAhead(
  rows: readonly RowModel[],
  day: string,
): {
  tomorrow: RowModel[];
  week: DayBlock[];
  nextWeek: DayBlock[];
  months: MonthBlock[];
} {
  const tomorrow = addDays(day, 1);
  const sunday = addDays(day, 6 - weekdayIndex(day));
  const nextWeekEnd = addDays(sunday, 7);
  const byDay = new Map<string, RowModel[]>();
  for (const row of rows) {
    const date = row.data.slot.date as string;
    byDay.set(date, [...(byDay.get(date) ?? []), row]);
  }
  const days = (from: string, until: string): DayBlock[] => {
    const out: DayBlock[] = [];
    for (let d = from; d <= until; d = addDays(d, 1)) {
      const dayRows = byDay.get(d);
      if (!dayRows) continue;
      out.push({
        key: d,
        label: longDayLabel(d),
        byDay: false,
        rows: dayRows.sort(compareRows),
      });
    }
    return out;
  };
  // Tomorrow has its own block: the rest of the week starts the day after it (and when the day is a Sunday, so does next week).
  const afterTomorrow = addDays(tomorrow, 1);
  const week = days(afterTomorrow, sunday);
  const nextWeek = days(
    afterTomorrow > addDays(sunday, 1) ? afterTomorrow : addDays(sunday, 1),
    nextWeekEnd,
  );
  const byMonth = new Map<string, Map<string, RowModel[]>>();
  for (const [date, dayRows] of byDay)
    if (date > nextWeekEnd) {
      const month = date.slice(0, 7);
      const weekStart = addDays(date, -weekdayIndex(date));
      const weeks = byMonth.get(month) ?? new Map<string, RowModel[]>();
      weeks.set(weekStart, [...(weeks.get(weekStart) ?? []), ...dayRows]);
      byMonth.set(month, weeks);
    }
  const months: MonthBlock[] = [];
  for (const month of [...byMonth.keys()].sort()) {
    const weeks = byMonth.get(month) ?? new Map<string, RowModel[]>();
    const first = `${month}-01`;
    const last = monthEnd(month);
    const blocks: DayBlock[] = [];
    for (const start of [...weeks.keys()].sort()) {
      const end = addDays(start, 6);
      blocks.push({
        key: `${month}-${start}`,
        label: weekLabel(
          start < first ? first : start,
          end > last ? last : end,
        ),
        byDay: true,
        rows: (weeks.get(start) ?? []).sort(compareAhead),
      });
    }
    months.push({
      key: month,
      label: monthLabel(month, day),
      count: blocks.reduce((n, block) => n + block.rows.length, 0),
      weeks: blocks,
    });
  }
  return {
    tomorrow: (byDay.get(tomorrow) ?? []).sort(compareRows),
    week,
    nextWeek,
    months,
  };
}

/**
 * The days after the displayed one, under the "Upcoming" fold and at `/upcoming`: Tomorrow (with its times of day), the rest of the
 * week a day at a time, the next four weeks, then months. Routine (repeating) tasks are folded to a count in every block, shown on
 * request, so the days ahead read as what is particular to them. Read from this device (`useUpcomingView`).
 */
export function Upcoming({
  day,
  zone,
  now,
  id,
  open: openRow,
}: {
  day: string;
  zone: string;
  now: number;
  id: string;
  /** Where a row's title leads when the task opens beside the day (the "How tasks open" setting). */
  open?: (row: RowModel) => RowOpen;
}) {
  const env = useTasksEnv();
  const view = useUpcomingView(day, zone, now);
  const actions = useTaskActions();
  const headingId = useId();
  const [shown, setShown] = useState<Set<string>>(() => new Set());
  const toggle = (key: string) =>
    setShown((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  const groups = groupAhead(view.rows, day);
  const tomorrow = addDays(day, 1);
  const render = (
    block: DayBlock,
    rowDay: (row: RowModel) => string,
    level: "h2" | "h3",
    /** What the sticky bar says while this block is under it ("Rest of the week · Tuesday 10 November"). */
    barLabel: string,
  ) => {
    const particular = block.rows.filter((row) => !routine(row));
    const folded = block.rows.filter(routine);
    const open = shown.has(block.key);
    const Heading = level;
    const items = open ? block.rows : particular;
    return (
      <section key={block.key} aria-labelledby={`${headingId}-${block.key}`}>
        <RailLabel
          heading={
            <Heading
              id={`${headingId}-${block.key}`}
              data-rail-heading={barLabel}
              data-rail-section="upcoming"
            >
              {block.label}
            </Heading>
          }
          sub={block.sub}
        />
        <List className="flex flex-col">
          {items.map((row) => (
            <TodayRow
              key={row.id}
              row={row}
              day={rowDay(row)}
              zone={zone}
              now={now}
              actions={actions}
              writable={env.writable}
              me={env.accountId}
              surface="upcoming"
              {...(openRow ? { open: openRow } : {})}
              {...(block.byDay
                ? { timeText: shortDay.format(utc(rowDay(row))) }
                : {})}
            />
          ))}
          {folded.length > 0 ? (
            <RailFoldLine
              action={open ? copy.UPCOMING.hide : copy.UPCOMING.show}
              expanded={open}
              onToggle={() => toggle(block.key)}
            >
              {copy.UPCOMING.routine(folded.length)}
            </RailFoldLine>
          ) : null}
        </List>
      </section>
    );
  };
  const tomorrowGroups = new Map<Group, RowModel[]>();
  for (const row of groups.tomorrow) {
    const g = groupOf(row, tomorrow, zone);
    tomorrowGroups.set(g, [...(tomorrowGroups.get(g) ?? []), row]);
  }
  const empty =
    !view.loading &&
    view.rows.length === 0 &&
    (view.error === null || view.stale);
  const horizon = aheadHorizon(todayIn(zone, now));
  return (
    // Focusable (not in the tab order): `#upcoming` lands the focus here, where the days ahead begin.
    <div
      id={id}
      data-upcoming=""
      tabIndex={-1}
      className="flex flex-col outline-none"
    >
      {view.loading ? null : (
        <Ahead targets={view.ahead} horizonLabel={dayLabel(horizon)} />
      )}
      {view.error !== null ? (
        <div
          className="my-3 flex flex-col gap-2 rounded-xl border border-destructive/35 bg-card p-4"
          data-upcoming-error={view.error}
        >
          <p className="text-sm text-muted-foreground">
            {view.error === "unstable"
              ? copy.LOCAL_UNSTABLE
              : copy.UPCOMING.failed}
            {view.stale ? ` ${copy.SHOWING_LAST_READ}` : ""}
          </p>
          <span>
            <Button onClick={view.retry}>{copy.TRY_AGAIN}</Button>
          </span>
        </div>
      ) : null}
      {view.loading ? (
        <div
          aria-busy="true"
          className="flex flex-col gap-2 py-3 pl-[94px]"
          data-upcoming-loading=""
        >
          <span className="sr-only">{copy.UPCOMING.loading}</span>
          {[0, 1].map((n) => (
            <Skeleton key={n} className="min-h-11 rounded-lg" />
          ))}
        </div>
      ) : null}
      {groups.tomorrow.length > 0 ? (
        <section aria-labelledby={`${headingId}-tomorrow`}>
          <RailHeading
            heading={
              <h2
                id={`${headingId}-tomorrow`}
                data-rail-heading={copy.UPCOMING.bar(
                  copy.UPCOMING.tomorrow,
                  longDayLabel(tomorrow),
                )}
                data-rail-section="upcoming"
              >
                {copy.UPCOMING.tomorrow}
              </h2>
            }
            sub={`${longDayLabel(tomorrow)} · ${copy.THINGS(groups.tomorrow.length)}`}
          />
          {["any", ...GROUP_ORDER.filter((g) => g !== "any")]
            .filter((g) => tomorrowGroups.has(g as Group))
            .map((g) =>
              render(
                {
                  key: `tomorrow-${g}`,
                  label: copy.GROUPS[g as Group],
                  byDay: false,
                  rows: tomorrowGroups.get(g as Group) ?? [],
                },
                () => tomorrow,
                "h3",
                copy.UPCOMING.bar(
                  copy.UPCOMING.tomorrow,
                  `${longDayLabel(tomorrow)} · ${copy.GROUPS[g as Group]}`,
                ),
              ),
            )}
        </section>
      ) : null}
      {groups.week.length > 0 ? (
        <section aria-labelledby={`${headingId}-week`}>
          <RailHeading
            heading={
              <h2
                id={`${headingId}-week`}
                data-rail-heading={copy.UPCOMING.bar(
                  copy.UPCOMING.restOfWeek,
                  longDayLabel(groups.week[0]?.key ?? tomorrow),
                )}
                data-rail-section="upcoming"
              >
                {copy.UPCOMING.restOfWeek}
              </h2>
            }
            sub={copy.UPCOMING.restOfWeekSub}
          />
          {groups.week.map((block) =>
            render(
              block,
              () => block.key,
              "h3",
              copy.UPCOMING.bar(
                copy.UPCOMING.restOfWeek,
                longDayLabel(block.key),
              ),
            ),
          )}
        </section>
      ) : null}
      {groups.nextWeek.length > 0 ? (
        <section aria-labelledby={`${headingId}-next-week`}>
          <RailHeading
            heading={
              <h2
                id={`${headingId}-next-week`}
                data-rail-heading={copy.UPCOMING.bar(
                  copy.UPCOMING.nextWeek,
                  groups.nextWeek[0]?.label ?? "",
                )}
                data-rail-section="upcoming"
              >
                {copy.UPCOMING.nextWeek}
              </h2>
            }
            sub={copy.UPCOMING.nextWeekSub}
          />
          {groups.nextWeek.map((block) =>
            render(
              block,
              () => block.key,
              "h3",
              copy.UPCOMING.bar(copy.UPCOMING.nextWeek, block.label),
            ),
          )}
        </section>
      ) : null}
      {groups.months.map((month) => (
        <section
          key={month.key}
          aria-labelledby={`${headingId}-${month.key}`}
          data-upcoming-month={month.key}
        >
          <RailHeading
            heading={
              <h2
                id={`${headingId}-${month.key}`}
                data-rail-heading={copy.UPCOMING.bar(
                  month.label,
                  month.weeks[0]?.label ?? "",
                )}
                data-rail-section="upcoming"
              >
                {month.label}
              </h2>
            }
            sub={copy.THINGS(month.count)}
          />
          {month.weeks.map((block) =>
            render(
              block,
              (row) => row.data.slot.date as string,
              "h3",
              copy.UPCOMING.bar(month.label, block.label),
            ),
          )}
        </section>
      ))}
      {empty ? (
        <p
          className="py-4 pl-[94px] text-sm text-muted-foreground"
          data-upcoming-empty=""
        >
          {copy.UPCOMING.empty}
        </p>
      ) : null}
      <p className="pt-4 pl-[94px] text-xs text-muted-foreground">
        {copy.UPCOMING.fromDevice}
      </p>
    </div>
  );
}
