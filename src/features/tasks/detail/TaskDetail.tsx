import { Link, useNavigate } from "@tanstack/react-router";
import { useId, useState } from "react";
import { Button } from "../../../components/ui/button";
import { PageHeading } from "../../../components/ui/page-heading";
import { useDataEnv } from "../../../data";
import { ResourcePolicyEditor } from "../../sharing";
import { useTaskActions } from "../actions";
import * as copy from "../copy";
import { useTasksEnv } from "../env";
import { dayLabel, longDayLabel } from "../format";
import { reviseOccurrence } from "../model/commands";
import { correctionResult } from "../model/correction";
import { resolveWallTime } from "../model/time";
import { pillTone } from "../today/TodayRow";
import { ArchiveControl, ClosureControls, Participation } from "./Controls";
import {
  CORRECTION_COPY,
  CorrectionDialog,
  savedCorrection,
} from "./CorrectionDialog";
import { EntryHistory } from "./EntryHistory";
import { RecordCard } from "./RecordCard";
import { useTaskDetail } from "./useTaskDetail";

export const DETAIL_COPY = {
  back: "‹ Tasks",
  edit: "Edit task",
  editWait: "Wait for this task to finish syncing before editing it.",
  sharing: "Sharing",
  sharingWait: "Sharing can be changed once this task has synced.",
  sharingProgress: "Who sees my progress",
  absent: "This task isn't on this device.",
  loading: "Loading this task",
  day: "Day",
  undated: "No date",
  noOccurrence: "This task has no day to show yet.",
  sharingLine: "Who can see this is set in Sharing.",
} as const;

/** WF-TASK-01: the task detail for one occurrence (not the timer, prerequisite or streak blocks: WEB-10c). */
export function TaskDetail({
  taskId,
  occurrence,
  focusRecord,
}: {
  taskId: string;
  occurrence?: string;
  focusRecord?: boolean;
}) {
  const env = useTasksEnv();
  const data = useDataEnv();
  const navigate = useNavigate();
  const view = useTaskDetail(taskId, occurrence);
  const actions = useTaskActions();
  const [correcting, setCorrecting] = useState(false);
  const [sharing, setSharing] = useState<string | null>(null);
  const dayId = useId();
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const now = env.now();
  if (view.status === "loading")
    return (
      <p aria-busy="true" className="text-[13px] text-ink-2">
        {DETAIL_COPY.loading}
      </p>
    );
  if (view.task === null)
    return (
      <div className="flex flex-col gap-3" data-task-detail="absent">
        <p className="text-[13.5px] text-ink-2">{DETAIL_COPY.absent}</p>
      </div>
    );
  const { task, row } = view;
  const policyVersion = task.policy_version;
  const correctionConflict =
    row?.attention !== null &&
    row?.attention !== undefined &&
    row.attention.kind === "revise_occurrence" &&
    row.attention.status === "version_conflict"
      ? row.attention
      : null;
  const mine = correctionConflict
    ? savedCorrection(correctionConflict.local_id)
    : null;
  const progressIds = [
    ...view.progressRows.map((p) => p.id),
    ...(row && (row.streamPresent || row.streamPending)
      ? [row.progressId]
      : []),
  ];
  return (
    <article
      className="flex max-w-[760px] flex-col gap-6"
      data-task-detail={task.id}
    >
      <div className="flex flex-col gap-2">
        <Link
          to="/tasks"
          search={{}}
          className="atlas-transition inline-flex min-h-11 w-fit items-center text-[13px] text-ink-2 hover:text-ink-1"
        >
          {DETAIL_COPY.back}
        </Link>
        <div className="flex flex-wrap items-center gap-3">
          {row ? (
            <span
              data-detail-pill={row.pill}
              className={`rounded-round border px-2.5 py-0.5 text-[12px] text-ink-1 ${pillTone(row.pill)}`}
            >
              {copy.PILL[row.pill]}
              {row.personal.kind === "result" && row.personal.provisional
                ? ` (${copy.PROVISIONAL})`
                : ""}
            </span>
          ) : null}
          {row ? (
            <span className="text-[13px] text-ink-2">
              {row.data.slot.date === null
                ? DETAIL_COPY.undated
                : longDayLabel(row.data.slot.date)}
            </span>
          ) : null}
          {row?.pending ? (
            <span
              data-pending-mark={row.pending}
              className="text-[12px] text-ink-2"
            >
              {copy.PENDING[row.pending]}
            </span>
          ) : null}
        </div>
        <PageHeading>{task.label}</PageHeading>
        <p className="text-[13px] text-ink-2">{DETAIL_COPY.sharingLine}</p>
        {row ? (
          <p className="text-[13px] text-ink-2">
            {copy.CARRY[row.data.definition.carry].line}
          </p>
        ) : null}
        <div className="flex flex-wrap items-start gap-2">
          {policyVersion === undefined || !view.synced ? (
            <Button disabled reason={DETAIL_COPY.editWait}>
              {DETAIL_COPY.edit}
            </Button>
          ) : (
            <Link
              to="/tasks/$taskId/edit"
              params={{ taskId: task.id }}
              className="atlas-transition inline-flex min-h-11 items-center rounded-control border border-hairline-strong bg-raised px-4 text-[13.5px] text-ink-1 hover:bg-row-hover"
            >
              {DETAIL_COPY.edit}
            </Link>
          )}
          {row ? (
            <Button onClick={() => setCorrecting(true)}>
              {CORRECTION_COPY.open}
            </Button>
          ) : null}
          {view.synced ? (
            <Button onClick={() => setSharing(task.id)}>
              {DETAIL_COPY.sharing}
            </Button>
          ) : (
            <Button disabled reason={DETAIL_COPY.sharingWait}>
              {DETAIL_COPY.sharing}
            </Button>
          )}
          <ArchiveControl
            task={task}
            actions={actions}
            writable={env.writable}
            attention={view.outstanding.attention.some(
              (d) => d.kind === "archive" && d.index_targets.includes(task.id),
            )}
          />
        </div>
      </div>
      {view.occurrences.length > 1 ? (
        <div className="flex flex-col gap-1">
          <label htmlFor={dayId} className="text-[12px] font-medium text-ink-2">
            {DETAIL_COPY.day}
          </label>
          <select
            id={dayId}
            value={row?.id ?? ""}
            data-field-edge=""
            onChange={(event) =>
              void navigate({
                to: "/tasks/$taskId",
                params: { taskId: task.id },
                search: { occurrence: event.target.value },
                replace: true,
              })
            }
            className="min-h-11 max-w-[260px] rounded-control border border-field-edge bg-canvas px-3 text-[13.5px] text-ink-1"
          >
            {view.occurrences.map((o) => (
              <option key={o.id} value={o.id}>
                {o.data?.slot.date
                  ? dayLabel(o.data.slot.date)
                  : DETAIL_COPY.undated}
              </option>
            ))}
          </select>
        </div>
      ) : null}
      {view.unreadable ? (
        <p className="text-[13px] text-ink-2">{copy.UNREADABLE}</p>
      ) : row === null ? (
        <p className="text-[13px] text-ink-2" data-no-occurrence="">
          {DETAIL_COPY.noOccurrence}
        </p>
      ) : (
        <>
          {correctionConflict ? (
            <section
              data-correction-conflict=""
              className="flex flex-col gap-2 rounded-row border border-conflict-edge bg-conflict-tint p-3.5"
            >
              <h2 className="text-[14px] font-medium text-ink-1">
                {CORRECTION_COPY.conflictTitle}
              </h2>
              <p className="text-[13px] text-ink-1">
                {CORRECTION_COPY.current}:{" "}
                {row.data.slot.date
                  ? dayLabel(row.data.slot.date)
                  : DETAIL_COPY.undated}
                {mine
                  ? ` · ${CORRECTION_COPY.mine}: ${mine.state.date ? dayLabel(mine.state.date) : DETAIL_COPY.undated}`
                  : ""}
              </p>
              <div className="flex flex-wrap gap-2">
                {mine && env.writable ? (
                  <Button
                    variant="primary"
                    onClick={() => {
                      const outbox = data.outbox();
                      const result = correctionResult(row.data, mine.state);
                      if (outbox === null || !result.ok) return;
                      // The person's explicit act: their correction again, on the version now saved (never automatic).
                      void outbox.supersede(
                        correctionConflict.local_id,
                        reviseOccurrence(
                          {
                            occurrenceId: row.id,
                            current: row.data,
                            definition: result.definition,
                            date: result.date,
                            time: result.time,
                            progressIds,
                          },
                          resolveWallTime,
                        ),
                      );
                    }}
                  >
                    {CORRECTION_COPY.saveMine}
                  </Button>
                ) : null}
                <Button
                  onClick={() => {
                    void data.outbox()?.discard(correctionConflict.local_id);
                  }}
                >
                  {CORRECTION_COPY.discardMine}
                </Button>
              </div>
            </section>
          ) : null}
          <RecordCard
            row={row}
            actions={actions}
            now={now}
            zone={zone}
            writable={env.writable}
            focus={focusRecord === true}
          />
          <EntryHistory
            row={row}
            actions={actions}
            zone={zone}
            writable={env.writable}
          />
          <Participation
            row={row}
            joint={view.joint}
            progressRows={view.progressRows}
          />
          {row.streamPresent && view.synced ? (
            <span>
              <Button
                variant="quiet"
                onClick={() => setSharing(row.progressId)}
              >
                {DETAIL_COPY.sharingProgress}
              </Button>
            </span>
          ) : null}
          <ClosureControls
            row={row}
            actions={actions}
            writable={env.writable}
          />
          {correcting ? (
            <CorrectionDialog
              row={row}
              identity={env.identity}
              open
              onClose={() => setCorrecting(false)}
              actions={actions}
              progressIds={progressIds}
              writable={env.writable}
            />
          ) : null}
        </>
      )}
      {sharing !== null ? (
        <ResourcePolicyEditor
          resourceId={sharing}
          open
          onOpenChange={(open) => {
            if (!open) setSharing(null);
          }}
        />
      ) : null}
    </article>
  );
}
