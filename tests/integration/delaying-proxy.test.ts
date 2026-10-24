// @vitest-environment node
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, test } from "vitest";
// @ts-expect-error: a plain ES module of the integration runner, without types.
import { createProxy } from "../../scripts/integration/delaying-proxy.mjs";

/**
 * WEB-08c revision 2: qualification of the delaying proxy's `refuse` action (R5's production A→B→A queue case, I-L12). A refused request
 * is NOT forwarded: the backend never sees it, the client receives the rule's status and body, and nothing of the backend's headers. A
 * request that matches no rule is forwarded as before (control).
 *
 * WEB-08c revision 14 (family `proxy-injected-answer-cacheable`): every answer the proxy makes itself keeps the backend API's
 * `cache-control: private, no-store` (and still no `Set-Cookie`), so a browser can never answer a later identical request from its HTTP
 * cache: an injected 410 without it was reused for every later `GET /sync?cursor=…` of the same token (review 14's I-N5 loop).
 */
const servers: Array<{ close(): unknown }> = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
});

async function upstream() {
  const seen: string[] = [];
  const server: Server = createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`);
    req.resume();
    res.writeHead(200, {
      "content-type": "application/json",
      "set-cookie": "atlas_session=upstream",
      "cache-control": "private, no-store",
      "x-upstream": "1",
    });
    res.end('{"ok":true}');
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push({ close: () => new Promise((r) => server.close(r)) });
  return {
    seen,
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
  };
}

async function started() {
  const up = await upstream();
  const proxy = createProxy({ upstream: up.url });
  const urls = (await proxy.start()) as {
    proxyUrl: string;
    controlUrl: string;
  };
  servers.push({ close: () => proxy.stop() });
  const control = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`${urls.controlUrl}${path}`, {
      method,
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return res.json();
  };
  return { up, base: urls.proxyUrl, control };
}

describe("delaying proxy: refuse (WEB-08c revision 2)", () => {
  test("control: an unmatched request is forwarded and its answer delivered", async () => {
    const { up, base } = await started();
    const res = await fetch(`${base}/api/x`, { method: "POST", body: "{}" });
    expect(res.status).toBe(200);
    expect(up.seen).toEqual(["POST /api/x"]);
  });

  test("a refused request never reaches the backend; the client gets the rule's status and body, and no backend header", async () => {
    const { up, base, control } = await started();
    await control("POST", "/rules", {
      method: "POST",
      path: "/api/commands",
      action: "refuse",
      status: 503,
      json: { code: "unavailable" },
    });
    const res = await fetch(`${base}/api/commands`, {
      method: "POST",
      body: '{"commands":[]}',
    });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ code: "unavailable" });
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(up.seen).toEqual([]);
    const log = (await control("GET", "/log")) as Array<{
      path: string;
      events: Array<{ event: string }>;
    }>;
    expect(log.at(-1)?.events.map((e) => e.event)).toContain("refused");
  });
});

describe("delaying proxy: an answer it makes itself is never cacheable (WEB-08c revision 14)", () => {
  test.each([
    ["rewrite_status", { status: 410 }, 410, {}],
    [
      "replace_response",
      { status: 409, json: { code: "x" } },
      409,
      { code: "x" },
    ],
  ] as const)(
    "%s: forwarded, then answered with the rule's status, `no-store`, no Set-Cookie and no other backend header",
    async (action, extra, status, body) => {
      const { up, base, control } = await started();
      await control("POST", "/rules", {
        method: "GET",
        path: "/api/sync",
        ordinal: 1,
        action,
        ...extra,
      });
      const res = await fetch(`${base}/api/sync?cursor=d1.x`);
      expect(res.status).toBe(status);
      expect(await res.json()).toEqual(body);
      expect(res.headers.get("cache-control")).toBe("private, no-store");
      expect(res.headers.get("set-cookie")).toBeNull();
      expect(res.headers.get("x-upstream")).toBeNull();
      // Forwarded (the backend committed), and the next identical request is the backend's own answer again.
      expect(up.seen).toEqual(["GET /api/sync?cursor=d1.x"]);
      const again = await fetch(`${base}/api/sync?cursor=d1.x`);
      expect(again.status).toBe(200);
      expect(again.headers.get("cache-control")).toBe("private, no-store");
    },
  );

  test("control: a forwarded answer keeps the backend's own headers", async () => {
    const { base } = await started();
    const res = await fetch(`${base}/api/x`);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(res.headers.get("x-upstream")).toBe("1");
  });
});
