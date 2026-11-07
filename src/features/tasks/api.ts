import type { Policy } from "../../data";
import { recogniseAtlasError } from "../../lib/api-client/problem";
import { type Session, StampedRequestError } from "../../session";
import {
  type AccountTimerPage,
  type DependencyGraph,
  type DependencyPreview,
  type Enrolment,
  type OccurrencePage,
  type ProgressJournal,
  parseAccountTimerPage,
  parseDependencyGraph,
  parseDependencyPreview,
  parseEnrolment,
  parseJournalPage,
  parseOccurrencePage,
  parsePresets,
  parseRotaState,
  parseStreak,
  parseTaskDetail,
  parseTaskResult,
  parseTimerPage,
  type RotaState,
  type TaskDetail,
  type TaskPreset,
  type TaskResult,
  type TaskStreak,
  type TimerPage,
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
  /**
   * `code`: an Atlas body's code when the answer had one (a `503 slice_capacity`), for a caller that stops on it (WEB-10c's catch-up).
   * `retry`: what the answer says about trying again (revision 10, Decision B), read only by the catch-up's callers; every other caller
   * treats every uncertain answer alike, as before.
   */
  | {
      ok: false;
      kind: "uncertain";
      requestId?: string;
      code?: string;
      retry?: RetryFacts;
    }
  | { ok: false; kind: "not_sent" | "offline" | "closed" };

/**
 * Revision 10 (Decision B, WEB-04 §5.11): the cause of an uncertain answer. `transient`: a recognised `500 internal_error` or
 * `503 temporarily_unavailable`; `transport`: no answer (a network error, a lost response); `rate_limited`: a `429`, with its valid
 * `Retry-After` as `afterMs` (from the answer); `unrecognised`: any other answer (an unexpected status or code, a `4xx` without an Atlas
 * body, a `200` that is not the contract's answer).
 */
export interface RetryFacts {
  cause: "transient" | "transport" | "rate_limited" | "unrecognised";
  afterMs?: number;
}

export type TasksFailure = Extract<TasksResult<never>, { ok: false }>;

export interface DailyQuery {
  day: string;
  zone: string;
  scope: "joint" | "personal";
  after?: string;
  revision?: number;
  limit: number;
}

/**
 * The COMPLETE enrolment (revision 10, R22): `initial_policy` is never omitted. The server reads an omitted policy as "resolve my CURRENT
 * progress defaults" and replaces the enrolment's audience with it (task `states.md` R2/F1), so every Join, Leave, consent or audience
 * change carries the audience the person reviewed: unchanged unless they chose another one. Build it with `enrolCommand`.
 */
export interface EnrolCommand {
  kind: "enrol";
  task_id: string;
  expected_version: number;
  active: boolean;
  aggregate_consent: boolean;
  initial_policy: Policy;
}

/** WEB-10c's online-only access commands (`/task-access-commands`; `set_rota`/`rota_consent` are refused on `/task-commands`). */
export interface SetRotaCommand {
  kind: "set_rota";
  task_id: string;
  expected_version: number;
  participants: string[];
}
export interface RotaConsentCommand {
  kind: "rota_consent";
  task_id: string;
  expected_version: number;
  accepted: boolean;
}
export type AccessCommand = EnrolCommand | SetRotaCommand | RotaConsentCommand;
/** `materialise`: sent only by the catch-up runner (D-10c-1), never queued. */
export interface MaterialiseCommand {
  kind: "materialise";
  task_id: string;
  through_date: string;
  limit: number;
}

export interface TasksApi {
  readDaily(query: DailyQuery): Promise<TasksResult<OccurrencePage>>;
  readPresets(query: {
    startDate: string;
    zone: string;
  }): Promise<TasksResult<TaskPreset[]>>;
  /**
   * `admitted` (revision 10, Decision B; revision 11, review R36): the catch-up's permission to transmit, asked before the first call and
   * each resend of a request the session held back (`not_sent`), and carried to the session's send boundary, where it is asked again in
   * the step that issues (after every wait for the token, the cover and the locks). Once false, nothing more is issued and `not_sent` is
   * the answer; a request already issued is never aborted. It must not throw.
   */
  readTask(
    id: string,
    admitted?: () => boolean,
  ): Promise<TasksResult<TaskDetail>>;
  readEnrolment(taskId: string): Promise<TasksResult<Enrolment>>;
  readJournal(
    progressId: string,
    after: number,
  ): Promise<TasksResult<ProgressJournal>>;
  /** `POST /task-access-commands` with the caller's key and the canonical body of one attempt. */
  enrol(
    command: EnrolCommand,
    key: string,
  ): Promise<TasksResult<{ revision: number }>>;
  // ---- WEB-10c -------------------------------------------------------------------------------------------------------------------
  readDependencies(
    occurrenceId: string,
  ): Promise<TasksResult<DependencyPreview>>;
  /**
   * WEB-18: `GET /occurrences/{id}/dependency-graph`, the visible upstream graph of one day for display and for the editor's authoritative
   * direct list. `maxDepth` absent: the server's default (200, the whole bounded graph); `1`: the editor's cheaper read. The answer is
   * validated against the request it answers (its root and effective `max_depth`).
   */
  readDependencyGraph(
    occurrenceId: string,
    maxDepth?: number,
  ): Promise<TasksResult<DependencyGraph>>;
  /** My sessions of one occurrence, 50 a page, in id order. */
  readTimers(
    occurrenceId: string,
    after?: string,
  ): Promise<TasksResult<TimerPage>>;
  readAccountTimers(query: {
    state: "running" | "stopped";
    after?: string;
    limit: number;
  }): Promise<TasksResult<AccountTimerPage>>;
  readRota(taskId: string): Promise<TasksResult<RotaState>>;
  readStreak(
    taskId: string,
    scope: "personal" | "joint",
  ): Promise<TasksResult<TaskStreak>>;
  /** `POST /task-commands` with the attempt's key: the catch-up runner only. `admitted`: as `readTask`'s (revision 11, review R36). */
  materialise(
    command: MaterialiseCommand,
    key: string,
    admitted?: () => boolean,
  ): Promise<TasksResult<TaskResult>>;
  /** `POST /task-access-commands` (enrolment, rota consent, turn order), one attempt per body. `enrol` is a call of it. */
  access(command: AccessCommand, key: string): Promise<TasksResult<TaskResult>>;
}

/** The effective `max_depth` of a graph read that names none (the endpoint's default). */
export const GRAPH_DEFAULT_DEPTH = 200;

/** The size of a timer-session page this slice asks for (the endpoint's default). */
export const TIMER_PAGE = 50;

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

const UNRECOGNISED: RetryFacts = { cause: "unrecognised" };
/** The recognised transient answers (WEB-04 §5.11): their status with their code. */
const TRANSIENT: Readonly<Record<number, string>> = {
  500: "internal_error",
  503: "temporarily_unavailable",
};

/**
 * A `Retry-After` (RFC 9110: delay-seconds or an IMF-fixdate HTTP-date; the obsolete date forms are not read) as a delay in ms from now,
 * or `undefined` when absent or not valid. A date in the past is no delay.
 */
export function retryAfterMs(
  raw: string | null | undefined,
  now: number,
): number | undefined {
  const value = raw?.trim() ?? "";
  // A very large one is still valid: held at about 31 years, so the deadline it makes stays an exact time.
  if (/^\d+$/.test(value)) return Math.min(Number(value), 1e9) * 1_000;
  const at = /^[A-Za-z]{3}, \d\d [A-Za-z]{3} \d{4} \d\d:\d\d:\d\d GMT$/.test(
    value,
  )
    ? Date.parse(value)
    : Number.NaN;
  return Number.isFinite(at) ? Math.max(0, at - now) : undefined;
}

export function classifyAnswer(
  status: number,
  contentType: string | null,
  body: unknown,
  retryAfter: string | null = null,
): TasksFailure {
  if (status === 401) return { ok: false, kind: "closed" };
  const atlas = recogniseAtlasError(contentType, body);
  if (status >= 400 && status < 500 && status !== 408 && status !== 429) {
    if (atlas === null)
      return { ok: false, kind: "uncertain", retry: UNRECOGNISED };
    return {
      ok: false,
      kind: REFUSAL_CODES[atlas.code] ?? BY_STATUS[status] ?? "invalid",
      requestId: atlas.request_id,
      code: atlas.code,
    };
  }
  const after =
    status === 429 ? retryAfterMs(retryAfter, Date.now()) : undefined;
  const retry: RetryFacts =
    status === 429
      ? {
          cause: "rate_limited",
          ...(after === undefined ? {} : { afterMs: after }),
        }
      : atlas !== null && TRANSIENT[status] === atlas.code
        ? { cause: "transient" }
        : UNRECOGNISED;
  return atlas === null
    ? { ok: false, kind: "uncertain", retry }
    : {
        ok: false,
        kind: "uncertain",
        requestId: atlas.request_id,
        code: atlas.code,
        retry,
      };
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
  return { ok: false, kind: "uncertain", retry: { cause: "transport" } };
}

interface Answered {
  data?: unknown;
  error?: unknown;
  response: Response;
}

/**
 * Revision 15 (review 16's R39; design assessment C3): a successful answer's body is asked for as TEXT (`parseAs: "text"`), so the client
 * library's only asynchronous decode is reading it, which the session's final validation (`sealResult`) follows; it is decoded HERE,
 * synchronously, after that validation and before anything acts on it. A body that is not JSON (`{`, empty, truncated) is then an answer
 * the server GAVE that is not the contract's, `unrecognised` like a valid body of the wrong shape, never "no answer" (a library JSON decode
 * rejected before `call` held the Response, which read as transport). A body with nothing to decode (a `204`, a `Content-Length: 0`) is
 * `undefined` as before. A value already decoded (a double that ignores `parseAs`) is taken as it is.
 */
const NOT_JSON = Symbol("not JSON");
function decodeBody(data: unknown): unknown {
  if (typeof data !== "string") return data;
  try {
    return JSON.parse(data) as unknown;
  } catch {
    return NOT_JSON;
  }
}

export async function call<T>(
  run: () => Promise<Answered>,
  parse: (body: unknown) => T | null,
): Promise<TasksResult<T>> {
  try {
    const { data, error, response } = await run();
    const requestId = response.headers.get("x-request-id") ?? undefined;
    if (response.ok) {
      const body = decodeBody(data);
      const value = body === NOT_JSON ? null : parse(body);
      return value === null
        ? {
            ok: false,
            kind: "uncertain",
            ...(requestId ? { requestId } : {}),
            retry: UNRECOGNISED,
          }
        : { ok: true, value, ...(requestId ? { requestId } : {}) };
    }
    return classifyAnswer(
      response.status,
      response.headers.get("content-type"),
      error,
      response.headers.get("retry-after"),
    );
  } catch (error) {
    return classifyThrown(error);
  }
}

const NOT_SENT_DELAYS_MS: readonly number[] = [50, 100, 200, 400, 800, 1_000];

/**
 * `not_sent`: the session held the request for a moment; the same call is made again, a bounded number of times (stamped-call contract).
 * `isCurrent` is asked before every call, the first included (revision 11, review R36): false, and nothing is made.
 */
export async function untilSent<T>(
  run: () => Promise<TasksResult<T>>,
  isCurrent: () => boolean = () => true,
): Promise<TasksResult<T>> {
  for (let attempt = 0; ; attempt += 1) {
    if (!isCurrent()) return { ok: false, kind: "not_sent" };
    const result = await run();
    if (result.ok || result.kind !== "not_sent") return result;
    const delay = NOT_SENT_DELAYS_MS[attempt];
    if (delay === undefined || !isCurrent()) return result;
    await new Promise<void>((resolve) => setTimeout(resolve, delay));
  }
}

/** The production client over the session, for the displayed `(account, epoch)`. */
export function createTasksApi(
  session: Session,
  account: string,
  epoch: number,
): TasksApi {
  // A caller's permission (the catch-up's) travels to the send boundary; every other call is made as before.
  const client = (admits?: () => boolean) =>
    session.api.client(
      "ordinary",
      account,
      epoch,
      admits === undefined ? undefined : { admits },
    );
  const offline = (): TasksResult<never> | null =>
    typeof navigator !== "undefined" && navigator.onLine === false
      ? { ok: false, kind: "offline" }
      : null;
  const get = <T>(
    path: string,
    params: Record<string, unknown>,
    parse: (body: unknown) => T | null,
    admitted?: () => boolean,
  ): Promise<TasksResult<T>> =>
    Promise.resolve(
      offline() ??
        untilSent(
          () =>
            call(
              () =>
                (
                  client(admitted) as unknown as {
                    GET(p: string, o: unknown): Promise<Answered>;
                  }
                ).GET(path, { params, parseAs: "text" }),
              parse,
            ),
          admitted,
        ),
    );
  const access = async (
    command: AccessCommand,
    key: string,
  ): Promise<TasksResult<TaskResult>> =>
    offline() ??
    call(
      () =>
        client().POST("/task-access-commands", {
          params: { header: { "Idempotency-Key": key } },
          body: { command } as never,
          parseAs: "text",
        }),
      parseTaskResult,
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
    readTask: (id, admitted) =>
      get("/tasks/{id}", { path: { id } }, parseTaskDetail, admitted),
    readEnrolment: (taskId) =>
      get("/tasks/{id}/enrolment", { path: { id: taskId } }, parseEnrolment),
    readJournal: (progressId, after) =>
      get(
        "/progress/{id}/entries",
        { path: { id: progressId }, query: { after, limit: 200 } },
        parseJournalPage,
      ),
    enrol: (command, key) => access(command, key),
    access: (command, key) => access(command, key),
    materialise: async (command, key, admitted) =>
      offline() ??
      (admitted?.() === false
        ? { ok: false, kind: "not_sent" }
        : call(
            () =>
              client(admitted).POST("/task-commands", {
                params: { header: { "Idempotency-Key": key } },
                body: { command } as never,
                parseAs: "text",
              }),
            parseTaskResult,
          )),
    readDependencies: (occurrenceId) =>
      get(
        "/occurrences/{id}/dependencies",
        { path: { id: occurrenceId } },
        parseDependencyPreview,
      ),
    readDependencyGraph: (occurrenceId, maxDepth) =>
      get(
        "/occurrences/{id}/dependency-graph",
        {
          path: { id: occurrenceId },
          query: maxDepth === undefined ? {} : { max_depth: maxDepth },
        },
        (body) =>
          parseDependencyGraph(body, {
            rootId: occurrenceId,
            maxDepth: maxDepth ?? GRAPH_DEFAULT_DEPTH,
          }),
      ),
    readTimers: (occurrenceId, after) =>
      get(
        "/occurrences/{id}/timers",
        {
          path: { id: occurrenceId },
          query: {
            limit: TIMER_PAGE,
            ...(after === undefined ? {} : { after }),
          },
        },
        (body) => parseTimerPage(body, occurrenceId, after ?? null, TIMER_PAGE),
      ),
    readAccountTimers: (q) =>
      get(
        "/timer-sessions",
        {
          query: {
            state: q.state,
            limit: q.limit,
            ...(q.after === undefined ? {} : { after: q.after }),
          },
        },
        (body) => parseAccountTimerPage(body, q.state, q.limit),
      ),
    readRota: (taskId) =>
      get("/tasks/{id}/rota", { path: { id: taskId } }, parseRotaState),
    readStreak: (taskId, scope) =>
      get(
        "/tasks/{id}/streak",
        { path: { id: taskId }, query: { scope } },
        parseStreak,
      ),
  };
}
