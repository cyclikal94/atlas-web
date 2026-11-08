import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import { Check, ChevronRight, X } from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState } from "react";
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
import { Popover, PopoverHost } from "../../../components/ui/popover";
import {
  type DraftWithCommand,
  useDataEnv,
  useDraftWithCommand,
} from "../../../data";
import { cn } from "../../../lib/utils";
import { PolicyEditorRecoveryHost, ResourcePolicyEditor } from "../../sharing";
import { type TaskActions, useTaskActions } from "../actions";
import { CatchUpNotice } from "../catchup/CatchUpNotice";
import * as copy from "../copy";
import { useTasksEnv } from "../env";
import { dayLabel, longDayLabel, whoLabel } from "../format";
import { commandOf, reviseOccurrence } from "../model/commands";
import {
  type SubmittedCorrection,
  submittedCorrection,
} from "../model/correction";
import { prerequisitesOf, progressOf } from "../model/dependencies";
import { type MoveSeed, parseMove } from "../model/move";
import { addDays, resolveWallTime, timeIn, todayIn } from "../model/time";
import { isTimerGoal } from "../model/timers";
import { editable } from "../reasons";
import { STREAK_COPY } from "../streak/StreakPage";
import { TODAY_TITLE } from "../titles";
import { pillTone } from "../today/TodayRow";
import type { RowModel } from "../view";
import { AnchorSection, type AnchorStatus } from "./AnchorSection";
import { ClosureControls, CONTROLS_COPY, Participation } from "./Controls";
import {
  CORRECTION_COPY,
  CorrectionDialog,
  CorrectionRecoveryHost,
} from "./CorrectionDialog";
import { type DayHandles, DayWork } from "./DayWork";
import { DEPENDENCY_COPY, useLabels } from "./Dependencies";
import { EntryHistory } from "./EntryHistory";
import {
  CarryEditor,
  DayActs,
  DayEditor,
  EDITOR_COPY,
  RepeatEditor,
  type TaskRevision,
} from "./FactEditors";
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
  /** The select of the task's other saved days, beside its label. */
  day: "Showing",
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
  /** The "Follows" cell: what the day waits for, in a few words. */
  follows: {
    none: "Nothing",
    loading: "Checking…",
    offline: "When online",
    hidden: "Private",
    failed: "Couldn't check",
    of: (done: number, total: number) => `${done} of ${total}`,
  },
  /** The timer's cell leads to its section. */
  timerGo: "Open the timer",
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
  // The calendar anchor's status, for the strip's "Follows" cell, and its section, which the cell brings into view.
  const [anchorStatus, setAnchorStatus] = useState<AnchorStatus | null>(null);
  const anchorSection = useRef<HTMLElement | null>(null);
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
  // WEB-13b: "Review this move…" from a calendar review (`?move=`, read strictly here, never in the entry route): it opens the one-day
  // correction of the day the address names, with the proposed date and time as the initial values of a NEW session, once; then the value
  // leaves the address (replace), so Back, a reload or a later visit neither reopens nor refills it.
  const rawMove = useRouterState({
    select: (state) =>
      (state.location.search as Record<string, unknown> | undefined)?.move,
  });
  const [seed, setSeed] = useState<MoveSeed | null>(null);
  // The `move` value this screen has consumed (once each): a value the address still shows is never applied twice.
  const consumed = useRef<unknown>(undefined);
  const day = view.row;
  useEffect(() => {
    if (rawMove === undefined || rawMove === consumed.current) return;
    if (view.status === "loading" || view.selection === "loading") return;
    consumed.current = rawMove;
    const move = parseMove(rawMove);
    if (
      move !== null &&
      day !== null &&
      occurrence === day.id &&
      day.canEdit &&
      env.writable
    ) {
      setSeed(move);
      setCorrecting(day.id);
    }
    void navigate({
      to: "/tasks/$taskId",
      params: { taskId },
      search: occurrence === undefined ? {} : { occurrence },
      replace: true,
    });
  }, [
    rawMove,
    view.status,
    view.selection,
    day,
    occurrence,
    env.writable,
    navigate,
    taskId,
  ]);
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
  // The strip's short editors of the task (how it repeats, what happens if it is missed) revise the task as the form does, so they need
  // what a revision needs: an editable task and execution, synced, with its policy version known, on a device that may write.
  const revision: TaskRevision | null =
    editable(task, view.execution) &&
    view.synced &&
    policyVersion !== undefined &&
    view.execution !== null &&
    env.writable
      ? {
          taskId: task.id,
          executionId: view.execution.id,
          title: task.label,
          policyVersion,
        }
      : null;
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
        // The task's other saved days (a repeating task): "Showing" and the day's select on one quiet row, so the Day cell below is
        // the day's own fact and this row is the way to another day.
        <div
          className="flex flex-wrap items-center gap-x-3 gap-y-2"
          data-day-picker=""
        >
          <Label htmlFor={dayId} className="text-muted-foreground">
            {DETAIL_COPY.day}
          </Label>
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
              facts={(day) => (
                <Facts
                  row={row}
                  taskId={task.id}
                  me={env.accountId}
                  names={names}
                  synced={view.synced}
                  columns={embedded ? 2 : 4}
                  onSharing={() => setSharing(task.id)}
                  actions={actions}
                  now={view.now}
                  zone={zone}
                  progressIds={progressIds}
                  revision={revision}
                  canCorrect={row.canEdit && env.writable}
                  anchor={anchorStatus}
                  onAnchor={() => {
                    const node = anchorSection.current;
                    if (!node) return;
                    node.scrollIntoView?.({
                      block: "nearest",
                      behavior: "smooth",
                    });
                    node
                      .querySelector<HTMLElement>("button:not([disabled])")
                      ?.focus({ preventScroll: true });
                  }}
                  onCorrect={() => {
                    setSeed(null);
                    setCorrecting(row.id);
                  }}
                  day={day}
                />
              )}
              actions={actions}
              now={view.now}
              zone={zone}
              writable={env.writable}
              focus={focusRecord === true || choseAgain}
              rowActions={
                <>
                  {row.canEdit &&
                  env.writable &&
                  !row.data.resolved &&
                  row.outcome !== "complete" ? (
                    <DayActs
                      row={row}
                      now={view.now}
                      zone={zone}
                      progressIds={progressIds}
                      actions={actions}
                    />
                  ) : null}
                  {row.canEdit ? (
                    <Button
                      onClick={() => {
                        setSeed(null);
                        setCorrecting(row.id);
                      }}
                    >
                      {CORRECTION_COPY.open}
                    </Button>
                  ) : (
                    // A known denial of the occurrence withholds the correction (R30); an open dialog stays open and explains it.
                    <Button disabled reason={CORRECTION_COPY.denied}>
                      {CORRECTION_COPY.open}
                    </Button>
                  )}
                </>
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
                  {view.definition !== null ? (
                    <AnchorSection
                      task={task}
                      repeats={view.definition.schedule.repeat !== null}
                      canEdit={editable(task, view.execution)}
                      synced={view.synced}
                      onStatus={setAnchorStatus}
                      sectionRef={(node) => {
                        anchorSection.current = node;
                      }}
                    />
                  ) : null}
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
              onClose={() => {
                setCorrecting(null);
                setSeed(null);
              }}
              actions={actions}
              progressIds={progressIds}
              writable={env.writable}
              seed={seed}
            />
          ) : null}
        </>
      )}
      {view.definition !== null && row === null ? (
        // WEB-13b: the task's calendar anchor, after the day (a task that repeats on its own schedule has none). With a day shown it is a
        // section of the day's grouped box instead (the Final design: "Follows an event or a date").
        <AnchorSection
          task={task}
          repeats={view.definition.schedule.repeat !== null}
          canEdit={editable(task, view.execution)}
          synced={view.synced}
        />
      ) : null}
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
 * happens when it is missed, what it follows, the way to its streak, and who can see it. A short choice (the day and its time, the
 * repeat, the carry) opens as a popover under its cell and saves as it is chosen; an editor with consequences (sharing) opens as the
 * centred dialog; the timer's cell leads to its section and "Follows" to what needs doing first.
 */
type Editing = "day" | "repeat" | "carry" | null;

function Facts({
  row,
  taskId,
  me,
  names,
  synced,
  onSharing,
  columns = 3,
  actions,
  now,
  zone,
  progressIds,
  revision,
  canCorrect,
  onCorrect,
  anchor,
  onAnchor,
  day,
}: {
  /** The calendar anchor's status (a one-off task's "Follows"), once its section has said it. */
  anchor: AnchorStatus | null;
  /** Brings the anchor's section into view. */
  onAnchor(): void;
  row: RowModel;
  taskId: string;
  me: string;
  names: ReadonlyMap<string, string>;
  synced: boolean;
  onSharing(): void;
  columns?: 2 | 3 | 4;
  actions: TaskActions;
  now: number;
  zone: string;
  progressIds: readonly string[];
  /** What a revision of the task needs, or null while the task may not be revised from here. */
  revision: TaskRevision | null;
  /** This day may be corrected (R30) on a device that may write. */
  canCorrect: boolean;
  /** Opens the full correction dialog. */
  onCorrect(): void;
  day: DayHandles;
}) {
  const definition = row.data.definition;
  const turn = row.data.rota?.account_id ?? null;
  const people = row.data.participants.map((id) => ({
    id,
    name: id === me ? copy.WHO.you : (names.get(id) ?? anonymous(id)),
  }));
  const timer = isTimerGoal(row.data);
  const cadence = definition.schedule.repeat;
  const [editing, setEditing] = useState<Editing>(null);
  const close = useCallback(() => setEditing(null), []);
  const toggle = (which: Exclude<Editing, null>) =>
    setEditing((open) => (open === which ? null : which));
  const dayRef = useRef<HTMLButtonElement>(null);
  const repeatRef = useRef<HTMLButtonElement>(null);
  const carryRef = useRef<HTMLButtonElement>(null);
  // What the day waits for, in a few words (the dialog has the rest).
  const read = day.deps.read;
  const preview = read.kind === "ready" ? read.preview : null;
  const items = preview ? prerequisitesOf(preview, row.id) : [];
  const label = useLabels(items);
  const counts = preview ? progressOf(preview, row.id) : null;
  const follows =
    read.kind === "loading"
      ? { text: DETAIL_COPY.follows.loading, dot: undefined, aside: null }
      : read.kind === "offline"
        ? { text: DETAIL_COPY.follows.offline, dot: undefined, aside: null }
        : read.kind === "refused"
          ? { text: DETAIL_COPY.follows.hidden, dot: undefined, aside: null }
          : read.kind === "error" || counts === null
            ? { text: DETAIL_COPY.follows.failed, dot: undefined, aside: null }
            : counts.total === 0
              ? { text: DETAIL_COPY.follows.none, dot: undefined, aside: null }
              : counts.firstOpen === null
                ? {
                    text: DEPENDENCY_COPY.allDone,
                    dot: "success" as const,
                    aside: DETAIL_COPY.follows.of(counts.done, counts.total),
                  }
                : {
                    text: label(counts.firstOpen).title,
                    dot: "warning" as const,
                    aside: DETAIL_COPY.follows.of(counts.done, counts.total),
                  };
  const dayValue = (
    <span className="font-num">
      {row.data.slot.date === null
        ? DETAIL_COPY.undated
        : dayLabel(row.data.slot.date)}
    </span>
  );
  const timeValue =
    row.data.slot.intended_time === null ||
    row.data.slot.intended_time === undefined ? null : (
      <span className="font-num text-xs text-muted-foreground">
        {row.data.slot.intended_time.slice(0, 5)}
      </span>
    );
  const aside = (text: string) => (
    <span className="text-xs text-muted-foreground">{text}</span>
  );
  const chevron = (
    <ChevronRight
      aria-hidden="true"
      className="size-4 flex-none text-muted-foreground"
    />
  );
  return (
    <PopoverHost data-task-facts-host="">
      <FactsStrip data-task-facts="" columns={columns}>
        {canCorrect ? (
          <FactCell
            as="button"
            ref={dayRef}
            label={copy.FACTS.day}
            data-fact="day"
            pressed={editing === "day"}
            onClick={() => toggle("day")}
          >
            {dayValue}
            {timeValue}
          </FactCell>
        ) : (
          <FactCell label={copy.FACTS.day} data-fact="day">
            {dayValue}
            {timeValue}
          </FactCell>
        )}
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
        {cadence === null && anchor !== null ? (
          // A one-off task: what it follows (its calendar anchor) in place of "Once" (the Final design's "Follows").
          <FactCell
            as="button"
            label={copy.FACTS.follows}
            data-fact="anchor"
            data-anchor-fact={anchor.state}
            dot={anchor.attention ? "warning" : undefined}
            onClick={onAnchor}
          >
            <span>{anchor.text}</span>
            {chevron}
          </FactCell>
        ) : revision !== null && cadence !== null ? (
          <FactCell
            as="button"
            ref={repeatRef}
            label={copy.FACTS.repeat}
            data-fact="repeat"
            pressed={editing === "repeat"}
            onClick={() => toggle("repeat")}
          >
            <span>{copy.CADENCE(cadence)}</span>
          </FactCell>
        ) : (
          <FactCell label={copy.FACTS.repeat} data-fact="repeat">
            <span>{copy.CADENCE(cadence)}</span>
          </FactCell>
        )}
        {timer ? (
          <FactCell
            as="button"
            label={copy.FACTS.timer}
            data-fact="goal"
            onClick={day.timer}
            aria-label={DETAIL_COPY.timerGo}
          >
            <span>{copy.GOAL_FACT(definition.goal)}</span>
            {chevron}
          </FactCell>
        ) : (
          <FactCell label={copy.FACTS.goal} data-fact="goal">
            <span>{copy.GOAL_FACT(definition.goal)}</span>
          </FactCell>
        )}
        {revision !== null ? (
          <FactCell
            as="button"
            ref={carryRef}
            label={copy.FACTS.carry}
            data-fact="carry"
            pressed={editing === "carry"}
            onClick={() => toggle("carry")}
          >
            <span>{copy.CARRY[definition.carry].label}</span>
          </FactCell>
        ) : (
          <FactCell label={copy.FACTS.carry} data-fact="carry">
            <span>{copy.CARRY[definition.carry].label}</span>
          </FactCell>
        )}
        <FactCell
          as="button"
          label={copy.FACTS.needsFirst}
          data-fact="follows"
          data-follows={read.kind}
          dot={follows.dot}
          onClick={day.see}
        >
          <span>{follows.text}</span>
          {follows.aside === null ? null : aside(follows.aside)}
          {chevron}
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
          {chevron}
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
            {chevron}
          </FactCell>
        ) : (
          <FactCell label={copy.FACTS.seenBy} data-fact="seen-by">
            <span className="text-muted-foreground">
              {DETAIL_COPY.seenByWait}
            </span>
          </FactCell>
        )}
      </FactsStrip>
      {canCorrect ? (
        <Popover
          anchor={dayRef}
          open={editing === "day"}
          onClose={close}
          label={EDITOR_COPY.day.title}
          data-fact-editor="day"
        >
          <DayEditor
            row={row}
            now={now}
            zone={zone}
            progressIds={progressIds}
            actions={actions}
            onDone={close}
            onMore={() => {
              close();
              onCorrect();
            }}
          />
        </Popover>
      ) : null}
      {revision !== null && cadence !== null ? (
        <Popover
          anchor={repeatRef}
          open={editing === "repeat"}
          onClose={close}
          label={EDITOR_COPY.repeat.title}
          data-fact-editor="repeat"
        >
          <RepeatEditor
            definition={definition}
            cadence={cadence}
            revision={revision}
            actions={actions}
            onDone={close}
          />
        </Popover>
      ) : null}
      {revision !== null ? (
        <Popover
          anchor={carryRef}
          open={editing === "carry"}
          onClose={close}
          label={EDITOR_COPY.carry.title}
          data-fact-editor="carry"
        >
          <CarryEditor
            definition={definition}
            revision={revision}
            actions={actions}
            onDone={close}
          />
        </Popover>
      ) : null}
    </PopoverHost>
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
