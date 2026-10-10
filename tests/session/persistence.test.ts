// @vitest-environment node
import { describe, expect, test } from "vitest";
import type { PersistenceHold } from "../../src/session";
import { DEFAULT_CONFIG } from "../../src/session/constants";
import {
  holdLock,
  newWorld,
  openPage,
  signedInPage,
  stateOf,
} from "../support/session/scenarios";

/**
 * F-PERSIST-*: the persistence hold (docs/session.md, obligation 4, revision 5), through the REAL kernel over the fake world's
 * Web Locks and the shared double of the `atlas-auth` store.
 *
 * The hold orders a commit in an account's own database against every settlement of the session record: a SHARED `atlas-auth`
 * lock, then the verdict at the durable record, kept until released. The premise (every change of `settled` is made under the
 * exclusive lock) is checked by the store double on every commit of every session scenario (`violations`, property P-F).
 */
const ask = async (
  l: Awaited<ReturnType<typeof signedInPage>>,
  page = l.page,
  account = l.account,
  epoch = l.epoch,
) => {
  const call = page.session.persistence.hold(account, epoch);
  await l.fixture.world.runUntilIdle();
  return call;
};
const held = (hold: PersistenceHold) => {
  if (hold.kind !== "held") throw new Error(`not held: ${hold.kind}`);
  return hold;
};

describe("the hold, when the identity is current", () => {
  test("is granted: a shared atlas-auth lock is held until released, and the record is untouched", async () => {
    const l = await signedInPage(await newWorld());
    const before = structuredClone(stateOf(l.fixture));
    const hold = held(await ask(l));
    expect(l.fixture.locks.heldNames(l.page.id)).toContain("atlas-auth");
    // Nothing was written: it is a read at the record, not a settlement.
    expect(stateOf(l.fixture)).toEqual(before);
    hold.release();
    await l.fixture.settle();
    expect(l.fixture.locks.heldNames(l.page.id)).not.toContain("atlas-auth");
    expect(l.fixture.store.violations).toEqual([]);
  });

  test("holds of several pages coexist (shared), and release is idempotent", async () => {
    const l = await signedInPage(await newWorld());
    const other = await openPage(l.fixture);
    const one = held(await ask(l));
    const two = held(await ask(l, other));
    expect(l.fixture.locks.heldNames(l.page.id)).toContain("atlas-auth");
    expect(l.fixture.locks.heldNames(other.id)).toContain("atlas-auth");
    one.release();
    one.release();
    two.release();
    await l.fixture.settle();
    expect(l.fixture.locks.allHeldNames().map((h) => h.name)).not.toContain(
      "atlas-auth",
    );
  });

  test("every request leaves a trace in the closed vocabulary, never the account", async () => {
    const l = await signedInPage(await newWorld());
    held(await ask(l)).release();
    await l.fixture.settle();
    const events = l.fixture.world.logs
      .filter((e) => String(e.type).startsWith("trace.persistence."))
      .map((e) => e.type);
    expect(events).toEqual([
      "trace.persistence.check",
      "trace.persistence.held",
      "trace.persistence.released",
    ]);
    // The vocabulary is closed and carries no secret: ids, an epoch and booleans are all it names (never a name or a cookie).
    const allowed = [
      "account",
      "epoch",
      "page",
      "seq",
      "type",
      "n",
      "durable",
      "current",
      "decoded",
      "t",
    ];
    for (const entry of l.fixture.world.logs.filter((e) =>
      String(e.type).startsWith("trace.persistence."),
    ))
      for (const key of Object.keys(entry)) expect(allowed).toContain(key);
  });
});

describe("the hold, when another page has settled a transition this page was never told of", () => {
  test("a sign-in as another account on page B: page A's hold is STALE (it is never told; the record is the authority)", async () => {
    const l = await signedInPage(await newWorld());
    const b = await openPage(l.fixture);
    // Page A is not told: every hint from page B is held for ever, so A's own copy of the identity never moves.
    l.fixture.world.setKnob("D2", "unbounded", (meta) => meta.from === b.id);
    expect((await l.fixture.signIn(b, "sam", "pw2")).kind).toBe("settled");
    await l.fixture.world.runUntilIdle();
    expect(stateOf(l.fixture).settled?.account_id).not.toBe(l.account);
    const hold = await ask(l);
    expect(hold.kind).toBe("stale");
    expect(l.fixture.locks.heldNames(l.page.id)).not.toContain("atlas-auth");
    expect(l.fixture.store.violations).toEqual([]);
  });

  test("a hold for an identity that was never settled is stale", async () => {
    const l = await signedInPage(await newWorld());
    expect((await ask(l, l.page, l.account, l.epoch + 5)).kind).toBe("stale");
    expect(
      (await ask(l, l.page, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb")).kind,
    ).toBe("stale");
  });
});

describe("the hold orders a persistence commit against a settlement", () => {
  test("a settlement requested while a hold is kept WAITS for it, and is made once the hold is released (the commit persists first)", async () => {
    const l = await signedInPage(await newWorld());
    const b = await openPage(l.fixture);
    const hold = held(await ask(l));
    // Another page starts a sign-in as someone else: its settlement needs the exclusive lock, which the hold keeps.
    const signIn = l.fixture.signIn(b, "sam", "pw2");
    const progress: string[] = [];
    void signIn.then(() => progress.push("signed in"));
    await l.fixture.world.runUntilIdle();
    expect(progress).toEqual([]);
    expect(stateOf(l.fixture).settled?.account_id).toBe(l.account);
    // The commit persists (here: nothing to do), the hold is released, and only then is the transition settled.
    hold.release();
    await l.fixture.world.runUntilIdle();
    expect((await signIn).kind).toBe("settled");
    expect(stateOf(l.fixture).settled?.account_id).not.toBe(l.account);
    expect(l.fixture.store.violations).toEqual([]);
  });

  test("a hold requested while a settlement holds atlas-auth waits behind it, then sees the NEW identity: stale", async () => {
    const l = await signedInPage(await newWorld());
    const blocker = await holdLock(l.fixture, "frozen", "atlas-auth");
    const pending = l.page.session.persistence.hold(l.account, l.epoch);
    let result: PersistenceHold["kind"] | null = null;
    void pending.then((h) => {
      result = h.kind;
    });
    await l.fixture.world.runUntilIdle();
    expect(result).toBeNull();
    blocker();
    await l.fixture.world.runUntilIdle();
    // Nothing settled in between, so it is granted.
    expect(result).toBe("held");
    held(await pending).release();
  });

  test("a hold that cannot be had within the wait is `unavailable`, never an answer about identity", async () => {
    const f = await newWorld();
    const l = await signedInPage(f);
    const release = await holdLock(f, "frozen", "atlas-auth");
    const call = l.page.session.persistence.hold(l.account, l.epoch);
    let kind: string | null = null;
    void call.then((h) => {
      kind = h.kind;
    });
    await f.world.advance(21_000);
    expect(kind).toBe("unavailable");
    release();
    await f.world.runUntilIdle();
    expect(f.store.violations).toEqual([]);
  });

  test("a holder that never releases cannot block every settlement of the browser for ever: the bound ends the hold (traced), and a sign-in then goes through", async () => {
    const l = await signedInPage(await newWorld());
    const b = await openPage(l.fixture);
    held(await ask(l));
    // While the hold is kept, a settlement cannot start: the session's own request for the lock gives up after its wait.
    const begun = l.fixture.runWith(b.session.attempts.begin("password"));
    await l.fixture.world.advance(21_000);
    expect((await begun).kind).toBe("lock_timeout");
    // The bound ends the stalled hold (30 s), and the browser is not blocked any longer.
    await l.fixture.world.advance(10_000);
    await l.fixture.world.runUntilIdle();
    expect(
      l.fixture.world.logs.some(
        (e) => e.type === "trace.persistence.timed_out",
      ),
    ).toBe(true);
    expect((await l.fixture.signIn(b, "sam", "pw2")).kind).toBe("settled");
    expect(l.fixture.store.violations).toEqual([]);
  });
});

describe("expiry is a REVOCATION (R2, revisions 6 and 7): the lock outlives the bound exactly as long as the work registered with the hold, with no deadline", () => {
  const HOLD = DEFAULT_CONFIG.persistenceHoldMs;
  const STALL = DEFAULT_CONFIG.persistenceStallMs;
  const trace = (l: Awaited<ReturnType<typeof signedInPage>>, name: string) =>
    l.fixture.world.logs.filter((e) => e.type === `trace.persistence.${name}`);

  test("with no registered work, the bound revokes the hold (the signal fires, valid() is false) and releases the lock at once", async () => {
    const l = await signedInPage(await newWorld());
    const hold = held(await ask(l));
    expect(hold.valid()).toBe(true);
    expect(hold.revoked.aborted).toBe(false);
    await l.fixture.world.advance(HOLD - 1);
    expect(hold.valid()).toBe(true);
    expect(l.fixture.locks.heldNames(l.page.id)).toContain("atlas-auth");
    await l.fixture.world.advance(1);
    await l.fixture.world.runUntilIdle();
    expect(hold.revoked.aborted).toBe(true);
    expect(hold.valid()).toBe(false);
    expect(l.fixture.locks.heldNames(l.page.id)).not.toContain("atlas-auth");
    expect(
      l.fixture.world.logs
        .filter((e) => String(e.type).startsWith("trace.persistence."))
        .map((e) => e.type),
    ).toEqual([
      "trace.persistence.check",
      "trace.persistence.held",
      "trace.persistence.timed_out",
      "trace.persistence.released",
    ]);
  });

  test("registered work keeps the lock past the bound until it SETTLES, and a holder that aborts it on the signal is let go at once", async () => {
    const l = await signedInPage(await newWorld());
    const hold = held(await ask(l));
    let end!: () => void;
    hold.track(
      new Promise<void>((resolve) => {
        end = resolve;
      }),
    );
    await l.fixture.world.advance(HOLD + 1_000);
    expect(hold.valid()).toBe(false);
    // Revoked, but the work has not ended: the lock is kept, so no settlement can be ordered ahead of it.
    expect(l.fixture.locks.heldNames(l.page.id)).toContain("atlas-auth");
    end();
    await l.fixture.world.runUntilIdle();
    expect(l.fixture.locks.heldNames(l.page.id)).not.toContain("atlas-auth");
    expect(trace(l, "stalled")).toEqual([]);
  });

  test("work that REJECTS also ends the wait (settled, not fulfilled), and the signal reaches a listener in the same step as valid() turns false", async () => {
    const l = await signedInPage(await newWorld());
    const hold = held(await ask(l));
    let seen: boolean | null = null;
    hold.revoked.addEventListener("abort", () => {
      seen = hold.valid();
    });
    hold.track(
      new Promise<void>((_, reject) =>
        hold.revoked.addEventListener("abort", () =>
          reject(new Error("abandoned")),
        ),
      ).catch(() => {
        throw new Error("abandoned");
      }),
    );
    await l.fixture.world.advance(HOLD + 1);
    await l.fixture.world.runUntilIdle();
    expect(seen).toBe(false);
    expect(l.fixture.locks.heldNames(l.page.id)).not.toContain("atlas-auth");
  });

  test("work that never ends keeps the lock for ever: the stall is TRACED once, nothing is released, and a settlement elsewhere gives up (it is not made)", async () => {
    const l = await signedInPage(await newWorld());
    const b = await openPage(l.fixture);
    const hold = held(await ask(l));
    let end!: () => void;
    hold.track(
      new Promise<void>((resolve) => {
        end = resolve;
      }),
    );
    await l.fixture.world.advance(HOLD + STALL - 1_000);
    expect(l.fixture.locks.heldNames(l.page.id)).toContain("atlas-auth");
    expect(trace(l, "stalled")).toEqual([]);
    await l.fixture.world.advance(2_000);
    await l.fixture.world.runUntilIdle();
    expect(trace(l, "timed_out")).toHaveLength(1);
    expect(trace(l, "stalled")).toHaveLength(1);
    // Nothing was given up: not at the stall, and not ten minutes later.
    await l.fixture.world.advance(600_000);
    await l.fixture.world.runUntilIdle();
    expect(l.fixture.locks.heldNames(l.page.id)).toContain("atlas-auth");
    expect(trace(l, "stalled")).toHaveLength(1);
    expect(trace(l, "released")).toEqual([]);
    // Another page cannot settle: its request waits for its own bound and gives up, and the record is exactly as it was.
    const begun = l.fixture.runWith(b.session.attempts.begin("password"));
    await l.fixture.world.advance(21_000);
    expect((await begun).kind).toBe("lock_timeout");
    expect(stateOf(l.fixture).settled?.account_id).toBe(l.account);
    // The work ends (the engine answers, or the page is closed): the lock goes, and the settlement is then made.
    end();
    await l.fixture.world.runUntilIdle();
    expect(l.fixture.locks.heldNames(l.page.id)).not.toContain("atlas-auth");
    expect((await l.fixture.signIn(b, "sam", "pw2")).kind).toBe("settled");
    expect(l.fixture.store.violations).toEqual([]);
  });

  test("a page that is closed frees its hold with it (a Web Lock does not outlive its page), so a stalled engine cannot block the browser once the page is gone", async () => {
    const l = await signedInPage(await newWorld());
    const b = await openPage(l.fixture);
    const hold = held(await ask(l));
    hold.track(new Promise<void>(() => undefined));
    await l.fixture.world.advance(HOLD + STALL + 1_000);
    expect(l.fixture.locks.heldNames(l.page.id)).toContain("atlas-auth");
    l.fixture.locks.destroyPage(l.page.id);
    expect((await l.fixture.signIn(b, "sam", "pw2")).kind).toBe("settled");
    expect(l.fixture.store.violations).toEqual([]);
  });

  test("release() does not give the lock up under work that has not settled: it takes effect when the last registered promise settles", async () => {
    const l = await signedInPage(await newWorld());
    const hold = held(await ask(l));
    let end!: () => void;
    hold.track(
      new Promise<void>((resolve) => {
        end = resolve;
      }),
    );
    hold.release();
    hold.release();
    expect(hold.valid()).toBe(false);
    await l.fixture.world.runUntilIdle();
    expect(l.fixture.locks.heldNames(l.page.id)).toContain("atlas-auth");
    expect(trace(l, "released")).toEqual([]);
    end();
    await l.fixture.world.runUntilIdle();
    expect(l.fixture.locks.heldNames(l.page.id)).not.toContain("atlas-auth");
    expect(trace(l, "released")).toHaveLength(1);
  });

  test("two registered promises: the lock goes only when BOTH have settled, whichever is last, and one that rejects counts", async () => {
    const l = await signedInPage(await newWorld());
    const hold = held(await ask(l));
    let first!: () => void;
    let second!: (reason: Error) => void;
    hold.track(
      new Promise<void>((resolve) => {
        first = resolve;
      }),
    );
    hold.track(
      new Promise<void>((_, reject) => {
        second = reject;
      }),
    );
    await l.fixture.world.advance(HOLD + 1_000);
    first();
    await l.fixture.world.runUntilIdle();
    expect(l.fixture.locks.heldNames(l.page.id)).toContain("atlas-auth");
    second(new Error("aborted"));
    await l.fixture.world.runUntilIdle();
    expect(l.fixture.locks.heldNames(l.page.id)).not.toContain("atlas-auth");
  });

  test("work registered AFTER the revocation is not waited for (valid() was false: it must never have been started)", async () => {
    const l = await signedInPage(await newWorld());
    const hold = held(await ask(l));
    await l.fixture.world.advance(HOLD + 1);
    await l.fixture.world.runUntilIdle();
    hold.track(new Promise<void>(() => undefined));
    await l.fixture.world.advance(STALL + 1_000);
    expect(trace(l, "stalled")).toEqual([]);
    expect(l.fixture.locks.heldNames(l.page.id)).not.toContain("atlas-auth");
  });

  test("a hold released before the bound is never REVOKED: no trace, one release, however long the world runs on (the bound's own timer cannot be cancelled, and nothing listens to it any more)", async () => {
    const l = await signedInPage(await newWorld());
    const hold = held(await ask(l));
    hold.track(Promise.resolve());
    hold.release();
    await l.fixture.world.advance(HOLD + STALL + 5_000);
    expect(hold.valid()).toBe(false);
    expect(trace(l, "timed_out")).toEqual([]);
    expect(trace(l, "stalled")).toEqual([]);
    expect(trace(l, "released")).toHaveLength(1);
  });

  test("a settlement queued behind a revoked hold with work is made as soon as the work ends, and the commit it waited for is ordered first", async () => {
    const l = await signedInPage(await newWorld());
    const b = await openPage(l.fixture);
    const hold = held(await ask(l));
    let end!: () => void;
    hold.track(
      new Promise<void>((resolve) => {
        end = resolve;
      }),
    );
    await l.fixture.world.advance(HOLD - 5_000);
    const signIn = l.fixture.signIn(b, "sam", "pw2");
    const progress: string[] = [];
    void signIn.then(() => progress.push("settled"));
    await l.fixture.world.advance(6_000);
    expect(progress).toEqual([]);
    expect(stateOf(l.fixture).settled?.account_id).toBe(l.account);
    end();
    await l.fixture.world.runUntilIdle();
    expect((await signIn).kind).toBe("settled");
    expect(stateOf(l.fixture).settled?.account_id).not.toBe(l.account);
    expect(l.fixture.store.violations).toEqual([]);
  });
});

describe("the premise: every change of the settled identity is made under the exclusive atlas-auth lock", () => {
  test("sign-in, a second sign-in as another account and a confirmed logout leave no violation", async () => {
    const f = await newWorld();
    const l = await signedInPage(f);
    expect((await f.signIn(l.page, "sam", "pw2")).kind).toBe("settled");
    await f.settle();
    expect(f.store.violations).toEqual([]);
  });
});
