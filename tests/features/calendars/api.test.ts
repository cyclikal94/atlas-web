// @vitest-environment node
import { describe, expect, test } from "vitest";
import {
  createCalendarApi,
  decodeReceipt,
  decodeSourcePage,
  LIVE_PAGES,
} from "../../../src/features/calendars/api";
import { StampedRequestError } from "../../../src/session";

/**
 * The direct calendar client (WEB-13a) over a double of the session's typed client: what each answer is classified as, the strict
 * body checks, `not_sent` asked again within its bound, a `stale` answer dropped, and the live list's page bound. The double records
 * every call (method, path, the Idempotency-Key and the body), so a test can say what went on the wire.
 */
interface Call {
  method: string;
  path: string;
  key?: string;
  body?: unknown;
  query?: unknown;
  pathId?: string;
}
type Reply =
  | { status: number; json?: unknown; contentType?: string }
  | { throws: unknown };

const atlas = (code: string, extra: Record<string, unknown> = {}) => ({
  code,
  message: "m",
  request_id: "11111111-1111-4111-8111-111111111111",
  details: [],
  ...extra,
});

function world(replies: Reply[]) {
  const calls: Call[] = [];
  const answer = async (call: Call) => {
    calls.push(call);
    const reply = replies.shift() ?? { status: 200, json: { revision: 1 } };
    if ("throws" in reply) throw reply.throws;
    const response = new Response(null, {
      status: reply.status,
      headers: { "content-type": reply.contentType ?? "application/json" },
    });
    return reply.status < 300
      ? { data: reply.json, response }
      : { error: reply.json, response };
  };
  const client = {
    POST: (
      path: string,
      init: {
        params: { header: Record<string, string>; path?: { id: string } };
        body?: unknown;
      },
    ) =>
      answer({
        method: "POST",
        path,
        key: init.params.header["Idempotency-Key"],
        body: init.body,
        pathId: init.params.path?.id,
      }),
    GET: (path: string, init?: { params?: { query?: unknown } }) =>
      answer({ method: "GET", path, query: init?.params?.query }),
  };
  const sleeps: number[] = [];
  const api = createCalendarApi(
    { api: { client: () => client } } as never,
    "acct",
    1,
    { sleep: async (ms) => void sleeps.push(ms) },
  );
  return { api, calls, sleeps };
}

const COMMAND = { kind: "create_source", id: "s", label: "L", timezone: "UTC" };

describe("command and refresh: what goes on the wire", () => {
  test("a command is POST /calendar-commands {command} with the given key; refresh has no body", async () => {
    const w = world([
      { status: 200, json: { revision: 5 } },
      { status: 200, json: { revision: 0 } },
    ]);
    expect(await w.api.command(COMMAND, "K1")).toEqual({
      ok: true,
      value: { revision: 5 },
    });
    // A revision of zero is a receipt (case 4: "may contain revision zero").
    expect(await w.api.refresh("S1", "K2")).toEqual({
      ok: true,
      value: { revision: 0 },
    });
    expect(w.calls).toEqual([
      {
        method: "POST",
        path: "/calendar-commands",
        key: "K1",
        body: { command: COMMAND },
        pathId: undefined,
      },
      {
        method: "POST",
        path: "/calendar-sources/{id}/refresh",
        key: "K2",
        body: undefined,
        pathId: "S1",
      },
    ]);
  });
});

describe("classification", () => {
  test("an Atlas refusal carries its status, code and request id, and a stale_refresh its reason", async () => {
    const w = world([
      {
        status: 409,
        json: atlas("stale_refresh", { reason: "lease_expired" }),
      },
      { status: 422, json: atlas("connection_unavailable") },
      { status: 409, json: atlas("stale_refresh", { reason: "made_up" }) },
    ]);
    expect(await w.api.refresh("S", "K")).toEqual({
      ok: false,
      kind: "refused",
      status: 409,
      code: "stale_refresh",
      reason: "lease_expired",
      requestId: "11111111-1111-4111-8111-111111111111",
    });
    expect(await w.api.refresh("S", "K")).toMatchObject({
      kind: "refused",
      code: "connection_unavailable",
    });
    expect(await w.api.refresh("S", "K")).not.toHaveProperty("reason");
  });

  test("an answer without an Atlas body is uncertain: a gateway 502, an HTML 404, a 200 that is not a receipt", async () => {
    const w = world([
      { status: 502, json: "Bad gateway", contentType: "text/html" },
      { status: 404, json: { error: "nope" } },
      { status: 200, json: { revision: -1 } },
      { status: 200, json: { revision: 1, extra: true } },
    ]);
    for (const status of [502, 404, 200, 200])
      expect(await w.api.refresh("S", "K")).toEqual({
        ok: false,
        kind: "uncertain",
        status,
      });
  });

  test("a network error, an abort or a time-out is uncertain", async () => {
    const w = world([
      { throws: new TypeError("Failed to fetch") },
      { throws: new DOMException("aborted", "AbortError") },
    ]);
    expect(await w.api.refresh("S", "K")).toEqual({
      ok: false,
      kind: "uncertain",
    });
    expect(await w.api.refresh("S", "K")).toEqual({
      ok: false,
      kind: "uncertain",
    });
  });

  test("not_sent is asked again within its bound and nothing else is counted; a stale answer is dropped as closed", async () => {
    const notSent = { throws: new StampedRequestError("not_sent") };
    const w = world([notSent, notSent, { status: 200, json: { revision: 9 } }]);
    expect(await w.api.refresh("S", "K")).toEqual({
      ok: true,
      value: { revision: 9 },
    });
    expect(w.calls.map((c) => c.key)).toEqual(["K", "K", "K"]);
    expect(w.sleeps).toEqual([50, 100]);
    const always = world(Array(20).fill(notSent));
    expect(await always.api.refresh("S", "K")).toEqual({
      ok: false,
      kind: "not_sent",
    });
    expect(always.calls.length).toBe(10);
    const stale = world([{ throws: new StampedRequestError("stale") }]);
    expect(await stale.api.refresh("S", "K")).toEqual({
      ok: false,
      kind: "closed",
    });
    const auth = world([{ throws: new StampedRequestError("auth_state") }]);
    expect(await auth.api.command(COMMAND, "K")).toEqual({
      ok: false,
      kind: "closed",
    });
  });

  test("the caller's live is asked before EVERY admission (revision 1, R4): once it says no, nothing more is sent and the answer is closed", async () => {
    const notSent = { throws: new StampedRequestError("not_sent") };
    // Control: the caller stays live, so the request is admitted again after each not_sent and sent.
    const control = world([
      notSent,
      notSent,
      { status: 200, json: { revision: 2 } },
    ]);
    expect(await control.api.command(COMMAND, "K", () => true)).toMatchObject({
      ok: true,
    });
    expect(control.calls).toHaveLength(3);
    // The caller goes during the wait after the first not_sent (it is live for the first admission only): no second admission.
    const gone = world([notSent, { status: 200, json: { revision: 2 } }]);
    let asked = 0;
    expect(await gone.api.command(COMMAND, "K", () => ++asked === 1)).toEqual({
      ok: false,
      kind: "closed",
    });
    expect(gone.calls).toHaveLength(1);
    expect(asked).toBe(2);
    // A caller that is already gone sends nothing at all, on every route of the client.
    const never = world([]);
    const no = () => false;
    for (const result of [
      await never.api.command(COMMAND, "K", no),
      await never.api.refresh("S", "K", no),
      await never.api.liveSources(no),
      await never.api.capabilities(no),
    ])
      expect(result).toEqual({ ok: false, kind: "closed" });
    expect(never.calls).toEqual([]);
  });
});

describe("the live list and the capability", () => {
  const item = (id: string, refreshing: boolean, health = "healthy") => ({
    id,
    kind: "calendar_source",
    parent_id: null,
    label: "L",
    value: { health, timezone: "UTC", refresh_in_progress: refreshing },
    version: 1,
    can_edit: true,
    archived: false,
  });

  test("reads every page until next_after is null, keeping only id, refresh_in_progress and health", async () => {
    const w = world([
      { status: 200, json: { items: [item("a", true)], next_after: "a" } },
      {
        status: 200,
        json: { items: [item("b", false, "fetch_failed")], next_after: null },
      },
    ]);
    const result = await w.api.liveSources();
    expect(result).toEqual({
      ok: true,
      value: {
        sources: new Map([
          ["a", { refreshInProgress: true, health: "healthy" }],
          ["b", { refreshInProgress: false, health: "fetch_failed" }],
        ]),
        complete: true,
      },
    });
    expect(w.calls.map((c) => c.query)).toEqual([
      { limit: 200 },
      { limit: 200, after: "a" },
    ]);
  });

  test("stops after LIVE_PAGES pages and says the list is incomplete", async () => {
    const w = world(
      Array.from({ length: LIVE_PAGES + 2 }, (_, i) => ({
        status: 200,
        json: { items: [item(`s${i}`, false)], next_after: `s${i}` },
      })),
    );
    const result = await w.api.liveSources();
    expect(w.calls.length).toBe(LIVE_PAGES);
    expect(result.ok && result.value.complete).toBe(false);
  });

  test("a page whose source lacks the read-time flag is not the contract's answer", () => {
    expect(
      decodeSourcePage({
        items: [{ ...item("a", false), value: { health: "healthy" } }],
        next_after: null,
      }),
    ).toBeNull();
    expect(
      decodeSourcePage({
        items: [{ ...item("a", false), kind: "task" }],
        next_after: null,
      }),
    ).toBeNull();
    expect(decodeSourcePage({ items: [], next_after: 3 })).toBeNull();
  });

  test("the capability is calendar_links, strictly", async () => {
    const w = world([
      { status: 200, json: { calendar_links: false, ntfy: true } },
      { status: 200, json: { calendar_links: "yes" } },
    ]);
    expect(await w.api.capabilities()).toEqual({
      ok: true,
      value: { calendarLinks: false },
    });
    expect(await w.api.capabilities()).toMatchObject({
      ok: false,
      kind: "uncertain",
    });
    expect(w.calls[0]).toMatchObject({
      method: "GET",
      path: "/notification-capabilities",
    });
  });

  test("decodeReceipt accepts exactly {revision: integer >= 0}", () => {
    expect(decodeReceipt({ revision: 0 })).toEqual({ revision: 0 });
    expect(decodeReceipt({ revision: 1.5 })).toBeNull();
    expect(decodeReceipt({ revision: "1" })).toBeNull();
    expect(decodeReceipt([])).toBeNull();
    expect(decodeReceipt(null)).toBeNull();
  });
});
