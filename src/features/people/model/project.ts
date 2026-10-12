import type {
  CacheRow,
  DraftStatus,
  DraftWithCommand,
  LocalId,
} from "../../../data";

/**
 * What the people screens show of this device's OUTSTANDING saves (§3.2 `project.ts`). PURE.
 *
 * The cache shows what the server published; the overlay (`pending_effects`) exists only once a draft has been CLAIMED for sending. A
 * change the person saved that is still queued (offline, or waiting for the defaults review) is therefore not in either, and the screens
 * fold the bodies of the outstanding drafts (`useOutstandingCreates`) over the cached rows themselves:
 *  - a create the cache does not hold yet is PROJECTED as a row (a person, a person's first note, a field), marked as not sent;
 *  - a later change (a rename, a field update, an archive) of a row is applied over it, in queue order, and the row is marked.
 * Nothing here is ever sent or stored; it is only what is shown, and a projected row is never a base for a version-checked command.
 */
export type ChangeKind =
  | "create_person"
  | "create_field"
  | "put_field_create"
  | "put_field_update"
  | "edit"
  | "archive";

export interface Change {
  localId: LocalId;
  status: DraftStatus;
  /** Queued but held for the defaults review (never sent until the person confirms it). */
  reviewing: boolean;
  createdSeq: number;
  kind: ChangeKind;
  id: string;
  parentId: string | null;
  label?: string;
  /** A field's value as saved (a `FieldValue`, or a note's text as a text value). */
  value?: Record<string, unknown>;
  archived?: boolean;
}

type Obj = Record<string, unknown>;
const isObject = (value: unknown): value is Obj =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

/** The changes one outstanding draft makes, read defensively from its body (an unrecognised body changes nothing shown). */
export function changesOf(draft: DraftWithCommand): Change[] {
  const base = {
    localId: draft.local_id,
    status: draft.status,
    reviewing: draft.review_block !== null,
    createdSeq: draft.created_seq,
  };
  const body = draft.command as Obj;
  const out: Change[] = [];
  if (Array.isArray(body.commands)) {
    for (const item of body.commands) {
      if (!isObject(item) || typeof item.id !== "string") continue;
      if (item.kind === "create_person" && text(item.name) !== undefined) {
        out.push({
          ...base,
          kind: "create_person",
          id: item.id,
          parentId: null,
          label: text(item.name) as string,
        });
      } else if (
        item.kind === "create_field" &&
        typeof item.person_id === "string" &&
        text(item.label) !== undefined &&
        text(item.value) !== undefined
      ) {
        out.push({
          ...base,
          kind: "create_field",
          id: item.id,
          parentId: item.person_id,
          label: text(item.label) as string,
          value: { kind: "text", text: item.value },
        });
      } else if (item.kind === "edit" && text(item.label) !== undefined) {
        out.push({
          ...base,
          kind: "edit",
          id: item.id,
          parentId: null,
          label: text(item.label) as string,
        });
      }
    }
    return out;
  }
  const command = body.command;
  if (!isObject(command) || typeof command.id !== "string") return out;
  if (command.kind === "put_field" && typeof command.parent_id === "string") {
    const update =
      command.expected_version !== undefined &&
      command.expected_version !== null;
    out.push({
      ...base,
      kind: update ? "put_field_update" : "put_field_create",
      id: command.id,
      parentId: command.parent_id,
      ...(text(command.label) === undefined
        ? {}
        : { label: text(command.label) as string }),
      ...(isObject(command.value) ? { value: command.value } : {}),
    });
  } else if (
    command.kind === "archive" &&
    typeof command.archived === "boolean"
  ) {
    out.push({
      ...base,
      kind: "archive",
      id: command.id,
      parentId: null,
      archived: command.archived,
    });
  }
  return out;
}

/** Every change of many drafts, in queue order. */
export const changesOfAll = (drafts: readonly DraftWithCommand[]): Change[] =>
  drafts.flatMap(changesOf).sort((a, b) => a.createdSeq - b.createdSeq);

/** How a row is marked (§4.3): not sent yet, sending, waiting for the server, or held for the defaults review. */
export type PendingMark = "not_sent" | "sending" | "waiting" | "reviewing";

export const markOf = (change: Change): PendingMark =>
  change.reviewing
    ? "reviewing"
    : change.status === "in_flight"
      ? "sending"
      : change.status === "acknowledged"
        ? "waiting"
        : "not_sent";

export interface ShownRow {
  row: CacheRow;
  /** The mark of the latest outstanding change of this row (or of the create that projects it); null when nothing is outstanding. */
  pending: PendingMark | null;
  /** The row exists only as a create saved on this device: it has no server version to edit, archive or rename against. */
  projected: boolean;
  /** The outstanding create's draft, for a projected row (an unsent create's content is edited in place, D-11a-15). */
  createDraft: LocalId | null;
  /** The newest outstanding change of the row (an update or archive), for in-place coalescing of a queued one. */
  latest: Change | null;
}

const CREATES: ReadonlySet<ChangeKind> = new Set([
  "create_person",
  "create_field",
  "put_field_create",
]);

function projected(change: Change, kind: "person" | "field"): CacheRow {
  return {
    id: change.id,
    kind,
    parent_id: change.parentId,
    label: change.label ?? "",
    value: (change.value as CacheRow["value"]) ?? null,
    // Not a server version: a projected row is never a base (`projected: true`).
    version: 0,
    can_edit: true,
    archived: false,
    kind_date: null,
  };
}

/**
 * The rows of one kind (optionally under one parent) as the screen shows them: the cached rows (already merged with the claimed
 * overlay) with the outstanding changes applied in queue order, plus the creates the cache does not hold yet. Cached rows keep their
 * order; projected rows follow in queue order (the caller sorts for display).
 */
export function foldRows(
  cached: readonly CacheRow[],
  changes: readonly Change[],
  kind: "person" | "field",
  parentId?: string,
): ShownRow[] {
  const rows = new Map<string, ShownRow>();
  for (const row of cached)
    rows.set(row.id, {
      row,
      pending: null,
      projected: false,
      createDraft: null,
      latest: null,
    });
  for (const change of changes) {
    if (CREATES.has(change.kind)) {
      const rowKind = change.kind === "create_person" ? "person" : "field";
      if (rowKind !== kind) continue;
      if (parentId !== undefined && change.parentId !== parentId) continue;
      const known = rows.get(change.id);
      if (known === undefined) {
        rows.set(change.id, {
          row: projected(change, kind),
          pending: markOf(change),
          projected: true,
          createDraft: change.localId,
          latest: null,
        });
      } else if (known.projected) {
        // A later create of the same id (an edited resend) replaces the projection.
        known.row = projected(change, kind);
        known.pending = markOf(change);
        known.createDraft = change.localId;
      } else {
        // The cache already holds it: the create is only waiting to be released.
        known.pending = markOf(change);
      }
      continue;
    }
    const shown = rows.get(change.id);
    if (shown === undefined) continue;
    const row = { ...shown.row };
    if (change.label !== undefined) row.label = change.label;
    if (change.value !== undefined)
      row.value = change.value as CacheRow["value"];
    if (change.archived !== undefined) row.archived = change.archived;
    shown.row = row;
    shown.pending = markOf(change);
    shown.latest = change;
  }
  return [...rows.values()];
}

/** The display order of a list of people: by name (base sensitivity, surrounding spaces ignored), then by id. */
const collator = new Intl.Collator(undefined, { sensitivity: "base" });
export const byName = (a: ShownRow, b: ShownRow): number =>
  collator.compare(a.row.label.trim(), b.row.label.trim()) ||
  (a.row.id < b.row.id ? -1 : a.row.id > b.row.id ? 1 : 0);
