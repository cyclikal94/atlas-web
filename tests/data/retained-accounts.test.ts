// @vitest-environment node
import { describe, expect, test } from "vitest";
import { accountDatabaseName } from "../../src/data/model/schema";
import { retainedAccountPlans } from "../../src/data/ports/ports-browser";
import { createPortsImpl } from "../../src/data/ports/ports-impl";
import { createRegistry, type Latch } from "../../src/data/store/registry";
import {
  accountOfDatabase,
  listRetainedAccountsWith,
} from "../../src/data/store/retained-accounts";
import type { AccountId } from "../../src/session/model/types";
import { FakeIdb, type TxInfo } from "../support/data/fake-idb";
import { draftRow, recoveryRow } from "../support/data/rows";
import { FakeSyncBus } from "../support/data/sync-bus";
import { World } from "../support/session/world";

/**
 * WEB-08c §2.1: the retained-account directory behind WF-SWITCH-01, over the IndexedDB double. A failed look is never "no other
 * accounts"; a label is only the account's OWN verified profile record; nothing is created, written or latched.
 */
const ALICE = "11111111-1111-4111-8111-111111111111" as AccountId;
const BOB = "22222222-2222-4222-8222-222222222222" as AccountId;
const CAROL = "33333333-3333-4333-8333-333333333333" as AccountId;

function origin() {
  const world = new World();
  for (const page of ["A", "seed", "port"]) world.registerPage(page);
  const idb = new FakeIdb(world);
  idb.autoDrive = true;
  const latches = new Map<AccountId, Latch>();
  const heldDeletes = new Set<AccountId>();
  const opened: AccountId[] = [];
  let failOpen: AccountId | null = null;
  const txs: TxInfo[] = [];
  idb.inject({
    match: (tx) => {
      txs.push(tx);
      return false;
    },
    mode: "abort",
  });
  const deps = {
    host: idb.hostForPage("A"),
    registry: { latch: (account: AccountId) => latches.get(account) ?? "open" },
    deletionFree: async (account: AccountId) => !heldDeletes.has(account),
    openExisting: async (account: AccountId) => {
      opened.push(account);
      if (failOpen === account) throw new Error("storage unavailable");
      const result = await idb
        .openerForPage("port", createRegistry("retained"))
        .open(account, { create: false, single: true, incarnation: "x" });
      return result.kind === "opened" ? result.store : null;
    },
    // The production composition's plans (`ports-browser.ts`).
    plans: retainedAccountPlans,
  };
  const create = async (account: AccountId): Promise<void> => {
    const result = await idb
      .openerForPage("seed", createRegistry("seed"))
      .open(account, {
        create: true,
        incarnation: `inc-${account}`,
        single: true,
      });
    if (result.kind === "opened") result.store.close();
  };
  const setProfile = (account: AccountId, username: string | null) => {
    const name = accountDatabaseName(account);
    const sync = idb.peek(name, "sync_state", "singleton") as unknown as Record<
      string,
      unknown
    >;
    idb.seed(name, "sync_state", [
      {
        ...sync,
        profile:
          username === null
            ? null
            : { username, verified_epoch: 3, verified_at: 1 },
      } as never,
    ]);
  };
  /** The real `LocalWorkPort.summarise`, over the same double, so a count can be compared with it. */
  const bus = new FakeSyncBus(world);
  const summarise = createPortsImpl({
    openExisting: async (account) => {
      const result = await idb
        .openerForPage("port", createRegistry("port"))
        .open(account, { create: false, single: true, incarnation: "y" });
      return result.kind === "opened" ? result.store : null;
    },
    channel: bus.channelFor("A"),
    registry: createRegistry("tab-A"),
    clock: { now: () => 1, sleep: async () => undefined },
    ids: { uuid: () => "00000000-0000-4000-8000-000000000001" },
    graceMs: 0,
  }).localWork.summarise;
  return {
    world,
    idb,
    deps,
    create,
    setProfile,
    summarise,
    latches,
    heldDeletes,
    opened,
    txs,
    failOpen: (account: AccountId | null) => {
      failOpen = account;
    },
  };
}

describe("accountOfDatabase: the exact account-database name pattern", () => {
  test("atlas-<uuid> is an account; atlas-auth and anything else are not", () => {
    expect(accountOfDatabase(accountDatabaseName(ALICE))).toBe(ALICE);
    expect(accountOfDatabase("atlas-auth")).toBeNull();
    expect(accountOfDatabase(`atlas-${ALICE}-x`)).toBeNull();
    expect(accountOfDatabase(`x-atlas-${ALICE}`)).toBeNull();
    expect(accountOfDatabase("atlas-")).toBeNull();
  });
});

describe("listRetainedAccounts (WEB-08c §2.1, D-8c-01)", () => {
  test("MU-8C-01: an unavailable or rejecting indexedDB.databases() is UNKNOWN, never an empty list", async () => {
    const o = origin();
    await o.create(BOB);
    o.idb.listUnsupported = true;
    expect(await listRetainedAccountsWith(o.deps, { exclude: ALICE })).toEqual({
      kind: "unknown",
    });
    o.idb.listUnsupported = false;
    o.idb.listError = new Error("boom");
    expect(await listRetainedAccountsWith(o.deps, { exclude: ALICE })).toEqual({
      kind: "unknown",
    });
  });

  test("MU-8C-02: the settled account is excluded; every other account database is listed once, atlas-auth never", async () => {
    const o = origin();
    for (const account of [ALICE, BOB, CAROL]) await o.create(account);
    const listing = await listRetainedAccountsWith(o.deps, { exclude: ALICE });
    expect(listing.kind).toBe("ok");
    const ids =
      listing.kind === "ok" ? listing.accounts.map((a) => a.account_id) : [];
    expect(ids.sort()).toEqual([BOB, CAROL]);
    expect(o.opened).not.toContain(ALICE);
  });

  test("MU-8C-03: the label is the account's OWN verified profile record; another account's record is never used", async () => {
    const o = origin();
    await o.create(ALICE);
    await o.create(BOB);
    await o.create(CAROL);
    o.setProfile(ALICE, "alice");
    o.setProfile(BOB, "bob");
    // Carol's database holds no profile at all: no name is inferred (not from her id, not from anyone else's record).
    o.setProfile(CAROL, null);
    const listing = await listRetainedAccountsWith(o.deps, { exclude: ALICE });
    expect(listing).toEqual({
      kind: "ok",
      accounts: expect.arrayContaining([
        { account_id: BOB, lastVerifiedName: "bob", waiting: 0 },
        { account_id: CAROL, lastVerifiedName: null, waiting: 0 },
      ]),
    });
    if (listing.kind === "ok") {
      expect(listing.accounts).toHaveLength(2);
      expect(JSON.stringify(listing)).not.toContain("alice");
    }
  });

  test("MU-8C-04: an account this page latched closed_for_deletion is skipped; one whose atlas-delete lock is held is skipped", async () => {
    const o = origin();
    for (const account of [BOB, CAROL]) await o.create(account);
    o.latches.set(BOB, "closed_for_deletion");
    o.heldDeletes.add(CAROL);
    expect(await listRetainedAccountsWith(o.deps, { exclude: ALICE })).toEqual({
      kind: "ok",
      accounts: [],
    });
    expect(o.opened).toEqual([]);
    // A latch for an identity change (this page merely switched away) does not hide a retained account.
    o.latches.set(BOB, "closed_for_identity");
    o.heldDeletes.clear();
    const listing = await listRetainedAccountsWith(o.deps, { exclude: ALICE });
    expect(listing.kind === "ok" ? listing.accounts.length : -1).toBe(2);
  });

  test("the count equals LocalWorkPort.summarise for the same database", async () => {
    const o = origin();
    await o.create(BOB);
    o.setProfile(BOB, "bob");
    const name = accountDatabaseName(BOB);
    o.idb.seed(name, "drafts", [
      draftRow({ status: "queued" }),
      draftRow({ status: "in_flight" }),
      draftRow({ status: "acknowledged" }),
    ]);
    o.idb.seed(name, "form_recovery", [recoveryRow()]);
    const expected = (await o.summarise(BOB)).count;
    expect(expected).toBeGreaterThan(0);
    const listing = await listRetainedAccountsWith(o.deps, { exclude: null });
    expect(listing).toEqual({
      kind: "ok",
      accounts: [
        { account_id: BOB, lastVerifiedName: "bob", waiting: expected },
      ],
    });
  });

  test("an open that fails is listed with its work UNKNOWN, never omitted while the database is still there", async () => {
    const o = origin();
    await o.create(BOB);
    o.failOpen(BOB);
    expect(await listRetainedAccountsWith(o.deps, { exclude: null })).toEqual({
      kind: "ok",
      accounts: [
        { account_id: BOB, lastVerifiedName: null, waiting: "unknown" },
      ],
    });
  });

  test("a read whose transactions fail keeps the row with its work unknown", async () => {
    const o = origin();
    await o.create(BOB);
    o.idb.inject({ match: (tx) => tx.account === BOB, mode: "error" });
    expect(await listRetainedAccountsWith(o.deps, { exclude: null })).toEqual({
      kind: "ok",
      accounts: [
        { account_id: BOB, lastVerifiedName: null, waiting: "unknown" },
      ],
    });
  });

  test("a database that vanishes between the listing and the open is omitted", async () => {
    const o = origin();
    await o.create(BOB);
    await o.create(CAROL);
    const open = o.deps.openExisting;
    o.deps.openExisting = async (account) => {
      if (account === BOB) o.idb.vanish(accountDatabaseName(BOB));
      return open(account);
    };
    const listing = await listRetainedAccountsWith(o.deps, { exclude: null });
    expect(
      listing.kind === "ok" ? listing.accounts.map((a) => a.account_id) : [],
    ).toEqual([CAROL]);
    expect(o.idb.has(accountDatabaseName(BOB))).toBe(false);
  });

  test("it creates nothing, writes nothing and leaves no connection open", async () => {
    const o = origin();
    await o.create(BOB);
    o.txs.length = 0;
    const before = o.idb.snapshot(accountDatabaseName(BOB));
    await listRetainedAccountsWith(o.deps, { exclude: null });
    expect(o.txs.length).toBeGreaterThan(0);
    expect(o.txs.every((tx) => tx.mode === "readonly")).toBe(true);
    expect(o.idb.snapshot(accountDatabaseName(BOB))).toEqual(before);
    expect(o.idb.openConnections(accountDatabaseName(BOB))).toBe(0);
    expect(o.idb.has(accountDatabaseName(CAROL))).toBe(false);
  });

  test("an aborted signal rejects with AbortError and reads nothing further", async () => {
    const o = origin();
    await o.create(BOB);
    const controller = new AbortController();
    controller.abort();
    await expect(
      listRetainedAccountsWith(o.deps, {
        exclude: null,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(o.opened).toEqual([]);
  });
});
