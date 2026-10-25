import { expect, test } from "@playwright/test";
import { recordEvidence } from "./data-evidence";
import { ACCOUNT, dataPage } from "./data-sync-helpers";
import { assertRuntimeClosures } from "./runtime-lifetime-oracle";

/** Fixture-only R43 oracle qualification. Existing native completion holds; no production duration changes. */
const ANSWER_TIMEOUT_MS = 15_000;
type BoundaryObservation = {
  native: ReturnType<NonNullable<Window["__atlasOpenClosure"]>["snapshot"]>;
  runtime: ReturnType<NonNullable<Window["__atlasData"]>["runtimeLifetime"]>;
};
type SingletonWindow = Window & {
  __r43Singleton?: {
    completed: boolean;
    stores: string[];
    before?: BoundaryObservation;
  };
};
for (const boundary of [
  "completion-1",
  "completion-2",
  "singleton-complete",
  "installed",
] as const) {
  test(`R43 lifetime qualification: ${boundary}`, async ({ context }, info) => {
    const seed = await dataPage(context);
    expect(
      await seed.evaluate((account) => {
        window.__atlasData?.setIdentity(account);
        return window.__atlasData?.open(account, { create: true });
      }, ACCOUNT),
    ).toBe("created");
    await seed.close();
    const page = await dataPage(context);
    await page.waitForFunction(() => window.__atlasOpenClosure !== undefined);
    const missing = await page.evaluate((account) => {
      try {
        window.__atlasData?.runtimeLifetime(account);
        return "did not fail";
      } catch (error) {
        return String(error);
      }
    }, ACCOUNT);
    expect(missing).toMatch(/runtime lifetime recorder not installed/);
    await page.evaluate(
      ({ account, boundary }) => {
        const data = window.__atlasData;
        const harness = window.__atlasOpenClosure;
        if (!data || !harness) throw new Error("missing native harness");
        data.recordRuntimeLifetime(account);
        harness.begin(account);
        if (boundary === "singleton-complete") {
          // Test-only native phase control: observe transaction completion before
          // Dexie's completion handler can resume the opener. Not a timing sample.
          const original = IDBDatabase.prototype.transaction;
          const observation = {
            completed: false,
            stores: [] as string[],
          } as NonNullable<SingletonWindow["__r43Singleton"]>;
          (window as SingletonWindow).__r43Singleton = observation;
          IDBDatabase.prototype.transaction = function transaction(
            this: IDBDatabase,
            ...args: Parameters<IDBDatabase["transaction"]>
          ): IDBTransaction {
            const made = original.apply(this, args);
            if (this.name === `atlas-${account}` && args[1] === "readwrite") {
              IDBDatabase.prototype.transaction = original;
              observation.stores = [...made.objectStoreNames];
              made.addEventListener(
                "complete",
                () => {
                  observation.completed = true;
                  observation.before = {
                    native: harness.snapshot(),
                    runtime: data.runtimeLifetime(account),
                  };
                  harness.dispose();
                },
                { once: true },
              );
            }
            return made;
          } as typeof IDBDatabase.prototype.transaction;
        } else if (boundary !== "installed") {
          harness.hold("completion", boundary === "completion-1" ? 1 : 2);
        }
        harness.open({ create: false });
      },
      { account: ACCOUNT, boundary },
    );
    if (boundary === "installed")
      expect(
        await page.evaluate(
          (timeout) => window.__atlasOpenClosure?.answered(1, timeout),
          ANSWER_TIMEOUT_MS,
        ),
      ).toEqual({ answered: true, answers: ["opened"] });
    else if (boundary === "singleton-complete")
      expect(
        await page.evaluate(
          (timeout) => window.__atlasOpenClosure?.answered(1, timeout),
          ANSWER_TIMEOUT_MS,
        ),
      ).toEqual({ answered: true, answers: ["refused:abandoned"] });
    else await page.evaluate(() => window.__atlasOpenClosure?.reached());

    const before = await page.evaluate(
      (account) =>
        (window as SingletonWindow).__r43Singleton?.before ?? {
          native: window.__atlasOpenClosure?.snapshot(),
          runtime: window.__atlasData?.runtimeLifetime(account),
        },
      ACCOUNT,
    );
    if (boundary !== "singleton-complete")
      await page.evaluate(() => window.__atlasOpenClosure?.dispose());
    const disposed = await page.evaluate(
      (account) => ({
        native: window.__atlasOpenClosure?.snapshot(),
        runtime: window.__atlasData?.runtimeLifetime(account),
      }),
      ACCOUNT,
    );
    if (boundary === "completion-1" || boundary === "completion-2")
      await page.evaluate(() => window.__atlasOpenClosure?.release());
    const answer = await page.evaluate(
      (timeout) => window.__atlasOpenClosure?.answered(1, timeout),
      ANSWER_TIMEOUT_MS,
    );
    const after = await page.evaluate(
      (account) => ({
        native: window.__atlasOpenClosure?.snapshot(),
        runtime: window.__atlasData?.runtimeLifetime(account),
      }),
      ACCOUNT,
    );
    const singleton = await page.evaluate(
      () => (window as SingletonWindow).__r43Singleton,
    );
    recordEvidence(info, `r43-lifetime-${boundary}`, {
      instrumentation:
        boundary === "singleton-complete"
          ? "test-only transaction-completion phase control"
          : "existing native phase control",
      singleton,
      boundary,
      missing,
      before,
      disposed,
      answer,
      after,
    });
    if (boundary === "singleton-complete") {
      expect(singleton?.completed, "singleton completion was observed").toBe(
        true,
      );
      expect(singleton?.stores).toEqual(["sync_state"]);
      expect(singleton?.before).toBeDefined();
    }
    expect(before.native?.nativeOpenSuccesses).toBe(
      boundary === "completion-1" ? 1 : 2,
    );
    expect(
      disposed.runtime?.disposals,
      "terminal disposal was observed",
    ).toHaveLength(1);
    const disposal = disposed.runtime?.disposals[0];
    expect(
      disposal?.stack,
      "fixture native disposal caller remains visible",
    ).toMatch(/open-closure/);
    expect(disposal?.runtime).toBe(before.runtime?.opens[0]?.runtime);
    expect(disposal?.closesAfter).not.toBeNull();
    const closed =
      (disposal?.closesAfter ?? -1) - (disposal?.closesBefore ?? 0);
    assertRuntimeClosures({
      disposals: disposed.runtime?.disposals ?? [],
      closed,
      legacyNativeSuccess: (before.native?.nativeOpenSuccesses ?? 0) > 0,
    });
    expect(closed).toBe(boundary === "installed" ? 1 : 0);
    expect(after.native, "native state after terminal disposal").toMatchObject({
      registryConnections: 0,
      nativeConnectionsLive: 0,
      liveService: false,
      latch: boundary === "installed" ? "closed_for_deletion" : "open",
    });
    if (boundary === "installed") {
      expect(disposal?.service).not.toBeNull();
      expect(disposal?.live).toBe(true);
      expect(disposal?.service).toBe(before.runtime?.opens[0]?.service);
      expect(before.runtime?.opens[0]?.installedAtAnswer).toBe(true);
      expect(answer).toEqual({ answered: true, answers: ["opened"] });
    } else {
      expect(disposal?.live).toBe(false);
      expect(disposal?.service).toBeNull();
      expect(disposal?.pending).toEqual([before.runtime?.opens[0]?.operation]);
      expect(
        answer,
        "pending open stays abandoned after terminal disposal",
      ).toEqual({
        answered: true,
        answers: ["refused:abandoned"],
      });
      expect(after.runtime?.opens[0]?.service).toBeNull();
      expect(after.runtime?.opens[0]?.answeredOrder).toBeGreaterThan(
        disposal?.order ?? 0,
      );
    }
    await page.evaluate(() => window.__atlasOpenClosure?.end());
  });
}
