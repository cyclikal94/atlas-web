import type { BrowserContext, Page } from "@playwright/test";
import { DATA_CONFIG } from "../../src/data/model/config";
import {
  arrange,
  fencedWithCursor,
  leaderOf,
  leaderPage,
  rowsOf,
  type Scripted,
  syncStateOf,
  untilLeader,
} from "./data-leader-helpers";
import {
  ACCOUNT,
  bootSession,
  seedSettled,
  stubNetwork,
} from "./data-sync-helpers";
import { expect, test } from "./helpers";

/**
 * R21-QUOTA (WEB-09c revision 21): the quota check before a segmented delta request judges the response THAT request may bring (`m` changes
 * whatever the limit), not the whole-batch estimate, in Chromium, Firefox and macOS WebKit with the production quota guard, plans and real
 * IndexedDB. NAMED FIXTURE INJECTION: `navigator.storage.estimate()` answers a declared free space; this is the admission calculation, not
 * disk exhaustion. `/sync` is scripted against BE-Q23's PROVISIONAL contract; nothing here is integration evidence.
 *
 *   Q-N1  the ordinary engine (the review's schedule: m = 4, limit 1, eight upserts in two pieces of four) at 32 MiB (control), 7 MiB
 *         (below the reserve: no request) and 12 MiB (above the reserve plus the bounded response, below the whole-batch estimate);
 *   Q-N2  the production leader's fenced recovery catch-up resuming a held continuation (no capability answer, as production; the default
 *         budget) at the reserve plus 4 MiB (the bounded response fits, the whole batch would not) and at 7 MiB (below the reserve).
 */

const MIB = 1024 * 1024;
const person = (n: number) => ({
  id: `00000000-0000-4000-8000-${n.toString().padStart(12, "0")}`,
  kind: "person",
  parent_id: null,
  label: "quota-control",
  value: null,
  version: 1,
  can_edit: true,
  archived: false,
  policy_version: 1,
});
const upserts = (from: number) =>
  Array.from({ length: 4 }, (_, k) => ({
    kind: "upsert",
    resource: person(from + k),
  }));
const piece = (index: number, next: string): string =>
  JSON.stringify({
    phase: "delta",
    batches: [
      {
        revision: 7,
        changes: upserts(4 * index + 1),
        segment: { index, last: index === 1 },
      },
    ],
    next_cursor: next,
    has_more: index === 0,
  });

/**
 * The declared free space, in every document of the context created after this call, from its start: no reading of the real estimate can
 * precede it (a page whose guard read the real figure first would judge on that for the estimate's lifetime). Each reading is counted.
 * On the PROTOTYPE: in WebKit an init script's definition on the `navigator.storage` instance is not the one the page later reads.
 */
async function declareFreeSpace(
  context: BrowserContext,
  free: number,
): Promise<void> {
  await context.addInitScript((bytes) => {
    const w = window as unknown as { __estimates?: number };
    Object.defineProperty(StorageManager.prototype, "estimate", {
      configurable: true,
      value: async () => {
        w.__estimates = (w.__estimates ?? 0) + 1;
        return { usage: 0, quota: bytes };
      },
    });
  }, free);
}
/** How many times the page read the declared estimate (a case whose guard never read it would prove nothing). */
const estimatesRead = (page: Page): Promise<number> =>
  page.evaluate(
    () => (window as unknown as { __estimates?: number }).__estimates ?? 0,
  );

test.describe("Q-N1: the ordinary engine admits a request by its negotiated budget (R21-QUOTA)", () => {
  for (const scenario of [
    { name: "ample space", free: 32 * MIB, rows: 8 },
    { name: "below the reserve", free: 7 * MIB, rows: 0 },
    { name: "the bounded response fits", free: 12 * MIB, rows: 8 },
  ])
    test(`m = 4, ${scenario.name}`, async ({ context }) => {
      const net = await stubNetwork(context);
      await seedSettled(context);
      await declareFreeSpace(context, scenario.free);
      const page = await bootSession(context);
      net.script.push(
        () => ({ status: 200, body: piece(0, "cont-0") }),
        () => ({ status: 200, body: piece(1, "final") }),
      );
      await page.evaluate(
        (a) =>
          window.__atlasData?.startSync(a, {
            seedCursor: "cursor-0",
            segmentedCapable: true,
            segmentedMaxChanges: 4,
          }),
        ACCOUNT,
      );
      await expect
        .poll(() =>
          page.evaluate(() => window.__atlasData?.engineState()?.kind),
        )
        .toMatch(/^(idle|stopped)$/);
      const state = await page.evaluate(() =>
        window.__atlasData?.engineState(),
      );
      await page.evaluate(() => window.__atlasData?.stopSync());
      expect(await estimatesRead(page)).toBeGreaterThan(0);
      const stored = await page.evaluate(
        async (a) => ({
          sync: await window.__atlasData?.syncState(a),
          cache: await window.__atlasData?.rows(a, "cache"),
          stage: await window.__atlasData?.rows(a, "delta_staging"),
        }),
        ACCOUNT,
      );
      expect(stored.cache).toHaveLength(scenario.rows);
      if (scenario.rows > 0) {
        expect(
          net.requests
            .slice(0, 2)
            .map((u) => [
              u.searchParams.get("cursor"),
              u.searchParams.get("max_changes"),
            ]),
        ).toEqual([
          ["cursor-0", "4"],
          ["cont-0", "4"],
        ]);
        expect(stored.sync).toMatchObject({
          applied_revision: 7,
          delta_stage: null,
        });
        expect(stored.stage).toEqual([]);
      } else {
        expect(net.requests).toHaveLength(0);
        expect(state).toEqual({ kind: "stopped", cause: "storage_full" });
        expect(stored.sync).toMatchObject({ cursor: "cursor-0" });
        expect(stored.stage).toEqual([]);
      }
    });
});

test.describe("Q-N2: the recovery catch-up admits a held continuation by its budget (R21-QUOTA)", () => {
  for (const scenario of [
    {
      name: "the bounded response fits, the whole batch would not",
      reserveFree: 4 * MIB,
      activates: true,
    },
    { name: "below the reserve", reserveFree: null, activates: false },
  ])
    test(scenario.name, async ({ context }) => {
      const net = await fencedWithCursor(context);
      // A revision being received: its first piece staged at the continuation `cont-0` (a FIXTURE arrangement of W27's rows).
      await arrange(context, async (page) => {
        await page.evaluate(
          async ([account, staged]) => {
            const data = window.__atlasData;
            const sync = await data?.syncState(account);
            await data?.put(account, "sync_state", [
              {
                ...sync,
                cursor: "cont-0",
                delta_stage: {
                  revision: 7,
                  next_index: 1,
                  boundary_cursor: "delta-0",
                  cursor: "cont-0",
                  changes: 4,
                  bytes: 966,
                  started_at: 0,
                },
              },
            ]);
            await data?.put(account, "delta_staging", staged);
          },
          [
            ACCOUNT,
            upserts(1).map((c) => ({
              id: c.resource.id,
              revision: 7,
              removed: false,
              row: { ...c.resource, kind_date: null },
              request_seq: 1,
            })),
          ] as const,
        );
      });
      net.answer = (call): Scripted =>
        call.cursor === "cont-0"
          ? { status: 200, body: piece(1, "final") }
          : {
              status: 200,
              body: JSON.stringify({
                phase: "delta",
                batches: [],
                next_cursor: call.cursor ?? "x",
                has_more: false,
              }),
            };
      const free =
        scenario.reserveFree === null
          ? 7 * MIB
          : DATA_CONFIG.quotaReserveBytes + scenario.reserveFree;
      await declareFreeSpace(context, free);
      const page = await leaderPage(context, net, "one");
      if (scenario.activates) {
        await expect
          .poll(async () => (await syncStateOf(page))?.cursor, {
            timeout: 15_000,
          })
          .toBe("final");
        const sync = await syncStateOf(page);
        expect(
          net.calls
            .filter((c) => c.cursor === "cont-0")
            .slice(0, 1)
            .map((c) => c.maxChanges),
        ).toEqual([String(DATA_CONFIG.segmentedMaxChanges)]);
        expect(sync).toMatchObject({
          cursor: "final",
          applied_revision: 7,
          delta_stage: null,
        });
        expect(await rowsOf(page, "delta_staging")).toEqual([]);
        expect(await estimatesRead(page)).toBeGreaterThan(0);
        expect(
          ((await rowsOf(page, "cache")) as Array<{ label: string }>).filter(
            (r) => r.label === "quota-control",
          ),
        ).toHaveLength(8);
      } else {
        const view = await untilLeader(
          page,
          (v) => (v as { job?: { kind?: string } }).job?.kind === "stopped",
        );
        expect((view as { job?: unknown }).job).toMatchObject({
          kind: "stopped",
          cause: "storage_full",
        });
        expect(net.calls.filter((c) => c.cursor === "cont-0")).toEqual([]);
        expect(await syncStateOf(page)).toMatchObject({
          cursor: "cont-0",
          delta_stage: { next_index: 1 },
        });
        expect(await rowsOf(page, "delta_staging")).toHaveLength(4);
        expect(await estimatesRead(page)).toBeGreaterThan(0);
        expect((await leaderOf(page)).job).toMatchObject({
          cause: "storage_full",
        });
      }
    });
});
