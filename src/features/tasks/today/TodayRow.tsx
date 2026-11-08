import { Link } from "@tanstack/react-router";
import { Check, Hash, ListChecks, X } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import type { BadgeVariant } from "../../../components/ui/badge";
import { Button } from "../../../components/ui/button";
import { Pill } from "../../../components/ui/chip";
import { cn } from "../../../lib/utils";
import type { TaskActions } from "../actions";
import * as copy from "../copy";
import { dayLabel, whoLabel } from "../format";
import type { Evidence } from "../model/contract";
import { parseDecimalInput } from "../model/decimal";
import { MESSAGES } from "../model/form";
import { dateIn, gapShifted, timeIn } from "../model/time";
import { recordBlock } from "../reasons";
import type { RowModel } from "../view";
import { RailRow, TickGlyph } from "./rail";

/** The pill's tone (never colour alone: the words say the state). */
export function pillTone(pill: RowModel["pill"]): BadgeVariant {
  switch (pill) {
    case "missed":
      return "warning";
    case "conflict":
      return "destructive";
    case "done":
    case "done_late":
      return "success";
    case "on_track":
      return "accent";
    default:
      return "muted";
  }
}

const PILL_TEXT: Record<BadgeVariant, string> = {
  default: "text-foreground",
  secondary: "text-muted-foreground",
  outline: "text-muted-foreground",
  accent: "text-primary",
  success: "text-success",
  warning: "text-warning",
  destructive: "text-destructive",
  muted: "text-muted-foreground",
};

/** Where a row's title leads: the task's page, or the same page with the task opened beside it (the "How tasks open" setting). */
export interface RowOpen {
  to: string;
  params?: Record<string, string>;
  search: Record<string, unknown>;
}

/**
 * One row on the rail (WF-TODAY-01, the Final design): the time (or "all day"), the title (a link to the task for this day), who takes
 * part and my state in words with any pending mark, and the quick action as the tick at the end. "Mark done" records in place for a
 * checkbox goal; an amount or a checklist is logged in place too (the Final design, 8 November 2026): the tick opens a recorder under
 * the title, with the same evidence the task page records. A disabled tick states why beside it. The same row draws the days ahead
 * (`surface: "upcoming"`), without the quick action and with the day in the time column where the section spans more than one day.
 */
export function TodayRow({
  row,
  day,
  zone,
  now,
  actions,
  writable,
  me,
  surface = "today",
  timeText,
  open,
}: {
  me: string;
  row: RowModel;
  day: string;
  zone: string;
  now: number;
  actions: Pick<TaskActions, "record">;
  writable: boolean;
  surface?: "today" | "upcoming";
  /** The time column, when it is not the row's own time ("Tue 4" in a section that spans days). */
  timeText?: string;
  /** Where the title leads when it is not the task's own page (a task opened beside the day). */
  open?: (row: RowModel) => RowOpen;
}) {
  const titleId = useId();
  const reasonId = useId();
  const recorderId = useId();
  const [busy, setBusy] = useState(false);
  const [logging, setLogging] = useState(false);
  const tickRef = useRef<HTMLButtonElement>(null);
  const { data } = row;
  const instant = data.slot.instant;
  const overdue =
    (instant !== null && dateIn(instant, zone) < day) ||
    (instant === null && data.slot.date !== null && data.slot.date < day);
  const timed = instant !== null && dateIn(instant, zone) === day;
  const time = timeText ?? (timed ? timeIn(instant, zone) : copy.ALL_DAY);
  // A row carried from an earlier day keeps that day's time in its note ("From Sun 8 Nov, 17:40"): the time column says "all day",
  // because on this day it is open at any time, and the note says when it was meant for.
  const from = overdue
    ? copy.FROM_DAY(
        instant !== null
          ? `${dayLabel(dateIn(instant, zone))}, ${timeIn(instant, zone)}`
          : dayLabel(data.slot.date as string),
      )
    : null;
  const explain =
    instant !== null &&
    (gapShifted(data.slot) ||
      (data.slot.timezone !== zone &&
        data.slot.intended_time !== null &&
        timeIn(instant, zone) !== data.slot.intended_time.slice(0, 5)));
  const provisional =
    row.personal.kind === "result" && row.personal.provisional;
  const stale = row.personal.kind === "result" && row.personal.stale;
  const participation = data.definition.participation;
  const reason =
    surface === "today" ? recordBlock(row, now, zone, writable) : null;
  const done = row.outcome === "complete";
  const past = timed ? instant * 1000 <= now : done;
  const goal = data.definition.goal;
  const record = async (evidence: Evidence, announce: string) => {
    setBusy(true);
    try {
      await actions.record(row, evidence, null, announce);
    } finally {
      setBusy(false);
    }
  };
  const pillText = `${copy.PILL[row.pill]}${provisional ? ` (${copy.PROVISIONAL})` : ""}`;
  const tone = pillTone(row.pill);
  const quiet = row.pill === "to_do" || row.pill === "on_track";
  // A day ahead is not open yet by definition: only a state that says more is written on its row.
  const stateShown = !(surface === "upcoming" && row.pill === "not_open");
  const tickLabel =
    goal.kind === "checkbox"
      ? done
        ? copy.MARK_NOT_DONE
        : copy.MARK_DONE
      : logging
        ? copy.CLOSE_RECORDER
        : goal.kind === "numeric"
          ? copy.LOG_AMOUNT
          : copy.TICK_ITEMS;
  const tick = (disabled: string | null) => (
    <button
      ref={tickRef}
      type="button"
      aria-label={tickLabel}
      aria-describedby={disabled ? `${reasonId} ${titleId}` : titleId}
      {...(goal.kind === "checkbox"
        ? {}
        : { "aria-expanded": logging, "aria-controls": recorderId })}
      disabled={disabled !== null}
      data-row-tick=""
      onClick={() =>
        goal.kind === "checkbox"
          ? void record(
              { kind: "checkbox", complete: !done },
              done ? copy.ANNOUNCE_NOT_DONE : copy.ANNOUNCE_DONE,
            )
          : setLogging((value) => !value)
      }
      className="atlas-press flex size-11 flex-none items-center justify-center rounded-full disabled:cursor-not-allowed disabled:opacity-50"
    >
      {goal.kind === "checkbox" ? (
        <TickGlyph done={done} />
      ) : (
        <span
          aria-hidden="true"
          data-done={done ? "true" : "false"}
          className={cn(
            "atlas-transition atlas-pop flex size-7 items-center justify-center rounded-full border-2",
            done
              ? "border-success bg-success text-success-foreground"
              : logging
                ? "border-primary bg-accent text-primary"
                : "border-input text-muted-foreground group-hover:border-foreground group-hover:text-foreground",
          )}
        >
          {logging ? (
            <X className="size-3.5" strokeWidth={2.4} />
          ) : goal.kind === "numeric" ? (
            <Hash className="size-3.5" strokeWidth={2.2} />
          ) : (
            <ListChecks className="size-3.5" strokeWidth={2.2} />
          )}
        </span>
      )}
    </button>
  );
  const quick =
    surface !== "today" ? null : reason !== null ? (
      <>
        <span
          id={reasonId}
          className="hidden max-w-[180px] truncate text-xs text-muted-foreground tablet:inline"
        >
          {reason}
        </span>
        {tick(reason)}
      </>
    ) : busy && goal.kind === "checkbox" ? (
      <>
        <span id={reasonId} className="sr-only">
          {copy.SAVING}
        </span>
        {tick(copy.SAVING)}
      </>
    ) : (
      tick(null)
    );
  const idAttr =
    surface === "today"
      ? { "data-today-row": row.id }
      : { "data-upcoming-row": row.id };
  const summary = row.personal.kind === "result" ? row.personal.action : null;
  const target = open?.(row) ?? {
    to: "/tasks/$taskId",
    params: { taskId: row.taskId },
    search: { occurrence: row.id },
  };
  return (
    <RailRow
      aria-labelledby={titleId}
      {...idAttr}
      data-task-id={row.taskId}
      data-pill={row.pill}
      data-source={row.source}
      data-structure={row.structureFrom}
      data-version={String(row.version)}
      data-can-edit={row.canEdit ? "true" : "false"}
      time={time}
      past={past}
      compact={surface === "upcoming"}
      className={logging ? "bg-accent/40" : undefined}
      trailing={
        <span className="flex min-w-0 flex-none items-center gap-2 self-start pt-[3px]">
          {logging && goal.kind !== "checkbox" ? (
            <RowRecorder
              id={recorderId}
              row={row}
              busy={busy}
              onRecord={record}
              onClose={() => {
                setLogging(false);
                tickRef.current?.focus();
              }}
            />
          ) : null}
          {row.pending && !logging ? (
            <span
              data-pending-mark={row.pending}
              className="hidden h-7 items-center rounded-full bg-muted px-2.5 text-xs leading-none text-muted-foreground tablet:inline-flex"
            >
              {copy.PENDING[row.pending]}
            </span>
          ) : null}
          {quick}
        </span>
      }
    >
      <div className="flex min-w-0 flex-1 flex-col py-1.5">
        <div className="flex min-w-0 flex-col gap-0.5 tablet:flex-row tablet:items-baseline tablet:gap-3">
          <Link
            id={titleId}
            to={target.to}
            params={target.params}
            search={target.search}
            className={cn(
              "atlas-transition min-w-0 flex-1 truncate text-[15px] leading-6 hover:text-primary",
              done ? "text-muted-foreground line-through" : "text-foreground",
            )}
          >
            {row.title ?? copy.UNTITLED}
          </Link>
          <span className="flex min-w-0 items-baseline gap-1 text-xs text-muted-foreground tablet:max-w-[55%] tablet:flex-none">
            <span className="truncate">
              {[
                participation === "personal"
                  ? copy.PARTICIPATION.personal
                  : `${copy.PARTICIPATION[participation]} · ${whoLabel(row, me)}`,
                goal.kind === "numeric" && summary !== null
                  ? goal.unit === "seconds"
                    ? `${copy.DURATION(summary.amount ?? "0")}${goal.minimum !== null ? ` / ${copy.DURATION(goal.minimum)}` : ""}`
                    : `${summary.amount ?? "0"}${goal.minimum !== null ? ` / ${goal.minimum}` : ""} ${goal.unit}`
                  : null,
                from,
              ]
                .filter((part) => part !== null)
                .join(" · ")}
            </span>
            {stateShown ? (
              <>
                <span aria-hidden="true">{" · "}</span>
                <span
                  data-row-pill=""
                  className={cn(
                    "truncate",
                    quiet
                      ? "text-muted-foreground"
                      : cn("font-medium", PILL_TEXT[tone]),
                  )}
                >
                  {pillText}
                </span>
              </>
            ) : null}
          </span>
        </div>
        {row.pending ? (
          <span
            data-pending-mark-narrow=""
            className="text-xs text-muted-foreground tablet:hidden"
          >
            {copy.PENDING[row.pending]}
          </span>
        ) : null}
        {stale ? (
          <span className="text-xs text-muted-foreground">{copy.STALE}</span>
        ) : null}
        {explain ? (
          <details className="text-xs text-muted-foreground">
            <summary className="min-h-11 leading-[44px]">
              {copy.WHY_AT(timeIn(instant as number, zone))}
            </summary>
            <p className="max-w-[560px] pb-2 leading-relaxed">
              {copy.WHY_BODY(data.slot.timezone)}
            </p>
          </details>
        ) : null}
      </div>
    </RailRow>
  );
}

/**
 * The recorder that comes out of a row's button (the Final design, revised 8 November 2026): for an amount, the field with its unit and
 * Record, in line with the tick; for a checklist, the items as pressed pills. It records the same evidence the task page does; nothing
 * is kept between visits (the task page keeps what is typed there).
 */
function RowRecorder({
  id,
  row,
  busy,
  onRecord,
  onClose,
}: {
  id: string;
  row: RowModel;
  busy: boolean;
  onRecord(evidence: Evidence, announce: string): Promise<void>;
  onClose(): void;
}) {
  const goal = row.data.definition.goal;
  const [amount, setAmount] = useState("");
  const [error, setError] = useState<string | null>(null);
  const field = useId();
  const first = useRef<HTMLInputElement>(null);
  // The recorder opened from the tick: its first field takes focus (the tick's expanded state announces it).
  useEffect(() => {
    first.current?.focus();
  }, []);
  const summary = row.personal.kind === "result" ? row.personal.action : null;
  if (goal.kind === "numeric")
    return (
      <form
        id={id}
        data-row-recorder="numeric"
        className="flex items-center gap-1.5"
        onSubmit={(event) => {
          event.preventDefault();
          const value = parseDecimalInput(amount);
          if (value === null) {
            setError(MESSAGES.amount);
            return;
          }
          void onRecord(
            { kind: "quantity", amount: value },
            copy.ANNOUNCE_SAVED,
          ).then(() => {
            setAmount("");
            onClose();
          });
        }}
      >
        <label htmlFor={field} className="sr-only">
          {copy.AMOUNT_LABEL(goal.unit)}
        </label>
        <span className="flex h-7 items-center rounded-full border border-input bg-background pl-2.5 pr-2 focus-within:border-ring">
          <input
            ref={first}
            id={field}
            inputMode="decimal"
            value={amount}
            placeholder="0"
            aria-invalid={error !== null}
            aria-describedby={error ? `${field}-error` : undefined}
            onChange={(event) => {
              setAmount(event.target.value);
              setError(null);
            }}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                onClose();
              }
            }}
            className="w-12 min-w-0 bg-transparent font-num text-[13px] text-foreground outline-none placeholder:text-muted-foreground"
          />
          <span className="text-xs text-muted-foreground">{goal.unit}</span>
        </span>
        {busy ? (
          <Button
            size="sm"
            disabled
            reason={copy.SAVING}
            className="h-7 rounded-full px-3 text-xs"
          >
            {copy.RECORD}
          </Button>
        ) : (
          <Button
            size="sm"
            variant="default"
            type="submit"
            className="h-7 rounded-full px-3 text-xs"
          >
            {copy.RECORD}
          </Button>
        )}
        {error ? (
          <span id={`${field}-error`} className="sr-only">
            {error}
          </span>
        ) : null}
      </form>
    );
  if (goal.kind === "checklist")
    return (
      <fieldset
        id={id}
        data-row-recorder="checklist"
        className="m-0 flex flex-wrap items-center justify-end gap-1.5 border-0 p-0"
      >
        <legend className="sr-only">{copy.TICK_ITEMS}</legend>
        {goal.items.map((item, index) => {
          const checked = summary?.checked.includes(item.id) ?? false;
          return (
            <Pill
              key={item.id}
              pressed={checked}
              disabled={busy}
              onClick={() =>
                void onRecord(
                  { kind: "checklist", item_id: item.id, complete: !checked },
                  copy.ANNOUNCE_SAVED,
                )
              }
              className="h-7 px-2.5 text-xs"
              {...(index === 0 ? { "data-first-item": "" } : {})}
            >
              {checked ? (
                <Check aria-hidden="true" className="size-3.5" />
              ) : null}
              {item.label}
            </Pill>
          );
        })}
      </fieldset>
    );
  return null;
}
