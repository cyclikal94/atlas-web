import type { CacheRow, ResourceKind } from "../../data";
import { recogniseAtlasError } from "../../lib/api-client/problem";
import type { Session } from "../../session";
import {
  classifyAnswer,
  classifyThrown,
  type SharingFailure,
} from "../sharing";
import {
  type PersonActivityPage,
  parsePersonActivityPage,
} from "./model/activity";
import {
  type IncomingRequest,
  type MergePreview,
  parseIncomingRequests,
  parseMergePreview,
  parseRecipientPreview,
  parseSentPage,
  type RecipientPreview,
  type SentPage,
} from "./model/requests";
import {
  type FieldAudience,
  type PersonSummary,
  type PersonSummaryDetail,
  parseFieldAudience,
  parsePersonSummary,
  parsePersonSummaryDetail,
  parseSummaryPage,
  type SummaryPage,
  type SummaryScope,
} from "./model/summary";

/**
 * The people endpoints of the pinned contract (first `v0.29.0-rc.1`, API 0.29.0; now `v0.31.0-rc.1`, API 0.31.0) that WEB-11a uses ONLINE (D-11a-14): the person read that says
 * who controls a profile, the duplicate suggestions, the viewer-safe summaries (finding 8: `model/summary.ts`), the two profile commands
 * and a shared field create. Every call goes through the
 * session's STAMPED typed client for the displayed `(account, epoch)` (lint R1); nothing here queues.
 *
 * Answers are classified with the sharing slice's rules (`classifyAnswer`, `classifyThrown`): a refusal needs an Atlas error body, a
 * `200` body is validated strictly (TypeScript types are not validation) and one that is not the contract's answer is `uncertain`. The
 * people-specific refusal `identity_grant_required` (a shared field whose audience cannot see the person) is told apart.
 *
 * WEB-11b adds the request reads (`model/requests.ts`) and two refusals: `expired` (a `410`, the recipient preview of a request that expired
 * and is not swept yet; it is no longer folded into `not_found`) and `capacity` (a people command's `503 slice_capacity`: the recipient
 * already has the most requests waiting, and nothing was made; any other `503` stays uncertain).
 *
 * WEB-19 adds the person's activity timeline (`GET /people/{id}/activity`, API 0.30.2, `model/activity.ts`): a `404` is `not_found` (the
 * person is not visible now: access lost), a `422 invalid_value` for `after` is `invalid` (the cursor is not one the reader may follow now).
 */
export type PeopleRefusal =
  | "conflict"
  | "operation_conflict"
  | "forbidden"
  | "not_found"
  | "invalid"
  | "identity_grant_required"
  | "expired"
  | "capacity";

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

/** One page of a summary read: after the cursor, at most `limit` (1–100) rows. */
export interface SummaryPageQuery {
  after: string | null;
  limit: number;
  archived: boolean;
}

/** One page of the activity timeline: after the cursor (an event id the reader was given), at most `limit` (1–100) events. */
export interface ActivityPageQuery {
  after: string | null;
  limit: number;
}

export interface PeopleApi {
  readPerson(id: string): Promise<PeopleResult<PersonDetailAnswer>>;
  /** `GET /people/summaries`: one page of the reader's visible people in `scope`, filtered by the server BEFORE pagination. */
  readSummaries(
    scope: SummaryScope,
    page: SummaryPageQuery,
  ): Promise<PeopleResult<SummaryPage<PersonSummary>>>;
  /** `GET /people/{id}/summary`: one person's summary and its "Shared with" rail. */
  readPersonSummary(id: string): Promise<PeopleResult<PersonSummaryDetail>>;
  /** `GET /people/{id}/field-audiences`: one page of the person's visible fields, each with its own sharing and who can see it. */
  readFieldAudiences(
    id: string,
    page: SummaryPageQuery,
  ): Promise<PeopleResult<SummaryPage<FieldAudience>>>;
  readDuplicates(
    id: string,
    page: { after?: string | null; limit: number },
  ): Promise<PeopleResult<ProjectionPage>>;
  /** WEB-19, `GET /people/{id}/activity`: one page of the person's recorded activity (newest first, in commit order). */
  readPersonActivity(
    id: string,
    page: ActivityPageQuery,
  ): Promise<PeopleResult<PersonActivityPage>>;
  /** `GET /people/requests`: the pending requests addressed to the reader (at most 100). */
  readRequests(): Promise<PeopleResult<IncomingRequest[]>>;
  /** `GET /people/requests/sent`: one page of the reader's sent requests, every state, with no age limit (Q16). */
  readSentRequests(page: {
    after: string | null;
    limit: number;
  }): Promise<PeopleResult<SentPage>>;
  /** `GET /people/requests/{id}/merge-preview`: the recipient's own comparison of a merge request (Q16). */
  readRecipientPreview(
    requestId: string,
  ): Promise<PeopleResult<RecipientPreview>>;
  /** `POST /people/merge-preview`: the caller's comparison of two people (a READ: no idempotency key, nothing changes). */
  previewMerge(
    sourceId: string,
    targetId: string,
  ): Promise<PeopleResult<MergePreview>>;
  /**
   * One command per request on `/people-commands`: `rename_profile` and `unlink` (WEB-11a), and `request_link`, `request_merge`, `merge`,
   * `respond_request` and `cancel_request` (WEB-11b).
   */
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
      return { ...failure, kind: "expired" };
    default:
      return failure as PeopleFailure;
  }
}

/**
 * What a response that is not `2xx` means, with `identity_grant_required` told apart. `capacity`: for a people command only, a `503` with
 * Atlas's `slice_capacity` body is the definite refusal it is (nothing was made); every other `5xx` is uncertain.
 */
export function classifyPeopleAnswer(
  status: number,
  contentType: string | null,
  body: unknown,
  options: { capacity?: boolean } = {},
): PeopleFailure {
  const classified = fromSharing(classifyAnswer(status, contentType, body));
  const atlas = recogniseAtlasError(contentType, body);
  if (options.capacity && status === 503 && atlas?.code === "slice_capacity")
    return {
      ok: false,
      kind: "capacity",
      requestId: atlas.request_id,
      message: atlas.message,
    };
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
  options: { capacity?: boolean } = {},
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
      options,
    );
  } catch (error) {
    return fromSharing(classifyThrown(error));
  }
}

const NOT_SENT_DELAYS_MS: readonly number[] = [50, 100, 200, 400, 800, 1_000];

/**
 * A READ the session held back (`not_sent`: nothing was sent, nothing counted; a stamped call made right as the tree is displayed is the
 * usual case) is asked again quietly, a bounded number of times, as the stamped-call contract says; only then is `not_sent` reported.
 * Commands are retried by their own attempt (`online.ts`), never here.
 */
export async function readUntilSent<T>(
  read: () => Promise<PeopleResult<T>>,
  sleep: (ms: number) => Promise<void> = (ms) =>
    new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<PeopleResult<T>> {
  for (let attempt = 0; ; attempt += 1) {
    const result = await read();
    if (result.ok || result.kind !== "not_sent") return result;
    const delay = NOT_SENT_DELAYS_MS[attempt];
    if (delay === undefined) return result;
    await sleep(delay);
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
      readUntilSent(() =>
        call(
          () => client().GET("/people/{id}", { params: { path: { id } } }),
          parsePersonDetail,
        ),
      ),
    readDuplicates: async (id, page) =>
      offline() ??
      readUntilSent(() =>
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
      ),
    readSummaries: async (scope, page) =>
      offline() ??
      readUntilSent(() =>
        call(
          () =>
            client().GET("/people/summaries", {
              params: {
                query: {
                  scope,
                  archived: page.archived,
                  limit: page.limit,
                  ...(page.after ? { after: page.after } : {}),
                },
              },
            }),
          (body) => parseSummaryPage(body, page, parsePersonSummary),
        ),
      ),
    readPersonSummary: async (id) =>
      offline() ??
      readUntilSent(() =>
        call(
          () =>
            client().GET("/people/{id}/summary", { params: { path: { id } } }),
          parsePersonSummaryDetail,
        ),
      ),
    readFieldAudiences: async (id, page) =>
      offline() ??
      readUntilSent(() =>
        call(
          () =>
            client().GET("/people/{id}/field-audiences", {
              params: {
                path: { id },
                query: {
                  archived: page.archived,
                  limit: page.limit,
                  ...(page.after ? { after: page.after } : {}),
                },
              },
            }),
          (body) => parseSummaryPage(body, page, parseFieldAudience),
        ),
      ),
    readPersonActivity: async (id, page) =>
      offline() ??
      readUntilSent(() =>
        call(
          () =>
            client().GET("/people/{id}/activity", {
              params: {
                path: { id },
                query: {
                  limit: page.limit,
                  ...(page.after ? { after: page.after } : {}),
                },
              },
            }),
          (body) => parsePersonActivityPage(body, page.limit),
        ),
      ),
    readRequests: async () =>
      offline() ??
      readUntilSent(() =>
        call(() => client().GET("/people/requests"), parseIncomingRequests),
      ),
    readSentRequests: async (page) =>
      offline() ??
      readUntilSent(() =>
        call(
          () =>
            client().GET("/people/requests/sent", {
              params: {
                query: {
                  limit: page.limit,
                  ...(page.after ? { after: page.after } : {}),
                },
              },
            }),
          (body) => parseSentPage(body, page),
        ),
      ),
    readRecipientPreview: async (id) =>
      offline() ??
      readUntilSent(() =>
        call(
          () =>
            client().GET("/people/requests/{id}/merge-preview", {
              params: { path: { id } },
            }),
          parseRecipientPreview,
        ),
      ),
    previewMerge: async (sourceId, targetId) =>
      offline() ??
      readUntilSent(() =>
        call(
          () =>
            client().POST("/people/merge-preview", {
              body: { source_id: sourceId, target_id: targetId },
            }),
          parseMergePreview,
        ),
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
        { capacity: true },
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
