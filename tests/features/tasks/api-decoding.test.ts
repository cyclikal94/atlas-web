// @vitest-environment node
import { describe, expect, test } from "vitest";
import {
  createTasksApi,
  type MaterialiseCommand,
  type TasksResult,
} from "../../../src/features/tasks/api";
import { createApiClient } from "../../../src/lib/api-client";
import { type Session, StampedRequestError } from "../../../src/session";
import { checkProperties } from "../../support/session/properties";
import {
  leaseIds,
  newWorld,
  openPage,
  signedInPage,
} from "../../support/session/scenarios";

/**
 * Revision 15 (review 16's R39; design assessment C3/Q3): how the task API classifies what it RECEIVED, through the production
 * composition: `createTasksApi` over the typed client of `createApiClient` (openapi-fetch as installed) and, below, over the real session
 * kernel's stamped client (`session.api.client`). A successful answer's body is asked for as text and decoded by the task API after the
 * session's final validation (`sealResult`), so a received body that is not JSON is `unrecognised` (an answer the server gave that is not
 * the contract's), never `transport` (no answer). FIXTURE evidence: injected Responses and the session harness's server, no backend.
 */
const ACCOUNT = "00000000-0000-4000-8000-0000000000a1";
const TASK = "aaaaaaaa-0000-4000-8000-0000000000b1";
const COMMAND: MaterialiseCommand = {
  kind: "materialise",
  task_id: TASK,
  through_date: "2026-10-25",
  limit: 31,
};

/** The task API over the production typed client, every request answered by `respond` (a Response, or a rejection). */
const apiOver = (respond: (request: Request) => Promise<Response>) => {
  const requests: Request[] = [];
  const client = createApiClient(async (request) => {
    requests.push(request);
    return respond(request);
  }, "http://127.0.0.1/api/experimental/v1");
  const api = createTasksApi(
    { api: { client: () => client } } as unknown as Session,
    ACCOUNT,
    1,
  );
  return { api, requests };
};
const answer =
  (body: BodyInit | null, status = 200, headers: Record<string, string> = {}) =>
  async () =>
    new Response(body, {
      status,
      headers: { "content-type": "application/json", ...headers },
    });
const atlas = (code: string) =>
  JSON.stringify({ code, message: "m", request_id: "req-1", details: [] });
const UNRECOGNISED = {
  ok: false,
  kind: "uncertain",
  retry: { cause: "unrecognised" },
} as const;
const TRANSPORT = {
  ok: false,
  kind: "uncertain",
  retry: { cause: "transport" },
} as const;

/** Each caller of the shared decode: the catch-up's two (the position read, the command), and the access command. */
const CALLERS: ReadonlyArray<
  [
    string,
    (api: ReturnType<typeof apiOver>["api"]) => Promise<TasksResult<unknown>>,
  ]
> = [
  ["GET /tasks/{id} (readTask)", (api) => api.readTask(TASK)],
  [
    "POST /task-commands (materialise)",
    (api) => api.materialise(COMMAND, "k-1"),
  ],
  [
    "POST /task-access-commands (access)",
    (api) =>
      api.access(
        {
          kind: "rota_consent",
          task_id: TASK,
          expected_version: 1,
          accepted: true,
        },
        "k-2",
      ),
  ],
];

describe("REVISION15 R39: a received body is classified as received, through the production client", () => {
  for (const [name, run] of CALLERS) {
    test.each([
      ["malformed JSON `{` (the review's witness)", "{"],
      ["truncated JSON", '{"revision": 1'],
      ["an empty body (no Content-Length)", ""],
      ["a body that is not JSON at all", "<html>gateway</html>"],
    ])(
      `${name}: a 200 whose body is %s is UNRECOGNISED, never transport`,
      async (_what, body) => {
        const { api, requests } = apiOver(
          answer(body, 200, { "x-request-id": "req-x" }),
        );
        const result = await run(api);
        expect(requests).toHaveLength(1);
        expect(result).toEqual({ ...UNRECOGNISED, requestId: "req-x" });
      },
    );

    test(`${name}: the CONTROL, a 200 of valid JSON of the wrong shape (\`{}\`), is unrecognised as before`, async () => {
      const { api } = apiOver(answer("{}"));
      expect(await run(api)).toEqual(UNRECOGNISED);
    });

    test(`${name}: a genuine fetch rejection (no Response) stays TRANSPORT`, async () => {
      const { api } = apiOver(async () => {
        throw new TypeError("Failed to fetch");
      });
      expect(await run(api)).toEqual(TRANSPORT);
    });

    test(`${name}: the session's protocol outcomes keep their meaning (not sent, stale: closed)`, async () => {
      for (const [kind, expected] of [
        ["not_sent", "not_sent"],
        ["stale", "closed"],
        ["auth_state", "closed"],
      ] as const) {
        const { api } = apiOver(async () => {
          throw new StampedRequestError(kind);
        });
        expect(await run(api)).toEqual({ ok: false, kind: expected });
      }
    });
  }

  test("a valid answer is decoded and parsed (the positive control of the text decode)", async () => {
    const { api, requests } = apiOver(answer(JSON.stringify({ revision: 7 })));
    expect(await api.materialise(COMMAND, "k-1")).toEqual({
      ok: true,
      value: { revision: 7 },
    });
    // The canonical body and key are unchanged by the decode.
    expect(requests[0]?.headers.get("idempotency-key")).toBe("k-1");
    expect(JSON.parse(await (requests[0] as Request).text())).toEqual({
      command: COMMAND,
    });
  });

  test("a 204 or a Content-Length 0 has no body to decode: unrecognised where an answer is required, as before", async () => {
    for (const make of [
      async () => new Response(null, { status: 204 }),
      answer("", 200, { "content-length": "0" }),
    ]) {
      const { api } = apiOver(make);
      expect(await api.readTask(TASK)).toEqual(UNRECOGNISED);
    }
  });

  test("error statuses keep their classification whatever their body: 503 recognised, 503/500 malformed, 429 malformed with its Retry-After, 401", async () => {
    const cases: Array<[() => Promise<Response>, unknown]> = [
      [
        answer(atlas("temporarily_unavailable"), 503),
        {
          ok: false,
          kind: "uncertain",
          requestId: "req-1",
          code: "temporarily_unavailable",
          retry: { cause: "transient" },
        },
      ],
      [answer("{", 503), UNRECOGNISED],
      [answer("{", 500), UNRECOGNISED],
      [
        answer("{", 429, { "retry-after": "5" }),
        {
          ok: false,
          kind: "uncertain",
          retry: { cause: "rate_limited", afterMs: 5_000 },
        },
      ],
      [answer("{", 401), { ok: false, kind: "closed" }],
      [
        answer(atlas("not_found"), 404),
        {
          ok: false,
          kind: "not_found",
          requestId: "req-1",
          code: "not_found",
        },
      ],
    ];
    for (const [make, expected] of cases) {
      const { api } = apiOver(make);
      expect(await api.readTask(TASK)).toEqual(expected);
    }
  });

  test("a body stream that fails after the headers (no complete answer received) stays transport: the policy is unchanged, not covered by the malformed-JSON correction", async () => {
    const { api } = apiOver(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('{"rev'));
              controller.error(new TypeError("network error"));
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    expect(await api.readTask(TASK)).toEqual(TRANSPORT);
  });
});

describe("REVISION15 R39 over the real session kernel: a received invalid body is sealed too", () => {
  const errorOf = (promise: Promise<unknown>) =>
    promise.then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );

  test("CONTROL: a malformed 200 delivered with no transition is unrecognised (received through the stamped client and its final check)", async () => {
    const f = await newWorld();
    const l = await signedInPage(f);
    f.server.addRule({
      match: (r) => r.path.endsWith(`/tasks/${TASK}`),
      rewrite: { status: 200, body: "{" },
    });
    const api = createTasksApi(l.page.session, l.account, l.epoch);
    const result = await f.runWith(api.readTask(TASK));
    expect(result).toMatchObject(UNRECOGNISED);
    expect(leaseIds(f)).toEqual([]);
    expect(checkProperties(f)).toEqual([]);
  });

  test("the identity moves while the malformed body is being received: the answer is dropped (closed), never classified as A's unrecognised answer", async () => {
    const f = await newWorld();
    const l = await signedInPage(f);
    const other = await openPage(f);
    const stop = f.server.addRule({
      match: (r) => r.path.endsWith(`/tasks/${TASK}`) && r.page === l.page.id,
      rewrite: { status: 200, body: "{" },
      bodyDelay: "unbounded",
    });
    const api = createTasksApi(l.page.session, l.account, l.epoch);
    const pending = errorOf(api.readTask(TASK));
    await f.world.runUntilIdle();
    expect(f.world.heldCount("Db")).toBe(1);
    f.world.setKnob("D2", "unbounded", (meta) => meta.page === l.page.id);
    expect((await f.signIn(other, "sam", "pw2")).kind).toBe("settled");
    await f.settle();
    stop();
    f.world.release("Db");
    await f.world.runUntilIdle();
    expect(await pending).toEqual({ value: { ok: false, kind: "closed" } });
    expect(leaseIds(f)).toEqual([]);
    expect(checkProperties(f)).toEqual([]);
  });
});
