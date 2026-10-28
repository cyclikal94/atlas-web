import type { Page } from "@playwright/test";
import { recordEvidence } from "./data-evidence";
import {
  ACCOUNT,
  bootSession,
  seedSettled,
  stubNetwork,
  upsert,
  waitForState,
} from "./data-sync-helpers";
import { expect, test } from "./helpers";

/**
 * N1-N4 (WEB-09c, BOUNDED-SYNC-PAGINATION-20261027): segmented delta delivery through the PRODUCTION engine, plans, scanner and the
 * production session's stamped wrapper, in a REAL engine's IndexedDB, with `/sync` stubbed by `page.route`. FIXTURE evidence against BE-Q23's
 * PROVISIONAL contract (`src/data/model/segmented-sync.ts`): the harness tells the engine the server segments (`segmentedCapable`, a labelled
 * fixture option; production never opts in until the contract is in a released pin) and the stub answers in segments. Nothing here talks to
 * a backend.
 *
 * N1 a real reload between segments resumes from the stored continuation and activates once; N2 an IndexedDB write that throws during the
 * activation leaves the previous cache and the staged words, and the retry activates; N3 a second page adopts the staged revision and finishes
 * it; N4 no read of the cache between two segments shows any of the revision.
 */

const REVISION = 41;
const changes = Array.from({ length: 12 }, (_, i) =>
  upsert(i + 1, { round: REVISION, filler: "s".repeat(400) }),
);
const segmentBody = (
  index: number,
  last: boolean,
  nextCursor: string,
): string =>
  JSON.stringify({
    phase: "delta",
    batches: [
      {
        revision: REVISION,
        changes: changes.slice(index * 4, index * 4 + 4),
        segment: { index, last },
      },
    ],
    next_cursor: nextCursor,
    has_more: !last,
  });
const SEGMENTS = [
  () => ({ status: 200, body: segmentBody(0, false, "cont-0") }),
  () => ({ status: 200, body: segmentBody(1, false, "cont-1") }),
  () => ({ status: 200, body: segmentBody(2, true, "final") }),
];

/**
 * What IndexedDB holds, read with RAW IndexedDB in one read-only transaction (a connection opened without a version, closed at once): the
 * harness's Dexie reads may go through another connection whose cached answers can lag the engine's commit by a moment, which is a fact about
 * the harness, not about what is stored. One transaction makes the cursor, the stage and the counts one consistent view.
 */
interface Stored {
  cursor: unknown;
  applied_revision: unknown;
  delta_stage: unknown;
  cache: number;
  staged: number;
}
const stored = (page: Page): Promise<Stored> =>
  page.evaluate(
    (name) =>
      new Promise<Stored>((resolve, reject) => {
        const open = indexedDB.open(name);
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const db = open.result;
          const tx = db.transaction(
            ["sync_state", "cache", "delta_staging"],
            "readonly",
          );
          const sync = tx.objectStore("sync_state").get("singleton");
          const cache = tx.objectStore("cache").count();
          const staged = tx.objectStore("delta_staging").count();
          tx.oncomplete = () => {
            db.close();
            const row = (sync.result ?? {}) as Record<string, unknown>;
            resolve({
              cursor: row.cursor,
              applied_revision: row.applied_revision ?? null,
              delta_stage: row.delta_stage ?? null,
              cache: cache.result,
              staged: staged.result,
            });
          };
          tx.onerror = () => reject(tx.error);
        };
      }),
    `atlas-${ACCOUNT}`,
  );
const startSegmented = (page: Page, seedCursor?: string) =>
  page.evaluate(
    async ({ acct, cur }) => {
      await window.__atlasData?.startSync(acct, {
        ...(cur === undefined ? {} : { seedCursor: cur }),
        segmentedCapable: true,
      });
    },
    { acct: ACCOUNT, cur: seedCursor },
  );
const reboot = async (page: Page) => {
  await page.goto("/__session?route=%2Ftoday");
  await page.waitForFunction(
    () => window.__atlasFixture?.session?.booted !== undefined,
  );
  await page.evaluate(() => window.__atlasFixture?.session?.ready);
  await page.waitForFunction(() => window.__atlasData !== undefined);
};
/**
 * The revision is applied: its revision is the applied one and nothing is staged. (Not "the cursor is `final`": once the activation commits,
 * a wake of the engine may ask again at once and move the cursor on to the stub's next empty page before a poll sees it.)
 */
const activated = async (page: Page): Promise<Stored> => {
  const deadline = Date.now() + 30_000;
  for (;;) {
    const now = await stored(page);
    if (now.applied_revision === REVISION && now.delta_stage === null)
      return now;
    if (Date.now() > deadline)
      throw new Error(`not activated: ${JSON.stringify(now)}`);
    await page.waitForTimeout(25);
  }
};
const cursorIs = async (page: Page, cursor: string): Promise<Stored> => {
  const deadline = Date.now() + 30_000;
  for (;;) {
    const now = await stored(page);
    if (now.cursor === cursor) return now;
    if (Date.now() > deadline)
      throw new Error(`the cursor is ${String(now.cursor)}, not ${cursor}`);
    await page.waitForTimeout(25);
  }
};

test.describe("N1-N4: a revision delivered in segments is staged, never shown, and activated whole (WEB-09c)", () => {
  test("N1 and N4: a real reload between segments resumes from the continuation; no read between segments shows the revision", async ({
    context,
  }, info) => {
    const net = await stubNetwork(context);
    await seedSettled(context);
    const page = await bootSession(context);
    const unavailable = () => ({ status: 503, body: "{}" });
    net.script.push(SEGMENTS[0] as never, () => ({
      status: 503,
      body: "{}",
    }));
    await startSegmented(page, "cursor-0");
    await cursorIs(page, "cont-0");
    expect((await stored(page)).cache).toBe(0);
    expect((await stored(page)).staged).toBe(4);
    expect((await stored(page)).applied_revision).toBeNull();
    // A REAL reload: the engine and every in-memory fact go; the continuation and the staged words are in IndexedDB.
    await reboot(page);
    net.script.length = 0;
    // The last segment is held back behind a 503 (a back-off), so the cache is read with two segments staged (N4).
    net.script.push(SEGMENTS[1] as never, unavailable);
    const before = net.requests.length;
    await startSegmented(page);
    await cursorIs(page, "cont-1");
    // N4: two segments staged, nothing of the revision in the cache.
    expect((await stored(page)).cache).toBe(0);
    expect((await stored(page)).staged).toBe(8);
    net.script.push(SEGMENTS[2] as never);
    await activated(page);
    await waitForState(page, "idle");
    expect((await stored(page)).cache).toBe(12);
    expect((await stored(page)).staged).toBe(0);
    expect(await stored(page)).toMatchObject({
      applied_revision: REVISION,
      delta_stage: null,
    });
    const resumed = net.requests.slice(before);
    expect(resumed[0]?.searchParams.get("cursor")).toBe("cont-0");
    expect(resumed[0]?.searchParams.get("max_changes")).toBe("100");
    expect(resumed[1]?.searchParams.get("cursor")).toBe("cont-1");
    recordEvidence(info, "segmented-reload", {
      requests: net.requests.map((u) => u.search),
      note: "FIXTURE: BE-Q23's provisional contract, stubbed /sync; real IndexedDB and a real reload",
    });
  });

  test("N2: an IndexedDB write that throws during the activation leaves the previous cache and the staged words; the retry activates once", async ({
    context,
  }, info) => {
    const net = await stubNetwork(context);
    await seedSettled(context);
    const page = await bootSession(context);
    // A page-level fault (as `data-local-faults.ts` installs for drafts): the next armed `put` into `cache` throws, inside the activation.
    await page.evaluate(() => {
      const w = window as unknown as {
        __cacheFault?: { armed: number; hits: number };
      };
      w.__cacheFault = { armed: 0, hits: 0 };
      const proto = IDBObjectStore.prototype as unknown as Record<
        string,
        (...a: unknown[]) => unknown
      >;
      const put = proto.put as (...a: unknown[]) => unknown;
      proto.put = function (this: IDBObjectStore, ...args: unknown[]) {
        const fault = w.__cacheFault;
        if (fault && fault.armed > 0 && this.name === "cache") {
          fault.armed -= 1;
          fault.hits += 1;
          throw new DOMException("injected fault", "DataError");
        }
        return put.apply(this, args);
      };
    });
    // Two segments staged, then a 503 (a back-off) while the fault is armed; the final segment is served twice.
    net.script.push(SEGMENTS[0] as never, SEGMENTS[1] as never, () => ({
      status: 503,
      body: "{}",
    }));
    await startSegmented(page, "cursor-0");
    await cursorIs(page, "cont-1");
    await page.evaluate(() => {
      (
        window as unknown as { __cacheFault: { armed: number } }
      ).__cacheFault.armed = 1;
    });
    // The final segment once (its activation faults), then a 503 so the state after the fault can be read before the retry is served.
    net.script.push(SEGMENTS[2] as never, () => ({ status: 503, body: "{}" }));
    const faulted = (): Promise<number> =>
      page.evaluate(
        () =>
          (window as unknown as { __cacheFault: { hits: number } }).__cacheFault
            .hits,
      );
    const deadline = Date.now() + 30_000;
    while ((await faulted()) === 0 || net.script.length > 0) {
      if (Date.now() > deadline)
        throw new Error("the activation was never faulted");
      await page.waitForTimeout(25);
    }
    // Nothing of the activation landed: the previous (empty) cache, both staged segments, the position at the continuation.
    expect(await stored(page)).toMatchObject({
      cursor: "cont-1",
      cache: 0,
      staged: 8,
      applied_revision: null,
    });
    net.script.push(SEGMENTS[2] as never);
    // The same page, requested again from the same position, activates once.
    await activated(page);
    await waitForState(page, "idle");
    const hits = await page.evaluate(
      () =>
        (window as unknown as { __cacheFault: { hits: number } }).__cacheFault
          .hits,
    );
    expect(hits).toBe(1);
    // At cont-1: the first 503, the faulted activation's request, the second 503 and the request that activated.
    const third = net.requests.filter(
      (u) => u.searchParams.get("cursor") === "cont-1",
    );
    expect(third.length).toBe(4);
    expect((await stored(page)).cache).toBe(12);
    expect((await stored(page)).staged).toBe(0);
    recordEvidence(info, "segmented-activation-fault", {
      faultedActivations: hits,
      finalRequests: third.length,
    });
  });

  test("N3: a second page adopts the staged revision (shared IndexedDB) and finishes it", async ({
    context,
  }, info) => {
    const net = await stubNetwork(context);
    await seedSettled(context);
    const first = await bootSession(context);
    net.script.push(SEGMENTS[0] as never, () => ({ status: 503, body: "{}" }));
    await startSegmented(first, "cursor-0");
    await cursorIs(first, "cont-0");
    await first.evaluate(() => window.__atlasData?.stopSync());
    const second = await bootSession(context);
    net.script.length = 0;
    net.script.push(SEGMENTS[1] as never, SEGMENTS[2] as never);
    const before = net.requests.length;
    await startSegmented(second);
    await activated(second);
    expect(net.requests[before]?.searchParams.get("cursor")).toBe("cont-0");
    expect((await stored(second)).cache).toBe(12);
    expect((await stored(first)).cache).toBe(12);
    expect((await stored(second)).staged).toBe(0);
    recordEvidence(info, "segmented-adoption", {
      requests: net.requests.map((u) => u.search),
    });
  });
});

/**
 * N5 and N6 (R20-SEG of the review of 28 October 2026): an edit made WHILE a revision is staged, through the production engine, the public
 * enqueue facade, the outbox dispatcher and the receipt writer, in a real engine's IndexedDB. The review's native schedule, kept: segment 0 of
 * revision 10 carries A = old; the edit is then sent and acknowledged (revision 11); the final segment does not name A and announces more
 * (`has_more`); later requests are held with 503s, so the state after the activation is read before anything newer is served. A staged word
 * older than the claim must not retire the acknowledged edit. Controls: ordinary pages (revision 10 before the edit, 11 after it) and a fresh
 * word of A in the final segment. N6 puts a REAL reload between the receipt and the final segment: the staged words' requests and the claim's
 * witness are durable, so the decision is the same.
 */
const A = "00000000-0000-4000-8000-000000000001";
const id = (n: number) =>
  `00000000-0000-4000-8000-${n.toString().padStart(12, "0")}`;
const person = (rid: string, label: string, version: number) => ({
  kind: "upsert",
  resource: {
    id: rid,
    kind: "person",
    parent_id: null,
    label,
    value: null,
    version,
    can_edit: true,
    archived: false,
    policy_version: 1,
  },
});
const held = () =>
  Array.from({ length: 12 }, () => () => ({ status: 503, body: "{}" }));
type Mode = "ordinary" | "fresh" | "stale";
const pieceBody = (
  mode: Mode,
  index: number,
  changes: unknown[],
  next: string,
): string =>
  JSON.stringify({
    phase: "delta",
    batches: [
      {
        revision: mode === "ordinary" && index === 1 ? 11 : 10,
        changes,
        ...(mode === "ordinary"
          ? {}
          : { segment: { index, last: index === 1 } }),
      },
    ],
    next_cursor: next,
    has_more: true,
  });
interface Local {
  drafts: Array<Record<string, unknown>>;
  effects: Array<Record<string, unknown>>;
  cache: Array<{ id: string; label: string; version: number }>;
  sync: Record<string, unknown>;
}
const local = (page: Page): Promise<Local> =>
  page.evaluate(async (acct) => {
    const data = window.__atlasData;
    return {
      drafts: ((await data?.rows(acct, "drafts")) ?? []) as Array<
        Record<string, unknown>
      >,
      effects: ((await data?.rows(acct, "pending_effects")) ?? []) as Array<
        Record<string, unknown>
      >,
      cache: ((await data?.rows(acct, "cache")) ?? []) as Array<{
        id: string;
        label: string;
        version: number;
      }>,
      sync: ((await data?.syncState(acct)) ?? {}) as Record<string, unknown>,
    };
  }, ACCOUNT);

/** Revision 10's first piece (staged, or an ordinary page), the edit sent and acknowledged; returns the state just after the receipt. */
async function editBetweenPieces(
  page: Page,
  net: Awaited<ReturnType<typeof stubNetwork>>,
  mode: Mode,
): Promise<Local> {
  const first = pieceBody(
    mode,
    0,
    [
      person(A, "old", 1),
      ...[10, 11, 12].map((n) => person(id(n), "early", 1)),
    ],
    "c1",
  );
  net.script.push(() => ({ status: 200, body: first }), ...held());
  await page.evaluate(
    (acct) =>
      window.__atlasData?.startSync(acct, {
        seedCursor: "cursor-0",
        segmentedCapable: true,
        segmentedMaxChanges: 4,
      }),
    ACCOUNT,
  );
  await expect.poll(async () => (await local(page)).sync.cursor).toBe("c1");
  await page.evaluate(() => window.__atlasData?.stopSync());
  await page.evaluate(
    async ({ acct, rid }) => {
      // The previous complete revision held A at version 1: the staged piece repeats that older content.
      await window.__atlasData?.put(acct, "cache", [
        {
          id: rid,
          kind: "person",
          parent_id: null,
          label: "old",
          value: null,
          version: 1,
          can_edit: true,
          archived: false,
          kind_date: null,
        },
      ]);
      await window.__atlasData?.startOutbox(acct);
    },
    { acct: ACCOUNT, rid: A },
  );
  net.commandScript.push(() => ({
    status: 200,
    body: JSON.stringify({ revision: mode === "ordinary" ? 12 : 11 }),
  }));
  const queued = await page.evaluate(
    (rid) =>
      window.__atlasData?.enqueue({
        endpoint: "/commands",
        targets: [
          {
            resourceId: rid,
            role: "primary",
            basis: "resource",
            versionChecked: true,
          },
        ],
        command: { kind: "edit", id: rid, base: { $base: rid }, label: "new" },
        displayPatch: { [rid]: { label: "new" } },
      }),
    A,
  );
  expect(queued?.kind).toBe("queued");
  await expect
    .poll(async () => (await local(page)).drafts)
    .toMatchObject([{ status: "acknowledged" }]);
  const after = await local(page);
  expect(after.effects).toMatchObject([
    { resource_id: A, display: { label: "new" } },
  ]);
  return after;
}

/** The second piece (the final segment, or the next ordinary page), served once, then held; returns the state after it applied. */
async function finish(
  page: Page,
  net: Awaited<ReturnType<typeof stubNetwork>>,
  mode: Mode,
): Promise<Local> {
  net.script.length = 0;
  const last = pieceBody(
    mode,
    1,
    [
      person(id(2), "other", 1),
      person(id(20), "later", 1),
      person(id(21), "later", 1),
      mode === "fresh" ? person(A, "new", 2) : person(id(29), "later", 1),
    ],
    "c2",
  );
  net.script.push(() => ({ status: 200, body: last }), ...held());
  await page.evaluate(
    (acct) =>
      window.__atlasData?.startSync(acct, {
        segmentedCapable: true,
        segmentedMaxChanges: 4,
      }),
    ACCOUNT,
  );
  await expect
    .poll(async () => (await local(page)).sync)
    .toMatchObject({ cursor: "c2", delta_stage: null });
  await page.evaluate(() => window.__atlasData?.stopSync());
  return local(page);
}

const expectOutcome = (after: Local, mode: Mode) => {
  expect(after.cache.find((row) => row.id === A)?.label).toBe(
    mode === "fresh" ? "new" : "old",
  );
  if (mode === "fresh") {
    expect(after.drafts).toEqual([]);
    expect(after.effects).toEqual([]);
  } else {
    expect(after.drafts).toMatchObject([{ status: "acknowledged" }]);
    expect(after.effects).toMatchObject([
      {
        resource_id: A,
        display: { label: "new" },
        last_mentioned_page_seq: null,
      },
    ]);
  }
};

test.describe("N5 and N6: an edit acknowledged while a revision is staged keeps its receipt state (R20-SEG)", () => {
  for (const mode of ["stale", "ordinary", "fresh"] as const)
    test(`N5 ${mode}: ${mode === "stale" ? "an older staged word does not retire the later edit" : mode === "fresh" ? "control: the final segment's fresh word releases it" : "control: ordinary pages keep it"}`, async ({
      context,
    }, info) => {
      const net = await stubNetwork(context);
      await seedSettled(context);
      const page = await bootSession(context);
      const before = await editBetweenPieces(page, net, mode);
      const after = await finish(page, net, mode);
      expectOutcome(after, mode);
      recordEvidence(info, `segmented-receipt-${mode}`, {
        before,
        after,
        commands: net.commands.length,
      });
    });

  test("N6: a real reload between the receipt and the final segment changes nothing of the decision", async ({
    context,
  }, info) => {
    const net = await stubNetwork(context);
    await seedSettled(context);
    const page = await bootSession(context);
    const before = await editBetweenPieces(page, net, "stale");
    await page.evaluate(() => window.__atlasData?.stopOutbox());
    await reboot(page);
    const after = await finish(page, net, "stale");
    expectOutcome(after, "stale");
    recordEvidence(info, "segmented-receipt-reload", { before, after });
  });
});
