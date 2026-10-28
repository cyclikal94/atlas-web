import { type BrowserContext, expect, type Page, test } from "@playwright/test";
import { recordEvidence } from "./data-evidence";
import {
  deltaPage,
  fresh,
  type LeaderNet,
  leaderPage,
  settleElsewhere,
  snapshotPage,
  untilSync,
} from "./data-leader-helpers";
import { serveIdentityReads } from "./data-local-faults";
import {
  ACCOUNT,
  type SyncStub,
  seedSettled,
  stubNetwork,
  untilTreeSettled,
} from "./data-sync-helpers";
import { runAxe } from "./helpers";
import {
  type Answer,
  detailOf,
  held,
  type Reads10c,
  refusal,
  serveTasks10c,
} from "./tasks-10c-helpers";
import {
  type BuiltTask,
  buildTask,
  cacheTasks,
  dailyPage,
  draftsOf,
  goOfflineAtBoundary,
  serveTaskReads,
  type TaskReads,
  todayUtc,
  view,
} from "./tasks-helpers";

/**
 * WEB-10c in Chromium, Firefox and WebKit: the PRODUCTION session and protected tree (`/__session`), the production data controller and
 * REAL IndexedDB and Web Locks; the cache is filled by one `/sync` delta page through the fixture leader. Every server answer here is the
 * stub's (`page.route`): FIXTURE evidence, never integration evidence (the I-M/I-S/I-D/I-TM/I-R cases run against the released backend).
 *
 * E-M1 Today brings a listed task up to date automatically and the banner leaves; E-M2 a reload while the attempt is held in `submitting`
 * (the same key resent) and while the position read is held (one read, no new `materialise`); E-M4 two tabs, one lock, one sequence;
 * E-S1 the streak's `409 materialisation_required` → catch-up → figures; E-S2 the streak at 390 px, tablet and desktop (axe);
 * E-D1 the dependency dialog's modes and focus return at desktop, 390 px (sheet) and tablet; E-TM1 the account's timers, then offline
 * after a reload from the kept copy; E-R1 the rota's consent and order; and (revision 1, review R9) E-D1/E-R1 identity: a preview and a
 * rota answer held across an account switch, with their positive controls; (revision 2) E-M5 a first read that never answers stays
 * stopped across a reload until Try again (R13, DA-M1), and E-TM2 a complete day read retires a cancelled session from the kept copy, so a
 * reload offline does not show it (DA-T1); (revision 3) E-TM3 a complete day read in ANOTHER tab retires what this tab's kept read saw,
 * through the shared store, while one of another day does not (DA-T3, R14). E-M3 (the command path) is not here: the fixture outbox
 * decides `409`s with its own registry, so the page's handler is never asked natively. Its journey (`409 materialisation_required` →
 * catch-up through the day → the SAME key resent → applied) runs in jsdom over the PRODUCTION dispatcher and registry
 * (`catchup-conflicts.test.ts`, revision 1); the first version's claim that the jsdom file covered it was of classification only.
 */
const TODAY = todayUtc();
const yesterday = (n = 1) =>
  new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);

async function bootAt(
  context: BrowserContext,
  route: string,
  viewport?: { width: number; height: number },
): Promise<Page> {
  const page = await context.newPage();
  if (viewport) await page.setViewportSize(viewport);
  await page.goto(`/__session?route=${encodeURIComponent(route)}`);
  await page.waitForFunction(
    () => window.__atlasFixture?.session?.booted !== undefined,
  );
  await page.evaluate(() => window.__atlasFixture?.session?.ready);
  await page.waitForFunction(() => window.__atlasData !== undefined);
  return page;
}

/** A reload of the session page (a plain reload would load the app route, where no fixture harness boots). */
async function reboot(page: Page): Promise<void> {
  const route = new URL(page.url()).pathname + new URL(page.url()).search;
  await page.goto(`/__session?route=${encodeURIComponent(route)}`);
  await page.waitForFunction(
    () => window.__atlasFixture?.session?.booted !== undefined,
  );
  await page.evaluate(() => window.__atlasFixture?.session?.ready);
  await page.waitForFunction(() => window.__atlasData !== undefined);
}

async function setup(
  context: BrowserContext,
  route: string,
  tasks: BuiltTask[],
  arrange: (reads: TaskReads, r10c: Reads10c) => void = () => undefined,
  viewport?: { width: number; height: number },
): Promise<{ page: Page; net: SyncStub; reads: TaskReads; r10c: Reads10c }> {
  const net = await stubNetwork(context);
  await serveIdentityReads(context);
  const reads = await serveTaskReads(context);
  const r10c = await serveTasks10c(context);
  arrange(reads, r10c);
  await seedSettled(context);
  const page = await bootAt(context, route, viewport);
  await cacheTasks(page, net, tasks);
  return { page, net, reads, r10c };
}

const repeating = (n: number, title: string) => {
  const t = buildTask({ n, title, date: yesterday(20) });
  const definition = t.data.definition as { schedule: { repeat: unknown } };
  definition.schedule.repeat = { frequency: "daily", interval: 1 };
  for (const u of t.upserts as Array<{
    resource: { kind: string; value: { schedule?: { repeat: unknown } } };
  }>)
    if (u.resource.kind === "execution" && u.resource.value.schedule)
      u.resource.value.schedule.repeat = { frequency: "daily", interval: 1 };
  return t;
};
const posts = (r: Reads10c) =>
  r.log.filter((e) => e.what === "POST materialise");
const positionReads = (r: Reads10c, task: BuiltTask) =>
  r.log.filter((e) => e.what === `GET /tasks/${task.taskId}`);

test.describe("E-M1: Today catches a listed task up (A1)", () => {
  test("pending → one call → caught up; the banner says it is working, then leaves once Today no longer lists the task", async ({
    context,
  }, info) => {
    const task = repeating(401, "Water the plants");
    let listed = true;
    let caughtUp = false;
    const call = held<void>();
    const { page, r10c } = await setup(
      context,
      `/today?day=${TODAY}&tz=UTC`,
      [task],
      (reads, r) => {
        reads.respond = (q) =>
          dailyPage(
            [view(task)],
            q.scope === "joint" && listed
              ? { pending_tasks: [task.taskId] }
              : {},
          );
        r.position = () =>
          detailOf(
            task,
            caughtUp
              ? { last_date: TODAY, pending: false }
              : { last_date: yesterday(20), pending: true },
          );
        r.materialise = async () => {
          await call.promise;
          caughtUp = true;
          return { status: 200, body: { revision: 7 } };
        };
      },
    );
    const banner = page.locator("[data-pending-tasks]");
    await expect(banner).toHaveAttribute("data-catch-up", "running");
    await expect(banner).toContainText("Bringing 1 repeating task up to date");
    call.release();
    await expect
      .poll(() => positionReads(r10c, task).length)
      .toBeGreaterThanOrEqual(2);
    expect(posts(r10c)).toHaveLength(1);
    expect(posts(r10c)[0]?.body).toEqual({
      kind: "materialise",
      task_id: task.taskId,
      through_date: TODAY,
      limit: 16,
    });
    // The new occurrences arrive by sync; Today's next current answer no longer lists the task.
    listed = false;
    await page.evaluate(() => {
      history.pushState(null, "", "/tasks");
      dispatchEvent(new PopStateEvent("popstate"));
    });
    await page.evaluate((day) => {
      history.pushState(null, "", `/today?day=${day}&tz=UTC`);
      dispatchEvent(new PopStateEvent("popstate"));
    }, TODAY);
    await expect(banner).toHaveCount(0);
    recordEvidence(info, "e-m1", {
      log: r10c.log.map(({ from: _from, ...e }) => e),
    });
  });
});

test.describe("E-M2: a reload in each phase (A3; CM-440)", () => {
  test("held in submitting: the new page resends the stored attempt with the SAME key", async ({
    context,
  }, info) => {
    const task = repeating(402, "Sweep the floor");
    let caughtUp = false;
    const first = held<Answer>();
    let calls = 0;
    const { page, r10c } = await setup(
      context,
      `/today?day=${TODAY}&tz=UTC`,
      [task],
      (reads, r) => {
        reads.respond = (q) =>
          dailyPage(
            [view(task)],
            q.scope === "joint" ? { pending_tasks: [task.taskId] } : {},
          );
        r.position = () =>
          detailOf(
            task,
            caughtUp
              ? { last_date: TODAY, pending: false }
              : { last_date: yesterday(20), pending: true },
          );
        r.materialise = () => {
          calls += 1;
          if (calls === 1) return first.promise;
          caughtUp = true;
          return { status: 200, body: { revision: 8 } };
        };
      },
    );
    await expect.poll(() => posts(r10c).length).toBe(1);
    await reboot(page);
    await expect.poll(() => posts(r10c).length, { timeout: 20_000 }).toBe(2);
    expect(posts(r10c)[1]?.key).toBe(posts(r10c)[0]?.key);
    first.release({ status: 200, body: { revision: 8 } });
    recordEvidence(info, "e-m2-submitting", {
      log: r10c.log.map(({ from: _from, ...e }) => e),
    });
  });

  test("held awaiting the position: after the reload exactly one more position read and no new materialise", async ({
    context,
  }, info) => {
    const task = repeating(403, "Feed the cat");
    let sent = false;
    const hold = held<Answer>();
    let heldOnce = false;
    const { page, r10c } = await setup(
      context,
      `/today?day=${TODAY}&tz=UTC`,
      [task],
      (reads, r) => {
        reads.respond = (q) =>
          dailyPage(
            [view(task)],
            q.scope === "joint" ? { pending_tasks: [task.taskId] } : {},
          );
        r.position = () => {
          if (!sent)
            return detailOf(task, { last_date: yesterday(20), pending: true });
          if (!heldOnce) {
            heldOnce = true;
            return hold.promise;
          }
          return detailOf(task, { last_date: TODAY, pending: false });
        };
        r.materialise = () => {
          sent = true;
          return { status: 200, body: { revision: 9 } };
        };
      },
    );
    await expect.poll(() => heldOnce).toBe(true);
    const postsBefore = posts(r10c).length;
    const readsBefore = positionReads(r10c, task).length;
    await reboot(page);
    await expect
      .poll(() => positionReads(r10c, task).length, { timeout: 20_000 })
      .toBe(readsBefore + 1);
    await page.waitForTimeout(1_500);
    expect(positionReads(r10c, task).length).toBe(readsBefore + 1);
    expect(posts(r10c).length).toBe(postsBefore);
    hold.release(detailOf(task, { last_date: TODAY, pending: false }));
    recordEvidence(info, "e-m2-awaiting", {
      log: r10c.log.map(({ from: _from, ...e }) => e),
    });
  });
});

test.describe("E-M4: two tabs, one lock, one sequence (A3)", () => {
  test("both tabs list the task; only the lock holder sends, the other waits and then finds it done", async ({
    context,
  }, info) => {
    const task = repeating(404, "Empty the dishwasher");
    let listed = false;
    // Three calls bring the task up to date; each answer takes a moment (requests of the account's windows are taken one at a time,
    // so the other tab's reads pass between them).
    const positions = [yesterday(20), yesterday(10), yesterday(2), TODAY];
    let calls = 0;
    const { page, r10c } = await setup(
      context,
      `/today?day=${TODAY}&tz=UTC`,
      [task],
      (reads, r) => {
        reads.respond = (q) =>
          dailyPage(
            [view(task)],
            q.scope === "joint" && listed
              ? { pending_tasks: [task.taskId] }
              : {},
          );
        r.position = () =>
          detailOf(task, {
            last_date: positions[Math.min(calls, 3)] as string,
            pending: calls < 3,
          });
        r.materialise = async () => {
          await new Promise((resolve) => setTimeout(resolve, 700));
          calls += 1;
          return { status: 200, body: { revision: 10 + calls } };
        };
      },
    );
    // Both tabs are shown first: a window that opens while another holds a request waits for it (the session's protocol).
    const second = await bootAt(context, `/today?day=${TODAY}&tz=UTC`);
    await expect(second.locator("[data-today-page]")).toBeVisible();
    listed = true;
    for (const tab of [page, second]) {
      // A tab behind another is hidden to WebKit; each is shown while it is navigated, as a person would.
      await tab.bringToFront();
      await tab.evaluate(() => {
        history.pushState(null, "", "/tasks");
        dispatchEvent(new PopStateEvent("popstate"));
      });
      await expect(tab.locator("[data-task-list]")).toBeVisible();
      await tab.evaluate((day) => {
        history.pushState(null, "", `/today?day=${day}&tz=UTC`);
        dispatchEvent(new PopStateEvent("popstate"));
      }, TODAY);
      await expect(tab.locator("[data-pending-tasks]")).toBeVisible({
        timeout: 15_000,
      });
    }
    await expect.poll(() => calls, { timeout: 20_000 }).toBe(3);
    await second.waitForTimeout(2_000);
    const sent = posts(r10c);
    expect(sent).toHaveLength(3);
    expect(new Set(sent.map((e) => e.key)).size).toBe(3);
    // One tab held the lock for the whole sequence; the other sent nothing.
    expect(new Set(sent.map((e) => e.from)).size).toBe(1);
    recordEvidence(info, "e-m4", {
      log: r10c.log.map(({ from, ...e }) => ({
        ...e,
        tab: from === page ? 1 : from === second ? 2 : 0,
      })),
    });
  });
});

test.describe("E-S1/E-S2: the streak (A5, A6)", () => {
  test("409 materialisation_required → the task is caught up → the figures", async ({
    context,
  }) => {
    const task = repeating(405, "Stretch");
    let caughtUp = false;
    const { page, r10c } = await setup(
      context,
      `/tasks/${task.taskId}/streak`,
      [task],
      (_reads, r) => {
        r.streak = () =>
          caughtUp
            ? { status: 200, body: { current: 3, longest: 5 } }
            : refusal(409, "materialisation_required");
        r.position = () =>
          detailOf(
            task,
            caughtUp
              ? { last_date: TODAY, pending: false }
              : { last_date: yesterday(20), pending: true },
          );
        r.materialise = () => {
          caughtUp = true;
          return { status: 200, body: { revision: 11 } };
        };
      },
    );
    await expect(page.locator("[data-streak-scope=personal]")).toHaveAttribute(
      "data-streak-state",
      "ready",
      { timeout: 20_000 },
    );
    await expect(page.locator("[data-streak-scope=personal]")).toContainText(
      "On a run of 3 days",
    );
    expect(posts(r10c)).toHaveLength(1);
  });

  for (const [width, height] of [
    [390, 844],
    [1180, 820],
    [1440, 900],
  ] as const)
    test(`axe and layout at ${width}×${height} (browser emulation, not a device)`, async ({
      context,
    }) => {
      const task = repeating(406, "Stretch");
      const { page } = await setup(
        context,
        `/tasks/${task.taskId}/streak`,
        [task],
        (_reads, r) => {
          r.streak = () => ({ status: 200, body: { current: 2, longest: 4 } });
        },
        { width, height },
      );
      await expect(page.locator("[data-streak-strip]")).toBeVisible();
      expect(await runAxe(page)).toEqual([]);
      const overflow = await page.evaluate(
        () =>
          document.documentElement.scrollWidth -
          document.documentElement.clientWidth,
      );
      expect(overflow).toBeLessThanOrEqual(0);
    });
});

test.describe("E-D1: what needs doing first (A8, A22)", () => {
  for (const [width, height] of [
    [1440, 900],
    [390, 844],
    [1180, 820],
  ] as const)
    test(`the dialog's ordered list and modes, axe, and focus returning to its opener at ${width}×${height}`, async ({
      context,
    }) => {
      const root = buildTask({ n: 407, title: "Hang the washing" });
      const pre = buildTask({ n: 408, title: "Run the washing machine" });
      const { page } = await setup(
        context,
        `/tasks/${root.taskId}?occurrence=${root.occurrenceId}`,
        [root, pre],
        (_reads, r) => {
          r.preview = () => ({
            status: 200,
            body: {
              token: "d".repeat(64),
              items: [
                {
                  occurrence_id: pre.occurrenceId,
                  task_id: pre.taskId,
                  complete: false,
                  can_complete: true,
                  progress_version: 1,
                },
                {
                  occurrence_id: root.occurrenceId,
                  task_id: root.taskId,
                  complete: false,
                  can_complete: true,
                  progress_version: 1,
                },
              ],
              unavailable: false,
              strict: false,
            },
          });
        },
        { width, height },
      );
      await untilTreeSettled(page);
      const opener = page.getByRole("button", {
        name: "See what needs doing first",
      });
      await expect(opener).toBeVisible();
      await opener.focus();
      await page.keyboard.press("Enter");
      const dialog = page.getByRole("dialog");
      await expect(dialog.locator("[data-dependency-list] li")).toHaveCount(2);
      await expect(
        dialog.locator("[data-dependency-list] li").first(),
      ).toContainText("Run the washing machine");
      await expect(dialog.getByRole("radiogroup")).toBeVisible();
      expect(await runAxe(page)).toEqual([]);
      await page.keyboard.press("Escape");
      await expect(dialog).toHaveCount(0);
      await expect(opener).toBeFocused();
      const overflow = await page.evaluate(
        () =>
          document.documentElement.scrollWidth -
          document.documentElement.clientWidth,
      );
      expect(overflow).toBeLessThanOrEqual(0);
    });
});

test.describe("E-TM1: the account's timers (A15)", () => {
  test("running rows online are kept on this device, and shown offline after a reload; a restricted row has no actions", async ({
    context,
  }, info) => {
    const task = buildTask({
      n: 409,
      title: "Practise piano",
      goal: {
        kind: "numeric",
        minimum: "1800",
        maximum: null,
        unit: "seconds",
      },
    });
    const started = Math.floor(Date.now() / 1000) - 600;
    const { page, r10c } = await setup(
      context,
      "/tasks/timers",
      [task],
      (_reads, r) => {
        r.accountTimers = (q) =>
          q.state === "running"
            ? {
                status: 200,
                body: {
                  items: [
                    {
                      access: "available",
                      id: "cccccccc-0000-4000-8000-000000000101",
                      occurrence_id: task.occurrenceId,
                      task_id: task.taskId,
                      task_title: "Practise piano",
                      slot_date: TODAY,
                      started_at: started,
                      stopped_at: null,
                      version: 2,
                      can_modify: true,
                    },
                    {
                      access: "restricted",
                      id: "cccccccc-0000-4000-8000-000000000102",
                      started_at: started - 60,
                      stopped_at: null,
                      version: 1,
                    },
                  ],
                  next_after: null,
                },
              }
            : { status: 200, body: { items: [], next_after: null } };
      },
    );
    const live = page.locator(
      '[data-account-timer="cccccccc-0000-4000-8000-000000000101"]',
    );
    await expect(live).toContainText("Practise piano");
    await expect(
      page
        .locator('[data-account-timer="cccccccc-0000-4000-8000-000000000102"]')
        .getByRole("button"),
    ).toHaveCount(0);
    await expect
      .poll(() =>
        page.evaluate(async (acct) => {
          const rows = (await window.__atlasData?.rows(
            acct,
            "sync_state",
          )) as Array<{ timer_copy?: unknown }>;
          return rows?.[0]?.timer_copy != null;
        }, ACCOUNT),
      )
      .toBe(true);
    await reboot(page);
    await goOfflineAtBoundary(page);
    await page.evaluate(() => {
      history.pushState(null, "", "/tasks");
      dispatchEvent(new PopStateEvent("popstate"));
    });
    await expect(page.locator("[data-task-list]")).toBeVisible();
    await page.evaluate(() => {
      history.pushState(null, "", "/tasks/timers");
      dispatchEvent(new PopStateEvent("popstate"));
    });
    await expect(page.locator("[data-timers-running=offline]")).toBeVisible();
    await expect(live).toContainText("Practise piano");
    await expect(page.locator("[data-timers-history]")).toContainText(
      "Session history is shown when you're online.",
    );
    recordEvidence(info, "e-tm1", {
      log: r10c.log.map(({ from: _from, ...e }) => e),
    });
  });
});

test.describe("E-R1: the rota (A17)", () => {
  test("consent is sent online (never queued) and the order dialog projects the turns; axe", async ({
    context,
  }) => {
    let consented = false;
    const task = repeating(410, "Take the bins out");
    (task.data.definition as { participation: string }).participation =
      "anyone";
    for (const u of task.upserts as Array<{
      resource: { kind: string; value: Record<string, unknown> };
    }>) {
      if (u.resource.kind === "execution")
        u.resource.value.participation = "anyone";
      if (u.resource.kind === "occurrence") {
        (
          u.resource.value.definition as { participation: string }
        ).participation = "anyone";
        u.resource.value.rota = {
          revision: 1,
          ordinal: 0,
          account_id: ACCOUNT,
        };
      }
    }
    const { page, r10c } = await setup(
      context,
      `/tasks/${task.taskId}?occurrence=${task.occurrenceId}`,
      [task],
      (_reads, r) => {
        r.enrolment = () => ({
          status: 200,
          body: {
            version: 1,
            active: true,
            aggregate_consent: true,
            policy: { grants: [], exclude_accounts: [] },
          },
        });
        r.rota = () => ({
          status: 200,
          body: {
            version: 1,
            participants: [ACCOUNT],
            consent_version: consented ? 3 : 2,
            accepted: consented,
            eligible_participants: [ACCOUNT],
          },
        });
        r.access = ({ command }) => {
          if (command.kind === "rota_consent")
            consented = command.accepted === true;
          return { status: 200, body: { revision: 4 } };
        };
      },
    );
    await expect(page.locator("[data-rota-turn]")).toContainText(
      "This turn: You",
    );
    const consent = page.getByLabel("Take turns on this task");
    await expect(consent).toBeEnabled();
    // The box follows the server: it is ticked once the read after the answer says so.
    await consent.click();
    await expect
      .poll(() => r10c.log.filter((e) => e.what === "POST rota_consent").length)
      .toBe(1);
    await expect(consent).toBeChecked();
    expect(await draftsOf(page)).toEqual([]);
    await page.getByRole("button", { name: "Turn order…" }).click();
    await expect(page.locator("[data-rota-dialog]")).toBeVisible();
    await expect(page.locator("[data-rota-projected]").first()).toBeVisible();
    expect(await runAxe(page)).toEqual([]);
  });
});

// ---- revision 1 (review R9, A18): identity schedules in the real engines -----------------------------------------------------------

/**
 * A18 (CM-384) in the real engines, with the PRODUCTION leader (`?leader=production`): one task is held by two accounts (shared), the first
 * account's answer is HELD, another account signs in in another tab (this page follows it: the protected tree and its database move), and
 * the held answer is delivered afterwards. It is never shown for the account now displayed, whose own answer is. FIXTURE evidence.
 */
const VIEWED = "22222222-2222-4222-8222-222222222222";
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

/** The page of `task` under the production leader, both accounts' caches holding it; `arrange` answers the 10c reads. */
async function sharedDetail(
  context: BrowserContext,
  task: BuiltTask,
  arrange: (r: Reads10c, net: LeaderNet) => void,
) {
  const net = await fresh(context);
  net.answer = (call) =>
    call.cursor === null
      ? snapshotPage(task.upserts, "delta-0", false)
      : deltaPage([], call.cursor);
  await serveTaskReads(context);
  const r10c = await serveTasks10c(context);
  arrange(r10c, net);
  const page = await leaderPage(context, net, "one", undefined, {
    route: `/tasks/${task.taskId}?occurrence=${task.occurrenceId}`,
  });
  await expect(page.locator(`[data-task-detail="${task.taskId}"]`)).toBeVisible(
    { timeout: 20_000 },
  );
  return { net, r10c, page };
}

/**
 * Another tab signs in as VIEWED; this page follows (its protected tree and database move, and it shows Today, as a switch does), its
 * database is brought up to date for VIEWED, and the same task's detail is opened again, now for VIEWED.
 */
async function switchToViewed(
  context: BrowserContext,
  net: LeaderNet,
  page: Page,
  task: BuiltTask,
): Promise<void> {
  net.identity = { account: VIEWED, session: "s2" };
  await settleElsewhere(context, settledAt(VIEWED, 2, "s2"));
  const synced = await untilSync(
    page,
    (state) => state?.cache_status === "valid",
    VIEWED,
  );
  expect(synced?.cache_status).toBe("valid");
  await page.evaluate((path) => {
    history.pushState(null, "", path);
    dispatchEvent(new PopStateEvent("popstate"));
  }, `/tasks/${task.taskId}?occurrence=${task.occurrenceId}`);
  await expect(page.locator(`[data-task-detail="${task.taskId}"]`)).toBeVisible(
    { timeout: 20_000 },
  );
}

test.describe("E-D1 identity (A18; CM-384): a preview held across an account switch", () => {
  test("the previous account's preview, delivered after another account is displayed, is never shown; the new account's own is", async ({
    context,
  }) => {
    const root = buildTask({ n: 440, title: "Hang the washing" });
    const preRoot = buildTask({ n: 441, title: "Run the washing machine" });
    const hold = held<void>();
    const asked: string[] = [];
    const theirs = (r: BuiltTask): Answer => ({
      status: 200,
      body: {
        token: "e".repeat(64),
        items: [
          {
            occurrence_id: preRoot.occurrenceId,
            task_id: preRoot.taskId,
            complete: false,
            can_complete: true,
            progress_version: 1,
          },
          {
            occurrence_id: r.occurrenceId,
            task_id: r.taskId,
            complete: false,
            can_complete: true,
            progress_version: 1,
          },
        ],
        unavailable: false,
        strict: false,
      },
    });
    const mine = (r: BuiltTask): Answer => ({
      status: 200,
      body: {
        token: "f".repeat(64),
        items: [
          {
            occurrence_id: r.occurrenceId,
            task_id: r.taskId,
            complete: false,
            can_complete: true,
            progress_version: null,
          },
        ],
        unavailable: false,
        strict: false,
      },
    });
    let viewedAnswered = false;
    const both = {
      ...root,
      upserts: [...root.upserts, ...preRoot.upserts],
    } as BuiltTask;
    const { net, page } = await sharedDetail(context, both, (r, n) => {
      r.preview = async () => {
        const who = n.identity.account;
        asked.push(who);
        if (who === ACCOUNT) {
          await hold.promise;
          return theirs(root);
        }
        viewedAnswered = true;
        return mine(root);
      };
    });
    await expect.poll(() => asked.includes(ACCOUNT)).toBe(true);
    await switchToViewed(context, net, page, root);
    // The new account's detail is composed from its own answer before the late one is delivered.
    await expect(page.locator("[data-dependencies-none]")).toBeVisible({
      timeout: 20_000,
    });
    expect(viewedAnswered).toBe(true);
    hold.release();
    // Long enough for a late answer to be composed and shown, were it applied.
    await page.waitForTimeout(1_500);
    await expect(page.locator("[data-dependencies-none]")).toBeVisible();
    await expect(page.locator("[data-dependencies-progress]")).toHaveCount(0);
    await expect(page.locator("[data-dependencies]")).not.toContainText(
      "Run the washing machine",
    );
  });
});

test.describe("E-D1/E-R1 identity controls (A18): the same held answers, delivered BEFORE the switch, are shown for their own account", () => {
  test("the held preview, released while its account is displayed, names what the day waits for", async ({
    context,
  }) => {
    const root = buildTask({ n: 443, title: "Hang the washing" });
    const pre = buildTask({ n: 444, title: "Run the washing machine" });
    const hold = held<void>();
    const both = {
      ...root,
      upserts: [...root.upserts, ...pre.upserts],
    } as BuiltTask;
    const { page } = await sharedDetail(context, both, (r) => {
      r.preview = async () => {
        await hold.promise;
        return {
          status: 200,
          body: {
            token: "e".repeat(64),
            items: [
              {
                occurrence_id: pre.occurrenceId,
                task_id: pre.taskId,
                complete: false,
                can_complete: true,
                progress_version: 1,
              },
              {
                occurrence_id: root.occurrenceId,
                task_id: root.taskId,
                complete: false,
                can_complete: true,
                progress_version: 1,
              },
            ],
            unavailable: false,
            strict: false,
          },
        };
      };
    });
    hold.release();
    await expect(page.locator("[data-dependencies-progress]")).toContainText(
      "Run the washing machine",
      { timeout: 20_000 },
    );
  });

  test("the held rota, released while its account is displayed, shows its consent", async ({
    context,
  }) => {
    const task = buildTask({
      n: 445,
      title: "Take the bins out",
      participation: "anyone",
    });
    const hold = held<void>();
    const { page } = await sharedDetail(context, task, (r) => {
      r.enrolment = () => ({
        status: 200,
        body: {
          version: 1,
          active: true,
          aggregate_consent: true,
          policy: { grants: [], exclude_accounts: [] },
        },
      });
      r.rota = async () => {
        await hold.promise;
        return {
          status: 200,
          body: {
            version: 3,
            participants: [ACCOUNT],
            consent_version: 4,
            accepted: true,
            eligible_participants: [ACCOUNT],
          },
        };
      };
    });
    hold.release();
    await expect(page.getByLabel("Take turns on this task")).toBeChecked({
      timeout: 20_000,
    });
  });
});

test.describe("E-R1 identity (A18; CM-384): a rota answer held across an account switch", () => {
  test("the previous account's rota (its consent and order), delivered after another account is displayed, is never shown", async ({
    context,
  }) => {
    const task = buildTask({
      n: 442,
      title: "Take the bins out",
      participation: "anyone",
    });
    const hold = held<void>();
    const asked: string[] = [];
    const { net, page } = await sharedDetail(context, task, (r, n) => {
      r.enrolment = () => ({
        status: 200,
        body: {
          version: 1,
          active: true,
          aggregate_consent: true,
          policy: { grants: [], exclude_accounts: [] },
        },
      });
      r.rota = async () => {
        const who = n.identity.account;
        asked.push(who);
        if (who === ACCOUNT) {
          await hold.promise;
          return {
            status: 200,
            body: {
              version: 3,
              participants: [ACCOUNT, VIEWED],
              consent_version: 4,
              accepted: true,
              eligible_participants: [ACCOUNT, VIEWED],
            },
          };
        }
        return {
          status: 200,
          body: {
            version: 1,
            participants: [],
            consent_version: 1,
            accepted: false,
            eligible_participants: [],
          },
        };
      };
    });
    await expect.poll(() => asked.includes(ACCOUNT)).toBe(true);
    await switchToViewed(context, net, page, task);
    const consent = page.getByLabel("Take turns on this task");
    await expect(consent).toBeEnabled({ timeout: 20_000 });
    await expect(consent).not.toBeChecked();
    expect(asked).toContain(VIEWED);
    hold.release();
    await page.waitForTimeout(1_500);
    await expect(consent).not.toBeChecked();
  });
});

test.describe("E-M5: a first read that never answers stays stopped across a reload (revision 2: R13, DA-M1)", () => {
  test("three uncertain first reads stop it; after a reload Today reads nothing more for it; Try again reads again and it is caught up", async ({
    context,
  }, info) => {
    const task = repeating(405, "Sweep the porch");
    let answering = false;
    const { page, r10c } = await setup(
      context,
      `/today?day=${TODAY}&tz=UTC`,
      [task],
      (reads, r) => {
        reads.respond = (q) =>
          dailyPage(
            [view(task)],
            q.scope === "joint" ? { pending_tasks: [task.taskId] } : {},
          );
        r.position = () =>
          answering
            ? detailOf(task, { last_date: TODAY, pending: false })
            : refusal(503, "unavailable");
      },
    );
    const stop = page.locator("[data-catch-up-stopped]");
    await expect(stop).toHaveAttribute("data-catch-up-stopped", "unreachable", {
      timeout: 20_000,
    });
    expect(positionReads(r10c, task)).toHaveLength(3);
    // The stop is the task's record, not this page's memory: a reload shows it and asks nothing.
    await reboot(page);
    await expect(page.locator("[data-catch-up-stopped]")).toHaveAttribute(
      "data-catch-up-stopped",
      "unreachable",
      { timeout: 15_000 },
    );
    await page.waitForTimeout(3_000);
    expect(positionReads(r10c, task)).toHaveLength(3);
    expect(posts(r10c)).toHaveLength(0);
    answering = true;
    await page
      .locator("[data-pending-tasks]")
      .getByRole("button", { name: "Try again" })
      .click();
    await expect(page.locator("[data-catch-up-stopped]")).toHaveCount(0, {
      timeout: 15_000,
    });
    // The stop leaves as soon as Try again lifts it (under the lock); its fresh read follows: wait for it, then nothing more.
    await expect
      .poll(() => positionReads(r10c, task).length, { timeout: 15_000 })
      .toBe(4);
    await page.waitForTimeout(1_000);
    expect(positionReads(r10c, task)).toHaveLength(4);
    expect(posts(r10c)).toHaveLength(0);
    recordEvidence(info, "e-m5", {
      log: r10c.log.map(({ from: _from, ...e }) => e),
    });
  });
});

test.describe("E-TM2: a complete day read corrects the kept copy (revision 2: DA-T1)", () => {
  test("a session the account list kept, then not listed by its day's complete read (cancelled), is not shown offline after a reload", async ({
    context,
  }, info) => {
    const task = buildTask({
      n: 410,
      title: "Practise piano",
      goal: {
        kind: "numeric",
        minimum: "1800",
        maximum: null,
        unit: "seconds",
      },
    });
    const id = "cccccccc-0000-4000-8000-000000000111";
    const started = Math.floor(Date.now() / 1000) - 600;
    const { page, r10c } = await setup(
      context,
      "/tasks/timers",
      [task],
      (_reads, r) => {
        r.accountTimers = (q) => ({
          status: 200,
          body: {
            items:
              q.state === "running"
                ? [
                    {
                      access: "available",
                      id,
                      occurrence_id: task.occurrenceId,
                      task_id: task.taskId,
                      task_title: "Practise piano",
                      slot_date: TODAY,
                      started_at: started,
                      stopped_at: null,
                      version: 2,
                      can_modify: true,
                    },
                  ]
                : [],
            next_after: null,
          },
        });
        // The day's own read: the session was cancelled elsewhere since (the server omits it).
        r.timers = () => ({
          status: 200,
          body: { items: [], next_after: null },
        });
      },
    );
    const copied = () =>
      page.evaluate(async (acct) => {
        const rows = (await window.__atlasData?.rows(
          acct,
          "sync_state",
        )) as Array<{ timer_copy?: { running?: Array<{ id: string }> } }>;
        return (rows?.[0]?.timer_copy?.running ?? []).map((r) => r.id);
      }, ACCOUNT);
    await expect.poll(copied).toEqual([id]);
    await page.evaluate((path) => {
      history.pushState(null, "", path);
      dispatchEvent(new PopStateEvent("popstate"));
    }, `/tasks/${task.taskId}?occurrence=${task.occurrenceId}`);
    await expect(page.locator("[data-timer-block]")).toHaveAttribute(
      "data-timer-block",
      "idle",
    );
    await expect.poll(copied).toEqual([]);
    await reboot(page);
    await goOfflineAtBoundary(page);
    await page.evaluate(() => {
      history.pushState(null, "", "/tasks");
      dispatchEvent(new PopStateEvent("popstate"));
    });
    await expect(page.locator("[data-task-list]")).toBeVisible();
    await page.evaluate(() => {
      history.pushState(null, "", "/tasks/timers");
      dispatchEvent(new PopStateEvent("popstate"));
    });
    await expect(page.locator("[data-timers-running=offline]")).toBeVisible();
    await expect(page.locator("[data-timers-running]")).toContainText(
      "Nothing is running.",
    );
    await expect(page.locator(`[data-account-timer="${id}"]`)).toHaveCount(0);
    recordEvidence(info, "e-tm2", {
      log: r10c.log.map(({ from: _from, ...e }) => e),
    });
  });
});

test.describe("E-TM3: a day read in another tab retires what this tab's kept read saw (revision 3: DA-T3, R14)", () => {
  for (const which of ["the same day", "another day (control)"] as const)
    test(`tab B's complete empty read of ${which}; tab A offline then shows the session ${which === "the same day" ? "not running" : "still running"}`, async ({
      context,
    }, info) => {
      const goal = {
        kind: "numeric",
        minimum: "1800",
        maximum: null,
        unit: "seconds",
      } as const;
      const here = buildTask({ n: 411, title: "Practise piano", goal });
      const other = buildTask({ n: 412, title: "Practise scales", goal });
      const id = "cccccccc-0000-4000-8000-000000000112";
      let cancelled = false;
      const detail = (task: BuiltTask) =>
        `/tasks/${task.taskId}?occurrence=${task.occurrenceId}`;
      const { page, r10c } = await setup(
        context,
        detail(here),
        [here, other],
        (_reads, r) => {
          r.timers = (q) => ({
            status: 200,
            body: {
              items:
                q.occurrenceId === here.occurrenceId && !cancelled
                  ? [
                      {
                        id,
                        occurrence_id: here.occurrenceId,
                        started_at: Math.floor(Date.now() / 1000) - 600,
                        stopped_at: null,
                        version: 2,
                      },
                    ]
                  : [],
              next_after: null,
            },
          });
        },
      );
      await expect(page.locator("[data-timer-block]")).toHaveAttribute(
        "data-timer-block",
        "running",
      );
      // The session is cancelled elsewhere; tab B reads a day.
      // The place in the observation order the copy's corrections have reached (moved by every applied day read).
      const fence = () =>
        page.evaluate(async (acct) => {
          const rows = (await window.__atlasData?.rows(
            acct,
            "sync_state",
          )) as Array<{ timer_fence?: number }>;
          return rows?.[0]?.timer_fence ?? 0;
        }, ACCOUNT);
      await expect.poll(fence).toBeGreaterThan(0);
      const before = await fence();
      cancelled = true;
      const target = which === "the same day" ? here : other;
      const second = await bootAt(context, detail(target));
      await expect(second.locator("[data-timer-block]")).toHaveAttribute(
        "data-timer-block",
        "idle",
      );
      // Tab B's read has been applied to the shared store (inspected through tab A, whose store handle the fixture exposes).
      await expect.poll(fence).toBeGreaterThan(before);
      // Tab A, offline: its kept read of the day is judged against what tab B recorded.
      await page.bringToFront();
      await goOfflineAtBoundary(page);
      await expect(page.locator("[data-timer-block]")).toHaveAttribute(
        "data-timer-block",
        which === "the same day" ? "idle" : "running",
      );
      recordEvidence(info, "e-tm3", {
        which,
        log: r10c.log.map(({ from, ...e }) => ({
          ...e,
          tab: from === page ? 1 : from === second ? 2 : 0,
        })),
      });
    });
});

/** The shared store of the account, read or written through `page` (the tab whose session holds the store handle). */
const syncOf = (page: Page) =>
  page.evaluate(async (acct) => {
    const rows = (await window.__atlasData?.rows(acct, "sync_state")) as Array<{
      timer_fence?: number;
      timer_scopes?: Record<string, { order?: number }>;
      timer_copy?: { running?: Array<{ id: string }> };
    }>;
    return rows?.[0] ?? {};
  }, ACCOUNT);

test.describe("E-TM4: another tab's later day read retires the live account row (revision 4: R19)", () => {
  // The fixture's session protocol takes the account's requests one at a time across windows, so a read issued earlier cannot be held
  // while a later one is answered here (that inversion, REVIEW4 T5, is the deterministic jsdom case). What a real second tab CAN do is
  // publish a later complete read of a day while this tab shows its account list online: the same authority rule applies to live rows.
  for (const which of ["the same day", "another day (control)"] as const)
    test(`tab B's complete empty read of ${which}; tab A's live list ${which === "the same day" ? "no longer offers" : "still offers"} the session`, async ({
      context,
    }, info) => {
      const goal = {
        kind: "numeric",
        minimum: "1800",
        maximum: null,
        unit: "seconds",
      } as const;
      const here = buildTask({ n: 413, title: "Practise piano", goal });
      const other = buildTask({ n: 414, title: "Practise scales", goal });
      const id = "cccccccc-0000-4000-8000-000000000113";
      const detail = (task: BuiltTask) =>
        `/tasks/${task.taskId}?occurrence=${task.occurrenceId}`;
      const { page, r10c } = await setup(
        context,
        "/tasks/timers",
        [here, other],
        (_reads, r) => {
          r.accountTimers = (q) => ({
            status: 200,
            body: {
              items:
                q.state === "running"
                  ? [
                      {
                        access: "available",
                        id,
                        occurrence_id: here.occurrenceId,
                        task_id: here.taskId,
                        task_title: "Practise piano",
                        slot_date: TODAY,
                        started_at: Math.floor(Date.now() / 1000) - 600,
                        stopped_at: null,
                        version: 2,
                        can_modify: true,
                      },
                    ]
                  : [],
              next_after: null,
            },
          });
          // The session was cancelled elsewhere since: every day read lists nothing.
          r.timers = () => ({
            status: 200,
            body: { items: [], next_after: null },
          });
        },
      );
      const row = page.locator(`[data-account-timer="${id}"]`);
      await expect(row.getByRole("button", { name: "Stop" })).toBeVisible();
      const fence = async () => (await syncOf(page)).timer_fence ?? 0;
      await expect.poll(fence).toBeGreaterThan(0);
      const before = await fence();
      const target = which === "the same day" ? here : other;
      const second = await bootAt(context, detail(target));
      await expect(second.locator("[data-timer-block]")).toHaveAttribute(
        "data-timer-block",
        "idle",
      );
      // Tab B's read has been applied to the shared store (inspected through tab A).
      await expect.poll(fence).toBeGreaterThan(before);
      await page.bringToFront();
      if (which === "the same day") await expect(row).toHaveCount(0);
      else {
        await page.waitForTimeout(1_000);
        await expect(row.getByRole("button", { name: "Stop" })).toBeVisible();
      }
      recordEvidence(info, "e-tm4", {
        which,
        log: r10c.log.map(({ from, ...e }) => ({
          ...e,
          tab: from === page ? 1 : from === second ? 2 : 0,
        })),
      });
    });
});

test.describe("E-M6: two tabs press Try again on the same stop (revision 4: R20)", () => {
  test("both presses are made while the account's lock is busy; the stop gets ONE fresh budget: three sends with the stored key, not six", async ({
    context,
  }, info) => {
    const stuck = repeating(415, "Water the plants");
    const busy = repeating(416, "Feed the cat");
    const key = "eeeeeeee-0000-4000-8000-000000000415";
    let freeBusy: () => void = () => undefined;
    const busyHeld = new Promise<void>((r) => {
      freeBusy = r;
    });
    const { page, r10c } = await setup(
      context,
      "/tasks",
      [stuck, busy],
      (reads, r) => {
        reads.respond = (q) =>
          dailyPage(
            [view(stuck), view(busy)],
            q.scope === "joint"
              ? { pending_tasks: [busy.taskId, stuck.taskId] }
              : {},
          );
        r.position = async ({ taskId }) => {
          // The other task's catch-up keeps the lock busy until it is freed.
          if (taskId === busy.taskId) {
            await busyHeld;
            return detailOf(busy, { last_date: TODAY, pending: false });
          }
          return detailOf(stuck, { last_date: yesterday(10), pending: true });
        };
        r.materialise = () => refusal(500, "internal");
      },
    );
    // The stuck task's sequence stopped with an uncertain attempt (another page's, or before a reload).
    await page.evaluate(
      async ([acct, row]) => {
        await window.__atlasData?.put(acct, "materialise_sequences", [row]);
      },
      [
        ACCOUNT,
        {
          task_id: stuck.taskId,
          through_date: TODAY,
          sequence_generation: "aaaaaaaa-0000-4000-8000-000000000415",
          phase: "stopped",
          attempt: {
            key,
            body: JSON.stringify({
              kind: "materialise",
              limit: 16,
              task_id: stuck.taskId,
              through_date: TODAY,
            }),
          },
          read_seq: 0,
          successful_calls: 0,
          last_known_position: yesterday(10),
          started_at: 1,
          read_failures: 3,
          stop: { reason: "unreachable" },
          trigger: "daily",
        },
      ] as const,
    );
    // Tab 2 shows the stop on the task's own detail before anything is held (a window waits for another's request in flight).
    const second = await bootAt(
      context,
      `/tasks/${stuck.taskId}?occurrence=${stuck.occurrenceId}`,
    );
    const tryAgain = (tab: Page) =>
      tab
        .locator(`[data-catch-up-task="${stuck.taskId}"]`)
        .getByRole("button", { name: "Try again" });
    await expect(tryAgain(second)).toBeVisible({ timeout: 15_000 });
    // Tab 1 opens Today: it catches the other task up, and that work keeps the account's lock (its position read is held).
    await page.bringToFront();
    await page.evaluate((day) => {
      history.pushState(null, "", `/today?day=${day}&tz=UTC`);
      dispatchEvent(new PopStateEvent("popstate"));
    }, TODAY);
    await expect(tryAgain(page)).toBeVisible({ timeout: 15_000 });
    await expect
      .poll(() => positionReads(r10c, busy).length, { timeout: 15_000 })
      .toBeGreaterThan(0);
    // Both presses are made on the stop as shown, while the lock is busy.
    for (const tab of [page, second]) {
      await tab.bringToFront();
      await tryAgain(tab).click();
    }
    expect(posts(r10c)).toHaveLength(0);
    freeBusy();
    await expect
      .poll(() => posts(r10c).length, { timeout: 30_000 })
      .toBeGreaterThanOrEqual(3);
    // Both tabs have had the lock since (each finished its queue): no fourth send follows.
    await second.waitForTimeout(8_000);
    const sent = posts(r10c);
    expect(sent.map((e) => e.key)).toEqual([key, key, key]);
    recordEvidence(info, "e-m6", {
      log: r10c.log.map(({ from, ...e }) => ({
        ...e,
        tab: from === page ? 1 : from === second ? 2 : 0,
      })),
    });
  });
});

test.describe("E-M7: a stop behind many other tasks' rows (revision 4: R21)", () => {
  for (const others of [100, 0] as const)
    test(`${others} other tasks' stops sort first: Today shows this task's stop with its reason and Try again, and sends nothing`, async ({
      context,
    }, info) => {
      const task = repeating(417, "Water the plants");
      const { page, r10c } = await setup(
        context,
        "/tasks",
        [task],
        (reads, r) => {
          reads.respond = (q) =>
            dailyPage(
              [view(task)],
              q.scope === "joint" ? { pending_tasks: [task.taskId] } : {},
            );
          r.position = () =>
            detailOf(task, { last_date: yesterday(10), pending: true });
        },
      );
      const stop = {
        through_date: TODAY,
        sequence_generation: "g",
        phase: "stopped",
        attempt: null,
        read_seq: 1,
        successful_calls: 8,
        last_known_position: yesterday(10),
        started_at: 1,
        read_failures: 0,
        stop: { reason: "bound" },
        trigger: "daily",
      };
      const rows = [
        ...Array.from({ length: others }, (_, i) => ({
          ...stop,
          task_id: `00000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`,
        })),
        { ...stop, task_id: task.taskId },
      ];
      expect(rows.every((r) => r.task_id <= task.taskId)).toBe(true);
      await page.evaluate(
        async ([acct, seeded]) => {
          await window.__atlasData?.put(acct, "materialise_sequences", seeded);
        },
        [ACCOUNT, rows] as const,
      );
      await page.evaluate((day) => {
        history.pushState(null, "", `/today?day=${day}&tz=UTC`);
        dispatchEvent(new PopStateEvent("popstate"));
      }, TODAY);
      const notice = page.locator(`[data-catch-up-task="${task.taskId}"]`);
      await expect(notice).toBeVisible({ timeout: 15_000 });
      await expect(notice).toHaveAttribute("data-catch-up-stopped", "bound");
      await expect(
        notice.getByRole("button", { name: "Try again" }),
      ).toBeEnabled();
      expect(posts(r10c)).toHaveLength(0);
      recordEvidence(info, "e-m7", {
        others,
        log: r10c.log.map(({ from: _from, ...e }) => e),
      });
    });
});

// Tolerant: a moment in which the page's tree remounts has no open store (the read answers nothing then; a poll asks again).
const syncEnded = (page: Page) =>
  page
    .evaluate(async (acct) => {
      const rows = (await window.__atlasData?.rows(
        acct,
        "sync_state",
      )) as Array<{
        timer_copy?: unknown;
        timer_ended?: { ids?: Array<[string, number]> };
      }>;
      return {
        copy: rows?.[0]?.timer_copy != null,
        ended: (rows?.[0]?.timer_ended?.ids ?? []).map(([id]) => id),
      };
    }, ACCOUNT)
    .catch(() => ({ copy: false, ended: [] as string[] }));

test.describe("E-TM5: a session the account's history listed finished stays finished offline after a reload (revision 5: R23)", () => {
  for (const listed of [true, false] as const)
    test(`the history ${listed ? "lists" : "does not list (control)"} the copied session stopped: offline after a reload it is ${listed ? "not" : "still"} shown running`, async ({
      context,
    }, info) => {
      const task = buildTask({
        n: 418,
        title: "Practise piano",
        goal: {
          kind: "numeric",
          minimum: "1800",
          maximum: null,
          unit: "seconds",
        },
      });
      const id = "cccccccc-0000-4000-8000-000000000118";
      const row = (stopped: number | null) => ({
        access: "available",
        id,
        occurrence_id: task.occurrenceId,
        task_id: task.taskId,
        task_title: "Practise piano",
        slot_date: TODAY,
        started_at: Math.floor(Date.now() / 1000) - 600,
        stopped_at: stopped,
        version: stopped === null ? 2 : 3,
        can_modify: stopped === null,
      });
      const { page, r10c } = await setup(
        context,
        "/tasks/timers",
        [task],
        (_reads, r) => {
          r.accountTimers = (q) => ({
            status: 200,
            body: {
              items:
                q.state === "running"
                  ? [row(null)]
                  : listed
                    ? [row(Math.floor(Date.now() / 1000) - 30)]
                    : [],
              next_after: null,
            },
          });
        },
      );
      await expect(page.locator("[data-timers-history=ready]")).toBeVisible();
      await expect.poll(async () => (await syncEnded(page)).copy).toBe(true);
      // Online both builds hide a session this page's own history lists stopped; what is under test is what survives the reload.
      // (Representation-neutral precondition: no wait on the new finished record; a moment for the page's writes to land.)
      if (listed)
        await expect(
          page.locator(`[data-timers-running] [data-account-timer="${id}"]`),
        ).toHaveCount(0);
      await page.waitForTimeout(1_000);
      await reboot(page);
      await goOfflineAtBoundary(page);
      await page.evaluate(() => {
        history.pushState(null, "", "/tasks");
        dispatchEvent(new PopStateEvent("popstate"));
      });
      await expect(page.locator("[data-task-list]")).toBeVisible();
      await page.evaluate(() => {
        history.pushState(null, "", "/tasks/timers");
        dispatchEvent(new PopStateEvent("popstate"));
      });
      await expect(page.locator("[data-timers-running=offline]")).toBeVisible();
      const shown = page.locator(
        `[data-timers-running] [data-account-timer="${id}"]`,
      );
      if (listed) {
        await page.waitForTimeout(1_000);
        await expect(shown).toHaveCount(0);
      } else
        await expect(shown.getByRole("button", { name: "Stop" })).toBeVisible();
      recordEvidence(info, "e-tm5", {
        listed,
        stored: await syncEnded(page),
        log: r10c.log.map(({ from: _from, ...e }) => e),
      });
    });
});

const stoppedRow = (
  task: BuiltTask,
  through: string,
  reason: string,
  over: Record<string, unknown> = {},
) => ({
  task_id: task.taskId,
  through_date: through,
  sequence_generation: `g-${through}`,
  phase: "stopped",
  attempt: null,
  read_seq: 1,
  successful_calls: 8,
  last_known_position: yesterday(10),
  started_at: 1,
  read_failures: 0,
  stop: { reason },
  trigger: "daily",
  ...over,
});
const storedRows = (page: Page, task: BuiltTask) =>
  page.evaluate(
    async ([acct, taskId]) =>
      (
        ((await window.__atlasData?.rows(acct, "materialise_sequences")) ??
          []) as Array<{
          task_id: string;
          through_date: string;
          phase: string;
          attempt: { key: string } | null;
        }>
      ).filter((r) => r.task_id === taskId),
    [ACCOUNT, task.taskId] as const,
  );
const plusDays = (n: number) =>
  new Date(Date.parse(`${TODAY}T00:00:00Z`) + n * 86_400_000)
    .toISOString()
    .slice(0, 10);

test.describe("E-M8: today's stop beside a later day's stop (revision 5: R24)", () => {
  for (const later of [true, false] as const)
    test(`${later ? "a later horizon stop sorts last" : "today's stop alone (control)"}: Today shows today's stop with Try again and sends nothing`, async ({
      context,
    }, info) => {
      const task = repeating(419, "Water the plants");
      const { page, r10c } = await setup(
        context,
        "/tasks",
        [task],
        (reads, r) => {
          reads.respond = (q) =>
            dailyPage(
              [view(task)],
              q.scope === "joint" ? { pending_tasks: [task.taskId] } : {},
            );
          r.position = () =>
            detailOf(task, { last_date: yesterday(10), pending: true });
        },
      );
      const rows = [
        stoppedRow(task, TODAY, "bound"),
        ...(later ? [stoppedRow(task, plusDays(32), "horizon")] : []),
      ];
      await page.evaluate(
        async ([acct, seeded]) => {
          await window.__atlasData?.put(acct, "materialise_sequences", seeded);
        },
        [ACCOUNT, rows] as const,
      );
      await page.evaluate((day) => {
        history.pushState(null, "", `/today?day=${day}&tz=UTC`);
        dispatchEvent(new PopStateEvent("popstate"));
      }, TODAY);
      // Representation-neutral: the stop shown with today's reason (a later horizon stop has another reason and no Try again).
      const notice = page.locator(
        `[data-catch-up-task="${task.taskId}"][data-catch-up-stopped="bound"]`,
      );
      await expect(notice).toBeVisible({ timeout: 15_000 });
      await expect
        .poll(() => positionReads(r10c, task).length)
        .toBeGreaterThan(0);
      await expect(page.locator("[data-pending-tasks]")).toHaveAttribute(
        "data-catch-up",
        "idle",
      );
      await expect(
        notice.getByRole("button", { name: "Try again" }),
      ).toBeEnabled();
      expect(posts(r10c)).toHaveLength(0);
      expect((await storedRows(page, task)).map((r) => r.through_date)).toEqual(
        rows.map((r) => r.through_date),
      );
      recordEvidence(info, "e-m8", {
        later,
        log: r10c.log.map(({ from: _from, ...e }) => e),
      });
    });
});

test.describe("E-M9: an earlier day's unsatisfied stop is kept when today's sequence begins (revision 5: R25)", () => {
  for (const covered of [false, true] as const)
    test(`today's sequence ${covered ? "covers it (control): the earlier row goes" : "does not cover it: the earlier stop and its attempt stay"}`, async ({
      context,
    }, info) => {
      const task = repeating(420, "Water the plants");
      const earlier = yesterday(2);
      let reads = 0;
      const { page, r10c } = await setup(context, "/tasks", [task], (r, x) => {
        r.respond = (q) =>
          dailyPage(
            [view(task)],
            q.scope === "joint" ? { pending_tasks: [task.taskId] } : {},
          );
        // The first read finds work to do; the read after the one call either covers today (and so the earlier day) or moved nothing.
        x.position = () => {
          reads += 1;
          return detailOf(
            task,
            reads === 1 || !covered
              ? { last_date: yesterday(10), pending: true }
              : { last_date: TODAY, pending: false },
          );
        };
      });
      const key = "eeeeeeee-0000-4000-8000-000000000120";
      await page.evaluate(
        async ([acct, seeded]) => {
          await window.__atlasData?.put(acct, "materialise_sequences", seeded);
        },
        [
          ACCOUNT,
          <object[]>[
            stoppedRow(task, earlier, "unreachable", {
              attempt: {
                key,
                body: JSON.stringify({
                  kind: "materialise",
                  limit: 16,
                  task_id: task.taskId,
                  through_date: earlier,
                }),
              },
              read_failures: 3,
            }),
          ],
        ] as const,
      );
      await page.evaluate((day) => {
        history.pushState(null, "", `/today?day=${day}&tz=UTC`);
        dispatchEvent(new PopStateEvent("popstate"));
      }, TODAY);
      await expect.poll(() => posts(r10c).length).toBe(1);
      await expect(page.locator("[data-pending-tasks]")).toHaveAttribute(
        "data-catch-up",
        "idle",
        { timeout: 15_000 },
      );
      const stored = async () =>
        (await storedRows(page, task)).find((r) => r.through_date === earlier);
      if (covered) await expect.poll(stored).toBeUndefined();
      else {
        await page.waitForTimeout(1_000);
        expect((await stored())?.attempt?.key).toBe(key);
        expect((await stored())?.phase).toBe("stopped");
      }
      recordEvidence(info, "e-m9", {
        covered,
        rows: await storedRows(page, task),
        log: r10c.log.map(({ from: _from, ...e }) => e),
      });
    });
});

test.describe("E-M10: a retained day beyond the detail's window (revision 6: R28)", () => {
  for (const later of [8, 7] as const)
    test(`${later} later horizon stops${later === 7 ? " (control)" : ""}: the task's detail reaches tomorrow's stop and its Try again, also after a reload, and sends nothing`, async ({
      context,
    }, info) => {
      const task = repeating(421, "Water the plants");
      const { page, r10c } = await setup(context, "/tasks", [task], (_, r) => {
        r.position = () => detailOf(task, { last_date: TODAY, pending: false });
      });
      const wanted = plusDays(1);
      const rows = [
        stoppedRow(task, wanted, "bound"),
        ...Array.from({ length: later }, (_, i) =>
          stoppedRow(task, plusDays(32 + i), "horizon"),
        ),
      ];
      await page.evaluate(
        async ([acct, seeded]) => {
          await window.__atlasData?.put(acct, "materialise_sequences", seeded);
        },
        [ACCOUNT, rows] as const,
      );
      const open = () =>
        page.evaluate((path) => {
          history.pushState(null, "", path);
          dispatchEvent(new PopStateEvent("popstate"));
        }, `/tasks/${task.taskId}?occurrence=${task.occurrenceId}`);
      const day = page.locator(
        `[data-catch-up-task="${task.taskId}"][data-catch-up-day="${wanted}"]`,
      );
      // Representation-neutral: every retained stop the detail offers is opened, however it is offered.
      const reach = async () => {
        await expect(
          page.locator(`[data-catch-up-task="${task.taskId}"]`).first(),
        ).toBeVisible({ timeout: 15_000 });
        const more = page.getByRole("button", { name: "Show earlier days" });
        for (let i = 0; i < 3 && (await more.count()) > 0; i += 1) {
          await more.click();
          await page.waitForTimeout(300);
        }
      };
      await open();
      await reach();
      await expect(day).toBeVisible({ timeout: 10_000 });
      await expect(
        day.getByRole("button", { name: "Try again" }),
      ).toBeEnabled();
      // Every retained row is still stored (nothing was deleted to make the window fit); read in this tab before the reboot.
      await expect
        .poll(async () =>
          (await storedRows(page, task).catch(() => null))?.map(
            (r) => r.through_date,
          ),
        )
        .toEqual(rows.map((r) => r.through_date));
      // A reload of the session page on the detail: the rows come back from real IndexedDB.
      await reboot(page);
      await reach();
      await expect(day).toBeVisible({ timeout: 10_000 });
      await expect(
        day.getByRole("button", { name: "Try again" }),
      ).toBeEnabled();
      expect(posts(r10c)).toHaveLength(0);
      recordEvidence(info, "e-m10", {
        later,
        log: r10c.log.map(({ from: _from, ...e }) => e),
      });
    });
});
