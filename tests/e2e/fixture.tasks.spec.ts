import { type BrowserContext, expect, type Page, test } from "@playwright/test";
import { recordEvidence } from "./data-evidence";
import { serveIdentityReads } from "./data-local-faults";
import {
  ACCOUNT,
  pageText,
  type SyncStub,
  seedSettled,
  startOutbox,
  stubNetwork,
} from "./data-sync-helpers";
import { runAxe } from "./helpers";
import {
  type BuiltTask,
  bodiesOf,
  buildTask,
  cacheTasks,
  dailyPage,
  draftsOf,
  goOfflineAtBoundary,
  goOnlineAtBoundary,
  occurrenceIdOf,
  progressIdOf,
  serveTaskReads,
  type TaskReads,
  todayUtc,
  view,
} from "./tasks-helpers";

/**
 * WEB-10a in Chromium, Firefox and WebKit: the PRODUCTION session and protected tree (`/__session`), the production data controller and REAL
 * IndexedDB; the cache is filled by one `/sync` delta page through the fixture leader and drafts are sent by the fixture outbox. The task
 * reads (`/daily`, `/task-presets`) are answered by `page.route`. FIXTURE evidence: an answer the stub gives is the stub's (the I-T cases run
 * against the released backend).
 *
 * E-T1 Today from /daily and from the cache, axe at five viewports; E-T2 Mark done offline, then sent; E-T3 create offline and an immediate
 * Mark done; E-T4 presets; E-T5 closure and exclusion; E-T6 archive offline leaves the day; E-T7 correction; E-T8 keyboard; E-T9 a real
 * window boundary; E-T11 a 403 read once across remounts; E-T12 display-zone change and the gap explainer.
 */
const TODAY = todayUtc();
const todayRoute = (zone = "UTC", day = TODAY) =>
  `/today?day=${day}&tz=${encodeURIComponent(zone)}`;
const rowOf = (page: Page, id: string) =>
  page.locator(`[data-today-row="${id}"]`);

async function bootAt(
  context: BrowserContext,
  route: string,
  look: {
    viewport?: { width: number; height: number };
    colorScheme?: "light" | "dark";
  } = {},
): Promise<Page> {
  const page = await context.newPage();
  // Set before the page loads, so nothing is measured mid-way through a theme transition.
  if (look.viewport) await page.setViewportSize(look.viewport);
  if (look.colorScheme)
    await page.emulateMedia({ colorScheme: look.colorScheme });
  await page.goto(`/__session?route=${encodeURIComponent(route)}`);
  await page.waitForFunction(
    () => window.__atlasFixture?.session?.booted !== undefined,
  );
  await page.evaluate(() => window.__atlasFixture?.session?.ready);
  await page.waitForFunction(() => window.__atlasData !== undefined);
  return page;
}

async function navigateInApp(page: Page, path: string): Promise<void> {
  await page.evaluate((to) => {
    history.pushState(null, "", to);
    dispatchEvent(new PopStateEvent("popstate"));
  }, path);
}

async function setup(
  context: BrowserContext,
  route: string,
  tasks: BuiltTask[],
  arrange: (reads: TaskReads) => void = () => undefined,
  look: Parameters<typeof bootAt>[2] = {},
): Promise<{ page: Page; net: SyncStub; reads: TaskReads }> {
  const net = await stubNetwork(context);
  await serveIdentityReads(context);
  const reads = await serveTaskReads(context);
  arrange(reads);
  await seedSettled(context);
  const page = await bootAt(context, route, look);
  // Always one sync page through the fixture leader: it creates the account's database as a first sync does (there is no production
  // leader here), so a save has somewhere to go even when no task is cached.
  await cacheTasks(page, net, tasks);
  return { page, net, reads };
}

/** The send of the queued drafts by the fixture outbox (a save in the tree only posts a hint; the fixture leader is woken explicitly). */
async function send(page: Page): Promise<void> {
  await startOutbox(page);
  await page.evaluate(() => window.__atlasData?.retryOutbox());
}

test.describe("E-T1: Today from /daily and from the cache (A1, A2, A19)", () => {
  test("online: both scopes, the server's results; offline: the same day from the cache, provisional", async ({
    context,
  }, info) => {
    const a = buildTask({ n: 1, title: "Brush your teeth" });
    const b = buildTask({ n: 2, title: "Water the plants" });
    const { page, reads } = await setup(context, todayRoute(), [a, b], (r) => {
      r.respond = (q) =>
        dailyPage(
          [
            view(a, {
              outcome: "complete",
              period_outcome: "complete",
              actionable: false,
            }),
            view(b),
          ],
          q.scope === "joint" ? { pending_tasks: [a.taskId] } : {},
        );
    });
    await expect(rowOf(page, a.occurrenceId)).toHaveAttribute(
      "data-source",
      "server",
    );
    await expect(rowOf(page, a.occurrenceId)).toHaveAttribute(
      "data-pill",
      "done",
    );
    await expect(rowOf(page, b.occurrenceId)).toHaveAttribute(
      "data-pill",
      "to_do",
    );
    await expect(page.locator("[data-today-summary]")).toHaveText(
      "1 of 2 done · 1 still to do",
    );
    await expect(page.locator("[data-pending-tasks]")).toBeVisible();
    expect(new Set(reads.daily.map((q) => q.scope))).toEqual(
      new Set(["joint", "personal"]),
    );
    // Offline, a remounted Today has no server answer: the same day is derived from the cache.
    await goOfflineAtBoundary(page);
    await navigateInApp(page, "/tasks");
    await navigateInApp(page, todayRoute());
    await expect(rowOf(page, b.occurrenceId)).toHaveAttribute(
      "data-source",
      "local",
    );
    await expect(rowOf(page, b.occurrenceId)).toHaveAttribute(
      "data-pill",
      "to_do",
    );
    recordEvidence(info, "e-t1", { daily: reads.daily });
  });

  for (const [width, height] of [
    [390, 844],
    [834, 1112],
    [1112, 834],
    [1180, 820],
    [1440, 900],
  ] as const)
    for (const scheme of ["light", "dark"] as const)
      test(`axe and layout at ${width}×${height}, ${scheme} (browser emulation, not a device)`, async ({
        context,
      }) => {
        const a = buildTask({ n: 3, title: "Brush your teeth" });
        const { page } = await setup(
          context,
          todayRoute(),
          [a],
          (r) => {
            r.respond = () => dailyPage([view(a)]);
          },
          { viewport: { width, height }, colorScheme: scheme },
        );
        await expect(rowOf(page, a.occurrenceId)).toBeVisible();
        expect(await runAxe(page)).toEqual([]);
        const overflow = await page.evaluate(
          () =>
            document.documentElement.scrollWidth -
            document.documentElement.clientWidth,
        );
        expect(overflow).toBeLessThanOrEqual(0);
      });
});

test.describe("E-T2: Mark done offline, then sent (A7, A8)", () => {
  test("a queued draft with the wrapped kind, 'Not sent yet'; online the body carries expected_version and happened_at ≤ the act; the sync page makes it Done", async ({
    context,
  }, info) => {
    const a = buildTask({ n: 4, title: "Brush your teeth" });
    const { page, net } = await setup(context, todayRoute(), [a]);
    await goOfflineAtBoundary(page);
    await expect(rowOf(page, a.occurrenceId)).toBeVisible();
    const before = Math.floor(Date.now() / 1000);
    await rowOf(page, a.occurrenceId)
      .getByRole("button", { name: "Mark done" })
      .click();
    await expect(
      rowOf(page, a.occurrenceId).locator("[data-pending-mark]"),
    ).toHaveText("Not sent yet");
    const after = Math.floor(Date.now() / 1000);
    const drafts = await draftsOf(page);
    expect(drafts.map((d) => [d.kind, d.status])).toEqual([
      ["record", "queued"],
    ]);
    await goOnlineAtBoundary(page);
    await send(page);
    await expect.poll(() => net.commands.length).toBe(1);
    const sent = net.commands[0];
    expect(sent?.path).toBe("/task-commands");
    expect(sent?.key).toBe(drafts[0]?.local_id);
    const body = JSON.parse(sent?.body ?? "{}") as {
      command: Record<string, unknown>;
    };
    expect(body.command).toMatchObject({
      kind: "record",
      occurrence_id: a.occurrenceId,
      subject_account_id: ACCOUNT,
      expected_version: 1,
      evidence: { kind: "checkbox", complete: true },
    });
    expect(body.command.happened_at as number).toBeGreaterThanOrEqual(before);
    expect(body.command.happened_at as number).toBeLessThanOrEqual(after);
    const done = { outcome: "complete", amount: null, checked: [] };
    net.script.push(() => ({
      status: 200,
      body: pageText(
        [
          [
            {
              kind: "upsert",
              resource: {
                id: a.progressId,
                kind: "progress",
                parent_id: a.occurrenceId,
                label: "Progress",
                value: {
                  subject_account_id: ACCOUNT,
                  recent_entries: [],
                  entry_count: 1,
                  excluded: false,
                  action: done,
                  period: done,
                  aggregate_consent: true,
                },
                version: 2,
                can_edit: true,
                archived: false,
                policy_version: 1,
              },
            },
          ],
        ],
        "cursor-2",
      ),
    }));
    await page.evaluate(() => window.__atlasData?.nudgeSync());
    await expect(rowOf(page, a.occurrenceId)).toHaveAttribute(
      "data-pill",
      "done",
    );
    await expect(
      rowOf(page, a.occurrenceId).locator("[data-pending-mark]"),
    ).toHaveCount(0);
    recordEvidence(info, "e-t2", { sent: net.commands });
  });
});

test.describe("E-T3: create offline and an immediate Mark done (A9, A10, A16; TASK-26)", () => {
  test("a create with deterministic ids, then a record that names the same progress id and depends on it; sent in order", async ({
    context,
  }, info) => {
    const { page, net } = await setup(context, "/tasks/new", []);
    await page
      .getByRole("button", { name: "Start from scratch instead" })
      .click();
    // The defaults snapshot is read online (the form uses it), so the offline create captures it rather than waiting for review.
    await expect(
      page.getByRole("radio", { name: "Use my defaults (only you)" }),
    ).toBeVisible();
    await goOfflineAtBoundary(page);
    await page.getByLabel("Name", { exact: true }).fill("Take the bins out");
    await page.getByRole("radio", { name: "Only me" }).check();
    await page.getByRole("button", { name: "Save" }).click();
    await expect(page.locator("[data-task-detail]")).toBeVisible();
    await expect(page.locator("[data-record-card]")).toBeVisible();
    await page
      .locator("[data-record-card]")
      .getByRole("button", { name: "Mark done" })
      .click();
    await expect.poll(async () => (await draftsOf(page)).length).toBe(2);
    const [create, record] = await draftsOf(page);
    const bodies = await bodiesOf(page);
    const createBody = bodies.find((b) => b.local_id === create?.local_id)
      ?.command.command as Record<string, unknown>;
    const recordBody = bodies.find((b) => b.local_id === record?.local_id)
      ?.command.command as Record<string, unknown>;
    // The first slot's key follows the saved schedule: `once` without a repeat, else `<start date>T<time or "date">`.
    const schedule = (
      createBody.definition as {
        schedule: {
          start_date: string;
          time: string | null;
          repeat: { frequency: string } | null;
        };
      }
    ).schedule;
    const key =
      schedule.repeat === null ||
      schedule.repeat.frequency === "after_completion"
        ? "once"
        : `${schedule.start_date}T${schedule.time ?? "date"}`;
    const occurrence = occurrenceIdOf(createBody.id as string, key);
    expect(create?.target_resource_ids).toEqual([
      createBody.id,
      createBody.execution_id,
      occurrence,
      progressIdOf(occurrence),
    ]);
    expect(recordBody).toMatchObject({
      occurrence_id: occurrence,
      expected_version: 1,
    });
    await goOnlineAtBoundary(page);
    await send(page);
    await expect.poll(() => net.commands.length).toBe(2);
    expect(
      net.commands.map(
        (c) =>
          (JSON.parse(c.body) as { command: { kind: string } }).command.kind,
      ),
    ).toEqual(["create_task", "record"]);
    recordEvidence(info, "e-t3", { sent: net.commands });
  });
});

test.describe("E-T3b: a create captured from defaults never fetched waits for review (A16)", () => {
  test("held for the defaults review in real IndexedDB; the record behind it waits; nothing is sent", async ({
    context,
  }) => {
    const { page, net } = await setup(context, "/tasks/new", [], (r) => {
      r.snapshot = {
        status: 503,
        body: {
          code: "temporarily_unavailable",
          message: "m",
          request_id: "11111111-1111-4111-8111-111111111111",
          details: [],
        },
      };
    });
    await page
      .getByRole("button", { name: "Start from scratch instead" })
      .click();
    await page.getByLabel("Name", { exact: true }).fill("Review me");
    await page.getByRole("button", { name: "Save" }).click();
    await expect(page.locator("[data-record-card]")).toBeVisible();
    await page
      .locator("[data-record-card]")
      .getByRole("button", { name: "Mark done" })
      .click();
    await expect.poll(async () => (await draftsOf(page)).length).toBe(2);
    const rows = (await page.evaluate(
      (acct) => window.__atlasData?.rows(acct, "drafts"),
      ACCOUNT,
    )) as Array<{
      kind: string;
      review_block: { kinds: string[] } | null;
      created_seq: number;
    }>;
    const create = rows.find((d) => d.kind === "create_task");
    expect(create?.review_block?.kinds.sort()).toEqual(["progress", "task"]);
    await send(page);
    await page.waitForTimeout(1_500);
    expect(net.commands).toHaveLength(0);
  });
});

test.describe("E-T4: the preset picker (A11)", () => {
  test("six presets from the API, chosen by keyboard, fill the form; a failure and offline keep 'Start from scratch'", async ({
    context,
  }) => {
    const definition = (participation: string) => ({
      schedule: {
        start_date: TODAY,
        time: null,
        timezone: "UTC",
        repeat: { frequency: "daily", interval: 1 },
      },
      goal: { kind: "checkbox" },
      carry: "close_incomplete",
      participation,
      open_days_before: 0,
      close_days_after: 1,
      allow_streak_exclusions: false,
    });
    const titles = [
      "Daily routine",
      "Shared persistent chore",
      "Three times a week",
      "Joint daily routine",
      "25 minutes of focus",
      "Seven days after completion",
    ];
    const { page, reads } = await setup(context, "/tasks/new", [], (r) => {
      r.presetsAnswer = {
        status: 200,
        body: {
          items: titles.map((title, i) => ({
            id: `p${i}`,
            title,
            definition: definition(i === 1 ? "everyone" : "personal"),
          })),
        },
      };
    });
    await expect(
      page.locator("[data-preset-list] input[type=radio]"),
    ).toHaveCount(6);
    await page.getByRole("radio", { name: /Daily routine/ }).focus();
    await page.keyboard.press("ArrowDown");
    await expect(
      page.getByRole("radio", { name: /Shared persistent chore/ }),
    ).toBeChecked();
    await page.getByRole("button", { name: "Use preset" }).click();
    await expect(page.getByLabel("Name", { exact: true })).toHaveValue(
      "Shared persistent chore",
    );
    expect(reads.presets).toBeGreaterThanOrEqual(1);
    await navigateInApp(page, "/tasks");
    reads.presetsAnswer = {
      status: 503,
      body: {
        code: "temporarily_unavailable",
        message: "m",
        request_id: "11111111-1111-4111-8111-111111111111",
        details: [],
      },
    };
    await navigateInApp(page, "/tasks/new");
    await expect(page.locator('[data-preset-picker="failed"]')).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Start from scratch instead" }),
    ).toBeVisible();
    await goOfflineAtBoundary(page);
    await navigateInApp(page, "/tasks");
    await navigateInApp(page, "/tasks/new");
    await expect(page.getByText("Presets need a connection")).toBeVisible();
  });
});

test.describe("E-T5: closure and streak exclusion (A12)", () => {
  test("Exclude is absent when the policy is off; with it on, Close and Exclude queue offline", async ({
    context,
  }) => {
    const off = buildTask({ n: 5, title: "Off" });
    const on = buildTask({ n: 6, title: "On", allowExclusions: true });
    const { page } = await setup(
      context,
      `/tasks/${off.taskId}?occurrence=${off.occurrenceId}`,
      [off, on],
    );
    await goOfflineAtBoundary(page);
    await expect(page.locator("[data-closure]")).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Exclude from my streak" }),
    ).toHaveCount(0);
    await navigateInApp(
      page,
      `/tasks/${on.taskId}?occurrence=${on.occurrenceId}`,
    );
    await page
      .getByRole("button", { name: "Close without completing" })
      .click();
    await page.getByRole("button", { name: "Exclude from my streak" }).click();
    await expect(page.getByRole("button", { name: "Reopen" })).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Undo streak exclusion" }),
    ).toBeVisible();
    expect((await draftsOf(page)).map((d) => d.kind)).toEqual([
      "resolve",
      "exclude",
    ]);
  });
});

test.describe("E-T6: archive offline leaves the day (A13)", () => {
  test("the occurrence leaves the offline Today walk; the task is listed under Archived; Restore brings it back", async ({
    context,
  }) => {
    const a = buildTask({ n: 7, title: "Archive me" });
    const { page } = await setup(context, todayRoute(), [a]);
    await goOfflineAtBoundary(page);
    await expect(rowOf(page, a.occurrenceId)).toBeVisible();
    await navigateInApp(
      page,
      `/tasks/${a.taskId}?occurrence=${a.occurrenceId}`,
    );
    await page.getByRole("button", { name: "Archive" }).click();
    await expect(page.getByRole("button", { name: "Restore" })).toBeVisible();
    await navigateInApp(page, todayRoute());
    await expect(page.locator("[data-today-page]")).toBeVisible();
    await expect(rowOf(page, a.occurrenceId)).toHaveCount(0);
    await navigateInApp(page, "/tasks");
    await page.getByRole("checkbox", { name: "Archived" }).check();
    await expect(page.locator(`[data-task-link="${a.taskId}"]`)).toBeVisible();
    await navigateInApp(
      page,
      `/tasks/${a.taskId}?occurrence=${a.occurrenceId}`,
    );
    await page.getByRole("button", { name: "Restore" }).click();
    await navigateInApp(page, todayRoute());
    await expect(rowOf(page, a.occurrenceId)).toBeVisible();
  });
});

test.describe("E-T7: the correction dialog (A14)", () => {
  test("Escape discards; Save correction queues a full-definition revise_occurrence", async ({
    context,
  }) => {
    const a = buildTask({
      n: 8,
      title: "Cups",
      goal: { kind: "numeric", minimum: null, maximum: "8", unit: "cups" },
    });
    const { page } = await setup(
      context,
      `/tasks/${a.taskId}?occurrence=${a.occurrenceId}`,
      [a],
    );
    await goOfflineAtBoundary(page);
    await page.getByRole("button", { name: "Correct this day" }).click();
    let dialog = page.getByRole("dialog");
    await dialog.getByLabel("At most").fill("3");
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await page.getByRole("button", { name: "Correct this day" }).click();
    dialog = page.getByRole("dialog");
    await expect(dialog.getByLabel("At most")).toHaveValue("8");
    await dialog.getByLabel("At most").fill("2");
    await dialog.getByRole("button", { name: "Save correction" }).click();
    await expect(dialog).toHaveCount(0);
    const bodies = await bodiesOf(page);
    const c = bodies
      .map((b) => b.command.command)
      .find((x) => x.kind === "revise_occurrence");
    expect(c).toMatchObject({
      id: a.occurrenceId,
      expected_version: 1,
      definition: {
        participation: "personal",
        goal: { kind: "numeric", minimum: null, maximum: "2", unit: "cups" },
      },
    });
  });
});

test.describe("E-T8: keyboard only (A19)", () => {
  test("filters by arrow keys and Mark done by Enter", async ({ context }) => {
    const a = buildTask({ n: 9, title: "Brush your teeth" });
    const { page } = await setup(context, todayRoute(), [a]);
    await goOfflineAtBoundary(page);
    await expect(rowOf(page, a.occurrenceId)).toBeVisible();
    await page.getByRole("radio", { name: "All" }).focus();
    await page.keyboard.press("ArrowRight");
    await expect(page.getByRole("radio", { name: "To do" })).toBeChecked();
    await expect(rowOf(page, a.occurrenceId)).toBeVisible();
    await rowOf(page, a.occurrenceId)
      .getByRole("button", { name: "Mark done" })
      .focus();
    await page.keyboard.press("Enter");
    await expect(rowOf(page, a.occurrenceId)).toHaveCount(0);
    await page.getByRole("radio", { name: "To do" }).focus();
    await page.keyboard.press("ArrowRight");
    await expect(page.getByRole("radio", { name: "Done" })).toBeChecked();
    await expect(rowOf(page, a.occurrenceId)).toHaveAttribute(
      "data-pill",
      "done",
    );
  });
});

test.describe("E-T9: a real window boundary (A4; TASK-31 late finalisation)", () => {
  test("a provisional row becomes Done when the real clock passes its closes_at (no sync, no timer shortened)", async ({
    context,
  }) => {
    const closesAt = Math.floor(Date.now() / 1000) + 6;
    const a = buildTask({
      n: 10,
      title: "Cups",
      carry: "retain_one",
      goal: { kind: "numeric", minimum: null, maximum: "8", unit: "cups" },
      action: { outcome: "provisional", amount: "1", checked: [] },
      closesAt,
    });
    const { page } = await setup(context, todayRoute(), [a]);
    await goOfflineAtBoundary(page);
    await expect(rowOf(page, a.occurrenceId)).toHaveAttribute(
      "data-pill",
      "on_track",
    );
    await expect(rowOf(page, a.occurrenceId)).toHaveAttribute(
      "data-pill",
      "done",
      { timeout: 20_000 },
    );
    expect(Math.floor(Date.now() / 1000)).toBeGreaterThanOrEqual(closesAt);
  });
});

test.describe("E-T11: a refused read is asked once across remounts (A2)", () => {
  test("a 403 on /daily is remembered for the identity: navigating away and back asks nothing more", async ({
    context,
  }) => {
    const { page, reads } = await setup(context, "/tasks", []);
    // Refused only once the cache is filled: a 403 makes the session re-check and remount the tree, which would interrupt the fixture leader.
    reads.respond = () => ({
      status: 403,
      body: {
        code: "forbidden",
        message: "m",
        request_id: "11111111-1111-4111-8111-111111111111",
        details: [],
      },
    });
    await navigateInApp(page, todayRoute());
    // A 403 closes and reopens the protected display while the session classifies it (it remounts the tree).
    await expect(page.locator("[data-today-error]")).toBeVisible({
      timeout: 20_000,
    });
    const asked = reads.daily.length;
    expect(asked).toBeGreaterThanOrEqual(1);
    await navigateInApp(page, "/tasks");
    await navigateInApp(page, todayRoute());
    await expect(page.locator("[data-today-error]")).toBeVisible();
    await page.waitForTimeout(1_000);
    expect(reads.daily.length).toBe(asked);
  });
});

test.describe("E-T12: display zone and the gap explainer (A6)", () => {
  test("a timed Vienna slot shows in the display zone; changing the zone regroups it; the spring-gap slot explains itself", async ({
    context,
  }) => {
    // 2026-03-29 02:30 Europe/Vienna never happens: the server's instant is 03:30 local (01:30Z).
    const instant = Date.UTC(2026, 2, 29, 1, 30) / 1000;
    const a = buildTask({
      n: 11,
      title: "Gap",
      date: "2026-03-29",
      time: "02:30:00",
      zone: "Europe/Vienna",
      instant,
      slotKey: "once",
      opensAt: Date.UTC(2026, 2, 28, 23) / 1000,
      closesAt: Date.UTC(2026, 2, 29, 22) / 1000,
    });
    const { page } = await setup(
      context,
      todayRoute("Europe/Vienna", "2026-03-29"),
      [a],
    );
    await goOfflineAtBoundary(page);
    await expect(rowOf(page, a.occurrenceId)).toBeVisible();
    await expect(rowOf(page, a.occurrenceId)).toContainText("03:30");
    await expect(page.locator('[data-today-group="morning"]')).toContainText(
      "Gap",
    );
    await rowOf(page, a.occurrenceId)
      .getByText("Why is this at 03:30?")
      .click();
    await expect(rowOf(page, a.occurrenceId)).toContainText(
      "This task is scheduled in Europe/Vienna.",
    );
    await page.getByLabel("Time zone").selectOption("America/New_York");
    await expect(page).toHaveURL(/tz=America%2FNew_York/);
    // 01:30Z is 21:30 on the 28th in New York: not on the 29th there.
    await expect(rowOf(page, a.occurrenceId)).toHaveCount(0);
  });
});
