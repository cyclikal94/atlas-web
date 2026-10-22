// @vitest-environment node
import { createHash } from "node:crypto";
import type { BrowserContext, Route } from "@playwright/test";
import { describe, expect, it } from "vitest";
import { AuthStub } from "../e2e/auth-stub";

/**
 * WEB-14a revision 22 (review R28, design assessment C1): the production-auth stub's DELIVERY ledger, separate from its arrival
 * (processing) ledger. Held, refused, aborted, failed and out-of-order answers, through the stub's real route handler with a scripted
 * Playwright route.
 */
const API = "/api/experimental/v1";
const b64url = (buffer: Buffer) =>
  buffer
    .toString("base64")
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
const VERIFIER = "v".repeat(43);
const CHALLENGE = b64url(createHash("sha256").update(VERIFIER).digest());

interface Scripted {
  route: Route;
  calls: Array<[string, unknown]>;
}
function scripted(
  method: string,
  path: string,
  body: unknown,
  page: object,
  options: { failFulfil?: boolean } = {},
): Scripted {
  const calls: Array<[string, unknown]> = [];
  const route = {
    request: () => ({
      url: () => `http://127.0.0.1${API}${path}`,
      method: () => method,
      postDataJSON: () => body,
      headers: () => ({ "x-atlas-session": "1" }),
      frame: () => ({ url: () => "http://127.0.0.1/", page: () => page }),
    }),
    fulfill: async (answer: { status: number }) => {
      calls.push(["fulfill", answer.status]);
      if (options.failFulfil)
        throw new Error("Target page, context or browser has been closed");
    },
    abort: async (code: string) => {
      calls.push(["abort", code]);
    },
  } as unknown as Route;
  return { route, calls };
}

async function installed() {
  const stub = new AuthStub();
  const kieran = stub.addAccount("kieran", "pw");
  const sam = stub.addAccount("sam", "pw2");
  let handler: ((route: Route) => Promise<void>) | null = null;
  await stub.install({
    route: async (_pattern: string, h: (route: Route) => Promise<void>) => {
      handler = h;
    },
  } as unknown as BrowserContext);
  const send = (s: Scripted) => {
    if (!handler) throw new Error("not installed");
    return handler(s.route);
  };
  return { stub, kieran, sam, send };
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const exchange = (username: string, password: string) => ({
  username,
  password,
  device_id: "dev",
  attempt_challenge: CHALLENGE,
});

describe("revision 22, C1: the auth stub's delivery ledger", () => {
  it("a held answer is processed on arrival but is held, not delivered, until released; the page that sent it is named", async () => {
    const { stub, send } = await installed();
    const page = { name: "tab 1" };
    const hold = stub.hold((r) => r.path === "/browser-sessions", 1);
    const request = scripted(
      "POST",
      "/browser-sessions",
      exchange("kieran", "pw"),
      page,
    );
    const done = send(request);
    await tick();
    expect(stub.requests.map((r) => [r.path, r.status])).toEqual([
      ["/browser-sessions", 200],
    ]);
    expect(stub.deliveries.map((d) => [d.state, d.status, d.hold])).toEqual([
      ["held", null, hold],
    ]);
    expect(stub.deliveries[0]?.page).toBe(page);
    expect(request.calls).toEqual([]);
    expect(stub.undelivered()).toHaveLength(1);
    expect(stub.undelivered([hold]), "a named hold is parked").toEqual([]);
    hold.release();
    await done;
    expect(stub.deliveries.map((d) => [d.state, d.status])).toEqual([
      ["fulfilled", 200],
    ]);
    expect(stub.undelivered()).toEqual([]);
  });

  it("a refusal is delivered with its own status", async () => {
    const { stub, send } = await installed();
    await send(
      scripted("POST", "/browser-sessions", exchange("kieran", "WRONG"), {}),
    );
    expect(stub.deliveries.map((d) => [d.state, d.status])).toEqual([
      ["fulfilled", 401],
    ]);
  });

  it("an aborted answer is aborted, never delivered, although it was processed as a 200", async () => {
    const { stub, send } = await installed();
    stub.answerNext((r) => r.path === "/browser-sessions", "abort");
    const request = scripted(
      "POST",
      "/browser-sessions",
      exchange("kieran", "pw"),
      {},
    );
    await send(request);
    expect(stub.requests[0]?.status, "processed").toBe(200);
    expect(stub.deliveries.map((d) => [d.state, d.status])).toEqual([
      ["aborted", null],
    ]);
    expect(request.calls).toEqual([["abort", "connectionreset"]]);
  });

  it("a fulfil that fails is failed: the cookie it assigned is on record but it is not a delivered activation", async () => {
    const { stub, send } = await installed();
    await send(
      scripted("POST", "/browser-sessions", exchange("kieran", "pw"), {}),
    );
    const grant = [...stub.grants.keys()][0];
    await expect(
      send(
        scripted(
          "POST",
          "/browser-sessions/activate",
          { grant, verifier: VERIFIER },
          {},
          { failFulfil: true },
        ),
      ),
    ).rejects.toThrow("closed");
    const activation = stub.deliveries[1];
    expect(activation?.state).toBe("failed");
    expect(activation?.error).toContain("closed");
    expect(activation?.cookieChange).toBe(1);
    expect(stub.serverSessions(), "the server created the session").toBe(1);
    expect(stub.deliveredActivations()).toEqual([]);
  });

  it("out of order: delivered activations follow the order the cookie changed, not the order the requests arrived", async () => {
    const { stub, kieran, sam, send } = await installed();
    await send(
      scripted("POST", "/browser-sessions", exchange("kieran", "pw"), {}),
    );
    await send(
      scripted("POST", "/browser-sessions", exchange("sam", "pw2"), {}),
    );
    const [grantKieran, grantSam] = [...stub.grants.keys()];
    const hold = stub.hold((r) => r.path === "/browser-sessions/activate", 1);
    const first = send(
      scripted(
        "POST",
        "/browser-sessions/activate",
        { grant: grantKieran, verifier: VERIFIER },
        {},
      ),
    );
    await tick();
    expect(stub.serverSessions(), "processed while its answer is held").toBe(1);
    await send(
      scripted(
        "POST",
        "/browser-sessions/activate",
        { grant: grantSam, verifier: VERIFIER },
        {},
      ),
    );
    hold.release();
    await first;
    expect(
      stub.requests
        .filter((r) => r.path === "/browser-sessions/activate")
        .map((r) => (r.body as { grant: string }).grant),
      "arrival order",
    ).toEqual([grantKieran, grantSam]);
    expect(
      stub.deliveredActivations().map((d) => d.account),
      "delivery order",
    ).toEqual([sam.id, kieran.id]);
    expect(stub.cookie).toBe(stub.deliveredActivations().at(-1)?.cookie);
  });
});
