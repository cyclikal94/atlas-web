import type { BrowserContext, Page } from "@playwright/test";
import {
  accountDatabaseName,
  DEXIE_SCHEMA,
  parseSchema,
  SCHEMA_VERSION,
  STORE_NAMES,
} from "../../src/data/model/schema";
import { recordEvidence } from "./data-evidence";
import { expect, test } from "./helpers";

/**
 * E-A1, E-A2, E-A3 and E-W2 (plan 8.1): the PRODUCTION Dexie adapter, raw-IndexedDB host, registry and open predicate in a real
 * engine, through the fixture-only data harness (`/__data`), with no session and no backend. Two pages of one browser context
 * are two tabs of one origin. FIXTURE evidence for this engine on this machine: not real Safari, not a device, not quota.
 */
declare global {
  interface Window {
    __deleteCalls: string[];
  }
}

async function openPage(context: BrowserContext): Promise<Page> {
  const page = await context.newPage();
  await page.addInitScript(() => {
    window.__deleteCalls = [];
    const original = indexedDB.deleteDatabase.bind(indexedDB);
    indexedDB.deleteDatabase = (name: string) => {
      window.__deleteCalls.push(name);
      return original(name);
    };
  });
  await page.goto("/__data");
  await page.waitForFunction(() => window.__atlasData !== undefined);
  return page;
}

const uuid = () => crypto.randomUUID();

test.describe("the shared conformance suite, against the REAL adapter", () => {
  test("E-A3: every conformance case passes in this engine", async ({
    context,
  }, info) => {
    const page = await openPage(context);
    const results = await page.evaluate(() =>
      window.__atlasData?.runConformance(),
    );
    recordEvidence(info, "conformance", results);
    expect(results?.length).toBeGreaterThanOrEqual(11);
    expect(results?.filter((result) => !result.ok)).toEqual([]);
  });
});

test.describe("E-A1: the database a first open creates", () => {
  test("version 2 has exactly the ten stores and indexes (the nine of version 1 and `draft_commands`, with the nested and compound indexes of the drafts store), and the singleton exists in the creating transaction", async ({
    context,
  }, info) => {
    const page = await openPage(context);
    const account = uuid();
    const outcome = await page.evaluate(async (a) => {
      window.__atlasData?.setIdentity(a);
      return window.__atlasData?.open(a, { create: true });
    }, account);
    expect(outcome).toBe("created");
    const description = await page.evaluate(
      (a) => window.__atlasData?.describe(a),
      account,
    );
    recordEvidence(info, "schema", description);
    expect(Object.keys(description?.stores ?? {}).sort()).toEqual(
      [...STORE_NAMES].sort(),
    );
    for (const store of STORE_NAMES) {
      const expected = parseSchema(store);
      const actual = description?.stores[store];
      expect(actual?.keyPath, `${store} key path`).toEqual(expected.keyPath);
      expect(
        actual?.indexes
          .map((index) => ({
            name: index.name,
            keyPath: index.keyPath,
            multiEntry: index.multiEntry,
          }))
          .sort((a, b) => a.name.localeCompare(b.name)),
        `${store} indexes`,
      ).toEqual(
        expected.indexes
          .map((index) => ({
            name: index.name,
            keyPath: index.keyPath,
            multiEntry: index.multiEntry,
          }))
          .sort((a, b) => a.name.localeCompare(b.name)),
      );
    }
    expect(DEXIE_SCHEMA.drafts).toContain("*index_targets");
    // The indexes the dispatcher and the summary rely on exist in THIS engine, nested key paths and the compound key included.
    expect(
      description?.stores.drafts?.indexes.map((index) => index.name).sort(),
    ).toEqual(
      [
        "[status+created_seq]",
        "created_seq",
        "depends_on",
        "index_targets",
        "retry_state.state",
        "review_block.kind",
        "status",
      ].sort(),
    );
    // Dexie's version n is IndexedDB version 10 n.
    expect(description?.version).toBe(SCHEMA_VERSION * 10);
    expect(description?.singleton?.cache_status).toBe("empty");
    expect(description?.singleton?.incarnation_id).toBeTruthy();
    expect(await page.evaluate(() => window.__atlasData?.list())).toContain(
      accountDatabaseName(account),
    );
  });
});

test.describe("E-A4: a database created by version 1 is upgraded in place", () => {
  test("every draft's command moves to `draft_commands` (one draft at a time), the header gains its kind, nothing else changes, and a second open is a no-op", async ({
    context,
  }, info) => {
    const page = await openPage(context);
    const account = uuid();
    const payload = "naïve ☃ 𝔘 ".repeat(20_000);
    await page.evaluate(
      async ([a, text]) => {
        window.__atlasData?.setIdentity(a as string);
        await window.__atlasData?.createLegacyV1(a as string, [
          {
            local_id: "one",
            created_seq: 1,
            command: { kind: "create", id: "x" },
          },
          {
            local_id: "two",
            created_seq: 2,
            command: { commands: [{ kind: "import", payload: text }] },
          },
        ]);
      },
      [account, payload],
    );
    const opened = await page.evaluate(
      (a) => window.__atlasData?.open(a, { create: false }),
      account,
    );
    expect(opened).toBe("opened");
    const description = await page.evaluate(
      (a) => window.__atlasData?.describe(a),
      account,
    );
    // Dexie's version n is IndexedDB version 10 n.
    expect(description?.version).toBe(SCHEMA_VERSION * 10);
    expect(Object.keys(description?.stores ?? {}).sort()).toEqual(
      [...STORE_NAMES].sort(),
    );
    const read = () =>
      page.evaluate(async (a) => {
        const data = window.__atlasData;
        if (!data) throw new Error("no harness");
        return {
          headers: (await data.rows(a, "drafts")) as Array<
            Record<string, unknown>
          >,
          bodies: (await data.rows(a, "draft_commands")) as Array<
            Record<string, unknown>
          >,
        };
      }, account);
    const first = await read();
    recordEvidence(info, "upgrade-v1-to-v2", {
      headers: first.headers.length,
      bodies: first.bodies.length,
      kinds: first.headers.map((header) => header.kind),
    });
    expect(first.headers.map((header) => header.local_id).sort()).toEqual([
      "one",
      "two",
    ]);
    for (const header of first.headers) expect("command" in header).toBe(false);
    expect(first.headers.map((header) => header.kind).sort()).toEqual([
      "create",
      "import",
    ]);
    expect(first.bodies.map((body) => body.local_id).sort()).toEqual([
      "one",
      "two",
    ]);
    expect(
      first.bodies.find((body) => body.local_id === "two")?.command,
    ).toEqual({ commands: [{ kind: "import", payload }] });
    // The singleton and its incarnation survive an upgrade untouched.
    expect(description?.singleton?.incarnation_id).toBe("legacy-incarnation");
    // A second open (a reload) changes nothing.
    await page.evaluate((a) => window.__atlasData?.close(a), account);
    await page.evaluate(
      (a) => window.__atlasData?.open(a, { create: false }),
      account,
    );
    expect(await read()).toEqual(first);
  });
});

test.describe("E-A2: a database that exists without its singleton is re-seeded IN PLACE", () => {
  test("drafts survive, the incarnation is new, cache_status is empty and deleteDatabase is never called", async ({
    context,
  }, info) => {
    const page = await openPage(context);
    const account = uuid();
    await page.evaluate(async (a) => {
      window.__atlasData?.setIdentity(a);
      await window.__atlasData?.open(a, { create: true });
    }, account);
    const before = await page.evaluate(async (a) => {
      const data = window.__atlasData;
      if (!data) throw new Error("no harness");
      await data.put(a, "drafts", [
        {
          local_id: "kept",
          account_id: a,
          endpoint: "/commands",
          target_id: null,
          command: {},
          command_digest: "x",
          defaults_revision: null,
          target_resource_ids: [],
          side_effect_bases: {},
          index_targets: [],
          bases: {},
          bumped: [],
          defaults_context: null,
          review_block: null,
          depends_on: [],
          status: "queued",
          held_pending_cache: false,
          unavailable_outcome: false,
          retry_state: null,
          attempts: 0,
          last_attempt_at: null,
          last_error: null,
          display_patch: null,
          receipt_revision: null,
          created_seq: 1,
          created_at: "2026-10-01T09:00:00.000Z",
        },
      ]);
      const incarnation = data.incarnation(a);
      data.close(a);
      await data.removeSingleton(a);
      return incarnation;
    }, account);
    const after = await page.evaluate(async (a) => {
      const data = window.__atlasData;
      if (!data) throw new Error("no harness");
      const outcome = await data.open(a);
      return {
        outcome,
        incarnation: data.incarnation(a),
        drafts: (
          (await data.rows(a, "drafts")) as Array<{ local_id: string }>
        ).map((row) => row.local_id),
        description: await data.describe(a),
        deletes: window.__deleteCalls,
      };
    }, account);
    recordEvidence(info, "reseed-in-place", { before, after });
    expect(after.outcome).toBe("opened");
    expect(after.incarnation).toBeTruthy();
    expect(after.incarnation).not.toBe(before);
    expect(after.drafts).toEqual(["kept"]);
    expect(after.description?.singleton?.cache_status).toBe("empty");
    expect(after.description?.singleton?.incarnation_id).toBe(
      after.incarnation,
    );
    expect(after.deletes).toEqual([]);
  });
});

test.describe("E-W2: opening an existing database never creates one", () => {
  test("`open` of an absent name is `absent` and `indexedDB.databases()` is unchanged", async ({
    context,
  }, info) => {
    const page = await openPage(context);
    const account = uuid();
    const before = await page.evaluate(() => window.__atlasData?.list());
    const outcome = await page.evaluate(async (a) => {
      window.__atlasData?.setIdentity(a);
      return window.__atlasData?.open(a);
    }, account);
    const after = await page.evaluate(() => window.__atlasData?.list());
    recordEvidence(info, "never-create", { before, outcome, after });
    expect(outcome).toBe("absent");
    expect(after).toEqual(before);
  });

  test("the race where the database vanished between the probe and the open: the creating upgrade is aborted and nothing remains", async ({
    context,
  }, info) => {
    const page = await openPage(context);
    const account = uuid();
    const name = accountDatabaseName(account);
    const outcome = await page.evaluate(
      (a) => window.__atlasData?.openDirect(a),
      account,
    );
    // Give the engine a moment to discard the aborted database before it is listed.
    const listed = await page.evaluate(async () => {
      await new Promise((resolve) => setTimeout(resolve, 200));
      return window.__atlasData?.list();
    });
    recordEvidence(info, "vanished-between-probe-and-open", {
      outcome,
      listed,
    });
    expect(outcome).toBe("absent");
    expect(listed).not.toContain(name);
  });

  test("a creating open under a pending operation is refused, and nothing is created", async ({
    context,
  }) => {
    const page = await openPage(context);
    const account = uuid();
    const outcome = await page.evaluate(async (a) => {
      window.__atlasData?.setIdentity(a);
      window.__atlasData?.setPending(a, true);
      return window.__atlasData?.open(a, { create: true });
    }, account);
    expect(outcome).toBe("refused:operation_pending");
    expect(await page.evaluate(() => window.__atlasData?.list())).not.toContain(
      accountDatabaseName(account),
    );
  });

  test("an identity that is another account is refused", async ({
    context,
  }) => {
    const page = await openPage(context);
    const outcome = await page.evaluate(async (a) => {
      window.__atlasData?.setIdentity("someone-else");
      return window.__atlasData?.open(a, { create: true });
    }, uuid());
    expect(outcome).toBe("refused:identity");
  });
});

test.describe("E-A3: a deletion by another tab closes every connection and nothing re-creates the database", () => {
  test("versionchange closes both durability connections; a late query is `closed`; the name is not listed afterwards", async ({
    context,
  }, info) => {
    const a = await openPage(context);
    const b = await openPage(context);
    const account = uuid();
    const name = accountDatabaseName(account);
    await a.evaluate(async (acct) => {
      window.__atlasData?.setIdentity(acct);
      await window.__atlasData?.open(acct, { create: true });
    }, account);
    await b.evaluate((acct) => window.__atlasData?.setIdentity(acct), account);
    expect(
      await a.evaluate((acct) => window.__atlasData?.openCount(acct), account),
    ).toBe(2);

    // Tab B deletes the database through the production host: A must close both connections for it to complete.
    const deleted = await b.evaluate(
      (n) => window.__atlasData?.host.delete(n),
      name,
    );
    expect(["deleted", "blocked_then_deleted"]).toContain(deleted);

    const state = await a.evaluate(async (acct) => {
      const data = window.__atlasData;
      if (!data) throw new Error("no harness");
      const cause = await data.tryRows(acct, "drafts");
      // Give any (wrong) auto-reopen a chance to happen.
      await new Promise((resolve) => setTimeout(resolve, 300));
      return {
        latch: data.latch(acct),
        open: data.openCount(acct),
        cause,
        notices: data.versionChanges,
        listed: await data.list(),
        afterSecondTry: await data.tryRows(acct, "drafts"),
      };
    }, account);
    recordEvidence(info, "deleted-by-another-tab", { deleted, state });
    expect(state.latch).toBe("closed_for_deletion");
    expect(state.open).toBe(0);
    expect(state.cause).toBe("closed");
    expect(state.afterSecondTry).toBe("closed");
    expect(state.notices).toEqual([{ account, kind: "deleted" }]);
    expect(state.listed).not.toContain(name);
    expect(await b.evaluate(() => window.__atlasData?.list())).not.toContain(
      name,
    );
  });
});

test.describe("E-P2: a persistence hold that runs out, with real Web Locks, a real timer and a real Dexie transaction queued behind a real one (R2)", () => {
  /** One engine, one fresh page and account. */
  async function run(
    context: BrowserContext,
    options: { holdMs: number; stallMs: number; blockerMs: number },
  ) {
    const page = await openPage(context);
    const account = uuid();
    return page.evaluate(
      async ([a, o]) => {
        const data = window.__atlasData;
        if (!data) throw new Error("no harness");
        data.setIdentity(a as string);
        return data.holdExpiry({
          account: a as string,
          ...(o as {
            holdMs: number;
            stallMs: number;
            blockerMs: number;
          }),
        });
      },
      [account, options] as const,
    );
  }

  test("the control: the long transaction ends INSIDE the bound: the queued commit is applied, and the settlement is granted only after it", async ({
    context,
  }, info) => {
    const result = await run(context, {
      holdMs: 6_000,
      stallMs: 3_000,
      blockerMs: 500,
    });
    recordEvidence(info, "hold-expiry-control", result);
    expect(result.outcome).toBe("applied");
    expect(result.written).toBe(true);
    expect(result.trace).not.toContain("persistence.timed_out");
    // The settlement requested while the hold was kept waited for the commit to persist (about the blocker's length).
    expect(result.settlementGrantedAfterMs).not.toBeNull();
    expect(result.settlementGrantedAfterMs as number).toBeGreaterThanOrEqual(
      300,
    );
  });

  test("the hold RUNS OUT while the commit is still queued: the transaction is aborted (nothing is durable), and the settlement is let in at the bound, not when the long transaction ends", async ({
    context,
  }, info) => {
    const result = await run(context, {
      holdMs: 500,
      stallMs: 3_000,
      blockerMs: 2_500,
    });
    recordEvidence(info, "hold-expiry", result);
    expect(result.outcome).toBe("dropped:unverified");
    expect(result.written).toBe(false);
    expect(result.trace).toContain("persistence.timed_out");
    // The lock was given up because the transaction ENDED (aborted): there was no stall to report.
    expect(result.trace).not.toContain("persistence.stalled");
    expect(result.settlementGrantedAfterMs).not.toBeNull();
    expect(result.settlementGrantedAfterMs as number).toBeGreaterThanOrEqual(
      300,
    );
    // Long before the 2.5 s transaction ended.
    expect(result.settlementGrantedAfterMs as number).toBeLessThan(1_800);
    // And the commit itself was answered at the bound too (dropped, nothing written), not when the long transaction ended.
    expect(result.commitAnsweredAfterMs).toBeGreaterThanOrEqual(400);
    expect(result.commitAnsweredAfterMs).toBeLessThan(1_800);
  });
});
