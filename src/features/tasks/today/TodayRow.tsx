import { Link } from "@tanstack/react-router";
import { AlertTriangle, Check, Minus } from "lucide-react";
import { useId, useState } from "react";
import { Badge, type BadgeVariant } from "../../../components/ui/badge";
import { Button } from "../../../components/ui/button";
import type { TaskActions } from "../actions";
import * as copy from "../copy";
import { dayLabel, whoLabel } from "../format";
import { dateIn, gapShifted, timeIn } from "../model/time";
import { recordBlock } from "../reasons";
import type { RowModel } from "../view";

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

/** The row's leading glyph, decorative: the pill's words carry the state. */
function RowGlyph({ pill }: { pill: RowModel["pill"] }) {
  const base = "flex size-6 flex-none items-center justify-center rounded-full";
  switch (pill) {
    case "done":
    case "done_late":
      return (
        <span
          aria-hidden="true"
          className={`${base} bg-success/12 text-success`}
        >
          <Check className="size-3.5" strokeWidth={2.5} />
        </span>
      );
    case "missed":
      return (
        <span
          aria-hidden="true"
          className={`${base} bg-warning/12 text-warning`}
        >
          <Minus className="size-3.5" strokeWidth={2.5} />
        </span>
      );
    case "conflict":
      return (
        <span
          aria-hidden="true"
          className={`${base} bg-destructive/12 text-destructive`}
        >
          <AlertTriangle className="size-3.5" strokeWidth={2.25} />
        </span>
      );
    default:
      return (
        <span
          aria-hidden="true"
          className={`${base} border-[1.5px] border-input`}
        />
      );
  }
}

/**
 * One Today row (WF-TODAY-01): time, title (a link to the task for this day), my state with any pending mark, the carry consequence, who
 * takes part, and the quick action. "Mark done" records in place for a checkbox goal; anything else is recorded on the task (D-10a-12).
 * A disabled action states why beside it.
 */
export function TodayRow({
  row,
  day,
  zone,
  now,
  actions,
  writable,
  me,
}: {
  me: string;
  row: RowModel;
  day: string;
  zone: string;
  now: number;
  actions: Pick<TaskActions, "record">;
  writable: boolean;
}) {
  const titleId = useId();
  const [busy, setBusy] = useState(false);
  const { data } = row;
  const instant = data.slot.instant;
  const overdue =
    (instant !== null && dateIn(instant, zone) < day) ||
    (instant === null && data.slot.date !== null && data.slot.date < day);
  const when =
    instant !== null && dateIn(instant, zone) === day
      ? timeIn(instant, zone)
      : overdue
        ? copy.FROM_DAY(
            dayLabel(
              instant !== null
                ? dateIn(instant, zone)
                : (data.slot.date as string),
            ),
          )
        : copy.GROUPS.any;
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
  const reason = recordBlock(row, now, zone, writable);
  const done = row.outcome === "complete";
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
  return (
    <li
      aria-labelledby={titleId}
      data-today-row={row.id}
      data-pill={row.pill}
      data-source={row.source}
      data-structure={row.structureFrom}
      data-version={row.version}
      data-can-edit={row.canEdit ? "true" : "false"}
      className="atlas-transition -mx-4 flex list-none flex-col gap-2 border-b border-border px-4 py-3.5 last:border-b-0 hover:bg-accent tablet:flex-row tablet:items-center tablet:gap-4"
    >
      <span className="flex items-center gap-3 tablet:w-32 tablet:flex-none">
        <RowGlyph pill={row.pill} />
        <span className="font-num text-xs text-muted-foreground">{when}</span>
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <Link
          id={titleId}
          to="/tasks/$taskId"
          params={{ taskId: row.taskId }}
          search={{ occurrence: row.id }}
          className={`atlas-transition truncate text-sm font-medium hover:text-primary ${
            row.outcome === "complete"
              ? "text-muted-foreground"
              : "text-foreground"
          }`}
        >
          {row.title ?? copy.UNTITLED}
        </Link>
        <span className="text-xs text-muted-foreground">
          {copy.PARTICIPATION[participation]}
          {participation === "personal" ? "" : ` · ${whoLabel(row, me)}`}
          {" · "}
          {copy.CARRY[data.definition.carry].line}
        </span>
        {stale ? (
          <span className="text-xs text-muted-foreground">{copy.STALE}</span>
        ) : null}
        {explain ? (
          <details className="text-xs text-muted-foreground">
            <summary className="min-h-11">
              {copy.WHY_AT(timeIn(instant as number, zone))}
            </summary>
            <p className="mt-0.5 max-w-[560px] leading-relaxed">
              {copy.WHY_BODY(data.slot.timezone)}
            </p>
          </details>
        ) : null}
      </div>
      <span className="flex flex-none flex-col items-start gap-0.5">
        <Badge data-row-pill="" variant={pillTone(row.pill)}>
          {pillText}
        </Badge>
        {row.pending ? (
          <span
            data-pending-mark={row.pending}
            className="text-xs text-muted-foreground"
          >
            {copy.PENDING[row.pending]}
          </span>
        ) : null}
      </span>
      <span className="flex-none">
        {data.definition.goal.kind === "checkbox" ? (
          reason !== null ? (
            <Button disabled reason={reason} aria-describedby={titleId}>
              {done ? copy.MARK_NOT_DONE : copy.MARK_DONE}
            </Button>
          ) : busy ? (
            <Button disabled reason={copy.SAVING}>
              {done ? copy.MARK_NOT_DONE : copy.MARK_DONE}
            </Button>
          ) : (
            <Button
              variant={done ? "outline" : "default"}
              aria-describedby={titleId}
              onClick={() => void mark(!done)}
            >
              {done ? copy.MARK_NOT_DONE : copy.MARK_DONE}
            </Button>
          )
        ) : data.definition.goal.kind === "numeric" ? (
          <Button asChild variant="outline" aria-describedby={titleId}>
            <Link
              to="/tasks/$taskId"
              params={{ taskId: row.taskId }}
              search={{ occurrence: row.id, record: true }}
            >
              {copy.RECORD}
            </Link>
          </Button>
        ) : null}
      </span>
    </li>
  );
}
