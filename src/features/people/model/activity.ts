import type { components } from "../../../lib/api-types";
import { charCount, LIMITS } from "./values";

/**
 * WEB-19: a person's ACTIVITY TIMELINE as the pinned contract gives it (`v0.31.0-rc.1`; BE-PEOPLE-ACTIVITY, API 0.30.2; backend
 * `docs/people.md` "Activity timeline"). PURE: the strict parser of `GET /people/{id}/activity` (`PersonActivityPage`).
 *
 * Kieran's decisions of 1 November 2026 (the timeline-first policy, `delivery/handoffs/people-activity-policy-20261101.md`) are the
 * server's: events are METADATA ONLY (no earlier name, label or value exists to show), `target.label` is the item's CURRENT label, an actor
 * is named only when it is the reader, the person's current owner or its currently linked account, and sharing changes are not recorded.
 * The client keeps to that: nothing here can carry an old value, and a `type` outside the eleven (a sharing row, say) is not the contract's
 * answer, so the whole page is refused rather than shown in part.
 *
 * Every schema is `additionalProperties: false` and validated EXACTLY, with the contract's own consistency rules: `summary` is the fixed
 * phrase of its `type`; `changed` only on `field_edited`; `account` on `person_linked`/`person_unlinked` (always, per the backend docs) and
 * nowhere else; `merged_from` only on `person_merged`; a `field_*` event is about a field and every other about a person;
 * `canonical_person_id` exactly when a target is `merged`, and only a person can be; `field_kind` only on a field; `next_after` is the
 * last item's id or null (and never on an empty page); at most `limit` items, each id once.
 */
type Schemas = components["schemas"];
export type PersonActivityPage = Schemas["PersonActivityPage"];
export type PersonActivityEvent = Schemas["PersonActivityEvent"];
export type ActivityAccount = Schemas["ActivityAccount"];
export type ActivityTarget = Schemas["ActivityTarget"];
export type ActivityType = PersonActivityEvent["type"];

export const ACTIVITY_TYPES = [
  "person_created",
  "person_renamed",
  "person_archived",
  "person_restored",
  "person_linked",
  "person_unlinked",
  "person_merged",
  "field_created",
  "field_edited",
  "field_archived",
  "field_restored",
] as const satisfies readonly ActivityType[];

/** The contract's fixed phrase of each type: checked, never displayed (presentation belongs to the client, `activity/describe.ts`). */
export const ACTIVITY_SUMMARIES: Readonly<
  Record<ActivityType, PersonActivityEvent["summary"]>
> = {
  person_created: "Added this person",
  person_renamed: "Renamed this person",
  person_archived: "Archived this person",
  person_restored: "Restored this person",
  person_linked: "Linked this person to an account",
  person_unlinked: "Unlinked this person from an account",
  person_merged: "Merged another profile into this person",
  field_created: "Added a field",
  field_edited: "Edited a field",
  field_archived: "Archived a field",
  field_restored: "Restored a field",
};

const FIELD_KINDS = [
  "text",
  "quantity",
  "date",
  "url",
  "boolean",
  "choices",
  "checklist",
] as const;

// ---- strict validation -------------------------------------------------------------------------------------------------------------
type Obj = Record<string, unknown>;
const isObject = (value: unknown): value is Obj =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const isUuid = (value: unknown): value is string =>
  typeof value === "string" && UUID.test(value);
const isInt = (value: unknown, min: number): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= min;
/** 1..300 characters as the server counts them (`chars().count()`), as the summaries count labels. */
const isLabel = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length >= 1 &&
  charCount(value) <= LIMITS.label;
const oneOf = <T extends string>(
  value: unknown,
  values: readonly T[],
): value is T =>
  typeof value === "string" && (values as readonly string[]).includes(value);
/** Only keys of `allowed`, and every key of `required`. */
const keysWithin = (
  value: Obj,
  required: readonly string[],
  allowed: readonly string[],
): boolean =>
  required.every((key) => Object.hasOwn(value, key)) &&
  Object.keys(value).every((key) => allowed.includes(key));

export function parseActivityAccount(value: unknown): ActivityAccount | null {
  if (!isObject(value)) return null;
  if (value.kind === "you" || value.kind === "someone_else")
    return Object.keys(value).length === 1 ? { kind: value.kind } : null;
  if (value.kind !== "account") return null;
  if (
    !keysWithin(
      value,
      ["kind", "account_id", "username"],
      ["kind", "account_id", "username"],
    )
  )
    return null;
  if (!isUuid(value.account_id)) return null;
  if (typeof value.username !== "string" || value.username.length === 0)
    return null;
  return {
    kind: "account",
    account_id: value.account_id,
    username: value.username,
  };
}

const TARGET_REQUIRED = ["kind", "id", "label", "archived", "state"] as const;
const TARGET_ALLOWED = [
  ...TARGET_REQUIRED,
  "canonical_person_id",
  "field_kind",
] as const;

export function parseActivityTarget(value: unknown): ActivityTarget | null {
  if (!isObject(value) || !keysWithin(value, TARGET_REQUIRED, TARGET_ALLOWED))
    return null;
  if (!oneOf(value.kind, ["person", "field"] as const)) return null;
  if (!isUuid(value.id) || !isLabel(value.label)) return null;
  if (typeof value.archived !== "boolean") return null;
  if (!oneOf(value.state, ["current", "merged"] as const)) return null;
  const merged = value.state === "merged";
  // `canonical_person_id` exactly when merged; only a person id is ever merged.
  if (merged !== Object.hasOwn(value, "canonical_person_id")) return null;
  if (merged && (value.kind !== "person" || !isUuid(value.canonical_person_id)))
    return null;
  if (Object.hasOwn(value, "field_kind")) {
    if (value.kind !== "field" || !oneOf(value.field_kind, FIELD_KINDS))
      return null;
  }
  return {
    kind: value.kind,
    id: value.id,
    label: value.label,
    archived: value.archived,
    state: value.state,
    ...(merged
      ? { canonical_person_id: value.canonical_person_id as string }
      : {}),
    ...(value.field_kind === undefined
      ? {}
      : {
          field_kind: value.field_kind as ActivityTarget["field_kind"] & string,
        }),
  };
}

const EVENT_REQUIRED = [
  "id",
  "occurred_at",
  "type",
  "summary",
  "actor",
  "target",
] as const;
const EVENT_ALLOWED = [
  ...EVENT_REQUIRED,
  "changed",
  "account",
  "merged_from",
] as const;

export function parseActivityEvent(value: unknown): PersonActivityEvent | null {
  if (!isObject(value) || !keysWithin(value, EVENT_REQUIRED, EVENT_ALLOWED))
    return null;
  if (!isUuid(value.id) || !isInt(value.occurred_at, 0)) return null;
  if (!oneOf(value.type, ACTIVITY_TYPES)) return null;
  const type = value.type;
  if (value.summary !== ACTIVITY_SUMMARIES[type]) return null;
  const actor = parseActivityAccount(value.actor);
  const target = parseActivityTarget(value.target);
  if (actor === null || target === null) return null;
  // A field's events are about the field; every other event is about a person.
  if ((target.kind === "field") !== type.startsWith("field_")) return null;
  const event: PersonActivityEvent = {
    id: value.id,
    occurred_at: value.occurred_at,
    type,
    summary: ACTIVITY_SUMMARIES[type],
    actor,
    target,
  };
  // `changed`: field_edited only, and there always (which parts changed: label, value or both, each once).
  if ((type === "field_edited") !== Object.hasOwn(value, "changed"))
    return null;
  if (type === "field_edited") {
    const changed = value.changed;
    if (
      !Array.isArray(changed) ||
      changed.length < 1 ||
      changed.length > 2 ||
      !changed.every((part) => part === "label" || part === "value") ||
      new Set(changed).size !== changed.length
    )
      return null;
    event.changed = [...changed] as ("label" | "value")[];
  }
  // `account`: the linked or previously linked account, on link and unlink only (always there: backend docs).
  const linking = type === "person_linked" || type === "person_unlinked";
  if (linking !== Object.hasOwn(value, "account")) return null;
  if (linking) {
    const account = parseActivityAccount(value.account);
    if (account === null) return null;
    event.account = account;
  }
  // `merged_from`: person_merged only, and only while the source is visible (otherwise omitted).
  if (Object.hasOwn(value, "merged_from")) {
    if (type !== "person_merged") return null;
    const from = value.merged_from;
    if (
      !isObject(from) ||
      !keysWithin(from, ["id", "label"], ["id", "label"]) ||
      !isUuid(from.id) ||
      !isLabel(from.label)
    )
      return null;
    event.merged_from = { id: from.id, label: from.label };
  }
  return event;
}

/**
 * One page of `GET /people/{id}/activity` asked with `limit`, or null when the body is not the contract's answer (shown as uncertain: the
 * People parsers' rule, D-19-9).
 */
export function parsePersonActivityPage(
  body: unknown,
  limit: number,
): PersonActivityPage | null {
  if (
    !isObject(body) ||
    !keysWithin(
      body,
      ["person_id", "items", "next_after", "coverage_started_at"],
      ["person_id", "items", "next_after", "coverage_started_at"],
    )
  )
    return null;
  if (!isUuid(body.person_id) || !isInt(body.coverage_started_at, 0))
    return null;
  if (!Array.isArray(body.items) || body.items.length > Math.min(limit, 100))
    return null;
  const items: PersonActivityEvent[] = [];
  const seen = new Set<string>();
  for (const item of body.items) {
    const event = parseActivityEvent(item);
    if (event === null || seen.has(event.id)) return null;
    seen.add(event.id);
    items.push(event);
  }
  // `next_after`: the last item's id, only when a further visible item exists.
  if (body.next_after !== null) {
    if (!isUuid(body.next_after) || body.next_after !== items.at(-1)?.id)
      return null;
  }
  return {
    person_id: body.person_id,
    items,
    next_after: body.next_after,
    coverage_started_at: body.coverage_started_at,
  };
}
