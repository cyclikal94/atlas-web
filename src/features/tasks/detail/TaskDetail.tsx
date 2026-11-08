import { Link, useNavigate } from "@tanstack/react-router";
import { Check, ChevronRight, X } from "lucide-react";
import { useId, useState } from "react";
import { useLayoutMode } from "../../../app/shell/layout-mode";
import { ActionMenu, type MenuItem } from "../../../components/ui/action-menu";
import { useAnnouncer } from "../../../components/ui/announcer";
import { AvatarStack } from "../../../components/ui/avatar-stack";
import { Badge } from "../../../components/ui/badge";
import { Breadcrumb } from "../../../components/ui/breadcrumb";
import { Button } from "../../../components/ui/button";
import { FactCell, FactsStrip } from "../../../components/ui/facts-strip";
import { GroupedSection } from "../../../components/ui/grouped";
import { Label } from "../../../components/ui/label";
import { NativeSelect } from "../../../components/ui/native-select";
import { PageGrid } from "../../../components/ui/page-grid";
import { PageHeading } from "../../../components/ui/page-heading";
import {
  type DraftWithCommand,
  useDataEnv,
  useDraftWithCommand,
} from "../../../data";
import { cn } from "../../../lib/utils";
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
import { addDays, resolveWallTime, timeIn, todayIn } from "../model/time";
import { isTimerGoal } from "../model/timers";
import { editable } from "../reasons";
import { STREAK_COPY } from "../streak/StreakPage";
import { TODAY_TITLE } from "../titles";
import { pillTone } from "../today/TodayRow";
import type { RowModel } from "../view";
import { ClosureControls, CONTROLS_COPY, Participation } from "./Controls";
import {
  CORRECTION_COPY,
  CorrectionDialog,
  CorrectionRecoveryHost,
} from "./CorrectionDialog";
import { DayWork } from "./DayWork";
import { EntryHistory } from "./EntryHistory";
import { anonymous, ROTA_COPY, RotaPanel, useUsernames } from "./Rota";
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
  /** The "Seen by" cell of the facts strip (the Final design): it opens the sharing editor. */
  seenBy: "Who can see this",
  seenByWait: "Once synced",
  close: "Close",
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

/**
 * WF-TASK-01 on the Final design (8 November 2026): the breadcrumb, the title with its state glyph and one summary line, "More" for the
 * task's other acts, then the facts strip, the day's action row, the grouped box of the day's decisions and reference, with the activity
 * beside them on a wide screen (and in the box below it elsewhere). WEB-10c's "What needs doing first", timer, streak and rota blocks
 * keep their places in the box.
 */
export function TaskDetail({
  taskId,
  occurrence,
  focusRecord,
  embedded = false,
  onClose,
}: {
  taskId: string;
  occurrence?: string;
  focusRecord?: boolean;
  /** Drawn beside or over another page (the "How tasks open" setting): the breadcrumb gives way to a close control. */
  embedded?: boolean;
  onClose?(): void;
}) {
  const env = useTasksEnv();
  const navigate = useNavigate();
  const view = useTaskDetail(taskId, occurrence);
  const actions = useTaskActions();
  const mode = useLayoutMode();
  const names = useUsernames();
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
  const archiveAttention = view.outstanding.attention.some(
    (d) => d.kind === "archive" && d.index_targets.includes(task.id),
  );
  const date = row?.data.slot.date ?? null;
  const today = todayIn(zone, view.now);
  // The activity stands beside the day only where there is room for it: the desktop, and not inside a container beside another page.
  const wide = mode === "desktop" && !embedded;
  // The task's other acts (the Final design): behind "More", each with its reason when it is withheld.
  const menu: MenuItem[] = [
    !editable(task, view.execution)
      ? {
          label: DETAIL_COPY.edit,
          reason: DETAIL_COPY.editDenied,
          onSelect: () => undefined,
        }
      : policyVersion === undefined || !view.synced
        ? {
            label: DETAIL_COPY.edit,
            reason: DETAIL_COPY.editWait,
            onSelect: () => undefined,
          }
        : {
            kind: "link",
            label: DETAIL_COPY.edit,
            to: "/tasks/$taskId/edit",
            params: { taskId: task.id },
          },
    view.synced
      ? { label: DETAIL_COPY.sharing, onSelect: () => setSharing(task.id) }
      : {
          label: DETAIL_COPY.sharing,
          reason: DETAIL_COPY.sharingWait,
          onSelect: () => undefined,
        },
    ...(row?.streamPresent && view.synced
      ? [
          {
            label: DETAIL_COPY.sharingProgress,
            onSelect: () => setSharing(row.progressId),
          } satisfies MenuItem,
        ]
      : []),
    {
      kind: "link",
      label: STREAK_COPY.linkName,
      to: "/tasks/$taskId/streak",
      params: { taskId: task.id },
    },
    !env.writable || !task.can_edit
      ? {
          label: task.archived ? CONTROLS_COPY.restore : CONTROLS_COPY.archive,
          reason: !env.writable ? copy.NOT_WRITABLE : CONTROLS_COPY.noEdit,
          onSelect: () => undefined,
        }
      : {
          label: task.archived ? CONTROLS_COPY.restore : CONTROLS_COPY.archive,
          onSelect: () => void actions.archive(task.id, !task.archived),
          tone: task.archived ? "default" : "destructive",
        },
  ];
  const turn = row?.data.rota?.account_id ?? null;
  const summaryParts: string[] = [];
  if (row !== null) {
    const instant = row.data.slot.instant;
    const when =
      date === null
        ? DETAIL_COPY.undated
        : `${instant !== null ? timeIn(instant, zone) : copy.SUMMARY_LINE.anyTime} ${
            date === today
              ? copy.SUMMARY_LINE.today
              : date === addDays(today, 1)
                ? copy.SUMMARY_LINE.tomorrow
                : dayLabel(date)
          }`;
    summaryParts.push(when, copy.CADENCE(row.data.definition.schedule.repeat));
    const participation = row.data.definition.participation;
    if (participation === "personal")
      summaryParts.push(copy.SUMMARY_LINE.justYou);
    else if (turn !== null)
      summaryParts.push(
        turn === env.accountId
          ? copy.SUMMARY_LINE.yourTurn
          : copy.SUMMARY_LINE.theirTurn(names.get(turn) ?? anonymous(turn)),
      );
    else
      summaryParts.push(
        `${copy.PARTICIPATION[participation]} · ${whoLabel(row, env.accountId)}`,
      );
  }
  return (
    <article
      className="atlas-enter flex min-w-0 flex-col gap-5"
      data-task-detail={task.id}
      data-archive={task.archived ? "archived" : "active"}
    >
      {embedded ? null : (
        <Breadcrumb
          items={[
            {
              label: TODAY_TITLE,
              to: "/today",
              ...(date === null ? {} : { search: { day: date } }),
            },
          ]}
          current={date === null ? DETAIL_COPY.undated : longDayLabel(date)}
        />
      )}
      <header className="flex items-start gap-4" data-task-header="">
        <StateGlyph row={row} />
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <PageHeading as={embedded ? "h2" : "h1"}>{task.label}</PageHeading>
          <p
            className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground"
            data-task-summary=""
          >
            {row ? (
              <span data-detail-day={row.data.slot.date ?? ""}>
                {summaryParts.join(" · ")}
              </span>
            ) : null}
            {row ? (
              <Badge data-detail-pill={row.pill} variant={pillTone(row.pill)}>
                {copy.PILL[row.pill]}
                {row.personal.kind === "result" && row.personal.provisional
                  ? ` (${copy.PROVISIONAL})`
                  : ""}
              </Badge>
            ) : null}
            {task.archived ? (
              <Badge variant="muted">{CONTROLS_COPY.archivedTag}</Badge>
            ) : null}
            {row?.pending ? (
              <span data-pending-mark={row.pending} className="text-xs">
                {copy.PENDING[row.pending]}
              </span>
            ) : null}
          </p>
          {archiveAttention ? (
            <p className="text-xs text-destructive">
              {CONTROLS_COPY.archiveConflict}
            </p>
          ) : null}
        </div>
        <div className="flex flex-none items-center gap-1.5">
          <ActionMenu items={menu} data-task-more="" />
          {embedded && onClose ? (
            <button
              type="button"
              aria-label={DETAIL_COPY.close}
              data-task-close=""
              onClick={onClose}
              className="atlas-transition flex size-11 items-center justify-center rounded-[10px] text-muted-foreground hover:bg-accent hover:text-accent-foreground"
            >
              <X aria-hidden="true" className="size-[18px]" />
            </button>
          ) : null}
        </div>
      </header>
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
            wrapperClassName="w-auto"
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
          <PageGrid
            aside={
              wide ? (
                <EntryHistory
                  key={`history:${row.id}`}
                  row={row}
                  actions={actions}
                  zone={zone}
                  writable={env.writable}
                  current={view.current}
                  frame="aside"
                />
              ) : undefined
            }
          >
            <DayWork
              key={`day:${row.id}`}
              row={row}
              facts={
                <Facts
                  row={row}
                  taskId={task.id}
                  me={env.accountId}
                  names={names}
                  synced={view.synced}
                  columns={embedded ? 2 : 3}
                  onSharing={() => setSharing(task.id)}
                />
              }
              actions={actions}
              now={view.now}
              zone={zone}
              writable={env.writable}
              focus={focusRecord === true || choseAgain}
              rowActions={
                row.canEdit ? (
                  <Button onClick={() => setCorrecting(row.id)}>
                    {CORRECTION_COPY.open}
                  </Button>
                ) : (
                  // A known denial of the occurrence withholds the correction (R30); an open dialog stays open and explains it.
                  <Button disabled reason={CORRECTION_COPY.denied}>
                    {CORRECTION_COPY.open}
                  </Button>
                )
              }
              extra={
                // The rest of the day's reference, in the same box (the Final design): the turns, the entries (where there is no column
                // for them), who is on it and the day's closure, each a section on a hairline.
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
                  {wide ? null : (
                    <EntryHistory
                      key={`history:${row.id}`}
                      row={row}
                      actions={actions}
                      zone={zone}
                      writable={env.writable}
                      current={view.current}
                    />
                  )}
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
          </PageGrid>
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

/** The 40px state glyph beside the title (the Final design): filled with a tick once the day is done, an outline before. */
function StateGlyph({ row }: { row: RowModel | null }) {
  const done = row?.outcome === "complete";
  return (
    <span
      aria-hidden="true"
      data-task-glyph={done ? "done" : "open"}
      className={cn(
        "mt-1 flex size-10 flex-none items-center justify-center rounded-full border-2",
        done
          ? "border-success bg-success text-success-foreground"
          : row === null
            ? "border-dashed border-input"
            : "border-input",
      )}
    >
      {done ? <Check className="size-5" strokeWidth={3} /> : null}
    </span>
  );
}

/**
 * The facts strip (the Final design): the day, who takes part (or whose turn it is), how the task repeats, what it measures, what
 * happens when it is missed, the way to its streak, and who can see it (the sharing editor opens from the cell, as every editor with
 * consequences does). A fact that is a decision or a reference lives in the grouped box below instead.
 */
function Facts({
  row,
  taskId,
  me,
  names,
  synced,
  onSharing,
  columns = 3,
}: {
  row: RowModel;
  taskId: string;
  me: string;
  names: ReadonlyMap<string, string>;
  synced: boolean;
  onSharing(): void;
  columns?: 2 | 3;
}) {
  const definition = row.data.definition;
  const turn = row.data.rota?.account_id ?? null;
  const people = row.data.participants.map((id) => ({
    id,
    name: id === me ? copy.WHO.you : (names.get(id) ?? anonymous(id)),
  }));
  const timer = isTimerGoal(row.data);
  return (
    <FactsStrip data-task-facts="" columns={columns}>
      <FactCell label={copy.FACTS.day} data-fact="day">
        <span className="font-num">
          {row.data.slot.date === null
            ? DETAIL_COPY.undated
            : dayLabel(row.data.slot.date)}
        </span>
      </FactCell>
      <FactCell
        label={turn !== null ? copy.FACTS.turn : copy.FACTS.who}
        data-fact="who"
      >
        {definition.participation === "personal" ? (
          <span>{copy.PARTICIPATION.personal}</span>
        ) : (
          <>
            {people.length > 0 ? (
              <AvatarStack
                people={people}
                {...(turn !== null ? { highlight: turn } : {})}
              />
            ) : null}
            <span>
              {turn !== null
                ? turn === me
                  ? copy.WHO.you
                  : (names.get(turn) ?? anonymous(turn))
                : `${copy.PARTICIPATION[definition.participation]} · ${whoLabel(row, me)}`}
            </span>
          </>
        )}
      </FactCell>
      <FactCell label={copy.FACTS.repeat} data-fact="repeat">
        <span>{copy.CADENCE(definition.schedule.repeat)}</span>
      </FactCell>
      <FactCell
        label={timer ? copy.FACTS.timer : copy.FACTS.goal}
        data-fact="goal"
      >
        <span>{copy.GOAL_FACT(definition.goal)}</span>
      </FactCell>
      <FactCell label={copy.FACTS.carry} data-fact="carry">
        <span>{copy.CARRY[definition.carry].label}</span>
      </FactCell>
      <FactCell
        as="link"
        label={copy.FACTS.streak}
        data-fact="streak"
        data-streak-link=""
        to="/tasks/$taskId/streak"
        params={{ taskId }}
        aria-label={STREAK_COPY.linkName}
      >
        <span>{STREAK_COPY.link}</span>
        <ChevronRight
          aria-hidden="true"
          className="size-4 flex-none text-muted-foreground"
        />
      </FactCell>
      {synced ? (
        <FactCell
          as="button"
          label={copy.FACTS.seenBy}
          data-fact="seen-by"
          onClick={onSharing}
          aria-label={DETAIL_COPY.seenBy}
        >
          <span>{DETAIL_COPY.seenBy}</span>
          <ChevronRight
            aria-hidden="true"
            className="size-4 flex-none text-muted-foreground"
          />
        </FactCell>
      ) : (
        <FactCell label={copy.FACTS.seenBy} data-fact="seen-by">
          <span className="text-muted-foreground">
            {DETAIL_COPY.seenByWait}
          </span>
        </FactCell>
      )}
    </FactsStrip>
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
