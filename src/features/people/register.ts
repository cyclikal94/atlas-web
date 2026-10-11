import type {
  CacheRow,
  CommandRegistry,
  CurrentRead,
  CurrentReadIo,
  DraftRow,
  DraftWithCommand,
  EnqueueRequest,
  JsonObject,
} from "../../data";
import {
  registerArchiveKind,
  registerArchiveReader,
} from "../content/archive-registration";
import { type Projection, parsePersonDetail, parseProjectionPage } from "./api";

/**
 * WEB-11a's command registrations (§3.4): how the sync queue screens describe a people draft, read its target's CURRENT state from the
 * server (WF-QUEUE-02's "Currently saved": an ordinary authorised read, never the cache) and rebuild it as a new operation on that state.
 * Registered ONCE per registry, from the protected tree's composition before any route renders (a second call does nothing).
 *
 * | kind            | describe            | current read                                         | rebuild                                       |
 * | `create_person` | "New person"        | —                                                    | —                                             |
 * | `create_field`  | "New note"          | —  (only ever second in a batch, never a header kind) | —                                             |
 * | `put_field`     | "Field change"      | `GET /fields?parent_id=…` then `&archived=true`      | an update: same name and value, current bases |
 * | `edit`          | "Name change"       | `GET /people/{id}`                                   | same name, current bases                      |
 * | `archive`       | (shared, `content/archive-registration.ts`) + the person reader `GET /people/{id}`                   |
 */
type Obj = Record<string, unknown>;
const isObject = (value: unknown): value is Obj =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const asRow = (projection: Projection): CacheRow => ({
  ...projection,
  kind_date: null,
});

async function json(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

const refusedRead = (status: number): CurrentRead | null =>
  status === 403 || status === 404 || status === 410
    ? { kind: "failed", reason: "inaccessible" }
    : null;

/** `GET /people/{id}` as a current read: the person, or `indeterminate` when the id now resolves to another (merged) person. */
export async function readPersonCurrent(
  id: string,
  io: CurrentReadIo,
): Promise<CurrentRead> {
  const response = await io.get(`/people/${encodeURIComponent(id)}`);
  if (!response.ok)
    return refusedRead(response.status) ?? { kind: "failed", reason: "error" };
  const detail = parsePersonDetail(await json(response));
  if (detail === null) return { kind: "failed", reason: "error" };
  if (detail.person.id !== id) return { kind: "indeterminate" };
  return { kind: "loaded", value: asRow(detail.person) };
}

/** The archive reader for people: a `404` is not this kind's to answer (the target may be a field or a task). */
async function personArchiveReader(
  id: string,
  io: CurrentReadIo,
): Promise<CurrentRead | null> {
  const response = await io.get(`/people/${encodeURIComponent(id)}`);
  if (response.status === 404) return null;
  if (!response.ok)
    return refusedRead(response.status) ?? { kind: "failed", reason: "error" };
  const detail = parsePersonDetail(await json(response));
  if (detail === null) return { kind: "failed", reason: "error" };
  return detail.person.id === id
    ? { kind: "loaded", value: asRow(detail.person) }
    : { kind: "indeterminate" };
}

const FIELD_PAGE = 200;
const FIELD_PAGES = 5;

/** The field among its person's fields (and then the archived ones), at most 5 pages of 200 each; `indeterminate` when not found. */
export async function readFieldCurrent(
  fieldId: string,
  parentId: string,
  io: CurrentReadIo,
): Promise<CurrentRead> {
  for (const archived of [false, true]) {
    let after: string | null = null;
    for (let page = 0; page < FIELD_PAGES; page += 1) {
      const query = new URLSearchParams({
        parent_id: parentId,
        limit: String(FIELD_PAGE),
        ...(archived ? { archived: "true" } : {}),
        ...(after === null ? {} : { after }),
      });
      const response = await io.get(`/fields?${query.toString()}`);
      if (!response.ok)
        return (
          refusedRead(response.status) ?? { kind: "failed", reason: "error" }
        );
      const parsed = parseProjectionPage(await json(response), FIELD_PAGE);
      if (parsed === null) return { kind: "failed", reason: "error" };
      const found = parsed.items.find((item) => item.id === fieldId);
      if (found !== undefined) return { kind: "loaded", value: asRow(found) };
      if (parsed.next_after === null) break;
      after = parsed.next_after;
    }
  }
  return { kind: "indeterminate" };
}

/** The single `put_field` a draft carries, or null. */
export function putFieldOf(draft: DraftWithCommand): {
  id: string;
  parentId: string;
  update: boolean;
  label: string;
  value: JsonObject;
} | null {
  const command = (draft.command as Obj).command;
  if (
    !isObject(command) ||
    command.kind !== "put_field" ||
    typeof command.id !== "string" ||
    typeof command.parent_id !== "string" ||
    typeof command.label !== "string" ||
    !isObject(command.value)
  )
    return null;
  return {
    id: command.id,
    parentId: command.parent_id,
    update:
      command.expected_version !== undefined &&
      command.expected_version !== null,
    label: command.label,
    value: command.value as JsonObject,
  };
}

/** The single person `edit` a draft carries, or null. */
export function renameOf(
  draft: DraftWithCommand,
): { id: string; label: string } | null {
  const commands = (draft.command as Obj).commands;
  if (!Array.isArray(commands) || commands.length !== 1) return null;
  const [edit] = commands;
  if (
    !isObject(edit) ||
    edit.kind !== "edit" ||
    typeof edit.id !== "string" ||
    typeof edit.label !== "string"
  )
    return null;
  return { id: edit.id, label: edit.label };
}

const checkedTarget = (id: string) =>
  [
    {
      resourceId: id,
      role: "primary",
      basis: "resource",
      versionChecked: true,
    },
  ] as const;

export function rebuildPutField(
  draft: DraftWithCommand,
  current: CacheRow | null,
): EnqueueRequest | null {
  const put = putFieldOf(draft);
  if (
    put === null ||
    !put.update ||
    current === null ||
    current.id !== put.id ||
    current.kind !== "field" ||
    current.policy_version === undefined
  )
    return null;
  const policyVersion = current.policy_version;
  return {
    endpoint: "/task-commands",
    targets: checkedTarget(put.id),
    build: () => ({
      command: {
        command: {
          kind: "put_field",
          id: put.id,
          parent_id: put.parentId,
          expected_version: current.version,
          expected_policy_version: policyVersion,
          label: put.label,
          value: put.value,
        },
      },
      displayPatch: { [put.id]: { label: put.label } },
    }),
  };
}

export function rebuildRename(
  draft: DraftWithCommand,
  current: CacheRow | null,
): EnqueueRequest | null {
  const rename = renameOf(draft);
  if (
    rename === null ||
    current === null ||
    current.id !== rename.id ||
    current.kind !== "person" ||
    current.policy_version === undefined
  )
    return null;
  const policyVersion = current.policy_version;
  return {
    endpoint: "/commands",
    targets: checkedTarget(rename.id),
    build: () => ({
      command: {
        commands: [
          {
            kind: "edit",
            id: rename.id,
            expected_version: current.version,
            expected_policy_version: policyVersion,
            label: rename.label,
            value: "",
          },
        ],
      },
      displayPatch: { [rename.id]: { label: rename.label } },
    }),
  };
}

const registered = new WeakSet<CommandRegistry>();

/** Registers every WEB-11a kind into `registry` (idempotent per registry). */
export function registerPeopleCommands(registry: CommandRegistry): void {
  if (registered.has(registry)) return;
  registered.add(registry);
  registry.register("create_person", { describe: () => "New person" });
  registry.register("create_field", { describe: () => "New note" });
  registry.register("put_field", {
    describe: () => "Field change",
    readCurrent: async (draft, io) => {
      const put = putFieldOf(draft);
      return put === null
        ? { kind: "indeterminate" }
        : readFieldCurrent(put.id, put.parentId, io);
    },
    rebuild: rebuildPutField,
  });
  registry.register("edit", {
    describe: (_draft: DraftRow) => "Name change",
    readCurrent: async (draft, io) => {
      const rename = renameOf(draft);
      return rename === null
        ? { kind: "indeterminate" }
        : readPersonCurrent(rename.id, io);
    },
    rebuild: rebuildRename,
  });
  registerArchiveReader(personArchiveReader);
  registerArchiveKind(registry);
}
