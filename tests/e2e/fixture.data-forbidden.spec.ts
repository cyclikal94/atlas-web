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
