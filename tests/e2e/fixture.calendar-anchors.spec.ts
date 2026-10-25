import type { BrowserContext, Page } from "@playwright/test";
import {
  atlasBody,
  type CalendarStub,
  pathKey,
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
 * E-ANC1 to E-ANC3 (WEB-13b §4.3/§4.4; cases 1 and 3; Q22 "other calendar commands"): task anchors in a real engine through the PRODUCTION
 * composition, the cache filled by one `/sync` page through the fixture leader (as the WEB-10a specs do), the network stubbed and the
 * fixture outbox sending what was queued. FIXTURE evidence (I-ANC1/I-ANC2 run the journeys against the released backend).
 */
const SOURCE = "00000000-0000-4000-8000-00000000ca21";
const EVENT = "00000000-0000-4000-8000-00000000e021";
const ANCHOR = {
  reference: { kind: "event_series", source_id: SOURCE, uid: "bin@example" },
  offset: { kind: "calendar_days", days: -1, time: "18:00:00" },
  weekdays: [],
};
const source = {
  kind: "upsert",
  resource: {
    id: SOURCE,
    kind: "calendar_source",
    parent_id: null,
    label: "Family calendar",
    value: {
      health: "healthy",
      last_success: 1_790_000_000,
      coverage_start: null,
      coverage_end: null,
      timezone: "Europe/London",
    },
    version: 2,
    can_edit: true,
    archived: false,
  },
};
const event = (timed: boolean) => ({
  kind: "upsert",
  resource: {
    id: EVENT,
    kind: "event",
    parent_id: SOURCE,
    label: "Bin day",
    value: {
      uid: "bin@example",
      original: "2026-11-02",
      title: "Bin day",
      start: timed
        ? {
            date: "2026-11-02",
            time: "07:00:00",
            timezone: "Europe/London",
            instant: 1793602800,
          }
        : {
            date: "2026-11-02",
            time: null,
            timezone: "Europe/London",
            instant: null,
          },
      end: null,
      status: "present",
      sequence: 0,
    },
    version: 1,
    can_edit: false,
    archived: false,
  },
});

async function taskPage(
  context: BrowserContext,
  route: string,
  tasks: BuiltTask[],
  extra: unknown[] = [source, event(true)],
  arm: (cal: CalendarStub) => void = () => undefined,
): Promise<{ page: Page; net: SyncStub; cal: CalendarStub }> {
  const net = await stubNetwork(context);
  await serveIdentityReads(context);
  await serveTaskReads(context);
  // Registered after the task reads: the binding read and the calendar commands are this stub's.
  const cal = await stubCalendars(context);
  arm(cal);
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
    body: pageText(
      [[...tasks.flatMap((t) => t.upserts), ...extra]],
      "cursor-1",
    ),
  }));
  await startLeader(page);
  await waitForState(page, "idle");
  cal.phase = "test";
  return { page, net, cal };
}

/** Leaves the task's screen and comes back (a new visit), as an in-app navigation does. */
async function revisit(page: Page, taskId: string): Promise<void> {
  await page.evaluate(() => {
    history.pushState(null, "", "/tasks");
    dispatchEvent(new PopStateEvent("popstate"));
  });
  await expect(page.locator("[data-task-detail]")).toHaveCount(0);
  await page.evaluate((to) => {
    history.pushState(null, "", to);
    dispatchEvent(new PopStateEvent("popstate"));
  }, `/tasks/${taskId}`);
  await expect(page.locator("[data-task-detail]")).toBeVisible();
}

async function send(page: Page): Promise<void> {
  await startOutbox(page);
  await page.evaluate(() => window.__atlasData?.retryOutbox());
}

const anchorReads = (cal: CalendarStub) =>
  cal.wire.filter(
    (w) => w.method === "GET" && pathKey(w.path) === "/tasks/*/anchor",
  );
const section = (page: Page) => page.locator("[data-anchor-section]");

async function chooseEvent(page: Page) {
  const dialog = page.getByRole("dialog", { name: "Anchor to a calendar" });
  await dialog.getByRole("button", { name: "Change event…" }).click();
  await dialog.locator('[data-event-uid="bin@example"]').click();
  await expect(dialog.locator("[data-anchor-picker]")).toHaveCount(0);
  return dialog;
}

test.describe("E-ANC1: a new task anchored to a calendar event", () => {
  test("offline: the create carries the anchor and no first occurrence; Repeats hides, keeps and omits it", async ({
    context,
  }) => {
    test.setTimeout(90_000);
    const { page, net } = await taskPage(context, "/tasks/new", []);
    await page
      .getByRole("button", { name: "Start from scratch instead" })
      .click();
    // The defaults snapshot is read online (the form uses it), so the offline create captures it rather than waiting for review (E-T3).
    await expect(
      page.getByRole("radio", { name: "Use my defaults (only you)" }),
    ).toBeVisible();
    await goOfflineAtBoundary(page);
    await page.getByLabel("Name").fill("Put the bins out");
    await page.getByLabel("Repeats").selectOption("none");
    const anchorPart = page.locator("[data-task-form-anchor]");
    await anchorPart.getByRole("button", { name: "Anchor…" }).click();
    const dialog = await chooseEvent(page);
    await dialog.getByLabel("Days before (−) or after (+)").fill("-1");
    await dialog.getByLabel("Time (optional)").fill("18:00");
    await dialog.getByRole("button", { name: "Save anchor" }).click();
    await expect(dialog).toBeHidden();
    await expect(anchorPart).toContainText(
      "Family calendar · Bin day · 1 day before at 18:00",
    );
    // Repeats hides the section and keeps the anchor; it comes back with it.
    await page.getByLabel("Repeats").selectOption("weekly");
    await expect(anchorPart).toHaveCount(0);
    await page.getByLabel("Repeats").selectOption("none");
    await expect(anchorPart).toContainText("Bin day");
    expect(await rows(page, "drafts")).toEqual([]);
    await page.getByRole("radio", { name: "Only me" }).check();
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect.poll(async () => (await rows(page, "drafts")).length).toBe(1);
    const [draft] = (await rows(page, "drafts")) as Array<{
      target_resource_ids: string[];
      local_id: string;
    }>;
    expect(draft?.target_resource_ids).toHaveLength(2);
    await goOnlineAtBoundary(page);
    await send(page);
    await expect.poll(() => net.commands.length, { timeout: 30_000 }).toBe(1);
    const sent = JSON.parse(net.commands[0]?.body ?? "{}") as {
      command: Record<string, unknown>;
    };
    expect(net.commands[0]?.key).toBe(draft?.local_id);
    expect(sent.command.kind).toBe("create_task");
    expect(sent.command.anchor).toEqual(ANCHOR);
  });

  test("a repeating task is saved without the anchor and without a warning", async ({
    context,
  }) => {
    test.setTimeout(90_000);
    const { page } = await taskPage(context, "/tasks/new", []);
    await page
      .getByRole("button", { name: "Start from scratch instead" })
      .click();
    // The defaults snapshot is read online (the form uses it), so the offline create captures it rather than waiting for review (E-T3).
    await expect(
      page.getByRole("radio", { name: "Use my defaults (only you)" }),
    ).toBeVisible();
    await goOfflineAtBoundary(page);
    await page.getByLabel("Name").fill("Weekly bins");
    await page.getByLabel("Repeats").selectOption("none");
    await page
      .locator("[data-task-form-anchor]")
      .getByRole("button", { name: "Anchor…" })
      .click();
    const dialog = await chooseEvent(page);
    await dialog.getByRole("button", { name: "Save anchor" }).click();
    await page.getByLabel("Repeats").selectOption("weekly");
    await page.getByRole("radio", { name: "Only me" }).check();
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect
      .poll(async () => (await rows(page, "draft_commands")).length)
      .toBe(1);
    const [body] = (await rows(page, "draft_commands")) as Array<{
      command: { command: Record<string, unknown> };
    }>;
    expect("anchor" in (body?.command.command ?? {})).toBe(false);
    await expect(page.getByText(/anchor/i)).toHaveCount(0);
  });
});

test.describe("E-ANC2: the binding read (case 3)", () => {
  test("online: read once and shown; offline: 'Binding details need a connection.' and the task's day is still shown", async ({
    context,
  }) => {
    test.setTimeout(90_000);
    const a = buildTask({ n: 41, title: "Put the bins out" });
    const { page, cal } = await taskPage(
      context,
      `/tasks/${a.taskId}`,
      [a],
      [source, event(true)],
      (c) => {
        c.binding = { binding: { anchor: ANCHOR, version: 2, active: true } };
      },
    );
    await expect(section(page)).toContainText(
      "Anchored to Family calendar · a calendar event · 1 day before at 18:00",
      { timeout: 20_000 },
    );
    const reads = anchorReads(cal).length;
    expect(reads).toBeGreaterThanOrEqual(1);
    // Leaving and coming back while offline: a new visit, and offline it reads nothing.
    await goOfflineAtBoundary(page);
    await revisit(page, a.taskId);
    await expect(section(page)).toHaveAttribute(
      "data-anchor-section",
      "offline",
    );
    await expect(section(page)).toContainText(
      "Binding details need a connection.",
    );
    await expect(page.locator("[data-detail-day]")).toBeVisible();
    expect(anchorReads(cal)).toHaveLength(reads);
  });

  test("a 403 on the read (the session re-checks and remounts the tree) is read once: the remounted section asks nothing more", async ({
    context,
  }) => {
    test.setTimeout(90_000);
    const a = buildTask({ n: 42, title: "Put the bins out" });
    const { page, cal } = await taskPage(
      context,
      `/tasks/${a.taskId}`,
      [a],
      [source],
      (c) => {
        c.answers.set("/tasks/*/anchor", [
          { status: 403, body: atlasBody("forbidden") },
          { status: 403, body: atlasBody("forbidden") },
        ]);
      },
    );
    await expect(section(page)).toHaveAttribute(
      "data-anchor-section",
      "failed",
      {
        timeout: 20_000,
      },
    );
    await page.waitForTimeout(4_000);
    expect(anchorReads(cal)).toHaveLength(1);
    await expect(section(page)).toContainText("Couldn't load the anchor");
  });
});

test.describe("E-ANC3: set_anchor (queued; case 1)", () => {
  test("queued offline on the task's version; sent online; a lost answer is resent with the SAME key and body; Remove sends anchor: null", async ({
    context,
  }) => {
    test.setTimeout(120_000);
    const a = buildTask({ n: 43, title: "Put the bins out" });
    const { page, cal } = await taskPage(context, `/tasks/${a.taskId}`, [a]);
    await goOfflineAtBoundary(page);
    await revisit(page, a.taskId);
    await expect(section(page)).toHaveAttribute(
      "data-anchor-section",
      "offline",
    );
    await section(page).getByRole("button", { name: "Anchor…" }).click();
    const dialog = await chooseEvent(page);
    await dialog.getByLabel("Days before (−) or after (+)").fill("-1");
    await dialog.getByLabel("Time (optional)").fill("18:00");
    await dialog.getByRole("button", { name: "Save anchor" }).click();
    await expect(dialog).toBeHidden();
    await expect(section(page)).toContainText("Anchor change waiting to send");
    cal.answers.set("/calendar-commands", [{ abort: true }]);
    // What the server shows once the change has committed (the stub's binding answer): read when the page comes online and again,
    // once, after the receipt.
    cal.binding = { binding: { anchor: ANCHOR, version: 1, active: true } };
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
        kind: "set_anchor",
        id: a.taskId,
        expected_version: 1,
        anchor: ANCHOR,
      },
    });
    await expect(section(page)).toContainText(
      "Saving — will confirm on next sync",
    );
    await expect(section(page)).toContainText("Anchored to", {
      timeout: 20_000,
    });
    // Remove: queued against the version the outbox assumes after the receipted change.
    await section(page)
      .getByRole("button", { name: /Anchor…|Change anchor…/ })
      .click();
    const again = page.getByRole("dialog", { name: "Anchor to a calendar" });
    await again.getByRole("button", { name: "Remove anchor" }).click();
    await expect(again).toBeHidden();
    await send(page);
    await expect
      .poll(() => posts(cal, "/calendar-commands").length, { timeout: 30_000 })
      .toBe(3);
    expect(
      JSON.parse(posts(cal, "/calendar-commands")[2]?.body ?? ""),
    ).toMatchObject({
      command: { kind: "set_anchor", id: a.taskId, anchor: null },
    });
  });

  test("409 conflict: 'This task changed elsewhere'; Review shows the change and Save supersedes it on the current version; a refused change says why", async ({
    context,
  }) => {
    test.setTimeout(120_000);
    const a = buildTask({ n: 44, title: "Put the bins out" });
    const { page, cal } = await taskPage(context, `/tasks/${a.taskId}`, [a]);
    await goOfflineAtBoundary(page);
    await revisit(page, a.taskId);
    await section(page).getByRole("button", { name: "Anchor…" }).click();
    const dialog = await chooseEvent(page);
    await dialog.getByRole("button", { name: "Save anchor" }).click();
    cal.answers.set("/calendar-commands", [
      { status: 409, body: atlasBody("conflict") },
      { status: 422, body: atlasBody("invalid_value") },
    ]);
    await goOnlineAtBoundary(page);
    await send(page);
    await expect(section(page).locator("[data-anchor-conflict]")).toContainText(
      "This task changed elsewhere — check the anchor before saving again.",
      { timeout: 30_000 },
    );
    await section(page).getByRole("button", { name: "Review" }).click();
    const review = page.getByRole("dialog", { name: "Anchor to a calendar" });
    await expect(review.getByLabel("Days before (−) or after (+)")).toHaveValue(
      "0",
    );
    await review.getByRole("button", { name: "Save anchor" }).click();
    await expect(review).toBeHidden();
    await send(page);
    await expect(section(page).locator("[data-anchor-rejected]")).toContainText(
      "Couldn't anchor this task",
      { timeout: 30_000 },
    );
    const statuses = (
      (await rows(page, "drafts")) as Array<{ kind: string; status: string }>
    )
      .filter((d) => d.kind === "set_anchor")
      .map((d) => d.status);
    expect(statuses).toEqual(["rejected"]);
    expect(posts(cal, "/calendar-commands")).toHaveLength(2);
  });

  test("the panel: axe with contrast, 44 px targets and no horizontal scroll at phone and desktop widths; seconds need a timed event", async ({
    context,
  }) => {
    test.setTimeout(120_000);
    const a = buildTask({ n: 45, title: "Put the bins out" });
    const { page } = await taskPage(
      context,
      `/tasks/${a.taskId}`,
      [a],
      [source, event(false)],
    );
    for (const size of [
      { width: 320, height: 1200 },
      { width: 1280, height: 900 },
    ]) {
      await page.setViewportSize(size);
      await section(page)
        .getByRole("button", { name: /Anchor…|Change anchor…/ })
        .click();
      const dialog = await chooseEvent(page);
      await expect(
        dialog.getByRole("radio", { name: /seconds before\/after/ }),
      ).toBeDisabled();
      const violations = await runAxe(page);
      expect(
        violations.map((v) => [v.id, v.nodes.map((n) => n.target)]),
        `${size.width}`,
      ).toEqual([]);
      expect(
        await smallTargets(page, '[role="dialog"]'),
        `${size.width}`,
      ).toEqual([]);
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth - window.innerWidth,
        ),
      ).toBeLessThanOrEqual(0);
      await page.keyboard.press("Escape");
      await expect(dialog).toBeHidden();
    }
  });
});
