import { useEffect, useRef, useState } from "react";
import { Button } from "../../../components/ui/button";
import { TASK_SEQUENCE_ROWS, type TaskSequences } from "../../../data";
import * as copy from "../copy";
import { useTasksEnv } from "../env";
import { dayLabel } from "../format";
import {
  CATCH_UP_COPY,
  reasonText,
  recoveryRows,
  stopsFor,
} from "../today/CatchUpBanner";
import { useCatchUp } from "./useCatchUp";

/**
 * A task's stopped catch-up on its own detail (review R8; WEB-04 §5.8): a command of the task refused with `materialisation_required`
 * waits for the catch-up, and when the sequence STOPS (the bound, no progress, the horizon, capacity, a refusal, no answer) the person sees
 * it here, where the waiting command is, with its reason and "Try again" (the same act as Today's banner: a fresh budget from the position
 * reached). Nothing is shown while no stop stands. No live region: the banner announces stops on Today, and this repeats a durable state.
 *
 * Revision 5 (review R24): every retained stop of the task is reachable here, each for its own day (the task's today, and its latest days
 * as read), so a later day's stop never hides the one a waiting command needs; each "Try again" names its own stop.
 *
 * Revision 6 (review R28): the latest days are a bounded window, never "every stop". The selected day (`day`) and the days a command
 * asked this page's runner for are read by their own keys whatever the window holds; and while the task holds more days than were read,
 * "Show earlier days" reads that many more (one read of the latest rows, so the window never has a gap), until every retained day is
 * shown, each with its own Try again. Shown even when no stop is in the window: an earlier one may be.
 */
export function CatchUpNotice({
  taskId,
  title,
  day,
}: {
  taskId: string;
  title: string;
  /** The day the detail shows (its occurrence's date), looked up by key. */
  day?: string | undefined;
}) {
  const env = useTasksEnv();
  const [rows, setRows] = useState(TASK_SEQUENCE_ROWS);
  const { runner, state, records, todayOf, discovery } = useCatchUp([taskId], {
    days: day === undefined ? [] : [day],
    rows,
  });
  // While a longer window is read, the shorter one stays shown (nothing it held is withdrawn, nor is it called complete).
  const last = useRef<TaskSequences | undefined>(undefined);
  const read =
    records.status === "ready" ? records.value.get(taskId) : undefined;
  if (records.status === "ready") last.current = read;
  const found = records.status === "ready" ? read : last.current;
  const stops = stopsFor(
    taskId,
    recoveryRows(found, todayOf(taskId), true),
    state,
    discovery,
  );
  const more = found !== undefined && !found.complete;
  // "Show earlier days" leaves once every day is shown: the notice keeps the focus, never the page's body.
  const notice = useRef<HTMLDivElement>(null);
  const asked = useRef(false);
  useEffect(() => {
    if (!more && asked.current) {
      asked.current = false;
      notice.current?.focus();
    }
  }, [more]);
  if (stops.length === 0 && !more) return null;
  const reachable = env.online && env.writable;
  return (
    <div
      ref={notice}
      tabIndex={-1}
      className="flex flex-col gap-2 outline-none"
      data-catch-up-notice={taskId}
    >
      {stops.map((stop) => (
        <div
          key={stop.throughDate ?? ""}
          className="flex flex-col gap-1 rounded-row border border-hairline-strong bg-raised px-3.5 py-2.5"
          data-catch-up-stopped={stop.reason}
          data-catch-up-task={taskId}
          data-catch-up-day={stop.throughDate}
        >
          <p className="text-[13px] font-medium text-ink-1">
            {CATCH_UP_COPY.stopped(title)}
          </p>
          {(stops.length > 1 || more) && stop.throughDate !== undefined ? (
            <p className="text-[12.5px] text-ink-2">
              {CATCH_UP_COPY.forDay(dayLabel(stop.throughDate))}
            </p>
          ) : null}
          <p className="text-[12.5px] text-ink-2">{reasonText(stop)}</p>
          {stop.requestId ? (
            <p className="select-all font-num text-[12px] text-ink-2">
              {copy.REQUEST_ID(stop.requestId)}
            </p>
          ) : null}
          {reachable && stop.reason !== "horizon" ? (
            <span>
              <Button
                onClick={() =>
                  runner.tryAgain(taskId, stop.throughDate, stop.seen)
                }
              >
                {copy.TRY_AGAIN}
              </Button>
            </span>
          ) : null}
        </div>
      ))}
      {more ? (
        <div
          className="flex flex-col gap-1 rounded-row border border-hairline-strong bg-raised px-3.5 py-2.5"
          data-catch-up-more={taskId}
        >
          <p className="text-[12.5px] text-ink-2">{CATCH_UP_COPY.earlier}</p>
          <span>
            <Button
              onClick={() => {
                asked.current = true;
                setRows((n) => n + TASK_SEQUENCE_ROWS);
              }}
            >
              {CATCH_UP_COPY.showEarlier}
            </Button>
          </span>
        </div>
      ) : null}
    </div>
  );
}
