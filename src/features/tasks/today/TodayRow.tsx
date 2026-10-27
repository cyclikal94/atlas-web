import { Link } from "@tanstack/react-router";
import { useId, useState } from "react";
import type { BadgeVariant } from "../../../components/ui/badge";
import { Button } from "../../../components/ui/button";
import { cn } from "../../../lib/utils";
import type { TaskActions } from "../actions";
import * as copy from "../copy";
import { dayLabel, whoLabel } from "../format";
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

/**
 * One row on the rail (WF-TODAY-01): the time (or "all day"), the title (a link to the task for this day), who takes part and my state
 * in words with any pending mark, and the quick action as the tick at the end. "Mark done" records in place for a checkbox goal; anything
 * else is recorded on the task (D-10a-12). A disabled tick states why beside it. The same row draws the days ahead (`surface:
 * "upcoming"`), without the quick action and with the day in the time column where the section spans more than one day.
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
}) {
  const titleId = useId();
  const reasonId = useId();
  const [busy, setBusy] = useState(false);
  const { data } = row;
  const instant = data.slot.instant;
  const overdue =
    (instant !== null && dateIn(instant, zone) < day) ||
    (instant === null && data.slot.date !== null && data.slot.date < day);
  const timed = instant !== null && dateIn(instant, zone) === day;
  const time = timeText ?? (timed ? timeIn(instant, zone) : copy.ALL_DAY);
  const from = overdue
    ? copy.FROM_DAY(
        dayLabel(
          instant !== null ? dateIn(instant, zone) : (data.slot.date as string),
        ),
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
  const mark = async (complete: boolean) => {
    setBusy(true);
    try {
      await actions.record(
        row,
        { kind: "checkbox", complete },
        null,
        complete ? copy.ANNOUNCE_DONE : copy.ANNOUNCE_NOT_DONE,
      );
    } finally {
      setBusy(false);
    }
  };
  const pillText = `${copy.PILL[row.pill]}${provisional ? ` (${copy.PROVISIONAL})` : ""}`;
  const tone = pillTone(row.pill);
  const quiet = row.pill === "to_do" || row.pill === "on_track";
  // A day ahead is not open yet by definition: only a state that says more is written on its row.
  const stateShown = !(surface === "upcoming" && row.pill === "not_open");
  const tickLabel = done ? copy.MARK_NOT_DONE : copy.MARK_DONE;
  const tick = (disabled: string | null) => (
    <button
      type="button"
      aria-label={tickLabel}
      aria-describedby={disabled ? `${reasonId} ${titleId}` : titleId}
      disabled={disabled !== null}
      data-row-tick=""
      onClick={() => void mark(!done)}
      className="flex size-11 flex-none items-center justify-center rounded-full disabled:cursor-not-allowed disabled:opacity-50"
    >
      <TickGlyph done={done} />
    </button>
  );
  const quick =
    surface !== "today" ? null : data.definition.goal.kind === "checkbox" ? (
      reason !== null ? (
        <>
          <span
            id={reasonId}
            className="hidden max-w-[180px] truncate text-xs text-muted-foreground tablet:inline"
          >
            {reason}
          </span>
          {tick(reason)}
        </>
      ) : busy ? (
        <>
          <span id={reasonId} className="sr-only">
            {copy.SAVING}
          </span>
          {tick(copy.SAVING)}
        </>
      ) : (
        tick(null)
      )
    ) : data.definition.goal.kind === "numeric" ? (
      <Button
        asChild
        variant="outline"
        size="sm"
        className="rounded-full text-xs"
        aria-describedby={titleId}
      >
        <Link
          to="/tasks/$taskId"
          params={{ taskId: row.taskId }}
          search={{ occurrence: row.id, record: true }}
        >
          {copy.RECORD}
        </Link>
      </Button>
    ) : null;
  const idAttr =
    surface === "today"
      ? { "data-today-row": row.id }
      : { "data-upcoming-row": row.id };
  return (
    <RailRow
      aria-labelledby={titleId}
      {...idAttr}
      data-pill={row.pill}
      data-source={row.source}
      data-structure={row.structureFrom}
      data-version={String(row.version)}
      data-can-edit={row.canEdit ? "true" : "false"}
      time={time}
      past={past}
      compact={surface === "upcoming"}
      trailing={
        <span className="flex flex-none items-center gap-2">
          {row.pending ? (
            <span
              data-pending-mark={row.pending}
              className="hidden text-xs text-muted-foreground tablet:inline"
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
            to="/tasks/$taskId"
            params={{ taskId: row.taskId }}
            search={{ occurrence: row.id }}
            className={cn(
              "atlas-transition min-w-0 flex-1 truncate text-[15px] leading-6 hover:text-primary",
              done ? "text-muted-foreground line-through" : "text-foreground",
            )}
          >
            {row.title ?? copy.UNTITLED}
          </Link>
          <span className="flex min-w-0 items-baseline gap-1 text-xs text-muted-foreground tablet:max-w-[55%] tablet:flex-none">
            <span className="truncate">
              {copy.PARTICIPATION[participation]}
              {participation === "personal" ? "" : ` · ${whoLabel(row, me)}`}
              {from ? ` · ${from}` : ""}
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
