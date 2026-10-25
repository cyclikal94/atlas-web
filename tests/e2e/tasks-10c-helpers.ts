import type { BrowserContext, Page, Route } from "@playwright/test";
import { API, type BuiltTask } from "./tasks-helpers";

/**
 * The WEB-10c reads and online commands of the native specs (FIXTURE evidence: `page.route`, not a backend). Register AFTER
 * `serveTaskReads` (a later route wins): what this does not answer falls back to it, and a queued command (anything but `materialise`)
 * falls back to the sync stub's command script.
 */
export type Answer = { status: number; body: unknown };
export type Handler<Q> = (q: Q) => Answer | Promise<Answer>;

export interface Reads10c {
  /** `GET /tasks/{id}` (the catch-up's position read). Default: 404. */
  position: Handler<{ taskId: string }>;
  /** `POST /task-commands` with a `materialise` command. Default: 200 `{revision}`. */
  materialise: Handler<{ command: Record<string, unknown>; key: string }>;
  preview: Handler<{ occurrenceId: string }>;
  timers: Handler<{ occurrenceId: string; after: string | null }>;
  accountTimers: Handler<{ state: string; after: string | null }>;
  rota: Handler<{ taskId: string }>;
  enrolment: Handler<{ taskId: string }>;
  streak: Handler<{ taskId: string; scope: string }>;
  access: Handler<{ command: Record<string, unknown>; key: string }>;
  /** Every request this layer answered, in order: `METHOD path` with the key of a command. */
  log: Array<{
    at: number;
    what: string;
    key?: string;
    body?: Record<string, unknown>;
    /** The page that sent it (null when Playwright cannot say). */
    from: Page | null;
  }>;
}

export const refusal = (status: number, code: string): Answer => ({
  status,
  body: {
    code,
    message: "m",
    request_id: "11111111-1111-4111-8111-111111111111",
    details: [],
  },
});

/** `GET /tasks/{id}` of a built task with its position. */
export function detailOf(
  task: BuiltTask,
  materialisation: { last_date: string | null; pending: boolean } | null,
): Answer {
  const [taskRow, executionRow] = task.upserts as Array<{
    resource: Record<string, unknown>;
  }>;
  return {
    status: 200,
    body: {
      task: taskRow?.resource,
      execution: executionRow?.resource,
      materialisation,
    },
  };
}

export async function serveTasks10c(
  context: BrowserContext,
): Promise<Reads10c> {
  const reads: Reads10c = {
    position: () => refusal(404, "not_found"),
    materialise: () => ({ status: 200, body: { revision: 1 } }),
    preview: () => refusal(404, "not_found"),
    timers: () => ({ status: 200, body: { items: [], next_after: null } }),
    accountTimers: () => ({
      status: 200,
      body: { items: [], next_after: null },
    }),
    rota: () => ({
      status: 200,
      body: {
        version: 0,
        participants: [],
        consent_version: 0,
        accepted: false,
        eligible_participants: [],
      },
    }),
    enrolment: () => refusal(404, "not_found"),
    streak: () => ({ status: 200, body: { current: null, longest: null } }),
    access: () => ({ status: 200, body: { revision: 1 } }),
    log: [],
  };
  const fulfil = async (route: Route, answer: Answer | Promise<Answer>) => {
    const a = await answer;
    return route.fulfill({
      status: a.status,
      contentType: "application/json",
      body: JSON.stringify(a.body),
    });
  };
  await context.route(`**${API}/**`, async (route: Route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname.replace(API, "");
    const method = request.method();
    const key = request.headers()["idempotency-key"];
    let from: Page | null = null;
    try {
      from = request.frame().page();
    } catch {
      from = null;
    }
    const note = (what: string, body?: Record<string, unknown>) =>
      reads.log.push({
        at: Date.now(),
        what,
        ...(key ? { key } : {}),
        ...(body ? { body } : {}),
        from,
      });
    let m: RegExpExecArray | null;
    if (method === "POST" && path === "/task-commands") {
      const body = JSON.parse(request.postData() ?? "{}") as {
        command?: Record<string, unknown>;
      };
      if (body.command?.kind !== "materialise") return route.fallback();
      note("POST materialise", body.command);
      return fulfil(
        route,
        reads.materialise({ command: body.command, key: key ?? "" }),
      );
    }
    if (method === "POST" && path === "/task-access-commands") {
      const body = JSON.parse(request.postData() ?? "{}") as {
        command?: Record<string, unknown>;
      };
      if (body.command?.kind === "enrol" || body.command === undefined)
        return route.fallback();
      note(`POST ${String(body.command.kind)}`, body.command);
      return fulfil(
        route,
        reads.access({ command: body.command, key: key ?? "" }),
      );
    }
    if (method !== "GET") return route.fallback();
    if ((m = /^\/tasks\/([^/]+)$/.exec(path))) {
      note(`GET ${path}`);
      return fulfil(route, reads.position({ taskId: m[1] as string }));
    }
    if ((m = /^\/occurrences\/([^/]+)\/dependencies$/.exec(path))) {
      note(`GET ${path}`);
      return fulfil(route, reads.preview({ occurrenceId: m[1] as string }));
    }
    if ((m = /^\/occurrences\/([^/]+)\/timers$/.exec(path))) {
      note(`GET ${path}`);
      return fulfil(
        route,
        reads.timers({
          occurrenceId: m[1] as string,
          after: url.searchParams.get("after"),
        }),
      );
    }
    if (path === "/timer-sessions") {
      note(`GET ${path}?state=${url.searchParams.get("state")}`);
      return fulfil(
        route,
        reads.accountTimers({
          state: url.searchParams.get("state") ?? "all",
          after: url.searchParams.get("after"),
        }),
      );
    }
    if ((m = /^\/tasks\/([^/]+)\/rota$/.exec(path))) {
      note(`GET ${path}`);
      return fulfil(route, reads.rota({ taskId: m[1] as string }));
    }
    if ((m = /^\/tasks\/([^/]+)\/enrolment$/.exec(path))) {
      note(`GET ${path}`);
      return fulfil(route, reads.enrolment({ taskId: m[1] as string }));
    }
    if ((m = /^\/tasks\/([^/]+)\/streak$/.exec(path))) {
      note(`GET ${path}?scope=${url.searchParams.get("scope")}`);
      return fulfil(
        route,
        reads.streak({
          taskId: m[1] as string,
          scope: url.searchParams.get("scope") ?? "joint",
        }),
      );
    }
    return route.fallback();
  });
  return reads;
}

/** A promise and its release, for holding one answer. */
export function held<T = void>(): {
  promise: Promise<T>;
  release(value: T): void;
} {
  let release: (value: T) => void = () => undefined;
  const promise = new Promise<T>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
