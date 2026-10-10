// @vitest-environment node
import { describe, expect, test } from "vitest";
import {
  classifyFailure,
  classifyStatus,
  currentDeviceThrough,
  readMeThrough,
} from "../../src/data/ui/identity-reads";
import { createApiClient } from "../../src/lib/api-client";
import { type Session, StampedRequestError } from "../../src/session";

/**
 * R16 (revision 8): the production adapters of `GET /me` and `GET /sessions` CLASSIFY what happened, because the retry budget treats
 * the classes differently (plan 5.6) and the review's loop came from flattening every failure to `null`. The typed client here is the
 * real `openapi-fetch` client over a scripted stamped fetch; the sessions list is scripted at the operation's own `Result`.
 */
const ACCOUNT = "11111111-1111-4111-8111-111111111111";

const respond = (
  status: number,
  body?: unknown,
  contentType = "application/json",
) =>
  new Response(
    body === undefined
      ? null
      : typeof body === "string"
        ? body
        : JSON.stringify(body),
    {
      status,
      headers: body === undefined ? {} : { "content-type": contentType },
    },
  );

function sessionOver(
  stamped: (request: Request) => Promise<Response>,
): Session {
  return {
    api: {
      client: () =>
        createApiClient(stamped, "http://localhost/api/experimental/v1"),
    },
  } as unknown as Session;
}

const readMe = (stamped: (request: Request) => Promise<Response>) =>
  readMeThrough(sessionOver(stamped))(ACCOUNT, 1);

describe("GET /me", () => {
  test("a 200 with a body is the answer", async () => {
    const body = { id: ACCOUNT, username: "kieran" };
    expect(await readMe(async () => respond(200, body))).toEqual({
      kind: "ok",
      value: body,
    });
  });

  test.each([[408], [429], [500], [502], [503], [504], [599]])(
    "%i is the network/5xx class (counted, backed off)",
    async (status) => {
      expect(
        await readMe(async () =>
          respond(status, { code: "temporarily_unavailable", message: "m" }),
        ),
      ).toEqual({ kind: "failure" });
    },
  );

  test.each([[400], [401], [403], [404], [409], [410], [422]])(
    "%i is an unrecognised answer (counted, three pause the caller)",
    async (status) => {
      expect(
        await readMe(async () =>
          respond(status, { code: "not_found", message: "m" }),
        ),
      ).toEqual({ kind: "unrecognised" });
    },
  );

  test("a 5xx with a body that is not JSON is still the network/5xx class", async () => {
    expect(
      await readMe(async () =>
        respond(503, "<html>bad gateway</html>", "text/html"),
      ),
    ).toEqual({ kind: "failure" });
  });

  test("a 200 that is empty, or whose body is not JSON, is not the contract's answer", async () => {
    expect(await readMe(async () => respond(200))).toEqual({
      kind: "unrecognised",
    });
    expect(
      await readMe(async () => respond(200, "not json", "application/json")),
    ).toEqual({ kind: "unrecognised" });
  });

  test("a transport failure, an abort and a time-out are the network class", async () => {
    expect(
      await readMe(async () => {
        throw new TypeError("Failed to fetch");
      }),
    ).toEqual({ kind: "failure" });
    expect(
      await readMe(async () => {
        throw new DOMException("aborted", "AbortError");
      }),
    ).toEqual({ kind: "failure" });
    expect(
      await readMe(async () => {
        throw new DOMException("timed out", "TimeoutError");
      }),
    ).toEqual({ kind: "failure" });
  });

  test.each([
    ["not_sent", "not_sent"],
    ["not_covered", "not_sent"],
    ["stale", "not_sent"],
    ["closed", "closed"],
    ["closed_unresolved", "closed"],
    ["auth_state", "closed"],
  ] as const)(
    "the session's %s counts nothing: it is %s",
    async (kind, expected) => {
      expect(
        await readMe(async () => {
          throw new StampedRequestError(kind);
        }),
      ).toEqual({ kind: expected });
    },
  );
});

describe("GET /sessions", () => {
  const device = (
    result: Awaited<ReturnType<Session["operations"]["listSessions"]>>,
  ) =>
    currentDeviceThrough({
      operations: { listSessions: async () => result },
    } as unknown as Session)();

  const row = (id: string, current: boolean) => ({
    id,
    device_id: `device-${id}`,
    current,
    created_at: "2026-10-01T00:00:00.000Z",
    expires_at: "2026-10-02T00:00:00.000Z",
    authentication: "local" as const,
  });

  test("the device of the row marked current is the answer", async () => {
    expect(
      await device({
        ok: true,
        value: { sessions: [row("a", false), row("b", true)] },
      } as never),
    ).toEqual({ kind: "ok", value: "device-b" });
  });

  test("a list with no current row is not the contract's answer", async () => {
    expect(
      await device({
        ok: true,
        value: { sessions: [row("a", false)] },
      } as never),
    ).toEqual({ kind: "unrecognised" });
    expect(
      await device({ ok: true, value: { sessions: [] } } as never),
    ).toEqual({ kind: "unrecognised" });
  });

  test("offline (a transport failure or a body that dropped) is the network class", async () => {
    expect(await device({ ok: false, error: "offline" })).toEqual({
      kind: "failure",
    });
  });

  test.each([
    [429, "failure"],
    [500, "failure"],
    [503, "failure"],
    [404, "unrecognised"],
    [403, "unrecognised"],
    // A 200 whose body was not a list arrives as `http` with the 200.
    [200, "unrecognised"],
  ] as const)("http %i is %s", async (status, expected) => {
    expect(await device({ ok: false, error: "http", status })).toEqual({
      kind: expected,
    });
  });

  test("an http answer with no status is unrecognised", async () => {
    expect(await device({ ok: false, error: "http" })).toEqual({
      kind: "unrecognised",
    });
  });

  test("nothing sent, and a request the session closed, count nothing", async () => {
    expect(await device({ ok: false, error: "not_sent" })).toEqual({
      kind: "not_sent",
    });
    expect(await device({ ok: false, error: "auth_state" })).toEqual({
      kind: "closed",
    });
    expect(await device({ ok: false, error: "closed" })).toEqual({
      kind: "closed",
    });
  });

  test("an operation that rejects is classified like a request that threw", async () => {
    const through = (error: unknown) =>
      currentDeviceThrough({
        operations: {
          listSessions: async () => {
            throw error;
          },
        },
      } as unknown as Session)();
    expect(await through(new TypeError("Failed to fetch"))).toEqual({
      kind: "failure",
    });
    expect(await through(new StampedRequestError("auth_state"))).toEqual({
      kind: "closed",
    });
  });
});

describe("the classes themselves", () => {
  test("classifyStatus: 5xx, 429 and 408 are failures of the network or the server; everything else is outside the contract", () => {
    for (const status of [408, 429, 500, 501, 502, 503, 504, 520, 599])
      expect(classifyStatus(status)).toBe("failure");
    for (const status of [
      0, 200, 204, 301, 400, 401, 403, 404, 409, 410, 422, 499,
    ])
      expect(classifyStatus(status)).toBe("unrecognised");
  });

  test("classifyFailure: only the session's closed set is anything but a failure of the network, and a parse error is unrecognised", () => {
    expect(classifyFailure(new TypeError("x"))).toEqual({ kind: "failure" });
    expect(classifyFailure(new Error("x"))).toEqual({ kind: "failure" });
    expect(classifyFailure("a string")).toEqual({ kind: "failure" });
    expect(classifyFailure(undefined)).toEqual({ kind: "failure" });
    expect(classifyFailure(new SyntaxError("Unexpected token"))).toEqual({
      kind: "unrecognised",
    });
  });
});
