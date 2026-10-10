import type { BrowserContext, Page } from "@playwright/test";
import type { HarnessEnqueue } from "../../src/fixture/data-harness/main";
import { recordEvidence } from "./data-evidence";
import { markers as sharedMarkers } from "./data-local-faults";
import {
  ACCOUNT,
  atlasError,
  bootSession,
  seedSettled,
  startOutbox,
  stubNetwork,
  untilTreeSettled,
  uuid,
} from "./data-sync-helpers";
import { expect, test } from "./helpers";

/**
 * E-O8 (revision 26, R46 and R47): the failure state of a local write ends with that write's own success or its explicit abandonment, and
 * the storage warning is every stop that still stands, in a real engine.
 *
 * The production outbox facade, plans, dispatcher, Dexie adapter and the fallback markers over REAL IndexedDB and the page's REAL
 * `localStorage`, through the production session's stamped wrapper, with the network stubbed by `page.route`. A named transaction is
 * ABORTED by a fault the spec installs in the page (a call of `IDBObjectStore.put` or `delete` that throws for the draft the case is
 * about), as the earlier specs fail a write: the facade's own failure handling, the durable streak and the marker are the real ones. FIXTURE
 * evidence for this engine on this machine: the HTTP answers are scripted inputs, not the released backend's, and the dispatcher is the
 * fixture's test leader (production starts none until WEB-09b). The page is OFFLINE (`context.setOffline`) while a draft is queued, so the
 * saved work is held until the recovery has been made. "After a reload" is a NEW page over the same database, with the page's `localStorage`
 * as it was, and nothing of the old page's memory.
 *
 * What is asserted is what the review reproduced in these engines (36 failures and 36 passes of its native probe): after a successful retry of
 * the same save, edit, supersession or discard, the draft's durable count, its marker and the warning are gone, and the saved work is sent;
 * and what the review found beside it (tests/data/outbox-local-recovery.test.ts asserts the same rules over the double of the store): with
 * two drafts stopped, "Try again" for one leaves the other's stop and the shared warning, and ends the warning only when the last one is gone.
 */
const OLD = uuid(31);
const NEW = uuid(32);
const A = uuid(33);
const B = uuid(34);

/** A version-checked edit of `id`, under a fixed key; `$base` is the base the transaction read for `id`. */
const edit = (id: string, localId: string): HarnessEnqueue => ({
  endpoint: "/commands",
  localId,
  targets: [
    {
      resourceId: id,
      role: "primary",
      basis: "resource",
      versionChecked: true,
    },
  ],
  command: { kind: "edit", id, base: { $base: id }, label: localId },
});

type Method = "enqueue" | "editQueued" | "supersede" | "discard";
const METHODS: Method[] = ["enqueue", "editQueued", "supersede", "discard"];
const DONE: Record<Method, string> = {
  enqueue: "queued",
  editQueued: "edited",
  supersede: "superseded",
  discard: "discarded",
};
type Fault = "healthy" | "streak" | "marker";
const FAULTS: Fault[] = ["healthy", "streak", "marker"];

const run = (page: Page, method: Method) =>
  page.evaluate(
    ({ m, old, spec }) => {
      const data = window.__atlasData;
      if (!data) throw new Error("no data harness");
      if (m === "enqueue") return data.enqueue(spec);
      if (m === "editQueued") return data.editQueued(old, spec);
      if (m === "supersede") return data.supersede(old, spec);
      return data.discardDraft(old);
    },
    {
      m: method,
      old: OLD,
      spec: edit(
        "r",
        method === "enqueue" || method === "supersede" ? NEW : OLD,
      ),
    },
  );

const streaks = (page: Page): Promise<Record<string, number>> =>
  page.evaluate(
    async (acct) =>
      (
        (await window.__atlasData?.syncState(acct)) as {
          local_write_streaks?: Record<string, number>;
        } | null
      )?.local_write_streaks ?? {},
    ACCOUNT,
  );
/** The operations that carry a marker in the page's real `localStorage` (the shared oracle parses the keys itself). */
const markers = sharedMarkers;
const warning = (page: Page) =>
  page.evaluate(() => window.__atlasData?.outboxStorage() ?? null);
const queue = (page: Page) =>
  page.evaluate((a) => window.__atlasData?.queue(a), ACCOUNT);
const statusOf = async (page: Page, id: string) =>
  (await queue(page))?.find((row) => row.local_id === id)?.status;
const untilStatus = (page: Page, id: string, status: string) =>
  expect.poll(() => statusOf(page, id), { timeout: 20_000 }).toBe(status);
const untilWarning = (page: Page, notResponding: boolean) =>
  expect
    .poll(async () => (await warning(page))?.notResponding, { timeout: 20_000 })
    .toBe(notResponding);
/** The warning is up and stays up while the page is observed (nothing else may take it down on its own). */
async function staysUp(page: Page): Promise<void> {
  for (let sample = 0; sample < 12; sample += 1) {
    expect((await warning(page))?.notResponding).toBe(true);
    await page.waitForTimeout(50);
  }
}

/**
 * Installs the fault the page's writes go through: the NEXT `armed` calls of `put` of a `drafts` row (or of `delete` of one, for a discard)
 * named `id` throw, and the NEXT `counter` writes of `sync_state` that carry a failure streak throw too (the write that counts a failure, so
 * the stop goes to the marker instead). Throwing inside the transaction aborts it, as every earlier spec's injected fault does.
 */
async function install(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as {
      __fault?: {
        id: string;
        delete: boolean;
        armed: number;
        counter: number;
        queue: number;
        hits: string[];
      };
    };
    if (w.__fault) return;
    w.__fault = {
      id: "",
      delete: false,
      armed: 0,
      counter: 0,
      queue: 0,
      hits: [],
    };
    // The dispatcher's read of the queue: the one `getAll` of the `[status+created_seq]` index of `drafts` (a step makes exactly one).
    const index = IDBIndex.prototype as unknown as Record<
      string,
      (...a: unknown[]) => unknown
    >;
    const getAll = index.getAll as (...a: unknown[]) => unknown;
    index.getAll = function (this: IDBIndex, ...args: unknown[]) {
      const fault = w.__fault;
      if (
        fault &&
        fault.queue > 0 &&
        this.objectStore.name === "drafts" &&
        this.name === "[status+created_seq]"
      ) {
        fault.queue -= 1;
        fault.hits.push("getAll drafts.[status+created_seq] (the queue read)");
        throw new DOMException("injected fault", "DataError");
      }
      return getAll.apply(this, args);
    };
    const proto = IDBObjectStore.prototype as unknown as Record<
      string,
      (...a: unknown[]) => unknown
    >;
    for (const name of ["put", "delete"] as const) {
      const original = proto[name] as (...a: unknown[]) => unknown;
      proto[name] = function (this: IDBObjectStore, ...args: unknown[]) {
        const fault = w.__fault;
        if (fault && this.name === "drafts" && fault.armed > 0) {
          const key =
            name === "put"
              ? (args[0] as { local_id?: string } | undefined)?.local_id
              : (args[0] as string | undefined);
          if (key === fault.id && (name === "delete") === fault.delete) {
            fault.armed -= 1;
            fault.hits.push(`${name} drafts ${key}`);
            throw new DOMException("injected fault", "DataError");
          }
        }
        if (
          fault &&
          name === "put" &&
          this.name === "sync_state" &&
          fault.counter > 0
        ) {
          const row = args[0] as { local_write_streaks?: object };
          if (Object.keys(row?.local_write_streaks ?? {}).length > 0) {
            fault.counter -= 1;
            fault.hits.push("put sync_state (a failure's counter)");
            throw new DOMException("injected fault", "DataError");
          }
        }
        return original.apply(this, args);
      };
    }
  });
}
const arm = (
  page: Page,
  options: {
    id?: string;
    delete?: boolean;
    armed?: number;
    counter?: number;
    queue?: number;
  },
) =>
  page.evaluate((o) => {
    const fault = (
      window as unknown as {
        __fault: {
          id: string;
          delete: boolean;
          armed: number;
          counter: number;
          queue: number;
        };
      }
    ).__fault;
    fault.id = o.id ?? "";
    fault.delete = o.delete ?? false;
    fault.armed = o.armed ?? 0;
    fault.counter = o.counter ?? 0;
    fault.queue = o.queue ?? 0;
  }, options);
const hits = (page: Page): Promise<string[]> =>
  page.evaluate(
    () => (window as unknown as { __fault: { hits: string[] } }).__fault.hits,
  );

/** Serves `GET /me` and `GET /sessions` (the profile read and the device mirror), as a healthy backend does; call it AFTER `stubNetwork`. */
async function serveIdentityReads(context: BrowserContext): Promise<void> {
  const now = Date.now();
  await context.route("**/api/experimental/v1/me", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ id: ACCOUNT, username: "alice" }),
    }),
  );
  await context.route("**/api/experimental/v1/sessions", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        sessions: [
          {
            id: "s1",
            device_id: "dev-1",
            created_at: new Date(now - 60_000).toISOString(),
            expires_at: new Date(now + 86_400_000).toISOString(),
            authentication: "password",
            current: true,
          },
        ],
      }),
    }),
  );
}

/** A page with a running outbox over a database that has a valid cache; the network is stubbed and identity reads are served. */
async function boot(context: BrowserContext) {
  const net = await stubNetwork(context);
  await serveIdentityReads(context);
  await seedSettled(context);
  const page = await bootSession(context);
  await untilTreeSettled(page, { connections: 0 });
  await startOutbox(page);
  await untilTreeSettled(page, { connections: 2 });
  await page.evaluate(
    (acct) =>
      window.__atlasData?.put(
        acct,
        "cache",
        ["r", "s", "t", "u"].map((id) => ({
          id,
          kind: "person",
          parent_id: null,
          label: id,
          value: null,
          version: 5,
          can_edit: true,
          archived: false,
          kind_date: null,
        })),
      ),
    ACCOUNT,
  );
  await install(page);
  return { net, page };
}

/**
 * A NEW page over the same database and `localStorage`, the old page's outbox stopped first so that nothing it held in memory (and nothing
 * it would still send) comes with it. The context is online again: the new page cannot load otherwise, and its dispatcher is started only
 * when the case says so.
 */
async function reload(context: BrowserContext, page: Page): Promise<Page> {
  await page.evaluate(() => window.__atlasData?.stopOutbox());
  await context.setOffline(false);
  await page.close();
  const next = await bootSession(context);
  await untilTreeSettled(next, { connections: 2 });
  await next.evaluate(async (acct) => {
    const data = window.__atlasData;
    if (!data) throw new Error("no data harness");
    await data.startOutbox(acct, { start: false });
  }, ACCOUNT);
  await install(next);
  return next;
}

/**
 * The draft the method acts on is saved (a conflicted one for a supersession, as a person resolves one), and the page is then OFFLINE, so
 * that nothing queued is sent until the case lets it.
 */
async function arranged(context: BrowserContext, method: Method) {
  const booted = await boot(context);
  const { net, page } = booted;
  if (method === "supersede") {
    net.commandScript.push(() => ({
      status: 409,
      body: atlasError("operation_conflict"),
    }));
    expect(
      (
        await page.evaluate(
          (s) => window.__atlasData?.enqueue(s),
          edit("r", OLD),
        )
      )?.kind,
    ).toBe("queued");
    await expect
      .poll(() => statusOf(page, OLD), { timeout: 20_000 })
      .toBe("operation_conflict");
    await context.setOffline(true);
  } else {
    await context.setOffline(true);
    if (method !== "enqueue")
      expect(
        (
          await page.evaluate(
            (s) => window.__atlasData?.enqueue(s),
            edit("r", OLD),
          )
        )?.kind,
      ).toBe("queued");
  }
  return booted;
}

test.describe("E-O8 (revision 26, R46): a successful retry ends its own failures, in a real engine", () => {
  for (const method of METHODS)
    for (const fault of FAULTS)
      for (const reloaded of [false, true])
        test(`R46: ${method}, ${fault}${reloaded ? ", after a reload" : ""}: the durable count, the marker and the warning end with the success, and the saved work is sent`, async ({
          context,
        }, info) => {
          const { net, page: first } = await arranged(context, method);
          let page = first;
          const target =
            method === "enqueue" || method === "supersede" ? NEW : OLD;

          const failures = fault === "healthy" ? 0 : fault === "streak" ? 3 : 1;
          if (failures > 0)
            await arm(page, {
              id: target,
              delete: method === "discard",
              armed: failures,
              counter: fault === "marker" ? 1 : 0,
            });
          for (let i = 0; i < failures; i += 1)
            expect(await run(page, method)).toMatchObject({
              kind: "refused",
              reason: "storage",
            });
          const own = `draft:${target}`;
          const stopped = {
            streaks: await streaks(page),
            markers: await markers(page),
            warning: await warning(page),
            hits: failures > 0 ? await hits(page) : [],
          };
          recordEvidence(info, `${method}-${fault}-stopped`, stopped);
          if (fault === "streak") {
            expect(stopped.streaks[own]).toBe(3);
            expect(stopped.warning?.notResponding).toBe(true);
          }
          if (fault === "marker") {
            expect(stopped.markers).toContain(own);
            expect(stopped.warning?.notResponding).toBe(true);
          }
          if (fault === "healthy") {
            expect(stopped.streaks[own]).toBeUndefined();
            expect(stopped.warning?.notResponding).toBe(false);
          } else expect(stopped.hits.length).toBeGreaterThanOrEqual(failures);

          if (reloaded) {
            page = await reload(context, page);
            // The new page's first look at the record and the markers.
            await untilWarning(page, fault !== "healthy");
          }

          const done = await run(page, method);
          const recovered = {
            done,
            streaks: await streaks(page),
            markers: await markers(page),
            warning: await warning(page),
          };
          recordEvidence(info, `${method}-${fault}-recovered`, recovered);
          expect(done?.kind).toBe(DONE[method]);
          expect(recovered.streaks[own]).toBeUndefined();
          expect(recovered.markers).not.toContain(own);
          await untilWarning(page, false);
          expect((await warning(page))?.memoryOnly).toBe(false);

          // The saved work is no longer held back: it is sent, or (a discard) there is nothing left to send.
          if (reloaded)
            await page.evaluate(() => window.__atlasData?.beginOutbox());
          await context.setOffline(false);
          if (method === "discard")
            expect(
              ((await queue(page)) ?? []).some((row) => row.local_id === OLD),
            ).toBe(false);
          else {
            await untilStatus(page, target, "acknowledged");
            expect(net.commands.some((c) => c.key === target)).toBe(true);
          }
          expect(
            await page.evaluate(() => window.__atlasData?.outboxState()),
          ).not.toMatchObject({ kind: "stopped" });
        });
});

test.describe("E-O8 (revision 26, R47): retrying one operation never hides another that is still stopped, in a real engine", () => {
  const STOPS = ["streak", "marker"] as const;
  for (const a of STOPS)
    for (const b of STOPS)
      for (const reloaded of [false, true])
        test(`R47: A is stopped by ${a}, B by ${b}${reloaded ? ", after a reload" : ""}: A's retry keeps B's stop and the shared warning; B's retry ends it`, async ({
          context,
        }, info) => {
          await boot(context).then(async ({ page: first }) => {
            let page = first;
            await context.setOffline(true);
            for (const [id, stop] of [
              [A, a],
              [B, b],
            ] as const) {
              await arm(page, {
                id,
                armed: stop === "streak" ? 3 : 1,
                counter: stop === "marker" ? 1 : 0,
              });
              for (let i = 0; i < (stop === "streak" ? 3 : 1); i += 1)
                expect(
                  (
                    await page.evaluate(
                      (s) => window.__atlasData?.enqueue(s as HarnessEnqueue),
                      edit(id === A ? "s" : "t", id),
                    )
                  )?.kind,
                ).toBe("refused");
            }
            expect((await warning(page))?.notResponding).toBe(true);
            if (reloaded) {
              page = await reload(context, page);
              await untilWarning(page, true);
            }

            // B's stop is known to this page, so the warning is not taken down even for the instant before A's clearing is written.
            const immediately = await page.evaluate((id) => {
              const data = window.__atlasData;
              data?.retryOutbox(id);
              return data?.outboxStorage();
            }, A);
            expect(immediately?.notResponding).toBe(true);
            await expect
              .poll(async () => [
                (await streaks(page))[`draft:${A}`],
                (await markers(page)).includes(`draft:${A}`),
              ])
              .toEqual([undefined, false]);
            await staysUp(page);
            const afterA = {
              streaks: await streaks(page),
              markers: await markers(page),
              warning: await warning(page),
            };
            recordEvidence(info, `after-retry-of-a`, afterA);
            // B's stop is untouched, and so is the warning they share.
            if (b === "streak") expect(afterA.streaks[`draft:${B}`]).toBe(3);
            else expect(afterA.markers).toContain(`draft:${B}`);

            await page.evaluate((id) => window.__atlasData?.retryOutbox(id), B);
            await untilWarning(page, false);
            expect(await streaks(page)).toEqual({});
            expect(await markers(page)).toEqual([]);
          });
        });
});

test.describe("E-O8 (revision 26, R46): the dispatcher's own successes end its failures, in a real engine", () => {
  /** The dispatcher is asked to look at the queue now: the `online` event a browser fires (a wake, not an explicit retry). */
  const wake = (page: Page) =>
    page.evaluate(() => window.dispatchEvent(new Event("online")));

  test("R46: three isolated aborts of the queue read, with successful reads between them, are not three in a row", async ({
    context,
  }, info) => {
    const { page } = await boot(context);
    for (let round = 1; round <= 3; round += 1) {
      await arm(page, { queue: 1 });
      await wake(page);
      await expect
        .poll(async () => (await hits(page)).length, {
          timeout: 20_000,
        })
        .toBe(round);
      // The read that follows (the dispatcher looks again by itself) lands, and ends the count.
      await expect
        .poll(async () => (await streaks(page)).queue, { timeout: 20_000 })
        .toBeUndefined();
    }
    recordEvidence(info, "isolated-aborts", {
      hits: await hits(page),
      streaks: await streaks(page),
      state: await page.evaluate(() => window.__atlasData?.outboxState()),
    });
    expect(
      await page.evaluate(() => window.__atlasData?.outboxState()),
    ).toEqual({ kind: "idle" });
  });

  test("R46: three failures of the queue read in a row still stop the dispatcher, and the next read that lands lifts the stop", async ({
    context,
  }) => {
    const { page } = await boot(context);
    await arm(page, { queue: 3 });
    await wake(page);
    await expect
      .poll(() => page.evaluate(() => window.__atlasData?.outboxState()), {
        timeout: 20_000,
      })
      .toEqual({ kind: "stopped", cause: "local_storage" });
    expect((await streaks(page)).queue).toBe(3);
    await wake(page);
    await expect
      .poll(() => page.evaluate(() => window.__atlasData?.outboxState()), {
        timeout: 20_000,
      })
      .toEqual({ kind: "idle" });
    expect((await streaks(page)).queue).toBeUndefined();
  });

  test("R46: a claim that lands ends the failures of the claim, whoever saw them (two failed edits, a reload, then the draft is sent)", async ({
    context,
  }, info) => {
    const { net, page: first } = await arranged(context, "editQueued");
    await arm(first, { id: OLD, armed: 2 });
    for (let i = 0; i < 2; i += 1)
      expect(await run(first, "editQueued")).toMatchObject({
        kind: "refused",
        reason: "storage",
      });
    expect((await streaks(first))[`draft:${OLD}`]).toBe(2);
    const page = await reload(context, first);
    await page.evaluate(() => window.__atlasData?.beginOutbox());
    await untilStatus(page, OLD, "acknowledged");
    recordEvidence(info, "claim", { streaks: await streaks(page) });
    expect(net.commands.some((c) => c.key === OLD)).toBe(true);
    expect((await streaks(page))[`draft:${OLD}`]).toBeUndefined();
  });
});
