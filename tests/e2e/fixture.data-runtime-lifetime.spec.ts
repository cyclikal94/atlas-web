import { type BrowserContext, expect, type Page, test } from "@playwright/test";
import { recordEvidence } from "./data-evidence";
import { ACCOUNT, dataPage } from "./data-sync-helpers";

/**
 * E-L1 (R35, revision 20), in Chromium, Firefox and WebKit: DISPOSING A RUNTIME IS TERMINAL FOR ITS PENDING OPENS. FIXTURE evidence: the
 * production `DataProvider`, `createProductionEnv`, the controller, `createBrowserRuntime`, the Dexie opener, the raw-IndexedDB host and the
 * page's connection registry over REAL IndexedDB (`src/fixture/data-harness/provider-lifetime.tsx`), with no session and no backend. The held
 * listing and the held completion are named injections that delay delivery in the live page; they fail nothing, shorten nothing and are not a
 * device stall, and no physical freeze or crash is claimed.
 *
 * The review (revision 19) found that unmounting the provider while the controller's open of an existing database was pending left, when the
 * open finished, two connections, a live service and an open latch, with no identity listener and no wipe responder owned by that runtime;
 * a later account switch left them live. Each case here holds ONE operation of the open (the discovery of the databases, or the engine's
 * completion of the native open, which is the window in which the connection exists and the opener has not been told), acts while it is held
 * (unmounts the provider, mounts a replacement, moves the identity) and lets it go, then reads, AFTER the runtime's own answer to `open` (the
 * explicit completed-open barrier: a wait that ends without one fails by saying so, never by timing out), what the ENGINE did (native open
 * requests, connections made and closed, whether or not any registry knew of them) and what the page holds.
 *
 * Controls: a completed open that is unmounted, and an identity change while the open is pending with the runtime NOT disposed. Both pass
 * on revision 19's sources too: they show the harness reads what it claims to read.
 */
const OTHER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
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

/** A page with the provider-lifetime harness, a run begun for the account (identity set, offline, nothing held), nothing mounted. */
async function lifetimePage(context: BrowserContext): Promise<Page> {
  await seedDatabase(context);
  const page = await dataPage(context);
  await page.waitForFunction(
    () => window.__atlasProviderLifetime !== undefined,
  );
  await page.evaluate((account) => {
    window.__atlasProviderLifetime?.begin(account);
  }, ACCOUNT);
  return page;
}

const snapshot = (page: Page) =>
  page.evaluate(() => {
    const harness = window.__atlasProviderLifetime;
    if (!harness) throw new Error("no provider-lifetime harness");
    return harness.snapshot();
  });

const answered = (page: Page, count: number) =>
  page.evaluate(
    ([wanted, timeout]) => {
      const harness = window.__atlasProviderLifetime;
      if (!harness) throw new Error("no provider-lifetime harness");
      return harness.answered(wanted, timeout);
    },
    [count, ANSWER_TIMEOUT_MS] as const,
  );

type Hold = "listing" | "completion";
const HOLDS: Array<{ hold: Hold; what: string }> = [
  { hold: "listing", what: "the discovery of the databases is held" },
  {
    hold: "completion",
    what: "the native open has finished in the engine and its completion is held",
  },
];

/** Nothing live: no connection in the registry or the engine, no service, no identity listener. */
const GONE = {
  registryConnections: 0,
  nativeConnectionsLive: 0,
  liveServices: 0,
  identityListeners: 0,
} as const;
/** An open that was abandoned installed no service, so no `closeAll` ran for it and the latch is what it was. */
const NOTHING = { ...GONE, latch: "open" } as const;
/**
 * A runtime that DID hold a service latches the account when it is disposed (`Service.dispose("closed")` closes every connection of the
 * account and latches it `closed_for_deletion`): existing behaviour, which the next open through the predicate lifts.
 */
const DISPOSED_WITH_SERVICE = {
  ...GONE,
  latch: "closed_for_deletion",
} as const;

test.describe("E-L1 (R35): a runtime disposed while its open is pending (the production provider, real IndexedDB)", () => {
  test("R35 control: a provider that stays mounted binds the database, and the unmount closes everything", async ({
    context,
  }, info) => {
    const page = await lifetimePage(context);
    await page.evaluate(() => {
      window.__atlasProviderLifetime?.mount();
    });
    const answers = await answered(page, 1);
    const bound = await snapshot(page);
    await page.evaluate(() => window.__atlasProviderLifetime?.unmount(1));
    const after = await snapshot(page);
    recordEvidence(info, "r35-control-completed", { answers, bound, after });
    expect(answers).toEqual({ answered: true, answers: ["opened"] });
    expect(bound).toMatchObject({
      registryConnections: 2,
      nativeConnectionsLive: 2,
      liveServices: 1,
    });
    expect(after).toMatchObject(DISPOSED_WITH_SERVICE);
    await page.close();
  });

  for (const { hold, what } of HOLDS) {
    test(`R35 control: ${what}, the identity leaves the account, the provider STILL mounted: the open is refused for the identity and its handles are closed`, async ({
      context,
    }, info) => {
      const page = await lifetimePage(context);
      await page.evaluate((kind) => {
        const harness = window.__atlasProviderLifetime;
        harness?.hold(kind);
        harness?.mount();
      }, hold);
      await page.evaluate(() => window.__atlasProviderLifetime?.reached());
      await page.evaluate(() =>
        window.__atlasProviderLifetime?.moveIdentity(null, 2),
      );
      await page.evaluate(() => window.__atlasProviderLifetime?.release());
      const answers = await answered(page, 1);
      const after = await snapshot(page);
      recordEvidence(info, `r35-control-identity-${hold}`, { answers, after });
      expect(answers).toEqual({
        answered: true,
        answers: ["refused:identity"],
      });
      expect(after).toMatchObject({
        registryConnections: 0,
        nativeConnectionsLive: 0,
        liveServices: 0,
        latch: "closed_for_identity",
      });
      await page.close();
    });

    test(`R35: ${what}, the provider is unmounted, then the hold is let go: the open is abandoned, nothing is kept, and a later identity change finds nothing`, async ({
      context,
    }, info) => {
      const page = await lifetimePage(context);
      await page.evaluate((kind) => {
        const harness = window.__atlasProviderLifetime;
        harness?.hold(kind);
        harness?.mount();
      }, hold);
      await page.evaluate(() => window.__atlasProviderLifetime?.reached());
      const held = await snapshot(page);
      await page.evaluate(() => window.__atlasProviderLifetime?.unmount(1));
      await page.evaluate(() => window.__atlasProviderLifetime?.release());
      const answers = await answered(page, 1);
      const afterRelease = await snapshot(page);
      await page.evaluate((other) => {
        window.__atlasProviderLifetime?.moveIdentity(other, 2);
      }, OTHER);
      // One more turn of the page's event loop: whatever the late completion left to do has had its chance.
      await page.evaluate(
        () => new Promise((resolve) => setTimeout(resolve, 0)),
      );
      const afterSwitch = await snapshot(page);
      recordEvidence(info, `r35-unmounted-${hold}`, {
        held,
        answers,
        afterRelease,
        afterSwitch,
      });
      // The premise: the hold was in force while the provider was unmounted (a completion hold means the engine HAD a connection).
      expect(held.runtimesBuilt).toBe(1);
      if (hold === "completion") {
        expect(held.nativeOpenSuccesses).toBe(1);
        expect(held.nativeConnectionsLive).toBe(1);
      } else {
        expect(held.nativeOpenRequests).toBe(0);
      }
      expect(answers).toEqual({
        answered: true,
        answers: ["refused:abandoned"],
      });
      expect(afterRelease).toMatchObject(NOTHING);
      expect(afterSwitch).toMatchObject(NOTHING);
      // A listing that was held starts no native open at all once the provider is gone.
      if (hold === "listing") expect(afterRelease.nativeOpenRequests).toBe(0);
      await page.close();
    });

    test(`R35: ${what}, the provider is unmounted and a replacement is mounted before the hold is let go: the replacement's two connections and its service are untouched`, async ({
      context,
    }, info) => {
      const page = await lifetimePage(context);
      await page.evaluate((kind) => {
        const harness = window.__atlasProviderLifetime;
        harness?.hold(kind);
        harness?.mount();
      }, hold);
      await page.evaluate(() => window.__atlasProviderLifetime?.reached());
      await page.evaluate(() => {
        const harness = window.__atlasProviderLifetime;
        harness?.unmount(1);
        harness?.mount();
      });
      // The replacement (the second runtime) opens the account while the first runtime's open is still held.
      const replacementOpened = await answered(page, 1);
      const beforeRelease = await snapshot(page);
      await page.evaluate(() => window.__atlasProviderLifetime?.release());
      const answers = await answered(page, 2);
      const afterRelease = await snapshot(page);
      await page.evaluate(() => window.__atlasProviderLifetime?.unmount(2));
      const afterReplacementUnmount = await snapshot(page);
      recordEvidence(info, `r35-replacement-${hold}`, {
        replacementOpened,
        beforeRelease,
        answers,
        afterRelease,
        afterReplacementUnmount,
      });
      expect(replacementOpened).toEqual({
        answered: true,
        answers: ["opened"],
      });
      expect(beforeRelease.runtimesBuilt).toBe(2);
      expect(beforeRelease.liveServices).toBe(1);
      expect(answers.answered).toBe(true);
      expect([...answers.answers].sort()).toEqual([
        "opened",
        "refused:abandoned",
      ]);
      // Exactly the replacement's own two connections remain, in the registry and in the engine, with its service live and no latch.
      expect(afterRelease).toMatchObject({
        registryConnections: 2,
        nativeConnectionsLive: 2,
        liveServices: 1,
        latch: "open",
        runtimesBuilt: 2,
      });
      expect(afterReplacementUnmount).toMatchObject(DISPOSED_WITH_SERVICE);
      await page.close();
    });
  }
});
