import type { Page } from "@playwright/test";
import { accountDatabaseName } from "../../src/data/model/schema";
import { recordEvidence } from "./data-evidence";
import { markers as sharedMarkers } from "./data-local-faults";
import {
  ACCOUNT,
  bootSession,
  dataPage,
  denseChecklist,
  pageText,
  seedSettled,
  startLeader,
  stubNetwork,
  upsert,
  uuid,
  waitForState,
} from "./data-sync-helpers";
import { expect, test } from "./helpers";

/**
 * E-C1, E-C2, E-C3 (plan 8.3): ordinary delta sync through the PRODUCTION engine, plans, scanner and the production session's
 * stamped wrapper (`fetchFor`), in a real engine, with the network stubbed by `page.route`. FIXTURE evidence for this engine on this
 * machine. The leader is a FIXTURE test leader (production starts no engine until WEB-09b supplies leadership), and the delta
 * database is arranged by a FIXTURE seeder (the real first snapshot is WEB-09b's). Memory figures are P-11's and are not asserted
 * here; "completes without a crash or hang" is all E-C3 claims.
 */
const cacheCount = (page: Page) =>
  page.evaluate(
    (a) => window.__atlasData?.rows(a, "cache").then((r) => r.length),
    ACCOUNT,
  );
const syncRow = (page: Page) =>
  page.evaluate((a) => window.__atlasData?.syncState(a), ACCOUNT);

test.describe("E-C3: the whole path (fetchFor -> scan -> commit) completes for dense valid pages", () => {
  test("W1-like dense checklist page: 800 tasks x 100 items, one batch, at the lowest rung", async ({
    context,
  }, info) => {
    const net = await stubNetwork(context);
    await seedSettled(context);
    const page = await bootSession(context);
    const changes = denseChecklist(800, 100);
    const body = pageText([changes], "cursor-dense");
    net.script.push(() => ({ status: 200, body }));
    const started = Date.now();
    await startLeader(page);
    await waitForState(page, "idle");
    const elapsedMs = Date.now() - started;
    expect(await cacheCount(page)).toBe(800);
    expect((await syncRow(page))?.cursor).toBe("cursor-dense");
    expect(net.requests).toHaveLength(1);
    expect(net.requests[0]?.searchParams.get("limit")).toBe("1");
    recordEvidence(info, "dense-checklist", {
      label:
        "W1-like (NOT the approved W1 fixture, which the profiling programme builds)",
      bytes: new TextEncoder().encode(body).length,
      changes: 800,
      elapsedMs,
      note: "completes without a crash or hang on this machine; no memory figure is asserted (that is P-11)",
    });
  });

  test("W3-like text-heavy page: 200 resources with 30 KB of text each", async ({
    context,
  }, info) => {
    const net = await stubNetwork(context);
    await seedSettled(context);
    const page = await bootSession(context);
    const text = "lorem ipsum ".repeat(2_500);
    const changes = Array.from({ length: 200 }, (_, i) =>
      upsert(i + 1, { notes: text }),
    );
    const body = pageText([changes], "cursor-text");
    net.script.push(() => ({ status: 200, body }));
    await startLeader(page);
    await waitForState(page, "idle");
    expect(await cacheCount(page)).toBe(200);
    recordEvidence(info, "text-heavy", {
      bytes: new TextEncoder().encode(body).length,
    });
  });

  test("W4-like multi-batch amplification: 10 batches rewriting the same 20 resources; the server's order wins", async ({
    context,
  }) => {
    const net = await stubNetwork(context);
    await seedSettled(context);
    const page = await bootSession(context);
    const batches = Array.from({ length: 10 }, (_, b) =>
      Array.from({ length: 20 }, (_, i) =>
        upsert(i + 1, { round: b, filler: "y".repeat(2_000) }),
      ),
    );
    net.script.push(() => ({
      status: 200,
      body: pageText(batches, "cursor-amp"),
    }));
    await startLeader(page);
    await waitForState(page, "idle");
    expect(await cacheCount(page)).toBe(20);
    const rows = (await page.evaluate(
      (a) => window.__atlasData?.rows(a, "cache"),
      ACCOUNT,
    )) as Array<{ value: { round: number } }>;
    expect(new Set(rows.map((r) => r.value.round))).toEqual(new Set([9]));
  });

  test("has_more pages are followed in order and the cursor of each is the position of the next request", async ({
    context,
  }) => {
    const net = await stubNetwork(context);
    await seedSettled(context);
    const page = await bootSession(context);
    net.script.push(
      () => ({ status: 200, body: pageText([[upsert(1, null)]], "c1", true) }),
      () => ({ status: 200, body: pageText([[upsert(2, null)]], "c2", true) }),
      () => ({ status: 200, body: pageText([[upsert(3, null)]], "c3", false) }),
    );
    await startLeader(page);
    await waitForState(page, "idle");
    expect(net.requests.map((u) => u.searchParams.get("cursor"))).toEqual([
      "cursor-0",
      "c1",
      "c2",
    ]);
    expect(await cacheCount(page)).toBe(3);
    expect((await syncRow(page))?.page_seq).toBe(3);
  });
});

test.describe("E-C1: the page is atomic in a real engine, through a NAMED fault", () => {
  test("a write that throws at the 7th put of a page's transaction leaves nothing of it; the same page applies identically once the fault is gone", async ({
    context,
  }, info) => {
    const net = await stubNetwork(context);
    await seedSettled(context);
    const page = await bootSession(context);
    const changes = Array.from({ length: 30 }, (_, i) => upsert(i + 1, { i }));
    const body = pageText([changes], "cursor-atomic");
    // Every attempt serves the same page.
    for (let i = 0; i < 6; i += 1)
      net.script.push(() => ({ status: 200, body }));
    // The named fault: the 7th `put` into `cache` within one transaction throws (a real engine cannot be made to abort on request).
    await page.evaluate(() => {
      const w = window as unknown as { __arm: boolean; __seen: number };
      w.__arm = true;
      w.__seen = 0;
      const counts = new WeakMap<object, number>();
      for (const name of ["put", "putAll"] as const) {
        const proto = IDBObjectStore.prototype as unknown as Record<
          string,
          (...a: unknown[]) => unknown
        >;
        const original = proto[name];
        if (typeof original !== "function") continue;
        proto[name] = function (this: IDBObjectStore, ...args: unknown[]) {
          if (w.__arm && this.name === "cache") {
            const n = (counts.get(this.transaction) ?? 0) + 1;
            counts.set(this.transaction, n);
            if (n === 7) {
              w.__seen += 1;
              throw new DOMException("injected fault", "DataError");
            }
          }
          return original.apply(this, args);
        };
      }
    });
    await startLeader(page);
    await waitForState(page, "stopped");
    const failed = await page.evaluate(async (a) => {
      const data = window.__atlasData;
      return {
        state: data?.engineState(),
        cache: (await data?.rows(a, "cache"))?.length,
        sync: await data?.syncState(a),
        injected: (window as unknown as { __seen: number }).__seen,
      };
    }, ACCOUNT);
    expect(failed.state).toEqual({ kind: "stopped", cause: "local_storage" });
    expect(failed.cache).toBe(0); // nothing of the page is durable, though 6 of its 30 puts had been issued
    expect(failed.injected).toBeGreaterThanOrEqual(3);
    expect(failed.sync).toMatchObject({ cursor: "cursor-0", page_seq: 0 });
    // The same page was requested again from the same position each time (the stamp is fresh each time).
    expect(
      net.requests.slice(0, 3).map((u) => u.searchParams.get("cursor")),
    ).toEqual(["cursor-0", "cursor-0", "cursor-0"]);
    // Disarm and ask again ("Retry applying changes"): it applies identically.
    await page.evaluate(() => {
      (window as unknown as { __arm: boolean }).__arm = false;
      window.__atlasData?.retrySync();
    });
    await waitForState(page, "idle");
    expect(await cacheCount(page)).toBe(30);
    expect((await syncRow(page))?.cursor).toBe("cursor-atomic");
    recordEvidence(info, "atomic-page-named-fault", {
      injectedAttempts: failed.injected,
      rowsAfterFailure: failed.cache,
    });
  });
});

test.describe("E-C4: a stop of the CAPTURE WRITE is enforced by the next capture, in a real engine, across wakes and a real reload (R5, revision 7)", () => {
  /**
   * The named fault: a `put` into `sync_state` that carries a capture (`request_seq` above zero) throws. The fixture seeder's own put
   * (sequence zero) and every put once the fault is disarmed go through. With `counter`, a put that records a local-write streak
   * throws too, so the stop cannot be counted durably and goes to the fallback marker in the page's REAL `localStorage`.
   */
  async function arm(page: Page, counter: boolean): Promise<void> {
    await page.evaluate((failCounter) => {
      const w = window as unknown as { __armed: boolean };
      w.__armed = true;
      const proto = IDBObjectStore.prototype as unknown as Record<
        string,
        (...a: unknown[]) => unknown
      >;
      const original = proto.put as (...a: unknown[]) => unknown;
      proto.put = function (this: IDBObjectStore, ...args: unknown[]) {
        if (w.__armed && this.name === "sync_state") {
          const row = args[0] as {
            request_seq?: number;
            local_write_streaks?: Record<string, number>;
          };
          if (
            (row.request_seq ?? 0) > 0 ||
            (failCounter &&
              Object.keys(row.local_write_streaks ?? {}).length > 0)
          )
            throw new DOMException("injected fault", "DataError");
        }
        return original.apply(this, args);
      };
    }, counter);
  }
  const disarm = (page: Page) =>
    page.evaluate(() => {
      (window as unknown as { __armed: boolean }).__armed = false;
    });
  /** The operations that carry a marker in the page's real `localStorage` (the shared oracle parses the keys itself, R55). */
  const markers = sharedMarkers;
  const wakes = async (page: Page) => {
    await page.evaluate(() => {
      window.dispatchEvent(new Event("online"));
      document.dispatchEvent(new Event("visibilitychange"));
      window.__atlasData?.nudgeSync();
    });
    await page.waitForTimeout(1_000);
  };
  // A reload of the fixture's session page: the app moves the address to its own route, so the page is loaded again from the entry.
  const reboot = async (page: Page) => {
    await page.goto("/__session?route=%2Ftoday");
    await page.waitForFunction(
      () => window.__atlasFixture?.session?.booted !== undefined,
    );
    await page.evaluate(() => window.__atlasFixture?.session?.ready);
    await page.waitForFunction(() => window.__atlasData !== undefined);
  };

  test("a counter that cannot be written: the fallback marker (real localStorage) stops it at once; wakes, `online` and a reload send nothing, and only the explicit retry sends a request", async ({
    context,
  }, info) => {
    const net = await stubNetwork(context);
    await seedSettled(context);
    const page = await bootSession(context);
    await arm(page, true);
    await startLeader(page);
    await waitForState(page, "stopped");
    expect(
      await page.evaluate(() => window.__atlasData?.engineState()),
    ).toEqual({ kind: "stopped", cause: "local_storage" });
    expect(await markers(page)).toEqual(["capture"]);
    expect(net.requests).toHaveLength(0);
    // The fault is gone, so a capture WOULD now succeed; every wake must still be refused.
    await disarm(page);
    await wakes(page);
    expect(net.requests).toHaveLength(0);
    expect(
      await page.evaluate(() => window.__atlasData?.engineState()),
    ).toEqual({ kind: "stopped", cause: "local_storage" });
    // A real reload: the marker, not the (never written) counter, keeps the stop.
    await reboot(page);
    await startLeader(page);
    await waitForState(page, "stopped");
    await wakes(page);
    expect(net.requests).toHaveLength(0);
    expect(await markers(page)).toEqual(["capture"]);
    // The explicit retry clears that operation's marker and the request is made.
    await page.evaluate(() => window.__atlasData?.retrySync());
    await waitForState(page, "idle");
    expect(net.requests).toHaveLength(1);
    expect(await markers(page)).toEqual([]);
    recordEvidence(info, "capture-stop-marker", {
      requestsWhileStopped: 0,
      requestsAfterRetry: net.requests.length,
    });
  });

  test("three failed capture writes are counted durably: a wake and a reload send nothing, and only the explicit retry sends a request", async ({
    context,
  }, info) => {
    const net = await stubNetwork(context);
    await seedSettled(context);
    const page = await bootSession(context);
    await arm(page, false);
    await startLeader(page);
    await waitForState(page, "stopped");
    expect(
      await page.evaluate((a) => window.__atlasData?.syncState(a), ACCOUNT),
    ).toMatchObject({ local_write_streaks: { capture: 3 } });
    // The streak was written, so there is no marker.
    expect(await markers(page)).toEqual([]);
    expect(net.requests).toHaveLength(0);
    await disarm(page);
    await wakes(page);
    expect(net.requests).toHaveLength(0);
    await reboot(page);
    await startLeader(page);
    await waitForState(page, "stopped");
    await wakes(page);
    expect(net.requests).toHaveLength(0);
    expect(
      await page.evaluate((a) => window.__atlasData?.syncState(a), ACCOUNT),
    ).toMatchObject({ local_write_streaks: { capture: 3 } });
    await page.evaluate(() => window.__atlasData?.retrySync());
    await waitForState(page, "idle");
    expect(net.requests).toHaveLength(1);
    // The operation's own streak is gone with the retry, and the capture that followed it.
    expect(
      (await page.evaluate((a) => window.__atlasData?.syncState(a), ACCOUNT))
        ?.local_write_streaks,
    ).toEqual({});
    recordEvidence(info, "capture-stop-durable", {
      requestsWhileStopped: 0,
      requestsAfterRetry: net.requests.length,
    });
  });
});

test.describe("E-C2: cross-tab", () => {
  test("the leader's commit is visible to a follower tab and announced on atlas-sync; the follower never issues /sync", async ({
    context,
  }, info) => {
    const net = await stubNetwork(context);
    await seedSettled(context);
    const leader = await bootSession(context);
    const follower = await dataPage(context);
    await follower.evaluate(() => window.__atlasData?.follow());
    net.script.push(() => ({
      status: 200,
      body: pageText([[upsert(1, null), upsert(2, null)]], "cursor-x"),
    }));
    await startLeader(leader);
    await waitForState(leader, "idle");
    await follower.waitForFunction(
      () => (window.__atlasData?.syncReceived.length ?? 0) > 0,
    );
    const seen = await follower.evaluate(async (a) => {
      const data = window.__atlasData;
      if (!data) throw new Error("no harness");
      data.setIdentity(a);
      await data.open(a);
      return {
        rows: (await data.rows(a, "cache")).length,
        hints: data.syncReceived,
        issued: 0,
      };
    }, ACCOUNT);
    recordEvidence(info, "cross-tab", seen);
    expect(seen.rows).toBe(2);
    expect(seen.hints[0]).toMatchObject({
      type: "data_changed",
      account: ACCOUNT,
    });
    // Exactly the leader's one request reached the network: the follower issued none.
    expect(net.requests).toHaveLength(1);
    expect(
      await follower.evaluate(
        (n) => window.__atlasData?.list().then((l) => l.includes(n)),
        accountDatabaseName(ACCOUNT),
      ),
    ).toBe(true);
    void uuid;
  });
});

declare global {
  interface Window {
    __hold?: { kind: string; release?: () => void };
    __exclusive?: Promise<{ release(): void } | null>;
    __pendingHold?: Promise<{ kind: string; release?: () => void }>;
  }
}

test.describe("E-P1: the persistence hold with REAL Web Locks and the REAL atlas-auth store (R2)", () => {
  test("a settlement requested while one tab holds waits for it; a hold requested behind the settlement is served after it and sees the NEW identity; nothing is told to anyone", async ({
    context,
  }, info) => {
    await stubNetwork(context);
    await seedSettled(context);
    const a = await bootSession(context);
    const b = await bootSession(context);
    const hold = await a.evaluate(async (account) => {
      const session = window.__atlasFixture?.session?.booted?.session;
      if (!session) throw new Error("no session");
      const held = await session.persistence.hold(account, 1);
      window.__hold = held;
      return held.kind;
    }, ACCOUNT);
    expect(hold).toBe("held");

    // Another tab asks for the lock a settlement needs (exclusive) and then for its own hold, behind it in the queue.
    await b.evaluate(async (account) => {
      const harness = window.__atlasFixture?.session;
      const session = harness?.booted?.session;
      if (!harness || !session) throw new Error("no session");
      window.__exclusive = harness.locks.acquire("atlas-auth");
      window.__pendingHold = session.persistence.hold(account, 1);
    }, ACCOUNT);
    const settledEarly = await b.evaluate(async () => {
      const probe = await Promise.race([
        window.__exclusive?.then(() => "granted"),
        new Promise((resolve) => setTimeout(() => resolve("waiting"), 700)),
      ]);
      return probe;
    });
    // The hold keeps the settlement out: a transition cannot be ordered before the commit that holds.
    expect(settledEarly).toBe("waiting");

    // The first tab's commit has persisted: it releases, the settlement is granted and makes its change under the lock.
    await a.evaluate(() => window.__hold?.release?.());
    const later = await b.evaluate(async (other) => {
      const harness = window.__atlasFixture?.session;
      if (!harness) throw new Error("no session");
      const lock = await window.__exclusive;
      if (!lock) return "no lock";
      await harness.seedAuthState({
        schema: 1,
        latest_epoch: 2,
        fence_seq: 0,
        attempt: null,
        settled: {
          account_id: other,
          epoch: 2,
          settled_at: new Date().toISOString(),
          session_id: "s2",
        },
        fences: {},
        leases: {},
      });
      lock.release();
      return "settled";
    }, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
    expect(later).toBe("settled");

    // The hold that was queued behind the settlement is granted after it and reads the new record: STALE. So is a fresh one.
    const queued = await b.evaluate(
      async () => (await window.__pendingHold)?.kind,
    );
    const fresh = await a.evaluate(async (account) => {
      const session = window.__atlasFixture?.session?.booted?.session;
      if (!session) throw new Error("no session");
      return (await session.persistence.hold(account, 1)).kind;
    }, ACCOUNT);
    recordEvidence(info, "persistence-hold-real-locks", {
      firstHold: hold,
      settlementWhileHeld: settledEarly,
      queuedHoldAfterSettlement: queued,
      freshHoldAfterSettlement: fresh,
    });
    expect(queued).toBe("stale");
    expect(fresh).toBe("stale");
  });
});

/**
 * E-C5 (R10 and R11, revision 8): the WRITE of an invalidation the server admitted, in a real engine. A `410 resync_required` makes the
 * production engine commit `invalidateRecoveryPosition` over REAL IndexedDB. The one thing injected is a named `DOMException` thrown by
 * `IDBObjectStore.put` for the `sync_state` write that carries the invalidation (`cache_status: "invalid"`). The test leader registers no
 * recovery job (production starts no engine until WEB-09b), so a SUCCESSFUL invalidation ends in `stopped / no_recovery`: that is the
 * observable "the write landed". FIXTURE evidence: a stubbed backend, a named fault, a fixture seeder; not a genuine storage failure or
 * quota exhaustion, not the released backend, not real Safari.
 */
test.describe("E-C5: a failed write of an admitted invalidation keeps the cache hidden, is retried within the bound, and stops with a notice (R10)", () => {
  // `QuotaExceededError` is classified as a quota failure, which has its own rule (stopped at once, not counted): see the test below.
  const FAULTS = ["AbortError", "UnknownError"] as const;
  /**
   * The engine reaches `kind` (R10): an ASSERTION that fails with the state it saw, not a wait that ends by the test's own timeout.
   * (Revision 13: MU-126, whose defect keeps the engine from ever stopping, was caught by `waitForState` timing out and so only by a
   * crash; the requirement is the same, the way it fails is now a statement about the state.) The shared `waitForState` helper is left
   * as it is: three profiling cases measure latencies through it.
   */
  const expectState = (page: Page, kind: string) =>
    expect
      .poll(
        () =>
          page.evaluate(() => window.__atlasData?.engineState()?.kind ?? null),
        { timeout: 25_000, intervals: [50, 100, 250, 500] },
      )
      .toBe(kind);
  const OPERATION = "invalidate:cursor-0";
  const gone = () => ({
    status: 410,
    body: JSON.stringify({
      code: "resync_required",
      message: "m",
      request_id: "11111111-1111-4111-8111-111111111111",
      details: [],
    }),
  });

  /** The named fault: the `sync_state` put that carries the invalidation throws `times` times (and a counter write too, if `counter`). */
  async function arm(
    page: Page,
    fault: string,
    times: number,
    counter = false,
  ): Promise<void> {
    await page.evaluate(
      ({ name, limit, failCounter }) => {
        const w = window as unknown as {
          __invalidation: { injected: number; armed: boolean };
        };
        w.__invalidation = { injected: 0, armed: true };
        const proto = IDBObjectStore.prototype as unknown as Record<
          string,
          (...a: unknown[]) => unknown
        >;
        const original = proto.put as (...a: unknown[]) => unknown;
        proto.put = function (this: IDBObjectStore, ...args: unknown[]) {
          if (w.__invalidation.armed && this.name === "sync_state") {
            const row = args[0] as {
              cache_status?: string;
              local_write_streaks?: Record<string, number>;
            };
            if (
              row.cache_status === "invalid" &&
              w.__invalidation.injected < limit
            ) {
              w.__invalidation.injected += 1;
              throw new DOMException("injected invalidation fault", name);
            }
            if (
              failCounter &&
              Object.keys(row.local_write_streaks ?? {}).length > 0
            )
              throw new DOMException("injected counter fault", "DataError");
          }
          return original.apply(this, args);
        };
      },
      { name: fault, limit: times, failCounter: counter },
    );
  }
  const disarm = (page: Page) =>
    page.evaluate(() => {
      (
        window as unknown as { __invalidation: { armed: boolean } }
      ).__invalidation.armed = false;
    });
  const injected = (page: Page) =>
    page.evaluate(
      () =>
        (window as unknown as { __invalidation?: { injected: number } })
          .__invalidation?.injected ?? 0,
    );
  /** The operations that carry a marker in the page's real `localStorage` (the shared oracle parses the keys itself, R55). */
  const markers = sharedMarkers;
  const state = (page: Page) =>
    page.evaluate(() => window.__atlasData?.engineState());
  const sync = (page: Page) =>
    page.evaluate((a) => window.__atlasData?.syncState(a), ACCOUNT);
  const wakes = async (page: Page) => {
    await page.evaluate(() => {
      window.dispatchEvent(new Event("online"));
      document.dispatchEvent(new Event("visibilitychange"));
      window.__atlasData?.nudgeSync();
    });
    await page.waitForTimeout(1_000);
  };
  const reboot = async (page: Page) => {
    await page.goto("/__session?route=%2Ftoday");
    await page.waitForFunction(
      () => window.__atlasFixture?.session?.booted !== undefined,
    );
    await page.evaluate(() => window.__atlasFixture?.session?.ready);
    await page.waitForFunction(() => window.__atlasData !== undefined);
  };

  for (const fault of FAULTS) {
    test(`${fault}, once: the retained invalidation is written on the retry, with NO second request`, async ({
      context,
    }, info) => {
      const net = await stubNetwork(context);
      net.script.push(gone);
      await seedSettled(context);
      const page = await bootSession(context);
      await arm(page, fault, 1);
      await startLeader(page);
      await expectState(page, "stopped");
      // `no_recovery`: the fixture leader registers no recovery job, so a landed invalidation is exactly this state.
      expect(await state(page)).toEqual({
        kind: "stopped",
        cause: "no_recovery",
      });
      expect(await sync(page)).toMatchObject({
        cache_status: "invalid",
        cursor: null,
        local_write_streaks: {},
      });
      expect(await injected(page)).toBe(1);
      expect(net.requests).toHaveLength(1);
      expect(await markers(page)).toEqual([]);
      recordEvidence(info, `invalidation-transient-${fault}`, {
        injected: 1,
        requests: net.requests.length,
      });
    });

    test(`${fault}, every time: three counted failures stop it, the cache stays hidden, wakes and a real reload send nothing, and only the explicit retry writes it`, async ({
      context,
    }, info) => {
      const net = await stubNetwork(context);
      net.script.push(gone);
      await seedSettled(context);
      const page = await bootSession(context);
      await arm(page, fault, 1_000);
      await startLeader(page);
      await expectState(page, "stopped");
      expect(await state(page)).toEqual({
        kind: "stopped",
        cause: "local_storage",
        invalidating: true,
      });
      // The database still says `valid` (the write that would say otherwise failed); the durable streak is what hides the cache.
      expect(await sync(page)).toMatchObject({
        cache_status: "valid",
        local_write_streaks: { [OPERATION]: 3 },
      });
      expect(await injected(page)).toBe(3);
      expect(net.requests).toHaveLength(1);
      // Cache rows were not touched, and nothing was asked of the recovery job.
      await disarm(page);
      await wakes(page);
      expect(net.requests).toHaveLength(1);
      expect(await state(page)).toMatchObject({
        kind: "stopped",
        invalidating: true,
      });
      // A real reload: the durable streak keeps the stop (and the gate), and the first step after it sends nothing.
      await reboot(page);
      await startLeader(page);
      await expectState(page, "stopped");
      await wakes(page);
      expect(net.requests).toHaveLength(1);
      expect(await state(page)).toEqual({
        kind: "stopped",
        cause: "local_storage",
        invalidating: true,
      });
      // The explicit retry clears that operation's streak and the write lands (the server is asked again: a reload loses memory).
      net.script.push(gone);
      await page.evaluate(() => window.__atlasData?.retrySync());
      await expectState(page, "stopped");
      await expect
        .poll(async () => (await state(page)) as { cause?: string })
        .toMatchObject({ cause: "no_recovery" });
      expect(await sync(page)).toMatchObject({
        cache_status: "invalid",
        local_write_streaks: {},
      });
      recordEvidence(info, `invalidation-persistent-${fault}`, {
        injected: 3,
        requestsBeforeRetry: 1,
        requestsAfterRetry: net.requests.length,
      });
    });
  }

  test("QuotaExceededError: stopped at once and not counted, with the quota notice; the account's marker keeps the cache hidden across wakes and a real reload; the explicit retry writes it", async ({
    context,
  }, info) => {
    const net = await stubNetwork(context);
    net.script.push(gone);
    await seedSettled(context);
    const page = await bootSession(context);
    await arm(page, "QuotaExceededError", 1);
    await startLeader(page);
    await expectState(page, "stopped");
    // A quota failure is not counted (a counter would need the very space that is missing): one failure, and the stop says so.
    expect(await state(page)).toEqual({
      kind: "stopped",
      cause: "storage_full",
      invalidating: true,
    });
    expect(await injected(page)).toBe(1);
    expect(await sync(page)).toMatchObject({
      cache_status: "valid",
      local_write_streaks: {},
    });
    expect(await markers(page)).toEqual([OPERATION]);
    expect(net.requests).toHaveLength(1);
    // The space is back, but a wake does not lift the stop or change what it says.
    await disarm(page);
    await wakes(page);
    expect(net.requests).toHaveLength(1);
    expect(await state(page)).toEqual({
      kind: "stopped",
      cause: "storage_full",
      invalidating: true,
    });
    // A real reload: the marker (read by the capture gate) keeps the stop and the cache gate, and nothing is requested.
    await reboot(page);
    await startLeader(page);
    await expectState(page, "stopped");
    await wakes(page);
    expect(net.requests).toHaveLength(1);
    expect(await state(page)).toEqual({
      kind: "stopped",
      cause: "local_storage",
      invalidating: true,
    });
    net.script.push(gone);
    await page.evaluate(() => window.__atlasData?.retrySync());
    await expect
      .poll(async () => (await state(page)) as { cause?: string })
      .toMatchObject({ cause: "no_recovery" });
    expect(await markers(page)).toEqual([]);
    expect(await sync(page)).toMatchObject({
      cache_status: "invalid",
      local_write_streaks: {},
    });
    recordEvidence(info, "invalidation-quota", {
      requestsBeforeRetry: 1,
      requestsAfterRetry: net.requests.length,
    });
  });

  test("a counter that cannot be written: the fallback marker (real localStorage) stops it at once, hides the cache across a real reload, and the explicit retry clears it", async ({
    context,
  }, info) => {
    const net = await stubNetwork(context);
    net.script.push(gone);
    await seedSettled(context);
    const page = await bootSession(context);
    await arm(page, "UnknownError", 1_000, true);
    await startLeader(page);
    await expectState(page, "stopped");
    expect(await state(page)).toEqual({
      kind: "stopped",
      cause: "local_storage",
      invalidating: true,
    });
    expect(await markers(page)).toEqual([OPERATION]);
    expect(await sync(page)).toMatchObject({
      cache_status: "valid",
      local_write_streaks: {},
    });
    await disarm(page);
    await wakes(page);
    expect(net.requests).toHaveLength(1);
    await reboot(page);
    await startLeader(page);
    await expectState(page, "stopped");
    expect(await state(page)).toEqual({
      kind: "stopped",
      cause: "local_storage",
      invalidating: true,
    });
    expect(net.requests).toHaveLength(1);
    net.script.push(gone);
    await page.evaluate(() => window.__atlasData?.retrySync());
    await expect
      .poll(async () => (await state(page)) as { cause?: string })
      .toMatchObject({ cause: "no_recovery" });
    expect(await markers(page)).toEqual([]);
    expect(await sync(page)).toMatchObject({ cache_status: "invalid" });
    recordEvidence(info, "invalidation-marker", {
      requests: net.requests.length,
    });
  });
});

/**
 * E-C6 (R10, revision 9): the cache the server has said is invalid stays hidden through an offline wake and an explicit retry, in a real
 * engine. The fourth review reproduced, in Chromium, Firefox and WebKit, that a memory-only stop followed by an offline wake and an
 * explicit retry followed by connectivity loss each left the cache displayable: the only record that hid it had been replaced or erased.
 *
 * What is real here: IndexedDB (the named `DOMException` is thrown by the real `IDBObjectStore.put` for the `sync_state` write that
 * carries the invalidation, and for the streak's write when the counter is to fail), `localStorage` (the fallback marker is the real one,
 * and its `setItem` throws `QuotaExceededError` when it is to fail), the production session, controller, engine and plans, `navigator.onLine`
 * (overridden, with the `offline` and `online` events dispatched), a real page reload and a real second tab as the follower. What is not:
 * the faults are named thrown exceptions, not genuine storage or quota failures; the network is stubbed; the persistence hold that cannot
 * verify a commit is not reproducible in a page and is covered by the controller-level tests only; the test leader is a FIXTURE.
 * The gate read is the production controller's (`createDataEnv`) over this page, derived as a screen derives it.
 */
test.describe("E-C6: an admitted invalidation's write is held through an offline wake and an explicit retry; the gate stays hidden, and a follower and a reload agree (R10)", () => {
  const OPERATION = "invalidate:cursor-0";
  const FAULTS = ["AbortError", "UnknownError", "QuotaExceededError"] as const;
  const gone = () => ({
    status: 410,
    body: JSON.stringify({
      code: "resync_required",
      message: "m",
      request_id: "11111111-1111-4111-8111-111111111111",
      details: [],
    }),
  });

  /**
   * The named faults. The `sync_state` put that carries the invalidation throws `fault`; `counter` makes the streak's write throw too;
   * `marker` makes `localStorage.setItem` throw for the fallback marker. `disarm` lifts all of it.
   */
  async function arm(
    page: Page,
    fault: string,
    options: { counter: boolean; marker: boolean },
  ): Promise<void> {
    await page.evaluate(
      ({ name, counter, marker }) => {
        const w = window as unknown as { __hold: { armed: boolean } };
        w.__hold = { armed: true };
        const proto = IDBObjectStore.prototype as unknown as Record<
          string,
          (...a: unknown[]) => unknown
        >;
        const put = proto.put as (...a: unknown[]) => unknown;
        proto.put = function (this: IDBObjectStore, ...args: unknown[]) {
          if (w.__hold.armed && this.name === "sync_state") {
            const row = args[0] as {
              cache_status?: string;
              local_write_streaks?: Record<string, number>;
            };
            if (row.cache_status === "invalid")
              throw new DOMException("injected invalidation fault", name);
            if (
              counter &&
              Object.keys(row.local_write_streaks ?? {}).length > 0
            )
              throw new DOMException("injected counter fault", "DataError");
          }
          return put.apply(this, args);
        };
        if (marker) {
          const set = Storage.prototype.setItem;
          Storage.prototype.setItem = function (key: string, value: string) {
            if (
              w.__hold.armed &&
              (key.startsWith("atlas-write-failing:") ||
                key.startsWith("atlas-write-dir:"))
            )
              throw new DOMException(
                "injected marker fault",
                "QuotaExceededError",
              );
            return set.call(this, key, value);
          };
        }
      },
      { name: fault, ...options },
    );
  }
  const disarm = (page: Page) =>
    page.evaluate(() => {
      (window as unknown as { __hold: { armed: boolean } }).__hold.armed =
        false;
    });
  /**
   * Overrides `navigator.onLine`. `wake: false` is the browser having lost connectivity with NO event delivered to the engine yet (a
   * throttled or frozen page learns late): the engine is still `stopped`, and a click on "Retry applying changes" reaches it in that state.
   */
  const setOnline = (page: Page, online: boolean, wake = true) =>
    page.evaluate(
      ({ on, fire }) => {
        Object.defineProperty(navigator, "onLine", {
          configurable: true,
          get: () => on,
        });
        if (!fire) return;
        window.dispatchEvent(new Event(on ? "online" : "offline"));
        window.__atlasData?.nudgeSync();
      },
      { on: online, fire: wake },
    );
  const state = (page: Page) =>
    page.evaluate(() => window.__atlasData?.engineState());
  const sync = (page: Page) =>
    page.evaluate((a) => window.__atlasData?.syncState(a), ACCOUNT);
  /** The operations that carry a marker in the page's real `localStorage` (the shared oracle parses the keys itself, R55). */
  const markers = sharedMarkers;
  const holds = (page: Page) =>
    page.evaluate(() => window.__atlasData?.invalidationHolds());
  const gate = (page: Page) => page.evaluate(() => window.__atlasData?.gate());
  const notices = (page: Page) =>
    page.evaluate(() => window.__atlasData?.gateNotices());
  const startGate = (page: Page) =>
    page.evaluate((a) => window.__atlasData?.startGate(a), ACCOUNT);
  const reboot = async (page: Page) => {
    await page.goto("/__session?route=%2Ftoday");
    await page.waitForFunction(
      () => window.__atlasFixture?.session?.booted !== undefined,
    );
    await page.evaluate(() => window.__atlasFixture?.session?.ready);
    await page.waitForFunction(() => window.__atlasData !== undefined);
  };
  const waiting = async (page: Page, reason: string) =>
    expect
      .poll(async () => state(page))
      .toMatchObject({ kind: "waiting", reason });
  const landed = async (page: Page) =>
    expect
      .poll(async () => (await state(page)) as { cause?: string })
      .toMatchObject({ cause: "no_recovery" });

  for (const fault of FAULTS) {
    test(`${fault}, recorded nowhere durable: an offline wake keeps the engine's hold and the gate hidden; online the stop returns; the explicit retry writes it with no second request`, async ({
      context,
    }, info) => {
      const net = await stubNetwork(context);
      net.script.push(gone);
      await seedSettled(context);
      const page = await bootSession(context);
      await arm(page, fault, { counter: true, marker: true });
      await startLeader(page);
      await waitForState(page, "stopped");
      await startGate(page);
      expect(await state(page)).toMatchObject({
        kind: "stopped",
        invalidating: true,
      });
      // The database says `valid`; no counter, no marker: the engine's memory is all that records the failure.
      expect(await sync(page)).toMatchObject({
        cache_status: "valid",
        local_write_streaks: {},
      });
      expect(await markers(page)).toEqual([]);
      expect(await holds(page)).toEqual([OPERATION]);
      expect(await gate(page)).toBe("refreshing");
      // An offline wake (the browser's own `offline` event and a nudge).
      await setOnline(page, false);
      await waiting(page, "offline");
      expect(await state(page)).toMatchObject({ invalidating: true });
      expect(await holds(page)).toEqual([OPERATION]);
      expect(await gate(page)).toBe("refreshing");
      expect(await sync(page)).toMatchObject({ cache_status: "valid" });
      expect(net.requests).toHaveLength(1);
      // Back online: the stop is restored from the tab's memory, with its notice, and nothing is sent.
      await setOnline(page, true);
      await waitForState(page, "stopped");
      expect(await gate(page)).toBe("refreshing");
      expect(await notices(page)).toHaveLength(1);
      expect(net.requests).toHaveLength(1);
      // The fault is gone and the explicit retry writes the retained invalidation: no second request, every record gone.
      await disarm(page);
      await page.evaluate(() => window.__atlasData?.retrySync());
      await landed(page);
      expect(await sync(page)).toMatchObject({
        cache_status: "invalid",
        local_write_streaks: {},
      });
      expect(await holds(page)).toEqual([]);
      expect(await gate(page)).toBe("refreshing");
      expect(net.requests).toHaveLength(1);
      recordEvidence(info, `hold-memory-offline-${fault}`, {
        requests: net.requests.length,
      });
    });
  }

  type RecordedBy = "counter" | "marker";
  const RECORDS: ReadonlyArray<readonly [string, RecordedBy]> = [
    ["AbortError", "counter"],
    ["UnknownError", "counter"],
    ["UnknownError", "marker"],
    ["QuotaExceededError", "marker"],
  ];
  for (const [fault, record] of RECORDS)
    test(`${fault}, recorded by the real ${record === "counter" ? "IndexedDB streak" : "localStorage marker"}: an explicit retry, then connectivity loss, erases nothing; a follower tab and a real reload hide the cache; the write lands when the browser is back`, async ({
      context,
    }, info) => {
      const net = await stubNetwork(context);
      net.script.push(gone);
      await seedSettled(context);
      const page = await bootSession(context);
      await arm(page, fault, {
        counter: record === "marker" && fault !== "QuotaExceededError",
        marker: false,
      });
      await startLeader(page);
      await waitForState(page, "stopped");
      await startGate(page);
      const recorded = {
        streaks:
          record === "counter"
            ? { [OPERATION]: 3 }
            : ({} as Record<string, number>),
        markers: record === "marker" ? [OPERATION] : [],
      };
      expect(await sync(page)).toMatchObject({
        cache_status: "valid",
        local_write_streaks: recorded.streaks,
      });
      expect(await markers(page)).toEqual(recorded.markers);
      expect(await gate(page)).toBe("refreshing");
      // The browser loses connectivity (no event yet), and the person presses "Retry applying changes" on the stopped engine.
      await setOnline(page, false, false);
      await page.evaluate(() => window.__atlasData?.retrySync());
      await waiting(page, "offline");
      // The retry lifted the stop and erased NOTHING: the record that hides the cache is exactly what it was.
      expect(await sync(page)).toMatchObject({
        cache_status: "valid",
        local_write_streaks: recorded.streaks,
      });
      expect(await markers(page)).toEqual(recorded.markers);
      expect(await holds(page)).toEqual([OPERATION]);
      expect(await gate(page)).toBe("refreshing");
      expect(net.requests).toHaveLength(1);
      // A FOLLOWER: a second tab of the same profile, with a controller and no engine, sees only what is durable, and it hides the cache.
      const follower = await bootSession(context);
      await startGate(follower);
      expect(await gate(follower)).toBe("refreshing");
      await follower.close();
      // A real RELOAD of the leader: the engine and its memory are gone; the durable record alone hides the cache, and the engine
      // stops at the record and sends nothing.
      await reboot(page);
      await startLeader(page);
      await waitForState(page, "stopped");
      await startGate(page);
      expect(await gate(page)).toBe("refreshing");
      expect(await state(page)).toMatchObject({
        kind: "stopped",
        invalidating: true,
      });
      expect(net.requests).toHaveLength(1);
      // The reload took the injected fault with it (a new page context), so the explicit retry (the server is asked again after a
      // reload) lands the invalidation, and only then does the record go.
      net.script.push(gone);
      await page.evaluate(() => window.__atlasData?.retrySync());
      await landed(page);
      expect(await sync(page)).toMatchObject({
        cache_status: "invalid",
        local_write_streaks: {},
      });
      expect(await markers(page)).toEqual([]);
      expect(await holds(page)).toEqual([]);
      expect(await gate(page)).toBe("refreshing");
      expect(net.requests).toHaveLength(2);
      recordEvidence(info, `hold-retry-offline-${fault}-${record}`, {
        requests: net.requests.length,
      });
    });

  for (const [fault, record] of RECORDS)
    test(`${fault}, recorded by the real ${record === "counter" ? "IndexedDB streak" : "localStorage marker"}: the retry's lifted cycle survives the offline gap, and when the browser is back it lands the RETAINED write with no second request, then every record goes`, async ({
      context,
    }, info) => {
      const net = await stubNetwork(context);
      net.script.push(gone);
      await seedSettled(context);
      const page = await bootSession(context);
      await arm(page, fault, {
        counter: record === "marker" && fault !== "QuotaExceededError",
        marker: false,
      });
      await startLeader(page);
      await waitForState(page, "stopped");
      await startGate(page);
      await setOnline(page, false, false);
      await page.evaluate(() => window.__atlasData?.retrySync());
      await waiting(page, "offline");
      expect(await gate(page)).toBe("refreshing");
      expect(await holds(page)).toEqual([OPERATION]);
      // The fault is gone and the browser is back: the cycle the retry lifted goes on and writes what the engine retained.
      await disarm(page);
      await setOnline(page, true);
      await landed(page);
      expect(await sync(page)).toMatchObject({
        cache_status: "invalid",
        local_write_streaks: {},
      });
      expect(await markers(page)).toEqual([]);
      expect(await holds(page)).toEqual([]);
      expect(await gate(page)).toBe("refreshing");
      expect(net.requests).toHaveLength(1);
      recordEvidence(info, `hold-retry-then-back-${fault}-${record}`, {
        requests: net.requests.length,
      });
    });

  test("the control: a successful write needs no hold, no marker and no stop, and the gate is hidden by the database", async ({
    context,
  }, info) => {
    const net = await stubNetwork(context);
    net.script.push(gone);
    await seedSettled(context);
    const page = await bootSession(context);
    await startLeader(page);
    await waitForState(page, "stopped");
    await startGate(page);
    expect(await state(page)).toEqual({
      kind: "stopped",
      cause: "no_recovery",
    });
    expect(await sync(page)).toMatchObject({
      cache_status: "invalid",
      local_write_streaks: {},
    });
    expect(await markers(page)).toEqual([]);
    expect(await holds(page)).toEqual([]);
    expect(await gate(page)).toBe("refreshing");
    expect(net.requests).toHaveLength(1);
    recordEvidence(info, "hold-control", { requests: net.requests.length });
  });
});
