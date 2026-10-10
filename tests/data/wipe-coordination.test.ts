// @vitest-environment node
import { describe, expect, test } from "vitest";
import { parseSyncMessage } from "../../src/data/engine/sync-channel";
import { attachWipeResponder } from "../../src/data/engine/wipe-responder";
import { accountDatabaseName } from "../../src/data/model/schema";
import { createPortsImpl } from "../../src/data/ports/ports-impl";
import { createRegistry } from "../../src/data/store/registry";
import { DataTestWorld } from "../support/data/env";
import { draftRow } from "../support/data/rows";

const ACCOUNT = "11111111-1111-4111-8111-111111111111";
const NAME = accountDatabaseName(ACCOUNT);

/**
 * The coordinated-closure protocol of the canonical wipe (plan 5.3.3), over the fake world with REAL tabs: a coordinating page
 * (the one that is wiping) and other tabs that hold the account's database open and run the wipe responder.
 */
async function origin(tabs: string[]) {
  const env = new DataTestWorld();
  const coordinator = env.page("A");
  coordinator.identity.account = ACCOUNT;
  const created = await env.run(coordinator.open(ACCOUNT, { create: true }));
  if (created.kind !== "opened") throw new Error("setup");
  created.store.close();
  env.idb.seed(NAME, "drafts", [draftRow({ status: "queued" })]);
  const others = [];
  for (const id of tabs) {
    const tab = env.page(id);
    tab.identity.account = ACCOUNT;
    const opened = await env.run(tab.open(ACCOUNT));
    if (opened.kind !== "opened") throw new Error("setup");
    const signing: string[] = [];
    attachWipeResponder({
      channel: env.bus.channelFor(id),
      registry: tab.registry,
      onSigningOut: (account) => signing.push(account),
    });
    others.push({ id, tab, signing, store: opened.store });
  }
  const impl = createPortsImpl({
    openExisting: async (account) => {
      const opened = await env.idb
        .openerForPage("A", createRegistry("port"))
        .open(account, { create: false, single: true, incarnation: "x" });
      return opened.kind === "opened" ? opened.store : null;
    },
    channel: env.bus.channelFor("A"),
    registry: coordinator.registry,
    clock: {
      now: () => env.world.time,
      sleep: (ms) =>
        new Promise((resolve) =>
          env.world.schedule("timer", "A", {}, resolve, ms),
        ),
    },
    ids: { uuid: () => crypto.randomUUID() },
    graceMs: 150,
  });
  return { env, impl, others };
}

describe("the closure protocol", () => {
  test("a present tab closes ALL its connections on `wipe_imminent`, tells its page, and the wait ends on its acknowledgement (not at the bound)", async () => {
    const { env, impl, others } = await origin(["B"]);
    const [b] = others as [(typeof others)[number]];
    impl.coordination.broadcastImminent(ACCOUNT, "op-1");
    await env.run(impl.coordination.setClosing(ACCOUNT));
    await env.world.advance(150);
    const before = env.world.time;
    await env.run(impl.coordination.waitForClosure(ACCOUNT, 5_000));
    expect(
      env.world.time - before,
      "the wait must end on the acknowledgement, not at the 5 s bound",
    ).toBeLessThan(1_000);
    expect(b.tab.registry.latch(ACCOUNT)).toBe("closed_for_deletion");
    expect(b.tab.registry.openCount(ACCOUNT)).toBe(0);
    expect(b.signing).toEqual([ACCOUNT]);
    // The delete can now complete.
    expect(await env.run(b.tab.host.delete(NAME))).toBe("deleted");
  });

  test("`closing` is committed BEFORE the broadcast can be observed by any tab", async () => {
    const { env, impl } = await origin(["B"]);
    impl.coordination.broadcastImminent(ACCOUNT, "op-1");
    await env.run(impl.coordination.setClosing(ACCOUNT));
    await env.world.runUntilIdle();
    const log = env.world.logs;
    const closingCommit = log.find(
      (e) =>
        e.type === "idb.commit" &&
        e.label === "data.setClosing" &&
        e.wrote === true,
    );
    const posted = log.find(
      (e) =>
        e.type === "sync.post" &&
        (e.message as { type: string }).type === "wipe_imminent",
    );
    const delivered = log.find(
      (e) =>
        e.type === "sync.deliver" &&
        (e.message as { type: string }).type === "wipe_imminent",
    );
    expect(closingCommit).toBeDefined();
    expect(posted).toBeDefined();
    expect(delivered).toBeDefined();
    expect((closingCommit?.seq ?? 0) < (posted?.seq ?? 0)).toBe(true);
    expect((posted?.seq ?? 0) < (delivered?.seq ?? 0)).toBe(true);
    expect(
      env.idb.peek(NAME, "sync_state", "singleton")?.draft_fence?.closing,
    ).toBe(true);
  });

  test("a frozen tab that never acknowledges is waited for only to the bound, and the delete completes the moment it wakes", async () => {
    const { env, impl, others } = await origin(["B", "C"]);
    const [b, c] = others as [(typeof others)[number], (typeof others)[number]];
    impl.coordination.broadcastImminent(ACCOUNT, "op-1");
    await env.world.runUntilIdle(); // both answered the presence query
    env.world.setFrozen("C", true); // C froze after answering: it will not acknowledge
    await env.run(impl.coordination.setClosing(ACCOUNT));
    const start = env.world.time;
    let done = false;
    const waiting = impl.coordination
      .waitForClosure(ACCOUNT, 5_000)
      .then(() => {
        done = true;
      });
    await env.world.advance(4_900);
    expect(done, "still waiting for the frozen tab").toBe(false);
    await env.world.advance(200);
    await waiting;
    expect(env.world.time - start).toBeGreaterThanOrEqual(5_000);
    expect(b.tab.registry.openCount(ACCOUNT)).toBe(0);
    expect(c.tab.registry.openCount(ACCOUNT)).toBe(2);
    // The delete cannot complete while the frozen tab holds a connection; it completes the moment the tab wakes and closes.
    let result: string | null = null;
    const deleting = b.tab.host.delete(NAME).then((r) => {
      result = r;
    });
    await env.world.runUntilIdle();
    await env.world.advance(60_000);
    expect(result).toBeNull();
    env.world.setFrozen("C", false);
    await env.world.runUntilIdle();
    await deleting;
    expect(result).toBe("blocked_then_deleted");
  });

  test("with no other tab there is nothing to wait for: it ends after the presence grace and sleeps no further", async () => {
    const { env, impl } = await origin([]);
    impl.coordination.broadcastImminent(ACCOUNT, "op-1");
    await env.run(impl.coordination.setClosing(ACCOUNT));
    await env.world.advance(150);
    const before = env.world.time;
    await env.run(impl.coordination.waitForClosure(ACCOUNT, 5_000));
    expect(env.world.time - before).toBe(0);
  });

  test("a tab with no open connection for the account does not answer the presence query", async () => {
    const { env, impl, others } = await origin(["B"]);
    const [b] = others as [(typeof others)[number]];
    b.tab.registry.closeAll(ACCOUNT, { latch: "closed_for_identity" });
    impl.coordination.broadcastImminent(ACCOUNT, "op-1");
    await env.world.runUntilIdle();
    const answers = env.bus.posted.filter((p) => p.message.type === "presence");
    expect(answers).toEqual([]);
  });

  test("another account's wipe does not touch this account's connections", async () => {
    const { env, impl, others } = await origin(["B"]);
    const [b] = others as [(typeof others)[number]];
    const other = "22222222-2222-4222-8222-222222222222";
    impl.coordination.broadcastImminent(other, "op-2");
    await env.run(impl.coordination.setClosing(other));
    await env.world.runUntilIdle();
    expect(b.tab.registry.latch(ACCOUNT)).toBe("open");
    expect(b.tab.registry.openCount(ACCOUNT)).toBe(2);
  });
});

describe("R12: the durable closing flag is a precondition, and a failure to set it is answered, not swallowed", () => {
  const closingOf = (env: Awaited<ReturnType<typeof origin>>["env"]) =>
    env.idb.peek(NAME, "sync_state", "singleton")?.draft_fence?.closing;
  const imminent = (env: Awaited<ReturnType<typeof origin>>["env"]) =>
    env.world.logs.filter(
      (e) =>
        e.type === "sync.post" &&
        (e.message as { type: string }).type === "wipe_imminent",
    );

  for (const mode of ["abort", "error", "quota"] as const) {
    test(`a failed closing write (${mode}) is answered "unconfirmed": no flag, no announcement, no tab is told to close`, async () => {
      const { env, impl, others } = await origin(["B"]);
      const [b] = others as [(typeof others)[number]];
      env.idb.inject({
        match: (tx) => tx.label === "data.setClosing",
        mode,
        times: 1,
      });
      impl.coordination.broadcastImminent(ACCOUNT, "op-1");
      expect(await env.run(impl.coordination.setClosing(ACCOUNT))).toBe(
        "unconfirmed",
      );
      await env.world.runUntilIdle();
      expect(closingOf(env)).not.toBe(true);
      // `wipe_imminent` says "the flag is set": it is not posted for a flag that is not, so no tab closes on it or latches.
      expect(imminent(env)).toEqual([]);
      expect(b.tab.registry.latch(ACCOUNT)).toBe("open");
      expect(b.tab.registry.openCount(ACCOUNT)).toBe(2);
      expect(b.signing).toEqual([]);
    });

    test(`and the next ask, with the fault gone (${mode}), sets the flag durably and only then announces it`, async () => {
      const { env, impl, others } = await origin(["B"]);
      const [b] = others as [(typeof others)[number]];
      env.idb.inject({
        match: (tx) => tx.label === "data.setClosing",
        mode,
        times: 1,
      });
      impl.coordination.broadcastImminent(ACCOUNT, "op-1");
      expect(await env.run(impl.coordination.setClosing(ACCOUNT))).toBe(
        "unconfirmed",
      );
      expect(await env.run(impl.coordination.setClosing(ACCOUNT))).toBe(
        "closing",
      );
      await env.world.runUntilIdle();
      expect(closingOf(env)).toBe(true);
      expect(imminent(env)).toHaveLength(1);
      expect(b.tab.registry.latch(ACCOUNT)).toBe("closed_for_deletion");
    });
  }

  test("a closing write that keeps failing never becomes a flag, however many times it is asked", async () => {
    const { env, impl } = await origin([]);
    env.idb.inject({
      match: (tx) => tx.label === "data.setClosing",
      mode: "error",
      times: 20,
    });
    for (let i = 0; i < 20; i += 1)
      expect(await env.run(impl.coordination.setClosing(ACCOUNT))).toBe(
        "unconfirmed",
      );
    expect(closingOf(env)).not.toBe(true);
    expect(imminent(env)).toEqual([]);
  });

  test("a recovery writer that has not heard anything is still excluded by the flag once it IS durable (the control)", async () => {
    const { env, impl } = await origin([]);
    expect(await env.run(impl.coordination.setClosing(ACCOUNT))).toBe(
      "closing",
    );
    expect(closingOf(env)).toBe(true);
  });

  test("an account with no database has nothing to close: the answer is `closing` and nothing is created", async () => {
    const { env, impl } = await origin([]);
    const other = "33333333-3333-4333-8333-333333333333";
    expect(await env.run(impl.coordination.setClosing(other))).toBe("closing");
    expect(
      env.idb.peek(accountDatabaseName(other), "sync_state", "singleton"),
    ).toBeUndefined();
  });
});

describe("the message union is closed and carries no content", () => {
  test("only the five known shapes parse; anything else is ignored", () => {
    expect(
      parseSyncMessage({
        type: "wipe_imminent",
        account: "a",
        operation_id: "o",
      }),
    ).not.toBeNull();
    expect(
      parseSyncMessage({ type: "closed_ack", account: "a", tab_id: "t" }),
    ).not.toBeNull();
    expect(
      parseSyncMessage({ type: "presence_query", account: "a", nonce: "n" }),
    ).not.toBeNull();
    expect(
      parseSyncMessage({
        type: "presence",
        account: "a",
        tab_id: "t",
        nonce: "n",
      }),
    ).not.toBeNull();
    expect(
      parseSyncMessage({
        type: "data_changed",
        account: "a",
        stores: ["drafts"],
      }),
    ).not.toBeNull();
    for (const bad of [
      null,
      "x",
      42,
      {},
      { type: "unknown" },
      { type: "wipe_imminent", account: "a" },
      { type: "wipe_imminent", account: 1, operation_id: "o" },
      { type: "data_changed", account: "a", stores: "drafts" },
      {
        type: "data_changed",
        account: "a",
        stores: Array.from({ length: 17 }, () => "x"),
      },
      { type: "closed_ack", account: "", tab_id: "t" },
    ])
      expect(parseSyncMessage(bad), JSON.stringify(bad)).toBeNull();
  });
  test("extra fields are dropped on parse (no content can ride along)", () => {
    expect(
      parseSyncMessage({
        type: "closed_ack",
        account: "a",
        tab_id: "t",
        secret: "x",
      }),
    ).toEqual({
      type: "closed_ack",
      account: "a",
      tab_id: "t",
    });
  });
});
