import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { BrowserContext, Page } from "@playwright/test";
import { recordEvidence } from "./data-evidence";
import {
  arm,
  edit,
  incarnationOf,
  install,
  installMarkerReadFaults,
  type MarkerReads,
  markerInstances,
  markerKeysOf,
  markerReads,
  markers,
  outboxState,
  queue,
  serveIdentityReads,
  statusOf,
  streaks,
  warning,
} from "./data-local-faults";
import { untilOutboxPlanCalled } from "./data-operation-barriers";
import {
  ACCOUNT,
  bootSession,
  dataPage,
  seedSettled,
  startOutbox,
  stubNetwork,
  untilTreeSettled,
  uuid,
} from "./data-sync-helpers";
import { expect, test } from "./helpers";

/**
 * E-O11 (revision 32, R52 and R53): a failure is ended by its own key and by the version it was seen at, in a real engine.
 *
 * R52. The independent review of revision 31 read a marker on one real page, let ANOTHER real page replace it, and let the first page
 * remove it (all nine interleavings failed, in Chromium, Firefox and WebKit). A marker whose key names its failure
 * (`atlas-write-failing:<account>:<operation>#<page>.<count>`) is written once and removed by that exact key, so the other page's failure
 * has a key of its own and the removal cannot reach it. Here the first page's REAL `localStorage.removeItem` is the barrier: the page
 * blocks inside it (a synchronous request to a route the spec serves), the spec makes the SECOND page record a failure through the real
 * markers over the real storage, and only then lets the removal go. The three schedules of the review (a direct retirement, an owed
 * retirement settled by a probe, one settled by a listing) each have their control (the other page writes nothing).
 *
 * R53. The review saved two drafts, failed an edit and its counter write for each (two fallback stops), asked to retry all, held the
 * delivery of the first counter reset after it committed, recorded NEWER failures of the second draft (three durable ones; a new
 * marker; a new marker whose reads then throw) and released the reset: the retry ended them, the warning went down, and starting the
 * dispatcher sent BOTH original bodies (six failing cases, in three engines). Here the same schedule runs through the production
 * facade over REAL IndexedDB (the failures are aborts the spec installs in the page) and the page's real `localStorage`, with the
 * dispatcher started separately afterwards, as the review composed it (the supported composition; production leadership is WEB-09b's).
 *
 * What is NOT claimed: a page freeze, a slow disk or a real storage failure (the delay is the fixture's hold of the facade's answer after
 * its transaction committed, the failures are injected aborts and refused or throwing storage calls), that the newer, unsaved body was
 * saved or sent (it was neither), or the released backend's answers (they are scripted). FIXTURE evidence for this engine on this machine.
 */
const A = uuid(61);
const B = uuid(62);
const NONE: MarkerReads = { enumeration: false, getItem: false };

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
const untilWarning = (page: Page, notResponding: boolean) =>
  expect
    .poll(async () => (await warning(page))?.notResponding, {
      timeout: 20_000,
    })
    .toBe(notResponding);
const untilStatus = (page: Page, id: string, status: string) =>
  expect.poll(() => statusOf(page, id), { timeout: 20_000 }).toBe(status);

test.describe("E-O11 (revision 32, R52): a retirement ends the key it saw, whatever another real page wrote meanwhile", () => {
  /**
   * The first page's real `localStorage.removeItem` blocks in a synchronous request while armed (`armed`), and refuses (`refuse`) the next
   * removals of a marker, as a store that will not remove does. `reached` counts the barriers that were taken.
   */
  async function installBarrier(page: Page): Promise<void> {
    await page.evaluate(() => {
      const w = window as unknown as {
        __barrier?: {
          armed: number;
          refuse: number;
          reached: number;
          url: string;
        };
      };
      if (w.__barrier) return;
      const state = { armed: 0, refuse: 0, reached: 0, url: "" };
      w.__barrier = state;
      const proto = Storage.prototype;
      const removeItem = proto.removeItem;
      proto.removeItem = function (this: Storage, key: string) {
        if (typeof key === "string" && key.startsWith("atlas-write-failing:")) {
          if (state.refuse > 0) {
            state.refuse -= 1;
            throw new DOMException("injected refusal", "QuotaExceededError");
          }
          if (state.armed > 0) {
            state.armed -= 1;
            state.reached += 1;
            const request = new XMLHttpRequest();
            request.open("GET", state.url, false);
            request.send();
            if (request.status !== 200)
              throw new Error("the other page did not write");
          }
        }
        return removeItem.call(this, key);
      };
    });
  }
  const barrier = (
    page: Page,
    next: { armed?: number; refuse?: number; url?: string },
  ) =>
    page.evaluate((state) => {
      const target = (
        window as unknown as {
          __barrier: { armed: number; refuse: number; url: string };
        }
      ).__barrier;
      if (state.armed !== undefined) target.armed = state.armed;
      if (state.refuse !== undefined) target.refuse = state.refuse;
      if (state.url !== undefined) target.url = state.url;
    }, next);
  /**
   * The spec's own loopback server, which the blocked page asks (a synchronous request) and which makes the OTHER page record its failure
   * before it answers. A server of the spec's own, not a route of the browser's: an engine does not hand a synchronous request to the
   * test runner (WebKit does not), and the fixture pages carry no content-security policy that would refuse the address.
   */
  async function serveBarrier(onWrite: () => Promise<boolean>) {
    const server = createServer((request, response) => {
      response.setHeader("Access-Control-Allow-Origin", "*");
      if (!request.url?.startsWith("/interleave")) {
        response.statusCode = 404;
        response.end();
        return;
      }
      onWrite().then(
        (ok) => {
          response.statusCode = ok ? 200 : 500;
          response.end("written");
        },
        (error) => {
          response.statusCode = 500;
          response.end(String(error));
        },
      );
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const { port } = server.address() as AddressInfo;
    return {
      url: `http://127.0.0.1:${port}/interleave`,
      close: () =>
        new Promise<void>((done) => {
          server.closeAllConnections();
          server.close(() => done());
        }),
    };
  }
  const reached = (page: Page) =>
    page.evaluate(
      () =>
        (window as unknown as { __barrier: { reached: number } }).__barrier
          .reached,
    );
  /** The raw keys of the markers that stand for the operation, by the oracle that parses them itself (any lifetime). */
  const keysOf = markerKeysOf;

  for (const mode of ["retire", "owed-probe", "owed-inspect"] as const)
    for (const interleave of [false, true])
      test(`R52: ${mode}: the other page ${interleave ? "writes between the read and the removal" : "writes nothing (control)"}`, async ({
        context,
      }, info) => {
        await stubNetwork(context);
        const page = await dataPage(context);
        const writer = await dataPage(context);
        const account = crypto.randomUUID().replace(/^.{8}/, "00000000");
        const operation = "draft:a";
        await installBarrier(page);
        // The spec serves the barrier: the first page blocks until the SECOND page's REAL markers have written to the REAL storage.
        const writes: string[] = [];
        const served = await serveBarrier(async () => {
          const wrote = await writer.evaluate(
            async ([acct, op]) => {
              const m = window.__atlasData?.markers;
              if (!m) throw new Error("no markers");
              const published = m.set(
                { account: acct as string, incarnationId: "incarnation-1" },
                op as string,
              );
              const state = published.state;
              return {
                ok: state === "recorded",
                keys: Object.keys(localStorage),
              };
            },
            [account, operation] as const,
          );
          writes.push(
            ...wrote.keys.filter(
              (k) =>
                k.startsWith("atlas-write-failing:") && k.includes(account),
            ),
          );
          return wrote.ok;
        });
        try {
          const original = await page.evaluate(
            async ([acct, op]) => {
              const m = window.__atlasData?.markers;
              if (!m) throw new Error("no markers");
              const published = m.set(
                { account: acct as string, incarnationId: "incarnation-1" },
                op as string,
              );
              const state = published.state;
              if (state !== "recorded") throw new Error("initial marker");
              return Object.keys(localStorage).filter(
                (k) => k.startsWith("atlas-write-failing:") && k.includes(acct),
              );
            },
            [account, operation] as const,
          );
          expect(original).toHaveLength(1);
          // The act's witness: the instances that stand when the success was issued.
          await page.evaluate(
            ([acct, op]) => {
              const m = window.__atlasData?.markers;
              (window as unknown as { __seen: unknown }).__seen = m?.witness(
                { account: acct as string, incarnationId: "incarnation-1" },
                op as string,
              );
            },
            [account, operation] as const,
          );
          if (mode !== "retire") {
            // The success is delivered while the store refuses the removal: the retirement is owed.
            await barrier(page, { refuse: 1 });
            expect(
              await page.evaluate(
                ([acct, op]) =>
                  window.__atlasData?.markers.retire(
                    { account: acct as string, incarnationId: "incarnation-1" },
                    op as string,
                    (window as unknown as { __seen: never }).__seen,
                  ),
                [account, operation] as const,
              ),
            ).toBe(false);
            expect(await keysOf(page, account, operation)).toEqual(original);
          }
          await barrier(page, {
            armed: interleave ? 1 : 0,
            url: served.url,
          });
          await page.evaluate(
            ([acct, op, how]) => {
              const m = window.__atlasData?.markers;
              if (!m) throw new Error("no markers");
              const seen = (window as unknown as { __seen: never }).__seen;
              if (how === "retire")
                m.retire(
                  { account: acct as string, incarnationId: "incarnation-1" },
                  op as string,
                  seen,
                );
              else if (how === "owed-probe")
                m.probe(
                  { account: acct as string, incarnationId: "incarnation-1" },
                  op as string,
                );
              else
                m.inspect({
                  account: acct as string,
                  incarnationId: "incarnation-1",
                });
            },
            [account, operation, mode] as const,
          );
          // What the removal did, as the other page sees it. The browser delivers a page's writes to the others asynchronously (WebKit and
          // Chromium show a page its own view first), so the other page's keys are polled until they are what they are to be, and the
          // first page's after that.
          if (interleave)
            await expect
              .poll(() => keysOf(writer, account, operation), {
                timeout: 10_000,
              })
              .toHaveLength(1);
          const after = await keysOf(writer, account, operation);
          recordEvidence(
            info,
            `r52-${mode}-${interleave ? "race" : "control"}`,
            {
              original,
              after,
              reached: await reached(page),
              writes,
            },
          );
          if (interleave) {
            // The barrier was taken, the other page's write succeeded and has a key of its own, and the removal took the older key only.
            expect(await reached(page)).toBe(1);
            expect(after).toHaveLength(1);
            expect(after).not.toEqual(original);
            expect(writes.some((k) => after.includes(k))).toBe(true);
            // The first page learns of it as the browser tells it (a page's view of another page's write is not instant in every engine):
            // its keys, and its markers' answer, become the other page's failure.
            await expect
              .poll(() => keysOf(page, account, operation), { timeout: 10_000 })
              .toEqual(after);
            await expect
              .poll(
                () =>
                  page.evaluate(
                    ([acct, op]) =>
                      window.__atlasData?.markers.probe(
                        {
                          account: acct as string,
                          incarnationId: "incarnation-1",
                        },
                        op as string,
                      ),
                    [account, operation] as const,
                  ),
                { timeout: 10_000 },
              )
              .toBe("marked");
          } else {
            expect(await reached(page)).toBe(0);
            expect(after).toEqual([]);
            await expect
              .poll(() => keysOf(page, account, operation), { timeout: 10_000 })
              .toEqual([]);
          }
        } finally {
          await served.close();
        }
      });

  // The review's schedule put the other page's write BETWEEN two calls of the retirement. A retirement is also reached when the other page
  // wrote EARLIER than that: after the witness was taken and before the retirement (or the listing that settles an owed one) began, so that
  // the failure is already in the first page's listing. It must stand then as well: nothing that ends a failure may take a key the witness
  // did not name, whatever it can see (the operation-wide removal that revision 31 made by comparing first removed exactly this).
  for (const mode of ["retire", "owed-probe", "owed-inspect"] as const)
    test(`R52: ${mode}: the other page wrote after the witness and BEFORE the retirement began: its key stands`, async ({
      context,
    }, info) => {
      await stubNetwork(context);
      const page = await dataPage(context);
      const writer = await dataPage(context);
      const account = crypto.randomUUID().replace(/^.{8}/, "00000000");
      const operation = "draft:a";
      await installBarrier(page);
      const original = await page.evaluate(
        async ([acct, op]) => {
          const m = window.__atlasData?.markers;
          if (!m) throw new Error("no markers");
          const published = m.set(
            { account: acct as string, incarnationId: "incarnation-1" },
            op as string,
          );
          const state = published.state;
          if (state !== "recorded") throw new Error("initial marker");
          (window as unknown as { __seen: unknown }).__seen = m.witness(
            { account: acct as string, incarnationId: "incarnation-1" },
            op as string,
          );
          return Object.keys(localStorage).filter(
            (k) => k.startsWith("atlas-write-failing:") && k.includes(acct),
          );
        },
        [account, operation] as const,
      );
      expect(original).toHaveLength(1);
      if (mode !== "retire") {
        await barrier(page, { refuse: 1 });
        expect(
          await page.evaluate(
            ([acct, op]) =>
              window.__atlasData?.markers.retire(
                { account: acct as string, incarnationId: "incarnation-1" },
                op as string,
                (window as unknown as { __seen: never }).__seen,
              ),
            [account, operation] as const,
          ),
        ).toBe(false);
      }
      // The other page records its failure now; the first page has LISTED it before it ends anything.
      expect(
        await writer.evaluate(
          async ([acct, op]) => {
            const published = window.__atlasData?.markers.set(
              { account: acct as string, incarnationId: "incarnation-1" },
              op as string,
            );
            if (!published) throw new Error("no markers");
            return published.state;
          },
          [account, operation] as const,
        ),
      ).toBe("recorded");
      await expect
        .poll(() => keysOf(page, account, operation), { timeout: 10_000 })
        .toHaveLength(2);
      await page.evaluate(
        ([acct, op, how]) => {
          const m = window.__atlasData?.markers;
          if (!m) throw new Error("no markers");
          const seen = (window as unknown as { __seen: never }).__seen;
          if (how === "retire")
            m.retire(
              { account: acct as string, incarnationId: "incarnation-1" },
              op as string,
              seen,
            );
          else if (how === "owed-probe")
            m.probe(
              { account: acct as string, incarnationId: "incarnation-1" },
              op as string,
            );
          else
            m.inspect({
              account: acct as string,
              incarnationId: "incarnation-1",
            });
        },
        [account, operation, mode] as const,
      );
      await expect
        .poll(() => keysOf(writer, account, operation), { timeout: 10_000 })
        .toHaveLength(1);
      const after = await keysOf(writer, account, operation);
      expect(after).not.toEqual(original);
      await expect
        .poll(() => keysOf(page, account, operation), { timeout: 10_000 })
        .toEqual(after);
      recordEvidence(info, `r52-${mode}-early-write`, { original, after });
    });
});

test.describe("E-O11 (revision 32, R53): a delayed retry ends the failures that stood when it was made, in a real engine", () => {
  /** A page with a running outbox whose dispatcher is NOT started (queue first, send after), over a database with a valid cache. */
  async function boot(context: BrowserContext) {
    const net = await stubNetwork(context);
    await serveIdentityReads(context);
    await seedSettled(context);
    const page = await bootSession(context);
    await untilTreeSettled(page, { connections: 0 });
    await startOutbox(page, ACCOUNT, { start: false });
    await untilTreeSettled(page, { connections: 2 });
    await page.evaluate(
      (acct) =>
        window.__atlasData?.put(
          acct,
          "cache",
          ["r", "s"].map((id) => ({
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
    await installMarkerReadFaults(page);
    return { net, page };
  }

  for (const mechanism of [
    "durable",
    "marker-readable",
    "marker-unreadable",
  ] as const)
    for (const newer of [false, true])
      test(`R53: draft b ${mechanism}, newer failure=${newer}: ${newer ? "only a is released and b's original body is not sent" : "both are released (control)"}`, async ({
        context,
      }, info) => {
        const { net, page } = await boot(context);
        await context.setOffline(true);
        expect((await enqueue(page, A, "r", "original"))?.kind).toBe("queued");
        expect((await enqueue(page, B, "s", "original"))?.kind).toBe("queued");
        // Both drafts are stopped by a fallback marker alone: the edit failed and so did the recording of its failure.
        for (const [id, target] of [
          [A, "r"],
          [B, "s"],
        ] as const) {
          await arm(page, { id, armed: 1, counter: 1 });
          expect(
            await editDraft(page, id, target, "first-failed"),
          ).toMatchObject({ kind: "refused", reason: "storage" });
        }
        await untilWarning(page, true);
        const olderB = await markerInstances(page, ACCOUNT, `draft:${B}`);
        expect(olderB).toHaveLength(1);
        // The first counter reset of the retry is held after its transaction was made: the retry has not reached b.
        await page.evaluate(() =>
          window.__atlasData?.holdOutboxPlan("data.recordLocalWriteOutcome"),
        );
        await page.evaluate(() => window.__atlasData?.retryOutbox());
        await untilOutboxPlanCalled(page);
        if (newer) {
          if (mechanism === "durable") {
            await arm(page, { id: B, armed: 3 });
            for (let i = 0; i < 3; i += 1)
              expect(
                await editDraft(page, B, "s", "newer-failed"),
              ).toMatchObject({ kind: "refused", reason: "storage" });
            expect((await streaks(page))[`draft:${B}`]).toBe(3);
          } else {
            await arm(page, { id: B, armed: 1, counter: 1 });
            expect(await editDraft(page, B, "s", "newer-failed")).toMatchObject(
              {
                kind: "refused",
                reason: "storage",
              },
            );
          }
        }
        const before = {
          markers: await markerInstances(page, ACCOUNT, `draft:${B}`),
          streak: (await streaks(page))[`draft:${B}`] ?? 0,
          warning: await warning(page),
        };
        // The reads throw before the earlier retry continues (the older retry must not turn that into permission).
        if (mechanism === "marker-unreadable")
          await markerReads(page, { enumeration: true, getItem: true });
        await page.evaluate(() => window.__atlasData?.releaseOutboxPlan());
        // The retry has moved on to b: a's marker is gone (the key it saw).
        await expect
          .poll(() => markerInstances(page, ACCOUNT, `draft:${A}`), {
            timeout: 20_000,
          })
          .toEqual([]);
        await markerReads(page, NONE);
        // Nothing the retry did is still outstanding once b's own cleanup has been decided: the dispatcher is started after it, as the
        // review composed it, and the page comes online.
        await expect
          .poll(async () => (await warning(page))?.notResponding, {
            timeout: 20_000,
          })
          .toBe(newer);
        const after = {
          markers: await markerInstances(page, ACCOUNT, `draft:${B}`),
          streak: (await streaks(page))[`draft:${B}`] ?? 0,
          warning: await warning(page),
        };
        await page.evaluate(() => window.__atlasData?.beginOutbox());
        await context.setOffline(false);
        if (newer) {
          await untilStatus(page, A, "acknowledged");
          await expect
            .poll(async () => (await outboxState(page))?.kind, {
              timeout: 20_000,
            })
            .toBe("stopped");
          // b stays held for as long as the observation lasts: neither body of it is sent.
          for (let sample = 0; sample < 12; sample += 1) {
            await page.evaluate(() =>
              window.dispatchEvent(new Event("online")),
            );
            expect(net.commands.map((c) => c.key)).toEqual([A]);
            await page.waitForTimeout(50);
          }
          expect(await statusOf(page, B)).toBe("queued");
          // The newer failure is exactly as recorded.
          if (mechanism === "durable") {
            expect(after.streak).toBe(3);
            expect(after.markers).toEqual(
              before.markers.filter((name) => !olderB.includes(name)),
            );
          } else
            expect(after.markers).toEqual(
              before.markers.filter((name) => !olderB.includes(name)),
            );
          expect(after.warning?.notResponding).toBe(true);
        } else {
          await untilStatus(page, A, "acknowledged");
          await untilStatus(page, B, "acknowledged");
          expect(net.commands.map((c) => c.key).sort()).toEqual([A, B].sort());
          expect(await markers(page)).toEqual([]);
        }
        const bodies = net.commands.map((c) => c.body).join("|");
        expect(bodies).not.toContain("newer-failed");
        expect(bodies).not.toContain("first-failed");
        recordEvidence(
          info,
          `r53-${mechanism}-${newer ? "newer" : "control"}`,
          {
            olderB,
            before,
            after,
            sent: net.commands.map((c) => c.key),
            rows: (await queue(page))?.map((row) => [row.local_id, row.status]),
          },
        );
      });

  test("R53: two retries, one after the other, are separately scoped: the second ends what the first could not", async ({
    context,
  }) => {
    const { net, page } = await boot(context);
    // The other page boots while the network is up (a page needs it to boot), and stays open: it only writes `localStorage`.
    const other = await dataPage(context);
    await context.setOffline(true);
    expect((await enqueue(page, A, "r", "original"))?.kind).toBe("queued");
    await arm(page, { id: A, armed: 1, counter: 1 });
    expect(await editDraft(page, A, "r", "first-failed")).toMatchObject({
      kind: "refused",
    });
    await untilWarning(page, true);
    await page.evaluate(() =>
      window.__atlasData?.holdOutboxPlan("data.recordLocalWriteOutcome"),
    );
    await page.evaluate(() => window.__atlasData?.retryOutbox());
    await untilOutboxPlanCalled(page);
    // Another real page's failure arrives while the reset waits.
    // (the other page records it in the lifetime of the database both pages have open, as a real second tab would)
    const lifetime = await incarnationOf(page, ACCOUNT);
    await other.evaluate(
      async ([acct, inc, op]) => {
        const published = window.__atlasData?.markers.set(
          { account: acct as string, incarnationId: inc as string },
          op as string,
        );
        if (!published) throw new Error("no markers");
        return published.state;
      },
      [ACCOUNT, lifetime, `draft:${A}`] as const,
    );
    await expect
      .poll(() => markerInstances(page, ACCOUNT, `draft:${A}`), {
        timeout: 10_000,
      })
      .toHaveLength(1);
    await page.evaluate(() => window.__atlasData?.releaseOutboxPlan());
    await untilWarning(page, true);
    // The person asks again, having seen the warning stay: the second act's entitlement includes the newer marker.
    await page.evaluate(() => window.__atlasData?.retryOutbox());
    await expect
      .poll(() => markerInstances(page, ACCOUNT, `draft:${A}`), {
        timeout: 20_000,
      })
      .toEqual([]);
    await page.evaluate(() => window.__atlasData?.beginOutbox());
    await context.setOffline(false);
    await untilStatus(page, A, "acknowledged");
    expect(net.commands.map((c) => c.key)).toEqual([A]);
  });
});
