import { ChevronLeft, ChevronRight } from "lucide-react";
import { useCallback, useState } from "react";
import { Button } from "../../../components/ui/button";
import { Choice } from "../../../components/ui/popover";
import { cn } from "../../../lib/utils";
import type { SaveOutcome, TaskActions } from "../actions";
import * as copy from "../copy";
import { longDayLabel } from "../format";
import { reviseOccurrence, reviseTask } from "../model/commands";
import {
  CARRIES,
  type Cadence,
  type Carry,
  type Frequency,
  type TaskDefinition,
} from "../model/contract";
import { addDays, resolveWallTime, todayIn } from "../model/time";
import type { RowModel } from "../view";

/**
 * The facts strip's short editors (the Final design, FD_EditPopover): each opens as a popover directly under the cell that was pressed,
 * saves on choice through the same commands the dialogs use, and closes when the save is queued. A refusal keeps the popover open and
 * says why. The day's editor corrects this occurrence alone (`revise_occurrence`); the repeat and the carry revise the task.
 */
export const EDITOR_COPY = {
  day: {
    title: "When",
    name: "Change the day",
    today: "Today",
    tomorrow: "Tomorrow",
    undated: "No date",
    time: "Time",
    any: "Any",
    other: "Another time",
    previous: "Previous month",
    next: "Next month",
    more: "Correct more about this day…",
    moved: (day: string) => `Moved to ${day}.`,
    unscheduled: "The date was removed.",
    timed: (time: string) => `Time set to ${time}.`,
    anyTime: "Any time that day.",
  },
  repeat: {
    title: "Repeats",
    name: "Change how it repeats",
    every: "Every",
    frequency: {
      daily: "Day",
      weekly: "Week",
      monthly: "Month",
      yearly: "Year",
      after_completion: "After it's done",
    } as Record<Frequency, string>,
    times: (n: number) => (n === 1 ? "Once" : `${n}×`),
    saved: (cadence: string) => `Now ${cadence.toLowerCase()}.`,
  },
  carry: {
    title: "If it isn't done",
    name: "Change what happens if it's missed",
    saved: (label: string) => `If missed: ${label.toLowerCase()}.`,
  },
  acts: {
    tomorrow: "Tomorrow",
    skip: "Skip",
  },
  busy: "Saving…",
} as const;

const QUICK_TIMES = ["09:00", "18:00"] as const;
const WEEKDAYS = ["M", "T", "W", "T", "F", "S", "S"] as const;

const monthFormat = new Intl.DateTimeFormat("en-GB", {
  month: "long",
  year: "numeric",
  timeZone: "UTC",
});
const monthLabel = (month: string) =>
  monthFormat.format(new Date(`${month}-01T00:00:00Z`));
const shiftMonth = (month: string, by: number) => {
  const [y, m] = month.split("-").map(Number) as [number, number];
  const date = new Date(Date.UTC(y, m - 1 + by, 1));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
};
/** The 42 days a month's grid shows, Monday first, from the Monday on or before the 1st. */
function gridOf(month: string): string[] {
  const first = `${month}-01`;
  const weekday = (new Date(`${first}T00:00:00Z`).getUTCDay() + 6) % 7;
  const start = addDays(first, -weekday);
  return Array.from({ length: 42 }, (_, i) => addDays(start, i));
}

/** A month to pick a day from: the weekday letters, the days (the month's neighbours dimmed), today ringed and the chosen day pressed. */
export function MonthGrid({
  month,
  chosen,
  today,
  onMonth,
  onPick,
  disabled = false,
}: {
  month: string;
  chosen: string | null;
  today: string;
  onMonth(month: string): void;
  onPick(day: string): void;
  disabled?: boolean;
}) {
  return (
    <div className="flex flex-col gap-1.5" data-month-grid={month}>
      <div className="flex items-center gap-1 px-1">
        <span className="flex-1 text-[13px] font-semibold">
          {monthLabel(month)}
        </span>
        <button
          type="button"
          aria-label={EDITOR_COPY.day.previous}
          onClick={() => onMonth(shiftMonth(month, -1))}
          className="atlas-press flex size-7 items-center justify-center rounded-full text-muted-foreground hover:bg-accent hover:text-accent-foreground"
        >
          <ChevronLeft aria-hidden="true" className="size-4" />
        </button>
        <button
          type="button"
          aria-label={EDITOR_COPY.day.next}
          onClick={() => onMonth(shiftMonth(month, 1))}
          className="atlas-press flex size-7 items-center justify-center rounded-full text-muted-foreground hover:bg-accent hover:text-accent-foreground"
        >
          <ChevronRight aria-hidden="true" className="size-4" />
        </button>
      </div>
      <div
        aria-hidden="true"
        className="grid grid-cols-7 text-center text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground"
      >
        {WEEKDAYS.map((letter, i) => (
          <span key={`${letter}-${String(i)}`}>{letter}</span>
        ))}
      </div>
      <div className="grid grid-cols-7 gap-px">
        {gridOf(month).map((day) => {
          const outside = !day.startsWith(month);
          const pressed = day === chosen;
          return (
            <button
              key={day}
              type="button"
              aria-label={longDayLabel(day)}
              aria-pressed={pressed}
              disabled={disabled}
              onClick={() => onPick(day)}
              className={cn(
                "atlas-press font-num mx-auto flex size-8 items-center justify-center rounded-full text-[13px] disabled:cursor-not-allowed",
                pressed
                  ? "bg-primary font-semibold text-primary-foreground"
                  : day === today
                    ? "shadow-[inset_0_0_0_1px_var(--primary)] hover:bg-accent"
                    : "hover:bg-accent",
                outside && !pressed ? "text-muted-foreground/60" : "",
              )}
            >
              {Number(day.slice(8))}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** A save in flight and the refusal it met, shared by the editors: a refusal keeps the popover open with its words. */
function useSave() {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const run = useCallback(async (save: () => Promise<SaveOutcome>) => {
    setBusy(true);
    setNote(null);
    try {
      const outcome = await save();
      if (!outcome.ok) setNote(outcome.message ?? copy.LOCAL_FAILED);
      return outcome.ok;
    } catch {
      setNote(copy.LOCAL_FAILED);
      return false;
    } finally {
      setBusy(false);
    }
  }, []);
  return { busy, note, run };
}

function Note({ note, busy }: { note: string | null; busy: boolean }) {
  if (busy)
    return (
      <span className="px-1 text-xs text-muted-foreground">
        {EDITOR_COPY.busy}
      </span>
    );
  if (note === null) return null;
  return (
    <span className="px-1 text-xs text-destructive" data-editor-refused="">
      {note}
    </span>
  );
}

/**
 * The day's editor: Today, Tomorrow and No date, the month to pick from, and the time (Any, two quick times, another typed). A choice
 * corrects this day alone, as the correction dialog does, keeping the time when the day changes and the day when the time changes.
 */
export function DayEditor({
  row,
  now,
  zone,
  progressIds,
  actions,
  onDone,
  onMore,
}: {
  row: RowModel;
  now: number;
  zone: string;
  progressIds: readonly string[];
  actions: Pick<TaskActions, "enqueue">;
  onDone(): void;
  onMore(): void;
}) {
  const date = row.data.slot.date;
  const time = row.data.slot.intended_time?.slice(0, 5) ?? null;
  const today = todayIn(zone, now);
  const tomorrow = addDays(today, 1);
  const [month, setMonth] = useState((date ?? today).slice(0, 7));
  const { busy, note, run } = useSave();
  const save = async (
    nextDate: string | null,
    nextTime: string | null,
    announce: string,
  ) => {
    const ok = await run(() =>
      actions.enqueue(
        reviseOccurrence(
          {
            occurrenceId: row.id,
            current: row.data,
            definition: row.data.definition,
            date: nextDate,
            time:
              nextDate === null || nextTime === null ? null : `${nextTime}:00`,
            progressIds,
          },
          resolveWallTime,
        ),
        announce,
      ),
    );
    if (ok) onDone();
  };
  const pickDay = (day: string | null) => {
    if (day === date) return;
    void save(
      day,
      time,
      day === null
        ? EDITOR_COPY.day.unscheduled
        : EDITOR_COPY.day.moved(longDayLabel(day)),
    );
  };
  const pickTime = (next: string | null) => {
    if (next === time) return;
    void save(
      date ?? today,
      next,
      next === null ? EDITOR_COPY.day.anyTime : EDITOR_COPY.day.timed(next),
    );
  };
  return (
    <>
      <div className="grid grid-cols-3 gap-1" data-day-quick="">
        <Choice
          pressed={date === today}
          disabled={busy}
          onClick={() => pickDay(today)}
        >
          {EDITOR_COPY.day.today}
        </Choice>
        <Choice
          pressed={date === tomorrow}
          disabled={busy}
          onClick={() => pickDay(tomorrow)}
        >
          {EDITOR_COPY.day.tomorrow}
        </Choice>
        <Choice
          pressed={date === null}
          disabled={busy}
          onClick={() => pickDay(null)}
        >
          {EDITOR_COPY.day.undated}
        </Choice>
      </div>
      <MonthGrid
        month={month}
        chosen={date}
        today={today}
        onMonth={setMonth}
        onPick={pickDay}
        disabled={busy}
      />
      <div
        className="flex flex-wrap items-center gap-1 border-t border-border pt-2.5"
        data-day-time=""
      >
        <span className="flex-1 px-1 text-xs text-muted-foreground">
          {EDITOR_COPY.day.time}
        </span>
        <Choice
          pressed={time === null}
          disabled={busy}
          onClick={() => pickTime(null)}
        >
          {EDITOR_COPY.day.any}
        </Choice>
        {QUICK_TIMES.map((quick) => (
          <Choice
            key={quick}
            pressed={time === quick}
            disabled={busy}
            onClick={() => pickTime(quick)}
            className="font-num"
          >
            {quick}
          </Choice>
        ))}
        <input
          type="time"
          aria-label={EDITOR_COPY.day.other}
          defaultValue={time ?? ""}
          disabled={busy}
          onChange={(event) => {
            const value = event.target.value;
            if (value.length === 5) pickTime(value);
          }}
          className="font-num h-[34px] min-w-0 rounded-full border border-border bg-background px-2.5 text-[13px] text-foreground"
        />
      </div>
      <Note note={note} busy={busy} />
      <span>
        <Button variant="ghost" onClick={onMore} data-day-more="">
          {EDITOR_COPY.day.more}
        </Button>
      </span>
    </>
  );
}

/** What a revision of the task needs beyond the definition: the cached task's policy version is required (Q1). */
export interface TaskRevision {
  taskId: string;
  executionId: string;
  title: string;
  policyVersion: number;
}

function useRevise(
  revision: TaskRevision,
  actions: Pick<TaskActions, "enqueue">,
  onDone: () => void,
) {
  const { busy, note, run } = useSave();
  const revise = async (definition: TaskDefinition, announce: string) => {
    const ok = await run(() =>
      actions.enqueue(
        reviseTask({
          taskId: revision.taskId,
          executionId: revision.executionId,
          title: revision.title,
          definition,
          policyVersion: revision.policyVersion,
        }),
        announce,
      ),
    );
    if (ok) onDone();
  };
  return { busy, note, revise };
}

const FIXED: readonly Frequency[] = ["daily", "weekly", "monthly", "yearly"];
const INTERVALS = [1, 2, 3, 4] as const;

/**
 * How the task repeats, within its family (the form's rule: a one-off stays one, a task that repeats after it is done keeps that, and a
 * fixed cadence may change its frequency and its interval).
 */
export function RepeatEditor({
  definition,
  cadence,
  revision,
  actions,
  onDone,
}: {
  definition: TaskDefinition;
  cadence: Cadence;
  revision: TaskRevision;
  actions: Pick<TaskActions, "enqueue">;
  onDone(): void;
}) {
  const { busy, note, revise } = useRevise(revision, actions, onDone);
  const fixed = cadence.frequency !== "after_completion";
  const pick = (next: Cadence) => {
    if (
      next.frequency === cadence.frequency &&
      next.interval === cadence.interval
    )
      return;
    void revise(
      {
        ...definition,
        schedule: { ...definition.schedule, repeat: next },
      },
      EDITOR_COPY.repeat.saved(copy.CADENCE(next)),
    );
  };
  return (
    <>
      {fixed ? (
        <div className="grid grid-cols-4 gap-1" data-repeat-frequency="">
          {FIXED.map((frequency) => (
            <Choice
              key={frequency}
              pressed={cadence.frequency === frequency}
              disabled={busy}
              onClick={() => pick({ ...cadence, frequency })}
            >
              {EDITOR_COPY.repeat.frequency[frequency]}
            </Choice>
          ))}
        </div>
      ) : null}
      <div
        className="flex flex-wrap items-center gap-1"
        data-repeat-interval=""
      >
        <span className="flex-1 px-1 text-xs text-muted-foreground">
          {EDITOR_COPY.repeat.every}
        </span>
        {INTERVALS.map((interval) => (
          <Choice
            key={interval}
            pressed={cadence.interval === interval}
            disabled={busy}
            onClick={() => pick({ ...cadence, interval })}
            className="font-num min-w-10"
          >
            {interval}
          </Choice>
        ))}
      </div>
      <span className="px-1 text-xs text-muted-foreground">
        {copy.CADENCE(cadence)}
      </span>
      <Note note={note} busy={busy} />
    </>
  );
}

/** What happens when a day is missed: the three carries, the chosen one's line under them. */
export function CarryEditor({
  definition,
  revision,
  actions,
  onDone,
}: {
  definition: TaskDefinition;
  revision: TaskRevision;
  actions: Pick<TaskActions, "enqueue">;
  onDone(): void;
}) {
  const { busy, note, revise } = useRevise(revision, actions, onDone);
  const pick = (carry: Carry) => {
    if (carry === definition.carry) return;
    void revise(
      { ...definition, carry },
      EDITOR_COPY.carry.saved(copy.CARRY[carry].label),
    );
  };
  return (
    <>
      <div className="grid grid-cols-1 gap-1" data-carry-choices="">
        {CARRIES.map((carry) => (
          <Choice
            key={carry}
            pressed={definition.carry === carry}
            disabled={busy}
            onClick={() => pick(carry)}
          >
            {copy.CARRY[carry].label}
          </Choice>
        ))}
      </div>
      <span className="px-1 text-xs text-muted-foreground">
        {copy.CARRY[definition.carry].line}
      </span>
      <Note note={note} busy={busy} />
    </>
  );
}

/**
 * The day's quick acts on the action row (the Final design): Tomorrow moves this day on by one (a correction of the day alone, keeping its
 * time) and Skip closes it without completing it (the closure the "This day" section explains). Shown only while the day is open and
 * may be changed.
 */
export function DayActs({
  row,
  now,
  zone,
  progressIds,
  actions,
}: {
  row: RowModel;
  now: number;
  zone: string;
  progressIds: readonly string[];
  actions: Pick<TaskActions, "enqueue" | "resolve">;
}) {
  const { busy, run } = useSave();
  const tomorrow = addDays(todayIn(zone, now), 1);
  const time = row.data.slot.intended_time?.slice(0, 5) ?? null;
  const move = () =>
    void run(() =>
      actions.enqueue(
        reviseOccurrence(
          {
            occurrenceId: row.id,
            current: row.data,
            definition: row.data.definition,
            date: tomorrow,
            time: time === null ? null : `${time}:00`,
            progressIds,
          },
          resolveWallTime,
        ),
        EDITOR_COPY.day.moved(longDayLabel(tomorrow)),
      ),
    );
  const act = (
    label: string,
    onClick: () => void,
    data: Record<`data-${string}`, string>,
  ) =>
    busy ? (
      <Button variant="outline" disabled reason={EDITOR_COPY.busy} {...data}>
        {label}
      </Button>
    ) : (
      <Button variant="outline" onClick={onClick} {...data}>
        {label}
      </Button>
    );
  return (
    <>
      {row.data.slot.date === tomorrow
        ? null
        : act(EDITOR_COPY.acts.tomorrow, move, { "data-day-tomorrow": "" })}
      {act(
        EDITOR_COPY.acts.skip,
        () => void run(() => actions.resolve(row, true)),
        { "data-day-skip": "" },
      )}
    </>
  );
}
