import type { BrowserContext, Page } from "@playwright/test";
import { recordEvidence } from "./data-evidence";
import {
  installMarkerReadFaults,
  type MarkerReads,
  markerReads,
  NO_READ_FAULTS,
  plantMarkerOn,
  serveIdentityReads,
} from "./data-local-faults";
import {
  ACCOUNT,
  bootSession,
  seedSettled,
  startLeader,
  stubNetwork,
  untilTreeSettled,
  waitForState,
} from "./data-sync-helpers";
import { expect, test } from "./helpers";

/**
 * E-C16 (revision 29, R47(c)): ordinary sync does not take a marker store it cannot read for one with no stops in it, in a real engine.
 *
 * The independent review of revision 28 wrote a stop of each operation the capture gate enforces (the capture write, the sync caller's
 * retry record, the sizing record, the current page's commit, an admitted invalidation at this position) as an EARLIER page, made the
 * markers' enumeration fail and started the engine: the gate was handed `markers.operations()`, which answers `[]` when it throws, and a
 * `GET /sync` went out through every one of those stops; the cursor advanced, and the retirement of the invalidation's record after the
 * page applied then erased the marker that hid the cache. That was a model probe over a double of the store; here the first page records
 * the marker in the REAL `localStorage` and is closed, and a SECOND page boots over the same database with its reads of `localStorage`
 * made to throw from its first one, then starts the production engine (the fixture's test leader, through the production session's
 * stamped wrapper) against a stubbed `/sync`.
 *
 * FIXTURE evidence for this engine on this machine: the HTTP answers are scripted inputs, the engine is the fixture's test leader
 * (production starts none until WEB-09b), and the unreadable storage is installed by the spec (throwing `Storage.prototype.getItem`,
 * `key` and the `length` getter); no real unreadable storage is produced.
 */
/**
 * ADAPTED, revision 33 (R55): a marker is found by reading the directories' fixed addresses and the key of each failure they list; the
 * origin's listing is never used. A read can fail for every key (`ALL`), for the directories (`DIRECTORY`) or for a listed failure's own
 * key (`KEY`: that operation, and no other, is unknown); a refused listing (`LISTING`) changes no answer.
 */
const NONE: MarkerReads = NO_READ_FAULTS;
// ADAPTED, revision 34 (premises P8 and P10): "both unreadable" refuses the origin's listing as well as every individual read; with only the
// reads refused, the listing named the marker and the page knew of the stop it was meant not to be able to read.
const ALL: MarkerReads = {
  ...NO_READ_FAULTS,
  getItem: true,
  enumeration: true,
};
/**
 * ADAPTED, revision 34 (premises P8 and P10): the origin's listing is now the SECOND witness of a failure, so the review's schedule (a
 * store that cannot be read for the marker) refuses the directories AND the listing: neither witness can name it, and the absence of
 * anything is `unknown`. Refusing the directories alone left the listing to name the marker, and the engine then stopped for a stop it
 * KNEW, which a gate that asked the plain enumeration (MU-946) would also have done: the case had lost its sensitivity (found by the
 * affected real-engine mutants of revision 34). The listing-only schedule is the next case, and E-O13 D8 and E-O10 `directory-only`
 * are the ones in which the listing alone names the marker.
 */
const DIRECTORY: MarkerReads = {
  ...NO_READ_FAULTS,
  directory: true,
  enumeration: true,
};
const KEY: MarkerReads = { ...NO_READ_FAULTS, key: true };
const LISTING: MarkerReads = { ...NO_READ_FAULTS, enumeration: true };

/** The markers' keys that stand, once however many failures stand for one operation (the failure's name is stripped). */
const stored = (page: Page) =>
  page.evaluate(() =>
    [
      ...new Set(
        Object.keys(localStorage)
          .filter((key) => key.startsWith("atlas-write-failing:"))
          .map((key) => key.replace(/#[0-9a-z-]{1,64}\.[0-9]+$/, "")),
      ),
    ].sort(),
  );

/**
 * The first page settles the database (its engine takes a first page, so the cursor is the stub's), stops, records `operations` as markers
 * of the real `localStorage`, and is closed. The second page boots with `reads` already failing, and the engine starts on it.
 */
async function coldEngine(
  context: BrowserContext,
  operations: (cursor: string) => string[],
  reads: MarkerReads,
) {
  const net = await stubNetwork(context);
  await serveIdentityReads(context);
  await seedSettled(context);
  const first = await bootSession(context);
  await untilTreeSettled(first, { connections: 0 });
  await startLeader(first);
  await waitForState(first, "idle");
  const cursor = await first.evaluate(async (a) => {
    const h = window.__atlasData;
    if (h === undefined) throw new Error("no data harness");
    h.stopSync();
    return ((await h.syncState(a)) as { cursor: string }).cursor;
  }, ACCOUNT);
  // An EARLIER page's failures: each is listed in a directory first and written under its own key (R52 and R55), in the lifetime of the
  // database both pages have open.
  const planted: string[] = [];
  for (const operation of operations(cursor))
    planted.push(await plantMarkerOn(first, ACCOUNT, operation, "prior.1"));
  const keys = planted.map((key) =>
    key.replace(/#[0-9a-z-]{1,64}\.[0-9]+$/, ""),
  );
  await first.close();
  const page = await bootSession(context);
  await untilTreeSettled(page, { connections: 0 });
  await installMarkerReadFaults(page);
  await markerReads(page, reads);
  const before = net.requests.length;
  await startLeader(page, ACCOUNT, cursor);
  return { net, page, cursor, keys, before };
}

/**
 * The engine reaches `kind`, as an ASSERTION that fails before the test's own timeout does: an engine that was never held (it goes idle
 * and asks the server) must fail by what it did, not by a wait that outlives the case.
 */
const untilEngine = (page: Page, kind: string, timeout = 8_000) =>
  expect
    .poll(() => page.evaluate(() => window.__atlasData?.engineState()?.kind), {
      timeout,
    })
    .toBe(kind);

const cursorOf = (page: Page) =>
  page.evaluate(async (a) => {
    const h = window.__atlasData;
    if (h === undefined) throw new Error("no data harness");
    return ((await h.syncState(a)) as { cursor: string }).cursor;
  }, ACCOUNT);

test.describe("E-C16 (revision 29, R47): the engine does not request through a stop whose marker the store cannot be read for, in a real engine", () => {
  const STOPS: Array<[string, (cursor: string) => string]> = [
    ["capture", () => "capture"],
    ["retry-state", () => "retry-state"],
    ["sizing", () => "sizing"],
    ["page", (cursor) => `page:${cursor}`],
    ["invalidate", (cursor) => `invalidate:${cursor}`],
  ];

  for (const [name, operation] of STOPS)
    test(`R47 sync: ${name}: the directories unreadable (the review's schedule): no request, the cursor stays, the marker stands`, async ({
      context,
    }, info) => {
      const { net, page, cursor, keys, before } = await coldEngine(
        context,
        (c) => [operation(c)],
        DIRECTORY,
      );
      await untilEngine(page, "stopped");
      await page.waitForTimeout(1_500);
      expect(net.requests.length).toBe(before);
      expect(await cursorOf(page)).toBe(cursor);
      expect(await stored(page)).toEqual(keys.sort());
      recordEvidence(info, `sync-${name}-directory`, {
        requests: net.requests.length - before,
        cursor,
      });
    });

  test("R47 sync: page: the listing of the origin refused: nothing reads it, so the marker is found, and no request goes (R55)", async ({
    context,
  }) => {
    const { net, page, cursor, keys, before } = await coldEngine(
      context,
      (c) => [`page:${c}`],
      LISTING,
    );
    await untilEngine(page, "stopped");
    await page.waitForTimeout(1_500);
    expect(net.requests.length).toBe(before);
    expect(await cursorOf(page)).toBe(cursor);
    expect(await stored(page)).toEqual(keys.sort());
  });

  for (const [name, operation] of STOPS.slice(3))
    test(`R47 sync: ${name}: both unreadable: nothing is requested, and once the markers can be read the stop still stands`, async ({
      context,
    }) => {
      const { net, page, cursor, keys, before } = await coldEngine(
        context,
        (c) => [operation(c)],
        ALL,
      );
      await untilEngine(page, "stopped");
      await page.waitForTimeout(1_500);
      expect(net.requests.length).toBe(before);
      await markerReads(page, NONE);
      // The engine asks again on its own pace (1 s, 2 s, 4 s ...): what it reads now is the marker, so the stop stands and nothing goes.
      await page.waitForTimeout(8_000);
      expect(net.requests.length).toBe(before);
      expect(await cursorOf(page)).toBe(cursor);
      expect(await stored(page)).toEqual(keys.sort());
    });

  test("R47 sync: both unreadable and NO marker: nothing is requested while nothing can be read, and a read that lands resumes the sync without anyone's act", async ({
    context,
  }, info) => {
    const { net, page, cursor, before } = await coldEngine(
      context,
      () => [],
      ALL,
    );
    await untilEngine(page, "stopped");
    await page.waitForTimeout(1_500);
    expect(net.requests.length).toBe(before);
    expect(await cursorOf(page)).toBe(cursor);
    await markerReads(page, NONE);
    await expect
      .poll(() => net.requests.length, { timeout: 12_000 })
      .toBeGreaterThan(before);
    expect(
      net.requests[before]?.searchParams.get("cursor"),
      "the held request is the one for the cursor the page was at",
    ).toBe(cursor);
    recordEvidence(info, "sync-no-marker-resumed", {
      requests: net.requests.length - before,
    });
  });

  // ADAPTED, revision 33 (R55): a failure that is listed and whose own key cannot be read makes ITS operation unknown and no other, so the
  // markers of other operations (their keys unreadable) do not stop the engine; a directory that cannot be read says nothing of the five
  // operations the gate names (nothing goes until a read lands, and then the request goes: the next test).
  test("R47 sync: control: markers of OTHER operations do not stop the engine while only their own keys are unreadable: the request goes", async ({
    context,
  }) => {
    const { net, page, before } = await coldEngine(
      context,
      (c) => ["draft:unrelated", "receipt:unrelated", `page:${c}-elsewhere`],
      KEY,
    );
    await expect
      .poll(() => net.requests.length, { timeout: 12_000 })
      .toBeGreaterThan(before);
    await untilEngine(page, "idle");
  });

  test("R47 sync: markers of OTHER operations, the directories unreadable: nothing goes while nothing can be read, and once a read lands the request goes", async ({
    context,
  }) => {
    const { net, page, before } = await coldEngine(
      context,
      (c) => ["draft:unrelated", "receipt:unrelated", `page:${c}-elsewhere`],
      DIRECTORY,
    );
    await untilEngine(page, "stopped");
    await page.waitForTimeout(1_500);
    expect(net.requests.length).toBe(before);
    await markerReads(page, NONE);
    await expect
      .poll(() => net.requests.length, { timeout: 15_000 })
      .toBeGreaterThan(before);
    await untilEngine(page, "idle");
  });
});
