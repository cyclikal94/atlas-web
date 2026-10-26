import type { Page } from "@playwright/test";
import { markerKeysOf } from "./data-local-faults";
import {
  ACCOUNT,
  atlasError,
  bootSession,
  seedSettled,
  startOutbox,
  stubNetwork,
} from "./data-sync-helpers";
import { expect, test } from "./helpers";

/**
 * E-F3 and E-F4 (WEB-13b revision 5, review 5's F-13b-1b and F-13b-1c; handover `delivery/handoffs/web13b-foundation-403-approved-20261025.md`):
 * the real engines' ordering of a transaction's COMMIT and the DELIVERY of its result, for the two late results the review found.
 *
 *  - E-F3: a visible full disk (the record of a `422` refused by `QuotaExceededError`), then two overlapping retries: the first one's
 *    resume committed and its delivery held (`holdOutboxPlan`), the second sending the draft again. When that answer's record meets a full
 *    disk again, that NEW hold stands after the first retry's completion is delivered, and nothing more is sent (two `POST`s, `stopped /
 *    storage_full`). Review 5's probe of the same schedule saw a third `POST` and an idle queue. Control: the second record lands; two
 *    `POST`s and idle.
 *  - E-F4: the record of a `422` fails and its failure counter fails too, the counter's REJECTION held; the harness's test leader then gives
 *    the binding up (`stopOutbox`: the ownership aborted, the dispatcher stopped, the account's service left open), and the rejection is
 *    delivered. No fallback marker is left, and the next owner (a new test leader on the same page) sends the draft again under its key.
 *    Control: the binding stands, the marker is recorded and the draft is stopped after one `POST`.
 *
 * FIXTURE evidence: the network is stubbed (`422` isolates the settlement from the session's `403` hold, which E-F1/E-F2 cover through the
 * production leader); the leader is the harness's test leader; the store faults are installed by the test on `IDBObjectStore.put`, each
 * counted and asserted to have fired. A full observation window follows the last delivery.
 */
type Faults = { record: number; counter: number; recordLeft: number };

/** The record of the draft's rejection fails `times` times (`QuotaExceededError` or a plain error); then, when asked, its counter once. */
async function installFaults(
  page: Page,
  options: { times: number; quota: boolean; counter: boolean },
) {
  await page.evaluate(({ times, quota, counter }) => {
    const faults = { record: 0, counter: 0, recordLeft: times };
    let counterArmed = false;
    (
      window as unknown as { __settlementFaults: typeof faults }
    ).__settlementFaults = faults;
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (
      this: IDBObjectStore,
      ...args: Parameters<IDBObjectStore["put"]>
    ) {
      const value = args[0] as {
        status?: string;
        local_write_streaks?: Record<string, number>;
      } | null;
      if (
        this.name === "drafts" &&
        value?.status === "rejected" &&
        faults.recordLeft > 0
      ) {
        faults.recordLeft -= 1;
        faults.record += 1;
        counterArmed = counter;
        throw quota
          ? new DOMException("E-F3 quota fault", "QuotaExceededError")
          : new DOMException("E-F4 record fault", "DataError");
      }
      if (
        counterArmed &&
        this.name === "sync_state" &&
        Object.keys(value?.local_write_streaks ?? {}).some((k) =>
          k.startsWith("receipt:"),
        )
      ) {
        counterArmed = false;
        faults.counter += 1;
        throw new DOMException("E-F4 counter fault", "DataError");
      }
      return put.apply(this, args);
    };
  }, options);
}
const faultsOf = (page: Page): Promise<Faults> =>
  page.evaluate(
    () =>
      (window as unknown as { __settlementFaults: Faults }).__settlementFaults,
  );
const state = (page: Page) =>
  page.evaluate(() => window.__atlasData?.outboxState() ?? null);

async function queued(page: Page): Promise<string> {
  const saved = await page.evaluate(() =>
    window.__atlasData?.enqueue({
      endpoint: "/commands",
      targets: [],
      command: { kind: "settlement-authority" },
    }),
  );
  expect(saved?.kind).toBe("queued");
  return (saved as { localId: string }).localId;
}

for (const again of [true, false])
  test(`E-F3: two overlapping retries after a visible full disk, the first one's completion delivered last: ${again ? "a NEW full disk met by the second answer stands" : "control: the second answer is recorded and the queue is idle"}`, async ({
    context,
  }, testInfo) => {
    test.setTimeout(60_000);
    const net = await stubNetwork(context);
    await seedSettled(context);
    const page = await bootSession(context);
    await startOutbox(page);
    for (let i = 0; i < 5; i += 1)
      net.commandScript.push(() => ({
        status: 422,
        body: atlasError("invalid_value"),
      }));
    await installFaults(page, {
      times: again ? 2 : 1,
      quota: true,
      counter: false,
    });
    const id = await queued(page);
    await expect
      .poll(() => state(page))
      .toMatchObject({
        kind: "stopped",
        cause: "storage_full",
      });
    expect(net.commands).toHaveLength(1);
    await page.evaluate((localId) => {
      window.__atlasData?.holdOutboxPlan("data.resumeDrafts");
      window.__atlasData?.retryOutbox(localId);
    }, id);
    await expect
      .poll(() => page.evaluate(() => window.__atlasData?.outboxPlanHeld()))
      .toBe(true);
    await page.evaluate(
      (localId) => window.__atlasData?.retryOutbox(localId),
      id,
    );
    await expect.poll(() => net.commands.length).toBe(2);
    await expect
      .poll(() => state(page))
      .toMatchObject(
        again ? { kind: "stopped", cause: "storage_full" } : { kind: "idle" },
      );
    expect((await faultsOf(page)).record).toBe(again ? 2 : 1);
    await page.evaluate(() => window.__atlasData?.releaseOutboxPlan());
    await expect
      .poll(() => page.evaluate(() => window.__atlasData?.outboxPlanHeld()))
      .toBe(false);
    // The defect's third send followed the delivery at once: a full observation window, with an `online` signal in it (which ends a
    // back-off and never a hold).
    await page.waitForTimeout(1_000);
    await page.evaluate(() => window.dispatchEvent(new Event("online")));
    await page.waitForTimeout(1_000);
    const observation = {
      again,
      posts: net.commands.map((c) => ({ key: c.key, body: c.body })),
      state: await state(page),
      faults: await faultsOf(page),
    };
    await testInfo.attach("e-f3-observation", {
      body: JSON.stringify(observation, null, 2),
      contentType: "application/json",
    });
    expect(
      net.commands,
      "two sends: the retries saw the first hold only",
    ).toHaveLength(2);
    expect(new Set(net.commands.map((c) => c.key))).toEqual(new Set([id]));
    expect(new Set(net.commands.map((c) => c.body)).size).toBe(1);
    expect(observation.state).toMatchObject(
      again ? { kind: "stopped", cause: "storage_full" } : { kind: "idle" },
    );
  });

for (const ends of [true, false])
  test(`E-F4: a failed record whose counter fails too, the counter's rejection delivered ${ends ? "after the binding ENDED: no marker, and the next owner sends the draft again under its key" : "while the binding stands (control): the marker stops the draft"}`, async ({
    context,
  }, testInfo) => {
    test.setTimeout(60_000);
    const net = await stubNetwork(context);
    await seedSettled(context);
    const page = await bootSession(context);
    await startOutbox(page);
    for (let i = 0; i < 5; i += 1)
      net.commandScript.push(() => ({
        status: 422,
        body: atlasError("invalid_value"),
      }));
    await installFaults(page, { times: 1, quota: false, counter: true });
    await page.evaluate(() =>
      window.__atlasData?.holdOutboxPlan("data.recordLocalWriteOutcome"),
    );
    const id = await queued(page);
    await expect
      .poll(() => page.evaluate(() => window.__atlasData?.outboxPlanHeld()))
      .toBe(true);
    expect(await faultsOf(page)).toMatchObject({ record: 1, counter: 1 });
    expect(net.commands).toHaveLength(1);
    if (ends) await page.evaluate(() => window.__atlasData?.stopOutbox());
    await page.evaluate(() => window.__atlasData?.releaseOutboxPlan());
    await page.waitForTimeout(1_000);
    const marks = await markerKeysOf(page, ACCOUNT, `receipt:${id}`);
    if (ends) {
      expect(marks, "no marker after the binding ended").toEqual([]);
      await startOutbox(page);
      await expect.poll(() => net.commands.length).toBe(2);
    } else {
      expect(marks).toHaveLength(1);
      await expect
        .poll(() => state(page))
        .toEqual({
          kind: "stopped",
          cause: "local_storage",
        });
    }
    await page.waitForTimeout(2_000);
    await testInfo.attach("e-f4-observation", {
      body: JSON.stringify(
        {
          ends,
          marks,
          posts: net.commands.map((c) => ({ key: c.key, body: c.body })),
          state: await state(page),
          faults: await faultsOf(page),
        },
        null,
        2,
      ),
      contentType: "application/json",
    });
    expect(net.commands).toHaveLength(ends ? 2 : 1);
    expect(new Set(net.commands.map((c) => c.key))).toEqual(new Set([id]));
    expect(new Set(net.commands.map((c) => c.body)).size).toBe(1);
  });
