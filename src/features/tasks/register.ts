import type {
  CacheRow,
  CommandRegistry,
  CommandSpec,
  CurrentRead,
  CurrentReadIo,
  DraftWithCommand,
  EnqueueRequest,
  JsonObject,
} from "../../data";
import { canonicalDefinition, commandOf } from "./model/commands";
import {
  parseDefinition,
  parseEvidence,
  parseResourcePage,
  parseTaskDetail,
} from "./model/contract";
import { evaluate } from "./model/evaluate";
import { slotOn, windows } from "./model/time";

/**
 * The registrations of WEB-10a's queued kinds (plan §4.7): a description for the queue, the projection of a create the cache does not hold
 * yet, the authorised current-state read of WF-QUEUE-02 (D-10a-15) and the rebuild of "Resend as a new operation". Registered ONCE per
 * registry (the registry throws on a second registration), before the routes render.
 */
export const DESCRIPTIONS: Readonly<Record<string, string>> = {
  create_task: "New task",
  revise_task: "Task change",
  record: "Progress entry",
  resolve: "Close or reopen a day",
  exclude: "Streak exclusion",
  revise_occurrence: "Correction to one day",
  archive: "Archive or restore",
};

type Obj = Record<string, unknown>;

/**
 * The projection of a queued `create_task` (§4.3): the task, its details, its first occurrence and my empty progress, each under the id it
 * was enqueued with (the targets are in a fixed order: task, execution, occurrence, progress). The first occurrence is the start-date slot
 * (or `once`), whose windows follow from the definition alone.
 */
export function projectCreateTask(
  draft: DraftWithCommand,
  resourceId: string,
): CacheRow | null {
  const command = commandOf(draft);
  if (command === null || command.kind !== "create_task") return null;
  const definition = parseDefinition(command.definition);
  if (definition === null || typeof command.title !== "string") return null;
  const [taskId, executionId, occurrenceId, progressId] =
    draft.target_resource_ids;
  const row = (
    id: string,
    kind: CacheRow["kind"],
    parent: string | null,
    label: string,
    value: JsonObject | null,
  ): CacheRow => ({
    id,
    kind,
    parent_id: parent,
    label,
    value,
    version: 1,
    can_edit: true,
    archived: false,
    kind_date: null,
  });
  if (resourceId === taskId)
    return row(taskId, "task", null, command.title, null);
  if (resourceId === executionId && taskId !== undefined)
    return row(
      executionId,
      "execution",
      taskId,
      "Task details",
      canonicalDefinition(definition),
    );
  const slot = slotOn(definition.schedule, definition.schedule.start_date);
  if (
    resourceId === occurrenceId &&
    taskId !== undefined &&
    executionId !== undefined
  ) {
    const window = windows(slot, definition);
    return row(occurrenceId, "occurrence", executionId, "Occurrence", {
      task_id: taskId,
      definition: canonicalDefinition(definition),
      slot: slot as unknown as JsonObject,
      opens_at: window.opens_at,
      closes_at: window.closes_at,
      participants: [draft.account_id],
      covered_by: null,
      resolved: false,
    });
  }
  if (resourceId === progressId && occurrenceId !== undefined) {
    const empty = evaluate(definition.goal, [], false);
    return row(progressId, "progress", occurrenceId, "Progress", {
      subject_account_id: draft.account_id,
      recent_entries: [],
      entry_count: 0,
      excluded: false,
      aggregate_consent: true,
      action: empty as unknown as JsonObject,
      period: empty as unknown as JsonObject,
    });
  }
  return null;
}

async function readJson(
  io: CurrentReadIo,
  path: string,
): Promise<{ status: number; body: unknown }> {
  const response = await io.get(path);
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  return { status: response.status, body };
}

const failedFor = (status: number): CurrentRead =>
  status === 403 || status === 404 || status === 410
    ? { kind: "failed", reason: "inaccessible" }
    : { kind: "failed", reason: "error" };

/** Task-level kinds: the task's projection from `GET /tasks/{id}`. */
async function readTaskCurrent(
  draft: DraftWithCommand,
  io: CurrentReadIo,
): Promise<CurrentRead> {
  const taskId = draft.target_resource_ids[0];
  if (taskId === undefined) return { kind: "failed", reason: "unavailable" };
  const { status, body } = await readJson(
    io,
    `/tasks/${encodeURIComponent(taskId)}`,
  );
  if (status !== 200) return failedFor(status);
  const detail = parseTaskDetail(body);
  return detail === null
    ? { kind: "indeterminate" }
    : { kind: "loaded", value: detail.task };
}

/** Progress-level kinds: my stream from `GET /progress?parent_id=<occurrence>`, matched by its id. */
async function readProgressCurrent(
  draft: DraftWithCommand,
  io: CurrentReadIo,
): Promise<CurrentRead> {
  const command = commandOf(draft);
  const occurrence = command?.occurrence_id;
  const stream = draft.target_resource_ids.find((id) => id !== occurrence);
  if (typeof occurrence !== "string" || stream === undefined)
    return { kind: "failed", reason: "unavailable" };
  const { status, body } = await readJson(
    io,
    `/progress?parent_id=${encodeURIComponent(occurrence)}&limit=200`,
  );
  if (status !== 200) return failedFor(status);
  const page = parseResourcePage(body);
  if (page === null) return { kind: "indeterminate" };
  const row = page.items.find((item) => item.id === stream);
  return row === undefined
    ? { kind: "failed", reason: "inaccessible" }
    : { kind: "loaded", value: row };
}

/** A request that sends `body` with `expected_version` taken from the reviewed current state (never the cache). */
function resend(
  draft: DraftWithCommand,
  command: Obj,
  current: CacheRow,
  extra: Obj = {},
): EnqueueRequest {
  const next: JsonObject = {
    command: {
      ...command,
      expected_version: current.version,
      ...extra,
    } as JsonObject,
  };
  const primary = draft.target_resource_ids[0] as string;
  return {
    endpoint: draft.endpoint,
    targets: [
      {
        resourceId: primary,
        role: "primary",
        basis: draft.kind === "exclude" ? "progress_stream" : "resource",
        versionChecked: false,
      },
    ],
    build: () => ({ command: next }),
  };
}

function rebuildRecord(
  draft: DraftWithCommand,
  current: CacheRow | null,
): EnqueueRequest | null {
  const command = commandOf(draft);
  if (command === null || parseEvidence(command.evidence) === null) return null;
  const checked = typeof command.expected_version === "number";
  if (checked && current === null) return null;
  const { expected_version: _old, ...rest } = command;
  // A new operation: a new entry id; the person's `happened_at` is kept.
  const next: JsonObject = {
    command: {
      ...rest,
      entry_id: crypto.randomUUID(),
      ...(checked && current !== null
        ? { expected_version: current.version }
        : {}),
    } as JsonObject,
  };
  const stream = draft.target_resource_ids.find(
    (id) => id !== command.occurrence_id,
  );
  return {
    endpoint: draft.endpoint,
    targets: [
      {
        resourceId: stream ?? (command.occurrence_id as string),
        role: "primary",
        basis: "progress_stream",
        versionChecked: false,
      },
    ],
    build: () => ({ command: next }),
  };
}

export function taskCommandSpecs(): Record<string, CommandSpec> {
  const describe = (kind: string) => () => DESCRIPTIONS[kind] as string;
  return {
    create_task: {
      describe: describe("create_task"),
      projectCreate: projectCreateTask,
    },
    revise_task: {
      describe: describe("revise_task"),
      readCurrent: readTaskCurrent,
      rebuild(draft, current) {
        const command = commandOf(draft);
        if (command === null || current === null) return null;
        if (current.policy_version === undefined) return null;
        return resend(draft, command, current, {
          expected_policy_version: current.policy_version,
        });
      },
    },
    record: {
      describe: describe("record"),
      readCurrent: readProgressCurrent,
      rebuild: rebuildRecord,
    },
    exclude: {
      describe: describe("exclude"),
      readCurrent: readProgressCurrent,
      rebuild(draft, current) {
        const command = commandOf(draft);
        return command === null || current === null
          ? null
          : resend(draft, command, current);
      },
    },
    resolve: {
      describe: describe("resolve"),
      rebuild(draft, current) {
        const command = commandOf(draft);
        return command === null || current === null
          ? null
          : resend(draft, command, current);
      },
    },
    revise_occurrence: { describe: describe("revise_occurrence") },
    archive: {
      describe: describe("archive"),
      readCurrent: readTaskCurrent,
      rebuild(draft, current) {
        const command = commandOf(draft);
        return command === null || current === null
          ? null
          : resend(draft, command, current);
      },
    },
  };
}

const registered = new WeakSet<CommandRegistry>();

/** Registers every WEB-10a kind into `registry`, once (idempotent per registry). */
export function registerTaskCommands(registry: CommandRegistry): void {
  if (registered.has(registry)) return;
  registered.add(registry);
  for (const [kind, spec] of Object.entries(taskCommandSpecs()))
    registry.register(kind, spec);
}
