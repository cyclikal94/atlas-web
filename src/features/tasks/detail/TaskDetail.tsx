import { Link, useNavigate } from "@tanstack/react-router";
import { ChevronRight } from "lucide-react";
import { useId, useState } from "react";
import { useAnnouncer } from "../../../components/ui/announcer";
import { Badge } from "../../../components/ui/badge";
import { Button } from "../../../components/ui/button";
import { GroupedSection } from "../../../components/ui/grouped";
import { Label } from "../../../components/ui/label";
import { NativeSelect } from "../../../components/ui/native-select";
import { PageActions } from "../../../components/ui/page-actions";
import { PageHeading } from "../../../components/ui/page-heading";
import {
  type DraftWithCommand,
  useDataEnv,
  useDraftWithCommand,
} from "../../../data";
import { PolicyEditorRecoveryHost, ResourcePolicyEditor } from "../../sharing";
import { useTaskActions } from "../actions";
import { CatchUpNotice } from "../catchup/CatchUpNotice";
import * as copy from "../copy";
import { useTasksEnv } from "../env";
import { dayLabel, longDayLabel, whoLabel } from "../format";
import { commandOf, reviseOccurrence } from "../model/commands";
import {
  type SubmittedCorrection,
  submittedCorrection,
} from "../model/correction";
import { resolveWallTime } from "../model/time";
import { editable } from "../reasons";
import { STREAK_COPY } from "../streak/StreakPage";
import { pillTone } from "../today/TodayRow";
import type { RowModel } from "../view";
import { ArchiveControl, ClosureControls, Participation } from "./Controls";
import {
  CORRECTION_COPY,
  CorrectionDialog,
  CorrectionRecoveryHost,
} from "./CorrectionDialog";
import { DayWork } from "./DayWork";
import { EntryHistory } from "./EntryHistory";
import { ROTA_COPY, RotaPanel } from "./Rota";
import { useTaskDetail } from "./useTaskDetail";

export const DETAIL_COPY = {
  back: "‹ Tasks",
  edit: "Edit task",
  editWait: "Wait for this task to finish syncing before editing it.",
  editDenied: "You can't edit this task",
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
  daysFailed: "Couldn't read this task's saved days.",
  sharingLine: "Who can see this is set in Sharing.",
} as const;

/** The detail could not be read whole (R9, revision 4): what it says, with Try again. Unknown is never "isn't on this device". */
function ReadError({
  error,
  stale,
  retry,
}: {
  error: "failed" | "unstable";
  stale: boolean;
  retry(): void;
}) {
  return (
    <div
      className="flex flex-col gap-2"
      {...(stale
        ? { "data-detail-row-stale": error }
        : { "data-detail-row-error": error })}
    >
      <p
        className={
          stale
            ? "text-xs text-muted-foreground"
            : "text-sm text-muted-foreground"
        }
      >
        {error === "unstable" ? copy.LOCAL_UNSTABLE : copy.LOCAL_FAILED}
        {stale ? ` ${copy.SHOWING_LAST_READ}` : ""}
      </p>
      <span>
        <Button onClick={retry}>{copy.TRY_AGAIN}</Button>
      </span>
    </div>
  );
}

/** WF-TASK-01: the task detail for one occurrence, with WEB-10c's "What needs doing first", timer, streak link and rota blocks. */
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
  const navigate = useNavigate();
  const view = useTaskDetail(taskId, occurrence);
  const actions = useTaskActions();
  // The day the correction dialog was opened for (revision 2): it never follows another day under the person.
  const [correcting, setCorrecting] = useState<string | null>(null);
  const [sharing, setSharing] = useState<string | null>(null);
  // "Show this task's days" chose the default day in place (DA19-I1): its control is gone, so the day's record card takes focus.
  const [choseAgain, setChoseAgain] = useState(false);
  const dayId = useId();
  const rotaId = useId();
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
      <p aria-busy="true" className="text-sm text-muted-foreground">
        {DETAIL_COPY.loading}
      </p>
    );
  if (view.status === "error" && view.readError !== null)
    return (
      <div className="flex flex-col gap-3" data-task-detail="error">
        <ReadError error={view.readError} stale={false} retry={view.retry} />
      </div>
    );
  if (view.task === null)
    return (
      <div className="flex flex-col gap-3" data-task-detail="absent">
        <p className="text-sm text-muted-foreground">{DETAIL_COPY.absent}</p>
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
      className="atlas-enter flex max-w-[760px] flex-col gap-6"
      data-task-detail={task.id}
    >
      <div className="flex flex-col gap-2">
        {/* On the phone the shell's header carries the way back (`shell/mobile-back.ts`). */}
        <Link
          to="/tasks"
          search={{}}
          className="atlas-transition inline-flex min-h-11 w-fit items-center text-sm font-medium text-muted-foreground hover:text-primary max-tablet:hidden"
        >
          {DETAIL_COPY.back}
        </Link>
        <div className="flex flex-wrap items-center gap-3">
          {row ? (
            <Badge data-detail-pill={row.pill} variant={pillTone(row.pill)}>
              {copy.PILL[row.pill]}
              {row.personal.kind === "result" && row.personal.provisional
                ? ` (${copy.PROVISIONAL})`
                : ""}
            </Badge>
          ) : null}
          {row ? (
            <span
              className="text-sm text-muted-foreground"
              data-detail-day={row.data.slot.date ?? ""}
            >
              {row.data.slot.date === null
                ? DETAIL_COPY.undated
                : longDayLabel(row.data.slot.date)}
            </span>
          ) : null}
          {row?.pending ? (
            <span
              data-pending-mark={row.pending}
              className="text-xs text-muted-foreground"
            >
              {copy.PENDING[row.pending]}
            </span>
          ) : null}
        </div>
        <PageHeading>{task.label}</PageHeading>
        <p className="text-sm text-muted-foreground">
          {DETAIL_COPY.sharingLine}
        </p>
        {row ? (
          <p className="text-sm text-muted-foreground">
            {copy.CARRY[row.data.definition.carry].line}
          </p>
        ) : null}
        <PageActions data-task-actions="">
          {!editable(task, view.execution) ? (
            <Button disabled reason={DETAIL_COPY.editDenied}>
              {DETAIL_COPY.edit}
            </Button>
          ) : policyVersion === undefined || !view.synced ? (
            <Button disabled reason={DETAIL_COPY.editWait}>
              {DETAIL_COPY.edit}
            </Button>
          ) : (
            <Button asChild variant="outline">
              <Link to="/tasks/$taskId/edit" params={{ taskId: task.id }}>
                {DETAIL_COPY.edit}
              </Link>
            </Button>
          )}
          {row === null ? null : row.canEdit ? (
            <Button onClick={() => setCorrecting(row.id)}>
              {CORRECTION_COPY.open}
            </Button>
          ) : (
            // A known denial of the occurrence withholds the correction (R30); an open dialog stays open and explains it.
            <Button disabled reason={CORRECTION_COPY.denied}>
              {CORRECTION_COPY.open}
            </Button>
          )}
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
        </PageActions>
      </div>
      {view.readError !== null ? (
        <ReadError error={view.readError} stale retry={view.retry} />
      ) : null}
      <CatchUpNotice
        key={task.id}
        taskId={task.id}
        title={task.label}
        day={row?.data.slot.date ?? undefined}
      />
      {view.occurrences.length > 1 ||
      view.days.more ||
      view.days.previous ||
      view.days.paged ||
      view.days.error !== null ? (
        <div className="flex flex-col gap-2" data-day-picker="">
          <Label htmlFor={dayId}>{DETAIL_COPY.day}</Label>
          <NativeSelect
            id={dayId}
            value={row?.id ?? ""}
            onChange={(event) =>
              void navigate({
                to: "/tasks/$taskId",
                params: { taskId: task.id },
                search: { occurrence: event.target.value },
                replace: true,
              })
            }
            className="max-w-[260px]"
          >
            {row === null ? <option value="" /> : null}
            {view.occurrences.map((o) => (
              <option key={o.id} value={o.id}>
                {o.data?.slot.date
                  ? dayLabel(o.data.slot.date)
                  : DETAIL_COPY.undated}
              </option>
            ))}
          </NativeSelect>
          {view.days.error !== null ? (
            <span
              className="flex flex-wrap items-center gap-2"
              data-day-picker-error={view.days.error}
            >
              <span className="text-xs text-muted-foreground">
                {DETAIL_COPY.daysFailed}
              </span>
              <Button variant="ghost" onClick={view.days.retry}>
                {copy.TRY_AGAIN}
              </Button>
            </span>
          ) : null}
          {view.days.more || view.days.previous ? (
            <span className="flex flex-wrap gap-2">
              {view.days.previous ? (
                <Button variant="ghost" onClick={view.days.showPrevious}>
                  {DETAIL_COPY.previousDays}
                </Button>
              ) : null}
              {view.days.more ? (
                <Button variant="ghost" onClick={view.days.showMore}>
                  {DETAIL_COPY.moreDays}
                </Button>
              ) : null}
            </span>
          ) : null}
        </div>
      ) : null}
      {view.selection === "loading" ? (
        <p aria-busy="true" className="text-sm text-muted-foreground">
          {DETAIL_COPY.dayLoading}
        </p>
      ) : view.selection === "unavailable" ? (
        <div className="flex flex-col gap-2" data-day-unavailable="">
          <p className="text-sm text-muted-foreground">
            {DETAIL_COPY.dayUnavailable}
          </p>
          {view.lost ? (
            // The visit's own day is gone here (kept with input through a sync visit, DA19-I1, or shown by this visit, DA20-I1): this address
            // already names no day, so choose again in place.
            <span>
              <Button
                variant="ghost"
                onClick={() => {
                  setChoseAgain(true);
                  view.chooseAgain();
                }}
              >
                {DETAIL_COPY.showDays}
              </Button>
            </span>
          ) : (
            <Link
              to="/tasks/$taskId"
              params={{ taskId: task.id }}
              search={{}}
              className="atlas-transition inline-flex min-h-11 w-fit items-center text-sm text-muted-foreground hover:text-foreground"
            >
              {DETAIL_COPY.showDays}
            </Link>
          )}
        </div>
      ) : view.unreadable ? (
        <p className="text-sm text-muted-foreground">{copy.UNREADABLE}</p>
      ) : row === null ? (
        <p className="text-sm text-muted-foreground" data-no-occurrence="">
          {DETAIL_COPY.noOccurrence}
        </p>
      ) : (
        <>
          {correctionConflict ? (
            <CorrectionConflict
              key={`conflict:${correctionConflict.local_id}`}
              row={row}
              conflictId={correctionConflict.local_id}
              stored={stored}
              mine={mine}
              readable={conflictDraft.status === "ready"}
              newerShown={newerShown}
              progressIds={progressIds}
              writable={env.writable}
            />
          ) : null}
          <DayWork
            key={`day:${row.id}`}
            row={row}
            facts={<Facts row={row} taskId={task.id} me={env.accountId} />}
            actions={actions}
            now={view.now}
            zone={zone}
            writable={env.writable}
            focus={focusRecord === true || choseAgain}
            extra={
              // The rest of the day's reference, in the same box (the Final design, 8 November 2026): the turns, the entries, who is on
              // it and the day's closure, each a section on a hairline.
              <>
                {row.data.definition.participation === "anyone" ? (
                  <GroupedSection
                    aria-labelledby={rotaId}
                    data-rota-section=""
                    heading={<h2 id={rotaId}>{ROTA_COPY.heading}</h2>}
                  >
                    <RotaPanel
                      key={`rota:${task.id}`}
                      row={row}
                      canEditOrder={view.execution?.can_edit === true}
                      days={view.occurrences.flatMap((o) =>
                        o.data === null ? [] : [{ id: o.id, data: o.data }],
                      )}
                      definition={row.data.definition}
                    />
                  </GroupedSection>
                ) : null}
                <EntryHistory
                  key={`history:${row.id}`}
                  row={row}
                  actions={actions}
                  zone={zone}
                  writable={env.writable}
                  current={view.current}
                />
                <Participation
                  row={row}
                  joint={view.joint}
                  progressRows={view.progressRows}
                  sharing={
                    row.streamPresent && view.synced ? (
                      <span>
                        <Button
                          variant="ghost"
                          onClick={() => setSharing(row.progressId)}
                        >
                          {DETAIL_COPY.sharingProgress}
                        </Button>
                      </span>
                    ) : null
                  }
                />
                <ClosureControls
                  row={row}
                  actions={actions}
                  writable={env.writable}
                />
              </>
            }
          />
          {row.streamPresent && view.synced && sharing === null ? (
            // Revision 37 (WEB-14a R40): a sharing draft left by the page before an update reopens its editor.
            <PolicyEditorRecoveryHost
              identity={env.identity}
              resourceId={row.progressId}
              onOpen={setSharing}
            />
          ) : null}
          {correcting === null ? (
            // Revision 37 (WEB-14a R40): a correction left by the page before an update is restored and its dialog opened again.
            <CorrectionRecoveryHost
              key={`correction-recovery:${row.id}`}
              row={row}
              identity={env.identity}
              onRestored={setCorrecting}
            />
          ) : null}
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

/**
 * The facts strip (the Final design): the day, who takes part, how the task repeats, what happens when it is missed, and the way to its
 * streak, as short labelled cells over the day's work. A fact that is a decision or a reference lives in the grouped box below instead.
 */
function Facts({
  row,
  taskId,
  me,
}: {
  row: RowModel;
  taskId: string;
  me: string;
}) {
  const definition = row.data.definition;
  const cells: { key: string; label: string; value: string }[] = [
    {
      key: "day",
      label: copy.FACTS.day,
      value:
        row.data.slot.date === null
          ? DETAIL_COPY.undated
          : dayLabel(row.data.slot.date),
    },
    {
      key: "who",
      label: copy.FACTS.who,
      value:
        definition.participation === "personal"
          ? copy.PARTICIPATION.personal
          : `${copy.PARTICIPATION[definition.participation]} · ${whoLabel(row, me)}`,
    },
    {
      key: "repeat",
      label: copy.FACTS.repeat,
      value: copy.CADENCE(definition.schedule.repeat),
    },
    {
      key: "carry",
      label: copy.FACTS.carry,
      value: copy.CARRY[definition.carry].label,
    },
    {
      key: "goal",
      label: copy.FACTS.goal,
      value: copy.GOAL_FACT(definition.goal),
    },
  ];
  const cell =
    "flex min-h-[72px] flex-col justify-center gap-1 bg-card px-4 py-3";
  const label =
    "text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground";
  return (
    <dl
      className="m-0 grid grid-cols-2 gap-px overflow-hidden rounded-[14px] border border-border bg-border tablet:grid-cols-3"
      data-task-facts=""
    >
      {cells.map((fact) => (
        <div key={fact.key} className={cell} data-fact={fact.key}>
          <dt className={label}>{fact.label}</dt>
          <dd className="m-0 text-sm font-medium text-foreground">
            {fact.value}
          </dd>
        </div>
      ))}
      <div className={cell} data-fact="streak">
        <dt className={label}>{copy.FACTS.streak}</dt>
        <dd className="m-0">
          <Link
            to="/tasks/$taskId/streak"
            params={{ taskId }}
            data-streak-link=""
            aria-label={STREAK_COPY.linkName}
            className="atlas-transition inline-flex min-h-11 items-center gap-0.5 text-sm font-medium text-foreground hover:text-primary hover:underline"
          >
            {STREAK_COPY.link}
            <ChevronRight aria-hidden="true" className="size-4" />
          </Link>
        </dd>
      </div>
    </dl>
  );
}

/**
 * A correction that met another one (version conflict), with the person's two choices. "Save mine on the current version" replaces the
 * SUBMITTED correction (its durable command, `stored`) with the same correction built in full on the version shown now (`reviewedBase`),
 * only while the queued operation is still the one read (`expectDraft`) and only while the occurrence may be corrected (R30: a known denial
 * withholds it here, and the writing transaction checks it again). The replacement's answer is awaited: only an actual supersession lets
 * the block go (it leaves with its draft); a refusal or a failure keeps the saved correction, its dependants and this block, and says why.
 */
function CorrectionConflict({
  row,
  conflictId,
  stored,
  mine,
  readable,
  newerShown,
  progressIds,
  writable,
}: {
  row: RowModel;
  conflictId: string;
  stored: DraftWithCommand | null;
  mine: SubmittedCorrection | null;
  /** The conflicted operation was read (so an unreadable one can be said to be). */
  readable: boolean;
  newerShown: boolean;
  progressIds: readonly string[];
  writable: boolean;
}) {
  const data = useDataEnv();
  const announcer = useAnnouncer();
  const [replacing, setReplacing] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const offered = mine !== null && stored !== null && newerShown && writable;
  const saveMine = async () => {
    // Admitted by this render's facts, whatever called it (R30).
    if (!offered || !row.canEdit || replacing) return;
    const outbox = data.outbox();
    if (outbox === null) return;
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
    setReplacing(true);
    setFailed(null);
    let outcome: Awaited<ReturnType<typeof outbox.supersede>> | null;
    try {
      outcome = await outbox.supersede(conflictId, {
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
    } catch {
      outcome = null;
    }
    setReplacing(false);
    if (outcome?.kind === "superseded") return;
    const reason = outcome?.kind === "refused" ? outcome.reason : "storage";
    const message =
      reason === "denied"
        ? CORRECTION_COPY.replaceDenied
        : reason === "draft_changed" || reason === "changed"
          ? CORRECTION_COPY.replaceChanged
          : reason === "closed" || reason === "identity_changed"
            ? null
            : (copy.refusalMessage(reason) ?? CORRECTION_COPY.replaceFailed);
    setFailed(message);
    if (message !== null) announcer.announce(message, "assertive");
  };
  return (
    <section
      data-correction-conflict=""
      className="flex flex-col gap-2 rounded-lg border border-destructive/35 bg-destructive/10 p-4"
    >
      <h2 className="text-sm font-semibold text-foreground">
        {CORRECTION_COPY.conflictTitle}
      </h2>
      <p className="text-sm text-foreground">
        {CORRECTION_COPY.current}:{" "}
        {row.data.slot.date
          ? dayLabel(row.data.slot.date)
          : DETAIL_COPY.undated}
        {mine
          ? ` · ${CORRECTION_COPY.mine}: ${mine.date ? dayLabel(mine.date) : DETAIL_COPY.undated}`
          : ""}
      </p>
      {mine === null && readable ? (
        <p className="text-xs text-muted-foreground">
          {CORRECTION_COPY.mineUnavailable}
        </p>
      ) : mine !== null && !newerShown ? (
        <p className="text-xs text-muted-foreground">
          {CORRECTION_COPY.waitingNewer}
        </p>
      ) : null}
      {failed !== null ? (
        <p
          className="text-xs text-muted-foreground"
          data-correction-replace-failed=""
        >
          {failed}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {!offered ? null : !row.canEdit ? (
          <Button disabled reason={CORRECTION_COPY.denied}>
            {CORRECTION_COPY.saveMine}
          </Button>
        ) : replacing ? (
          <Button disabled reason={CORRECTION_COPY.replacing}>
            {CORRECTION_COPY.saveMine}
          </Button>
        ) : (
          <Button variant="default" onClick={() => void saveMine()}>
            {CORRECTION_COPY.saveMine}
          </Button>
        )}
        <Button
          onClick={() => {
            void data.outbox()?.discard(conflictId);
          }}
        >
          {CORRECTION_COPY.discardMine}
        </Button>
      </div>
    </section>
  );
}
