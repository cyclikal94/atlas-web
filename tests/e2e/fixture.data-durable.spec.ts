import type { Page } from "@playwright/test";
import { recordEvidence } from "./data-evidence";
import { dataPage } from "./data-sync-helpers";
import { expect, test } from "./helpers";

/**
 * E-O14 (revision 34, R58 and the R57 timeout): a failure is durable in the step that records it, in a real engine, with REAL Web Locks.
 *
 * The independent review of revision 33 showed (in three engines, with the production marker and stop helpers and an actual acquired
 * lock whose delivery was held) that a failure which waited for its slot was published when the lock was delivered, after the person had
 * recovered the operation. The author's bounded diagnostic of the same revision then showed that the same wait is why a stop recorded by a
 * page that is closed at once (the invalidator of the reviewer's native-sync probe) leaves NO marker: the service is disposed before the lock
 * arrives, the publication is obsolete, and the page that should have concealed the cache never does (`readiness timeout`). Both are one
 * cause, a durable record that depends on a lock's arrival, and one correction: the key is written in the step that records the failure.
 *
 * The lab (`window.__atlasDurableLab`) composes the PRODUCTION markers and stop helpers over the page's real `localStorage` and real Web
 * Locks, and holds the DELIVERY of a granted lock (the lock is requested and granted by the browser; the markers learn of it when the spec
 * says). Cases (each in three engines):
 *
 *   P1. A failure is durable while the lock is held back; an entitled recovery, delivered before or after the lock, leaves nothing standing,
 *       nothing listed and nothing for a page that loads afterwards (the review's schedule, with the control that does NOT recover).
 *   P2. A newer failure of the same operation is not reached by the recovery of the older one, however the lock is delivered.
 *   P3. A stop recorded by a page whose service is disposed at once (before the lock is delivered) is a marker that another page reads.
 *
 * FIXTURE evidence for these engines on this machine: real storage and locks, an injected hold of one delivery; not a frozen page.
 */
const SCOPE = {
  account: "00000000-0000-4000-8000-0000000000bb",
  incarnationId: "native-durable",
};
type Counts = { requested: number; acquired: number; held: number };
const counts = (page: Page, name: string): Promise<Counts | undefined> =>
  page.evaluate((n) => window.__atlasDurableLab?.counts(n), name);
const heldLock = async (page: Page, name: string): Promise<void> => {
  // The browser granted the lock and the markers have not been told: the schedule the review held.
  await expect
    .poll(async () => (await counts(page, name))?.held, { timeout: 15_000 })
    .toBe(1);
};
const raw = (page: Page) =>
  page.evaluate((s) => window.__atlasDurableLab?.raw(s) ?? null, SCOPE);

test.describe("E-O14 (revision 34, R58): a failure is durable in the step that records it, whatever the lock does", () => {
  for (const recovery of ["before", "after"] as const)
    test(`P1: recovered with the lock delivered ${recovery} the recovery: nothing stands, nothing is listed, a page that loads afterwards finds nothing`, async ({
      context,
    }, info) => {
      const page = await dataPage(context);
      await page.evaluate(() =>
        window.__atlasDurableLab?.create("w", {
          id: "writer",
          onlySlot: 3,
          holdDelivery: true,
        }),
      );
      const recorded = await page.evaluate(
        (s) => window.__atlasDurableLab?.recordStop("w", s, "draft:a"),
        SCOPE,
      );
      expect(recorded).toBe("marker");
      await heldLock(page, "w");
      // Durable now: the key stands while the lock is held back, and the page holds no memory stop for it.
      const during = await raw(page);
      expect(during?.failures).toHaveLength(1);
      expect(during?.directories).toEqual([]);
      expect(
        await page.evaluate(
          (s) => window.__atlasDurableLab?.memoryHeld("w", s, "draft:a"),
          SCOPE,
        ),
      ).toBe(false);
      if (recovery === "before")
        await page.evaluate(() => window.__atlasDurableLab?.deliver("w"));
      const seen = await page.evaluate(
        (s) => window.__atlasDurableLab?.witness("w", s, "draft:a"),
        SCOPE,
      );
      expect(seen).toBe("instance");
      expect(
        await page.evaluate(
          (s) => window.__atlasDurableLab?.retire("w", s, "draft:a"),
          SCOPE,
        ),
      ).toEqual(["draft:a"]);
      if (recovery === "after")
        await page.evaluate(() => window.__atlasDurableLab?.deliver("w"));
      await page.evaluate(() => window.__atlasDurableLab?.prepare("w"));
      const after = await raw(page);
      expect(after?.failures).toEqual([]);
      if (recovery === "after") expect(after?.directories).toEqual([]);
      // A page that loads afterwards reads nothing standing.
      const reader = await dataPage(context);
      const read = await reader.evaluate((s) => {
        const lab = window.__atlasDurableLab;
        if (!lab) throw new Error("no lab");
        lab.create("reader", { noLocks: true });
        return {
          probe: lab.probe("reader", s, "draft:a"),
          inspect: lab.inspect("reader", s),
        };
      }, SCOPE);
      expect(read.probe).toBe("unmarked");
      expect(read.inspect).toEqual({ operations: [], known: true });
      recordEvidence(info, "p1", { recovery, during, after, read });
    });

  test("P1 control: a failure that is NOT recovered still stands after the lock is delivered, and a page that loads afterwards finds it", async ({
    context,
  }) => {
    const page = await dataPage(context);
    await page.evaluate(() =>
      window.__atlasDurableLab?.create("w", {
        id: "writer",
        onlySlot: 4,
        holdDelivery: true,
      }),
    );
    await page.evaluate(
      (s) => window.__atlasDurableLab?.recordStop("w", s, "draft:a"),
      SCOPE,
    );
    await heldLock(page, "w");
    await page.evaluate(() => window.__atlasDurableLab?.deliver("w"));
    await page.evaluate(() => window.__atlasDurableLab?.prepare("w"));
    const reader = await dataPage(context);
    await reader.evaluate(() =>
      window.__atlasDurableLab?.create("reader", { noLocks: true }),
    );
    await expect
      .poll(
        () =>
          reader.evaluate(
            (s) => window.__atlasDurableLab?.probe("reader", s, "draft:a"),
            SCOPE,
          ),
        { timeout: 15_000 },
      )
      .toBe("marked");
    // The slot arrived: the failure is listed.
    expect((await raw(page))?.directories).toHaveLength(1);
  });

  test("P2: a newer failure of the same operation is not reached by the recovery of the older one, however the lock is delivered", async ({
    context,
  }) => {
    const page = await dataPage(context);
    await page.evaluate(() =>
      window.__atlasDurableLab?.create("w", {
        id: "writer",
        onlySlot: 5,
        holdDelivery: true,
      }),
    );
    await page.evaluate(
      (s) => window.__atlasDurableLab?.recordStop("w", s, "draft:a"),
      SCOPE,
    );
    await heldLock(page, "w");
    await page.evaluate(
      (s) => window.__atlasDurableLab?.witness("w", s, "draft:a"),
      SCOPE,
    );
    // A newer failure: a key of its own (the older one, this page's, is replaced by it).
    await page.evaluate(
      (s) => window.__atlasDurableLab?.recordStop("w", s, "draft:a"),
      SCOPE,
    );
    await page.evaluate(
      (s) => window.__atlasDurableLab?.retire("w", s, "draft:a"),
      SCOPE,
    );
    await page.evaluate(() => window.__atlasDurableLab?.deliver("w"));
    await page.evaluate(() => window.__atlasDurableLab?.prepare("w"));
    expect(
      await page.evaluate(
        (s) => window.__atlasDurableLab?.probe("w", s, "draft:a"),
        SCOPE,
      ),
    ).toBe("marked");
    expect((await raw(page))?.failures).toHaveLength(1);
  });

  test("P3 (the R57 timeout, product side): a stop recorded by a page that is disposed before the lock is delivered is a marker another page reads", async ({
    context,
  }, info) => {
    const writer = await dataPage(context);
    await writer.evaluate(() =>
      window.__atlasDurableLab?.create("invalidator", {
        id: "invalidator",
        onlySlot: 6,
        holdDelivery: true,
      }),
    );
    // The stop is recorded while the service is live; the lock has been requested and granted and its delivery is held.
    expect(
      await writer.evaluate(
        (s) =>
          window.__atlasDurableLab?.recordStop(
            "invalidator",
            s,
            "invalidate:cursor-0",
            true,
          ),
        SCOPE,
      ),
    ).toBe("marker");
    await heldLock(writer, "invalidator");
    // The service is disposed at once, and the lock is delivered after it (revision 33: the publication was obsolete, no marker).
    await writer.evaluate(() => {
      window.__atlasDurableLab?.release("invalidator");
      window.__atlasDurableLab?.deliver("invalidator");
    });
    const follower = await dataPage(context);
    await follower.evaluate(() =>
      window.__atlasDurableLab?.create("follower", { noLocks: true }),
    );
    await expect
      .poll(
        () =>
          follower.evaluate(
            (s) =>
              window.__atlasDurableLab?.probe(
                "follower",
                s,
                "invalidate:cursor-0",
              ),
            SCOPE,
          ),
        { timeout: 15_000 },
      )
      .toBe("marked");
    recordEvidence(info, "p3", await raw(follower));
  });
});
