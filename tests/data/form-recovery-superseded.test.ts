// @vitest-environment node
import { describe, expect, test } from "vitest";
import { DataRuntime } from "../../src/data/engine/account-service";
import { createQuotaGuard } from "../../src/data/engine/quota-guard";
import type { AccountStore } from "../../src/data/store/port";
import { createDataEnv } from "../../src/data/ui/env";
import { unrevokedHold } from "../../src/session";
import { identityReadWorld } from "../support/data/identity-reads";
import { ACCOUNT, pageWorld } from "../support/data/page-world";

/**
 * WEB-14a revision 1, R7 (WEB-04 8): the controller's form-recovery port after another tab's newer build has upgraded the displayed
 * account's database. The page never uses that database for anything else (D-P8: its service ends, the account is latched
 * `upgrade_pending`), but the person's form keeps a port: its saves, restores and discards go through the RECOVERY CONNECTION
 * (`deps.recovery`, `store/recovery-store.ts` in the browser), for the account and incarnation this controller last had open, and only
 * while that account is still the displayed one and still superseded. A deletion's or an identity change's closure is never stood in for,
 * and a page that never bound the account has nothing to continue.
 *
 * The production controller and runtime over the double of IndexedDB. The recovery store here is ANOTHER page context's store over the same
 * database (a fresh connection), counted; the real one is exercised in three engines by `fixture.data-schema-probe.spec.ts` (E-R7) and
 * `fixture.pwa-schema.spec.ts`.
 */
async function controller() {
  const w = await pageWorld();
  const d = identityReadWorld(w);
  const runtime = new DataRuntime({
    identity: w.identity,
    persistence: { hold: async () => unrevokedHold() },
    registry: w.page.registry,
    open: (account, options) => w.page.open(account, options),
  });
  const fresh = w.env.page("recovery");
  fresh.identity.account = ACCOUNT;
  const opened = await fresh.open(ACCOUNT);
  if (opened.kind !== "opened") throw new Error("setup");
  const runs: string[] = [];
  const recoveryStore: AccountStore = {
    account: ACCOUNT,
    incarnationId: opened.store.incarnationId,
    run: (plan, input, options) => {
      runs.push(plan.name);
      return opened.store.run(plan, input, options);
    },
    watch: (plan, input) => opened.store.watch(plan, input),
    close: () => undefined,
  };
  const asked: string[] = [];
  const latchListeners = new Set<() => void>();
  const offLatch = w.page.registry.onLatch(() => {
    for (const listener of [...latchListeners]) listener();
  });
  const env = createDataEnv({
    identity: w.identity,
    online: { get: () => true, subscribe: () => () => undefined },
    onOnline: d.onOnline,
    loadRuntime: async () => runtime,
    quota: createQuotaGuard({
      storage: { estimate: async () => ({ usage: 0, quota: 1e9 }) },
      now: d.clock.now,
    }),
    timers: d.timers,
    clock: { ...d.clock, iso: () => new Date(d.clock.now()).toISOString() },
    ids: { uuid: () => crypto.randomUUID() },
    fence: () => ({ hasPendingOperation: false, sessionStarted: true }),
    readMe: async () => ({ kind: "unrecognised" }),
    currentDeviceId: async () => ({ kind: "closed" }),
    // As the browser composition answers: a store only while the account is latched `upgrade_pending`.
    recovery: {
      storeFor: (account, incarnationId) => {
        asked.push(`${account}:${incarnationId}`);
        return w.page.registry.latch(account) === "upgrade_pending"
          ? recoveryStore
          : null;
      },
      subscribe: (listener) => {
        latchListeners.add(listener);
        return () => latchListeners.delete(listener);
      },
    },
  });
  const settle = async () => {
    for (let i = 0; i < 20; i += 1) await w.env.settle();
  };
  const save = (title: string) =>
    env.formRecovery.save({
      formContext: "task-edit:/tasks/1",
      tabInstanceId: "tab-a",
      values: { title },
      savedAt: new Date(d.clock.now()).toISOString(),
    });
  return {
    w,
    env,
    runs,
    asked,
    settle,
    save,
    incarnation: opened.store.incarnationId,
    end() {
      offLatch();
      env.dispose();
      runtime.dispose();
    },
  };
}

describe("the form keeps its recovery path when a newer build supersedes the database (R7)", () => {
  test("open: the port reaches the service; superseded: it reaches the recovery connection, for the incarnation last open", async () => {
    const t = await controller();
    await t.settle();
    expect(t.env.service()).not.toBeNull();
    expect(t.env.formRecoveryOpen.get()).toBe(true);
    expect(await t.save("while open")).toBe("saved");
    expect(t.runs).toEqual([]);
    t.w.page.registry.closeAll(ACCOUNT, { latch: "upgrade_pending" });
    await t.settle();
    // The page uses the database for nothing else; the form keeps a port.
    expect(t.env.service()).toBeNull();
    expect(t.env.formRecoveryOpen.get()).toBe(true);
    expect(await t.save("after the upgrade")).toBe("saved");
    expect(t.runs).toContain("data.saveFormRecovery");
    expect(t.asked.at(-1)).toBe(`${ACCOUNT}:${t.incarnation}`);
    expect(
      (await t.env.formRecovery.list("task-edit:/tasks/1")).map(
        (copy) => copy.values.title,
      ),
    ).toEqual(["after the upgrade"]);
    t.end();
  });

  test("the identity leaves the account: the port is withdrawn, and nothing goes through the recovery connection", async () => {
    const t = await controller();
    await t.settle();
    t.w.page.registry.closeAll(ACCOUNT, { latch: "upgrade_pending" });
    await t.settle();
    expect(t.env.formRecoveryOpen.get()).toBe(true);
    t.w.identity.move({ account: null, epoch: 1 });
    await t.settle();
    expect(t.env.formRecoveryOpen.get()).toBe(false);
    const before = t.runs.length;
    expect(await t.save("signed out")).toBe("failed");
    expect(t.runs.length).toBe(before);
    t.end();
  });

  test.each(["closed_for_deletion", "closed_for_identity"] as const)(
    "a %s closure is never stood in for",
    async (latch) => {
      const t = await controller();
      await t.settle();
      t.w.page.registry.closeAll(ACCOUNT, { latch });
      await t.settle();
      expect(t.env.service()).toBeNull();
      expect(t.env.formRecoveryOpen.get()).toBe(false);
      expect(await t.save("closed")).toBe("failed");
      expect(t.runs).toEqual([]);
      t.end();
    },
  );

  test("superseded, then deleted (a wipe): the port is withdrawn when the latch changes", async () => {
    const t = await controller();
    await t.settle();
    t.w.page.registry.closeAll(ACCOUNT, { latch: "upgrade_pending" });
    await t.settle();
    expect(t.env.formRecoveryOpen.get()).toBe(true);
    t.w.page.registry.closeAll(ACCOUNT, { latch: "closed_for_deletion" });
    await t.settle();
    expect(t.env.formRecoveryOpen.get()).toBe(false);
    expect(await t.save("after the wipe")).toBe("failed");
    t.end();
  });
});
