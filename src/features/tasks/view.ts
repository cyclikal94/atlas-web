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
 * Precedence (§4.1): a row with NO outstanding draft takes the server's derived fields when there is a CURRENT answer for it; a row with
 * outstanding drafts shows the locally layered personal result with its pending mark until the drafts' effects are in the cache.
 *
 * WHOLE-INPUT FRESHNESS (R2, revision 2; design assessment C1). The structure of the row (definition, window, participants, `can_edit`,
 * version) and its derived fields (my outcome, `actionable`) are chosen separately:
 * - Structure: the committed cache row, unless the daily item is AHEAD of it: a newer version, or the same version read after the cache's
 *   last commit, or a row the cache does not hold yet while the answer is CURRENT (no content committed since its dispatch: the delta has not
 *   delivered it). An answer that is not current never supplies a row the cache lacks, which may have been removed since (revision 3,
 *   design assessment C1: not having seen a row is no evidence that it was never removed); it is asked again. A committed correction
 *   therefore always defeats an older daily item, and a permission the cache committed after the read began defeats the item's `can_edit`.
 * - Derived fields: the server's only while no cache page was committed since the read was DISPATCHED, the device clock has not gone back
 *   since then (`sameClock`), no window boundary of the row lies between the dispatch and now in either direction (delivery time is not
 *   evaluation time: a slow answer is not renewed by arriving late), and the server's item is of the version the structure is. Otherwise my
 *   result is the personal reapplication of ARCH §3.3c over the saved summary, with its finalisation. The joint result is never computed here.
 * - Structure is resolved ONCE (`effectiveOccurrence`): the committed or daily row, then the outstanding drafts' projection and display
 *   patches. Composition and the screen's clock use the same result, so a window a queued create or correction gives is scheduled exactly as
 *   it is shown (R8, revision 3).
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
  /** The listed daily item (joint scope) for this occurrence, or null. */
  joint: OccurrenceView | null;
  /** My daily item (personal scope), or null. */
  personal: OccurrenceView | null;
  /** Where the two items above come from; absent or null when there is no answer to apply (offline, none yet, the detail). */
  answer?: AnswerBasis | null;
}

/** The provenance of a `/daily` answer as one row sees it (R2, revisions 2 and 3). */
export interface AnswerBasis {
  /** When the accepted page chains were DISPATCHED (ms, the earlier of the two scopes): the answer describes no later instant for certain. */
  requestedAt: number;
  /** No content is known to have been committed between the read's dispatch and the cache rows given with it. */
  current: boolean;
  /** The device clock has not gone back since the read was dispatched (the screen clock's generation is the one captured then). */
  sameClock: boolean;
}

/**
 * Whether the server's derived fields for a row can still describe it now (R2): they were evaluated no earlier than the read was dispatched,
 * so a window that opened or closed between then and now makes them stale, however late the answer was delivered. In EITHER direction
 * (revision 3): a clock that went back before a boundary the answer was evaluated after is not covered either. My result is then the
 * personal reapplication over the saved summary, finalised when the window has closed, until a newer answer arrives.
 */
export function answerCovers(
  data: Pick<OccurrenceData, "opens_at" | "closes_at">,
  requestedAt: number | null,
  nowMs: number,
): boolean {
  if (requestedAt === null) return false;
  const from = Math.min(requestedAt, nowMs);
  const to = Math.max(requestedAt, nowMs);
  for (const boundary of [data.opens_at, data.closes_at])
    if (boundary !== null && from < boundary * 1000 && boundary * 1000 <= to)
      return false;
  return true;
}

/** The structure a daily item describes, as a cache row (its parent and label from the cached row when there is one). */
function dailyRow(item: OccurrenceView, cached: CacheRow | null): CacheRow {
  return {
    id: item.id,
    kind: "occurrence",
    parent_id: cached?.parent_id ?? null,
    label: cached?.label ?? "",
    value: item.data as unknown as CacheRow["value"],
    version: item.version,
    can_edit: item.can_edit,
    archived: cached?.archived ?? false,
    kind_date: cached?.kind_date ?? null,
  };
}

/**
 * The row's structure (R2, revisions 2 and 3): the daily item only when it is ahead of the committed cache (see the module comment); `null`
 * when neither can be used (a daily-only row whose answer is not current: it may have been removed since).
 */
export function structureOf(
  cached: CacheRow | null,
  item: OccurrenceView | null,
  basis: AnswerBasis | null,
): { row: CacheRow | null; from: "cache" | "daily" } {
  if (item === null || basis === null) return { row: cached, from: "cache" };
  const ahead =
    cached === null
      ? basis.current
      : item.version > cached.version ||
        (item.version === cached.version && basis.current);
  return ahead
    ? { row: dailyRow(item, cached), from: "daily" }
    : { row: cached, from: "cache" };
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
  /** Where the structure (definition, window, permission, version) came from. */
  structureFrom: "cache" | "daily";
  /** The server lists this row in a CURRENT answer (its membership of the day is the server's). */
  listed: boolean;
  joint: OccurrenceView | null;
  /** When the answer applied to this row was dispatched (ms), or null. */
  requestedAt: number | null;
}

export type RowResult =
  | { kind: "row"; row: RowModel }
  /** The cached value does not parse (a contract drift): "This item can't be shown on this device". Never guessed. */
  | { kind: "unreadable"; id: string }
  /** Nothing current describes the row (a daily item that may have been removed since): not shown. */
  | { kind: "absent"; id: string };

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

/** One occurrence's effective structure: the drafts that name it and the row they leave (see `effectiveOccurrence`). */
export interface Effective {
  drafts: DraftWithCommand[];
  from: "cache" | "daily";
  /** The occurrence row as shown (committed or daily structure, then the drafts' projection and patches), or null. */
  row: CacheRow | null;
  /** Its parsed data, or null (no row, or a row that does not parse). */
  data: OccurrenceData | null;
}

/**
 * The structure of one occurrence as a screen shows it, resolved ONCE (R8, revision 3; design assessment C2): the committed row or the
 * daily item ahead of it (`structureOf`), then, in queue order, the projection of an outstanding create and the display patches of every
 * draft naming the occurrence, its progress stream or its task. `composeRow` composes from it and the screen's clock schedules the windows it
 * gives, so a queued create or correction is woken for at exactly the boundaries it is shown with.
 */
export function effectiveOccurrence(
  sources: Pick<
    RowSources,
    "occurrenceId" | "progressId" | "occurrence" | "task" | "joint" | "answer"
  >,
  outstanding: Outstanding,
): Effective {
  const { occurrenceId, progressId } = sources;
  const drafts = draftsNaming(outstanding, [
    occurrenceId,
    progressId,
    ...(sources.task ? [sources.task.id] : []),
  ]);
  const structure = structureOf(
    sources.occurrence,
    sources.joint,
    sources.answer ?? null,
  );
  const row = patched(structure.row, occurrenceId, drafts);
  return {
    drafts,
    from: structure.from,
    row,
    data: row === null ? null : parseOccurrenceData(row.value),
  };
}

export function composeRow(
  sources: RowSources,
  outstanding: Outstanding,
  me: string,
  nowMs: number,
): RowResult {
  const { occurrenceId, progressId } = sources;
  const basis = sources.answer ?? null;
  const effective = effectiveOccurrence(sources, outstanding);
  const { drafts, data } = effective;
  const occurrenceRow = effective.row;
  if (occurrenceRow === null) return { kind: "absent", id: occurrenceId };
  if (data === null) return { kind: "unreadable", id: occurrenceId };
  const version = occurrenceRow.version;
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
  // An entry the synced stream already lists has landed: it is not pending any more, whatever the overlay read (a separate transaction)
  // still says, so it is never counted twice (design assessment F4).
  const landed = new Set((progress?.recent_entries ?? []).map((e) => e.id));
  const pending: PendingEvidence[] = drafts
    .map((d) => pendingEvidenceOf(d, me))
    .filter(
      (p): p is PendingEvidence & { occurrenceId: string } =>
        p !== null && p.occurrenceId === occurrenceId && !landed.has(p.entryId),
    );
  const personal = personalResult({
    occurrence: data,
    stream: progress,
    pending,
    streamPending,
    me,
    nowMs,
  });
  const canEdit = occurrenceRow.can_edit;
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
  const answerCurrent =
    basis?.current === true &&
    basis.sameClock &&
    answerCovers(data, basis.requestedAt, nowMs);
  if (drafts.length === 0 && answerCurrent) {
    if (sources.personal !== null && sources.personal.version === version) {
      outcome = sources.personal.outcome;
      periodOutcome = sources.personal.period_outcome;
      actionable = sources.personal.actionable;
      source = "server";
    } else if (
      sources.joint !== null &&
      sources.joint.version === version &&
      personal.kind !== "result"
    ) {
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
      version,
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
      structureFrom: effective.from,
      listed:
        answerCurrent && (sources.joint !== null || sources.personal !== null),
      joint: sources.joint,
      requestedAt: basis?.requestedAt ?? null,
    },
  };
}
