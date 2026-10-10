import type { Page } from "@playwright/test";
import { DATA_CONFIG } from "../../src/data/model/config";
import { recordEvidence } from "./data-evidence";
import { ACCOUNT, dataPage } from "./data-sync-helpers";
import { expect, test } from "./helpers";

/**
 * E-M1 (revision 23, R42), in Chromium, Firefox and WebKit: the crash-loop marker is a claim about an UNKNOWN outcome and ends when the
 * outcome is known. The PRODUCTION sync engine, plans, guards and Dexie adapter over REAL IndexedDB, on the data harness page (no session:
 * the harness's own runtime and identity, and a transport this spec supplies inside the page). FIXTURE evidence: no backend is behind it,
 * the response is a script of 327,700 bytes (40 projections of 8,000 bytes: over `markerMinBytes`), and the engine is started by the
 * fixture's TEST LEADER (production starts no engine until WEB-09b supplies leadership).
 *
 * THE REVIEW'S SCHEDULE. A page of at least `markerMinBytes` writes `sizing.attempt` before its guarded commit. When the persistence hold
 * answers `unavailable`, the commit is DROPPED (correctly: `unverified`), and the marker used to be left: the next capture read it as a
 * tab that did not survive, so three safe drops at the lowest rung were `floor_hits: 3` and `stopped / floor`, with no allocation failure,
 * no watchdog overrun, no crash and no quota exhaustion. Here the hold's answer is a NAMED INJECTION of the port's outcome
 * (`setPersistenceFault`): it tests the handling of that outcome, not real lock contention, a physical freeze or a browser crash. Each
 * drop is followed by the engine's own wake (`nudgeSync`), the same step a notification asks for, so the case does not wait for the
 * paced timer (the pacing is not what it shows: its count of floor hits is).
 *
 * THE CONTROL THAT MATTERS. A genuine crash must still be detected: the persistence hold never answers (`pending`), the page is CLOSED
 * with the commit in flight (the one thing a marker exists for), and the next page of the origin finds the marker in the real database
 * and steps the ladder down.
 */
declare global {
  interface Window {
    __limits?: number[];
  }
}

const RUNG = 4;
const body = (): string =>
  JSON.stringify({
    phase: "delta",
    has_more: false,
    next_cursor: "after-page",
    batches: [
      {
        revision: 1,
        changes: Array.from({ length: 40 }, (_, i) => ({
          kind: "upsert",
          resource: {
            id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
            kind: "person",
            parent_id: null,
            label: "Person",
            value: { text: "x".repeat(8_000) },
            version: 1,
            can_edit: true,
            archived: false,
          },
        })),
      },
    ],
  });
const EMPTY = JSON.stringify({
  phase: "delta",
  has_more: false,
  next_cursor: "after-empty",
  batches: [],
});

type Fault = "none" | "unavailable" | "pending";

/** Starts the engine over a scripted transport that answers `payload`; every request's `limit` is recorded. */
async function start(
  page: Page,
  options: {
    payload: string;
    fault?: Fault;
    deviceMemoryGiB?: number;
    /** The cursor the delta database is arranged at first; `null` leaves the database as the last page left it. */
    seedCursor?: string | null;
  },
): Promise<void> {
  await page.evaluate(
    async ({ account, payload, fault, memory, seed }) => {
      const data = window.__atlasData;
      if (data === undefined) throw new Error("no harness");
      window.__limits = [];
      data.setPersistenceFault(fault);
      await data.startSyncLocal(account, {
        ...(seed === null ? {} : { seedCursor: seed }),
        ...(memory === null ? {} : { deviceMemoryGiB: memory }),
        transport: (request) => {
          window.__limits?.push(
            Number(new URL(request.url).searchParams.get("limit")),
          );
          return Promise.resolve(
            new Response(payload, {
              status: 200,
              headers: { "content-type": "application/json" },
            }),
          );
        },
      });
    },
    {
      account: ACCOUNT,
      payload: options.payload,
      fault: options.fault ?? "none",
      memory: options.deviceMemoryGiB ?? null,
      seed:
        options.seedCursor === undefined ? "before-page" : options.seedCursor,
    },
  );
}

const limits = (page: Page) => page.evaluate(() => window.__limits ?? []);
const stopped = (page: Page) =>
  page.evaluate(() => window.__atlasData?.engineState() ?? null);
/** What the REAL database holds of the ladder and the cursor, and how many cache rows. */
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
      cursor: string | null;
      page_seq: number;
    } | null;
    return {
      sizing: sync?.sizing ?? null,
      cursor: sync?.cursor ?? null,
      pageSeq: sync?.page_seq ?? null,
      cache: ((await data?.rows(account, "cache")) ?? []).length,
    };
  }, ACCOUNT);
/** How many commits the engine saw DROPPED, from its own trace (a fixed vocabulary): after the attempt's marker was settled. */
const drops = (page: Page) =>
  page.evaluate(
    () =>
      (window.__atlasData?.engineTrace ?? []).filter(
        (line) =>
          line.includes("data.sync_commit") &&
          line.includes('"kind":"dropped"'),
      ).length,
  );
const stop = (page: Page) =>
  page.evaluate(() => window.__atlasData?.stopSync());
/**
 * The record BETWEEN two steps of the engine (adapted in revision 37). A sample is taken right after the poll that counted a drop, and that
 * poll's own nudge (or the engine's paced retry) may already have started the NEXT step, which writes ITS crash-loop marker before its
 * guarded commit: a record read while that step is in flight holds the next attempt's marker, a correct claim about an outcome that is
 * unknown at that instant, and not a marker the counted drop left (revision 37's qualification control failed once in WebKit on a pool
 * runner exactly so: the marker seen was started 2.5 ms after the poll's nudge, after the drop it was sampled for). The record is read when
 * the engine's own trace says no step is running (the last step that began has ended) and is kept only if no step began while it was read;
 * the wait is an assertion, so a defect that keeps the engine from coming to rest fails as one. What the drops left is then what is read,
 * and every assertion on it is the original one.
 */
async function settledRecord(page: Page) {
  let read: { settled: boolean; record?: Awaited<ReturnType<typeof record>> } =
    {
      settled: false,
    };
  await expect
    .poll(
      async () => {
        read = await page.evaluate(async (account) => {
          const data = window.__atlasData;
          const trace = data?.engineTrace ?? [];
          const length = trace.length;
          const began = trace.findLastIndex(
            (line) =>
              line.includes(' data.sync_tick {"why":') &&
              line.includes('"coalesced":false'),
          );
          const ended = trace.findLastIndex(
            (line) =>
              line.includes(" data.sync_next ") ||
              line.includes(" data.sync_step_failed"),
          );
          if (began > ended) return { settled: false };
          const sync = (await data?.syncState(account)) as {
            sizing: {
              limit: number;
              class: string | null;
              floor_hits: number;
              attempt: { id: string } | null;
            };
            cursor: string | null;
            page_seq: number;
          } | null;
          const cache = ((await data?.rows(account, "cache")) ?? []).length;
          if (trace.length !== length) return { settled: false };
          return {
            settled: true,
            record: {
              sizing: sync?.sizing ?? null,
              cursor: sync?.cursor ?? null,
              pageSeq: sync?.page_seq ?? null,
              cache,
            },
          };
        }, ACCOUNT);
        return read.settled;
      },
      { timeout: 15_000, intervals: [10, 25, 50, 100] },
    )
    .toBe(true);
  if (read.record === undefined) throw new Error("no settled record");
  return read.record;
}

test.describe("E-M1 (R42): a safely dropped large page leaves no crash marker, in a real engine", () => {
  for (const memory of [undefined, 8] as const)
    test(`the persistence hold is unavailable, ${memory === undefined ? "at the lowest rung (no device-memory signal)" : `starting at rung ${RUNG}`}: ${DATA_CONFIG.floorAfter + 1} safe drops count nothing and leave no marker; the same page commits when the hold recovers`, async ({
      context,
    }, info) => {
      const page = await dataPage(context);
      await start(page, {
        payload: body(),
        fault: "unavailable",
        ...(memory === undefined ? {} : { deviceMemoryGiB: memory }),
      });
      const seen: unknown[] = [];
      for (let n = 1; n <= DATA_CONFIG.floorAfter + 1; n += 1) {
        // The engine's own wake asks for the next step; one that arrives while a step unwinds is the step's to honour or not, so it is
        // asked again until the drop is seen (each wake is at most one step, and every step is one more safe drop).
        await expect
          .poll(
            async () => {
              await page.evaluate(() => window.__atlasData?.nudgeSync());
              return drops(page);
            },
            { timeout: 15_000, intervals: [250] },
          )
          .toBeGreaterThanOrEqual(n);
        // Adapted in revision 37: read between steps (see `settledRecord`); the original read was `record(page)`.
        seen.push({ drop: n, ...(await settledRecord(page)) });
      }
      const dropped = await settledRecord(page);
      const asked = await limits(page);
      const engine = await stopped(page);
      // The record is written BEFORE anything is asserted: a failure leaves what the real database showed.
      recordEvidence(info, `r42-unavailable-hold-${memory ?? "lowest"}`, {
        namedInjection:
          "the persistence hold answers `unavailable` (setPersistenceFault); each next step is the engine's own wake (nudgeSync)",
        bodyBytes: body().length,
        markerMinBytes: DATA_CONFIG.markerMinBytes,
        seen,
        limits: asked,
        engine,
        afterDrops: dropped,
      });
      expect(body().length).toBeGreaterThan(DATA_CONFIG.markerMinBytes);
      for (const row of seen as Array<{
        sizing: { floor_hits: number; attempt: unknown; limit: number } | null;
        cache: number;
        cursor: string | null;
      }>) {
        expect(row.sizing?.attempt).toBeNull();
        expect(row.sizing?.floor_hits).toBe(0);
        expect(row.cache).toBe(0);
        expect(row.cursor).toBe("before-page");
      }
      expect(engine).not.toMatchObject({ kind: "stopped" });
      // The ladder never moved: every request asked for the rung the device started at.
      expect(new Set(asked).size).toBe(1);
      expect(dropped.sizing?.limit).toBe(asked[0]);
      // The hold recovers: the next step commits the page, which clears nothing because nothing is left to clear.
      await page.evaluate(() =>
        window.__atlasData?.setPersistenceFault("none"),
      );
      await page.evaluate(() => window.__atlasData?.nudgeSync());
      await expect
        .poll(async () => (await record(page)).cache, { timeout: 15_000 })
        .toBe(40);
      const after = await record(page);
      expect(after.cursor).toBe("after-page");
      expect(after.sizing).toMatchObject({ floor_hits: 0, attempt: null });
      await stop(page);
      await page.close();
    });

  test("a later page of the origin, after the drops, asks at the rung the device started at: no marker was left in the real database", async ({
    context,
  }, info) => {
    const first = await dataPage(context);
    await start(first, {
      payload: body(),
      fault: "unavailable",
      deviceMemoryGiB: 8,
    });
    await expect
      .poll(() => drops(first), { timeout: 15_000 })
      .toBeGreaterThanOrEqual(1);
    // Adapted in revision 37: read between steps (see `settledRecord`); the original read was `record(first)`.
    const leftBehind = await settledRecord(first);
    await stop(first);
    await first.close();
    const second = await dataPage(context);
    await start(second, {
      payload: EMPTY,
      deviceMemoryGiB: 8,
      seedCursor: null,
    });
    await expect
      .poll(async () => (await limits(second)).length, { timeout: 15_000 })
      .toBeGreaterThanOrEqual(1);
    const asked = await limits(second);
    recordEvidence(info, "r42-later-page-after-a-drop", {
      leftBehind,
      secondPageLimits: asked,
      second: await record(second),
    });
    expect(leftBehind.sizing?.attempt).toBeNull();
    expect(asked[0]).toBe(RUNG);
    await stop(second);
    await second.close();
  });

  test("an ownership mismatch drops a large page; the next legitimate run asks at the same rung (it asked at half of it before the fix)", async ({
    context,
  }, info) => {
    const page = await dataPage(context);
    await page.evaluate(async (account) => {
      const data = window.__atlasData;
      if (data === undefined) throw new Error("no harness");
      data.setRuntimeIdentity({ account, epoch: 1 });
      await data.openService(account, { create: true });
      await data.seedDelta(account, "before-page");
      const row = (await data.syncState(account)) as Record<string, unknown>;
      // Another page owns the database: a NAMED arrangement of the row the ownership guard reads.
      await data.put(account, "sync_state", [
        {
          ...row,
          owner: { tab_id: "other", ownership_token: "other", heartbeat_at: 1 },
        },
      ]);
    }, ACCOUNT);
    await start(page, { payload: body(), deviceMemoryGiB: 8 });
    await expect
      .poll(() => drops(page), { timeout: 15_000 })
      .toBeGreaterThanOrEqual(1);
    // Adapted in revision 37: read between steps (see `settledRecord`); the original read was `record(page)`.
    const dropped = await settledRecord(page);
    // The other page lets go; the engine's own wake asks again.
    await page.evaluate(async (account) => {
      const data = window.__atlasData;
      const row = (await data?.syncState(account)) as Record<string, unknown>;
      await data?.put(account, "sync_state", [{ ...row, owner: null }]);
      data?.nudgeSync();
    }, ACCOUNT);
    await expect
      .poll(async () => (await record(page)).cache, { timeout: 15_000 })
      .toBe(40);
    const asked = await limits(page);
    recordEvidence(info, "r42-owner-dropped", {
      dropped,
      limits: asked,
      after: await record(page),
    });
    expect(dropped.sizing?.attempt).toBeNull();
    expect(dropped.sizing?.limit).toBe(RUNG);
    expect(asked.length).toBeGreaterThanOrEqual(2);
    expect(new Set(asked)).toEqual(new Set([RUNG]));
    await stop(page);
    await page.close();
  });

  test("control: a healthy hold commits the large page and its own transaction clears the marker", async ({
    context,
  }, info) => {
    const page = await dataPage(context);
    await start(page, { payload: body(), deviceMemoryGiB: 8 });
    await expect
      .poll(async () => (await record(page)).cache, { timeout: 15_000 })
      .toBe(40);
    const after = await record(page);
    recordEvidence(info, "r42-healthy-large-page", { after });
    expect(after.cursor).toBe("after-page");
    expect(after.sizing).toMatchObject({
      limit: RUNG,
      floor_hits: 0,
      attempt: null,
    });
    await stop(page);
    await page.close();
  });
});

test.describe("E-M1 (R42): a genuine crash is still detected", () => {
  test("the commit never returns and the page is closed: the next page of the origin finds the marker in the real database and steps the ladder down", async ({
    context,
  }, info) => {
    const crashing = await dataPage(context);
    await start(crashing, {
      payload: body(),
      fault: "pending",
      deviceMemoryGiB: 8,
    });
    // The attempt is in flight: the marker is in the real database and nothing has been decided.
    await expect
      .poll(async () => (await record(crashing)).sizing?.attempt, {
        timeout: 15_000,
      })
      .not.toBeNull();
    const inFlight = await record(crashing);
    expect(inFlight.cache).toBe(0);
    await crashing.close();
    const next = await dataPage(context);
    await start(next, {
      payload: EMPTY,
      deviceMemoryGiB: 8,
      seedCursor: null,
    });
    await expect
      .poll(async () => (await limits(next)).length, { timeout: 15_000 })
      .toBeGreaterThanOrEqual(1);
    const asked = await limits(next);
    const after = await record(next);
    recordEvidence(info, "r42-genuine-crash", {
      namedInjection:
        "the persistence hold never answers (setPersistenceFault pending); the page is then closed with the commit in flight",
      inFlight,
      nextPageLimits: asked,
      after,
    });
    expect(asked[0]).toBe(RUNG / 2);
    expect(after.sizing).toMatchObject({ limit: RUNG / 2, attempt: null });
    await stop(next);
    await next.close();
  });

  test("a crash at the lowest rung counts toward the floor: three pages that never returned stop the fourth", async ({
    context,
  }, info) => {
    const seen: unknown[] = [];
    for (let crash = 1; crash <= DATA_CONFIG.floorAfter; crash += 1) {
      const page = await dataPage(context);
      await start(page, {
        payload: body(),
        fault: "pending",
        ...(crash === 1 ? {} : { seedCursor: null }),
      });
      await expect
        .poll(async () => (await record(page)).sizing?.attempt, {
          timeout: 15_000,
        })
        .not.toBeNull();
      await page.close();
    }
    const last = await dataPage(context);
    await start(last, { payload: EMPTY, seedCursor: null });
    await expect
      .poll(() => stopped(last), { timeout: 15_000 })
      .toMatchObject({ kind: "stopped", cause: "floor" });
    const after = await record(last);
    seen.push(after);
    recordEvidence(info, "r42-genuine-crash-loop", { after, seen });
    expect(after.sizing).toMatchObject({
      limit: 1,
      floor_hits: DATA_CONFIG.floorAfter,
    });
    expect(await limits(last)).toEqual([]);
    await stop(last);
    await last.close();
  });
});
