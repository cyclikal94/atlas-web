// @vitest-environment node
import { describe, expect, test } from "vitest";
import { startDeviceMirror } from "../../src/data/engine/device-mirror";
import type { ReadResult } from "../../src/data/engine/identity-task";
import {
  createProfileSource,
  parseAccountIdentity,
} from "../../src/data/engine/profile-source";
import { accountDatabaseName } from "../../src/data/model/schema";
import { identityReadWorld, ok } from "../support/data/identity-reads";
import { pageWorld } from "../support/data/page-world";

/**
 * F-P1 and F-P2 (plan 8.7): the verified profile label and the device mirror, through the production plans and the commit guard
 * over the double of IndexedDB. FIXTURE evidence: `GET /me` and the sessions list are scripted here; the released backend is I-P1.
 */
const ACCOUNT = "11111111-1111-4111-8111-111111111111";

/** A scripted `GET /me`: a body is an answer, `null` is a failed read, and a classified result is itself. */
class Script {
  private queue: ReadResult<unknown>[] = [];
  push(...items: unknown[]): void {
    for (const item of items)
      this.queue.push(
        item === null
          ? { kind: "failure" }
          : typeof item === "object" &&
              item !== null &&
              "kind" in item &&
              typeof (item as { kind: unknown }).kind === "string"
            ? (item as ReadResult<unknown>)
            : ok(item),
      );
  }
  next(): ReadResult<unknown> {
    return this.queue.shift() ?? { kind: "closed" };
  }
}

async function setup(options: { database?: boolean } = {}) {
  const w = await pageWorld({ epoch: 1 });
  const reads = identityReadWorld(w, { database: options.database });
  const me = new Script();
  const asked: Array<[string, number]> = [];
  const traces: string[] = [];
  const source = createProfileSource({
    identity: w.identity,
    readMe: async (account, epoch) => {
      asked.push([account, epoch]);
      return me.next();
    },
    online: reads.online,
    onOnline: reads.onOnline,
    onService: reads.onService,
    service: reads.service,
    clock: { now: () => 1_000, random: reads.clock.random },
    timers: reads.timers,
    trace: { emit: (event: string) => traces.push(event) } as never,
  });
  const online = {
    get value() {
      return reads.state.online;
    },
    set value(next: boolean) {
      reads.state.online = next;
    },
  };
  return {
    w,
    online,
    reads,
    me,
    asked,
    traces,
    source,
    goOnline: reads.goOnline,
  };
}
const settle = async (w: Awaited<ReturnType<typeof setup>>["w"]) => {
  for (let i = 0; i < 10; i += 1) await w.env.settle();
};
const body = (username: string, id = ACCOUNT) => ({
  id,
  username,
  has_password: true,
  oidc_issuers: [],
});

describe("F-P1: the profile label is shown only while it is verified for THIS epoch", () => {
  test("nothing is shown before verification, and never anything derived from the opaque account id", async () => {
    const t = await setup();
    expect(t.source.labelFor(t.w.identity.get())).toBeNull();
    t.online.value = false;
    const stop = t.source.start();
    await settle(t.w);
    expect(t.source.labelFor(t.w.identity.get())).toBeNull();
    stop();
  });

  test("it is verified once per (account, epoch), shown for that epoch, and a new epoch hides it until it is verified again", async () => {
    const t = await setup();
    t.me.push(body("kieran"), body("kieran-renamed"));
    const stop = t.source.start();
    await settle(t.w);
    expect(t.asked).toEqual([[ACCOUNT, 1]]);
    expect(t.source.labelFor(t.w.identity.get())).toBe("kieran");
    // A re-authentication within the account: a NEW epoch. The older epoch's name is not shown for it...
    t.w.identity.move({ account: ACCOUNT, epoch: 2 });
    expect(t.source.labelFor(t.w.identity.get())).toBeNull();
    await settle(t.w);
    // ...and it is re-verified (never trusted from before).
    expect(t.asked).toEqual([
      [ACCOUNT, 1],
      [ACCOUNT, 2],
    ]);
    expect(t.source.labelFor(t.w.identity.get())).toBe("kieran-renamed");
    // Notifications for the same identity do not read again.
    t.w.identity.move({ account: ACCOUNT, epoch: 2 });
    await settle(t.w);
    expect(t.asked).toHaveLength(2);
    stop();
  });

  test("it is shown for no OTHER account or identity, and not when signed out", async () => {
    const t = await setup();
    t.me.push(body("kieran"));
    const stop = t.source.start();
    await settle(t.w);
    expect(
      t.source.labelFor({ account_id: "other", epoch: 1, session_id: "s" }),
    ).toBeNull();
    expect(t.source.labelFor(null)).toBeNull();
    stop();
  });

  // R18 ADAPTATION of "a body whose id is not the account, or that is not a profile, is REJECTED and not asked again" (the original
  // asserted that a single such answer completed the task and that `online` asked nothing more). Its intent, that such a body is never
  // shown and never taken for a verification, is kept in the first three assertions; the second half is replaced by the reconciliation's
  // rule for a response outside the contract: it is an UNRECOGNISED answer, counted in the caller's budget, three in a row pause the
  // caller, and `online` does not end that pause.
  test("a body whose id is not the account, or that is not a profile, is never shown and never a verification: it is an unrecognised answer, counted, and three in a row pause the caller", async () => {
    const t = await setup();
    t.me.push(
      body("someone", "99999999-9999-4999-8999-999999999999"),
      { id: ACCOUNT },
      { id: ACCOUNT, username: 42 },
    );
    const stop = t.source.start();
    await settle(t.w);
    expect(t.source.labelFor(t.w.identity.get())).toBeNull();
    expect(t.traces).toContain("data.profile_rejected");
    expect(t.asked).toHaveLength(1);
    expect(t.w.sync().read_retry_states["profile:1"]).toMatchObject({
      unrecognised_streak: 1,
      paused: false,
    });
    await t.w.env.world.advance(60_000);
    await settle(t.w);
    expect(t.asked).toHaveLength(3);
    expect(t.source.labelFor(t.w.identity.get())).toBeNull();
    expect(t.w.sync().read_retry_states["profile:1"]).toMatchObject({
      unrecognised_streak: 3,
      paused: true,
    });
    // `online` does not end a pause that unrecognised answers caused, and nothing is asked again.
    t.goOnline();
    await t.w.env.world.advance(3_600_000);
    await settle(t.w);
    expect(t.asked).toHaveLength(3);
    stop();
  });

  test("a repaired profile verifies after earlier malformed answers: the history is kept until the valid success, which clears it", async () => {
    const t = await setup();
    t.me.push({ id: ACCOUNT }, body("kieran"));
    const stop = t.source.start();
    await settle(t.w);
    expect(t.source.labelFor(t.w.identity.get())).toBeNull();
    expect(t.w.sync().read_retry_states["profile:1"]).toMatchObject({
      unrecognised_streak: 1,
    });
    await t.w.env.world.advance(60_000);
    await settle(t.w);
    expect(t.source.labelFor(t.w.identity.get())).toBe("kieran");
    expect(t.asked).toHaveLength(2);
    expect(t.w.sync().read_retry_states["profile:1"]).toBeUndefined();
    stop();
  });

  test.each([
    [{ id: ACCOUNT }],
    [{ id: ACCOUNT, username: 42 }],
    [{ id: ACCOUNT, username: "   " }],
    [{ id: ACCOUNT, username: "x".repeat(201) }],
    ["a string"],
    [[]],
  ])("the shape is validated: %j", (candidate) => {
    expect(parseAccountIdentity(candidate, ACCOUNT)).toBeNull();
  });

  test("only the username is kept: nothing else of the body reaches the store", async () => {
    const t = await setup();
    t.me.push({
      ...body("kieran"),
      has_password: true,
      oidc_issuers: ["https://issuer.example"],
    });
    const stop = t.source.start();
    await settle(t.w);
    expect(t.w.sync().profile).toEqual({
      username: "kieran",
      verified_epoch: 1,
      verified_at: 1_000,
    });
    expect(JSON.stringify(t.w.snapshot())).not.toContain("issuer.example");
    stop();
  });

  test("a read that could not be made is asked again on its back-off, and at once on `online`", async () => {
    const t = await setup();
    t.online.value = false;
    const stop = t.source.start();
    await settle(t.w);
    // Offline nothing is asked.
    expect(t.asked).toEqual([]);
    t.me.push(null, null, body("kieran"));
    t.goOnline();
    await settle(t.w);
    expect(t.asked).toHaveLength(1);
    expect(t.source.labelFor(t.w.identity.get())).toBeNull();
    // The second attempt is on the back-off (2 s), not on a notification of the same identity.
    t.w.identity.move({ account: ACCOUNT, epoch: 1 });
    await settle(t.w);
    expect(t.asked).toHaveLength(1);
    await t.w.env.world.advance(2_500);
    await settle(t.w);
    expect(t.asked).toHaveLength(2);
    // `online` ends the back-off at once.
    t.goOnline();
    await settle(t.w);
    expect(t.asked).toHaveLength(3);
    expect(t.source.labelFor(t.w.identity.get())).toBe("kieran");
    stop();
  });

  test("an answer that arrives after the identity moved is discarded", async () => {
    const t = await setup();
    let release: (value: ReadResult<unknown>) => void = () => undefined;
    const slow = createProfileSource({
      identity: t.w.identity,
      readMe: () =>
        new Promise((resolve) => {
          release = resolve;
        }),
      online: () => true,
      onOnline: () => () => undefined,
      onService: () => () => undefined,
      service: () => t.w.service,
      clock: { now: () => 1, random: () => 0.5 },
      timers: t.reads.timers,
    });
    const stop = slow.start();
    await settle(t.w);
    t.w.identity.move({ account: ACCOUNT, epoch: 2 });
    release(ok(body("stale")));
    await settle(t.w);
    expect(
      slow.labelFor({ account_id: ACCOUNT, epoch: 1, session_id: "s" }),
    ).toBeNull();
    expect(slow.labelFor(t.w.identity.get())).toBeNull();
    expect(t.w.sync().profile).toBeNull();
    stop();
  });

  test("MU-44: a database that does not exist is NOT created by the profile write; the in-memory label is still shown", async () => {
    const t = await setup({ database: false });
    const before = t.w.env.idb.has(accountDatabaseName("another-account"));
    t.me.push(body("kieran"));
    const stop = t.source.start();
    await settle(t.w);
    expect(t.source.labelFor(t.w.identity.get())).toBe("kieran");
    expect(t.w.sync().profile).toBeNull();
    expect(t.w.env.idb.has(accountDatabaseName("another-account"))).toBe(
      before,
    );
    stop();
  });

  test("a page that starts OFFLINE shows a name persisted for this epoch, and not one persisted for another", async () => {
    const t = await setup();
    t.w.setSync({
      profile: { username: "kieran", verified_epoch: 1, verified_at: 5 },
    });
    t.online.value = false;
    const stop = t.source.start();
    await settle(t.w);
    expect(t.source.labelFor(t.w.identity.get())).toBe("kieran");
    stop();
    const t2 = await setup();
    t2.w.setSync({
      profile: { username: "old", verified_epoch: 1, verified_at: 5 },
    });
    t2.w.identity.move({ account: ACCOUNT, epoch: 2 });
    t2.online.value = false;
    const stop2 = t2.source.start();
    await settle(t2.w);
    expect(t2.source.labelFor(t2.w.identity.get())).toBeNull();
    stop2();
  });

  test("the profile write is guarded like every response-derived write: a closing wipe refuses it", async () => {
    const t = await setup();
    t.w.setSync({
      draft_fence: {
        token: "t",
        started_at: 1,
        operation_ids: [],
        consent_digest: "",
        closing: true,
      },
    });
    t.me.push(body("kieran"));
    const stop = t.source.start();
    await settle(t.w);
    expect(t.w.sync().profile).toBeNull();
    stop();
  });
});

describe("F-P2: the device mirror", () => {
  const mirror = async (
    over: { id?: string | null; database?: boolean } = {},
  ) => {
    const t = await setup({ database: over.database });
    const calls = { n: 0 };
    const stop = startDeviceMirror({
      identity: t.w.identity,
      currentDeviceId: async () => {
        calls.n += 1;
        const id = over.id === undefined ? "device-1" : over.id;
        // A list with no current row is not the contract's answer.
        return id === null ? { kind: "unrecognised" } : ok(id);
      },
      online: t.reads.online,
      onOnline: t.reads.onOnline,
      onService: t.reads.onService,
      service: t.reads.service,
      clock: t.reads.clock,
      timers: t.reads.timers,
    });
    return {
      ...t,
      calls,
      stop,
    };
  };

  test("device_id, device_verified and device_verified_for are written in one guarded transaction, and nothing else of sync_state moves", async () => {
    const m = await mirror();
    const before = m.w.sync();
    await settle(m.w);
    const after = m.w.sync();
    expect(after.device_id).toBe("device-1");
    expect(after.device_verified).toBe(true);
    expect(after.device_verified_for).toEqual({
      account_id: ACCOUNT,
      epoch: 1,
    });
    for (const field of [
      "cursor",
      "phase",
      "cache_status",
      "page_seq",
      "request_seq",
      "draft_seq",
      "applied_revision",
    ] as const)
      expect(after[field]).toEqual(before[field]);
    m.stop();
  });

  test("it is written once per (account, epoch); a new epoch writes again for that epoch", async () => {
    const m = await mirror();
    await settle(m.w);
    m.w.identity.move({ account: ACCOUNT, epoch: 1 });
    await settle(m.w);
    expect(m.calls.n).toBe(1);
    m.w.identity.move({ account: ACCOUNT, epoch: 2 });
    await settle(m.w);
    expect(m.calls.n).toBe(2);
    expect(m.w.sync().device_verified_for).toEqual({
      account_id: ACCOUNT,
      epoch: 2,
    });
    m.stop();
  });

  test("a failed attempt leaves the fields exactly as they were", async () => {
    const m = await mirror();
    await settle(m.w);
    const before = JSON.stringify(m.w.sync());
    const remove = m.w.env.idb.inject({
      match: (tx) => tx.label === "data.recordDeviceVerification",
      mode: "error",
      times: 1,
    });
    m.w.identity.move({ account: ACCOUNT, epoch: 2 });
    await settle(m.w);
    remove();
    // The stamp mirror may move (epoch publication) but the device fields did not.
    const after = m.w.sync();
    expect(after.device_verified_for).toEqual({
      account_id: ACCOUNT,
      epoch: 1,
    });
    expect(JSON.parse(before).device_id).toBe(after.device_id);
    m.stop();
  });

  test("a STALE attempt (the identity moved before the write) writes nothing: the late answer for the older epoch is dropped", async () => {
    const m = await setup();
    const releases: Array<(v: ReadResult<string>) => void> = [];
    const stop = startDeviceMirror({
      identity: m.w.identity,
      currentDeviceId: () =>
        new Promise((resolve) => {
          releases.push(resolve);
        }),
      online: () => true,
      onOnline: () => () => undefined,
      onService: () => () => undefined,
      service: () => m.w.service,
      clock: m.reads.clock,
      timers: m.reads.timers,
    });
    await settle(m.w);
    expect(releases).toHaveLength(1);
    m.w.identity.move({ account: ACCOUNT, epoch: 2 });
    await settle(m.w);
    expect(releases).toHaveLength(2);
    // The answer for epoch 1 arrives AFTER the identity moved to epoch 2: it is dropped by the guard and writes nothing.
    releases[0]?.(ok("device-late"));
    await settle(m.w);
    expect(m.w.sync().device_id).toBeNull();
    expect(m.w.sync().device_verified).toBe(false);
    releases[1]?.(ok("device-2"));
    await settle(m.w);
    expect(m.w.sync().device_id).toBe("device-2");
    expect(m.w.sync().device_verified_for).toEqual({
      account_id: ACCOUNT,
      epoch: 2,
    });
    stop();
  });

  test("no database: nothing is written and nothing is created; no current device in the list: nothing is written", async () => {
    const none = await mirror({ database: false });
    await settle(none.w);
    expect(none.w.sync().device_verified).toBe(false);
    none.stop();
    const missing = await mirror({ id: null });
    await settle(missing.w);
    expect(missing.w.sync().device_id).toBeNull();
    expect(missing.w.sync().device_verified).toBe(false);
    missing.stop();
  });
});
