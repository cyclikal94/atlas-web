import type { BrowserContext, Page } from "@playwright/test";
import { expect, test } from "./helpers";

/**
 * S-IDB, S-LOCK and S-HINT (plan 13.5): the PRODUCTION adapters (raw IndexedDB store, Web Locks, BroadcastChannel hints) in
 * a real engine, through the fixture-only session harness with `?boot=off` (no session running, no backend). Two pages of
 * one browser context are two tabs of one origin. FIXTURE evidence: it shows the adapters do what the fake platform claims in
 * this engine. It is not integration evidence, and it says nothing about real Safari, freeze or bfcache (WEB-08c).
 */
type Records = {
  auth_state: { latest_epoch: number };
  boot: unknown;
  device: unknown;
};
declare global {
  interface Window {
    __t: Record<string, unknown>;
  }
}

async function openPage(context: BrowserContext): Promise<Page> {
  const page = await context.newPage();
  await page.goto("/__session?boot=off");
  await page.waitForFunction(
    () => window.__atlasFixture?.session !== undefined,
  );
  await page.evaluate(() => {
    window.__t = {};
  });
  return page;
}

test.describe("S-IDB: the atlas-auth store", () => {
  test("a write in one page is seen by a transaction created later in another", async ({
    context,
  }) => {
    const a = await openPage(context);
    const b = await openPage(context);
    await a.evaluate(async () => {
      const store = await window.__atlasFixture?.session?.openStore();
      if (!store) throw new Error("no harness");
      await store.transact(
        () => ({
          write: { boot: { last_boot_at: "written-by-a" } },
          result: null,
        }),
        { durability: "strict", label: "a" },
      ).complete;
    });
    const seen = await b.evaluate(async () => {
      const store = await window.__atlasFixture?.session?.openStore();
      if (!store) throw new Error("no harness");
      return store.transact((r) => ({ write: null, result: r.boot })).complete;
    });
    expect(seen).toEqual({ last_boot_at: "written-by-a" });
  });

  test("overlapping read-modify-write transactions from two pages never lose an update", async ({
    context,
  }) => {
    const a = await openPage(context);
    const b = await openPage(context);
    const increment = () =>
      // 25 transactions created back to back in this page, each reading the counter and writing it plus one.
      window.__atlasFixture?.session?.openStore().then((store) =>
        Promise.all(
          Array.from(
            { length: 25 },
            () =>
              store.transact((r) => ({
                write: {
                  auth_state: {
                    ...r.auth_state,
                    latest_epoch: r.auth_state.latest_epoch + 1,
                  },
                },
                result: null,
              })).complete,
          ),
        ),
      );
    await Promise.all([a.evaluate(increment), b.evaluate(increment)]);
    const total = await a.evaluate(async () => {
      const store = await window.__atlasFixture?.session?.openStore();
      return store?.transact((r) => ({
        write: null,
        result: r.auth_state.latest_epoch,
      })).complete;
    });
    expect(total).toBe(50);
  });

  test("an aborted transaction reverts atomically: an earlier write in the same transaction does not survive", async ({
    context,
  }) => {
    const page = await openPage(context);
    const outcome = await page.evaluate(async () => {
      const store = await window.__atlasFixture?.session?.openStore();
      if (!store) throw new Error("no harness");
      let error = "none";
      try {
        await store.transact(() => ({
          // `device` is written first; `boot` cannot be cloned, so its put throws inside the transaction.
          write: {
            device: { device_id: "d1", created_at: "x" },
            boot: { last_boot_at: () => 1 },
          } as never,
          result: null,
        })).complete;
      } catch (caught) {
        error = (caught as Error).name;
      }
      const after = await store.transact((r) => ({
        write: null,
        result: r.device,
      })).complete;
      return { error, device: after };
    });
    expect(outcome.error).not.toBe("none");
    expect(outcome.device).toBeNull();
  });

  test("a body that throws commits nothing, and the throw is reported to the caller", async ({
    context,
  }) => {
    const page = await openPage(context);
    const outcome = await page.evaluate(async () => {
      const store = await window.__atlasFixture?.session?.openStore();
      if (!store) throw new Error("no harness");
      let message = "none";
      try {
        await store.transact(() => {
          throw new Error("a defect in a reducer");
        }).complete;
      } catch (caught) {
        message = (caught as Error).message;
      }
      return {
        message,
        boot: await store.transact((r) => ({ write: null, result: r.boot }))
          .complete,
      };
    });
    expect(outcome).toEqual({ message: "a defect in a reducer", boot: null });
  });

  test("a stored auth_state that is present but malformed fails closed and is never overwritten", async ({
    context,
  }) => {
    const page = await openPage(context);
    const outcome = await page.evaluate(async () => {
      const store = await window.__atlasFixture?.session?.openStore();
      if (!store) throw new Error("no harness");
      // Put a malformed record with a raw connection, as a corrupted profile or a future schema would leave it.
      await new Promise<void>((resolve, reject) => {
        const open = indexedDB.open("atlas-auth");
        open.onsuccess = () => {
          const tx = open.result.transaction("records", "readwrite");
          tx.objectStore("records").put({ schema: 99 }, "auth_state");
          tx.oncomplete = () => {
            open.result.close();
            resolve();
          };
          tx.onerror = () => reject(tx.error);
        };
      });
      let cause = "none";
      try {
        await store.transact(() => ({
          write: { boot: { last_boot_at: "x" } },
          result: null,
        })).complete;
      } catch (caught) {
        cause = (caught as { cause?: string }).cause ?? (caught as Error).name;
      }
      const raw = await new Promise<unknown>((resolve) => {
        const open = indexedDB.open("atlas-auth");
        open.onsuccess = () => {
          const get = open.result
            .transaction("records")
            .objectStore("records")
            .getAll();
          get.onsuccess = () => {
            open.result.close();
            resolve(get.result);
          };
        };
      });
      return { cause, raw };
    });
    expect(outcome.cause).toBe("corrupt");
    // Nothing was written by the failed transaction, and the malformed record is exactly as it was left.
    expect(outcome.raw).toEqual([{ schema: 99 }]);
  });

  test("versionchange: an upgrade elsewhere is never blocked by this page; the store then reports closed", async ({
    context,
  }) => {
    const page = await openPage(context);
    const outcome = await page.evaluate(async () => {
      const store = await window.__atlasFixture?.session?.openStore();
      if (!store) throw new Error("no harness");
      const upgraded = await new Promise<string>((resolve) => {
        const open = indexedDB.open("atlas-auth", 2);
        open.onupgradeneeded = () => undefined;
        open.onblocked = () => resolve("blocked");
        open.onsuccess = () => {
          open.result.close();
          resolve("upgraded");
        };
        open.onerror = () => resolve("error");
      });
      let cause = "none";
      try {
        await store.transact((r) => ({ write: null, result: r.boot })).complete;
      } catch (caught) {
        cause = (caught as { cause?: string }).cause ?? (caught as Error).name;
      }
      return { upgraded, cause };
    });
    // `blocked` may fire first while the old connection closes; the upgrade must still complete.
    expect(outcome.upgraded).toBe("upgraded");
    expect(outcome.cause).toBe("closed");
  });

  test("the boot canary writes boot.last_boot_at and nothing else", async ({
    context,
  }) => {
    const page = await openPage(context);
    const outcome = await page.evaluate(async () => {
      const harness = window.__atlasFixture?.session;
      if (!harness) throw new Error("no harness");
      const store = await harness.openStore();
      const ok = await harness.canary(store);
      return { ok, records: await harness.readRecords() };
    });
    expect(outcome.ok).toBe(true);
    expect((outcome.records as Records).boot).toMatchObject({
      last_boot_at: expect.stringMatching(/^\d{4}-\d\d-\d\dT/),
    });
    expect((outcome.records as Records).auth_state.latest_epoch).toBe(0);
    expect((outcome.records as Records).device).toBeNull();
  });
});

test.describe("S-LOCK: Web Locks as the protocol uses them", () => {
  test("a grant comes only after the holder's release; try and probe see it held; wait resolves after", async ({
    context,
  }) => {
    const a = await openPage(context);
    const b = await openPage(context);
    await a.evaluate(async () => {
      window.__t.handle =
        await window.__atlasFixture?.session?.locks.acquire("atlas-test-1");
    });
    const whileHeld = await b.evaluate(async () => {
      const locks = window.__atlasFixture?.session?.locks;
      if (!locks) throw new Error("no harness");
      return {
        probe: await locks.probe("atlas-test-1"),
        tried: (await locks.tryAcquire("atlas-test-1")) === null,
      };
    });
    expect(whileHeld).toEqual({ probe: false, tried: true });
    // B requests it; it must stay pending until A releases.
    await b.evaluate(() => {
      window.__t.granted = false;
      window.__t.pending = window.__atlasFixture?.session?.locks
        .acquire("atlas-test-1")
        .then((h) => {
          window.__t.granted = true;
          return h;
        });
    });
    await b.waitForTimeout(150);
    expect(await b.evaluate(() => window.__t.granted)).toBe(false);
    await a.evaluate(() =>
      (window.__t.handle as { release(): void }).release(),
    );
    await b.waitForFunction(() => window.__t.granted === true);
    await b.evaluate(async () => {
      (await (window.__t.pending as Promise<{ release(): void }>)).release();
    });
    // `probe` is true only once the release has been published to this page; false proves nothing, so poll for the true.
    await expect
      .poll(() =>
        b.evaluate(() =>
          window.__atlasFixture?.session?.locks.probe("atlas-test-1"),
        ),
      )
      .toBe(true);
  });

  test("requests are granted first-in, first-out per name", async ({
    context,
  }) => {
    const holder = await openPage(context);
    const second = await openPage(context);
    const third = await openPage(context);
    await holder.evaluate(async () => {
      window.__t.handle =
        await window.__atlasFixture?.session?.locks.acquire("atlas-test-fifo");
    });
    // The label is passed as an argument: a closure variable of the test is not visible inside the page.
    const request = (label: string) => {
      window.__t.order = [];
      window.__atlasFixture?.session?.locks
        .acquire("atlas-test-fifo")
        .then((h) => {
          (window.__t.order as string[]).push(label);
          window.__t.mine = h;
        });
    };
    await second.evaluate(request, "second");
    await second.waitForTimeout(80);
    await third.evaluate(request, "third");
    await third.waitForTimeout(80);
    await holder.evaluate(() =>
      (window.__t.handle as { release(): void }).release(),
    );
    await second.waitForFunction(
      () => (window.__t.order as string[]).length === 1,
    );
    // The third is still waiting until the second releases.
    expect(
      await third.evaluate(() => (window.__t.order as string[]).length),
    ).toBe(0);
    await second.evaluate(() =>
      (window.__t.mine as { release(): void }).release(),
    );
    await third.waitForFunction(
      () => (window.__t.order as string[]).length === 1,
    );
  });

  test("closing the holding page releases its lock", async ({ context }) => {
    const holder = await openPage(context);
    const waiter = await openPage(context);
    await holder.evaluate(async () => {
      window.__t.handle =
        await window.__atlasFixture?.session?.locks.acquire("atlas-test-close");
    });
    await waiter.evaluate(() => {
      window.__t.granted = false;
      window.__atlasFixture?.session?.locks
        .acquire("atlas-test-close")
        .then(() => {
          window.__t.granted = true;
        });
    });
    await waiter.waitForTimeout(100);
    expect(await waiter.evaluate(() => window.__t.granted)).toBe(false);
    await holder.close();
    await waiter.waitForFunction(() => window.__t.granted === true);
  });

  test("a request aborted before its grant resolves null and does not hold the lock afterwards", async ({
    context,
  }) => {
    const holder = await openPage(context);
    const waiter = await openPage(context);
    await holder.evaluate(async () => {
      window.__t.handle =
        await window.__atlasFixture?.session?.locks.acquire("atlas-test-abort");
    });
    const aborted = await waiter.evaluate(async () => {
      const controller = new AbortController();
      const request = window.__atlasFixture?.session?.locks.acquire(
        "atlas-test-abort",
        { signal: controller.signal },
      );
      controller.abort();
      return (await request) === null;
    });
    expect(aborted).toBe(true);
    await holder.evaluate(() =>
      (window.__t.handle as { release(): void }).release(),
    );
    // Nobody holds it: a fresh try is granted at once.
    const fresh = await waiter.evaluate(async () => {
      const handle =
        await window.__atlasFixture?.session?.locks.tryAcquire(
          "atlas-test-abort",
        );
      handle?.release();
      return handle !== null;
    });
    expect(fresh).toBe(true);
  });

  test("navigator.locks.query is never called by the adapter, and steal is never used", async ({
    context,
  }) => {
    const page = await openPage(context);
    const used = await page.evaluate(async () => {
      const calls: string[] = [];
      const locks = navigator.locks as LockManager & {
        query: () => Promise<unknown>;
      };
      const originalRequest = locks.request.bind(locks);
      locks.query = async () => {
        calls.push("query");
        return {};
      };
      (locks as unknown as { request: unknown }).request = (
        ...args: unknown[]
      ) => {
        const options = args.find((a) => typeof a === "object" && a !== null) as
          | { steal?: boolean }
          | undefined;
        if (options?.steal) calls.push("steal");
        return (originalRequest as (...a: unknown[]) => Promise<unknown>)(
          ...args,
        );
      };
      const port = window.__atlasFixture?.session?.locks;
      if (!port) throw new Error("no harness");
      const handle = await port.acquire("atlas-test-noquery");
      await port.probe("atlas-test-noquery");
      handle?.release();
      await port.wait("atlas-test-noquery");
      await port.tryAcquire("atlas-test-noquery").then((h) => h?.release());
      return calls;
    });
    expect(used).toEqual([]);
  });
});

test.describe("S-HINT: BroadcastChannel hints", () => {
  test("a hint reaches another page of the same origin, not the sender, and a malformed message is ignored", async ({
    context,
  }) => {
    const sender = await openPage(context);
    const receiver = await openPage(context);
    await receiver.evaluate(() => {
      window.__t.got = [];
      const hints = window.__atlasFixture?.session?.hints();
      if (!hints) throw new Error("no harness");
      window.__t.channel = hints;
      hints.subscribe((hint) => (window.__t.got as unknown[]).push(hint));
    });
    await sender.evaluate(() => {
      window.__t.got = [];
      const hints = window.__atlasFixture?.session?.hints();
      if (!hints) throw new Error("no harness");
      window.__t.channel = hints;
      hints.subscribe((hint) => (window.__t.got as unknown[]).push(hint));
      hints.post({ type: "auth_state_changed" });
      // A raw message that is not a hint is not delivered to listeners.
      new BroadcastChannel("atlas-auth-hints").postMessage({
        type: "not-a-hint",
      });
      new BroadcastChannel("atlas-auth-hints").postMessage("garbage");
      hints.post({ type: "lease", lease_id: "l1", account_id: "A" });
    });
    await receiver.waitForFunction(
      () => (window.__t.got as unknown[]).length >= 2,
    );
    expect(await receiver.evaluate(() => window.__t.got)).toEqual([
      { type: "auth_state_changed" },
      { type: "lease", lease_id: "l1", account_id: "A" },
    ]);
    await sender.waitForTimeout(100);
    expect(await sender.evaluate(() => window.__t.got)).toEqual([]);
  });
});
