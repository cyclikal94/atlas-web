// @vitest-environment node
import {
  createServer,
  type IncomingMessage,
  request,
  type ServerResponse,
} from "node:http";
import { connect, type Socket } from "node:net";
import type { Browser, TestInfo } from "@playwright/test";
import { describe, expect, it } from "vitest";
import type { TransportAttempt } from "../../scripts/integration/http-transport-loss.mjs";
import {
  type AttemptRecord,
  type CleanupStep,
  categorise,
  classifyJournal,
  createScriptedOrigin,
  globRegExp,
  type Interpose,
  type Journal,
  LaneCancelled,
  type OpenStage,
  type OriginRoute,
  openTransportLanes,
  type RequestRecord,
  runCleanup,
  runTransportLaneFixture,
  settleLanes,
  transportLaneFixture,
} from "../e2e/native-transport";

/**
 * WEB-13b revision 18/19: the native transport lane's own parts that need no browser (tests/e2e/native-transport.ts): the URL globs its
 * scripted origin matches as Playwright does, the classification of a lane's journal (revision 19, Review 23 F23-1: design assessment
 * schedules D01–D06), the scripted origin's dispatch of the fixture handlers over real HTTP, and its ownership of what it dispatches and
 * forwards (F23-2: D07–D10). Every negative names the rule it breaks; the harness mutants (revision-19/harness-mutants.py) select these
 * names.
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

// ---- The journal and its classification ------------------------------------------------------------------------------------------

const FRONT = "http://127.0.0.1:9";
const U = `${FRONT}/api/experimental/v1/calendar-sources/s/import`;
const V = `${FRONT}/__transport/probe/v`;
const CHROMIUM = "Failed to load resource: net::ERR_EMPTY_RESPONSE";
const WEBKIT = "Failed to load resource: The network connection was lost.";
const firefoxFont = (url: string, status = 2152398868) =>
  `[JavaScript Error: "downloadable font: download failed (font-family: "Geist Mono Variable" style:normal weight:100..900 width:100 src index:0): status=${status} source: ${url}"]`;
const httpText = (status: number) =>
  `Failed to load resource: the server responded with a status of ${status} (X)`;

/** Builds a journal in the order its calls are made (each call takes the next lane-wide sequence), as openLane records one. */
function journal() {
  let seq = 0;
  const next = () => {
    seq += 1;
    return seq;
  };
  const j: Journal = {
    problems: [],
    requests: [],
    attempts: [],
    expectations: [],
  };
  let front = 0;
  const b = {
    j,
    request(page: number, document: number, url: string, method = "GET") {
      const r: RequestRecord = {
        seq: next(),
        page,
        document,
        method,
        url,
        navigation: false,
        observed: { generation: 0, phase: "online", nonce: null },
        terminal: null,
      };
      j.requests.push(r);
      return r;
    },
    attempt(
      url: string,
      outcome: TransportAttempt["outcome"],
      generation: number,
      options: { method?: string; status?: number } = {},
    ): AttemptRecord {
      front += 1;
      const a: AttemptRecord = {
        seq: next(),
        attempt: {
          seq: front,
          generation,
          phase: generation % 2 === 1 ? "loss" : "online",
          nonce: null,
          method: options.method ?? "GET",
          url,
          at: 0,
          outcome,
          ...(options.status !== undefined ? { status: options.status } : {}),
        },
      };
      j.attempts.push(a);
      return a;
    },
    fail(r: RequestRecord, errorText = "net::ERR_EMPTY_RESPONSE") {
      r.terminal = { seq: next(), kind: "failed", errorText };
    },
    respond(r: RequestRecord, status: number) {
      r.terminal = { seq: next(), kind: "response", status };
    },
    problem(
      page: number,
      document: number,
      type: string,
      text: string,
      location = "",
    ) {
      const c = categorise(type, text, location);
      j.problems.push({
        seq: next(),
        page,
        document,
        type,
        text,
        url: c.url,
        category: c.category,
        ...(c.status !== undefined ? { status: c.status } : {}),
        observed: { generation: 0, phase: "online", nonce: null },
      });
    },
    expectHttp(path: string, status: number, count = 1, method = "POST") {
      j.expectations.push({
        id: j.expectations.length + 1,
        seq: next(),
        method,
        path,
        status,
        count,
        reason: "test",
      });
    },
    /** A request of `page`/`document` dropped by the front in loss `generation` (`attempts` times: Firefox 10, WebKit 4) and failed. */
    lost(
      page: number,
      document: number,
      url: string,
      generation = 1,
      attempts = 1,
    ) {
      const r = b.request(page, document, url);
      for (let i = 0; i < attempts; i += 1) b.attempt(url, "lost", generation);
      b.fail(r);
      return r;
    },
    /** A request forwarded online (`generation` even) and failed afterwards (the target reset it): not a transport loss. */
    resetOnline(page: number, document: number, url: string, generation = 0) {
      const r = b.request(page, document, url);
      b.attempt(url, "forwarded", generation);
      b.fail(r, "net::ERR_EMPTY_RESPONSE");
      return r;
    },
    answered(
      page: number,
      document: number,
      url: string,
      status: number,
      generation = 0,
      method = "GET",
    ) {
      const r = b.request(page, document, url, method);
      b.attempt(url, "forwarded", generation, { method, status });
      b.respond(r, status);
      return r;
    },
  };
  return b;
}
const verdicts = (j: Journal) =>
  classifyJournal(j).problems.map((p) => [p.text.slice(0, 40), p.verdict]);

describe("classifyJournal D01: each problem judged once, repeatably, from the journal alone", () => {
  it("positive: each engine's network-failure message for its own page's request the front dropped in a loss", () => {
    const b = journal();
    b.lost(0, 1, U);
    b.problem(0, 1, "error", CHROMIUM, U);
    b.lost(0, 1, V, 1, 4);
    b.problem(0, 1, "error", WEBKIT, V);
    const font = `${FRONT}/assets/geist.woff2`;
    b.lost(0, 1, font, 1, 10);
    b.problem(0, 1, "error", firefoxFont(font));
    const v = classifyJournal(b.j);
    expect(v.unexpected).toEqual([]);
    expect(v.expected.map((p) => p.evidence?.attempts.length)).toEqual([
      1, 4, 10,
    ]);
    expect(v.expected.every((p) => p.evidence?.generations[0] === 1)).toBe(
      true,
    );
  });
  it("conservation and repeatability: every problem exactly once with a reason; the same journal gives the same verdict", () => {
    const b = journal();
    b.lost(0, 1, U);
    b.problem(0, 1, "error", CHROMIUM, U);
    b.problem(0, 1, "error", "something broke");
    b.problem(0, 1, "pageerror", "boom");
    const first = classifyJournal(b.j);
    expect(first.problems.map((p) => p.seq)).toEqual(
      b.j.problems.map((p) => p.seq),
    );
    expect(first.expected.length + first.unexpected.length).toBe(3);
    expect(first.problems.every((p) => p.reason.length > 0)).toBe(true);
    expect(classifyJournal(b.j)).toEqual(first);
  });
});

describe("classifyJournal D02: the same URL across phases", () => {
  it("negative: an online 500 before a loss of the same URL stays unexpected; the loss's own message is the expected one", () => {
    const b = journal();
    b.answered(0, 1, U, 500, 0, "GET");
    b.problem(0, 1, "error", httpText(500), U);
    b.lost(0, 1, U);
    b.problem(0, 1, "error", CHROMIUM, U);
    expect(verdicts(b.j)).toEqual([
      [httpText(500).slice(0, 40), "unexpected"],
      [CHROMIUM.slice(0, 40), "expected"],
    ]);
  });
  it("negative: a 500 after the loss is restored stays unexpected", () => {
    const b = journal();
    b.lost(0, 1, U);
    b.problem(0, 1, "error", CHROMIUM, U);
    b.answered(0, 1, U, 500, 2, "GET");
    b.problem(0, 1, "error", httpText(500), U);
    expect(classifyJournal(b.j).unexpected.map((p) => p.category)).toEqual([
      "http",
    ]);
  });
  it("negative: a network failure before any loss (forwarded, then reset) stays unexpected, however many later drops of that URL", () => {
    const b = journal();
    b.resetOnline(0, 1, U);
    b.problem(0, 1, "error", CHROMIUM, U);
    b.lost(0, 1, U);
    b.problem(0, 1, "error", CHROMIUM, U);
    b.lost(0, 1, U, 3);
    b.lost(0, 1, V, 3);
    const v = classifyJournal(b.j);
    expect(v.problems.map((p) => p.verdict)).toEqual([
      "unexpected",
      "expected",
    ]);
    expect(v.unexpected[0]?.reason).toMatch(/not a transport loss/);
  });
  it("two loss generations: each message is its own request's, with that request's generation", () => {
    const b = journal();
    b.lost(0, 1, U, 1);
    b.problem(0, 1, "error", CHROMIUM, U);
    b.lost(0, 1, U, 3);
    b.problem(0, 1, "error", CHROMIUM, U);
    const v = classifyJournal(b.j);
    expect(v.unexpected).toEqual([]);
    expect(v.expected.map((p) => p.evidence?.generations)).toEqual([[1], [3]]);
  });
  it("negative: an HTTP message never consumes an earlier loss of the same URL that logged nothing (Firefox's fetch)", () => {
    const b = journal();
    b.lost(0, 1, U);
    b.answered(0, 1, U, 500, 2, "GET");
    b.problem(0, 1, "error", httpText(500), U);
    const v = classifyJournal(b.j);
    expect(v.unexpected.map((p) => [p.category, p.reason])).toEqual([
      ["http", "HTTP 500 of #4 GET was not declared"],
    ]);
  });
});

describe("classifyJournal D03: pages, overlaps and methods", () => {
  it("negative: page B's failure of a URL page A lost cannot borrow A's drop", () => {
    const b = journal();
    b.lost(0, 1, U);
    b.resetOnline(1, 1, U, 2);
    b.problem(1, 1, "error", CHROMIUM, U);
    b.problem(0, 1, "error", CHROMIUM, U);
    expect(
      classifyJournal(b.j).problems.map((p) => [p.page, p.verdict]),
    ).toEqual([
      [1, "unexpected"],
      [0, "expected"],
    ]);
  });
  it("negative: a page's message with no request of its own", () => {
    const b = journal();
    b.lost(0, 1, U);
    b.problem(1, 1, "error", CHROMIUM, U);
    expect(classifyJournal(b.j).unexpected).toHaveLength(1);
  });
  it("negative: two requests of the same method and URL open at once are ambiguous, so both messages are unexpected", () => {
    const b = journal();
    const a = b.request(0, 1, U);
    const c = b.request(1, 1, U);
    b.attempt(U, "lost", 1);
    b.attempt(U, "lost", 1);
    b.fail(a);
    b.fail(c);
    b.problem(0, 1, "error", CHROMIUM, U);
    b.problem(1, 1, "error", CHROMIUM, U);
    const v = classifyJournal(b.j);
    expect(v.unexpected).toHaveLength(2);
    expect(v.requests.every((r) => r.ambiguous)).toBe(true);
  });
  it("negative: a GET lost and a POST of the same URL failing for another reason: the POST's message is not excused", () => {
    const b = journal();
    b.lost(0, 1, U);
    b.problem(0, 1, "error", CHROMIUM, U);
    const post = b.request(0, 1, U, "POST");
    b.attempt(U, "forwarded", 2, { method: "POST" });
    b.fail(post);
    b.problem(0, 1, "error", CHROMIUM, U);
    expect(classifyJournal(b.j).problems.map((p) => p.verdict)).toEqual([
      "expected",
      "unexpected",
    ]);
  });
});

describe("classifyJournal D04: documents", () => {
  it("negative: a message observed in the next document cannot use the previous document's drop", () => {
    const b = journal();
    b.lost(0, 1, U);
    b.problem(0, 2, "error", CHROMIUM, U);
    expect(classifyJournal(b.j).unexpected[0]?.reason).toMatch(
      /no failed request of this page's document/,
    );
  });
  it("negative: the new document's own reset at the same URL, beside the old document's unexcused drop", () => {
    const b = journal();
    b.lost(0, 1, U);
    b.resetOnline(0, 2, U, 2);
    b.problem(0, 2, "error", CHROMIUM, U);
    expect(classifyJournal(b.j).unexpected).toHaveLength(1);
  });
});

describe("classifyJournal D05: exceptions, warnings, counts and declared HTTP statuses", () => {
  it("negative: a page error naming an allowed status, or a dropped URL in network wording, always fails", () => {
    const b = journal();
    b.expectHttp(new URL(U).pathname, 502);
    b.answered(0, 1, U, 502, 0, "POST");
    b.problem(
      0,
      1,
      "pageerror",
      "Unhandled application error with a status of 502",
    );
    b.lost(0, 1, V);
    b.problem(
      0,
      1,
      "pageerror",
      `Failed to load resource: net::ERR_EMPTY_RESPONSE ${V}`,
    );
    // The engine's exact network wording, located at a lost request of the page: still a page error.
    b.lost(0, 1, U);
    b.problem(0, 1, "pageerror", CHROMIUM, U);
    const v = classifyJournal(b.j);
    expect(v.unexpected.map((p) => p.reason)).toEqual([
      "a page error always fails, whatever it names",
      "a page error always fails, whatever it names",
      "a page error always fails, whatever it names",
    ]);
  });
  it("negative: a warning in an engine's network wording for a lost request still fails", () => {
    const b = journal();
    b.lost(0, 1, U);
    b.problem(0, 1, "warning", CHROMIUM, U);
    expect(classifyJournal(b.j).unexpected[0]?.reason).toBe(
      "a warning always fails",
    );
  });
  it("negative: a second message for one lost request is beyond its count", () => {
    const b = journal();
    b.lost(0, 1, U, 1, 10);
    b.problem(0, 1, "error", CHROMIUM, U);
    b.problem(0, 1, "error", CHROMIUM, U);
    expect(classifyJournal(b.j).problems.map((p) => p.verdict)).toEqual([
      "expected",
      "unexpected",
    ]);
  });
  it("negative: two messages on either side of one request's failure event are still one request's count", () => {
    const b = journal();
    const r = b.request(0, 1, U);
    b.attempt(U, "lost", 1);
    b.problem(0, 1, "error", CHROMIUM, U);
    b.fail(r);
    b.problem(0, 1, "error", CHROMIUM, U);
    expect(classifyJournal(b.j).problems.map((p) => p.verdict)).toEqual([
      "expected",
      "unexpected",
    ]);
  });
  it("negative: an application's own error text, and a Firefox font failure for an HTTP reason", () => {
    const b = journal();
    b.lost(0, 1, U);
    b.problem(0, 1, "error", "something broke", U);
    const font = `${FRONT}/assets/geist.woff2`;
    b.lost(0, 1, font);
    b.problem(0, 1, "error", firefoxFont(font, 2147746065));
    expect(classifyJournal(b.j).unexpected.map((p) => p.category)).toEqual([
      "other",
      "other",
    ]);
  });
  it("an HTTP status is expected only for the one declared request, corroborated by the front; an undeclared one never borrows a loss", () => {
    const path = new URL(U).pathname;
    const b = journal();
    b.answered(0, 1, U, 502, 0, "POST");
    b.problem(0, 1, "error", httpText(502), U);
    b.expectHttp(path, 502);
    b.answered(0, 1, U, 502, 0, "POST");
    b.problem(0, 1, "error", httpText(502), U);
    b.lost(0, 1, V);
    b.answered(0, 1, V, 503, 2);
    b.problem(0, 1, "error", httpText(503), V);
    const v = classifyJournal(b.j);
    expect(v.problems.map((p) => [p.status, p.verdict])).toEqual([
      [502, "unexpected"],
      [502, "expected"],
      [503, "unexpected"],
    ]);
    expect(v.expected[0]?.evidence?.expectation).toBe(1);
    expect(v.violations).toEqual([]);
  });
  it("negative: a declaration unmet, exceeded, or met only by a response the front did not see answered so", () => {
    const path = new URL(U).pathname;
    const unmet = journal();
    unmet.expectHttp(path, 422);
    unmet.answered(0, 1, `${FRONT}/other`, 422, 0, "POST");
    unmet.problem(0, 1, "error", httpText(422), `${FRONT}/other`);
    const u = classifyJournal(unmet.j);
    expect(u.violations).toEqual([
      expect.stringMatching(/0 of the declared 1/),
    ]);
    expect(u.unexpected).toHaveLength(1);
    const excess = journal();
    excess.expectHttp(path, 422);
    excess.answered(0, 1, U, 422, 0, "POST");
    excess.answered(0, 1, U, 422, 0, "POST");
    expect(classifyJournal(excess.j).violations).toEqual([
      expect.stringMatching(/1 response\(s\) beyond the declared 1/),
    ]);
    const unseen = journal();
    unseen.expectHttp(path, 422);
    const r = unseen.request(0, 1, U, "POST");
    unseen.attempt(U, "forwarded", 0, { method: "POST", status: 200 });
    unseen.respond(r, 422);
    unseen.problem(0, 1, "error", httpText(422), U);
    const n = classifyJournal(unseen.j);
    expect(n.violations).toContainEqual(
      expect.stringMatching(/cannot attribute/),
    );
    expect(n.unexpected).toHaveLength(1);
  });
});

describe("classifyJournal D06: delivery order", () => {
  it("a message delivered after the loss ended is still its own request's (the request's own generation, not the current phase)", () => {
    const b = journal();
    b.lost(0, 1, U, 1);
    b.answered(0, 1, V, 200, 2);
    b.problem(0, 1, "error", CHROMIUM, U);
    expect(classifyJournal(b.j).expected[0]?.evidence?.generations).toEqual([
      1,
    ]);
  });
  it("negative: a delayed message after another request of that URL failed for another reason is ambiguous", () => {
    const b = journal();
    b.lost(0, 1, U, 1);
    b.resetOnline(0, 1, U, 2);
    b.problem(0, 1, "error", CHROMIUM, U);
    expect(classifyJournal(b.j).unexpected).toHaveLength(1);
  });
  it("a message observed before its request's failure event (engine event order) is still attributed", () => {
    const b = journal();
    const r = b.request(0, 1, U);
    b.attempt(U, "lost", 1);
    b.problem(0, 1, "error", CHROMIUM, U);
    b.fail(r);
    expect(classifyJournal(b.j).unexpected).toEqual([]);
  });
});

// ---- The scripted origin over real HTTP ---------------------------------------------------------------------------------------------

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
        res.on("error", (error) =>
          resolve({ error: (error as NodeJS.ErrnoException).code }),
        );
      },
    );
    req.on("error", (error) =>
      resolve({ error: (error as NodeJS.ErrnoException).code }),
    );
    req.end(options.body);
  });
}

/**
 * The origins below join within this bound (a harness bound, shorter than the test's own timeout): a cancellation that never takes effect
 * fails close() by name rather than timing the test out.
 */
const CLOSE_BOUND = 1_000;
/** Resolves "done" when `promise` settles within `ms`, else "still pending": a named observation bound, never a product deadline. */
const within = (promise: Promise<unknown>, ms = 2_000) =>
  Promise.race([
    promise.then(() => "done" as const),
    new Promise<"still pending">((resolve) =>
      setTimeout(() => resolve("still pending"), ms).unref(),
    ),
  ]);
const closed = (socket: Socket) =>
  socket.closed
    ? Promise.resolve()
    : new Promise<void>((resolve) => socket.once("close", () => resolve()));

/**
 * A fallback target: `/healthy` answers 200; `/hold` arrives and is held before headers; `/headers` sends headers and part of a body,
 * then holds. Every target-side socket and held response is recorded; `arrived(path)` resolves at arrival.
 */
async function target() {
  const sockets = new Set<Socket>();
  const held: Array<{ path: string; res: ServerResponse }> = [];
  const waiting = new Map<string, () => void>();
  const arrivals = new Map<string, Promise<void>>();
  const arrived = (path: string) => {
    let p = arrivals.get(path);
    if (p === undefined) {
      p = new Promise<void>((resolve) => waiting.set(path, resolve));
      arrivals.set(path, p);
    }
    return p;
  };
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const path = req.url ?? "";
    void arrived(path);
    waiting.get(path)?.();
    if (path === "/healthy") return void res.writeHead(200).end("healthy");
    held.push({ path, res });
    if (path === "/headers") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.write("partial");
    }
  });
  server.on("connection", (s: Socket) => {
    sockets.add(s);
    s.once("close", () => sockets.delete(s));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  return {
    url: `http://127.0.0.1:${address.port}`,
    port: address.port,
    sockets,
    held,
    /** The target-side socket of the latest held request to `path`. */
    socketOf: (path: string) =>
      held.filter((h) => h.path === path).at(-1)?.res.socket as Socket,
    arrived,
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      }),
  };
}

/** A raw client socket to `url` that sends `head` (and optionally part of a body) and is destroyed by the caller. */
function rawClient(url: string, head: string) {
  const at = new URL(url);
  const socket = connect({ host: at.hostname, port: Number(at.port) });
  const received: Buffer[] = [];
  socket.on("data", (c: Buffer) => received.push(c));
  socket.on("error", () => undefined);
  const connected = new Promise<void>((resolve) =>
    socket.once("connect", () => resolve()),
  );
  void connected.then(() => socket.write(head));
  return { socket, connected, received };
}

const until = async (condition: () => boolean, label: string, ms = 2_000) => {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) return `${label}: still not after ${ms} ms`;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return "done";
};

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
      expect(origin.receipts[3]?.forward).toBe("completed");
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

describe("createScriptedOrigin D07–D08: owned forwards end with their downstream and with the origin", () => {
  it("D07: a healthy forward completes; a held forward's upstream is destroyed and joined by close, and the target sees its socket close", async () => {
    const t = await target();
    const unrelated = rawClient(
      t.url,
      "GET /unrelated HTTP/1.1\r\nhost: x\r\n\r\n",
    );
    const origin = createScriptedOrigin({
      stamp,
      fallback: t.url,
      closeBoundMs: CLOSE_BOUND,
    });
    const url = await origin.start();
    try {
      await unrelated.connected;
      expect(await send(url, "/healthy")).toMatchObject({
        status: 200,
        body: "healthy",
      });
      expect(origin.receipts[0]?.forward).toBe("completed");
      const outcome = send(url, "/hold");
      await t.arrived("/hold");
      const heldSocket = t.socketOf("/hold");
      expect(origin.owned().upstreams).toBe(1);
      await origin.close();
      expect(
        origin.owned(),
        "nothing the origin owned is open once close() resolves",
      ).toMatchObject({
        upstreams: 0,
        connections: 0,
        dispatches: [],
        listening: false,
      });
      expect(
        await within(closed(heldSocket)),
        "the target's held socket closes",
      ).toBe("done");
      expect((await outcome).error).toBeDefined();
      expect(origin.receipts[1]).toMatchObject({
        outcome: "unrouted",
        forward: "abandoned",
      });
      expect(
        unrelated.socket.closed,
        "an unrelated target connection is not the origin's",
      ).toBe(false);
    } finally {
      unrelated.socket.destroy();
      await origin.close();
      await t.close();
    }
  });
  it("D08: the downstream closing before the upload ends dispatches nothing; after forwarding, or after the target's headers, it ends the forward", async () => {
    const t = await target();
    const origin = createScriptedOrigin({
      stamp,
      fallback: t.url,
      closeBoundMs: CLOSE_BOUND,
    });
    const url = await origin.start();
    try {
      const upload = rawClient(
        url,
        "POST /upload HTTP/1.1\r\nhost: x\r\ncontent-length: 100\r\n\r\n0123456789",
      );
      await upload.connected;
      expect(
        await until(() => origin.owned().connections === 1, "upload connected"),
      ).toBe("done");
      upload.socket.destroy();
      expect(
        await until(
          () => origin.owned().connections === 0,
          "upload connection closed",
        ),
      ).toBe("done");
      expect(
        origin.receipts,
        "an unfinished upload is never dispatched",
      ).toEqual([]);

      const before = rawClient(url, "GET /hold HTTP/1.1\r\nhost: x\r\n\r\n");
      await t.arrived("/hold");
      const beforeSocket = t.socketOf("/hold");
      before.socket.destroy();
      expect(
        await within(closed(beforeSocket)),
        "the downstream's close ends the forward before headers",
      ).toBe("done");
      expect(
        await until(() => origin.owned().upstreams === 0, "upstream released"),
      ).toBe("done");
      expect(origin.receipts.at(-1)).toMatchObject({
        downstreamClosed: true,
        forward: "abandoned",
      });

      const after = rawClient(url, "GET /headers HTTP/1.1\r\nhost: x\r\n\r\n");
      await t.arrived("/headers");
      const afterSocket = t.socketOf("/headers");
      expect(
        await until(
          () => Buffer.concat(after.received).toString().includes("partial"),
          "partial body received",
        ),
      ).toBe("done");
      after.socket.destroy();
      expect(
        await within(closed(afterSocket)),
        "the downstream's close ends a forward whose body is held",
      ).toBe("done");
      expect(
        await until(
          () => origin.owned().dispatches.length === 0,
          "dispatch ended",
        ),
      ).toBe("done");
      expect(origin.receipts.at(-1)).toMatchObject({
        downstreamClosed: true,
        forward: "abandoned",
      });
      expect(origin.errors).toEqual([]);
    } finally {
      await origin.close();
      await t.close();
    }
  });
});

describe("createScriptedOrigin D09: held handlers", () => {
  it("a hold that honours route.signal is released by close; nothing is answered after it", async () => {
    const origin = createScriptedOrigin({
      stamp,
      fallback: "http://127.0.0.1:9",
      closeBoundMs: CLOSE_BOUND,
    });
    const url = await origin.start();
    let release: () => void = () => undefined;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered: () => void = () => undefined;
    const arrived = new Promise<void>((resolve) => {
      entered = resolve;
    });
    await origin.route("**/held", async (route: OriginRoute) => {
      entered();
      const answer = await Promise.race([
        hold.then(() => "released" as const),
        new Promise<"cancelled">((resolve) =>
          route.signal.addEventListener("abort", () => resolve("cancelled")),
        ),
      ]);
      if (answer === "cancelled") return;
      await route.fulfill({ body: "late" });
    });
    const outcome = send(url, "/held");
    await arrived;
    await origin.close();
    expect(origin.receipts[0]).toMatchObject({ outcome: "cancelled" });
    release();
    expect((await outcome).error).toBeDefined();
    expect(origin.errors).toEqual([]);
  });
  it("the calendar stub's held answer (calendar-13b-helpers `wait`) honours the signal", async () => {
    const { stubCalendars } = await import("../e2e/calendar-13b-helpers");
    const origin = createScriptedOrigin({
      stamp,
      fallback: "http://127.0.0.1:9",
      closeBoundMs: CLOSE_BOUND,
    });
    const url = await origin.start();
    const routes = {
      route: (glob: string, handler: never) => origin.route(glob, handler),
    };
    const cal = await stubCalendars(routes as never);
    let release: (v: { status: number; body: unknown }) => void = () =>
      undefined;
    cal.answers.set("/calendar-commands", [
      {
        wait: new Promise((resolve) => {
          release = resolve;
        }),
      },
    ]);
    const outcome = send(url, "/api/experimental/v1/calendar-commands", {
      method: "POST",
      body: "{}",
    });
    expect(await until(() => cal.wire.length === 1, "the create arrived")).toBe(
      "done",
    );
    await origin.close();
    release({ status: 200, body: { revision: 1 } });
    expect((await outcome).error).toBeDefined();
    expect(origin.receipts[0]).toMatchObject({ outcome: "cancelled" });
    expect(origin.errors).toEqual([]);
  });
  it("negative: a hold that ignores cancellation fails close by name, and its later answer is recorded as late and never written", async () => {
    const origin = createScriptedOrigin({
      stamp,
      fallback: "http://127.0.0.1:9",
      closeBoundMs: 200,
    });
    const url = await origin.start();
    let release: () => void = () => undefined;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    let answered: Promise<void> = Promise.resolve();
    await origin.route("**/stubborn", async (route: OriginRoute) => {
      await hold;
      answered = route.fulfill({ body: "late" });
      await answered;
    });
    const outcome = send(url, "/stubborn");
    expect(await until(() => origin.receipts.length === 1, "arrived")).toBe(
      "done",
    );
    await expect(origin.close()).rejects.toThrow(
      /1 dispatch\(es\) \[GET http:\/\/127\.0\.0\.1:4321\/stubborn\]/,
    );
    release();
    await hold;
    await answered;
    expect(origin.errors).toEqual([
      expect.stringMatching(
        /late fulfilled of GET .*\/stubborn after the origin closed/,
      ),
    ]);
    expect(origin.receipts[0]?.late).toEqual(["fulfilled"]);
    expect((await outcome).error).toBeDefined();
  });
  it("a handler that never decides is cancelled at close; a decision after its downstream closed is recorded, not an error", async () => {
    const origin = createScriptedOrigin({
      stamp,
      fallback: "http://127.0.0.1:9",
      closeBoundMs: CLOSE_BOUND,
    });
    const url = await origin.start();
    let later: OriginRoute | null = null;
    await origin.route("**/undecided", () => undefined);
    await origin.route("**/abandoned", (route: OriginRoute) => {
      later = route;
    });
    const client = rawClient(url, "GET /abandoned HTTP/1.1\r\nhost: x\r\n\r\n");
    expect(await until(() => later !== null, "abandoned arrived")).toBe("done");
    client.socket.destroy();
    expect(
      await until(
        () => origin.receipts[0]?.outcome === "cancelled",
        "abandoned cancelled",
      ),
    ).toBe("done");
    await (later as unknown as OriginRoute).fallback();
    expect(origin.receipts[0]?.late).toEqual(["fallback"]);
    const undecided = send(url, "/undecided");
    expect(
      await until(() => origin.receipts.length === 2, "undecided arrived"),
    ).toBe("done");
    await origin.close();
    expect(origin.receipts[1]).toMatchObject({ outcome: "cancelled" });
    expect((await undecided).error).toBeDefined();
    expect(origin.errors).toEqual([]);
  });
});

describe("D10: start, close and the fixture's teardown", () => {
  it("close is idempotent (one shared close), joins a start in progress, and a closed origin never starts", async () => {
    const origin = createScriptedOrigin({
      stamp,
      fallback: "http://127.0.0.1:9",
    });
    const starting = origin.start();
    const first = origin.close();
    const second = origin.close();
    expect(second).toBe(first);
    await first;
    const url = await starting;
    expect(origin.owned()).toMatchObject({ state: "closed", listening: false });
    expect((await send(url, "/x")).error).toBe("ECONNREFUSED");
    const never = createScriptedOrigin({
      stamp,
      fallback: "http://127.0.0.1:9",
    });
    await never.close();
    await expect(never.start()).rejects.toThrow(/start\(\) in state closed/);
  });
  it("close joins an idle connection's close event, not its closed flag (set at destroy(), a turn before the event)", async () => {
    const origin = createScriptedOrigin({
      stamp,
      fallback: "http://127.0.0.1:9",
      closeBoundMs: CLOSE_BOUND,
    });
    const url = await origin.start();
    const idle = rawClient(url, "");
    await idle.connected;
    expect(
      await until(() => origin.owned().connections === 1, "idle connected"),
    ).toBe("done");
    await origin.close();
    expect(
      origin.owned().connections,
      "the idle connection's close is delivered before close() resolves",
    ).toBe(0);
    idle.socket.destroy();
  });
  it("runCleanup attempts every step, newest first, and keeps each failure with its label", async () => {
    const ran: string[] = [];
    const steps: CleanupStep[] = [
      { label: "a", run: async () => void ran.push("a") },
      {
        label: "b",
        run: async () => {
          ran.push("b");
          throw new Error("b failed");
        },
      },
      {
        label: "c",
        run: async () => {
          ran.push("c");
          return new Error("c failed");
        },
      },
      { label: "d", run: async () => void ran.push("d") },
    ];
    expect(await runCleanup(steps)).toEqual([
      "c: Error: c failed",
      "b: Error: b failed",
    ]);
    expect(ran).toEqual(["d", "c", "b", "a"]);
  });
  it("settleLanes closes first, then reports: an attach failure, a classification and a cleanup failure are all kept", async () => {
    const order: string[] = [];
    const b = journal();
    b.problem(0, 1, "pageerror", "boom");
    const lane = (attachFails: boolean) => ({
      verdict: () => {
        order.push("verdict");
        return classifyJournal(b.j);
      },
      ledger: () => ({ attachFails }),
      undeclaredForeign: () => [],
      origin: { errors: [] },
    });
    const report = await settleLanes(
      [lane(true), lane(false)],
      () =>
        runCleanup([
          {
            label: "context",
            run: async () => {
              order.push("cleanup");
              throw new Error("close failed");
            },
          },
        ]),
      async (name, body) => {
        order.push(`attach ${name}`);
        if (JSON.parse(body).attachFails) throw new Error("attach failed");
      },
    );
    expect(order[0]).toBe("cleanup");
    expect(report.closeErrors).toEqual(["context: Error: close failed"]);
    expect(report.reportErrors).toEqual([
      "lane 0 ledger: Error: attach failed",
    ]);
    expect(report.failures).toHaveLength(2);
  });
  it("the fixture settles even when its use fails, and keeps the original failure with the teardown report", async () => {
    const attached: string[] = [];
    const info = {
      attach: async (name: string) => void attached.push(name),
      project: { use: {} },
    };
    await expect(
      transportLaneFixture(
        { browser: {} as never },
        async () => {
          throw new Error("the case failed");
        },
        info as never,
      ),
    ).rejects.toThrow(
      /transport lane fixture: Error: the case failed; teardown \{"closeErrors":\[\],"reportErrors":\[\],"failures":\[\],"openErrors":\[\]\}/,
    );
  });
});

// ---- Revision 20 (Review 24 F24-1; design assessment token 1fd56474…, L01–L08): the manager owns every admitted open ----------------

/**
 * A browser double whose contexts are counted (every context it ever made, and which are still open); the lane's listeners are REAL
 * loopback servers, observed independently (a refused connection). The real-engine counterpart is the guard spec's L cases.
 */
function fakeBrowser() {
  type FakeContext = {
    id: number;
    closes: number;
    on: () => void;
    addInitScript: () => Promise<void>;
    close: () => Promise<void>;
  };
  const live = new Set<FakeContext>();
  const made: FakeContext[] = [];
  const hooks: { onClose?: () => Promise<void> } = {};
  return {
    live,
    made,
    hooks,
    newContext: (async () => {
      const c: FakeContext = {
        id: made.length + 1,
        closes: 0,
        on: () => undefined,
        addInitScript: async () => undefined,
        close: async () => {
          c.closes += 1;
          await hooks.onClose?.();
          live.delete(c);
        },
      };
      made.push(c);
      live.add(c);
      return c;
    }) as unknown as Browser["newContext"],
  };
}
const fakeInfo = () => {
  const attached = new Map<string, unknown>();
  return {
    attached,
    info: {
      project: { use: { baseURL: "http://127.0.0.1:9" } },
      attach: async (name: string, { body }: { body: string }) =>
        void attached.set(name, JSON.parse(body)),
    } as unknown as Pick<TestInfo, "project" | "attach">,
  };
};
const deferred = <T = void>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
const refused = async (url: unknown) =>
  (await send(String(url), "/__transport/probe/none")).error === "ECONNREFUSED";
const STAGES: OpenStage[] = [
  "witness",
  "scripted origin",
  "front",
  "context",
  "init script",
  "publication",
];
const LISTENERS: OpenStage[] = ["witness", "scripted origin", "front"];
type Step = "pass" | "hold-after" | "hold-before" | "reject";
/**
 * The qualification seam: `plan(stage, nth)` decides each stage's n-th call (from 1). `hold-after` performs the REAL acquisition, then
 * holds its delivery; `hold-before` holds, then asks for the acquisition (which settlement may refuse); `reject` fails without acquiring.
 * Every acquired handle (a listener's URL, a context) is kept for the independent oracles.
 */
function seam(plan: (stage: OpenStage, nth: number) => Step) {
  const seen: OpenStage[] = [];
  const handles: Array<{ stage: OpenStage; handle: unknown }> = [];
  const counts = new Map<OpenStage, number>();
  const reached = deferred();
  const release = deferred<"deliver" | "reject">();
  const askedLate: string[] = [];
  const interpose = (async (
    stage: OpenStage,
    acquire: () => Promise<unknown>,
  ) => {
    seen.push(stage);
    const nth = (counts.get(stage) ?? 0) + 1;
    counts.set(stage, nth);
    const step = plan(stage, nth);
    if (step === "reject") {
      reached.resolve();
      throw new Error(`injected ${stage} failure`);
    }
    if (step === "hold-before") {
      reached.resolve();
      if ((await release.promise) === "reject")
        throw new Error(`late ${stage} rejection`);
      try {
        const handle = await acquire();
        handles.push({ stage, handle });
        return handle;
      } catch (error) {
        askedLate.push(String(error));
        throw error;
      }
    }
    const handle = await acquire();
    handles.push({ stage, handle });
    if (step === "hold-after") {
      reached.resolve();
      await release.promise;
    }
    return handle;
  }) as Interpose;
  return { interpose, seen, handles, reached, release, askedLate };
}
const listenerUrls = (s: ReturnType<typeof seam>) =>
  s.handles.filter((h) => LISTENERS.includes(h.stage)).map((h) => h.handle);
/** Gives a settlement that does NOT join pending work every chance to finish first (a sensitivity window, not a duration under test). */
const turns = () => new Promise((resolve) => setTimeout(resolve, 50));

describe("L01: the manager's ordinary lifecycle", () => {
  for (const mode of ["fixture", "integration"] as const)
    it(`L01 ${mode}: a complete open and its settlement return everything to baseline; a later open is refused before allocating`, async () => {
      const browser = fakeBrowser();
      const sentinel = await browser.newContext();
      const { info, attached } = fakeInfo();
      const s = seam(() => "pass");
      const lanes = openTransportLanes(browser, info, {
        interpose: s.interpose,
      });
      const lane = await lanes.open({ mode });
      expect(lanes.lanes).toEqual([lane]);
      expect(await refused(lane.witness.url)).toBe(false);
      // Within a lane, the context closes first, while its front and witness still listen (no browser event about them going away).
      const atContextClose: boolean[] = [];
      browser.hooks.onClose = async () => {
        atContextClose.push(
          await refused(lane.transport.url),
          await refused(lane.witness.url),
        );
      };
      const settling = lanes.settle();
      expect(lanes.settle(), "repeated settlement shares one operation").toBe(
        settling,
      );
      expect(await settling).toEqual({
        closeErrors: [],
        reportErrors: [],
        failures: [],
        openErrors: [],
      });
      expect(s.seen).toEqual(
        STAGES.filter((st) => mode === "fixture" || st !== "scripted origin"),
      );
      expect(
        atContextClose,
        "the context closes before its front and witness",
      ).toEqual([false, false]);
      for (const url of listenerUrls(s)) expect(await refused(url)).toBe(true);
      expect(browser.made.slice(1).map((c) => c.closes)).toEqual([1]);
      expect(browser.live, "the unrelated context survives").toEqual(
        new Set([sentinel]),
      );
      expect([...attached.keys()]).toEqual([
        "transport-ledger-0",
        "transport-teardown",
      ]);
      expect(attached.get("transport-teardown")).toMatchObject({
        opens: [{ id: 1, outcome: "published" }],
        late: [],
      });
      await expect(lanes.open({ mode })).rejects.toThrow(
        /open refused, settlement began/,
      );
      expect(s.seen.length, "nothing allocated for the refused open").toBe(
        mode === "fixture" ? 6 : 5,
      );
      expect(lanes.state).toBe("settled");
    });
  it("L01: an empty manager settles cleanly, once", async () => {
    const { info } = fakeInfo();
    const lanes = openTransportLanes(fakeBrowser(), info);
    expect(await lanes.settle()).toEqual({
      closeErrors: [],
      reportErrors: [],
      failures: [],
      openErrors: [],
    });
    expect(await lanes.settle()).toBe(await lanes.settle());
  });
});

describe("L02–L06: settlement overlapping each stage of an open", () => {
  for (const [index, stage] of STAGES.entries())
    it(`L02–L06 ${stage} held after its genuine acquisition: settlement waits for it and disposes it; no later stage, no publication`, async () => {
      const browser = fakeBrowser();
      const { info, attached } = fakeInfo();
      const s = seam((st) => (st === stage ? "hold-after" : "pass"));
      const lanes = openTransportLanes(browser, info, {
        interpose: s.interpose,
      });
      const opening = lanes.open({ mode: "fixture" });
      const outcome = opening.then(
        () => "published",
        (error: unknown) => error,
      );
      await s.reached.promise;
      let released = false;
      let settledAt: string | null = null;
      const settling = lanes.settle();
      void settling.then(() => {
        settledAt = released ? "after release" : "before release";
      });
      expect(lanes.state).toBe("closing");
      await turns();
      expect(
        settledAt,
        "settlement cannot report while an acquisition it owns is held",
      ).toBeNull();
      released = true;
      s.release.resolve("deliver");
      const report = await settling;
      expect(settledAt).toBe("after release");
      const cancelled = await outcome;
      expect(cancelled).toBeInstanceOf(LaneCancelled);
      const when = stage === "publication" ? "at" : "after";
      expect(String(cancelled)).toContain(
        `open 1 cancelled ${when} ${stage}: settlement began`,
      );
      expect(report).toEqual({
        closeErrors: [],
        reportErrors: [],
        failures: [],
        openErrors: [
          `open 1 cancelled at ${stage}: LaneCancelled: open 1 cancelled ${when} ${stage}: settlement began while it was opening`,
        ],
      });
      expect(s.seen, "no later stage began").toEqual(
        STAGES.slice(0, index + 1),
      );
      expect(lanes.lanes, "nothing published").toEqual([]);
      for (const url of listenerUrls(s)) expect(await refused(url)).toBe(true);
      expect(browser.live.size).toBe(0);
      expect(
        browser.made.map((c) => c.closes),
        "each context closed exactly once",
      ).toEqual(index >= STAGES.indexOf("context") ? [1] : []);
      expect(attached.has("transport-ledger-0")).toBe(false);
      expect(attached.get("transport-teardown")).toMatchObject({
        opens: [{ id: 1, outcome: "cancelled", stage }],
      });
      expect(await lanes.settle(), "repeated settlement: the same report").toBe(
        report,
      );
    });
  for (const stage of [
    "witness",
    "scripted origin",
    "front",
    "context",
  ] as const)
    it(`L02–L04 ${stage} held BEFORE its acquisition: released after settlement began, the acquisition is refused and nothing is acquired`, async () => {
      const browser = fakeBrowser();
      const { info } = fakeInfo();
      const s = seam((st) => (st === stage ? "hold-before" : "pass"));
      const lanes = openTransportLanes(browser, info, {
        interpose: s.interpose,
      });
      const outcome = lanes.open({ mode: "fixture" }).catch((e: unknown) => e);
      await s.reached.promise;
      const settling = lanes.settle();
      s.release.resolve("deliver");
      const report = await settling;
      expect(s.askedLate).toEqual([
        `LaneCancelled: open 1 cancelled before ${stage}: settlement began while it was opening`,
      ]);
      expect(String(await outcome)).toContain(`cancelled before ${stage}`);
      expect(report.openErrors).toEqual([
        `open 1 cancelled at ${stage}: LaneCancelled: open 1 cancelled before ${stage}: settlement began while it was opening`,
      ]);
      expect(report.closeErrors).toEqual([]);
      expect(s.handles.map((h) => h.stage)).toEqual(
        STAGES.slice(0, STAGES.indexOf(stage)),
      );
      expect(browser.made).toEqual([]);
      for (const url of listenerUrls(s)) expect(await refused(url)).toBe(true);
    });
  for (const stage of [
    "witness",
    "scripted origin",
    "front",
    "context",
    "init script",
  ] as const)
    it(`L02–L06 ${stage} rejected before settlement: the open fails with its stage, unwinds what it acquired at once, and settlement reports it`, async () => {
      const browser = fakeBrowser();
      const { info } = fakeInfo();
      const s = seam((st) => (st === stage ? "reject" : "pass"));
      const lanes = openTransportLanes(browser, info, {
        interpose: s.interpose,
      });
      await expect(lanes.open({ mode: "fixture" })).rejects.toThrow(
        `injected ${stage} failure`,
      );
      const earlier = listenerUrls(s);
      for (const url of earlier)
        expect(await refusedSoon(url), "unwound before any settlement").toBe(
          true,
        );
      expect(
        await until(() => browser.live.size === 0, "contexts unwound"),
      ).toBe("done");
      const report = await lanes.settle();
      expect(report).toEqual({
        closeErrors: [],
        reportErrors: [],
        failures: [],
        openErrors: [
          `open 1 failed at ${stage}: Error: injected ${stage} failure`,
        ],
      });
      expect(browser.made.map((c) => c.closes)).toEqual(
        STAGES.indexOf(stage) > STAGES.indexOf("context") ? [1] : [],
      );
    });
});
/** A listener refuses connections within a short observation bound (its asynchronous unwinding). */
async function refusedSoon(url: unknown) {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (await refused(url)) return true;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return false;
}

describe("L05: an acquisition that does not answer within settlement's join bound", () => {
  it("L05 a held context: settlement fails by name at the bound; the context arriving later is closed and recorded", async () => {
    const browser = fakeBrowser();
    const { info } = fakeInfo();
    const lateLines: string[] = [];
    const lateSeen = deferred();
    const s = seam((st) => (st === "context" ? "hold-after" : "pass"));
    const lanes = openTransportLanes(browser, info, {
      interpose: s.interpose,
      joinBoundMs: 200,
      onLate: (line) => {
        lateLines.push(line);
        if (lateLines.length === 2) lateSeen.resolve();
      },
    });
    const outcome = lanes.open({ mode: "fixture" }).catch((e: unknown) => e);
    await s.reached.promise;
    const settling = lanes.settle();
    expect(
      await within(settling, 2_000),
      "settlement returns at its join bound, not when the acquisition answers",
    ).toBe("done");
    const report = await settling;
    expect(report.closeErrors).toEqual([
      "open 1: context acquisition still pending when settlement's join bound ended (its result will be disposed when it arrives)",
      "open 1: unfinished at context when settlement's join bound ended",
    ]);
    expect(report.openErrors).toEqual([]);
    expect(browser.live.size, "honestly still open at the report").toBe(1);
    for (const url of listenerUrls(s)) expect(await refused(url)).toBe(true);
    s.release.resolve("deliver");
    await lateSeen.promise;
    // Two independent late facts (the open's end, and the context's disposal, which completes after its close): order not asserted.
    expect([...lateLines].sort()).toEqual([
      "open 1: ended cancelled after settlement (LaneCancelled: open 1 cancelled after context: settlement began while it was opening)",
      "open 1: late context arrived after settlement; disposed",
    ]);
    expect(lanes.late).toEqual(lateLines);
    expect(browser.live.size).toBe(0);
    expect(browser.made[0]?.closes).toBe(1);
    expect(lanes.lanes).toEqual([]);
    expect(
      await lanes.settle(),
      "a later settle never turns into success",
    ).toBe(report);
    expect(String(await outcome)).toContain("cancelled after context");
  });
  it("L05 a late rejection after the bound is observed and recorded (no unhandled rejection), and a later stage is never asked for", async () => {
    const { info } = fakeInfo();
    const browser = fakeBrowser();
    const lateLines: string[] = [];
    const lateSeen = deferred();
    const s = seam((st) => (st === "front" ? "hold-before" : "pass"));
    const lanes = openTransportLanes(browser, info, {
      interpose: s.interpose,
      joinBoundMs: 200,
      onLate: (line) => {
        lateLines.push(line);
        if (lateLines.length === 2) lateSeen.resolve();
      },
    });
    void lanes.open({ mode: "fixture" });
    await s.reached.promise;
    const settling = lanes.settle();
    expect(
      await within(settling, 2_000),
      "settlement returns at its join bound, not when the acquisition answers",
    ).toBe("done");
    const report = await settling;
    expect(report.closeErrors).toEqual([
      "open 1: front acquisition still pending when settlement's join bound ended (its result will be disposed when it arrives)",
      "open 1: unfinished at front when settlement's join bound ended",
    ]);
    s.release.resolve("reject");
    await lateSeen.promise;
    expect([...lateLines].sort()).toEqual([
      "open 1: ended failed after settlement (Error: late front rejection)",
      "open 1: late front rejected after settlement: Error: late front rejection",
    ]);
    expect(s.seen).toEqual(["witness", "scripted origin", "front"]);
    expect(browser.made).toEqual([]);
  });
});

describe("L07: concurrent opens and managers", () => {
  it("L07 a published lane, an open held at front and one rejected at context: each accounted for once; another manager is untouched", async () => {
    const browser = fakeBrowser();
    const { info, attached } = fakeInfo();
    const s = seam((st, nth) =>
      st === "front" && nth === 2
        ? "hold-after"
        : st === "context" && nth === 2
          ? "reject"
          : "pass",
    );
    const a = openTransportLanes(browser, info, { interpose: s.interpose });
    const first = await a.open({ mode: "fixture" });
    const held = a.open({ mode: "fixture" }).catch((e: unknown) => e);
    await s.reached.promise;
    await expect(a.open({ mode: "fixture" })).rejects.toThrow(
      "injected context failure",
    );
    const other = fakeInfo();
    const b = openTransportLanes(browser, other.info);
    const kept = await b.open({ mode: "fixture" });
    const settling = a.settle();
    await turns();
    s.release.resolve("deliver");
    const report = await settling;
    expect(report).toEqual({
      closeErrors: [],
      reportErrors: [],
      failures: [],
      openErrors: [
        "open 2 cancelled at front: LaneCancelled: open 2 cancelled after front: settlement began while it was opening",
        "open 3 failed at context: Error: injected context failure",
      ],
    });
    expect(String(await held)).toContain("open 2 cancelled after front");
    expect(a.lanes).toEqual([first]);
    expect([...attached.keys()]).toEqual([
      "transport-ledger-0",
      "transport-teardown",
    ]);
    for (const url of listenerUrls(s)) expect(await refused(url)).toBe(true);
    expect(browser.live, "only the other manager's context remains").toEqual(
      new Set([kept.context]),
    );
    expect(await refused(kept.witness.url)).toBe(false);
    expect(await refused(kept.transport.url)).toBe(false);
    expect((await b.settle()).openErrors).toEqual([]);
    expect(await refused(kept.transport.url)).toBe(true);
    expect(browser.live.size).toBe(0);
  });
  it("L07 the other order: an open held before front rejects during settlement, while one held after its context is delivered later", async () => {
    const browser = fakeBrowser();
    const { info } = fakeInfo();
    const atContext = seam((st) => (st === "context" ? "hold-after" : "pass"));
    const atFront = seam((st) => (st === "front" ? "hold-before" : "pass"));
    const which = new Map<number, ReturnType<typeof seam>>();
    let opened = 0;
    const lanes = openTransportLanes(browser, info, {
      // The first open's stages go through the first seam, the second's through the other (the witness is each open's first stage).
      interpose: (<T>(stage: OpenStage, acquire: () => Promise<T>) => {
        if (stage === "witness") opened += 1;
        const own = which.get(opened) as ReturnType<typeof seam>;
        return own.interpose(stage, acquire);
      }) as Interpose,
    });
    which.set(1, atContext);
    const one = lanes.open({ mode: "fixture" }).catch((e: unknown) => e);
    await atContext.reached.promise;
    which.set(2, atFront);
    const two = lanes.open({ mode: "fixture" }).catch((e: unknown) => e);
    await atFront.reached.promise;
    const settling = lanes.settle();
    atFront.release.resolve("reject");
    expect(String(await two)).toContain("late front rejection");
    await turns();
    atContext.release.resolve("deliver");
    const report = await settling;
    expect(report.closeErrors).toEqual([]);
    expect(report.openErrors).toEqual([
      "open 1 cancelled at context: LaneCancelled: open 1 cancelled after context: settlement began while it was opening",
      "open 2 failed at front: Error: late front rejection",
    ]);
    expect(String(await one)).toContain("cancelled after context");
    for (const url of [...listenerUrls(atContext), ...listenerUrls(atFront)])
      expect(await refused(url)).toBe(true);
    expect(browser.live.size).toBe(0);
    expect(browser.made.map((c) => c.closes)).toEqual([1]);
  });
});

describe("L08: failed use, failed or hanging cleanup, failed reporting", () => {
  it("L08 the fixture's use fails with an open pending: the original failure is kept with a bounded, named teardown failure", async () => {
    const browser = fakeBrowser();
    const { info } = fakeInfo();
    const s = seam((st) => (st === "context" ? "hold-after" : "pass"));
    const lateSeen = deferred();
    const failed = runTransportLaneFixture(
      browser,
      async (open) => {
        void open({ mode: "fixture" });
        await s.reached.promise;
        throw new Error("the case failed");
      },
      info,
      {
        interpose: s.interpose,
        joinBoundMs: 200,
        onLate: (line) => {
          if (line.includes("late context")) lateSeen.resolve();
        },
      },
    );
    await expect(failed).rejects.toThrow(
      /transport lane fixture: Error: the case failed; teardown .*open 1: context acquisition still pending when settlement's join bound ended/,
    );
    s.release.resolve("deliver");
    await lateSeen.promise;
    expect(browser.live.size).toBe(0);
  });
  it("L08 the fixture without a use failure fails on an open that was cancelled by its settlement", async () => {
    const { info } = fakeInfo();
    const s = seam((st) => (st === "init script" ? "hold-after" : "pass"));
    const failed = runTransportLaneFixture(
      fakeBrowser(),
      async (open) => {
        void open({ mode: "fixture" }).catch(() => undefined);
        await s.reached.promise;
        setTimeout(() => s.release.resolve("deliver"), 0);
      },
      info,
      { interpose: s.interpose },
    );
    await expect(failed).rejects.toThrow(/open 1 cancelled at init script/);
  });
  it("L08 runCleanup: a hanging step is reported at its bound, later steps still run, and its eventual outcome is recorded late", async () => {
    const ran: string[] = [];
    const hang = deferred();
    const late: string[] = [];
    const lateSeen = deferred();
    const cleaning = runCleanup(
      [
        { label: "a", run: async () => void ran.push("a") },
        {
          label: "b",
          run: async () => {
            ran.push("b");
            await hang.promise;
            return new Error("b closed badly");
          },
        },
        { label: "c", run: async () => void ran.push("c") },
      ],
      100,
      (line) => {
        late.push(line);
        lateSeen.resolve();
      },
    );
    expect(
      await within(cleaning, 2_000),
      "cleanup returns at the hanging step's bound",
    ).toBe("done");
    expect(await cleaning).toEqual(["b: still running 100 ms after it began"]);
    expect(ran).toEqual(["c", "b", "a"]);
    hang.resolve();
    await lateSeen.promise;
    expect(late).toEqual([
      "b: its close ended after its bound (Error: b closed badly)",
    ]);
  });
  it("L08 settleLanes attempts every lane's ledger, classification, origin errors and foreign requests whatever the others did", async () => {
    const lane = (parts: { verdict?: () => never; foreign?: () => never }) => ({
      verdict: parts.verdict ?? (() => classifyJournal(journal().j)),
      ledger: () => ({}),
      undeclaredForeign: parts.foreign ?? (() => ["GET http://elsewhere/x"]),
      origin: { errors: ["handler failed"] },
    });
    const report = await settleLanes(
      [
        lane({
          verdict: () => {
            throw new Error("classifier threw");
          },
        }),
        lane({
          foreign: () => {
            throw new Error("foreign threw");
          },
        }),
      ],
      async () => {
        throw new Error("close threw");
      },
      async () => undefined,
    );
    expect(report).toEqual({
      closeErrors: ["close: Error: close threw"],
      reportErrors: [
        "lane 0 classification: Error: classifier threw",
        "lane 1 foreign requests: Error: foreign threw",
      ],
      failures: [
        "lane 0 scripted origin handler: handler failed",
        "lane 0: a request outside the lane's origin: GET http://elsewhere/x",
        "lane 1 scripted origin handler: handler failed",
      ],
    });
  });
});
