import type { CacheRow } from "../../data";
import { recogniseAtlasError } from "../../lib/api-client/problem";
import { type Session, StampedRequestError } from "../../session";
import {
  type Enrolment,
  type OccurrencePage,
  type ProgressJournal,
  parseEnrolment,
  parseJournalPage,
  parseOccurrencePage,
  parsePresets,
  parseResourcePage,
  parseTaskDetail,
  type TaskDetail,
  type TaskPreset,
} from "./model/contract";

/**
 * The online task reads of the pinned contract and the one online-only command (`enrol`, D-10a-7). Every call goes through the session's
 * STAMPED client for the displayed `(account, epoch)` (lint R1); nothing here queues. Every answer is CLASSIFIED, as WEB-12a's sharing client
 * does: a refusal needs an Atlas error body; `uncertain` is a network error, a time-out, a `5xx`, a `429`, a 4xx without an Atlas body or a
 * `200` that is not the contract's answer; `not_sent` is a request the session held back; `closed` is a request the session closed or an
 * identity that moved. A `200` body is validated strictly before it is used.
 */
export type RefusalKind =
  | "conflict"
  | "operation_conflict"
  | "forbidden"
  | "not_found"
  | "invalid";

export type TasksResult<T> =
  | { ok: true; value: T; requestId?: string }
  | { ok: false; kind: RefusalKind; requestId?: string; code?: string }
  | { ok: false; kind: "uncertain"; requestId?: string }
  | { ok: false; kind: "not_sent" | "offline" | "closed" };

export type TasksFailure = Extract<TasksResult<never>, { ok: false }>;

export interface DailyQuery {
  day: string;
  zone: string;
  scope: "joint" | "personal";
  after?: string;
  revision?: number;
  limit: number;
}

export interface EnrolCommand {
  kind: "enrol";
  task_id: string;
  expected_version: number;
  active: boolean;
  aggregate_consent: boolean;
}

export interface TasksApi {
  readDaily(query: DailyQuery): Promise<TasksResult<OccurrencePage>>;
  readPresets(query: {
    startDate: string;
    zone: string;
  }): Promise<TasksResult<TaskPreset[]>>;
  readTask(id: string): Promise<TasksResult<TaskDetail>>;
  readEnrolment(taskId: string): Promise<TasksResult<Enrolment>>;
  readJournal(
    progressId: string,
    after: number,
  ): Promise<TasksResult<ProgressJournal>>;
  listProgress(occurrenceId: string): Promise<TasksResult<CacheRow[]>>;
  /** `POST /task-access-commands` with the caller's key and the canonical body of one attempt. */
  enrol(
    command: EnrolCommand,
    key: string,
  ): Promise<TasksResult<{ revision: number }>>;
}

const REFUSAL_CODES: Readonly<Record<string, RefusalKind>> = {
  conflict: "conflict",
  operation_conflict: "operation_conflict",
};
const BY_STATUS: Readonly<Record<number, RefusalKind>> = {
  400: "invalid",
  403: "forbidden",
  404: "not_found",
  409: "conflict",
  410: "not_found",
  422: "invalid",
};

export function classifyAnswer(
  status: number,
  contentType: string | null,
  body: unknown,
): TasksFailure {
  if (status === 401) return { ok: false, kind: "closed" };
  const atlas = recogniseAtlasError(contentType, body);
  if (status >= 400 && status < 500 && status !== 408 && status !== 429) {
    if (atlas === null) return { ok: false, kind: "uncertain" };
    return {
      ok: false,
      kind: REFUSAL_CODES[atlas.code] ?? BY_STATUS[status] ?? "invalid",
      requestId: atlas.request_id,
      code: atlas.code,
    };
  }
  return atlas === null
    ? { ok: false, kind: "uncertain" }
    : { ok: false, kind: "uncertain", requestId: atlas.request_id };
}

export function classifyThrown(error: unknown): TasksFailure {
  if (error instanceof StampedRequestError) {
    switch (error.kind) {
      case "not_sent":
      case "not_covered":
        return { ok: false, kind: "not_sent" };
      default:
        return { ok: false, kind: "closed" };
    }
  }
  return { ok: false, kind: "uncertain" };
}

interface Answered {
  data?: unknown;
  error?: unknown;
  response: Response;
}

export async function call<T>(
  run: () => Promise<Answered>,
  parse: (body: unknown) => T | null,
): Promise<TasksResult<T>> {
  try {
    const { data, error, response } = await run();
    const requestId = response.headers.get("x-request-id") ?? undefined;
    if (response.ok) {
      const value = parse(data);
      return value === null
        ? { ok: false, kind: "uncertain", ...(requestId ? { requestId } : {}) }
        : { ok: true, value, ...(requestId ? { requestId } : {}) };
    }
    return classifyAnswer(
      response.status,
      response.headers.get("content-type"),
      error,
    );
  } catch (error) {
    return classifyThrown(error);
  }
}

const NOT_SENT_DELAYS_MS: readonly number[] = [50, 100, 200, 400, 800, 1_000];

/** `not_sent`: the session held the request for a moment; the same call is made again, a bounded number of times (stamped-call contract). */
export async function untilSent<T>(
  run: () => Promise<TasksResult<T>>,
  isCurrent: () => boolean = () => true,
): Promise<TasksResult<T>> {
  for (let attempt = 0; ; attempt += 1) {
    const result = await run();
    if (result.ok || result.kind !== "not_sent") return result;
    const delay = NOT_SENT_DELAYS_MS[attempt];
    if (delay === undefined || !isCurrent()) return result;
    await new Promise<void>((resolve) => setTimeout(resolve, delay));
    if (!isCurrent()) return result;
  }
}

const parseReceipt = (body: unknown): { revision: number } | null =>
  typeof body === "object" &&
  body !== null &&
  !Array.isArray(body) &&
  Object.keys(body).length === 1 &&
  Number.isSafeInteger((body as { revision: unknown }).revision)
    ? { revision: (body as { revision: number }).revision }
    : null;

/** The production client over the session, for the displayed `(account, epoch)`. */
export function createTasksApi(
  session: Session,
  account: string,
  epoch: number,
): TasksApi {
  const client = () => session.api.client("ordinary", account, epoch);
  const offline = (): TasksResult<never> | null =>
    typeof navigator !== "undefined" && navigator.onLine === false
      ? { ok: false, kind: "offline" }
      : null;
  const get = <T>(
    path: string,
    params: Record<string, unknown>,
    parse: (body: unknown) => T | null,
  ): Promise<TasksResult<T>> =>
    Promise.resolve(
      offline() ??
        untilSent(() =>
          call(
            () =>
              (
                client() as unknown as {
                  GET(p: string, o: unknown): Promise<Answered>;
                }
              ).GET(path, { params }),
            parse,
          ),
        ),
    );
  return {
    readDaily: (q) =>
      get(
        "/daily",
        {
          query: {
            day: q.day,
            timezone: q.zone,
            scope: q.scope,
            state: "all",
            limit: q.limit,
            ...(q.after === undefined ? {} : { after: q.after }),
            ...(q.revision === undefined ? {} : { revision: q.revision }),
          },
        },
        parseOccurrencePage,
      ),
    readPresets: (q) =>
      get(
        "/task-presets",
        { query: { start_date: q.startDate, timezone: q.zone } },
        parsePresets,
      ),
    readTask: (id) => get("/tasks/{id}", { path: { id } }, parseTaskDetail),
    readEnrolment: (taskId) =>
      get("/tasks/{id}/enrolment", { path: { id: taskId } }, parseEnrolment),
    readJournal: (progressId, after) =>
      get(
        "/progress/{id}/entries",
        { path: { id: progressId }, query: { after, limit: 200 } },
        parseJournalPage,
      ),
    listProgress: (occurrenceId) =>
      get(
        "/progress",
        { query: { parent_id: occurrenceId, limit: 200 } },
        (body) => parseResourcePage(body)?.items ?? null,
      ),
    enrol: async (command, key) =>
      offline() ??
      call(
        () =>
          client().POST("/task-access-commands", {
            params: { header: { "Idempotency-Key": key } },
            body: { command } as never,
          }),
        parseReceipt,
      ),
  };
}
