import type { Page } from "@playwright/test";
import { expect, test } from "./helpers";
import {
  type LaneReport,
  type LaneVerdict,
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
