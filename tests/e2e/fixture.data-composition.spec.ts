import type { BrowserContext, Page } from "@playwright/test";
import {
  accountDatabaseName,
  SCHEMA_VERSION,
} from "../../src/data/model/schema";
import type { HarnessEnqueue } from "../../src/fixture/data-harness/main";
import { recordEvidence } from "./data-evidence";
import { expect, test } from "./helpers";

/**
 * WEB-10a revision 3 (R9; design assessment C3, schedules Q12 and Q19) in Chromium, Firefox and WebKit: the REAL Dexie adapter over real
 * IndexedDB. E-CG1: the store advances `sync_state.composition_seq` in the same transaction as a write to a composition store (here the
 * production enqueue), and leaves it alone for a write of `sync_state` alone, for a plan whose scope does not hold `sync_state`, and for a
 * transaction that fails. E-CG2: version 3 is the barrier against an older build, which writes without advancing it: opening the database
 * delivers `versionchange` to an older build's connection, and an older build cannot open the upgraded database. FIXTURE evidence.
 */
async function openPage(context: BrowserContext): Promise<Page> {
  const page = await context.newPage();
  // A fault this test arms: a `put` into the named store throws, as a failing write does (the transaction aborts).
  await page.addInitScript(() => {
    const w = window as unknown as { __failPutInto?: string | null };
    w.__failPutInto = null;
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (
      this: IDBObjectStore,
      ...args: Parameters<IDBObjectStore["put"]>
    ) {
      if (w.__failPutInto === this.name)
        throw new DOMException("injected write failure", "DataError");
      return put.apply(this, args);
    };
  });
  await page.goto("/__data");
  await page.waitForFunction(() => window.__atlasData !== undefined);
  return page;
}

const create = (id: string): HarnessEnqueue => ({
  endpoint: "/commands",
  targets: [
    {
      resourceId: id,
      role: "primary",
      basis: "resource",
      versionChecked: false,
      seedIfUntracked: 1,
    },
  ],
  command: { kind: "create", id },
});

test.describe("E-CG1: the real adapter advances the local composition generation with every composition write, and only then", () => {
  test("an enqueue advances it by one; a write of sync_state alone, a raw plan without sync_state in scope and a failed save do not", async ({
    context,
  }, info) => {
    const page = await openPage(context);
    const account = crypto.randomUUID();
    await page.evaluate(async (a) => {
      window.__atlasData?.setIdentity(a);
      await window.__atlasData?.open(a, { create: true });
    }, account);
    const generation = () =>
      page.evaluate(
        async (a) =>
          (
            (await window.__atlasData?.syncState(a)) as {
              composition_seq?: number;
            } | null
          )?.composition_seq ?? 0,
        account,
      );
    const drafts = () =>
      page.evaluate(
        async (a) => (await window.__atlasData?.rows(a, "drafts"))?.length,
        account,
      );
    const start = await generation();
    const first = await page.evaluate(
      ([a, spec]) =>
        window.__atlasData?.enqueueDirect(a as string, spec as HarnessEnqueue),
      [account, create("x")] as const,
    );
    expect(first).toEqual({ kind: "queued" });
    expect(await generation()).toBe(start + 1);
    // Writes of the singleton alone (the closing fence) and a plan whose scope does not hold sync_state (the harness's raw put).
    await page.evaluate((a) => window.__atlasData?.markClosing(a), account);
    await page.evaluate(
      (a) =>
        window.__atlasData?.put(a, "cache", [
          {
            id: "c1",
            kind: "person",
            parent_id: null,
            label: "c1",
            value: null,
            version: 1,
            can_edit: true,
            archived: false,
            kind_date: null,
          },
        ]),
      account,
    );
    expect(await generation()).toBe(start + 1);
    // A save whose draft write fails: nothing of it commits, the generation included.
    const before = await drafts();
    await page.evaluate(() => {
      (window as unknown as { __failPutInto?: string | null }).__failPutInto =
        "drafts";
    });
    const failed = await page.evaluate(
      ([a, spec]) =>
        window.__atlasData?.enqueueDirect(a as string, spec as HarnessEnqueue),
      [account, create("y")] as const,
    );
    await page.evaluate(() => {
      (window as unknown as { __failPutInto?: string | null }).__failPutInto =
        null;
    });
    expect(failed?.kind).not.toBe("queued");
    expect(await drafts()).toBe(before);
    expect(await generation()).toBe(start + 1);
    recordEvidence(info, "e-cg1", { start, first, failed });
  });
});

test.describe("E-CG2: version 3 closes an older build's connection and an older build cannot open it (Q19)", () => {
  test("a version-1 database held open by an older build's connection: this build's open delivers versionchange to it, upgrades, and a version-2 open is refused", async ({
    context,
  }, info) => {
    const page = await openPage(context);
    const account = crypto.randomUUID();
    const name = accountDatabaseName(account);
    await page.evaluate(async (a) => {
      window.__atlasData?.setIdentity(a);
      await window.__atlasData?.createLegacyV1(a, []);
    }, account);
    // An older build's connection (Dexie version 1 is IndexedDB version 10). Like every build's adapter, it closes on versionchange.
    await page.evaluate(
      (db) =>
        new Promise<void>((resolve, reject) => {
          const w = window as unknown as { __older?: number | null };
          w.__older = null;
          const request = indexedDB.open(db, 10);
          request.onerror = () => reject(request.error);
          request.onsuccess = () => {
            const connection = request.result;
            connection.onversionchange = (event) => {
              w.__older = event.newVersion;
              connection.close();
            };
            resolve();
          };
        }),
      name,
    );
    const opened = await page.evaluate(
      (a) => window.__atlasData?.open(a, { create: false }),
      account,
    );
    expect(opened).toBe("opened");
    const description = await page.evaluate(
      (a) => window.__atlasData?.describe(a),
      account,
    );
    expect(description?.version).toBe(SCHEMA_VERSION * 10);
    expect(SCHEMA_VERSION).toBe(3);
    const older = await page.evaluate(
      () => (window as unknown as { __older?: number | null }).__older,
    );
    expect(older).toBe(SCHEMA_VERSION * 10);
    // A build of version 2 (IndexedDB version 20) cannot open the database any more.
    const refused = await page.evaluate(
      (db) =>
        new Promise<string>((resolve) => {
          const request = indexedDB.open(db, 20);
          request.onsuccess = () => {
            request.result.close();
            resolve("opened");
          };
          request.onerror = () => resolve(request.error?.name ?? "error");
        }),
      name,
    );
    expect(refused).toBe("VersionError");
    recordEvidence(info, "e-cg2", {
      version: description?.version,
      older,
      refused,
    });
  });
});
