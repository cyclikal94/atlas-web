import type { Page } from "@playwright/test";
import { recordEvidence } from "./data-evidence";
import {
  arm,
  boot,
  edit,
  incarnationOf,
  install,
  markers,
  outboxState,
  warning,
} from "./data-local-faults";
import {
  ACCOUNT,
  bootSession,
  dataPage,
  seedSettled,
  startLeader,
  stubNetwork,
  uuid,
} from "./data-sync-helpers";
import { withHeldOperations } from "./held-operation";
import { expect, test } from "./helpers";

/**
 * E-O12 (revision 33, R56): a callback that outlives its service records NOTHING, in a real engine.
 *
 * The independent review of revision 32 failed an operation and its counter transaction with real Dexie and IndexedDB, held the delivery of
 * the counter's rejection after the counter had actually failed, closed the service and deleted the database through the production
 * account-database port, created a replacement, and then delivered the old rejection: the writer recorded the old operation's fallback marker
 * in the page's real `localStorage` under a key that named the account and not the database's lifetime, and a fresh reader of the
 * replacement saw it marked (Chromium, Firefox and WebKit; the facade's edit). The same shape was reached from the dispatcher's read of the
 * queue and the sync engine's capture.
 *
 * Here the three callers run the same schedule through the production code over REAL IndexedDB and the page's real `localStorage`: the
 * operation and its counter fail by aborted native transactions (the spec installs the faults), the counter's answer is held after its
 * transaction has failed (`holdOutboxPlan`, `holdEnginePlan`), the service is closed and the database deleted by the production port
 * (`closeOwnConnections`, `delete`), and the answer is delivered. Every case has its live control (the same schedule, the lifetime not
 * ended: the stop is recorded in the marker). The oracle is the raw `localStorage` of the page, read by the spec's own parser: neither a
 * marker key nor a directory may exist afterwards, for any lifetime. A second page then creates the replacement database, and the module's
 * own answer for the replacement's lifetime is read there.
 *
 * What is NOT claimed: a page freeze or a naturally late rejection (the delivery is held by the fixture), a failing disk (the faults are
 * injected aborts), or a complete logout journey (the deletion is the production port's, not the session's wipe). FIXTURE evidence for
 * this engine on this machine.
 */
const A = uuid(71);

const rawKeys = (page: Page): Promise<string[]> =>
  page.evaluate(() =>
    Object.keys(localStorage)
      .filter(
        (key) =>
          key.startsWith("atlas-write-failing:") ||
          key.startsWith("atlas-write-dir:"),
      )
      .sort(),
  );

/** Closes the page's connections and deletes the account's database through the production port, as a wipe does. */
const endLifetime = (page: Page) =>
  page.evaluate(async (acct) => {
    const ports = window.__atlasData?.ports;
    if (!ports) throw new Error("no ports");
    await ports.database.closeOwnConnections(acct);
    return ports.database.delete(acct);
  }, ACCOUNT);

/** A second page creates the replacement database (a new incarnation) and reads what its lifetime says of `operation`. */
async function replacementSays(
  context: Parameters<typeof dataPage>[0],
  old: string,
  operation: string,
) {
  const second = await dataPage(context);
  await second.evaluate(async (acct) => {
    const data = window.__atlasData;
    if (!data) throw new Error("no data harness");
    data.setIdentity(acct);
    await data.open(acct, { create: true });
  }, ACCOUNT);
  const lifetime = await incarnationOf(second, ACCOUNT);
  expect(lifetime).not.toBe(old);
  const says = await second.evaluate(
    ([acct, inc, op]) => {
      const markers = window.__atlasData?.markers;
      if (!markers) throw new Error("no markers");
      const scope = { account: acct as string, incarnationId: inc as string };
      return {
        probe: markers.probe(scope, op as string),
        inspect: markers.inspect(scope),
      };
    },
    [ACCOUNT, lifetime, operation] as const,
  );
  return { second, lifetime, says };
}

/** The faults the page's writes go through (the earlier native local-write specs' injection, with the dispatcher's read of the queue). */
async function installFaults(page: Page): Promise<void> {
  await install(page);
  await page.evaluate(() => {
    const w = window as unknown as {
      __lifetime?: {
        queue: number;
        capture: number;
        counter: number;
        written: string[];
      };
    };
    if (w.__lifetime) return;
    const state = {
      queue: 0,
      capture: 0,
      counter: 0,
      written: [] as string[],
    };
    w.__lifetime = state;
    // Every write of a marker or a directory the page makes, even one that is removed a moment later (the next read of the queue that
    // lands ends a `queue` stop by itself): the control asserts that the schedule DID record, and the ended case that nothing was written.
    const storage = Storage.prototype as unknown as Record<
      string,
      (...a: unknown[]) => unknown
    >;
    const setItem = storage.setItem as (...a: unknown[]) => unknown;
    storage.setItem = function (this: Storage, ...args: unknown[]) {
      const key = args[0];
      if (
        typeof key === "string" &&
        (key.startsWith("atlas-write-failing:") ||
          key.startsWith("atlas-write-dir:"))
      )
        state.written.push(key);
      return setItem.apply(this, args);
    };
    const index = IDBIndex.prototype as unknown as Record<
      string,
      (...a: unknown[]) => unknown
    >;
    const getAll = index.getAll as (...a: unknown[]) => unknown;
    index.getAll = function (this: IDBIndex, ...args: unknown[]) {
      if (
        state.queue > 0 &&
        this.objectStore.name === "drafts" &&
        this.name === "[status+created_seq]"
      ) {
        state.queue -= 1;
        throw new DOMException("injected fault", "DataError");
      }
      return getAll.apply(this, args);
    };
    const proto = IDBObjectStore.prototype as unknown as Record<
      string,
      (...a: unknown[]) => unknown
    >;
    const put = proto.put as (...a: unknown[]) => unknown;
    proto.put = function (this: IDBObjectStore, ...args: unknown[]) {
      if (this.name === "sync_state") {
        const row = args[0] as {
          request_seq?: number;
          local_write_streaks?: object;
        };
        if (state.capture > 0 && (row.request_seq ?? 0) > 0) {
          state.capture -= 1;
          throw new DOMException("injected fault", "DataError");
        }
        if (
          state.counter > 0 &&
          Object.keys(row.local_write_streaks ?? {}).length > 0
        ) {
          state.counter -= 1;
          throw new DOMException("injected fault", "DataError");
        }
      }
      return put.apply(this, args);
    };
  });
}
/** The markers and directories the page wrote since the faults were installed, in order (including ones removed again since). */
const written = (page: Page): Promise<string[]> =>
  page.evaluate(
    () =>
      (window as unknown as { __lifetime: { written: string[] } }).__lifetime
        .written,
  );
const faults = (
  page: Page,
  next: { queue?: number; capture?: number; counter?: number },
) =>
  page.evaluate((n) => {
    const state = (
      window as unknown as {
        __lifetime: {
          queue: number;
          capture: number;
          counter: number;
          written: string[];
        };
      }
    ).__lifetime;
    state.queue = n.queue ?? 0;
    state.capture = n.capture ?? 0;
    state.counter = n.counter ?? 0;
  }, next);

const enqueue = (page: Page, localId: string, target: string, label: string) =>
  page.evaluate(
    (spec) => window.__atlasData?.enqueue(spec),
    edit(target, localId, label),
  );
const editDraft = (page: Page, id: string, target: string, label: string) =>
  page.evaluate(
    ({ id: draft, spec }) => window.__atlasData?.editQueued(draft, spec),
    { id, spec: edit(target, id, label) },
  );

test.describe("E-O12 (revision 33, R56): the facade's edit, a failed counter whose rejection is delivered after the lifetime ended", () => {
  for (const ended of [false, true])
    test(`R56 facade: ${ended ? "the service closed and the database deleted before the old rejection arrives: nothing is recorded, shown or held, and the replacement's lifetime is clean" : "live control: the same schedule with the lifetime standing records the stop in the marker and shows the warning"}`, async ({
      context,
    }, info) => {
      const { page } = await boot(context);
      await context.setOffline(true);
      expect((await enqueue(page, A, "r", "original"))?.kind).toBe("queued");
      const old = await incarnationOf(page, ACCOUNT);
      await arm(page, { id: A, armed: 1, counter: 1 });
      // The counter's transaction fails, and the delivery of its rejection is held. Revision 21 (R20-N1): the edit and the held answer
      // are owned by a scope that releases the hold by its own token and joins the edit on every path.
      const result = await withHeldOperations(async (holds) => {
        const counter = await holds.holdOutbox(
          page,
          "data.recordLocalWriteOutcome",
        );
        const editing = holds.launch("the failing edit", () =>
          editDraft(page, A, "r", "unsaved"),
        );
        await counter.untilHeld();
        if (ended) {
          expect(["deleted", "blocked_then_deleted"]).toContain(
            await endLifetime(page),
          );
          expect(await rawKeys(page)).toEqual([]);
        }
        await counter.release();
        return await editing.settled();
      });
      if (ended) {
        expect(result).toMatchObject({
          kind: "refused",
          reason: "identity_changed",
        });
        // Neither a marker nor a directory, for any lifetime: the old service wrote nothing, and no lifetime can inherit it.
        await page.waitForTimeout(500);
        expect(await rawKeys(page)).toEqual([]);
        expect(await warning(page)).toEqual({
          notResponding: false,
          memoryOnly: false,
        });
        // The replacement page has to load: the network comes back.
        await context.setOffline(false);
        const { says, lifetime } = await replacementSays(
          context,
          old,
          `draft:${A}`,
        );
        expect(says).toEqual({
          probe: "unmarked",
          inspect: { operations: [], known: true },
        });
        recordEvidence(info, "r56-facade-ended", {
          old,
          replacement: lifetime,
          keys: await rawKeys(page),
          says,
        });
      } else {
        expect(result).toMatchObject({ kind: "refused", reason: "storage" });
        await expect
          .poll(() => markers(page), { timeout: 10_000 })
          .toEqual([`draft:${A}`]);
        expect(await warning(page)).toEqual({
          notResponding: true,
          memoryOnly: false,
        });
      }
    });
});

test.describe("E-O12 (revision 33, R56): the dispatcher's read of the queue, a failed counter whose rejection is delivered after the lifetime ended", () => {
  for (const ended of [false, true])
    test(`R56 dispatcher: ${ended ? "the service closed and the database deleted before the old rejection arrives: nothing is recorded under `queue`" : "live control: the same schedule with the lifetime standing records the stop under `queue`"}`, async ({
      context,
    }, info) => {
      const { page } = await boot(context);
      await installFaults(page);
      const old = await incarnationOf(page, ACCOUNT);
      await faults(page, { queue: 1, counter: 1 });
      // Revision 21 (R20-N1): the held answer is owned by a scope that releases it by its own token on every path.
      await withHeldOperations(async (holds) => {
        const counter = await holds.holdOutbox(
          page,
          "data.recordLocalWriteOutcome",
        );
        // The dispatcher is asked to look at the queue now (the browser's `online` event).
        await page.evaluate(() => window.dispatchEvent(new Event("online")));
        await counter.untilHeld();
        if (ended)
          expect(["deleted", "blocked_then_deleted"]).toContain(
            await endLifetime(page),
          );
        await counter.release();
      });
      if (ended) {
        await page.waitForTimeout(500);
        expect(await rawKeys(page)).toEqual([]);
        // Not even a transient write: the old service attempted none.
        expect(await written(page)).toEqual([]);
        expect(await outboxState(page)).not.toEqual({
          kind: "stopped",
          cause: "local_storage",
        });
        const { says } = await replacementSays(context, old, "queue");
        expect(says).toEqual({
          probe: "unmarked",
          inspect: { operations: [], known: true },
        });
        recordEvidence(info, "r56-dispatcher-ended", {
          state: await outboxState(page),
          says,
        });
      } else {
        // The stop of the queue read ends with the next read that lands (R46), which the dispatcher makes by itself, so what is asserted is
        // that the marker was RECORDED, not that it still stands.
        await expect
          .poll(
            async () =>
              (await written(page)).some((k) => k.includes(":queue#")),
            {
              timeout: 10_000,
            },
          )
          .toBe(true);
      }
    });
});

test.describe("E-O12 (revision 33, R56): the sync engine's capture, a failed counter whose rejection is delivered after the lifetime ended", () => {
  for (const ended of [false, true])
    test(`R56 engine: ${ended ? "the service closed and the database deleted before the old rejection arrives: nothing is recorded under `capture`" : "live control: the same schedule with the lifetime standing records the stop under `capture`"}`, async ({
      context,
    }, info) => {
      await stubNetwork(context);
      await seedSettled(context);
      const page = await bootSession(context);
      await installFaults(page);
      await faults(page, { capture: 1, counter: 1 });
      // Revision 21 (R20-N1): the held answer is owned by a scope that releases it by its own token on every path.
      const old = await withHeldOperations(async (holds) => {
        const counter = await holds.holdEngine(
          page,
          "data.recordLocalWriteOutcome",
        );
        await startLeader(page);
        await counter.untilHeld();
        const old = await incarnationOf(page, ACCOUNT);
        if (ended)
          expect(["deleted", "blocked_then_deleted"]).toContain(
            await endLifetime(page),
          );
        await counter.release();
        return old;
      });
      const state = () =>
        page.evaluate(() => window.__atlasData?.engineState());
      if (ended) {
        await page.waitForTimeout(500);
        expect(await rawKeys(page)).toEqual([]);
        expect(await written(page)).toEqual([]);
        expect(await state()).not.toEqual({
          kind: "stopped",
          cause: "local_storage",
        });
        const { says } = await replacementSays(context, old, "capture");
        expect(says).toEqual({
          probe: "unmarked",
          inspect: { operations: [], known: true },
        });
        recordEvidence(info, "r56-engine-ended", {
          state: await state(),
          says,
        });
      } else {
        await expect
          .poll(() => markers(page), { timeout: 10_000 })
          .toEqual(["capture"]);
        expect((await written(page)).some((k) => k.includes(":capture#"))).toBe(
          true,
        );
        await expect
          .poll(state, { timeout: 10_000 })
          .toEqual({ kind: "stopped", cause: "local_storage" });
      }
    });
});
