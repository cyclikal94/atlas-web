import type { CacheRow, ResourceKind } from "../../data";
import { recogniseAtlasError } from "../../lib/api-client/problem";
import type { Session } from "../../session";
import {
  classifyAnswer,
  classifyThrown,
  type SharingFailure,
} from "../sharing";

/**
 * The people endpoints of the pinned contract (`v0.28.0-rc.1`) that WEB-11a uses ONLINE (D-11a-14): the person read that says who
 * controls a profile, the duplicate suggestions, the two profile commands and a shared field create. Every call goes through the
 * session's STAMPED typed client for the displayed `(account, epoch)` (lint R1); nothing here queues.
 *
 * Answers are classified with the sharing slice's rules (`classifyAnswer`, `classifyThrown`): a refusal needs an Atlas error body, a
 * `200` body is validated strictly (TypeScript types are not validation) and one that is not the contract's answer is `uncertain`. The
 * people-specific refusal `identity_grant_required` (a shared field whose audience cannot see the person) is told apart.
 */
export type PeopleRefusal =
  | "conflict"
  | "operation_conflict"
  | "forbidden"
  | "not_found"
  | "invalid"
  | "identity_grant_required";

export type PeopleResult<T> =
  | { ok: true; value: T }
  | { ok: false; kind: PeopleRefusal; requestId?: string; message?: string }
  | { ok: false; kind: "uncertain"; requestId?: string }
  | { ok: false; kind: "not_sent" | "offline" | "closed" };

export type PeopleFailure = Extract<PeopleResult<never>, { ok: false }>;

/** A projection as the contract gives it (a person or a field). */
export type Projection = Omit<CacheRow, "kind_date">;

export interface PersonDetailAnswer {
  person: Projection;
  linked_account_id: string | null;
}
export interface ProjectionPage {
  items: Projection[];
  next_after: string | null;
}

/** An online-only command's attempt: the key, and the canonical JSON of the body sent under it. */
export interface CommandAttempt {
  key: string;
  body: string;
}

export interface PeopleApi {
  readPerson(id: string): Promise<PeopleResult<PersonDetailAnswer>>;
  readDuplicates(
    id: string,
    page: { after?: string | null; limit: number },
  ): Promise<PeopleResult<ProjectionPage>>;
  /** `rename_profile` or `unlink` (`/people-commands`), one command per request. */
  peopleCommand(
    attempt: CommandAttempt,
  ): Promise<PeopleResult<{ revision: number; person_id: string }>>;
  /** A shared field create (`/task-access-commands`). */
  putFieldShared(
    attempt: CommandAttempt,
  ): Promise<PeopleResult<{ revision: number }>>;
}

// ---- strict validation -------------------------------------------------------------------------------------------------------------
type Obj = Record<string, unknown>;
const isObject = (value: unknown): value is Obj =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const isUuid = (value: unknown): value is string =>
  typeof value === "string" && UUID.test(value);
const isInt = (value: unknown, min: number): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= min;
const KINDS: readonly ResourceKind[] = [
  "person",
  "field",
  "task",
  "execution",
  "occurrence",
  "progress",
  "list",
  "calendar_source",
  "event",
  "review",
  "reminder",
];
const REQUIRED = [
  "id",
  "kind",
  "parent_id",
  "label",
  "value",
  "version",
  "can_edit",
  "archived",
];

export function parseProjection(body: unknown): Projection | null {
  if (!isObject(body)) return null;
  const keys = Object.keys(body);
  if (!REQUIRED.every((key) => Object.hasOwn(body, key))) return null;
  if (!keys.every((key) => REQUIRED.includes(key) || key === "policy_version"))
    return null;
  if (!isUuid(body.id) || !KINDS.includes(body.kind as ResourceKind))
    return null;
  if (body.parent_id !== null && !isUuid(body.parent_id)) return null;
  if (typeof body.label !== "string" || body.label.length === 0) return null;
  if (body.value !== null && !isObject(body.value)) return null;
  if (!isInt(body.version, 1) || typeof body.can_edit !== "boolean")
    return null;
  if (typeof body.archived !== "boolean") return null;
  if (body.policy_version !== undefined && !isInt(body.policy_version, 1))
    return null;
  return {
    id: body.id,
    kind: body.kind as ResourceKind,
    parent_id: body.parent_id as string | null,
    label: body.label,
    value: body.value as Projection["value"],
    version: body.version,
    can_edit: body.can_edit,
    archived: body.archived,
    ...(body.policy_version === undefined
      ? {}
      : { policy_version: body.policy_version as number }),
  };
}

export function parsePersonDetail(body: unknown): PersonDetailAnswer | null {
  if (
    !isObject(body) ||
    Object.keys(body).length !== 2 ||
    !Object.hasOwn(body, "person") ||
    !Object.hasOwn(body, "linked_account_id")
  )
    return null;
  const person = parseProjection(body.person);
  if (person === null || person.kind !== "person") return null;
  if (body.linked_account_id !== null && !isUuid(body.linked_account_id))
    return null;
  return { person, linked_account_id: body.linked_account_id };
}

export function parseProjectionPage(
  body: unknown,
  limit: number,
): ProjectionPage | null {
  if (
    !isObject(body) ||
    Object.keys(body).length !== 2 ||
    !Array.isArray(body.items) ||
    !Object.hasOwn(body, "next_after")
  )
    return null;
  if (body.items.length > limit) return null;
  if (body.next_after !== null && !isUuid(body.next_after)) return null;
  const items: Projection[] = [];
  for (const item of body.items) {
    const parsed = parseProjection(item);
    if (parsed === null) return null;
    items.push(parsed);
  }
  return { items, next_after: body.next_after };
}

export function parsePersonReceipt(
  body: unknown,
): { revision: number; person_id: string } | null {
  if (
    !isObject(body) ||
    Object.keys(body).length !== 2 ||
    !isInt(body.revision, 0) ||
    !isUuid(body.person_id)
  )
    return null;
  return { revision: body.revision, person_id: body.person_id };
}

export function parseTaskReceipt(body: unknown): { revision: number } | null {
  if (!isObject(body) || Object.keys(body).length !== 1) return null;
  return isInt(body.revision, 0) ? { revision: body.revision } : null;
}

// ---- classification -----------------------------------------------------------------------------------------------------------------
function fromSharing(failure: SharingFailure): PeopleFailure {
  switch (failure.kind) {
    case "last_manager":
      return { ...failure, kind: "invalid" };
    case "gone":
      return { ...failure, kind: "not_found" };
    default:
      return failure as PeopleFailure;
  }
}

/** What a response that is not `2xx` means, with `identity_grant_required` told apart. */
export function classifyPeopleAnswer(
  status: number,
  contentType: string | null,
  body: unknown,
): PeopleFailure {
  const classified = fromSharing(classifyAnswer(status, contentType, body));
  const atlas = recogniseAtlasError(contentType, body);
  if (
    atlas !== null &&
    atlas.code === "identity_grant_required" &&
    status >= 400 &&
    status < 500
  )
    return {
      ok: false,
      kind: "identity_grant_required",
      requestId: atlas.request_id,
      message: atlas.message,
    };
  return classified;
}

interface Answered {
  data?: unknown;
  error?: unknown;
  response: Response;
}

async function call<T>(
  run: () => Promise<Answered>,
  parse: (body: unknown) => T | null,
): Promise<PeopleResult<T>> {
  try {
    const { data, error, response } = await run();
    if (response.ok) {
      const value = parse(data);
      return value === null
        ? { ok: false, kind: "uncertain" }
        : { ok: true, value };
    }
    return classifyPeopleAnswer(
      response.status,
      response.headers.get("content-type"),
      error,
    );
  } catch (error) {
    return fromSharing(classifyThrown(error));
  }
}

/** The production client over the session, for the displayed `(account, epoch)`. */
export function createPeopleApi(
  session: Session,
  account: string,
  epoch: number,
): PeopleApi {
  const client = () => session.api.client("ordinary", account, epoch);
  const offline = (): PeopleResult<never> | null =>
    typeof navigator !== "undefined" && navigator.onLine === false
      ? { ok: false, kind: "offline" }
      : null;
  return {
    readPerson: async (id) =>
      offline() ??
      call(
        () => client().GET("/people/{id}", { params: { path: { id } } }),
        parsePersonDetail,
      ),
    readDuplicates: async (id, page) =>
      offline() ??
      call(
        () =>
          client().GET("/people/{id}/duplicates", {
            params: {
              path: { id },
              query: {
                limit: page.limit,
                ...(page.after ? { after: page.after } : {}),
              },
            },
          }),
        (body) => parseProjectionPage(body, page.limit),
      ),
    peopleCommand: async (attempt) =>
      offline() ??
      call(
        () =>
          client().POST("/people-commands", {
            params: { header: { "Idempotency-Key": attempt.key } },
            body: JSON.parse(attempt.body) as never,
          }),
        parsePersonReceipt,
      ),
    putFieldShared: async (attempt) =>
      offline() ??
      call(
        () =>
          client().POST("/task-access-commands", {
            params: { header: { "Idempotency-Key": attempt.key } },
            body: JSON.parse(attempt.body) as never,
          }),
        parseTaskReceipt,
      ),
  };
}
