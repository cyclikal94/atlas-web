import {
  captureDefaults,
  type DefaultsRecord,
  type DraftWithCommand,
  type EnqueueRequest,
  type JsonObject,
  type LocalId,
  type Policy,
  type TargetSpec,
} from "../../../data";
import { ONLY_YOU_POLICY } from "./audience";
import type { PersonSharing } from "./person-form";
import type { FieldValue } from "./values";

/**
 * What WEB-11a sends (§3.3). PURE: request builders for the outbox and the bodies of the online-only commands.
 *
 * Queued (offline-capable):
 *  - `create_person` (+ the optional first note, `create_field`, in the SAME atomic `/commands` batch, person first: SHARE-10);
 *  - `put_field` create on `/task-commands` (private or "Use my defaults"), and update (Q1: `expected_version` AND
 *    `expected_policy_version`);
 *  - `edit` on `/commands`: renaming a person whose profile is NOT linked (D-11a-5);
 *  - `archive` on `/task-commands`, of a person or a field, both directions.
 * Online-only, never queued: `rename_profile` and `unlink` (`/people-commands`), and a SHARED field create (`/task-access-commands`).
 *
 * Rules: optional fields are OMITTED, never `null`; a create never carries `expected_version` or `expected_policy_version`; an update
 * never carries `initial_policy`; a field's `parent_id` is the person it was created under and is never changed. An explicit private
 * policy is exactly `{grants: [], exclude_accounts: []}`. "Use my defaults" omits the policy and CAPTURES the template kinds the command
 * consumes (`captureDefaults`, WEB-12a): the revision guard, the "Was" side of the review, and a review block when the defaults were never
 * fetched (or name a household nobody here has seen).
 */
const created = (resourceId: string): TargetSpec => ({
  resourceId,
  role: "primary",
  basis: "resource",
  versionChecked: false,
  seedIfUntracked: 1,
});
const checked = (resourceId: string): TargetSpec => ({
  resourceId,
  role: "primary",
  basis: "resource",
  versionChecked: true,
});

/** The parts of a capture a build attaches, and the body's top-level `defaults_revision` (omitted when none was ever fetched). */
function captured(
  record: DefaultsRecord | null,
  kinds: Array<"person" | "field">,
): {
  body: { defaults_revision?: string };
  result: {
    defaultsRevision: string | null;
    defaultsContext: unknown;
    defaultsReview: string[];
  };
} {
  const capture = captureDefaults(record, kinds);
  return {
    body:
      capture.defaultsRevision === null
        ? {}
        : { defaults_revision: capture.defaultsRevision },
    result: {
      defaultsRevision: capture.defaultsRevision,
      defaultsContext: capture.defaultsContext,
      defaultsReview: capture.defaultsReview,
    },
  };
}

// ---- new person (+ note) --------------------------------------------------------------------------------------------------------
export interface CreatePersonInput {
  personId: string;
  name: string;
  sharing: PersonSharing;
  /** The first note, created in the same batch; null when none is sent. */
  note: { fieldId: string; label: string; text: string } | null;
  /** The B5 record as `useSharingDefaults()` holds it now (null: never fetched). */
  record: DefaultsRecord | null;
}

export function createPersonRequest(input: CreatePersonInput): EnqueueRequest {
  const explicit = input.sharing === "only_you";
  const policy = (): { initial_policy?: JsonObject } =>
    explicit
      ? { initial_policy: ONLY_YOU_POLICY() as unknown as JsonObject }
      : {};
  const commands: JsonObject[] = [
    {
      kind: "create_person",
      id: input.personId,
      name: input.name,
      ...policy(),
    } as JsonObject,
  ];
  if (input.note !== null)
    commands.push({
      kind: "create_field",
      id: input.note.fieldId,
      person_id: input.personId,
      label: input.note.label,
      value: input.note.text,
      ...policy(),
    } as JsonObject);
  const kinds: Array<"person" | "field"> = explicit
    ? []
    : input.note === null
      ? ["person"]
      : ["person", "field"];
  return {
    endpoint: "/commands",
    targets: [
      created(input.personId),
      ...(input.note === null ? [] : [created(input.note.fieldId)]),
    ],
    build: () => {
      if (kinds.length === 0) return { command: { commands } };
      const capture = captured(input.record, kinds);
      return { command: { commands, ...capture.body }, ...capture.result };
    },
  };
}

// ---- fields -----------------------------------------------------------------------------------------------------------------------
export interface PutFieldCreateInput {
  fieldId: string;
  personId: string;
  label: string;
  value: FieldValue;
  audience: "defaults" | "only_you";
  record: DefaultsRecord | null;
  /** The person's own queued create when the person exists only on this device (the field waits for it). */
  dependsOn?: readonly LocalId[];
}

export function putFieldCreateRequest(
  input: PutFieldCreateInput,
): EnqueueRequest {
  const command: JsonObject = {
    kind: "put_field",
    id: input.fieldId,
    parent_id: input.personId,
    label: input.label,
    value: input.value as unknown as JsonObject,
    ...(input.audience === "only_you"
      ? { initial_policy: ONLY_YOU_POLICY() as unknown as JsonObject }
      : {}),
  };
  return {
    endpoint: "/task-commands",
    targets: [created(input.fieldId)],
    ...(input.dependsOn === undefined || input.dependsOn.length === 0
      ? {}
      : { dependsOnExtra: [...input.dependsOn] }),
    build: () => {
      if (input.audience === "only_you") return { command: { command } };
      const capture = captured(input.record, ["field"]);
      return { command: { command, ...capture.body }, ...capture.result };
    },
  };
}

export interface PutFieldUpdateInput {
  fieldId: string;
  personId: string;
  label: string;
  value: FieldValue;
  /** The field's merged `policy_version` when the edit began (Q1); the save is refused without one. */
  policyVersion: number;
  /** Whether the value keeps the field's current type: only then is the value part of the display patch (a shallow merge). */
  sameKind: boolean;
}

export function putFieldUpdateRequest(
  input: PutFieldUpdateInput,
): EnqueueRequest {
  return {
    endpoint: "/task-commands",
    targets: [checked(input.fieldId)],
    build: (bases) => ({
      command: {
        command: {
          kind: "put_field",
          id: input.fieldId,
          parent_id: input.personId,
          expected_version: bases[input.fieldId] as number,
          expected_policy_version: input.policyVersion,
          label: input.label,
          value: input.value as unknown as JsonObject,
        },
      },
      displayPatch: {
        [input.fieldId]: {
          label: input.label,
          ...(input.sameKind
            ? { value: input.value as unknown as Record<string, unknown> }
            : {}),
        },
      },
    }),
  };
}

/**
 * An edit of a create that has NOT been sent (D-11a-15): the same body with the new name and value, rebuilt from the stored command so
 * its captured defaults (revision, context, review block) stay exactly as they were. An edit of the content is not a review of its
 * audience, so the build names no review (the block stays).
 */
export function editCreateRequest(
  draft: DraftWithCommand,
  next: { label: string; value: FieldValue | string },
): EnqueueRequest | null {
  const body = draft.command as {
    command?: Record<string, unknown>;
    commands?: Array<Record<string, unknown>>;
  };
  let command: JsonObject;
  if (body.command?.kind === "put_field" && typeof next.value !== "string")
    command = {
      ...draft.command,
      command: {
        ...(body.command as JsonObject),
        label: next.label,
        value: next.value as unknown as JsonObject,
      },
    };
  else return null;
  return {
    endpoint: draft.endpoint,
    targets: draft.target_resource_ids.map(created),
    build: () => ({ command }),
  };
}

// ---- people -------------------------------------------------------------------------------------------------------------------------
/** The rename of a person whose profile is not linked: an ordinary content `edit` (D-11a-5), queueable, guarded by both versions. */
export function renameEditRequest(input: {
  personId: string;
  name: string;
  policyVersion: number;
}): EnqueueRequest {
  return {
    endpoint: "/commands",
    targets: [checked(input.personId)],
    build: (bases) => ({
      command: {
        commands: [
          {
            kind: "edit",
            id: input.personId,
            expected_version: bases[input.personId] as number,
            expected_policy_version: input.policyVersion,
            label: input.name,
            value: "",
          },
        ],
      },
      displayPatch: { [input.personId]: { label: input.name } },
    }),
  };
}

/** Archive or restore a person or a field (`/task-commands`, content-version-checked, no policy check). */
export function archiveRequest(input: {
  id: string;
  archived: boolean;
}): EnqueueRequest {
  return {
    endpoint: "/task-commands",
    targets: [checked(input.id)],
    build: (bases) => ({
      command: {
        command: {
          kind: "archive",
          id: input.id,
          expected_version: bases[input.id] as number,
          archived: input.archived,
        },
      },
      displayPatch: { [input.id]: { archived: input.archived } },
    }),
  };
}

// ---- online-only bodies -------------------------------------------------------------------------------------------------------------
export const renameProfileBody = (input: {
  personId: string;
  version: number;
  name: string;
}) => ({
  command: {
    kind: "rename_profile" as const,
    person_id: input.personId,
    expected_version: input.version,
    name: input.name,
  },
});

export const unlinkBody = (input: { personId: string; version: number }) => ({
  command: {
    kind: "unlink" as const,
    person_id: input.personId,
    expected_version: input.version,
  },
});

/** A field created SHARED (an explicit policy with a grant): online-only, `/task-access-commands` (never queued, no defaults). */
export const putFieldSharedBody = (input: {
  fieldId: string;
  personId: string;
  label: string;
  value: FieldValue;
  policy: Policy;
}) => ({
  command: {
    kind: "put_field" as const,
    id: input.fieldId,
    parent_id: input.personId,
    label: input.label,
    value: input.value,
    initial_policy: input.policy,
  },
});
