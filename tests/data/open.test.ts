// @vitest-environment node
import { describe, expect, test } from "vitest";
import { accountDatabaseName } from "../../src/data/model/schema";
import { initialSyncState } from "../../src/data/model/sync-state";
import { wipeLockName } from "../../src/data/store/open";
import { StoreFailure } from "../../src/data/store/port";
import { listPlan } from "../../src/fixture/data-harness/conformance";
import { LOCKS } from "../../src/session/constants";
import { DataTestWorld } from "../support/data/env";

const ACCOUNT = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";

describe("F-A4: creation takes the session's wipe lock and the may-create predicate", () => {
  test("the lock name equals the session's LOCKS.wipe (the constant is not exported from the session index)", () => {
    expect(wipeLockName(ACCOUNT)).toBe(LOCKS.wipe(ACCOUNT));
  });

  test("creation is refused when the page's identity is another account, and nothing is created", async () => {
    const env = new DataTestWorld();
    env.idb.autoDrive = true;
    const page = env.page("A");
    page.identity.account = OTHER;
    expect(await page.open(ACCOUNT, { create: true })).toEqual({
      kind: "refused",
      reason: "identity",
    });
    expect(env.idb.has(accountDatabaseName(ACCOUNT))).toBe(false);
    page.identity.account = null;
    expect(await page.open(ACCOUNT, { create: true })).toEqual({
      kind: "refused",
      reason: "identity",
    });
  });

  test("creation is refused while a logout or retirement is pending for the account", async () => {
    const env = new DataTestWorld();
    env.idb.autoDrive = true;
    const page = env.page("A");
    page.identity.account = ACCOUNT;
    page.pending.add(ACCOUNT);
    expect(await page.open(ACCOUNT, { create: true })).toEqual({
      kind: "refused",
      reason: "operation_pending",
    });
    expect(env.idb.has(accountDatabaseName(ACCOUNT))).toBe(false);
    page.pending.delete(ACCOUNT);
    expect((await page.open(ACCOUNT, { create: true })).kind).toBe("opened");
  });

  test("a creation waits behind a running wipe (the same lock) and proceeds when it ends", async () => {
    const env = new DataTestWorld();
    const a = env.page("A");
    const b = env.page("B");
    a.identity.account = ACCOUNT;
    const held = b.locks.acquire(LOCKS.wipe(ACCOUNT));
    await env.settle();
    const handle = await held;
    expect(handle).not.toBeNull();

    let settled = false;
    const opening = a.open(ACCOUNT, { create: true }).then((outcome) => {
      settled = true;
      return outcome;
    });
    await env.settle();
    expect(
      settled,
      "creation must not proceed while the wipe holds the lock",
    ).toBe(false);
    expect(env.idb.has(accountDatabaseName(ACCOUNT))).toBe(false);

    handle?.release();
    await env.settle();
    const outcome = await opening;
    expect(outcome.kind).toBe("opened");
    expect(env.idb.has(accountDatabaseName(ACCOUNT))).toBe(true);
  });

  test("a wipe that outlasts the bound refuses with wipe_in_progress and creates nothing", async () => {
    const env = new DataTestWorld();
    const a = env.page("A");
    const b = env.page("B");
    a.identity.account = ACCOUNT;
    const held = await (async () => {
      const pending = b.locks.acquire(LOCKS.wipe(ACCOUNT));
      await env.settle();
      return pending;
    })();
    const opening = a.open(ACCOUNT, { create: true });
    await env.settle();
    await env.world.advance(20_001);
    expect(await opening).toEqual({
      kind: "refused",
      reason: "wipe_in_progress",
    });
    expect(env.idb.has(accountDatabaseName(ACCOUNT))).toBe(false);
    held?.release();
  });

  test("the pending operation that appears while the lock was waited for is seen on the re-check", async () => {
    const env = new DataTestWorld();
    const a = env.page("A");
    const b = env.page("B");
    a.identity.account = ACCOUNT;
    const wipe = b.locks.acquire(LOCKS.wipe(ACCOUNT));
    await env.settle();
    const handle = await wipe;
    const opening = a.open(ACCOUNT, { create: true });
    await env.settle();
    a.pending.add(ACCOUNT); // a logout began while this page waited
    handle?.release();
    await env.settle();
    expect(await opening).toEqual({
      kind: "refused",
      reason: "operation_pending",
    });
    expect(env.idb.has(accountDatabaseName(ACCOUNT))).toBe(false);
  });

  test("the lock is released after creation (a later wipe is not blocked by it)", async () => {
    const env = new DataTestWorld();
    env.idb.autoDrive = true;
    const a = env.page("A");
    const b = env.page("B");
    a.identity.account = ACCOUNT;
    await a.open(ACCOUNT, { create: true });
    const taken = await b.locks.acquire(LOCKS.wipe(ACCOUNT));
    expect(taken).not.toBeNull();
    taken?.release();
  });
});

describe("opening an existing database never creates one", () => {
  test("an absent database is `absent` and nothing is created", async () => {
    const env = new DataTestWorld();
    env.idb.autoDrive = true;
    const page = env.page("A");
    page.identity.account = ACCOUNT;
    expect(await page.open(ACCOUNT)).toEqual({ kind: "absent" });
    expect(env.idb.has(accountDatabaseName(ACCOUNT))).toBe(false);
  });

  test("a database that vanishes between the probe and the open is `absent`, not re-created", async () => {
    const env = new DataTestWorld();
    env.idb.autoDrive = true;
    const page = env.page("A");
    page.identity.account = ACCOUNT;
    await page.open(ACCOUNT, { create: true });
    page.registry.closeAll(ACCOUNT);
    env.idb.beforeOpen = (name) => env.idb.vanish(name);
    expect(await page.open(ACCOUNT)).toEqual({ kind: "absent" });
    expect(env.idb.has(accountDatabaseName(ACCOUNT))).toBe(false);
  });

  test("an unavailable databases() is never read as `absent` (MU-41)", async () => {
    const env = new DataTestWorld();
    env.idb.autoDrive = true;
    const page = env.page("A");
    page.identity.account = ACCOUNT;
    env.idb.listUnsupported = true;
    await expect(page.open(ACCOUNT, { create: true })).rejects.toThrow();
    expect(env.idb.has(accountDatabaseName(ACCOUNT))).toBe(false);
  });

  test("a database that exists without its singleton is re-seeded in place and nothing is deleted", async () => {
    const env = new DataTestWorld();
    env.idb.autoDrive = true;
    const page = env.page("A");
    page.identity.account = ACCOUNT;
    env.idb.createDamaged(ACCOUNT);
    env.idb.seed(accountDatabaseName(ACCOUNT), "drafts", [
      { local_id: "kept" } as never,
    ]);
    const outcome = await page.open(ACCOUNT);
    expect(outcome.kind).toBe("opened");
    if (outcome.kind !== "opened") return;
    const rows = await outcome.store.run(listPlan("drafts"), undefined);
    expect(rows.map((row) => row.local_id)).toEqual(["kept"]);
    const seeded = env.idb.peek(
      accountDatabaseName(ACCOUNT),
      "sync_state",
      "singleton",
    );
    expect(seeded?.cache_status).toBe("empty");
    expect(seeded?.incarnation_id).toBe(outcome.store.incarnationId);
    expect(env.idb.deleteRequests).toEqual([]);
  });

  test("the singleton is seeded in the creating transaction with the supplied incarnation", async () => {
    const env = new DataTestWorld();
    env.idb.autoDrive = true;
    const page = env.page("A");
    page.identity.account = ACCOUNT;
    const outcome = await page.open(ACCOUNT, { create: true });
    expect(outcome.kind === "opened" && outcome.created).toBe(true);
    const row = env.idb.peek(
      accountDatabaseName(ACCOUNT),
      "sync_state",
      "singleton",
    );
    expect(row).toEqual(initialSyncState(row?.incarnation_id as string));
  });
});

describe("F-A5: a latched account refuses every plan until it is reopened through the predicate", () => {
  async function opened(env: DataTestWorld) {
    env.idb.autoDrive = true;
    const page = env.page("A");
    page.identity.account = ACCOUNT;
    const outcome = await page.open(ACCOUNT, { create: true });
    if (outcome.kind !== "opened") throw new Error("not opened");
    return { page, store: outcome.store };
  }

  test("closeAll latches, closes every connection and refuses later plans with `closed`", async () => {
    const env = new DataTestWorld();
    const { page, store } = await opened(env);
    expect(page.registry.openCount(ACCOUNT)).toBe(2);
    page.registry.closeAll(ACCOUNT, { latch: "closed_for_deletion" });
    expect(page.registry.latch(ACCOUNT)).toBe("closed_for_deletion");
    expect(page.registry.openCount(ACCOUNT)).toBe(0);
    await expect(
      store.run(listPlan("drafts"), undefined),
    ).rejects.toMatchObject({ cause: "closed" });
    await expect(
      store.run(listPlan("drafts"), undefined),
    ).rejects.toBeInstanceOf(StoreFailure);
  });

  test("closeAll is idempotent and resolves with nothing open", async () => {
    const env = new DataTestWorld();
    env.idb.autoDrive = true;
    const page = env.page("A");
    expect(() => page.registry.closeAll(ACCOUNT)).not.toThrow();
    expect(() => page.registry.closeAll(ACCOUNT)).not.toThrow();
    expect(page.registry.latch(ACCOUNT)).toBe("closed_for_deletion");
  });

  test("a late plan after the database was deleted does not re-create it", async () => {
    const env = new DataTestWorld();
    const { page, store } = await opened(env);
    const deleted = page.host.delete(accountDatabaseName(ACCOUNT));
    await env.settle();
    expect(["deleted", "blocked_then_deleted"]).toContain(await deleted);
    expect(env.idb.has(accountDatabaseName(ACCOUNT))).toBe(false);
    await expect(
      store.run(listPlan("drafts"), undefined),
    ).rejects.toMatchObject({ cause: "closed" });
    expect(env.idb.has(accountDatabaseName(ACCOUNT))).toBe(false);
    expect(page.versionChanges).toEqual([
      { account: ACCOUNT, kind: "deleted" },
    ]);
  });

  test("a successful reopen through the predicate clears the latch; a refusal does not", async () => {
    const env = new DataTestWorld();
    const { page } = await opened(env);
    page.registry.closeAll(ACCOUNT, { latch: "closed_for_identity" });
    page.identity.account = OTHER;
    expect(await page.open(ACCOUNT)).toEqual({
      kind: "refused",
      reason: "identity",
    });
    expect(page.registry.latch(ACCOUNT)).toBe("closed_for_identity");
    page.identity.account = ACCOUNT;
    const again = await page.open(ACCOUNT);
    expect(again.kind).toBe("opened");
    expect(page.registry.latch(ACCOUNT)).toBe("open");
  });
});
