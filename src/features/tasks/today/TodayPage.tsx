import { CalendarX2, ChevronLeft, ChevronRight } from "lucide-react";
import { useId, useMemo, useState } from "react";
import { Button } from "../../../components/ui/button";
import { EmptyState } from "../../../components/ui/empty-state";
import { inputClass } from "../../../components/ui/input";
import { Label } from "../../../components/ui/label";
import { List } from "../../../components/ui/list";
import { NativeSelect } from "../../../components/ui/native-select";
import { Progress } from "../../../components/ui/progress";
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
import { addDays, todayIn } from "../model/time";
import type { RowModel } from "../view";
import { TodayRow } from "./TodayRow";
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

/**
 * WF-TODAY-01: the day's tasks for the displayed account, in the display zone, with filters, the progress summary, time-of-day groups and
 * the states loading / empty / error / offline, and the `pending_tasks` notice (D-10a-6; "Catch up" is WEB-10c's). Choosing another day
 * changes only what is read; nothing is ever deleted by a day change.
 */
export function TodayPage({
  day,
  zone,
  dayGiven,
  onChange,
}: {
  day: string;
  zone: string;
  /** The day came from the address (otherwise it is today, and rolls over at local midnight). */
  dayGiven: boolean;
  onChange(next: { day?: string; zone?: string }): void;
}) {
  const env = useTasksEnv();
  const view = useTodayView(day, zone);
  const actions = useTaskActions();
  const [filter, setFilter] = useState<Filter>("all");
  const filterName = useId();
  const zoneId = useId();
  const dayId = useId();
  const zones = useMemo(knownZones, []);
  const today = todayIn(zone, view.now);
  const all = view.rows;
  const counts = countRows(all.map((row) => inputsOf(row, view.now)));
  const shown = all.filter((row) => inFilter(filter, inputsOf(row, view.now)));
  const groups = new Map<Group, RowModel[]>();
  for (const row of shown) {
    const group = groupOf(row, day, zone);
    groups.set(group, [...(groups.get(group) ?? []), row]);
  }
  const progress =
    counts.total > 0 ? Math.round((counts.done / counts.total) * 100) : 0;
  return (
    <div
      className="atlas-enter flex max-w-[760px] flex-col gap-6"
      data-today-page=""
    >
      {/* The page's heading is the route's (`features/today/route.tsx`), outside the cache gate and this lazy screen. */}
      <p className="-mt-3 text-base text-muted-foreground">
        {longDayLabel(day)}
      </p>
      <div className="flex flex-wrap items-end gap-x-5 gap-y-3 rounded-xl border bg-card p-4 shadow-sm">
        <div className="flex items-end gap-1.5">
          <Button
            variant="ghost"
            size="icon"
            aria-label={copy.PREVIOUS_DAY}
            onClick={() => onChange({ day: addDays(day, -1) })}
          >
            <ChevronLeft aria-hidden="true" />
          </Button>
          <div className="flex flex-col gap-2">
            <Label htmlFor={dayId}>{copy.DAY_LABEL}</Label>
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
          </div>
          <Button
            variant="ghost"
            size="icon"
            aria-label={copy.NEXT_DAY}
            onClick={() => onChange({ day: addDays(day, 1) })}
          >
            <ChevronRight aria-hidden="true" />
          </Button>
          {dayGiven && day !== today ? (
            <Button variant="ghost" onClick={() => onChange({ day: today })}>
              {copy.BACK_TO_TODAY}
            </Button>
          ) : null}
        </div>
        <div className="flex min-w-0 flex-col gap-2">
          <Label htmlFor={zoneId}>{copy.ZONE_LABEL}</Label>
          <NativeSelect
            id={zoneId}
            value={zone}
            onChange={(event) => onChange({ zone: event.target.value })}
            className="max-w-[260px]"
          >
            {(zones.includes(zone) ? zones : [zone, ...zones]).map((z) => (
              <option key={z} value={z}>
                {z}
              </option>
            ))}
          </NativeSelect>
        </div>
      </div>
      <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
        <fieldset className="flex flex-col gap-2">
          <legend
            id={filterName}
            className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground"
          >
            {copy.FILTERS_NAME}
          </legend>
          <div className="flex flex-wrap gap-1.5">
            {FILTERS.map((f) => (
              <label
                key={f}
                className={cn(
                  "atlas-transition inline-flex h-10 cursor-pointer items-center gap-2 rounded-full border px-3.5 text-sm shadow-xs hover:bg-accent hover:text-accent-foreground",
                  filter === f
                    ? "border-primary/40 bg-accent font-medium text-accent-foreground"
                    : "border-border bg-card text-foreground",
                )}
              >
                <input
                  type="radio"
                  name={filterName}
                  value={f}
                  checked={filter === f}
                  onChange={() => setFilter(f)}
                  className="size-4"
                />
                {copy.FILTER_LABEL[f]}
              </label>
            ))}
          </div>
        </fieldset>
        <div className="flex min-w-[200px] flex-1 flex-col gap-1.5 tablet:max-w-[300px]">
          <p className="text-sm text-foreground" data-today-summary="">
            {copy.SUMMARY(
              counts.done,
              counts.total,
              counts.toDo,
              counts.notKnown,
            )}
          </p>
          <Progress
            aria-hidden="true"
            value={progress}
            className="h-1.5"
            indicatorClassName="bg-success"
          />
          <p className="text-xs text-muted-foreground">
            {copy.ZONE_HINT(zone)}
          </p>
        </div>
      </div>
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
      {view.loading ? (
        <div
          aria-busy="true"
          data-today-loading=""
          className="flex flex-col gap-2"
        >
          <span className="sr-only">{copy.LOADING}</span>
          {[0, 1, 2].map((n) => (
            <Skeleton key={n} className="min-h-14 rounded-lg" />
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
          className="flex flex-col gap-5"
          data-today-refreshing={view.refreshing ? "" : undefined}
          data-today-stale={view.stale ? "" : undefined}
        >
          {GROUP_ORDER.filter((g) => groups.has(g)).map((group) => (
            <section
              key={group}
              aria-labelledby={`${filterName}-${group}`}
              data-today-group={group}
            >
              <h2
                id={`${filterName}-${group}`}
                className="mb-2 px-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground"
              >
                {copy.GROUPS[group]}
              </h2>
              <List className="atlas-stagger overflow-hidden rounded-xl border bg-card px-4 shadow-sm">
                {[...(groups.get(group) ?? [])].sort(compareRows).map((row) => (
                  <TodayRow
                    key={row.id}
                    row={row}
                    day={day}
                    zone={zone}
                    now={view.now}
                    actions={actions}
                    writable={env.writable}
                    me={env.accountId}
                  />
                ))}
              </List>
            </section>
          ))}
          {view.unreadable.length > 0 ? (
            <p
              className="text-xs text-muted-foreground"
              data-today-unreadable={view.unreadable.length}
            >
              {copy.UNREADABLE}
            </p>
          ) : null}
        </div>
      )}
    </div>
  );
}
