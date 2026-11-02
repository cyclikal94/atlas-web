// @vitest-environment node
import { request } from "node:http";
import { describe, expect, it } from "vitest";
import {
  classifyConsole,
  createScriptedOrigin,
  globRegExp,
  type OriginRoute,
} from "../e2e/native-transport";

/**
 * WEB-13b revision 18: the native transport lane's own parts that need no browser (tests/e2e/native-transport.ts): the URL globs its
 * scripted origin matches as Playwright does, the console classification against the front's record (with the guard's negatives), and
 * the scripted origin's dispatch of the fixture handlers over real HTTP.
 */
const stamp = () => ({ generation: 7, phase: "online" as const, nonce: null });

describe("globRegExp: the fixture handlers' globs as Playwright reads them", () => {
  const cases: Array<[string, string, boolean]> = [
    [
      "**/api/experimental/v1/**",
      "http://h:1/api/experimental/v1/sync?x=1",
      true,
    ],
    ["**/api/experimental/v1/**", "http://h:1/api/experimental/v2/sync", false],
    ["**/api/experimental/v1/me", "http://h:1/api/experimental/v1/me", true],
    ["**/api/experimental/v1/me", "http://h:1/api/experimental/v1/me?x", false],
    ["**/health", "http://h:1/health", true],
    ["**/health", "http://h:1/healthz", false],
    [
      "**/api/experimental/v1/calendar-sources?*",
      "http://h:1/api/experimental/v1/calendar-sources?limit=200",
      true,
    ],
    [
      "**/api/experimental/v1/calendar-sources",
      "http://h:1/api/experimental/v1/calendar-sources?limit=200",
      false,
    ],
    [
      "**/api/experimental/v1/calendar-sources/*/import",
      "http://h:1/api/experimental/v1/calendar-sources/abc/import",
      true,
    ],
    [
      "**/api/experimental/v1/calendar-sources/*/import",
      "http://h:1/api/experimental/v1/calendar-sources/a/b/import",
      false,
    ],
  ];
  it.each(cases)("%s on %s: %s", (glob, url, matches) => {
    expect(globRegExp(glob).test(url)).toBe(matches);
  });
  it("refuses what it does not implement", () => {
    expect(() => globRegExp("**/{a,b}")).toThrow(/unsupported/);
  });
});

describe("classifyConsole: a network failure is expected only for a request the front dropped, once per drop", () => {
  const dropped = (url: string) => ({
    seq: 1,
    generation: 1,
    phase: "loss" as const,
    nonce: "n",
    method: "GET",
    url,
    at: 0,
    outcome: "lost" as const,
  });
  const URL_A = "http://127.0.0.1:9/__transport/probe/a";
  const problem = (text: string, url = URL_A, type = "error") => ({
    page: 0,
    type,
    text,
    url,
  });
  it("positive: each engine's wording, matched by the message's location", () => {
    for (const text of [
      "Failed to load resource: net::ERR_EMPTY_RESPONSE",
      "Failed to load resource: The network connection was lost.",
      "NetworkError when attempting to fetch resource.",
    ])
      expect(
        classifyConsole([problem(text)], [dropped(URL_A)]).unexpected,
      ).toEqual([]);
  });
  it("a URL in the text counts when the location is empty", () => {
    const v = classifyConsole(
      [problem(`GET ${URL_A} net::ERR_EMPTY_RESPONSE`, "")],
      [dropped(URL_A)],
    );
    expect(v.expected).toHaveLength(1);
  });
  it("negative: more messages than drops of that URL", () => {
    const v = classifyConsole(
      [
        problem("Failed to load resource: x"),
        problem("Failed to load resource: x"),
      ],
      [dropped(URL_A)],
    );
    expect(v.unexpected).toHaveLength(1);
  });
  it("negative: a network failure for a URL the front never dropped (a forwarded request)", () => {
    const v = classifyConsole(
      [problem("Failed to load resource: x", "http://127.0.0.1:9/other")],
      [
        dropped(URL_A),
        { ...dropped("http://127.0.0.1:9/other"), outcome: "forwarded" },
      ],
    );
    expect(v.unexpected).toHaveLength(1);
  });
  it("negative: an application error or warning during the loss, and a page error naming a dropped URL", () => {
    const v = classifyConsole(
      [
        problem("something broke"),
        problem("deprecated", URL_A, "warning"),
        problem(`Failed to load resource ${URL_A}`, "", "pageerror"),
      ],
      [dropped(URL_A), dropped(URL_A), dropped(URL_A)],
    );
    expect(v.unexpected).toHaveLength(3);
  });
  it("an HTTP status is expected only when the case provokes it", () => {
    const text =
      "Failed to load resource: the server responded with a status of 502 (Bad Gateway)";
    expect(
      classifyConsole([problem(text)], [], new Set([502])).unexpected,
    ).toEqual([]);
    expect(classifyConsole([problem(text)], []).unexpected).toHaveLength(1);
    expect(
      classifyConsole([problem(text)], [], new Set([422])).unexpected,
    ).toHaveLength(1);
  });
});

/** One request to the scripted origin as the front forwards it (the browser's Host kept). */
function send(
  origin: string,
  path: string,
  options: { method?: string; body?: string } = {},
): Promise<{ status?: number; body?: string; type?: string; error?: string }> {
  const at = new URL(origin);
  return new Promise((resolve) => {
    const req = request(
      {
        host: at.hostname,
        port: at.port,
        method: options.method ?? "GET",
        path,
        headers: { host: "127.0.0.1:4321", "idempotency-key": "k-1" },
        agent: false,
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c) => {
          body += c;
        });
        res.on("end", () =>
          resolve({
            status: res.statusCode,
            body,
            type: res.headers["content-type"],
          }),
        );
      },
    );
    req.on("error", (error) =>
      resolve({ error: (error as NodeJS.ErrnoException).code }),
    );
    req.end(options.body);
  });
}

describe("createScriptedOrigin: the fixture handlers answer arriving requests over real HTTP", () => {
  it("newest handler first; fallback passes on; the Request surface is the browser's; receipts keep no body text", async () => {
    const fallback = createScriptedOrigin({
      stamp,
      fallback: "http://127.0.0.1:9",
    });
    const fallbackUrl = await fallback.start();
    await fallback.route("**/*", (route: OriginRoute) =>
      route.fulfill({ status: 299, body: "from-fallback-target" }),
    );
    const origin = createScriptedOrigin({ stamp, fallback: fallbackUrl });
    const url = await origin.start();
    const seen: unknown[] = [];
    try {
      await origin.route("**/api/**", (route: OriginRoute) =>
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: '{"old":1}',
        }),
      );
      await origin.route("**/api/x", (route: OriginRoute) => {
        const r = route.request();
        seen.push({
          url: r.url(),
          method: r.method(),
          key: r.headers()["idempotency-key"],
          body: r.postData(),
        });
        return route.fallback();
      });
      await origin.route("**/api/abort", (route: OriginRoute) =>
        route.abort("connectionreset"),
      );
      await origin.route("**/api/bad", (route: OriginRoute) =>
        route.fulfill({ status: 200, json: {} } as never),
      );
      expect(
        await send(url, "/api/x", { method: "POST", body: "SECRET-ICS" }),
      ).toMatchObject({
        status: 200,
        body: '{"old":1}',
        type: "application/json",
      });
      expect(seen).toEqual([
        {
          url: "http://127.0.0.1:4321/api/x",
          method: "POST",
          key: "k-1",
          body: "SECRET-ICS",
        },
      ]);
      expect((await send(url, "/api/abort")).error).toBeDefined();
      expect((await send(url, "/api/bad")).status).toBe(500);
      expect(await send(url, "/assets/a.js")).toMatchObject({
        status: 299,
        body: "from-fallback-target",
      });
      expect(
        origin.receipts.map((r) => [r.method, r.url, r.outcome, r.generation]),
      ).toEqual([
        ["POST", "http://127.0.0.1:4321/api/x", "fulfilled", 7],
        ["GET", "http://127.0.0.1:4321/api/abort", "aborted", 7],
        ["GET", "http://127.0.0.1:4321/api/bad", "handler_error", 7],
        ["GET", "http://127.0.0.1:4321/assets/a.js", "unrouted", 7],
      ]);
      expect(origin.receipts[0]?.bodyBytes).toBe(10);
      expect(JSON.stringify(origin.receipts)).not.toContain("SECRET-ICS");
      expect(origin.errors).toEqual([
        expect.stringContaining("unsupported fulfil json"),
      ]);
    } finally {
      await origin.close();
      await fallback.close();
    }
  });
});
