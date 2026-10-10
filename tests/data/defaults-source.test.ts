// @vitest-environment node
import { describe, expect, test } from "vitest";
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
