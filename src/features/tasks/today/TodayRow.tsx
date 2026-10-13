import { Link } from "@tanstack/react-router";
import { useId, useState } from "react";
import { Button } from "../../../components/ui/button";
import type { TaskActions } from "../actions";
import * as copy from "../copy";
import { dayLabel } from "../format";
import { dateIn, gapShifted, timeIn } from "../model/time";
import { recordBlock } from "../reasons";
import type { RowModel } from "../view";

/** The pill's tone (never colour alone: the words say the state). */
export function pillTone(pill: RowModel["pill"]): string {
  switch (pill) {
    case "missed":
      return "border-missed-edge bg-missed-tint";
    case "conflict":
      return "border-conflict-edge bg-conflict-tint";
    default:
      return "border-hairline-strong bg-raised";
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
  const others = data.participants.filter((id) => id !== me).length;
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
      className="flex list-none flex-col gap-2 border-b border-hairline px-1 py-3 tablet:flex-row tablet:items-center tablet:gap-3"
    >
      <span className="w-24 flex-none text-[12.5px] tabular-nums text-ink-2">
        {when}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <Link
          id={titleId}
          to="/tasks/$taskId"
          params={{ taskId: row.taskId }}
          search={{ occurrence: row.id }}
          className="atlas-transition truncate text-[14px] font-medium text-ink-1"
        >
          {row.title ?? copy.UNTITLED}
        </Link>
        <span className="text-[12.5px] text-ink-2">
          {copy.PARTICIPATION[participation]}
          {participation === "personal"
            ? ""
            : ` · ${others === 0 ? "You" : `You and ${others} other${others === 1 ? "" : "s"}`}`}
          {" · "}
          {copy.CARRY[data.definition.carry].line}
        </span>
        {stale ? (
          <span className="text-[12px] text-ink-2">{copy.STALE}</span>
        ) : null}
        {explain ? (
          <details className="text-[12.5px] text-ink-2">
            <summary className="min-h-11">
              {copy.WHY_AT(timeIn(instant as number, zone))}
            </summary>
            <p className="mt-0.5 max-w-[560px] leading-[1.55]">
              {copy.WHY_BODY(data.slot.timezone)}
            </p>
          </details>
        ) : null}
      </div>
      <span className="flex flex-none flex-col items-start gap-0.5">
        <span
          data-row-pill=""
          className={`rounded-round border px-2.5 py-0.5 text-[12px] text-ink-1 ${pillTone(row.pill)}`}
        >
          {pillText}
        </span>
        {row.pending ? (
          <span
            data-pending-mark={row.pending}
            className="text-[11.5px] text-ink-2"
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
              variant={done ? "secondary" : "primary"}
              aria-describedby={titleId}
              onClick={() => void mark(!done)}
            >
              {done ? copy.MARK_NOT_DONE : copy.MARK_DONE}
            </Button>
          )
        ) : data.definition.goal.kind === "numeric" ? (
          <Link
            to="/tasks/$taskId"
            params={{ taskId: row.taskId }}
            search={{ occurrence: row.id, record: true }}
            aria-describedby={titleId}
            className="atlas-transition inline-flex min-h-11 items-center rounded-control border border-hairline-strong bg-raised px-4 text-[13.5px] text-ink-1 hover:bg-row-hover"
          >
            {copy.RECORD}
          </Link>
        ) : null}
      </span>
    </li>
  );
}
