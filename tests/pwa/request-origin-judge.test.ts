import { describe, expect, it } from "vitest";
import {
  type JudgeOptions,
  type LedgerEntry,
  parseRequestId,
  reconcile,
  type Seen,
  type Window,
} from "../e2e/request-origin-judge";

/**
 * WEB-14a revision 43 (F-FRESH-2) Q1, corrected in revision 44 (review r43: incomplete_fix; design assessment Q1): the per-occurrence
 * request-origin rules AND the terminal accounting, on hand-built ledgers and browser records shaped like the engines' (qualification Q2,
 * .agtx/evidence/revision-r43-20261102/q2). Healthy windows with ordinary page traffic pass; every way a worker request, a duplicate, a gap,
 * an unknown or an unfinished request could hide fails or stays unresolved, with the reason named.
 *
 * Revision 43's sixteen cases are all kept (first two blocks). Their `settled(...)` assertions now read `reconcile(...).unresolved`, the
 * one predicate the recorder both waits on and judges with. One expectation changed, labelled at its case: a backend request the browser
 * reported only as FAILED is now also reported on the browser's side.
 */
const DAILY =
  "/api/experimental/v1/daily?day=2026-11-02&timezone=UTC&scope=joint";
const DAILY_PERSONAL =
  "/api/experimental/v1/daily?day=2026-11-02&timezone=UTC&scope=personal";
const DEFAULTS = "/api/experimental/v1/defaults/snapshot";
const ME = "/api/experimental/v1/me";

let n = 0;
const entry = (
  id: number,
  path: string,
  status = 200,
  extra: Partial<LedgerEntry> = {},
): LedgerEntry => ({
  id,
  method: "GET",
  path,
  at: id,
  status,
  end: "finished",
  ...extra,
});
const record = (
  origin: Seen["origin"],
  id: number | null,
  path: string,
  label: string | null,
  extra: Partial<Seen> = {},
): Seen => ({
  n: ++n,
  method: "GET",
  path,
  origin,
  page: label,
  navigation: false,
  idHeader: id === null ? null : String(id),
  id,
  status: 200,
  fromServiceWorker: false,
  finished: true,
  failed: null,
  ...extra,
});
const page = (
  id: number | null,
  path: string,
  label: string,
  extra: Partial<Seen> = {},
) => record("page", id, path, label, extra);
const worker = (id: number | null, path: string, extra: Partial<Seen> = {}) =>
  record("worker", id, path, null, extra);
const pending = (path: string, label: string, extra: Partial<Seen> = {}) =>
  page(null, path, label, {
    status: null,
    fromServiceWorker: null,
    finished: false,
    ...extra,
  });
const win = (
  from: number,
  to: number,
  seen: Seen[],
  extra: Partial<Window> = {},
): Window => ({
  from,
  to,
  seenFrom: 0,
  seenTo: seen.length === 0 ? 0 : Math.max(...seen.map((r) => r.n)),
  carry: [],
  ...extra,
});
/** One reconcile over a ledger reply (after, high] holding `entries`; by default the reply covers exactly the window. */
const run = (
  window: Window,
  entries: LedgerEntry[],
  seen: Seen[],
  options: JudgeOptions,
  reply: { after?: number; high?: number } = {},
) =>
  reconcile(
    window,
    {
      after: reply.after ?? window.from,
      high: reply.high ?? window.to,
      entries,
    },
    seen,
    options,
  );
const probeNav = (id: number, path: string, status = 404) =>
  page(id, path, "tab 3", { navigation: true, status });

describe("request-origin judge: healthy windows (revision 43, kept)", () => {
  it("a probe's backend navigation with the open app's delayed defaults and both daily reads in the same window passes", () => {
    n = 0;
    const entries = [
      entry(11, DEFAULTS),
      entry(12, "/api", 404),
      entry(13, DAILY),
      entry(14, DAILY_PERSONAL),
    ];
    const seen = [
      page(11, DEFAULTS, "tab 2"),
      probeNav(12, "/api"),
      page(13, DAILY, "tab 2"),
      page(14, DAILY_PERSONAL, "tab 2"),
    ];
    const verdict = run(win(10, 14, seen), entries, seen, {
      scope: "all",
      probe: { page: "tab 3", path: "/api", status: 404 },
    });
    expect(verdict.problems).toEqual([]);
    expect(verdict.pageBackend.map((a) => a.entry.id)).toEqual([
      11, 12, 13, 14,
    ]);
    expect(
      run(win(10, 14, seen), entries, seen, { scope: "all" }).unresolved,
    ).toEqual([]);
  });

  it("two equal reads from different tabs are two page occurrences, joined by id rather than URL", () => {
    n = 0;
    const entries = [entry(21, DAILY), entry(22, DAILY)];
    const seen = [page(22, DAILY, "tab 4"), page(21, DAILY, "tab 2")];
    const verdict = run(win(20, 22, seen), entries, seen, {
      scope: "backend",
    });
    expect(verdict.problems).toEqual([]);
    expect(verdict.attributions.map((a) => a.seen[0]?.page)).toEqual([
      "tab 2",
      "tab 4",
    ]);
  });

  it("exactly the browser's own /sw.js check and /favicon.ico may go unobserved; a static request a page made and the worker answered is a page's", () => {
    n = 0;
    const entries = [
      entry(31, "/sw.js"),
      entry(32, "/favicon.ico", 404),
      entry(33, "/assets/x.js"),
    ];
    const seen = [
      page(33, "/assets/x.js", "tab 2", { fromServiceWorker: true }),
      worker(33, "/assets/x.js"),
    ];
    expect(
      run(win(30, 33, seen), entries, seen, { scope: "all" }).problems,
    ).toEqual([]);
  });

  it("scope backend does not judge a worker's static installation fetches, which no page made", () => {
    n = 0;
    const entries = [
      entry(41, "/assets/a.js"),
      entry(42, "/index.html"),
      entry(43, "/health"),
    ];
    const seen = [page(43, "/health", "tab 1")];
    const verdict = run(win(40, 43, seen), entries, seen, {
      scope: "backend",
    });
    expect(verdict.problems).toEqual([]);
    expect(verdict.pageBackend).toHaveLength(1);
  });

  it("the wait does not hold for what the scope does not judge, and always holds for an unobserved backend request", () => {
    n = 0;
    const installs = [entry(161, "/assets/a.js"), entry(162, "/index.html")];
    expect(
      run(win(160, 162, []), installs, [], { scope: "backend" }).unresolved,
    ).toEqual([]);
    expect(
      run(win(160, 162, []), installs, [], { scope: "all" }).unresolved,
    ).not.toEqual([]);
    const sessions = [...installs, entry(163, "/api/experimental/v1/sessions")];
    expect(
      run(win(160, 163, []), sessions, [], { scope: "backend" }).unresolved,
    ).not.toEqual([]);
    const own = [entry(164, "/sw.js")];
    expect(
      run(win(163, 164, []), own, [], { scope: "all" }).unresolved,
    ).toEqual([]);
    const pendingPage = [pending(DAILY, "tab 2")];
    expect(
      run(win(164, 164, pendingPage), [], pendingPage, { scope: "backend" })
        .unresolved,
    ).not.toEqual([]);
  });

  it("a request after the window's end belongs to the next window, which judges it", () => {
    n = 0;
    const entries = [
      entry(51, DAILY),
      entry(52, "/api/experimental/v1/sessions"),
    ];
    const seen = [page(51, DAILY, "tab 2")];
    expect(
      run(win(50, 51, seen), entries, seen, { scope: "backend" }, { high: 52 })
        .problems,
    ).toEqual([]);
    expect(
      run(win(51, 52, seen), entries, seen, { scope: "backend" }, { after: 50 })
        .problems,
    ).toEqual([
      "#52 GET /api/experimental/v1/sessions (200, finished): unobserved",
    ]);
  });
});

describe("request-origin judge: what must fail (revision 43, kept)", () => {
  it("a worker's extra GET to the same URL as a page read: unobserved in Firefox/WebKit, a worker request in Chromium", () => {
    n = 0;
    const entries = [entry(61, DAILY), entry(62, DAILY)];
    const firefox = [page(62, DAILY, "tab 2")];
    expect(
      run(win(60, 62, firefox), entries, firefox, { scope: "backend" })
        .problems,
    ).toEqual([`#61 GET ${DAILY} (200, finished): unobserved`]);
    const chromium = [worker(61, DAILY), page(62, DAILY, "tab 2")];
    expect(
      run(win(60, 62, chromium), entries, chromium, { scope: "backend" })
        .problems,
    ).toEqual([
      `#61 GET ${DAILY} (200, finished): worker-origin (seen as worker)`,
      `worker GET ${DAILY}: a worker's backend request (browser record 2)`,
    ]);
  });

  it("a worker's unsolicited GET of one of the four historically allowed paths fails (the old whitelist accepted it)", () => {
    n = 0;
    const entries = [entry(71, "/api/experimental/v1/sessions")];
    expect(
      run(win(70, 71, []), entries, [], { scope: "backend" }).problems,
    ).toEqual([
      "#71 GET /api/experimental/v1/sessions (200, finished): unobserved",
    ]);
  });

  it("a page read the worker answered by forwarding it (status and body the backend's) fails, from either side", () => {
    n = 0;
    const entries = [entry(81, DEFAULTS)];
    const forwarded = [
      page(81, DEFAULTS, "tab 2", { fromServiceWorker: true }),
    ];
    expect(
      run(win(80, 81, forwarded), entries, forwarded, { scope: "backend" })
        .problems,
    ).toEqual([
      `#81 GET ${DEFAULTS} (200, finished): worker-fulfilled (seen as page tab 2 answered by the worker)`,
      `page tab 2 GET ${DEFAULTS}: answered by the worker (browser record 1)`,
    ]);
    const chromium = [
      page(81, DEFAULTS, "tab 2", { fromServiceWorker: true }),
      worker(81, DEFAULTS),
    ];
    expect(
      run(win(80, 81, chromium), entries, chromium, { scope: "backend" })
        .problems[0],
    ).toMatch(/worker-fulfilled/);
  });

  it("a backend answer that never reached the server (the shell or a cache) fails on the browser's side", () => {
    n = 0;
    const cached = [page(null, ME, "tab 2", { fromServiceWorker: true })];
    expect(
      run(win(90, 90, cached), [], cached, { scope: "backend" }).problems,
    ).toEqual([
      `page tab 2 GET ${ME}: answered by the worker (browser record 1)`,
    ]);
    const noId = [page(null, ME, "tab 2")];
    expect(
      run(win(90, 90, noId), [], noId, { scope: "backend" }).problems,
    ).toEqual([
      `page tab 2 GET ${ME}: answered without a server request id (browser record 2)`,
    ]);
    const stale = [page(3, ME, "tab 2", { fromServiceWorker: true })];
    expect(
      run(win(90, 90, stale), [], stale, { scope: "backend" }).problems,
    ).toHaveLength(1);
  });

  it("a probe that reaches the server twice, never, or from another page fails", () => {
    n = 0;
    const probe = { page: "tab 3", path: "/api", status: 404 };
    const twice = [entry(101, "/api", 404), entry(102, "/api", 404)];
    const twiceSeen = [probeNav(101, "/api"), probeNav(102, "/api")];
    expect(
      run(win(100, 102, twiceSeen), twice, twiceSeen, { scope: "all", probe })
        .problems,
    ).toContain("probe tab 3 /api: reached the server 2 times, not once");
    // A worker's duplicate of the probe's navigation (Firefox/WebKit: unobserved).
    const duplicate = [entry(101, "/api", 404), entry(102, "/api", 404)];
    const duplicateSeen = [probeNav(101, "/api")];
    expect(
      run(win(100, 102, duplicateSeen), duplicate, duplicateSeen, {
        scope: "all",
        probe,
      }).problems,
    ).toEqual(["#102 GET /api (404, finished): unobserved"]);
    expect(
      run(win(100, 100, []), [], [], { scope: "all", probe }).problems,
    ).toEqual(["probe tab 3 /api: reached the server 0 times, not once"]);
    const elsewhere = [entry(101, "/api", 404)];
    const elsewhereSeen = [
      page(101, "/api", "tab 2", { navigation: true, status: 404 }),
    ];
    expect(
      run(win(100, 101, elsewhereSeen), elsewhere, elsewhereSeen, {
        scope: "all",
        probe,
      }).problems,
    ).toEqual(["probe tab 3 /api: reached the server 0 times, not once"]);
  });

  it("a probe answered with the wrong status fails, as does a page record whose status disagrees with the server's", () => {
    n = 0;
    const entries = [entry(111, "/ready", 404)];
    const seen = [probeNav(111, "/ready", 404)];
    expect(
      run(win(110, 111, seen), entries, seen, {
        scope: "all",
        probe: { page: "tab 3", path: "/ready", status: 200 },
      }).problems,
    ).toEqual(["probe tab 3 /ready: server answered 404, not 200"]);
    const mismatch = [
      page(111, "/ready", "tab 3", { navigation: true, status: 200 }),
    ];
    expect(
      run(win(110, 111, mismatch), entries, mismatch, { scope: "backend" })
        .problems,
    ).toEqual([
      "#111 GET /ready (404, finished): status-mismatch (seen as page tab 3 navigation)",
    ]);
  });

  it("a gap or a repeated id in the ledger is an unknown, never a pass", () => {
    n = 0;
    const seen = [page(121, DAILY, "tab 2"), page(123, DAILY, "tab 2")];
    const gap = run(
      win(120, 123, seen),
      [entry(121, DAILY), entry(123, DAILY)],
      seen,
      { scope: "backend" },
    );
    expect(gap.problems).toEqual([
      "server request #122 is missing from the ledger",
    ]);
    // (Revision 43 checked `settled` false here: the gap is now a known failure, which is never a pass either.)
    expect(gap.failures).not.toEqual([]);
    const repeated = [entry(121, DAILY), entry(121, DAILY)];
    expect(
      run(win(120, 121, seen), repeated, seen, { scope: "backend" })
        .problems[0],
    ).toBe("server request #121 appears 2 times in the ledger");
  });

  it("an unfinished or closed response, and a lost one the browser reported only as failed, fail", () => {
    n = 0;
    const unfinished = [entry(131, DAILY, 200, { end: null })];
    const seen = [page(131, DAILY, "tab 2")];
    expect(
      run(win(130, 131, seen), unfinished, seen, { scope: "all" }).unresolved,
    ).not.toEqual([]);
    expect(
      run(win(130, 131, seen), unfinished, seen, { scope: "backend" }).problems,
    ).toEqual([
      `#131 GET ${DAILY} (200, unfinished): the server has not finished it (seen as page tab 2)`,
    ]);
    const closed = [entry(131, DAILY, 200, { end: "closed" })];
    expect(
      run(win(130, 131, seen), closed, seen, { scope: "backend" }).problems[0],
    ).toMatch(/unfinished/);
    // CHANGED in revision 44 (labelled): the browser's failure is now reported on its own side too, not only the unobserved receipt.
    const lost = [
      page(null, DAILY, "tab 2", {
        status: null,
        fromServiceWorker: null,
        finished: false,
        failed: "net::ERR_ABORTED",
      }),
    ];
    expect(
      run(win(130, 131, lost), [entry(131, DAILY)], lost, { scope: "backend" })
        .problems,
    ).toEqual([
      `page tab 2 GET ${DAILY}: failed: net::ERR_ABORTED (browser record 2)`,
      `#131 GET ${DAILY} (200, finished): unobserved`,
    ]);
  });

  it("a record no page frame made (origin unknown) is not a page's; a non-GET backend request fails; a POST /sw.js is not exempt", () => {
    n = 0;
    const unknown = [record("unknown", 141, DEFAULTS, null)];
    expect(
      run(win(140, 141, unknown), [entry(141, DEFAULTS)], unknown, {
        scope: "backend",
      }).problems[0],
    ).toMatch(/worker-origin \(seen as unknown\)/);
    const post = [
      page(142, "/api/experimental/v1/tasks", "tab 2", {
        method: "POST",
        status: 405,
      }),
    ];
    expect(
      run(
        win(141, 142, post),
        [entry(142, "/api/experimental/v1/tasks", 405, { method: "POST" })],
        post,
        { scope: "backend" },
      ).problems,
    ).toEqual([
      "#142 POST /api/experimental/v1/tasks (405, finished): not-get (seen as page tab 2)",
    ]);
    expect(
      run(
        win(142, 143, []),
        [entry(143, "/sw.js", 405, { method: "POST" })],
        [],
        { scope: "all" },
      ).problems,
    ).toEqual(["#143 POST /sw.js (405, finished): unobserved"]);
  });

  it("in scope all, a static request no page made (a worker's own cache repair) fails", () => {
    n = 0;
    expect(
      run(win(150, 151, []), [entry(151, "/assets/x.js")], [], {
        scope: "all",
      }).problems,
    ).toEqual(["#151 GET /assets/x.js (200, finished): unobserved"]);
  });
});

describe("revision 44: every admitted browser request needs a terminal outcome (review r43 F-FRESH-2)", () => {
  it("the review's native witness: a healthy read plus an observed page request with no response and no server receipt is NOT a pass", () => {
    n = 0;
    const seen = [
      page(201, "/health?review-control=1", "tab 1"),
      pending("/health?review-pending=1", "tab 1"),
    ];
    const verdict = run(
      win(200, 201, seen),
      [entry(201, "/health?review-control=1")],
      seen,
      { scope: "backend" },
    );
    expect(verdict.pageBackend).toHaveLength(1);
    expect(verdict.failures).toEqual([]);
    expect(verdict.unresolved).toEqual([
      "page tab 1 GET /health?review-pending=1: no end yet (browser record 2, pending)",
    ]);
    expect(verdict.problems).toEqual(verdict.unresolved);
    // Its healthy counterpart: the same request ends with its own receipt.
    n = 0;
    const healthy = [
      page(201, "/health?review-control=1", "tab 1"),
      page(202, "/health?review-pending=1", "tab 1"),
    ];
    expect(
      run(
        win(200, 202, healthy),
        [
          entry(201, "/health?review-control=1"),
          entry(202, "/health?review-pending=1"),
        ],
        healthy,
        { scope: "backend" },
      ).problems,
    ).toEqual([]);
  });

  it("aborted with no server receipt, rejected by a worker, and unknown origin with no receipt never vanish beside a healthy read", () => {
    n = 0;
    const base = page(201, "/health", "tab 1");
    const cases: Array<[Seen, RegExp, "failures" | "unresolved"]> = [
      [
        page(null, DAILY, "tab 1", {
          status: null,
          fromServiceWorker: null,
          finished: false,
          failed: "net::ERR_ABORTED",
        }),
        /failed: net::ERR_ABORTED/,
        "failures",
      ],
      [
        page(null, DAILY, "tab 1", {
          status: null,
          fromServiceWorker: null,
          finished: false,
          failed: "net::ERR_FAILED",
        }),
        /failed: net::ERR_FAILED/,
        "failures",
      ],
      [
        record("unknown", null, DAILY, null, {
          status: null,
          fromServiceWorker: null,
          finished: false,
        }),
        /unknown GET .*no end yet .*pending/,
        "unresolved",
      ],
      [
        record("unknown", null, DAILY, null),
        /no page frame made it/,
        "failures",
      ],
      [
        record("worker", null, DAILY, null, {
          status: null,
          fromServiceWorker: null,
          finished: false,
        }),
        /worker GET .*no end yet/,
        "unresolved",
      ],
      [worker(null, DAILY), /a worker's backend request/, "failures"],
    ];
    for (const [extra, reason, side] of cases) {
      const seen = [base, extra];
      const verdict = run(
        win(200, 201, seen, { seenFrom: 0 }),
        [entry(201, "/health")],
        seen,
        { scope: "backend" },
      );
      expect(verdict.pageBackend, reason.source).toHaveLength(1);
      expect(verdict[side].join("\n"), reason.source).toMatch(reason);
      expect(verdict.problems, reason.source).not.toEqual([]);
    }
  });

  it("headers are not an end: received headers then a stall stays unresolved, then a failure after headers fails", () => {
    n = 0;
    const entries = [entry(301, DAILY)];
    const stalled = [page(301, DAILY, "tab 2", { finished: false })];
    const verdict = run(win(300, 301, stalled), entries, stalled, {
      scope: "backend",
    });
    expect(verdict.failures).toEqual([]);
    expect(verdict.unresolved).toEqual([
      `#301 GET ${DAILY} (200, finished): the browser has not ended it (seen as page tab 2)`,
      `page tab 2 GET ${DAILY}: no end yet (browser record 1, headers 200 only)`,
    ]);
    const broken = [
      page(301, DAILY, "tab 2", {
        finished: false,
        failed: "net::ERR_CONNECTION_RESET",
      }),
    ];
    expect(
      run(win(300, 301, broken), entries, broken, { scope: "backend" })
        .problems,
    ).toEqual([
      `#301 GET ${DAILY} (200, finished): failed (seen as page tab 2)`,
      `page tab 2 GET ${DAILY}: failed after headers (200): net::ERR_CONNECTION_RESET (browser record 2)`,
    ]);
    // The server closing before it finished is terminal and unsuccessful, whatever the browser says.
    const done = [page(301, DAILY, "tab 2")];
    expect(
      run(
        win(300, 301, done),
        [entry(301, DAILY, 200, { end: "closed" })],
        done,
        {
          scope: "backend",
        },
      ).failures,
    ).toEqual([
      `#301 GET ${DAILY} (200, closed): unfinished (seen as page tab 2)`,
    ]);
  });

  it("a worker's backend request fails from its admission, before it ends (Chromium never ends an unread worker fetch)", () => {
    n = 0;
    const entries = [entry(1301, "/api", 404)];
    const seen = [
      worker(1301, "/api", { status: 404, finished: false }),
      worker(null, DAILY, {
        status: null,
        fromServiceWorker: null,
        finished: false,
      }),
    ];
    const verdict = run(win(1300, 1301, seen), entries, seen, { scope: "all" });
    expect(verdict.failures).toEqual([
      "#1301 GET /api (404, finished): worker-origin (seen as worker)",
      "worker GET /api: a worker's backend request (browser record 1)",
      `worker GET ${DAILY}: a worker's backend request (browser record 2)`,
    ]);
    expect(verdict.unresolved).toEqual([
      "worker GET /api: no end yet (browser record 1, headers 404 only)",
      `worker GET ${DAILY}: no end yet (browser record 2, pending)`,
    ]);
    // A static receipt carried by a worker record may be a page's forwarded request whose page record has not ended (nor got its id)
    // yet: the window cannot stop while that page record is unresolved, and once it ends the static request is the page's.
    n = 0;
    const waiting = [
      pending("/assets/x.js", "tab 2"),
      worker(1302, "/assets/x.js"),
    ];
    expect(
      run(win(1301, 1302, waiting), [entry(1302, "/assets/x.js")], waiting, {
        scope: "all",
      }).unresolved,
    ).toEqual([
      "page tab 2 GET /assets/x.js: no end yet (browser record 1, pending)",
    ]);
    const ended = [
      page(1302, "/assets/x.js", "tab 2", { n: 1, fromServiceWorker: true }),
      waiting[1] as Seen,
    ];
    expect(
      run(win(1301, 1302, ended), [entry(1302, "/assets/x.js")], ended, {
        scope: "all",
      }).problems,
    ).toEqual([]);
  });

  it("a backend answer from the worker's fetch handler fails from its headers alone, before the request ends", () => {
    n = 0;
    const early = [
      page(1201, DEFAULTS, "tab 2", {
        fromServiceWorker: true,
        finished: false,
      }),
    ];
    const verdict = run(
      win(1200, 1201, early),
      [entry(1201, DEFAULTS)],
      early,
      {
        scope: "backend",
      },
    );
    expect(verdict.failures).toEqual([
      `page tab 2 GET ${DEFAULTS}: answered by the worker (browser record 1)`,
    ]);
    expect(verdict.unresolved).toEqual([
      `#1201 GET ${DEFAULTS} (200, finished): the browser has not ended it (seen as page tab 2 answered by the worker)`,
      `page tab 2 GET ${DEFAULTS}: no end yet (browser record 1, headers 200 only)`,
    ]);
  });

  it("only a canonical positive safe integer is a request id; anything else in the header fails", () => {
    expect(parseRequestId("17")).toBe(17);
    for (const bad of [
      null,
      "",
      "0",
      "-1",
      "01",
      "1e3",
      "1.0",
      " 7",
      "NaN",
      "abc",
      "9007199254740993",
    ])
      expect(parseRequestId(bad), String(bad)).toBeNull();
    n = 0;
    for (const header of ["0", "-1", "NaN", "9007199254740993", "1e3"]) {
      const malformed = page(null, ME, "tab 2", { idHeader: header });
      const seen = [malformed];
      expect(
        run(win(400, 400, seen, { seenFrom: malformed.n - 1 }), [], seen, {
          scope: "backend",
        }).failures[0],
        header,
      ).toBe(
        `page tab 2 GET ${ME}: malformed server request id ${JSON.stringify(header)} (browser record ${malformed.n})`,
      );
    }
  });

  it("an id naming no request of this server fails; one beyond the ledger read is waited for; a stale/replayed id is a duplicate", () => {
    n = 0;
    const foreign = [page(7, ME, "tab 2")];
    expect(
      run(
        win(400, 401, foreign),
        [entry(401, "/health")],
        foreign,
        {
          scope: "backend",
        },
        { after: 400 },
      ).failures,
    ).toEqual([
      `page tab 2 GET ${ME}: names server request #7, which is outside the ledger read (browser record 1)`,
    ]);
    const ahead = [page(409, ME, "tab 2")];
    expect(
      run(win(400, 401, ahead), [entry(401, "/health")], ahead, {
        scope: "backend",
      }).unresolved,
    ).toEqual([
      "#401 GET /health (200, finished): unobserved",
      `page tab 2 GET ${ME}: its server request #409 is not in the ledger yet (browser record 2)`,
    ]);
    // The same receipt claimed by two page records (a replay, a cached copy): never two passes.
    const replayed = [page(401, ME, "tab 2"), page(401, ME, "tab 3")];
    expect(
      run(win(400, 401, replayed), [entry(401, ME)], replayed, {
        scope: "backend",
      }).failures,
    ).toEqual([
      `#401 GET ${ME} (200, finished): duplicate (seen as page tab 2; page tab 3)`,
    ]);
  });

  it("a receipt whose method or path is not the browser request's fails (never joined by id alone)", () => {
    n = 0;
    const seen = [
      page(501, "/api/experimental/v1/other", "tab 2", { method: "POST" }),
    ];
    expect(
      run(win(500, 501, seen), [entry(501, DEFAULTS)], seen, {
        scope: "backend",
      }).failures,
    ).toEqual([
      `#501 GET ${DEFAULTS} (200, finished): field-mismatch (seen as page tab 2)`,
    ]);
  });

  it("opening straddle: a request admitted during the opening read whose receipt lies at or below `from` is judged here", () => {
    n = 0;
    // Server receipt #600 was in the opening high-water (from = 600); the browser record arrived after the browser cut (seenFrom = 0).
    const healthy = [page(600, DEFAULTS, "tab 2")];
    const verdict = run(
      win(600, 600, healthy),
      [entry(599, "/assets/a.js"), entry(600, DEFAULTS)],
      healthy,
      { scope: "backend" },
      { after: 0, high: 600 },
    );
    // (The short reply is not contiguous from 0, so restrict the check to the straddle with a reply that starts at 598.)
    const straddle = run(
      win(600, 600, healthy),
      [entry(599, "/assets/a.js"), entry(600, DEFAULTS)],
      healthy,
      { scope: "backend" },
      { after: 598, high: 600 },
    );
    expect(
      verdict.failures.some((f) => /missing from the ledger/.test(f)),
    ).toBe(true);
    expect(straddle.problems).toEqual([]);
    expect(straddle.receipts).toEqual([600]);
    expect(straddle.pageBackend.map((a) => a.entry.id)).toEqual([600]);
    // The same straddling request answered by the worker is not hidden by the cut.
    n = 0;
    const forwarded = [
      page(600, DEFAULTS, "tab 2", { fromServiceWorker: true }),
      worker(600, DEFAULTS),
    ];
    expect(
      run(
        win(600, 600, forwarded),
        [entry(599, "/assets/a.js"), entry(600, DEFAULTS)],
        forwarded,
        { scope: "backend" },
        { after: 598, high: 600 },
      ).problems,
    ).toEqual([
      // The worker's own record names the receipt too, so the straddling server entry is judged as well.
      `#600 GET ${DEFAULTS} (200, finished): worker-fulfilled (seen as page tab 2 answered by the worker; worker)`,
      `page tab 2 GET ${DEFAULTS}: answered by the worker (browser record 1)`,
      `worker GET ${DEFAULTS}: a worker's backend request (browser record 2)`,
    ]);
  });

  it("carried work: a record unfinished when the window opened is this window's, pending or ended", () => {
    n = 0;
    const early = pending(DAILY, "tab 2");
    const later = page(701, "/health", "tab 2");
    const window = win(700, 701, [early, later], {
      seenFrom: early.n,
      carry: [early.n],
    });
    expect(
      run(window, [entry(701, "/health")], [early, later], { scope: "backend" })
        .unresolved,
    ).toEqual([
      `page tab 2 GET ${DAILY}: no end yet (browser record 1, pending)`,
    ]);
    const ended = {
      ...early,
      id: 699,
      idHeader: "699",
      status: 200,
      fromServiceWorker: false,
      finished: true,
    };
    const verdict = run(
      window,
      [entry(699, DAILY), entry(700, "/assets/a.js"), entry(701, "/health")],
      [ended, later],
      { scope: "backend" },
      { after: 698 },
    );
    expect(verdict.problems).toEqual([]);
    expect(verdict.receipts).toEqual([699, 701]);
    // Not carried: an earlier record is outside the window and is not judged here.
    expect(
      run(
        win(700, 701, [early, later], { seenFrom: early.n }),
        [entry(701, "/health")],
        [early, later],
        {
          scope: "backend",
        },
      ).problems,
    ).toEqual([]);
  });

  it("a server entry without a browser event is waited for, then attributed to a page, or failed for a worker", () => {
    n = 0;
    const entries = [entry(801, DAILY)];
    expect(
      run(win(800, 801, []), entries, [], { scope: "backend" }).unresolved,
    ).toEqual([`#801 GET ${DAILY} (200, finished): unobserved`]);
    const seenPage = [page(801, DAILY, "tab 2")];
    expect(
      run(win(800, 801, seenPage), entries, seenPage, { scope: "backend" })
        .problems,
    ).toEqual([]);
    const seenWorker = [worker(801, DAILY)];
    expect(
      run(win(800, 801, seenWorker), entries, seenWorker, { scope: "backend" })
        .failures[0],
    ).toMatch(/worker-origin/);
  });

  it("a record outside the window that carries an in-window receipt holds the verdict until it ends", () => {
    n = 0;
    const inside = page(901, "/health", "tab 2");
    const outside = page(902, DAILY, "tab 4", { finished: false });
    const verdict = run(
      win(900, 902, [inside], { seenTo: inside.n }),
      [entry(901, "/health"), entry(902, DAILY)],
      [inside, outside],
      { scope: "backend" },
    );
    expect(verdict.unresolved).toEqual([
      `#902 GET ${DAILY} (200, finished): the browser has not ended it (seen as page tab 4)`,
    ]);
  });

  it("static scope boundaries: a cached copy's stale id is not a receipt; a static page request must still end in scope all", () => {
    n = 0;
    const cachedCopy = [
      page(5, "/assets/x.js", "tab 2", { fromServiceWorker: true }),
    ];
    expect(
      run(win(1000, 1000, cachedCopy), [], cachedCopy, { scope: "all" })
        .problems,
    ).toEqual([]);
    const loading = [
      page(null, "/assets/x.js", "tab 2", {
        status: null,
        fromServiceWorker: null,
        finished: false,
      }),
    ];
    expect(
      run(win(1000, 1000, loading), [], loading, { scope: "all" }).unresolved,
    ).toEqual([
      "page tab 2 GET /assets/x.js: no end yet (browser record 2, pending)",
    ]);
    expect(
      run(win(1000, 1000, loading), [], loading, { scope: "backend" }).problems,
    ).toEqual([]);
    const aborted = [
      page(null, "/assets/x.js", "tab 2", {
        status: null,
        fromServiceWorker: null,
        finished: false,
        failed: "NS_BINDING_ABORTED",
      }),
    ];
    expect(
      run(win(1000, 1000, aborted), [], aborted, { scope: "all" }).failures,
    ).toEqual([
      "page tab 2 GET /assets/x.js: failed: NS_BINDING_ABORTED (browser record 3)",
    ]);
    // A worker's static fetch with no receipt is unattributable in scope all, and not judged in scope backend.
    const fetched = [worker(null, "/assets/y.js")];
    expect(
      run(win(1000, 1000, fetched), [], fetched, { scope: "all" }).failures,
    ).toEqual([
      "worker GET /assets/y.js: no server receipt (browser record 4)",
    ]);
    expect(
      run(win(1000, 1000, fetched), [], fetched, { scope: "backend" }).problems,
    ).toEqual([]);
  });

  it("a malformed, out-of-range or short ledger reply is never a pass", () => {
    n = 0;
    const seen = [page(1101, "/health", "tab 1")];
    const window = win(1100, 1101, seen);
    expect(
      run(window, [{ ...entry(1101, "/health"), id: Number.NaN }], seen, {
        scope: "backend",
      }).failures,
    ).toContain("server request #1101 is missing from the ledger");
    expect(
      run(
        window,
        [{ ...entry(1101, "/health"), end: "weird" as never }],
        seen,
        { scope: "backend" },
      ).failures[0],
    ).toMatch(/malformed/);
    expect(
      run(window, [entry(1101, "/health"), entry(1102, "/health")], seen, {
        scope: "backend",
      }).failures,
    ).toContain(
      "server request #1102 is outside the ledger reply (1100, 1101]",
    );
    expect(
      run(
        window,
        [entry(1101, "/health")],
        seen,
        { scope: "backend" },
        { high: 1100 },
      ).failures[0],
    ).toMatch(/does not cover window/);
  });
});
