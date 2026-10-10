import type { BrowserContext, Page } from "@playwright/test";
import {
  EMPTY_DIGEST,
  UNREADABLE_BASELINE,
  UNREADABLE_LIVE,
  UNREADABLE_SUMMARY,
} from "../../src/data/model/local-work";
import { accountDatabaseName } from "../../src/data/model/schema";
import { recordEvidence } from "./data-evidence";
import { expect, test } from "./helpers";

/**
 * E-C14 (R12, revision 11): an open that FAILS is never an absence. The production Dexie adapter, the production deletion ports and the
 * page's own opener in a real engine, through the fixture-only data harness (`/__data`), with no session and no backend.
 *
 * The adapter used to answer `absent` for ANY `AbortError` raised while it opened without the right to create the database, and for
 * any such error on its second connection. An aborted open REQUEST is not proof that the database is missing (the review injected one
 * for an existing database that held an unfinished form): the ports then read the account as having no work, `setClosing` answered
 * `closing` although no flag had been written, and `wipe_imminent` could be announced. Now `absent` means exactly one thing: the
 * adapter's own refusal to create ended the open (Dexie runs its `populate` hook only in the upgrade that creates a database, so the
 * refusal proves the database did not exist), and every other failure is a failure.
 *
 * The faults are NAMED INJECTIONS over a real database: `indexedDB.open` for the account's database returns a request whose `error` is
 * a `DOMException` of the named kind. Nothing here is a physical storage failure, and none of it is a device or real Safari.
 */
declare global {
  interface Window {
    __openFaults: {
      /** An unfinished form in the account's (existing) database, with raw IndexedDB. */
      seedForm(name: string): Promise<void>;
      /** The durable singleton's fence and the number of form copies, with raw IndexedDB; null when the database does not exist. */
      read(
        name: string,
      ): Promise<{ fence: unknown; forms: number; version: number } | null>;
      /** Every later `indexedDB.open` of this database (from its `from`th call) raises the named error. */
      fail(name: string, mode: string, from: number): void;
      /** Stops injecting; returns how many opens were seen and how many were failed. */
      restore(): { calls: number; injected: number };
      /** The types of the `atlas-sync` messages this page has heard from its own ports (a second channel object receives them). */
      heard(): string[];
    };
  }
}

const FAULTS = ["AbortError", "UnknownError", "QuotaExceededError"] as const;

async function openPage(context: BrowserContext): Promise<Page> {
  const page = await context.newPage();
  await page.addInitScript(() => {
    const original = indexedDB.open.bind(indexedDB);
    let calls = 0;
    let injected = 0;
    let plan: { name: string; mode: string; from: number } | null = null;
    indexedDB.open = ((name: string, version?: number) => {
      if (plan === null || name !== plan.name) return original(name, version);
      calls += 1;
      if (calls < plan.from) return original(name, version);
      injected += 1;
      const request = {
        error: new DOMException("injected open failure", plan.mode),
        readyState: "done",
        result: undefined,
        transaction: null,
        source: null,
        onerror: null as null | ((event: unknown) => void),
        onblocked: null,
        onupgradeneeded: null,
        onsuccess: null,
      };
      setTimeout(
        () =>
          request.onerror?.({
            target: request,
            preventDefault() {},
            stopPropagation() {},
          }),
        0,
      );
      return request as unknown as IDBOpenDBRequest;
    }) as typeof indexedDB.open;

    const heard: string[] = [];
    const channel = new BroadcastChannel("atlas-sync");
    channel.onmessage = (event) =>
      heard.push(String((event.data as { type?: unknown } | null)?.type));

    const raw = <T>(
      name: string,
      use: (db: IDBDatabase, done: (value: T) => void) => void,
    ): Promise<T> =>
      new Promise((resolve, reject) => {
        const request = original(name);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => use(request.result, resolve);
      });

    window.__openFaults = {
      seedForm: (name) =>
        raw<void>(name, (db, done) => {
          const tx = db.transaction("form_recovery", "readwrite");
          tx.objectStore("form_recovery").put({
            form_context: "review",
            tab_instance_id: "tab",
            fields: { title: "retained draft" },
            redacted: [],
            saved_at: new Date().toISOString(),
            capture_seq: 1,
            writer_gen: 1,
            terminal: false,
            content_digest: "content",
          });
          tx.oncomplete = () => {
            db.close();
            done();
          };
        }),
      read: async (name) => {
        const listed = await indexedDB.databases();
        if (!listed.some((entry) => entry.name === name)) return null;
        return raw(name, (db, done) => {
          const tx = db.transaction(
            ["sync_state", "form_recovery"],
            "readonly",
          );
          let fence: unknown = null;
          let forms = 0;
          const get = tx.objectStore("sync_state").get("singleton");
          get.onsuccess = () => {
            fence = (get.result as { draft_fence?: unknown } | undefined)
              ?.draft_fence;
          };
          const count = tx.objectStore("form_recovery").count();
          count.onsuccess = () => {
            forms = count.result;
          };
          tx.oncomplete = () => {
            const version = db.version;
            db.close();
            done({ fence: fence ?? null, forms, version });
          };
        });
      },
      fail: (name, mode, from) => {
        calls = 0;
        injected = 0;
        plan = { name, mode, from };
      },
      restore: () => {
        plan = null;
        return { calls, injected };
      },
      heard: () => [...heard],
    };
  });
  await page.goto("/__data");
  await page.waitForFunction(() => window.__atlasData !== undefined);
  return page;
}

const uuid = () => crypto.randomUUID();

/** An existing database with one unfinished form copy, closed again, so only raw IndexedDB holds it. */
async function seededAccount(page: Page): Promise<string> {
  const account = uuid();
  const name = accountDatabaseName(account);
  await page.evaluate(
    async ({ account, name }) => {
      const data = window.__atlasData;
      if (!data) throw new Error("no harness");
      data.setIdentity(account);
      await data.open(account, { create: true });
      data.close(account);
      await window.__openFaults.seedForm(name);
    },
    { account, name },
  );
  return account;
}

test.describe("E-C14: an open that fails is never an absence (the production ports)", () => {
  test("the control: a readable database counts its work, takes the fence and the closing flag", async ({
    context,
  }, info) => {
    const page = await openPage(context);
    const account = await seededAccount(page);
    const name = accountDatabaseName(account);
    const out = await page.evaluate(
      async ({ account }) => {
        const ports = window.__atlasData?.ports;
        if (!ports) throw new Error("no ports");
        const summary = await ports.localWork.summarise(account);
        const fence = await ports.coordination.setDraftFence(account, "op-1");
        const closing = await ports.coordination.setClosing(account);
        await new Promise((resolve) => setTimeout(resolve, 100));
        return { summary, fence, closing, heard: window.__openFaults.heard() };
      },
      { account },
    );
    const durable = await page.evaluate(
      (n) => window.__openFaults.read(n),
      name,
    );
    recordEvidence(info, "open-failure-control", { out, durable });
    expect(out.summary.count).toBe(1);
    expect(out.summary.digest).not.toBe(EMPTY_DIGEST);
    expect(out.summary.digest).not.toBe(UNREADABLE_SUMMARY);
    expect(out.closing).toBe("closing");
    // The announcement follows the durable flag: this is the listener the failure cases below rely on.
    expect(out.heard).toContain("wipe_imminent");
    expect(durable?.fence).toMatchObject({ closing: true });
  });

  test("a database that is genuinely absent is still absent: no work, nothing to close, and nothing is created", async ({
    context,
  }, info) => {
    const page = await openPage(context);
    const account = uuid();
    const name = accountDatabaseName(account);
    const before = await page.evaluate(() => window.__atlasData?.list());
    const out = await page.evaluate(
      async ({ account }) => {
        const data = window.__atlasData;
        if (!data) throw new Error("no harness");
        const ports = data.ports;
        return {
          summary: await ports.localWork.summarise(account),
          fence: await ports.coordination.setDraftFence(account, "op-1"),
          baseline: await ports.coordination.baselineDigest(account),
          live: await ports.coordination.liveDigest(account),
          closing: await ports.coordination.setClosing(account),
          direct: await data.openDirect(account),
        };
      },
      { account },
    );
    const after = await page.evaluate(() => window.__atlasData?.list());
    recordEvidence(info, "open-failure-absent", { out, before, after });
    expect(out.summary).toMatchObject({ count: 0, digest: EMPTY_DIGEST });
    expect(out.fence).toEqual({ consentDigest: EMPTY_DIGEST });
    expect(out.baseline).toBe(EMPTY_DIGEST);
    expect(out.live).toBe(EMPTY_DIGEST);
    expect(out.closing).toBe("closing");
    expect(out.direct).toBe("absent");
    expect(after).toEqual(before);
    expect(after).not.toContain(name);
  });

  for (const fault of FAULTS)
    test(`${fault}: an existing database that cannot be opened is UNREADABLE: no empty digest, no fence, no closing flag, and nothing is announced`, async ({
      context,
    }, info) => {
      const page = await openPage(context);
      const account = await seededAccount(page);
      const name = accountDatabaseName(account);
      const out = await page.evaluate(
        async ({ account, name, fault }) => {
          const ports = window.__atlasData?.ports;
          if (!ports) throw new Error("no ports");
          const faults = window.__openFaults;
          faults.fail(name, fault, 1);
          const summary = await ports.localWork.summarise(account);
          const fence = await ports.coordination
            .setDraftFence(account, "op-1")
            .then(
              (value) => ({ resolved: value }),
              (error: unknown) => ({ rejected: String(error) }),
            );
          const baseline = await ports.coordination.baselineDigest(account);
          const live = await ports.coordination.liveDigest(account);
          const closing = await ports.coordination.setClosing(account);
          const seen = faults.restore();
          await new Promise((resolve) => setTimeout(resolve, 100));
          return {
            summary,
            fence,
            baseline,
            live,
            closing,
            seen,
            heard: faults.heard(),
          };
        },
        { account, name, fault },
      );
      const durable = await page.evaluate(
        (n) => window.__openFaults.read(n),
        name,
      );
      recordEvidence(info, `open-failure-ports-${fault}`, { out, durable });
      expect(out.seen.injected).toBeGreaterThan(0);
      // Not "no work": the digest cannot equal any baseline, so a later recount that CAN read the work differs and the person is asked.
      expect(out.summary).toMatchObject({
        count: 0,
        digest: UNREADABLE_SUMMARY,
      });
      expect(out.summary.digest).not.toBe(EMPTY_DIGEST);
      expect(out.fence).toHaveProperty("rejected");
      expect(out.baseline).toBe(UNREADABLE_BASELINE);
      expect(out.live).toBe(UNREADABLE_LIVE);
      expect(out.closing).toBe("unconfirmed");
      expect(out.heard).not.toContain("wipe_imminent");
      // The database is untouched: still there, its form copy kept, no fence and no closing flag.
      expect(durable).toMatchObject({ fence: null, forms: 1 });
    });

  for (const fault of FAULTS)
    test(`${fault}: once the open works again the work is counted and the closing flag is written (the failure left nothing behind)`, async ({
      context,
    }) => {
      const page = await openPage(context);
      const account = await seededAccount(page);
      const name = accountDatabaseName(account);
      const out = await page.evaluate(
        async ({ account, name, fault }) => {
          const ports = window.__atlasData?.ports;
          if (!ports) throw new Error("no ports");
          window.__openFaults.fail(name, fault, 1);
          const failed = await ports.coordination.setClosing(account);
          window.__openFaults.restore();
          const summary = await ports.localWork.summarise(account);
          const closing = await ports.coordination.setClosing(account);
          return { failed, summary, closing };
        },
        { account, name, fault },
      );
      const durable = await page.evaluate(
        (n) => window.__openFaults.read(n),
        name,
      );
      expect(out.failed).toBe("unconfirmed");
      expect(out.summary.count).toBe(1);
      expect(out.closing).toBe("closing");
      expect(durable?.fence).toMatchObject({ closing: true });
    });
});

test.describe("E-C14: the page's own opener (two connections) does not turn a failed open into an absence", () => {
  const CONNECTIONS = [
    ["first (strict)", 1],
    ["second", 2],
  ] as const;
  for (const [which, from] of CONNECTIONS)
    for (const fault of FAULTS)
      test(`${fault} on the ${which} connection: the open is a FAILURE, no connection is left open, the database is untouched`, async ({
        context,
      }, info) => {
        const page = await openPage(context);
        const account = await seededAccount(page);
        const name = accountDatabaseName(account);
        const out = await page.evaluate(
          async ({ account, name, fault, from }) => {
            const data = window.__atlasData;
            if (!data) throw new Error("no harness");
            data.setIdentity(account);
            window.__openFaults.fail(name, fault, from);
            const through = await data.open(account).then(
              (value) => `resolved:${value}`,
              (error: unknown) => `rejected:${(error as Error)?.name ?? error}`,
            );
            const direct = await data.openDirect(account).then(
              (value) => `resolved:${value}`,
              (error: unknown) => `rejected:${(error as Error)?.name ?? error}`,
            );
            const seen = window.__openFaults.restore();
            return {
              through,
              direct,
              seen,
              connections: data.openCount(account),
              listed: (await data.list()).includes(name),
            };
          },
          { account, name, fault, from },
        );
        const durable = await page.evaluate(
          (n) => window.__openFaults.read(n),
          name,
        );
        recordEvidence(
          info,
          `open-failure-opener-${which.split(" ")[0]}-${fault}`,
          {
            out,
            durable,
          },
        );
        expect(out.seen.injected).toBeGreaterThan(0);
        // "absent" is the answer that every caller reads as "nothing to find, nothing to close".
        expect(out.through).toMatch(/^rejected:/);
        expect(out.direct).toMatch(/^rejected:/);
        expect(out.connections).toBe(0);
        expect(out.listed).toBe(true);
        expect(durable).toMatchObject({ fence: null, forms: 1 });
        // The control after the fault: the same call opens the database.
        const again = await page.evaluate(
          (account) => window.__atlasData?.open(account),
          account,
        );
        expect(again).toBe("opened");
      });
});

test.describe("E-C14: a REAL aborted upgrade of an existing database is not an absence either", () => {
  // A control that holds on the unfixed adapter too (the engine words this abort differently from the injected request error: the
  // review's own real aborted-upgrade probe passed there as well), kept so the failure family is covered with a real abort.
  test("a version-1 database with a draft whose upgrade throws: opening it without creation rights fails, the database and its draft are kept", async ({
    context,
  }, info) => {
    const page = await openPage(context);
    const account = uuid();
    const name = accountDatabaseName(account);
    const out = await page.evaluate(
      async ({ account, name }) => {
        const data = window.__atlasData;
        if (!data) throw new Error("no harness");
        data.setIdentity(account);
        // `command: null` cannot be moved to `draft_commands`: the version-2 upgrade throws inside its transaction and the engine aborts it.
        await data.createLegacyV1(account, [
          {
            local_id: "kept",
            created_seq: 1,
            command: null as unknown as object,
          },
        ]);
        const direct = await data.openDirect(account).then(
          (value) => `resolved:${value}`,
          (error: unknown) => `rejected:${(error as Error)?.name ?? error}`,
        );
        const through = await data.open(account).then(
          (value) => `resolved:${value}`,
          (error: unknown) => `rejected:${(error as Error)?.name ?? error}`,
        );
        return { direct, through, listed: (await data.list()).includes(name) };
      },
      { account, name },
    );
    const durable = await page.evaluate(
      (n) =>
        new Promise<{ version: number; drafts: number } | null>((resolve) => {
          const request = indexedDB.open(n);
          request.onerror = () => resolve(null);
          request.onsuccess = () => {
            const db = request.result;
            const tx = db.transaction("drafts", "readonly");
            const count = tx.objectStore("drafts").count();
            tx.oncomplete = () => {
              const version = db.version;
              db.close();
              resolve({ version, drafts: count.result });
            };
          };
        }),
      name,
    );
    recordEvidence(info, "open-failure-aborted-upgrade", { out, durable });
    expect(out.direct).toMatch(/^rejected:/);
    expect(out.through).toMatch(/^rejected:/);
    expect(out.listed).toBe(true);
    // Dexie's version 1 is IndexedDB version 10: the aborted upgrade left the database exactly as it was.
    expect(durable).toEqual({ version: 10, drafts: 1 });
  });
});
