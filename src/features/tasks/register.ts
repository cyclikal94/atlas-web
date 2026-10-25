import type {
  CacheRow,
  CommandRegistry,
  CommandSpec,
  CurrentRead,
  CurrentReadIo,
  DraftWithCommand,
  EnqueueRequest,
  JsonObject,
  TargetNeeds,
} from "../../data";
import {
  archiveResource,
  canonicalDefinition,
  commandOf,
  exclude,
  record,
  reviseTask,
} from "./model/commands";
import {
  PROGRESS_PAGE,
  parseDefinition,
  parseEvidence,
  parseProgressPage,
  parseProjection,
  parseTaskDetail,
} from "./model/contract";
import { evaluate } from "./model/evaluate";
import { editList, listItem, projectCreateList } from "./model/lists";
import { slotOn, windows } from "./model/time";

/**
 * The registrations of WEB-10a's queued kinds (plan §4.7) and WEB-10b's list kinds (its plan §3.4): a description for the queue, the
 * projection of a create the cache does not hold yet, the authorised current-state read of WF-QUEUE-02 (D-10a-15) and the rebuild of
 * "Resend as a new operation". Registered ONCE per registry (the registry throws on a second registration), before the routes render.
 */
export const DESCRIPTIONS: Readonly<Record<string, string>> = {
  create_task: "New task",
  revise_task: "Task change",
  record: "Progress entry",
  resolve: "Close or reopen a day",
  exclude: "Streak exclusion",
  revise_occurrence: "Correction to one day",
  archive: "Archive or restore",
  create_list: "New list",
  edit_list: "List name change",
  list_item: "List change",
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
  return taskRead(status, body);
}

/**
 * An archive's target is a task or a list (WEB-10b, plan §3.4): the task read first, exactly as before for a task (a `200` is that
 * answer); `GET /tasks/{id}` answers `404` for a list, and only then is the list read (`readListCurrent`). Any other answer is the task
 * read's. A task no longer readable costs the list walk too, and still ends `inaccessible`.
 */
async function readArchiveCurrent(
  draft: DraftWithCommand,
  io: CurrentReadIo,
): Promise<CurrentRead> {
  const id = draft.target_resource_ids[0];
  if (id === undefined) return { kind: "failed", reason: "unavailable" };
  const { status, body } = await readJson(
    io,
    `/tasks/${encodeURIComponent(id)}`,
  );
  if (status === 404) return readListCurrent(draft, io);
  return taskRead(status, body);
}

function taskRead(status: number, body: unknown): CurrentRead {
  if (status !== 200) return failedFor(status);
  const detail = parseTaskDetail(body);
  // The task's details come back with it and are kept beside it (DA-A1): a revision needs write access to both, and only this read says
  // whether the person still has it. The task is the reviewed value and the only base.
  return detail === null
    ? { kind: "indeterminate" }
    : {
        kind: "loaded",
        value: detail.task,
        related: detail.execution === null ? [] : [detail.execution],
      };
}

/**
 * My progress stream among a draft's targets: the target that is not the occurrence. A version-checked record or an exclusion names it as
 * a primary; a record that is NOT version-checked (an amount, an observation) names it as a SIDE EFFECT (`side_effect_bases`), so both
 * are looked at (R5, revision 1: the primaries alone missed it, and such a record could not be read or rebuilt).
 */
function streamOf(
  draft: DraftWithCommand,
  occurrenceId: unknown,
): string | undefined {
  return [
    ...draft.target_resource_ids,
    ...Object.keys(draft.side_effect_bases ?? {}),
  ].find((id) => id !== occurrenceId);
}

/**
 * Progress-level kinds: my stream from `GET /progress?parent_id=<occurrence>`, matched by its id. The collection is paged (R19, review of
 * 15 October 2026): the endpoint orders an occurrence's visible streams by id, so mine can be on any page. Walk the pages one at a time,
 * following each page's cursor, and stop at my stream; it is absent (`inaccessible`) only once a valid page ENDS the collection. A refusal
 * or an error of any page is that page's answer, and a page that is not one of this collection (`parseProgressPage`: a missing, repeated
 * or backward cursor among them) is `indeterminate`, never absence and never another request. Only the page in hand is kept. The data
 * layer seals the whole walk; a scope that ended (the dialog closed, the account changed) sends nothing more and answers nothing.
 */
async function readProgressCurrent(
  draft: DraftWithCommand,
  io: CurrentReadIo,
): Promise<CurrentRead> {
  const command = commandOf(draft);
  const occurrence = command?.occurrence_id;
  const stream = streamOf(draft, occurrence);
  const ended: CurrentRead = { kind: "failed", reason: "unavailable" };
  if (typeof occurrence !== "string" || stream === undefined) return ended;
  let after: string | null = null;
  for (;;) {
    if (io.signal.aborted) return ended;
    const { status, body } = await readJson(
      io,
      `/progress?parent_id=${encodeURIComponent(occurrence)}&limit=${PROGRESS_PAGE}${
        after === null ? "" : `&after=${encodeURIComponent(after)}`
      }`,
    );
    if (io.signal.aborted) return ended;
    if (status !== 200) return failedFor(status);
    const page = parseProgressPage(body, occurrence, after);
    if (page === null) return { kind: "indeterminate" };
    const row = page.items.find((item) => item.id === stream);
    if (row !== undefined) return { kind: "loaded", value: row };
    if (page.next_after === null)
      return { kind: "failed", reason: "inaccessible" };
    after = page.next_after;
  }
}

/** The page size of the list walk: the server's maximum (`reads.rs` `resources`: 1..=200). */
export const LIST_PAGE = 200;

/**
 * One page of `GET /lists?archived=<archived>&limit=200[&after=<after>]` (`ResourcePage`), or null when it is not what the released
 * endpoint answers to that request (as `parseProgressPage`, R19): exact keys; every item a list projection of the archived state asked
 * for, its ids strictly ascending and after `after`; and `next_after` the last id exactly when the page is full, otherwise null.
 */
export function parseListPage(
  value: unknown,
  archived: boolean,
  after: string | null,
): { items: CacheRow[]; next_after: string | null } | null {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).length !== 2 ||
    !Object.hasOwn(value, "items") ||
    !Object.hasOwn(value, "next_after")
  )
    return null;
  const { items, next_after: next } = value as Obj;
  if (!Array.isArray(items) || items.length > LIST_PAGE) return null;
  const out: CacheRow[] = [];
  let last = after;
  for (const raw of items) {
    const row = parseProjection(raw);
    if (
      row === null ||
      row.kind !== "list" ||
      row.parent_id !== null ||
      row.archived !== archived ||
      (last !== null && !(row.id > last))
    )
      return null;
    out.push(row);
    last = row.id;
  }
  if (out.length === LIST_PAGE ? next !== last : next !== null) return null;
  return { items: out, next_after: next as string | null };
}

/**
 * List-level kinds (WEB-10b): the list's projection from `GET /lists`, which filters by `archived` (default `false`). There is no read of
 * one list by its id, so the two collections are walked, the one the draft expects first (for an archive, the state before it; otherwise
 * active), each page following its cursor, until the list is found (`loaded`). Pages are id-ordered, so a valid page holding a larger id
 * ends that collection without it. The list is absent (`inaccessible`) only once BOTH collections ended without it. A refusal or an error
 * of any page is that page's answer; a page that is not one of the collection (`parseListPage`) is `indeterminate`, never absence and never
 * another request. Only the page in hand is kept, and a scope that ended (`io.signal`) sends nothing more (the contract of
 * `readProgressCurrent`).
 */
async function readListCurrent(
  draft: DraftWithCommand,
  io: CurrentReadIo,
): Promise<CurrentRead> {
  const command = commandOf(draft);
  const listId = command?.kind === "list_item" ? command.list_id : command?.id;
  const ended: CurrentRead = { kind: "failed", reason: "unavailable" };
  if (command === null || !isString(listId)) return ended;
  const first =
    command.kind === "archive" && typeof command.archived === "boolean"
      ? !command.archived
      : false;
  for (const archived of [first, !first]) {
    let after: string | null = null;
    for (;;) {
      if (io.signal.aborted) return ended;
      const cursor = after ? `&after=${encodeURIComponent(after)}` : "";
      const { status, body } = await readJson(
        io,
        `/lists?archived=${archived}&limit=${LIST_PAGE}${cursor}`,
      );
      if (io.signal.aborted) return ended;
      // Any answer but a 200 is this page's answer (`failedFor`); a 200 that is not a page of the collection is `indeterminate`.
      const page: ReturnType<typeof parseListPage> | undefined =
        status === 200 ? parseListPage(body, archived, after) : undefined;
      if (page === undefined) return failedFor(status);
      if (page === null) return { kind: "indeterminate" };
      const found = page.items.find((item) => item.id === listId);
      if (found) return { kind: "loaded", value: found };
      if (
        page.next_after === null ||
        page.items.some((item) => item.id > listId)
      )
        break;
      after = page.next_after;
    }
  }
  return { kind: "failed", reason: "inaccessible" };
}

/**
 * "Save as new" (WF-QUEUE-02) for a task command (R5, revision 1): the replacement is the SAME kind of request the person's act made, built
 * by its own builder from the stored command, so it keeps every target the original named (the ordering targets, the side effects whose
 * versions the server raises) with their roles and version checks, and the defaults the original captured (top-level `defaults_revision`
 * and context: a first record on an Anyone task is still checked against the audience the person saw, and the server refuses it when the
 * defaults have changed since, which sends it to the defaults review). The target the reviewed read is of is based on the REVIEWED version
 * (`reviewedBase`), never silently rebased on the cache, and the record of versions is raised from it, so a later save of the same target
 * follows on. The supersession is conditional on the draft still being the one reviewed (`expectDraft`).
 */
function asReplacement(
  draft: DraftWithCommand,
  request: EnqueueRequest,
  reviewed: { id: string; version: number } | null,
): EnqueueRequest {
  const body = draft.command as Obj;
  const capturedRevision =
    typeof body.defaults_revision === "string" ? body.defaults_revision : null;
  const captured =
    capturedRevision !== null ||
    draft.defaults_revision !== null ||
    draft.defaults_context !== null;
  return {
    ...request,
    targets: request.targets.map((target) =>
      reviewed !== null && target.resourceId === reviewed.id
        ? { ...target, reviewedBase: reviewed.version }
        : target,
    ),
    expectDraft: (stored) =>
      stored.local_id === draft.local_id &&
      stored.status === draft.status &&
      stored.command_digest === draft.command_digest,
    build: (bases) => {
      const built = request.build(bases);
      if (!captured) return built;
      const { defaultsReview: _review, ...rest } = built;
      const inner = (built.command as Obj).command as JsonObject;
      return {
        ...rest,
        command:
          capturedRevision === null
            ? { command: inner }
            : { command: inner, defaults_revision: capturedRevision },
        defaultsRevision: draft.defaults_revision,
        defaultsContext: draft.defaults_context,
      };
    },
  };
}

const isString = (value: unknown): value is string => typeof value === "string";

/**
 * What a STORED task command needs of my access, exactly as its builder states it (`model/commands`; WEB-10a DA17-N1/N2): the defaults
 * review's confirmation rebuilds a stored draft without the builder, so the needs are derived again from the draft and its body. A record
 * writes my stream and, when it creates it, needs the occurrence (`joinRequiresEdit`, decided from what the writing transaction knows);
 * an exclusion writes my stream; a closure and a correction need the occurrence; a revision the task and its details; an archive the
 * task or list; a rename or a membership change of a list the list (WEB-10b). A create needs nothing (its rows are its own). A body this cannot read needs nothing more than what the server decides.
 */
function admissionOf(draft: DraftWithCommand): TargetNeeds {
  const command = commandOf(draft);
  if (command === null) return {};
  const occurrence = command.occurrence_id;
  const stream = streamOf(draft, occurrence);
  switch (command.kind) {
    case "record":
      return isString(occurrence) && stream !== undefined
        ? { [stream]: { requiresEdit: true, joinRequiresEdit: occurrence } }
        : {};
    case "exclude":
      return stream === undefined ? {} : { [stream]: { requiresEdit: true } };
    case "resolve":
      return isString(occurrence)
        ? { [occurrence]: { requiresEdit: true } }
        : {};
    case "revise_occurrence":
    case "archive":
    case "edit_list":
      return isString(command.id)
        ? { [command.id]: { requiresEdit: true } }
        : {};
    case "list_item":
      return isString(command.list_id)
        ? { [command.list_id]: { requiresEdit: true } }
        : {};
    case "revise_task": {
      if (!isString(command.id)) return {};
      const needs: Record<string, { requiresEdit: true }> = {
        [command.id]: { requiresEdit: true },
      };
      for (const id of Object.keys(draft.side_effect_bases ?? {}))
        needs[id] = { requiresEdit: true };
      return needs;
    }
    default:
      return {};
  }
}

function rebuildRecord(
  draft: DraftWithCommand,
  current: CacheRow | null,
): EnqueueRequest | null {
  const command = commandOf(draft);
  if (command === null) return null;
  const evidence = parseEvidence(command.evidence);
  const occurrenceId = command.occurrence_id;
  const subject = command.subject_account_id;
  const stream = streamOf(draft, occurrenceId);
  if (
    evidence === null ||
    !isString(occurrenceId) ||
    !isString(subject) ||
    stream === undefined ||
    typeof command.happened_at !== "number"
  )
    return null;
  const replaces = isString(command.replaces) ? command.replaces : null;
  const checked = typeof command.expected_version === "number";
  // A version-checked record needs the reviewed version of my stream; a record that is not checked may continue without it.
  if (checked && current === null) return null;
  if (current !== null && current.id !== stream) return null;
  const captured =
    draft.defaults_revision !== null || draft.defaults_context !== null;
  return asReplacement(
    draft,
    record({
      occurrenceId,
      progressId: stream,
      me: subject,
      // A new operation: a new entry id; the person's `happened_at` is kept.
      entryId: crypto.randomUUID(),
      evidence,
      happenedAt: command.happened_at,
      replaces,
      // The stream the original created on demand (an Anyone task's first record): seeded at 1 again unless the read found it.
      firstAnyoneStream: captured,
      defaults: null,
    }),
    current === null ? null : { id: stream, version: current.version },
  );
}

/**
 * A revision rebuilt on the reviewed task (DA-A1): never under a known denial of the task or of its details, as the reviewed read returned
 * them (`related`); the writing transaction checks the cached rows again (`requiresEdit`). Details the read did not return are no
 * denial (the server decides), and nothing here is a grant.
 */
function rebuildReviseTask(
  draft: DraftWithCommand,
  current: CacheRow | null,
  related: readonly CacheRow[] = [],
): EnqueueRequest | null {
  const command = commandOf(draft);
  const [taskId, executionId] = draft.target_resource_ids;
  if (
    command === null ||
    current === null ||
    current.policy_version === undefined ||
    taskId === undefined ||
    current.id !== taskId
  )
    return null;
  const definition = parseDefinition(command.definition);
  const execution =
    executionId ??
    Object.keys(draft.side_effect_bases).find((id) => id !== taskId);
  if (
    definition === null ||
    !isString(command.title) ||
    execution === undefined
  )
    return null;
  // The rule of `reasons.ts` `editable`, stated here so the registration chunk does not load the screens' copy.
  const details = related.find((row) => row.id === execution);
  if (!current.can_edit || details?.can_edit === false) return null;
  return asReplacement(
    draft,
    reviseTask({
      taskId,
      executionId: execution,
      title: command.title,
      definition,
      policyVersion: current.policy_version,
    }),
    { id: taskId, version: current.version },
  );
}

function rebuildExclude(
  draft: DraftWithCommand,
  current: CacheRow | null,
): EnqueueRequest | null {
  const command = commandOf(draft);
  const occurrenceId = command?.occurrence_id;
  const stream = streamOf(draft, occurrenceId);
  if (
    command === null ||
    current === null ||
    !isString(occurrenceId) ||
    stream === undefined ||
    current.id !== stream ||
    typeof command.excluded !== "boolean"
  )
    return null;
  return asReplacement(
    draft,
    exclude({ occurrenceId, progressId: stream, excluded: command.excluded }),
    { id: stream, version: current.version },
  );
}

function rebuildArchive(
  draft: DraftWithCommand,
  current: CacheRow | null,
): EnqueueRequest | null {
  const command = commandOf(draft);
  const id = draft.target_resource_ids[0];
  // Archiving needs write access to the task or list (DA-A3): never rebuilt on a reviewed read that denies it.
  if (
    command === null ||
    current === null ||
    id === undefined ||
    current.id !== id ||
    (current.kind !== "task" && current.kind !== "list") ||
    !current.can_edit ||
    typeof command.archived !== "boolean"
  )
    return null;
  return asReplacement(
    draft,
    archiveResource({ id, archived: command.archived }),
    { id, version: current.version },
  );
}

/** A rename rebuilt on the reviewed list: its policy version (Q1) and write access as the reviewed read returned them. */
function rebuildEditList(
  draft: DraftWithCommand,
  current: CacheRow | null,
): EnqueueRequest | null {
  const command = commandOf(draft);
  const listId = draft.target_resource_ids[0];
  if (
    command === null ||
    current === null ||
    listId === undefined ||
    current.id !== listId ||
    current.kind !== "list" ||
    current.policy_version === undefined ||
    current.can_edit === false ||
    !isString(command.name)
  )
    return null;
  return asReplacement(
    draft,
    editList({
      listId,
      name: command.name,
      policyVersion: current.policy_version,
    }),
    { id: listId, version: current.version },
  );
}

/**
 * A membership change rebuilt on the reviewed list: the same task and direction, on the reviewed version, with write access. No
 * `dependsOnExtra`: a task the original waited for was sent, or rejected with it, before the original could conflict.
 */
function rebuildListItem(
  draft: DraftWithCommand,
  current: CacheRow | null,
): EnqueueRequest | null {
  const command = commandOf(draft);
  const listId = draft.target_resource_ids[0];
  if (
    command === null ||
    current === null ||
    listId === undefined ||
    current.id !== listId ||
    command.list_id !== listId ||
    current.kind !== "list" ||
    current.can_edit === false ||
    !isString(command.task_id) ||
    typeof command.included !== "boolean"
  )
    return null;
  return asReplacement(
    draft,
    listItem({ listId, taskId: command.task_id, included: command.included }),
    { id: listId, version: current.version },
  );
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
      rebuild: rebuildReviseTask,
      admission: admissionOf,
    },
    record: {
      describe: describe("record"),
      readCurrent: readProgressCurrent,
      rebuild: rebuildRecord,
      admission: admissionOf,
    },
    exclude: {
      describe: describe("exclude"),
      readCurrent: readProgressCurrent,
      rebuild: rebuildExclude,
      admission: admissionOf,
    },
    // No authorised read of one occurrence exists for its draft (`/occurrences` lists by task, which the draft does not name), so a
    // closure cannot be rebuilt on a reviewed version: only discarded (R5, revision 1; it was never rebuildable without one).
    resolve: { describe: describe("resolve"), admission: admissionOf },
    revise_occurrence: {
      describe: describe("revise_occurrence"),
      admission: admissionOf,
    },
    archive: {
      describe: describe("archive"),
      readCurrent: readArchiveCurrent,
      rebuild: rebuildArchive,
      admission: admissionOf,
    },
    create_list: {
      describe: describe("create_list"),
      projectCreate: projectCreateList,
    },
    edit_list: {
      describe: describe("edit_list"),
      readCurrent: readListCurrent,
      rebuild: rebuildEditList,
      admission: admissionOf,
    },
    list_item: {
      describe: describe("list_item"),
      readCurrent: readListCurrent,
      rebuild: rebuildListItem,
      admission: admissionOf,
    },
  };
}

const registered = new WeakSet<CommandRegistry>();

/** Registers every WEB-10a and WEB-10b kind into `registry`, once (idempotent per registry). */
export function registerTaskCommands(registry: CommandRegistry): void {
  if (registered.has(registry)) return;
  registered.add(registry);
  for (const [kind, spec] of Object.entries(taskCommandSpecs()))
    registry.register(kind, spec);
}
