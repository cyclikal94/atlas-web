import { type BrowserContext, expect, type Page, test } from "@playwright/test";
import { recordEvidence } from "./data-evidence";
import { ACCOUNT, dataPage } from "./data-sync-helpers";

/**
 * E-L2 (R36) and E-L3 (R37, revision 21), in Chromium, Firefox and WebKit: THE LIFETIME OF A DATABASE OPEN. FIXTURE evidence: the
 * production `createBrowserRuntime` (the page's `DataRuntime`, the open predicate, the Dexie opener, the raw-IndexedDB host, the wipe lock
 * and the page's connection registry) over REAL IndexedDB (`src/fixture/data-harness/open-closure.ts`), with no session and no backend.
 * The held listing, the held completion and the actions made in the turn a native request is made are NAMED injections: they delay
 * delivery or act at an instant; they fail nothing, shorten nothing and are not a device stall.
 *
 * R36 (creation). The review held the listing made under the wipe's lock, changed one of the page's facts and let it go: the open created
 * the database and answered `opened` for an account the page had left. Here the may-create predicate is changed (the identity moves,
 * the page signs out, a logout becomes pending, the account is closed, the runtime is disposed) while that listing is held, and again
 * in the turn the creating native request is made, which only the check INSIDE the creating upgrade can see. A refusal must leave NO
 * database in the engine (the engine's own listing says so), no native connection and no service.
 *
 * R37 (closure). The review deleted the database while an open was between its native connections (the second one's completion held,
 * and, with no held event, a deletion queued in the turn the second native request is made): the opener's handles were not in the registry
 * yet, the deletion stayed blocked, and when the open finished it lifted the latch and published a service. Here every schedule ends
 * with the deletion (or upgrade) FINISHED, no native connection left open, no live service, the latch as the closure set it, and the
 * runtime's own answer `refused:closed`. One schedule queues the deletion right after the FIRST native request, so that the second
 * request waits behind it: an opener whose first handle is not closeable by the closure never finishes (the answer is awaited
 * 15 s and a missing answer fails by saying so).
 *
 * Controls pass on revision 20's sources too: a creation nothing disturbs, a logout already pending, a completed open that is then deleted.
 * Reads are made AFTER the runtime's own answer to `open` (the explicit completed-open barrier).
 */
/** The runtime's answer is awaited this long: shorter than the test's own timeout (30 s), so a missing answer is an assertion. */
const ANSWER_TIMEOUT_MS = 15_000;

/** The account's database exists, as the first sync or a saved draft would have made it, and nothing of this page holds it open. */
async function seedDatabase(context: BrowserContext): Promise<void> {
  const seed = await dataPage(context);
  expect(
    await seed.evaluate((account) => {
      window.__atlasData?.setIdentity(account);
      return window.__atlasData?.open(account, { create: true });
    }, ACCOUNT),
  ).toBe("created");
  await seed.close();
}

/** A page with the open-closure harness and a run begun for the account; the database exists only if `seeded`. */
async function closurePage(
  context: BrowserContext,
  seeded: boolean,
): Promise<Page> {
  if (seeded) await seedDatabase(context);
  const page = await dataPage(context);
  await page.waitForFunction(() => window.__atlasOpenClosure !== undefined);
  await page.evaluate((account) => {
    window.__atlasOpenClosure?.begin(account);
  }, ACCOUNT);
  return page;
}

const snapshot = (page: Page) =>
  page.evaluate(() => {
    const h = window.__atlasOpenClosure;
    if (!h) throw new Error("no open-closure harness");
    return h.snapshot();
  });
const exists = (page: Page) =>
  page.evaluate(() => {
    const h = window.__atlasOpenClosure;
    if (!h) throw new Error("no open-closure harness");
    return h.exists();
  });
const answered = (page: Page, count: number) =>
  page.evaluate(
    ([wanted, timeout]) => {
      const h = window.__atlasOpenClosure;
      if (!h) throw new Error("no open-closure harness");
      return h.answered(wanted, timeout);
    },
    [count, ANSWER_TIMEOUT_MS] as const,
  );
const finished = (page: Page, which: "deletion" | "upgrade") =>
  page.evaluate(
    ([what, timeout]) => {
      const h = window.__atlasOpenClosure;
      if (!h) throw new Error("no open-closure harness");
      return h.finished(what, timeout);
    },
    [which, ANSWER_TIMEOUT_MS] as const,
  );

type Change = "switch" | "signout" | "operation" | "closure";
/** What each change of a fact refuses a creation with. */
const REFUSALS: Array<{
  change: Change | "dispose";
  answer: string;
  latch: string;
}> = [
  { change: "switch", answer: "refused:identity", latch: "open" },
  { change: "signout", answer: "refused:identity", latch: "open" },
  { change: "operation", answer: "refused:operation_pending", latch: "open" },
  {
    change: "closure",
    answer: "refused:closed",
    latch: "closed_for_deletion",
  },
  { change: "dispose", answer: "refused:abandoned", latch: "open" },
];

/** No database in the engine, no connection of the page's in the engine or the registry, no service. */
const NOTHING_CREATED = {
  registryConnections: 0,
  nativeConnectionsLive: 0,
  liveService: false,
} as const;

test.describe("E-L2 (R36): the may-create predicate holds at the creating boundary (real IndexedDB)", () => {
  for (const { change, answer, latch } of REFUSALS) {
    test(`R36: the listing made under the wipe's lock is held, then ${change === "dispose" ? "the runtime is disposed" : `the page's facts change (${change})`}, then it is let go: the creation is refused (${answer}) and NO database is created`, async ({
      context,
    }, info) => {
      const page = await closurePage(context, false);
      expect(await exists(page)).toBe(false);
      await page.evaluate(() => {
        const h = window.__atlasOpenClosure;
        h?.hold("listing", 2);
        h?.open({ create: true });
      });
      await page.evaluate(() => window.__atlasOpenClosure?.reached());
      const held = await snapshot(page);
      await page.evaluate((what) => {
        const h = window.__atlasOpenClosure;
        if (what === "dispose") h?.dispose();
        else h?.change(what);
        h?.release();
      }, change);
      const answers = await answered(page, 1);
      const after = await snapshot(page);
      const created = await exists(page);
      recordEvidence(info, `r36-listing-${change}`, {
        held,
        answers,
        after,
        created,
      });
      // The premise: the hold was in force before the creating open began, with the lock held and the database absent.
      expect(held.listingCalls).toBe(2);
      expect(held.nativeOpenRequests).toBe(0);
      expect(answers).toEqual({ answered: true, answers: [answer] });
      expect(created).toBe(false);
      expect(after).toMatchObject({ ...NOTHING_CREATED, latch });
      expect(after.nativeOpenRequests).toBe(0);
      await page.close();
    });
  }

  for (const { change, answer, latch } of REFUSALS.filter(
    (r): r is (typeof REFUSALS)[number] & { change: Change } =>
      r.change !== "dispose",
  )) {
    test(`R36: the page's facts change (${change}) in the turn the creating native request is made, before the engine delivers its upgrade: the creating upgrade refuses (${answer}) and NO database is created`, async ({
      context,
    }, info) => {
      const page = await closurePage(context, false);
      await page.evaluate((what) => {
        const h = window.__atlasOpenClosure;
        h?.afterRequest(1, what);
        h?.open({ create: true });
      }, change);
      const answers = await answered(page, 1);
      const after = await snapshot(page);
      const created = await exists(page);
      recordEvidence(info, `r36-creating-turn-${change}`, {
        answers,
        after,
        created,
      });
      // The premise: the creating native request WAS made (the check made before it had passed), so only the upgrade could refuse.
      expect(after.nativeOpenRequests).toBe(1);
      expect(answers).toEqual({ answered: true, answers: [answer] });
      expect(created).toBe(false);
      expect(after).toMatchObject({ ...NOTHING_CREATED, latch });
      await page.close();
    });
  }

  test("R36 control: nothing changes while the listing under the lock is held: the database is created, opened and served", async ({
    context,
  }, info) => {
    const page = await closurePage(context, false);
    await page.evaluate(() => {
      const h = window.__atlasOpenClosure;
      h?.hold("listing", 2);
      h?.open({ create: true });
    });
    await page.evaluate(() => window.__atlasOpenClosure?.reached());
    await page.evaluate(() => window.__atlasOpenClosure?.release());
    const answers = await answered(page, 1);
    const after = await snapshot(page);
    const created = await exists(page);
    recordEvidence(info, "r36-control-listing", { answers, after, created });
    expect(answers).toEqual({ answered: true, answers: ["opened"] });
    expect(created).toBe(true);
    expect(after).toMatchObject({
      registryConnections: 2,
      nativeConnectionsLive: 2,
      liveService: true,
      latch: "open",
    });
    await page.close();
  });

  test("R36 control: nothing changes in the turn the creating native request is made: the database is created, opened and served", async ({
    context,
  }, info) => {
    const page = await closurePage(context, false);
    await page.evaluate(() => {
      const h = window.__atlasOpenClosure;
      h?.afterRequest(1, "none");
      h?.open({ create: true });
    });
    const answers = await answered(page, 1);
    const after = await snapshot(page);
    const created = await exists(page);
    recordEvidence(info, "r36-control-creating-turn", {
      answers,
      after,
      created,
    });
    expect(answers).toEqual({ answered: true, answers: ["opened"] });
    expect(created).toBe(true);
    expect(after).toMatchObject({
      registryConnections: 2,
      nativeConnectionsLive: 2,
      liveService: true,
    });
    await page.close();
  });

  test("R36 control: a logout or retirement already pending when the creation is asked for is refused before it lists under the lock", async ({
    context,
  }, info) => {
    const page = await closurePage(context, false);
    await page.evaluate(() => {
      const h = window.__atlasOpenClosure;
      h?.change("operation");
      h?.open({ create: true });
    });
    const answers = await answered(page, 1);
    const after = await snapshot(page);
    const created = await exists(page);
    recordEvidence(info, "r36-control-pending", { answers, after, created });
    expect(answers).toEqual({
      answered: true,
      answers: ["refused:operation_pending"],
    });
    expect(created).toBe(false);
    expect(after.listingCalls).toBe(1);
    expect(after).toMatchObject(NOTHING_CREATED);
    await page.close();
  });
});

/** Nothing live after a closure: the deletion or upgrade finished, no native connection, no registry entry, no service. */
const CLOSED_FOR = (latch: string) =>
  ({
    registryConnections: 0,
    nativeConnectionsLive: 0,
    liveService: false,
    latch,
  }) as const;

test.describe("E-L3 (R37): a closure ends a pending open (real IndexedDB)", () => {
  test("R37: the SECOND native open's completion is held, the database is deleted, then the completion is let go: the deletion finishes, no connection is left, the answer is `closed` and no service is published", async ({
    context,
  }, info) => {
    const page = await closurePage(context, true);
    await page.evaluate(() => {
      const h = window.__atlasOpenClosure;
      h?.hold("completion", 2);
      h?.open({ create: false });
    });
    await page.evaluate(() => window.__atlasOpenClosure?.reached());
    await page.evaluate(() => window.__atlasOpenClosure?.deleteNow());
    // The page's connections have been told (the first one's handler is attached; the held one's is not yet).
    await page.waitForFunction(
      () => (window.__atlasOpenClosure?.snapshot().versionChanges ?? 0) > 0,
    );
    const during = await snapshot(page);
    await page.evaluate(() => window.__atlasOpenClosure?.release());
    const answers = await answered(page, 1);
    // The answer first: a runtime that never answers fails HERE, by this assertion, and not by the test's own timeout after a second wait.
    recordEvidence(info, "r37-held-second-completion-delete-answer", {
      answers,
    });
    expect(answers).toEqual({ answered: true, answers: ["refused:closed"] });
    const deleted = await finished(page, "deletion");
    const after = await snapshot(page);
    recordEvidence(info, "r37-held-second-completion-delete", {
      during,
      answers,
      deleted,
      after,
    });
    expect(deleted.finished).toBe(true);
    expect(after).toMatchObject(CLOSED_FOR("closed_for_deletion"));
    expect(await exists(page)).toBe(false);
    await page.close();
  });

  test("R37: the database is deleted in the turn the SECOND native open request is made (no event is held): the deletion finishes, no connection is left, the answer is `closed`", async ({
    context,
  }, info) => {
    const page = await closurePage(context, true);
    await page.evaluate(() => {
      const h = window.__atlasOpenClosure;
      h?.afterRequest(2, "delete");
      h?.open({ create: false });
    });
    const answers = await answered(page, 1);
    // The answer first: a runtime that never answers fails HERE, by this assertion, and not by the test's own timeout after a second wait.
    recordEvidence(info, "r37-delete-after-second-request-answer", { answers });
    expect(answers).toEqual({ answered: true, answers: ["refused:closed"] });
    const deleted = await finished(page, "deletion");
    const after = await snapshot(page);
    recordEvidence(info, "r37-delete-after-second-request", {
      answers,
      deleted,
      after,
    });
    expect(deleted.finished).toBe(true);
    expect(after).toMatchObject(CLOSED_FOR("closed_for_deletion"));
    expect(after.nativeOpenRequests).toBe(2);
    expect(await exists(page)).toBe(false);
    await page.close();
  });

  test("R37: the database is deleted in the turn the FIRST native open request is made, so that the second request waits behind the deletion: nothing waits for ever, the deletion finishes, nothing is created and the answer is `closed`", async ({
    context,
  }, info) => {
    const page = await closurePage(context, true);
    await page.evaluate(() => {
      const h = window.__atlasOpenClosure;
      h?.afterRequest(1, "delete");
      h?.open({ create: false });
    });
    const answers = await answered(page, 1);
    // The answer first: a runtime that never answers fails HERE, by this assertion, and not by the test's own timeout after a second wait.
    recordEvidence(info, "r37-delete-after-first-request-answer", { answers });
    expect(answers).toEqual({ answered: true, answers: ["refused:closed"] });
    const deleted = await finished(page, "deletion");
    const after = await snapshot(page);
    const created = await exists(page);
    recordEvidence(info, "r37-delete-after-first-request", {
      answers,
      deleted,
      after,
      created,
    });
    expect(deleted.finished).toBe(true);
    expect(after).toMatchObject(CLOSED_FOR("closed_for_deletion"));
    // The second request, which ran after the deletion, must not have created the database it was told not to create.
    expect(created).toBe(false);
    await page.close();
  });

  test("R37: the account is closed on the page (a latch from a wipe) while the FIRST native open's completion is held, then the completion is let go: the connection that finished meanwhile is closed, the answer is `closed` and the latch is the closure's", async ({
    context,
  }, info) => {
    const page = await closurePage(context, true);
    await page.evaluate(() => {
      const h = window.__atlasOpenClosure;
      h?.hold("completion", 1);
      h?.open({ create: false });
    });
    await page.evaluate(() => window.__atlasOpenClosure?.reached());
    const held = await snapshot(page);
    await page.evaluate(() => {
      const h = window.__atlasOpenClosure;
      h?.change("closure");
      h?.release();
    });
    const answers = await answered(page, 1);
    const after = await snapshot(page);
    recordEvidence(info, "r37-held-first-completion-closure", {
      held,
      answers,
      after,
    });
    // The premise: the engine had a connection the opener had not been told of.
    expect(held.nativeConnectionsLive).toBe(1);
    expect(answers).toEqual({ answered: true, answers: ["refused:closed"] });
    expect(after).toMatchObject(CLOSED_FOR("closed_for_deletion"));
    expect(await exists(page)).toBe(true);
    await page.close();
  });

  test("R37: the account is closed on the page (a latch from a wipe) while the SECOND native open's completion is held: the FIRST connection, which the opener knows of, is closed AT ONCE and not when the open ends; the answer is `closed` and nothing is left", async ({
    context,
  }, info) => {
    const page = await closurePage(context, true);
    await page.evaluate(() => {
      const h = window.__atlasOpenClosure;
      h?.hold("completion", 2);
      h?.open({ create: false });
    });
    await page.evaluate(() => window.__atlasOpenClosure?.reached());
    const held = await snapshot(page);
    await page.evaluate(() => window.__atlasOpenClosure?.change("closure"));
    const during = await snapshot(page);
    await page.evaluate(() => window.__atlasOpenClosure?.release());
    const answers = await answered(page, 1);
    const after = await snapshot(page);
    recordEvidence(info, "r37-held-second-completion-closure", {
      held,
      during,
      answers,
      after,
    });
    // The premise: the engine had two connections, and only the second was out of the opener's sight.
    expect(held.nativeConnectionsLive).toBe(2);
    // Closed at once: the closure does not wait for the open to finish.
    expect(during.nativeConnectionsLive).toBe(1);
    expect(answers).toEqual({ answered: true, answers: ["refused:closed"] });
    expect(after).toMatchObject(CLOSED_FOR("closed_for_deletion"));
    await page.close();
  });

  test("R37: a newer build upgrades the database while the SECOND native open's completion is held, then the completion is let go: the upgrade finishes, no connection is left and the answer is `closed` (the latch says the page must reload)", async ({
    context,
  }, info) => {
    const page = await closurePage(context, true);
    await page.evaluate(() => {
      const h = window.__atlasOpenClosure;
      h?.hold("completion", 2);
      h?.open({ create: false });
    });
    await page.evaluate(() => window.__atlasOpenClosure?.reached());
    await page.evaluate(() => window.__atlasOpenClosure?.upgradeNow());
    await page.waitForFunction(
      () => (window.__atlasOpenClosure?.snapshot().versionChanges ?? 0) > 0,
    );
    const during = await snapshot(page);
    await page.evaluate(() => window.__atlasOpenClosure?.release());
    const answers = await answered(page, 1);
    // The answer first: a runtime that never answers fails HERE, by this assertion, and not by the test's own timeout after a second wait.
    recordEvidence(info, "r37-held-second-completion-upgrade-answer", {
      answers,
    });
    expect(answers).toEqual({ answered: true, answers: ["refused:closed"] });
    const upgraded = await finished(page, "upgrade");
    const after = await snapshot(page);
    recordEvidence(info, "r37-held-second-completion-upgrade", {
      during,
      answers,
      upgraded,
      after,
    });
    expect(upgraded.finished).toBe(true);
    expect(after).toMatchObject(CLOSED_FOR("upgrade_pending"));
    await page.close();
  });

  test("R37: the account is closed on the page in the turn the singleton's SEEDING transaction is created: the transaction completes, both connections are closed, the answer is `closed` and the latch is the closure's", async ({
    context,
  }, info) => {
    const page = await closurePage(context, true);
    await page.evaluate(() => {
      const h = window.__atlasOpenClosure;
      h?.afterSeeding("closure");
      h?.open({ create: false });
    });
    const answers = await answered(page, 1);
    const after = await snapshot(page);
    recordEvidence(info, "r37-seeding-closure", { answers, after });
    // The premise: both native connections existed (the open had got as far as seeding).
    expect(after.nativeOpenSuccesses).toBe(2);
    expect(answers).toEqual({ answered: true, answers: ["refused:closed"] });
    expect(after).toMatchObject(CLOSED_FOR("closed_for_deletion"));
    expect(await exists(page)).toBe(true);
    await page.close();
  });

  test("R37: the database is deleted in the turn the singleton's SEEDING transaction is created: the deletion finishes once the transaction has, no connection is left and the answer is `closed`", async ({
    context,
  }, info) => {
    const page = await closurePage(context, true);
    await page.evaluate(() => {
      const h = window.__atlasOpenClosure;
      h?.afterSeeding("delete");
      h?.open({ create: false });
    });
    const answers = await answered(page, 1);
    recordEvidence(info, "r37-seeding-delete-answer", { answers });
    expect(answers).toEqual({ answered: true, answers: ["refused:closed"] });
    const deleted = await finished(page, "deletion");
    const after = await snapshot(page);
    recordEvidence(info, "r37-seeding-delete", { answers, deleted, after });
    expect(after.nativeOpenSuccesses).toBe(2);
    expect(deleted.finished).toBe(true);
    expect(after).toMatchObject(CLOSED_FOR("closed_for_deletion"));
    expect(await exists(page)).toBe(false);
    await page.close();
  });

  test("R37 control: an open nothing disturbs completes: two connections in the engine and the registry, a live service, no latch", async ({
    context,
  }, info) => {
    const page = await closurePage(context, true);
    await page.evaluate(() =>
      window.__atlasOpenClosure?.open({ create: false }),
    );
    const answers = await answered(page, 1);
    const after = await snapshot(page);
    recordEvidence(info, "r37-control-completed", { answers, after });
    expect(answers).toEqual({ answered: true, answers: ["opened"] });
    expect(after).toMatchObject({
      registryConnections: 2,
      nativeConnectionsLive: 2,
      liveService: true,
      latch: "open",
    });
    await page.close();
  });

  test("R37 control: a COMPLETED open is then deleted: the service ends, the deletion finishes and no connection is left", async ({
    context,
  }, info) => {
    const page = await closurePage(context, true);
    await page.evaluate(() =>
      window.__atlasOpenClosure?.open({ create: false }),
    );
    const answers = await answered(page, 1);
    await page.evaluate(() => window.__atlasOpenClosure?.deleteNow());
    const deleted = await finished(page, "deletion");
    const after = await snapshot(page);
    recordEvidence(info, "r37-control-completed-then-deleted", {
      answers,
      deleted,
      after,
    });
    expect(answers).toEqual({ answered: true, answers: ["opened"] });
    expect(deleted.finished).toBe(true);
    expect(after).toMatchObject(CLOSED_FOR("closed_for_deletion"));
    await page.close();
  });
});
