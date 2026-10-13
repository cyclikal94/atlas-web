import type {
  CacheRow,
  DraftRow,
  DraftWithCommand,
  ProjectionPatch,
} from "../../data";
import { pendingEvidenceOf } from "./model/commands";
import {
  type OccurrenceData,
  type OccurrenceView,
  type Outcome,
  type ProgressState,
  parseOccurrenceData,
  parseProgressState,
} from "./model/contract";
import {
  eligible,
  actionable as isActionable,
  type PendingEvidence,
  type PersonalResult,
  personalResult,
} from "./model/evaluate";
import { type Pill, pillOf, type RowInputs } from "./model/row-state";
import { projectCreateTask } from "./register";

/**
 * One occurrence as a screen shows it, composed PURELY from what this device holds: the cached rows (task, occurrence, my progress stream
 * by its deterministic id), the outstanding drafts that name them (their display patches, my pending evidence, the projection of a create
 * the cache does not hold yet), and this page's last `/daily` answers for the identity (Q8: the joint result is only ever the server's).
 *
 * Precedence (§4.1): a row with NO outstanding draft takes the server's derived fields when there is an answer; a row with outstanding
 * drafts shows the locally layered personal result with its pending mark until the drafts' effects are in the cache.
 */
export interface Outstanding {
  drafts: readonly DraftWithCommand[];
  attention: readonly DraftRow[];
}

export interface RowSources {
  occurrenceId: string;
  progressId: string;
  occurrence: CacheRow | null;
  task: CacheRow | null;
  progress: CacheRow | null;
  joint: OccurrenceView | null;
  personal: OccurrenceView | null;
  /**
   * When the server's answers were received (ms), or null. The caller passes null when the personal answer is not current (offline, or a
   * sync page committed after its read began); `composeRow` also ignores it once a window boundary of the row has passed since then.
   */
  answeredAt: number | null;
}

/**
 * Whether the server's derived fields for a row still describe it now (R2, revision 1): they were evaluated when they were answered, so a
 * window that opened or closed since then (`opens_at`/`closes_at` in `(answeredAt, now]`) makes them stale. My result is then the personal
 * reapplication over the saved summary, finalised when the window has closed, until a newer answer arrives.
 */
export function answerCovers(
  data: Pick<OccurrenceData, "opens_at" | "closes_at">,
  answeredAt: number | null,
  nowMs: number,
): boolean {
  if (answeredAt === null) return false;
  for (const boundary of [data.opens_at, data.closes_at])
    if (
      boundary !== null &&
      answeredAt < boundary * 1000 &&
      boundary * 1000 <= nowMs
    )
      return false;
  return true;
}

export type PendingMark = "queued" | "sending" | "waiting";

export interface RowModel {
  id: string;
  taskId: string;
  title: string | null;
  data: OccurrenceData;
  version: number;
  canEdit: boolean;
  archived: boolean;
  /** My stream as cached (patched), or null. */
  progress: ProgressState | null;
  progressId: string;
  streamPresent: boolean;
  streamPending: boolean;
  personal: PersonalResult;
  outcome: Outcome | null;
  periodOutcome: Outcome | null;
  actionable: boolean;
  /** My result should exist but this device cannot tell. */
  unavailable: boolean;
  pill: Pill;
  pending: PendingMark | null;
  attention: DraftRow | null;
  /** The drafts that name this row, oldest first. */
  drafts: readonly DraftWithCommand[];
  /** Where the derived fields came from. */
  source: "server" | "local";
  joint: OccurrenceView | null;
  answeredAt: number | null;
}

export type RowResult =
  | { kind: "row"; row: RowModel }
  /** The cached value does not parse (a contract drift): "This item can't be shown on this device". Never guessed. */
  | { kind: "unreadable"; id: string };

/** The drafts naming any of `ids`, oldest first. */
export function draftsNaming(
  outstanding: Outstanding,
  ids: readonly string[],
): DraftWithCommand[] {
  return outstanding.drafts
    .filter((d) => ids.some((id) => d.index_targets.includes(id)))
    .sort((a, b) => a.created_seq - b.created_seq);
}

/** A row with the display patches of the outstanding drafts applied in queue order (a later patch's field wins). */
export function patched(
  row: CacheRow | null,
  id: string,
  drafts: readonly DraftWithCommand[],
): CacheRow | null {
  let out = row;
  if (out === null)
    for (const draft of drafts)
      if (
        draft.kind === "create_task" &&
        draft.target_resource_ids.includes(id)
      ) {
        out = projectCreateTask(draft, id);
        if (out !== null) break;
      }
  if (out === null) return null;
  for (const draft of drafts) {
    const patch: ProjectionPatch | undefined = draft.display_patch?.[id];
    if (patch === undefined) continue;
    out = {
      ...out,
      ...(patch.label === undefined ? {} : { label: patch.label }),
      ...(patch.archived === undefined ? {} : { archived: patch.archived }),
      ...(patch.value === undefined
        ? {}
        : {
            value: {
              ...(out.value ?? {}),
              ...(patch.value as Record<string, never>),
            },
          }),
    };
  }
  return out;
}

function markOf(drafts: readonly DraftWithCommand[]): PendingMark | null {
  if (drafts.length === 0) return null;
  if (drafts.some((d) => d.status === "queued" || d.status === "blocked"))
    return "queued";
  if (drafts.some((d) => d.status === "in_flight")) return "sending";
  return "waiting";
}

export function composeRow(
  sources: RowSources,
  outstanding: Outstanding,
  me: string,
  nowMs: number,
): RowResult {
  const { occurrenceId, progressId } = sources;
  const drafts = draftsNaming(outstanding, [
    occurrenceId,
    progressId,
    ...(sources.task ? [sources.task.id] : []),
  ]);
  const occurrenceRow = patched(sources.occurrence, occurrenceId, drafts);
  const useServer = drafts.length === 0 && sources.joint !== null;
  const data = useServer
    ? (sources.joint as OccurrenceView).data
    : occurrenceRow === null
      ? null
      : parseOccurrenceData(occurrenceRow.value);
  if (data === null) return { kind: "unreadable", id: occurrenceId };
  const taskDrafts = sources.task
    ? drafts
    : [
        ...drafts,
        ...outstanding.drafts.filter((d) =>
          d.index_targets.includes(data.task_id),
        ),
      ];
  const taskRow = patched(sources.task, data.task_id, taskDrafts);
  const progressRow = patched(sources.progress, progressId, drafts);
  const progress =
    progressRow === null ? null : parseProgressState(progressRow.value);
  const streamPresent = sources.progress !== null || progressRow !== null;
  const streamPending =
    sources.progress === null &&
    drafts.some(
      (d) =>
        d.target_resource_ids.includes(progressId) ||
        d.index_targets.includes(progressId),
    );
  const pending: PendingEvidence[] = drafts
    .map((d) => pendingEvidenceOf(d, me))
    .filter(
      (p): p is PendingEvidence & { occurrenceId: string } =>
        p !== null && p.occurrenceId === occurrenceId,
    );
  const personal = personalResult({
    occurrence: data,
    stream: progress,
    pending,
    streamPending,
    me,
    nowMs,
  });
  const canEdit = useServer
    ? (sources.joint as OccurrenceView).can_edit
    : (occurrenceRow?.can_edit ?? false);
  let outcome: Outcome | null =
    personal.kind === "result" ? personal.outcome : null;
  let periodOutcome: Outcome | null =
    personal.kind === "result" ? personal.periodOutcome : null;
  let actionable = isActionable(data, {
    eligible: eligible(data, {
      streamPresent: streamPresent || streamPending || pending.length > 0,
      canEdit,
    }),
    outcome,
    nowMs,
  });
  let source: RowModel["source"] = "local";
  if (drafts.length === 0 && answerCovers(data, sources.answeredAt, nowMs)) {
    if (sources.personal !== null) {
      outcome = sources.personal.outcome;
      periodOutcome = sources.personal.period_outcome;
      actionable = sources.personal.actionable;
      source = "server";
    } else if (sources.joint !== null && personal.kind !== "result") {
      // No stream of mine (an Anyone task not joined yet): what I can do is the joint answer's.
      actionable = sources.joint.actionable;
      source = "server";
    }
  }
  const attention =
    outstanding.attention.find((d) =>
      [occurrenceId, progressId].some((id) => d.index_targets.includes(id)),
    ) ?? null;
  const unavailable = personal.kind === "unavailable" && source === "local";
  const inputs: RowInputs = {
    data,
    outcome,
    periodOutcome,
    unavailable,
    actionable,
    attention: attention !== null,
    nowMs,
  };
  return {
    kind: "row",
    row: {
      id: occurrenceId,
      taskId: data.task_id,
      title: taskRow?.label ?? null,
      data,
      version: useServer
        ? (sources.joint as OccurrenceView).version
        : (occurrenceRow?.version ?? 1),
      canEdit,
      archived: taskRow?.archived ?? false,
      progress,
      progressId,
      streamPresent,
      streamPending,
      personal,
      outcome,
      periodOutcome,
      actionable,
      unavailable,
      pill: pillOf(inputs),
      pending: markOf(drafts),
      attention,
      drafts,
      source,
      joint: sources.joint,
      answeredAt: sources.answeredAt,
    },
  };
}
