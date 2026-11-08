import type { BrowserContext, Page } from "@playwright/test";
import {
  type CalendarStub,
  posts,
  rows,
  smallTargets,
  stubCalendars,
} from "./calendar-13b-helpers";
import { serveIdentityReads } from "./data-local-faults";
import {
  pageText,
  type SyncStub,
  seedSettled,
  startLeader,
  startOutbox,
  stubNetwork,
  waitForState,
} from "./data-sync-helpers";
import { expect, runAxe, test } from "./helpers";
import {
  type BuiltTask,
  buildTask,
  goOfflineAtBoundary,
  goOnlineAtBoundary,
  serveTaskReads,
} from "./tasks-helpers";

/**
 * E-REV1 to E-REV3 (WEB-13b §4.5; Q22 "resolution of locally available calendar review items"; the wireframe's review panel and state
 * cards): synced anchor reviews on the Calendars screen in a real engine through the PRODUCTION composition, the cache filled by `/sync`
 * pages through the fixture leader and the fixture outbox sending what was queued. FIXTURE evidence (I-REV1 runs against the released
 * backend).
 */
const SOURCE = "00000000-0000-4000-8000-00000000ca31";
const EVENT = "00000000-0000-4000-8000-00000000e031";
const REVIEW = "00000000-0000-4000-8000-00000000d031";
const ROUTE = "/settings/calendars";

const resource = (r: Record<string, unknown>) => ({
  kind: "upsert",
  resource: {
    parent_id: null,
    value: null,
    version: 1,
    can_edit: true,
    archived: false,
    ...r,
  },
});
const source = resource({
  id: SOURCE,
  kind: "calendar_source",
  label: "Family calendar",
  value: {
    health: "healthy",
    last_success: 1_790_000_000,
    coverage_start: null,
    coverage_end: null,
    timezone: "Europe/London",
  },
  version: 2,
});
const event = resource({
  id: EVENT,
  kind: "event",
  parent_id: SOURCE,
  label: "Bin day",
  can_edit: false,
  value: {
    uid: "bin@example",
    original: "2026-11-02",
    title: "Bin day",
    start: { date: "2026-11-02", time: null, timezone: "UTC", instant: null },
    end: null,
    status: "present",
    sequence: 0,
  },
});
const review = (
  task: BuiltTask,
  value: Record<string, unknown>,
  over: Record<string, unknown> = {},
) =>
  resource({
    id: REVIEW,
    kind: "review",
    parent_id: task.occurrenceId,
    label: "Review task",
    value,
    ...over,
  });
const proposedSlot = (date: string, time: string | null) => ({
  key: `anchor:${EVENT}`,
  date,
  intended_time: time,
  timezone: "UTC",
  instant: null,
});

async function reviewsPage(
  context: BrowserContext,
  task: BuiltTask,
  changes: unknown[],
  route = ROUTE,
): Promise<{ page: Page; net: SyncStub; cal: CalendarStub }> {
  const net = await stubNetwork(context);
  await serveIdentityReads(context);
  await serveTaskReads(context);
  const cal = await stubCalendars(context);
  await seedSettled(context);
  const page = await context.newPage();
  await page.goto(`/__session?route=${encodeURIComponent(route)}`);
  await page.waitForFunction(
    () => window.__atlasFixture?.session?.booted !== undefined,
  );
  await page.evaluate(() => window.__atlasFixture?.session?.ready);
  await page.waitForFunction(() => window.__atlasData !== undefined);
  net.script.push(() => ({
    status: 200,
    body: pageText([[...task.upserts, source, event, ...changes]], "cursor-1"),
  }));
  await startLeader(page);
  await waitForState(page, "idle");
  cal.phase = "test";
  return { page, net, cal };
}

const card = (page: Page) => page.locator(`[data-review="${REVIEW}"]`);
async function send(page: Page): Promise<void> {
  await startOutbox(page);
  await page.evaluate(() => window.__atlasData?.retryOutbox());
}
/** One more `/sync` page through the fixture leader (a publication). */
async function publish(
  page: Page,
  net: SyncStub,
  changes: unknown[],
  cursor: string,
) {
  net.script.push(() => ({ status: 200, body: pageText([changes], cursor) }));
  await page.evaluate(
    (a) => window.__atlasData?.startSync(a),
    "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  );
}

test.describe("E-REV1: Acknowledge (queued, observed; case 1)", () => {
  test("offline → queued; online → sent on the review's version, a lost answer resent with the SAME key; published resolved → gone", async ({
    context,
  }) => {
    test.setTimeout(120_000);
    const task = buildTask({
      n: 51,
      title: "Put the bins out",
      slotKey: `anchor:${EVENT}`,
    });
    const { page, net, cal } = await reviewsPage(context, task, [
      review(
        task,
        { reason: "missing", resolved: false, slot: null },
        { version: 3 },
      ),
    ]);
    await expect(card(page)).toContainText(
      "“Put the bins out”: its calendar link is missing",
    );
    await goOfflineAtBoundary(page);
    await card(page).getByRole("button", { name: "Acknowledge" }).click();
    await expect(card(page)).toContainText("Acknowledged — waiting to send");
    expect(posts(cal, "/calendar-commands")).toEqual([]);
    cal.answers.set("/calendar-commands", [{ abort: true }]);
    await goOnlineAtBoundary(page);
    await send(page);
    await expect
      .poll(() => posts(cal, "/calendar-commands").length, { timeout: 60_000 })
      .toBe(2);
    const [first, second] = posts(cal, "/calendar-commands");
    expect(second?.key).toBe(first?.key);
    expect(second?.body).toBe(first?.body);
    expect(JSON.parse(first?.body ?? "")).toEqual({
      command: {
        kind: "resolve_review",
        id: REVIEW,
        expected_version: 3,
        resolved: true,
      },
    });
    await expect(card(page)).toContainText(
      "Acknowledged — will confirm on next sync",
      { timeout: 30_000 },
    );
    await publish(
      page,
      net,
      [
        review(
          task,
          { reason: "missing", resolved: true, slot: null },
          { version: 4 },
        ),
      ],
      "cursor-2",
    );
    await expect(card(page)).toHaveCount(0, { timeout: 30_000 });
  });

  test("the private generic review shows no date, title or task; a review deleted while shown is 'no longer available', both actions disabled", async ({
    context,
  }) => {
    test.setTimeout(90_000);
    const task = buildTask({
      n: 52,
      title: "Put the bins out",
      slotKey: `anchor:${EVENT}`,
    });
    const { page, net } = await reviewsPage(context, task, [
      review(task, {
        reason: "context_unavailable",
        resolved: false,
        slot: null,
      }),
    ]);
    await expect(card(page)).toContainText(
      "The schedule may have changed — check the source directly.",
    );
    const text = (await card(page).textContent()) ?? "";
    expect(text).not.toContain("Put the bins out");
    expect(text).not.toContain("Bin day");
    expect(text).not.toContain("Family calendar");
    expect(text).not.toMatch(/\d{4}/);
    await publish(page, net, [{ kind: "remove", id: REVIEW }], "cursor-2");
    await expect(card(page)).toHaveAttribute("data-review-state", "gone", {
      timeout: 30_000,
    });
    await expect(card(page)).toContainText(
      "This review is no longer available to you.",
    );
    for (const button of await card(page).getByRole("button").all())
      await expect(button).toBeDisabled();
  });
});

test.describe("E-REV2: Review this move… (the seeded correction)", () => {
  test("work_started: opens the day's correction with the proposed date and time; saving queues revise_occurrence and the review stays until acknowledged", async ({
    context,
  }) => {
    test.setTimeout(90_000);
    const task = buildTask({
      n: 53,
      title: "Put the bins out",
      slotKey: `anchor:${EVENT}`,
    });
    const { page } = await reviewsPage(context, task, [
      review(task, {
        reason: "work_started",
        resolved: false,
        slot: proposedSlot("2026-11-03", "18:30:00"),
      }),
    ]);
    await expect(card(page)).toContainText(
      "Started work exists on the current occurrence",
    );
    await card(page).getByRole("link", { name: "Review this move…" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible({ timeout: 20_000 });
    await expect(dialog).toContainText("This came from a calendar review.");
    await expect(dialog.getByLabel("The date it counts for")).toHaveValue(
      "2026-11-03",
    );
    await expect(dialog.getByLabel("Time of day")).toHaveValue("18:30");
    await expect
      .poll(() => new URL(page.url()).searchParams.get("move"))
      .toBeNull();
    await dialog.getByRole("button", { name: "Save" }).click();
    await expect
      .poll(async () =>
        ((await rows(page, "drafts")) as Array<{ kind: string }>).map(
          (d) => d.kind,
        ),
      )
      .toEqual(["revise_occurrence"]);
    // The review is not resolved by the correction: it is still there to acknowledge.
    await page.goBack();
    await expect(card(page)).toBeVisible({ timeout: 20_000 });
    await expect(card(page)).toHaveAttribute("data-review-state", "open");
  });
});

test.describe("E-REV3: two tabs", () => {
  test("tab A acknowledges; tab B's card shows the waiting acknowledgement (the data hint) and offers no second one", async ({
    context,
  }) => {
    test.setTimeout(120_000);
    const task = buildTask({
      n: 54,
      title: "Put the bins out",
      slotKey: `anchor:${EVENT}`,
    });
    const { page: a } = await reviewsPage(context, task, [
      review(task, { reason: "missing", resolved: false, slot: null }),
    ]);
    const b = await context.newPage();
    await b.goto(`/__session?route=${encodeURIComponent(ROUTE)}`);
    await b.waitForFunction(() => window.__atlasData !== undefined);
    await expect(card(b)).toBeVisible({ timeout: 30_000 });
    await goOfflineAtBoundary(a);
    await card(a).getByRole("button", { name: "Acknowledge" }).click();
    await expect(card(a)).toContainText("Acknowledged — waiting to send");
    await expect(card(b)).toContainText("Acknowledged — waiting to send", {
      timeout: 20_000,
    });
    await expect(
      card(b).getByRole("button", { name: "Acknowledge" }),
    ).toHaveCount(0);
  });
});

for (const scheme of ["dark", "light"] as const)
  test.describe(`E-REV: layout and axe (${scheme})`, () => {
    test.use({ colorScheme: scheme });
    test("the review panel at phone and desktop widths: axe with contrast, 44 px targets, no horizontal scroll", async ({
      context,
    }) => {
      test.setTimeout(90_000);
      const task = buildTask({
        n: 55,
        title: "Put the bins out",
        slotKey: `anchor:${EVENT}`,
      });
      const { page } = await reviewsPage(context, task, [
        review(task, {
          reason: "work_started",
          resolved: false,
          slot: proposedSlot("2026-11-03", null),
        }),
      ]);
      for (const size of [
        { width: 320, height: 1200 },
        { width: 390, height: 1200 },
        { width: 1280, height: 900 },
      ]) {
        await page.setViewportSize(size);
        await expect(card(page)).toBeVisible();
        const violations = await runAxe(page);
        expect(
          violations.map((v) => [v.id, v.nodes.map((n) => n.target)]),
          `${size.width}`,
        ).toEqual([]);
        expect(await smallTargets(page), `${size.width}`).toEqual([]);
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth - window.innerWidth,
          ),
          `${size.width}`,
        ).toBeLessThanOrEqual(0);
      }
    });
  });

test.describe("revision 23 (review 27 F27-1): leaving a bounded page is not leaving the cache", () => {
  test("an earlier review moves the 100th shown review to page two: page one claims nothing of it; a shown review deleted is 'no longer available'; the moved one comes back open", async ({
    context,
  }) => {
    test.setTimeout(120_000);
    const task = buildTask({
      n: 57,
      title: "Put the bins out",
      slotKey: `anchor:${EVENT}`,
    });
    const rid = (n: number) =>
      `00000000-0000-4000-8000-0000000d${String(n).padStart(4, "0")}`;
    const generic = (n: number) =>
      resource({
        id: rid(n),
        kind: "review",
        parent_id: task.occurrenceId,
        label: "Review task",
        value: { reason: "context_unavailable", resolved: false, slot: null },
      });
    const { page, net } = await reviewsPage(
      context,
      task,
      Array.from({ length: 100 }, (_, i) => generic(1000 + i)),
    );
    const at = (n: number) => page.locator(`[data-review="${rid(n)}"]`);
    const all = page.locator("[data-review]");
    const gone = page.locator('[data-review-state="gone"]');
    await expect(all).toHaveCount(20, { timeout: 30_000 });
    for (let n = 0; n < 4; n += 1)
      await page.getByRole("button", { name: "Show more reviews" }).click();
    await expect(all).toHaveCount(100);
    await expect(at(1099)).toHaveAttribute("data-review-state", "open");
    // A sync page publishes a review whose id sorts first: the 100th moves to page two, unchanged in the cache.
    await publish(page, net, [generic(999)], "cursor-2");
    await expect(at(999)).toHaveAttribute("data-review-state", "open", {
      timeout: 30_000,
    });
    await expect(at(1099)).toHaveCount(0);
    await expect(gone).toHaveCount(0);
    expect(
      ((await rows(page, "cache")) as Array<{ id: string }>).some(
        (row) => row.id === rid(1099),
      ),
    ).toBe(true);
    // A shown review really deleted: said to be gone; and the moved one is back on page one, open.
    await publish(page, net, [{ kind: "remove", id: rid(1098) }], "cursor-3");
    await expect(at(1098)).toHaveAttribute("data-review-state", "gone", {
      timeout: 30_000,
    });
    await expect(at(1098)).toContainText(
      "This review is no longer available to you.",
    );
    await expect(
      at(1098).getByRole("button", { name: "Acknowledge" }),
    ).toBeDisabled();
    await expect(at(1099)).toHaveAttribute("data-review-state", "open");
    await expect(
      at(1099).getByRole("button", { name: "Acknowledge" }),
    ).toBeEnabled();
    await expect(gone).toHaveCount(1);
    await expect(all).toHaveCount(101);
  });
});

test.describe("revision 24 (review 28 F28-1): a published resolution retires the review from every page that showed it", () => {
  test("a review shown on page one and again on page two is published resolved there, then deleted: page one says nothing of it; a review deleted unresolved in the same sync page is 'no longer available'", async ({
    context,
  }) => {
    test.setTimeout(120_000);
    const task = buildTask({
      n: 58,
      title: "Put the bins out",
      slotKey: `anchor:${EVENT}`,
    });
    const rid = (n: number) =>
      `00000000-0000-4000-8000-0000000d${String(n).padStart(4, "0")}`;
    const generic = (n: number, resolved = false, version = 1) =>
      resource({
        id: rid(n),
        kind: "review",
        parent_id: task.occurrenceId,
        label: "Review task",
        version,
        value: { reason: "context_unavailable", resolved, slot: null },
      });
    const { page, net } = await reviewsPage(
      context,
      task,
      Array.from({ length: 100 }, (_, i) => generic(1000 + i)),
    );
    const at = (n: number) => page.locator(`[data-review="${rid(n)}"]`);
    const all = page.locator("[data-review]");
    const gone = page.locator('[data-review-state="gone"]');
    const cached = async (n: number) =>
      (
        (await rows(page, "cache")) as Array<{
          id: string;
          version: number;
          value: { resolved?: boolean } | null;
        }>
      ).find((row) => row.id === rid(n));
    await expect(all).toHaveCount(20, { timeout: 30_000 });
    for (let n = 0; n < 4; n += 1)
      await page.getByRole("button", { name: "Show more reviews" }).click();
    await expect(all).toHaveCount(100);
    await expect(at(1099)).toHaveAttribute("data-review-state", "open");
    // An earlier review moves the 100th to page two, where it is shown too: two pages showed it.
    await publish(page, net, [generic(999)], "cursor-2");
    await expect(at(999)).toHaveAttribute("data-review-state", "open", {
      timeout: 30_000,
    });
    await expect(at(1099)).toHaveCount(0);
    await page.getByRole("button", { name: "Show more reviews" }).click();
    await expect(at(1099)).toHaveAttribute("data-review-state", "open");
    await expect(all).toHaveCount(1);
    // Published resolved (version 2) while page two is shown: its card goes.
    await publish(page, net, [generic(1099, true, 2)], "cursor-3");
    await expect(at(1099)).toHaveCount(0, { timeout: 30_000 });
    expect(await cached(1099)).toMatchObject({
      version: 2,
      value: { resolved: true },
    });
    // One sync page deletes it and 1000 (shown on page one, never resolved).
    await publish(
      page,
      net,
      [
        { kind: "remove", id: rid(1099) },
        { kind: "remove", id: rid(1000) },
      ],
      "cursor-4",
    );
    await expect
      .poll(async () => (await cached(1099)) === undefined, { timeout: 30_000 })
      .toBe(true);
    expect(await cached(1000)).toBeUndefined();
    await expect(gone).toHaveCount(0);
    await page.getByRole("button", { name: "Show previous reviews" }).click();
    // Page one: 1000 is said to be gone (the control); 1099, seen resolved on page two, is not.
    await expect(at(1000)).toHaveAttribute("data-review-state", "gone", {
      timeout: 30_000,
    });
    await expect(at(1000)).toContainText(
      "This review is no longer available to you.",
    );
    await expect(gone).toHaveCount(1);
    await expect(at(1099)).toHaveCount(0);
    await expect(all).toHaveCount(100);
  });
});
