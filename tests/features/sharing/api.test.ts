import { afterEach, describe, expect, test } from "vitest";
import {
  classifyAnswer,
  classifyThrown,
  createSharingApi,
  forgetRefusedPolicies,
  parseDirectory,
  parseInvitations,
  parsePolicyState,
  parseReceipt,
  parseTemplateScope,
  untilSent,
} from "../../../src/features/sharing/api";
import { type Session, StampedRequestError } from "../../../src/session";
import { HOME, ME, SAM } from "../../support/data/sharing";

/**
 * WEB-12a's sharing client: every answer is classified (a refusal needs an Atlas error body; anything that may have committed is
 * `uncertain`), every 200 body is validated, and each call goes through the stamped typed client with the right path, query, body and
 * Idempotency-Key. FIXTURE evidence: the session is a double (the I-SH cases run against the released backend).
 */
afterEach(() => {
  Object.defineProperty(navigator, "onLine", {
    value: true,
    configurable: true,
  });
});

const JSON_TYPE = "application/json";
const atlas = (code: string) => ({
  code,
  message: `m:${code}`,
  request_id: "rrrrrrrr-rrrr-4rrr-8rrr-rrrrrrrrrrrr",
  details: [],
});

describe("classifyAnswer", () => {
  test.each([
    [409, "conflict", "conflict"],
    [409, "operation_conflict", "operation_conflict"],
    [409, "last_manager", "last_manager"],
    [410, "invitation_expired", "gone"],
    [403, "forbidden", "forbidden"],
    [404, "not_found", "not_found"],
    [422, "validation", "invalid"],
    [400, "bad_request", "invalid"],
    [409, "something_new", "conflict"],
  ])(
    "%i %s is the refusal %s, with the request id and message",
    (status, code, kind) => {
      expect(classifyAnswer(status, JSON_TYPE, atlas(code))).toEqual({
        ok: false,
        kind,
        requestId: atlas(code).request_id,
        message: `m:${code}`,
      });
    },
  );

  test("a 4xx without an Atlas error body (a gateway page) is NOT a refusal: uncertain", () => {
    expect(classifyAnswer(409, "text/html", "<html>")).toEqual({
      ok: false,
      kind: "uncertain",
    });
    expect(classifyAnswer(403, JSON_TYPE, { error: "nope" })).toEqual({
      ok: false,
      kind: "uncertain",
    });
  });

  test("5xx, 429 and 408 are uncertain (the command may have committed); 401 is closed", () => {
    for (const status of [500, 502, 503, 429, 408])
      expect(classifyAnswer(status, JSON_TYPE, null).kind).toBe("uncertain");
    expect(classifyAnswer(503, JSON_TYPE, atlas("unavailable"))).toEqual({
      ok: false,
      kind: "uncertain",
      requestId: atlas("x").request_id,
    });
    expect(classifyAnswer(401, JSON_TYPE, atlas("unauthorised")).kind).toBe(
      "closed",
    );
  });
});

describe("classifyThrown", () => {
  test("the session's closed set: not_sent and not_covered are not_sent; stale, closed and auth_state are closed; anything else uncertain", () => {
    expect(classifyThrown(new StampedRequestError("not_sent")).kind).toBe(
      "not_sent",
    );
    expect(classifyThrown(new StampedRequestError("not_covered")).kind).toBe(
      "not_sent",
    );
    for (const kind of [
      "stale",
      "closed",
      "closed_unresolved",
      "auth_state",
    ] as const)
      expect(classifyThrown(new StampedRequestError(kind)).kind).toBe("closed");
    expect(classifyThrown(new TypeError("Failed to fetch")).kind).toBe(
      "uncertain",
    );
    expect(
      classifyThrown(new DOMException("timeout", "TimeoutError")).kind,
    ).toBe("uncertain");
  });
});

describe("the 200 bodies, strictly", () => {
  test("PolicyState", () => {
    const body = { version: 3, policy: { grants: [], exclude_accounts: [] } };
    expect(parsePolicyState(body)).toEqual(body);
    expect(parsePolicyState({ ...body, version: 0 })).toBeNull();
    expect(parsePolicyState({ ...body, extra: 1 })).toBeNull();
    expect(parsePolicyState({ version: 1, policy: { grants: [] } })).toBeNull();
  });
  test("TemplateScope: null or a template, version >= 0, all five kinds", () => {
    const scope = {
      person: { template: null, version: 0 },
      field: { template: { kind: "private" }, version: 2 },
      task: { template: null, version: 0 },
      list: { template: null, version: 0 },
      progress: {
        template: { kind: "primary_household", edit: false },
        version: 1,
      },
    };
    expect(parseTemplateScope(scope)).toEqual(scope);
    const { progress: _, ...four } = scope;
    expect(parseTemplateScope(four)).toBeNull();
    expect(
      parseTemplateScope({
        ...scope,
        task: { template: { kind: "x" }, version: 1 },
      }),
    ).toBeNull();
  });
  test("Directory, Invitations, Receipt", () => {
    expect(parseDirectory([{ id: SAM, username: "sam" }])).toEqual([
      { id: SAM, username: "sam" },
    ]);
    expect(parseDirectory([{ id: "sam", username: "sam" }])).toBeNull();
    const invitation = {
      id: SAM,
      household_id: HOME,
      household_name: "Home",
      sender_id: ME,
      status: "pending",
      expires_at: "2026-10-17T10:00:00Z",
      version: 1,
    };
    expect(parseInvitations([invitation])).toEqual([invitation]);
    expect(parseInvitations([{ ...invitation, status: "lost" }])).toBeNull();
    expect(parseReceipt({ revision: 7 })).toEqual({ revision: 7 });
    expect(parseReceipt({ revision: 0 })).toBeNull();
  });
});

/** The typed client's call arguments, as loose data (the double records whatever the client was asked). */
// biome-ignore lint/suspicious/noExplicitAny: the double stands in for openapi-fetch's generic GET/POST signatures
type Init = any;

describe("createSharingApi over the stamped client", () => {
  function sessionDouble(
    answer: (method: string, path: string, init: Init) => Init,
  ) {
    const requests: Array<{
      klass: string;
      account: string;
      epoch: number;
      method: string;
      path: string;
      init: Init;
    }> = [];
    const session = {
      api: {
        client: (klass: string, account: string, epoch: number) => ({
          GET: async (path: string, init: Init) => {
            requests.push({ klass, account, epoch, method: "GET", path, init });
            return answer("GET", path, init);
          },
          POST: async (path: string, init: Init) => {
            requests.push({
              klass,
              account,
              epoch,
              method: "POST",
              path,
              init,
            });
            return answer("POST", path, init);
          },
        }),
      },
    } as unknown as Session;
    return { session, requests };
  }
  const response = (status: number, contentType = JSON_TYPE) =>
    new Response(null, {
      status: status === 204 ? 204 : status,
      headers: { "content-type": contentType },
    });

  test("replace_policy goes to /management-commands with the Idempotency-Key, through the ordinary client of (account, epoch)", async () => {
    const { session, requests } = sessionDouble(() => ({
      data: { revision: 9 },
      response: response(200),
    }));
    const api = createSharingApi(session, ME, 4);
    const command = {
      kind: "replace_policy" as const,
      id: SAM,
      expected_version: 2,
      policy: { grants: [], exclude_accounts: [] },
    };
    expect(await api.management([command], "key-1")).toEqual({
      ok: true,
      value: { revision: 9 },
    });
    expect(requests).toEqual([
      {
        klass: "ordinary",
        account: ME,
        epoch: 4,
        method: "POST",
        path: "/management-commands",
        init: {
          params: { header: { "Idempotency-Key": "key-1" } },
          body: { commands: [command] },
        },
      },
    ]);
  });

  test("a 200 that is not a receipt is uncertain (it may have committed), never a success", async () => {
    const { session } = sessionDouble(() => ({
      data: { ok: true },
      response: response(200),
    }));
    expect((await createSharingApi(session, ME, 1).access([], "k")).ok).toBe(
      false,
    );
    expect(await createSharingApi(session, ME, 1).access([], "k")).toEqual({
      ok: false,
      kind: "uncertain",
    });
  });

  test("the reads: GET /policies/{id}, /defaults/templates with and without household_id, /directory?username", async () => {
    const { session, requests } = sessionDouble((_m, path) => ({
      data:
        path === "/policies/{id}"
          ? { version: 1, policy: { grants: [], exclude_accounts: [] } }
          : path === "/directory"
            ? []
            : null,
      response: response(200),
    }));
    const api = createSharingApi(session, ME, 1);
    await api.readPolicy(SAM);
    await api.readTemplates(null);
    await api.readTemplates(HOME);
    await api.lookup("sam");
    expect(requests.map((r) => [r.path, r.init])).toEqual([
      ["/policies/{id}", { params: { path: { id: SAM } } }],
      ["/defaults/templates", { params: { query: {} } }],
      ["/defaults/templates", { params: { query: { household_id: HOME } } }],
      ["/directory", { params: { query: { username: "sam" } } }],
    ]);
  });

  test("an Atlas refusal is classified from the response and its error body", async () => {
    const { session } = sessionDouble(() => ({
      error: atlas("conflict"),
      response: response(409),
    }));
    expect(
      await createSharingApi(session, ME, 1).management([], "k"),
    ).toMatchObject({ ok: false, kind: "conflict" });
  });

  test("MU-S20: a policy read refused with 403 is not asked again for the same account (the 403 remounts the protected tree)", async () => {
    forgetRefusedPolicies();
    const { session, requests } = sessionDouble(() => ({
      error: atlas("forbidden"),
      response: response(403),
    }));
    const api = createSharingApi(session, ME, 1);
    expect((await api.readPolicy(SAM)).ok).toBe(false);
    expect(await api.readPolicy(SAM)).toEqual({ ok: false, kind: "forbidden" });
    expect(await createSharingApi(session, ME, 2).readPolicy(SAM)).toEqual({
      ok: false,
      kind: "forbidden",
    });
    expect(requests).toHaveLength(1);
    // Two reads of the same policy at once are ONE request.
    forgetRefusedPolicies();
    const both = await Promise.all([api.readPolicy(SAM), api.readPolicy(SAM)]);
    expect(both.every((r) => !r.ok)).toBe(true);
    expect(requests).toHaveLength(2);
    // Another account, or another resource, is asked.
    await createSharingApi(session, SAM, 1).readPolicy(SAM);
    await api.readPolicy(HOME);
    expect(requests).toHaveLength(4);
    forgetRefusedPolicies();
  });

  test("offline: nothing is sent", async () => {
    Object.defineProperty(navigator, "onLine", {
      value: false,
      configurable: true,
    });
    const { session, requests } = sessionDouble(() => ({
      data: { revision: 1 },
      response: response(200),
    }));
    expect(await createSharingApi(session, ME, 1).management([], "k")).toEqual({
      ok: false,
      kind: "offline",
    });
    expect(requests).toEqual([]);
  });
});

describe("untilSent", () => {
  test("asks again after not_sent, a bounded number of times", async () => {
    let calls = 0;
    const result = await untilSent(
      async () => {
        calls += 1;
        return calls < 3
          ? ({ ok: false, kind: "not_sent" } as const)
          : ({ ok: true, value: 1 } as const);
      },
      { sleep: async () => undefined },
    );
    expect(result).toEqual({ ok: true, value: 1 });
    expect(calls).toBe(3);
    let forever = 0;
    const last = await untilSent(
      async () => {
        forever += 1;
        return { ok: false, kind: "not_sent" } as const;
      },
      { sleep: async () => undefined },
    );
    expect(last.ok).toBe(false);
    expect(forever).toBe(7);
  });
});
