// @vitest-environment node
import { describe, expect, test } from "vitest";
import type { Acquisition } from "../../src/data/engine/defaults-source";
import type { QuotaGuard } from "../../src/data/engine/quota-guard";
import {
  ACCOUNT,
  DB,
  defaultsWorld,
  OTHER,
} from "../support/data/defaults-world";
import { record, revision, snapshot } from "../support/data/sharing";

/**
 * WEB-12a, B5: the defaults source through the PRODUCTION controller (`createDataEnv`), runtime, plans and commit guard over the double
 * of IndexedDB. It reads `GET /defaults/snapshot` only while a screen uses it, keeps the current identity's record (memory or the open
 * database), persists it as ONE record through W14 only when the database already exists, and never shows or persists a body that is
 * not the contract's snapshot. FIXTURE evidence: no backend is involved.
 */
const ok = (value: unknown) => ({ kind: "ok" as const, value });

describe("demand-driven: nothing is asked until a screen uses the defaults", () => {
  test("a started controller that nobody asks for defaults makes no request", async () => {
    const t = await defaultsWorld({ answers: [ok(snapshot())] });
    await t.settle();
    await t.advance(60_000);
    expect(t.asked).toEqual([]);
    expect(t.env.defaults.record.get()).toBeNull();
    t.env.dispose();
  });

  test("once used: one read for the (account, epoch), shown and persisted as one record of format 1", async () => {
    const t = await defaultsWorld({ answers: [ok(snapshot())] });
    await t.settle();
    const release = t.env.defaults.use();
    await t.settle();
    expect(t.asked).toEqual([[ACCOUNT, 1]]);
    const shown = t.env.defaults.record.get();
    expect(shown?.snapshot).toEqual(snapshot());
    expect(shown?.epoch).toBe(1);
    expect(t.stored()).toEqual(shown);
    // Read once per (account, epoch): no repetition while it stays used.
    await t.advance(120_000);
    expect(t.asked).toHaveLength(1);
    release();
    t.env.dispose();
  });

  test("a controller with no reader asks nothing and shows only what is persisted", async () => {
    const t = await defaultsWorld({ noReader: true, persisted: record() });
    await t.settle();
    t.env.defaults.use();
    await t.settle();
    expect(t.env.defaults.record.get()).toEqual(record());
    expect(await t.env.defaults.refresh()).toBe("closed");
    t.env.dispose();
  });
});

describe("what is shown and persisted", () => {
  test("an offline start shows the persisted record with no request, and the look settles", async () => {
    const t = await defaultsWorld({ online: false, persisted: record() });
    t.env.defaults.use();
    await t.settle();
    expect(t.env.defaults.record.get()).toEqual(record());
    expect(t.env.defaults.settled.get()).toBe(true);
    await t.advance(60_000);
    expect(t.asked).toEqual([]);
    t.env.dispose();
  });

  test("WEB-09a's seed (null) and a damaged field read as no record: settled with none", async () => {
    const t = await defaultsWorld({
      online: false,
      persisted: { format: 1, snapshot: { defaults: "x" } },
    });
    t.env.defaults.use();
    await t.settle();
    expect(t.env.defaults.record.get()).toBeNull();
    expect(t.env.defaults.settled.get()).toBe(true);
    t.env.dispose();
  });

  test("MU-D18: a body that is not the contract's snapshot is never persisted or shown, is counted, and three in a row pause the caller", async () => {
    const bad = snapshot();
    (bad.defaults as { revision: string }).revision = "not-hex";
    const t = await defaultsWorld({
      answers: [ok(bad), ok(bad), ok(bad), ok(snapshot())],
    });
    t.env.defaults.use();
    await t.settle();
    expect(t.env.defaults.record.get()).toBeNull();
    expect(t.stored()).toBeNull();
    await t.advance(10 * 60_000);
    // Three unrecognised answers pause this caller: the fourth (valid) answer is never asked for.
    expect(t.asked).toHaveLength(3);
    expect(t.env.defaults.record.get()).toBeNull();
    expect(t.stored()).toBeNull();
    const budget = (
      t.world.idb.peek(DB, "sync_state", "singleton") as {
        read_retry_states: Record<string, { paused: boolean }>;
      }
    ).read_retry_states;
    expect(budget["defaults:1"]?.paused).toBe(true);
    t.env.dispose();
  });

  test("with no database: the read is made, held in memory only, and NO database is created", async () => {
    const t = await defaultsWorld({
      database: false,
      answers: [ok(snapshot())],
    });
    t.env.defaults.use();
    await t.settle();
    expect(t.asked).toEqual([[ACCOUNT, 1]]);
    expect(t.env.defaults.record.get()?.snapshot).toEqual(snapshot());
    expect(t.databaseExists()).toBe(false);
    t.env.dispose();
  });

  test("the identity moves while the read is pending: the answer is discarded, nothing is shown or written for anyone", async () => {
    const t = await defaultsWorld({ hold: true });
    t.env.defaults.use();
    await t.settle();
    expect(t.held).toHaveLength(1);
    t.identity.set({ account_id: ACCOUNT, epoch: 2, session_id: "s2" });
    await t.settle();
    t.release(ok(snapshot()));
    await t.settle();
    // The epoch-1 answer is not the epoch-2 identity's.
    expect(t.stored()).toBeNull();
    expect(t.env.defaults.record.get()).toBeNull();
    t.env.dispose();
  });

  test("an identity change forgets what memory held: another account never sees it", async () => {
    const t = await defaultsWorld({
      database: false,
      answers: [ok(snapshot())],
    });
    t.env.defaults.use();
    await t.settle();
    expect(t.env.defaults.record.get()).not.toBeNull();
    t.identity.set({ account_id: OTHER, epoch: 1, session_id: "o" });
    await t.settle();
    expect(t.env.defaults.record.get()).toBeNull();
    // And back: the memory of the earlier sign-in is gone; only what the account's own reads or database hold may show.
    t.identity.set({ account_id: ACCOUNT, epoch: 3, session_id: "s3" });
    await t.settle();
    expect(t.env.defaults.record.get()).toBeNull();
    t.env.dispose();
  });
});

describe("refresh(): one read now, for the person's act", () => {
  test("resolves `fetched` with the new record, and is not counted in the budget", async () => {
    const t = await defaultsWorld({
      answers: [ok(snapshot()), ok(snapshot({ revision: revision(2) }))],
    });
    t.env.defaults.use();
    await t.settle();
    expect(await t.env.defaults.refresh()).toBe("fetched");
    await t.settle();
    expect(t.env.defaults.record.get()?.snapshot.defaults.revision).toBe(
      revision(2),
    );
    expect(t.stored()).toEqual(t.env.defaults.record.get());
    t.env.dispose();
  });

  test("offline: `offline` and no request; a failure: `failed`; an unrecognised body: `failed` and nothing kept", async () => {
    const t = await defaultsWorld({ online: false });
    expect(await t.env.defaults.refresh()).toBe("offline");
    expect(t.asked).toEqual([]);
    t.online.set(true);
    t.answers.push({ kind: "failure" }, ok({ defaults: 1 }));
    expect(await t.env.defaults.refresh()).toBe("failed");
    expect(await t.env.defaults.refresh()).toBe("failed");
    expect(t.env.defaults.record.get()).toBeNull();
    t.env.dispose();
  });

  test("two refreshes at once share one read", async () => {
    const t = await defaultsWorld({ hold: true });
    // ADAPTED in WEB-12a review 4 (R10): the refreshes are issued once the page has bound its database. Issued while the look was still
    // under way, a read is asked with no binding, and the database that binds meanwhile makes it obsolete (`closed`; Q5 below).
    await t.settle();
    const a = t.env.defaults.refresh();
    const b = t.env.defaults.refresh();
    await t.settle();
    expect(t.held).toHaveLength(1);
    t.release(ok(snapshot()));
    expect(await a).toBe("fetched");
    expect(await b).toBe("fetched");
    t.env.dispose();
  });
});

describe("two reads landing out of order: the one ASKED later stands", () => {
  test("an earlier-issued answer that lands last does not replace the later one, in memory or in the database", async () => {
    const t = await defaultsWorld({ hold: true });
    t.env.defaults.use();
    await t.settle();
    // The follow task's read (issued first) is held; a refresh issued later is held too.
    await t.advance(1_000);
    const later = t.env.defaults.refresh();
    await t.settle();
    expect(t.held).toHaveLength(2);
    const [first, second] = t.held.splice(0, 2);
    second?.(ok(snapshot({ revision: revision(2) })));
    expect(await later).toBe("fetched");
    await t.settle();
    first?.(ok(snapshot({ revision: revision(1) })));
    await t.settle();
    expect(t.env.defaults.record.get()?.snapshot.defaults.revision).toBe(
      revision(2),
    );
    expect(
      (t.stored() as { snapshot: { defaults: { revision: string } } }).snapshot
        .defaults.revision,
    ).toBe(revision(2));
    t.env.dispose();
  });
});

describe("every persistence is ordered against the session (G5)", () => {
  test("MU-D20: a commit whose persistence hold is STALE (the session record moved on) persists nothing; memory still shows the verified snapshot", async () => {
    let holds = 0;
    const t = await defaultsWorld({
      answers: [ok(snapshot())],
      persistence: {
        hold: async () => {
          holds += 1;
          return { kind: "stale" };
        },
      },
    });
    t.env.defaults.use();
    await t.settle();
    expect(t.env.defaults.record.get()?.snapshot).toEqual(snapshot());
    expect(holds).toBeGreaterThanOrEqual(1);
    expect(t.stored()).toBeNull();
    t.env.dispose();
  });
});

describe("growth is admitted through the quota ledger (R28)", () => {
  test("a refused reservation persists nothing (memory still shows the verified snapshot)", async () => {
    const settled: string[] = [];
    const quota: QuotaGuard = {
      check: async () => "refuse",
      reserve: async () => ({
        verdict: "refuse",
        live: () => false,
        settle: (outcome) => {
          settled.push(outcome);
        },
      }),
      lastFree: () => 0,
      invalidate: () => undefined,
    };
    const t = await defaultsWorld({ quota, answers: [ok(snapshot())] });
    t.env.defaults.use();
    await t.settle();
    expect(t.env.defaults.record.get()?.snapshot).toEqual(snapshot());
    expect(t.stored()).toBeNull();
    t.env.dispose();
  });

  test("a hold that lapsed before the transaction decided writes nothing, and is settled not_written", async () => {
    const settled: string[] = [];
    const quota: QuotaGuard = {
      check: async () => "ok",
      reserve: async () => ({
        verdict: "ok",
        live: () => false,
        settle: (outcome) => {
          settled.push(outcome);
        },
      }),
      lastFree: () => 1e9,
      invalidate: () => undefined,
    };
    const t = await defaultsWorld({ quota, answers: [ok(snapshot())] });
    t.env.defaults.use();
    await t.settle();
    expect(t.stored()).toBeNull();
    expect(settled).toEqual(["not_written"]);
    t.env.dispose();
  });
});

describe("acquire(boundary): a snapshot asked for AFTER the caller's moment (WEB-12a review 2, R7)", () => {
  /** A page whose defaults are already followed (an existing screen uses them) and whose first read has been answered. */
  async function followed() {
    const t = await defaultsWorld({ hold: true });
    const unuse = t.env.defaults.use();
    await t.settle();
    t.release(ok(snapshot()));
    await t.settle();
    expect(t.asked).toHaveLength(1);
    expect(t.held).toHaveLength(0);
    return { ...t, unuse };
  }
  const revisionOf = (got: Acquisition) =>
    got.record?.snapshot.defaults.revision ?? null;
  /** Whether `promise` has settled yet. */
  const settledYet = (promise: Promise<unknown>) => {
    let done = false;
    void promise.then(() => {
      done = true;
    });
    return () => done;
  };

  test("MU-D21: a refresh under way that PREDATES the boundary is not shared: the acquisition issues its own read at once, and the older success does not answer it", async () => {
    const t = await followed();
    await t.advance(1_000);
    const older = t.env.defaults.refresh();
    await t.settle();
    expect(t.asked).toHaveLength(2);
    await t.advance(1_000);
    const opened = t.now();
    const got = t.env.defaults.acquire(t.env.defaults.boundary());
    await t.settle();
    // Issued while the older one is still held: it is not waited for.
    expect(t.asked).toHaveLength(3);
    const done = settledYet(got);
    const [a, b] = t.held.splice(0, 2);
    a?.(ok(snapshot({ revision: revision(2) })));
    expect(await older).toBe("fetched");
    await t.settle();
    expect(done()).toBe(false);
    b?.(ok(snapshot({ revision: revision(3) })));
    const answer = await got;
    expect(answer.outcome).toBe("fetched");
    expect(revisionOf(answer)).toBe(revision(3));
    expect(answer.record?.issued_at).toBeGreaterThanOrEqual(opened);
    // The later-issued record is the one shown and persisted.
    expect(t.env.defaults.record.get()?.snapshot.defaults.revision).toBe(
      revision(3),
    );
    t.unuse();
    t.env.dispose();
  });

  test("MU-D21: completions in reverse order: the acquisition's own read lands first and answers it; the older one landing later replaces nothing", async () => {
    const t = await followed();
    await t.advance(1_000);
    const older = t.env.defaults.refresh();
    await t.settle();
    await t.advance(1_000);
    const got = t.env.defaults.acquire(t.env.defaults.boundary());
    await t.settle();
    expect(t.asked).toHaveLength(3);
    const [a, b] = t.held.splice(0, 2);
    b?.(ok(snapshot({ revision: revision(3) })));
    expect(revisionOf(await got)).toBe(revision(3));
    a?.(ok(snapshot({ revision: revision(2) })));
    expect(await older).toBe("fetched");
    await t.settle();
    expect(t.env.defaults.record.get()?.snapshot.defaults.revision).toBe(
      revision(3),
    );
    t.unuse();
    t.env.dispose();
  });

  test("MU-D21: the older read's FAILURE does not fail the acquisition, and the acquisition's own failure is reported even though the older read succeeded", async () => {
    const t = await followed();
    await t.advance(1_000);
    const olderFails = t.env.defaults.refresh();
    await t.settle();
    await t.advance(1_000);
    const got = t.env.defaults.acquire(t.env.defaults.boundary());
    await t.settle();
    const [a, b] = t.held.splice(0, 2);
    a?.({ kind: "failure" });
    expect(await olderFails).toBe("failed");
    b?.(ok(snapshot({ revision: revision(3) })));
    expect((await got).outcome).toBe("fetched");

    await t.advance(1_000);
    const olderSucceeds = t.env.defaults.refresh();
    await t.settle();
    await t.advance(1_000);
    const second = t.env.defaults.acquire(t.env.defaults.boundary());
    await t.settle();
    const [c, d] = t.held.splice(0, 2);
    c?.(ok(snapshot({ revision: revision(4) })));
    expect(await olderSucceeds).toBe("fetched");
    d?.({ kind: "failure" });
    expect(await second).toEqual({ outcome: "failed", record: null });
    t.unuse();
    t.env.dispose();
  });

  test("MU-D21: the follower's read under way that predates the boundary is not taken for it either", async () => {
    const t = await defaultsWorld({ hold: true });
    const unuse = t.env.defaults.use();
    await t.settle();
    expect(t.asked).toHaveLength(1);
    await t.advance(1_000);
    const got = t.env.defaults.acquire(t.env.defaults.boundary());
    await t.settle();
    expect(t.asked).toHaveLength(2);
    const done = settledYet(got);
    const [follow, own] = t.held.splice(0, 2);
    follow?.(ok(snapshot({ revision: revision(2) })));
    await t.settle();
    expect(done()).toBe(false);
    own?.(ok(snapshot({ revision: revision(3) })));
    expect(revisionOf(await got)).toBe(revision(3));
    unuse();
    t.env.dispose();
  });

  test("MU-D21: a refresh issued in the SAME millisecond as the boundary but before it is not shared (the issue order decides, not the clock)", async () => {
    const t = await followed();
    const older = t.env.defaults.refresh();
    const sameTime = t.now();
    const got = t.env.defaults.acquire(t.env.defaults.boundary());
    await t.settle();
    expect(t.now()).toBe(sameTime);
    expect(t.asked).toHaveLength(3);
    const [a, b] = t.held.splice(0, 2);
    a?.(ok(snapshot({ revision: revision(2) })));
    expect(await older).toBe("fetched");
    b?.(ok(snapshot({ revision: revision(3) })));
    expect(revisionOf(await got)).toBe(revision(3));
    t.unuse();
    t.env.dispose();
  });

  test("DA-O1 (the current cache rule; the stricter one is an open owner decision): same-millisecond reads completing in reverse: the acquisition is answered by its own read, while memory and storage keep the LAST completion, because equal times replace", async () => {
    const t = await followed();
    const older = t.env.defaults.refresh();
    const got = t.env.defaults.acquire(t.env.defaults.boundary());
    await t.settle();
    expect(t.asked).toHaveLength(3);
    const [a, b] = t.held.splice(0, 2);
    b?.(ok(snapshot({ revision: revision(3) })));
    // The caller's own answer is strict: issue order, not the clock.
    expect(revisionOf(await got)).toBe(revision(3));
    a?.(ok(snapshot({ revision: revision(2) })));
    expect(await older).toBe("fetched");
    await t.settle();
    // The shared record follows `issued_at` and accepts an equal one (W14's equal-time rule), so the earlier-issued answer that landed
    // last is what memory and storage hold. Recorded, not endorsed: docs/sharing.md item 9 and the design assessment's Decision O.
    expect(t.env.defaults.record.get()?.snapshot.defaults.revision).toBe(
      revision(2),
    );
    expect(
      (t.stored() as { snapshot: { defaults: { revision: string } } }).snapshot
        .defaults.revision,
    ).toBe(revision(2));
    t.unuse();
    t.env.dispose();
  });

  test("control: a refresh issued AFTER the boundary is shared (one read), and a later boundary is answered only by its own read", async () => {
    const t = await followed();
    const first = t.env.defaults.boundary();
    const refreshed = t.env.defaults.refresh();
    const got = t.env.defaults.acquire(first);
    await t.settle();
    expect(t.asked).toHaveLength(2);
    // A second caller marks its moment while that read is under way: it needs its own.
    const second = t.env.defaults.acquire(t.env.defaults.boundary());
    await t.settle();
    expect(t.asked).toHaveLength(3);
    // The first boundary may share the newest qualifying read too.
    const again = t.env.defaults.acquire(first);
    await t.settle();
    expect(t.asked).toHaveLength(3);
    const [shared, own] = t.held.splice(0, 2);
    own?.(ok(snapshot({ revision: revision(5) })));
    expect(revisionOf(await second)).toBe(revision(5));
    expect(revisionOf(await again)).toBe(revision(5));
    shared?.(ok(snapshot({ revision: revision(4) })));
    expect(await refreshed).toBe("fetched");
    expect(revisionOf(await got)).toBe(revision(4));
    t.unuse();
    t.env.dispose();
  });

  test("MU-D22: a boundary of another (account, epoch) is closed without a request, and an identity that moves before the answer is closed too", async () => {
    const t = await followed();
    const stale = t.env.defaults.boundary();
    t.identity.set({ account_id: ACCOUNT, epoch: 2, session_id: "s" });
    await t.settle();
    const asked = t.asked.length;
    const answer = t.env.defaults.acquire(stale);
    await t.settle();
    // Asserted before the answer is awaited: a read issued for the new identity would be held, and only this says why.
    expect(t.asked).toHaveLength(asked);
    expect(await answer).toEqual({ outcome: "closed", record: null });
    // While a read for the current identity is under way, the identity moves: no answer for the earlier one.
    for (const resolve of t.held.splice(0)) resolve(ok(snapshot()));
    await t.settle();
    const pending = t.env.defaults.acquire(t.env.defaults.boundary());
    await t.settle();
    t.identity.set({ account_id: OTHER, epoch: 1, session_id: "s" });
    for (const resolve of t.held.splice(0)) resolve(ok(snapshot()));
    expect(await pending).toEqual({ outcome: "closed", record: null });
    expect(await t.env.defaults.acquire(null)).toEqual({
      outcome: "closed",
      record: null,
    });
    t.unuse();
    t.env.dispose();
  });

  test("offline: `offline` and no request", async () => {
    const t = await defaultsWorld({ online: false });
    expect(await t.env.defaults.acquire(t.env.defaults.boundary())).toEqual({
      outcome: "offline",
      record: null,
    });
    expect(t.asked).toEqual([]);
    t.env.dispose();
  });
});

describe("an answer belongs to the database binding it was asked under (WEB-12a review 4, R10)", () => {
  /** A quota guard whose reservations wait for `admit` (Q3). */
  function heldQuota() {
    const settled: string[] = [];
    const waiting: Array<() => void> = [];
    let reserved = 0;
    const quota: QuotaGuard = {
      check: async () => "ok",
      reserve: async () => {
        reserved += 1;
        await new Promise<void>((resolve) => waiting.push(resolve));
        return {
          verdict: "ok",
          live: () => true,
          settle: (outcome) => {
            settled.push(outcome);
          },
        };
      },
      lastFree: () => 1e9,
      invalidate: () => undefined,
    };
    return {
      quota,
      settled,
      reserved: () => reserved,
      admit: () => waiting.shift()?.(),
    };
  }
  type World = Awaited<ReturnType<typeof defaultsWorld>>;
  /** The page closes the account's connections, the database is deleted, and a new one (a new incarnation) is created and bound. */
  async function replaceDatabase(t: World) {
    const before = t.env.service();
    expect(before?.live).toBe(true);
    t.page.registry.closeAll(ACCOUNT);
    await t.settle();
    expect(before?.live).toBe(false);
    expect(await t.world.run(t.page.host.delete(DB))).toMatch(/deleted/);
    expect(t.databaseExists()).toBe(false);
    await t.create();
    // The identity is published again (as the session does at every evaluation): the controller looks for the database and binds it.
    t.identity.set({
      ...(t.identity.get() as NonNullable<ReturnType<typeof t.identity.get>>),
    });
    await t.settle();
    const after = t.env.service();
    expect(after?.live).toBe(true);
    expect(after).not.toBe(before);
    expect(after?.incarnationId).not.toBe(before?.incarnationId);
    expect(t.stored()).toBeNull();
    return { before, after };
  }
  const revisionStored = (t: World) =>
    (t.stored() as { snapshot: { defaults: { revision: string } } } | null)
      ?.snapshot.defaults.revision ?? null;
  const revisionShown = (t: World) =>
    t.env.defaults.record.get()?.snapshot.defaults.revision ?? null;

  test("Q1 control: an answer whose binding stands is shown, persisted into the incarnation it was asked under and returned", async () => {
    const t = await defaultsWorld({ hold: true });
    await t.settle();
    const service = t.env.service();
    const got = t.env.defaults.acquire(t.env.defaults.boundary());
    await t.settle();
    expect(t.held).toHaveLength(1);
    t.release(ok(snapshot({ revision: revision(7) })));
    expect((await got).outcome).toBe("fetched");
    await t.settle();
    expect(revisionStored(t)).toBe(revision(7));
    expect(revisionShown(t)).toBe(revision(7));
    expect(t.env.service()).toBe(service);
    t.env.dispose();
  });

  test("MU-D23 (Q1): an answer asked before the database was deleted and opened again never populates the replacement incarnation", async () => {
    const t = await defaultsWorld({ hold: true });
    await t.settle();
    const got = t.env.defaults.acquire(t.env.defaults.boundary());
    await t.settle();
    expect(t.held).toHaveLength(1);
    await replaceDatabase(t);
    t.release(ok(snapshot({ revision: revision(8) })));
    const outcome = await got;
    await t.settle();
    expect(t.stored()).toBeNull();
    expect(revisionShown(t)).toBeNull();
    expect(outcome).toEqual({ outcome: "closed", record: null });
    // A fresh request, asked under the binding that stands, is persisted into it.
    const fresh = t.env.defaults.acquire(t.env.defaults.boundary());
    await t.settle();
    expect(t.held).toHaveLength(1);
    t.release(ok(snapshot({ revision: revision(9) })));
    expect((await fresh).outcome).toBe("fetched");
    await t.settle();
    expect(revisionStored(t)).toBe(revision(9));
    expect(revisionShown(t)).toBe(revision(9));
    t.env.dispose();
  });

  test("MU-D23 (Q2): through refresh() too, and a service replaced on the SAME incarnation is not the authority for an answer asked before it", async () => {
    const t = await defaultsWorld({ hold: true });
    await t.settle();
    const first = t.env.service();
    const incarnation = first?.incarnationId;
    const got = t.env.defaults.refresh();
    await t.settle();
    expect(t.held).toHaveLength(1);
    // The page closes its connections and opens the same database again: a new service, the same incarnation.
    t.page.registry.closeAll(ACCOUNT);
    await t.settle();
    t.identity.set({
      ...(t.identity.get() as NonNullable<ReturnType<typeof t.identity.get>>),
    });
    await t.settle();
    const second = t.env.service();
    expect(second?.live).toBe(true);
    expect(second).not.toBe(first);
    expect(second?.incarnationId).toBe(incarnation);
    t.release(ok(snapshot({ revision: revision(8) })));
    expect(await got).toBe("closed");
    await t.settle();
    expect(t.stored()).toBeNull();
    expect(revisionShown(t)).toBeNull();
    const fresh = t.env.defaults.refresh();
    await t.settle();
    expect(t.held).toHaveLength(1);
    t.release(ok(snapshot({ revision: revision(9) })));
    expect(await fresh).toBe("fetched");
    await t.settle();
    expect(revisionStored(t)).toBe(revision(9));
    t.env.dispose();
  });

  test("MU-D24 (Q2): the automatic read asked before the replacement writes nothing into it, and the follower asks again under the binding that stands", async () => {
    const t = await defaultsWorld({ hold: true });
    await t.settle();
    t.env.defaults.use();
    await t.settle();
    expect(t.held).toHaveLength(1);
    await replaceDatabase(t);
    t.release(ok(snapshot({ revision: revision(8) })));
    await t.settle();
    expect(t.stored()).toBeNull();
    expect(revisionShown(t)).toBeNull();
    // Asked again, uncounted, under the new binding.
    await t.advance(60_000);
    expect(t.held).toHaveLength(1);
    expect(t.asked).toHaveLength(2);
    t.release(ok(snapshot({ revision: revision(9) })));
    await t.settle();
    expect(revisionStored(t)).toBe(revision(9));
    expect(revisionShown(t)).toBe(revision(9));
    t.env.dispose();
  });

  test("MU-D25 (Q3): a binding replaced while the write waits for its quota admission: nothing is committed through the new service, the reservation is settled once, and the answer is not shown or returned", async () => {
    const q = heldQuota();
    const t = await defaultsWorld({ hold: true, quota: q.quota });
    await t.settle();
    const got = t.env.defaults.acquire(t.env.defaults.boundary());
    await t.settle();
    t.release(ok(snapshot({ revision: revision(8) })));
    await t.settle();
    expect(q.reserved()).toBe(1);
    // Published while the binding stood (memory before the optional write).
    expect(revisionShown(t)).toBe(revision(8));
    await replaceDatabase(t);
    // Its binding has gone: what memory holds of it is out of view at once.
    expect(revisionShown(t)).toBeNull();
    q.admit();
    const outcome = await got;
    await t.settle();
    expect(t.stored()).toBeNull();
    expect(revisionShown(t)).toBeNull();
    expect(outcome).toEqual({ outcome: "closed", record: null });
    expect(q.settled).toEqual(["not_written"]);
    t.env.dispose();
  });

  test("Q3 control: the same admission with the binding unchanged writes, settles `written` once and returns the record", async () => {
    const q = heldQuota();
    const t = await defaultsWorld({ hold: true, quota: q.quota });
    await t.settle();
    const got = t.env.defaults.acquire(t.env.defaults.boundary());
    await t.settle();
    t.release(ok(snapshot({ revision: revision(8) })));
    await t.settle();
    q.admit();
    expect((await got).outcome).toBe("fetched");
    await t.settle();
    expect(revisionStored(t)).toBe(revision(8));
    expect(q.settled).toEqual(["written"]);
    t.env.dispose();
  });

  test("Q4: a persistence hold (G5) released after the binding ended: the old service writes nothing and nothing is published", async () => {
    const gates: Array<() => void> = [];
    const t = await defaultsWorld({
      hold: true,
      persistence: {
        hold: async () => {
          await new Promise<void>((resolve) => gates.push(resolve));
          return {
            kind: "held",
            valid: () => true,
            revoked: new AbortController().signal,
            track: () => undefined,
            release: () => undefined,
          } as never;
        },
      },
    });
    await t.settle();
    const got = t.env.defaults.acquire(t.env.defaults.boundary());
    await t.settle();
    t.release(ok(snapshot({ revision: revision(8) })));
    await t.settle();
    expect(gates).toHaveLength(1);
    await replaceDatabase(t);
    for (const open of gates.splice(0)) open();
    const outcome = await got;
    await t.settle();
    expect(t.stored()).toBeNull();
    expect(revisionShown(t)).toBeNull();
    expect(outcome).toEqual({ outcome: "closed", record: null });
    t.env.dispose();
  });

  test("Q5: with no database, an answer is kept in memory only while none is open; one that opens meanwhile makes it obsolete, and it is never written there", async () => {
    // Known absent: memory only, and nothing is created.
    const t = await defaultsWorld({ database: false, hold: true });
    await t.settle();
    const memoryOnly = t.env.defaults.refresh();
    await t.settle();
    t.release(ok(snapshot({ revision: revision(5) })));
    expect(await memoryOnly).toBe("fetched");
    expect(revisionShown(t)).toBe(revision(5));
    expect(t.databaseExists()).toBe(false);
    // Asked with none open; a database opens before the answer.
    const late = t.env.defaults.refresh();
    await t.settle();
    expect(t.held).toHaveLength(1);
    await t.create();
    t.identity.set({
      ...(t.identity.get() as NonNullable<ReturnType<typeof t.identity.get>>),
    });
    await t.settle();
    expect(t.env.service()?.live).toBe(true);
    // The memory-only record was the no-database binding's: it is not shown over the database that opened.
    expect(revisionShown(t)).toBeNull();
    t.release(ok(snapshot({ revision: revision(6) })));
    expect(await late).toBe("closed");
    await t.settle();
    expect(t.stored()).toBeNull();
    expect(revisionShown(t)).toBeNull();
    // A fresh request after the attachment succeeds and is persisted.
    const fresh = t.env.defaults.refresh();
    await t.settle();
    t.release(ok(snapshot({ revision: revision(7) })));
    expect(await fresh).toBe("fetched");
    await t.settle();
    expect(revisionStored(t)).toBe(revision(7));
    t.env.dispose();
  });

  test("MU-D28 (Q5): asked with no database open; one opens and ends again before the answer: a binding intervened, so it is obsolete", async () => {
    const t = await defaultsWorld({ database: false, hold: true });
    await t.settle();
    const late = t.env.defaults.refresh();
    await t.settle();
    expect(t.held).toHaveLength(1);
    await t.create();
    t.identity.set({
      ...(t.identity.get() as NonNullable<ReturnType<typeof t.identity.get>>),
    });
    await t.settle();
    expect(t.env.service()?.live).toBe(true);
    t.page.registry.closeAll(ACCOUNT);
    await t.settle();
    // No database is bound again, exactly as when the read was asked: but one stood in between.
    expect(t.env.service()).toBeNull();
    t.release(ok(snapshot({ revision: revision(6) })));
    expect(await late).toBe("closed");
    await t.settle();
    expect(revisionShown(t)).toBeNull();
    t.env.dispose();
  });

  test("Q5: asked while the look for the database is still under way, and the database binds before the answer: obsolete, never written", async () => {
    const t = await defaultsWorld({ hold: true });
    const early = t.env.defaults.refresh();
    await t.settle();
    expect(t.env.service()?.live).toBe(true);
    expect(t.held).toHaveLength(1);
    t.release(ok(snapshot({ revision: revision(6) })));
    expect(await early).toBe("closed");
    await t.settle();
    expect(t.stored()).toBeNull();
    expect(revisionShown(t)).toBeNull();
    t.env.dispose();
  });

  test("MU-D26 (Q6): what memory held under a binding that has gone is never shown over the replacement, and the follower reads again under it", async () => {
    const t = await defaultsWorld({ hold: true });
    await t.settle();
    t.env.defaults.use();
    await t.settle();
    t.release(ok(snapshot({ revision: revision(7) })));
    await t.settle();
    expect(revisionStored(t)).toBe(revision(7));
    expect(revisionShown(t)).toBe(revision(7));
    expect(t.asked).toHaveLength(1);
    await replaceDatabase(t);
    // The replacement holds nothing: neither the old memory nor the old database's record is shown.
    expect(revisionShown(t)).toBeNull();
    expect(t.env.defaults.settled.get()).toBe(true);
    // The completed automatic read belonged to the old binding: it is asked again under the new one, and persisted there.
    expect(t.asked).toHaveLength(2);
    t.release(ok(snapshot({ revision: revision(9) })));
    await t.settle();
    expect(revisionStored(t)).toBe(revision(9));
    expect(revisionShown(t)).toBe(revision(9));
    t.env.dispose();
  });

  test("Q6 control: an offline reload of an unchanged database hydrates its record without a request", async () => {
    const t = await defaultsWorld({
      online: false,
      persisted: record(snapshot({ revision: revision(4) })),
    });
    t.env.defaults.use();
    await t.settle();
    expect(revisionShown(t)).toBe(revision(4));
    expect(t.env.defaults.settled.get()).toBe(true);
    expect(t.asked).toEqual([]);
    t.env.dispose();
  });

  test("MU-D27 (Q7): a read asked in an earlier lifetime of the controller (stopped and started again) answers, shares and writes nothing in the new one", async () => {
    const t = await defaultsWorld({ hold: true });
    await t.settle();
    const old = t.env.defaults.acquire(t.env.defaults.boundary());
    await t.settle();
    expect(t.held).toHaveLength(1);
    t.env.dispose();
    t.env.start();
    await t.settle();
    // A refresh of the new lifetime does not share the old read: it asks its own.
    const fresh = t.env.defaults.refresh();
    await t.settle();
    expect(t.held).toHaveLength(2);
    t.release(ok(snapshot({ revision: revision(8) })));
    expect(await old).toEqual({ outcome: "closed", record: null });
    await t.settle();
    expect(t.stored()).toBeNull();
    expect(revisionShown(t)).toBeNull();
    t.release(ok(snapshot({ revision: revision(9) })));
    expect(await fresh).toBe("fetched");
    await t.settle();
    expect(revisionStored(t)).toBe(revision(9));
    t.env.dispose();
  });

  test("Q7 control: letting go of a use lease and using again does not end an explicit read under way", async () => {
    const t = await defaultsWorld({ hold: true });
    await t.settle();
    const release = t.env.defaults.use();
    await t.settle();
    t.release(ok(snapshot({ revision: revision(5) })));
    await t.settle();
    const got = t.env.defaults.acquire(t.env.defaults.boundary());
    await t.settle();
    expect(t.held).toHaveLength(1);
    release();
    t.env.defaults.use();
    await t.settle();
    t.release(ok(snapshot({ revision: revision(6) })));
    expect((await got).outcome).toBe("fetched");
    await t.settle();
    expect(revisionStored(t)).toBe(revision(6));
    t.env.dispose();
  });
});
