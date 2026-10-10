// @vitest-environment node
import { describe, expect, test } from "vitest";
import { DataRuntime } from "../../src/data/engine/account-service";
import { createQuotaGuard } from "../../src/data/engine/quota-guard";
import type { SyncMessage } from "../../src/data/engine/sync-channel";
import { createDataEnv } from "../../src/data/ui/env";
import { unrevokedHold } from "../../src/session";
import { identityReadWorld } from "../support/data/identity-reads";
import { ACCOUNT, pageWorld } from "../support/data/page-world";

/**
 * R16 (revision 11): what a look found belongs to ONE binding. The controller's look for the displayed account's database has an
 * answer (the database opened, or there is none) and the profile read and the device mirror act on it: while the database is not
 * known they ask nothing, because the durable retry budget (a pause, a count) lives in it. The revision-10 fix made a FAILED first
 * look an unknown. But the answer of an EARLIER look survived the binding it described: after the service ended, after the page left the
 * account and came back, or at the start of a new look, `databasePending` said "nothing left to discover" while the new look was
 * pending or failing, so the profile task started without reading the current durable budget (the review's two probes: three `/me`
 * requests over a saved pause when reopening rejects, one before the binding when it succeeds).
 *
 * The rule: an answer ends with the binding it described (the service ended, was replaced, or the page left for another account) and
 * with the START of any later look; only a look that LANDS says again what is there. Nothing looks again by itself when a binding
 * ends (a reopening would undo the latch of a wipe that closed it): the identity's next notification, `online`, another tab's hint and
 * `retryLoad` do. The durable budget is never reset or ignored to restore progress: the recovery below is the bounded one.
 *
 * The production controller, the REAL runtime and services, plans and readers over the double of IndexedDB, with fake time. Every
 * failure is a NAMED injection of the runtime's open; none is a genuine device failure.
 */
const OTHER = "22222222-2222-4222-8222-222222222222";
const PAUSE = {
  backing_off_since: null,
  paused: true,
  unrecognised_streak: 3,
};
/** The durable entry of both readers for one sign-in. */
const pausedFor = (epoch: number) => ({
  [`profile:${epoch}`]: PAUSE,
  [`device:${epoch}`]: PAUSE,
});

type Open = "real" | "reject" | "absent" | "hold";

async function binding(answer: "unrecognised" | "failure" = "unrecognised") {
  const w = await pageWorld();
  const d = identityReadWorld(w);
  const runtime = new DataRuntime({
    identity: w.identity,
    persistence: { hold: async () => unrevokedHold() },
    registry: w.page.registry,
    open: (account, options) => w.page.open(account, options),
  });
  // What the next opens of the runtime do. `hold` parks the open until `release`.
  const plan: { mode: Open; only?: string } = { mode: "real" };
  const opens: Record<string, number> = {};
  const parked: Array<() => void> = [];
  let asked = 0;
  const messages = new Set<(message: SyncMessage) => void>();
  const env = createDataEnv({
    identity: w.identity,
    online: { get: () => true, subscribe: () => () => undefined },
    onOnline: d.onOnline,
    loadRuntime: async () =>
      ({
        open: async (account: string) => {
          opens[account] = (opens[account] ?? 0) + 1;
          const applies = plan.only === undefined || plan.only === account;
          if (applies && plan.mode === "reject")
            throw new Error("listing unavailable");
          if (applies && plan.mode === "absent") return { kind: "absent" };
          if (applies && plan.mode === "hold")
            await new Promise<void>((resolve) => parked.push(resolve));
          return runtime.open(account, { create: false });
        },
      }) as never,
    quota: createQuotaGuard({
      storage: { estimate: async () => ({ usage: 0, quota: 1e9 }) },
      now: d.clock.now,
    }),
    timers: d.timers,
    clock: {
      ...d.clock,
      iso: () => new Date(d.clock.now()).toISOString(),
    },
    ids: { uuid: () => crypto.randomUUID() },
    fence: () => ({ hasPendingOperation: false, sessionStarted: true }),
    readMe: async (account) => {
      if (account === ACCOUNT) asked += 1;
      return { kind: answer };
    },
    currentDeviceId: async () => ({ kind: "closed" }),
    channel: {
      post: () => undefined,
      subscribe: (listener) => {
        messages.add(listener);
        return () => messages.delete(listener);
      },
    },
  });
  const settle = async () => {
    for (let i = 0; i < 20; i += 1) await w.env.settle();
  };
  return {
    w,
    d,
    env,
    runtime,
    plan,
    opens,
    asked: () => asked,
    settle,
    advance: async (ms: number) => {
      await w.env.world.advance(ms);
      await settle();
    },
    /** Lets the parked opens go. */
    release: async () => {
      for (const go of parked.splice(0)) go();
      await settle();
    },
    parkedOpens: () => parked.length,
    /** Another tab's hint, as a write of the account's database would announce. */
    hint: () => {
      for (const listener of [...messages])
        listener({ type: "data_changed", account: ACCOUNT, stores: [] });
    },
    end() {
      env.dispose();
      runtime.dispose();
    },
  };
}
type Binding = Awaited<ReturnType<typeof binding>>;

/** What each way back asks of the server over a saved pause for the new sign-in (the control values are the bounded recovery). */
const RETURNS = [
  ["reject", 0],
  ["paused", 0],
  ["healthy", 3],
  ["absent", 3],
] as const;

/** Sets the durable state the way back finds, and the way the runtime opens. */
function arrange(t: Binding, mode: (typeof RETURNS)[number][0], epoch: number) {
  t.w.setSync({
    read_retry_states: mode === "healthy" ? {} : pausedFor(epoch),
  });
  t.plan.mode =
    mode === "reject" ? "reject" : mode === "absent" ? "absent" : "real";
}

/** A page whose first binding is established over a saved pause: it asked nothing. */
async function established(): Promise<Binding> {
  const t = await binding();
  t.w.setSync({ read_retry_states: pausedFor(1) });
  await t.settle();
  expect(t.env.service()).not.toBeNull();
  expect(t.asked()).toBe(0);
  return t;
}

describe("the service ends and the sign-in moves on: the earlier answer is gone", () => {
  for (const [mode, expected] of RETURNS)
    test(`reopening ${mode}: ${expected === 0 ? "nothing is asked, whatever the page is told, for an hour" : "the bounded budget of a page with nothing saved (three answers, then it pauses)"}`, async () => {
      const t = await established();
      t.env.service()?.dispose("closed");
      await t.settle();
      expect(t.env.service()).toBeNull();
      arrange(t, mode, 3);
      const before = t.asked();
      t.w.identity.move({ account: ACCOUNT, epoch: 3 });
      await t.settle();
      await t.advance(3_600_000);
      expect(t.asked() - before).toBe(expected);
      // A look that landed is a binding again; one that failed is not, and is not taken for one.
      expect(t.env.service() !== null).toBe(
        mode === "paused" || mode === "healthy",
      );
      t.end();
    });

  test("the same, with the sign-in unchanged: the next notification of the identity looks again, and a saved pause is read before anything is asked", async () => {
    const t = await established();
    t.env.service()?.dispose("closed");
    await t.settle();
    // Nothing looks by itself when a binding ends (a wipe that closed it must not be undone): the page is waiting, and asks nothing.
    const opened = t.opens[ACCOUNT] ?? 0;
    await t.advance(3_600_000);
    expect(t.opens[ACCOUNT] ?? 0).toBe(opened);
    expect(t.asked()).toBe(0);
    // The identity is published again, as the session does at every evaluation: now it looks.
    t.w.identity.move({ account: ACCOUNT, epoch: 1 });
    await t.settle();
    await t.advance(3_600_000);
    expect(t.opens[ACCOUNT] ?? 0).toBe(opened + 1);
    expect(t.env.service()).not.toBeNull();
    expect(t.asked()).toBe(0);
    t.end();
  });

  test("a read that is BACKING OFF when the service ends: its timer fires with the budget unreadable, and it asks nothing until a look lands", async () => {
    const t = await binding("failure");
    await t.settle();
    // The first request failed (counted, and the database holds it); the second waits for its back-off.
    expect(t.asked()).toBe(1);
    const unbound = t.asked();
    t.env.service()?.dispose("closed");
    await t.settle();
    // No identity change, no hint, no `online`: nothing starts a look, and the back-off timer fires into a page that cannot read
    // what it counted. It must not take the missing answer for "there is no database" and ask on its memory.
    await t.advance(600_000);
    expect(t.env.service()).toBeNull();
    expect(t.asked()).toBe(unbound);
    // The identity is published again: the look lands, the count is read, and the bounded schedule goes on from where it was.
    t.w.identity.move({ account: ACCOUNT, epoch: 1 });
    await t.settle();
    expect(t.env.service()).not.toBeNull();
    await t.advance(3_600_000);
    expect(t.asked()).toBeGreaterThan(unbound);
    t.end();
  });

  test("the look is DELAYED (the open is still pending when the sign-in moves): nothing is asked until it lands, then the saved pause is honoured", async () => {
    const t = await established();
    t.env.service()?.dispose("closed");
    await t.settle();
    t.w.setSync({ read_retry_states: pausedFor(3) });
    t.plan.mode = "hold";
    t.w.identity.move({ account: ACCOUNT, epoch: 3 });
    await t.settle();
    await t.advance(120_000);
    expect(t.parkedOpens()).toBe(1);
    expect(t.asked()).toBe(0);
    t.plan.mode = "real";
    await t.release();
    await t.advance(3_600_000);
    expect(t.env.service()).not.toBeNull();
    expect(t.asked()).toBe(0);
    t.end();
  });

  test("the control: a delayed look over NOTHING saved asks once it lands (three answers), and not before", async () => {
    const t = await established();
    t.env.service()?.dispose("closed");
    await t.settle();
    t.w.setSync({ read_retry_states: {} });
    t.plan.mode = "hold";
    t.w.identity.move({ account: ACCOUNT, epoch: 3 });
    await t.settle();
    await t.advance(120_000);
    expect(t.asked()).toBe(0);
    t.plan.mode = "real";
    await t.release();
    await t.advance(3_600_000);
    expect(t.asked()).toBe(3);
    t.end();
  });
});

describe("the page leaves the account and comes back: the answer about it does not wait there", () => {
  for (const middle of ["reject", "absent"] as const)
    for (const [mode, expected] of RETURNS)
      test(`the other account's look ${middle === "reject" ? "fails" : "finds no database"}, then back to the first and reopening ${mode}: ${expected === 0 ? "nothing is asked" : "the bounded budget"}`, async () => {
        const t = await established();
        t.plan.only = OTHER;
        t.plan.mode = middle;
        t.w.identity.move({ account: OTHER, epoch: 2 });
        await t.settle();
        await t.advance(60_000);
        arrange(t, mode, 3);
        // The way back is the first account's look: the other account's fault no longer applies.
        delete t.plan.only;
        t.plan.mode =
          mode === "reject" ? "reject" : mode === "absent" ? "absent" : "real";
        const before = t.asked();
        t.w.identity.move({ account: ACCOUNT, epoch: 3 });
        await t.settle();
        await t.advance(3_600_000);
        expect(t.asked() - before).toBe(expected);
        t.end();
      });
});

describe("a later look that fails leaves the account unknown, whatever the earlier one found", () => {
  test("no database was found; then another tab creates one and a hint starts a look that FAILS; a sign-in that moves on asks nothing", async () => {
    const t = await binding();
    // The first look finds no database: the page asks on its memory (three answers) and pauses itself.
    t.plan.mode = "absent";
    await t.settle();
    await t.advance(3_600_000);
    expect(t.asked()).toBe(3);
    // Another tab creates the database (with a saved pause for the next sign-in) and says so; this page's look of it fails.
    t.w.setSync({ read_retry_states: pausedFor(2) });
    t.plan.mode = "reject";
    t.hint();
    await t.settle();
    // A new sign-in is new work, and the earlier "there is none" cannot say what the database holds now.
    const before = t.asked();
    t.w.identity.move({ account: ACCOUNT, epoch: 2 });
    await t.settle();
    await t.advance(3_600_000);
    expect(t.asked() - before).toBe(0);
    // The failure ends, the look lands, and the pause that was saved is read: still nothing.
    t.plan.mode = "real";
    await t.advance(60_000);
    await t.advance(3_600_000);
    expect(t.env.service()).not.toBeNull();
    expect(t.asked() - before).toBe(0);
    t.end();
  });

  test("the control: the same sequence with nothing saved asks on the page's memory once the look lands", async () => {
    const t = await binding();
    t.plan.mode = "absent";
    await t.settle();
    await t.advance(3_600_000);
    expect(t.asked()).toBe(3);
    t.w.setSync({ read_retry_states: {} });
    t.plan.mode = "reject";
    t.hint();
    await t.settle();
    const before = t.asked();
    t.w.identity.move({ account: ACCOUNT, epoch: 2 });
    await t.settle();
    await t.advance(600_000);
    expect(t.asked() - before).toBe(0);
    t.plan.mode = "real";
    await t.advance(60_000);
    await t.advance(3_600_000);
    expect(t.asked() - before).toBe(3);
    t.end();
  });

  test("a look that finds the database absent ends the failure and the wait: the page then asks on its memory", async () => {
    const t = await established();
    t.env.service()?.dispose("closed");
    await t.settle();
    t.plan.mode = "reject";
    t.w.identity.move({ account: ACCOUNT, epoch: 3 });
    await t.settle();
    await t.advance(120_000);
    expect(t.asked()).toBe(0);
    t.plan.mode = "absent";
    await t.advance(60_000);
    await t.advance(3_600_000);
    expect(t.asked()).toBe(3);
    t.end();
  });
});
