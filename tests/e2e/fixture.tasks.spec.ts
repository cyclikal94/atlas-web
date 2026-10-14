import { type BrowserContext, expect, type Page, test } from "@playwright/test";
import { recordEvidence } from "./data-evidence";
import {
  deltaPage,
  fresh,
  leaderPage,
  rowsOf,
  settleElsewhere,
  snapshotPage,
  untilSync,
} from "./data-leader-helpers";
import { serveIdentityReads } from "./data-local-faults";
import {
  ACCOUNT,
  pageText,
  type SyncStub,
  seedSettled,
  startLeader,
  startOutbox,
  stubNetwork,
  untilTreeSettled,
  waitForState,
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
 * window boundary; E-T11 a 403 read once across remounts; E-T12 display-zone change and the gap explainer. Revision 1 adds E-T9b (online,
 * then offline in place), E-T7b/E-T7c (the correction conflict choices; the edit kept across the queue), E-T8b (forms and dialogs by
 * keyboard, focus return), E-T13 (axe of the forms and dialogs), E-T2b (the PRODUCTION leader sends a save made in the tree) and E-T10 (a
 * held `/daily` answer across a real account switch). Revision 2 adds E-T8d (the form and the correction dialog by real Tab traversal from
 * the page's start; E-T8b's programmatic-focus cases remain as activation controls), E-T8e (keys + a held local save + the queue visit: the
 * newer edit survives), E-T9c (the detail follows its window's close), E-T9d (an answer dispatched before the close and delivered after it),
 * E-T9e (a committed correction defeats the older answer) and E-T7e (the conflict choices after a reload, from the durable operation).
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
    // Strengthened in revision 1 (the assertions are unchanged): a task that STAYS on the day is the control that Today has composed its
    // rows before the archived one's absence is asserted. Since R4, Today shows no row until the whole outstanding overlay is read, so an
    // absence checked at once could pass before any row was composed (the real-engine mutant MU-2031 survived that way).
    const stays = buildTask({ n: 22, title: "Stays" });
    const { page } = await setup(context, todayRoute(), [a, stays]);
    await goOfflineAtBoundary(page);
    await expect(rowOf(page, a.occurrenceId)).toBeVisible();
    await expect(rowOf(page, stays.occurrenceId)).toBeVisible();
    await navigateInApp(
      page,
      `/tasks/${a.taskId}?occurrence=${a.occurrenceId}`,
    );
    await page.getByRole("button", { name: "Archive" }).click();
    await expect(page.getByRole("button", { name: "Restore" })).toBeVisible();
    await navigateInApp(page, todayRoute());
    await expect(page.locator("[data-today-page]")).toBeVisible();
    await expect(rowOf(page, stays.occurrenceId)).toBeVisible();
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
    // Harness correction (revision 2, labelled): the two scopes of ONE read can reach the stub tens of milliseconds apart (WebKit, measured
    // 3 of 10 runs, about 70 ms), so the error can show before the second has arrived. Count once this first read is quiet; the assertion
    // that navigating away and back asks nothing more is unchanged.
    let settled = -1;
    await expect
      .poll(async () => {
        const before = reads.daily.length;
        await page.waitForTimeout(300);
        const quiet = reads.daily.length === before;
        if (quiet) settled = before;
        return quiet;
      })
      .toBe(true);
    const asked = settled;
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
    // Strengthened in revision 1 (the assertions are unchanged): an undated task, on every day in every zone, is the control that the
    // regrouped day has been composed before the timed row's absence is asserted.
    const anyDay = buildTask({ n: 24, title: "Any day", date: null });
    const { page } = await setup(
      context,
      todayRoute("Europe/Vienna", "2026-03-29"),
      [a, anyDay],
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
    await expect(rowOf(page, anyDay.occurrenceId)).toBeVisible();
    // 01:30Z is 21:30 on the 28th in New York: not on the 29th there.
    await expect(rowOf(page, a.occurrenceId)).toHaveCount(0);
  });
});

// ---- revision 1 (review of 13 October 2026, R2/R3/R7) -------------------------------------------------------------------------------

const VIEWED = "22222222-2222-4222-8222-222222222222";
/** A settled record of `account` at `epoch` (a sign-in in another tab), as the production store writes it. */
const settledAt = (account: string, epoch: number, session: string) => ({
  schema: 1,
  latest_epoch: epoch,
  fence_seq: 0,
  attempt: null,
  settled: {
    account_id: account,
    epoch,
    settled_at: new Date().toISOString(),
    session_id: session,
  },
  fences: {},
  leases: {},
});
const conflict = (code: string) => ({
  status: 409,
  body: JSON.stringify({
    code,
    message: "m",
    request_id: "11111111-1111-4111-8111-111111111111",
    details: [],
  }),
});
/**
 * Serves `/daily` (call AFTER the network stub: a later route wins). `who` is the account the stub's session answers for WHEN THE REQUEST
 * ARRIVES: the answer is that account's, and `hold` (asked with it) keeps the request unanswered until `release`.
 */
async function serveDaily(
  context: BrowserContext,
  answer: (account: string) => { status: number; body: unknown },
  hold: (account: string) => boolean = () => false,
  who: () => string = () => ACCOUNT,
) {
  const held: Array<() => Promise<void>> = [];
  const asked: Array<{ account: string; url: string }> = [];
  await context.route("**/api/experimental/v1/daily**", async (route) => {
    const account = who();
    asked.push({ account, url: route.request().url() });
    const fulfil = async () => {
      const a = answer(account);
      await route
        .fulfill({
          status: a.status,
          contentType: "application/json",
          body: JSON.stringify(a.body),
        })
        .catch(() => undefined);
    };
    if (hold(account)) held.push(fulfil);
    else await fulfil();
  });
  return {
    asked,
    held,
    release: async () => {
      for (const fulfil of held.splice(0)) await fulfil();
    },
  };
}

test.describe("E-T9b: online, then offline without a remount (A4; R2 of revision 1)", () => {
  test("a row the server answered provisional is finalised from the saved summary when the real window closes after the device went offline", async ({
    context,
  }) => {
    const closesAt = Math.floor(Date.now() / 1000) + 8;
    const a = buildTask({
      n: 15,
      title: "Cups",
      carry: "retain_one",
      goal: { kind: "numeric", minimum: null, maximum: "8", unit: "cups" },
      action: { outcome: "provisional", amount: "1", checked: [] },
      closesAt,
    });
    const { page } = await setup(context, todayRoute(), [a], (r) => {
      r.respond = () =>
        dailyPage([
          view(a, { outcome: "provisional", period_outcome: "provisional" }),
        ]);
    });
    await expect(rowOf(page, a.occurrenceId)).toHaveAttribute(
      "data-source",
      "server",
    );
    await expect(rowOf(page, a.occurrenceId)).toHaveAttribute(
      "data-pill",
      "on_track",
    );
    // Offline in place: the same mounted Today stops using the answer received online.
    await goOfflineAtBoundary(page);
    await expect(rowOf(page, a.occurrenceId)).toHaveAttribute(
      "data-source",
      "local",
    );
    await expect(rowOf(page, a.occurrenceId)).toHaveAttribute(
      "data-pill",
      "done",
      { timeout: 20_000 },
    );
    expect(Math.floor(Date.now() / 1000)).toBeGreaterThanOrEqual(closesAt);
  });
});

test.describe("E-T7b: a correction that met another correction (A14; R7 of revision 1)", () => {
  for (const choice of ["Save mine on the current version", "Discard mine"])
    test(`'${choice}'`, async ({ context }) => {
      const a = buildTask({
        n: 16,
        title: "Cups",
        goal: { kind: "numeric", minimum: null, maximum: "8", unit: "cups" },
      });
      const { page, net } = await setup(
        context,
        `/tasks/${a.taskId}?occurrence=${a.occurrenceId}`,
        [a],
      );
      await goOfflineAtBoundary(page);
      await page.getByRole("button", { name: "Correct this day" }).click();
      const dialog = page.getByRole("dialog");
      await dialog.getByLabel("At most").fill("2");
      await dialog.getByRole("button", { name: "Save correction" }).click();
      await expect(dialog).toHaveCount(0);
      // Someone else corrected the day first: the server refuses ours on version 1.
      net.commandScript.push(() => conflict("conflict"));
      await goOnlineAtBoundary(page);
      await send(page);
      await expect
        .poll(async () => (await draftsOf(page)).map((d) => d.status))
        .toEqual(["version_conflict"]);
      // Their correction arrives with the next sync page: the occurrence at version 2, at most 6.
      const theirs = (
        a.upserts as Array<{
          kind: string;
          resource: { kind: string; value: Record<string, unknown> };
        }>
      ).find((u) => u.resource.kind === "occurrence");
      if (theirs === undefined) throw new Error("setup: no occurrence upsert");
      const definition = (theirs.resource.value as { definition: object })
        .definition as Record<string, unknown>;
      net.script.push(() => ({
        status: 200,
        body: pageText(
          [
            [
              {
                ...theirs,
                resource: {
                  ...theirs.resource,
                  version: 2,
                  value: {
                    ...theirs.resource.value,
                    definition: {
                      ...definition,
                      goal: {
                        kind: "numeric",
                        minimum: null,
                        maximum: "6",
                        unit: "cups",
                      },
                    },
                  },
                },
              },
            ],
          ],
          "cursor-2",
        ),
      }));
      await page.evaluate(() => window.__atlasData?.nudgeSync());
      const block = page.locator("[data-correction-conflict]");
      await expect(block).toContainText(
        "Someone else corrected this day first",
      );
      await block.getByRole("button", { name: choice }).click();
      if (choice === "Discard mine") {
        await expect(block).toHaveCount(0);
        await expect.poll(async () => (await draftsOf(page)).length).toBe(0);
        return;
      }
      await expect(block).toHaveCount(0);
      await send(page);
      await expect.poll(() => net.commands.length).toBe(2);
      const resent = JSON.parse(net.commands[1]?.body ?? "{}") as {
        command: Record<string, unknown>;
      };
      // Mine again, on the version now saved, by the person's act.
      expect(resent.command).toMatchObject({
        kind: "revise_occurrence",
        id: a.occurrenceId,
        expected_version: 2,
        definition: { goal: { maximum: "2" } },
      });
      expect(net.commands[1]?.key).not.toBe(net.commands[0]?.key);
    });
});

test.describe("E-T7c: a correction kept while the person visits the queue (A14; R3/R7 of revision 1)", () => {
  test("the in-dialog sync control keeps the edit for this day; back on the day, the dialog opens on it", async ({
    context,
  }) => {
    const a = buildTask({
      n: 17,
      title: "Cups",
      goal: { kind: "numeric", minimum: null, maximum: "8", unit: "cups" },
    });
    const detail = `/tasks/${a.taskId}?occurrence=${a.occurrenceId}`;
    const { page } = await setup(context, detail, [a]);
    await goOfflineAtBoundary(page);
    await page.getByRole("button", { name: "Correct this day" }).click();
    let dialog = page.getByRole("dialog");
    await dialog.getByLabel("At most").fill("4");
    await dialog.locator("[data-sync-tone]").click();
    await expect(page).toHaveURL(/\/sync/);
    await expect(dialog).toHaveCount(0);
    await navigateInApp(page, detail);
    await page.getByRole("button", { name: "Correct this day" }).click();
    dialog = page.getByRole("dialog");
    await expect(dialog.getByLabel("At most")).toHaveValue("4");
    expect(await draftsOf(page)).toEqual([]);
  });
});

test.describe("E-T8b: keyboard only, forms and dialogs (A10, A14, A19; R7 of revision 1)", () => {
  test("the correction dialog opens, closes by Escape and saves by Enter, focus returning to its control each time (activation control: programmatic focus, revision 2)", async ({
    context,
  }) => {
    const a = buildTask({
      n: 18,
      title: "Cups",
      goal: { kind: "numeric", minimum: null, maximum: "8", unit: "cups" },
    });
    const { page } = await setup(
      context,
      `/tasks/${a.taskId}?occurrence=${a.occurrenceId}`,
      [a],
    );
    await goOfflineAtBoundary(page);
    const opener = page.getByRole("button", { name: "Correct this day" });
    await opener.focus();
    await page.keyboard.press("Enter");
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            document.activeElement?.closest('[role="dialog"]') !== null &&
            document.activeElement !== null,
        ),
      )
      .toBe(true);
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(opener).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(dialog).toBeVisible();
    await dialog.getByLabel("At most").focus();
    await page.keyboard.press("End");
    await page.keyboard.press("Backspace");
    await page.keyboard.type("3");
    await dialog.getByRole("button", { name: "Save correction" }).focus();
    await page.keyboard.press("Enter");
    await expect(dialog).toHaveCount(0);
    await expect(opener).toBeFocused();
    expect((await draftsOf(page)).map((d) => d.kind)).toEqual([
      "revise_occurrence",
    ]);
  });

  test("the task form is filled and saved by keyboard; the new task's detail follows (activation control: programmatic focus, revision 2)", async ({
    context,
  }) => {
    const { page } = await setup(context, "/tasks/new", []);
    await goOfflineAtBoundary(page);
    await page
      .getByRole("button", { name: "Start from scratch instead" })
      .focus();
    await page.keyboard.press("Enter");
    const name = page.getByLabel("Name", { exact: true });
    await name.focus();
    await page.keyboard.type("Water the plants");
    await page.getByRole("radio", { name: "Only me" }).focus();
    await page.keyboard.press("Space");
    await expect(page.getByRole("radio", { name: "Only me" })).toBeChecked();
    await page.getByRole("button", { name: "Save" }).focus();
    await page.keyboard.press("Enter");
    await expect(page.locator("[data-task-detail]")).toBeVisible();
    expect((await draftsOf(page)).map((d) => d.kind)).toEqual(["create_task"]);
  });
});

test.describe("E-T13: axe and layout of the forms and dialogs (A19; R7 of revision 1)", () => {
  for (const [width, height] of [
    [390, 844],
    [1440, 900],
  ] as const)
    for (const scheme of ["light", "dark"] as const)
      test(`the task form, the task detail and the correction dialog at ${width}×${height}, ${scheme} (browser emulation, not a device)`, async ({
        context,
      }) => {
        const a = buildTask({
          n: 19,
          title: "Cups",
          goal: { kind: "numeric", minimum: null, maximum: "8", unit: "cups" },
        });
        const { page } = await setup(
          context,
          `/tasks/${a.taskId}?occurrence=${a.occurrenceId}`,
          [a],
          () => undefined,
          { viewport: { width, height }, colorScheme: scheme },
        );
        await goOfflineAtBoundary(page);
        const overflow = () =>
          page.evaluate(
            () =>
              document.documentElement.scrollWidth -
              document.documentElement.clientWidth,
          );
        await expect(page.locator("[data-record-card]")).toBeVisible();
        expect(await runAxe(page), "the task detail").toEqual([]);
        expect(await overflow()).toBeLessThanOrEqual(0);
        await page.getByRole("button", { name: "Correct this day" }).click();
        await expect(page.getByRole("dialog")).toBeVisible();
        expect(await runAxe(page), "the correction dialog").toEqual([]);
        expect(await overflow()).toBeLessThanOrEqual(0);
        await page.keyboard.press("Escape");
        await navigateInApp(page, "/tasks/new");
        await page
          .getByRole("button", { name: "Start from scratch instead" })
          .click();
        await expect(page.getByLabel("Name", { exact: true })).toBeVisible();
        expect(await runAxe(page), "the task form").toEqual([]);
        expect(await overflow()).toBeLessThanOrEqual(0);
      });
});

test.describe("E-T2b: the PRODUCTION leader sends a save made in the tree (A7, A18; R7 of revision 1)", () => {
  test("Mark done online with ?leader=production: the record is sent with its own key, with no harness call to wake anything", async ({
    context,
  }) => {
    const a = buildTask({ n: 20, title: "Brush your teeth" });
    const net = await fresh(context);
    net.answer = (call) =>
      call.cursor === null
        ? snapshotPage(a.upserts, "delta-0", false)
        : deltaPage([], call.cursor);
    await serveDaily(context, () => dailyPage([view(a)]));
    const page = await leaderPage(context, net, "one", undefined, {
      route: todayRoute(),
    });
    await expect(rowOf(page, a.occurrenceId)).toBeVisible({ timeout: 20_000 });
    await rowOf(page, a.occurrenceId)
      .getByRole("button", { name: "Mark done" })
      .click();
    // Nothing but the tree's own save: the production dispatcher hears it and sends.
    await expect
      .poll(() => net.commands.map((c) => c.path), { timeout: 20_000 })
      .toEqual(["/task-commands"]);
    const records = (
      (await rowsOf(page, "drafts")) as Array<{
        kind: string;
        local_id: string;
      }>
    ).filter((d) => d.kind === "record");
    expect(records).toHaveLength(1);
    expect(net.commands[0]?.key).toBe(records[0]?.local_id);
    expect(net.commands[0]?.page).toBe("one");
  });
});

test.describe("E-T10: a /daily answer held across an account switch (A20; R7 of revision 1)", () => {
  test("the answer for the previous account arrives after another account is displayed and is never shown", async ({
    context,
  }) => {
    const a = buildTask({ n: 21, title: "Theirs" });
    const net = await fresh(context);
    net.answer = (call) =>
      call.cursor === null
        ? snapshotPage(
            net.identity.account === ACCOUNT ? a.upserts : [],
            "delta-0",
            false,
          )
        : deltaPage([], call.cursor);
    // The previous account's reads are held; the next account's are answered at once, with its own (empty) day.
    const daily = await serveDaily(
      context,
      (account) =>
        account === ACCOUNT
          ? dailyPage([
              view(a, {
                outcome: "complete",
                period_outcome: "complete",
                actionable: false,
              }),
            ])
          : dailyPage([]),
      (account) => account === ACCOUNT,
      () => net.identity.account,
    );
    const page = await leaderPage(context, net, "one", undefined, {
      route: todayRoute(),
    });
    // The account's day from its cache, while both of its /daily reads are held.
    await expect(rowOf(page, a.occurrenceId)).toHaveAttribute(
      "data-source",
      "local",
      { timeout: 20_000 },
    );
    await expect.poll(() => daily.held.length).toBeGreaterThanOrEqual(2);
    // Another tab signs in as someone else: this page now displays that account.
    net.identity = { account: VIEWED, session: "s2" };
    await settleElsewhere(context, settledAt(VIEWED, 2, "s2"));
    // The leading page follows the new settlement: its binding moves to that account, whose cache it brings up to date.
    const synced = await untilSync(
      page,
      (state) => state?.cache_status === "valid",
      VIEWED,
    );
    expect(synced?.cache_status).toBe("valid");
    await expect(page.locator("[data-today-page]")).toBeVisible({
      timeout: 20_000,
    });
    // The next account's day is composed (empty, not loading) before the late answers are delivered: the absence below is then a
    // statement about a live view, not about one that has not been drawn yet.
    await expect(page.locator("[data-today-empty]")).toBeVisible({
      timeout: 20_000,
    });
    const heldBefore = daily.held.length;
    expect(heldBefore).toBeGreaterThanOrEqual(2);
    await daily.release();
    // Long enough for a late answer to be composed and shown, were it applied.
    await page.waitForTimeout(1_500);
    await expect(page.locator("[data-today-empty]")).toBeVisible();
    await expect(rowOf(page, a.occurrenceId)).toHaveCount(0);
    // The next account's own day was asked for and answered (so the screen is live, not stuck), and the held answers were delivered.
    expect(daily.asked.some((q) => q.account === VIEWED)).toBe(true);
    expect(daily.held).toHaveLength(0);
  });
});

// ---- revision 2 --------------------------------------------------------------------------------------------------------------------------

/** What has keyboard focus, as a person sees it (K1): its name, whether it is in a dialog, on screen, not covered and visibly focused. */
interface Focus {
  tag: string;
  type: string | null;
  name: string;
  chip: boolean;
  inDialog: boolean;
  inView: boolean;
  unobscured: boolean;
  /** What is at the control's centre when something else is (for the failure message). */
  coveredBy: string;
  /** The control's box and the viewport, for the failure message. */
  box: string;
  focusVisible: boolean;
}
const focusOf = (page: Page): Promise<Focus> =>
  page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    if (el === null || el === document.body)
      return {
        tag: "body",
        type: null,
        name: "",
        chip: false,
        inDialog: false,
        inView: false,
        unobscured: false,
        coveredBy: "",
        box: "",
        focusVisible: false,
      };
    const r = el.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    const inView =
      r.width > 0 &&
      r.height > 0 &&
      cx >= 0 &&
      cy >= 0 &&
      cx <= innerWidth &&
      cy <= innerHeight;
    const top = inView ? document.elementFromPoint(cx, cy) : null;
    const labelled = (el as HTMLInputElement).labels?.[0]?.textContent;
    const name = (
      el.getAttribute("aria-label") ??
      labelled ??
      el.textContent ??
      ""
    )
      .replace(/\s+/g, " ")
      .trim();
    return {
      tag: el.tagName.toLowerCase(),
      type: el.getAttribute("type"),
      name,
      chip: el.hasAttribute("data-sync-tone"),
      inDialog: el.closest('[role="dialog"]') !== null,
      inView,
      unobscured:
        top !== null && (top === el || el.contains(top) || top.contains(el)),
      coveredBy:
        top === null
          ? "nothing"
          : `${top.tagName.toLowerCase()}${top.id ? `#${top.id}` : ""}.${String(top.className).slice(0, 60)}`,
      box: `${Math.round(r.top)}..${Math.round(r.bottom)} of ${innerHeight}`,
      // A date or time field has several stops of its own (each part of the value, and Chromium's picker button), whose focus the
      // BROWSER draws (the focused part is highlighted): WebKit never matches `:focus-visible` on these fields and Chromium's picker stop
      // is inside the field, so the app's ring rule does not apply there. Measured per engine in revision 2; recorded as the browser's own
      // indicator, not the app's ring.
      focusVisible:
        el.matches(":focus-visible") ||
        (["date", "time"].includes(el.getAttribute("type") ?? "") &&
          el.matches(":focus-within")),
    };
  });
/**
 * The key that moves to the next control. Safari (WebKit) with its default settings moves by Tab between text fields only and by
 * Option+Tab (Alt+Tab) through every control: that is the keyboard path of a person using Safari, so the WebKit project uses it (the dialog's
 * focus loop honours either: `focus-loop.ts`). Chromium and Firefox use Tab.
 */
const nextKey = (shift = false): string =>
  `${test.info().project.name === "fixture-webkit" ? "Alt+" : ""}${shift ? "Shift+" : ""}Tab`;
/** Presses Tab (or Shift+Tab) until `want` holds, at most `max` times; throws with the path taken otherwise. */
async function tabTo(
  page: Page,
  want: (f: Focus) => boolean,
  label: string,
  options: { shift?: boolean; max?: number } = {},
): Promise<Focus> {
  const trail: string[] = [];
  for (let i = 0; i < (options.max ?? 60); i += 1) {
    await page.keyboard.press(nextKey(options.shift));
    const f = await focusOf(page);
    trail.push(f.name || f.tag);
    if (want(f)) return f;
  }
  // An assertion, not a thrown error: a control missing from the tab order is the defect this traversal exists to show.
  expect(
    false,
    `${label} was not reached by ${options.shift ? "Shift+Tab" : "Tab"}: ${trail.join(" → ")}`,
  ).toBe(true);
  throw new Error("unreachable");
}
/** A meaningful stop: visibly focused, on screen and not covered by anything. */
function seen(f: Focus, what: string): void {
  expect(f.focusVisible, `${what}: visible focus`).toBe(true);
  expect(f.inView, `${what}: on screen`).toBe(true);
  expect(
    f.unobscured,
    `${what}: not covered (at its centre: ${f.coveredBy}; box ${f.box})`,
  ).toBe(true);
}
/** The person starts at the top of the page: nothing has focus (as after the page loaded). */
const fromPageStart = (page: Page) =>
  page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
const DIALOG_CONTROLS = [
  "Close",
  "At least",
  "At most",
  "Unit",
  "The date it counts for",
  "Time of day",
  "You can start it (days before)",
  "How long it stays open (days)",
  "Cancel",
  "Save correction",
];

test.describe("E-T8d: keyboard traversal, forms and dialogs (A10, A14, A19; R7 of revision 2)", () => {
  test("the correction dialog by Tab from the page's start: reached, contained both ways, edited and saved by keys, focus returned", async ({
    context,
  }) => {
    const a = buildTask({
      n: 22,
      title: "Cups",
      goal: { kind: "numeric", minimum: null, maximum: "8", unit: "cups" },
    });
    const { page } = await setup(
      context,
      `/tasks/${a.taskId}?occurrence=${a.occurrenceId}`,
      [a],
    );
    await goOfflineAtBoundary(page);
    await expect(
      page.getByRole("button", { name: "Correct this day" }),
    ).toBeVisible();
    await fromPageStart(page);
    seen(
      await tabTo(page, (f) => f.name === "Correct this day", "the opener"),
      "the opener",
    );
    await page.keyboard.press("Enter");
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect.poll(async () => (await focusOf(page)).inDialog).toBe(true);
    // Forward: every stop is in the dialog, visible and uncovered, until Tab comes back round to the first.
    const first = await focusOf(page);
    const forward: Focus[] = [first];
    for (let i = 0; i < 40; i += 1) {
      await page.keyboard.press(nextKey());
      const f = await focusOf(page);
      if (f.name === first.name && f.tag === first.tag && i > 0) break;
      forward.push(f);
    }
    for (const f of forward) {
      expect(f.inDialog, `${f.name}: inside the dialog`).toBe(true);
      seen(f, `dialog stop '${f.name}'`);
    }
    const names = forward.map((f) => f.name);
    for (const control of DIALOG_CONTROLS)
      expect(
        names.some((n) => n === control || n.startsWith(control)),
        `'${control}' is reached by Tab (${names.join(" → ")})`,
      ).toBe(true);
    expect(forward.some((f) => f.chip)).toBe(true);
    // Backward: the same stops, in the dialog, back to where it began.
    let back = 0;
    for (; back < 40; back += 1) {
      await page.keyboard.press(nextKey(true));
      const f = await focusOf(page);
      expect(f.inDialog, `${f.name}: inside the dialog (Shift+Tab)`).toBe(true);
      if (f.name === first.name && f.tag === first.tag) break;
    }
    expect(back + 1).toBe(forward.length);
    // Edit by keys and save with Enter on the Save button.
    seen(
      await tabTo(
        page,
        (f) => f.inDialog && f.name.startsWith("At most"),
        "At most",
      ),
      "At most",
    );
    await page.keyboard.press("End");
    await page.keyboard.press("Backspace");
    await page.keyboard.type("3");
    seen(
      await tabTo(page, (f) => f.name === "Save correction", "Save correction"),
      "Save correction",
    );
    await page.keyboard.press("Enter");
    await expect(dialog).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Correct this day" }),
    ).toBeFocused();
    await expect
      .poll(async () => (await draftsOf(page)).map((d) => d.kind))
      .toEqual(["revise_occurrence"]);
    const body = (await bodiesOf(page))[0]?.command.command as {
      definition: { goal: { maximum: string } };
    };
    expect(body.definition.goal.maximum).toBe("3");
    // Escape discards and returns focus to the opener too.
    await page.keyboard.press("Enter");
    await expect(dialog).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Correct this day" }),
    ).toBeFocused();
    expect(await draftsOf(page)).toHaveLength(1);
  });

  test("the task form by Tab from the page's start: preset choice, name, sharing by arrow keys, saved by Enter", async ({
    context,
  }) => {
    const { page } = await setup(context, "/tasks/new", []);
    await goOfflineAtBoundary(page);
    await expect(
      page.getByRole("button", { name: "Start from scratch instead" }),
    ).toBeVisible();
    await fromPageStart(page);
    seen(
      await tabTo(
        page,
        (f) => f.name === "Start from scratch instead",
        "Start from scratch instead",
      ),
      "Start from scratch instead",
    );
    await page.keyboard.press("Enter");
    await expect(page.locator("[data-task-form]")).toBeVisible();
    seen(
      await tabTo(
        page,
        (f) => f.tag === "input" && f.name.startsWith("Name"),
        "Name",
      ),
      "Name",
    );
    await page.keyboard.type("Water the plants");
    const sharing = await tabTo(
      page,
      (f) =>
        f.type === "radio" &&
        (f.name === "Only me" || f.name.startsWith("Use my defaults")),
      "the sharing choice",
    );
    seen(sharing, "the sharing choice");
    const onlyMe = page.getByRole("radio", { name: "Only me" });
    for (let i = 0; i < 6 && !(await onlyMe.isChecked()); i += 1)
      await page.keyboard.press("ArrowDown");
    await expect(onlyMe).toBeChecked();
    await expect(onlyMe).toBeFocused();
    seen(await tabTo(page, (f) => f.name === "Save", "Save"), "Save");
    await page.keyboard.press("Enter");
    await expect(page.locator("[data-task-detail]")).toBeVisible();
    expect((await draftsOf(page)).map((d) => d.kind)).toEqual(["create_task"]);
  });
});

/** Holds the COMPLETION of local writes of drafts (`draft_commands`, read-write) while `__holdDraftWrites` is set: the write is durable, the save's
 * acknowledgement waits. Installed before the page loads (Dexie assigns `oncomplete` per transaction). */
const holdDraftWritesInit = (): void => {
  const desc = Object.getOwnPropertyDescriptor(
    IDBTransaction.prototype,
    "oncomplete",
  );
  const get = desc?.get;
  const set = desc?.set;
  if (get === undefined || set === undefined) return;
  const w = window as unknown as {
    __holdDraftWrites?: boolean;
    __heldDraftWrites?: Array<() => void>;
  };
  w.__heldDraftWrites = [];
  Object.defineProperty(IDBTransaction.prototype, "oncomplete", {
    configurable: true,
    enumerable: desc?.enumerable ?? true,
    get() {
      return get.call(this);
    },
    set(fn: unknown) {
      const tx = this as IDBTransaction;
      if (
        typeof fn !== "function" ||
        tx.mode !== "readwrite" ||
        !Array.from(tx.objectStoreNames).includes("draft_commands")
      ) {
        set.call(this, fn);
        return;
      }
      set.call(this, function (this: IDBTransaction, event: Event) {
        if (w.__holdDraftWrites === true) {
          w.__heldDraftWrites?.push(() => fn.call(tx, event));
          return;
        }
        return fn.call(tx, event);
      });
    },
  });
};

test.describe("E-T8e: keys, a held local save and the queue visit (A14, A19; R3/R7 of revision 2)", () => {
  test("a correction saved by keys while its acknowledgement is held, kept through the in-dialog sync control, edited again: the older save keeps the newer edit", async ({
    context,
  }) => {
    await context.addInitScript(holdDraftWritesInit);
    const a = buildTask({
      n: 23,
      title: "Cups",
      goal: { kind: "numeric", minimum: null, maximum: "8", unit: "cups" },
    });
    const detail = `/tasks/${a.taskId}?occurrence=${a.occurrenceId}`;
    const { page } = await setup(context, detail, [a]);
    await goOfflineAtBoundary(page);
    await expect(
      page.getByRole("button", { name: "Correct this day" }),
    ).toBeVisible();
    await fromPageStart(page);
    await tabTo(page, (f) => f.name === "Correct this day", "the opener");
    await page.keyboard.press("Enter");
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await tabTo(
      page,
      (f) => f.inDialog && f.name.startsWith("At most"),
      "At most",
    );
    await page.keyboard.press("End");
    await page.keyboard.press("Backspace");
    await page.keyboard.type("12");
    await tabTo(page, (f) => f.name === "Save correction", "Save correction");
    await page.evaluate(() => {
      (window as unknown as { __holdDraftWrites?: boolean }).__holdDraftWrites =
        true;
    });
    await page.keyboard.press("Enter");
    // The save is written but not acknowledged: the dialog waits.
    await expect(
      dialog.getByRole("button", { name: "Save correction" }),
    ).toBeDisabled();
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window as unknown as { __heldDraftWrites?: unknown[] })
              .__heldDraftWrites?.length ?? 0,
        ),
      )
      .toBeGreaterThanOrEqual(1);
    // To the queue by the in-dialog sync control, by keys.
    await tabTo(
      page,
      (f) => f.inDialog && f.chip,
      "the in-dialog sync control",
    );
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/sync/);
    await expect(dialog).toHaveCount(0);
    // Back on the day: the dialog opens on the kept edit; the person changes it.
    await navigateInApp(page, detail);
    await expect(
      page.getByRole("button", { name: "Correct this day" }),
    ).toBeVisible();
    await fromPageStart(page);
    await tabTo(page, (f) => f.name === "Correct this day", "the opener");
    await page.keyboard.press("Enter");
    await expect(dialog.getByLabel("At most")).toHaveValue("12");
    await tabTo(
      page,
      (f) => f.inDialog && f.name.startsWith("At most"),
      "At most",
    );
    await page.keyboard.press("End");
    await page.keyboard.press("Backspace");
    await page.keyboard.press("Backspace");
    await page.keyboard.type("15");
    // The older save is acknowledged now.
    await page.evaluate(() => {
      const w = window as unknown as {
        __holdDraftWrites?: boolean;
        __heldDraftWrites?: Array<() => void>;
      };
      w.__holdDraftWrites = false;
      for (const release of w.__heldDraftWrites?.splice(0) ?? []) release();
    });
    await expect(
      dialog.getByRole("button", { name: "Save correction" }),
    ).toBeEnabled();
    await expect(dialog).toBeVisible();
    await expect(dialog.getByLabel("At most")).toHaveValue("15");
    const saved = (await bodiesOf(page)).map(
      (b) =>
        (b.command.command as { definition: { goal: { maximum: string } } })
          .definition.goal.maximum,
    );
    expect(saved).toEqual(["12"]);
    // The newer edit is saved by its own act, and only then does the dialog close.
    await tabTo(page, (f) => f.name === "Save correction", "Save correction");
    await page.keyboard.press("Enter");
    await expect(dialog).toHaveCount(0);
    await expect
      .poll(async () =>
        (await bodiesOf(page))
          .map(
            (b) =>
              (
                b.command.command as {
                  definition: { goal: { maximum: string } };
                }
              ).definition.goal.maximum,
          )
          .sort(),
      )
      .toEqual(["12", "15"]);
  });
});

test.describe("E-T9c: the task detail follows its day's window (A4, A15; R8 of revision 2)", () => {
  test("left open offline across the real close, the detail becomes Done with no data change or user action (no timer shortened)", async ({
    context,
  }) => {
    const closesAt = Math.floor(Date.now() / 1000) + 8;
    const a = buildTask({
      n: 24,
      title: "Cups",
      carry: "retain_one",
      goal: { kind: "numeric", minimum: null, maximum: "8", unit: "cups" },
      action: { outcome: "provisional", amount: "1", checked: [] },
      closesAt,
    });
    const { page } = await setup(
      context,
      `/tasks/${a.taskId}?occurrence=${a.occurrenceId}`,
      [a],
    );
    await goOfflineAtBoundary(page);
    const pill = page.locator("[data-detail-pill]");
    await expect(pill).toHaveAttribute("data-detail-pill", "on_track");
    await expect(pill).toHaveAttribute("data-detail-pill", "done", {
      timeout: 20_000,
    });
    expect(Math.floor(Date.now() / 1000)).toBeGreaterThanOrEqual(closesAt);
  });
});

test.describe("E-T9d: an answer dispatched before the close and delivered after it (A2, A4; R2 of revision 2)", () => {
  test("the day read ahead of the occurrence's delta, both scopes delivered after the real close: finalised from my saved summary, not the provisional answer", async ({
    context,
  }) => {
    const closesAt = Math.floor(Date.now() / 1000) + 8;
    const a = buildTask({
      n: 25,
      title: "Cups",
      carry: "retain_one",
      goal: { kind: "numeric", minimum: null, maximum: "8", unit: "cups" },
      action: { outcome: "provisional", amount: "1", checked: [] },
      closesAt,
    });
    // The cache holds the task and my progress; the occurrence's delta has not arrived (the daily read is ahead of it).
    const withoutOccurrence: BuiltTask = {
      ...a,
      upserts: (a.upserts as Array<{ resource: { kind: string } }>).filter(
        (u) => u.resource.kind !== "occurrence",
      ),
    };
    let release: () => void = () => undefined;
    const first = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { page, reads } = await setup(
      context,
      todayRoute(),
      [withoutOccurrence],
      (r) => {
        r.respond = () =>
          Date.now() < closesAt * 1000
            ? dailyPage([
                view(a, {
                  outcome: "provisional",
                  period_outcome: "provisional",
                }),
              ])
            : dailyPage([
                view(a, {
                  outcome: "complete",
                  period_outcome: "complete",
                  actionable: false,
                }),
              ]);
        r.gate = first;
      },
    );
    await expect.poll(() => reads.daily.length).toBeGreaterThanOrEqual(2);
    expect(reads.dispatched.every((t) => t < closesAt * 1000)).toBe(true);
    await expect
      .poll(() => Date.now(), { timeout: 20_000 })
      .toBeGreaterThan(closesAt * 1000 + 500);
    // Every later read is held (never delivered): what shows is decided by the late answer alone.
    reads.gate = new Promise<void>(() => undefined);
    release();
    await expect(rowOf(page, a.occurrenceId)).toHaveAttribute(
      "data-pill",
      "done",
      { timeout: 10_000 },
    );
    await expect(rowOf(page, a.occurrenceId)).toHaveAttribute(
      "data-source",
      "local",
    );
    await expect(rowOf(page, a.occurrenceId)).toHaveAttribute(
      "data-structure",
      "daily",
    );
  });
});

test.describe("E-T9e: a committed correction defeats an older answer (A2, A14; R2 of revision 2)", () => {
  test("a sync page commits version 2 with a closed window while the re-read is held: the committed day is shown and finalised", async ({
    context,
  }) => {
    const a = buildTask({
      n: 26,
      title: "Cups",
      carry: "retain_one",
      goal: { kind: "numeric", minimum: null, maximum: "8", unit: "cups" },
      action: { outcome: "provisional", amount: "1", checked: [] },
      closesAt: Math.floor(Date.now() / 1000) + 3600,
    });
    const { page, net, reads } = await setup(
      context,
      todayRoute(),
      [a],
      (r) => {
        r.respond = () =>
          dailyPage([
            view(a, { outcome: "provisional", period_outcome: "provisional" }),
          ]);
      },
    );
    await expect(rowOf(page, a.occurrenceId)).toHaveAttribute(
      "data-source",
      "server",
    );
    await expect(rowOf(page, a.occurrenceId)).toHaveAttribute(
      "data-pill",
      "on_track",
    );
    reads.gate = new Promise<void>(() => undefined);
    const occurrence = (
      a.upserts as Array<{
        kind: string;
        resource: { kind: string; value: Record<string, unknown> };
      }>
    ).find((u) => u.resource.kind === "occurrence");
    if (occurrence === undefined)
      throw new Error("setup: no occurrence upsert");
    // The correction arrives in a batch at revision 2, after the first page's revision 1, as a server's always-increasing sync clock sends
    // it (`pageText` numbers the batches of each page from 1, which would repeat revision 1).
    net.script.push(() => ({
      status: 200,
      body: JSON.stringify({
        phase: "delta",
        batches: [
          {
            revision: 2,
            changes: [
              {
                ...occurrence,
                resource: {
                  ...occurrence.resource,
                  version: 2,
                  value: {
                    ...occurrence.resource.value,
                    closes_at: Math.floor(Date.now() / 1000) - 1,
                  },
                },
              },
            ],
          },
        ],
        next_cursor: "cursor-2",
        has_more: false,
      }),
    }));
    await page.evaluate(() => window.__atlasData?.nudgeSync());
    await expect(rowOf(page, a.occurrenceId)).toHaveAttribute(
      "data-version",
      "2",
      { timeout: 10_000 },
    );
    await expect(rowOf(page, a.occurrenceId)).toHaveAttribute(
      "data-structure",
      "cache",
    );
    await expect(rowOf(page, a.occurrenceId)).toHaveAttribute(
      "data-source",
      "local",
    );
    await expect(rowOf(page, a.occurrenceId)).toHaveAttribute(
      "data-pill",
      "done",
    );
  });
});

test.describe("E-T7e: the conflict choices after a reload (A14; DA-N1 of revision 2)", () => {
  test("a correction refused on a version conflict, the page reloaded: 'Save mine' resends what was SUBMITTED, read from the queued operation", async ({
    context,
  }) => {
    const a = buildTask({
      n: 27,
      title: "Cups",
      goal: { kind: "numeric", minimum: null, maximum: "8", unit: "cups" },
    });
    const detail = `/tasks/${a.taskId}?occurrence=${a.occurrenceId}`;
    const { page, net } = await setup(context, detail, [a]);
    await goOfflineAtBoundary(page);
    await page.getByRole("button", { name: "Correct this day" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("At most").fill("2");
    await dialog.getByRole("button", { name: "Save correction" }).click();
    await expect(dialog).toHaveCount(0);
    net.commandScript.push(() => conflict("conflict"));
    await goOnlineAtBoundary(page);
    await send(page);
    await expect
      .poll(async () => (await draftsOf(page)).map((d) => d.status))
      .toEqual(["version_conflict"]);
    const theirs = (
      a.upserts as Array<{
        kind: string;
        resource: { kind: string; value: Record<string, unknown> };
      }>
    ).find((u) => u.resource.kind === "occurrence");
    if (theirs === undefined) throw new Error("setup: no occurrence upsert");
    const definition = (theirs.resource.value as { definition: object })
      .definition as Record<string, unknown>;
    net.script.push(() => ({
      status: 200,
      body: pageText(
        [
          [
            {
              ...theirs,
              resource: {
                ...theirs.resource,
                version: 2,
                value: {
                  ...theirs.resource.value,
                  definition: {
                    ...definition,
                    goal: {
                      kind: "numeric",
                      minimum: null,
                      maximum: "6",
                      unit: "cups",
                    },
                  },
                },
              },
            },
          ],
        ],
        "cursor-2",
      ),
    }));
    await page.evaluate(() => window.__atlasData?.nudgeSync());
    await expect(page.locator("[data-correction-conflict]")).toBeVisible();
    // Their correction is committed (version 2) before the reload: the version the person is then shown.
    await expect
      .poll(async () => {
        const rows = (await page.evaluate(
          (acct) => window.__atlasData?.rows(acct, "cache"),
          ACCOUNT,
        )) as Array<{ id: string; version: number }>;
        return rows.find((r) => r.id === a.occurrenceId)?.version;
      })
      .toBe(2);
    // A reload: nothing of this page's memory survives; the queued operation does.
    await page.goto(`/__session?route=${encodeURIComponent(detail)}`);
    await page.waitForFunction(
      () => window.__atlasFixture?.session?.booted !== undefined,
    );
    await page.evaluate(() => window.__atlasFixture?.session?.ready);
    await page.waitForFunction(() => window.__atlasData !== undefined);
    const block = page.locator("[data-correction-conflict]");
    await expect(block).toContainText("Someone else corrected this day first");
    // Asserted before it is pressed: a choice missing after the reload is the defect, reported as such (not as a click that times out).
    const saveMine = block.getByRole("button", {
      name: "Save mine on the current version",
    });
    await expect(saveMine).toBeVisible({ timeout: 10_000 });
    await saveMine.click();
    await expect(block).toHaveCount(0);
    await send(page);
    await expect.poll(() => net.commands.length).toBe(2);
    const resent = JSON.parse(net.commands[1]?.body ?? "{}") as {
      command: Record<string, unknown>;
    };
    expect(resent.command).toMatchObject({
      kind: "revise_occurrence",
      id: a.occurrenceId,
      expected_version: 2,
      definition: { goal: { maximum: "2" } },
    });
    expect(net.commands[1]?.key).not.toBe(net.commands[0]?.key);
  });
});

test.describe("E-T9f: an occurrence created offline is followed to its close on Today (A4, A9, A15; R8 of revision 3)", () => {
  // The review's native diagnostic of 14 October 2026 (`.agtx/evidence/web10a-review-3/native-corrected.spec.ts`), kept as a case: a
  // one-off maximum-5 task created and recorded on OFFLINE (both saves stay queued), shown on an explicit day; ONLY the wall clock is set
  // to five seconds before the day's canonical close, and native timers and the five seconds run for real. The time zone is Africa/Abidjan
  // (UTC+0, offered by every engine's zone list). Today must reach Done with nothing but time; the detail is the control.
  for (const surface of ["today", "detail"] as const)
    test(`${surface}: On track five seconds before the close, Done after it, with no event`, async ({
      context,
      page,
    }) => {
      const net = await stubNetwork(context);
      await serveIdentityReads(context);
      await serveTaskReads(context);
      await seedSettled(context);
      await page.goto(`/__session?route=${encodeURIComponent("/tasks/new")}`);
      await page.waitForFunction(
        () => window.__atlasFixture?.session?.booted !== undefined,
      );
      await page.evaluate(() => window.__atlasFixture?.session?.ready);
      await page.waitForFunction(() => window.__atlasData !== undefined);
      await cacheTasks(page, net, []);
      await page
        .getByRole("button", { name: "Start from scratch instead" })
        .click();
      await expect(
        page.getByRole("radio", { name: "Use my defaults (only you)" }),
      ).toBeVisible();
      await goOfflineAtBoundary(page);
      const today = todayUtc();
      await page.getByLabel("Name", { exact: true }).fill("Projected close");
      await page.getByRole("radio", { name: "Only me", exact: true }).check();
      await page.getByRole("radio", { name: "An amount", exact: true }).check();
      await page.getByLabel("At most", { exact: true }).fill("5");
      await page.getByLabel("Unit", { exact: true }).fill("cups");
      await page
        .getByLabel("Time zone", { exact: true })
        .selectOption("Africa/Abidjan");
      await page.getByLabel("Starting", { exact: true }).fill(today);
      await page.getByLabel("Repeats", { exact: true }).selectOption("none");
      await page.getByRole("button", { name: "Save", exact: true }).click();
      await expect(page.locator("[data-record-card]")).toBeVisible();
      await page.getByLabel("Amount (cups)", { exact: true }).fill("2");
      await page
        .locator("[data-record-card]")
        .getByRole("button", { name: "Record", exact: true })
        .click();
      // Both saves stay queued: the day exists on this device only as their projection.
      await expect.poll(async () => (await draftsOf(page)).length).toBe(2);
      const detail = new URL(page.url()).pathname + new URL(page.url()).search;
      const close = Date.parse(`${today}T00:00:00Z`) + 86_400_000;
      await page.clock.setSystemTime(close - 5_000);
      await page.evaluate(() => {
        history.pushState(null, "", "/tasks");
        dispatchEvent(new PopStateEvent("popstate"));
      });
      await page.evaluate(
        (to) => {
          history.pushState(null, "", to);
          dispatchEvent(new PopStateEvent("popstate"));
        },
        surface === "today" ? `/today?day=${today}&tz=UTC` : detail,
      );
      const pill = page.locator(
        surface === "today" ? "[data-today-row]" : "[data-detail-pill]",
      );
      const attribute = surface === "today" ? "data-pill" : "data-detail-pill";
      await expect(pill).toHaveAttribute(attribute, "on_track");
      expect(await page.evaluate(() => Date.now())).toBeLessThan(close);
      // Nothing happens on the page but time.
      await page.waitForFunction((end) => Date.now() >= end, close + 500);
      await expect(pill).toHaveAttribute(attribute, "done", { timeout: 1_000 });
      expect((await draftsOf(page)).map((d) => d.status)).toEqual([
        "queued",
        "queued",
      ]);
    });
});

/**
 * Holds the COMPLETION of the first read-only transaction that reads cached rows BY ID (`get` on `cache`: the related read of Today's local
 * snapshot, never its walk, which reads by index) once `__holdRelated` is set: its rows were read, its result waits. Installed before the
 * page loads (Dexie assigns `oncomplete` per transaction). Another tab can commit while it is held: the engine has finished the read.
 */
const holdRelatedReadInit = (): void => {
  const desc = Object.getOwnPropertyDescriptor(
    IDBTransaction.prototype,
    "oncomplete",
  );
  const get = desc?.get;
  const set = desc?.set;
  if (get === undefined || set === undefined) return;
  const w = window as unknown as {
    __holdRelated?: boolean;
    __heldRelated?: Array<() => void>;
    __states?: string[];
  };
  w.__heldRelated = [];
  w.__states = [];
  const byId = new WeakSet<IDBTransaction>();
  const storeGet = IDBObjectStore.prototype.get;
  IDBObjectStore.prototype.get = function (
    this: IDBObjectStore,
    ...args: Parameters<IDBObjectStore["get"]>
  ) {
    if (this.name === "cache" && this.transaction.mode === "readonly")
      byId.add(this.transaction);
    return storeGet.apply(this, args);
  };
  Object.defineProperty(IDBTransaction.prototype, "oncomplete", {
    configurable: true,
    enumerable: desc?.enumerable ?? true,
    get() {
      return get.call(this);
    },
    set(fn: unknown) {
      const tx = this as IDBTransaction;
      if (typeof fn !== "function" || tx.mode !== "readonly") {
        set.call(this, fn);
        return;
      }
      set.call(this, function (this: IDBTransaction, event: Event) {
        if (w.__holdRelated === true && byId.has(tx)) {
          w.__holdRelated = false;
          w.__heldRelated?.push(() => fn.call(tx, event));
          return;
        }
        return fn.call(tx, event);
      });
    },
  });
};

test.describe("E-T14: another tab commits while Today's local read is between its stages (A1, A18; R9 of revision 3, Q13)", () => {
  for (const between of [true, false])
    test(`between=${between}: tab A never shows the old occurrence with the new title (or the reverse); it ends on what B committed`, async ({
      context,
    }) => {
      const a = buildTask({ n: 30, title: "Cups" });
      const b = buildTask({ n: 31, title: "Plants" });
      const net = await stubNetwork(context);
      await serveIdentityReads(context);
      await serveTaskReads(context);
      await seedSettled(context);
      // Tab B: the fixture leader that commits every page of this account.
      const writer = await bootAt(context, "/tasks");
      await cacheTasks(writer, net, [a]);
      // Tab A: Today, a follower over the same database, its related read held on request.
      const page = await context.newPage();
      await page.addInitScript(holdRelatedReadInit);
      await page.goto(`/__session?route=${encodeURIComponent(todayRoute())}`);
      await page.waitForFunction(
        () => window.__atlasFixture?.session?.booted !== undefined,
      );
      await page.evaluate(() => window.__atlasFixture?.session?.ready);
      await expect(rowOf(page, a.occurrenceId)).toHaveAttribute(
        "data-version",
        "1",
      );
      // Tab A's boot remounts tab B's protected tree, which closes B's registry (and the harness leader's store with it, WEB-09a): once
      // both trees are settled B's leader is started again over the same database.
      await untilTreeSettled(page);
      await untilTreeSettled(writer);
      await startLeader(writer);
      await waitForState(writer, "idle");
      // Every state tab A shows of the row, from now on (no act here: the engine renders every publication).
      await page.evaluate((id) => {
        const w = window as unknown as { __states: string[] };
        const note = () => {
          const el = document.querySelector<HTMLElement>(
            `[data-today-row="${id}"]`,
          );
          const next =
            el === null
              ? "none"
              : `${el.dataset.version}|${el.textContent?.includes("Renamed") ? "new" : "old"}`;
          if (w.__states[w.__states.length - 1] !== next) w.__states.push(next);
        };
        note();
        new MutationObserver(note).observe(document.body, {
          subtree: true,
          childList: true,
          attributes: true,
          characterData: true,
        });
      }, a.occurrenceId);
      const commit = async (revision: number, changes: unknown[]) => {
        net.script.push(() => ({
          status: 200,
          body: JSON.stringify({
            phase: "delta",
            batches: [{ revision, changes }],
            next_cursor: `cursor-${revision}`,
            has_more: false,
          }),
        }));
        await writer.evaluate(() => window.__atlasData?.nudgeSync());
      };
      const renamed = (
        a.upserts as Array<{ resource: Record<string, unknown> }>
      )
        .filter(
          (u) => u.resource.kind === "task" || u.resource.kind === "occurrence",
        )
        .map((u) => ({
          kind: "upsert",
          resource: {
            ...u.resource,
            version: 2,
            ...(u.resource.kind === "task" ? { label: "Renamed" } : {}),
          },
        }));
      await page.evaluate(() => {
        (window as unknown as { __holdRelated: boolean }).__holdRelated = true;
      });
      // An unrelated commit makes tab A read its day again; its related read is held.
      await commit(2, b.upserts);
      await expect
        .poll(() =>
          page.evaluate(
            () =>
              (window as unknown as { __heldRelated: unknown[] }).__heldRelated
                .length,
          ),
        )
        .toBe(1);
      if (between) {
        // While A's related read is held: B commits the occurrence's version 2 and the task's new title in ONE page.
        await commit(3, renamed);
        await expect
          .poll(() =>
            writer.evaluate(
              async (acct) =>
                (
                  (await window.__atlasData?.syncState(acct)) as {
                    applied_revision?: number;
                  } | null
                )?.applied_revision,
              ACCOUNT,
            ),
          )
          .toBe(3);
      }
      await page.evaluate(() => {
        const w = window as unknown as { __heldRelated: Array<() => void> };
        for (const release of w.__heldRelated.splice(0)) release();
      });
      if (!between) await commit(3, renamed);
      await expect(rowOf(page, a.occurrenceId)).toHaveAttribute(
        "data-version",
        "2",
        { timeout: 10_000 },
      );
      await expect(rowOf(page, a.occurrenceId)).toContainText("Renamed");
      const states = await page.evaluate(
        () => (window as unknown as { __states: string[] }).__states,
      );
      expect(states).not.toContain("1|new");
      expect(states).not.toContain("2|old");
      expect(states[states.length - 1]).toBe("2|new");
    });
});

// ---- WEB-10a revision 4 (R9, R10, R11; design assessment C1, C3, C4: J1, E1, D7) ------------------------------------------------------

/** Commits one delta page through the fixture leader of `writer` (the page that holds it). */
async function commitDelta(
  writer: Page,
  net: SyncStub,
  revision: number,
  changes: unknown[],
): Promise<void> {
  net.script.push(() => ({
    status: 200,
    body: JSON.stringify({
      phase: "delta",
      batches: [{ revision, changes }],
      next_cursor: `cursor-r4-${revision}`,
      has_more: false,
    }),
  }));
  await writer.evaluate(() => window.__atlasData?.nudgeSync());
}

test.describe("E-T15: the open full history follows its stream's committed version (A8; R10 of revision 4, J1)", () => {
  for (const opened of [true, false])
    test(`opened=${opened}: a correction committed through sync is shown as the journal says (opened) or in the recent entries (control)`, async ({
      context,
    }) => {
      const at = Math.floor(Date.now() / 1000);
      const entry = (n: number) => ({
        id: `bbbbbbbb-0000-4000-8000-00000000000${n}`,
        evidence: { kind: "quantity", amount: String(n) },
        happened_at: at,
        recorded_by: ACCOUNT,
      });
      const first = entry(1);
      const correction = entry(2);
      const task = buildTask({
        n: 40,
        title: "History",
        goal: { kind: "numeric", minimum: "10", maximum: null, unit: "cups" },
      });
      const progress = (
        task.upserts as Array<{ resource: Record<string, unknown> }>
      ).find((u) => u.resource.kind === "progress")?.resource as Record<
        string,
        unknown
      >;
      Object.assign(progress.value as object, {
        recent_entries: [first],
        entry_count: 1,
      });
      let journal: unknown[] = [
        { ...first, sequence: 1, logical_order: 1, replaces: null },
      ];
      const asked: string[] = [];
      const net = await stubNetwork(context);
      await serveIdentityReads(context);
      await serveTaskReads(context);
      await context.route(
        `**/api/experimental/v1/progress/${task.progressId}/entries?*`,
        (route) => {
          asked.push(
            new URL(route.request().url()).searchParams.get("after") ?? "",
          );
          return route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({ entries: journal, next_after: null }),
          });
        },
      );
      await seedSettled(context);
      const page = await bootAt(
        context,
        `/tasks/${task.taskId}?occurrence=${task.occurrenceId}`,
      );
      await cacheTasks(page, net, [task]);
      const shown = (id: string) => page.locator(`[data-entry="${id}"]`);
      await expect(shown(first.id)).toBeVisible();
      if (opened) {
        await page
          .getByRole("button", { name: "Full history", exact: true })
          .click();
        await expect(
          page.getByRole("heading", { name: "Full history", exact: true }),
        ).toBeVisible();
        expect(asked).toEqual(["0"]);
      }
      journal = [
        { ...first, sequence: 1, logical_order: 1, replaces: null },
        { ...correction, sequence: 2, logical_order: 1, replaces: first.id },
      ];
      await commitDelta(page, net, 2, [
        {
          kind: "upsert",
          resource: {
            ...progress,
            version: 2,
            value: {
              ...(progress.value as object),
              recent_entries: [first, correction],
              entry_count: 2,
            },
          },
        },
      ]);
      await expect(shown(correction.id)).toBeVisible({ timeout: 10_000 });
      if (opened) {
        // From the journal read again after the commit: the correction says what it is and the first entry is marked corrected.
        await expect(shown(correction.id)).toContainText("Correction");
        await expect(shown(first.id)).toContainText("Corrected");
        expect(asked).toEqual(["0", "0"]);
      } else expect(asked).toEqual([]);
    });
});

test.describe("E-T16: an enrolment change pressed again while it is pending sends nothing more (A15; R11 of revision 4, E1)", () => {
  test("Join twice (a double press, then once more): one request with one key, the control disabled with the reason; the answer settles it", async ({
    context,
  }) => {
    const task = buildTask({
      n: 41,
      title: "Shared",
      participation: "everyone",
    });
    const net = await stubNetwork(context);
    await serveIdentityReads(context);
    await serveTaskReads(context);
    let enrolment = { version: 1, active: false, aggregate_consent: true };
    await context.route(
      `**/api/experimental/v1/tasks/${task.taskId}/enrolment`,
      (route) =>
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            ...enrolment,
            policy: { grants: [], exclude_accounts: [] },
          }),
        }),
    );
    const calls: Array<{ key: string | null; body: string | null }> = [];
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    await context.route(
      "**/api/experimental/v1/task-access-commands",
      async (route) => {
        calls.push({
          key: route.request().headers()["idempotency-key"] ?? null,
          body: route.request().postData(),
        });
        await held;
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ revision: 2 }),
        });
      },
    );
    await seedSettled(context);
    const page = await bootAt(
      context,
      `/tasks/${task.taskId}?occurrence=${task.occurrenceId}`,
    );
    await cacheTasks(page, net, [task]);
    const settings = page.locator("[data-enrolment]");
    const join = settings.getByRole("button", {
      name: "Join this task",
      exact: true,
    });
    try {
      await expect(join).toBeEnabled();
      await join.dblclick();
      await expect.poll(() => calls.length).toBe(1);
      await expect(join).toBeDisabled();
      await expect(settings).toContainText("Sending your change…");
      await expect(
        settings.getByRole("checkbox", {
          name: "Count me in the shared total",
        }),
      ).toBeDisabled();
      // Once more, through the page itself: a disabled control dispatches nothing, and the owner refuses a second attempt anyway.
      await page.evaluate(() =>
        document
          .querySelector<HTMLButtonElement>("[data-enrolment] button")
          ?.click(),
      );
      await page.waitForTimeout(0);
      expect(calls).toHaveLength(1);
    } finally {
      enrolment = { version: 2, active: true, aggregate_consent: true };
      release();
    }
    await expect(
      settings.getByRole("button", { name: "Leave this task", exact: true }),
    ).toBeEnabled();
    expect(calls).toHaveLength(1);
    expect(JSON.parse(calls[0]?.body ?? "{}").command).toMatchObject({
      kind: "enrol",
      expected_version: 1,
      active: true,
    });
  });
});

test.describe("E-T17: another tab commits while the task detail's read is between its stages (A1, A18; R9 of revision 4, D7)", () => {
  for (const between of [true, false])
    test(`between=${between}: tab A never shows the new title with the old day (or the reverse); it ends on what B committed`, async ({
      context,
    }) => {
      const a = buildTask({ n: 42, title: "Cups" });
      const b = buildTask({ n: 43, title: "Plants" });
      const net = await stubNetwork(context);
      await serveIdentityReads(context);
      await serveTaskReads(context);
      await seedSettled(context);
      const writer = await bootAt(context, "/tasks");
      await cacheTasks(writer, net, [a]);
      const page = await context.newPage();
      await page.addInitScript(holdRelatedReadInit);
      await page.goto(
        `/__session?route=${encodeURIComponent(`/tasks/${a.taskId}?occurrence=${a.occurrenceId}`)}`,
      );
      await page.waitForFunction(
        () => window.__atlasFixture?.session?.booted !== undefined,
      );
      await page.evaluate(() => window.__atlasFixture?.session?.ready);
      const oldDay = String((a.data.slot as { date: string }).date);
      await expect(page.locator("[data-detail-day]")).toHaveAttribute(
        "data-detail-day",
        oldDay,
      );
      await untilTreeSettled(page);
      await untilTreeSettled(writer);
      await startLeader(writer);
      await waitForState(writer, "idle");
      await page.evaluate(() => {
        const w = window as unknown as { __states: string[] };
        const note = () => {
          const day = document
            .querySelector<HTMLElement>("[data-detail-day]")
            ?.getAttribute("data-detail-day");
          const title = document.querySelector("h1")?.textContent ?? "";
          const next =
            day === undefined || day === null
              ? "none"
              : `${day}|${title.includes("Renamed") ? "new" : "old"}`;
          if (w.__states[w.__states.length - 1] !== next) w.__states.push(next);
        };
        note();
        new MutationObserver(note).observe(document.body, {
          subtree: true,
          childList: true,
          attributes: true,
          characterData: true,
        });
      });
      const newDay = "2001-02-03";
      const renamed = (
        a.upserts as Array<{ resource: Record<string, unknown> }>
      )
        .filter(
          (u) => u.resource.kind === "task" || u.resource.kind === "occurrence",
        )
        .map((u) => ({
          kind: "upsert",
          resource: {
            ...u.resource,
            version: 2,
            ...(u.resource.kind === "task" ? { label: "Renamed" } : {}),
            ...(u.resource.kind === "occurrence"
              ? {
                  value: {
                    ...(u.resource.value as Record<string, unknown>),
                    slot: {
                      ...(u.resource.value as { slot: object }).slot,
                      date: newDay,
                    },
                  },
                }
              : {}),
          },
        }));
      await page.evaluate(() => {
        (window as unknown as { __holdRelated: boolean }).__holdRelated = true;
      });
      // An unrelated commit makes tab A read its detail again; one of its reads by id is held.
      await commitDelta(writer, net, 2, b.upserts);
      await expect
        .poll(() =>
          page.evaluate(
            () =>
              (window as unknown as { __heldRelated: unknown[] }).__heldRelated
                .length,
          ),
        )
        .toBe(1);
      if (between) {
        await commitDelta(writer, net, 3, renamed);
        await expect
          .poll(() =>
            writer.evaluate(
              async (acct) =>
                (
                  (await window.__atlasData?.syncState(acct)) as {
                    applied_revision?: number;
                  } | null
                )?.applied_revision,
              ACCOUNT,
            ),
          )
          .toBe(3);
      }
      await page.evaluate(() => {
        const w = window as unknown as { __heldRelated: Array<() => void> };
        for (const release of w.__heldRelated.splice(0)) release();
      });
      if (!between) await commitDelta(writer, net, 3, renamed);
      await expect(page.locator("[data-detail-day]")).toHaveAttribute(
        "data-detail-day",
        newDay,
        { timeout: 10_000 },
      );
      await expect(page.locator("h1")).toContainText("Renamed");
      const states = await page.evaluate(
        () => (window as unknown as { __states: string[] }).__states,
      );
      expect(states).not.toContain(`${oldDay}|new`);
      expect(states).not.toContain(`${newDay}|old`);
      expect(states[states.length - 1]).toBe(`${newDay}|new`);
    });
});
