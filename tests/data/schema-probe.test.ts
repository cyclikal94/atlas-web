// @vitest-environment node
import { describe, expect, test } from "vitest";
import {
  accountDatabaseName,
  DECLARED_IDB_VERSION,
  SCHEMA_VERSION,
} from "../../src/data/model/schema";
import type { AccountId } from "../../src/data/model/types";
import { StoreFailure } from "../../src/data/store/port";
import { DataTestWorld } from "../support/data/env";

/**
 * WEB-14a D-P8, DECLARED-THEN-PROBE (WEB-03 5, eighth round). An account database another tab's NEWER build has upgraded is never used by
 * this page's code again: an open that finds a newer installed version fails with `StoreFailure("closed")` before reading anything, latches
 * the account `upgrade_pending`, and reports `upgraded` ONCE; an upgrading `versionchange` while the page holds the database does the same;
 * and the supersession is sticky for the page (a later open is refused at once, whoever asks). An equal version opens as before.
 *
 * FIXTURE evidence over the double of IndexedDB, which mirrors the Dexie adapter; the real adapter in three engines is
 * `tests/e2e/fixture.data-schema-probe.spec.ts`.
 */
const A = "acct-a" as AccountId;
const DB = accountDatabaseName(A);

const createdAt = async (f: DataTestWorld, page = f.page("A")) => {
  page.identity.account = A;
  const outcome = await f.run(page.open(A, { create: true }));
  if (outcome.kind !== "opened") throw new Error(`not opened: ${outcome.kind}`);
  return outcome.store;
};

describe("the declared version", () => {
  test("Dexie's declared version n is IndexedDB version n * 10", () => {
    expect(SCHEMA_VERSION).toBe(3);
    expect(DECLARED_IDB_VERSION).toBe(30);
  });
});

describe("the probe at open", () => {
  test("an equal installed version opens normally (the positive control)", async () => {
    const f = new DataTestWorld();
    const store = await createdAt(f);
    store.close();
    const page = f.page("A");
    const again = await f.run(page.open(A));
    expect(again.kind).toBe("opened");
    expect(page.versionChanges).toEqual([]);
    expect(page.registry.latch(A)).toBe("open");
  });

  test("a NEWER installed version: the open fails closed, the account is latched, `upgraded` is reported once, nothing is read", async () => {
    const f = new DataTestWorld();
    const store = await createdAt(f);
    store.close();
    f.idb.upgradeTo(DB, DECLARED_IDB_VERSION + 10);
    await f.world.runUntilIdle();
    const page = f.page("B");
    page.identity.account = A;
    const before = f.idb.openConnections(DB);
    const outcome = await f.run(page.open(A)).catch((error: unknown) => error);
    // The opener's failure is reported by `openAccountData` as the closure it is.
    expect(outcome).toMatchObject({ kind: "refused", reason: "closed" });
    expect(page.registry.latch(A)).toBe("upgrade_pending");
    expect(page.versionChanges).toEqual([{ account: A, kind: "upgraded" }]);
    // No connection was left open by the refused open.
    expect(f.idb.openConnections(DB)).toBe(before);
  });

  test("the supersession is sticky for the page: every later open is refused at once, and reported only once", async () => {
    const f = new DataTestWorld();
    const store = await createdAt(f);
    store.close();
    f.idb.upgradeTo(DB, DECLARED_IDB_VERSION + 10);
    await f.world.runUntilIdle();
    const page = f.page("B");
    page.identity.account = A;
    await f.run(page.open(A)).catch(() => undefined);
    // Even a direct call to the opener (the deletion ports' path) is refused before it reaches the database.
    await expect(
      f.run(page.opener.open(A, { create: false, incarnation: "x" })),
    ).rejects.toBeInstanceOf(StoreFailure);
    const second = await f.run(page.open(A));
    expect(second).toEqual({ kind: "refused", reason: "closed" });
    expect(page.versionChanges).toHaveLength(1);
  });
});

describe("an upgrading versionchange while the database is open", () => {
  test("closes the page's connections, latches, reports once, and the page never reopens it", async () => {
    const f = new DataTestWorld();
    const store = await createdAt(f);
    const page = f.page("A");
    expect(f.idb.openConnections(DB)).toBeGreaterThan(0);
    f.idb.upgradeTo(DB, DECLARED_IDB_VERSION + 10);
    await f.world.runUntilIdle();
    expect(f.idb.openConnections(DB)).toBe(0);
    expect(page.registry.latch(A)).toBe("upgrade_pending");
    expect(page.versionChanges).toEqual([{ account: A, kind: "upgraded" }]);
    void store;
    // Unlike a deletion's latch, which a deliberately authorised new open lifts, this one is never lifted on this page.
    const reopened = await f.run(page.open(A));
    expect(reopened).toEqual({ kind: "refused", reason: "closed" });
    expect(page.versionChanges).toHaveLength(1);
  });

  test("a deletion is not a supersession: an authorised new open after it still creates (the wipe's path is unchanged)", async () => {
    const f = new DataTestWorld();
    await createdAt(f);
    const page = f.page("A");
    await f.run(page.host.delete(DB));
    expect(page.versionChanges).toEqual([{ account: A, kind: "deleted" }]);
    const recreated = await f.run(page.open(A, { create: true }));
    expect(recreated.kind).toBe("opened");
  });
});
