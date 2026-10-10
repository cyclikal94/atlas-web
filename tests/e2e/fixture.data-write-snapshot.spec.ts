import { type BrowserContext, expect, type Page, test } from "@playwright/test";
import { recordEvidence } from "./data-evidence";

/**
 * E-S1 (R39) and E-S2 (R40, revision 22), in Chromium, Firefox and WebKit: A SAVE STORES WHAT IT WAS ADMITTED AND DIGESTED AT. FIXTURE
 * evidence: the production outbox, quota guard, runtime and Dexie adapter over REAL IndexedDB (`src/fixture/data-harness/write-snapshot.ts`),
 * with a caller that edits the graph its `build` returned, or its request, at a named instant. The free space is an injected estimate and the
 * wrapper of the native `put` observes and queues (it fails nothing and delays nothing): this is not genuine quota exhaustion, not a device
 * and not real Safari.
 *
 * R39. The review edited the caller's graph in the turn the native put of the `drafts` header returned, before the body's put was called:
 * every public write path (`enqueue`, `editQueued`, `supersede`) answered success with a 4,996-byte reservation while the stored command was
 * the 900,000-character later edit, its digest was another command's and 904,978 bytes were written. Here the same schedule runs with the
 * graph handed over as the caller's own object and as a fresh root over a nested value the caller still holds (the two affected
 * shapes), with a deep copy as the control. The CONTROL THAT THE INJECTION IS REAL IN THIS ENGINE is a hand-made plan that writes a graph
 * the caller still owns by reference: the engine stores the later edit, and a header edited as the put returns is not changed (a clone is
 * made at the call). Growth that lands BEFORE the plan reads the graph is the save and is admitted at its real size, or refused as quota
 * with everything stored untouched; a request edited while the reservation is awaited stores what was validated.
 *
 * R40. The review superseded a conflict with the empty-list command and then, under the same local id, with a one-hole list: the second,
 * different command answered `superseded` as the previous save, and a direct enqueue stored a command whose digest was not that of its wire
 * form. A sparse list is now refused at the boundary (a TypeError, as `undefined` is); the genuine same save is still recognised and a dense
 * `[null]` is still a different save.
 */
const LATER = 900_000;
const TIGHT = 100_000;
const ROOMY = 2 * 1024 * 1024;
const PATHS = ["enqueue", "edit", "supersede"] as const;
const SUCCESS = { enqueue: "queued", edit: "edited", supersede: "superseded" };

/** A page with the write-snapshot harness. */
async function snapshotPage(context: BrowserContext): Promise<Page> {
  const page = await context.newPage();
  await page.goto("/__data");
  await page.waitForFunction(() => window.__atlasWriteSnapshot !== undefined);
  return page;
}

type WritePath = (typeof PATHS)[number];
type Shape = "direct" | "fresh-root" | "deep-copy";
type Schedule = "after-header" | "before-plan";

const write = (
  page: Page,
  path: WritePath,
  shape: Shape,
  schedule: Schedule,
  room: number,
) =>
  page.evaluate(
    ([p, s, when, r]) => {
      const h = window.__atlasWriteSnapshot;
      if (!h) throw new Error("no write-snapshot harness");
      return h.write(p, s, when, r);
    },
    [path, shape, schedule, room] as const,
  );

test.describe("E-S1 (R39): what is admitted is what is digested is what is stored (real IndexedDB, the real adapter)", () => {
  for (const path of PATHS)
    for (const shape of ["direct", "fresh-root", "deep-copy"] as const) {
      const label =
        shape === "direct"
          ? "build returns the caller's own object (affected)"
          : shape === "fresh-root"
            ? "build returns a fresh root over a nested value the caller still holds (affected)"
            : "build returns a deep copy (control)";
      test(`R39: ${path}, ${label}, edited when the header's native put returns: the body is the one that was digested and admitted`, async ({
        context,
      }, info) => {
        const page = await snapshotPage(context);
        const result = await write(page, path, shape, "after-header", TIGHT);
        recordEvidence(info, `r39-${path}-${shape}`, result);
        // The schedule happened: the native put returned, the edit ran, and the caller's graph IS the later edit...
        expect(result.observed).toBe(true);
        expect(result.mutated).toBe(true);
        expect(result.callerTextLength).toBe(LATER);
        // ...against a tight admission (100,000 bytes of room: what was reserved is a few kilobytes, far below the later edit)
        expect(Math.max(...result.reserved)).toBeLessThan(10_000);
        expect(result.outcome).toMatchObject({ kind: SUCCESS[path] });
        // What the engine stored is what was built, what its digest says, and what the guard admitted.
        expect(result.storedTextLength).toBe("small".length);
        expect(result.storedLabel).toBe("original");
        expect(result.digestMatches).toBe(true);
        expect(result.actualBytes).not.toBeNull();
        expect(result.actualBytes as number).toBeLessThanOrEqual(
          Math.max(...result.reserved),
        );
        expect(result.latch).toBe("open");
        await page.close();
      });
    }

  test("control: the injection is real in this engine: a plan that writes a graph the caller still owns, by reference, stores the later edit, and a header edited as the put returns is stored as it was cloned", async ({
    context,
  }, info) => {
    const page = await snapshotPage(context);
    const result = await page.evaluate(() => {
      const h = window.__atlasWriteSnapshot;
      if (!h) throw new Error("no write-snapshot harness");
      return h.interval();
    });
    recordEvidence(info, "r39-interval-control", result);
    expect(result.observed).toBe(true);
    // the interval exists between the two native puts of one transaction...
    expect(result.storedTextLength).toBe("later edit".length);
    // ...and a put clones its row when it is called
    expect(result.storedHeaderEndpoint).toBe("/commands");
    await page.close();
  });

  for (const path of PATHS) {
    test(`R39: ${path}, the caller's graph grows BEFORE the plan reads it, with room for input of ${TIGHT} bytes only: refused as quota and everything stored is untouched`, async ({
      context,
    }, info) => {
      const page = await snapshotPage(context);
      const result = await write(page, path, "direct", "before-plan", TIGHT);
      recordEvidence(info, `r39-${path}-grown-tight`, result);
      expect(result.observed).toBe(true);
      expect(result.outcome).toEqual({ kind: "refused", reason: "quota" });
      expect(result.untouched).toBe(true);
      await page.close();
    });

    test(`R39: ${path}, the caller's graph grows BEFORE the plan reads it, with room for it: that is the save, admitted at its real size and stored whole`, async ({
      context,
    }, info) => {
      const page = await snapshotPage(context);
      const result = await write(page, path, "direct", "before-plan", ROOMY);
      recordEvidence(info, `r39-${path}-grown-roomy`, result);
      expect(result.observed).toBe(true);
      expect(result.outcome).toMatchObject({ kind: SUCCESS[path] });
      expect(result.storedTextLength).toBe(LATER);
      expect(result.digestMatches).toBe(true);
      // admitted a second time at its real size, and the write is within it
      expect(result.reserved.length).toBeGreaterThanOrEqual(2);
      expect(result.actualBytes as number).toBeLessThanOrEqual(
        Math.max(...result.reserved),
      );
      await page.close();
    });

    test(`R39: ${path}, the request is edited while the quota reservation is awaited: what was validated is what is stored`, async ({
      context,
    }, info) => {
      const page = await snapshotPage(context);
      const result = await page.evaluate((p) => {
        const h = window.__atlasWriteSnapshot;
        if (!h) throw new Error("no write-snapshot harness");
        return h.request(p);
      }, path);
      recordEvidence(info, `r39-${path}-request`, result);
      expect(result.outcome).toMatchObject({ kind: SUCCESS[path] });
      expect(result.storedEndpoint).toBe("/commands");
      if (path === "enqueue")
        expect(result.storedTargets).toEqual([
          "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        ]);
      await page.close();
    });
  }
});

test.describe("E-S2 (R40): a sparse list has one policy (refusal) and a genuine retry is still recognised (real IndexedDB)", () => {
  const sparse = (page: Page, mode: "same" | "dense" | "sparse") =>
    page.evaluate((m) => {
      const h = window.__atlasWriteSnapshot;
      if (!h) throw new Error("no write-snapshot harness");
      return h.sparse(m);
    }, mode);

  test("control: the same save under the same local id is recognised as that save, and a direct enqueue of it stores a command whose digest is its wire form's", async ({
    context,
  }, info) => {
    const page = await snapshotPage(context);
    const result = await sparse(page, "same");
    recordEvidence(info, "r40-same", result);
    expect(result.first).toMatchObject({ kind: "superseded" });
    expect(result.next).toMatchObject({ kind: "superseded" });
    expect(result.direct).toMatchObject({ outcome: { kind: "queued" } });
    expect(result.storedDigestMatchesWire).toBe(true);
    await page.close();
  });

  test("control: a dense `[null]` is a different save (not recognised as the previous one), and what is stored matches its wire form", async ({
    context,
  }, info) => {
    const page = await snapshotPage(context);
    const result = await sparse(page, "dense");
    recordEvidence(info, "r40-dense", result);
    expect(result.first).toMatchObject({ kind: "superseded" });
    expect(result.next).toEqual({ kind: "refused", reason: "not_found" });
    expect(result.direct).toMatchObject({ outcome: { kind: "queued" } });
    expect(result.storedLength).toBe(1);
    expect(result.storedHasElement).toBe(true);
    expect(result.storedDigestMatchesWire).toBe(true);
    await page.close();
  });

  test("R40: a one-hole list under the same local id is NOT the previous save, and a direct enqueue of it is refused and stores nothing", async ({
    context,
  }, info) => {
    const page = await snapshotPage(context);
    const result = await sparse(page, "sparse");
    recordEvidence(info, "r40-sparse", result);
    expect(result.first).toMatchObject({ kind: "superseded" });
    expect(result.next).toEqual({ kind: "refused", reason: "not_found" });
    expect(result.direct).toEqual({ threw: "TypeError" });
    expect(result.storedLength).toBeNull();
    // the premise: the hole is what the empty list's digest used to hide
    expect(result.json).toBe('{"kind":"create","items":[null]}');
    expect(result.digestChanged).toBeNull();
    await page.close();
  });
});
