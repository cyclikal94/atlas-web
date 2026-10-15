import type { BrowserContext, Page } from "@playwright/test";
import {
  accountDatabaseName,
  DECLARED_IDB_VERSION,
} from "../../src/data/model/schema";
import { recordEvidence } from "./data-evidence";
import { expect, test } from "./helpers";

/**
 * WEB-14a D-P8, DECLARED-THEN-PROBE (WEB-03 5, eighth round) with the REAL Dexie adapter (`/__data`, the production opener, host and
 * registry) in a real engine. Also qualification probe Q-P1: Dexie 4.4.6 stores this build's declared version 2 as IndexedDB version 20,
 * and opens a database another build has raised to 30 WITHOUT an error (which is why the adapter must probe).
 *
 * A newer build's database is never used by this page's code: an open that finds it fails `refused:closed` before reading anything, the
 * account is latched `upgrade_pending`, `upgraded` is reported ONCE, and every later open on the page is refused; an upgrade made while the
 * page holds the database closes it the same way. An equal version opens normally (the positive control). FIXTURE evidence (no backend).
 */
const NEWER = DECLARED_IDB_VERSION + 10;

async function openPage(context: BrowserContext): Promise<Page> {
  const page = await context.newPage();
  await page.goto("/__data");
  await page.waitForFunction(() => window.__atlasData !== undefined);
  return page;
}

/** Another build opens the account's database at `version` (raw IndexedDB: a version change with no schema change) and closes it. */
const upgradeTo = (page: Page, name: string, version: number) =>
  page.evaluate(
    ({ n, v }) =>
      new Promise<number>((resolve, reject) => {
        const request = indexedDB.open(n, v);
        request.onsuccess = () => {
          const reached = request.result.version;
          request.result.close();
          resolve(reached);
        };
        request.onerror = () => reject(request.error);
        request.onblocked = () => undefined;
      }),
    { n: name, v: version },
  );

/** The installed version, read with a no-version open (which never upgrades). */
const installedVersion = (page: Page, name: string) =>
  page.evaluate(
    (n) =>
      new Promise<number>((resolve, reject) => {
        const request = indexedDB.open(n);
        request.onsuccess = () => {
          const version = request.result.version;
          request.result.close();
          resolve(version);
        };
        request.onerror = () => reject(request.error);
      }),
    name,
  );

test.describe("D-P8: declared-then-probe with the real adapter", () => {
  test("Q-P1 and the positive control: version 2 is IndexedDB 20, an equal version opens normally", async ({
    context,
  }, info) => {
    const page = await openPage(context);
    const account = crypto.randomUUID();
    const name = accountDatabaseName(account);
    const created = await page.evaluate(async (a) => {
      const data = window.__atlasData;
      if (!data) throw new Error("no harness");
      data.setIdentity(a);
      const outcome = await data.open(a, { create: true });
      data.close(a);
      return outcome;
    }, account);
    const version = await installedVersion(page, name);
    const again = await page.evaluate(async (a) => {
      const data = window.__atlasData;
      if (!data) throw new Error("no harness");
      return {
        outcome: await data.open(a),
        latch: data.latch(a),
        notices: data.versionChanges.length,
      };
    }, account);
    recordEvidence(info, "schema-probe-control", { created, version, again });
    expect(created).toBe("created");
    expect(version).toBe(DECLARED_IDB_VERSION);
    expect(again).toEqual({ outcome: "opened", latch: "open", notices: 0 });
  });

  test("a database already NEWER than this build: Dexie alone would open it (Q-P1); the adapter refuses it closed, latches, reports once, and stays refused", async ({
    context,
  }, info) => {
    const page = await openPage(context);
    const account = crypto.randomUUID();
    const name = accountDatabaseName(account);
    await page.evaluate(async (a) => {
      const data = window.__atlasData;
      if (!data) throw new Error("no harness");
      data.setIdentity(a);
      await data.open(a, { create: true });
      await data.put(a, "cache", [
        {
          id: "r1",
          kind: "person",
          parent_id: null,
          label: "r1",
          value: null,
          version: 1,
          can_edit: true,
          archived: false,
          kind_date: null,
        },
      ]);
      data.close(a);
    }, account);
    expect(await upgradeTo(page, name, NEWER)).toBe(NEWER);
    const state = await page.evaluate(async (a) => {
      const data = window.__atlasData;
      if (!data) throw new Error("no harness");
      const first = await data.open(a);
      const second = await data.open(a);
      return {
        first,
        second,
        latch: data.latch(a),
        open: data.openCount(a),
        notices: data.versionChanges.filter((n) => n.account === a),
      };
    }, account);
    const after = await installedVersion(page, name);
    recordEvidence(info, "schema-probe-newer-at-open", { state, after });
    expect(state.first).toBe("refused:closed");
    expect(state.second).toBe("refused:closed");
    expect(state.latch).toBe("upgrade_pending");
    expect(state.open).toBe(0);
    expect(state.notices).toEqual([{ account, kind: "upgraded" }]);
    // The database is left exactly as the newer build made it.
    expect(after).toBe(NEWER);
  });

  test("an upgrade while the page holds the database: its connections close, the account is latched, `upgraded` once, and it is never reopened here", async ({
    context,
  }, info) => {
    const page = await openPage(context);
    const other = await openPage(context);
    const account = crypto.randomUUID();
    const name = accountDatabaseName(account);
    await page.evaluate(async (a) => {
      const data = window.__atlasData;
      if (!data) throw new Error("no harness");
      data.setIdentity(a);
      await data.open(a, { create: true });
    }, account);
    expect(
      await page.evaluate((a) => window.__atlasData?.openCount(a), account),
    ).toBe(2);
    // The other page plays the newer build: its upgrade can complete only because this page closes its connections.
    expect(await upgradeTo(other, name, NEWER)).toBe(NEWER);
    const state = await page.evaluate(async (a) => {
      const data = window.__atlasData;
      if (!data) throw new Error("no harness");
      const read = await data.tryRows(a, "cache");
      const reopened = await data.open(a);
      return {
        read,
        reopened,
        latch: data.latch(a),
        open: data.openCount(a),
        notices: data.versionChanges.filter((n) => n.account === a),
      };
    }, account);
    recordEvidence(info, "schema-probe-upgrade-while-open", state);
    expect(state.read).toBe("closed");
    expect(state.reopened).toBe("refused:closed");
    expect(state.latch).toBe("upgrade_pending");
    expect(state.open).toBe(0);
    expect(state.notices).toEqual([{ account, kind: "upgraded" }]);
  });

  test("E-R7 (revision 1): after a newer build's upgrade, the recovery connection saves, lists and discards through a fresh connection, and nothing else", async ({
    context,
  }, info) => {
    const page = await openPage(context);
    const account = crypto.randomUUID();
    const name = accountDatabaseName(account);
    const incarnationId = await page.evaluate(async (a) => {
      const data = window.__atlasData;
      if (!data) throw new Error("no harness");
      data.setIdentity(a);
      await data.open(a, { create: true });
      const incarnation = data.incarnation(a);
      data.close(a);
      return incarnation;
    }, account);
    expect(incarnationId).not.toBeNull();
    expect(await upgradeTo(page, name, NEWER)).toBe(NEWER);
    const run = (input: {
      account?: string;
      incarnationId: string;
      admitted?: boolean;
      calls: Array<Record<string, string>>;
    }) =>
      page.evaluate(
        ({ a, rest }) => {
          const data = window.__atlasData;
          if (!data) throw new Error("no harness");
          return data.recoveryConnection(a, rest as never);
        },
        { a: input.account ?? account, rest: input },
      );
    const answers = await run({
      incarnationId: incarnationId as string,
      calls: [
        { kind: "save", tab: "t1", text: "first" },
        { kind: "save", tab: "t1", text: "second" },
        { kind: "list" },
        { kind: "save", tab: "t2", text: "other" },
        { kind: "discard", tab: "t1" },
        { kind: "list" },
        { kind: "foreign" },
      ],
    });
    expect(answers).toEqual([
      "saved",
      "saved",
      JSON.stringify(["t1:second"]),
      "saved",
      "discarded",
      JSON.stringify(["t2:other"]),
      // A plan outside the recovery set is refused before anything is opened: not a way back into the account's data.
      "refused:error",
    ]);
    // Never upgraded (or created) anything: the database is at the newer build's version.
    expect(await installedVersion(page, name)).toBe(NEWER);
    // Another incarnation (the database deleted and re-created since): every write refused in the transaction.
    const otherIncarnation = await run({
      incarnationId: "not-this-incarnation",
      calls: [
        { kind: "save", tab: "t3", text: "x" },
        { kind: "discard", tab: "t2" },
      ],
    });
    expect(otherIncarnation).toEqual(["failed", "failed"]);
    // Not admitted (the account was closed for a deletion or left): nothing is opened, so nothing is saved.
    const closed = await run({
      incarnationId: incarnationId as string,
      admitted: false,
      calls: [{ kind: "save", tab: "t4", text: "y" }],
    });
    expect(closed).toEqual(["failed"]);
    // ADAPTED, WEB-14a revision 14 (separately labelled for the reviewer): nothing is read either. Revision 1 expected the list to answer
    // "[]" here; revision 7 (R15) made a recovery read that cannot reach the store REJECT (unavailable), never answer an empty list, and
    // this native case was not brought along (the complete fixture selection had not run since). The intent is kept: a connection that is
    // not admitted opens nothing and certifies nothing.
    const closedList = await run({
      incarnationId: incarnationId as string,
      admitted: false,
      calls: [{ kind: "list" }],
    }).then(
      (answers) => `answered ${JSON.stringify(answers)}`,
      (error: Error) => error.message,
    );
    expect(closedList).toMatch(/store failure: closed/);
    // A database that does not exist is never created.
    const missing = crypto.randomUUID();
    const absent = await run({
      account: missing,
      incarnationId: incarnationId as string,
      calls: [{ kind: "save", tab: "t5", text: "z" }],
    });
    expect(absent).toEqual(["failed"]);
    expect(
      await page.evaluate(
        async (n) => (await indexedDB.databases()).some((d) => d.name === n),
        accountDatabaseName(missing),
      ),
    ).toBe(false);
    // A newer schema that broke the recovery contract (no `form_recovery`): the save fails, like any failed local write.
    const broken = await page.evaluate(
      ({ n, v }) =>
        new Promise<number>((resolve, reject) => {
          const request = indexedDB.open(n, v);
          request.onupgradeneeded = () =>
            request.result.deleteObjectStore("form_recovery");
          request.onsuccess = () => {
            const reached = request.result.version;
            request.result.close();
            resolve(reached);
          };
          request.onerror = () => reject(request.error);
        }),
      { n: name, v: NEWER + 10 },
    );
    expect(broken).toBe(NEWER + 10);
    const contract = await run({
      incarnationId: incarnationId as string,
      calls: [{ kind: "save", tab: "t1", text: "after the contract broke" }],
    });
    expect(contract).toEqual(["failed"]);
    recordEvidence(info, "schema-probe-recovery-connection", {
      answers,
      otherIncarnation,
      closed,
      closedList,
      absent,
      contract,
    });
  });
});
