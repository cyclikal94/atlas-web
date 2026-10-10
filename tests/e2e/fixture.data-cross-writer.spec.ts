import type { Page } from "@playwright/test";
import { recordEvidence } from "./data-evidence";
import {
  arm,
  boot,
  edit,
  hits,
  markers,
  outboxState,
  queue,
  statusOf,
  streaks,
  warning,
} from "./data-local-faults";
import { uuid } from "./data-sync-helpers";
import { expect, test } from "./helpers";

/**
 * E-O9 (revision 27, R46 and R47): ONE stop, whichever writer holds it, in a real engine.
 *
 * The production outbox facade, plans, dispatcher, Dexie adapter and fallback markers over REAL IndexedDB and the page's REAL
 * `localStorage`, through the production session's stamped wrapper, with the network stubbed by `page.route`. The facade and the
 * dispatcher both write `draft:<id>` (a save, an edit or a discard; the claim), so the stop of one of them must be seen, honoured and
 * ended by the other: a stop the DISPATCHER recorded ends when the facade's own edit or discard of the draft succeeds (revision 26 left
 * the dispatcher stopped), and a stop the FACADE recorded is honoured by an ordinary wake of the dispatcher, which sent the saved draft
 * (revision 26) until the person retried. The memory-only form (neither the record nor the marker could hold it) is the page's, shared by
 * the two. R47: a record that cannot be read is unknown, not empty, so a stop the page knew of stands through any number of unreadable
 * reconciliations and an unrelated "Try again" or save never hides it.
 *
 * A named transaction is ABORTED by a fault the spec installs in the page (a throwing `put` or `delete` of one draft's row, a throwing
 * write of the failure's counter, and, for the memory-only form, a refused `setItem` of the marker); the facade's reads of the record of
 * stops fail through the real plan (`failStopReads`). FIXTURE evidence for this engine on this machine: the HTTP answers are scripted
 * inputs, not the released backend's, the dispatcher is the fixture's test leader (production starts none until WEB-09b), and no real
 * failing disk or full origin is produced. The page is OFFLINE while a draft is queued, so the saved work is held until the case lets it
 * go. What the review reproduced in these engines (revision 26: 9 of 24 cases failing) is asserted here as it asserts it.
 */
const OLD = uuid(41);
const A = uuid(42);
const B = uuid(43);

type Mechanism = "streak" | "marker" | "memory";
const MECHANISMS: Mechanism[] = ["streak", "marker", "memory"];
/** The faults a failure of one write needs for the stop to be held by `mechanism`: three counted failures, or the counter (then the marker) cannot be written. */
const faultFor = (mechanism: Mechanism) => ({
  armed: mechanism === "streak" ? 3 : 1,
  counter: mechanism === "streak" ? 0 : 1,
  markers: mechanism === "memory" ? 1 : 0,
});

const enqueue = (page: Page, localId: string, target: string, label: string) =>
  page.evaluate(
    (spec) => window.__atlasData?.enqueue(spec),
    edit(target, localId, label),
  );
const untilState = (page: Page, kind: string) =>
  expect
    .poll(async () => (await outboxState(page))?.kind, { timeout: 20_000 })
    .toBe(kind);
const untilWarning = (
  page: Page,
  notResponding: boolean,
  memoryOnly: boolean,
) =>
  expect
    .poll(async () => await warning(page), { timeout: 20_000 })
    .toEqual({ notResponding, memoryOnly });
const untilStatus = (page: Page, id: string, status: string) =>
  expect.poll(() => statusOf(page, id), { timeout: 20_000 }).toBe(status);
/** The state stays `stopped` and nothing is sent while the page is observed, however the dispatcher is woken meanwhile. */
async function staysHeld(
  page: Page,
  net: { commands: unknown[] },
): Promise<void> {
  for (let sample = 0; sample < 12; sample += 1) {
    await page.evaluate(() => window.dispatchEvent(new Event("online")));
    expect((await outboxState(page))?.kind).toBe("stopped");
    expect(net.commands).toHaveLength(0);
    await page.waitForTimeout(50);
  }
}

test.describe("E-O9 (revision 27, R46): a stop the dispatcher recorded ends with the facade's own success or abandonment, in a real engine", () => {
  for (const mechanism of MECHANISMS)
    for (const method of ["editQueued", "discard"] as const)
      test(`R46: the dispatcher's ${mechanism} stop of a draft ends on the facade's ${method}: the count, the marker and the warning are gone, and the draft goes on`, async ({
        context,
      }, info) => {
        const { net, page } = await boot(context);
        await context.setOffline(true);
        expect((await enqueue(page, OLD, "r", "original"))?.kind).toBe(
          "queued",
        );
        // The claim of the draft fails: the dispatcher's own write of `draft:<id>`.
        await arm(page, { id: OLD, ...faultFor(mechanism) });
        await context.setOffline(false);
        await untilState(page, "stopped");
        const stopped = {
          state: await outboxState(page),
          streaks: await streaks(page),
          markers: await markers(page),
          warning: await warning(page),
          hits: await hits(page),
          sent: net.commands.length,
        };
        recordEvidence(info, `${method}-${mechanism}-stopped`, stopped);
        expect(stopped.sent).toBe(0);
        if (mechanism === "streak")
          expect(stopped.streaks[`draft:${OLD}`]).toBe(3);
        if (mechanism === "marker")
          expect(stopped.markers).toContain(`draft:${OLD}`);
        // The facade shows the dispatcher's stop at once, and says when it is held in this tab alone.
        await untilWarning(page, true, mechanism === "memory");
        if (mechanism === "memory")
          expect(await outboxState(page)).toEqual({
            kind: "stopped",
            cause: "local_storage",
            memoryOnly: true,
          });

        const done =
          method === "editQueued"
            ? await page.evaluate(
                ({ id, spec }) => window.__atlasData?.editQueued(id, spec),
                { id: OLD, spec: edit("r", OLD, "edited") },
              )
            : await page.evaluate(
                (id) => window.__atlasData?.discardDraft(id),
                OLD,
              );
        expect(done?.kind).toBe(
          method === "editQueued" ? "edited" : "discarded",
        );
        await untilWarning(page, false, false);
        await untilState(page, "idle");
        recordEvidence(info, `${method}-${mechanism}-recovered`, {
          done,
          state: await outboxState(page),
          streaks: await streaks(page),
          markers: await markers(page),
          warning: await warning(page),
        });
        expect((await streaks(page))[`draft:${OLD}`]).toBeUndefined();
        expect(await markers(page)).not.toContain(`draft:${OLD}`);
        if (method === "editQueued") {
          await untilStatus(page, OLD, "acknowledged");
          expect(net.commands).toHaveLength(1);
          expect(net.commands[0]?.key).toBe(OLD);
          expect(net.commands[0]?.body).toContain('"label":"edited"');
        } else {
          expect(
            ((await queue(page)) ?? []).some((row) => row.local_id === OLD),
          ).toBe(false);
          expect(net.commands).toHaveLength(0);
        }
      });
});

test.describe("E-O9 (revision 27, R46): an ordinary wake honours a stop the facade recorded, until recovery or an explicit retry, in a real engine", () => {
  for (const mechanism of MECHANISMS)
    for (const recovery of [
      "the explicit retry",
      "the edit's own success",
      "a discard",
    ] as const)
      test(`R46: a ${mechanism} stop of the facade's ${recovery === "a discard" ? "discard" : "edit"} is not bypassed by the dispatcher's wake, and ends with ${recovery}`, async ({
        context,
      }, info) => {
        const { net, page } = await boot(context);
        await context.setOffline(true);
        expect((await enqueue(page, OLD, "r", "original"))?.kind).toBe(
          "queued",
        );
        const discarding = recovery === "a discard";
        const faults = faultFor(mechanism);
        await arm(page, { id: OLD, delete: discarding, ...faults });
        for (let i = 0; i < faults.armed; i += 1)
          expect(
            discarding
              ? await page.evaluate(
                  (id) => window.__atlasData?.discardDraft(id),
                  OLD,
                )
              : await page.evaluate(
                  ({ id, spec }) => window.__atlasData?.editQueued(id, spec),
                  { id: OLD, spec: edit("r", OLD, "new") },
                ),
          ).toMatchObject({ kind: "refused", reason: "storage" });
        await untilWarning(page, true, mechanism === "memory");
        recordEvidence(info, `${recovery}-${mechanism}-stopped`, {
          streaks: await streaks(page),
          markers: await markers(page),
          warning: await warning(page),
          hits: await hits(page),
        });

        // The page comes online: the dispatcher looks at the queue, finds the draft, and holds it back.
        await context.setOffline(false);
        await untilState(page, "stopped");
        await staysHeld(page, net);
        expect(await statusOf(page, OLD)).toBe("queued");
        expect(await warning(page)).toEqual({
          notResponding: true,
          memoryOnly: mechanism === "memory",
        });

        if (recovery === "the explicit retry")
          await page.evaluate((id) => window.__atlasData?.retryOutbox(id), OLD);
        else if (recovery === "the edit's own success")
          expect(
            (
              await page.evaluate(
                ({ id, spec }) => window.__atlasData?.editQueued(id, spec),
                { id: OLD, spec: edit("r", OLD, "saved") },
              )
            )?.kind,
          ).toBe("edited");
        else
          expect(
            (
              await page.evaluate(
                (id) => window.__atlasData?.discardDraft(id),
                OLD,
              )
            )?.kind,
          ).toBe("discarded");
        await untilWarning(page, false, false);
        await untilState(page, "idle");
        expect((await streaks(page))[`draft:${OLD}`]).toBeUndefined();
        expect(await markers(page)).toEqual([]);
        if (recovery === "a discard") {
          expect(net.commands).toHaveLength(0);
          expect(
            ((await queue(page)) ?? []).some((row) => row.local_id === OLD),
          ).toBe(false);
        } else {
          await untilStatus(page, OLD, "acknowledged");
          expect(net.commands).toHaveLength(1);
          expect(net.commands[0]?.key).toBe(OLD);
          // What the draft held when it was sent: the original after a retry, what the edit saved after its success.
          expect(net.commands[0]?.body).toContain(
            recovery === "the explicit retry"
              ? '"label":"original"'
              : '"label":"saved"',
          );
        }
      });
});

test.describe("E-O9 (revision 27, R47): a record that cannot be read is unknown, not empty, in a real engine", () => {
  for (const reads of ["healthy", "unreadable"] as const)
    for (const prefix of ["retry", "save"] as const)
      test(`R47: B's durable stop outlasts ${reads === "unreadable" ? "unreadable reconciliations" : "healthy ones (the control)"} after the ${prefix} of an unrelated draft and a repeated retry, and ends only with B's own retry`, async ({
        context,
      }, info) => {
        const { page } = await boot(context);
        await context.setOffline(true);
        await arm(page, { id: B, armed: 3 });
        for (let i = 0; i < 3; i += 1)
          expect((await enqueue(page, B, "t", B))?.kind).toBe("refused");
        expect((await streaks(page))[`draft:${B}`]).toBe(3);
        await untilWarning(page, true, false);

        if (reads === "unreadable")
          await page.evaluate(() => window.__atlasData?.failStopReads(20));
        if (prefix === "retry")
          await page.evaluate(() =>
            window.__atlasData?.retryOutbox("unrelated"),
          );
        else expect((await enqueue(page, A, "s", A))?.kind).toBe("queued");
        await page.evaluate(() => window.__atlasData?.retryOutbox("unrelated"));
        if (reads === "unreadable")
          // The reads the reconciliations made have happened (a condition, not a delay): at least three of them failed.
          await expect
            .poll(
              () =>
                page.evaluate(() => window.__atlasData?.stopReadFaultsLeft()),
              { timeout: 20_000 },
            )
            .toBeLessThanOrEqual(17);
        for (let sample = 0; sample < 12; sample += 1) {
          expect((await warning(page))?.notResponding).toBe(true);
          await page.waitForTimeout(50);
        }
        recordEvidence(info, `${reads}-${prefix}`, {
          streaks: await streaks(page),
          warning: await warning(page),
          left: await page.evaluate(() =>
            window.__atlasData?.stopReadFaultsLeft(),
          ),
        });
        expect((await streaks(page))[`draft:${B}`]).toBe(3);

        // The record can be read again, and B is still stopped: the answer is the record's.
        await page.evaluate(() => window.__atlasData?.failStopReads(0));
        await page.evaluate(() => window.__atlasData?.retryOutbox("unrelated"));
        for (let sample = 0; sample < 6; sample += 1) {
          expect((await warning(page))?.notResponding).toBe(true);
          await page.waitForTimeout(50);
        }
        expect((await streaks(page))[`draft:${B}`]).toBe(3);

        await page.evaluate((id) => window.__atlasData?.retryOutbox(id), B);
        await untilWarning(page, false, false);
        expect(await streaks(page)).toEqual({});
        expect(await markers(page)).toEqual([]);
      });
});
