import {
  type Bases,
  type CacheRow,
  captureDefaults,
  type DefaultsRecord,
  type DraftWithCommand,
  type EnqueueRequest,
  isUuid,
  type JsonObject,
  type LocalId,
  type Observation,
} from "../../../data";
import { commandOf, TASK_ENDPOINT } from "./commands";

/**
 * WEB-10b's list commands as outbox requests (plan §3.1; backend `commands.rs` 509-586, the vendored `TaskCreateList`, `TaskEditList`,
 * `TaskListItem` and `TaskArchive`). Pure, like `commands.ts`: ids, the defaults record and the policy version are decided before a request
 * is built and passed in, and `build` turns the bases the enqueue transaction read into the whole wire body. Every body carries exactly the
 * schema's keys; an optional field is omitted, never sent as `null`.
 *
 * A list's membership is never a display patch (D-10b-4): a patch built from the array one screen saw would drop another tab's queued add
 * while it is shown. `list-view.ts` composes it from the outstanding `list_item` drafts instead.
 */
export const LIST_KINDS = [
  "create_list",
  "edit_list",
  "list_item",
  "archive",
] as const;
/** The server's cap on a list's task references, counting tasks the reader cannot see (backend docs/tasks.md §Bounds; `commands.rs` 562). */
export const LIST_CAPACITY = 100;
/** A list name's length limit, in code points (`lib.rs` 159-165: `label.chars().count() <= 300`). */
export const LIST_NAME_MAX = 300;

export type ListNameProblem = "blank" | "too_long";

/**
 * The server's name rule exactly (`lib.rs` 159-165): blank is Unicode `White_Space` only (Rust's `trim`, which `String.prototype.trim`
 * does not match: U+0085 is White_Space and U+FEFF is not), and the length is counted in code points, not UTF-16 units.
 */
export function listNameProblem(name: string): ListNameProblem | null {
  if (/^\p{White_Space}*$/u.test(name)) return "blank";
  return [...name].length > LIST_NAME_MAX ? "too_long" : null;
}

export interface ListValue {
  task_ids: string[];
}

/** A list projection's value (`service.rs` 296-303: `{"task_ids": [...]}`, the visible ids), or null when it is not one. */
export function parseListValue(value: unknown): ListValue | null {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return null;
  const keys = Object.keys(value);
  if (keys.length !== 1 || keys[0] !== "task_ids") return null;
  const ids = (value as { task_ids: unknown }).task_ids;
  if (!Array.isArray(ids) || ids.length > LIST_CAPACITY) return null;
  if (!ids.every((id) => isUuid(id)) || new Set(ids).size !== ids.length)
    return null;
  return { task_ids: [...ids] };
}

const primary = (resourceId: string) =>
  ({
    resourceId,
    role: "primary",
    basis: "resource",
    versionChecked: true,
    requiresEdit: true,
  }) as const;

// ---- create_list --------------------------------------------------------------------------------------------------------------
export interface CreateListInput {
  listId: string;
  name: string;
  /** The defaults record as it is at the person's act: the `list` defaults are captured (WEB-12a contract §1-2; D-10b-3). */
  defaults: DefaultsRecord | null;
  localId?: string;
}

/**
 * A new list. No `initial_policy`: the server applies the resolved `list` defaults at send, checked against the revision captured here
 * (`defaults_changed`). Defaults this device never fetched hold the create for review (D-10b-3).
 */
export function createList(input: CreateListInput): EnqueueRequest {
  const captured = captureDefaults(input.defaults, ["list"]);
  const command: JsonObject = {
    kind: "create_list",
    id: input.listId,
    name: input.name,
  };
  return {
    endpoint: TASK_ENDPOINT,
    targets: [
      {
        resourceId: input.listId,
        role: "primary",
        basis: "resource",
        versionChecked: false,
        seedIfUntracked: 1,
      },
    ],
    ...(input.localId === undefined ? {} : { localId: input.localId }),
    build: () => ({
      command: (captured.defaultsRevision === null
        ? { command }
        : {
            command,
            defaults_revision: captured.defaultsRevision,
          }) as JsonObject,
      defaultsRevision: captured.defaultsRevision,
      defaultsContext: captured.defaultsContext,
      defaultsReview: captured.defaultsReview,
    }),
  };
}

/**
 * A rename of a list whose `create_list` is still `queued` (D-10b-8): that create, edited in place with ONLY its name changed. Its id,
 * `initial_policy` and top-level `defaults_revision` stay as stored, its captured defaults stay (the build names none), and its review block
 * stays (no `defaultsReview`: an edit of the name is not a review of the audience). Written only to the draft this rename was shown
 * (`expectDraft`): another tab's edit committed in between is never overwritten. Null when the draft is not a create of a list.
 */
export function renameQueuedCreate(
  draft: DraftWithCommand,
  name: string,
): EnqueueRequest | null {
  const command = commandOf(draft);
  const listId = draft.target_resource_ids[0];
  if (
    command === null ||
    command.kind !== "create_list" ||
    listId === undefined ||
    command.id !== listId
  )
    return null;
  const stored = draft.command as JsonObject;
  return {
    endpoint: TASK_ENDPOINT,
    targets: [
      {
        resourceId: listId,
        role: "primary",
        basis: "resource",
        versionChecked: false,
        seedIfUntracked: 1,
      },
    ],
    expectDraft: (now) =>
      now.local_id === draft.local_id &&
      now.status === "queued" &&
      now.command_digest === draft.command_digest,
    build: () => ({
      command: { ...stored, command: { ...(command as JsonObject), name } },
    }),
  };
}

// ---- edit_list ------------------------------------------------------------------------------------------------------------------
export interface EditListInput {
  listId: string;
  name: string;
  /** The cached list's `policy_version` (Q1): required, an edit without one cannot be built. */
  policyVersion: number;
  localId?: string;
}

export function editList(input: EditListInput): EnqueueRequest {
  return {
    endpoint: TASK_ENDPOINT,
    // Renaming needs write access to the list: a known denial refuses it in the transaction that would write it.
    targets: [primary(input.listId)],
    ...(input.localId === undefined ? {} : { localId: input.localId }),
    build: (bases: Bases) => ({
      command: {
        command: {
          kind: "edit_list",
          id: input.listId,
          expected_version: bases[input.listId] as number,
          expected_policy_version: input.policyVersion,
          name: input.name,
        },
      },
      displayPatch: { [input.listId]: { label: input.name } },
    }),
  };
}

// ---- list_item ----------------------------------------------------------------------------------------------------------------
export interface ListItemInput {
  listId: string;
  taskId: string;
  included: boolean;
  /** The outstanding `create_task` of a task this device has not sent yet (D-10b-11): this change is sent after it, or not at all. */
  after?: LocalId | null;
  localId?: string;
  /**
   * What the read that chose `after` saw of the TASK (`readResourceView`'s observation; revision 4, D1 / DA-N1): the add is written only
   * if its transaction reads the same facts of the task, so a create replaced, discarded or published after that read is never named.
   */
  observed?: Observation;
}

/**
 * Adds a task to a list or removes it (`list_item`): edit access to the list and read access to the task, checked by the server. Only the
 * list is a target, so a list change never waits behind an unrelated task conflict; a task not sent yet is named in `dependsOnExtra`.
 * No display patch (D-10b-4).
 */
export function listItem(input: ListItemInput): EnqueueRequest {
  return {
    endpoint: TASK_ENDPOINT,
    targets: [primary(input.listId)],
    ...(input.after ? { dependsOnExtra: [input.after] } : {}),
    ...(input.localId === undefined ? {} : { localId: input.localId }),
    ...(input.observed === undefined ? {} : { observed: input.observed }),
    build: (bases: Bases) => ({
      command: {
        command: {
          kind: "list_item",
          list_id: input.listId,
          expected_version: bases[input.listId] as number,
          task_id: input.taskId,
          included: input.included,
        },
      },
    }),
  };
}

/**
 * The projection of an outstanding `create_list` for its own list id (and no other): what the server will create, before the cache
 * holds it. A new list is empty, editable by its creator and not archived.
 */
export function projectCreateList(
  draft: DraftWithCommand,
  resourceId: string,
): CacheRow | null {
  const command = commandOf(draft);
  if (
    command === null ||
    command.kind !== "create_list" ||
    command.id !== resourceId ||
    typeof command.name !== "string"
  )
    return null;
  return {
    id: resourceId,
    kind: "list",
    parent_id: null,
    label: command.name,
    value: { task_ids: [] },
    version: 1,
    can_edit: true,
    archived: false,
    kind_date: null,
  };
}

// ---- form recovery readiness (Q4; WEB-14a supplies the app-update event that captures them) ---------------------------------------
/**
 * The Lists' recoverable forms, PURE, as WEB-10a's (`recovery.ts`): the raw input as canonical JSON keyed by a form context, no secrets.
 * Restoring NEVER submits: the values are shown again and saving stays the person's act. A value that does not parse restores nothing.
 * Ids and attempt keys are not recovered: a restored form is a new save.
 */
export const newListFormContext = (formId: string) => `list-form:new:${formId}`;
export const listFormContext = (listId: string) => `list-form:${listId}`;
export const listPickerContext = (listId: string) => `list-picker:${listId}`;

export const listFormRecoveryValues = (
  name: string,
): Record<string, string> => ({
  list: JSON.stringify({ name }),
});

export function restoreListForm(
  values: Readonly<Record<string, string>>,
): { name: string } | null {
  try {
    const raw = JSON.parse(values.list ?? "null") as unknown;
    if (typeof raw !== "object" || raw === null || Array.isArray(raw))
      return null;
    const keys = Object.keys(raw);
    const name = (raw as { name?: unknown }).name;
    return keys.length === 1 && typeof name === "string" ? { name } : null;
  } catch {
    return null;
  }
}

export const pickerRecoveryValues = (input: {
  query: string;
  selected: readonly string[];
}): Record<string, string> => ({
  picker: JSON.stringify({ query: input.query, selected: [...input.selected] }),
});

export function restorePicker(
  values: Readonly<Record<string, string>>,
): { query: string; selected: string[] } | null {
  try {
    const raw = JSON.parse(values.picker ?? "null") as unknown;
    if (typeof raw !== "object" || raw === null || Array.isArray(raw))
      return null;
    const { query, selected } = raw as { query?: unknown; selected?: unknown };
    if (
      Object.keys(raw).length !== 2 ||
      typeof query !== "string" ||
      !Array.isArray(selected) ||
      selected.length > LIST_CAPACITY ||
      !selected.every((id) => isUuid(id)) ||
      new Set(selected).size !== selected.length
    )
      return null;
    return { query, selected: [...selected] };
  } catch {
    return null;
  }
}
