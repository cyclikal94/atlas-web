import { Button } from "../../../components/ui/button";
import * as copy from "../copy";
import { useTasksEnv } from "../env";
import { CATCH_UP_COPY, stopFor } from "../today/CatchUpBanner";
import { useCatchUp } from "./useCatchUp";

/**
 * A task's stopped catch-up on its own detail (review R8; WEB-04 §5.8): a command of the task refused with `materialisation_required`
 * waits for the catch-up, and when the sequence STOPS (the bound, no progress, the horizon, capacity, a refusal, no answer) the person sees
 * it here, where the waiting command is, with its reason and "Try again" (the same act as Today's banner: a fresh budget from the position
 * reached). Nothing is shown while no stop stands. No live region: the banner announces stops on Today, and this repeats a durable state.
 */
export function CatchUpNotice({
  taskId,
  title,
}: {
  taskId: string;
  title: string;
}) {
  const env = useTasksEnv();
  const { runner, state, records, discovery } = useCatchUp([taskId]);
  const stop = stopFor(
    taskId,
    records.status === "ready" ? records.value : new Map(),
    state,
    discovery,
  );
  if (stop === null) return null;
  const reachable = env.online && env.writable;
  return (
    <div
      className="flex flex-col gap-1 rounded-row border border-hairline-strong bg-raised px-3.5 py-2.5"
      data-catch-up-stopped={stop.reason}
      data-catch-up-task={taskId}
    >
      <p className="text-[13px] font-medium text-ink-1">
        {CATCH_UP_COPY.stopped(title)}
      </p>
      <p className="text-[12.5px] text-ink-2">
        {CATCH_UP_COPY.reason[stop.reason]}
      </p>
      {stop.requestId ? (
        <p className="select-all font-num text-[12px] text-ink-2">
          {copy.REQUEST_ID(stop.requestId)}
        </p>
      ) : null}
      {reachable && stop.reason !== "horizon" ? (
        <span>
          <Button
            onClick={() => runner.tryAgain(taskId, stop.throughDate, stop.seen)}
          >
            {copy.TRY_AGAIN}
          </Button>
        </span>
      ) : null}
    </div>
  );
}
