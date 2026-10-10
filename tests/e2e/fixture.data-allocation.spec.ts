import type { Page } from "@playwright/test";
import { DATA_CONFIG } from "../../src/data/model/config";
import {
  type AllocationSite,
  type FaultKind,
  installAllocationFault,
  readAllocationFault,
  removeAllocationFault,
  scanLengths,
} from "../support/data/allocation-faults";
import { recordEvidence } from "./data-evidence";
import { ACCOUNT, dataPage } from "./data-sync-helpers";
import { expect, test } from "./helpers";

/**
 * E-Z1 (revision 24, R44), in Chromium, Firefox and WebKit: an allocation failure at ANY stage of a page's processing is one signal about
 * the DEVICE. The PRODUCTION sync engine, plans, scanner, decoder, guards and Dexie adapter over REAL IndexedDB, on the data harness page
 * (no session: the harness's own runtime and identity, and a transport this spec supplies inside the page). FIXTURE evidence: no backend
 * is behind it, and the engine is started by the fixture's TEST LEADER (production starts no engine until WEB-09b supplies leadership).
 *
 * THE REVIEW'S SCHEDULES. A valid delta page of about 474,000 bytes (600 projections) succeeds without a fault. With ONE allocation
 * failure at the scanner's initial arrays, their growth or the final trimmed copies, the engine used to stop at once as `local_storage`
 * (no smaller request, no floor count); one at the decoding of a key, the cursor, or an element inside the commit used to be read as
 * invalid data (the same size asked for again, the unrecognised-response budget counted). Here each failure is a NAMED INJECTION in the
 * live page (`installAllocationFault`, the same function the unit tests install in-process): it throws the exception the policy reads as
 * an allocation failure at one named site of the production bundle. It tests the handling of that exception, NOT a physical
 * memory-exhaustion measurement, a real low-memory device or a browser's own limit. The fault is installed AFTER the page booted (in the
 * live page, never as a context init script), and each case reads the page's own record of the fault (`readAllocationFault`) and asserts
 * its premise (it fired, once, as many times as intended) before it asserts a consequence.
 *
 * THE CONTROLS THAT MATTER. A healthy page makes one request and counts nothing; a response body that cannot be allocated steps down (the
 * existing path); a fault of the DATA at the same sites (a `SyntaxError`, an invalid-UTF-8 `TypeError`) keeps its own classification: the
 * unrecognised-response budget counts it and the same size is asked for again.
 */
declare global {
  interface Window {
    __limits?: number[];
  }
}

const KIB = 1024;
const RUNG = DATA_CONFIG.initialLimitUnconstrained;
const CURSOR = "after-page";
const uuid = (n: number): string =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const body = (count: number, filler = 0): string =>
  JSON.stringify({
    phase: "delta",
    has_more: false,
    next_cursor: CURSOR,
    batches: [
      {
        revision: 1,
        changes: Array.from({ length: count }, (_, i) => ({
          kind: "upsert",
          resource: {
            id: uuid(i + 1),
            kind: "person",
            parent_id: null,
            label: `Person ${i + 1}`,
            value: filler > 0 ? { text: "x".repeat(filler) } : { n: i + 1 },
            version: 1,
            can_edit: true,
            archived: false,
          },
        })),
      },
    ],
  });
const SMALL = { count: 3, filler: 0 };
/** More than 512 changes: the scan's arrays grow once. */
const GROWN = { count: 520, filler: 0 };
/** 327,700 bytes: over `markerMinBytes`, so every attempt writes the crash-loop marker before it commits. */
const BULKY = { count: 40, filler: 8_000 };
const MID = { count: 300, filler: 0 };
type Shape = { count: number; filler: number };
const payload = (shape: Shape): string => body(shape.count, shape.filler);

/** Starts the engine over a scripted transport that answers `text`; every request's `limit` is recorded. */
async function start(
  page: Page,
  options: {
    text: string;
    bodyFault?: boolean;
    deviceMemoryGiB?: number;
    seedCursor?: string | null;
  },
): Promise<void> {
  await page.evaluate(
    async ({ account, text, bodyFault, memory, seed }) => {
      const data = window.__atlasData;
      if (data === undefined) throw new Error("no harness");
      window.__limits = [];
      let served = 0;
      await data.startSyncLocal(account, {
        ...(seed === null ? {} : { seedCursor: seed }),
        ...(memory === null ? {} : { deviceMemoryGiB: memory }),
        transport: (request) => {
          window.__limits?.push(
            Number(new URL(request.url).searchParams.get("limit")),
          );
          const response = new Response(text, {
            status: 200,
            headers: { "content-type": "application/json" },
          });
          served += 1;
          if (bodyFault === true && served === 1)
            Object.defineProperty(response, "arrayBuffer", {
              value: () =>
                Promise.reject(
                  new RangeError("named body allocation injection"),
                ),
            });
          return Promise.resolve(response);
        },
      });
    },
    {
      account: ACCOUNT,
      text: options.text,
      bodyFault: options.bodyFault ?? false,
      memory: options.deviceMemoryGiB ?? null,
      seed:
        options.seedCursor === undefined ? "before-page" : options.seedCursor,
    },
  );
}

const install = (
  page: Page,
  site: AllocationSite,
  options: {
    kind?: FaultKind;
    times?: number;
    skip?: number;
    grown?: boolean;
  } = {},
) =>
  page.evaluate(installAllocationFault, {
    site,
    cursor: CURSOR,
    lengths: scanLengths(),
    ...options,
  });
const fault = (page: Page) => page.evaluate(readAllocationFault);
const limits = (page: Page) => page.evaluate(() => window.__limits ?? []);
const engine = (page: Page) =>
  page.evaluate(() => window.__atlasData?.engineState() ?? null);
/** What the REAL database holds: the ladder, the retry budget, the cursor, the page count and how many cache rows. */
const record = (page: Page) =>
  page.evaluate(async (account) => {
    const data = window.__atlasData;
    const sync = (await data?.syncState(account)) as {
      sizing: {
        limit: number;
        class: string | null;
        floor_hits: number;
        attempt: { id: string } | null;
      };
      read_retry_states?: { sync?: { unrecognised_streak: number } };
      local_write_streaks?: Record<string, number>;
      cursor: string | null;
      page_seq: number;
    } | null;
    return {
      sizing: sync?.sizing ?? null,
      unrecognised: sync?.read_retry_states?.sync?.unrecognised_streak ?? 0,
      localWrites: sync?.local_write_streaks ?? {},
      cursor: sync?.cursor ?? null,
      pageSeq: sync?.page_seq ?? null,
      cache: ((await data?.rows(account, "cache")) ?? []).length,
    };
  }, ACCOUNT);
const stop = (page: Page) =>
  page.evaluate(() => window.__atlasData?.stopSync());
const idle = (page: Page) =>
  expect
    .poll(async () => (await engine(page))?.kind, {
      timeout: 15_000,
      intervals: [100],
    })
    .toBe("idle");
/** The count of requests, polled: the engine's own schedule decides when the next one is made. */
const requests = (page: Page, count: number) =>
  expect
    .poll(async () => (await limits(page)).length, {
      timeout: 15_000,
      intervals: [100],
    })
    .toBeGreaterThanOrEqual(count);

const RECOVERS: Array<{
  site: AllocationSite;
  shape: Shape;
  grown?: boolean;
  where: "scanner" | "decoder";
}> = [
  { site: "offsets.initial", shape: SMALL, where: "scanner" },
  { site: "nodes.initial", shape: SMALL, where: "scanner" },
  { site: "offsets.growth", shape: GROWN, grown: true, where: "scanner" },
  { site: "nodes.growth", shape: GROWN, grown: true, where: "scanner" },
  { site: "offsets.copy", shape: SMALL, where: "scanner" },
  { site: "nodes.copy", shape: SMALL, where: "scanner" },
  { site: "offsets.copy", shape: GROWN, grown: true, where: "scanner" },
  { site: "key.decode", shape: SMALL, where: "scanner" },
  { site: "key.parse", shape: SMALL, where: "scanner" },
  { site: "cursor.decode", shape: SMALL, where: "scanner" },
  { site: "cursor.parse", shape: SMALL, where: "scanner" },
  { site: "change.decode", shape: SMALL, where: "decoder" },
  { site: "change.parse", shape: SMALL, where: "decoder" },
  { site: "change.decode", shape: BULKY, where: "decoder" },
  { site: "change.parse", shape: BULKY, where: "decoder" },
];

test.describe("E-Z1 (R44): an allocation failure at any stage of a page's processing steps the ladder down, in a real engine", () => {
  for (const row of RECOVERS)
    test(`${row.site} (${row.shape.count} changes${row.shape.filler > 0 ? `, ${body(row.shape.count, row.shape.filler).length} bytes, over markerMinBytes` : ""}): ${RUNG} -> ${RUNG / 2}, the same position is asked for again, the page commits whole and nothing is counted as data or storage`, async ({
      context,
    }, info) => {
      const page = await dataPage(context);
      await install(page, row.site, { grown: row.grown === true });
      await start(page, {
        text: payload(row.shape),
        deviceMemoryGiB: 8,
      });
      await requests(page, 2);
      await idle(page);
      const seen = await fault(page);
      const asked = await limits(page);
      const after = await record(page);
      // The record is written BEFORE anything is asserted: a failure leaves what the real database showed.
      recordEvidence(info, `r44-recovers-${row.site}-${row.shape.count}`, {
        namedInjection: `an allocation failure (a RangeError) thrown at ${row.site} of the production ${row.where}, once, in the live page`,
        bodyBytes: payload(row.shape).length,
        markerMinBytes: DATA_CONFIG.markerMinBytes,
        fault: seen,
        limits: asked,
        engine: await engine(page),
        after,
      });
      expect(seen?.hits).toBe(1);
      expect(seen?.stacks[0]).toBeDefined();
      expect(asked).toEqual([RUNG, RUNG / 2]);
      expect(after.cache).toBe(row.shape.count);
      expect(after.cursor).toBe(CURSOR);
      expect(after.pageSeq).toBe(1);
      // One rung, however large the page: a marker left by the failed attempt would be read as a tab that did not survive.
      expect(after.sizing).toMatchObject({
        limit: RUNG / 2,
        floor_hits: 0,
        attempt: null,
      });
      expect(after.unrecognised).toBe(0);
      expect(after.localWrites).toEqual({});
      expect(await engine(page)).toMatchObject({ kind: "idle" });
      await stop(page);
      await page.close();
    });

  test(`a failure part-way through a page (the 251st element of ${MID.count}, after 200 rows were streamed into the transaction) rolls the whole page back, and the retry commits it once`, async ({
    context,
  }, info) => {
    const page = await dataPage(context);
    await install(page, "change.decode", { skip: 250 });
    await start(page, { text: payload(MID), deviceMemoryGiB: 8 });
    await requests(page, 2);
    await idle(page);
    const seen = await fault(page);
    const asked = await limits(page);
    const after = await record(page);
    recordEvidence(info, "r44-mid-page-rollback", {
      namedInjection:
        "an allocation failure thrown at the decoding of the 251st element (skip 250), once, in the live page",
      fault: seen,
      limits: asked,
      after,
    });
    expect(seen?.hits).toBe(1);
    expect(asked).toEqual([RUNG, RUNG / 2]);
    expect(after.cache).toBe(MID.count);
    expect(after.pageSeq).toBe(1);
    expect(after.sizing).toMatchObject({ limit: RUNG / 2, floor_hits: 0 });
    await stop(page);
    await page.close();
  });
});

test.describe("E-Z1 (R44): repeated allocation failure is bounded exhaustion, and 'Try again' starts again", () => {
  for (const row of [
    { site: "offsets.initial", shape: SMALL },
    { site: "offsets.copy", shape: SMALL },
    { site: "key.decode", shape: SMALL },
    { site: "change.decode", shape: SMALL },
    { site: "change.parse", shape: BULKY },
  ] as Array<{ site: AllocationSite; shape: Shape }>)
    test(`${row.site} ${row.shape === BULKY ? "(a page over markerMinBytes) " : ""}at the lowest rung: ${DATA_CONFIG.floorAfter} attempts, then \`stopped / floor\` with nothing applied; 'Try again' with the failure gone commits the page and clears the count`, async ({
      context,
    }, info) => {
      const page = await dataPage(context);
      await install(page, row.site, { times: 100_000 });
      // No device-memory signal: the lowest rung from the first request.
      await start(page, { text: payload(row.shape) });
      await expect
        .poll(() => engine(page), { timeout: 20_000, intervals: [100] })
        .toMatchObject({ kind: "stopped", cause: "floor" });
      const seen = await fault(page);
      const asked = await limits(page);
      const floor = await record(page);
      // Nothing more is asked for however long it waits (terminal until the person asks).
      await page.waitForTimeout(1_500);
      const stillAsked = await limits(page);
      await page.evaluate(removeAllocationFault);
      await page.evaluate(() => window.__atlasData?.retrySync());
      await idle(page);
      const recovered = await record(page);
      recordEvidence(info, `r44-floor-${row.site}`, {
        namedInjection: `a PERSISTENT allocation failure (a RangeError) thrown at ${row.site} of the production code, in the live page; removed before 'Try again'`,
        bodyBytes: payload(row.shape).length,
        fault: seen,
        limits: asked,
        stillAsked,
        floor,
        recovered,
      });
      expect(seen?.hits).toBe(DATA_CONFIG.floorAfter);
      expect(asked).toEqual(Array(DATA_CONFIG.floorAfter).fill(1));
      expect(stillAsked).toEqual(asked);
      expect(floor.sizing).toMatchObject({
        limit: 1,
        floor_hits: DATA_CONFIG.floorAfter,
        attempt: null,
      });
      expect(floor.cache).toBe(0);
      expect(floor.cursor).toBe("before-page");
      expect(floor.pageSeq).toBe(0);
      expect(floor.unrecognised).toBe(0);
      expect(recovered.cache).toBe(row.shape.count);
      expect(recovered.cursor).toBe(CURSOR);
      expect(recovered.sizing).toMatchObject({
        limit: 1,
        floor_hits: 0,
        attempt: null,
      });
      await stop(page);
      await page.close();
    });

  test(`from the device's first rung the ladder walks ${RUNG} -> ${RUNG / 2} -> 1, then ${DATA_CONFIG.floorAfter} attempts at the lowest rung`, async ({
    context,
  }, info) => {
    const page = await dataPage(context);
    await install(page, "offsets.initial", { times: 100_000 });
    await start(page, { text: payload(SMALL), deviceMemoryGiB: 8 });
    await expect
      .poll(() => engine(page), { timeout: 20_000, intervals: [100] })
      .toMatchObject({ kind: "stopped", cause: "floor" });
    const asked = await limits(page);
    recordEvidence(info, "r44-ladder-walk", {
      namedInjection:
        "a PERSISTENT allocation failure thrown at offsets.initial of the production scanner, in the live page",
      limits: asked,
      floor: await record(page),
    });
    expect(asked).toEqual([RUNG, RUNG / 2, 1, 1, 1]);
    await stop(page);
    await page.close();
  });
});

test.describe("E-Z1 (R44) controls: a healthy page, a body that cannot be allocated, and a fault of the DATA", () => {
  test("control: a healthy page makes one request at the device's rung and counts nothing", async ({
    context,
  }, info) => {
    const page = await dataPage(context);
    await start(page, { text: payload(GROWN), deviceMemoryGiB: 8 });
    await idle(page);
    const after = await record(page);
    recordEvidence(info, "r44-healthy", { limits: await limits(page), after });
    expect(await limits(page)).toEqual([RUNG]);
    expect(after.cache).toBe(GROWN.count);
    expect(after.sizing).toMatchObject({
      limit: RUNG,
      floor_hits: 0,
      attempt: null,
    });
    await stop(page);
    await page.close();
  });

  test("control: a response body that cannot be allocated steps down (the existing path)", async ({
    context,
  }, info) => {
    const page = await dataPage(context);
    await start(page, {
      text: payload(SMALL),
      bodyFault: true,
      deviceMemoryGiB: 8,
    });
    await requests(page, 2);
    await idle(page);
    const asked = await limits(page);
    recordEvidence(info, "r44-body-allocation", {
      namedInjection:
        "the first response's arrayBuffer() rejects with a RangeError",
      limits: asked,
      after: await record(page),
    });
    expect(asked).toEqual([RUNG, RUNG / 2]);
    expect((await record(page)).cache).toBe(SMALL.count);
    await stop(page);
    await page.close();
  });

  for (const row of [
    { site: "change.parse", kind: "syntax" },
    { site: "change.decode", kind: "utf8" },
    { site: "key.decode", kind: "utf8" },
    { site: "cursor.parse", kind: "syntax" },
  ] as Array<{ site: AllocationSite; kind: FaultKind }>)
    test(`control: a ${row.kind} fault at ${row.site} is a fault of the DATA: the unrecognised budget counts it, the ladder does not move, and the same size is asked for again`, async ({
      context,
    }, info) => {
      const page = await dataPage(context);
      await install(page, row.site, { kind: row.kind });
      await start(page, { text: payload(SMALL), deviceMemoryGiB: 8 });
      await requests(page, 1);
      // After the first fault the budget has counted ONE unrecognised answer and the engine backs off.
      await expect
        .poll(async () => (await record(page)).unrecognised, {
          timeout: 15_000,
          intervals: [100],
        })
        .toBe(1);
      const counted = await record(page);
      await requests(page, 2);
      await idle(page);
      const asked = await limits(page);
      const after = await record(page);
      recordEvidence(info, `r44-data-fault-${row.site}-${row.kind}`, {
        namedInjection: `a ${row.kind === "syntax" ? "SyntaxError" : "TypeError (invalid UTF-8)"} thrown at ${row.site}, once, in the live page`,
        fault: await fault(page),
        limits: asked,
        counted,
        after,
      });
      expect((await fault(page))?.hits).toBe(1);
      expect(counted.sizing).toMatchObject({
        limit: RUNG,
        floor_hits: 0,
        attempt: null,
      });
      expect(asked).toEqual([RUNG, RUNG]);
      expect(after.cache).toBe(SMALL.count);
      expect(after.sizing).toMatchObject({ limit: RUNG, floor_hits: 0 });
      expect(after.unrecognised).toBe(0);
      await stop(page);
      await page.close();
    });
});

// A page this size is what the scenarios assume: a regression guard on the arithmetic the cases rely on.
test("E-Z1 arithmetic: the pages are the sizes the cases assume", () => {
  expect(GROWN.count).toBeGreaterThan(512);
  expect(SMALL.count).toBeLessThanOrEqual(512);
  expect(payload(BULKY).length).toBeGreaterThan(DATA_CONFIG.markerMinBytes);
  expect(payload(GROWN).length).toBeLessThan(256 * KIB);
});
