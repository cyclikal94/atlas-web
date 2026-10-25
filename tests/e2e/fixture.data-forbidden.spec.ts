import {
  atlasBody,
  posts,
  rows,
  sourceProjection,
  stubCalendars,
} from "./calendar-13b-helpers";
import {
  deltaPage,
  fresh,
  leaderPage,
  snapshotPage,
} from "./data-leader-helpers";
import { expect, test } from "./helpers";

/**
 * E-F1 (F-13b-1; WEB-13b revision 3, handover `delivery/handoffs/web13b-foundation-403-approved-20261025.md`): an ordinary `403 forbidden`
 * to a queued command, through the PRODUCTION composition in a real engine: the page's session (its stamped wrapper, whose handling of a
 * `403` sets the interim hold and closes the display before the body is classified, `session/kernel/send.ts`), the page data host and
 * its production leader, which stops its dispatcher while the display is closed and starts it again when the ordinary refusal reopens it.
 * The answer is the draft's: it is recorded as a terminal rejection, the command is sent ONCE. Control: a `422` (no hold). Review 1's
 * independent probe of the same journey (seven identical POSTs in 82 ms before the correction) is preserved under its evidence. FIXTURE
 * evidence: the network is stubbed (the released backend's answers are the I-specs').
 */
const SOURCE = "00000000-0000-4000-8000-00000000ca13";

for (const [status, code] of [
  [403, "forbidden"],
  [422, "invalid_value"],
] as const)
  test(`E-F1: a ${status} ${code} to a queued command is sent once and recorded as a rejection`, async ({
    context,
  }) => {
    test.setTimeout(60_000);
    const net = await fresh(context);
    const { kind_date: _kind, ...wire } = sourceProjection(SOURCE);
    net.answer = (call) =>
      call.cursor === null
        ? snapshotPage([{ kind: "upsert", resource: wire }], "delta-0", false)
        : deltaPage([], call.cursor);
    const cal = await stubCalendars(context);
    // Every send of the command is refused the same way (a resend would be answered too, and counted).
    cal.answers.set(
      "/calendar-commands",
      Array.from({ length: 30 }, () => ({ status, body: atlasBody(code) })),
    );
    const page = await leaderPage(context, net, "one", undefined, {
      route: "/settings/calendars",
    });
    await expect(page.locator(`[data-source-row="${SOURCE}"]`)).toBeVisible({
      timeout: 30_000,
    });
    await page.getByRole("button", { name: "Manage Work rota" }).click();
    const dialog = page.getByRole("dialog", { name: "Manage — Work rota" });
    await dialog.getByLabel("Timezone").fill("Europe/Vienna");
    await dialog.getByRole("button", { name: "Save", exact: true }).click();
    const configure = async () =>
      (
        (await rows(page, "drafts")) as Array<{
          kind: string;
          status: string;
          attempts: number;
        }>
      ).find((d) => d.kind === "configure_source");
    // Settled (rejected) or sent again, whichever comes first.
    await expect
      .poll(
        async () =>
          (await configure())?.status === "rejected" ||
          posts(cal, "/calendar-commands").length > 1,
        { timeout: 20_000 },
      )
      .toBe(true);
    // A resend would follow at once (the defect sent one after another): a settled queue sends nothing more.
    await page.waitForTimeout(2_000);
    const sent = posts(cal, "/calendar-commands");
    expect(sent, "a returned domain refusal is sent once").toHaveLength(1);
    expect(await configure()).toMatchObject({
      status: "rejected",
      attempts: 1,
    });
    expect(JSON.parse(sent[0]?.body ?? "")).toEqual({
      command: {
        kind: "configure_source",
        id: SOURCE,
        expected_version: 2,
        enabled: true,
        timezone: "Europe/Vienna",
      },
    });
  });

/**
 * E-F2 (F-13b-1a; WEB-13b revision 4, review 4's native diagnostic made a maintained case): the same journey, with the page's record of the
 * command's answer refused three times by the real engine's store (a `DataError` thrown by `IDBObjectStore.put` for exactly the first three
 * writes of the rejected `configure_source` draft; every other write, the claim and the failure counter included, works). Revision 3 recorded
 * a stopped run's answer when its commit succeeded but dropped a FAILED one with the run the `403`'s interim hold had stopped: four
 * identical sends 25-31 ms apart, no streak. Now each failure is counted against the receipt and paced (250 ms) whatever became of the run,
 * and the third stops the draft: three sends, the durable streak at three, nothing more. Control: a `422` (no hold) behaves the same.
 * FIXTURE evidence: the network is stubbed and the store fault is installed by the test.
 */
for (const [status, code] of [
  [403, "forbidden"],
  [422, "invalid_value"],
] as const)
  test(`E-F2: a ${status} ${code} whose record fails three times is sent three times, paced, and the draft stops`, async ({
    context,
  }, testInfo) => {
    test.setTimeout(60_000);
    const net = await fresh(context);
    const { kind_date: _kind, ...wire } = sourceProjection(SOURCE);
    net.answer = (call) =>
      call.cursor === null
        ? snapshotPage([{ kind: "upsert", resource: wire }], "delta-0", false)
        : deltaPage([], call.cursor);
    const cal = await stubCalendars(context);
    cal.answers.set(
      "/calendar-commands",
      Array.from({ length: 30 }, () => ({ status, body: atlasBody(code) })),
    );
    const page = await leaderPage(context, net, "one", undefined, {
      route: "/settings/calendars",
    });
    await expect(page.locator(`[data-source-row="${SOURCE}"]`)).toBeVisible({
      timeout: 30_000,
    });
    await page.evaluate(() => {
      const fault = { remaining: 3, hits: 0 };
      (window as unknown as { __recordFault: typeof fault }).__recordFault =
        fault;
      const put = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function (
        this: IDBObjectStore,
        ...args: Parameters<IDBObjectStore["put"]>
      ) {
        const value = args[0] as { kind?: string; status?: string } | null;
        if (
          this.name === "drafts" &&
          value?.kind === "configure_source" &&
          value.status === "rejected" &&
          fault.remaining > 0
        ) {
          fault.remaining -= 1;
          fault.hits += 1;
          throw new DOMException("E-F2 record fault", "DataError");
        }
        return put.apply(this, args);
      };
    });
    await page.getByRole("button", { name: "Manage Work rota" }).click();
    const dialog = page.getByRole("dialog", { name: "Manage — Work rota" });
    await dialog.getByLabel("Timezone").fill("Europe/Vienna");
    await dialog.getByRole("button", { name: "Save", exact: true }).click();
    const streak = async () =>
      (
        (await rows(page, "sync_state")) as Array<{
          local_write_streaks?: Record<string, number>;
        }>
      )
        .flatMap((r) => Object.values(r.local_write_streaks ?? {}))
        .reduce((a, b) => Math.max(a, b), 0);
    // Stopped (the streak at its bound) or sent a fourth time, whichever comes first.
    await expect
      .poll(
        async () =>
          (await streak()) >= 3 || posts(cal, "/calendar-commands").length > 3,
        { timeout: 20_000 },
      )
      .toBe(true);
    // A resend would follow at once (the defect sent one after another): a stopped draft sends nothing more.
    await page.waitForTimeout(2_000);
    const sent = posts(cal, "/calendar-commands");
    const fault = await page.evaluate(
      () =>
        (window as unknown as { __recordFault: { hits: number } })
          .__recordFault,
    );
    const intervals = sent.slice(1).map((s, i) => s.at - (sent[i]?.at ?? 0));
    await testInfo.attach("e-f2-observations", {
      body: JSON.stringify({ status, intervals, fault, sent }, null, 2),
      contentType: "application/json",
    });
    expect(fault.hits, "the three faults fired").toBe(3);
    expect(sent, "three sends, the bound").toHaveLength(3);
    expect(new Set(sent.map((s) => s.key)).size).toBe(1);
    expect(new Set(sent.map((s) => s.body)).size).toBe(1);
    expect(await streak()).toBe(3);
    // The page waits 250 ms after each failure before sending again; the times here are the test runner's, taken as each request is
    // routed, so the bound allows for the transport's own jitter (the defect's intervals were 25-31 ms).
    for (const interval of intervals) expect(interval).toBeGreaterThan(200);
    const draft = (
      (await rows(page, "drafts")) as Array<{ kind: string; status: string }>
    ).find((d) => d.kind === "configure_source");
    expect(draft).toMatchObject({ status: "in_flight" });
  });
