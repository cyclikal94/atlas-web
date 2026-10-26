import {
  type Bases,
  type BuildResult,
  captureDefaults,
  type DefaultsRecord,
  type DraftWithCommand,
  type EnqueueRequest,
  type JsonObject,
  type ProjectionPatch,
  type TargetSpec,
  type TemplateKind,
} from "../../../data";
import {
  type Evidence,
  type OccurrenceData,
  parseEvidence,
  type Slot,
  type TaskDefinition,
} from "./contract";
import type { PendingEvidence } from "./evaluate";
import { windows } from "./time";

/**
 * The queued task commands of WEB-10a as outbox requests (DES 3158-3242; plan §3.3). Each request names its targets with their version
 * basis, and its `build` is PURE: the bases the enqueue transaction read go in, the whole wire body (`{ command, defaults_revision? }`) comes
 * out, with a display patch where the cache row should change at once. Everything that is not pure (fresh ids, the instant of the person's
 * act, the deterministic ids, the defaults record) is decided BEFORE the request is built and passed in.
 *
 * A field the schema allows to be absent is omitted, never sent as `null`. The client never records for another person (TASK-18): the
 * subject is always the signed-in account.
 */
export const TASK_ENDPOINT = "/task-commands";
export const TASK_ACCESS_ENDPOINT = "/task-access-commands";

/** The kinds this slice queues (registered in `register.ts`). `enrol` is online-only and never queued. */
export const QUEUED_KINDS = [
  "create_task",
  "revise_task",
  "record",
  "exclude",
  "resolve",
  "revise_occurrence",
  "archive",
] as const;
export type QueuedKind = (typeof QUEUED_KINDS)[number];

const EMPTY_POLICY = { grants: [], exclude_accounts: [] };

/** The defaults a command consumes, captured from the record as it is at the person's act (WEB-12a; DES 4610-4666). */
function capture(
  record: DefaultsRecord | null,
  kinds: readonly TemplateKind[],
): Pick<
  BuildResult,
  "defaultsRevision" | "defaultsContext" | "defaultsReview"
> & {
  revision: string | null;
} {
  const captured = captureDefaults(record, kinds);
  return {
    revision: captured.defaultsRevision,
    defaultsRevision: captured.defaultsRevision,
    defaultsContext: captured.defaultsContext,
    defaultsReview: captured.defaultsReview,
  };
}

const body = (command: JsonObject, revision: string | null): JsonObject =>
  revision === null ? { command } : { command, defaults_revision: revision };

/** A definition as the server writes it (field order of `Definition`), so its size and digest are stable. */
export function canonicalDefinition(definition: TaskDefinition): JsonObject {
  const { schedule, goal } = definition;
  return {
    schedule: {
      start_date: schedule.start_date,
      time: schedule.time,
      timezone: schedule.timezone,
      repeat:
        schedule.repeat === null
          ? null
          : {
              frequency: schedule.repeat.frequency,
              interval: schedule.repeat.interval,
            },
    },
    goal:
      goal.kind === "numeric"
        ? {
            kind: "numeric",
            minimum: goal.minimum,
            maximum: goal.maximum,
            unit: goal.unit,
          }
        : goal.kind === "checklist"
          ? {
              kind: "checklist",
              items: goal.items.map((item) => ({
                id: item.id,
                label: item.label,
              })),
            }
          : { kind: "checkbox" },
    carry: definition.carry,
    participation: definition.participation,
    open_days_before: definition.open_days_before,
    close_days_after: definition.close_days_after,
    allow_streak_exclusions: definition.allow_streak_exclusions,
  };
}

// ---- create_task ------------------------------------------------------------------------------------------------------------------
export interface CreateTaskInput {
  taskId: string;
  executionId: string;
  /** The first occurrence's deterministic id, when `create_task` makes one (start date not after today in the task's zone, or undated). */
  occurrenceId: string | null;
  /** My progress stream's deterministic id under that occurrence. */
  progressId: string | null;
  title: string;
  definition: TaskDefinition;
  /** D-10a-4: "Use my defaults" (the task audience from the defaults) or "Only me" (an explicit empty policy; still queueable). */
  sharing: "defaults" | "only_me";
  defaults: DefaultsRecord | null;
  localId?: string;
}

/** The targets of a create, in a fixed order the projection relies on: task, execution, then the first occurrence and my progress. */
export function createTargets(input: {
  taskId: string;
  executionId: string;
  occurrenceId: string | null;
  progressId: string | null;
}): TargetSpec[] {
  const seeded = (
    resourceId: string,
    basis: TargetSpec["basis"],
  ): TargetSpec => ({
    resourceId,
    role: "primary",
    basis,
    versionChecked: false,
    seedIfUntracked: 1,
  });
  const out = [
    seeded(input.taskId, "resource"),
    seeded(input.executionId, "resource"),
  ];
  if (input.occurrenceId !== null) {
    out.push(seeded(input.occurrenceId, "resource"));
    if (input.progressId !== null)
      out.push(seeded(input.progressId, "progress_stream"));
  }
  return out;
}

export function createTask(input: CreateTaskInput): EnqueueRequest {
  // `progress` is always consumed (the creator's enrolment uses the progress defaults); `task` only when its audience comes from them.
  const kinds: TemplateKind[] =
    input.sharing === "defaults" ? ["task", "progress"] : ["progress"];
  const captured = capture(input.defaults, kinds);
  const command: JsonObject = {
    kind: "create_task",
    id: input.taskId,
    execution_id: input.executionId,
    title: input.title,
    definition: canonicalDefinition(input.definition),
    ...(input.sharing === "only_me" ? { initial_policy: EMPTY_POLICY } : {}),
  };
  return {
    endpoint: TASK_ENDPOINT,
    targets: createTargets(input),
    ...(input.localId === undefined ? {} : { localId: input.localId }),
    build: () => ({
      command: body(command, captured.revision),
      defaultsRevision: captured.defaultsRevision,
      defaultsContext: captured.defaultsContext,
      defaultsReview: captured.defaultsReview,
    }),
  };
}

// ---- revise_task ------------------------------------------------------------------------------------------------------------------
export interface ReviseTaskInput {
  taskId: string;
  executionId: string;
  title: string;
  definition: TaskDefinition;
  /** The cached task's `policy_version` (Q1): required; a revise without one cannot be built. */
  policyVersion: number;
  localId?: string;
}

export function reviseTask(input: ReviseTaskInput): EnqueueRequest {
  const definition = canonicalDefinition(input.definition);
  return {
    endpoint: TASK_ENDPOINT,
    // The server writes the task AND its details, and needs write access to both (R29/DA-A2): a known denial of either refuses the
    // save in the transaction that would write it, an edit of a queued revision included.
    targets: [
      {
        resourceId: input.taskId,
        role: "primary",
        basis: "resource",
        versionChecked: true,
        requiresEdit: true,
      },
      {
        resourceId: input.executionId,
        role: "side_effect",
        basis: "resource",
        versionChecked: true,
        requiresEdit: true,
      },
    ],
    ...(input.localId === undefined ? {} : { localId: input.localId }),
    build: (bases: Bases) => ({
      command: body(
        {
          kind: "revise_task",
          id: input.taskId,
          expected_version: bases[input.taskId] as number,
          expected_policy_version: input.policyVersion,
          title: input.title,
          definition,
        },
        null,
      ),
      displayPatch: {
        [input.taskId]: { label: input.title },
        [input.executionId]: { value: definition },
      },
    }),
  };
}

// ---- record -----------------------------------------------------------------------------------------------------------------------
export interface RecordInput {
  occurrenceId: string;
  /** My progress stream's deterministic id. */
  progressId: string;
  me: string;
  /** A fresh UUIDv4, chosen at the person's act. */
  entryId: string;
  evidence: Evidence;
  /** Unix seconds of the person's act, taken when it happened (never at send): offline work keeps its in-window time. */
  happenedAt: number;
  replaces: string | null;
  /**
   * An Anyone occurrence where neither the cache nor an outstanding draft has my stream: the server creates it on demand at version 1, so it
   * is seeded at 1 and the record consumes the progress defaults (DES 4610-4666).
   */
  firstAnyoneStream: boolean;
  defaults: DefaultsRecord | null;
}

/** Whether a record is checked against my stream's version: checkbox and checklist evidence that replaces nothing (`commands.rs`). */
export const recordIsVersionChecked = (
  evidence: Evidence,
  replaces: string | null,
): boolean =>
  (evidence.kind === "checkbox" || evidence.kind === "checklist") &&
  replaces === null;

export function record(input: RecordInput): EnqueueRequest {
  const checked = recordIsVersionChecked(input.evidence, input.replaces);
  const captured = input.firstAnyoneStream
    ? capture(input.defaults, ["progress"])
    : null;
  return {
    endpoint: TASK_ENDPOINT,
    targets: [
      // Every record raises my stream's version on the server, so it always raises the local record: checked as the primary, otherwise
      // as a side effect (no `expected_version` is sent then). It writes my stream, so a known denial of it refuses the record; and the
      // record that CREATES it (an Anyone occurrence's first) needs the occurrence's edit access, decided in the writing transaction from
      // whether this device knows my participation there, not from what the screen thought (DA17-N2).
      {
        resourceId: input.progressId,
        role: checked ? "primary" : "side_effect",
        basis: "progress_stream",
        versionChecked: true,
        requiresEdit: true,
        joinRequiresEdit: input.occurrenceId,
        ...(input.firstAnyoneStream ? { seedIfUntracked: 1 } : {}),
      },
      // The occurrence orders the record after any queued change of it (a correction, a closure); it is not version-checked.
      {
        resourceId: input.occurrenceId,
        role: "primary",
        basis: "resource",
        versionChecked: false,
      },
    ],
    build: (bases: Bases) => {
      const command: JsonObject = {
        kind: "record",
        occurrence_id: input.occurrenceId,
        subject_account_id: input.me,
        entry_id: input.entryId,
        evidence: input.evidence as JsonObject,
        ...(input.replaces === null ? {} : { replaces: input.replaces }),
        ...(checked
          ? { expected_version: bases[input.progressId] as number }
          : {}),
        happened_at: input.happenedAt,
      };
      return captured === null
        ? { command: body(command, null) }
        : {
            command: body(command, captured.revision),
            defaultsRevision: captured.defaultsRevision,
            defaultsContext: captured.defaultsContext,
            defaultsReview: captured.defaultsReview,
          };
    },
  };
}

// ---- exclude, resolve, archive ---------------------------------------------------------------------------------------------------
export function exclude(input: {
  occurrenceId: string;
  progressId: string;
  excluded: boolean;
}): EnqueueRequest {
  return {
    endpoint: TASK_ENDPOINT,
    targets: [
      // An exclusion writes my stream (the server checks my write access to it), never the occurrence.
      {
        resourceId: input.progressId,
        role: "primary",
        basis: "progress_stream",
        versionChecked: true,
        requiresEdit: true,
      },
      // Named so the occurrence's outstanding work includes it (not version-checked).
      {
        resourceId: input.occurrenceId,
        role: "primary",
        basis: "resource",
        versionChecked: false,
      },
    ],
    build: (bases: Bases) => ({
      command: body(
        {
          kind: "exclude",
          occurrence_id: input.occurrenceId,
          expected_version: bases[input.progressId] as number,
          excluded: input.excluded,
        },
        null,
      ),
      displayPatch: {
        [input.progressId]: { value: { excluded: input.excluded } },
      },
    }),
  };
}

export function resolve(input: {
  occurrenceId: string;
  resolved: boolean;
}): EnqueueRequest {
  return {
    endpoint: TASK_ENDPOINT,
    // Closing or reopening a day needs write access to the occurrence (DA17-N1): a known denial refuses it in the writing transaction.
    targets: [
      {
        resourceId: input.occurrenceId,
        role: "primary",
        basis: "resource",
        versionChecked: true,
        requiresEdit: true,
      },
    ],
    build: (bases: Bases) => ({
      command: body(
        {
          kind: "resolve",
          occurrence_id: input.occurrenceId,
          expected_version: bases[input.occurrenceId] as number,
          resolved: input.resolved,
        },
        null,
      ),
      displayPatch: {
        [input.occurrenceId]: { value: { resolved: input.resolved } },
      },
    }),
  };
}

export function archive(input: {
  taskId: string;
  archived: boolean;
}): EnqueueRequest {
  return archiveResource({ id: input.taskId, archived: input.archived });
}

/** `archive` of any resource the server archives (`person`, `field`, `task`, `list`: WEB-10b reuses it for a list, D-10b-7). */
export function archiveResource(input: {
  id: string;
  archived: boolean;
}): EnqueueRequest {
  return {
    endpoint: TASK_ENDPOINT,
    // Archiving needs write access to the resource (DA-A3): a known denial refuses it in the writing transaction.
    targets: [
      {
        resourceId: input.id,
        role: "primary",
        basis: "resource",
        versionChecked: true,
        requiresEdit: true,
      },
    ],
    build: (bases: Bases) => ({
      command: body(
        {
          kind: "archive",
          id: input.id,
          expected_version: bases[input.id] as number,
          archived: input.archived,
        },
        null,
      ),
      displayPatch: { [input.id]: { archived: input.archived } },
    }),
  };
}

// ---- revise_occurrence --------------------------------------------------------------------------------------------------------------
export interface ReviseOccurrenceInput {
  occurrenceId: string;
  current: OccurrenceData;
  /** The full corrected definition: participation unchanged (the server refuses a change). */
  definition: TaskDefinition;
  date: string | null;
  /** `HH:MM:SS`; requires a date. */
  time: string | null;
  /** Every progress stream under the occurrence this device knows (cache or outstanding creates): the server raises each one. */
  progressIds: readonly string[];
  localId?: string;
}

/** The slot the correction gives the occurrence: its key is kept, its date, time and instant are the new ones. */
export function correctedSlot(
  current: Slot,
  definition: TaskDefinition,
  date: string | null,
  time: string | null,
  resolveInstant: (zone: string, date: string, time: string) => number,
): Slot {
  const zone = definition.schedule.timezone;
  return {
    key: current.key,
    date,
    intended_time: date === null ? null : time,
    timezone: zone,
    instant:
      date === null || time === null ? null : resolveInstant(zone, date, time),
  };
}

export function reviseOccurrence(
  input: ReviseOccurrenceInput,
  resolveInstant: (zone: string, date: string, time: string) => number,
): EnqueueRequest {
  const definition = canonicalDefinition(input.definition);
  const slot = correctedSlot(
    input.current.slot,
    input.definition,
    input.date,
    input.time,
    resolveInstant,
  );
  const window = windows(slot, input.definition);
  const progress = [...new Set(input.progressIds)];
  return {
    endpoint: TASK_ENDPOINT,
    // A correction needs write access to the occurrence (R30): a known denial refuses it in the writing transaction, a replacement of a
    // conflicted correction included. The progress streams it raises are side effects the server raises; they need no access of mine.
    targets: [
      {
        resourceId: input.occurrenceId,
        role: "primary",
        basis: "resource",
        versionChecked: true,
        requiresEdit: true,
      },
      ...progress.map(
        (id): TargetSpec => ({
          resourceId: id,
          role: "side_effect",
          basis: "progress_stream",
          versionChecked: true,
        }),
      ),
    ],
    ...(input.localId === undefined ? {} : { localId: input.localId }),
    build: (bases: Bases) => ({
      command: body(
        {
          kind: "revise_occurrence",
          id: input.occurrenceId,
          expected_version: bases[input.occurrenceId] as number,
          definition,
          date: input.date,
          time: input.date === null ? null : input.time,
        },
        null,
      ),
      displayPatch: {
        [input.occurrenceId]: {
          value: {
            definition,
            slot: slot as unknown as JsonObject,
            opens_at: window.opens_at,
            closes_at: window.closes_at,
          },
        } satisfies ProjectionPatch,
      },
    }),
  };
}

// ---- reading drafts back ----------------------------------------------------------------------------------------------------------
type Obj = Record<string, unknown>;
const isObject = (value: unknown): value is Obj =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The task command inside a draft's body (`{ command: {...} }`), or null. */
export function commandOf(
  draft: Pick<DraftWithCommand, "command">,
): Obj | null {
  const inner = (draft.command as Obj).command;
  return isObject(inner) ? inner : null;
}

/** A queued `record` of MY stream as pending evidence, or null when the draft is something else. */
export function pendingEvidenceOf(
  draft: Pick<DraftWithCommand, "command" | "kind">,
  me: string,
): (PendingEvidence & { occurrenceId: string }) | null {
  if (draft.kind !== "record") return null;
  const command = commandOf(draft);
  if (command === null || command.subject_account_id !== me) return null;
  const evidence = parseEvidence(command.evidence);
  if (
    evidence === null ||
    typeof command.entry_id !== "string" ||
    typeof command.occurrence_id !== "string" ||
    typeof command.happened_at !== "number"
  )
    return null;
  const replaces = command.replaces;
  return {
    occurrenceId: command.occurrence_id,
    entryId: command.entry_id,
    evidence,
    happenedAt: command.happened_at,
    replaces: typeof replaces === "string" ? replaces : null,
  };
}
