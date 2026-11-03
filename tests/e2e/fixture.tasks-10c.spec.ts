import { type BrowserContext, expect, type Page, test } from "@playwright/test";
import { recordEvidence } from "./data-evidence";
import {
  deltaPage,
  fresh,
  type LeaderNet,
  leaderPage,
  rowsOf,
  settleElsewhere,
  snapshotPage,
  untilSync,
} from "./data-leader-helpers";
import { operationKeyOf, serveIdentityReads } from "./data-local-faults";
import {
  ACCOUNT,
  type SyncStub,
  seedSettled,
  stubNetwork,
  untilTreeSettled,
} from "./data-sync-helpers";
import { runAxe } from "./helpers";
import {
  ABORTED,
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
  goOnlineAtBoundary,
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
 * through the shared store, while one of another day does not (DA-T3, R14); (revision 7) E-TM6 a Stop pressed on a session another
 * connection recorded finished (a raw IndexedDB write this page's live queries do not hear) is refused by the writing transaction (R32),
 * with its control. E-M3 (the command path) is not here: the fixture outbox
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

  /**
   * ADAPTATION (revision 10, Decision B and the design assessment's step 5): this case expected exactly ONE more read after the reload, the
   * discovery read taken as the position read. Each caller now reads under its own admission, and the held read, issued and never answered,
   * is counted as lost when it was issued: the discovery read, then the position read after its 1 s pace. The intent kept: only reads,
   * never another `materialise` (CM-440), and nothing more once the position is read.
   */
  test("held awaiting the position: after the reload the discovery read and its own position read, and no new materialise", async ({
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
      .toBe(readsBefore + 2);
    await page.waitForTimeout(1_500);
    expect(positionReads(r10c, task).length).toBe(readsBefore + 2);
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

// ---- revision 8 (review 8 R33, A17): a rota answer told to the screen showing the task now -------------------------------------

/**
 * E-R2 (review 8 R33; design assessment Q-R1/Q-R3) in the real engines: change A (the consent, or a saved turn order) is held, the person
 * goes to Tasks by the detail's own link and comes back with browser Back (one document, so the same page memory), and only then is A
 * answered. Uncertain: the screen showing the task NOW offers Try again, which resends A's body under A's key (before revision 8 only the
 * screen that sent A, unmounted by then, was told, so nothing was offered). Control, success: nothing to retry, the rota is read again by
 * the screen now showing it, and the order dialog the person opened since stays open. The ordering of an EARLIER answer against a LATER
 * change (whose key it must not end) is jsdom's (`rota.test.tsx` R33, REVIEW8 T13/T15 ported): a stale answer correctly changes nothing
 * visible, so a native run would have no endpoint proving it had been processed before the retry. FIXTURE evidence.
 */
test.describe("E-R2: a rota change answered after the person went away and came back (A17; review 8 R33)", () => {
  const OTHER_ID = "22222222-2222-4222-8222-222222222222";
  for (const caller of ["consent", "order"] as const)
    for (const answer of ["uncertain", "success"] as const)
      test(`${caller}: A, held while the person went to Tasks and back, is answered ${answer}`, async ({
        context,
      }) => {
        const task = repeating(
          caller === "consent" ? 446 : 447,
          "Take the bins out",
        );
        (task.data.definition as { participation: string }).participation =
          "anyone";
        for (const u of task.upserts as Array<{
          resource: { kind: string; value: Record<string, unknown> };
        }>) {
          if (u.resource.kind === "execution")
            u.resource.value.participation = "anyone";
          if (u.resource.kind === "occurrence")
            (
              u.resource.value.definition as { participation: string }
            ).participation = "anyone";
        }
        const path = `/tasks/${task.taskId}?occurrence=${task.occurrenceId}`;
        const hold = held<void>();
        let calls = 0;
        const { page, r10c } = await setup(
          context,
          path,
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
                consent_version: 2,
                accepted: false,
                eligible_participants: [ACCOUNT, OTHER_ID],
              },
            });
            r.access = async () => {
              calls += 1;
              if (calls === 1) {
                await hold.promise;
                return answer === "success"
                  ? { status: 200, body: { revision: 4 } }
                  : refusal(503, "unavailable");
              }
              return { status: 200, body: { revision: 5 } };
            };
          },
        );
        const kind = caller === "consent" ? "rota_consent" : "set_rota";
        const sent = () => r10c.log.filter((e) => e.what === `POST ${kind}`);
        const rotaReads = () =>
          r10c.log.filter((e) => e.what === `GET /tasks/${task.taskId}/rota`)
            .length;
        const consent = page.getByLabel("Take turns on this task");
        await expect(consent).toBeEnabled();
        const order = page.getByRole("button", { name: "Turn order…" });
        if (caller === "consent") await consent.click();
        else {
          await order.click();
          await expect(page.locator("[data-rota-dialog]")).toBeVisible();
          await page.getByRole("button", { name: /^Add: / }).click();
          await page.getByRole("button", { name: "Save order" }).click();
        }
        await expect.poll(() => sent().length).toBe(1);
        if (caller === "order") {
          // The dialog is modal: the person closes it (the save goes on) before leaving by the detail's link.
          await page.getByRole("button", { name: "Cancel" }).click();
          await expect(page.locator("[data-rota-dialog]")).toHaveCount(0);
        }
        // One document throughout: page memory is kept, as an ordinary navigation keeps it.
        await page.evaluate(() => {
          (window as unknown as { __r33: number }).__r33 = 1;
        });
        await page.getByRole("link", { name: "‹ Tasks" }).click();
        await expect(page).toHaveURL(/\/tasks$/);
        await expect(page.locator("[data-rota-panel]")).toHaveCount(0);
        await page.goBack();
        await expect(page).toHaveURL(new RegExp(`/tasks/${task.taskId}`));
        await expect(consent).toBeEnabled();
        expect(
          await page.evaluate(
            () => (window as unknown as { __r33?: number }).__r33,
          ),
        ).toBe(1);
        if (caller === "order") {
          await order.click();
          await expect(page.locator("[data-rota-dialog]")).toBeVisible();
        }
        const scope =
          caller === "consent"
            ? page.locator("[data-rota-panel]")
            : page.getByRole("dialog");
        const retry = scope.getByRole("button", { name: "Try again" });
        await expect(retry).toHaveCount(0);
        const readsBefore = rotaReads();
        hold.release();
        if (answer === "uncertain") {
          await expect(retry).toBeVisible();
          await retry.click();
          await expect.poll(() => sent().length).toBe(2);
          expect(sent()[1]?.key, "A's own key").toBe(sent()[0]?.key);
          expect(sent()[1]?.body).toEqual(sent()[0]?.body);
        } else {
          await expect.poll(rotaReads).toBeGreaterThan(readsBefore);
          await expect(retry).toHaveCount(0);
          if (caller === "order")
            await expect(page.locator("[data-rota-dialog]")).toBeVisible();
          expect(sent().length).toBe(1);
        }
        expect(await draftsOf(page)).toEqual([]);
      });
});

// ---- revision 9 (review 9 R34, A17): Try again consumes only the order it resends --------------------------------------------------

/**
 * E-R3 (review 9 R34; design assessment Q-R1/Q-R3) in the real engines: order A (a third person added) is saved and held; while it is on
 * its way the person removes the second person (B, never sent: witness) or leaves the order as it is (control); A is answered uncertain,
 * and Try again resends A's body under A's key and succeeds. Witness: the dialog stays open on B, says A was saved and B was not, and B is
 * still there after Cancel and opening the order again (the same visit). Before revision 9 the success consumed B and closed the dialog.
 * Then a full reload: page memory goes (no automatic request, and B is not recovered: rota changes are never stored), and the order opens
 * on the server's roster, A. Control: the unchanged order is consumed and the dialog closes. Two tabs hold separate page memories (no
 * shared attempt or editor); not exercised here: booting a second fixture tab remounts the first's tree. FIXTURE evidence.
 */
test.describe("E-R3: Try again's success consumes only the order it resent (A17; review 9 R34)", () => {
  const OTHER_ID = "22222222-2222-4222-8222-222222222222";
  const THIRD_ID = "33333333-3333-4333-8333-333333333333";
  for (const edited of [true, false])
    test(`${edited ? "witness: an order edited while A was on its way stays, through close/reopen; a reload forgets it and sends nothing" : "control: the order not edited since A is consumed"}`, async ({
      context,
    }) => {
      const task = repeating(edited ? 448 : 449, "Take the bins out");
      (task.data.definition as { participation: string }).participation =
        "anyone";
      for (const u of task.upserts as Array<{
        resource: { kind: string; value: Record<string, unknown> };
      }>) {
        if (u.resource.kind === "execution")
          u.resource.value.participation = "anyone";
        if (u.resource.kind === "occurrence")
          (
            u.resource.value.definition as { participation: string }
          ).participation = "anyone";
      }
      const path = `/tasks/${task.taskId}?occurrence=${task.occurrenceId}`;
      const hold = held<void>();
      let calls = 0;
      const roster = { version: 1, participants: [ACCOUNT, OTHER_ID] };
      const { page, r10c } = await setup(context, path, [task], (_reads, r) => {
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
            version: roster.version,
            participants: roster.participants,
            consent_version: 2,
            accepted: false,
            eligible_participants: [ACCOUNT, OTHER_ID, THIRD_ID],
          },
        });
        r.access = async ({ command }) => {
          calls += 1;
          if (calls === 1) {
            await hold.promise;
            return refusal(503, "unavailable");
          }
          roster.version += 1;
          roster.participants = command.participants as string[];
          return { status: 200, body: { revision: 5 } };
        };
      });
      const sent = () => r10c.log.filter((e) => e.what === "POST set_rota");
      const dialog = page.locator("[data-rota-dialog]");
      const people = () =>
        page
          .locator("[data-rota-order] [data-rota-person]")
          .evaluateAll((els) =>
            els.map((el) => el.getAttribute("data-rota-person")),
          );
      const order = page.getByRole("button", { name: "Turn order…" });
      await expect(order).toBeEnabled();
      await order.click();
      await expect(dialog).toBeVisible();
      await page.getByRole("button", { name: "Add: Someone (3333…)" }).click();
      await page.getByRole("button", { name: "Save order" }).click();
      await expect.poll(() => sent().length).toBe(1);
      expect(sent()[0]?.body).toMatchObject({
        participants: [ACCOUNT, OTHER_ID, THIRD_ID],
      });
      if (edited)
        await page
          .getByRole("button", { name: "Remove: Someone (2222…)" })
          .click();
      expect(await people()).toEqual(
        edited ? [ACCOUNT, THIRD_ID] : [ACCOUNT, OTHER_ID, THIRD_ID],
      );
      hold.release();
      const retry = page.getByRole("dialog").getByRole("button", {
        name: "Try again",
      });
      await expect(retry).toBeVisible();
      await retry.click();
      await expect.poll(() => sent().length).toBe(2);
      expect(sent()[1]?.key, "A's own key").toBe(sent()[0]?.key);
      expect(sent()[1]?.body, "A's own body").toEqual(sent()[0]?.body);
      expect(await draftsOf(page)).toEqual([]);
      if (!edited) {
        await expect(dialog).toHaveCount(0);
        return;
      }
      await expect(page.locator("[data-rota-saved-earlier]")).toBeVisible();
      await expect(dialog).toBeVisible();
      expect(await people()).toEqual([ACCOUNT, THIRD_ID]);
      await expect(
        page.getByRole("button", { name: "Save order" }),
      ).toBeEnabled();
      await page.getByRole("button", { name: "Cancel" }).click();
      await expect(dialog).toHaveCount(0);
      await order.click();
      await expect(dialog).toBeVisible();
      expect(await people(), "the same visit: B is still the person's").toEqual(
        [ACCOUNT, THIRD_ID],
      );
      await page.getByRole("button", { name: "Cancel" }).click();
      await expect(dialog).toHaveCount(0);
      await reboot(page);
      await expect(order).toBeEnabled();
      await order.click();
      await expect(dialog).toBeVisible();
      expect(
        await people(),
        "after a reload: the server's roster (A), never B",
      ).toEqual([ACCOUNT, OTHER_ID, THIRD_ID]);
      await expect(
        page.getByRole("dialog").getByRole("button", { name: "Try again" }),
      ).toHaveCount(0);
      expect(sent().length, "nothing is sent by a reload").toBe(2);
      // The reloaded page's account store, opened by the reader if the page has not opened it yet (`draftsOf` assumes it is open).
      expect(await rowsOf(page, "drafts")).toEqual([]);
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
  /**
   * ADAPTATION (revision 10, Decision B supersedes the three-uncertain stop for commands): this case counted ONE fresh budget as three
   * sends (two budgets: six). An unrecognised command answer is now retried through its 180-second window, so one budget is one paced
   * episode: resends at 1, 2, 4, 8 … s after the one before, every one with the stored key. Two budgets would be two interleaved episodes,
   * resending sooner than the pace. The intent kept: both presses on one stop admit ONE fresh budget, with the stored key.
   */
  test("both presses are made while the account's lock is busy; the stop gets ONE fresh budget: one paced episode with the stored key, not two", async ({
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
    // Both tabs have had the lock since (each finished its queue); the episode goes on at its own pace.
    await second.waitForTimeout(8_000);
    const sent = posts(r10c);
    expect(new Set(sent.map((e) => e.key))).toEqual(new Set([key]));
    // About 11 s from the first send: sends at 0, 1, 3, 7 s (the fifth is due at 15 s). Each no sooner than its pace after the one
    // before (a second budget would resend in between).
    expect(sent.length).toBeGreaterThanOrEqual(4);
    expect(sent.length).toBeLessThanOrEqual(5);
    const paces = [1_000, 2_000, 4_000, 8_000];
    sent.slice(1).forEach((e, i) => {
      expect(e.at - (sent[i]?.at as number)).toBeGreaterThanOrEqual(
        (paces[i] as number) - 25,
      );
    });
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

test.describe("E-TM6: Stop is admitted by the writing transaction against what is stored (revision 7: R32)", () => {
  for (const retired of [true, false] as const)
    test(`${retired ? "a session recorded finished by another connection, not yet heard of here" : "control: nothing recorded"}: ${retired ? "Stop saves nothing and says so" : "Stop is queued once"}`, async ({
      context,
    }, info) => {
      const task = buildTask({
        n: 430,
        title: "Practise piano",
        goal: {
          kind: "numeric",
          minimum: "1800",
          maximum: null,
          unit: "seconds",
        },
      });
      const id = "cccccccc-0000-4000-8000-000000000130";
      const started = Math.floor(Date.now() / 1000) - 600;
      const { page, r10c } = await setup(
        context,
        `/tasks/${task.taskId}?occurrence=${task.occurrenceId}`,
        [task],
        (_reads, r) => {
          r.timers = () => ({
            status: 200,
            body: {
              items: [
                {
                  id,
                  occurrence_id: task.occurrenceId,
                  started_at: started,
                  stopped_at: null,
                  version: 2,
                },
              ],
              next_after: null,
            },
          });
        },
      );
      const block = page.locator("[data-timer-block]");
      await expect(block).toHaveAttribute("data-timer-block", "running");
      // The day read's own record has landed (its scope), so nothing of this page writes the singleton after the raw write below.
      await expect
        .poll(() =>
          page.evaluate(
            async ([acct, occ]) => {
              const rows = (await window.__atlasData?.rows(
                acct,
                "sync_state",
              )) as Array<{ timer_scopes?: Record<string, unknown> }>;
              return rows?.[0]?.timer_scopes?.[occ] !== undefined;
            },
            [ACCOUNT, task.occurrenceId] as const,
          ),
        )
        .toBe(true);
      // Offline: the kept read stays shown, and a queued stop stays queued (nothing is sent).
      await goOfflineAtBoundary(page);
      await expect(block).toHaveAttribute("data-timer-block", "running");
      if (retired)
        // Another connection records the session finished: a raw IndexedDB write, which this page's live queries do not hear.
        await page.evaluate(
          async ([name, session]) => {
            const db = await new Promise<IDBDatabase>((resolve, reject) => {
              const open = indexedDB.open(name);
              open.onsuccess = () => resolve(open.result);
              open.onerror = () => reject(open.error);
            });
            await new Promise<void>((resolve, reject) => {
              const tx = db.transaction("sync_state", "readwrite");
              const store = tx.objectStore("sync_state");
              const read = store.get("singleton");
              read.onsuccess = () => {
                const row = read.result as { timer_order?: number };
                store.put({
                  ...row,
                  timer_ended: {
                    lost: false,
                    ids: [[session, row.timer_order ?? 0]],
                    through: 0,
                  },
                });
              };
              tx.oncomplete = () => resolve();
              tx.onerror = () => reject(tx.error);
            });
            db.close();
          },
          [`atlas-${ACCOUNT}`, id] as const,
        );
      await page.waitForTimeout(300);
      await expect(block, "not heard of yet").toHaveAttribute(
        "data-timer-block",
        "running",
      );
      await block.getByRole("button", { name: "Stop", exact: true }).click();
      if (retired) {
        await expect(page.locator('[aria-live="assertive"]')).toContainText(
          "This timer may already have ended. Nothing was saved.",
        );
        await page.waitForTimeout(300);
        expect(
          (await draftsOf(page)).filter((d) => d.kind === "stop_timer"),
        ).toEqual([]);
      } else
        await expect
          .poll(
            async () =>
              (await draftsOf(page)).filter((d) => d.kind === "stop_timer")
                .length,
          )
          .toBe(1);
      recordEvidence(info, "e-tm6", {
        retired,
        log: r10c.log.map(({ from: _from, ...e }) => e),
        drafts: await draftsOf(page),
      });
    });
});

test.describe("E-M11: a reconnection past the first page, and a fence across a reload (revision 11: R36)", () => {
  const body = (taskId: string) =>
    JSON.stringify({
      kind: "materialise",
      limit: 16,
      task_id: taskId,
      through_date: TODAY,
    });
  const schedule = (over: Record<string, unknown>) => ({
    v: 1,
    caller: "command",
    issued: null,
    since: null,
    failures: 0,
    next: 0,
    server: null,
    cause: null,
    unknown: 0,
    seen: Date.now() - 5_000,
    pause: null,
    ...over,
  });

  test("150 other tasks' rows sort first: an observed offline-then-online change resumes this task's window pause once, with its stored key", async ({
    context,
  }, info) => {
    const task = repeating(419, "Water the plants");
    const key = "eeeeeeee-0000-4000-8000-000000000419";
    const { page, r10c } = await setup(context, "/tasks", [task], (_, r) => {
      r.position = () => detailOf(task, { last_date: TODAY, pending: false });
    });
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
      schedule: null,
    };
    const rows = [
      ...Array.from({ length: 150 }, (_, i) => ({
        ...stop,
        task_id: `00000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`,
      })),
      {
        ...stop,
        task_id: task.taskId,
        read_seq: 0,
        successful_calls: 0,
        attempt: { key, body: body(task.taskId) },
        stop: { reason: "unreachable" },
        read_failures: 10,
        schedule: schedule({
          since: Date.now() - 181_000,
          failures: 10,
          next: Date.now() - 5_000,
          cause: "transport",
          pause: "window",
        }),
      },
    ];
    expect(rows.every((r) => r.task_id <= task.taskId)).toBe(true);
    await page.evaluate(
      async ([acct, seeded]) => {
        await window.__atlasData?.put(acct, "materialise_sequences", seeded);
      },
      [ACCOUNT, rows] as const,
    );
    // Not a reconnection: nothing is sent while the page only stays online.
    await page.waitForTimeout(1_500);
    expect(posts(r10c)).toHaveLength(0);
    await goOfflineAtBoundary(page);
    await page.waitForTimeout(300);
    await goOnlineAtBoundary(page);
    await expect.poll(() => posts(r10c).length, { timeout: 15_000 }).toBe(1);
    expect(posts(r10c)[0]?.key).toBe(key);
    await expect
      .poll(
        () =>
          page.evaluate(
            async ([acct, id]) =>
              (
                ((await window.__atlasData?.rows(
                  acct,
                  "materialise_sequences",
                )) ?? []) as Array<{ task_id: string }>
              ).filter((r) => r.task_id === id).length,
            [ACCOUNT, task.taskId] as const,
          ),
        { timeout: 15_000 },
      )
      .toBe(0);
    await page.waitForTimeout(1_500);
    expect(posts(r10c)).toHaveLength(1);
    recordEvidence(info, "e-m11-scan", {
      log: r10c.log.map(({ from: _from, ...e }) => e),
    });
  });

  // Revision 12 (review 13 R36-A, design assessment C3): CORRECTED. Revision 11 expected the press to end this marker and resend the stored
  // key: with only the marker left, nothing says whether the unrecorded answer was a 429 with a deadline or a success that may only
  // continue with its position read, so the press now ends nothing and transmits nothing (the stop stays shown, the marker stays).
  test("a marker of the day's unrecorded outcome (real localStorage) fences it across a full reload; Try again, with no outcome behind the marker, ends nothing and transmits nothing", async ({
    context,
  }, info) => {
    const task = repeating(420, "Water the plants");
    const key = "eeeeeeee-0000-4000-8000-000000000420";
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
          posts(r).length > 0
            ? detailOf(task, { last_date: TODAY, pending: false })
            : detailOf(task, { last_date: yesterday(10), pending: true });
      },
    );
    // An admitted command whose answer was never recorded, and the marker of that day's failed record (another page's, before a reload).
    await page.evaluate(
      async ([acct, row]) => {
        await window.__atlasData?.put(acct, "materialise_sequences", [row]);
      },
      [
        ACCOUNT,
        {
          task_id: task.taskId,
          through_date: TODAY,
          sequence_generation: "aaaaaaaa-0000-4000-8000-000000000420",
          phase: "submitting",
          attempt: { key, body: body(task.taskId) },
          read_seq: 0,
          successful_calls: 0,
          last_known_position: yesterday(10),
          started_at: 1,
          read_failures: 0,
          stop: null,
          trigger: "daily",
          revision: 3,
          schedule: schedule({ issued: Date.now() - 5_000 }),
        },
      ] as const,
    );
    const marker = `${await operationKeyOf(page, `materialise:${task.taskId}:${TODAY}`)}#native-page.1`;
    await page.evaluate((k) => localStorage.setItem(k, "1"), marker);
    await page.evaluate((day) => {
      history.pushState(null, "", `/today?day=${day}&tz=UTC`);
      dispatchEvent(new PopStateEvent("popstate"));
    }, TODAY);
    await reboot(page);
    const notice = page.locator(`[data-catch-up-task="${task.taskId}"]`);
    await expect(notice).toHaveAttribute("data-catch-up-stopped", "storage", {
      timeout: 15_000,
    });
    await page.waitForTimeout(2_000);
    expect(posts(r10c)).toHaveLength(0);
    expect(await page.evaluate((k) => localStorage.getItem(k), marker)).toBe(
      "1",
    );
    await notice.getByRole("button", { name: "Try again" }).click();
    // Longer than the lost issue's 1-second pace that revision 11 resent after: still nothing, the stop and the marker standing.
    await page.waitForTimeout(3_000);
    expect(posts(r10c)).toHaveLength(0);
    await expect(notice).toHaveAttribute("data-catch-up-stopped", "storage");
    expect(await page.evaluate((k) => localStorage.getItem(k), marker)).toBe(
      "1",
    );
    // The durable row is the issued one still: its attempt kept, nothing reduced as lost. Read through `rowsOf`, which opens the store
    // when the rebooted page has none open (`__atlasData.rows` then throws "no open store", as revision 12's first WebKit run showed).
    const after = (
      (await rowsOf(page, "materialise_sequences")) as Array<{
        task_id: string;
        phase: string;
        attempt: { key: string } | null;
      }>
    ).filter((r) => r.task_id === task.taskId);
    expect(after).toHaveLength(1);
    expect(after[0]?.phase).toBe("submitting");
    expect(after[0]?.attempt?.key).toBe(key);
    recordEvidence(info, "e-m11-fence", {
      log: r10c.log.map(({ from: _from, ...e }) => e),
    });
  });
});

/**
 * Revision 15 (review 16's R36-H and R36-I; design assessment Q2/Q5): natively, in each engine.
 * - E-M12a records the ORDER a browser gives a late `beforeunload`/`pagehide` listener and the rejection of a call it cancels as the
 *   page is closed, navigated away from or reloaded: the runner tells a call cancelled by the teardown from a failure observed live by
 *   that order alone (`./lifecycle`, per call).
 * - E-M12b..e put an independent oracle on the page's REAL IndexedDB and localStorage (a trace of the writes of the task's discovery entry
 *   and of its marker, in the order the page made them; a write of the entry can be failed, as `data-local-faults.ts` fails a write): the
 *   fence of an outcome observed live is in localStorage BEFORE that outcome is first written (R36-H); a failed write is fenced BEFORE its
 *   first repair is written (R36-I); a store that keeps failing fences the caller for another tab and a reload; a page closed while its
 *   call is held publishes no fence and another tab recovers the call (E-M2, I-10C-M4a). FIXTURE evidence (the stub's answers).
 */
// REVISION17 ADAPTATION (review 18's R36-K; Kieran's decision approval/web10c-r36k-conservative-recovery-20261102.json): an observed
// transport failure is fenced under its caller's lost-answer operation (`materialise-lost:…`). Every raw marker filter of E-M12 recognises
// the caller's fence under either operation; what each case asserts of the fence (set, standing, retired, absent) is unchanged.
test.describe("E-M12: the page's lifecycle and the first outcome write, natively (revision 15: R36-H/I)", () => {
  type Trace = { log: string[]; fail: number; prev: string };
  /**
   * Installs the trace in every page of the context BEFORE it boots (so the discovery's admission is its first write seen); each page's
   * first `fail` writes of the discovery's outcome fail.
   */
  const trace = (context: BrowserContext, taskId: string, fail: number) =>
    context.addInitScript(
      ([id, failing]) => {
        const w = window as unknown as { __r15?: Trace };
        if (w.__r15) return;
        const t: Trace = { log: [], fail: failing, prev: "" };
        w.__r15 = t;
        const proto = IDBObjectStore.prototype;
        const put = proto.put;
        proto.put = function (this: IDBObjectStore, ...args: unknown[]) {
          if (this.name === "sync_state") {
            const entry = (
              args[0] as {
                materialise_discovery?: Record<
                  string,
                  { schedule?: { issued?: number | null } | null }
                >;
              } | null
            )?.materialise_discovery?.[id];
            const sig = JSON.stringify(entry ?? null);
            if (sig !== t.prev) {
              const kind =
                entry === undefined
                  ? "outcome:removed"
                  : entry.schedule?.issued != null
                    ? "admission"
                    : "outcome:failure";
              if (
                kind !== "admission" &&
                t.prev !== "" &&
                t.prev !== "null" &&
                t.fail > 0
              ) {
                t.fail -= 1;
                t.log.push(`${kind}:FAILED`);
                throw new DOMException("injected fault", "DataError");
              }
              if ((t.prev !== "" && t.prev !== "null") || kind === "admission")
                t.log.push(kind);
              t.prev = sig;
            }
          }
          return put.apply(this, args as [unknown, IDBValidKey?]);
        };
        const ours = (key: unknown) =>
          typeof key === "string" &&
          key.startsWith("atlas-write-failing:") &&
          (key.includes(`:materialise:${id}#`) ||
            key.includes(`:materialise-lost:${id}#`));
        const storage = Storage.prototype;
        const setItem = storage.setItem;
        storage.setItem = function (this: Storage, key: string, value: string) {
          if (ours(key)) t.log.push("marker:set");
          return setItem.call(this, key, value);
        };
        const removeItem = storage.removeItem;
        storage.removeItem = function (this: Storage, key: string) {
          if (ours(key)) t.log.push("marker:removed");
          return removeItem.call(this, key);
        };
      },
      [taskId, fail] as const,
    );
  const traced = (page: Page) =>
    page.evaluate(
      () => (window as unknown as { __r15?: Trace }).__r15?.log ?? [],
    );
  /** The discovery's markers in the origin's REAL localStorage, read raw. */
  const discoveryMarkers = (page: Page, taskId: string) =>
    page.evaluate(
      (id) =>
        Object.keys(localStorage).filter(
          (k) =>
            k.startsWith("atlas-write-failing:") &&
            (k.includes(`:materialise:${id}#`) ||
              k.includes(`:materialise-lost:${id}#`)),
        ),
      taskId,
    );
  const reads = (r: Reads10c, task: BuiltTask) => positionReads(r, task).length;
  /** Today with the task listed pending; its FIRST read held until `first` is released, then `later` answers. */
  const arrange =
    (task: BuiltTask, first: Promise<Answer>, later: () => Answer) =>
    (q: TaskReads, r: Reads10c) => {
      q.respond = (d) =>
        dailyPage(
          [view(task)],
          d.scope === "joint" ? { pending_tasks: [task.taskId] } : {},
        );
      let n = 0;
      r.position = () => {
        n += 1;
        return n === 1 ? first : later();
      };
    };

  /**
   * ADAPTATION of this revision's first E-M12a (labelled; its first run's failures are kept in the revision-15 evidence): it asserted that
   * a page's `pagehide` comes before the rejection of a call the page's teardown cancels. Firefox and WebKit deliver that rejection
   * BEFORE `pagehide` on a navigation or a reload, and Chromium after the FIRST `pagehide` listener (a microtask checkpoint between
   * listeners, the cancellation already queued), so `pagehide` alone cannot tell it apart. The runner's lifecycle listens to
   * `beforeunload` and `pagehide`, added LATE (after the page's own listeners and its call), as here. This case asserts what it relies
   * on: that late listener sees the teardown before the call's rejection is delivered, if the browser delivers one at all.
   *
   * ADAPTATION again (revision 16, labelled; review 17's R36-J, Kieran's D1 decision approval/web10c-d1-preserve-rule-20261102.json): a
   * `beforeunload` is no departure any more (a navigation answered with 204, a download or one cancelled leaves the page running), so
   * the late `beforeunload` listener seeing the teardown first is no longer what the runner relies on. It relies on this instead, which
   * the case now asserts: the rejection is delivered EITHER during the page's `pagehide` dispatch (`window.event` is that `pagehide`: a
   * departure, the call left recoverable, E-M2) OR before any `pagehide` (a failure that cannot be told from a genuine one: protected as
   * observed; its first write, which lands before the page unloads, is what the next page recovers, E-M2). The order seen is recorded.
   */
  for (const action of ["close", "navigate", "reload"] as const)
    test(`E-M12a: ${action}: the rejection of the call the page's departure cancels (if the browser rejects it at all) is delivered during the page's pagehide dispatch or before any pagehide`, async ({
      context,
      browserName,
    }, info) => {
      await context.route("**/__r15/blank*", (route) =>
        route.fulfill({
          status: 200,
          contentType: "text/html",
          body: "<!doctype html><title>r15</title>",
        }),
      );
      // Never answered: the browser cancels it with the page.
      await context.route("**/__r15/held", () => undefined);
      const page = await context.newPage();
      await page.goto("/__r15/blank");
      await page.evaluate(() => {
        localStorage.removeItem("__r15:order");
        const note = (what: string) => {
          const log = JSON.parse(
            localStorage.getItem("__r15:order") ?? "[]",
          ) as string[];
          log.push(what);
          localStorage.setItem("__r15:order", JSON.stringify(log));
        };
        // The page's own listeners first (as the session's), then the call, then the runner's lifecycle (late; not capturing, as it:
        // a page Firefox closes does not invoke a capturing pagehide listener of window, this revision's second run).
        addEventListener("beforeunload", () => note("early beforeunload"));
        addEventListener("pagehide", () => note("early pagehide"));
        void fetch("/__r15/held").then(
          () => note("answered"),
          (e: unknown) =>
            note(
              `rejected:${(e as Error).name} event=${(window as { event?: Event }).event?.type ?? "none"}`,
            ),
        );
        addEventListener("beforeunload", () => note("late beforeunload"));
        addEventListener("pagehide", () => note("late pagehide"));
      });
      await page.waitForTimeout(300);
      if (action === "close") await page.close();
      else if (action === "navigate") await page.goto("/__r15/blank?next");
      else await page.reload();
      const reader = action === "close" ? await context.newPage() : page;
      if (action === "close") await reader.goto("/__r15/blank?reader");
      await reader.waitForTimeout(1_000);
      const order = await reader.evaluate(
        () =>
          JSON.parse(localStorage.getItem("__r15:order") ?? "[]") as string[],
      );
      recordEvidence(info, `e-m12a-${action}-${browserName}`, { order });
      expect(order).not.toContain("answered");
      const late = order.findIndex((e) => e === "late pagehide");
      expect(late, "the late pagehide listener saw the departure").not.toBe(-1);
      const rejected = order.findIndex((e) => e.startsWith("rejected"));
      if (rejected !== -1) {
        const during = order[rejected]?.endsWith(" event=pagehide") === true;
        const hide = order.findIndex((e) => e.endsWith(" pagehide"));
        expect(
          during || rejected < hide,
          `delivered during the pagehide dispatch or before any pagehide: ${JSON.stringify(order)}`,
        ).toBe(true);
      }
    });

  test("E-M12b (R36-H): a discovery read with no answer on a LIVE page: its fence is in real localStorage BEFORE its outcome is first written; that write retires it and the read is made again", async ({
    context,
  }, info) => {
    const task = repeating(421, "Water the ferns");
    await trace(context, task.taskId, 0);
    const first = held<Answer>();
    const { page, r10c } = await setup(
      context,
      `/today?day=${TODAY}&tz=UTC`,
      [task],
      arrange(task, first.promise, () =>
        detailOf(task, { last_date: TODAY, pending: false }),
      ),
    );
    await expect.poll(() => reads(r10c, task), { timeout: 15_000 }).toBe(1);
    first.release(ABORTED);
    await expect.poll(() => reads(r10c, task), { timeout: 15_000 }).toBe(2);
    await expect
      .poll(() => discoveryMarkers(page, task.taskId), { timeout: 10_000 })
      .toEqual([]);
    const log = await traced(page);
    recordEvidence(info, "e-m12b", {
      trace: log,
      log: r10c.log.map(({ from: _from, ...e }) => e),
    });
    const set = log.indexOf("marker:set");
    const outcome = log.indexOf("outcome:failure");
    expect(set, "fenced at its receipt").not.toBe(-1);
    expect(outcome, "the outcome was written").not.toBe(-1);
    expect(set, "the fence before the outcome's first write").toBeLessThan(
      outcome,
    );
    expect(log.indexOf("marker:removed")).toBeGreaterThan(outcome);
    await expect(page.locator("[data-catch-up-stopped]")).toHaveCount(0);
  });

  test("E-M12c (R36-I): a discovery success whose first write FAILS on a live page is fenced at that failure, BEFORE its first repair is written; the repair retires it and the work goes on", async ({
    context,
  }, info) => {
    const task = repeating(422, "Water the palms");
    await trace(context, task.taskId, 1);
    const first = held<Answer>();
    const { page, r10c } = await setup(
      context,
      `/today?day=${TODAY}&tz=UTC`,
      [task],
      arrange(task, first.promise, () =>
        detailOf(task, { last_date: TODAY, pending: false }),
      ),
    );
    await expect.poll(() => reads(r10c, task), { timeout: 15_000 }).toBe(1);
    first.release(detailOf(task, { last_date: yesterday(20), pending: true }));
    await expect.poll(() => posts(r10c).length, { timeout: 15_000 }).toBe(1);
    await expect
      .poll(() => discoveryMarkers(page, task.taskId), { timeout: 10_000 })
      .toEqual([]);
    const log = await traced(page);
    recordEvidence(info, "e-m12c", {
      trace: log,
      log: r10c.log.map(({ from: _from, ...e }) => e),
    });
    const failed = log.indexOf("outcome:removed:FAILED");
    const set = log.indexOf("marker:set");
    const repair = log.indexOf("outcome:removed");
    expect(failed, "the first write failed").not.toBe(-1);
    expect(set, "fenced at the failure").toBeGreaterThan(failed);
    expect(set, "before the first repair is written").toBeLessThan(repair);
    expect(log.indexOf("marker:removed")).toBeGreaterThan(repair);
  });

  // A tab WITHOUT Web Locks is not a native case: the app's compatibility gate refuses such a browser ("Atlas can't open in this
  // browser", this revision's second run), so the runner's no-lock path is the service tests' (REVIEW16 Q1, REVISION15).
  test("E-M12d (R36-I): a store that keeps failing the discovery's success fences it in real localStorage: another tab and a reload read nothing for it and show the storage stop", async ({
    context,
  }, info) => {
    const task = repeating(423, "Water the moss");
    await trace(context, task.taskId, 99);
    const first = held<Answer>();
    const { page, r10c } = await setup(
      context,
      `/today?day=${TODAY}&tz=UTC`,
      [task],
      arrange(task, first.promise, () =>
        detailOf(task, { last_date: yesterday(20), pending: true }),
      ),
    );
    await expect.poll(() => reads(r10c, task), { timeout: 15_000 }).toBe(1);
    first.release(detailOf(task, { last_date: yesterday(20), pending: true }));
    const notice = page.locator(`[data-catch-up-task="${task.taskId}"]`);
    await expect(notice).toHaveAttribute("data-catch-up-stopped", "storage", {
      timeout: 15_000,
    });
    const log = await traced(page);
    expect(log.indexOf("marker:set")).toBeLessThan(
      log.lastIndexOf("outcome:removed:FAILED"),
    );
    expect(await discoveryMarkers(page, task.taskId)).toHaveLength(1);
    const other = await context.newPage();
    await other.goto(
      `/__session?route=${encodeURIComponent(`/today?day=${TODAY}&tz=UTC`)}`,
    );
    await other.waitForFunction(
      () => window.__atlasFixture?.session?.booted !== undefined,
    );
    await expect(
      other.locator(`[data-catch-up-task="${task.taskId}"]`),
    ).toHaveAttribute("data-catch-up-stopped", "storage", {
      timeout: 20_000,
    });
    await reboot(page);
    await expect(notice).toHaveAttribute("data-catch-up-stopped", "storage", {
      timeout: 15_000,
    });
    await page.waitForTimeout(2_000);
    expect(reads(r10c, task), "no page read for the fenced caller").toBe(1);
    expect(posts(r10c)).toHaveLength(0);
    recordEvidence(info, "e-m12d", {
      trace: log,
      log: r10c.log.map(({ from: _from, ...e }) => e),
    });
  });

  test("E-M12e (teardown): a page CLOSED while its discovery read is held publishes no fence; the other tab, waiting for the lock, recovers the call and the work goes on", async ({
    context,
  }, info) => {
    const task = repeating(425, "Water the roses");
    const never = new Promise<Answer>(() => undefined);
    const { page, r10c } = await setup(
      context,
      `/today?day=${TODAY}&tz=UTC`,
      [task],
      arrange(task, never, () =>
        detailOf(task, { last_date: TODAY, pending: false }),
      ),
    );
    await expect.poll(() => reads(r10c, task), { timeout: 15_000 }).toBe(1);
    const other = await bootAt(context, `/today?day=${TODAY}&tz=UTC`);
    await page.waitForTimeout(500);
    expect(reads(r10c, task), "the other tab waits for the lock").toBe(1);
    await page.close();
    await expect
      .poll(() => reads(r10c, task), { timeout: 20_000 })
      .toBeGreaterThanOrEqual(2);
    await other.waitForTimeout(1_500);
    expect(await discoveryMarkers(other, task.taskId)).toEqual([]);
    await expect(
      other.locator(
        `[data-catch-up-task="${task.taskId}"][data-catch-up-stopped]`,
      ),
    ).toHaveCount(0);
    recordEvidence(info, "e-m12e", {
      log: r10c.log.map(({ from: _from, ...e }) => e),
    });
  });

  /**
   * Revision 16 (review 17's R36-J; design assessment Q1/Q4): an ATTEMPTED departure the page outlives. Review 17's native witness,
   * maintained (its source is kept unchanged in the review's evidence): the caller's call is held; the page attempts to leave by a
   * navigation answered with 204, a download, or one the person cancels at the page's `beforeunload` prompt, and the page goes on with
   * exactly one `beforeunload` (no `pagehide`, no `pageshow`); the call then fails at the network (`ABORTED`), and EVERY write of its
   * outcome fails in the page's real IndexedDB. The failure the page observed fences the caller in real localStorage, so another tab,
   * booted after, reads (or sends) nothing for it (Decision B). `none` is review 17's control (no navigation); `lands` the liveness
   * control (204, the outcome write not failed: the fence retired by its record and the caller's call made again). FIXTURE evidence.
   */
  type Caller16 = "discovery" | "command" | "position";
  type Leave16 = "204" | "download" | "cancelled" | "none";
  const r16 = (
    context: BrowserContext,
    taskId: string,
    caller: Caller16,
    fail: boolean,
  ) =>
    context.addInitScript(
      ([id, which, failing]) => {
        const w = window as unknown as {
          __r16?: {
            fault: boolean;
            failures: number;
            events: string[];
            markSets: number;
            sequenceAdmissions: number;
          };
        };
        if (w.__r16) return;
        // `sequenceAdmissions`: this page's admissions of the task's command or position read (each written before it is sent).
        const t = {
          fault: false,
          failures: 0,
          events: [] as string[],
          markSets: 0,
          sequenceAdmissions: 0,
        };
        w.__r16 = t;
        for (const e of ["beforeunload", "pagehide", "pageshow"])
          addEventListener(e, () => t.events.push(e));
        const put = IDBObjectStore.prototype.put;
        IDBObjectStore.prototype.put = function (
          this: IDBObjectStore,
          ...args: unknown[]
        ) {
          const value = args[0] as {
            task_id?: string;
            schedule?: { issued?: number | null; cause?: string } | null;
            materialise_discovery?: Record<
              string,
              { schedule?: { issued?: number | null; cause?: string } | null }
            >;
          } | null;
          if (
            this.name === "materialise_sequences" &&
            value?.task_id === id &&
            value.schedule?.issued != null
          )
            t.sequenceAdmissions += 1;
          const schedule =
            which === "discovery"
              ? this.name === "sync_state"
                ? value?.materialise_discovery?.[id]?.schedule
                : undefined
              : this.name === "materialise_sequences" && value?.task_id === id
                ? value?.schedule
                : undefined;
          if (
            failing &&
            t.fault &&
            schedule != null &&
            schedule.issued === null &&
            schedule.cause === "transport"
          ) {
            t.failures += 1;
            throw new DOMException("injected fault (revision 16)", "DataError");
          }
          return put.apply(this, args as [unknown, IDBValidKey?]);
        };
        const set = Storage.prototype.setItem;
        Storage.prototype.setItem = function (
          this: Storage,
          key: string,
          v: string,
        ) {
          if (
            key.startsWith("atlas-write-failing:") &&
            (key.includes(`:materialise:${id}`) ||
              key.includes(`:materialise-lost:${id}`))
          )
            t.markSets += 1;
          return set.call(this, key, v);
        };
      },
      [taskId, caller, fail] as const,
    );
  const markersOf = (page: Page, taskId: string) =>
    page.evaluate(
      (id) =>
        Object.keys(localStorage).filter(
          (k) =>
            k.startsWith("atlas-write-failing:") &&
            (k.includes(`:materialise:${id}`) ||
              k.includes(`:materialise-lost:${id}`)),
        ),
      taskId,
    );
  /** The page attempts to leave and goes on: exactly one `beforeunload`, and nothing else, before the held call fails. */
  const attemptToLeave = async (
    context: BrowserContext,
    page: Page,
    leave: Leave16,
  ) => {
    if (leave === "none") return;
    if (leave === "cancelled") {
      // Sticky activation (a prompt needs it), then a beforeunload that asks, which the person cancels.
      await page.mouse.click(2, 2);
      await page.evaluate(() =>
        addEventListener("beforeunload", (event) => {
          event.preventDefault();
          event.returnValue = "";
        }),
      );
      page.once("dialog", (dialog) => void dialog.dismiss());
      await context.route("**/__r16/next", (route) =>
        route.fulfill({
          status: 200,
          contentType: "text/html",
          body: "<!doctype html><title>r16</title>",
        }),
      );
      await page
        .evaluate(() => {
          location.href = "/__r16/next";
        })
        .catch(() => undefined);
    } else {
      let served!: () => void;
      const done = new Promise<void>((resolve) => {
        served = resolve;
      });
      await context.route(`**/__r16/${leave}`, async (route) => {
        if (leave === "204") await route.fulfill({ status: 204 });
        else
          await route.fulfill({
            status: 200,
            headers: {
              "content-type": "application/octet-stream",
              "content-disposition": 'attachment; filename="r16.txt"',
            },
            body: "revision 16",
          });
        served();
      });
      await page.evaluate((target) => {
        location.href = target;
      }, `/__r16/${leave}`);
      await done;
    }
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window as unknown as { __r16: { events: string[] } }).__r16.events,
        ),
      )
      .toEqual(["beforeunload"]);
    // The page goes on (a short observation of the native lifecycle; no product timer is changed).
    await page.waitForTimeout(300);
    expect(
      await page.evaluate(
        () =>
          (window as unknown as { __r16: { events: string[] } }).__r16.events,
      ),
      "no pagehide: the page went on",
    ).toEqual(["beforeunload"]);
  };
  const cases16: Array<{ caller: Caller16; leave: Leave16; lands: boolean }> = [
    { caller: "discovery", leave: "204", lands: false },
    { caller: "discovery", leave: "download", lands: false },
    { caller: "discovery", leave: "cancelled", lands: false },
    { caller: "discovery", leave: "none", lands: false },
    { caller: "discovery", leave: "204", lands: true },
    { caller: "command", leave: "204", lands: false },
    { caller: "command", leave: "none", lands: false },
    { caller: "command", leave: "204", lands: true },
    { caller: "position", leave: "204", lands: false },
    { caller: "position", leave: "none", lands: false },
    { caller: "position", leave: "204", lands: true },
  ];
  for (const { caller, leave, lands } of cases16)
    test(`${caller === "discovery" ? "E-M12f" : "E-M12g"} (R36-J) ${caller}, ${leave === "none" ? "CONTROL no navigation" : `a navigation ${leave === "204" ? "answered with 204" : leave === "download" ? "that downloads" : "the person cancels"}`}: ${lands ? "LIVENESS CONTROL the outcome written: its fence retired and the call made again" : "every write of the failure the page observed fails: fenced in real localStorage, another tab sends nothing for it"}`, async ({
      context,
    }, info) => {
      const task = repeating(
        450 +
          cases16.findIndex(
            (c) =>
              c.caller === caller && c.leave === leave && c.lands === lands,
          ),
        `Water the ${caller} ${leave}`,
      );
      await r16(context, task.taskId, caller, !lands);
      const first = held<Answer>();
      let reads16 = 0;
      let commands = 0;
      const { page, r10c } = await setup(
        context,
        `/today?day=${TODAY}&tz=UTC`,
        [task],
        (q, r) => {
          q.respond = (d) =>
            dailyPage(
              [view(task)],
              d.scope === "joint" ? { pending_tasks: [task.taskId] } : {},
            );
          r.position = () => {
            reads16 += 1;
            if (caller === "discovery")
              return reads16 === 1
                ? first.promise
                : detailOf(task, { last_date: TODAY, pending: false });
            if (reads16 === 1)
              return detailOf(task, {
                last_date: yesterday(20),
                pending: true,
              });
            if (caller === "position" && reads16 === 2) return first.promise;
            return detailOf(task, { last_date: TODAY, pending: false });
          };
          r.materialise = () => {
            commands += 1;
            return caller === "command" && commands === 1
              ? first.promise
              : { status: 200, body: { revision: 8 } };
          };
        },
      );
      const held16 = () =>
        caller === "command"
          ? commands === 1
          : reads16 === (caller === "discovery" ? 1 : 2);
      await expect.poll(held16, { timeout: 15_000 }).toBe(true);
      const before = { reads: reads16, commands };
      await page.evaluate(() => {
        const t = (
          window as unknown as { __r16: { fault: boolean; events: string[] } }
        ).__r16;
        t.fault = true;
        t.events = [];
      });
      await attemptToLeave(context, page, leave);
      first.release(ABORTED);
      if (lands) {
        // The outcome is recorded: the fence retired and the caller's call made again (paced from the observation, 1 s).
        await expect
          .poll(
            () => (caller === "command" ? commands : reads16 - before.reads),
            { timeout: 15_000 },
          )
          .toBeGreaterThanOrEqual(caller === "command" ? 2 : 1);
        await expect
          .poll(() => markersOf(page, task.taskId), { timeout: 10_000 })
          .toEqual([]);
        if (caller === "command")
          expect(posts(r10c)[1]?.key).toBe(posts(r10c)[0]?.key);
        recordEvidence(info, `e-m12-r16-${caller}-${leave}-lands`, {
          trace: await page.evaluate(
            () => (window as unknown as { __r16: unknown }).__r16,
          ),
          log: r10c.log.map(({ from: _from, ...e }) => e),
        });
        return;
      }
      await expect(
        page.locator(
          `[data-catch-up-task="${task.taskId}"][data-catch-up-stopped]`,
        ),
      ).toHaveCount(1, { timeout: 15_000 });
      const trace16 = await page.evaluate(
        () =>
          (
            window as unknown as {
              __r16: { failures: number; markSets: number };
            }
          ).__r16,
      );
      const markers = await markersOf(page, task.taskId);
      expect(
        trace16.failures,
        "real IndexedDB outcome writes failed",
      ).toBeGreaterThan(0);
      expect(
        { reads: reads16, commands },
        "the owner made only the held call",
      ).toEqual(before);
      expect(
        markers,
        "the shared stop stands in real localStorage",
      ).toHaveLength(1);
      const other = await bootAt(context, `/today?day=${TODAY}&tz=UTC`);
      await expect(
        other.getByRole("heading", { name: "Today", exact: true }),
      ).toBeVisible({ timeout: 15_000 });
      await other.waitForTimeout(2_000);
      const peerTrace = await other.evaluate(
        () =>
          (window as unknown as { __r16: { sequenceAdmissions: number } })
            .__r16,
      );
      recordEvidence(info, `e-m12-r16-${caller}-${leave}`, {
        trace: trace16,
        peerTrace,
        markers,
        peerStop: await other
          .locator(`[data-catch-up-task="${task.taskId}"]`)
          .getAttribute("data-catch-up-stopped")
          .catch(() => null),
        log: r10c.log.map(({ from, ...e }) => ({
          ...e,
          owner: from === page ? "first" : "peer",
        })),
      });
      // The caller's own transmissions: a discovery read (the peer's discovery of the task is another caller with its own fence, and
      // is made in the control too), a command, a position read (admitted in the sequence's row before it is sent).
      if (caller === "discovery")
        expect(
          reads16,
          "Decision B: no page reads for the caller after the failure it observed could not be recorded",
        ).toBe(before.reads);
      else {
        expect(
          commands,
          "Decision B: no page sends the command again after the failure it observed could not be recorded",
        ).toBe(before.commands);
        expect(
          peerTrace.sequenceAdmissions,
          "Decision B: the other tab admits no call of the task's sequence (command or position read)",
        ).toBe(0);
      }
    });

  /**
   * Revision 16 (review 17's R36-J; Kieran's D1 decision): NO TASK BETWEEN A FAILURE'S DELIVERY AND ITS JUDGEMENT, natively, for each
   * caller. The rule ("a failure delivered before the page's pagehide began is protected, however soon the page leaves") is exact only
   * if the runner judges a failure in the task it is delivered in. Here a genuine network failure (`ABORTED`: the stub's `route.abort`,
   * delivered in a task of its own) is answered to the held call, and AS IT IS DELIVERED a `pagehide` of the page is queued for the next
   * task (`setTimeout`, from a reaction to the very fetch the production transport made; every outcome write fails). Had anything between
   * the session's fetch and the runner's classification waited for a task, the failure would be judged after that `pagehide` (a
   * departure) and left unfenced; it is fenced first. The synthetic `pagehide` does not unload the page. FIXTURE evidence.
   */
  for (const caller of ["discovery", "command", "position"] as const)
    test(`E-M12h (R36-J) ${caller}: a genuine failure with the page's pagehide queued for the next task as it is delivered: fenced before that pagehide (judged in the task it was delivered in)`, async ({
      context,
    }, info) => {
      const task = repeating(
        470 + ["discovery", "command", "position"].indexOf(caller),
        `Water the ${caller} hedge`,
      );
      await r16(context, task.taskId, caller, true);
      await context.addInitScript(
        ([id, which]) => {
          const w = window as unknown as {
            __r16h?: { armed: boolean; log: string[] };
          };
          if (w.__r16h) return;
          const t = { armed: false, log: [] as string[] };
          w.__r16h = t;
          const set = Storage.prototype.setItem;
          Storage.prototype.setItem = function (
            this: Storage,
            key: string,
            v: string,
          ) {
            if (
              key.startsWith("atlas-write-failing:") &&
              (key.includes(`:materialise:${id}`) ||
                key.includes(`:materialise-lost:${id}`))
            )
              t.log.push("marker:set");
            return set.call(this, key, v);
          };
          const real = window.fetch;
          window.fetch = function (
            this: unknown,
            ...args: Parameters<typeof fetch>
          ) {
            const pending = real.apply(this, args);
            const url =
              args[0] instanceof Request ? args[0].url : String(args[0]);
            const ours =
              which === "command"
                ? url.includes("/task-commands")
                : url.includes(`/tasks/${id}`);
            if (ours)
              pending.then(undefined, () => {
                if (!t.armed) return;
                t.armed = false;
                t.log.push("delivered");
                setTimeout(() => {
                  t.log.push("pagehide (next task)");
                  dispatchEvent(new Event("pagehide"));
                }, 0);
              });
            return pending;
          } as typeof fetch;
        },
        [task.taskId, caller] as const,
      );
      const first = held<Answer>();
      let reads16 = 0;
      let commands = 0;
      const { page, r10c } = await setup(
        context,
        `/today?day=${TODAY}&tz=UTC`,
        [task],
        (q, r) => {
          q.respond = (d) =>
            dailyPage(
              [view(task)],
              d.scope === "joint" ? { pending_tasks: [task.taskId] } : {},
            );
          r.position = () => {
            reads16 += 1;
            if (caller === "discovery")
              return reads16 === 1
                ? first.promise
                : detailOf(task, { last_date: TODAY, pending: false });
            if (reads16 === 1)
              return detailOf(task, {
                last_date: yesterday(20),
                pending: true,
              });
            if (caller === "position" && reads16 === 2) return first.promise;
            return detailOf(task, { last_date: TODAY, pending: false });
          };
          r.materialise = () => {
            commands += 1;
            return caller === "command" && commands === 1
              ? first.promise
              : { status: 200, body: { revision: 8 } };
          };
        },
      );
      await expect
        .poll(
          () =>
            caller === "command"
              ? commands === 1
              : reads16 === (caller === "discovery" ? 1 : 2),
          { timeout: 15_000 },
        )
        .toBe(true);
      await page.evaluate(() => {
        (window as unknown as { __r16: { fault: boolean } }).__r16.fault = true;
        (window as unknown as { __r16h: { armed: boolean } }).__r16h.armed =
          true;
      });
      first.release(ABORTED);
      await expect
        .poll(
          () =>
            page.evaluate(
              () =>
                (window as unknown as { __r16h: { log: string[] } }).__r16h.log,
            ),
          { timeout: 15_000 },
        )
        .toContain("pagehide (next task)");
      await page.waitForTimeout(500);
      const log = await page.evaluate(
        () => (window as unknown as { __r16h: { log: string[] } }).__r16h.log,
      );
      recordEvidence(info, `e-m12h-${caller}`, {
        log,
        markers: await markersOf(page, task.taskId),
        requests: r10c.log.map(({ from: _from, ...e }) => e),
      });
      const delivered = log.indexOf("delivered");
      // The fence of THIS failure (a position read's caller was fenced once before, by the command's known success, then retired).
      const set = log.indexOf("marker:set", delivered + 1);
      const hide = log.indexOf("pagehide (next task)");
      expect(
        delivered,
        "precondition: the genuine failure was delivered",
      ).not.toBe(-1);
      expect(set, "fenced").not.toBe(-1);
      expect(
        set,
        "fenced BEFORE the pagehide queued as the failure was delivered: no task between delivery and judgement",
      ).toBeLessThan(hide);
      expect(await markersOf(page, task.taskId)).toHaveLength(1);
    });
});

/**
 * Revision 17 (review 18's R36-K; Kieran's decision approval/web10c-r36k-conservative-recovery-20261102.json; design assessment Q3/Q4):
 * a REAL reload while a second same-origin page holds a valid readwrite transaction over the account database (no product write, no
 * injected fault), released when the navigation completes and proved complete before recovery is assessed; and a live owner whose
 * outcome write keeps failing, with a peer tab. Maintained from Review 18's and Review 17's probes. FIXTURE evidence (stub server), real
 * engines, IndexedDB, Web Locks and lifecycle. The ordinary E-M2 recovery observation (20 s) is kept; no production timer is changed.
 */
test.describe("E-M12i/j: a lost answer after a real reload under database contention, and a live owner's unwritten outcome (revision 17: R36-K)", () => {
  type Caller = "discovery" | "command" | "position";
  const fencesOf = (page: Page, taskId: string) =>
    page.evaluate(
      (id) =>
        Object.keys(localStorage).filter(
          (k) =>
            k.startsWith("atlas-write-failing:") &&
            (k.includes(`:materialise:${id}`) ||
              k.includes(`:materialise-lost:${id}`)),
        ),
      taskId,
    );
  for (const caller of ["discovery", "command", "position"] as Caller[])
    for (const blocked of [false, true])
      test(`E-M12i ${caller} ${blocked ? "WITNESS (a transaction held until the reload completes)" : "CONTROL (available database)"}: the call left unanswered by a real reload is recovered by the next page${caller === "command" ? " with the same key" : caller === "position" ? " as the row's own read, no other materialise" : ""}`, async ({
        context,
      }, info) => {
        const task = repeating(461, "Contended fern");
        const first = held<Answer>();
        let calls = 0;
        let sent = 0;
        let holding = false;
        let caughtUp = false;
        await context.route("**/__r17-blank", (r) =>
          r.fulfill({
            status: 200,
            contentType: "text/html",
            body: "<!doctype html><title>transaction owner</title>",
          }),
        );
        const { page, r10c } = await setup(
          context,
          `/today?day=${TODAY}&tz=UTC`,
          [task],
          (q, r) => {
            q.respond = (d) =>
              dailyPage(
                [view(task)],
                d.scope === "joint" ? { pending_tasks: [task.taskId] } : {},
              );
            r.position = () => {
              calls += 1;
              if (caller === "discovery" && calls === 1) return first.promise;
              if (caller === "position" && sent > 0 && !holding) {
                holding = true;
                return first.promise;
              }
              return detailOf(
                task,
                caughtUp || (caller === "position" && sent > 0)
                  ? { last_date: TODAY, pending: false }
                  : caller === "discovery"
                    ? { last_date: TODAY, pending: false }
                    : { last_date: yesterday(20), pending: true },
              );
            };
            r.materialise = () => {
              sent += 1;
              if (caller === "command" && sent === 1) return first.promise;
              caughtUp = true;
              return { status: 200, body: { revision: 9 } };
            };
          },
        );
        await expect
          .poll(
            () =>
              caller === "discovery"
                ? calls === 1
                : caller === "command"
                  ? sent === 1
                  : holding,
            { timeout: 15_000 },
          )
          .toBe(true);
        const before = { calls, sent };
        const helper = await context.newPage();
        await helper.goto("/__r17-blank");
        const initial = await helper.evaluate(
          async ({ id, blocked, account, caller }) => {
            const w = window as unknown as Record<string, unknown>;
            const db = await new Promise<IDBDatabase>((resolve, reject) => {
              const r = indexedDB.open(`atlas-${account}`);
              r.onsuccess = () => resolve(r.result);
              r.onerror = () => reject(r.error);
            });
            const all = (store: string) =>
              new Promise<Array<Record<string, unknown>>>((resolve, reject) => {
                const r = db.transaction(store).objectStore(store).getAll();
                r.onsuccess = () => resolve(r.result);
                r.onerror = () => reject(r.error);
              });
            const issued =
              caller === "discovery"
                ? (
                    (await all("sync_state"))[0]?.materialise_discovery as
                      | Record<string, { schedule?: { issued?: number } }>
                      | undefined
                  )?.[id]?.schedule?.issued
                : (
                    (await all("materialise_sequences")).find(
                      (x) => x.task_id === id,
                    )?.schedule as { issued?: number } | undefined
                  )?.issued;
            w.__r17db = db;
            w.__r17hold = false;
            w.__r17done = !blocked;
            w.__r17cycles = 0;
            if (blocked)
              await new Promise<void>((resolve, reject) => {
                const stores =
                  caller === "discovery"
                    ? ["sync_state"]
                    : ["sync_state", "materialise_sequences"];
                const tx = db.transaction(stores, "readwrite");
                w.__r17hold = true;
                tx.oncomplete = () => {
                  w.__r17done = true;
                };
                tx.onerror = () => reject(tx.error);
                const again = () => {
                  const r = tx.objectStore("sync_state").getAll();
                  r.onsuccess = () => {
                    w.__r17cycles = (w.__r17cycles as number) + 1;
                    if (w.__r17cycles === 1) resolve();
                    if (w.__r17hold) again();
                  };
                  r.onerror = () => reject(r.error);
                };
                again();
              });
            return { issued: issued ?? null, cycles: w.__r17cycles as number };
          },
          { id: task.taskId, blocked, account: ACCOUNT, caller },
        );
        expect(
          initial.issued,
          "precondition: the call is durably issued",
        ).not.toBeNull();
        if (blocked)
          expect(
            initial.cycles,
            "precondition: the transaction is held",
          ).toBeGreaterThan(0);
        try {
          await reboot(page);
        } finally {
          await helper.evaluate(() => {
            (window as unknown as Record<string, unknown>).__r17hold = false;
          });
        }
        await helper.waitForFunction(
          () =>
            (window as unknown as Record<string, unknown>).__r17done === true,
        );
        // The ordinary E-M2 recovery observation; no timer shortened.
        await expect
          .poll(() => (caller === "command" ? sent : calls - before.calls), {
            timeout: 20_000,
          })
          .toBeGreaterThanOrEqual(caller === "command" ? 2 : 1);
        await info.attach("observations", {
          body: JSON.stringify(
            {
              initial,
              calls,
              sent,
              before,
              fences: await fencesOf(page, task.taskId),
              log: r10c.log.map(({ from: _, ...e }) => e),
            },
            null,
            2,
          ),
          contentType: "application/json",
        });
        first.release(
          caller === "command"
            ? { status: 200, body: { revision: 9 } }
            : detailOf(task, { last_date: TODAY, pending: false }),
        );
        await helper.evaluate(() => {
          (
            (window as unknown as Record<string, unknown>)
              .__r17db as IDBDatabase
          ).close();
        });
        await helper.close();
        if (caller === "command")
          expect(posts(r10c)[1]?.key, "the same attempt").toBe(
            posts(r10c)[0]?.key,
          );
        if (caller === "position")
          expect(sent, "no other materialise after the known success").toBe(
            before.sent,
          );
        await expect
          .poll(() => fencesOf(page, task.taskId), { timeout: 10_000 })
          .toHaveLength(0);
        await expect(
          page.locator(
            `[data-catch-up-task="${task.taskId}"][data-catch-up-stopped]`,
          ),
        ).toHaveCount(0);
      });

  test("E-M12j discovery: a LIVE owner whose outcome cannot be written keeps every other tab from reading for it (its fence and its lock held); once it closes, the other tab's Try again recovers the read", async ({
    context,
  }) => {
    const task = repeating(462, "Owned fern");
    const first = held<Answer>();
    let reads = 0;
    await context.addInitScript((id) => {
      const w = window as unknown as {
        __r17j: { fault: boolean; failures: number };
      };
      w.__r17j = { fault: false, failures: 0 };
      const put = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function (
        this: IDBObjectStore,
        ...args: [unknown, IDBValidKey?]
      ) {
        const e = (
          args[0] as {
            materialise_discovery?: Record<
              string,
              { schedule?: { issued?: number | null; cause?: string } }
            >;
          }
        )?.materialise_discovery?.[id];
        if (
          this.name === "sync_state" &&
          w.__r17j.fault &&
          e?.schedule?.issued === null &&
          e?.schedule?.cause === "transport"
        ) {
          w.__r17j.failures += 1;
          throw new DOMException("controlled outcome failure", "DataError");
        }
        return put.apply(this, args);
      };
    }, task.taskId);
    const { page } = await setup(
      context,
      `/today?day=${TODAY}&tz=UTC`,
      [task],
      (q, r) => {
        q.respond = (d) =>
          dailyPage(
            [view(task)],
            d.scope === "joint" ? { pending_tasks: [task.taskId] } : {},
          );
        r.position = () => {
          reads += 1;
          return reads === 1
            ? first.promise
            : detailOf(task, { last_date: TODAY, pending: false });
        };
      },
    );
    await expect.poll(() => reads, { timeout: 15_000 }).toBe(1);
    await page.evaluate(() => {
      (window as unknown as { __r17j: { fault: boolean } }).__r17j.fault = true;
    });
    first.release(ABORTED);
    await expect(
      page.locator(`[data-catch-up-task="${task.taskId}"]`),
    ).toHaveAttribute("data-catch-up-stopped", "unreachable", {
      timeout: 15_000,
    });
    expect(
      await page.evaluate(
        () =>
          (window as unknown as { __r17j: { failures: number } }).__r17j
            .failures,
      ),
      "real IndexedDB outcome failures occurred",
    ).toBeGreaterThan(0);
    expect(await fencesOf(page, task.taskId), "the fence stands").toHaveLength(
      1,
    );
    const other = await bootAt(context, `/today?day=${TODAY}&tz=UTC`);
    await expect(
      other.getByRole("heading", { name: "Today", exact: true }),
    ).toBeVisible({
      timeout: 15_000,
    });
    // A bounded observation that nothing is read (the owner's repairs end within about 1.25 s).
    await other.waitForTimeout(3_000);
    expect(
      reads,
      "Decision B: no other tab reads while the live owner's outcome cannot be written",
    ).toBe(1);
    const notice = other.locator(`[data-catch-up-task="${task.taskId}"]`);
    await expect(notice).toHaveAttribute("data-catch-up-stopped", "storage", {
      timeout: 15_000,
    });
    // The owner's tab closes (the browser lets its locks go): the person's Try again in the other tab rediscovers the read.
    await page.close();
    await notice.getByRole("button", { name: "Try again" }).click();
    await expect.poll(() => reads, { timeout: 20_000 }).toBe(2);
    await expect
      .poll(() => fencesOf(other, task.taskId), { timeout: 10_000 })
      .toHaveLength(0);
  });
});

test.describe("E-M12k: a lost call's committed pause whose fence outlived its page (revision 18: review 19's R36-L)", () => {
  // Pages A (its call held, then a transport failure observed while another connection holds a valid readwrite transaction over the
  // affected stores: its outcome write cannot land before A closes), B (rediscovers the lost call and commits its PAUSE: a window, by a
  // scripted forward clock boundary that is NOT the real 180-second observation, or a clock moved back; its retirement of the fence is
  // refused by the store for B's whole lifetime in the witnesses) and C (a healthy store). C shows the stop, sends nothing for it and
  // ends the fence; the person's Try again resumes the same work once. `owner`: a live page holds the fence's own Web Lock: C ends
  // nothing and its press is held until that page lets go. FIXTURE evidence (stubbed answers), REAL IndexedDB, localStorage and Web Locks.
  type Caller = "discovery" | "command" | "position";
  type Mode = "control" | "witness" | "clock" | "owner";
  const label: Record<Mode, string> = {
    control: "CONTROL (its fence retired by its page)",
    witness: "WITNESS (the removal refused until its page closed)",
    clock: "WITNESS (a clock pause; the removal refused until its page closed)",
    owner: "SAFETY (a live page holds the fence's lock)",
  };
  for (const caller of ["discovery", "command", "position"] as Caller[])
    for (const mode of ["control", "witness", "clock", "owner"] as Mode[])
      test(`E-M12k ${caller} ${label[mode]}: the next page shows the paused stop and sends nothing for it; Try again resumes ${caller === "command" ? "the same key and body" : caller === "position" ? "the row's own read, no other materialise" : "the read"} once`, async ({
        context,
      }, info) => {
        const task = repeating(481, "Recoverable fern");
        const first = held<Answer>();
        let reads = 0;
        let sent = 0;
        let holding = false;
        let caughtUp = false;
        const marker =
          caller === "discovery"
            ? `:materialise-lost:${task.taskId}#`
            : `:materialise-lost:${task.taskId}:`;
        await context.route("**/__r18-blank", (r) =>
          r.fulfill({
            status: 200,
            contentType: "text/html",
            body: "<!doctype html><title>transaction owner</title>",
          }),
        );
        await context.addInitScript((key) => {
          const now = Date.now;
          const offset = Number(localStorage.getItem("__r18offset") ?? 0);
          Date.now = () => now() + offset;
          const remove = Storage.prototype.removeItem;
          Storage.prototype.removeItem = function (this: Storage, k: string) {
            if (
              k.startsWith("atlas-write-failing:") &&
              k.includes(key) &&
              localStorage.getItem("__r18failRetire") === "yes"
            )
              throw new DOMException("removal refused", "SecurityError");
            return remove.call(this, k);
          };
        }, marker);
        const { page, r10c } = await setup(
          context,
          `/today?day=${TODAY}&tz=UTC`,
          [task],
          (q, r) => {
            q.respond = (d) =>
              dailyPage(
                [view(task)],
                d.scope === "joint" ? { pending_tasks: [task.taskId] } : {},
              );
            r.position = () => {
              reads += 1;
              if (caller === "discovery" && reads === 1) return first.promise;
              if (caller === "position" && sent > 0 && !holding) {
                holding = true;
                return first.promise;
              }
              return detailOf(
                task,
                caller === "discovery" ||
                  caughtUp ||
                  (caller === "position" && sent > 0)
                  ? { last_date: TODAY, pending: false }
                  : { last_date: yesterday(20), pending: true },
              );
            };
            r.materialise = () => {
              sent += 1;
              if (caller === "command" && sent === 1) return first.promise;
              caughtUp = true;
              return { status: 200, body: { revision: 9 } };
            };
          },
        );
        await expect
          .poll(
            () =>
              caller === "discovery"
                ? reads === 1
                : caller === "command"
                  ? sent === 1
                  : holding,
            { timeout: 15_000 },
          )
          .toBe(true);
        const helper = await context.newPage();
        await helper.goto("/__r18-blank");
        await helper.evaluate(async (account) => {
          const w = window as unknown as Record<string, unknown>;
          const db = await new Promise<IDBDatabase>((resolve, reject) => {
            const r = indexedDB.open(`atlas-${account}`);
            r.onsuccess = () => resolve(r.result);
            r.onerror = () => reject(r.error);
          });
          w.__r18db = db;
          w.__r18hold = true;
          w.__r18done = false;
          await new Promise<void>((resolve, reject) => {
            const tx = db.transaction(
              ["sync_state", "materialise_sequences"],
              "readwrite",
            );
            let n = 0;
            tx.oncomplete = () => {
              w.__r18done = true;
            };
            tx.onerror = () => reject(tx.error);
            const again = () => {
              const r = tx.objectStore("sync_state").getAll();
              r.onsuccess = () => {
                n += 1;
                if (n === 1) resolve();
                if (w.__r18hold) again();
              };
              r.onerror = () => reject(r.error);
            };
            again();
          });
        }, ACCOUNT);
        const marks = () =>
          helper.evaluate(
            (key) =>
              Object.keys(localStorage).filter(
                (k) => k.startsWith("atlas-write-failing:") && k.includes(key),
              ),
            marker,
          );
        const state = () =>
          helper.evaluate(
            async ({ id, caller }) => {
              const db = (window as unknown as { __r18db: IDBDatabase })
                .__r18db;
              const store =
                caller === "discovery" ? "sync_state" : "materialise_sequences";
              const rows = await new Promise<Array<Record<string, unknown>>>(
                (resolve, reject) => {
                  const r = db.transaction(store).objectStore(store).getAll();
                  r.onsuccess = () => resolve(r.result);
                  r.onerror = () => reject(r.error);
                },
              );
              return (
                caller === "discovery"
                  ? (
                      rows[0]?.materialise_discovery as
                        | Record<string, unknown>
                        | undefined
                    )?.[id]
                  : rows.find((x) => x.task_id === id)
              ) as Record<string, unknown> | undefined;
            },
            { id: task.taskId, caller },
          );
        // A observes the transport failure; its outcome write waits behind the held transaction while A closes.
        first.release(ABORTED);
        await expect.poll(marks, { timeout: 15_000 }).toHaveLength(1);
        await page.close();
        await helper.evaluate(() => {
          (window as unknown as Record<string, unknown>).__r18hold = false;
        });
        await helper.waitForFunction(
          () =>
            (window as unknown as Record<string, unknown>).__r18done === true,
        );
        // A scripted clock: past the window (not a real elapsed-duration claim), or moved back before the call's issue.
        await helper.evaluate((m) => {
          localStorage.setItem(
            "__r18offset",
            m === "clock" ? "-120000" : "181000",
          );
          localStorage.setItem(
            "__r18failRetire",
            m === "control" ? "no" : "yes",
          );
        }, mode);
        const second = await bootAt(context, `/today?day=${TODAY}&tz=UTC`);
        await expect
          .poll(
            async () =>
              ((await state())?.schedule as { pause?: string } | undefined)
                ?.pause,
            { timeout: 15_000 },
          )
          .toBe(mode === "clock" ? "clock" : "window");
        await expect(
          second.locator(
            `[data-catch-up-task="${task.taskId}"][data-catch-up-stopped]`,
          ),
        ).toHaveCount(1);
        expect(
          await marks(),
          "precondition: the fence after the rediscovering page",
        ).toHaveLength(mode === "control" ? 0 : 1);
        const paused = await state();
        expect(
          (paused?.schedule as { issued?: unknown } | undefined)?.issued,
          "precondition: nothing outstanding",
        ).toBeNull();
        await second.close();
        await helper.evaluate((m) => {
          localStorage.setItem("__r18failRetire", "no");
          if (m === "clock") localStorage.setItem("__r18offset", "0");
        }, mode);
        if (mode === "owner")
          await helper.evaluate((key) => {
            const k = Object.keys(localStorage).find(
              (x) => x.startsWith("atlas-write-failing:") && x.includes(key),
            ) as string;
            const scope = (
              k.slice("atlas-write-failing:".length).split("#")[0] as string
            ).split(":");
            const name = `atlas-materialise-fence:${decodeURIComponent(scope[0] as string)}:${decodeURIComponent(scope[1] as string)}:${scope.slice(2).join(":")}`;
            const w = window as unknown as Record<string, unknown>;
            w.__r18lock = name;
            void navigator.locks.request(
              name,
              () =>
                new Promise<void>((resolve) => {
                  w.__r18letGo = resolve;
                }),
            );
          }, marker);
        if (mode === "owner")
          await helper.waitForFunction(
            () =>
              typeof (window as unknown as Record<string, unknown>)
                .__r18letGo === "function",
          );
        const third = await bootAt(context, `/today?day=${TODAY}&tz=UTC`);
        const notice = third.locator(`[data-catch-up-task="${task.taskId}"]`);
        await expect(notice).toHaveAttribute(
          "data-catch-up-stopped",
          "unreachable",
          { timeout: 15_000 },
        );
        // A bounded observation that plain work sends nothing for the stop (no timer shortened).
        await third.waitForTimeout(3_000);
        expect(await state(), "the stop exactly as recorded").toEqual(paused);
        expect(sent, "no other materialise").toBe(
          caller === "discovery" ? 0 : 1,
        );
        if (caller === "discovery") expect(reads, "no discovery read").toBe(1);
        expect(
          await marks(),
          mode === "owner" ? "a live owner's fence stands" : "the fence ended",
        ).toHaveLength(mode === "owner" ? 1 : 0);
        const before = { reads, sent };
        if (mode === "owner") {
          await notice.getByRole("button", { name: "Try again" }).click();
          // Held: the recorded stop stays shown (it is shown before the page's own memory stop), with the same token.
          await third.waitForTimeout(3_000);
          await expect(notice).toHaveAttribute(
            "data-catch-up-stopped",
            "unreachable",
          );
          expect({ reads, sent }, "held: nothing sent").toEqual(before);
          expect(await state()).toEqual(paused);
          expect(await marks()).toHaveLength(1);
          await helper.evaluate(() => {
            (
              (window as unknown as Record<string, unknown>)
                .__r18letGo as () => void
            )();
          });
        }
        await notice.getByRole("button", { name: "Try again" }).click();
        // The ordinary recovery observation (E-M2's 20 s bound).
        await expect.poll(() => state(), { timeout: 20_000 }).toBeUndefined();
        await info.attach("observations", {
          body: JSON.stringify(
            {
              mode,
              before,
              after: { reads, sent },
              paused,
              marks: await marks(),
              log: r10c.log.map(({ from: _, ...e }) => e),
            },
            null,
            2,
          ),
          contentType: "application/json",
        });
        await helper.evaluate(() => {
          (
            (window as unknown as Record<string, unknown>)
              .__r18db as IDBDatabase
          ).close();
        });
        await helper.close();
        if (caller === "command") {
          expect(sent, "the held attempt resent once").toBe(before.sent + 1);
          expect(posts(r10c)[1]?.key, "the same key").toBe(posts(r10c)[0]?.key);
          expect(JSON.stringify(posts(r10c)[1]?.body), "the same body").toBe(
            JSON.stringify(posts(r10c)[0]?.body),
          );
        }
        if (caller === "discovery")
          expect(reads, "the discovery read once").toBe(before.reads + 1);
        if (caller === "position") {
          expect(sent, "no other materialise after the known success").toBe(1);
          expect(
            reads - before.reads,
            "the new discovery and the row's own position read",
          ).toBe(2);
        }
        await expect(notice).toHaveCount(0);
      });
});
