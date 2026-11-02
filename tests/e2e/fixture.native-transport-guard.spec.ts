import { connect } from "node:net";
import type { Browser, BrowserContext, Page } from "@playwright/test";
import { expect, test } from "./helpers";
import {
  type Ingest,
  type Interpose,
  type LaneReport,
  LaneSeamMisuse,
  type LaneVerdict,
  type OpenStage,
  type OriginRoute,
  openTransportLanes,
  type TransportLane,
} from "./native-transport";

/**
 * WEB-13b revision 19 (Review 23 F23-1/F23-2; design assessment token 3266b126…, qualification Q3, schedules D02–D05 and D07): the
 * native transport lane's console guard and cleanup in REAL engines, before any application case relies on them. Each case opens a lane
 * itself (`openTransportLanes`), provokes real HTTP responses, request failures, warnings and page errors on a quiet page the lane's
 * scripted origin serves, settles the lane (closing everything it owns first) and asserts the EXACT classification: every positive beside
 * its unexpected-error negative. No case expects the application; none weakens the guard: the fixture's own teardown is unchanged, and
 * these cases judge the same report it would judge.
 *
 * Network failures are provoked as each engine logs them: a no-store fetch in Chromium and WebKit, a FontFace download in Firefox (which
 * logs nothing for a failed fetch). HTTP statuses are provoked with fetch (Chromium and WebKit log them; Firefox does not, so its HTTP
 * schedules have no message to judge, and the declaration counts are judged from the browser's own responses in every engine). Delivery DELAY of a console event cannot be
 * controlled through Playwright: D06 is qualified on the pure journal only (tests/static/native-transport.test.ts).
 *
 * Revision 26 (Review 31 F31-1; NAV1–NAV5): a navigation's own response and its message, the document transitions of redirects, reloads,
 * 204s, downloads, failed navigations and same-document changes, and a REAL native message held downstream of the lane's native listener
 * (the `ingest` qualification seam) until after a restoration, a navigation, a page close or settlement. A delay BEFORE the listener (in
 * the engine or Playwright) is still not controllable here: such a message is attributed to the document current when it arrives.
 *
 * Revision 27 (Review 32 F32-1; design assessment token f0a2dd0e6c…, NAV-C1–C9): the document moves on only at Playwright's own
 * new-document navigation event. NAV6 is Review 32's schedule (a navigation held at the origin, stopped, then history to its URL, with a
 * declared delayed fetch 500 of the surviving document), stopped by the page's native window.stop() in every engine and by the browser's
 * Stop in Chromium; NAV7 history to a still-pending navigation's URL before its genuine commit; NAV8 two pages; NAV9 same-URL
 * supersession. Each native action waits on the origin-arrival barrier (`heldRoute`, `armOnCookie`), never on elapsed time.
 */

const GUARD = "/api/__guard";

async function guardLane(
  lanes: ReturnType<typeof openTransportLanes>,
): Promise<TransportLane> {
  const lane = await lanes.open({ mode: "fixture" });
  await lane.routes.route(`**${GUARD}/page*`, (route) =>
    (route as unknown as OriginRoute).fulfill({
      status: 200,
      contentType: "text/html",
      headers: { "cache-control": "no-store" },
      body: "<!doctype html><html><head><title>Guard</title></head><body>guard</body></html>",
    }),
  );
  await lane.routes.route(`**${GUARD}/status/*`, (route) => {
    const status = Number(route.request().url().split("/").pop());
    return (route as unknown as OriginRoute).fulfill({
      status,
      contentType: "text/plain",
      headers: { "cache-control": "no-store" },
      body: `status ${status}`,
    });
  });
  // Online, a reset AFTER arrival: the browser's request fails in the network, but the front forwarded it (not a transport loss).
  await lane.routes.route(`**${GUARD}/reset/*`, (route) =>
    (route as unknown as OriginRoute).abort("connectionreset"),
  );
  return lane;
}

const open = async (lane: TransportLane, n = 0) => {
  const page = await lane.context.newPage();
  await page.goto(`${GUARD}/page?${n}`);
  return page;
};
/** A FontFace download of `path`: resolves when the engine has given up on it (a failure is the point). */
const font = (page: Page, path: string) =>
  page.evaluate(
    (p) =>
      new FontFace(`g${Math.random()}`.replace(".", ""), `url(${p})`)
        .load()
        .then(
          () => "loaded",
          () => "failed",
        ),
    path,
  );
/**
 * A request of `path` that fails in the network, in the form the engine LOGS: a no-store fetch for Chromium and WebKit (each logs a
 * failed fetch, located at the resource); a FontFace download for Firefox (it logs only the font's failure, naming the resource).
 */
const networkFailure = async (page: Page, path: string, browserName: string) =>
  browserName === "firefox"
    ? font(page, path)
    : page.evaluate(
        (p) =>
          fetch(p, { cache: "no-store" }).then(
            () => "loaded",
            () => "failed",
          ),
        path,
      );
const fetchStatus = (page: Page, path: string) =>
  page.evaluate(
    (p) => fetch(p, { cache: "no-store" }).then((r) => r.status),
    path,
  );
/** Settles once the engine has had its turn to deliver what it logs about the requests so far (a condition: the journal stops changing). */
async function quiet(lane: TransportLane) {
  let last = -1;
  for (let i = 0; i < 200; i += 1) {
    const now =
      lane.journal.problems.length +
      lane.journal.requests.filter((r) => r.terminal !== null).length;
    if (now === last) return;
    last = now;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
const summary = (v: LaneVerdict) =>
  v.problems.map((p) => ({
    page: p.page,
    document: p.document,
    category: p.category,
    verdict: p.verdict,
    url: p.url.replace(/^https?:\/\/[^/]+/, ""),
  }));
const logsHttp = (browserName: string) => browserName !== "firefox";

async function settle(
  lanes: ReturnType<typeof openTransportLanes>,
  lane: TransportLane,
): Promise<{ report: LaneReport; verdict: LaneVerdict }> {
  const report = await lanes.settle();
  const verdict = lane.verdict();
  await test.info().attach("guard-verdict", {
    body: JSON.stringify(
      { report, problems: summary(verdict), raw: lane.journal.problems },
      null,
      1,
    ),
    contentType: "application/json",
  });
  expect(report.closeErrors, "everything the lane owned closed").toEqual([]);
  expect(report.reportErrors).toEqual([]);
  expect(report.openErrors, "every open finished").toEqual([]);
  return { report, verdict };
}

test.describe("native transport guard (revision 19 qualification in real engines)", () => {
  test("D02: an online HTTP 500 and an online reset of the same URL stay unexpected beside that URL's genuine loss", async ({
    browser,
    browserName,
  }) => {
    const lanes = openTransportLanes(browser, test.info());
    try {
      const lane = await guardLane(lanes);
      const page = await open(lane);
      const url = `${GUARD}/status/500`;
      expect(await fetchStatus(page, url)).toBe(500);
      expect(await networkFailure(page, `${GUARD}/reset/f`, browserName)).toBe(
        "failed",
      );
      await quiet(lane);
      await lane.lose();
      expect(await networkFailure(page, `${GUARD}/reset/f`, browserName)).toBe(
        "failed",
      );
      await quiet(lane);
      expect(await lane.restore()).toEqual([]);
      const { report, verdict } = await settle(lanes, lane);
      expect(summary(verdict)).toEqual([
        ...(logsHttp(browserName)
          ? [
              {
                page: 0,
                document: 1,
                category: "http",
                verdict: "unexpected",
                url,
              },
            ]
          : []),
        {
          page: 0,
          document: 1,
          category: "network",
          verdict: "unexpected",
          url: `${GUARD}/reset/f`,
        },
        {
          page: 0,
          document: 1,
          category: "network",
          verdict: "expected",
          url: `${GUARD}/reset/f`,
        },
      ]);
      expect(verdict.expected[0]?.evidence?.generations).toEqual([1]);
      expect(report.failures).toHaveLength(verdict.unexpected.length);
    } finally {
      await lanes.settle();
    }
  });

  test("D05: a page error naming a declared status, warnings and forged network wording fail; only the declared response's own message is expected, and an extra one is beyond its count", async ({
    browser,
    browserName,
  }) => {
    const lanes = openTransportLanes(browser, test.info());
    try {
      const lane = await guardLane(lanes);
      const page = await open(lane);
      const declared = `${GUARD}/status/502`;
      lane.expectHttp({
        method: "GET",
        path: declared,
        status: 502,
        count: 1,
        reason: "the guard's declared 502",
      });
      expect(await fetchStatus(page, declared)).toBe(502);
      expect(await fetchStatus(page, `${GUARD}/status/503`)).toBe(503);
      // Waited for from BEFORE the throw: the event can be delivered as soon as evaluate returns.
      const thrown = page.waitForEvent("pageerror");
      await page.evaluate(() => {
        console.warn("Failed to load resource: net::ERR_EMPTY_RESPONSE");
        console.error("Failed to load resource: net::ERR_EMPTY_RESPONSE");
        setTimeout(() => {
          throw new Error("Unhandled application error with a status of 502");
        }, 0);
      });
      await thrown;
      expect(await fetchStatus(page, declared)).toBe(502);
      await quiet(lane);
      const { verdict } = await settle(lanes, lane);
      const http = logsHttp(browserName);
      expect(
        verdict.problems.map((p) => [p.category, p.verdict, p.status ?? null]),
      ).toEqual([
        ...(http ? [["http", "expected", 502]] : []),
        ...(http ? [["http", "unexpected", 503]] : []),
        ["warning", "unexpected", null],
        // A page's own console.error in network wording is located at the page, not at a failed request of it.
        ["network", "unexpected", null],
        ["exception", "unexpected", null],
        ...(http ? [["http", "unexpected", 502]] : []),
      ]);
      expect(verdict.violations).toEqual([
        expect.stringMatching(/1 response\(s\) beyond the declared 1/),
      ]);
    } finally {
      await lanes.settle();
    }
  });

  test("D03: two pages and one URL: page A's loss is expected, page B's online reset of the same URL is not", async ({
    browser,
    browserName,
  }) => {
    const lanes = openTransportLanes(browser, test.info());
    try {
      const lane = await guardLane(lanes);
      const a = await open(lane, 1);
      const b = await open(lane, 2);
      const url = `${GUARD}/reset/shared`;
      await lane.lose();
      expect(await networkFailure(a, url, browserName)).toBe("failed");
      await quiet(lane);
      expect(await lane.restore()).toEqual([]);
      expect(await networkFailure(b, url, browserName)).toBe("failed");
      await quiet(lane);
      const { verdict } = await settle(lanes, lane);
      expect(
        verdict.problems.map((p) => [p.page, p.category, p.verdict]),
      ).toEqual([
        [0, "network", "expected"],
        [1, "network", "unexpected"],
      ]);
    } finally {
      await lanes.settle();
    }
  });

  test("D04: a new document cannot use the previous document's loss; its own reset of the same URL is unexpected", async ({
    browser,
    browserName,
  }) => {
    const lanes = openTransportLanes(browser, test.info());
    try {
      const lane = await guardLane(lanes);
      const page = await open(lane, 1);
      const url = `${GUARD}/reset/doc`;
      await lane.lose();
      expect(await networkFailure(page, url, browserName)).toBe("failed");
      await quiet(lane);
      expect(await lane.restore()).toEqual([]);
      await page.goto(`${GUARD}/page?again`);
      expect(await networkFailure(page, url, browserName)).toBe("failed");
      await quiet(lane);
      const { verdict } = await settle(lanes, lane);
      expect(
        verdict.problems.map((p) => [p.document, p.category, p.verdict]),
      ).toEqual([
        [1, "network", "expected"],
        [2, "network", "unexpected"],
      ]);
      const fonts = lane.journal.requests.filter((r) => r.url.endsWith(url));
      expect(fonts.map((r) => r.document)).toEqual([1, 2]);
    } finally {
      await lanes.settle();
    }
  });

  test("D07 in the engine: a request held at the scripted origin when the case ends is cancelled and joined by the lane's close", async ({
    browser,
  }) => {
    const lanes = openTransportLanes(browser, test.info());
    try {
      const lane = await guardLane(lanes);
      let release: () => void = () => undefined;
      const hold = new Promise<void>((resolve) => {
        release = resolve;
      });
      let arrived: () => void = () => undefined;
      const seen = new Promise<void>((resolve) => {
        arrived = resolve;
      });
      await lane.routes.route(`**${GUARD}/held`, async (route) => {
        const own = route as unknown as OriginRoute;
        arrived();
        const outcome = await Promise.race([
          hold.then(() => "released"),
          new Promise((resolve) =>
            own.signal.addEventListener("abort", () => resolve("cancelled")),
          ),
        ]);
        if (outcome === "released") await own.fulfill({ body: "late" });
      });
      const page = await open(lane);
      void page
        .evaluate(
          (p) =>
            fetch(p).then(
              () => true,
              () => false,
            ),
          `${GUARD}/held`,
        )
        .catch(() => undefined);
      await seen;
      const { report } = await settle(lanes, lane);
      release();
      expect(lane.origin?.owned()).toMatchObject({
        state: "closed",
        dispatches: [],
        upstreams: 0,
        connections: 0,
        listening: false,
      });
      expect(
        lane.origin?.receipts.find((r) => r.url.endsWith(`${GUARD}/held`))
          ?.outcome,
      ).toBe("cancelled");
      expect(lane.transport.owned()).toEqual({
        clientSockets: 0,
        upstreams: 0,
        listening: false,
      });
      expect(report.failures).toEqual([]);
    } finally {
      await lanes.settle();
    }
  });
});

// ---- Revision 26 (Review 31 F31-1, family native-transport-console-attribution; design assessment token 37c3b6402c…, NAV1–NAV5) -------

const S503 =
  "Failed to load resource: the server responded with a status of 503 (Service Unavailable)";
/** The guard's lane with the navigation answers: a redirect, a 204, a download and a 503 document that forges the engine's message. */
async function navigationLane(
  lanes: ReturnType<typeof openTransportLanes>,
): Promise<TransportLane> {
  const lane = await guardLane(lanes);
  await lane.routes.route(`**${GUARD}/redirect/*`, (route) =>
    (route as unknown as OriginRoute).fulfill({
      status: 302,
      headers: {
        location: `${GUARD}/status/${route.request().url().split("/").pop()}`,
        "cache-control": "no-store",
      },
    }),
  );
  await lane.routes.route(`**${GUARD}/nocontent`, (route) =>
    (route as unknown as OriginRoute).fulfill({
      status: 204,
      headers: { "cache-control": "no-store" },
    }),
  );
  await lane.routes.route(`**${GUARD}/download`, (route) =>
    (route as unknown as OriginRoute).fulfill({
      status: 200,
      contentType: "application/octet-stream",
      headers: {
        "content-disposition": "attachment; filename=guard.bin",
        "cache-control": "no-store",
      },
      body: "guard",
    }),
  );
  // The document's OWN console.error in the engine's wording, located at the document's URL (the navigation's URL).
  await lane.routes.route(`**${GUARD}/forged`, (route) =>
    (route as unknown as OriginRoute).fulfill({
      status: 503,
      contentType: "text/html",
      headers: { "cache-control": "no-store" },
      body: `<!doctype html><title>Forged</title><body>forged<script>console.error(${JSON.stringify(S503)})</script></body>`,
    }),
  );
  return lane;
}
const path = (url: string) => url.replace(/^https?:\/\/[^/]+/, "");
/** A page.goto that the engine refuses on purpose (a 204, a download, a lost navigation): its rejection is the point. */
const refusedGoto = (page: Page, url: string) =>
  page.goto(url).then(
    () => "committed",
    () => "refused",
  );
/**
 * Each expected HTTP message's relation agrees with its own request: `same-document` exactly when the message is in the request's
 * initiating document, otherwise `committed-by-navigation` for the document that request (a navigation) committed.
 */
const relationAgrees = (v: LaneVerdict, lane: TransportLane) =>
  v.expected
    .filter((p) => p.category === "http")
    .every((p) => {
      const r = lane.journal.requests.find(
        (q) => q.seq === p.evidence?.request,
      );
      if (r === undefined) return false;
      return p.document === r.document
        ? p.evidence?.relation === "same-document"
        : p.evidence?.relation === "committed-by-navigation" &&
            r.navigation &&
            r.commit?.document === p.document;
    });

test.describe("native transport navigation attribution (revision 26 qualification in real engines)", () => {
  test("NAV1 Review 31's ordinary schedule: a declared fetch 500 and a declared navigation 503 are each expected once, by their own requests; the navigation keeps its initiating document and records the one it committed", async ({
    browser,
    browserName,
  }) => {
    const lanes = openTransportLanes(browser, test.info());
    try {
      const lane = await navigationLane(lanes);
      const page = await open(lane);
      lane.expectHttp({
        method: "GET",
        path: `${GUARD}/status/500`,
        status: 500,
        count: 1,
        reason: "NAV1 fetch control",
      });
      expect(await fetchStatus(page, `${GUARD}/status/500`)).toBe(500);
      lane.expectHttp({
        method: "GET",
        path: `${GUARD}/status/503`,
        status: 503,
        count: 1,
        reason: "NAV1 the navigation itself",
      });
      expect((await page.goto(`${GUARD}/status/503`))?.status()).toBe(503);
      await quiet(lane);
      const { report, verdict } = await settle(lanes, lane);
      expect(verdict.unexpected).toEqual([]);
      expect(verdict.violations).toEqual([]);
      expect(report.failures).toEqual([]);
      expect(
        verdict.expected.map((p) => [p.category, p.status, path(p.url)]),
      ).toEqual(
        logsHttp(browserName)
          ? [
              ["http", 500, `${GUARD}/status/500`],
              ["http", 503, `${GUARD}/status/503`],
            ]
          : [],
      );
      expect(relationAgrees(verdict, lane)).toBe(true);
      const nav = lane.journal.requests.find((r) =>
        r.url.endsWith(`${GUARD}/status/503`),
      );
      expect(nav).toMatchObject({
        navigation: true,
        document: 1,
        terminal: { kind: "response", status: 503 },
        commit: { document: 2 },
      });
      expect(verdict.expectations.map((e) => e.matched.length)).toEqual([1, 1]);
      expect(lane.journal.engine).toBe(browserName);
      await test.info().attach("nav1-relations", {
        body: JSON.stringify(
          verdict.expected.map((p) => ({
            document: p.document,
            relation: p.evidence?.relation,
          })),
        ),
        contentType: "application/json",
      });
    } finally {
      await lanes.settle();
    }
  });

  test("NAV2 the document moves on only at a commit (revision 27: Playwright's new-document event): a redirect chain commits once, a reload commits, a 204 and a download do not, fragments and history changes do not; a lost navigation's own message is its initiating document's", async ({
    browser,
    browserName,
  }) => {
    const lanes = openTransportLanes(browser, test.info());
    try {
      const lane = await navigationLane(lanes);
      const page = await open(lane);
      lane.expectHttp({
        method: "GET",
        path: `${GUARD}/status/502`,
        status: 502,
        count: 2,
        reason: "NAV2 the redirect's final hop and its reload",
      });
      expect((await page.goto(`${GUARD}/redirect/502`))?.status()).toBe(502);
      expect((await page.reload())?.status()).toBe(502);
      expect(await refusedGoto(page, `${GUARD}/nocontent`)).toBe("refused");
      expect(await refusedGoto(page, `${GUARD}/download`)).toBe("refused");
      await page.evaluate(() => {
        location.hash = "fragment";
        history.pushState({}, "", "/api/__guard/pushed");
      });
      lane.expectHttp({
        method: "GET",
        path: `${GUARD}/status/500`,
        status: 500,
        count: 1,
        reason: "NAV2 a fetch of the document the reload committed",
      });
      expect(await fetchStatus(page, `${GUARD}/status/500`)).toBe(500);
      await quiet(lane);
      await lane.lose();
      expect(await refusedGoto(page, `${GUARD}/reset/navigation`)).toBe(
        "refused",
      );
      await quiet(lane);
      expect(await lane.restore()).toEqual([]);
      await page.goto(`${GUARD}/page?after`);
      await quiet(lane);
      const { verdict } = await settle(lanes, lane);
      expect(verdict.unexpected).toEqual([]);
      expect(verdict.violations).toEqual([]);
      const req = (suffix: string) =>
        lane.journal.requests.filter((r) => r.url.endsWith(suffix));
      expect(req(`${GUARD}/redirect/502`)).toMatchObject([
        {
          document: 1,
          commit: null,
          commitReason: expect.stringMatching(/^redirected to #\d+$/),
        },
      ]);
      const finals = req(`${GUARD}/status/502`);
      expect(finals.map((r) => [r.document, r.commit?.document])).toEqual([
        [1, 2],
        [2, 3],
      ]);
      expect(finals[0]?.redirectedFrom).toBe(
        req(`${GUARD}/redirect/502`)[0]?.seq,
      );
      for (const suffix of [`${GUARD}/nocontent`, `${GUARD}/download`])
        expect(req(suffix), suffix).toMatchObject([
          {
            document: 3,
            commit: null,
            // Revision 27 (F32-1): Playwright's own abort event decides it, in every engine (diag/order-2).
            commitReason: expect.stringMatching(
              /^aborted without committing a document: /,
            ),
          },
        ]);
      expect(req(`${GUARD}/status/500`).map((r) => r.document)).toEqual([3]);
      const lost = req(`${GUARD}/reset/navigation`);
      expect(lost.every((r) => r.document === 3)).toBe(true);
      expect(lost.every((r) => r.commit === null)).toBe(true);
      // Chromium and Firefox commit an error document for the lost navigation, each a new document Playwright links to NO request
      // (revision 27: revision 26 attributed Firefox's, at the failed URL, by that URL); WebKit commits none. The abort comes first.
      const errorDocument = browserName !== "webkit";
      expect(req(`${GUARD}/page?after`).map((r) => r.document)).toEqual([
        errorDocument ? 4 : 3,
      ]);
      expect(
        (lane.journal.navigations ?? []).map((n) => [
          n.kind,
          n.document,
          n.request === null ? null : "request",
        ]),
      ).toEqual([
        ["new-document", 1, "request"],
        ["new-document", 2, "request"],
        ["new-document", 3, "request"],
        ["aborted", 3, "request"],
        ["aborted", 3, "request"],
        ["same-document", 3, null],
        ["same-document", 3, null],
        ["aborted", 3, "request"],
        ...(errorDocument ? [["new-document", 4, null]] : []),
        ["new-document", errorDocument ? 5 : 4, "request"],
      ]);
      expect(
        verdict.expected.map((p) => [p.category, p.status ?? null]),
      ).toEqual([
        ...(logsHttp(browserName)
          ? [
              ["http", 502],
              ["http", 502],
              ["http", 500],
            ]
          : []),
        // WebKit logs the lost navigation's failure in the document it was issued from (no error document is committed).
        ...(browserName === "webkit" ? [["network", null]] : []),
      ]);
      expect(relationAgrees(verdict, lane)).toBe(true);
    } finally {
      await lanes.settle();
    }
  });

  test("NAV3 two pages navigate to one URL with one declared status: only the first is declared; the other's message is unexpected and its response is beyond the declaration", async ({
    browser,
    browserName,
  }) => {
    const lanes = openTransportLanes(browser, test.info());
    try {
      const lane = await navigationLane(lanes);
      const a = await open(lane, 1);
      const b = await open(lane, 2);
      lane.expectHttp({
        method: "GET",
        path: `${GUARD}/status/503`,
        status: 503,
        count: 1,
        reason: "NAV3 page A's navigation",
      });
      expect((await a.goto(`${GUARD}/status/503`))?.status()).toBe(503);
      await quiet(lane);
      expect((await b.goto(`${GUARD}/status/503`))?.status()).toBe(503);
      await quiet(lane);
      const { verdict } = await settle(lanes, lane);
      expect(
        verdict.problems.map((p) => [p.page, p.category, p.verdict]),
      ).toEqual(
        logsHttp(browserName)
          ? [
              [0, "http", "expected"],
              [1, "http", "unexpected"],
            ]
          : [],
      );
      expect(verdict.violations).toEqual([
        expect.stringMatching(/1 response\(s\) beyond the declared 1/),
      ]);
    } finally {
      await lanes.settle();
    }
  });

  test("NAV4 a document's own message forged in the engine's wording at the navigation's URL, and an undeclared navigation status, stay unexpected; the declared navigation's message is credited once", async ({
    browser,
    browserName,
  }) => {
    const lanes = openTransportLanes(browser, test.info());
    try {
      const lane = await navigationLane(lanes);
      const page = await open(lane);
      lane.expectHttp({
        method: "GET",
        path: `${GUARD}/forged`,
        status: 503,
        count: 1,
        reason: "NAV4 the forging document's navigation",
      });
      expect((await page.goto(`${GUARD}/forged`))?.status()).toBe(503);
      await quiet(lane);
      expect((await page.goto(`${GUARD}/status/504`))?.status()).toBe(504);
      await quiet(lane);
      const { verdict } = await settle(lanes, lane);
      expect(
        verdict.problems.map((p) => [
          path(p.url),
          p.category,
          p.status,
          p.verdict,
        ]),
      ).toEqual([
        ...(logsHttp(browserName)
          ? [
              [`${GUARD}/forged`, "http", 503, "expected"],
              [`${GUARD}/forged`, "http", 503, "unexpected"],
              [`${GUARD}/status/504`, "http", 504, "unexpected"],
            ]
          : [[`${GUARD}/forged`, "http", 503, "unexpected"]]),
      ]);
      expect(verdict.violations).toEqual([]);
    } finally {
      await lanes.settle();
    }
  });

  for (const release of ["restore", "navigate", "close"] as const)
    test(`NAV5 a real native message held at the ingestion seam, released after ${release}: it keeps the page and document its listener saw; the unrelated page still works`, async ({
      browser,
      browserName,
    }) => {
      const holds: Array<() => void> = [];
      let holding = false;
      const ingest: Ingest = (p, deliver) => {
        if (holding && p.category === "network") holds.push(deliver);
        else deliver();
      };
      const lanes = openTransportLanes(browser, test.info(), { ingest });
      try {
        const lane = await guardLane(lanes);
        const a = await open(lane, 1);
        const b = await open(lane, 2);
        const url = `${GUARD}/reset/held`;
        await lane.lose();
        holding = true;
        expect(await networkFailure(a, url, browserName)).toBe("failed");
        await expect.poll(() => holds.length).toBe(1);
        expect(lane.heldProblems()).toMatchObject([
          { page: 0, document: 1, category: "network" },
        ]);
        expect(lane.journal.problems).toEqual([]);
        expect(await lane.restore()).toEqual([]);
        if (release === "navigate") await a.goto(`${GUARD}/page?new`);
        if (release === "close") await a.close();
        holding = false;
        for (const deliver of holds.splice(0)) deliver();
        if (release === "navigate")
          expect(await networkFailure(a, url, browserName)).toBe("failed");
        expect(lane.judge(await lane.probe(b), "online")).toEqual([]);
        await quiet(lane);
        const { verdict } = await settle(lanes, lane);
        expect(
          verdict.problems.map((p) => [
            p.page,
            p.document,
            p.category,
            p.verdict,
          ]),
        ).toEqual([
          [0, 1, "network", "expected"],
          ...(release === "navigate" ? [[0, 2, "network", "unexpected"]] : []),
        ]);
      } finally {
        holding = false;
        for (const deliver of holds.splice(0)) deliver();
        await lanes.settle();
      }
    });

  test("NAV5 a real native message still held when settlement classifies: the report fails by name; its later delivery is late and never classified", async ({
    browser,
    browserName,
  }) => {
    const holds: Array<() => void> = [];
    const lateLines: string[] = [];
    const lanes = openTransportLanes(browser, test.info(), {
      ingest: (p, deliver) => {
        if (p.category === "network") holds.push(deliver);
        else deliver();
      },
      onLate: (line) => void lateLines.push(line),
    });
    try {
      const lane = await guardLane(lanes);
      const a = await open(lane, 1);
      await lane.lose();
      expect(
        await networkFailure(a, `${GUARD}/reset/settled`, browserName),
      ).toBe("failed");
      await expect.poll(() => holds.length).toBe(1);
      expect(await lane.restore()).toEqual([]);
      const report = await lanes.settle();
      expect(report.closeErrors).toEqual([]);
      expect(report.failures).toEqual([
        expect.stringMatching(
          /^lane 0: a console problem captured at journal #\d+ \(page 0 document 1 error\) was still held by the ingestion seam when the journal was classified/,
        ),
      ]);
      for (const deliver of holds.splice(0)) deliver();
      expect(lane.journal.problems).toEqual([]);
      expect(lane.journal.late).toHaveLength(1);
      expect(lateLines).toEqual([expect.stringMatching(/not classified/)]);
    } finally {
      for (const deliver of holds.splice(0)) deliver();
      await lanes.settle();
    }
  });
});

// ---- Revision 27 (Review 32 F32-1, family native-transport-console-attribution; design assessment token f0a2dd0e6c…, NAV-C1–C9) -------

/**
 * A route of the lane's scripted origin that HOLDS each arrival (a real request, its connection open) until `release`, then answers it,
 * unless the browser cancelled it first (then it writes nothing). `arrivals` counts arrivals; `arrived(n)` resolves at the n-th.
 * `holdFirst` holds only the first arrival and answers later ones at once.
 */
async function heldRoute(
  lane: TransportLane,
  glob: string,
  answer:
    | { status: number; contentType: string; body: string }
    | ((arrival: number) => {
        status: number;
        contentType: string;
        body: string;
      }),
  options: { holdFirst?: boolean } = {},
) {
  const gates: Array<() => void> = [];
  const waiters: Array<{ n: number; resolve: () => void }> = [];
  let arrivals = 0;
  const cancelled: number[] = [];
  await lane.routes.route(glob, async (route) => {
    const r = route as unknown as OriginRoute;
    arrivals += 1;
    const mine = arrivals;
    for (const w of waiters.filter((x) => x.n <= mine)) w.resolve();
    if (!(options.holdFirst === true && mine > 1))
      await new Promise<void>((resolve) => {
        gates.push(resolve);
        if (r.signal.aborted) resolve();
        else
          r.signal.addEventListener("abort", () => resolve(), { once: true });
      });
    if (r.signal.aborted) {
      cancelled.push(mine);
      return;
    }
    const a = typeof answer === "function" ? answer(mine) : answer;
    await r.fulfill({
      status: a.status,
      contentType: a.contentType,
      headers: { "cache-control": "no-store" },
      body: a.body,
    });
  });
  return {
    arrived: (n = 1) =>
      new Promise<void>((resolve) => {
        if (arrivals >= n) resolve();
        else waiters.push({ n, resolve });
      }),
    release: () => {
      for (const g of gates.splice(0)) g();
    },
    cancelled,
  };
}
const SENTINEL = (name: string) =>
  `<!doctype html><title>${name}</title><body>${name}<script>window.documentIdentity = ${JSON.stringify(name)};</script></body>`;
const identityOf = (page: Page) =>
  page.evaluate(
    () =>
      (window as unknown as { documentIdentity?: string }).documentIdentity ??
      null,
  );
/**
 * Arms, in the page's CURRENT document, a native action run when the cookie `name` appears (polled by the page itself). The test sets
 * the cookie only after the origin-arrival barrier, so the action runs while the navigation is genuinely held, without evaluating in the
 * page then (Chromium does not run an evaluation while a browser-initiated navigation is pending: diag/order-3 E4).
 */
const armOnCookie = (
  page: Page,
  name: string,
  action: "stop" | "history",
  url: string,
) =>
  page.evaluate(
    ({ n, a, u }) => {
      const timer = setInterval(() => {
        if (!document.cookie.split("; ").includes(`${n}=1`)) return;
        clearInterval(timer);
        if (a === "stop") window.stop();
        else history.pushState({}, "", u);
      }, 10);
    },
    { n: name, a: action, u: url },
  );
const setCookie = (page: Page, name: string) =>
  page
    .context()
    .addCookies([{ name, value: "1", url: new URL(page.url()).origin }]);
const transitionsOf = (lane: TransportLane, page = 0) =>
  (lane.journal.navigations ?? [])
    .filter((n) => n.page === page)
    .map((n) => [n.kind, n.document, n.request === null ? null : "request"]);

test.describe("native transport navigation provenance (revision 27 qualification in real engines)", () => {
  for (const initiator of ["page", "browser"] as const)
    test(`NAV6 Review 32's schedule, ${initiator === "page" ? "a page-initiated navigation stopped by the page's native window.stop()" : "a browser-initiated navigation (page.goto) stopped by the browser's Stop in Chromium (CDP Page.stopLoading, the review's stimulus) and by the page's native window.stop() in Firefox and WebKit"}: held at the origin, stopped, then history to a different URL and to the stopped URL; the original document survives, nothing is committed, and a declared delayed fetch 500 stays that document's and is expected`, async ({
      browser,
      browserName,
    }) => {
      // Chromium's window.stop() does not stop a browser-initiated navigation (diag/order-3 E2), so Chromium uses the browser's Stop;
      // Firefox and WebKit stop it natively from the page. No engine is skipped.
      const browserStop = initiator === "browser" && browserName === "chromium";
      const lanes = openTransportLanes(browser, test.info());
      const holds: Array<{ release: () => void }> = [];
      try {
        const lane = await guardLane(lanes);
        const base = `${GUARD}/nav6`;
        await lane.routes.route(`**${base}/page`, (route) =>
          (route as unknown as OriginRoute).fulfill({
            status: 200,
            contentType: "text/html",
            headers: { "cache-control": "no-store" },
            body: SENTINEL("original"),
          }),
        );
        const navigation = await heldRoute(lane, `**${base}/held`, {
          status: 200,
          contentType: "text/html",
          body: SENTINEL("replacement"),
        });
        holds.push(navigation);
        const delayed = await heldRoute(lane, `**${base}/delayed500`, {
          status: 500,
          contentType: "text/plain",
          body: "declared response",
        });
        holds.push(delayed);
        const page = await lane.context.newPage();
        await page.goto(`${base}/page`);
        expect(await identityOf(page)).toBe("original");
        // The review's positive control first: an ordinary history change is a same-document event.
        await page.evaluate(() =>
          history.pushState({}, "", "/api/__guard/nav6/ordinary-history"),
        );
        let goto: Promise<string> | null = null;
        if (!browserStop) await armOnCookie(page, "nav6-stop", "stop", "");
        if (initiator === "page")
          await page.evaluate(() => {
            location.assign("/api/__guard/nav6/held");
          });
        else
          goto = page.goto(`${base}/held`).then(
            () => "committed",
            (e) => `refused: ${String(e)}`,
          );
        await navigation.arrived();
        if (browserStop) {
          const cdp = await page.context().newCDPSession(page);
          await cdp.send("Page.stopLoading");
          await cdp.detach();
        } else await setCookie(page, "nav6-stop");
        const held = () =>
          lane.journal.requests.find((r) => r.url.endsWith(`${base}/held`));
        await expect
          .poll(
            () =>
              (lane.journal.navigations ?? []).some(
                (n) => n.kind === "aborted" && n.request === held()?.seq,
              ),
            { message: "Playwright's abort event for the stopped navigation" },
          )
          .toBe(true);
        if (goto !== null) expect(await goto).toMatch(/^refused/);
        expect(await identityOf(page), "the original document survives").toBe(
          "original",
        );
        lane.expectHttp({
          method: "GET",
          path: `${base}/delayed500`,
          status: 500,
          count: 1,
          reason: "NAV6 a delayed fetch of the surviving document",
        });
        await page.evaluate(() => {
          (window as unknown as { status500?: Promise<number> }).status500 =
            fetch("/api/__guard/nav6/delayed500", { cache: "no-store" }).then(
              (r) => r.status,
            );
        });
        await delayed.arrived();
        await page.evaluate(() =>
          history.pushState({}, "", "/api/__guard/nav6/held"),
        );
        expect(await identityOf(page)).toBe("original");
        delayed.release();
        expect(
          await page.evaluate(
            () =>
              (window as unknown as { status500: Promise<number> }).status500,
          ),
        ).toBe(500);
        await quiet(lane);
        const { report, verdict } = await settle(lanes, lane);
        expect(
          transitionsOf(lane),
          "the stopped navigation committed nothing",
        ).toEqual([
          ["new-document", 1, "request"],
          ["same-document", 1, null],
          ["aborted", 1, "request"],
          ["same-document", 1, null],
        ]);
        expect(
          held(),
          "the stopped navigation ended without a commit",
        ).toMatchObject({
          navigation: true,
          document: 1,
          commit: null,
          commitReason: expect.stringMatching(
            /^aborted without committing a document: /,
          ),
          terminal: { kind: "failed" },
        });
        expect(
          navigation.cancelled,
          "the origin saw the browser cancel it",
        ).toEqual([1]);
        expect(lane.journal.provenanceFailures).toEqual([]);
        expect(verdict.violations).toEqual([]);
        expect(
          verdict.unexpected,
          "the declared fetch is the surviving document's",
        ).toEqual([]);
        expect(report.failures).toEqual([]);
        expect(
          verdict.expected.map((p) => [
            p.document,
            p.status,
            p.evidence?.relation,
          ]),
        ).toEqual(logsHttp(browserName) ? [[1, 500, "same-document"]] : []);
        expect(verdict.expectations.map((e) => e.matched.length)).toEqual([1]);
      } finally {
        for (const h of holds) h.release();
        await lanes.settle();
      }
    });

  test("NAV7 history to a STILL PENDING navigation's own URL: no commit while it is held; its genuine commit then advances the document exactly once, and its own declared 503 is credited through that commit", async ({
    browser,
    browserName,
  }) => {
    const lanes = openTransportLanes(browser, test.info());
    const holds: Array<{ release: () => void }> = [];
    try {
      const lane = await guardLane(lanes);
      const base = `${GUARD}/nav7`;
      const navigation = await heldRoute(lane, `**${base}/held`, {
        status: 503,
        contentType: "text/html",
        body: SENTINEL("committed"),
      });
      holds.push(navigation);
      const page = await open(lane);
      lane.expectHttp({
        method: "GET",
        path: `${base}/held`,
        status: 503,
        count: 1,
        reason: "NAV7 the held navigation itself",
      });
      await armOnCookie(page, "nav7-history", "history", `${base}/held`);
      const goto = page.goto(`${base}/held`);
      await navigation.arrived();
      await setCookie(page, "nav7-history");
      const nav = () =>
        lane.journal.requests.find((r) => r.url.endsWith(`${base}/held`));
      await expect
        .poll(
          () =>
            (lane.journal.navigations ?? []).some(
              (n) =>
                n.kind === "same-document" &&
                n.url.endsWith(`${base}/held`) &&
                n.seq > (nav()?.seq ?? Infinity),
            ),
          { message: "the history change while the navigation is held" },
        )
        .toBe(true);
      expect(nav()?.commit, "no commit while held").toBeUndefined();
      expect(transitionsOf(lane)).toEqual([
        ["new-document", 1, "request"],
        ["same-document", 1, null],
      ]);
      navigation.release();
      expect((await goto)?.status()).toBe(503);
      expect(await identityOf(page)).toBe("committed");
      await quiet(lane);
      const { report, verdict } = await settle(lanes, lane);
      expect(transitionsOf(lane)).toEqual([
        ["new-document", 1, "request"],
        ["same-document", 1, null],
        ["new-document", 2, "request"],
      ]);
      expect(nav()).toMatchObject({ document: 1, commit: { document: 2 } });
      expect(lane.journal.provenanceFailures).toEqual([]);
      expect(verdict.violations).toEqual([]);
      expect(verdict.unexpected).toEqual([]);
      expect(report.failures).toEqual([]);
      expect(verdict.expected.map((p) => [p.category, p.status])).toEqual(
        logsHttp(browserName) ? [["http", 503]] : [],
      );
      expect(relationAgrees(verdict, lane)).toBe(true);
    } finally {
      for (const h of holds) h.release();
      await lanes.settle();
    }
  });

  test("NAV8 two pages of one lane: page A's stopped navigation and history to its URL change nothing of page B, whose declared delayed fetch 500 (held across A's stop, history and close) stays B's and is expected", async ({
    browser,
    browserName,
  }) => {
    const lanes = openTransportLanes(browser, test.info());
    const holds: Array<{ release: () => void }> = [];
    try {
      const lane = await guardLane(lanes);
      const base = `${GUARD}/nav8`;
      const navigation = await heldRoute(lane, `**${base}/held`, {
        status: 200,
        contentType: "text/html",
        body: SENTINEL("replacement"),
      });
      holds.push(navigation);
      const delayed = await heldRoute(lane, `**${base}/delayed500`, {
        status: 500,
        contentType: "text/plain",
        body: "declared response",
      });
      holds.push(delayed);
      const a = await open(lane, 1);
      const b = await open(lane, 2);
      lane.expectHttp({
        method: "GET",
        path: `${base}/delayed500`,
        status: 500,
        count: 1,
        reason: "NAV8 page B's delayed fetch",
      });
      await b.evaluate(() => {
        (window as unknown as { status500?: Promise<number> }).status500 =
          fetch("/api/__guard/nav8/delayed500", { cache: "no-store" }).then(
            (r) => r.status,
          );
      });
      await delayed.arrived();
      await armOnCookie(a, "nav8-stop", "stop", "");
      await a.evaluate(() => {
        location.assign("/api/__guard/nav8/held");
      });
      await navigation.arrived();
      await setCookie(a, "nav8-stop");
      await expect
        .poll(() =>
          (lane.journal.navigations ?? []).some(
            (n) => n.page === 0 && n.kind === "aborted",
          ),
        )
        .toBe(true);
      await a.evaluate(() =>
        history.pushState({}, "", "/api/__guard/nav8/held"),
      );
      await a.close();
      delayed.release();
      expect(
        await b.evaluate(
          () => (window as unknown as { status500: Promise<number> }).status500,
        ),
      ).toBe(500);
      await quiet(lane);
      const { report, verdict } = await settle(lanes, lane);
      expect(transitionsOf(lane, 0)).toEqual([
        ["new-document", 1, "request"],
        ["aborted", 1, "request"],
        ["same-document", 1, null],
      ]);
      expect(transitionsOf(lane, 1)).toEqual([["new-document", 1, "request"]]);
      expect(lane.journal.provenanceFailures).toEqual([]);
      expect(verdict.violations).toEqual([]);
      expect(verdict.unexpected).toEqual([]);
      expect(report.failures).toEqual([]);
      expect(
        verdict.expected.map((p) => [p.page, p.document, p.status]),
      ).toEqual(logsHttp(browserName) ? [[1, 1, 500]] : []);
    } finally {
      for (const h of holds) h.release();
      await lanes.settle();
    }
  });

  test("NAV9 a second navigation of the SAME URL while the first is held: exactly one commit, linked to the request whose document actually loaded (Chromium refuses the second and commits the first; Firefox and WebKit supersede the first and commit the second)", async ({
    browser,
    browserName,
  }) => {
    const lanes = openTransportLanes(browser, test.info());
    const holds: Array<{ release: () => void }> = [];
    try {
      const lane = await guardLane(lanes);
      const base = `${GUARD}/nav9`;
      // Each arrival's document names its arrival: the sentinel shows which request's document committed.
      const navigation = await heldRoute(
        lane,
        `**${base}/same`,
        (n) => ({
          status: 200,
          contentType: "text/html",
          body: SENTINEL(`arrival-${n}`),
        }),
        { holdFirst: true },
      );
      holds.push(navigation);
      const page = await open(lane);
      const outcome = (p: Promise<unknown>) =>
        p.then(
          () => "committed",
          () => "refused",
        );
      const first = outcome(page.goto(`${base}/same`));
      await navigation.arrived();
      const second = outcome(page.goto(`${base}/same`));
      // Diag/order-2 and this case's first run (focused/nav-1): Chromium refuses a browser-initiated navigation of the URL its pending
      // navigation is loading (no second request); Firefox and WebKit start it and cancel the first.
      const chromium = browserName === "chromium";
      expect(await (chromium ? second : first)).toBe("refused");
      navigation.release();
      expect(await (chromium ? first : second)).toBe("committed");
      const loaded = await identityOf(page);
      await quiet(lane);
      const { report, verdict } = await settle(lanes, lane);
      const same = lane.journal.requests.filter((r) =>
        r.url.endsWith(`${base}/same`),
      );
      expect(same, "one request in Chromium, two elsewhere").toHaveLength(
        chromium ? 1 : 2,
      );
      const committed = same.at(-1);
      expect(loaded).toBe(chromium ? "arrival-1" : "arrival-2");
      expect(committed).toMatchObject({ document: 1, commit: { document: 2 } });
      if (!chromium)
        expect(same[0]).toMatchObject({
          document: 1,
          commit: null,
          commitReason: expect.stringMatching(
            /^(aborted without committing a document: |superseded by navigation #\d+$)/,
          ),
        });
      expect(
        (lane.journal.navigations ?? [])
          .filter((n) => n.kind === "new-document")
          .map((n) => [n.document, n.request]),
      ).toEqual([
        [1, lane.journal.requests[0]?.seq],
        [2, committed?.seq],
      ]);
      expect(lane.journal.provenanceFailures).toEqual([]);
      expect(verdict.unexpected).toEqual([]);
      expect(verdict.violations).toEqual([]);
      expect(report.failures).toEqual([]);
    } finally {
      for (const h of holds) h.release();
      await lanes.settle();
    }
  });
});

// ---- Revision 20 (Review 24 F24-1; design assessment token 1fd56474…, L04–L07 in real engines) -------------------------------------

const deferred = <T = void>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
/** True when nothing listens on `url` any more (an independent observation of a lane listener). */
const refused = (url: unknown) =>
  new Promise<boolean>((resolve) => {
    const at = new URL(String(url));
    const socket = connect({ host: at.hostname, port: Number(at.port) });
    socket.once("connect", () => {
      socket.destroy();
      resolve(false);
    });
    socket.once("error", () => resolve(true));
  });
const LISTENERS: OpenStage[] = ["witness", "scripted origin", "front"];
const STAGES: OpenStage[] = [
  "witness",
  "scripted origin",
  "front",
  "context",
  "init script",
  "publication",
];
/** The qualification seam: the REAL acquisition at `stage` (its n-th call), then its delivery held until `release`. */
function holdAfter(stage: OpenStage, nth = 1) {
  const handles: Array<{ stage: OpenStage; handle: unknown }> = [];
  const seen: OpenStage[] = [];
  const counts = new Map<OpenStage, number>();
  const reached = deferred();
  const release = deferred();
  const interpose = (async (st: OpenStage, acquire: () => Promise<unknown>) => {
    seen.push(st);
    const n = (counts.get(st) ?? 0) + 1;
    counts.set(st, n);
    const handle = await acquire();
    handles.push({ stage: st, handle });
    if (st === stage && n === nth) {
      reached.resolve();
      await release.promise;
    }
    return handle;
  }) as Interpose;
  return { interpose, handles, seen, reached, release };
}
/**
 * Revision 21 (Review 25 F25-1): the review's schedules at `stage` (its first call). `reject`: the REAL acquisition, then the wrapper
 * fails; `hold-then-reject`: the real acquisition, its delivery held until `release`, then the wrapper fails; `start-reject`: the real
 * acquisition is started and the wrapper fails before it answers; `substitute`: the real acquisition, then another value delivered.
 * Every acquired handle and every thrown error (`thrown`, for comparison by identity) is kept.
 */
function afterAcquisition(
  stage: OpenStage,
  step: "reject" | "hold-then-reject" | "start-reject" | "substitute",
) {
  const handles: Array<{ stage: OpenStage; handle: unknown }> = [];
  const seen: OpenStage[] = [];
  const thrown: Error[] = [];
  const reached = deferred();
  const release = deferred();
  let calls = 0;
  const interpose = (async (st: OpenStage, acquire: () => Promise<unknown>) => {
    seen.push(st);
    const mine = st === stage && ++calls === 1;
    if (mine && step === "start-reject") {
      acquire().catch(() => undefined);
      const error = new Error(`injected ${st} failure while acquiring`);
      thrown.push(error);
      throw error;
    }
    const handle = await acquire();
    handles.push({ stage: st, handle });
    if (!mine) return handle;
    if (step === "substitute") return { substitute: st };
    if (step === "hold-then-reject") {
      reached.resolve();
      await release.promise;
    }
    const error = new Error(
      step === "reject"
        ? `injected ${st} failure after acquisition`
        : `late ${st} rejection after acquisition`,
    );
    thrown.push(error);
    throw error;
  }) as Interpose;
  return { interpose, handles, seen, thrown, reached, release };
}
const contextsOf = (browser: Browser) => new Set(browser.contexts());
/** A settlement that does NOT join pending work would finish within this window (a sensitivity window, not a duration under test). */
const turns = () => new Promise((resolve) => setTimeout(resolve, 100));

test.describe("native transport lane manager (revision 20 qualification in real engines)", () => {
  for (const [index, stage] of STAGES.entries())
    test(`L02–L06 ${stage} held after its real acquisition while settlement begins: settlement waits, disposes it, starts no later stage and publishes nothing; the browser and an unrelated context survive`, async ({
      browser,
    }) => {
      const sentinel = await browser.newContext();
      try {
        const baseline = contextsOf(browser);
        const seam = holdAfter(stage);
        const lanes = openTransportLanes(browser, test.info(), {
          interpose: seam.interpose,
        });
        const outcome = lanes.open({ mode: "fixture" }).then(
          () => "published",
          (error: unknown) => String(error),
        );
        await seam.reached.promise;
        let released = false;
        let settledAt: string | null = null;
        const settling = lanes.settle();
        void settling.then(() => {
          settledAt = released ? "after release" : "before release";
        });
        await turns();
        expect(
          settledAt,
          "settlement cannot report while an acquisition it owns is held",
        ).toBeNull();
        released = true;
        seam.release.resolve();
        const report = await settling;
        expect(settledAt).toBe("after release");
        const when = stage === "publication" ? "at" : "after";
        expect(report).toEqual({
          closeErrors: [],
          reportErrors: [],
          failures: [],
          openErrors: [
            `open 1 cancelled at ${stage}: LaneCancelled: open 1 cancelled ${when} ${stage}: settlement began while it was opening`,
          ],
        });
        expect(await outcome).toContain(`cancelled ${when} ${stage}`);
        expect(seam.seen, "no later stage began").toEqual(
          STAGES.slice(0, index + 1),
        );
        expect(lanes.lanes).toEqual([]);
        for (const h of seam.handles.filter((x) => LISTENERS.includes(x.stage)))
          expect(await refused(h.handle), `${h.stage} closed`).toBe(true);
        expect(
          contextsOf(browser),
          "only the lane's own context was closed",
        ).toEqual(baseline);
        const own = seam.handles.find((h) => h.stage === "context")?.handle as
          | BrowserContext
          | undefined;
        if (own !== undefined)
          expect(browser.contexts().includes(own)).toBe(false);
        expect(await lanes.settle()).toBe(report);
        expect(browser.isConnected()).toBe(true);
        expect(browser.contexts().includes(sentinel)).toBe(true);
      } finally {
        await sentinel.close();
      }
    });

  test("L04 the review's exact F24-1 schedule: a context delivered late by browser.newContext is closed by the settlement it overlapped, and no lane is published", async ({
    browser,
  }) => {
    const acquired = deferred<BrowserContext>();
    const release = deferred();
    const delayed = {
      newContext: async (options?: Parameters<Browser["newContext"]>[0]) => {
        const context = await browser.newContext(options);
        acquired.resolve(context);
        await release.promise;
        return context;
      },
    } as Pick<Browser, "newContext">;
    const lanes = openTransportLanes(delayed, test.info());
    const opening = lanes.open({ mode: "fixture" }).catch((e: unknown) => e);
    const context = await acquired.promise;
    let settled = false;
    const settling = lanes.settle();
    void settling.then(() => {
      settled = true;
    });
    await turns();
    expect(
      settled,
      "no successful report while the acquired context is undelivered",
    ).toBe(false);
    expect(browser.contexts().includes(context)).toBe(true);
    release.resolve();
    const report = await settling;
    expect(report.closeErrors).toEqual([]);
    expect(report.openErrors).toEqual([
      "open 1 cancelled at context: LaneCancelled: open 1 cancelled after context: settlement began while it was opening",
    ]);
    expect(String(await opening)).toContain("cancelled after context");
    expect(
      browser.contexts().includes(context),
      "the late context is closed",
    ).toBe(false);
    expect(lanes.lanes).toEqual([]);
    expect(await lanes.settle()).toBe(report);
  });

  // Revision 21 (Review 25 F25-1): an EXPLAINED ORACLE CORRECTION. This schedule holds the WRAPPER after a genuine acquisition; the
  // context is owned from its arrival, so it is now closed during settlement and the bound names the wrapper. Revision 20's message and
  // its still-open-at-the-report oracle belong to a genuinely pending `newContext` (the next case). Bound, unfinished open, late record
  // and never-success re-settlement are kept.
  test("L05 a context not delivered within settlement's join bound: settlement fails by name; the context arriving later is closed and recorded", async ({
    browser,
  }) => {
    const seam = holdAfter("context");
    const lateSeen = deferred();
    const late: string[] = [];
    const lanes = openTransportLanes(browser, test.info(), {
      interpose: seam.interpose,
      joinBoundMs: 1_000,
      onLate: (line) => {
        late.push(line);
        if (line.includes("late context")) lateSeen.resolve();
      },
    });
    void lanes.open({ mode: "fixture" }).catch(() => undefined);
    await seam.reached.promise;
    const context = seam.handles.find((h) => h.stage === "context")
      ?.handle as BrowserContext;
    const report = await lanes.settle();
    expect(report.closeErrors).toEqual([
      "open 1: context wrapper still pending when settlement's join bound ended (its acquired resource was disposed; its outcome will be recorded when it arrives)",
      "open 1: unfinished at context when settlement's join bound ended",
    ]);
    expect(
      browser.contexts().includes(context),
      "the acquired context is closed at the report, its wrapper still held",
    ).toBe(false);
    seam.release.resolve();
    await lateSeen.promise;
    expect(late).toContain(
      "open 1: late context wrapper delivered after settlement",
    );
    expect(browser.contexts().includes(context)).toBe(false);
    expect(await lanes.settle(), "never turns into success").toBe(report);
  });

  test("L05 a context whose delivery by browser.newContext outlives the join bound: named as a pending acquisition, honestly open at the report, closed when it arrives", async ({
    browser,
  }) => {
    const acquired = deferred<BrowserContext>();
    const release = deferred();
    const delayed = {
      newContext: async (options?: Parameters<Browser["newContext"]>[0]) => {
        const context = await browser.newContext(options);
        acquired.resolve(context);
        await release.promise;
        return context;
      },
    } as Pick<Browser, "newContext">;
    const lateSeen = deferred();
    const late: string[] = [];
    const lanes = openTransportLanes(delayed, test.info(), {
      joinBoundMs: 1_000,
      onLate: (line) => {
        late.push(line);
        if (line.includes("late context")) lateSeen.resolve();
      },
    });
    void lanes.open({ mode: "fixture" }).catch(() => undefined);
    const context = await acquired.promise;
    const report = await lanes.settle();
    expect(report.closeErrors).toEqual([
      "open 1: context acquisition still pending when settlement's join bound ended (its result will be disposed when it arrives)",
      "open 1: unfinished at context when settlement's join bound ended",
    ]);
    expect(
      browser.contexts().includes(context),
      "undelivered: honestly still open at the report",
    ).toBe(true);
    release.resolve();
    await lateSeen.promise;
    expect(late).toContain(
      "open 1: late context arrived after settlement; disposed",
    );
    expect(browser.contexts().includes(context)).toBe(false);
    expect(await lanes.settle(), "never turns into success").toBe(report);
  });

  test("L07 a working lane, an open held at its context, and another manager's working lane: settlement ends only its own manager's resources", async ({
    browser,
    browserName,
  }) => {
    const seam = holdAfter("context", 2);
    const a = openTransportLanes(browser, test.info(), {
      interpose: seam.interpose,
    });
    const b = openTransportLanes(browser, test.info());
    try {
      const first = await guardLane(a);
      const firstPage = await open(first);
      expect(await fetchStatus(firstPage, `${GUARD}/status/200`)).toBe(200);
      const held = a.open({ mode: "fixture" }).catch((e: unknown) => e);
      await seam.reached.promise;
      const other = await guardLane(b);
      const otherPage = await open(other);
      const settling = a.settle();
      await turns();
      seam.release.resolve();
      const report = await settling;
      expect(report.closeErrors).toEqual([]);
      expect(report.reportErrors).toEqual([]);
      expect(report.failures).toEqual([]);
      expect(report.openErrors).toEqual([
        "open 2 cancelled at context: LaneCancelled: open 2 cancelled after context: settlement began while it was opening",
      ]);
      expect(String(await held)).toContain("open 2 cancelled after context");
      expect(a.lanes).toEqual([first]);
      expect(browser.contexts().includes(first.context)).toBe(false);
      const heldContext = seam.handles.filter((h) => h.stage === "context")[1]
        ?.handle as BrowserContext;
      expect(browser.contexts().includes(heldContext)).toBe(false);
      for (const h of seam.handles.filter((x) => LISTENERS.includes(x.stage)))
        expect(await refused(h.handle)).toBe(true);
      expect(browser.contexts().includes(other.context)).toBe(true);
      expect(
        await fetchStatus(otherPage, `${GUARD}/status/200`),
        `the other manager's lane still works (${browserName})`,
      ).toBe(200);
    } finally {
      await a.settle();
      const report = await b.settle();
      expect(report.openErrors).toEqual([]);
      expect(report.closeErrors).toEqual([]);
    }
  });
  // ---- Revision 21 (Review 25 F25-1; design assessment Q02, Q03, Q05): ownership follows the REAL acquisition, in real engines ---------
  for (const [index, stage] of STAGES.entries()) {
    test(`F25-1 Q02 ${stage}: the wrapper rejects after the genuine acquisition; the open fails with that error and its own unwinding closes everything it acquired; the browser and an unrelated context survive`, async ({
      browser,
    }) => {
      const sentinel = await browser.newContext();
      try {
        const baseline = contextsOf(browser);
        const seam = afterAcquisition(stage, "reject");
        const lanes = openTransportLanes(browser, test.info(), {
          interpose: seam.interpose,
        });
        const failure = await lanes.open({ mode: "fixture" }).catch((e) => e);
        expect(failure, "the original thrown value").toBe(seam.thrown[0]);
        expect(seam.handles.map((h) => h.stage)).toEqual(
          STAGES.slice(0, index + 1),
        );
        expect(lanes.state, "no settlement asked for").toBe("open");
        const own = seam.handles.find((h) => h.stage === "context")?.handle as
          | BrowserContext
          | undefined;
        if (own !== undefined)
          await expect
            .poll(() => browser.contexts().includes(own), {
              message: "the acquired context is closed by the open's unwinding",
              timeout: 5_000,
            })
            .toBe(false);
        for (const h of seam.handles.filter((x) => LISTENERS.includes(x.stage)))
          await expect
            .poll(() => refused(h.handle), {
              message: `${h.stage} closed by the open's unwinding`,
              timeout: 5_000,
            })
            .toBe(true);
        const report = await lanes.settle();
        expect(report).toEqual({
          closeErrors: [],
          reportErrors: [],
          failures: [],
          openErrors: [
            `open 1 failed at ${stage}: Error: injected ${stage} failure after acquisition`,
          ],
        });
        expect(contextsOf(browser), "back to the baseline").toEqual(baseline);
        expect(lanes.lanes).toEqual([]);
        expect(await lanes.settle()).toBe(report);
        expect(browser.isConnected()).toBe(true);
        expect(browser.contexts().includes(sentinel)).toBe(true);
      } finally {
        await sentinel.close();
      }
    });

    test(`F25-1 Q03 ${stage}: held after the genuine acquisition while settlement begins, then rejecting: closed while still held, the open fails, nothing published; the browser and an unrelated context survive`, async ({
      browser,
    }) => {
      const sentinel = await browser.newContext();
      try {
        const baseline = contextsOf(browser);
        const seam = afterAcquisition(stage, "hold-then-reject");
        const lanes = openTransportLanes(browser, test.info(), {
          interpose: seam.interpose,
        });
        const outcome = lanes
          .open({ mode: "fixture" })
          .catch((e: unknown) => e);
        await seam.reached.promise;
        let reported = false;
        const settling = lanes.settle();
        void settling.then(() => {
          reported = true;
        });
        const own = seam.handles.find((h) => h.stage === "context")?.handle as
          | BrowserContext
          | undefined;
        if (own !== undefined)
          await expect
            .poll(() => browser.contexts().includes(own), {
              message: "closed while its wrapper is held",
              timeout: 5_000,
            })
            .toBe(false);
        for (const h of seam.handles.filter((x) => LISTENERS.includes(x.stage)))
          await expect
            .poll(() => refused(h.handle), {
              message: `${h.stage} closed while held`,
              timeout: 5_000,
            })
            .toBe(true);
        expect(reported, "the held wrapper is still joined").toBe(false);
        seam.release.resolve();
        const report = await settling;
        expect(await outcome).toBe(seam.thrown[0]);
        expect(report).toEqual({
          closeErrors: [],
          reportErrors: [],
          failures: [],
          openErrors: [
            `open 1 failed at ${stage}: Error: late ${stage} rejection after acquisition`,
          ],
        });
        expect(seam.seen, "no later stage began").toEqual(
          STAGES.slice(0, index + 1),
        );
        expect(lanes.lanes).toEqual([]);
        expect(contextsOf(browser)).toEqual(baseline);
        expect(await lanes.settle()).toBe(report);
        expect(browser.isConnected()).toBe(true);
      } finally {
        await sentinel.close();
      }
    });
  }

  test("F25-1 Q05 a wrapper failing while browser.newContext is still delivering: the open fails at once; the context is closed by the open's own unwinding when it arrives, without settlement; a sibling open still works", async ({
    browser,
  }) => {
    const acquired = deferred<BrowserContext>();
    const release = deferred();
    let calls = 0;
    const delayed = {
      newContext: async (options?: Parameters<Browser["newContext"]>[0]) => {
        calls += 1;
        const context = await browser.newContext(options);
        if (calls === 1) {
          acquired.resolve(context);
          await release.promise;
        }
        return context;
      },
    } as Pick<Browser, "newContext">;
    const seam = afterAcquisition("context", "start-reject");
    const lanes = openTransportLanes(delayed, test.info(), {
      interpose: seam.interpose,
    });
    try {
      const failure = await lanes.open({ mode: "fixture" }).catch((e) => e);
      expect(failure).toBe(seam.thrown[0]);
      const context = await acquired.promise;
      expect(browser.contexts().includes(context), "made, undelivered").toBe(
        true,
      );
      release.resolve();
      await expect
        .poll(() => browser.contexts().includes(context), {
          message: "closed by the open's unwinding when it arrived",
          timeout: 5_000,
        })
        .toBe(false);
      expect(lanes.state).toBe("open");
      const sibling = await guardLane(lanes);
      const page = await open(sibling);
      expect(await fetchStatus(page, `${GUARD}/status/200`)).toBe(200);
    } finally {
      const report = await lanes.settle();
      expect(report.closeErrors).toEqual([]);
      expect(report.openErrors).toEqual([
        "open 1 failed at context: Error: injected context failure while acquiring",
      ]);
      expect(lanes.late).toEqual([]);
    }
  });

  test("F25-1 seam-contract negative: a wrapper delivering another value than its genuine context fails the open by name; only the real context is owned and closed", async ({
    browser,
  }) => {
    const baseline = contextsOf(browser);
    const seam = afterAcquisition("context", "substitute");
    const lanes = openTransportLanes(browser, test.info(), {
      interpose: seam.interpose,
    });
    const failure = await lanes.open({ mode: "fixture" }).catch((e) => e);
    expect(failure).toBeInstanceOf(LaneSeamMisuse);
    const own = seam.handles.find((h) => h.stage === "context")
      ?.handle as BrowserContext;
    await expect
      .poll(() => browser.contexts().includes(own), { timeout: 5_000 })
      .toBe(false);
    const report = await lanes.settle();
    expect(report.openErrors).toEqual([
      "open 1 failed at context: LaneSeamMisuse: open 1: the context wrapper delivered a value other than its acquisition's",
    ]);
    expect(report.closeErrors).toEqual([]);
    expect(contextsOf(browser)).toEqual(baseline);
  });
});
