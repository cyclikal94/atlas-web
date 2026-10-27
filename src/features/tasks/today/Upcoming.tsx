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
  weekdayLabel,
} from "../format";
import { addDays } from "../model/time";
import type { RowModel } from "../view";
import { RailFoldLine, RailHeading, RailLabel } from "./rail";
import { TodayRow } from "./TodayRow";
import { useUpcomingView } from "./useUpcomingView";

/** The Monday-based weekday of a date (0 Monday … 6 Sunday). */
function weekdayIndex(day: string): number {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  return (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7;
}
const dayNumber = (day: string) => String(Number(day.slice(8, 10)));
const monthFormat = new Intl.DateTimeFormat("en-GB", {
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
const monthLabel = (day: string) => monthFormat.format(utc(day));
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

/** The rows after `day`, in the Final design's groups: tomorrow, the rest of this week by day, the next four weeks, then by month. */
export function groupAhead(
  rows: readonly RowModel[],
  day: string,
): {
  tomorrow: RowModel[];
  week: DayBlock[];
  weeks: DayBlock[];
  later: DayBlock[];
} {
  const tomorrow = addDays(day, 1);
  const sunday = addDays(day, 6 - weekdayIndex(day));
  const weeksEnd = addDays(sunday, 28);
  const byDay = new Map<string, RowModel[]>();
  for (const row of rows) {
    const date = row.data.slot.date as string;
    byDay.set(date, [...(byDay.get(date) ?? []), row]);
  }
  const week: DayBlock[] = [];
  for (let d = addDays(tomorrow, 1); d <= sunday; d = addDays(d, 1)) {
    const dayRows = byDay.get(d);
    if (!dayRows) continue;
    week.push({
      key: d,
      label: weekdayLabel(d),
      sub: dayNumber(d),
      byDay: false,
      rows: dayRows.sort(compareRows),
    });
  }
  const weeks: DayBlock[] = [];
  for (
    let start = addDays(sunday, 1);
    start <= weeksEnd;
    start = addDays(start, 7)
  ) {
    const end = addDays(start, 6);
    const block: RowModel[] = [];
    for (let d = start; d <= end; d = addDays(d, 1))
      block.push(...(byDay.get(d) ?? []));
    if (block.length === 0) continue;
    weeks.push({
      key: start,
      label: weekLabel(start, end),
      byDay: true,
      rows: block.sort(compareAhead),
    });
  }
  const later: DayBlock[] = [];
  const months = new Map<string, RowModel[]>();
  for (const [date, dayRows] of byDay)
    if (date > weeksEnd) {
      const month = date.slice(0, 7);
      months.set(month, [...(months.get(month) ?? []), ...dayRows]);
    }
  for (const month of [...months.keys()].sort())
    later.push({
      key: month,
      label: monthLabel(`${month}-01`),
      byDay: true,
      rows: (months.get(month) ?? []).sort(compareAhead),
    });
  return {
    tomorrow: (byDay.get(tomorrow) ?? []).sort(compareRows),
    week,
    weeks,
    later,
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
}: {
  day: string;
  zone: string;
  now: number;
  id: string;
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
            <Heading id={`${headingId}-${block.key}`}>{block.label}</Heading>
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
  return (
    <div id={id} data-upcoming="" className="flex flex-col">
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
              <h2 id={`${headingId}-tomorrow`}>{copy.UPCOMING.tomorrow}</h2>
            }
            sub={`${weekdayLabel(tomorrow)} ${dayNumber(tomorrow)} · ${copy.THINGS(groups.tomorrow.length)}`}
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
              ),
            )}
        </section>
      ) : null}
      {groups.week.length > 0 ? (
        <section aria-labelledby={`${headingId}-week`}>
          <RailHeading
            heading={
              <h2 id={`${headingId}-week`}>{copy.UPCOMING.restOfWeek}</h2>
            }
            sub={copy.UPCOMING.restOfWeekSub}
          />
          {groups.week.map((block) => render(block, () => block.key, "h3"))}
        </section>
      ) : null}
      {groups.weeks.length > 0 ? (
        <section aria-labelledby={`${headingId}-weeks`}>
          <RailHeading
            heading={
              <h2 id={`${headingId}-weeks`}>{copy.UPCOMING.nextWeeks}</h2>
            }
            sub={copy.UPCOMING.nextWeeksSub}
          />
          {groups.weeks.map((block) =>
            render(block, (row) => row.data.slot.date as string, "h3"),
          )}
        </section>
      ) : null}
      {groups.later.length > 0 ? (
        <section aria-labelledby={`${headingId}-later`}>
          <RailHeading
            heading={<h2 id={`${headingId}-later`}>{copy.UPCOMING.later}</h2>}
          />
          {groups.later.map((block) =>
            render(block, (row) => row.data.slot.date as string, "h3"),
          )}
        </section>
      ) : null}
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
