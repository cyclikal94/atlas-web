import { readFileSync, writeFileSync } from "node:fs";
import type { BrowserContext, Page, Route } from "@playwright/test";
import * as commands from "../../src/features/tasks/model/commands";
import {
  type OccurrenceView,
  parseProgressState,
  type TaskDefinition,
} from "../../src/features/tasks/model/contract";
import {
  finalise,
  personalResult,
} from "../../src/features/tasks/model/evaluate";
import {
  occurrenceId,
  progressId,
  slotKey,
} from "../../src/features/tasks/model/ids";
import {
  addDays,
  dateIn,
  resolveWallTime,
  slotOn,
  todayIn,
} from "../../src/features/tasks/model/time";
import { taskCommandSpecs } from "../../src/features/tasks/register";
import {
  ACCOUNTS,
  bootHarness,
  expect,
  exposeSession,
  paceSignIn,
  proxy,
  signIn as signInUnpaced,
  stackFile,
  test,
  untilView,
  type Who,
} from "./helpers";

/**
 * WEB-10a against the RELEASED backend (`v0.28.0-rc.1`) on a disposable SQLite database behind the delaying proxy: the production session,
 * the production data controller and the task screens, with the FIXTURE leader standing in for WEB-09b's production leadership. The
 * client's own model (deterministic ids, wall time, evaluation and offline finalisation) and command builders are checked against what the
 * server stores and answers. FOCUSED REAL-BACKEND EVIDENCE for a fixture-stage task: BE-Q1 and BE-CH1 have no completion record, so this is
 * NOT integration acceptance (`integration_passed` stays false). No PostgreSQL, HTTPS or device.
 *
 * I-T1 UI create, Today, Mark done (TASK-27 #1); I-T2 offline create and record with the create's response lost (TASK-26); I-T3 a real preset
 * (TASK-29); I-T4 resolve/reopen for two readers (TASK-23 #1); I-T5 exclude without the policy (TASK-23 #2); I-T6 Anyone exclusion (TASK-23
 * #5); I-T7 Everyone: all excluded, a non-consented stream, an invisible stream, personal scope (TASK-23 #3/#4, TASK-31 #4/#5, TASK-17);
 * I-T9 late completion and offline finalisation (TASK-31 #1/#2/#6); I-T10 correction (TASK-27 #3-#5); I-T11 archive/restore; I-T12
 * TASK-7; I-T13 stale progress version; I-T14 enrolment; I-T15 corrections and the journal (TASK-12/12a); I-T17 defaults review; I-T18
 * Vienna gap and fold. Revision 1: I-T19 task edit in the UI and the task's sharing editor; I-T20 record and correction in the UI and the
 * progress sharing editor; I-T21 a version conflict resent from /sync and a record after it; I-T22 a rebuilt first Anyone record keeps its
 * defaults guard. Revision 10: I-T23 a consent change in the UI keeps a private enrolment audience for progress generated afterwards (R22).
 */
const API = "/api/experimental/v1";

// Sign-in pacing shared with the other integration specs (the same ledger file per stack): at most 8 attempts per account a minute.
const budget = (who: Who) => paceSignIn(who);
const ROTATION: Who[] = ["alice", "carol", "dave", "erin"];
const ROTATION_FILE = stackFile("atlas-tasks-rotation.txt");
let main: Who = "alice";
test.beforeEach(async ({ context }, info) => {
  void context;
  let n = 0;
  try {
    n = Number(readFileSync(ROTATION_FILE, "utf8")) || 0;
  } catch {
    n = 0;
  }
  writeFileSync(ROTATION_FILE, String(n + 1));
  main = ROTATION[n % ROTATION.length] as Who;
  info.setTimeout(180_000);
});

interface Id {
  account_id: string;
  epoch: number;
}
async function signedIn(page: Page, who: Who): Promise<Id> {
  await budget(who);
  expect((await signInUnpaced(page, who)).kind).toBe("settled");
  await untilView(page, "displaying");
  const id = (await page.evaluate(() =>
    window.__s.identity.get(),
  )) as Id | null;
  if (!id) throw new Error("no identity after sign-in");
  return id;
}

async function leader(page: Page, account: string): Promise<void> {
  await page.evaluate((a) => window.__atlasData?.prepareAccount(a), account);
  await page.evaluate(async (a) => {
    const data = window.__atlasData;
    if (!data) throw new Error("no data harness");
    await data.startOutbox(a, {});
    await data.startSync(a);
  }, account);
}

/** The page loaded again once the database exists, so the controller binds it from the start (see integration.sharing.spec.ts). */
async function reopenBound(
  page: Page,
  account: string,
  route: string,
): Promise<void> {
  await page.goto(`/__session?route=${encodeURIComponent(route)}`);
  await exposeSession(page);
  await untilView(page, "displaying");
  await page.evaluate(async (a) => {
    const data = window.__atlasData;
    if (!data) throw new Error("no data harness");
    await data.startOutbox(a, {});
    await data.startSync(a);
  }, account);
}

async function bootAs(context: BrowserContext, who: Who, route = "/tasks") {
  const page = await bootHarness(context, "/tasks");
  const id = await signedIn(page, who);
  await leader(page, id.account_id);
  await reopenBound(page, id.account_id, route);
  return { page, id };
}

/** A second account signed in for its own API calls only (no data harness, no screens). */
async function apiAs(context: BrowserContext, who: Who) {
  const page = await bootHarness(context, "/tasks");
  const id = await signedIn(page, who);
  return { page, id };
}

const go = (page: Page, path: string) =>
  page.evaluate((p) => {
    history.pushState(null, "", p);
    dispatchEvent(new PopStateEvent("popstate"));
  }, path);

interface Raw {
  status: number;
  body: unknown;
}
/** One stamped request made in the page (the session's own client), asked again while the session answers `not_sent`. */
const call = (
  page: Page,
  id: Id,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
  key?: string,
) =>
  page.evaluate(
    async ({ id, method, path, body, key }) => {
      const fetchFor = window.__s.api.fetchFor(
        "ordinary",
        id.account_id,
        id.epoch,
      );
      for (let attempt = 0; ; attempt += 1) {
        try {
          const response = await fetchFor(
            new Request(`${location.origin}/api/experimental/v1${path}`, {
              method,
              headers: {
                ...(body === undefined
                  ? {}
                  : { "content-type": "application/json" }),
                ...(key ? { "Idempotency-Key": key } : {}),
              },
              ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            }),
          );
          const text = await response.text();
          return {
            status: response.status,
            body: text ? JSON.parse(text) : null,
          };
        } catch (error) {
          if (
            !String((error as { kind?: string }).kind ?? error).includes(
              "not_sent",
            ) ||
            attempt >= 60
          )
            throw error;
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      }
    },
    { id, method, path, body, key },
  ) as Promise<Raw>;

/** A request built by the CLIENT's builder, with the bases given, sent once with a fresh key. */
const send = (
  page: Page,
  id: Id,
  request: ReturnType<typeof commands.record>,
  bases: Record<string, number> = {},
) =>
  call(
    page,
    id,
    "POST",
    "/task-commands",
    request.build(bases).command,
    crypto.randomUUID(),
  );
const access = (
  page: Page,
  id: Id,
  command: Record<string, unknown>,
  key = crypto.randomUUID(),
) => call(page, id, "POST", "/task-access-commands", { command }, key);

const ZONE = "Europe/London";
const today = () => todayIn(ZONE, Date.now());
const def = (
  over: Partial<TaskDefinition> = {},
  schedule: Partial<TaskDefinition["schedule"]> = {},
): TaskDefinition => ({
  schedule: {
    start_date: today(),
    time: null,
    timezone: ZONE,
    repeat: null,
    ...schedule,
  },
  goal: { kind: "checkbox" },
  carry: "close_incomplete",
  participation: "personal",
  open_days_before: 0,
  close_days_after: 1,
  allow_streak_exclusions: false,
  ...over,
});

interface Made {
  taskId: string;
  occurrenceId: string;
  progressId: string;
}
/** A task created through the client's builder (queueable `/task-commands`, or `/task-access-commands` with an explicit audience). */
async function makeTask(
  page: Page,
  id: Id,
  definition: TaskDefinition,
  options: {
    title?: string;
    grants?: Array<{ kind: "account"; id: string; edit: boolean }>;
    taskId?: string;
  } = {},
): Promise<Made> {
  const taskId = options.taskId ?? crypto.randomUUID();
  const slot = slotOn(definition.schedule, definition.schedule.start_date);
  const occ = await occurrenceId(taskId, slot.key);
  const prog = await progressId(occ, id.account_id);
  const request = commands.createTask({
    taskId,
    executionId: crypto.randomUUID(),
    occurrenceId: occ,
    progressId: prog,
    title: options.title ?? "I-T task",
    definition,
    sharing: "only_me",
    defaults: null,
  });
  const body = request.build({}).command as {
    command: Record<string, unknown>;
  };
  const out = options.grants
    ? await access(page, id, {
        ...body.command,
        initial_policy: { grants: options.grants, exclude_accounts: [] },
      })
    : await call(page, id, "POST", "/task-commands", body, crypto.randomUUID());
  expect(out.status, JSON.stringify(out.body)).toBe(200);
  return { taskId, occurrenceId: occ, progressId: prog };
}

const views = async (
  page: Page,
  id: Id,
  taskId: string,
  scope: "joint" | "personal",
): Promise<OccurrenceView[]> => {
  const out = await call(
    page,
    id,
    "GET",
    `/occurrences?task_id=${taskId}&scope=${scope}&limit=200`,
  );
  expect(out.status, JSON.stringify(out.body)).toBe(200);
  return (out.body as { items: OccurrenceView[] }).items;
};
const viewOf = async (
  page: Page,
  id: Id,
  taskId: string,
  occ: string,
  scope: "joint" | "personal",
) => (await views(page, id, taskId, scope)).find((v) => v.id === occ);
const progressOf = async (page: Page, id: Id, occ: string) =>
  (
    (await call(page, id, "GET", `/progress?parent_id=${occ}&limit=200`))
      .body as { items: Array<{ id: string; version: number; value: unknown }> }
  ).items;
const record = (
  occ: string,
  prog: string,
  me: string,
  evidence: Parameters<typeof commands.record>[0]["evidence"],
  over: Partial<Parameters<typeof commands.record>[0]> = {},
) =>
  commands.record({
    occurrenceId: occ,
    progressId: prog,
    me,
    entryId: crypto.randomUUID(),
    evidence,
    happenedAt: Math.floor(Date.now() / 1000),
    replaces: null,
    firstAnyoneStream: false,
    defaults: null,
    ...over,
  });
const cacheRow = async (page: Page, account: string, rid: string) =>
  (
    (await page.evaluate(
      (a) => window.__atlasData?.rows(a, "cache"),
      account,
    )) as Array<{
      id: string;
      version: number;
      value: unknown;
      archived: boolean;
    }>
  ).find((r) => r.id === rid);

test.describe("I-T1: a task made in the UI, on Today, marked done (A1, A3, A7; TASK-27 #1)", () => {
  test("create from scratch → synced → the Today row → Mark done → Done; the server's personal result equals the local reapplication", async ({
    context,
  }) => {
    const { page, id } = await bootAs(context, main, "/tasks/new");
    await page
      .getByRole("button", { name: "Start from scratch instead" })
      .click({ timeout: 30_000 });
    const title = `I-T1 ${Date.now() % 100_000}`;
    await page.getByLabel("Name", { exact: true }).fill(title);
    await page.getByLabel("Time zone").selectOption(ZONE);
    await page.getByRole("radio", { name: "Only me" }).check();
    await page.getByRole("button", { name: "Save" }).click();
    await expect(page.locator("[data-task-detail]")).toBeVisible({
      timeout: 30_000,
    });
    const taskId = new URL(page.url()).pathname.split("/").pop() as string;
    await page.evaluate(() => window.__atlasData?.retryOutbox());
    await expect
      .poll(
        async () => (await call(page, id, "GET", `/tasks/${taskId}`)).status,
        { timeout: 60_000 },
      )
      .toBe(200);
    const occ = await occurrenceId(taskId, `${today()}Tdate`);
    const prog = await progressId(occ, id.account_id);
    await go(page, `/today?day=${today()}&tz=${encodeURIComponent(ZONE)}`);
    const row = page.locator(`[data-today-row="${occ}"]`);
    await expect(row).toBeVisible({ timeout: 30_000 });
    await row.getByRole("button", { name: "Mark done" }).click();
    await page.evaluate(() => window.__atlasData?.retryOutbox());
    await expect
      .poll(
        async () => (await viewOf(page, id, taskId, occ, "personal"))?.outcome,
        { timeout: 60_000 },
      )
      .toBe("complete");
    await expect(row).toHaveAttribute("data-pill", "done", { timeout: 60_000 });
    await expect
      .poll(async () => (await cacheRow(page, id.account_id, prog))?.version, {
        timeout: 60_000,
      })
      .toBe(2);
    const server = await viewOf(page, id, taskId, occ, "personal");
    const cached = await cacheRow(page, id.account_id, prog);
    const local = personalResult({
      occurrence: server?.data as never,
      stream: parseProgressState(cached?.value),
      pending: [],
      streamPending: false,
      me: id.account_id,
      nowMs: Date.now(),
    });
    expect(local).toMatchObject({
      kind: "result",
      outcome: server?.outcome,
      periodOutcome: server?.period_outcome,
    });
  });
});

test.describe("I-T2: offline create and record, the create's response lost (A9; TASK-26)", () => {
  test("replayed with the same key: exactly one task, one occurrence and one entry, all under the client's ids", async ({
    context,
    provokes,
  }) => {
    provokes(502);
    const { page, id } = await bootAs(context, main, "/tasks/new");
    await page
      .getByRole("button", { name: "Start from scratch instead" })
      .click({ timeout: 30_000 });
    // The defaults snapshot is read while online, so the offline create is captured, not held for review.
    await expect(
      page.getByRole("radio", { name: /^Use my defaults/ }),
    ).toBeVisible();
    await page.evaluate(() => {
      const w = window as unknown as { __offline?: boolean };
      w.__offline = true;
      Object.defineProperty(Navigator.prototype, "onLine", {
        configurable: true,
        get: () => w.__offline !== true,
      });
      window.dispatchEvent(new Event("offline"));
    });
    await page
      .getByLabel("Name", { exact: true })
      .fill(`I-T2 ${Date.now() % 100_000}`);
    await page.getByLabel("Time zone").selectOption(ZONE);
    await page.getByRole("button", { name: "Save" }).click();
    await page
      .locator("[data-record-card]")
      .getByRole("button", { name: "Mark done" })
      .click({ timeout: 30_000 });
    const taskId = new URL(page.url()).pathname.split("/").pop() as string;
    const rule = await proxy.addRule({
      method: "POST",
      path: `${API}/task-commands`,
      ordinal: 1,
      action: "drop_after_forward",
    });
    await page.evaluate(() => {
      (window as unknown as { __offline?: boolean }).__offline = false;
      window.dispatchEvent(new Event("online"));
    });
    await page.evaluate(() => window.__atlasData?.retryOutbox());
    await expect
      .poll(
        async () => (await call(page, id, "GET", `/tasks/${taskId}`)).status,
        { timeout: 60_000 },
      )
      .toBe(200);
    const occ = await occurrenceId(taskId, `${today()}Tdate`);
    const prog = await progressId(occ, id.account_id);
    await expect
      .poll(
        async () => (await viewOf(page, id, taskId, occ, "personal"))?.outcome,
        { timeout: 60_000 },
      )
      .toBe("complete");
    expect((await views(page, id, taskId, "joint")).map((v) => v.id)).toEqual([
      occ,
    ]);
    const journal = await call(
      page,
      id,
      "GET",
      `/progress/${prog}/entries?after=0&limit=200`,
    );
    expect((journal.body as { entries: unknown[] }).entries).toHaveLength(1);
    const log = (await proxy.log()).filter(
      (e) => e.path === `${API}/task-commands`,
    );
    expect(log.length).toBeGreaterThanOrEqual(3);
    await proxy.removeRule(rule.id);
  });
});

test.describe("I-T3: a real preset (A11; TASK-29)", () => {
  test("'Shared persistent chore' from GET /task-presets fills the form and is created with the preset's definition", async ({
    context,
  }) => {
    const { page, id } = await bootAs(context, main, "/tasks/new");
    const chore = page.getByRole("radio", { name: /Shared persistent chore/ });
    await chore.check({ timeout: 30_000 });
    await page.getByRole("button", { name: "Use preset" }).click();
    await expect(page.getByLabel("Name", { exact: true })).toHaveValue(
      "Shared persistent chore",
    );
    await page.getByRole("radio", { name: "Only me" }).check();
    const zone = await page.evaluate(
      () => Intl.DateTimeFormat().resolvedOptions().timeZone,
    );
    const presets = await call(
      page,
      id,
      "GET",
      `/task-presets?start_date=${todayIn(zone, Date.now())}&timezone=${encodeURIComponent(zone)}`,
    );
    const preset = (
      presets.body as { items: Array<{ title: string; definition: unknown }> }
    ).items.find((p) => p.title === "Shared persistent chore");
    await page.getByRole("button", { name: "Save" }).click();
    await expect(page.locator("[data-task-detail]")).toBeVisible({
      timeout: 30_000,
    });
    const taskId = new URL(page.url()).pathname.split("/").pop() as string;
    await page.evaluate(() => window.__atlasData?.retryOutbox());
    await expect
      .poll(
        async () => (await call(page, id, "GET", `/tasks/${taskId}`)).status,
        { timeout: 60_000 },
      )
      .toBe(200);
    const detail = (await call(page, id, "GET", `/tasks/${taskId}`)).body as {
      execution: { value: unknown };
      task: { label: string };
    };
    expect(detail.task.label).toBe("Shared persistent chore");
    expect(detail.execution.value).toEqual(preset?.definition);
  });
});

test.describe("I-T4: resolve and reopen for two readers (A12; TASK-23 #1)", () => {
  test("outcome and period outcome are unchanged for both readers; only actionable changes", async ({
    context,
    browser,
  }) => {
    const { page, id } = await bootAs(context, main);
    const other = await browser.newContext();
    try {
      const b = await apiAs(other, "frank");
      const made = await makeTask(
        page,
        id,
        def({ participation: "everyone" }),
        { grants: [{ kind: "account", id: b.id.account_id, edit: true }] },
      );
      const before = {
        a: await viewOf(page, id, made.taskId, made.occurrenceId, "joint"),
        b: await viewOf(b.page, b.id, made.taskId, made.occurrenceId, "joint"),
      };
      expect(before.a?.actionable).toBe(true);
      expect(
        (
          await send(
            page,
            id,
            commands.resolve({
              occurrenceId: made.occurrenceId,
              resolved: true,
            }),
            { [made.occurrenceId]: 1 },
          )
        ).status,
      ).toBe(200);
      const closed = {
        a: await viewOf(page, id, made.taskId, made.occurrenceId, "joint"),
        b: await viewOf(b.page, b.id, made.taskId, made.occurrenceId, "joint"),
      };
      for (const who of ["a", "b"] as const) {
        expect(closed[who]?.outcome).toBe(before[who]?.outcome);
        expect(closed[who]?.period_outcome).toBe(before[who]?.period_outcome);
      }
      expect(closed.a?.actionable).toBe(false);
      expect(
        (
          await send(
            page,
            id,
            commands.resolve({
              occurrenceId: made.occurrenceId,
              resolved: false,
            }),
            { [made.occurrenceId]: 2 },
          )
        ).status,
      ).toBe(200);
      const open = await viewOf(
        page,
        id,
        made.taskId,
        made.occurrenceId,
        "joint",
      );
      expect([open?.outcome, open?.period_outcome, open?.actionable]).toEqual([
        before.a?.outcome,
        before.a?.period_outcome,
        true,
      ]);
    } finally {
      await other.close();
    }
  });
});

test.describe("I-T5: exclude without the policy (A12; TASK-23 #2)", () => {
  test("queued by the harness (the UI hides it), refused 422, kept as rejected with the person's input", async ({
    context,
    provokes,
  }) => {
    provokes(422);
    const { page, id } = await bootAs(context, main);
    const made = await makeTask(page, id, def());
    const body = commands
      .exclude({
        occurrenceId: made.occurrenceId,
        progressId: made.progressId,
        excluded: true,
      })
      .build({ [made.progressId]: 1 }).command;
    const out = await page.evaluate(
      (spec) => window.__atlasData?.enqueue(spec),
      {
        endpoint: "/task-commands",
        targets: [
          {
            resourceId: made.progressId,
            role: "primary",
            basis: "progress_stream",
            versionChecked: false,
          },
        ],
        command: body,
      } as never,
    );
    expect(out?.kind).toBe("queued");
    await page.evaluate(() => window.__atlasData?.retryOutbox());
    await expect
      .poll(
        async () =>
          (
            (await page.evaluate(
              (a) => window.__atlasData?.queue(a),
              id.account_id,
            )) as Array<{ local_id: string; status: string }>
          ).find((r) => r.local_id === out?.localId)?.status,
        { timeout: 60_000 },
      )
      .toBe("rejected");
  });
});

test.describe("I-T6: Anyone, one participant's exclusion (A12; TASK-23 #5)", () => {
  test("B's exclusion is B's personal result and is absent from the joint result", async ({
    context,
    browser,
  }) => {
    const { page, id } = await bootAs(context, main);
    const other = await browser.newContext();
    try {
      const b = await apiAs(other, "frank");
      const made = await makeTask(
        page,
        id,
        def({ participation: "anyone", allow_streak_exclusions: true }),
        { grants: [{ kind: "account", id: b.id.account_id, edit: true }] },
      );
      const bProg = await progressId(made.occurrenceId, b.id.account_id);
      // B's stream is created on demand by B's first record (Anyone), at version 1, then raised to 2.
      const first = record(
        made.occurrenceId,
        bProg,
        b.id.account_id,
        { kind: "checkbox", complete: false },
        { firstAnyoneStream: true },
      );
      expect((await send(b.page, b.id, first, { [bProg]: 1 })).status).toBe(
        200,
      );
      expect(
        (
          await send(
            b.page,
            b.id,
            commands.exclude({
              occurrenceId: made.occurrenceId,
              progressId: bProg,
              excluded: true,
            }),
            { [bProg]: 2 },
          )
        ).status,
      ).toBe(200);
      expect(
        (await viewOf(b.page, b.id, made.taskId, made.occurrenceId, "personal"))
          ?.outcome,
      ).toBe("excluded");
      expect(
        (await viewOf(b.page, b.id, made.taskId, made.occurrenceId, "joint"))
          ?.outcome,
      ).not.toBe("excluded");
      expect(
        (await viewOf(page, id, made.taskId, made.occurrenceId, "joint"))
          ?.outcome,
      ).not.toBe("excluded");
    } finally {
      await other.close();
    }
  });
});

test.describe("I-T7: Everyone, consent and visibility (A12, A15; TASK-23 #3/#4, TASK-31 #4/#5, TASK-17)", () => {
  test("all excluded → joint excluded; a non-consented stream → joint unknown yet its detail readable; an invisible stream simply absent; personal scope readable", async ({
    context,
    browser,
  }) => {
    const { page, id } = await bootAs(context, main);
    const bContext = await browser.newContext();
    const cContext = await browser.newContext();
    try {
      const b = await apiAs(bContext, "frank");
      const c = await apiAs(cContext, "grace");
      const start = addDays(today(), -1);
      const everyone = (consent: boolean) =>
        makeTask(
          page,
          id,
          def(
            { participation: "everyone", allow_streak_exclusions: true },
            { start_date: start, repeat: { frequency: "daily", interval: 1 } },
          ),
          {
            grants: [
              { kind: "account", id: b.id.account_id, edit: true },
              { kind: "account", id: c.id.account_id, edit: false },
            ],
          },
        ).then(async (made) => {
          // B joins (A can read B's progress; C cannot), then today's occurrence is made with both participants.
          const joined = await access(b.page, b.id, {
            kind: "enrol",
            task_id: made.taskId,
            expected_version: 0,
            active: true,
            aggregate_consent: consent,
            initial_policy: {
              grants: [{ kind: "account", id: id.account_id, edit: false }],
              exclude_accounts: [],
            },
          });
          expect(joined.status, JSON.stringify(joined.body)).toBe(200);
          const mat = await call(
            page,
            id,
            "POST",
            "/task-commands",
            {
              command: {
                kind: "materialise",
                task_id: made.taskId,
                through_date: today(),
                limit: 16,
              },
            },
            crypto.randomUUID(),
          );
          expect(mat.status, JSON.stringify(mat.body)).toBe(200);
          const occ = await occurrenceId(
            made.taskId,
            slotKey(
              {
                ...def().schedule,
                start_date: start,
                repeat: { frequency: "daily", interval: 1 },
              },
              today(),
            ),
          );
          return { ...made, occ };
        });
      const both = await everyone(true);
      const aProg = await progressId(both.occ, id.account_id);
      const bProg = await progressId(both.occ, b.id.account_id);
      const v = await viewOf(page, id, both.taskId, both.occ, "joint");
      expect(v?.data.participants.sort()).toEqual(
        [id.account_id, b.id.account_id].sort(),
      );
      expect(
        (
          await send(
            page,
            id,
            commands.exclude({
              occurrenceId: both.occ,
              progressId: aProg,
              excluded: true,
            }),
            { [aProg]: 1 },
          )
        ).status,
      ).toBe(200);
      expect(
        (
          await send(
            b.page,
            b.id,
            commands.exclude({
              occurrenceId: both.occ,
              progressId: bProg,
              excluded: true,
            }),
            { [bProg]: 1 },
          )
        ).status,
      ).toBe(200);
      expect(
        (await viewOf(page, id, both.taskId, both.occ, "joint"))?.outcome,
      ).toBe("excluded");
      // C reads the task but not B's progress (B granted only A): B's stream is simply absent for C, and C's joint result is unknown.
      const forC = (await progressOf(c.page, c.id, both.occ)).map((p) => p.id);
      expect(forC).not.toContain(bProg);
      expect(
        (await viewOf(c.page, c.id, both.taskId, both.occ, "joint"))?.outcome,
      ).toBe("unknown");
      const withheld = await everyone(false);
      const wProg = await progressId(withheld.occ, b.id.account_id);
      expect(
        (await viewOf(page, id, withheld.taskId, withheld.occ, "joint"))
          ?.outcome,
      ).toBe("unknown");
      const mine = await progressId(withheld.occ, id.account_id);
      expect(
        (
          await send(
            page,
            id,
            record(withheld.occ, mine, id.account_id, {
              kind: "checkbox",
              complete: true,
            }),
            { [mine]: 1 },
          )
        ).status,
      ).toBe(200);
      expect(
        (await viewOf(page, id, withheld.taskId, withheld.occ, "joint"))
          ?.outcome,
      ).toBe("unknown");
      // The non-consented stream's own detail is still readable by A (TASK-31 #4), and A's personal scope is known (TASK-17).
      expect(
        (await progressOf(page, id, withheld.occ)).map((p) => p.id),
      ).toContain(wProg);
      expect(
        (await viewOf(page, id, withheld.taskId, withheld.occ, "personal"))
          ?.outcome,
      ).not.toBe("unknown");
      const daily = await call(
        page,
        id,
        "GET",
        `/daily?day=${today()}&timezone=${encodeURIComponent(ZONE)}&scope=personal&state=all&limit=200`,
      );
      expect(
        (daily.body as { items: OccurrenceView[] }).items.find(
          (i) => i.id === withheld.occ,
        )?.outcome,
      ).not.toBe("unknown");
    } finally {
      await bContext.close();
      await cContext.close();
    }
  });
});

test.describe("I-T9: late completion and offline finalisation (A4; TASK-31 #1/#2/#6)", () => {
  test("a past window: nine entries against a maximum of eight are missed, three complete; the stored outcome finalises to the server's", async ({
    context,
  }) => {
    const { page, id } = await bootAs(context, main);
    const start = addDays(today(), -3);
    const goal = {
      kind: "numeric" as const,
      minimum: null,
      maximum: "8",
      unit: "cups",
    };
    const check = async (n: number, expected: string) => {
      const made = await makeTask(
        page,
        id,
        def({ goal, carry: "retain_one" }, { start_date: start }),
      );
      const view = await viewOf(
        page,
        id,
        made.taskId,
        made.occurrenceId,
        "personal",
      );
      const inside = (view?.data.opens_at as number) + 60;
      for (let i = 0; i < n; i += 1)
        expect(
          (
            await send(
              page,
              id,
              record(
                made.occurrenceId,
                made.progressId,
                id.account_id,
                { kind: "quantity", amount: "1" },
                { happenedAt: inside },
              ),
            )
          ).status,
        ).toBe(200);
      const server = await viewOf(
        page,
        id,
        made.taskId,
        made.occurrenceId,
        "personal",
      );
      expect(server?.outcome).toBe(expected);
      const stored = parseProgressState(
        (await progressOf(page, id, made.occurrenceId)).find(
          (p) => p.id === made.progressId,
        )?.value,
      );
      // The synced state is evaluated open; the client finalises the STORED outcome, never the eight recent entries.
      expect(finalise(stored?.action.outcome ?? "unknown", goal, true)).toBe(
        expected,
      );
      expect(
        personalResult({
          occurrence: server?.data as never,
          stream: stored,
          pending: [],
          streamPending: false,
          me: id.account_id,
          nowMs: Date.now(),
        }),
      ).toMatchObject({ outcome: expected });
    };
    await check(9, "missed");
    await check(3, "complete");
    // An untouched past checkbox: raw ProgressState says unknown, the read and the local finalisation say missed (TASK-31 #1).
    const tick = await makeTask(page, id, def({}, { start_date: start }));
    const raw = parseProgressState(
      (await progressOf(page, id, tick.occurrenceId)).find(
        (p) => p.id === tick.progressId,
      )?.value,
    );
    expect(raw?.action.outcome).toBe("unknown");
    expect(
      (await viewOf(page, id, tick.taskId, tick.occurrenceId, "personal"))
        ?.outcome,
    ).toBe("missed");
    expect(finalise("unknown", { kind: "checkbox" }, true)).toBe("missed");
  });
});

test.describe("I-T10: the correction of one day (A14; TASK-27 #3-#5)", () => {
  test("keeps the id, slot key and roster; a maximum below the recorded amount is accepted; a goal-kind change is refused atomically", async ({
    context,
    provokes,
  }) => {
    provokes(422);
    const { page, id } = await bootAs(context, main);
    const goal = {
      kind: "numeric" as const,
      minimum: null,
      maximum: "8",
      unit: "cups",
    };
    const made = await makeTask(page, id, def({ goal }));
    expect(
      (
        await send(
          page,
          id,
          record(made.occurrenceId, made.progressId, id.account_id, {
            kind: "quantity",
            amount: "5",
          }),
        )
      ).status,
    ).toBe(200);
    const before = await viewOf(
      page,
      id,
      made.taskId,
      made.occurrenceId,
      "personal",
    );
    const narrowed = commands.reviseOccurrence(
      {
        occurrenceId: made.occurrenceId,
        current: before?.data as never,
        definition: {
          ...(before?.data.definition as TaskDefinition),
          goal: { ...goal, maximum: "2" },
        },
        date: before?.data.slot.date ?? null,
        time: null,
        progressIds: [made.progressId],
      },
      resolveWallTime,
    );
    expect(
      (
        await send(page, id, narrowed, {
          [made.occurrenceId]: before?.version as number,
          [made.progressId]: 2,
        })
      ).status,
    ).toBe(200);
    const after = await viewOf(
      page,
      id,
      made.taskId,
      made.occurrenceId,
      "personal",
    );
    expect(after?.id).toBe(made.occurrenceId);
    expect(after?.data.slot.key).toBe(before?.data.slot.key);
    expect(after?.data.participants).toEqual(before?.data.participants);
    expect(after?.data.definition.goal).toEqual({ ...goal, maximum: "2" });
    const kind = commands.reviseOccurrence(
      {
        occurrenceId: made.occurrenceId,
        current: after?.data as never,
        definition: {
          ...(after?.data.definition as TaskDefinition),
          goal: { kind: "checkbox" },
        },
        date: after?.data.slot.date ?? null,
        time: null,
        progressIds: [made.progressId],
      },
      resolveWallTime,
    );
    expect(
      (
        await send(page, id, kind, {
          [made.occurrenceId]: after?.version as number,
          [made.progressId]: 3,
        })
      ).status,
    ).toBe(422);
    expect(
      (await viewOf(page, id, made.taskId, made.occurrenceId, "personal"))
        ?.version,
    ).toBe(after?.version);
  });
});

test.describe("I-T11: archive and restore (A13)", () => {
  test("Archive in the UI leaves the day online; history stays; Restore returns it", async ({
    context,
  }) => {
    const { page, id } = await bootAs(context, main);
    const made = await makeTask(page, id, def(), {
      title: `I-T11 ${Date.now() % 100_000}`,
    });
    expect(
      (
        await send(
          page,
          id,
          record(made.occurrenceId, made.progressId, id.account_id, {
            kind: "checkbox",
            complete: true,
          }),
          { [made.progressId]: 1 },
        )
      ).status,
    ).toBe(200);
    await expect
      .poll(
        async () => (await cacheRow(page, id.account_id, made.taskId))?.version,
        { timeout: 60_000 },
      )
      .toBe(1);
    await go(page, `/tasks/${made.taskId}?occurrence=${made.occurrenceId}`);
    await page
      .getByRole("button", { name: "Archive" })
      .click({ timeout: 30_000 });
    await page.evaluate(() => window.__atlasData?.retryOutbox());
    await expect
      .poll(
        async () =>
          (
            (await call(page, id, "GET", `/tasks/${made.taskId}`)).body as {
              task: { archived?: boolean };
            }
          ).task.archived,
        { timeout: 60_000 },
      )
      .toBe(true);
    const day = await call(
      page,
      id,
      "GET",
      `/daily?day=${today()}&timezone=${encodeURIComponent(ZONE)}&limit=200`,
    );
    expect(
      (day.body as { items: OccurrenceView[] }).items.map((i) => i.id),
    ).not.toContain(made.occurrenceId);
    expect(
      (
        (
          await call(
            page,
            id,
            "GET",
            `/progress/${made.progressId}/entries?after=0&limit=200`,
          )
        ).body as { entries: unknown[] }
      ).entries,
    ).toHaveLength(1);
    await go(page, `/today?day=${today()}&tz=${encodeURIComponent(ZONE)}`);
    await expect(page.locator("[data-today-page]")).toBeVisible({
      timeout: 30_000,
    });
    await expect(
      page.locator(`[data-today-row="${made.occurrenceId}"]`),
    ).toHaveCount(0);
    await go(page, `/tasks/${made.taskId}?occurrence=${made.occurrenceId}`);
    await page
      .getByRole("button", { name: "Restore" })
      .click({ timeout: 30_000 });
    await page.evaluate(() => window.__atlasData?.retryOutbox());
    await expect
      .poll(
        async () =>
          (
            (await call(page, id, "GET", `/tasks/${made.taskId}`)).body as {
              task: { archived?: boolean };
            }
          ).task.archived,
        { timeout: 60_000 },
      )
      .toBe(false);
    await go(page, `/today?day=${today()}&tz=${encodeURIComponent(ZONE)}`);
    await expect(
      page.locator(`[data-today-row="${made.occurrenceId}"]`),
    ).toBeVisible({ timeout: 60_000 });
  });
});

/**
 * I-T12 (R39, revision 27): the oracle names the read it judges. Every `/daily` request of the page passes through ONE route that records
 * its scope, day, zone, `revision` and `after` in interception order and fetches the server's answer itself (`route.fetch`), so the
 * status and the page's revision, items and cursor are on the ledger BEFORE the page receives them. A scope's chain is sequential: while
 * its continuation is held, that chain can ask nothing else, so a first page of the same scope seen meanwhile belongs to another read;
 * and a new read always asks BOTH scopes (`useTodayView`'s `Promise.all`), so one scope held with no new request is proof that no new read
 * began. The first continuation of each scope in `hold` is held until the test releases it.
 */
type Scope = "joint" | "personal";
interface DailyCall {
  n: number;
  scope: Scope;
  day: string | null;
  zone: string | null;
  revision: number | null;
  after: string | null;
  held: boolean;
  /** The server's status, recorded before the page is answered (null while held or in flight). */
  status: number | null;
  page: {
    revision: number;
    ids: string[];
    items: OccurrenceView[];
    next: string | null;
  } | null;
}
const DAILY_ROUTE = `**${API}/daily?**`;
async function dailyLedger(page: Page, hold: readonly Scope[]) {
  const calls: DailyCall[] = [];
  const held = new Map<Scope, { call: DailyCall; release: () => void }>();
  const releases: Array<() => void> = [];
  let lastEvent = Date.now();
  let closed = false;
  const handler = async (route: Route) => {
    const q = new URL(route.request().url()).searchParams;
    const call: DailyCall = {
      n: calls.length,
      scope: q.get("scope") as Scope,
      day: q.get("day"),
      zone: q.get("timezone"),
      revision: q.has("revision") ? Number(q.get("revision")) : null,
      after: q.get("after"),
      held: false,
      status: null,
      page: null,
    };
    calls.push(call);
    lastEvent = Date.now();
    if (
      !closed &&
      call.revision !== null &&
      hold.includes(call.scope) &&
      !held.has(call.scope)
    ) {
      call.held = true;
      await new Promise<void>((resolve) => {
        held.set(call.scope, { call, release: resolve });
        releases.push(resolve);
      });
    }
    try {
      const response = await route.fetch();
      call.status = response.status();
      if (call.status === 200) {
        const body = (await response.json()) as {
          revision: number;
          items: OccurrenceView[];
          next_after: string | null;
        };
        call.page = {
          revision: body.revision,
          ids: body.items.map((item) => item.id),
          items: body.items,
          next: body.next_after,
        };
      }
      lastEvent = Date.now();
      await route.fulfill({ response });
    } catch (error) {
      // Only the test's own teardown (the page closing under a held request) may end a request without an answer.
      if (!closed) throw error;
      await route.abort().catch(() => undefined);
    }
  };
  await page.route(DAILY_ROUTE, handler);
  const of = (scope: Scope) => calls.filter((c) => c.scope === scope);
  return {
    calls,
    of,
    /** The held continuation of `scope`, once the page has asked for it. */
    async held(scope: Scope): Promise<DailyCall> {
      await expect
        .poll(() => held.has(scope), {
          message: `the ${scope} continuation is held`,
          timeout: 60_000,
        })
        .toBe(true);
      return (held.get(scope) as { call: DailyCall }).call;
    },
    release(scope: Scope) {
      held.get(scope)?.release();
    },
    /** The server has answered `call` (its status is on the ledger). */
    async answered(call: DailyCall) {
      await expect.poll(() => call.status, { timeout: 60_000 }).not.toBeNull();
    },
    /** No `/daily` request was made or answered for `ms`, and none but the held ones is unanswered. */
    async quietFor(ms: number) {
      await expect
        .poll(
          () =>
            Date.now() - lastEvent >= ms &&
            calls.every((c) => c.status !== null || (c.held && !c.page)),
          { timeout: 60_000, intervals: [100] },
        )
        .toBe(true);
    },
    async dispose() {
      closed = true;
      for (const release of releases) release();
      await page.unroute(DAILY_ROUTE, handler);
    },
  };
}

/**
 * The chain of `scope` that starts at the cursorless first page `first`: every later call of that scope, in order, must continue it (the
 * revision the first page answered, the cursor the previous page gave) until a page ends it. Anything else (another first page, another
 * revision, a cursor of an older page) fails here, named.
 */
function chainFrom(calls: DailyCall[], first: DailyCall) {
  expect(first.revision, "a chain starts without a revision").toBeNull();
  expect(first.after, "a chain starts without a cursor").toBeNull();
  expect(first.status).toBe(200);
  const head = first.page as NonNullable<DailyCall["page"]>;
  const pages = [first];
  for (const call of calls.filter(
    (c) => c.scope === first.scope && c.n > first.n,
  )) {
    const previous = (pages.at(-1) as DailyCall).page;
    expect(
      previous?.next,
      `call ${call.n} follows the end of the ${first.scope} chain from call ${first.n}`,
    ).not.toBeNull();
    expect(
      { revision: call.revision, after: call.after },
      `call ${call.n} continues the ${first.scope} chain from call ${first.n}`,
    ).toEqual({ revision: head.revision, after: previous?.next ?? null });
    expect(call.status).toBe(200);
    expect(call.page?.revision).toBe(head.revision);
    pages.push(call);
  }
  return {
    revision: head.revision,
    complete: (pages.at(-1) as DailyCall).page?.next === null,
    items: pages.flatMap((c) => c.page?.items ?? []),
    calls: pages,
  };
}

/** The page asked `/daily` again from call `since` on, every such call is answered, and the last one ended its chain (or failed). */
function settledSince(calls: DailyCall[], since: number): boolean {
  const later = calls.slice(since);
  if (later.length === 0 || calls.some((c) => c.status === null && !c.held))
    return false;
  const last = later.at(-1) as DailyCall;
  return last.status !== 200 || last.page?.next === null;
}

/** Every occurrence the server lists for the day now, in either scope (the test's own read, before the ledger exists). */
async function listedToday(page: Page, id: Id, day: string): Promise<string[]> {
  const ids: string[] = [];
  for (const scope of ["joint", "personal"] as const) {
    let after: string | null = null;
    let revision: number | null = null;
    do {
      const out = await call(
        page,
        id,
        "GET",
        `/daily?day=${day}&timezone=${encodeURIComponent(ZONE)}&scope=${scope}&state=all&limit=200${
          after === null ? "" : `&after=${after}&revision=${revision}`
        }`,
      );
      expect(out.status, JSON.stringify(out.body)).toBe(200);
      const body = out.body as {
        items: Array<{ id: string }>;
        next_after: string | null;
        revision: number;
      };
      ids.push(...body.items.map((item) => item.id));
      revision = body.revision;
      after = body.next_after;
    } while (after !== null);
  }
  return ids;
}

/** A task id whose occurrence id sorts before `bound` (the endpoint pages a day's items in id order). */
async function taskIdBelow(definition: TaskDefinition, bound: string) {
  const key = slotOn(definition.schedule, definition.schedule.start_date).key;
  for (let tries = 0; tries < 2_000_000; tries += 1) {
    const taskId = crypto.randomUUID();
    if ((await occurrenceId(taskId, key)) < bound) return taskId;
  }
  throw new Error(`no task id gives an occurrence id below ${bound}`);
}

/** The cache holds the task, the occurrence and my progress of every task (the sync engine has delivered them; each round asks it to sync). */
async function untilDelivered(page: Page, account: string, made: Made[]) {
  await expect
    .poll(
      async () => {
        await page.evaluate(() => window.__atlasData?.nudgeSync());
        const rows =
          ((await page.evaluate(
            (a) => window.__atlasData?.rows(a, "cache"),
            account,
          )) as Array<{ id: string }> | undefined) ?? [];
        const ids = new Set(rows.map((r) => r.id));
        return made.every(
          (m) =>
            ids.has(m.taskId) &&
            ids.has(m.occurrenceId) &&
            ids.has(m.progressId),
        );
      },
      { message: "the sync engine delivered every task", timeout: 60_000 },
    )
    .toBe(true);
}

const appliedRevision = async (page: Page, account: string) =>
  (
    (await page.evaluate((a) => window.__atlasData?.syncState(a), account)) as {
      applied_revision?: number | null;
    } | null
  )?.applied_revision ?? null;

const todayPath = (day: string) =>
  `/today?day=${day}&tz=${encodeURIComponent(ZONE)}`;

test.describe("I-T12: TASK-7, a publication between two pages of /daily (A2)", () => {
  // A fresh document reads the page size when its task boundary mounts: set before every document of the test, so the one read the test
  // judges is the read of a single client-side navigation to Today (no reload and no second Today mount on the way).
  test.beforeEach(async ({ context }) => {
    await context.addInitScript(() => {
      (
        window as unknown as { __atlasTasksDailyPageSize?: number }
      ).__atlasTasksDailyPageSize = 2;
    });
  });

  test("the continuation is refused 409 and the scope restarts from its first page; no page of the old revision is shown", async ({
    context,
    provokes,
  }) => {
    provokes(409);
    const { page, id } = await bootAs(context, main, "/tasks");
    const day = today();
    // Three tasks that sort FIRST in the day: the two-item first page of each scope is two of them. The publication marks the first
    // ("sentinel") done and archives the second ("leaving"), so a page of the old revision can be told from the new one by a value AND by
    // a member the new revision no longer has.
    const existing = await listedToday(page, id, day);
    const bound = existing.reduce((a, b) => (b < a ? b : a), "g");
    const made: Made[] = [];
    for (let i = 0; i < 3; i += 1) {
      const definition = def();
      made.push(
        await makeTask(page, id, definition, {
          title: `I-T12 ${i}`,
          taskId: await taskIdBelow(definition, bound),
        }),
      );
    }
    made.sort((a, b) => (a.occurrenceId < b.occurrenceId ? -1 : 1));
    const [sentinel, leaving, staying] = made as [Made, Made, Made];
    // Isolate the read: the cache holds everything the server has written for this account, then the sync engine is stopped, so no
    // committed content (and no other trigger the test does not make) can begin another read while the one judged here runs.
    await untilDelivered(page, id.account_id, made);
    await page.evaluate(() => window.__atlasData?.stopSync());
    const applied = await appliedRevision(page, id.account_id);
    expect(applied).not.toBeNull();
    let publication: Made | null = null;
    const ledger = await dailyLedger(page, ["joint", "personal"]);
    try {
      await go(page, todayPath(day));
      const heldJoint = await ledger.held("joint");
      const heldPersonal = await ledger.held("personal");
      // One read so far: per scope, its first page and the continuation now held, both of this day and zone.
      for (const [scope, cont] of [
        ["joint", heldJoint],
        ["personal", heldPersonal],
      ] as const) {
        const calls = ledger.of(scope);
        expect(
          calls.map((c) => c.n),
          `the ${scope} calls before the publication`,
        ).toEqual([calls[0]?.n, cont.n]);
        const first = calls[0] as DailyCall;
        expect(chainFrom([first], first).complete).toBe(false);
        expect({ day: first.day, zone: first.zone }).toEqual({
          day,
          zone: ZONE,
        });
        expect(
          { revision: cont.revision, after: cont.after },
          `the ${scope} continuation names the first page's revision and cursor`,
        ).toEqual({
          revision: first.page?.revision,
          after: first.page?.next,
        });
        expect(first.page?.ids, `the ${scope} first page`).toEqual(
          made.slice(0, 2).map((m) => m.occurrenceId),
        );
      }
      const oldFirst = {
        joint: (ledger.of("joint")[0] as DailyCall).page?.items[0],
        personal: (ledger.of("personal")[0] as DailyCall).page?.items[0],
      };
      for (const scope of ["joint", "personal"] as const) {
        expect(oldFirst[scope]?.id).toBe(sentinel.occurrenceId);
        expect(oldFirst[scope]?.outcome, scope).not.toBe("complete");
        expect(oldFirst[scope]?.actionable, scope).toBe(true);
      }

      // Other writes land between the two pages, through the backend: the sentinel is marked done, `leaving` is archived (it leaves the
      // day) and a task is created.
      expect(
        (
          await send(
            page,
            id,
            record(sentinel.occurrenceId, sentinel.progressId, id.account_id, {
              kind: "checkbox",
              complete: true,
            }),
            { [sentinel.progressId]: 1 },
          )
        ).status,
      ).toBe(200);
      expect(
        (
          await send(
            page,
            id,
            commands.archive({ taskId: leaving.taskId, archived: true }),
            { [leaving.taskId]: 1 },
          )
        ).status,
      ).toBe(200);
      publication = await makeTask(page, id, def(), {
        title: "I-T12 publication",
      });

      // The joint continuation, released while its read is still the current one: refused 409 by the server, and the SAME read asks
      // the joint first page again (no cursor, no revision) and walks the newer revision to its end.
      const sinceJoint = ledger.calls.length;
      ledger.release("joint");
      await ledger.answered(heldJoint);
      expect(heldJoint.status).toBe(409);
      await expect
        .poll(() => settledSince(ledger.calls, sinceJoint), {
          message: "the page asks /daily again after the joint 409",
          timeout: 60_000,
        })
        .toBe(true);
      // Only the joint scope was asked again: the personal continuation is still held, so no other read began (a new read asks both
      // scopes), and the restart is the held read's own.
      const afterJoint = ledger.calls.slice(sinceJoint);
      expect(
        afterJoint.map((c) => c.scope),
        "the calls after the joint 409",
      ).toEqual(afterJoint.map(() => "joint"));
      const joint = chainFrom(ledger.calls, afterJoint[0] as DailyCall);
      expect(joint.complete, "the joint restart reaches its last page").toBe(
        true,
      );

      const sincePersonal = ledger.calls.length;
      ledger.release("personal");
      await ledger.answered(heldPersonal);
      expect(heldPersonal.status).toBe(409);
      await expect
        .poll(() => settledSince(ledger.calls, sincePersonal), {
          message: "the page asks /daily again after the personal 409",
          timeout: 60_000,
        })
        .toBe(true);
      const afterPersonal = ledger.calls.slice(sincePersonal);
      expect(
        afterPersonal.map((c) => c.scope),
        "the calls after the personal 409",
      ).toEqual(afterPersonal.map(() => "personal"));
      const personal = chainFrom(ledger.calls, afterPersonal[0] as DailyCall);
      expect(
        personal.complete,
        "the personal restart reaches its last page",
      ).toBe(true);

      // The accepted chains are wholly of the newer revision: complete, unmixed, and carrying the publication and the sentinel's change.
      expect(joint.revision).toBeGreaterThan(heldJoint.revision as number);
      expect(personal.revision).toBeGreaterThan(
        heldPersonal.revision as number,
      );
      for (const chain of [joint, personal]) {
        const ids = chain.items.map((item) => item.id);
        expect(new Set(ids).size, "no item twice").toBe(ids.length);
        expect(ids).toEqual([...ids].sort());
        for (const m of [sentinel, staying, publication])
          expect(ids).toContain(m.occurrenceId);
        expect(ids).not.toContain(leaving.occurrenceId);
      }
      const newSentinel = {
        joint: joint.items.find((i) => i.id === sentinel.occurrenceId),
        personal: personal.items.find((i) => i.id === sentinel.occurrenceId),
      };
      for (const scope of ["joint", "personal"] as const) {
        expect(newSentinel[scope]?.outcome, scope).toBe("complete");
        expect(newSentinel[scope]?.actionable, scope).toBe(false);
      }

      // The screen shows that answer. This device's cache (sync stopped) has heard of neither the record nor the archive, so only the
      // newer pages can make the sentinel done; and `leaving`, which only the OLD pages list, is the device's own row, not the server's.
      for (const m of [sentinel, staying])
        await expect(
          page.locator(`[data-today-row="${m.occurrenceId}"]`),
        ).toHaveAttribute("data-source", "server", { timeout: 60_000 });
      await expect(
        page.locator(`[data-today-row="${sentinel.occurrenceId}"]`),
      ).toHaveAttribute("data-pill", "done");
      await expect(
        page.locator(`[data-today-row="${leaving.occurrenceId}"]`),
        "the row only the old pages list is this device's own",
      ).toHaveAttribute("data-source", "local");
      await expect(page.locator("[data-today-error]")).toHaveCount(0);
      // Isolation held: one read, two restarts, nothing else asked; the cache did not move; the day did not change under the test.
      await ledger.quietFor(1_500);
      expect(ledger.calls.length).toBe(
        2 + 2 + joint.calls.length + personal.calls.length,
      );
      expect(await appliedRevision(page, id.account_id)).toBe(applied);
      expect(today()).toBe(day);
    } finally {
      await ledger.dispose();
      await page.evaluate(
        (a) => window.__atlasData?.startSync(a),
        id.account_id,
      );
    }
    // Ordinary sync resumes: the publication and the archive reach the cache and the screen.
    const published = publication as Made | null;
    expect(published).not.toBeNull();
    await untilDelivered(page, id.account_id, [published as Made]);
    await expect(
      page.locator(`[data-today-row="${(published as Made).occurrenceId}"]`),
    ).toHaveAttribute("data-source", "server", { timeout: 60_000 });
    await expect(
      page.locator(`[data-today-row="${leaving.occurrenceId}"]`),
    ).toHaveCount(0, { timeout: 60_000 });
  });

  test("a 409 that reaches a read a newer read has already replaced is dropped: the replacement stays shown, the old read neither restarts nor publishes", async ({
    context,
    provokes,
  }) => {
    provokes(409);
    const { page, id } = await bootAs(context, main, "/tasks");
    const day = today();
    const made: Made[] = [];
    for (let i = 0; i < 3; i += 1)
      made.push(await makeTask(page, id, def(), { title: `I-T12b ${i}` }));
    await untilDelivered(page, id.account_id, made);
    const ledger = await dailyLedger(page, ["joint", "personal"]);
    try {
      await go(page, todayPath(day));
      // The old read is held at both continuations: it can ask nothing more until they are released.
      const heldJoint = await ledger.held("joint");
      const heldPersonal = await ledger.held("personal");
      for (const scope of ["joint", "personal"] as const)
        expect(ledger.of(scope)).toHaveLength(2);
      const mark = ledger.calls.length;

      // A publication, delivered by the running sync engine: committed content begins a newer read, which completes while the old one
      // is still held. Its first pages can only be a newer read's (the old read's chains are blocked).
      const publication = await makeTask(page, id, def(), {
        title: "I-T12b publication",
      });
      await page.evaluate(() => window.__atlasData?.nudgeSync());
      await untilDelivered(page, id.account_id, [publication]);
      await expect(
        page.locator(`[data-today-row="${publication.occurrenceId}"]`),
      ).toHaveAttribute("data-source", "server", { timeout: 60_000 });
      await ledger.quietFor(2_000);
      const replacement = { joint: 0, personal: 0 };
      for (const scope of ["joint", "personal"] as const) {
        const firsts = ledger
          .of(scope)
          .filter((c) => c.n >= mark && c.revision === null);
        expect(firsts.length, `a newer ${scope} read began`).toBeGreaterThan(0);
        // The newest is complete and of a newer revision than the held continuation; it lists the publication.
        const chain = chainFrom(ledger.calls, firsts.at(-1) as DailyCall);
        expect(chain.complete).toBe(true);
        const heldRevision = (scope === "joint" ? heldJoint : heldPersonal)
          .revision as number;
        expect(chain.revision).toBeGreaterThan(heldRevision);
        expect(chain.items.map((i) => i.id)).toContain(
          publication.occurrenceId,
        );
        replacement[scope] = chain.calls.length;
      }
      const settled = ledger.calls.length;

      // The old continuations are released only now: the server refuses both 409, and the old read, no longer current, asks nothing.
      ledger.release("joint");
      ledger.release("personal");
      await ledger.answered(heldJoint);
      await ledger.answered(heldPersonal);
      expect([heldJoint.status, heldPersonal.status]).toEqual([409, 409]);
      await ledger.quietFor(2_000);
      expect(
        ledger.calls.slice(settled).map((c) => c.n),
        "no /daily request after the old read's 409s",
      ).toEqual([]);
      // The replacement is still what the screen shows; the old read published nothing and reported no failure.
      for (const m of [...made, publication])
        await expect(
          page.locator(`[data-today-row="${m.occurrenceId}"]`),
        ).toHaveAttribute("data-source", "server");
      await expect(page.locator("[data-today-error]")).toHaveCount(0);
      expect(replacement.joint).toBeGreaterThan(1);
      expect(today()).toBe(day);
    } finally {
      await ledger.dispose();
    }
  });
});

test.describe("I-T13: a stale progress version (A7)", () => {
  test("a checkbox record on a stale version is a version_conflict; the occurrence's version is untouched", async ({
    context,
    provokes,
  }) => {
    provokes(409);
    const { page, id } = await bootAs(context, main);
    const made = await makeTask(page, id, def());
    expect(
      (
        await send(
          page,
          id,
          record(made.occurrenceId, made.progressId, id.account_id, {
            kind: "checkbox",
            complete: true,
          }),
          { [made.progressId]: 1 },
        )
      ).status,
    ).toBe(200);
    const occBefore = (
      await viewOf(page, id, made.taskId, made.occurrenceId, "joint")
    )?.version;
    const stale = record(made.occurrenceId, made.progressId, id.account_id, {
      kind: "checkbox",
      complete: false,
    }).build({ [made.progressId]: 1 }).command;
    const out = await page.evaluate(
      (spec) => window.__atlasData?.enqueue(spec),
      {
        endpoint: "/task-commands",
        targets: [
          {
            resourceId: made.progressId,
            role: "primary",
            basis: "progress_stream",
            versionChecked: false,
          },
        ],
        command: stale,
      } as never,
    );
    await page.evaluate(() => window.__atlasData?.retryOutbox());
    await expect
      .poll(
        async () =>
          (
            (await page.evaluate(
              (a) => window.__atlasData?.queue(a),
              id.account_id,
            )) as Array<{ local_id: string; status: string }>
          ).find((r) => r.local_id === out?.localId)?.status,
        { timeout: 60_000 },
      )
      .toBe("version_conflict");
    expect(
      (await viewOf(page, id, made.taskId, made.occurrenceId, "joint"))
        ?.version,
    ).toBe(occBefore);
  });
});

test.describe("I-T14: enrolment (A15; TASK-2, TASK-27 #2)", () => {
  test("enrol at version 0 succeeds; the same act at 0 again is refused; the consent toggle at 1 is kept", async ({
    context,
    browser,
    provokes,
  }) => {
    provokes(409);
    const { page, id } = await bootAs(context, main);
    const other = await browser.newContext();
    try {
      const b = await apiAs(other, "frank");
      const made = await makeTask(
        page,
        id,
        def({ participation: "everyone" }),
        { grants: [{ kind: "account", id: b.id.account_id, edit: true }] },
      );
      const enrol = (version: number, consent: boolean) =>
        access(b.page, b.id, {
          kind: "enrol",
          task_id: made.taskId,
          expected_version: version,
          active: true,
          aggregate_consent: consent,
        });
      expect((await enrol(0, true)).status).toBe(200);
      expect((await enrol(0, true)).status).toBe(409);
      expect((await enrol(1, false)).status).toBe(200);
      const now = await call(
        b.page,
        b.id,
        "GET",
        `/tasks/${made.taskId}/enrolment`,
      );
      expect(now.body).toMatchObject({
        version: 2,
        active: true,
        aggregate_consent: false,
      });
    } finally {
      await other.close();
    }
  });
});

test.describe("I-T15: corrections and the journal (A8; TASK-12/12a)", () => {
  test("a replacement inherits the order; a second correction of the same entry conflicts; the journal pages by sequence; a late close_incomplete record is refused", async ({
    context,
    provokes,
  }) => {
    provokes(409, 422);
    const { page, id } = await bootAs(context, main);
    const goal = {
      kind: "numeric" as const,
      minimum: "10",
      maximum: null,
      unit: "minutes",
    };
    const made = await makeTask(page, id, def({ goal, carry: "accumulate" }));
    const first = crypto.randomUUID();
    expect(
      (
        await send(
          page,
          id,
          record(
            made.occurrenceId,
            made.progressId,
            id.account_id,
            { kind: "quantity", amount: "1" },
            { entryId: first },
          ),
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await send(
          page,
          id,
          record(made.occurrenceId, made.progressId, id.account_id, {
            kind: "quantity",
            amount: "2",
          }),
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await send(
          page,
          id,
          record(
            made.occurrenceId,
            made.progressId,
            id.account_id,
            { kind: "quantity", amount: "5" },
            { replaces: first },
          ),
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await send(
          page,
          id,
          record(
            made.occurrenceId,
            made.progressId,
            id.account_id,
            { kind: "quantity", amount: "6" },
            { replaces: first },
          ),
        )
      ).status,
    ).toBe(409);
    const pages: Array<{
      id: string;
      sequence: number;
      logical_order: number;
      replaces: string | null;
    }> = [];
    let after = 0;
    for (let guard = 0; guard < 10; guard += 1) {
      const page1 = (
        await call(
          page,
          id,
          "GET",
          `/progress/${made.progressId}/entries?after=${after}&limit=1`,
        )
      ).body as { entries: typeof pages; next_after: number | null };
      pages.push(...page1.entries);
      if (page1.next_after === null) break;
      after = page1.next_after;
    }
    expect(pages.map((e) => e.sequence)).toEqual(
      [...pages.map((e) => e.sequence)].sort((a, b) => a - b),
    );
    expect(pages).toHaveLength(3);
    const replacement = pages.find((e) => e.replaces === first);
    expect(replacement?.logical_order).toBe(
      pages.find((e) => e.id === first)?.logical_order,
    );
    expect(
      (await viewOf(page, id, made.taskId, made.occurrenceId, "personal"))
        ?.outcome,
    ).toBe("incomplete");
    const past = await makeTask(
      page,
      id,
      def({}, { start_date: addDays(today(), -3) }),
    );
    expect(
      (
        await send(
          page,
          id,
          record(past.occurrenceId, past.progressId, id.account_id, {
            kind: "checkbox",
            complete: true,
          }),
          { [past.progressId]: 1 },
        )
      ).status,
    ).toBe(422);
  });
});

test.describe("I-T17: a real defaults_changed for a queued create (A16)", () => {
  test("captured under R1, refused when the defaults move, reviewed and confirmed in /sync, created once", async ({
    context,
    provokes,
  }) => {
    provokes(409);
    const { page, id } = await bootAs(context, main, "/tasks/new");
    await page
      .getByRole("button", { name: "Start from scratch instead" })
      .click({ timeout: 30_000 });
    await expect(
      page.getByRole("radio", { name: /^Use my defaults/ }),
    ).toBeVisible({ timeout: 30_000 });
    await page.evaluate(() => {
      const w = window as unknown as { __offline?: boolean };
      w.__offline = true;
      Object.defineProperty(Navigator.prototype, "onLine", {
        configurable: true,
        get: () => w.__offline !== true,
      });
      window.dispatchEvent(new Event("offline"));
    });
    await page
      .getByLabel("Name", { exact: true })
      .fill(`I-T17 ${Date.now() % 100_000}`);
    await page.getByRole("button", { name: "Save" }).click();
    await expect(page.locator("[data-task-detail]")).toBeVisible({
      timeout: 30_000,
    });
    const taskId = new URL(page.url()).pathname.split("/").pop() as string;
    const templates = await call(page, id, "GET", "/defaults/templates");
    const moved = await call(
      page,
      id,
      "POST",
      "/management-commands",
      {
        commands: [
          {
            kind: "set_defaults",
            household_id: null,
            resource_kind: "progress",
            expected_version: (
              templates.body as { progress: { version: number } }
            ).progress.version,
            template: { kind: "private" },
          },
        ],
      },
      crypto.randomUUID(),
    );
    expect(moved.status).toBe(200);
    await page.evaluate(() => {
      (window as unknown as { __offline?: boolean }).__offline = false;
      window.dispatchEvent(new Event("online"));
    });
    await page.evaluate(() => window.__atlasData?.retryOutbox());
    await go(page, "/sync?tab=conflicts");
    await page
      .getByRole("button", { name: /^Review sharing/ })
      .click({ timeout: 60_000 });
    const review = page.getByRole("dialog", { name: "Review sharing" });
    await expect(review).toContainText("Sharing defaults have changed", {
      timeout: 30_000,
    });
    await review.locator("[data-confirm]").click();
    await expect(review).toBeHidden({ timeout: 30_000 });
    await page.evaluate(() => window.__atlasData?.retryOutbox());
    await expect
      .poll(
        async () => (await call(page, id, "GET", `/tasks/${taskId}`)).status,
        { timeout: 60_000 },
      )
      .toBe(200);
  });
});

test.describe("I-T18: Vienna's spring gap and autumn fold (A5, A6; TASK-8/9)", () => {
  test("the server's slot instants and occurrence ids equal the client's; shown in Europe/London", async ({
    context,
  }) => {
    const { page, id } = await bootAs(context, main);
    for (const [date, expected] of [
      ["2026-03-29", "2026-03-29T01:30:00Z"],
      ["2025-10-26", "2025-10-26T00:30:00Z"],
    ] as const) {
      const schedule = {
        start_date: date,
        time: "02:30:00",
        timezone: "Europe/Vienna",
        repeat: { frequency: "daily" as const, interval: 1 },
      };
      const made = await makeTask(page, id, def({}, schedule));
      const view = await viewOf(
        page,
        id,
        made.taskId,
        made.occurrenceId,
        "joint",
      );
      expect(view?.id).toBe(made.occurrenceId);
      expect(view?.data.slot.key).toBe(slotKey(schedule, date));
      expect(view?.data.slot.instant).toBe(Date.parse(expected) / 1000);
      expect(view?.data.slot.instant).toBe(
        resolveWallTime("Europe/Vienna", date, "02:30:00"),
      );
      expect(dateIn(view?.data.slot.instant as number, "Europe/London")).toBe(
        date,
      );
    }
  });
});

// ---- revision 1 (review of 13 October 2026, R5 and R7): the composed journeys -------------------------------------------------------

const goOffline = (page: Page) =>
  page.evaluate(() => {
    const w = window as unknown as { __offline?: boolean };
    w.__offline = true;
    Object.defineProperty(Navigator.prototype, "onLine", {
      configurable: true,
      get: () => w.__offline !== true,
    });
    window.dispatchEvent(new Event("offline"));
  });
const goOnline = (page: Page) =>
  page.evaluate(() => {
    (window as unknown as { __offline?: boolean }).__offline = false;
    window.dispatchEvent(new Event("online"));
  });
const policyOf = async (page: Page, id: Id, rid: string) =>
  (await call(page, id, "GET", `/policies/${rid}`)).body as {
    version: number;
    policy: { grants: Array<{ kind: string; id: string; edit: boolean }> };
  };
const accountIdOf = async (page: Page, id: Id, username: string) => {
  const found = (
    await call(
      page,
      id,
      "GET",
      `/directory?username=${encodeURIComponent(username)}`,
    )
  ).body as Array<{ id: string; username: string }>;
  const entry = (found ?? []).find((e) => e.username === username);
  if (!entry) throw new Error(`no directory entry for ${username}`);
  return entry.id;
};
/** The shared policy editor of WEB-12a, opened by the task screen: one account grant added and saved. */
async function grantInEditor(page: Page, opener: string, username: string) {
  await page.getByRole("button", { name: opener }).click({ timeout: 60_000 });
  const dialog = page.getByRole("dialog", { name: /^Sharing/ });
  await expect(dialog.locator("[data-audience]")).toBeVisible({
    timeout: 30_000,
  });
  await dialog.getByRole("button", { name: "+ Add account grant" }).click();
  await dialog.getByRole("textbox", { name: "Exact username" }).fill(username);
  await dialog.getByRole("button", { name: "Look up" }).click();
  await dialog.getByRole("button", { name: `Choose: ${username}` }).click();
  await dialog.locator("[data-save]").click();
  await expect(dialog).toBeHidden({ timeout: 30_000 });
}
/** Until the leader's cache holds `rid` (each round asks the leader to sync). */
async function untilCached(page: Page, account: string, rid: string) {
  await expect
    .poll(
      async () => {
        await page.evaluate(() => window.__atlasData?.nudgeSync());
        return (await cacheRow(page, account, rid)) !== undefined;
      },
      { timeout: 60_000 },
    )
    .toBe(true);
}

test.describe("I-T19: a task edited in the UI, and its own sharing section (A10, A16; R7 of revision 1)", () => {
  test("Edit task saves a revise_task that the server applies (title and definition, Q1 policy version); Sharing grants the task to another account through the shared editor", async ({
    context,
  }) => {
    const { page, id } = await bootAs(context, main);
    const goal = {
      kind: "numeric" as const,
      minimum: null,
      maximum: "8",
      unit: "cups",
    };
    const made = await makeTask(page, id, def({ goal }), {
      title: `I-T19 ${Date.now() % 100_000}`,
    });
    await untilCached(page, id.account_id, made.taskId);
    await go(page, `/tasks/${made.taskId}`);
    await page
      .getByRole("link", { name: "Edit task" })
      .click({ timeout: 60_000 });
    const renamed = `I-T19 renamed ${Date.now() % 100_000}`;
    await page.getByLabel("Name", { exact: true }).fill(renamed);
    await page.getByLabel("At most", { exact: true }).fill("6");
    await page.getByRole("button", { name: "Save" }).click();
    await expect(page.locator("[data-task-detail]")).toBeVisible({
      timeout: 30_000,
    });
    await page.evaluate(() => window.__atlasData?.retryOutbox());
    await expect
      .poll(
        async () => {
          const detail = (await call(page, id, "GET", `/tasks/${made.taskId}`))
            .body as {
            task: { label: string };
            execution: {
              value: { goal: { maximum: string | null } };
            } | null;
          };
          return [detail.task.label, detail.execution?.value.goal.maximum];
        },
        { timeout: 60_000 },
      )
      .toEqual([renamed, "6"]);
    // The task's own sharing section: the shared editor (WEB-12a) on the task.
    const bob = await accountIdOf(page, id, ACCOUNTS.bob.username);
    await untilCached(page, id.account_id, made.taskId);
    await go(page, `/tasks/${made.taskId}`);
    await grantInEditor(page, "Sharing", ACCOUNTS.bob.username);
    await expect
      .poll(async () => (await policyOf(page, id, made.taskId)).policy.grants, {
        timeout: 60_000,
      })
      .toContainEqual({ kind: "account", id: bob, edit: false });
  });
});

test.describe("I-T20: an amount recorded and the day corrected in the UI, and my progress's sharing (A8, A14, A16; R7 of revision 1)", () => {
  test("Record, then Correct this day through the dialog (id, slot key and roster kept; a maximum below the amount accepted); 'Who sees my progress' grants through the shared editor", async ({
    context,
  }) => {
    const { page, id } = await bootAs(context, main);
    const goal = {
      kind: "numeric" as const,
      minimum: null,
      maximum: "8",
      unit: "cups",
    };
    const bob = await accountIdOf(page, id, ACCOUNTS.bob.username);
    const made = await makeTask(
      page,
      id,
      def({ goal, participation: "anyone" }),
      { grants: [{ kind: "account", id: bob, edit: false }] },
    );
    await untilCached(page, id.account_id, made.occurrenceId);
    const before = await viewOf(
      page,
      id,
      made.taskId,
      made.occurrenceId,
      "personal",
    );
    await go(page, `/tasks/${made.taskId}?occurrence=${made.occurrenceId}`);
    const card = page.locator("[data-record-card]");
    await card.getByLabel("Amount (cups)").fill("5", { timeout: 60_000 });
    await card.getByRole("button", { name: "Record" }).click();
    await page.evaluate(() => window.__atlasData?.retryOutbox());
    await expect
      .poll(
        async () =>
          (
            (await progressOf(page, id, made.occurrenceId)).find(
              (p) => p.id === made.progressId,
            )?.value as { action?: { amount?: string } } | undefined
          )?.action?.amount,
        { timeout: 60_000 },
      )
      .toBe("5");
    await untilCached(page, id.account_id, made.progressId);
    await page.getByRole("button", { name: "Correct this day" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("At most").fill("2");
    await dialog.getByRole("button", { name: "Save correction" }).click();
    await expect(dialog).toBeHidden({ timeout: 30_000 });
    await page.evaluate(() => window.__atlasData?.retryOutbox());
    await expect
      .poll(
        async () =>
          (await viewOf(page, id, made.taskId, made.occurrenceId, "personal"))
            ?.data.definition.goal,
        { timeout: 60_000 },
      )
      .toEqual({ ...goal, maximum: "2" });
    const after = await viewOf(
      page,
      id,
      made.taskId,
      made.occurrenceId,
      "personal",
    );
    expect(after?.id).toBe(made.occurrenceId);
    expect(after?.data.slot.key).toBe(before?.data.slot.key);
    expect(after?.data.participants).toEqual(before?.data.participants);
    // My progress's own sharing section: the shared editor (WEB-12a) on my stream. Whoever is granted a progress stream must already see
    // its occurrence (the server's IdentityGrantRequired, reported as invalid_value): Bob takes part in this Anyone task (granted on it from
    // the start), so he can be granted my progress.
    await untilCached(page, id.account_id, made.progressId);
    await go(page, `/tasks/${made.taskId}?occurrence=${made.occurrenceId}`);
    await grantInEditor(page, "Who sees my progress", ACCOUNTS.bob.username);
    await expect
      .poll(
        async () => (await policyOf(page, id, made.progressId)).policy.grants,
        { timeout: 60_000 },
      )
      .toContainEqual({ kind: "account", id: bob, edit: false });
  });
});

test.describe("I-T21: a version conflict resent from /sync, then a record after it (A7, A17; R5 of revision 1)", () => {
  test("'Resend as a new operation' on the reviewed version is applied, and a record made after it is applied on the version the replacement left (no 409)", async ({
    context,
    provokes,
  }) => {
    provokes(409);
    const { page, id } = await bootAs(context, main);
    const made = await makeTask(page, id, def());
    await untilCached(page, id.account_id, made.progressId);
    await go(page, `/tasks/${made.taskId}?occurrence=${made.occurrenceId}`);
    const card = page.locator("[data-record-card]");
    await expect(card.getByRole("button", { name: "Mark done" })).toBeVisible({
      timeout: 60_000,
    });
    await goOffline(page);
    await card.getByRole("button", { name: "Mark done" }).click();
    // Meanwhile my stream moves on the server (another device of mine): version 1 → 2.
    expect(
      (
        await send(
          page,
          id,
          record(made.occurrenceId, made.progressId, id.account_id, {
            kind: "checkbox",
            complete: false,
          }),
          { [made.progressId]: 1 },
        )
      ).status,
    ).toBe(200);
    await goOnline(page);
    await page.evaluate(() => window.__atlasData?.retryOutbox());
    // The drafts as stored (header rows), oldest first.
    const queue = async () =>
      (
        ((await page.evaluate(
          (a) => window.__atlasData?.rows(a, "drafts"),
          id.account_id,
        )) ?? []) as Array<{
          local_id: string;
          status: string;
          kind: string;
          created_seq: number;
        }>
      ).sort((x, y) => x.created_seq - y.created_seq);
    await expect
      .poll(async () => (await queue()).map((d) => [d.kind, d.status]), {
        timeout: 60_000,
      })
      .toEqual([["record", "version_conflict"]]);
    // /sync: the item's authorised current read shows version 2; the person resends on it.
    await go(page, "/sync?tab=conflicts");
    await page
      .getByRole("button", { name: /^Details: Progress entry/ })
      .click({ timeout: 60_000 });
    const item = page.getByRole("dialog");
    const resend = item.getByRole("button", {
      name: "Resend as a new operation",
    });
    await expect(resend).toBeEnabled({ timeout: 30_000 });
    // Offline from here: the replacement and the record after it are both saved before either is sent.
    await goOffline(page);
    await resend.click();
    await expect(item).toBeHidden({ timeout: 30_000 });
    await go(page, `/tasks/${made.taskId}?occurrence=${made.occurrenceId}`);
    await card
      .getByRole("button", { name: "Mark not done" })
      .click({ timeout: 30_000 });
    await expect
      .poll(async () => (await queue()).map((d) => [d.kind, d.status]))
      .toEqual([
        ["record", "queued"],
        ["record", "queued"],
      ]);
    await goOnline(page);
    await page.evaluate(() => window.__atlasData?.retryOutbox());
    await expect
      .poll(
        async () =>
          (await progressOf(page, id, made.occurrenceId)).find(
            (p) => p.id === made.progressId,
          )?.version,
        { timeout: 60_000 },
      )
      .toBe(4);
    await expect
      .poll(
        async () => (await queue()).filter((d) => d.status !== "acknowledged"),
        {
          timeout: 60_000,
        },
      )
      .toEqual([]);
  });
});

test.describe("I-T22: the first record of an Anyone task, rebuilt, keeps its defaults guard (A16; R5 of revision 1)", () => {
  test("captured under the defaults B saw; the defaults move; the rebuilt request is refused defaults_changed, while the same body without the guard would be applied", async ({
    context,
    browser,
    provokes,
  }) => {
    provokes(409);
    const { page, id } = await bootAs(context, main);
    const other = await browser.newContext();
    try {
      const b = await apiAs(other, "frank");
      // An amount (not version-checked): the path that may continue without a current read (the stream does not exist yet).
      const made = await makeTask(
        page,
        id,
        def({
          participation: "anyone",
          goal: { kind: "numeric", minimum: null, maximum: "8", unit: "cups" },
        }),
        { grants: [{ kind: "account", id: b.id.account_id, edit: true }] },
      );
      const bProg = await progressId(made.occurrenceId, b.id.account_id);
      const snapshot = (await call(b.page, b.id, "GET", "/defaults/snapshot"))
        .body as never;
      const original = record(
        made.occurrenceId,
        bProg,
        b.id.account_id,
        { kind: "quantity", amount: "1" },
        {
          firstAnyoneStream: true,
          defaults: {
            format: 1,
            snapshot,
            fetched_at: Date.now(),
            issued_at: Date.now(),
            epoch: b.id.epoch,
          },
        },
      );
      const captured = original.build({ [bProg]: 1 });
      expect(captured.defaultsRevision).toBeTruthy();
      // The draft as the outbox stores it, refused for some other reason (an operation conflict), then rebuilt by "save as new".
      const draft = {
        local_id: crypto.randomUUID(),
        kind: "record",
        status: "operation_conflict",
        command_digest: "d",
        endpoint: "/task-commands",
        command: captured.command,
        target_resource_ids: original.targets
          .filter((t) => t.role === "primary")
          .map((t) => t.resourceId),
        side_effect_bases: Object.fromEntries(
          original.targets
            .filter((t) => t.role === "side_effect")
            .map((t) => [t.resourceId, 1]),
        ),
        defaults_revision: captured.defaultsRevision ?? null,
        defaults_context: captured.defaultsContext ?? null,
      } as never;
      const rebuilt = taskCommandSpecs().record?.rebuild?.(draft, null);
      expect(rebuilt).toBeTruthy();
      const body = rebuilt?.build({ [bProg]: 1 }).command as {
        defaults_revision?: string;
        command: Record<string, unknown>;
      };
      expect(body.defaults_revision).toBe(captured.defaultsRevision);
      // B's progress defaults change before the rebuilt request is sent.
      const templates = await call(b.page, b.id, "GET", "/defaults/templates");
      expect(
        (
          await call(
            b.page,
            b.id,
            "POST",
            "/management-commands",
            {
              commands: [
                {
                  kind: "set_defaults",
                  household_id: null,
                  resource_kind: "progress",
                  expected_version: (
                    templates.body as { progress: { version: number } }
                  ).progress.version,
                  template: { kind: "private" },
                },
              ],
            },
            crypto.randomUUID(),
          )
        ).status,
      ).toBe(200);
      const guarded = await call(
        b.page,
        b.id,
        "POST",
        "/task-commands",
        body,
        crypto.randomUUID(),
      );
      expect(guarded.status, JSON.stringify(guarded.body)).toBe(409);
      expect((guarded.body as { code: string }).code).toBe("defaults_changed");
      expect(
        (await progressOf(b.page, b.id, made.occurrenceId)).some(
          (p) => p.id === bProg,
        ),
      ).toBe(false);
      // What a rebuild that dropped the guard would send (the defect of review R5): the server applies it under the changed defaults.
      const unguarded = await call(
        b.page,
        b.id,
        "POST",
        "/task-commands",
        { command: body.command },
        crypto.randomUUID(),
      );
      expect(unguarded.status, JSON.stringify(unguarded.body)).toBe(200);
    } finally {
      await other.close();
    }
  });
});

test.describe("I-T23: a consent change made in the UI keeps a private enrolment audience; progress generated afterwards stays private (A15, A16; R22 of revision 10)", () => {
  test("the creator's progress defaults grant another reader of the task, the creator changes only the consent in the UI: the enrolment stays private and that reader cannot read the next day's progress; control: an explicitly shared audience is readable", async ({
    context,
    browser,
  }) => {
    const { page, id } = await bootAs(context, main);
    const other = await browser.newContext();
    type Grant = { kind: "account" | "household"; id: string; edit: boolean };
    type Policy = { grants: Grant[]; exclude_accounts: string[] };
    type Enrolled = {
      version: number;
      active: boolean;
      aggregate_consent: boolean;
      policy: Policy;
    };
    const PRIVATE: Policy = { grants: [], exclude_accounts: [] };
    let restore: (() => Promise<void>) | null = null;
    try {
      const b = await apiAs(other, "frank");
      const reader: Policy = {
        grants: [{ kind: "account", id: b.id.account_id, edit: false }],
        exclude_accounts: [],
      };
      // A daily Everyone task that B can read, started yesterday, so today's occurrence is generated after the change.
      const definition = def(
        { participation: "everyone" },
        {
          start_date: addDays(today(), -1),
          repeat: { frequency: "daily", interval: 1 },
        },
      );
      const made = await makeTask(page, id, definition, {
        grants: [{ kind: "account", id: b.id.account_id, edit: false }],
      });
      const enrolment = async () => {
        const read = await call(
          page,
          id,
          "GET",
          `/tasks/${made.taskId}/enrolment`,
        );
        expect(read.status, JSON.stringify(read.body)).toBe(200);
        return read.body as Enrolled;
      };
      // Precondition: the creator's enrolment is private, made so explicitly (the account's defaults may name a household).
      const created = await enrolment();
      if (JSON.stringify(created.policy) !== JSON.stringify(PRIVATE))
        expect(
          (
            await access(page, id, {
              kind: "enrol",
              task_id: made.taskId,
              expected_version: created.version,
              active: created.active,
              aggregate_consent: created.aggregate_consent,
              initial_policy: PRIVATE,
            })
          ).status,
        ).toBe(200);
      const before = await enrolment();
      expect(before.policy).toEqual(PRIVATE);
      expect(before.active).toBe(true);
      // The creator's progress defaults now grant B: an enrol that omitted its policy would take them.
      const setProgressDefault = async (template: unknown) => {
        const templates = (await call(page, id, "GET", "/defaults/templates"))
          .body as { progress: { version: number; template: unknown } };
        const moved = await call(
          page,
          id,
          "POST",
          "/management-commands",
          {
            commands: [
              {
                kind: "set_defaults",
                household_id: null,
                resource_kind: "progress",
                expected_version: templates.progress.version,
                template,
              },
            ],
          },
          crypto.randomUUID(),
        );
        expect(moved.status, JSON.stringify(moved.body)).toBe(200);
        return templates.progress;
      };
      const original = await setProgressDefault({
        kind: "explicit",
        policy: reader,
      });
      restore = async () => {
        await setProgressDefault(
          original.version > 0 ? original.template : null,
        );
      };
      // The consent alone, changed in the task detail.
      await untilCached(page, id.account_id, made.taskId);
      await go(page, `/tasks/${made.taskId}?occurrence=${made.occurrenceId}`);
      const settings = page.locator("[data-enrolment]");
      const consent = settings.getByRole("checkbox", {
        name: "Count me in the shared total",
      });
      await expect(consent).toBeEnabled({ timeout: 60_000 });
      await expect(consent).toBeChecked({ checked: before.aggregate_consent });
      await consent.click();
      await expect(settings).toContainText("Saved.", { timeout: 30_000 });
      const after = await enrolment();
      expect(after).toEqual({
        version: before.version + 1,
        active: true,
        aggregate_consent: !before.aggregate_consent,
        policy: PRIVATE,
      });
      // Today's occurrence is generated now, from the enrolment as it stands: B (who can read the task) cannot read the creator's progress.
      const materialise = async (through: string) => {
        const out = await call(
          page,
          id,
          "POST",
          "/task-commands",
          {
            command: {
              kind: "materialise",
              task_id: made.taskId,
              through_date: through,
              limit: 16,
            },
          },
          crypto.randomUUID(),
        );
        expect(out.status, JSON.stringify(out.body)).toBe(200);
      };
      const visibleToB = async (date: string) => {
        const occ = await occurrenceId(
          made.taskId,
          slotKey(definition.schedule, date),
        );
        const mine = await progressId(occ, id.account_id);
        const read = await call(
          b.page,
          b.id,
          "GET",
          `/progress?parent_id=${occ}&limit=200`,
        );
        expect(read.status, JSON.stringify(read.body)).toBe(200);
        return (read.body as { items: Array<{ id: string }> }).items.some(
          (row) => row.id === mine,
        );
      };
      await materialise(today());
      expect(await visibleToB(today())).toBe(false);
      // Control: the same reader setup with an explicitly SHARED audience (sent as the UI's audience editor would): tomorrow's progress,
      // generated after it, is readable by B. So the private result above is the audience, not an unreadable setup.
      expect(
        (
          await access(page, id, {
            kind: "enrol",
            task_id: made.taskId,
            expected_version: after.version,
            active: true,
            aggregate_consent: after.aggregate_consent,
            initial_policy: reader,
          })
        ).status,
      ).toBe(200);
      const tomorrow = addDays(today(), 1);
      await materialise(tomorrow);
      expect(await visibleToB(tomorrow)).toBe(true);
    } finally {
      await restore?.();
      await other.close();
    }
  });
});
