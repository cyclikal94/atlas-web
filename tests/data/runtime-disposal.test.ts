// @vitest-environment node
import { describe, expect, test } from "vitest";
import {
  DataRuntime,
  unorderedPersistence,
} from "../../src/data/engine/account-service";
import { accountDatabaseName } from "../../src/data/model/schema";
import type { AccountId } from "../../src/data/model/types";
import { type OpenOptions, openAccountData } from "../../src/data/store/open";
import { LOCKS } from "../../src/session/constants";
import {
  A,
  B,
  type Gate,
  gate,
  type Holds,
  type PendingWorld,
  setup,
} from "../support/data/pending-open";

/**
 * R35 (revision 20): disposing a `DataRuntime` while a database open is pending must not let that open create live connections, a
 * service or an epoch publication afterwards.
 *
 * The invariant: DISPOSAL IS TERMINAL. A runtime that has been disposed opens nothing (a new `open` is refused `abandoned`), and an open
 * that was pending when it was disposed finishes into nothing: it installs no service, publishes no epoch, lifts no latch, and lets go of
 * exactly the handles it opened. It must NOT close what a healthy REPLACEMENT runtime opened for the same account through the page's
 * shared registry (the provider disposes one runtime and builds the next on every unmount and restart).
 *
 * Every phase of a pending open is held in turn, with the pending open's own caller gone (disposed), with a completed open and with an
 * identity change as controls: the discovery of the databases (`indexedDB.databases()`), the native open before it starts, the native open
 * once it has finished in the engine but its completion has not been delivered, and, for a creation, the wait behind a wipe's lock, the
 * listing under that lock and the creating upgrade. FIXTURE evidence: the double of IndexedDB. The production composition (the provider,
 * `createBrowserRuntime`, Dexie and real IndexedDB) is in `provider-pending-open.test.tsx` and the real-engine spec
 * `fixture.data-runtime-lifetime.spec.ts`.
 */
const NOTHING = {
  connections: 0,
  service: false,
  published: 0,
  latch: "open",
} as const;
const ABANDONED = { kind: "refused", reason: "abandoned" } as const;

/** The three phases of a pending open of an existing database, and what a disposal at that phase leaves of the native work. */
const PHASES = [
  {
    name: "the discovery of the databases is pending",
    holds: (g: Gate): Holds => ({ listing: { 1: g } }),
    // The listing has not returned: no native open has begun, and none may.
    nativeOpens: 0,
  },
  {
    name: "the native open is pending (it has not started)",
    holds: (g: Gate): Holds => ({ before: { 1: g } }),
    nativeOpens: 1,
  },
  {
    name: "the native open has finished in the engine and its completion has not been delivered",
    holds: (g: Gate): Holds => ({ landed: { 1: g } }),
    nativeOpens: 1,
  },
] as const;

describe("R35: controls", () => {
  test("a completed open is closed by disposal, and nothing is left", async () => {
    const f = await setup();
    const rt = f.runtime();
    const opened = await rt.open(A);
    expect(opened.kind).toBe("opened");
    expect(f.page.registry.openCount(A)).toBe(2);
    rt.dispose();
    expect(f.held(rt)).toMatchObject({ connections: 0, service: false });
  });

  for (const phase of PHASES)
    test(`an identity change while ${phase.name}, with the runtime NOT disposed: the open is refused, its handles are closed and the account is latched for the identity`, async () => {
      const g = gate();
      const f = await setup({ holds: phase.holds(g) });
      const rt = f.runtime();
      const pending = rt.open(A);
      await g.reached;
      f.page.identity.account = B;
      f.identity.set({ account_id: B, epoch: 2, session_id: "s2" });
      g.release();
      expect(await pending).toEqual({ kind: "refused", reason: "identity" });
      await f.world.settle();
      expect(f.held(rt)).toEqual({
        connections: 0,
        service: false,
        published: 0,
        latch: "closed_for_identity",
      });
      rt.dispose();
    });
});

describe("R35: a runtime disposed while an open is pending keeps nothing that open produces", () => {
  // Two layers hold the same invariant and each is shown on its own: `openAccountData` starts nothing for a caller that has gone and lets
  // go of what it opened (an opener that honours `abandoned`), and the RUNTIME releases the store of an outcome that arrives after its
  // disposal whatever the opener did (one that ignores it, which is what a double of `open` or a future implementation may be).
  for (const honour of [true, false])
    for (const phase of PHASES) {
      const opener = honour
        ? "an opener that honours `abandoned`"
        : "an opener that ignores `abandoned`";
      // What a disposal leaves of the NATIVE work: with an opener that honours it, a held listing starts no open at all; with one that
      // does not, the open begins and is let go on arrival.
      const nativeOpens = honour ? phase.nativeOpens : 1;
      test(`${phase.name} (${opener}): the late completion installs no service, publishes no epoch and keeps no connection; ${nativeOpens === 0 ? "no native open is begun at all" : "the native open that was under way is let go"}`, async () => {
        const g = gate();
        const f = await setup({ holds: phase.holds(g) });
        const rt = f.runtime(honour);
        const pending = rt.open(A);
        await g.reached;
        rt.dispose();
        g.release();
        expect(await pending).toEqual(ABANDONED);
        await f.world.settle();
        expect(f.held(rt)).toEqual(NOTHING);
        expect(f.calls.opens).toBe(nativeOpens);
        // The identity left the account afterwards: there is nothing to close, and nothing follows it.
        f.page.identity.account = B;
        f.identity.set({ account_id: B, epoch: 2, session_id: "s2" });
        await f.world.settle();
        expect(f.held(rt)).toEqual(NOTHING);
        expect(f.identity.listenerCount).toBe(0);
      });

      test(`${phase.name} (${opener}), and the identity has changed before the late completion: still nothing is kept, and the latch is not touched`, async () => {
        const g = gate();
        const f = await setup({ holds: phase.holds(g) });
        const rt = f.runtime(honour);
        const pending = rt.open(A);
        await g.reached;
        rt.dispose();
        f.page.identity.account = B;
        f.identity.set({ account_id: B, epoch: 2, session_id: "s2" });
        g.release();
        expect(await pending).toEqual(ABANDONED);
        await f.world.settle();
        expect(f.held(rt)).toEqual(NOTHING);
      });

      test(`${phase.name} (${opener}), and a healthy replacement runtime opens the same account meanwhile: the late completion closes none of the replacement's connections`, async () => {
        const g = gate();
        const f = await setup({ holds: phase.holds(g) });
        const old = f.runtime(honour);
        const pending = old.open(A);
        await g.reached;
        old.dispose();
        const replacement = f.runtime();
        const current = await replacement.open(A);
        expect(current.kind).toBe("opened");
        g.release();
        expect(await pending).toEqual(ABANDONED);
        await f.world.settle();
        // Exactly the replacement's own two connections; its service is live, so the account is not latched.
        expect(f.page.registry.openCount(A)).toBe(2);
        expect(f.page.registry.latch(A)).toBe("open");
        expect(replacement.serviceFor(A)?.live).toBe(true);
        expect(old.serviceFor(A)).toBeNull();
        replacement.dispose();
        expect(f.page.registry.openCount(A)).toBe(0);
      });
    }

  test("a late completion lifts no latch that something else set meanwhile (a wipe latched the account)", async () => {
    const g = gate();
    const f = await setup({ holds: { landed: { 1: g } } });
    const rt = f.runtime();
    const pending = rt.open(A);
    await g.reached;
    rt.dispose();
    f.page.registry.closeAll(A, { latch: "closed_for_deletion" });
    g.release();
    expect(await pending).toEqual(ABANDONED);
    await f.world.settle();
    expect(f.page.registry.latch(A)).toBe("closed_for_deletion");
    expect(f.page.registry.openCount(A)).toBe(0);
  });

  test("the runtime tells its opener when it is abandoned: false while it stands, true from its disposal", async () => {
    const f = await setup();
    const seen: Array<() => boolean> = [];
    const rt = new DataRuntime({
      identity: f.identity,
      persistence: unorderedPersistence,
      registry: f.page.registry,
      open: (account, openOptions) => {
        if (openOptions.abandoned) seen.push(openOptions.abandoned);
        return f.page.open(account, { create: openOptions.create });
      },
    });
    await rt.open(A);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.()).toBe(false);
    rt.dispose();
    expect(seen[0]?.()).toBe(true);
  });
});

describe("R35: a disposed runtime opens nothing, ever", () => {
  test("a new open is refused `abandoned`: no listing, no native open, no database created", async () => {
    const f = await setup({ seeded: false });
    const rt = f.runtime();
    rt.dispose();
    expect(await rt.open(A, { create: true })).toEqual(ABANDONED);
    expect(await rt.open(A)).toEqual(ABANDONED);
    await f.world.settle();
    expect(f.calls).toEqual({ listings: 0, opens: 0 });
    expect(f.world.idb.has(accountDatabaseName(A))).toBe(false);
    expect(f.held(rt)).toEqual(NOTHING);
  });

  test("the same over an opener that ignores `abandoned`: the runtime itself starts no listing and no open", async () => {
    const f = await setup({ seeded: false });
    const rt = f.runtime(false);
    rt.dispose();
    expect(await rt.open(A, { create: true })).toEqual(ABANDONED);
    expect(await rt.open(A)).toEqual(ABANDONED);
    await f.world.settle();
    expect(f.calls).toEqual({ listings: 0, opens: 0 });
    expect(f.world.idb.has(accountDatabaseName(A))).toBe(false);
  });

  test("a disposed runtime that had a service refuses to open the same account again, and disposal is idempotent", async () => {
    const f = await setup();
    const rt = f.runtime();
    expect((await rt.open(A)).kind).toBe("opened");
    rt.dispose();
    rt.dispose();
    expect(await rt.open(A)).toEqual(ABANDONED);
    expect(f.page.registry.openCount(A)).toBe(0);
    expect(f.identity.listenerCount).toBe(0);
  });
});

describe("R35: a creation of the database by a runtime that has gone", () => {
  test("disposed while the creation waits behind a wipe's lock: nothing is created and the lock is let go the moment it is granted", async () => {
    const f = await setup({ seeded: false });
    const wipe = f.world.page("W");
    const lock = await f.world.run(wipe.locks.acquire(LOCKS.wipe(A)));
    expect(lock).not.toBeNull();
    const rt = f.runtime();
    const pending = rt.open(A, { create: true });
    await f.world.settle();
    rt.dispose();
    lock?.release();
    expect(await pending).toEqual(ABANDONED);
    await f.world.settle();
    expect(f.world.idb.has(accountDatabaseName(A))).toBe(false);
    expect(f.calls.opens).toBe(0);
    // The listing before the lock was the only one: a caller that went does not list again under it.
    expect(f.calls.listings).toBe(1);
    expect(await f.world.run(wipe.locks.probe(LOCKS.wipe(A)))).toBe(true);
    expect(f.held(rt)).toEqual(NOTHING);
  });

  test("disposed while the listing made under the lock is pending: nothing is created", async () => {
    const g = gate();
    const f = await setup({ seeded: false, holds: { listing: { 2: g } } });
    const rt = f.runtime();
    const pending = rt.open(A, { create: true });
    await g.reached;
    rt.dispose();
    g.release();
    expect(await pending).toEqual(ABANDONED);
    await f.world.settle();
    expect(f.world.idb.has(accountDatabaseName(A))).toBe(false);
    expect(f.calls.opens).toBe(0);
    expect(f.held(rt)).toEqual(NOTHING);
  });

  test("disposed while the creating upgrade has finished in the engine: the database it made stays (a creation cannot be taken back, and a deletion is the wipe's decision), its handles are let go, no service is installed and a latch set meanwhile stays", async () => {
    const g = gate();
    const f = await setup({ seeded: false, holds: { landed: { 1: g } } });
    f.page.registry.setLatch(A, "closed_for_deletion");
    const rt = f.runtime();
    const pending = rt.open(A, { create: true });
    await g.reached;
    rt.dispose();
    g.release();
    expect(await pending).toEqual(ABANDONED);
    await f.world.settle();
    expect(f.world.idb.has(accountDatabaseName(A))).toBe(true);
    expect(f.held(rt)).toEqual({ ...NOTHING, latch: "closed_for_deletion" });
  });
});

describe("R35: two opens of one account in ONE runtime keep one service", () => {
  for (const order of [
    {
      name: "the first open finishes last",
      holds: (g: Gate): Holds => ({ landed: { 1: g } }),
    },
    {
      name: "the second open finishes last",
      holds: (g: Gate): Holds => ({ landed: { 2: g } }),
    },
  ])
    test(`${order.name}: the standing service is handed to both, the duplicate store is let go, and the connections are the standing service's two`, async () => {
      const g = gate();
      const f = await setup({ holds: order.holds(g) });
      const rt = f.runtime();
      const heldCall = order.name.startsWith("the first") ? 1 : 2;
      // Start the open that is NOT held first or second so that the held one is the one that finishes last.
      const first = rt.open(A);
      if (heldCall === 1) await g.reached;
      const second = rt.open(A);
      if (heldCall === 2) await g.reached;
      const early = await (heldCall === 1 ? second : first);
      expect(early.kind).toBe("opened");
      g.release();
      const late = await (heldCall === 1 ? first : second);
      await f.world.settle();
      if (early.kind !== "opened" || late.kind !== "opened")
        throw new Error("both opens answer opened");
      expect(late.service).toBe(early.service);
      expect(f.page.registry.openCount(A)).toBe(2);
      expect(rt.serviceFor(A)).toBe(early.service);
      rt.dispose();
      expect(f.page.registry.openCount(A)).toBe(0);
    });
});

describe("R35: openAccountData for a caller that has gone", () => {
  /** An open the test drives directly, with `abandoned` as the test says. */
  async function direct(f: PendingWorld, options: OpenOptions) {
    return openAccountData(f.openDeps, A as AccountId, options);
  }

  test("a caller that is already gone starts nothing: no listing, no open", async () => {
    const f = await setup();
    expect(await direct(f, { abandoned: () => true })).toEqual(ABANDONED);
    expect(f.calls).toEqual({ listings: 0, opens: 0 });
  });

  test("control: a caller that has not gone opens, and the open lifts the latch", async () => {
    const f = await setup();
    f.page.registry.setLatch(A, "closed_for_deletion");
    const outcome = await direct(f, { abandoned: () => false });
    expect(outcome.kind).toBe("opened");
    expect(f.page.registry.latch(A)).toBe("open");
    expect(f.page.registry.openCount(A)).toBe(2);
    if (outcome.kind === "opened") outcome.store.close();
  });

  test("gone while the databases are listed: no native open, nothing registered, the latch untouched", async () => {
    const g = gate();
    const f = await setup({ holds: { listing: { 1: g } } });
    f.page.registry.setLatch(A, "closed_for_deletion");
    let gone = false;
    const pending = direct(f, { abandoned: () => gone });
    await g.reached;
    gone = true;
    g.release();
    expect(await pending).toEqual(ABANDONED);
    expect(f.calls.opens).toBe(0);
    expect(f.page.registry.openCount(A)).toBe(0);
    expect(f.page.registry.latch(A)).toBe("closed_for_deletion");
  });

  test("gone while the native open is under way: its own two connections are closed, the answer is `abandoned`, and the latch stays as it was", async () => {
    const g = gate();
    const f = await setup({ holds: { landed: { 1: g } } });
    f.page.registry.setLatch(A, "closed_for_deletion");
    let gone = false;
    const pending = direct(f, { abandoned: () => gone });
    await g.reached;
    gone = true;
    g.release();
    expect(await pending).toEqual(ABANDONED);
    expect(f.page.registry.openCount(A)).toBe(0);
    expect(f.page.registry.latch(A)).toBe("closed_for_deletion");
  });

  test("gone while the native open is under way, and ANOTHER runtime holds the account's connections: only this open's own are closed", async () => {
    const g = gate();
    const f = await setup({ holds: { landed: { 1: g } } });
    let gone = false;
    const pending = direct(f, { abandoned: () => gone });
    await g.reached;
    // A second open of the same account (the replacement's): it is call 2, which is not held.
    const standing = await f.openDeps.opener.open(A, {
      create: false,
      incarnation: "standing",
    });
    expect(standing.kind).toBe("opened");
    expect(f.page.registry.openCount(A)).toBe(4);
    gone = true;
    g.release();
    expect(await pending).toEqual(ABANDONED);
    expect(f.page.registry.openCount(A)).toBe(2);
    expect(f.page.registry.latch(A)).toBe("open");
    if (standing.kind === "opened") standing.store.close();
    expect(f.page.registry.openCount(A)).toBe(0);
  });

  test("gone while a creation waits for the wipe's lock: nothing is created, and the lock is let go", async () => {
    const f = await setup({ seeded: false });
    const wipe = f.world.page("W");
    const lock = await f.world.run(wipe.locks.acquire(LOCKS.wipe(A)));
    let gone = false;
    const pending = direct(f, { create: true, abandoned: () => gone });
    await f.world.settle();
    gone = true;
    lock?.release();
    expect(await pending).toEqual(ABANDONED);
    await f.world.settle();
    expect(f.world.idb.has(accountDatabaseName(A))).toBe(false);
    expect(await f.world.run(wipe.locks.probe(LOCKS.wipe(A)))).toBe(true);
  });

  test("an absent database is still answered `absent` (the answer of the look, with no resource to release)", async () => {
    const f = await setup({ seeded: false });
    expect(await direct(f, { abandoned: () => false })).toEqual({
      kind: "absent",
    });
  });
});
