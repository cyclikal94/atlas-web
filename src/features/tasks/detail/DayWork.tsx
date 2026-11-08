import { type ReactNode, useState } from "react";
import { GroupedBox } from "../../../components/ui/grouped";
import type { DraftWithCommand } from "../../../data";
import type { TaskActions } from "../actions";
import { useTasksEnv } from "../env";
import type { Evidence } from "../model/contract";
import type { Mode } from "../model/dependencies";
import { isTimerGoal } from "../model/timers";
import type { RowModel } from "../view";
import {
  CompletionConflict,
  DependencyDialog,
  DependencyEditor,
  DependencyEditorRecoveryHost,
  DependencyRow,
  gateOf,
  type RootEvidence,
  SetConflict,
  UnmetConflict,
  useDependencies,
} from "./Dependencies";
import { RecordCard } from "./RecordCard";
import { TimerBlock } from "./Timer";

/**
 * The day's work on the detail, in the design's order (WF-TASK-01): the record card, "What needs doing first" and the timer (WEB-10c), with the
 * conflict blocks of this day's dependency and completion drafts above them. The preview is read once per day shown and shared by the
 * row, the record card's gate, the dialog and the conflict blocks.
 */
export function DayWork({
  row,
  actions,
  now,
  zone,
  writable,
  focus,
  extra,
}: {
  row: RowModel;
  actions: TaskActions;
  now: number;
  zone: string;
  writable: boolean;
  focus: boolean;
  /** More sections of the day's grouped box (the rota, when the task takes turns). */
  extra?: ReactNode;
}) {
  const env = useTasksEnv();
  const deps = useDependencies(row);
  const [dialog, setDialog] = useState<{
    root: RootEvidence | null;
    replacing: DraftWithCommand | null;
    mode?: Mode;
  } | null>(null);
  const [editor, setEditor] = useState<{
    replacing: DraftWithCommand | null;
  } | null>(null);
  const attention = row.attention;
  const conflicted =
    attention !== null &&
    (attention.status === "version_conflict" || attention.status === "rejected")
      ? attention
      : null;
  const openDialog = (root: RootEvidence | null) =>
    setDialog({ root, replacing: null });
  const review = (
    draft: DraftWithCommand,
    mode: Mode,
    evidence: Evidence | null,
  ) =>
    setDialog({
      root: evidence === null ? null : { evidence, ticket: null },
      replacing: draft,
      mode,
    });
  return (
    <>
      {conflicted?.kind === "complete_dependencies" ? (
        <CompletionConflict
          key={`completion:${conflicted.local_id}`}
          row={row}
          state={deps}
          localId={conflicted.local_id}
          onReview={review}
        />
      ) : null}
      {conflicted?.kind === "set_dependencies" ? (
        <SetConflict
          key={`set:${conflicted.local_id}`}
          occurrenceId={row.id}
          localId={conflicted.local_id}
          onKeepEditing={(draft) => setEditor({ replacing: draft })}
        />
      ) : null}
      {conflicted !== null &&
      conflicted.status === "version_conflict" &&
      (conflicted.kind === "record" || conflicted.kind === "stop_timer") ? (
        <UnmetConflict
          key={`unmet:${conflicted.local_id}`}
          row={row}
          state={deps}
          localId={conflicted.local_id}
          onSee={() => openDialog(null)}
        />
      ) : null}
      <RecordCard
        key={`record:${row.id}`}
        row={row}
        actions={actions}
        now={now}
        zone={zone}
        writable={writable}
        focus={focus}
        gate={gateOf(row, deps, env.online, now, openDialog)}
      />
      {/* The day's decisions and reference in one grouped box (the Final design): what needs doing first, the timer, the turns. */}
      <GroupedBox data-day-work="">
        <DependencyRow
          row={row}
          state={deps}
          onSee={() => openDialog(null)}
          onSet={() => setEditor({ replacing: null })}
        />
        {/* The timer is a section only of a task measured in time; a tick or an amount has no timer row to show. */}
        {isTimerGoal(row.data) ? (
          <TimerBlock
            key={`timer:${row.id}`}
            row={row}
            actions={actions}
            deps={deps}
            writable={writable}
            onSee={() => openDialog(null)}
          />
        ) : null}
        {extra}
      </GroupedBox>
      {dialog !== null ? (
        <DependencyDialog
          key={`dialog:${row.id}:${dialog.replacing?.local_id ?? ""}`}
          row={row}
          state={deps}
          open
          onClose={() => setDialog(null)}
          rootEvidence={dialog.root}
          replacing={dialog.replacing}
          {...(dialog.mode ? { initialMode: dialog.mode } : {})}
          actions={actions}
        />
      ) : null}
      {/* D-1 (WEB-14a maintenance merge): a new list left by the page before an update is restored and its editor opened again, once. */}
      <DependencyEditorRecoveryHost
        key={`dependency-recovery:${row.id}`}
        row={row}
        idle={editor === null && dialog === null}
        onRestored={() => setEditor({ replacing: null })}
      />
      {editor !== null ? (
        <DependencyEditor
          key={`editor:${row.id}:${editor.replacing?.local_id ?? ""}`}
          row={row}
          state={deps}
          open
          onClose={() => setEditor(null)}
          replacing={editor.replacing}
          actions={actions}
        />
      ) : null}
    </>
  );
}
