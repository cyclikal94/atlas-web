import { Link, useNavigate } from "@tanstack/react-router";
import { useId, useState } from "react";
import { Button } from "../../../components/ui/button";
import { PageHeading } from "../../../components/ui/page-heading";
import { useDataEnv, useDraftWithCommand } from "../../../data";
import { ResourcePolicyEditor } from "../../sharing";
import { useTaskActions } from "../actions";
import * as copy from "../copy";
import { useTasksEnv } from "../env";
import { dayLabel, longDayLabel } from "../format";
import { commandOf, reviseOccurrence } from "../model/commands";
import { submittedCorrection } from "../model/correction";
import { resolveWallTime } from "../model/time";
import { pillTone } from "../today/TodayRow";
import { ArchiveControl, ClosureControls, Participation } from "./Controls";
import { CORRECTION_COPY, CorrectionDialog } from "./CorrectionDialog";
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
  dayLoading: "Loading this day",
  dayUnavailable:
    "This day isn't saved on this device, or isn't one of this task's days. Nothing can be recorded for it here.",
  showDays: "Show this task's days",
  moreDays: "More saved days",
  previousDays: "Previous saved days",
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
  // The day the correction dialog was opened for (revision 2): it never follows another day under the person.
  const [correcting, setCorrecting] = useState<string | null>(null);
  const [sharing, setSharing] = useState<string | null>(null);
  const dayId = useId();
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  // A correction that met another one (version conflict): what the person submitted is read from the queued operation itself (revision 2,
  // C5), so the choice survives a reload, another tab and a second conflict of its own replacement.
  const conflictId =
    view.row?.attention?.kind === "revise_occurrence" &&
    view.row.attention.status === "version_conflict"
      ? view.row.attention.local_id
      : null;
  const conflictDraft = useDraftWithCommand(conflictId);
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
  const stored =
    correctionConflict !== null &&
    conflictDraft.status === "ready" &&
    conflictDraft.value !== null &&
    conflictDraft.value.local_id === correctionConflict.local_id &&
    conflictDraft.value.kind === "revise_occurrence" &&
    conflictDraft.value.status === "version_conflict"
      ? conflictDraft.value
      : null;
  const mine =
    stored === null || row === null
      ? null
      : submittedCorrection(commandOf(stored), row.id);
  // "Save mine on the current version" needs the version that defeated it on this device: until a version newer than the one the
  // operation was built on is shown, resending would only meet the same conflict again.
  const builtOn =
    stored === null || row === null ? undefined : stored.bases[row.id];
  const newerShown =
    row !== null && (builtOn === undefined || row.version > builtOn);
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
            <Button onClick={() => setCorrecting(row.id)}>
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
      {view.occurrences.length > 1 ||
      view.days.more ||
      view.days.previous ||
      view.days.paged ? (
        <div className="flex flex-col gap-1" data-day-picker="">
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
            {row === null ? <option value="" /> : null}
            {view.occurrences.map((o) => (
              <option key={o.id} value={o.id}>
                {o.data?.slot.date
                  ? dayLabel(o.data.slot.date)
                  : DETAIL_COPY.undated}
              </option>
            ))}
          </select>
          {view.days.more || view.days.previous ? (
            <span className="flex flex-wrap gap-2">
              {view.days.previous ? (
                <Button variant="quiet" onClick={view.days.showPrevious}>
                  {DETAIL_COPY.previousDays}
                </Button>
              ) : null}
              {view.days.more ? (
                <Button variant="quiet" onClick={view.days.showMore}>
                  {DETAIL_COPY.moreDays}
                </Button>
              ) : null}
            </span>
          ) : null}
        </div>
      ) : null}
      {view.selection === "loading" ? (
        <p aria-busy="true" className="text-[13px] text-ink-2">
          {DETAIL_COPY.dayLoading}
        </p>
      ) : view.selection === "unavailable" ? (
        <div className="flex flex-col gap-2" data-day-unavailable="">
          <p className="text-[13px] text-ink-2">{DETAIL_COPY.dayUnavailable}</p>
          <Link
            to="/tasks/$taskId"
            params={{ taskId: task.id }}
            search={{}}
            className="atlas-transition inline-flex min-h-11 w-fit items-center text-[13px] text-ink-2 hover:text-ink-1"
          >
            {DETAIL_COPY.showDays}
          </Link>
        </div>
      ) : view.unreadable ? (
        <p className="text-[13px] text-ink-2">{copy.UNREADABLE}</p>
      ) : row === null && view.rowError !== null ? (
        // Unknown is not "no day" (R9, revision 3): the day's saved inputs could not be read whole.
        <div
          className="flex flex-col gap-2"
          data-detail-row-error={view.rowError}
        >
          <p className="text-[13px] text-ink-2">
            {view.rowError === "unstable"
              ? copy.LOCAL_UNSTABLE
              : copy.LOCAL_FAILED}
          </p>
          <span>
            <Button onClick={view.retryRow}>{copy.TRY_AGAIN}</Button>
          </span>
        </div>
      ) : row === null ? (
        <p className="text-[13px] text-ink-2" data-no-occurrence="">
          {DETAIL_COPY.noOccurrence}
        </p>
      ) : (
        <>
          {view.rowError !== null ? (
            <p
              className="text-[12.5px] text-ink-2"
              data-detail-row-stale={view.rowError}
            >
              {view.rowError === "unstable"
                ? copy.LOCAL_UNSTABLE
                : copy.LOCAL_FAILED}{" "}
              {copy.SHOWING_LAST_READ}
            </p>
          ) : null}
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
                  ? ` · ${CORRECTION_COPY.mine}: ${mine.date ? dayLabel(mine.date) : DETAIL_COPY.undated}`
                  : ""}
              </p>
              {mine === null && conflictDraft.status === "ready" ? (
                <p className="text-[12.5px] text-ink-2">
                  {CORRECTION_COPY.mineUnavailable}
                </p>
              ) : mine !== null && !newerShown ? (
                <p className="text-[12.5px] text-ink-2">
                  {CORRECTION_COPY.waitingNewer}
                </p>
              ) : null}
              <div className="flex flex-wrap gap-2">
                {mine && stored && newerShown && env.writable ? (
                  <Button
                    variant="primary"
                    onClick={() => {
                      const outbox = data.outbox();
                      if (outbox === null) return;
                      // The person's explicit act: the correction they SUBMITTED (its durable command) again, built in full on the version
                      // they are shown now (`reviewedBase`), and only if the queued operation is still the one read (`expectDraft`).
                      const request = reviseOccurrence(
                        {
                          occurrenceId: row.id,
                          current: row.data,
                          definition: mine.definition,
                          date: mine.date,
                          time: mine.time,
                          progressIds,
                        },
                        resolveWallTime,
                      );
                      void outbox.supersede(correctionConflict.local_id, {
                        ...request,
                        targets: request.targets.map((target) =>
                          target.resourceId === row.id
                            ? { ...target, reviewedBase: row.version }
                            : target,
                        ),
                        expectDraft: (now) =>
                          now.local_id === stored.local_id &&
                          now.status === stored.status &&
                          now.command_digest === stored.command_digest,
                      });
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
            key={`record:${row.id}`}
            row={row}
            actions={actions}
            now={view.now}
            zone={zone}
            writable={env.writable}
            focus={focusRecord === true}
          />
          <EntryHistory
            key={`history:${row.id}`}
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
          {correcting === row.id ? (
            <CorrectionDialog
              key={`correction:${row.id}`}
              row={row}
              identity={env.identity}
              open
              onClose={() => setCorrecting(null)}
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
