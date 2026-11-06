// @vitest-environment node
import { describe, expect, test } from "vitest";
import { createTasksApi } from "../../../src/features/tasks/api";
import { createApiClient } from "../../../src/lib/api-client";
import type { Session } from "../../../src/session";
import { DOCUMENTED } from "../../support/tasks/graphs";

/**
 * WEB-18 (plan §3.3): `readDependencyGraph` through the production composition, `createTasksApi` over the typed client of
 * `createApiClient`: the path and query it asks (no parameter for the full read, `max_depth=1` for the editor's), the strict parse of a
 * TEXT body against the request it answers, and the classification of the contract's declared errors. FIXTURE: injected Responses.
 */
const ACCOUNT = "00000000-0000-4000-8000-0000000000a1";
const chain = JSON.parse(DOCUMENTED.chain as string) as { root_id: string };
const depthOne = JSON.parse(DOCUMENTED.depthOne as string) as {
  root_id: string;
};

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

describe("readDependencyGraph", () => {
  test("the full read names no max_depth and is checked against the default (200)", async () => {
    const { api, requests } = apiOver(answer(DOCUMENTED.chain as string));
    const result = await api.readDependencyGraph(chain.root_id);
    expect(requests).toHaveLength(1);
    const url = new URL(requests[0]?.url as string);
    expect(url.pathname).toBe(
      `/api/experimental/v1/occurrences/${chain.root_id}/dependency-graph`,
    );
    expect(url.search).toBe("");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.max_depth).toBe(200);
  });

  test("the editor's read asks max_depth=1 and its answer must say 1", async () => {
    const { api, requests } = apiOver(answer(DOCUMENTED.depthOne as string));
    const result = await api.readDependencyGraph(depthOne.root_id, 1);
    expect(
      new URL(requests[0]?.url as string).searchParams.get("max_depth"),
    ).toBe("1");
    expect(result.ok).toBe(true);
    // The same body for a full read is not that read's answer.
    const full = apiOver(answer(DOCUMENTED.depthOne as string));
    expect(await full.api.readDependencyGraph(depthOne.root_id)).toMatchObject({
      ok: false,
      kind: "uncertain",
    });
  });

  test("an answer for another root is not this read's answer (uncertain)", async () => {
    const { api } = apiOver(answer(DOCUMENTED.chain as string));
    expect(
      await api.readDependencyGraph("6e0a1d7c-2f3b-5c4d-8e9f-0a1b2c3d4e99"),
    ).toMatchObject({
      ok: false,
      kind: "uncertain",
      retry: { cause: "unrecognised" },
    });
  });

  test("a body that is not JSON is unrecognised, never transport", async () => {
    const { api } = apiOver(answer("{", 200, { "x-request-id": "req-x" }));
    expect(await api.readDependencyGraph(chain.root_id)).toEqual({
      ok: false,
      kind: "uncertain",
      requestId: "req-x",
      retry: { cause: "unrecognised" },
    });
  });

  test.each([
    [404, "not_found", { ok: false, kind: "not_found" }],
    [403, "forbidden", { ok: false, kind: "forbidden" }],
    [403, "credential_mismatch", { ok: false, kind: "forbidden" }],
    [409, "conflict", { ok: false, kind: "conflict" }],
    [422, "invalid_value", { ok: false, kind: "invalid" }],
    [400, "malformed_request", { ok: false, kind: "invalid" }],
    [
      503,
      "slice_capacity",
      { ok: false, kind: "uncertain", code: "slice_capacity" },
    ],
    [
      503,
      "temporarily_unavailable",
      { ok: false, kind: "uncertain", retry: { cause: "transient" } },
    ],
    [
      500,
      "internal_error",
      { ok: false, kind: "uncertain", retry: { cause: "transient" } },
    ],
  ])("%i %s is classified", async (status, code, expected) => {
    const { api } = apiOver(answer(atlas(code), status));
    expect(await api.readDependencyGraph(chain.root_id)).toMatchObject(
      expected,
    );
  });

  test("401 closes", async () => {
    const { api } = apiOver(answer(atlas("unauthenticated"), 401));
    expect(await api.readDependencyGraph(chain.root_id)).toEqual({
      ok: false,
      kind: "closed",
    });
  });
});
