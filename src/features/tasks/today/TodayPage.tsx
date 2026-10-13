import { useId, useMemo, useState } from "react";
import { Button } from "../../../components/ui/button";
import { List } from "../../../components/ui/list";
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
  return (
    <div className="flex max-w-[760px] flex-col gap-5" data-today-page="">
      {/* The page's heading is the route's (`features/today/route.tsx`), outside the cache gate and this lazy screen. */}
      <p className="text-[13px] text-ink-2">{longDayLabel(day)}</p>
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex items-end gap-1.5">
          <Button
            variant="quiet"
            aria-label={copy.PREVIOUS_DAY}
            onClick={() => onChange({ day: addDays(day, -1) })}
          >
            ‹
          </Button>
          <div className="flex flex-col gap-1">
            <label
              htmlFor={dayId}
              className="text-[12px] font-medium text-ink-2"
            >
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
              className="min-h-11 rounded-control border border-field-edge bg-canvas px-3 text-[13.5px] text-ink-1"
            />
          </div>
          <Button
            variant="quiet"
            aria-label={copy.NEXT_DAY}
            onClick={() => onChange({ day: addDays(day, 1) })}
          >
            ›
          </Button>
          {dayGiven && day !== today ? (
            <Button variant="quiet" onClick={() => onChange({ day: today })}>
              {copy.BACK_TO_TODAY}
            </Button>
          ) : null}
        </div>
        <div className="flex flex-col gap-1">
          <label
            htmlFor={zoneId}
            className="text-[12px] font-medium text-ink-2"
          >
            {copy.ZONE_LABEL}
          </label>
          <select
            id={zoneId}
            value={zone}
            data-field-edge=""
            onChange={(event) => onChange({ zone: event.target.value })}
            className="min-h-11 max-w-[260px] rounded-control border border-field-edge bg-canvas px-3 text-[13.5px] text-ink-1"
          >
            {(zones.includes(zone) ? zones : [zone, ...zones]).map((z) => (
              <option key={z} value={z}>
                {z}
              </option>
            ))}
          </select>
        </div>
      </div>
      <fieldset className="flex flex-col gap-2">
        <legend id={filterName} className="text-[12px] font-medium text-ink-2">
          {copy.FILTERS_NAME}
        </legend>
        <div className="flex flex-wrap gap-1.5">
          {FILTERS.map((f) => (
            <label
              key={f}
              className="atlas-transition inline-flex min-h-11 items-center gap-2 rounded-control border border-hairline-strong bg-raised px-3.5 text-[13.5px] text-ink-1"
            >
              <input
                type="radio"
                name={filterName}
                value={f}
                checked={filter === f}
                onChange={() => setFilter(f)}
                className="size-[15px]"
              />
              {copy.FILTER_LABEL[f]}
            </label>
          ))}
        </div>
      </fieldset>
      <p className="text-[13px] text-ink-1" data-today-summary="">
        {copy.SUMMARY(counts.done, counts.total, counts.toDo, counts.notKnown)}
      </p>
      <p className="text-[12px] text-ink-2">{copy.ZONE_HINT(zone)}</p>
      {view.pendingTasks.length > 0 ? (
        <p
          data-pending-tasks=""
          className="max-w-[620px] rounded-row border border-hairline-strong bg-raised px-3.5 py-2.5 text-[13px] leading-[1.55] text-ink-1"
        >
          {copy.PENDING_TASKS}
        </p>
      ) : null}
      {view.error !== null ? (
        <section
          data-today-error={view.error.kind}
          aria-labelledby={`${filterName}-error`}
          className="flex max-w-[620px] flex-col gap-2 rounded-row border border-hairline-strong bg-panel p-3.5"
        >
          <h2
            id={`${filterName}-error`}
            className="text-[14px] font-medium text-ink-1"
          >
            {copy.ERROR_TITLE}
          </h2>
          <p className="text-[13px] text-ink-2">
            {view.error.kind === "kept_changing"
              ? copy.KEPT_CHANGING
              : copy.ERROR_BODY}
          </p>
          {view.error.kind === "failed" && view.error.requestId ? (
            <p className="select-all font-num text-[12px] text-ink-2">
              {copy.REQUEST_ID(view.error.requestId)}
            </p>
          ) : null}
          {all.length > 0 ? (
            <p className="text-[12.5px] text-ink-2">{copy.SHOWING_DEVICE}</p>
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
            <div key={n} className="min-h-11 rounded-row bg-raised" />
          ))}
        </div>
      ) : shown.length === 0 && view.unreadable.length === 0 ? (
        view.error === null || all.length > 0 ? (
          <p className="text-[13.5px] text-ink-2" data-today-empty="">
            {copy.EMPTY(filter)}
          </p>
        ) : null
      ) : (
        <div
          className="flex flex-col gap-5"
          data-today-refreshing={view.refreshing ? "" : undefined}
        >
          {GROUP_ORDER.filter((g) => groups.has(g)).map((group) => (
            <section
              key={group}
              aria-labelledby={`${filterName}-${group}`}
              data-today-group={group}
            >
              <h2
                id={`${filterName}-${group}`}
                className="text-[13px] font-semibold text-ink-2"
              >
                {copy.GROUPS[group]}
              </h2>
              <List className="rounded-row border border-hairline-strong bg-panel px-3">
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
              className="text-[12.5px] text-ink-2"
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
