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
  /**
   * Revision 21 (the E-ANC2 failing-order control only; the default keeps every other case unchanged): `awaitIdle: false` returns once
   * the leader was started, without waiting for the harness's leader to be idle.
   */
  options: { awaitIdle?: boolean } = {},
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
  if (options.awaitIdle === false) return { page, net, cal };
  await waitForState(page, "idle");
  cal.phase = "test";
  return { page, net, cal };
}

/** A promise and its resolver (revision 21). */
const held = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

/** The harness's data gate closures so far (`[ms, account, reason, stack]`; WEB-09a R43) and its leader's state (revision 21). */
const gateFacts = (page: Page) =>
  page.evaluate(() => {
    const data = window.__atlasData;
    return {
      closes: (data?.gateDiagnostics().closes ?? []).map((c) => String(c[2])),
      engine: data?.engineState() ?? null,
    };
  });

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
    // Revision 21 (managed run 8d7e22bd, pool request-07b6cd6f2458428dbd01, m4-air Chromium: set-up timed out at waitForState "idle"):
    // the read is issued at boot while the harness starts its leader. Answered before set-up had seen that leader idle, its session
    // re-check disposed the BOUND tree (`closeAll(closed_for_deletion)` at 162 ms, WEB-09a R43) and the harness's leader with it, so
    // set-up waited for an idle that could never come. The FIRST 403 is therefore held until set-up has seen the leader idle (the order
    // of every earlier pass); the case's 403s, its assertions and its timers are unchanged. The failing order itself is the control below.
    const forbidden = held<{ status: number; body: unknown }>();
    const { page, cal } = await taskPage(
      context,
      `/tasks/${a.taskId}`,
      [a],
      [source],
      (c) => {
        c.answers.set("/tasks/*/anchor", [
          { wait: forbidden.promise },
          { status: 403, body: atlasBody("forbidden") },
        ]);
      },
    );
    forbidden.resolve({ status: 403, body: atlasBody("forbidden") });
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

  test("control (revision 21): the 403 answered before set-up has seen the harness's leader idle: its re-check ends that leader for good, so set-up's wait for idle cannot succeed; the section still fails once and asks nothing more", async ({
    context,
    browserName,
  }) => {
    test.setTimeout(90_000);
    const a = buildTask({ n: 45, title: "Put the bins out" });
    // The failing run's order: the read (issued once the delta has delivered the task) is answered 403 with no wait for the harness's
    // leader to be idle. The answer is held only until the read has arrived, then released at once.
    const forbidden = held<{ status: number; body: unknown }>();
    const { page, cal } = await taskPage(
      context,
      `/tasks/${a.taskId}`,
      [a],
      [source],
      (c) => {
        c.answers.set("/tasks/*/anchor", [
          { wait: forbidden.promise },
          { status: 403, body: atlasBody("forbidden") },
        ]);
      },
      { awaitIdle: false },
    );
    await expect
      .poll(() => anchorReads(cal).length, { timeout: 20_000 })
      .toBe(1);
    forbidden.resolve({ status: 403, body: atlasBody("forbidden") });
    // The re-check's closure of the bound tree (Chromium and Firefox; WebKit's tree may bind without a remount, WEB-09a R43, so there
    // only the implication is asserted: a closure leaves no harness leader).
    if (browserName !== "webkit")
      await expect
        .poll(async () => (await gateFacts(page)).closes, { timeout: 20_000 })
        .toContain("closed_for_deletion");
    await expect(section(page)).toHaveAttribute(
      "data-anchor-section",
      "failed",
      { timeout: 20_000 },
    );
    await page.waitForTimeout(4_000);
    const facts = await gateFacts(page);
    test.info().annotations.push({
      type: "gate facts",
      description: JSON.stringify(facts),
    });
    // Observed in all three engines (revision 21 probe anc2-3): after the closure the harness's leader waits on a cache that is no longer
    // valid, so it is not idle and set-up's wait for idle (the failing run's 60 s timeout) cannot be met in this order.
    if (facts.closes.includes("closed_for_deletion"))
      expect(
        facts.engine,
        "the closure leaves the harness's leader waiting, never idle: set-up's wait for idle could not have succeeded",
      ).toEqual({ kind: "waiting", reason: "cache_not_valid" });
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
    // Revision 22 (review 26 F26-1): the WHOLE message, not only its prefix: a 422 names no rule, so the reason is the generic one.
    await expect(section(page).locator("[data-anchor-rejected]")).toContainText(
      "Couldn't anchor this task — the server turned it down",
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

  test("revision 22 (review 26 F26-1): a refused change is explained by its refusal alone — an old timed seconds binding, a later visit's null binding and offline give the same generic reason; Dismiss removes it and nothing is resent", async ({
    context,
  }) => {
    test.setTimeout(120_000);
    const a = buildTask({ n: 47, title: "Put the bins out" });
    // The binding the server keeps (a refused change does not replace it): a timed event series with a SECONDS offset.
    const seconds = {
      reference: ANCHOR.reference,
      offset: { kind: "elapsed_seconds", seconds: -3600 },
      weekdays: [],
    };
    const { page, cal } = await taskPage(
      context,
      `/tasks/${a.taskId}`,
      [a],
      [source, event(true)],
      (c) => {
        c.binding = { binding: { anchor: seconds, version: 1, active: true } };
      },
    );
    await expect(section(page)).toHaveAttribute(
      "data-anchor-section",
      "anchored",
      { timeout: 20_000 },
    );
    const firstReads = anchorReads(cal).length;
    cal.answers.set("/calendar-commands", [
      { status: 422, body: atlasBody("invalid_value") },
    ]);
    // A change to a calendar-days offset (no seconds in it at all), refused with a generic 422.
    await section(page).getByRole("button", { name: "Change anchor…" }).click();
    const dialog = page.getByRole("dialog", { name: "Anchor to a calendar" });
    await dialog.getByRole("radio", { name: "calendar day(s), at" }).check();
    await dialog.getByLabel("Days before (−) or after (+)").fill("-1");
    await dialog.getByRole("button", { name: "Save anchor" }).click();
    await expect(dialog).toBeHidden();
    await send(page);
    const refusal = section(page).locator("[data-anchor-rejected] > span");
    const GENERIC = "Couldn't anchor this task — the server turned it down";
    await expect(refusal).toHaveText(GENERIC, { timeout: 30_000 });
    const sent = posts(cal, "/calendar-commands");
    expect(sent).toHaveLength(1);
    expect(JSON.parse(sent[0]?.body ?? "")).toMatchObject({
      command: {
        kind: "set_anchor",
        id: a.taskId,
        anchor: { offset: { kind: "calendar_days", days: -1 } },
      },
    });
    const refused = (
      (await rows(page, "drafts")) as Array<{
        kind: string;
        status: string;
        local_id: string;
        last_error: unknown;
      }>
    ).filter((d) => d.kind === "set_anchor");
    expect(refused).toMatchObject([
      {
        status: "rejected",
        last_error: { status: 422, code: "invalid_value" },
      },
    ]);
    // A later visit reads a different binding (none): the refusal's reason does not change.
    cal.binding = { binding: null };
    await revisit(page, a.taskId);
    await expect(section(page)).toHaveAttribute("data-anchor-section", "none", {
      timeout: 20_000,
    });
    await expect(refusal).toHaveText(GENERIC);
    expect(anchorReads(cal).length).toBe(firstReads + 1);
    // Offline, a new visit reads nothing: the same reason, from the durable refusal alone.
    await goOfflineAtBoundary(page);
    await revisit(page, a.taskId);
    await expect(section(page)).toHaveAttribute(
      "data-anchor-section",
      "offline",
    );
    await expect(refusal).toHaveText(GENERIC);
    expect(anchorReads(cal).length).toBe(firstReads + 1);
    // Dismiss removes that refused change only when asked; nothing is resent.
    await section(page).getByRole("button", { name: "Dismiss" }).click();
    await expect(section(page).locator("[data-anchor-rejected]")).toHaveCount(
      0,
    );
    await expect
      .poll(async () =>
        ((await rows(page, "drafts")) as Array<{ local_id: string }>).map(
          (d) => d.local_id,
        ),
      )
      .not.toContain(refused[0]?.local_id);
    expect(posts(cal, "/calendar-commands")).toHaveLength(1);
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

test.describe("E-ANC4: a section kept mounted through a departure and return (revision 3, review 3 R3c)", () => {
  test("away and back in one turn: the binding is read for the visit going on, and a panel opened afterwards is kept by its sync control and saved once", async ({
    context,
  }) => {
    test.setTimeout(120_000);
    const a = buildTask({ n: 46, title: "Put the bins out" });
    const { page, cal } = await taskPage(
      context,
      `/tasks/${a.taskId}`,
      [a],
      [source, event(true)],
      (c) => {
        c.binding = { binding: { anchor: ANCHOR, version: 2, active: true } };
      },
    );
    await expect(section(page)).toHaveAttribute(
      "data-anchor-section",
      "anchored",
      { timeout: 20_000 },
    );
    const reads = anchorReads(cal).length;
    // The section element is marked, then the address goes away and comes back in one task: the browser's history, the router and the
    // document all move, and React keeps the same section (asserted by the mark).
    await section(page).evaluate((el) => {
      (el as HTMLElement & { r3c?: boolean }).r3c = true;
    });
    await page.evaluate((to) => {
      history.pushState(null, "", "/tasks");
      dispatchEvent(new PopStateEvent("popstate"));
      history.pushState(null, "", to);
      dispatchEvent(new PopStateEvent("popstate"));
    }, `/tasks/${a.taskId}`);
    await expect(page).toHaveURL(new RegExp(`/tasks/${a.taskId}$`));
    expect(
      await section(page).evaluate(
        (el) => (el as HTMLElement & { r3c?: boolean }).r3c === true,
      ),
      "React kept the section mounted",
    ).toBe(true);
    // A new visit: its own read, once.
    await expect.poll(() => anchorReads(cal).length).toBe(reads + 1);
    await expect(section(page)).toHaveAttribute(
      "data-anchor-section",
      "anchored",
    );
    // Typed only now, after the return.
    await section(page).getByRole("button", { name: "Change anchor…" }).click();
    let dialog = page.getByRole("dialog", { name: "Anchor to a calendar" });
    await dialog.getByLabel("Days before (−) or after (+)").fill("-7");
    await dialog.locator("[data-sync-tone]").click();
    await expect(dialog).toBeHidden();
    await expect(page).toHaveURL(/\/sync/);
    await page.goBack();
    await expect(section(page)).toBeVisible();
    await section(page).getByRole("button", { name: "Change anchor…" }).click();
    dialog = page.getByRole("dialog", { name: "Anchor to a calendar" });
    await expect(dialog.getByLabel("Days before (−) or after (+)")).toHaveValue(
      "-7",
    );
    await dialog.getByRole("button", { name: "Save anchor" }).click();
    await expect(dialog).toBeHidden();
    const bodies = (
      (await rows(page, "draft_commands")) as Array<{
        command: { command: { kind: string; anchor?: unknown } };
      }>
    ).filter((b) => b.command.command.kind === "set_anchor");
    expect(bodies.map((b) => b.command.command.anchor)).toEqual([
      {
        ...ANCHOR,
        offset: { kind: "calendar_days", days: -7, time: "18:00:00" },
      },
    ]);
    expect(anchorReads(cal)).toHaveLength(reads + 1);
  });
});
