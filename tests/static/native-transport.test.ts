// @vitest-environment node

import { EventEmitter } from "node:events";
import {
  createServer,
  type IncomingMessage,
  request,
  type ServerResponse,
} from "node:http";
import { connect, type Socket } from "node:net";
import { createContext, runInContext } from "node:vm";
import type { Browser, TestInfo } from "@playwright/test";
import { describe, expect, it } from "vitest";
import type { TransportAttempt } from "../../scripts/integration/http-transport-loss.mjs";
import {
  ACTIVATION_SOURCE_PIN,
  type AttemptRecord,
  type CleanupStep,
  categorise,
  classifyJournal,
  createScriptedOrigin,
  frameOfRequest,
  globRegExp,
  type Interpose,
  installedPlaywrightCore,
  installUiStimulus,
  type Journal,
  LaneCancelled,
  LaneSeamMisuse,
  type OpenStage,
  type OriginRoute,
  observeActivations,
  observeNavigations,
  openTransportLanes,
  type Problem,
  type RecordedRequest,
  type RequestRecord,
  readNavigated,
  recordContext,
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
/**
 * Revision 29 (F34-1): Playwright's in-process SERVER side of a context double, as `observeActivations` reads it through the client
 * connection's `toImpl`: the server context (an emitter of `internalframenavigatedtonewdocument` with `possiblyUninitializedPages()`), the
 * dispatcher connection (`existingDispatcher`) and each bound client object's server object. A client object never bound throws, as
 * Playwright's `toImpl` does for an object without a dispatcher.
 */
function serverSide(pagesAtAttach = 0) {
  const server = Object.assign(new EventEmitter(), {
    possiblyUninitializedPages: () => Array.from({ length: pagesAtAttach }),
  });
  const dispatched = new WeakSet<object>();
  const impls = new WeakMap<object, unknown>();
  const dispatchers = {
    existingDispatcher: (o: object) => (dispatched.has(o) ? {} : undefined),
  };
  const connection: { toImpl: (x: unknown) => unknown } = {
    toImpl(x: unknown) {
      if (x === connection) return dispatchers;
      if (typeof x !== "object" || x === null || !impls.has(x))
        throw new TypeError(
          "Cannot read properties of undefined (reading '_object')",
        );
      return impls.get(x);
    },
  };
  return {
    server,
    connection,
    bind: (client: object, impl: unknown) => {
      impls.set(client, impl);
    },
    implOf: (client: object) => impls.get(client),
    /** Playwright creates a frame's dispatcher at its first request or its page's announcement; from then on it dispatches its commits. */
    dispatch: (frame: object) => {
      dispatched.add(frame);
    },
    isDispatched: (frame: object) => dispatched.has(frame),
    /** Playwright's `frameCommittedNewDocumentNavigation` → `frameNavigatedToNewDocument`: the context event, emitted before any client delivery. */
    commit: (frame: object) =>
      server.emit("internalframenavigatedtonewdocument", frame),
  };
}

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
  /**
   * `onClose` runs inside each close. `deliver` (revision 21) holds `newContext`'s DELIVERY of a context it has already made (Review 24's
   * F24-1 schedule: a genuine acquisition still pending for its caller); resolving it "reject" makes `newContext` unwind its own context
   * and reject, as a foreign API that fails owns its unwinding. Each hook applies to the next `newContext` only.
   */
  const hooks: {
    onClose?: () => Promise<void>;
    deliver?: Promise<"deliver" | "reject">;
  } = {};
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
      // Revision 29: its in-process server side (no page, no commit), so the lane's activation source attaches as in Playwright.
      const side = serverSide();
      side.bind(c, side.server);
      (c as unknown as { _connection: unknown })._connection = side.connection;
      made.push(c);
      live.add(c);
      const deliver = hooks.deliver;
      hooks.deliver = undefined;
      if (deliver !== undefined && (await deliver) === "reject") {
        live.delete(c);
        throw new Error("newContext failed");
      }
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
type Step =
  | "pass"
  | "hold-after"
  | "hold-before"
  | "reject"
  | "acquire-reject"
  | "start-reject"
  | "retain-reject"
  | "twice"
  | "substitute"
  | "invent";
/**
 * The qualification seam: `plan(stage, nth)` decides each stage's n-th call (from 1). `hold-after` performs the REAL acquisition, then
 * holds its delivery (released "deliver", or "reject": the wrapper then fails AFTER its genuine acquisition); `hold-before` holds, then
 * asks for the acquisition (which settlement may refuse); `reject` fails without acquiring.
 *
 * Revision 21 (Review 25 F25-1): `acquire-reject` performs the REAL acquisition and then fails (the review's schedule); `start-reject`
 * starts it and fails before it answers (the started acquisition is kept in `starts`); `retain-reject` fails without acquiring but keeps
 * the acquisition to call later (`retained`). The seam-contract negatives: `twice` asks for its acquisition twice, `substitute` delivers
 * another value than the acquired one, `invent` delivers a value without acquiring. Every acquired handle (a listener's URL, a context)
 * is kept for the independent oracles, and every error the seam throws is kept (`thrown`) so the open's rejection can be compared by
 * identity.
 */
function seam(plan: (stage: OpenStage, nth: number) => Step) {
  const seen: OpenStage[] = [];
  const handles: Array<{ stage: OpenStage; handle: unknown }> = [];
  const starts: Array<{ stage: OpenStage; started: Promise<unknown> }> = [];
  const retained: Array<{ stage: OpenStage; acquire: () => Promise<unknown> }> =
    [];
  const thrown: Error[] = [];
  const counts = new Map<OpenStage, number>();
  const reached = deferred();
  const release = deferred<"deliver" | "reject">();
  const askedLate: string[] = [];
  const fail = (message: string) => {
    const error = new Error(message);
    thrown.push(error);
    return error;
  };
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
      throw fail(`injected ${stage} failure`);
    }
    if (step === "retain-reject") {
      retained.push({ stage, acquire });
      reached.resolve();
      throw fail(`injected ${stage} failure`);
    }
    if (step === "invent") return { invented: stage };
    if (step === "start-reject") {
      const started = acquire();
      started.catch(() => undefined);
      starts.push({ stage, started });
      reached.resolve();
      throw fail(`injected ${stage} failure while acquiring`);
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
    if (step === "acquire-reject") {
      reached.resolve();
      throw fail(`injected ${stage} failure after acquisition`);
    }
    if (step === "twice") {
      try {
        await acquire();
      } catch (error) {
        askedLate.push(String(error));
      }
    }
    if (step === "substitute") return { substitute: stage };
    if (step === "hold-after") {
      reached.resolve();
      if ((await release.promise) === "reject")
        throw fail(`late ${stage} rejection after acquisition`);
    }
    return handle;
  }) as Interpose;
  return {
    interpose,
    seen,
    handles,
    starts,
    retained,
    thrown,
    reached,
    release,
    askedLate,
  };
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
      // Revision 21 (Review 25 F25-1, Q03 with delivery): ownership follows the acquisition, so what the held stage acquired, and
      // everything before it, is closed while its wrapper is still held; the wrapper's outcome is what settlement still waits for.
      for (const url of listenerUrls(s))
        expect(await refusedSoon(url), "closed while its wrapper is held").toBe(
          true,
        );
      expect(
        await until(() => browser.live.size === 0, "context closed while held"),
      ).toBe("done");
      expect(lanes.snapshot()[0]?.holdings[index]).toEqual({
        stage,
        acquisition: "acquired",
        wrapper: "pending",
        disposal:
          LISTENERS.includes(stage) || stage === "context"
            ? "disposed"
            : "none",
      });
      expect(settledAt, "still waiting for the held wrapper").toBeNull();
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
  // Revision 21 (Review 25 F25-1; design assessment "L05 held-after control"): an EXPLAINED ORACLE CORRECTION, not a deletion. Revision
  // 20 owned a context only when the wrapper delivered it, so this schedule (the context genuinely acquired, its WRAPPER held past the
  // bound) left the context "honestly still open at the report" under the message "context acquisition still pending". The acquisition
  // is not pending: it succeeded and is owned, so it is now closed during settlement, and the bound names the WRAPPER. The bound's named
  // failure, the unfinished open, the late record and the never-success re-settlement are kept. Revision 20's message and its
  // still-open-at-the-report oracle now belong to a GENUINELY pending acquisition: "L05 a context whose delivery by newContext" below.
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
      "open 1: context wrapper still pending when settlement's join bound ended (its acquired resource was disposed; its outcome will be recorded when it arrives)",
      "open 1: unfinished at context when settlement's join bound ended",
    ]);
    expect(report.openErrors).toEqual([]);
    expect(
      browser.live.size,
      "the acquired context is closed at the report, its wrapper still held",
    ).toBe(0);
    expect(browser.made[0]?.closes).toBe(1);
    for (const url of listenerUrls(s)) expect(await refused(url)).toBe(true);
    s.release.resolve("deliver");
    await lateSeen.promise;
    // Two independent late facts (the open's end, and the wrapper's delivery): order not asserted.
    expect([...lateLines].sort()).toEqual([
      "open 1: ended cancelled after settlement (LaneCancelled: open 1 cancelled after context: settlement began while it was opening)",
      "open 1: late context wrapper delivered after settlement",
    ]);
    expect(lanes.late).toEqual(lateLines);
    expect(browser.live.size).toBe(0);
    expect(browser.made[0]?.closes, "closed exactly once").toBe(1);
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
    // Revision 21 (F25-1): RELABELLED, same schedule and oracle. The front's acquisition never began (its wrapper holds before asking),
    // so the bound now names the WRAPPER, not an acquisition, and the late rejection is the wrapper's.
    expect(report.closeErrors).toEqual([
      "open 1: front wrapper still pending when settlement's join bound ended (its acquisition never began and is now refused; its outcome will be recorded when it arrives)",
      "open 1: unfinished at front when settlement's join bound ended",
    ]);
    s.release.resolve("reject");
    await lateSeen.promise;
    expect([...lateLines].sort()).toEqual([
      "open 1: ended failed after settlement (Error: late front rejection)",
      "open 1: late front wrapper rejected after settlement: Error: late front rejection",
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
    // Revision 21 (F25-1): the held stage is the context's WRAPPER (its acquisition succeeded), so the bound names the wrapper and the
    // context is already closed when the fixture fails; the genuinely pending acquisition keeps revision 20's message (next case).
    await expect(failed).rejects.toThrow(
      /transport lane fixture: Error: the case failed; teardown .*open 1: context wrapper still pending when settlement's join bound ended/,
    );
    expect(browser.live.size, "closed before the wrapper is released").toBe(0);
    s.release.resolve("deliver");
    await lateSeen.promise;
    expect(browser.live.size).toBe(0);
    expect(browser.made.map((c) => c.closes)).toEqual([1]);
  });
  it("L08 the fixture's use fails while a context's delivery is genuinely pending: the original failure and revision 20's named acquisition failure", async () => {
    const browser = fakeBrowser();
    const { info } = fakeInfo();
    const s = seam(() => "pass");
    const deliver = deferred<"deliver" | "reject">();
    browser.hooks.deliver = deliver.promise;
    const lateSeen = deferred();
    const failed = runTransportLaneFixture(
      browser,
      async (open) => {
        void open({ mode: "fixture" });
        await until(() => browser.made.length === 1, "context made");
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
    expect(browser.live.size, "undelivered, so honestly still open").toBe(1);
    deliver.resolve("deliver");
    await lateSeen.promise;
    expect(browser.live.size).toBe(0);
    expect(browser.made.map((c) => c.closes)).toEqual([1]);
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

// ---- Revision 21 (Review 25 F25-1; design assessment token 8179e31e…, Q01–Q08): ownership follows the REAL acquisition ----------------

/** What each stage's own disposer closes (init script and publication have none: their context and listeners are earlier holdings). */
const DISPOSED = (stage: OpenStage) =>
  LISTENERS.includes(stage) || stage === "context" ? "disposed" : "none";

describe("L05 (revision 21): a genuinely pending acquisition, distinct from a held wrapper", () => {
  it("L05 a context whose delivery by newContext outlives the join bound: named as a pending acquisition, honestly open at the report, closed when it arrives", async () => {
    const browser = fakeBrowser();
    const sentinel = await browser.newContext();
    const { info } = fakeInfo();
    const deliver = deferred<"deliver" | "reject">();
    browser.hooks.deliver = deliver.promise;
    const lateLines: string[] = [];
    const lateSeen = deferred();
    const lanes = openTransportLanes(browser, info, {
      joinBoundMs: 200,
      onLate: (line) => {
        lateLines.push(line);
        if (lateLines.length === 2) lateSeen.resolve();
      },
    });
    const outcome = lanes.open({ mode: "fixture" }).catch((e: unknown) => e);
    expect(await until(() => browser.made.length === 2, "context made")).toBe(
      "done",
    );
    const report = await lanes.settle();
    expect(report.closeErrors).toEqual([
      "open 1: context acquisition still pending when settlement's join bound ended (its result will be disposed when it arrives)",
      "open 1: unfinished at context when settlement's join bound ended",
    ]);
    expect(
      browser.live.size,
      "undelivered: honestly still open at the report",
    ).toBe(2);
    expect(lanes.snapshot()[0]?.holdings[3]).toEqual({
      stage: "context",
      acquisition: "pending",
      wrapper: "pending",
      disposal: "none",
      late: true,
    });
    deliver.resolve("deliver");
    await lateSeen.promise;
    expect([...lateLines].sort()).toEqual([
      "open 1: ended cancelled after settlement (LaneCancelled: open 1 cancelled after context: settlement began while it was opening)",
      "open 1: late context arrived after settlement; disposed",
    ]);
    expect(browser.live, "only the sentinel").toEqual(new Set([sentinel]));
    expect(browser.made[1]?.closes).toBe(1);
    expect(await lanes.settle(), "never turns into success").toBe(report);
    expect(String(await outcome)).toContain("cancelled after context");
  });
  it("L05 the same pending acquisition rejected after the bound: its rejection is recorded as the acquisition's; nothing is fabricated to close", async () => {
    const browser = fakeBrowser();
    const { info } = fakeInfo();
    const deliver = deferred<"deliver" | "reject">();
    browser.hooks.deliver = deliver.promise;
    const lateLines: string[] = [];
    const lateSeen = deferred();
    const lanes = openTransportLanes(browser, info, {
      joinBoundMs: 200,
      onLate: (line) => {
        lateLines.push(line);
        if (lateLines.length === 2) lateSeen.resolve();
      },
    });
    void lanes.open({ mode: "fixture" });
    expect(await until(() => browser.made.length === 1, "context made")).toBe(
      "done",
    );
    const report = await lanes.settle();
    expect(report.closeErrors[0]).toBe(
      "open 1: context acquisition still pending when settlement's join bound ended (its result will be disposed when it arrives)",
    );
    deliver.resolve("reject");
    await lateSeen.promise;
    expect([...lateLines].sort()).toEqual([
      "open 1: ended failed after settlement (Error: newContext failed)",
      "open 1: late context acquisition rejected after settlement: Error: newContext failed",
    ]);
    expect(browser.made[0]?.closes, "the API unwound its own context").toBe(0);
    expect(browser.live.size).toBe(0);
  });
  it("L05 a context's wrapper held past the bound, then rejecting: the context was already closed; the wrapper's rejection is recorded late", async () => {
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
    void lanes.open({ mode: "fixture" });
    await s.reached.promise;
    const report = await lanes.settle();
    expect(report.closeErrors).toEqual([
      "open 1: context wrapper still pending when settlement's join bound ended (its acquired resource was disposed; its outcome will be recorded when it arrives)",
      "open 1: unfinished at context when settlement's join bound ended",
    ]);
    expect(browser.live.size).toBe(0);
    s.release.resolve("reject");
    await lateSeen.promise;
    expect([...lateLines].sort()).toEqual([
      "open 1: ended failed after settlement (Error: late context rejection after acquisition)",
      "open 1: late context wrapper rejected after settlement: Error: late context rejection after acquisition",
    ]);
    expect(
      browser.made.map((c) => c.closes),
      "closed exactly once",
    ).toEqual([1]);
    expect(await lanes.settle()).toBe(report);
  });
});

describe("F25-1 Q02: a wrapper rejecting AFTER its stage's genuine acquisition, before settlement", () => {
  for (const [index, stage] of STAGES.entries())
    it(`Q02 ${stage}: the open fails with the original error, what it acquired is closed at once (no settlement needed), exactly once; the sentinel survives`, async () => {
      const browser = fakeBrowser();
      const sentinel = await browser.newContext();
      const { info, attached } = fakeInfo();
      const s = seam((st) => (st === stage ? "acquire-reject" : "pass"));
      const lanes = openTransportLanes(browser, info, {
        interpose: s.interpose,
      });
      const failure = await lanes.open({ mode: "fixture" }).catch((e) => e);
      expect(failure, "the original thrown value, not a wrapper of it").toBe(
        s.thrown[0],
      );
      expect(s.handles.map((h) => h.stage)).toEqual(STAGES.slice(0, index + 1));
      expect(lanes.state, "no settlement asked for").toBe("open");
      for (const url of listenerUrls(s))
        expect(await refusedSoon(url), "unwound before any settlement").toBe(
          true,
        );
      expect(
        await until(
          () => browser.live.size === 1,
          "contexts back to the sentinel",
        ),
      ).toBe("done");
      expect(browser.live).toEqual(new Set([sentinel]));
      expect(
        await until(
          () =>
            lanes.snapshot()[0]?.holdings[index]?.disposal === DISPOSED(stage),
          "the failed stage's own disposal recorded",
        ),
      ).toBe("done");
      expect(lanes.snapshot()[0]?.holdings[index]).toEqual({
        stage,
        acquisition: "acquired",
        wrapper: "failed",
        disposal: DISPOSED(stage),
        wrapperError: `Error: injected ${stage} failure after acquisition`,
      });
      const report = await lanes.settle();
      expect(report).toEqual({
        closeErrors: [],
        reportErrors: [],
        failures: [],
        openErrors: [
          `open 1 failed at ${stage}: Error: injected ${stage} failure after acquisition`,
        ],
      });
      expect(
        browser.made.slice(1).map((c) => c.closes),
        "each context closed exactly once (unwinding and settlement share one disposal)",
      ).toEqual(index >= STAGES.indexOf("context") ? [1] : []);
      expect(lanes.lanes, "nothing published").toEqual([]);
      expect(attached.has("transport-ledger-0")).toBe(false);
      expect(await lanes.settle()).toBe(report);
      expect(browser.live).toEqual(new Set([sentinel]));
    });
});

describe("F25-1 Q03: settlement overlapping a genuine acquisition whose held wrapper then rejects", () => {
  for (const [index, stage] of STAGES.entries())
    it(`Q03 ${stage}: owned before release and closed while held; the late rejection fails the open; once each; repeated settlement shares the report`, async () => {
      const browser = fakeBrowser();
      const sentinel = await browser.newContext();
      const { info } = fakeInfo();
      const s = seam((st) => (st === stage ? "hold-after" : "pass"));
      const lanes = openTransportLanes(browser, info, {
        interpose: s.interpose,
      });
      const outcome = lanes.open({ mode: "fixture" }).catch((e: unknown) => e);
      await s.reached.promise;
      expect(
        lanes.snapshot()[0]?.holdings[index],
        "owned before the wrapper is released",
      ).toMatchObject({ stage, acquisition: "acquired", wrapper: "pending" });
      let reported = false;
      const settling = lanes.settle();
      void settling.then(() => {
        reported = true;
      });
      for (const url of listenerUrls(s))
        expect(await refusedSoon(url), "closed while held").toBe(true);
      expect(
        await until(() => browser.live.size === 1, "context closed while held"),
      ).toBe("done");
      expect(reported, "the held wrapper is still joined").toBe(false);
      s.release.resolve("reject");
      const report = await settling;
      expect(await outcome).toBe(s.thrown[0]);
      expect(report).toEqual({
        closeErrors: [],
        reportErrors: [],
        failures: [],
        openErrors: [
          `open 1 failed at ${stage}: Error: late ${stage} rejection after acquisition`,
        ],
      });
      expect(s.seen, "no later stage began").toEqual(
        STAGES.slice(0, index + 1),
      );
      expect(lanes.lanes).toEqual([]);
      expect(browser.live).toEqual(new Set([sentinel]));
      expect(
        browser.made.slice(1).map((c) => c.closes),
        "each context closed exactly once",
      ).toEqual(index >= STAGES.indexOf("context") ? [1] : []);
      expect(lanes.snapshot()[0]?.holdings[index]).toEqual({
        stage,
        acquisition: "acquired",
        wrapper: "failed",
        disposal: DISPOSED(stage),
        wrapperError: `Error: late ${stage} rejection after acquisition`,
      });
      expect(await lanes.settle(), "repeated settlement: the same report").toBe(
        report,
      );
    });
});

describe("F25-1 Q05: a failed open while its manager stays open; the seam's contract", () => {
  it("Q05 a wrapper failing while its context's acquisition is still pending: the open fails at once; the context is closed when it arrives, without settlement; a sibling open still works", async () => {
    const browser = fakeBrowser();
    const sentinel = await browser.newContext();
    const { info } = fakeInfo();
    const deliver = deferred<"deliver" | "reject">();
    browser.hooks.deliver = deliver.promise;
    const s = seam((st, nth) =>
      st === "context" && nth === 1 ? "start-reject" : "pass",
    );
    const lanes = openTransportLanes(browser, info, {
      interpose: s.interpose,
    });
    const failure = await lanes.open({ mode: "fixture" }).catch((e) => e);
    expect(failure).toBe(s.thrown[0]);
    expect(lanes.snapshot()[0]?.holdings[3]).toMatchObject({
      stage: "context",
      acquisition: "pending",
      wrapper: "failed",
    });
    expect(browser.live.size, "made, not yet delivered").toBe(2);
    deliver.resolve("deliver");
    expect(
      await until(() => browser.live.size === 1, "closed when it arrived"),
    ).toBe("done");
    expect(lanes.state).toBe("open");
    expect(browser.made[1]?.closes).toBe(1);
    for (const url of listenerUrls(s))
      expect(await refusedSoon(url)).toBe(true);
    const sibling = await lanes.open({ mode: "fixture" });
    expect(lanes.lanes).toEqual([sibling]);
    const report = await lanes.settle();
    expect(report).toEqual({
      closeErrors: [],
      reportErrors: [],
      failures: [],
      openErrors: [
        "open 1 failed at context: Error: injected context failure while acquiring",
      ],
    });
    expect(browser.live).toEqual(new Set([sentinel]));
    expect(browser.made.slice(1).map((c) => c.closes)).toEqual([1, 1]);
    expect(lanes.late).toEqual([]);
  });
  it("Q05 the same, the pending acquisition then rejecting: recorded, observed (no unhandled rejection), nothing fabricated to close", async () => {
    const browser = fakeBrowser();
    const { info } = fakeInfo();
    const deliver = deferred<"deliver" | "reject">();
    browser.hooks.deliver = deliver.promise;
    const s = seam((st) => (st === "context" ? "start-reject" : "pass"));
    const lanes = openTransportLanes(browser, info, {
      interpose: s.interpose,
    });
    const failure = await lanes.open({ mode: "fixture" }).catch((e) => e);
    expect(failure, "the original thrown value").toBe(s.thrown[0]);
    deliver.resolve("reject");
    expect(
      await until(
        () => lanes.snapshot()[0]?.holdings[3]?.acquisition === "rejected",
        "the acquisition's rejection recorded",
      ),
    ).toBe("done");
    expect(lanes.snapshot()[0]?.holdings[3]).toEqual({
      stage: "context",
      acquisition: "rejected",
      wrapper: "failed",
      disposal: "none",
      acquisitionError: "Error: newContext failed",
      wrapperError: "Error: injected context failure while acquiring",
    });
    const report = await lanes.settle();
    expect(report.closeErrors).toEqual([]);
    expect(browser.made[0]?.closes).toBe(0);
    expect(browser.live.size).toBe(0);
  });
  it("Q05 a wrapper failing while a listener's start is in progress: the partial start is closed by the open's own unwinding (the object disposer is armed at start)", async () => {
    const browser = fakeBrowser();
    const { info } = fakeInfo();
    const s = seam((st) => (st === "witness" ? "start-reject" : "pass"));
    const lanes = openTransportLanes(browser, info, {
      interpose: s.interpose,
    });
    const failure = await lanes.open({ mode: "fixture" }).catch((e) => e);
    expect(failure, "the original thrown value").toBe(s.thrown[0]);
    const url = await s.starts[0]?.started;
    expect(await refusedSoon(url), "the started witness was closed").toBe(true);
    expect(
      await until(
        () => lanes.snapshot()[0]?.holdings[0]?.disposal === "disposed",
        "witness disposed",
      ),
    ).toBe("done");
    expect(lanes.state).toBe("open");
    expect((await lanes.settle()).closeErrors).toEqual([]);
  });
  it("Q05 a wrapper failing before acquiring but keeping its acquisition: calling it later is refused (the open failed); nothing more is acquired; a sibling open still works", async () => {
    const browser = fakeBrowser();
    const { info } = fakeInfo();
    const s = seam((st, nth) =>
      st === "front" && nth === 1 ? "retain-reject" : "pass",
    );
    const lanes = openTransportLanes(browser, info, {
      interpose: s.interpose,
    });
    const failure = await lanes.open({ mode: "fixture" }).catch((e) => e);
    expect(failure, "the original thrown value").toBe(s.thrown[0]);
    const late = await (s.retained[0]?.acquire() ?? Promise.resolve()).catch(
      (e: unknown) => e,
    );
    expect(late).toBeInstanceOf(LaneSeamMisuse);
    expect(String(late)).toBe(
      "LaneSeamMisuse: open 1 refused before front: the open has already failed",
    );
    expect(lanes.snapshot()[0]?.holdings[2]).toMatchObject({
      stage: "front",
      acquisition: "not_begun",
      wrapper: "failed",
      disposal: "none",
    });
    expect(s.handles.map((h) => h.stage)).toEqual([
      "witness",
      "scripted origin",
    ]);
    for (const url of listenerUrls(s))
      expect(await refusedSoon(url)).toBe(true);
    const sibling = await lanes.open({ mode: "fixture" });
    expect(lanes.lanes).toEqual([sibling]);
    const report = await lanes.settle();
    expect(report.openErrors).toEqual([
      "open 1 failed at front: Error: injected front failure",
    ]);
    expect(report.closeErrors).toEqual([]);
    expect(browser.made.map((c) => c.closes)).toEqual([1]);
    expect(browser.live.size).toBe(0);
  });
  for (const [step, message, made] of [
    [
      "twice",
      "LaneSeamMisuse: open 1: the context wrapper asked for its acquisition more than once (it is single-use)",
      1,
    ],
    [
      "substitute",
      "LaneSeamMisuse: open 1: the context wrapper delivered a value other than its acquisition's",
      1,
    ],
    [
      "invent",
      "LaneSeamMisuse: open 1: the context wrapper delivered without a successful acquisition (not_begun)",
      0,
    ],
  ] as const)
    it(`Q05 seam-contract negative (${step}): the stage fails by name; only the REAL acquisition is owned, and it is closed once`, async () => {
      const browser = fakeBrowser();
      const { info } = fakeInfo();
      const s = seam((st) => (st === "context" ? step : "pass"));
      const lanes = openTransportLanes(browser, info, {
        interpose: s.interpose,
      });
      const failure = await lanes.open({ mode: "fixture" }).catch((e) => e);
      expect(failure).toBeInstanceOf(LaneSeamMisuse);
      expect(String(failure)).toBe(message);
      if (step === "twice") expect(s.askedLate).toEqual([message]);
      expect(browser.made.length, "no second or invented context").toBe(made);
      expect(await until(() => browser.live.size === 0, "unwound")).toBe(
        "done",
      );
      expect(browser.made.map((c) => c.closes)).toEqual(made === 1 ? [1] : []);
      const report = await lanes.settle();
      expect(report.openErrors).toEqual([
        `open 1 failed at context: ${message}`,
      ]);
      expect(report.closeErrors).toEqual([]);
      expect(browser.made.map((c) => c.closes)).toEqual(made === 1 ? [1] : []);
    });
});

describe("F25-1 Q07–Q08: concurrent opens and managers; the fixture", () => {
  it("Q07 a published lane, a held front rejecting during settlement and a context rejected after acquisition, beside another manager: each closed once; only its own manager's; distinct teardown records", async () => {
    const browser = fakeBrowser();
    const { info, attached } = fakeInfo();
    const s = seam((st, nth) =>
      st === "front" && nth === 2
        ? "hold-after"
        : st === "context" && nth === 2
          ? "acquire-reject"
          : "pass",
    );
    const a = openTransportLanes(browser, info, { interpose: s.interpose });
    const first = await a.open({ mode: "fixture" });
    const held = a.open({ mode: "fixture" }).catch((e: unknown) => e);
    await s.reached.promise;
    await expect(a.open({ mode: "fixture" })).rejects.toThrow(
      "injected context failure after acquisition",
    );
    const other = fakeInfo();
    const b = openTransportLanes(browser, other.info);
    const kept = await b.open({ mode: "fixture" });
    expect(
      await until(() => browser.live.size === 2, "open 3's context unwound"),
    ).toBe("done");
    const settling = a.settle();
    await turns();
    s.release.resolve("reject");
    const report = await settling;
    expect(report).toEqual({
      closeErrors: [],
      reportErrors: [],
      failures: [],
      openErrors: [
        "open 2 failed at front: Error: late front rejection after acquisition",
        "open 3 failed at context: Error: injected context failure after acquisition",
      ],
    });
    expect(String(await held)).toContain(
      "late front rejection after acquisition",
    );
    expect(a.lanes).toEqual([first]);
    for (const url of listenerUrls(s)) expect(await refused(url)).toBe(true);
    expect(browser.live, "only the other manager's context remains").toEqual(
      new Set([kept.context]),
    );
    expect(await refused(kept.transport.url)).toBe(false);
    expect((await b.settle()).openErrors).toEqual([]);
    expect(browser.live.size).toBe(0);
    expect(browser.made.map((c) => c.closes)).toEqual([1, 1, 1]);
    const mine = attached.get("transport-teardown") as { manager: number };
    const theirs = other.attached.get("transport-teardown") as {
      manager: number;
    };
    expect(typeof mine.manager).toBe("number");
    expect(mine.manager, "each teardown record names its manager").not.toBe(
      theirs.manager,
    );
  });
  it("Q08 the fixture's use fails because its open failed after acquiring: the original error is the cause; the teardown names the failed open; nothing stays open", async () => {
    const browser = fakeBrowser();
    const { info } = fakeInfo();
    const s = seam((st) => (st === "context" ? "acquire-reject" : "pass"));
    const failed = runTransportLaneFixture(
      browser,
      async (open) => {
        await open({ mode: "fixture" });
      },
      info,
      { interpose: s.interpose },
    ).catch((e: unknown) => e as Error);
    const error = await failed;
    expect(String(error)).toMatch(
      /transport lane fixture: Error: injected context failure after acquisition; teardown .*open 1 failed at context: Error: injected context failure after acquisition/,
    );
    expect((error as Error).cause).toBe(s.thrown[0]);
    expect(browser.live.size).toBe(0);
    expect(browser.made.map((c) => c.closes)).toEqual([1]);
  });
});

// ---- Revision 26 (Review 31 F31-1, family native-transport-console-attribution; design assessment token 37c3b6402c…, NAV1–NAV5) -------

const S503 =
  "Failed to load resource: the server responded with a status of 503 (Service Unavailable)";
const N = `${FRONT}/api/__guard/status/503`;

/**
 * Revision 27 (F32-1, C3): `r`'s commit of `document`, WITH the provenance the recorder writes for it: a `new-document` navigation event
 * naming `r`, at the commit's sequence. A test that sets `r.commit` alone models a commit without provenance (admitted by nothing).
 */
function commitOf(
  b: ReturnType<typeof journal>,
  r: RequestRecord,
  document: number,
) {
  const seq = nextSeq(b);
  r.commit = { seq, document };
  b.j.navigations ??= [];
  b.j.navigations.push({
    seq,
    page: r.page,
    url: r.url,
    kind: "new-document",
    from: r.document,
    document,
    request: r.seq,
    reason: `committed by navigation #${r.seq}`,
  });
}
/** A navigation of `page` from `document`, answered `status` through the front, committing `commit` (or nothing when null). */
function navigated(
  b: ReturnType<typeof journal>,
  page: number,
  document: number,
  url: string,
  status: number,
  commit: number | null,
) {
  const r = b.answered(page, document, url, status);
  r.navigation = true;
  if (commit === null) r.commit = null;
  else commitOf(b, r, commit);
  return r;
}
/** The next journal sequence of `b` (a commit takes one, as the recorder's navigation event does). */
const nextSeq = (b: ReturnType<typeof journal>) => {
  const all = [
    ...b.j.problems.map((p) => p.seq),
    ...b.j.requests.flatMap((r) => [r.seq, r.terminal?.seq ?? 0]),
    ...b.j.attempts.map((a) => a.seq),
    ...b.j.expectations.map((e) => e.seq),
    ...(b.j.navigations ?? []).map((n) => n.seq),
  ];
  // The builder's own counter is private: a commit is stamped just after the latest event, and every later call is later still.
  return Math.max(0, ...all) + 0.5;
};

describe("F31-1 classifyJournal: a navigation's own HTTP-status message and the document it committed", () => {
  it("positive (Chromium's order): the declared navigation's 503, logged after its commit, is expected through that commit alone", () => {
    const b = journal();
    b.j.engine = "chromium";
    b.expectHttp("/api/__guard/status/503", 503, 1, "GET");
    const nav = navigated(b, 0, 1, N, 503, 2);
    b.problem(0, 2, "error", S503, N);
    const v = classifyJournal(b.j);
    expect(v.unexpected).toEqual([]);
    expect(v.violations).toEqual([]);
    expect(v.expected[0]?.evidence).toMatchObject({
      request: nav.seq,
      expectation: 1,
      relation: "committed-by-navigation",
    });
    expect(v.expected[0]?.reason).toMatch(
      /the navigation's own response, in the document it committed/,
    );
    expect(v.requests[0]).toMatchObject({
      document: 1,
      commit: { document: 2 },
    });
    expect(classifyJournal(b.j), "repeatable").toEqual(v);
  });
  it("positive (WebKit's order): logged before the commit, the message is its initiating document's (no commit relation needed)", () => {
    const b = journal();
    b.j.engine = "webkit";
    b.expectHttp("/api/__guard/status/503", 503, 1, "GET");
    const nav = b.answered(0, 1, N, 503);
    nav.navigation = true;
    b.problem(0, 1, "error", S503, N);
    commitOf(b, nav, 2);
    const v = classifyJournal(b.j);
    expect(v.unexpected).toEqual([]);
    expect(v.expected[0]?.evidence?.relation).toBe("same-document");
  });
  for (const engine of ["firefox", undefined])
    it(`negative: in ${engine ?? "an unknown engine"} (no navigation status is logged) a status message in the committed document is unexpected`, () => {
      const b = journal();
      if (engine !== undefined) b.j.engine = engine;
      b.expectHttp("/api/__guard/status/503", 503, 1, "GET");
      navigated(b, 0, 1, N, 503, 2);
      b.problem(0, 2, "error", S503, N);
      expect(classifyJournal(b.j).unexpected[0]?.reason).toMatch(
        /no 503 response of this page's document for this URL/,
      );
    });
  it("negative: the commit relation admits only the navigation: an old document's fetch of the same URL is not eligible in the new document, and the navigation answers once", () => {
    const b = journal();
    b.j.engine = "chromium";
    b.expectHttp("/api/__guard/status/503", 503, 2, "GET");
    b.answered(0, 1, N, 503);
    b.problem(0, 1, "error", S503, N);
    navigated(b, 0, 1, N, 503, 2);
    b.problem(0, 2, "error", S503, N);
    b.problem(0, 2, "error", S503, N);
    expect(
      classifyJournal(b.j).problems.map((p) => [p.document, p.verdict]),
    ).toEqual([
      [1, "expected"],
      [2, "expected"],
      [2, "unexpected"],
    ]);
  });
  it("negative: one navigation answers one message across BOTH its documents (WebKit's message before the commit, then the document's own forged text after it)", () => {
    const b = journal();
    b.j.engine = "webkit";
    b.expectHttp("/api/__guard/status/503", 503, 1, "GET");
    const nav = b.answered(0, 1, N, 503);
    nav.navigation = true;
    b.problem(0, 1, "error", S503, N);
    commitOf(b, nav, 2);
    b.problem(0, 2, "error", S503, N);
    expect(
      classifyJournal(b.j).problems.map((p) => [p.document, p.verdict]),
    ).toEqual([
      [1, "expected"],
      [2, "unexpected"],
    ]);
  });
  it("negative: an undeclared navigation's own status message is unexpected", () => {
    const b = journal();
    b.j.engine = "chromium";
    navigated(b, 0, 1, N, 503, 2);
    b.problem(0, 2, "error", S503, N);
    expect(classifyJournal(b.j).unexpected[0]?.reason).toMatch(
      /HTTP 503 of #\d+ GET was not declared/,
    );
  });
  it("negative: a network message cannot use a navigation's commit (only an HTTP status of its own response)", () => {
    const b = journal();
    b.j.engine = "chromium";
    const nav = b.lost(0, 1, N);
    nav.navigation = true;
    commitOf(b, nav, 2);
    b.problem(0, 2, "error", CHROMIUM, N);
    expect(classifyJournal(b.j).unexpected[0]?.reason).toMatch(
      /no failed request of this page's document/,
    );
  });
  it("negative: a later document, another page, and a message ordered before the commit cannot use the commit", () => {
    const b = journal();
    b.j.engine = "chromium";
    b.expectHttp("/api/__guard/status/503", 503, 1, "GET");
    navigated(b, 0, 1, N, 503, 2);
    b.problem(0, 3, "error", S503, N);
    b.problem(1, 2, "error", S503, N);
    const v = classifyJournal(b.j);
    expect(v.unexpected).toHaveLength(2);
    const c = journal();
    c.j.engine = "chromium";
    c.expectHttp("/api/__guard/status/503", 503, 1, "GET");
    const nav = c.answered(0, 1, N, 503);
    nav.navigation = true;
    c.problem(0, 2, "error", S503, N);
    commitOf(c, nav, 2);
    expect(
      classifyJournal(c.j).unexpected[0]?.reason,
      "the commit must precede its message",
    ).toMatch(/no 503 response of this page's document/);
  });
  it("negative: a request that is not a main-frame navigation, or a navigation that committed nothing, gets no commit relation", () => {
    for (const shape of ["not-navigation", "no-commit"] as const) {
      const b = journal();
      b.j.engine = "chromium";
      b.expectHttp("/api/__guard/status/503", 503, 1, "GET");
      const r = b.answered(0, 1, N, 503);
      r.navigation = shape === "no-commit";
      if (shape === "no-commit") r.commit = null;
      else commitOf(b, r, 2);
      b.problem(0, 2, "error", S503, N);
      expect(classifyJournal(b.j).unexpected, shape).toHaveLength(1);
    }
  });
});

describe("F32-1 classifyJournal C3: a commit admits a message only with its own new-document provenance", () => {
  const build = (
    shape:
      | "evidenced"
      | "no-event"
      | "aborted"
      | "same-document"
      | "other-request"
      | "other-sequence"
      | "other-page",
  ) => {
    const b = journal();
    b.j.engine = "chromium";
    b.expectHttp("/api/__guard/status/503", 503, 1, "GET");
    const nav = b.answered(0, 1, N, 503);
    nav.navigation = true;
    commitOf(b, nav, 2);
    const event = b.j.navigations?.[0];
    if (event === undefined) throw new Error("no event");
    if (shape === "no-event") b.j.navigations = [];
    if (shape === "aborted")
      Object.assign(event, { kind: "aborted", document: 1 });
    if (shape === "same-document")
      Object.assign(event, { kind: "same-document", document: 1 });
    if (shape === "other-request") event.request = nav.seq + 1000;
    if (shape === "other-sequence") event.seq += 0.25;
    if (shape === "other-page") event.page = 1;
    b.problem(0, 2, "error", S503, N);
    return classifyJournal(b.j);
  };
  it("positive control: a recorded new-document event naming the navigation, at its commit, admits its own message", () => {
    const v = build("evidenced");
    expect(v.unexpected).toEqual([]);
    expect(v.expected[0]?.evidence?.relation).toBe("committed-by-navigation");
  });
  for (const shape of [
    "no-event",
    "aborted",
    "same-document",
    "other-request",
    "other-sequence",
    "other-page",
  ] as const)
    it(`negative: a commit field with ${shape} provenance admits nothing (the message is unexpected)`, () => {
      expect(build(shape).unexpected[0]?.reason).toMatch(
        /no 503 response of this page's document for this URL/,
      );
    });
  it("a provenance failure the recorder named is a violation of the lane", () => {
    const b = journal();
    b.j.provenanceFailures = [
      "page 0: navigation event #4 unreadable (not an object)",
    ];
    expect(classifyJournal(b.j).violations).toEqual([
      "navigation provenance: page 0: navigation event #4 unreadable (not an object)",
    ]);
  });
});

/**
 * Revision 28 (F33-1): a CONTEXT double, as the recorder now listens (`recordContext`): its listeners receive what a Playwright client
 * context emits (network events, page announcements, and console/web errors after the page's own delivery, as Playwright's client does).
 * Each page double below is one of its pages.
 */
function recorderContext(options: { pagesAtAttach?: number } = {}) {
  const listeners = new Map<string, Array<(value: unknown) => void>>();
  // Revision 29 (F34-1): with Playwright's in-process server side (`serverSide`), as a real lane context has.
  const side = serverSide(options.pagesAtAttach ?? 0);
  const context = {
    _connection: side.connection,
    on(event: string, listener: (value: never) => void) {
      listeners.set(event, [
        ...(listeners.get(event) ?? []),
        listener as (v: unknown) => void,
      ]);
    },
  };
  side.bind(context, side.server);
  const emit = (event: string, value: unknown) => {
    for (const l of listeners.get(event) ?? []) l(value);
  };
  return { context, emit, listeners, side };
}

/**
 * A page double emitting exactly the event sequence an engine was observed to emit (revision-26 diag/order-1; revision-27 diag/order-2
 * and order-3, which also record Playwright's internal frame events; revision-28 diag popup-order-1). Its main frame carries a
 * Playwright-shaped client emitter (`_eventEmitter`) on which each navigation is delivered as Playwright's own `navigated` event
 * (`FrameNavigatedEvent`: `newDocument` with the linked request's CHANNEL, whose `_object` is the public request; `error` for an abort); a
 * commit or a same-document change is followed, as in Playwright's client, by the public `framenavigated` (an abort has none).
 * `publicOnly` emits a public `framenavigated` WITHOUT the internal event (the recorder must not move on it).
 *
 * Revision 28: its network events reach the CONTEXT's listeners (Playwright delivers them to the context, and to a page only once it
 * announced it). `announce: false` makes a POPUP not yet announced: its requests' public `frame()` throws Playwright's own refusal, their
 * client initializer still names the main frame, and `announce()` later emits the context's `page` event.
 */
function recorderPage(
  ctx: ReturnType<typeof recorderContext> = recorderContext(),
  options: { announce?: boolean; url?: string; nativeDocument?: string } = {},
) {
  const listeners = new Map<string, Array<(value: unknown) => void>>();
  let mainUrl = options.url ?? "about:blank";
  const internal = new EventEmitter();
  const main = {
    url: () => mainUrl,
    parentFrame: () => null,
    _eventEmitter: internal,
  };
  // Revision 29 (F34-1): the main frame's SERVER frame (Playwright's): its URL, its current native document and that document's server
  // request. Its commits reach the server context first; the client is sent one only once the frame has a dispatcher (its first request
  // or the page's announcement), as in Playwright.
  let nativeNo = 0;
  const serverMain = {
    url: () => mainUrl,
    parentFrame: () => null,
    _currentDocument: {
      documentId: options.nativeDocument as string | undefined,
      request: undefined as unknown,
    },
  };
  ctx.side.bind(main, serverMain);
  const page = {
    mainFrame: () => main,
    on(event: string, listener: (value: never) => void) {
      listeners.set(event, [
        ...(listeners.get(event) ?? []),
        listener as (v: unknown) => void,
      ]);
    },
  };
  const emit = (event: string, value: unknown) => {
    for (const l of listeners.get(event) ?? []) l(value);
  };
  let announced = false;
  const announce = () => {
    announced = true;
    ctx.side.dispatch(serverMain);
    ctx.emit("page", page);
  };
  if (options.announce !== false) announce();
  const channel = (r: RecordedRequest | undefined) =>
    r === undefined ? undefined : { _object: r };
  const serverCommit = (
    url: string,
    request?: RecordedRequest,
    nativeDocument?: string,
  ) => {
    mainUrl = url;
    nativeNo += 1;
    // Playwright's server holds every request a commit links (also one whose client event the recorder never received).
    if (request !== undefined && ctx.side.implOf(request) === undefined)
      ctx.side.bind(request, { request: request.url() });
    serverMain._currentDocument = {
      documentId: nativeDocument ?? `native-${nativeNo}`,
      request: request === undefined ? undefined : ctx.side.implOf(request),
    };
    const dispatched = ctx.side.isDispatched(serverMain);
    ctx.side.commit(serverMain);
    return dispatched;
  };
  const clientNavigated = (url: string, request?: RecordedRequest) => {
    mainUrl = url;
    internal.emit("navigated", {
      url,
      name: "",
      newDocument: { request: channel(request) },
    });
    emit("framenavigated", main);
  };
  const request = (
    url: string,
    options: {
      nav?: boolean;
      from?: RecordedRequest;
      failure?: string;
      frame?: unknown;
    } = {},
  ) => {
    const frame = options.frame ?? main;
    const r: RecordedRequest & {
      failed?: string;
      _initializer: { frame: { _object: unknown } };
    } = {
      method: () => "GET",
      url: () => url,
      isNavigationRequest: () => options.nav ?? true,
      frame: () => {
        if (!announced)
          throw new Error(
            "Frame for this navigation request is not available, because the request\nwas issued before the frame is created.",
          );
        return frame;
      },
      failure: () => (r.failed === undefined ? null : { errorText: r.failed }),
      redirectedFrom: () => options.from ?? null,
      _initializer: { frame: { _object: frame } },
    };
    // Revision 29: its server request (identity); the request's dispatcher creates its frame's, and its parent's.
    ctx.side.bind(r, { request: url });
    ctx.side.dispatch(serverMain);
    ctx.emit("request", r);
    return r;
  };
  return {
    page,
    main,
    internal,
    announce,
    request,
    respond: (r: RecordedRequest, status: number) =>
      ctx.emit("response", { request: () => r, status: () => status }),
    fail: (r: RecordedRequest & { failed?: string }, errorText: string) => {
      r.failed = errorText;
      ctx.emit("requestfailed", r);
    },
    finish: (r: RecordedRequest) => ctx.emit("requestfinished", r),
    /**
     * Playwright's `frameCommittedNewDocumentNavigation`: a new document, linked to `request` when Playwright linked one. Revision 29: the
     * server context observes it first; the client is sent it only if the frame has a dispatcher (Firefox's requestless popup: not).
     */
    newDocument: (url: string, request?: RecordedRequest) => {
      const dispatched = serverCommit(url, request);
      if (dispatched) clientNavigated(url, request);
    },
    /** Revision 29: ONLY the server's commit (the context event), returning whether the frame had a dispatcher (would be sent it). */
    serverCommit,
    /** Revision 29: ONLY the client's `navigated` new-document event and public framenavigated (no server commit). */
    clientNavigated,
    serverMain,
    /** Playwright's `frameCommittedSameDocumentNavigation`: a fragment or history-API change. */
    sameDocument: (url: string) => {
      mainUrl = url;
      internal.emit("navigated", { url, name: "" });
      emit("framenavigated", main);
    },
    /** Playwright's `frameAbortedNavigation`: the pending document (its request) with the error, at the frame's CURRENT url; no public event. */
    aborted: (request: RecordedRequest | undefined, error: string) =>
      internal.emit("navigated", {
        url: mainUrl,
        name: "",
        newDocument: { request: channel(request) },
        error,
      }),
    /** A public framenavigated alone (no provenance event). */
    publicOnly: (url: string) => {
      mainUrl = url;
      emit("framenavigated", main);
    },
    /** A raw internal event (shape negatives). */
    raw: (value: unknown) => internal.emit("navigated", value),
    /** Another frame's navigation: its own emitter (never the main frame's) and its public framenavigated. */
    subframe: (url: string) => {
      const frame = {
        url: () => url,
        parentFrame: () => main,
        _eventEmitter: new EventEmitter(),
      };
      frame._eventEmitter.emit("navigated", {
        url,
        name: "",
        newDocument: {},
      });
      emit("framenavigated", frame);
      return frame;
    },
    /** A console message, delivered as Playwright's client does: to the page's listeners, then to the context's (`page()` names it). */
    console: (type: string, text: string, url: string) => {
      const message = {
        type: () => type,
        text: () => text,
        location: () => ({ url }),
        page: () => page,
      };
      emit("console", message);
      ctx.emit("console", message);
    },
    /** A page error, delivered as Playwright's client does: to the context first (`weberror`), then to the page's listeners. */
    pageerror: (message: string) => {
      const error = new Error(message);
      ctx.emit("weberror", { page: () => page, error: () => error });
      emit("pageerror", error);
    },
  };
}
function recorded(engine: string, hold?: (p: Readonly<Problem>) => boolean) {
  let seq = 0;
  const j: Journal = {
    problems: [],
    requests: [],
    attempts: [],
    expectations: [],
    engine,
  };
  const held: Array<Readonly<Problem>> = [];
  const ctx = recorderContext();
  const recorder = recordContext(ctx.context, {
    journal: j,
    next: () => {
      seq += 1;
      return seq;
    },
    stamp,
    ingest: (p: Readonly<Problem>) =>
      hold?.(p) ? held.push(p) : j.problems.push(p),
  });
  const d = recorderPage(ctx);
  /** The front's record of a forwarded answer (as the transport's observer journals it, before the browser's response). */
  const forwarded = (url: string, status: number) => {
    seq += 1;
    j.attempts.push({
      seq,
      attempt: {
        seq,
        generation: 0,
        phase: "online",
        nonce: null,
        method: "GET",
        url,
        at: 0,
        outcome: "forwarded",
        status,
      },
    });
  };
  const declare = (path: string, status: number, count = 1) => {
    seq += 1;
    j.expectations.push({
      id: j.expectations.length + 1,
      seq,
      method: "GET",
      path,
      status,
      count,
      reason: "test",
    });
  };
  return { j, d, ctx, held, forwarded, declare, recorder };
}
const docs = (j: Journal) =>
  j.requests.map((r) => [
    new URL(r.url).pathname,
    r.document,
    r.commit === undefined
      ? "pending"
      : r.commit === null
        ? r.commitReason
        : r.commit.document,
  ]);
const kinds = (j: Journal) =>
  (j.navigations ?? []).map((n) => [
    n.kind,
    n.document,
    n.request === null ? null : "request",
  ]);

describe("F32-1 recordPage: the document moves on only at a new-document event of the main frame's navigation provenance", () => {
  const P = `${FRONT}/api/__guard/page`;
  it("NAV1 Chromium's order (request, response, commit, status message): the request keeps document 1, commits 2, and its message is expected", () => {
    const { j, d, forwarded, declare } = recorded("chromium");
    const first = d.request(P);
    forwarded(P, 200);
    d.respond(first, 200);
    d.newDocument(P, first);
    declare("/api/__guard/status/503", 503);
    const nav = d.request(N);
    forwarded(N, 503);
    d.respond(nav, 503);
    d.newDocument(N, nav);
    d.console("error", S503, N);
    expect(docs(j)).toEqual([
      ["/api/__guard/page", 0, 1],
      ["/api/__guard/status/503", 1, 2],
    ]);
    expect(j.problems.map((p) => p.document)).toEqual([2]);
    expect(j.provenanceFailures).toEqual([]);
    expect(j.navigationProvenance).toEqual([
      {
        page: 0,
        source: "playwright-frame-navigated",
        version: "1.63.0",
        bundleSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      },
    ]);
    const v = classifyJournal(j);
    expect(v.unexpected).toEqual([]);
    expect(v.violations).toEqual([]);
    expect(v.expected[0]?.evidence?.relation).toBe("committed-by-navigation");
  });
  it("NAV1 WebKit's order (status message between response and commit): the message is document 1's and expected", () => {
    const { j, d, forwarded, declare } = recorded("webkit");
    const first = d.request(P);
    d.respond(first, 200);
    d.newDocument(P, first);
    declare("/api/__guard/status/503", 503);
    const nav = d.request(N);
    forwarded(N, 503);
    d.respond(nav, 503);
    d.console("error", S503, N);
    d.newDocument(N, nav);
    expect(j.problems.map((p) => p.document)).toEqual([1]);
    const v = classifyJournal(j);
    expect(v.unexpected).toEqual([]);
    expect(v.violations).toEqual([]);
    expect(v.expected[0]?.evidence?.relation).toBe("same-document");
  });
  it("NAV2 a redirect chain commits ONE document, by its final hop; the hop is redirected and the final hop names it", () => {
    const { j, d } = recorded("chromium");
    const first = d.request(P);
    d.respond(first, 200);
    d.newDocument(P, first);
    const hop = d.request(`${FRONT}/api/__guard/redirect/502`);
    d.respond(hop, 302);
    const last = d.request(`${FRONT}/api/__guard/status/502`, { from: hop });
    d.respond(last, 502);
    d.newDocument(`${FRONT}/api/__guard/status/502`, last);
    expect(docs(j)).toEqual([
      ["/api/__guard/page", 0, 1],
      ["/api/__guard/redirect/502", 1, `redirected to #${j.requests[2]?.seq}`],
      ["/api/__guard/status/502", 1, 2],
    ]);
    expect(j.requests[2]?.redirectedFrom).toBe(j.requests[1]?.seq);
    expect(kinds(j)).toEqual([
      ["new-document", 1, "request"],
      ["new-document", 2, "request"],
    ]);
  });
  it("NAV2 a 204 (response, abort, failure) and WebKit's download (abort first, then two responses and a failure) commit nothing; a later same-document change to that URL is not a commit", () => {
    const { j, d } = recorded("webkit");
    const first = d.request(P);
    d.respond(first, 200);
    d.newDocument(P, first);
    const empty = d.request(`${FRONT}/api/__guard/nocontent`);
    d.respond(empty, 204);
    d.aborted(empty, "Aborted: 204 No Content");
    d.fail(empty, "Aborted: 204 No Content");
    const file = d.request(`${FRONT}/api/__guard/download`);
    d.aborted(file, "Download is starting");
    d.respond(file, 200);
    d.respond(file, 200);
    d.fail(file, "Frame load interrupted");
    d.sameDocument(`${FRONT}/api/__guard/download`);
    const fetchAfter = d.request(`${FRONT}/api/__guard/status/500`, {
      nav: false,
    });
    expect(docs(j)).toEqual([
      ["/api/__guard/page", 0, 1],
      [
        "/api/__guard/nocontent",
        1,
        "aborted without committing a document: Aborted: 204 No Content",
      ],
      [
        "/api/__guard/download",
        1,
        "aborted without committing a document: Download is starting",
      ],
      ["/api/__guard/status/500", 1, "pending"],
    ]);
    expect(j.requests[2]?.terminal).toMatchObject({
      kind: "response",
      status: 200,
    });
    expect(j.requests[2]?.failedAfterResponse?.errorText).toBe(
      "Frame load interrupted",
    );
    expect(kinds(j)).toEqual([
      ["new-document", 1, "request"],
      ["aborted", 1, "request"],
      ["aborted", 1, "request"],
      ["same-document", 1, null],
    ]);
    expect(fetchAfter.url()).toMatch(/500$/);
    expect(j.provenanceFailures).toEqual([]);
  });
  it("NAV2 reloads commit a new document each; fragments and history changes do not; a subframe's navigation and a public framenavigated alone are ignored", () => {
    const { j, d } = recorded("chromium");
    for (let i = 0; i < 3; i += 1) {
      const r = d.request(N);
      d.respond(r, 503);
      d.newDocument(N, r);
    }
    d.sameDocument(`${N}#frag`);
    d.sameDocument(`${FRONT}/api/__guard/pushed`);
    d.subframe(`${FRONT}/api/__guard/frame`);
    d.publicOnly(`${FRONT}/api/__guard/elsewhere`);
    expect(docs(j).map((x) => x[2])).toEqual([1, 2, 3]);
    expect(kinds(j)).toEqual([
      ["new-document", 1, "request"],
      ["new-document", 2, "request"],
      ["new-document", 3, "request"],
      ["same-document", 3, null],
      ["same-document", 3, null],
    ]);
  });
  it("NAV2 a failed navigation: Chromium's and Firefox's error pages are new UNATTRIBUTED documents (Playwright links no request); WebKit commits none", () => {
    for (const [engine, errorPage] of [
      ["chromium", "chrome-error://chromewebdata/"],
      ["firefox", `${FRONT}/api/__guard/reset/x`],
      ["webkit", null],
    ] as const) {
      const { j, d } = recorded(engine);
      const a = d.request(P);
      d.respond(a, 200);
      d.newDocument(P, a);
      const lostNav = d.request(`${FRONT}/api/__guard/reset/x`);
      d.aborted(lostNav, "net::ERR_EMPTY_RESPONSE");
      d.fail(lostNav, "net::ERR_EMPTY_RESPONSE");
      if (errorPage !== null) d.newDocument(errorPage);
      expect(kinds(j), engine).toEqual([
        ["new-document", 1, "request"],
        ["aborted", 1, "request"],
        ...(errorPage === null ? [] : [["new-document", 2, null]]),
      ]);
      expect(j.requests[1]?.commit, engine).toBeNull();
      expect(j.requests[1]?.terminal, engine).toMatchObject({
        kind: "failed",
      });
      expect(j.provenanceFailures, engine).toEqual([]);
    }
  });
  it("NAV-C9 supersession: Chromium aborts the held navigation before the next request; Firefox and WebKit supersede it; a later navigation of the SAME URL commits only itself", () => {
    const chromium = recorded("chromium");
    {
      const { j, d } = chromium;
      const first = d.request(P);
      d.respond(first, 200);
      d.newDocument(P, first);
      const a = d.request(`${FRONT}/api/__guard/held`);
      d.aborted(a, "net::ERR_ABORTED; maybe frame was detached?");
      d.fail(a, "net::ERR_ABORTED");
      const b = d.request(N);
      d.respond(b, 503);
      d.newDocument(N, b);
      expect(docs(j)).toEqual([
        ["/api/__guard/page", 0, 1],
        [
          "/api/__guard/held",
          1,
          "aborted without committing a document: net::ERR_ABORTED; maybe frame was detached?",
        ],
        ["/api/__guard/status/503", 1, 2],
      ]);
    }
    for (const engine of ["firefox", "webkit"]) {
      const { j, d } = recorded(engine);
      const first = d.request(P);
      d.respond(first, 200);
      d.newDocument(P, first);
      const a = d.request(`${FRONT}/api/__guard/held`);
      const a2 = d.request(`${FRONT}/api/__guard/held`);
      d.fail(a, "NS_BINDING_ABORTED");
      d.respond(a2, 200);
      d.newDocument(`${FRONT}/api/__guard/held`, a2);
      expect(docs(j), engine).toEqual([
        ["/api/__guard/page", 0, 1],
        [
          "/api/__guard/held",
          1,
          `superseded by navigation #${a2 && j.requests[2]?.seq}`,
        ],
        ["/api/__guard/held", 1, 2],
      ]);
      expect(j.provenanceFailures, engine).toEqual([]);
    }
  });
  it("NAV2 a navigation of a new page (no request linked) is a new unattributed document", () => {
    const { j, d } = recorded("chromium");
    d.newDocument(P);
    expect(j.navigations).toMatchObject([
      { kind: "new-document", document: 1, request: null },
    ]);
    expect(j.provenanceFailures).toEqual([]);
  });
  // Review 32's exact schedules (evidence/review-32/cancelled-navigation.spec.ts and cancelled-control.spec.ts), in Chromium's order
  // observed with the browser's Stop (diag/order-2: the abort event, then the request failure).
  for (const history of ["same-url", "different-url"] as const)
    it(`NAV-C1/C2 (Review 32, history to the ${history === "same-url" ? "cancelled navigation's URL" : "a different URL: the review's control"}): a stopped navigation commits nothing, and a declared delayed fetch 500 stays the surviving document's and is expected`, () => {
      const { j, d, forwarded, declare } = recorded("chromium");
      const held = `${FRONT}/api/__r32/held`;
      const first = d.request(`${FRONT}/api/__r32/page`);
      d.respond(first, 200);
      d.newDocument(`${FRONT}/api/__r32/page`, first);
      d.sameDocument(`${FRONT}/api/__r32/ordinary-history`);
      const stopped = d.request(held);
      d.aborted(stopped, "net::ERR_ABORTED; maybe frame was detached?");
      d.fail(stopped, "net::ERR_ABORTED");
      declare("/api/__r32/delayed500", 500);
      const late = d.request(`${FRONT}/api/__r32/delayed500`, { nav: false });
      d.sameDocument(
        history === "same-url" ? held : `${FRONT}/api/__r32/elsewhere`,
      );
      forwarded(`${FRONT}/api/__r32/delayed500`, 500);
      d.respond(late, 500);
      d.console(
        "error",
        "Failed to load resource: the server responded with a status of 500 (Internal Server Error)",
        `${FRONT}/api/__r32/delayed500`,
      );
      expect(kinds(j), "the stopped navigation committed nothing").toEqual([
        ["new-document", 1, "request"],
        ["same-document", 1, null],
        ["aborted", 1, "request"],
        ["same-document", 1, null],
      ]);
      expect(j.requests[1]).toMatchObject({
        document: 1,
        commit: null,
        commitReason: expect.stringMatching(
          /^aborted without committing a document/,
        ),
      });
      expect(j.problems.map((p) => [p.document, p.status])).toEqual([[1, 500]]);
      const v = classifyJournal(j);
      expect(v.violations).toEqual([]);
      expect(
        v.unexpected,
        "the declared fetch is in the surviving document",
      ).toEqual([]);
      expect(v.expected[0]?.evidence?.relation).toBe("same-document");
    });
  it("NAV-C3 history to a STILL PENDING navigation's URL (all three engines' order, diag/order-3 E1): no commit; the real commit then advances exactly once and its own message is credited", () => {
    const { j, d, forwarded, declare } = recorded("chromium");
    const first = d.request(P);
    d.respond(first, 200);
    d.newDocument(P, first);
    declare("/api/__guard/status/503", 503);
    const nav = d.request(N);
    d.sameDocument(N);
    expect(
      j.requests[1]?.commit,
      "still undecided while pending",
    ).toBeUndefined();
    forwarded(N, 503);
    d.respond(nav, 503);
    d.newDocument(N, nav);
    d.console("error", S503, N);
    expect(kinds(j)).toEqual([
      ["new-document", 1, "request"],
      ["same-document", 1, null],
      ["new-document", 2, "request"],
    ]);
    expect(j.requests[1]?.commit).toMatchObject({ document: 2 });
    const v = classifyJournal(j);
    expect(v.unexpected).toEqual([]);
    expect(v.violations).toEqual([]);
    expect(v.expected[0]?.evidence?.relation).toBe("committed-by-navigation");
  });
  it("NAV-C8 two pages: page A's abort and history leave page B's documents and attribution alone", () => {
    let seq = 0;
    const j: Journal = {
      problems: [],
      requests: [],
      attempts: [],
      expectations: [],
      engine: "chromium",
    };
    const sink = {
      journal: j,
      next: () => {
        seq += 1;
        return seq;
      },
      stamp,
      ingest: (p: Readonly<Problem>) => void j.problems.push(p),
    };
    const ctx = recorderContext();
    recordContext(ctx.context, sink);
    const a = recorderPage(ctx);
    const b = recorderPage(ctx);
    const ra = a.request(P);
    a.respond(ra, 200);
    a.newDocument(P, ra);
    const rb = b.request(P);
    b.respond(rb, 200);
    b.newDocument(P, rb);
    const held = a.request(N);
    const other = b.request(N);
    a.aborted(held, "net::ERR_ABORTED");
    a.sameDocument(N);
    b.respond(other, 503);
    b.newDocument(N, other);
    expect(
      (j.navigations ?? []).map((n) => [n.page, n.kind, n.document]),
    ).toEqual([
      [0, "new-document", 1],
      [1, "new-document", 1],
      [0, "aborted", 1],
      [0, "same-document", 1],
      [1, "new-document", 2],
    ]);
    expect(
      j.requests.map((r) => [
        r.page,
        r.commit === null ? "ended" : r.commit?.document,
      ]),
    ).toEqual([
      [0, 1],
      [1, 1],
      [0, "ended"],
      [1, 2],
    ]);
    expect(j.provenanceFailures).toEqual([]);
  });
  it("revision 19's schedule (the review's): a fetch control, then the declared navigation; nothing is unexpected", () => {
    const { j, d, forwarded, declare } = recorded("chromium");
    const first = d.request(P);
    d.respond(first, 200);
    d.newDocument(P, first);
    declare("/api/__guard/status/500", 500);
    const f = d.request(`${FRONT}/api/__guard/status/500`, { nav: false });
    forwarded(`${FRONT}/api/__guard/status/500`, 500);
    d.respond(f, 500);
    d.console(
      "error",
      "Failed to load resource: the server responded with a status of 500 (Internal Server Error)",
      `${FRONT}/api/__guard/status/500`,
    );
    declare("/api/__guard/status/503", 503);
    const nav = d.request(N);
    forwarded(N, 503);
    d.respond(nav, 503);
    d.newDocument(N, nav);
    d.console("error", S503, N);
    const v = classifyJournal(j);
    expect(
      v.unexpected,
      "the navigation's own message belongs to the document it committed",
    ).toEqual([]);
    expect(v.expected.map((p) => [p.document, p.evidence?.relation])).toEqual([
      [1, "same-document"],
      [2, "committed-by-navigation"],
    ]);
  });
  it("NAV5 the envelope: frozen at the native listener, with the document of that moment, whenever it reaches the journal", () => {
    const { j, d, held } = recorded("chromium", () => true);
    const first = d.request(P);
    d.respond(first, 200);
    d.newDocument(P, first);
    d.console("error", CHROMIUM, `${FRONT}/x`);
    const next = d.request(N);
    d.respond(next, 200);
    d.newDocument(N, next);
    expect(held).toHaveLength(1);
    expect(Object.isFrozen(held[0])).toBe(true);
    expect(Object.isFrozen(held[0]?.observed)).toBe(true);
    expect(
      held[0]?.document,
      "the document when the listener received it",
    ).toBe(1);
    expect(j.problems).toEqual([]);
  });
});

describe("F32-1 navigation provenance: unavailable, unreadable or contradicting evidence fails by name, and the document is never guessed", () => {
  const P = `${FRONT}/api/__guard/page`;
  it("a page whose main frame has no Playwright client emitter: provenance unavailable, a lane violation; its documents never move", () => {
    let seq = 0;
    const j: Journal = {
      problems: [],
      requests: [],
      attempts: [],
      expectations: [],
    };
    const listeners = new Map<string, (v: unknown) => void>();
    // Revision 28 adaptation (F33-1): announced as an explicit page is (about:blank, its initial empty document; revision 27 used P, which
    // is now ALSO the named "first met already showing a document" gap, qualified separately below). The intent is unchanged.
    const main = { url: () => "about:blank", parentFrame: () => null };
    const ctx = recorderContext();
    // Revision 29 adaptation (F34-1): its server frame exists (Playwright's), showing its initial document; only the CLIENT emitter is missing.
    ctx.side.bind(main, {
      url: () => "about:blank",
      parentFrame: () => null,
      _currentDocument: { documentId: undefined, request: undefined },
    });
    recordContext(ctx.context, {
      journal: j,
      next: () => {
        seq += 1;
        return seq;
      },
      stamp,
      ingest: (p) => void j.problems.push(p),
    });
    ctx.emit("page", {
      mainFrame: () => main,
      on: (event: string, listener: (value: never) => void) => {
        listeners.set(event, listener as (v: unknown) => void);
      },
    });
    listeners.get("framenavigated")?.(main);
    expect(j.navigationProvenance).toEqual([
      {
        page: 0,
        unavailable: expect.stringMatching(
          /no Playwright client navigation emitter/,
        ),
      },
    ]);
    expect(classifyJournal(j).violations).toEqual([
      expect.stringMatching(
        /^navigation provenance: page 0: navigation provenance unavailable/,
      ),
    ]);
    expect(j.navigations).toEqual([]);
  });
  it("observeNavigations refuses another installed Playwright version, and its disposer detaches exactly its own listener", () => {
    const emitter = new EventEmitter();
    const refused = observeNavigations(
      { _eventEmitter: emitter },
      () => undefined,
      {
        version: "1.62.0",
        bundleSha256: null,
        error: null,
      },
    );
    expect(refused).toEqual({
      ok: false,
      reason: expect.stringMatching(
        /qualified for playwright-core 1\.63\.0 only; installed: 1\.62\.0/,
      ),
    });
    expect(emitter.listenerCount("navigated")).toBe(0);
    const other = () => undefined;
    emitter.on("navigated", other);
    const seen: unknown[] = [];
    const sub = observeNavigations(
      { _eventEmitter: emitter },
      (e) => void seen.push(e),
    );
    expect(sub.ok).toBe(true);
    expect(emitter.listenerCount("navigated")).toBe(2);
    emitter.emit("navigated", { url: P, name: "" });
    if (sub.ok) {
      sub.dispose();
      sub.dispose();
    }
    emitter.emit("navigated", { url: P, name: "" });
    expect(seen).toHaveLength(1);
    expect(emitter.listeners("navigated")).toEqual([other]);
    expect(installedPlaywrightCore()).toMatchObject({
      version: "1.63.0",
      error: null,
    });
  });
  it("readNavigated reads Playwright's three kinds and refuses other shapes", () => {
    const r = { url: () => P };
    expect(
      readNavigated({
        url: P,
        name: "",
        newDocument: { request: { _object: r } },
      }),
    ).toEqual({
      ok: true,
      kind: "new-document",
      url: P,
      request: r,
    });
    expect(readNavigated({ url: P, name: "", newDocument: {} })).toMatchObject({
      kind: "new-document",
      request: null,
    });
    expect(readNavigated({ url: P, name: "" })).toMatchObject({
      kind: "same-document",
      request: null,
    });
    expect(
      readNavigated({
        url: P,
        name: "",
        newDocument: { request: { _object: r } },
        error: "x",
      }),
    ).toMatchObject({ kind: "aborted", request: r, error: "x" });
    for (const bad of [
      null,
      "x",
      { name: "" },
      { url: P, error: 3 },
      { url: P, newDocument: 1 },
      { url: P, newDocument: { request: r } },
    ])
      expect(readNavigated(bad), JSON.stringify(bad)).toMatchObject({
        ok: false,
      });
  });
  it("an unreadable event, a request never recorded, a commit of an ended request and an abort of a committed one are each named; nothing is attributed through them", () => {
    const { j, d } = recorded("chromium");
    const first = d.request(P);
    d.respond(first, 200);
    d.newDocument(P, first);
    d.raw({ url: 7 });
    const stranger = {
      method: () => "GET",
      url: () => N,
      isNavigationRequest: () => true,
      frame: () => d.page.mainFrame(),
      failure: () => null,
      redirectedFrom: () => null,
    };
    d.newDocument(N, stranger);
    const stopped = d.request(N);
    d.aborted(stopped, "net::ERR_ABORTED");
    d.newDocument(N, stopped);
    d.aborted(first, "late");
    expect(j.provenanceFailures).toEqual([
      expect.stringMatching(
        /navigation event #\d+ unreadable \(no string url\)/,
      ),
      expect.stringMatching(
        /navigation event #\d+ \(new-document\) names a request this page's recorder never saw/,
      ),
      expect.stringMatching(
        /commits a new document for request #\d+, which had already ended \(aborted without committing a document: net::ERR_ABORTED\)/,
      ),
      expect.stringMatching(
        /aborts request #\d+, which had committed document 1/,
      ),
    ]);
    expect(kinds(j)).toEqual([
      ["new-document", 1, "request"],
      ["unreadable", 1, null],
      ["new-document", 2, null],
      ["aborted", 2, "request"],
      ["new-document", 3, null],
      ["aborted", 3, "request"],
    ]);
    expect(j.requests[1]?.commit, "never re-attributed").toBeNull();
    expect(classifyJournal(j).violations).toHaveLength(4);
  });
  it("NAV-C2 a new document Playwright links to no request, while a navigation is pending, is unattributed; the pending navigation commits only at its own event", () => {
    const { j, d } = recorded("chromium");
    const first = d.request(P);
    d.respond(first, 200);
    d.newDocument(P, first);
    const pending = d.request(N);
    d.newDocument(`${FRONT}/api/__guard/requestless`);
    expect(
      j.requests[1]?.commit,
      "not backfilled from the pending navigation",
    ).toBeUndefined();
    d.respond(pending, 503);
    d.newDocument(N, pending);
    expect(kinds(j)).toEqual([
      ["new-document", 1, "request"],
      ["new-document", 2, null],
      ["new-document", 3, "request"],
    ]);
    expect(j.requests[1]?.commit).toMatchObject({ document: 3 });
    expect(j.provenanceFailures).toEqual([]);
  });
  it("the request link is by IDENTITY, never by URL: an event naming the superseded earlier request of a URL is a named failure, and the later request of that URL stays undecided", () => {
    const { j, d } = recorded("firefox");
    const first = d.request(P);
    d.respond(first, 200);
    d.newDocument(P, first);
    const a = d.request(N);
    d.request(N);
    d.newDocument(N, a);
    expect(j.provenanceFailures).toEqual([
      expect.stringMatching(
        /commits a new document for request #\d+, which had already ended \(superseded by navigation #\d+\)/,
      ),
    ]);
    expect(
      j.requests[2]?.commit,
      "the later request of the URL is not credited",
    ).toBeUndefined();
    expect(kinds(j).at(-1)).toEqual(["new-document", 2, null]);
  });
  it("the recorder's disposer detaches its provenance listener", () => {
    const { d, recorder } = recorded("chromium");
    expect(d.internal.listenerCount("navigated")).toBe(1);
    recorder.dispose();
    expect(d.internal.listenerCount("navigated")).toBe(0);
  });
});
describe("F31-1 the ingestion seam and the seal (C4)", () => {
  /** A browser double whose context reports its engine and gives the lane one page double (driven by the case). */
  function seamBrowser() {
    // Revision 28: the context double receives ALL of the lane's context listeners (its capture registry's, attached as it arrives).
    const ctx = recorderContext();
    const pages: Array<ReturnType<typeof recorderPage>> = [];
    let front = "";
    const browser = {
      newContext: (async (options?: { baseURL?: string }) => {
        front = options?.baseURL ?? "";
        // Revision 29 adaptation (F34-1): with the in-process server side every real lane context has.
        const made = {
          _connection: ctx.context._connection,
          on: ctx.context.on,
          addInitScript: async () => undefined,
          close: async () => undefined,
          browser: () => ({ browserType: () => ({ name: () => "chromium" }) }),
        };
        ctx.side.bind(made, ctx.side.server);
        return made;
      }) as unknown as Browser["newContext"],
    };
    const page = () => {
      const d = recorderPage(ctx);
      pages.push(d);
      return d;
    };
    // The lane's REAL front origin (its context's baseURL): the lane's own foreign-origin guard now sees every request of the context.
    return { browser, page, pages, front: () => front };
  }
  const P = `${FRONT}/api/__guard/page`;
  it("held then released before settlement: classified with its listener-time document; the engine is the context's", async () => {
    const { browser, page, front } = seamBrowser();
    const { info } = fakeInfo();
    const holds: Array<() => void> = [];
    const lanes = openTransportLanes(browser, info, {
      ingest: (_p, deliver) => void holds.push(deliver),
    });
    const lane = await lanes.open({ mode: "fixture" });
    expect(lane.journal.engine).toBe("chromium");
    const d = page();
    // Revision 28 adaptation: the page's URL is on the lane's real front (its context's requests now reach the lane's foreign guard).
    const Q = `${front()}/api/__guard/page`;
    const r = d.request(Q);
    d.respond(r, 200);
    d.newDocument(Q, r);
    d.console("warning", "held warning", Q);
    d.newDocument(`${FRONT}/elsewhere`);
    expect(lane.heldProblems()).toHaveLength(1);
    expect(lane.journal.problems).toEqual([]);
    for (const deliver of holds.splice(0)) deliver();
    expect(lane.journal.problems.map((p) => [p.document, p.type])).toEqual([
      [1, "warning"],
    ]);
    expect(d.internal.listenerCount("navigated")).toBe(1);
    const report = await lanes.settle();
    expect(report.failures).toEqual([
      expect.stringMatching(
        /^lane 0 page 0 document 1 warning \[warning\]: held warning \(a warning always fails\)$/,
      ),
    ]);
    expect(
      d.internal.listenerCount("navigated"),
      "revision 27: the seal detached the page's navigation provenance",
    ).toBe(0);
  });
  it("held through settlement: the report fails by name; a delivery after the seal is late and never classified; a second delivery is misuse", async () => {
    const { browser, page } = seamBrowser();
    const { info, attached } = fakeInfo();
    const holds: Array<() => void> = [];
    const lateLines: string[] = [];
    const lanes = openTransportLanes(browser, info, {
      ingest: (_p, deliver) => void holds.push(deliver),
      onLate: (l) => void lateLines.push(l),
    });
    const lane = await lanes.open({ mode: "fixture" });
    const d = page();
    d.console("error", CHROMIUM, P);
    const report = await lanes.settle();
    expect(report.failures).toEqual([
      expect.stringMatching(
        /^lane 0: a console problem captured at journal #\d+ \(page 0 document 0 error\) was still held by the ingestion seam when the journal was classified/,
      ),
    ]);
    const [deliver] = holds;
    deliver?.();
    expect(lane.journal.problems, "never classified after the seal").toEqual(
      [],
    );
    expect(lane.journal.late).toHaveLength(1);
    expect(lanes.late).toEqual([
      expect.stringMatching(
        /delivered after the lane's journal was classified; not classified/,
      ),
    ]);
    expect(lateLines).toEqual(lanes.late);
    expect(attached.has("transport-ledger-0")).toBe(true);
    deliver?.();
    expect(lane.seal()).toEqual([
      expect.stringMatching(/delivered journal #\d+ more than once/),
    ]);
  });
  it("released during settlement (closing, before the seal): classified normally", async () => {
    const { browser, page } = seamBrowser();
    const { info } = fakeInfo();
    const holds: Array<() => void> = [];
    const lanes = openTransportLanes(browser, info, {
      ingest: (_p, deliver) => void holds.push(deliver),
    });
    const lane = await lanes.open({ mode: "fixture" });
    page().console("warning", "during", P);
    const settling = lanes.settle();
    for (const deliver of holds.splice(0)) deliver();
    const report = await settling;
    expect(report.failures).toEqual([
      expect.stringMatching(/during \(a warning always fails\)$/),
    ]);
    expect(lane.journal.late ?? []).toEqual([]);
  });
  it("a seam that throws: the envelope is delivered at once and the misuse fails the report", async () => {
    const { browser, page } = seamBrowser();
    const { info } = fakeInfo();
    const lanes = openTransportLanes(browser, info, {
      ingest: () => {
        throw new Error("seam broke");
      },
    });
    const lane = await lanes.open({ mode: "fixture" });
    page().console("warning", "thrown", P);
    expect(lane.journal.problems).toHaveLength(1);
    const report = await lanes.settle();
    expect(report.failures).toContainEqual(
      expect.stringMatching(
        /the ingestion seam threw for journal #\d+: Error: seam broke/,
      ),
    );
  });
  it("without a seam: delivered at once, nothing held", async () => {
    const { browser, page } = seamBrowser();
    const { info } = fakeInfo();
    const lanes = openTransportLanes(browser, info);
    const lane = await lanes.open({ mode: "fixture" });
    page().console("warning", "direct", P);
    expect(lane.journal.problems).toHaveLength(1);
    expect(lane.heldProblems()).toEqual([]);
    await lanes.settle();
  });
});

// ---- Revision 28 (Review 33 F33-1, family native-transport-console-attribution; design assessment token 98d2410c…, C1–C3/C5, CAP1–CAP7) ---

describe("F33-1 recordContext: a popup's first request, response and commit precede its announcement and are still its own", () => {
  const P = `${FRONT}/api/__guard/page`;
  /** An opener (page 0, announced as an explicit page is) and a popup Playwright has NOT announced yet (diag popup-order-1). */
  function withPopup(engine: string) {
    const r = recorded(engine);
    const opened = r.d.request(P);
    r.d.respond(opened, 200);
    r.d.newDocument(P, opened);
    const popup = recorderPage(r.ctx, { announce: false, url: "" });
    return { ...r, popup };
  }
  it("CAP1 Chromium's observed popup order (request, response 503, commit, THEN the page, then its status message): one request of page 1, its commit, its message credited once", () => {
    const { j, popup, forwarded, declare } = withPopup("chromium");
    declare("/api/__guard/status/503", 503);
    const nav = popup.request(N);
    forwarded(N, 503);
    popup.respond(nav, 503);
    popup.newDocument(N, nav);
    popup.announce();
    popup.console("error", S503, N);
    expect(j.pages).toEqual([
      { page: 0, via: "page", firstUrl: "about:blank", announced: true },
      { page: 1, via: "request", firstUrl: "", announced: true },
    ]);
    // Revision 29 adaptation (F34-1): each server-observed activation now takes its own journal sequence just before the client's
    // commit event (opener: activation #3, commit #4; popup: activation #9, commit #10). Same commits, documents and order.
    expect(
      j.requests.map((r) => [r.page, r.document, r.navigation, r.commit]),
    ).toEqual([
      [0, 0, true, { seq: 4, document: 1 }],
      [1, 0, true, { seq: 10, document: 1 }],
    ]);
    expect(
      j.activations?.map((a) => [
        a.seq,
        a.page,
        a.kind,
        a.dispatched,
        a.pairedWith,
      ]),
    ).toEqual([
      [3, 0, "new-document", true, 4],
      [9, 1, "new-document", true, 10],
    ]);
    expect(j.navigations?.map((n) => [n.page, n.kind, n.document])).toEqual([
      [0, "new-document", 1],
      [1, "new-document", 1],
    ]);
    expect(j.navigationProvenance?.map((p) => p.page)).toEqual([0, 1]);
    expect(j.provenanceFailures).toEqual([]);
    const v = classifyJournal(j);
    expect(v.violations).toEqual([]);
    expect(v.unexpected).toEqual([]);
    expect(
      v.expected.map((p) => [p.page, p.document, p.evidence?.relation]),
    ).toEqual([[1, 1, "committed-by-navigation"]]);
    expect(v.expectations.map((e) => e.matched.length)).toEqual([1]);
  });
  it("CAP1 the page announced while its request is still held: the announcement binds the SAME record (no second page, nothing renumbered or re-stamped)", () => {
    const { j, popup } = withPopup("webkit");
    const nav = popup.request(N);
    const before = structuredClone(j.requests[1]);
    popup.announce();
    popup.respond(nav, 503);
    popup.newDocument(N, nav);
    expect(j.pages?.map((p) => [p.page, p.via, p.announced])).toEqual([
      [0, "page", true],
      [1, "request", true],
    ]);
    expect(j.requests).toHaveLength(2);
    expect(j.requests[1]).toMatchObject({
      seq: before?.seq,
      page: 1,
      document: 0,
      observed: before?.observed,
      commit: { document: 1 },
    });
    expect(j.provenanceFailures).toEqual([]);
  });
  it("CAP2 a popup's redirect chain and a later reload: only the final hop commits, the hop is redirected, the reload commits document 2", () => {
    const { j, popup } = withPopup("chromium");
    const hop = popup.request(`${FRONT}/api/__guard/redirect`);
    popup.respond(hop, 302);
    const final = popup.request(N, { from: hop });
    popup.respond(final, 503);
    popup.newDocument(N, final);
    popup.announce();
    const reload = popup.request(N);
    popup.respond(reload, 503);
    popup.newDocument(N, reload);
    expect(
      j.requests
        .filter((r) => r.page === 1)
        .map((r) => [
          r.document,
          r.commit === null ? r.commitReason : r.commit?.document,
        ]),
    ).toEqual([
      [0, expect.stringMatching(/^redirected to #\d+$/)],
      [0, 1],
      [1, 2],
    ]);
    expect(j.provenanceFailures).toEqual([]);
  });
  it("CAP4 the opener and the popup fetch the same URL: two records, one per page by frame identity; neither is credited to the other", () => {
    const { j, d, popup } = withPopup("chromium");
    const mine = d.request(N, { nav: false });
    const theirs = popup.request(N);
    popup.respond(theirs, 503);
    d.respond(mine, 503);
    popup.newDocument(N, theirs);
    popup.announce();
    expect(
      j.requests.slice(1).map((r) => [r.page, r.document, r.navigation]),
    ).toEqual([
      [0, 1, false],
      [1, 0, true],
    ]);
    expect(j.requests[1]?.commit).toBeUndefined();
    expect(j.requests[2]?.commit).toMatchObject({ document: 1 });
  });
  it("CAP4 a subframe's request belongs to its page (by its frame's top frame) and is never a main-frame navigation", () => {
    const { j, d } = recorded("chromium");
    const sub = d.subframe(`${FRONT}/frame`);
    const r = d.request(`${FRONT}/frame`, { frame: sub });
    d.respond(r, 200);
    expect(j.requests.map((x) => [x.page, x.navigation])).toEqual([[0, false]]);
    expect(j.provenanceFailures).toEqual([]);
  });
  it("CAP6 a page error and a console error Playwright delivers BEFORE it announces the page reach only the context: recorded once, with that page and its document; after the announcement, once each through the page", () => {
    const { j, popup } = withPopup("webkit");
    const nav = popup.request(P);
    popup.respond(nav, 200);
    popup.newDocument(P, nav);
    popup.pageerror("early page error");
    popup.console("error", "early console error", P);
    popup.announce();
    popup.pageerror("later page error");
    popup.console("warning", "later warning", P);
    expect(j.problems.map((p) => [p.page, p.document, p.type, p.text])).toEqual(
      [
        [1, 1, "pageerror", "early page error"],
        [1, 1, "error", "early console error"],
        [1, 1, "pageerror", "later page error"],
        [1, 1, "warning", "later warning"],
      ],
    );
    expect(j.pages?.map((p) => [p.page, p.via])).toEqual([
      [0, "page"],
      [1, "request"],
    ]);
  });
  it("CAP6 a problem of a page met first through that problem: numbered then, bound to the same record at its announcement", () => {
    const { j } = recorded("webkit");
    const ctx2 = recorderContext();
    const j2: Journal = {
      problems: [],
      requests: [],
      attempts: [],
      expectations: [],
    };
    let seq = 0;
    recordContext(ctx2.context, {
      journal: j2,
      next: () => {
        seq += 1;
        return seq;
      },
      stamp,
      ingest: (p) => void j2.problems.push(p),
    });
    const quiet = recorderPage(ctx2, { announce: false });
    quiet.pageerror("before announcement");
    quiet.announce();
    quiet.pageerror("after announcement");
    expect(j2.problems.map((p) => [p.page, p.document, p.text])).toEqual([
      [0, 0, "before announcement"],
      [0, 0, "after announcement"],
    ]);
    expect(j2.pages).toEqual([
      { page: 0, via: "problem", firstUrl: "about:blank", announced: true },
    ]);
    expect(j.pages).toHaveLength(1);
  });
});

describe("F33-1 recordContext: missing, contradictory or unidentifiable provenance fails by name; nothing is invented", () => {
  const P = `${FRONT}/api/__guard/page`;
  it("CAP7 a page first met already showing a document (an activation the recorder did not see): a named failure, and no commit is invented", () => {
    const { j, ctx } = recorded("chromium");
    recorderPage(ctx, { url: P });
    expect(j.provenanceFailures).toEqual([
      expect.stringMatching(
        /^page 1: first met \(at its announcement\) already showing http:\/\/127\.0\.0\.1:9\/api\/__guard\/page: an earlier document activation was not observed/,
      ),
    ]);
    expect(j.navigations).toEqual([]);
    expect(classifyJournal(j).violations).toEqual([
      expect.stringMatching(/^navigation provenance: page 1: first met/),
    ]);
  });
  it("CAP7 a response, a failure and an end of a request the recorder never saw are named failures, never silently dropped", () => {
    const { j, ctx } = recorded("chromium");
    const ghost: RecordedRequest = {
      method: () => "GET",
      url: () => `${FRONT}/ghost`,
      isNavigationRequest: () => false,
      frame: () => null,
      failure: () => ({ errorText: "net::ERR_FAILED" }),
      redirectedFrom: () => null,
    };
    ctx.emit("response", { request: () => ghost, status: () => 200 });
    ctx.emit("requestfailed", ghost);
    ctx.emit("requestfinished", ghost);
    expect(j.provenanceFailures).toEqual([
      expect.stringMatching(
        /^a response \(journal #\d+, status 200\) to a request the recorder never saw: GET http:\/\/127\.0\.0\.1:9\/ghost$/,
      ),
      expect.stringMatching(
        /^a request failure \(journal #\d+\) of a request the recorder never saw: GET /,
      ),
      expect.stringMatching(
        /^a request end \(journal #\d+\) of a request the recorder never saw: GET /,
      ),
    ]);
    expect(j.requests).toEqual([]);
  });
  it("CAP7 a navigation event naming ANOTHER page's request: a named failure; the request is not committed by it", () => {
    const { j, d, ctx } = recorded("chromium");
    const other = recorderPage(ctx);
    const r = d.request(P);
    other.newDocument(P, r);
    expect(j.provenanceFailures).toEqual([
      expect.stringMatching(
        /^page 1: navigation event #\d+ \(new-document\) names request #\d+, which is page 0's$/,
      ),
    ]);
    expect(j.requests[0]?.commit).toBeUndefined();
    expect(kinds(j)).toEqual([["new-document", 1, null]]);
  });
  it("CAP7 a request whose frame cannot be identified fails by name; a service worker's request (no frame) is recorded apart, unclassified, with no failure", () => {
    const { j, ctx } = recorded("chromium");
    const base = {
      method: () => "GET",
      isNavigationRequest: () => false,
      failure: () => null,
      redirectedFrom: () => null,
    };
    ctx.emit("request", {
      ...base,
      url: () => `${FRONT}/sw`,
      frame: () => {
        throw new Error(
          "Service Worker requests do not have an associated frame.",
        );
      },
      serviceWorker: () => ({}),
    });
    ctx.emit("request", {
      ...base,
      url: () => `${FRONT}/lost`,
      frame: () => {
        throw new Error("Frame for this navigation request is not available");
      },
    });
    ctx.emit("request", {
      ...base,
      url: () => `${FRONT}/orphan`,
      frame: () => ({ url: () => "" }),
    });
    expect(j.requests).toEqual([]);
    expect(
      j.unattributedRequests?.map((r) => [
        new URL(r.url).pathname,
        r.page,
        r.unattributed,
      ]),
    ).toEqual([
      ["/sw", -1, "a service worker's request (it has no frame)"],
      ["/lost", -1, expect.stringMatching(/no readable client initializer/)],
      ["/orphan", -1, "a frame without parentFrame()"],
    ]);
    expect(j.provenanceFailures).toEqual([
      expect.stringMatching(
        /^request #\d+ GET http:\/\/127\.0\.0\.1:9\/lost: its page cannot be identified/,
      ),
      expect.stringMatching(
        /^request #\d+ GET http:\/\/127\.0\.0\.1:9\/orphan: its page cannot be identified \(a frame without parentFrame\(\)\)/,
      ),
    ]);
  });
  it("frameOfRequest reads the client initializer frame only for Playwright's own refusal and only under the pinned version", () => {
    const frame = { url: () => "", parentFrame: () => null };
    const early = {
      method: () => "GET",
      url: () => P,
      isNavigationRequest: () => true,
      frame: () => {
        throw new Error("Frame for this navigation request is not available");
      },
      failure: () => null,
      redirectedFrom: () => null,
      _initializer: { frame: { _object: frame } },
    };
    expect(frameOfRequest(early)).toEqual({ ok: true, frame, early: true });
    expect(
      frameOfRequest(early, {
        version: "1.62.0",
        bundleSha256: null,
        error: null,
      }),
    ).toEqual({
      ok: false,
      reason: expect.stringMatching(
        /read only under playwright-core 1\.63\.0 \(installed: 1\.62\.0\)$/,
      ),
    });
    expect(frameOfRequest({ ...early, frame: () => frame })).toEqual({
      ok: true,
      frame,
      early: false,
    });
  });
  it("the disposer detaches every page's provenance once and reports a failing detachment by name; later events are late, never recorded", () => {
    const { j, d, ctx, recorder } = recorded("chromium");
    const popup = recorderPage(ctx, { announce: false, url: "" });
    popup.request(N);
    expect(d.internal.listenerCount("navigated")).toBe(1);
    expect(popup.internal.listenerCount("navigated")).toBe(1);
    popup.main._eventEmitter.off = () => {
      throw new Error("detach refused");
    };
    expect(recorder.dispose()).toEqual([
      expect.stringMatching(
        /^page 1: detaching its navigation provenance failed: Error: detach refused$/,
      ),
    ]);
    expect(d.internal.listenerCount("navigated")).toBe(0);
    expect(recorder.dispose(), "single use").toEqual([]);
    const requests = j.requests.length;
    d.request(P);
    popup.announce();
    expect(j.requests).toHaveLength(requests);
    expect(j.lateEvents).toEqual([
      `a request (GET ${P}) delivered after the recorder was detached; not recorded`,
      "a page announcement delivered after the recorder was detached; not recorded",
    ]);
  });
});

describe("F33-1 C5 the capture registry is owned with its context", () => {
  it("C5 an open failing after its context arrived: the open's own disposal of the context detaches the capture it attached (nothing published, no seal)", async () => {
    const ctx = recorderContext();
    let popup: ReturnType<typeof recorderPage> | undefined;
    let closed = 0;
    const browser = {
      newContext: (async () => ({
        on: ctx.context.on,
        addInitScript: async () => {
          // A page of the context already met (its first request) when the open fails.
          popup = recorderPage(ctx, { announce: false, url: "" });
          popup.request(`${FRONT}/early`);
          throw new Error("init script failed");
        },
        close: async () => {
          closed += 1;
        },
        browser: () => ({ browserType: () => ({ name: () => "chromium" }) }),
      })) as unknown as Browser["newContext"],
    };
    const { info } = fakeInfo();
    const lanes = openTransportLanes(browser, info);
    await expect(lanes.open({ mode: "fixture" })).rejects.toThrow(
      /init script failed/,
    );
    const report = await lanes.settle();
    expect(closed, "the context was closed once").toBe(1);
    expect(report.closeErrors).toEqual([]);
    expect(
      popup?.internal.listenerCount("navigated"),
      "detached by the context's own disposal",
    ).toBe(0);
  });
});

// ---- Revision 29 (Review 34 F34-1, family native-transport-console-attribution; design assessment token 5b499855…, C1–C5, Q1) --------

describe("F34-1 the activation source: an activation Playwright never dispatched is still the page's (observed orders, revision-29 diag/activation-boundary-1)", () => {
  const P = `${FRONT}/api/__guard/page`;
  const B = "blob:http://127.0.0.1:9/0a6f2c1e-0000-4000-8000-000000000034";
  /** An opener (page 0) with its HTTP document, and a popup double Playwright has not announced and holds no dispatcher for. */
  function withOpener(engine: string) {
    const r = recorded(engine);
    const opened = r.d.request(P);
    r.d.respond(opened, 200);
    r.d.newDocument(P, opened);
    const popup = recorderPage(r.ctx, { announce: false, url: "" });
    return { ...r, popup };
  }
  const page1 = (j: Journal) => ({
    activations: (j.activations ?? [])
      .filter((a) => a.page === 1)
      .map((a) => [
        a.kind,
        a.url,
        a.request,
        a.dispatched,
        a.pairedWith ?? null,
      ]),
    navigations: (j.navigations ?? [])
      .filter((n) => n.page === 1)
      .map((n) => [n.kind, n.from, n.document, n.request, n.url]),
  });

  it("CAP3-F34 Firefox's native blob popup (requestless commit BEFORE the page exists for the client, then the page announced at the blob): one requestless activation of page 1, document 1, nothing missing", () => {
    const { j, popup } = withOpener("firefox");
    const before = j.activations?.length ?? 0;
    expect(
      popup.serverCommit(B),
      "undispatched: Playwright sends the client nothing",
    ).toBe(false);
    expect(j.activations?.slice(before)).toEqual([
      expect.objectContaining({
        page: -1,
        kind: "new-document",
        url: B,
        request: "none",
        dispatched: false,
      }),
    ]);
    const activation = j.activations?.at(-1);
    popup.announce();
    popup.console("error", "a genuine error of the blob document", B);
    expect(j.pages?.[1]).toEqual({
      page: 1,
      via: "page",
      firstUrl: B,
      announced: true,
    });
    expect(page1(j)).toEqual({
      activations: [["new-document", B, "none", false, null]],
      navigations: [["new-document", 0, 1, null, B]],
    });
    const navigation = j.navigations?.find((n) => n.page === 1);
    expect(
      navigation?.seq,
      "applied at its OWN server sequence, never re-stamped",
    ).toBe(activation?.seq);
    expect(navigation?.reason).toMatch(
      /^a requestless new document, committed before Playwright dispatched its frame/,
    );
    expect(
      j.requests.filter((r) => r.page === 1),
      "no request invented",
    ).toEqual([]);
    expect(j.problems.at(-1)).toMatchObject({ page: 1, document: 1 });
    expect(j.provenanceFailures).toEqual([]);
    expect(j.activationSource).toMatchObject({
      source: "playwright-server-context",
      pagesAtAttach: 0,
    });
  });
  it("CAP3-F34 control, Firefox's explicit page: its initial about:blank commit (undispatched) is document 0, the blob commit (dispatched, requestless) is paired with the client's event as document 1", () => {
    const { j, popup } = withOpener("firefox");
    popup.serverCommit("about:blank");
    popup.announce();
    popup.newDocument(B);
    expect(j.pages?.[1]).toEqual({
      page: 1,
      via: "page",
      firstUrl: "about:blank",
      announced: true,
    });
    const nav = j.navigations?.find((n) => n.page === 1);
    expect(page1(j)).toEqual({
      activations: [
        ["initial-document", "about:blank", "none", false, null],
        ["new-document", B, "none", true, nav?.seq],
      ],
      navigations: [["new-document", 0, 1, null, B]],
    });
    expect(j.provenanceFailures).toEqual([]);
  });
  it('CAP3-blank a named window.open("", name): WebKit\'s initial about:blank (native document "") is document 0; the opener\'s later navigation of it commits document 1, linked to its request', () => {
    const { j, popup } = withOpener("webkit");
    popup.serverCommit("about:blank", undefined, "");
    popup.announce();
    const nav = popup.request(N);
    popup.respond(nav, 200);
    popup.newDocument(N, nav);
    expect(page1(j)).toEqual({
      activations: [
        ["initial-document", "about:blank", "none", false, null],
        ["new-document", N, "linked", true, j.navigations?.at(-1)?.seq],
      ],
      navigations: [["new-document", 0, 1, j.requests.at(-1)?.seq, N]],
    });
    expect(j.provenanceFailures).toEqual([]);
  });
  it("a second undispatched about:blank commit is a NEW document (only the frame's first is its initial document)", () => {
    const { j, popup } = withOpener("chromium");
    popup.serverCommit("about:blank");
    popup.serverCommit("about:blank");
    popup.announce();
    expect(page1(j)).toEqual({
      activations: [
        ["initial-document", "about:blank", "none", false, null],
        ["new-document", "about:blank", "none", false, null],
      ],
      navigations: [["new-document", 0, 1, null, "about:blank"]],
    });
    expect(j.provenanceFailures).toEqual([]);
  });
  it("Chromium's HTTP popup (dispatched at its request, before the announcement): the activation is paired with the client's commit, linked to the same request by identity", () => {
    const { j, popup } = withOpener("chromium");
    const nav = popup.request(N);
    popup.respond(nav, 503);
    popup.newDocument(N, nav);
    popup.announce();
    const commit = j.navigations?.find((n) => n.page === 1);
    expect(page1(j).activations).toEqual([
      ["new-document", N, "linked", true, commit?.seq],
    ]);
    expect(commit?.request).toBe(j.requests.at(-1)?.seq);
    expect(j.provenanceFailures).toEqual([]);
  });
  it("a subframe's server commit is no activation of its page", () => {
    const { j, ctx } = withOpener("chromium");
    const before = j.activations?.length;
    ctx.side.commit({
      url: () => `${FRONT}/frame`,
      parentFrame: () => ({}),
      _currentDocument: { documentId: "f", request: undefined },
    });
    expect(j.activations).toHaveLength(before ?? 0);
    expect(j.provenanceFailures).toEqual([]);
  });
});

describe("F34-1 the hand-off and the source fail by name; nothing is inferred from a URL", () => {
  const P = `${FRONT}/api/__guard/page`;
  const B = "blob:http://127.0.0.1:9/0a6f2c1e-0000-4000-8000-000000000034";
  function withOpener(
    engine: string,
    options: { pagesAtAttach?: number } = {},
  ) {
    let seq = 0;
    const j: Journal = {
      problems: [],
      requests: [],
      attempts: [],
      expectations: [],
      engine,
    };
    const ctx = recorderContext(options);
    const recorder = recordContext(ctx.context, {
      journal: j,
      next: () => {
        seq += 1;
        return seq;
      },
      stamp,
      ingest: (p) => void j.problems.push(p),
    });
    const d = recorderPage(ctx);
    const opened = d.request(P);
    d.respond(opened, 200);
    d.newDocument(P, opened);
    const popup = recorderPage(ctx, { announce: false, url: "" });
    return { j, d, ctx, popup, recorder };
  }
  it("CAP7 a DISPATCHED activation whose client event the recorder never received (a late subscription) fails at settlement, even when the page ends at about:blank", () => {
    const { j, d, recorder } = withOpener("chromium");
    expect(d.serverCommit("about:blank"), "dispatched").toBe(true);
    expect(j.provenanceFailures).toEqual([]);
    expect(recorder.dispose()).toEqual([]);
    expect(j.provenanceFailures).toEqual([
      expect.stringMatching(
        /^page 0: activation #\d+ \(about:blank\) was dispatched to Playwright's client but the recorder never received its navigation event/,
      ),
    ]);
  });
  it("CAP7 a client new-document event with no server activation is a named failure", () => {
    const { j, d } = withOpener("chromium");
    d.clientNavigated(`${FRONT}/requestless`);
    expect(j.provenanceFailures).toEqual([
      expect.stringMatching(
        /^page 0: navigation event #\d+ \(new-document, http:\/\/127\.0\.0\.1:9\/requestless\) has no activation observed at Playwright's server$/,
      ),
    ]);
  });
  it("CAP7 a client event naming a request other than its server activation's (by identity, whatever the URL) is a named failure", () => {
    const { j, d } = withOpener("chromium");
    const first = d.request(N);
    const second = d.request(N);
    d.serverCommit(N, first);
    d.clientNavigated(N, second);
    expect(j.provenanceFailures).toEqual([
      expect.stringMatching(
        /^page 0: navigation event #\d+ \(new-document\) names a request but its server activation #\d+ has another$/,
      ),
    ]);
    d.serverCommit(N);
    d.clientNavigated(N, first);
    expect(j.provenanceFailures).toContainEqual(
      expect.stringMatching(
        /names a request but its server activation #\d+ has none$/,
      ),
    );
    d.serverCommit(N, second);
    d.clientNavigated(N);
    expect(j.provenanceFailures).toContainEqual(
      expect.stringMatching(
        /names no request but its server activation #\d+ has one$/,
      ),
    );
  });
  it("CAP7 an undispatched activation naming a server request is UNRESOLVED: a named failure, never credited as requestless", () => {
    const { j, popup } = withOpener("firefox");
    const unseen = {
      method: () => "GET",
      url: () => B,
      isNavigationRequest: () => true,
      frame: () => popup.main,
      failure: () => null,
      redirectedFrom: () => null,
    };
    popup.serverCommit(B, unseen);
    popup.announce();
    expect(j.activations?.at(-1)).toMatchObject({
      page: 1,
      request: "unresolved",
      dispatched: false,
    });
    expect(j.navigations?.at(-1)).toMatchObject({
      page: 1,
      kind: "new-document",
      request: null,
      reason: expect.stringMatching(/unresolved/),
    });
    expect(j.provenanceFailures).toEqual([
      expect.stringMatching(
        /^page 1: activation #\d+ \(blob:.*\) names a request Playwright never delivered: unresolved, never treated as requestless$/,
      ),
    ]);
  });
  it("CAP7 a page first met showing a native document that is not its last observed activation (one escaped observation) fails by name, whatever its URL", () => {
    const { j, popup } = withOpener("firefox");
    popup.serverCommit(B);
    popup.serverMain._currentDocument = {
      documentId: "not-observed",
      request: undefined,
    };
    popup.announce();
    expect(j.provenanceFailures).toEqual([
      expect.stringMatching(
        /^page 1: first met showing native document "not-observed", not its last observed activation #\d+ \("native-1"\)/,
      ),
    ]);
  });
  it("CAP7 an undispatched activation of a frame the recorder never meets fails at settlement (never dropped)", () => {
    const { j, popup, recorder } = withOpener("firefox");
    popup.serverCommit(B);
    expect(recorder.dispose()).toEqual([]);
    expect(j.provenanceFailures).toEqual([
      expect.stringMatching(
        /^a main frame the recorder never met \(server frame \d+\): activation #\d+ \(blob:.*\) was never attributed to a lane page$/,
      ),
    ]);
  });
  it("CAP7 a source attached after a page of its context existed fails by name", () => {
    const { j } = withOpener("chromium", { pagesAtAttach: 1 });
    expect(j.provenanceFailures).toEqual([
      "the activation source attached after 1 page(s) of its context existed: their earlier activations cannot have been observed",
    ]);
  });
  it("CAP7 an unavailable source (no in-process toImpl: a connected client) fails by name; the first-URL gap still fails a page first met showing a document", () => {
    let seq = 0;
    const j: Journal = {
      problems: [],
      requests: [],
      attempts: [],
      expectations: [],
      engine: "firefox",
    };
    const ctx = recorderContext();
    (ctx.context as { _connection?: unknown })._connection = {};
    recordContext(ctx.context, {
      journal: j,
      next: () => {
        seq += 1;
        return seq;
      },
      stamp,
      ingest: (p) => void j.problems.push(p),
    });
    const popup = recorderPage(ctx, { announce: false, url: "" });
    popup.serverCommit(B);
    popup.announce();
    expect(j.activationSource).toEqual({
      unavailable: expect.stringMatching(/no in-process `toImpl`/),
    });
    expect(j.activations).toEqual([]);
    expect(j.provenanceFailures).toEqual([
      expect.stringMatching(
        /^activation source unavailable \(the client connection has no in-process `toImpl`/,
      ),
      expect.stringMatching(
        /^page 0: first met \(at its announcement\) already showing blob:.*: an earlier document activation was not observed/,
      ),
    ]);
  });
  it("CAP7 the source refuses another installed Playwright version and an unexpected shape, attaching nothing", () => {
    const ctx = recorderContext();
    const listener = () => undefined;
    expect(
      observeActivations(ctx.context, listener, {
        version: "1.62.0",
        bundleSha256: null,
        error: null,
      }),
    ).toEqual({
      ok: false,
      reason:
        "the activation source is qualified for playwright-core 1.63.0 only; installed: 1.62.0",
    });
    expect(ctx.side.server.listenerCount(ACTIVATION_SOURCE_PIN.event)).toBe(0);
    const odd = recorderContext();
    odd.side.bind(odd.context, { on: () => undefined });
    expect(observeActivations(odd.context, listener)).toEqual({
      ok: false,
      reason:
        "the server context has no on/off/possiblyUninitializedPages of the pinned shape",
    });
  });
  it("CAP7 an unreadable server commit is a named failure", () => {
    const { j, ctx } = withOpener("chromium");
    ctx.side.commit({ url: () => "x", parentFrame: () => null });
    expect(j.provenanceFailures).toEqual([
      expect.stringMatching(
        /^a document activation Playwright's server observed is unreadable \(a server frame without `_currentDocument`\)/,
      ),
    ]);
  });
  it("the disposer detaches the source exactly once: a later server commit reaches nothing", () => {
    const { j, d, ctx, recorder } = withOpener("chromium");
    expect(ctx.side.server.listenerCount(ACTIVATION_SOURCE_PIN.event)).toBe(1);
    expect(recorder.dispose()).toEqual([]);
    expect(ctx.side.server.listenerCount(ACTIVATION_SOURCE_PIN.event)).toBe(0);
    const recorded = j.activations?.length;
    d.serverCommit(`${FRONT}/after`);
    expect(j.activations).toHaveLength(recorded ?? 0);
    expect(j.lateEvents).toBeUndefined();
    expect(recorder.dispose(), "single use").toEqual([]);
  });
  it("a failing detachment of the source is reported by name; a commit still delivered after it is late, never recorded", () => {
    const { j, d, ctx, recorder } = withOpener("chromium");
    ctx.side.server.off = () => {
      throw new Error("off refused");
    };
    expect(recorder.dispose()).toEqual([
      "detaching the activation source failed: Error: off refused",
    ]);
    const recorded = j.activations?.length;
    d.serverCommit(`${FRONT}/after`);
    expect(j.activations).toHaveLength(recorded ?? 0);
    expect(j.lateEvents).toEqual([
      "a server-observed document activation delivered after the recorder was detached; not recorded",
    ]);
  });
  it("two lane contexts: each source observes only its own context's activations", () => {
    const a = withOpener("firefox");
    const b = withOpener("firefox");
    a.popup.serverCommit(B);
    a.popup.announce();
    expect(b.j.activations?.map((x) => x.url)).toEqual([P]);
    expect(a.j.activations?.map((x) => x.url)).toEqual([P, B]);
    expect(a.j.provenanceFailures).toEqual([]);
    expect(b.j.provenanceFailures).toEqual([]);
  });
});

describe("F34-1 OWN-install: attaching the capture registry fails after newContext returned", () => {
  it("the open fails by name and its context is closed once, before the open's error is reported", async () => {
    let closed = 0;
    const browser = {
      newContext: (async () => ({
        // A context the recorder cannot attach to (no `on`): recordContext throws inside the acquisition.
        _connection: undefined,
        addInitScript: async () => undefined,
        close: async () => {
          closed += 1;
        },
        browser: () => ({ browserType: () => ({ name: () => "chromium" }) }),
      })) as unknown as Browser["newContext"],
    };
    const { info } = fakeInfo();
    const lanes = openTransportLanes(browser, info);
    await expect(lanes.open({ mode: "fixture" })).rejects.toThrow(
      /attaching the context's capture registry failed: TypeError/,
    );
    const report = await lanes.settle();
    expect(closed, "the context was closed once").toBe(1);
    expect(report.closeErrors).toEqual([]);
  });
  it("a failing close of that context is reported with the attachment's failure, neither masking the other", async () => {
    const browser = {
      newContext: (async () => ({
        addInitScript: async () => undefined,
        close: async () => {
          throw new Error("close refused");
        },
      })) as unknown as Browser["newContext"],
    };
    const { info } = fakeInfo();
    const lanes = openTransportLanes(browser, info);
    await expect(lanes.open({ mode: "fixture" })).rejects.toThrow(
      /attaching the context's capture registry failed: TypeError.*; closing its context also failed: Error: close refused/,
    );
    await lanes.settle();
  });
});

// ---- Revision 28 (Review 33 F33-2, family native-transport-ui-initialisation; design assessment token 98d2410c…, C4, UI1–UI3) ---------

describe("F33-2 installUiStimulus: document-scoped, repeat-safe in a global it already installed (Playwright's own serialised script)", () => {
  /**
   * A JavaScript realm with an engine-shaped Navigator (a configurable prototype getter reading the realm's native connectivity), a
   * window that is the global, a document object and event dispatch. `install()` evaluates the SAME serialised function Playwright's
   * addInitScript sends; `newDocument()` replaces the global's document as a reused Window's next document does.
   */
  function realm() {
    const sandbox = createContext({});
    runInContext(
      `
      globalThis.window = globalThis;
      globalThis.nativeOnline = true;
      globalThis.events = [];
      class Navigator { get onLine() { return globalThis.nativeOnline; } }
      globalThis.Navigator = Navigator;
      globalThis.navigator = new Navigator();
      globalThis.document = { n: 1 };
      let ids = 0;
      globalThis.crypto = { randomUUID: () => "id-" + (++ids) };
      globalThis.Event = class Event { constructor(type) { this.type = type; } };
      globalThis.dispatchEvent = (e) => { globalThis.events.push(e.type); return true; };
      `,
      sandbox,
    );
    const run = (code: string) => runInContext(code, sandbox);
    return {
      install: () => run(`(${installUiStimulus.toString()})()`),
      read: () => run("window.__atlasUiConnectivity.read()"),
      set: (online: boolean) =>
        run(`window.__atlasUiConnectivity.set(${online})`),
      events: () => run("events.slice()") as string[],
      getter: () =>
        run(
          'Object.getOwnPropertyDescriptor(Navigator.prototype, "onLine").get',
        ),
      newDocument: () => run("document = { n: document.n + 1 }"),
      run,
    };
  }
  it("UI1 one installation: the document's id, no stimulus, the native reading; set() drives the getter the application reads and dispatches its event", () => {
    const r = realm();
    r.install();
    expect(r.read()).toEqual({
      document: "id-1",
      native: true,
      ui: true,
      stimulus: null,
    });
    expect(r.set(false)).toEqual({
      document: "id-1",
      native: true,
      ui: false,
      stimulus: false,
    });
    expect(r.run("navigator.onLine")).toBe(false);
    r.run("nativeOnline = false");
    expect(r.set(true)).toMatchObject({ native: false, ui: true });
    expect(r.events()).toEqual(["offline", "online"]);
    expect(
      r.run('Object.getOwnPropertyDescriptor(window, "__atlasUiConnectivity")'),
    ).toMatchObject({
      configurable: false,
      writable: false,
    });
  });
  it("UI2 a repeated installation for the SAME document: no error, its id and stimulus kept, no getter wrapped over the lane's own, no extra event", () => {
    const r = realm();
    r.install();
    r.set(false);
    const getter = r.getter();
    expect(() => r.install()).not.toThrow();
    expect(r.getter(), "the lane's getter is not wrapped again").toBe(getter);
    expect(r.read()).toEqual({
      document: "id-1",
      native: true,
      ui: false,
      stimulus: false,
    });
    r.run("nativeOnline = false");
    expect(r.set(true)).toMatchObject({ native: false, ui: true });
    expect(r.set(false)).toMatchObject({ native: false, ui: false });
    expect(r.events()).toEqual(["offline", "online", "offline"]);
  });
  it("UI2 a reused global's NEW document (WebKit's popup: the script runs again): a new id and no stimulus; the native reading stays genuine", () => {
    const r = realm();
    r.install();
    r.set(false);
    r.newDocument();
    expect(() => r.install()).not.toThrow();
    expect(r.read()).toEqual({
      document: "id-2",
      native: true,
      ui: true,
      stimulus: null,
    });
    r.run("nativeOnline = false");
    expect(r.read()).toMatchObject({
      native: false,
      ui: false,
      stimulus: null,
    });
  });
  it("UI2 a reused global's new document WITHOUT another run (Chromium and Firefox run the script once): still a new id and no stimulus", () => {
    const r = realm();
    r.install();
    r.set(false);
    r.newDocument();
    expect(
      r.run("navigator.onLine"),
      "the old document's stimulus does not outlive it",
    ).toBe(true);
    expect(r.read()).toEqual({
      document: "id-2",
      native: true,
      ui: true,
      stimulus: null,
    });
  });
  it("UI3 a slot that is not the lane's installation: a named error, and navigator.onLine is left as the engine's", () => {
    const r = realm();
    const native = r.getter();
    r.run(
      'Object.defineProperty(window, "__atlasUiConnectivity", { value: { read() {} } })',
    );
    expect(() => r.install()).toThrow(
      /window\.__atlasUiConnectivity exists but is not the lane's UI stimulus installation over navigator\.onLine/,
    );
    expect(r.getter()).toBe(native);
  });
  it("UI3 a branded installation of another version or shape (a stale or foreign installer): a named error, never adopted", () => {
    for (const shape of ["version: 2, adopt() {}", "version: 1"]) {
      const r = realm();
      const native = r.getter();
      r.run(
        `Object.defineProperty(window, "__atlasUiConnectivity", { value: { [Symbol.for("atlas.native-transport.ui-connectivity")]: { ${shape}, getter: Object.getOwnPropertyDescriptor(Navigator.prototype, "onLine").get } } })`,
      );
      expect(() => r.install(), shape).toThrow(
        /window\.__atlasUiConnectivity exists but is not the lane's UI stimulus installation/,
      );
      expect(r.getter()).toBe(native);
    }
  });
  it("UI3 the lane's slot whose getter was replaced since: a named error, never a getter wrapped over a stranger's", () => {
    const r = realm();
    r.install();
    r.run(
      'Object.defineProperty(Navigator.prototype, "onLine", { configurable: true, get() { return 42; } })',
    );
    expect(() => r.install()).toThrow(
      /is not the lane's UI stimulus installation/,
    );
    expect(r.run("navigator.onLine")).toBe(42);
  });
  it("UI3 the lane's getter without its slot (a partial installation): a named error, never wrapped again", () => {
    const r = realm();
    r.install();
    const other = realm();
    other.run(
      `Object.defineProperty(Navigator.prototype, "onLine", { configurable: true, get: (${(
        () => {
          const g = () => true;
          Object.defineProperty(
            g,
            Symbol.for("atlas.native-transport.ui-connectivity"),
            { value: true },
          );
          return g;
        }
      ).toString()})() })`,
    );
    expect(() => other.install()).toThrow(
      /already has the lane's getter but window\.__atlasUiConnectivity is missing/,
    );
  });
  it("UI3 an engine without a configurable getter: a named error before anything is defined", () => {
    const r = realm();
    r.run(
      'Object.defineProperty(Navigator.prototype, "onLine", { configurable: false, get() { return true; } })',
    );
    expect(() => r.install()).toThrow(
      /navigator\.onLine has no configurable getter/,
    );
    expect(
      r.run('Object.getOwnPropertyDescriptor(window, "__atlasUiConnectivity")'),
    ).toBeUndefined();
  });
  it("UI1 separate globals (opener and child, two contexts) share no stimulus", () => {
    const opener = realm();
    const child = realm();
    opener.install();
    child.install();
    child.set(false);
    expect(opener.read()).toMatchObject({ ui: true, stimulus: null });
    expect(child.read()).toMatchObject({ ui: false, stimulus: false });
  });
});
