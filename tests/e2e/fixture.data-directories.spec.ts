import type { BrowserContext, Page } from "@playwright/test";
import {
  classify,
  report as collect,
  describe as describeVerdicts,
  runLoop,
} from "./d5-collector";
import { recordEvidence } from "./data-evidence";
import { dataPage } from "./data-sync-helpers";
import { expect, test } from "./helpers";

/**
 * E-O13 (revisions 33 and 34, R55): whether a failure stands is read from TWO WITNESSES, the directories' FIXED ADDRESSES and the listing of
 * the origin's keys, in a real engine, with real `localStorage`, real Web Locks and real pages. REVISION 34 ADAPTATIONS are labelled
 * where they are made: D1 no longer expects that the origin's keys are never listed (the listing is the second witness) and asserts that
 * the walks are never disturbed by a second page that churns the keys as fast as it can; D6 and D7 are new.
 *
 * Revision 34 (D6, D7): the review of revision 33 found, with two real pages, that a directory rewritten by the next owner of its slot
 * loses entries (WebKit: 25 of 200 failures undiscovered), because a Web Lock does not make the previous owner's last writes visible.
 * D6 repeats that schedule (two live pages take and let go of ONE slot in turn, publishing unique failures; a third page compares what the
 * production reads find with the raw keys), D7 is a page that holds no slot at all.
 *
 * Original text of revision 33:
 *
 * The independent review of revision 32 showed over a model of `Storage` that a listing made while an unrelated key is removed and another
 * added can return a store of the same length that omits a marker that stood throughout, and that the marker module took the omission for
 * absence. The installed engines did not reproduce the omission natively (36 cases kept the marker); the HTML standard still leaves the order
 * of `Storage.key` to the implementation and promises no locking across agents, so the contract does not rest on that. A page that publishes
 * a failure now owns ONE directory slot (a Web Lock it holds for its life) and writes the failures it publishes in that slot's directory,
 * which no other page writes; a reader reads the 32 fixed addresses and the key of each failure they list, and never lists the origin's keys.
 *
 * Cases:
 *   D1. Churn: while another real page removes and adds unrelated keys in a tight loop, a cold real page reads a marker that stands
 *       throughout thousands of times (`probe`, `witness`, `inspect`) and never misses it; the page's `Storage.key` and `Storage.length` are
 *       spied and are never used. The same page also runs the revision-32 style listing under the same churn as a labelled MEASUREMENT (no
 *       expectation: the engines did not reproduce the omission before, and a count of zero says nothing about the contract).
 *   D2. Slots: every page that prepares holds a different slot lock (`ifAvailable` probes only, no `query`), and a closed page frees its slot.
 *   D3. Cross-page publication and exact retirement: a failure a page publishes is found by a cold page, ended by that page by its exact key, and
 *       the first page sees it end; a second page's failure of the same operation is its own and stands.
 *   D4. Takeover: a page closes holding slot N with a failure published; a new page takes slot N (the start is fixed by an init script,
 *       FIXTURE only), inherits what the directory lists, publishes its own failure, and a cold reader finds both; the new owner ends the
 *       inherited one by its exact key.
 *   D5. A MEASUREMENT of the assumption the design rejected: a Web-Locks-serialised read-modify-write of one `localStorage` record across
 *       three pages, against an unlocked control. It records how many updates were lost; it expects only that the control can see a loss
 *       (it would otherwise prove nothing). On Firefox and WebKit the locked variant lost updates when measured during this revision, which is
 *       why no record here is ever read-modify-written by more than one page.
 *
 * REVISION 35 ADAPTATIONS (R55, premise P11: the authority of a read is ONE snapshot of the origin's keys, `Object.keys(localStorage)`,
 * and `Storage.key` is never read): D1 counts the snapshots and the index reads separately and asserts that the markers made NO index
 * read; `readWithoutListing` refuses the size as well as `key` (the snapshot reads the size first, as its work bound, so a refused size
 * is a refused listing; refusing `key` alone refuses nothing any more); D9 is new: a cold page finds a failure that NO directory lists,
 * by the snapshot, with `Storage.key` refused, a key named `keys` stored and a second page churning the keys, and a refused size makes
 * the read incomplete. The original bytes of this file are kept in `.agtx/evidence/WEB-09a/revision-35/originals/`.
 *
 * What is NOT claimed: that a page freeze or a slow lock hand-over was observed, or any behaviour of a browser other than the three
 * installed engines. FIXTURE evidence for this engine on this machine.
 */
const SCOPE = {
  account: "00000000-0000-4000-8000-0000000000aa",
  incarnationId: "native-lifetime",
};
const OP = "draft:a";
const OTHER = "draft:b";

type Published = "recorded" | "unavailable" | "obsolete";
const publish = (page: Page, operation: string): Promise<Published> =>
  page.evaluate(
    async ([scope, op]) => {
      const markers = window.__atlasData?.markers;
      if (!markers) throw new Error("no markers");
      const published = markers.set(
        scope as { account: string; incarnationId: string },
        op as string,
      );
      return published.state;
    },
    [SCOPE, operation] as const,
  );
const probe = (page: Page, operation: string) =>
  page.evaluate(
    ([scope, op]) =>
      window.__atlasData?.markers.probe(
        scope as { account: string; incarnationId: string },
        op as string,
      ),
    [SCOPE, operation] as const,
  );
/** The slots whose lock is held by any page right now, found with `ifAvailable` requests only (a held lock is never read with `query`). */
const slotsHeld = (page: Page): Promise<number[]> =>
  page.evaluate(async () => {
    const held: number[] = [];
    for (let slot = 0; slot < 32; slot += 1) {
      const heldElsewhere = await navigator.locks.request(
        `atlas-write-slot:${slot}`,
        { ifAvailable: true },
        (lock) => lock === null,
      );
      if (heldElsewhere) held.push(slot);
    }
    return held;
  });
const rawKeys = (page: Page, prefix: string) =>
  page.evaluate(
    (p) =>
      Object.keys(localStorage)
        .filter((key) => key.startsWith(p))
        .sort(),
    prefix,
  );
const failureKeys = (page: Page, operation: string) =>
  page.evaluate(
    ([scope, op]) => {
      const s = scope as { account: string; incarnationId: string };
      const prefix = `atlas-write-failing:${encodeURIComponent(s.account)}:${encodeURIComponent(s.incarnationId)}:${op}#`;
      return Object.keys(localStorage)
        .filter((key) => key.startsWith(prefix))
        .sort();
    },
    [SCOPE, operation] as const,
  );

/**
 * A read made in `page` with the origin's listing REFUSED (`Storage.key` throws, as an enumeration that has become unreadable does), so
 * that only the directories can name a failure; the listing is restored afterwards. Answers what the markers said (revision 34).
 * ADAPTED, revision 35 (P11): the listing is a snapshot whose size is read first, so the SIZE is refused too (refusing `key` alone
 * would refuse nothing the markers read).
 */
const readWithoutListing = (page: Page, operation: string, other: string) =>
  page.evaluate(
    ([scope, op, unnamed]) => {
      const markers = window.__atlasData?.markers;
      if (!markers) throw new Error("no markers");
      const s = scope as { account: string; incarnationId: string };
      const proto = Storage.prototype as unknown as Record<string, unknown>;
      const key = proto.key;
      proto.key = () => {
        throw new DOMException("refused", "SecurityError");
      };
      const length = Object.getOwnPropertyDescriptor(
        Storage.prototype,
        "length",
      );
      if (length)
        Object.defineProperty(Storage.prototype, "length", {
          ...length,
          get() {
            throw new DOMException("refused", "SecurityError");
          },
        });
      try {
        return {
          probe: markers.probe(s, op as string),
          unnamed: markers.probe(s, unnamed as string),
          witness: markers.witness(s, op as string).kind,
          inspect: markers.inspect(s),
        };
      } finally {
        proto.key = key;
        if (length) Object.defineProperty(Storage.prototype, "length", length);
      }
    },
    [SCOPE, operation, other] as const,
  );

test.describe("E-O13 (revision 33, R55): discovery by fixed addresses, in a real engine", () => {
  test("D1 (adapted, revisions 34 and 35): while another real page churns the origin's unrelated keys, a cold page never misses a marker that stands, and its reads take a snapshot of the origin's keys and never walk them by index", async ({
    context,
  }, info) => {
    const owner = await dataPage(context);
    expect(await publish(owner, OP)).toBe("recorded");
    const churner = await dataPage(context);
    await churner.evaluate(() => {
      const w = window as unknown as { __churn: boolean; __churned: number };
      w.__churn = true;
      w.__churned = 0;
      void (async () => {
        let i = 0;
        while (w.__churn) {
          // A removal and an addition of unrelated keys, as the review's writer does (the count of keys stays the same).
          localStorage.removeItem(`unrelated-${(i + 25) % 50}`);
          localStorage.setItem(`unrelated-${i % 50}`, String(i));
          i += 1;
          w.__churned = i;
          if (i % 100 === 0) await new Promise((r) => setTimeout(r, 0));
        }
      })();
    });
    const reader = await dataPage(context);
    // The first page's write reaches the reader as the browser delivers it (a page's view of another page's write can lag).
    await expect
      .poll(() => probe(reader, OP), { timeout: 15_000 })
      .toBe("marked");
    const result = await reader.evaluate(
      async ([scope, op]) => {
        const markers = window.__atlasData?.markers;
        if (!markers) throw new Error("no markers");
        const s = scope as { account: string; incarnationId: string };
        // The origin's listing is spied. ADAPTED, revision 34: revision 33 required that nothing the markers answer uses it; it is the second
        // witness now, so it is COUNTED, and what is asserted is that no walk was disturbed (`inspect` is `known` every time, and every
        // answer names the marker) while a second real page removed and added keys as fast as it could.
        // ADAPTED, revision 35 (P11): the markers read the size (the work bound) and take ONE snapshot (`Object.keys` of the store)
        // per read, and make NO index read; the three are counted apart.
        let listed = 0;
        let indexed = 0;
        let snapshots = 0;
        const objectKeys = Object.keys;
        Object.keys = ((target: object) => {
          if (target instanceof Storage) snapshots += 1;
          return objectKeys(target);
        }) as typeof Object.keys;
        const proto = Storage.prototype as unknown as Record<string, unknown>;
        const key = proto.key as (...a: unknown[]) => unknown;
        proto.key = function (this: Storage, ...args: unknown[]) {
          indexed += 1;
          return key.apply(this, args);
        };
        const length = Object.getOwnPropertyDescriptor(
          Storage.prototype,
          "length",
        );
        if (length?.get)
          Object.defineProperty(Storage.prototype, "length", {
            ...length,
            get(this: Storage) {
              listed += 1;
              return (length.get as () => number).call(this);
            },
          });
        let misses = 0;
        let reads = 0;
        for (let round = 0; round < 60; round += 1) {
          for (let n = 0; n < 100; n += 1) {
            reads += 1;
            if (markers.probe(s, op as string) !== "marked") misses += 1;
            if (markers.witness(s, op as string).kind !== "instance")
              misses += 1;
            const read = markers.inspect(s);
            if (!read.known || !read.operations.includes(op as string))
              misses += 1;
          }
          // Let the churn and the browser's delivery of it go on between the batches.
          await new Promise((r) => setTimeout(r, 0));
        }
        // The labelled MEASUREMENT: the listing the revision-32 module made, under the same churn. Nothing is expected of its count.
        let listingMisses = 0;
        let listings = 0;
        const target = `atlas-write-failing:${encodeURIComponent(s.account)}:${encodeURIComponent(s.incarnationId)}:${op}#`;
        proto.key = key;
        Object.keys = objectKeys;
        if (length) Object.defineProperty(Storage.prototype, "length", length);
        for (let round = 0; round < 60; round += 1) {
          for (let n = 0; n < 100; n += 1) {
            listings += 1;
            const before = localStorage.length;
            let found = false;
            let whole = true;
            for (let i = 0; i < before; i += 1) {
              const k = localStorage.key(i);
              if (k === null) {
                whole = false;
                break;
              }
              if (k.startsWith(target)) found = true;
            }
            if (whole && localStorage.length === before && !found)
              listingMisses += 1;
          }
          await new Promise((r) => setTimeout(r, 0));
        }
        return {
          reads,
          misses,
          listed,
          indexed,
          snapshots,
          listings,
          listingMisses,
        };
      },
      [SCOPE, OP] as const,
    );
    const churned = await churner.evaluate(() => {
      const w = window as unknown as { __churn: boolean; __churned: number };
      w.__churn = false;
      return w.__churned;
    });
    recordEvidence(info, "d1-churn", { ...result, churned });
    expect(churned).toBeGreaterThan(1_000);
    expect(result.reads).toBe(6_000);
    expect(result.misses).toBe(0);
    // ADAPTED, revision 35 (P11): each look took a snapshot (three looks per round) and read the size as its bound, and NO look read a
    // key by index, so the zero above is not the absence of a look, and no walk existed to be disturbed.
    expect(result.snapshots).toBeGreaterThanOrEqual(3 * result.reads);
    expect(result.listed).toBeGreaterThanOrEqual(3 * result.reads);
    expect(result.indexed).toBe(0);
    expect(await failureKeys(owner, OP)).toHaveLength(1);
  });

  test("D2: every page that prepares holds a different slot lock, and a closed page frees its slot", async ({
    context,
  }, info) => {
    const probePage = await dataPage(context);
    const before = await slotsHeld(probePage);
    const pages: Page[] = [];
    for (let n = 0; n < 3; n += 1) pages.push(await dataPage(context));
    // Each harness page prepared its markers when it loaded: three more slots are held, none twice (a lock is exclusive by construction).
    await expect
      .poll(async () => (await slotsHeld(probePage)).length, {
        timeout: 15_000,
      })
      .toBe(before.length + 3);
    const held = await slotsHeld(probePage);
    expect(new Set(held).size).toBe(held.length);
    await (pages[0] as Page).close();
    await expect
      .poll(async () => (await slotsHeld(probePage)).length, {
        timeout: 15_000,
      })
      .toBe(before.length + 2);
    recordEvidence(info, "d2-slots", { before, held });
  });

  test("D3: a failure a page publishes is found by a cold page, ended by its exact key, and a second page's failure of the same operation is its own", async ({
    context,
  }) => {
    const first = await dataPage(context);
    const second = await dataPage(context);
    expect(await publish(first, OP)).toBe("recorded");
    expect(await publish(second, OP)).toBe("recorded");
    const reader = await dataPage(context);
    await expect
      .poll(async () => (await failureKeys(reader, OP)).length, {
        timeout: 15_000,
      })
      .toBe(2);
    await expect
      .poll(() => probe(reader, OP), { timeout: 15_000 })
      .toBe("marked");
    // Two pages, two directories, each listing its writer's failure only.
    const directories = await rawKeys(reader, "atlas-write-dir:");
    expect(directories).toHaveLength(2);
    // The reader names what stands and ends exactly that.
    const ended = await reader.evaluate(
      ([scope, op]) => {
        const markers = window.__atlasData?.markers;
        if (!markers) throw new Error("no markers");
        const s = scope as { account: string; incarnationId: string };
        const seen = markers.witness(s, op as string);
        return markers.retire(s, op as string, seen);
      },
      [SCOPE, OP] as const,
    );
    expect(ended).toBe(true);
    await expect
      .poll(async () => (await failureKeys(first, OP)).length, {
        timeout: 15_000,
      })
      .toBe(0);
    await expect
      .poll(() => probe(first, OP), { timeout: 15_000 })
      .toBe("unmarked");
    // A failure published afterwards is a new key and stands.
    expect(await publish(second, OP)).toBe("recorded");
    await expect
      .poll(() => probe(first, OP), { timeout: 15_000 })
      .toBe("marked");
  });

  test("D4: a new owner of a slot inherits what the directory lists, publishes in it, and ends the inherited failure by its exact key", async ({
    context,
  }, info) => {
    const fix = (c: BrowserContext, slot: number) =>
      c.addInitScript((n) => {
        (globalThis as { __fixtureSlotStart?: number }).__fixtureSlotStart = n;
      }, slot);
    await fix(context, 7);
    const previous = await dataPage(context);
    const watcher = await dataPage(context);
    await expect
      .poll(async () => (await slotsHeld(watcher)).includes(7), {
        timeout: 15_000,
      })
      .toBe(true);
    expect(await publish(previous, OP)).toBe("recorded");
    const directory = (await rawKeys(watcher, "atlas-write-dir:")).find((k) =>
      k.endsWith(":7"),
    );
    expect(directory).toBeDefined();
    await previous.close();
    // The page is gone: its lock is released by the browser, and its failure still stands.
    await expect
      .poll(async () => (await slotsHeld(watcher)).includes(7), {
        timeout: 15_000,
      })
      .toBe(false);
    const heir = await dataPage(context);
    await expect
      .poll(async () => (await slotsHeld(watcher)).includes(7), {
        timeout: 15_000,
      })
      .toBe(true);
    expect(await publish(heir, OTHER)).toBe("recorded");
    const reader = await dataPage(context);
    await expect
      .poll(
        () =>
          reader.evaluate(
            ([scope]) =>
              window.__atlasData?.markers.inspect(
                scope as { account: string; incarnationId: string },
              ),
            [SCOPE] as const,
          ),
        { timeout: 15_000 },
      )
      .toEqual({ operations: [OP, OTHER], known: true });
    // The heir ends the inherited failure by its exact key; its own stands.
    const ended = await heir.evaluate(
      ([scope, op]) => {
        const markers = window.__atlasData?.markers;
        if (!markers) throw new Error("no markers");
        const s = scope as { account: string; incarnationId: string };
        return markers.retire(
          s,
          op as string,
          markers.witness(s, op as string),
        );
      },
      [SCOPE, OP] as const,
    );
    expect(ended).toBe(true);
    await expect
      .poll(
        () =>
          reader.evaluate(
            ([scope]) =>
              window.__atlasData?.markers.inspect(
                scope as { account: string; incarnationId: string },
              ),
            [SCOPE] as const,
          ),
        { timeout: 15_000 },
      )
      .toEqual({ operations: [OTHER], known: true });
    // Revision 34: the directories ALONE name both (the listing is refused in the reader), so the new owner kept what the previous one
    // listed in its own directory rather than leaving it to the listing.
    await heir.evaluate(
      ([scope, op]) => {
        const markers = window.__atlasData?.markers;
        if (!markers) throw new Error("no markers");
        markers.set(
          scope as { account: string; incarnationId: string },
          op as string,
        );
      },
      [SCOPE, "draft:d4-extra"] as const,
    );
    await expect
      .poll(
        async () =>
          (await readWithoutListing(reader, OTHER, "draft:never")).inspect,
        { timeout: 15_000 },
      )
      .toEqual({ operations: [OTHER, "draft:d4-extra"], known: false });
    recordEvidence(info, "d4-takeover", {
      directory,
      keys: await rawKeys(reader, "atlas-write-"),
    });
  });

  test("D5 measurement: a Web-Locks-serialised read-modify-write of one record across three pages, against an unlocked control (why no record is shared this way)", async ({
    context,
  }, info) => {
    // Revision 34. A measurement of the engine, not of the product. The locked half is 1,200 Web Lock round trips between
    // processes, which take about 2 s on an idle machine and 17 to 24 s on a saturated one (a load average of 190: forty
    // repetitions in WebKit), so the default 30 s left it no margin, and it once timed out there with nothing to read. It now has
    // headroom, and a half that still does not finish says how far each page got (a real stall is read, not a bare timeout).
    //
    // Revision 35 (R57, Q14 of the design assessment): the budgets are consistent and the diagnosis is bounded. Revision 34's 180 s test
    // timeout could expire before the second half's own 120 s budget (so a stall of the locked half could still end as a bare timeout),
    // and the progress it collected at the end was itself a `page.evaluate` that an unresponsive page need never answer. Now: each half
    // has `budgetMs`, the test's timeout covers setup, BOTH halves, their bounded collection and the check page with a stated reserve
    // (asserted below, so the arithmetic cannot drift), and the progress of every page is polled from the test process every
    // `pollMs` while a half runs, each poll bounded by `answerMs`. A half that exceeds its budget fails with the last progress each page
    // REPORTED and its age, and says which pages did not answer at all (a page that answers with an unfinished count is waiting for its
    // lock; one that does not answer is unresponsive). The workload (3 pages, 400 requests each), the control assertion and the absence
    // of any expectation of the locked half are unchanged; the old 30 s failure and revision 34's outcome stay on record.
    //
    // Revision 38 (Q15 of the design assessment of review 37): the loop records how far each lock request got, and a half that stops
    // progressing is classified by the collector (`d5-collector.ts`, its verdicts qualified by `fixture.data-d5-collector.spec.ts`):
    // waiting behind a holder that is one of the pages, another client or NOBODY; inside its callback; released but not told; or a page
    // that does not answer. The workload, the budgets, the control assertion and the absence of any expectation of the locked half are
    // unchanged; the arithmetic below now counts the collector's two bounded snapshots of a half (the first without progress, the deadline).
    const budgetMs = 100_000;
    const pollMs = 2_000;
    const answerMs = 5_000;
    const setupReserveMs = 60_000;
    const timeoutMs = 300_000;
    expect(2 * (budgetMs + 2 * answerMs) + setupReserveMs).toBeLessThan(
      timeoutMs,
    );
    test.setTimeout(timeoutMs);
    const pages: Page[] = [];
    for (let n = 0; n < 3; n += 1) pages.push(await dataPage(context));
    const run = async (locked: boolean) => {
      const key = `rmw-${locked ? "locked" : "control"}`;
      const started = Date.now();
      // Revision 38 (Q15): the loop is the collector's (`d5-collector.ts`): the same read-modify-write, 400 steps, the same yields of the
      // control, a synchronous callback, plus counters in page memory of how far each lock request got (requested, granted, returned,
      // settled), so a half that stops progressing is classified rather than inferred from a count.
      const answered = pages.map(() => false);
      const working = Promise.all(
        pages.map((page, index) =>
          runLoop(page, { id: `p${index}`, key, locked }).then((count) => {
            answered[index] = true;
            return count;
          }),
        ),
      );
      // The progress each page last REPORTED, and when (polled from the test process; every poll is bounded).
      const observed = pages.map(() => ({ count: -1, at: started }));
      const report = (page: Page, index: number) =>
        Promise.race([
          page
            .evaluate(
              (k) =>
                (window as unknown as { __d5?: Record<string, number> }).__d5?.[
                  k
                ] ?? 0,
              key,
            )
            .then((count) => {
              observed[index] = { count, at: Date.now() };
              return true;
            })
            .catch(() => false),
          new Promise<false>((resolve) =>
            setTimeout(() => resolve(false), answerMs),
          ),
        ]);
      // Revision 38 (Q15): the first time two successive polls show no progress, the collector's bounded snapshot (each page's lock
      // request state, its client id and the lock manager's holder and queue) is recorded once, whether or not the half then finishes.
      let snapshot: { atMs: number; verdicts: string } | null = null;
      let polling = true;
      const poller = (async () => {
        let previous = "";
        while (polling) {
          await Promise.all(pages.map(report));
          const seen = JSON.stringify(observed.map((o) => o.count));
          if (seen === previous && snapshot === null && polling) {
            const reports = await Promise.all(
              pages.map((page, index) =>
                collect(page, key, index, { answerMs, manager: true }),
              ),
            );
            snapshot = {
              atMs: Date.now() - started,
              verdicts: describeVerdicts(reports, classify(reports, answered)),
            };
            recordEvidence(
              info,
              `d5-${locked ? "locked" : "control"}-stall-snapshot`,
              { ...snapshot, reports },
            );
          }
          previous = seen;
          await new Promise((resolve) => setTimeout(resolve, pollMs));
        }
      })();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finished = await Promise.race([
        working,
        new Promise<null>((resolve) => {
          timer = setTimeout(() => {
            resolve(null);
          }, budgetMs);
        }),
      ]);
      clearTimeout(timer);
      // The half's duration is taken here, before the poller is drained (its last sleep is not part of the measurement).
      const elapsedMs = Date.now() - started;
      polling = false;
      if (finished === null) {
        // One last bounded collection: a page that does not answer within `answerMs` is named, with what it last reported.
        const replied = await Promise.all(pages.map(report));
        const now = Date.now();
        // Revision 38 (Q15): and the collector's verdict of every page at the deadline (bounded), beside the first no-progress one.
        const reports = await Promise.all(
          pages.map((page, index) =>
            collect(page, key, index, { answerMs, manager: true }),
          ),
        );
        const verdicts = describeVerdicts(reports, classify(reports, answered));
        recordEvidence(info, `d5-${locked ? "locked" : "control"}-deadline`, {
          verdicts,
          reports,
          first: snapshot,
        });
        throw new Error(
          `D5 ${locked ? "locked" : "control"} half: not finished in ${budgetMs} ms; per page: ${observed
            .map(
              (seen, index) =>
                `p${index} ${seen.count < 0 ? "never reported" : `${seen.count} of 400`} (last report ${now - seen.at} ms ago${replied[index] ? "" : `, no answer in ${answerMs} ms`})`,
            )
            .join(
              "; ",
            )}; at the deadline: ${verdicts}${snapshot === null ? "" : `; first without progress (${(snapshot as { atMs: number }).atMs} ms): ${(snapshot as { verdicts: string }).verdicts}`}`,
        );
      }
      await poller;
      const done = finished;
      recordEvidence(info, `d5-${locked ? "locked" : "control"}-duration`, {
        ms: elapsedMs,
      });
      const fresh = await dataPage(context);
      const stored = await fresh.evaluate(
        (k) =>
          (
            JSON.parse(localStorage.getItem(k) ?? '{"items":[]}') as {
              items: string[];
            }
          ).items.length,
        key,
      );
      await fresh.close();
      const expected = done.reduce((a, b) => a + b, 0);
      return { expected, stored, lost: expected - stored };
    };
    const control = await run(false);
    const locked = await run(true);
    recordEvidence(info, "d5-rmw-measurement", { control, locked });
    // The control must be able to see a loss, or the locked figure proves nothing. No expectation is made of the locked one.
    expect(control.lost).toBeGreaterThan(0);
  });

  test("D6 (revision 34): two live pages take and let go of ONE slot in turn, each publishing unique failures; a third page finds every failure the raw keys name", async ({
    context,
  }, info) => {
    const COUNT = 100;
    const scope = { account: SCOPE.account, incarnationId: "native-handover" };
    const pages = [await dataPage(context), await dataPage(context)];
    const cycles = (page: Page, id: string) =>
      page.evaluate(
        async ({ id: pageId, count, scope: s }) => {
          const lab = window.__atlasDurableLab;
          if (!lab) throw new Error("no lab");
          lab.create(pageId, { id: pageId, onlySlot: 0 });
          let retries = 0;
          const outcomes: string[] = [];
          for (let n = 0; n < count; n += 1) {
            let held = false;
            for (let tries = 0; tries < 20_000; tries += 1) {
              if (await lab.prepare(pageId)) {
                held = true;
                break;
              }
              retries += 1;
              await new Promise((r) => setTimeout(r, 0));
            }
            if (!held) throw new Error("the slot was never free");
            outcomes.push(lab.set(pageId, s, `${pageId}:${n}`));
            lab.release(pageId);
          }
          lab.destroy(pageId);
          return { retries, outcomes };
        },
        { id, count: COUNT, scope },
      );
    const [one, two] = await Promise.all([
      cycles(pages[0] as Page, "pa"),
      cycles(pages[1] as Page, "pb"),
    ]);
    expect(
      [...one.outcomes, ...two.outcomes].every((o) => o === "recorded"),
    ).toBe(true);
    const reader = await dataPage(context);
    const audit = await reader.evaluate((s) => {
      const lab = window.__atlasDurableLab;
      if (!lab) throw new Error("no lab");
      lab.create("reader", { noLocks: true });
      const raw = lab.raw(s);
      const read = lab.inspect("reader", s);
      const named = raw.failures.map((entry) => entry.split("#")[0] as string);
      return {
        raw: raw.failures.length,
        directories: raw.directories.length,
        listedInDirectory: raw.directories.reduce(
          (sum, d) =>
            sum +
            (JSON.parse(d.slice(d.indexOf(":") + 1)) as { e: unknown[] }).e
              .length,
          0,
        ),
        known: read.known,
        missing: named.filter((op) => !read.operations.includes(op)),
      };
    }, scope);
    recordEvidence(info, "d6-handover", {
      one: one.retries,
      two: two.retries,
      ...audit,
    });
    // Every failure that was recorded is discoverable, and the read is whole. (Revision 33 left 25 of the 200 undiscovered in WebKit.)
    expect(audit.raw).toBe(2 * COUNT);
    expect(audit.missing).toEqual([]);
    expect(audit.known).toBe(true);
  });

  test("D8 (revision 34): with the origin's listing refused in the reading page, the directories still name what stands, the read says it is not whole, and the listing that lands again restores known absence", async ({
    context,
  }, info) => {
    const writer = await dataPage(context);
    expect(await publish(writer, OP)).toBe("recorded");
    // A COLD reader: the wait reads the raw keys, not the markers (a read through the markers would make the page informed, and an
    // informed page keeps what it established when its listing is refused, which would hide a directory that is not there).
    const reader = await dataPage(context);
    await expect
      .poll(async () => (await rawKeys(reader, "atlas-write-")).length, {
        timeout: 15_000,
      })
      .toBe(2);
    const refused = await readWithoutListing(reader, OP, "draft:never");
    recordEvidence(info, "d8-refused-listing", refused);
    expect(refused.probe).toBe("marked");
    expect(refused.witness).toBe("instance");
    expect(refused.unnamed).toBe("unknown");
    expect(refused.inspect).toEqual({ operations: [OP], known: false });
    // The listing lands again: nothing else stands, and the read says so.
    expect(
      await reader.evaluate(
        ([scope]) =>
          window.__atlasData?.markers.inspect(
            scope as { account: string; incarnationId: string },
          ),
        [SCOPE] as const,
      ),
    ).toEqual({ operations: [OP], known: true });
    expect(await probe(reader, "draft:never")).toBe("unmarked");
  });

  test("D7 (revision 34): a page that can take no slot records its failure durably, and another page finds it", async ({
    context,
  }) => {
    const scope = { account: SCOPE.account, incarnationId: "native-no-slot" };
    const writer = await dataPage(context);
    const outcome = await writer.evaluate((s) => {
      const lab = window.__atlasDurableLab;
      if (!lab) throw new Error("no lab");
      lab.create("bare", { noLocks: true, id: "bare" });
      return lab.set("bare", s, "draft:a");
    }, scope);
    expect(outcome).toBe("recorded");
    const reader = await dataPage(context);
    await reader.evaluate(() =>
      window.__atlasDurableLab?.create("reader", { noLocks: true }),
    );
    await expect
      .poll(
        () =>
          reader.evaluate(
            (s) => window.__atlasDurableLab?.probe("reader", s, "draft:a"),
            scope,
          ),
        { timeout: 15_000 },
      )
      .toBe("marked");
    const raw = await reader.evaluate(
      (s) => window.__atlasDurableLab?.raw(s),
      scope,
    );
    expect(raw?.directories).toEqual([]);
    expect(raw?.failures).toHaveLength(1);
  });

  test("D9 (revision 35): a cold page finds a failure that NO directory lists by ONE snapshot of the origin's keys, with Storage.key refused, a key named keys stored and a second page churning the keys; a size it cannot read makes the read incomplete", async ({
    context,
  }, info) => {
    const scope = { account: SCOPE.account, incarnationId: "native-snapshot" };
    // The production publisher in a page that can take NO slot (the interval before a slot arrives, or every slot held): its key alone.
    const writer = await dataPage(context);
    const outcome = await writer.evaluate((s) => {
      const lab = window.__atlasDurableLab;
      if (!lab) throw new Error("no lab");
      lab.create("bare", { noLocks: true, id: "bare" });
      localStorage.setItem(
        "keys",
        "a key the origin stored under the name keys",
      );
      return lab.set("bare", s, "draft:a");
    }, scope);
    expect(outcome).toBe("recorded");
    const churner = await dataPage(context);
    await churner.evaluate(() => {
      const w = window as unknown as { __churn: boolean; __churned: number };
      w.__churn = true;
      w.__churned = 0;
      void (async () => {
        let i = 0;
        while (w.__churn) {
          localStorage.removeItem(`unrelated-${(i + 25) % 50}`);
          localStorage.setItem(`unrelated-${i % 50}`, String(i));
          i += 1;
          w.__churned = i;
          if (i % 100 === 0) await new Promise((r) => setTimeout(r, 0));
        }
      })();
    });
    const reader = await dataPage(context);
    // Cold: the wait reads the raw key, not the markers.
    await expect
      .poll(
        () =>
          reader.evaluate(
            (s) =>
              Object.keys(localStorage).filter((key) =>
                key.startsWith(
                  `atlas-write-failing:${encodeURIComponent(s.account)}:${encodeURIComponent(s.incarnationId)}:`,
                ),
              ).length,
            scope,
          ),
        { timeout: 15_000 },
      )
      .toBe(1);
    const result = await reader.evaluate(async (s) => {
      const lab = window.__atlasDurableLab;
      if (!lab) throw new Error("no lab");
      const proto = Storage.prototype as unknown as Record<string, unknown>;
      const key = proto.key;
      let indexed = 0;
      proto.key = () => {
        indexed += 1;
        throw new DOMException("refused", "SecurityError");
      };
      let misses = 0;
      let reads = 0;
      const first: Record<string, unknown> = {};
      try {
        for (let round = 0; round < 20; round += 1) {
          // A new cold reader each round: it knows nothing it could fall back on.
          lab.create(`cold-${round}`, { noLocks: true });
          for (let n = 0; n < 50; n += 1) {
            reads += 1;
            const probed = lab.probe(`cold-${round}`, s, "draft:a");
            const read = lab.inspect(`cold-${round}`, s);
            if (round === 0 && n === 0) Object.assign(first, { probed, read });
            if (probed !== "marked") misses += 1;
            if (!read.known || read.operations.join() !== "draft:a")
              misses += 1;
            if (lab.probe(`cold-${round}`, s, "draft:never") !== "unmarked")
              misses += 1;
          }
          lab.destroy(`cold-${round}`);
          await new Promise((r) => setTimeout(r, 0));
        }
      } finally {
        proto.key = key;
      }
      // The size cannot be read: the snapshot cannot be bounded, so the read is incomplete (and the failure is not forgotten by a
      // reader that knew it). Restored, the same reader is whole again without any event.
      lab.create("refused", { noLocks: true });
      const informed = lab.probe("refused", s, "draft:a");
      const length = Object.getOwnPropertyDescriptor(
        Storage.prototype,
        "length",
      );
      if (!length) throw new Error("no length");
      Object.defineProperty(Storage.prototype, "length", {
        ...length,
        get() {
          throw new DOMException("refused", "SecurityError");
        },
      });
      let refused: Record<string, unknown>;
      try {
        lab.create("refused-cold", { noLocks: true });
        refused = {
          informedProbe: lab.probe("refused", s, "draft:a"),
          informedUnnamed: lab.probe("refused", s, "draft:never"),
          coldProbe: lab.probe("refused-cold", s, "draft:a"),
          coldInspect: lab.inspect("refused-cold", s),
        };
      } finally {
        Object.defineProperty(Storage.prototype, "length", length);
      }
      const restored = lab.inspect("refused-cold", s);
      return { reads, misses, indexed, first, informed, refused, restored };
    }, scope);
    const churned = await churner.evaluate(() => {
      const w = window as unknown as { __churn: boolean; __churned: number };
      w.__churn = false;
      return w.__churned;
    });
    recordEvidence(info, "d9-snapshot", { ...result, churned });
    expect(churned).toBeGreaterThan(100);
    expect(result.reads).toBe(1_000);
    expect(result.misses).toBe(0);
    expect(result.indexed).toBe(0);
    expect(result.informed).toBe("marked");
    expect(result.refused).toEqual({
      informedProbe: "marked",
      informedUnnamed: "unknown",
      coldProbe: "unknown",
      coldInspect: { operations: [], known: false },
    });
    expect(result.restored).toEqual({ operations: ["draft:a"], known: true });
    // No directory lists it: the snapshot alone found it.
    const raw = await reader.evaluate(
      (s) => window.__atlasDurableLab?.raw(s),
      scope,
    );
    expect(raw?.directories).toEqual([]);
    expect(raw?.failures).toHaveLength(1);
  });
});
