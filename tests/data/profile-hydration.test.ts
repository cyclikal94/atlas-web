// @vitest-environment node
import { describe, expect, test } from "vitest";
import type { ReadResult } from "../../src/data/engine/identity-task";
import {
  createProfileSource,
  type ProfileSource,
} from "../../src/data/engine/profile-source";
import { createQuotaGuard } from "../../src/data/engine/quota-guard";
import type {
  SyncChannel,
  SyncMessage,
} from "../../src/data/engine/sync-channel";
import { accountDatabaseName } from "../../src/data/model/schema";
import type { ProfileState, SyncStateRow } from "../../src/data/model/types";
import { createDataEnv } from "../../src/data/ui/env";
import type { Identity, Store } from "../../src/session";
import { DataTestWorld } from "../support/data/env";
import { EPOCH_BASE } from "../support/session/env";

/**
 * R17 (revision 8): a page that starts OFFLINE shows the name verified earlier IN THE SAME EPOCH, without a request. The controller
 * loads its runtime and opens the account's database a little AFTER the profile source starts, so the source has to read the profile
 * when the database becomes available and not only when it starts. These run the production controller, runtime, plans and source over
 * the double of IndexedDB, with the real asynchronous binding; the reviewer's own probe (`profile-offline.test.ts`) is the control.
 *
 * FIXTURE evidence: the platform is a double, and no request is ever made by the offline cases (the script of `GET /me` is checked).
 */
const ACCOUNT = "11111111-1111-4111-8111-111111111111";
const NAME = accountDatabaseName(ACCOUNT);

class Cell<T> implements Store<T> {
  private listeners = new Set<() => void>();
  constructor(private value: T) {}
  get() {
    return this.value;
  }
  set(next: T) {
    this.value = next;
    for (const l of [...this.listeners]) l();
  }
  subscribe(l: () => void) {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
}

interface Options {
  database?: boolean;
  online?: boolean;
  epoch?: number;
  /** A name persisted in the database before the page starts. */
  persisted?: Pick<ProfileState, "username" | "verified_epoch"> | null;
  /** `GET /me` does not answer until `release` is called. */
  holdMe?: boolean;
  /** What `GET /me` answers, in order, from the page's first request (a failed read when they run out). */
  answers?: ReadResult<unknown>[];
}

async function setup(options: Options = {}) {
  const world = new DataTestWorld();
  world.idb.autoDrive = true;
  const page = world.page("A");
  const epoch = options.epoch ?? 1;
  const identity = new Cell<Identity | null>({
    account_id: ACCOUNT,
    epoch,
    session_id: "s",
  });
  page.identity.account = ACCOUNT;
  page.identity.epoch = epoch;
  const create = async () => {
    const created = await page.open(ACCOUNT, { create: true });
    if (created.kind !== "opened") throw new Error("setup");
    await world.settle();
    if (options.persisted) {
      const sync = world.idb.peek(
        NAME,
        "sync_state",
        "singleton",
      ) as SyncStateRow;
      world.idb.seed(NAME, "sync_state", [
        {
          ...sync,
          profile: { ...options.persisted, verified_at: 5 },
        },
      ]);
    }
  };
  if (options.database !== false) await create();
  const runtime = new world.modules.accountService.DataRuntime({
    identity,
    persistence: world.modules.accountService.unorderedPersistence,
    registry: page.registry,
    open: (account, o) => page.open(account, o),
  });
  const online = new Cell(options.online !== false);
  const onlineListeners = new Set<() => void>();
  const messages = new Set<(m: SyncMessage) => void>();
  const channel: SyncChannel = {
    post: () => undefined,
    subscribe: (l) => {
      messages.add(l);
      return () => messages.delete(l);
    },
  };
  const asked: Array<[string, number]> = [];
  const answers: ReadResult<unknown>[] = [...(options.answers ?? [])];
  const held: Array<(result: ReadResult<unknown>) => void> = [];
  const cancelled = new Set<number>();
  let seq = 0;
  const env = createDataEnv({
    identity,
    loadRuntime: async () => runtime,
    online,
    quota: createQuotaGuard({
      storage: { estimate: async () => ({ usage: 0, quota: 1e9 }) },
      now: () => EPOCH_BASE + world.world.time,
    }),
    ids: { uuid: () => crypto.randomUUID() },
    clock: {
      iso: () => new Date(EPOCH_BASE + world.world.time).toISOString(),
      now: () => EPOCH_BASE + world.world.time,
      random: () => 0.5,
    },
    fence: () => ({ hasPendingOperation: false, sessionStarted: true }),
    readMe: async (account, e) => {
      asked.push([account, e]);
      if (options.holdMe)
        return new Promise<ReadResult<unknown>>((resolve) => {
          held.push(resolve);
        });
      return answers.shift() ?? { kind: "failure" };
    },
    currentDeviceId: async () => ({ kind: "closed" }),
    onOnline: (l) => {
      onlineListeners.add(l);
      return () => {
        onlineListeners.delete(l);
      };
    },
    channel,
    timers: {
      setTimeout: (fn, ms) => {
        seq += 1;
        const id = seq;
        world.world.schedule(
          "timer",
          "A",
          { timer: id },
          () => {
            if (!cancelled.has(id)) fn();
          },
          ms,
        );
        return id;
      },
      clearTimeout: (handle) => {
        cancelled.add(handle as number);
      },
    },
  });
  const settle = async () => {
    for (let i = 0; i < 20; i += 1) await world.settle();
  };
  const advance = async (ms: number) => {
    await world.world.advance(ms);
    await settle();
  };
  return {
    world,
    page,
    identity,
    env,
    online,
    asked,
    answers,
    release: (result: ReadResult<unknown>) => held.shift()?.(result),
    messages,
    settle,
    advance,
    create,
    goOnline() {
      online.set(true);
      for (const l of [...onlineListeners]) l();
    },
    label: () => env.profile.labelFor(identity.get()),
    persisted: () =>
      (
        world.idb.peek(NAME, "sync_state", "singleton") as
          | SyncStateRow
          | undefined
      )?.profile ?? null,
  };
}

const body = (username: string) => ({
  id: ACCOUNT,
  username,
  has_password: true,
  oidc_issuers: [],
});

describe("R17: an offline start shows the name verified for this epoch", () => {
  test("the production controller hydrates it once the database is bound, with no request and no creation of anything", async () => {
    const t = await setup({
      online: false,
      persisted: { username: "Offline Alice", verified_epoch: 1 },
    });
    await t.settle();
    expect(t.env.service()).not.toBeNull();
    expect(t.label()).toBe("Offline Alice");
    // Held through the reviewer's 60 seconds of simulated time, and still nothing was asked.
    await t.advance(60_000);
    expect(t.label()).toBe("Offline Alice");
    expect(t.asked).toEqual([]);
    t.env.dispose();
  });

  test("R16 (revision 11): the binding ends and returns: nothing is asked while it is gone, and the persisted name is shown again once the look lands", async () => {
    const t = await setup({
      online: false,
      persisted: { username: "Offline Alice", verified_epoch: 1 },
    });
    await t.settle();
    expect(t.label()).toBe("Offline Alice");
    // The service ends (a latch, or the page's own close): what a look found belongs to that binding and ends with it.
    t.env.service()?.dispose("closed");
    await t.settle();
    expect(t.env.service()).toBeNull();
    await t.advance(60_000);
    expect(t.asked).toEqual([]);
    // The identity is published again, as the session does at every evaluation: the look lands and the name is read from the database.
    t.identity.set({ account_id: ACCOUNT, epoch: 1, session_id: "s" });
    await t.settle();
    expect(t.env.service()).not.toBeNull();
    expect(t.label()).toBe("Offline Alice");
    await t.advance(60_000);
    expect(t.asked).toEqual([]);
    t.env.dispose();
  });

  test("a name persisted for an OLDER epoch stays hidden", async () => {
    const t = await setup({
      online: false,
      epoch: 2,
      persisted: { username: "Old Alice", verified_epoch: 1 },
    });
    await t.advance(60_000);
    expect(t.env.service()).not.toBeNull();
    expect(t.label()).toBeNull();
    expect(t.env.profile.profile.get()).toBeNull();
    expect(t.asked).toEqual([]);
    t.env.dispose();
  });

  test("a name persisted for a NEWER epoch than the identity's is not shown either", async () => {
    const t = await setup({
      online: false,
      epoch: 1,
      persisted: { username: "New Alice", verified_epoch: 2 },
    });
    await t.advance(10_000);
    expect(t.label()).toBeNull();
    t.env.dispose();
  });

  test("with nothing persisted nothing is shown, and still nothing is asked", async () => {
    const t = await setup({ online: false, persisted: null });
    await t.advance(60_000);
    expect(t.label()).toBeNull();
    expect(t.asked).toEqual([]);
    t.env.dispose();
  });

  test("with no database at all nothing is shown, nothing is asked, and the database is NOT created", async () => {
    const t = await setup({
      online: false,
      database: false,
      persisted: { username: "Offline Alice", verified_epoch: 1 },
    });
    await t.advance(60_000);
    expect(t.env.service()).toBeNull();
    expect(t.label()).toBeNull();
    expect(t.asked).toEqual([]);
    expect(t.world.idb.has(NAME)).toBe(false);
    t.env.dispose();
  });

  test("a database that another tab creates LATER is read when it appears, not only at start", async () => {
    const t = await setup({
      online: false,
      database: false,
      persisted: { username: "Offline Alice", verified_epoch: 1 },
    });
    await t.advance(5_000);
    expect(t.label()).toBeNull();
    // Another tab creates the database (the first sync); this page hears of it and opens it, never creating it.
    await t.create();
    for (const listener of [...t.messages])
      listener({ type: "data_changed", account: ACCOUNT, stores: ["cache"] });
    await t.settle();
    expect(t.env.service()).not.toBeNull();
    expect(t.label()).toBe("Offline Alice");
    expect(t.asked).toEqual([]);
    t.env.dispose();
  });

  test("the identity moving while the read is pending: the answer is discarded, and the new epoch shows only its own name", async () => {
    const t = await setup({
      online: false,
      persisted: { username: "Offline Alice", verified_epoch: 1 },
    });
    // Hold the profile read of the page's database until the identity has moved.
    t.world.world.setKnob(
      "store_start",
      "unbounded",
      (meta) => (meta as { label?: string }).label === "data.readProfile",
    );
    await t.settle();
    expect(t.env.service()).not.toBeNull();
    expect(t.label()).toBeNull();
    t.page.identity.epoch = 2;
    t.identity.set({ account_id: ACCOUNT, epoch: 2, session_id: "s" });
    t.world.world.release(
      "store_start",
      (meta) => (meta as { label?: string }).label === "data.readProfile",
    );
    t.world.world.clearKnobs();
    await t.settle();
    // The name was verified for epoch 1: it is not shown for epoch 2, and it is never shown for the identity it was read for either.
    expect(t.label()).toBeNull();
    expect(
      t.env.profile.labelFor({
        account_id: ACCOUNT,
        epoch: 1,
        session_id: "s",
      }),
    ).toBeNull();
    t.env.dispose();
  });

  test("an identity that signs out while the read is pending shows nothing", async () => {
    const t = await setup({
      online: false,
      persisted: { username: "Offline Alice", verified_epoch: 1 },
    });
    t.world.world.setKnob(
      "store_start",
      "unbounded",
      (meta) => (meta as { label?: string }).label === "data.readProfile",
    );
    await t.settle();
    t.identity.set(null);
    t.world.world.release(
      "store_start",
      (meta) => (meta as { label?: string }).label === "data.readProfile",
    );
    t.world.world.clearKnobs();
    await t.settle();
    expect(t.env.profile.profile.get()).toBeNull();
    t.env.dispose();
  });

  test("the control: a standalone source whose service is already bound hydrates at once", async () => {
    const t = await setup({
      online: false,
      persisted: { username: "Offline Alice", verified_epoch: 1 },
    });
    await t.settle();
    const service = t.env.service();
    expect(service).not.toBeNull();
    const source: ProfileSource = createProfileSource({
      identity: t.identity,
      readMe: async () => {
        throw new Error("no offline request");
      },
      online: () => false,
      onOnline: () => () => undefined,
      service: () => service,
      clock: { now: () => 100 },
    });
    const stop = source.start();
    await t.settle();
    expect(source.labelFor(t.identity.get())).toBe("Offline Alice");
    stop();
    t.env.dispose();
  });
});

describe("the same hydration when the page is online", () => {
  test("the persisted name shows while `GET /me` is still in flight, and the verified answer then replaces it and is written", async () => {
    const t = await setup({
      online: true,
      holdMe: true,
      persisted: { username: "Old Name", verified_epoch: 1 },
    });
    await t.settle();
    expect(t.asked).toEqual([[ACCOUNT, 1]]);
    expect(t.label()).toBe("Old Name");
    t.release({ kind: "ok", value: body("New Name") });
    await t.settle();
    expect(t.label()).toBe("New Name");
    expect(t.persisted()).toMatchObject({
      username: "New Name",
      verified_epoch: 1,
    });
    t.env.dispose();
  });

  test("a page that starts offline and comes online verifies, replaces the persisted name and writes the new one", async () => {
    const t = await setup({
      online: false,
      persisted: { username: "Old Name", verified_epoch: 1 },
    });
    await t.settle();
    expect(t.label()).toBe("Old Name");
    expect(t.asked).toEqual([]);
    t.answers.push({ kind: "ok", value: body("New Name") });
    t.goOnline();
    await t.settle();
    expect(t.label()).toBe("New Name");
    expect(t.persisted()?.username).toBe("New Name");
    t.env.dispose();
  });

  test("a name verified BEFORE the database was open is written to it when it opens, if it is this epoch's and not already there", async () => {
    const t = await setup({
      online: true,
      database: false,
      answers: [{ kind: "ok", value: body("kieran") }],
    });
    await t.settle();
    // The answer landed with no database open: the label is in memory only.
    expect(t.label()).toBe("kieran");
    expect(t.world.idb.has(NAME)).toBe(false);
    await t.create();
    for (const listener of [...t.messages])
      listener({ type: "data_changed", account: ACCOUNT, stores: ["cache"] });
    await t.settle();
    expect(t.env.service()).not.toBeNull();
    expect(t.persisted()).toMatchObject({
      username: "kieran",
      verified_epoch: 1,
    });
    t.env.dispose();
  });

  test("a name already persisted for this epoch is not written again", async () => {
    const t = await setup({
      online: true,
      database: false,
      persisted: { username: "kieran", verified_epoch: 1 },
      answers: [{ kind: "ok", value: body("kieran") }],
    });
    await t.settle();
    await t.create();
    const before = JSON.stringify(t.persisted());
    for (const listener of [...t.messages])
      listener({ type: "data_changed", account: ACCOUNT, stores: ["cache"] });
    await t.settle();
    expect(JSON.stringify(t.persisted())).toBe(before);
    t.env.dispose();
  });
});
