import { readFileSync, writeFileSync } from "node:fs";
import type { BrowserContext, Page } from "@playwright/test";
import * as commands from "../../src/features/tasks/model/commands";
import type {
  DependencyPreview,
  OccurrenceView,
  TaskDefinition,
} from "../../src/features/tasks/model/contract";
import {
  occurrenceId,
  progressId,
  slotKey,
} from "../../src/features/tasks/model/ids";
import { addDays, slotOn, todayIn } from "../../src/features/tasks/model/time";
import {
  bootHarness,
  expect,
  exposeSession,
  paceSignIn,
  signIn as signInUnpaced,
  stackFile,
  test,
  untilView,
  type Who,
} from "./helpers";

/**
 * WEB-10c against the RELEASED backend (`v0.29.0-rc.1`) on a disposable SQLite database behind the delaying proxy: the production session,
 * the production data controller and the task screens, with the FIXTURE leader standing in for WEB-09b's production leadership (the
 * WEB-10a harness). FOCUSED REAL-BACKEND EVIDENCE for a fixture-stage task: BE-Q1, BE-B6 and BE-CH1 have no completion record, so this
 * is NOT integration acceptance (`integration_passed` stays false). No PostgreSQL, HTTPS or device.
 *
 * The plan's case names map to these titles (`I-10C-…`, so the integration runner's historical-selection inventory accounts for them):
 * I-M1…I-M5 catch-up (A1–A4), I-S1/I-S2 streak (A5/A6), I-D1…I-D7 dependencies (A8–A11), I-TM1…I-TM6 timers (A12–A15), I-SU1
 * successors (A16), I-R1/I-R4 rotas (A17). Plan cases folded into another: I-D5 (stale token) into I-10C-D4's token check and the
 * jsdom conflict test; I-R2/I-R3 into I-10C-R1/R4. Revision 1 (review R9) corrects the first version's claim that I-TM5 was folded
 * into another case (it was not run): I-10C-TM5 is its own pair of cases (a first Anyone timer and a completion, each held for a
 * defaults review), and TASK-30 check 6 (a hidden completion exposes and triggers no successor) is I-10C-SU1 check 6.
 */
const API = "/api/experimental/v1";

// Sign-in pacing shared with the other integration specs (the same ledger file per stack): at most 8 attempts per account a minute.
const budget = (who: Who) => paceSignIn(who);
const ROTATION: Who[] = ["alice", "carol", "dave", "erin"];
const ROTATION_FILE = stackFile("atlas-tasks-10c-rotation.txt");
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
  info.setTimeout(240_000);
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
/**
 * Revision 11 (review R37): every request a test helper makes carries this header, so a log of the PAGE's own traffic (`requestLog`,
 * I-10C-M4's barriers) never counts a helper's request as the product's. The backend ignores it.
 */
const HELPER = "x-atlas-test-helper";
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
                "x-atlas-test-helper": "1",
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

// ---- WEB-10c helpers ---------------------------------------------------------------------------------------------------------------
/** Every day of a task, page after page (`/occurrences` answers at most 200 a page). */
async function allViews(
  page: Page,
  id: Id,
  taskId: string,
): Promise<OccurrenceView[]> {
  const out: OccurrenceView[] = [];
  let after: string | null = null;
  let revision: number | null = null;
  for (let n = 0; n < 50; n += 1) {
    // A continuation names the first page's revision (as `/daily`'s do).
    const res = await call(
      page,
      id,
      "GET",
      `/occurrences?task_id=${taskId}&scope=personal&limit=200${after ? `&after=${after}&revision=${revision}` : ""}`,
    );
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const body = res.body as {
      items: OccurrenceView[];
      next_after: string | null;
      revision: number;
    };
    out.push(...body.items);
    if (body.next_after === null) return out;
    after = body.next_after;
    revision ??= body.revision;
  }
  throw new Error("more pages than expected");
}
const daily = { frequency: "daily", interval: 1 } as const;
/** A daily task whose first day was `daysAgo` days ago: the server made only that day at creation. */
const backdated = (
  daysAgo: number,
  over: Partial<TaskDefinition> = {},
): TaskDefinition =>
  def(
    { carry: "retain_one", ...over },
    { start_date: addDays(today(), -daysAgo), repeat: daily },
  );
const dayOf = async (
  taskId: string,
  definition: TaskDefinition,
  date: string,
) => occurrenceId(taskId, slotKey(definition.schedule, date));
const position = async (page: Page, id: Id, taskId: string) =>
  (
    (await call(page, id, "GET", `/tasks/${taskId}`)).body as {
      materialisation: { last_date: string | null; pending: boolean } | null;
    }
  ).materialisation;
const materialise = (page: Page, id: Id, taskId: string, through: string) =>
  call(
    page,
    id,
    "POST",
    "/task-commands",
    {
      command: {
        kind: "materialise",
        task_id: taskId,
        through_date: through,
        limit: 16,
      },
    },
    crypto.randomUUID(),
  );
/** The `materialise` posts and position reads the PAGE made, from the browser's own request log (a helper's are not the page's). */
function requestLog(page: Page, taskId: string) {
  const out: Array<{
    kind: "materialise" | "position";
    key?: string;
    at: number;
  }> = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (!url.pathname.startsWith(API)) return;
    if (request.headers()[HELPER] !== undefined) return;
    const path = url.pathname.slice(API.length);
    if (request.method() === "POST" && path === "/task-commands") {
      const body = request.postDataJSON() as {
        command?: { kind?: string; task_id?: string };
      } | null;
      if (
        body?.command?.kind === "materialise" &&
        body.command.task_id === taskId
      )
        out.push({
          kind: "materialise",
          key: request.headers()["idempotency-key"],
          at: Date.now(),
        });
    }
    if (request.method() === "GET" && path === `/tasks/${taskId}`)
      out.push({ kind: "position", at: Date.now() });
  });
  return out;
}
const preview = async (page: Page, id: Id, occ: string) => {
  const out = await call(page, id, "GET", `/occurrences/${occ}/dependencies`);
  expect(out.status, JSON.stringify(out.body)).toBe(200);
  return out.body as DependencyPreview;
};
const occurrenceVersion = async (
  page: Page,
  id: Id,
  taskId: string,
  occ: string,
) => (await viewOf(page, id, taskId, occ, "personal"))?.version as number;
const setDeps = async (
  page: Page,
  id: Id,
  taskId: string,
  occ: string,
  prerequisites: string[],
  strict: boolean,
) =>
  call(
    page,
    id,
    "POST",
    "/task-commands",
    commands
      .setDependencies({ occurrenceId: occ, prerequisites, strict })
      .build({ [occ]: await occurrenceVersion(page, id, taskId, occ) }).command,
    crypto.randomUUID(),
  );
const completeWith = (
  page: Page,
  id: Id,
  occ: string,
  token: string,
  mode: "require_satisfied" | "complete_prerequisites" | "advisory_override",
  rootEvidence: Record<string, unknown> | null = null,
) =>
  call(
    page,
    id,
    "POST",
    "/task-commands",
    {
      command: {
        kind: "complete_dependencies",
        occurrence_id: occ,
        preview_token: token,
        mode,
        happened_at: Math.floor(Date.now() / 1000),
        ...(rootEvidence === null ? {} : { root_evidence: rootEvidence }),
      },
    },
    crypto.randomUUID(),
  );
const offline = (page: Page) =>
  page.evaluate(() => {
    const w = window as unknown as { __offline?: boolean };
    w.__offline = true;
    Object.defineProperty(Navigator.prototype, "onLine", {
      configurable: true,
      get: () => w.__offline !== true,
    });
    window.dispatchEvent(new Event("offline"));
  });
const online = (page: Page) =>
  page.evaluate(() => {
    (window as unknown as { __offline?: boolean }).__offline = false;
    window.dispatchEvent(new Event("online"));
  });
const SECONDS = {
  kind: "numeric",
  minimum: "60",
  maximum: null,
  unit: "seconds",
} as const;

// ---- catch-up ----------------------------------------------------------------------------------------------------------------------
test.describe("I-10C-M1: Today catches a task up automatically (A1; CM-350, CM-433; TASK-5a/13a)", () => {
  test("a daily task begun 20 days ago is brought up to date from Today in two calls; the days sync; the banner leaves", async ({
    context,
  }) => {
    const { page, id } = await bootAs(context, main);
    const definition = backdated(20);
    const made = await makeTask(page, id, definition, { title: "I-10C-M1" });
    expect(await position(page, id, made.taskId)).toMatchObject({
      pending: true,
    });
    const log = requestLog(page, made.taskId);
    await go(page, `/today?day=${today()}&tz=${encodeURIComponent(ZONE)}`);
    await expect
      .poll(async () => (await position(page, id, made.taskId))?.pending, {
        timeout: 90_000,
      })
      .toBe(false);
    expect((await position(page, id, made.taskId))?.last_date).toBe(today());
    expect(log.filter((e) => e.kind === "materialise")).toHaveLength(2);
    const all = await views(page, id, made.taskId, "personal");
    expect(new Set(all.map((v) => v.id)).size).toBe(21);
    // The new days arrive by sync; Today's next current answer no longer lists the task.
    const todays = await dayOf(made.taskId, definition, today());
    await expect(page.locator(`[data-today-row="${todays}"]`)).toBeVisible({
      timeout: 90_000,
    });
    await expect(page.locator("[data-pending-tasks]")).toHaveCount(0, {
      timeout: 90_000,
    });
  });
});

test.describe("I-10C-M2/M3: the bound, Try again and the horizon (A2; TASK-13; CM-441)", () => {
  test("a task needing more than 128 days stops after exactly 8 counted calls; Try again continues from there with no duplicate day; today + 32 is refused, today + 31 accepted", async ({
    context,
    provokes,
  }) => {
    provokes(422);
    const { page, id } = await bootAs(context, main);
    const made = await makeTask(page, id, backdated(200), {
      title: "I-10C-M2",
    });
    const log = requestLog(page, made.taskId);
    await go(page, `/today?day=${today()}&tz=${encodeURIComponent(ZONE)}`);
    const stopped = page.locator(`[data-catch-up-task="${made.taskId}"]`);
    await expect(stopped).toHaveAttribute("data-catch-up-stopped", "bound", {
      timeout: 120_000,
    });
    const calls = log.filter((e) => e.kind === "materialise");
    expect(calls).toHaveLength(8);
    expect(new Set(calls.map((e) => e.key)).size).toBe(8);
    const reached = (await position(page, id, made.taskId))
      ?.last_date as string;
    expect(reached < today()).toBe(true);
    await stopped.getByRole("button", { name: "Try again" }).click();
    await expect
      .poll(async () => (await position(page, id, made.taskId))?.pending, {
        timeout: 120_000,
      })
      .toBe(false);
    const after = log.filter((e) => e.kind === "materialise");
    expect(after.length).toBeGreaterThan(8);
    expect(new Set(after.map((e) => e.key)).size).toBe(after.length);
    const all = await allViews(page, id, made.taskId);
    expect(new Set(all.map((v) => v.id)).size).toBe(all.length);
    expect(all.length).toBe(201);
    // The server's horizon: today + 31 in the task's zone is the furthest it generates (a fresh task, its own position).
    const ahead = await makeTask(page, id, backdated(0), { title: "I-10C-M3" });
    expect(
      (await materialise(page, id, ahead.taskId, addDays(today(), 32))).status,
    ).toBe(422);
    expect(
      (await materialise(page, id, ahead.taskId, addDays(today(), 31))).status,
    ).toBe(200);
  });
});

test.describe("I-10C-M4: a reload while the position read is held (A3; CM-440)", () => {
  /**
   * Revision 11 (review R37; design assessment C5): a CAUSAL witness of the recovery. The old page's position read (after its successful
   * `materialise`) is held until the page is CLOSED, and the retained row is proven before it closes (one success, awaiting ITS OWN read,
   * admitted and unanswered, stable). A new page of the same browser (the same database) is the recovering runner, triggered by the real
   * daily endpoint; its own traffic only is counted (every helper request carries `HELPER`; the arranger is another signed-in client in
   * another browser context), and each of its reads is held at a barrier where the durable records name the caller that is asking. The
   * revision-10 version passed without the new page doing anything (Review 12, R37); it is kept in the evidence history, not here.
   *
   * `ATLAS_I10C_M4_QUALIFY` (qualification runs only, execute.md; never set in a validation plan): `old-page-settles` lets the old page's
   * read through (the retained-row precondition must then fail); `helper-get` adds an untagged GET of the task from the new page after
   * its discovery (under a mutant that disables the recovery, the oracle must still fail).
   */
  const QUALIFY = process.env.ATLAS_I10C_M4_QUALIFY ?? "";
  type Retained = {
    rows: Array<{
      task_id: string;
      through_date: string;
      sequence_generation: string;
      phase: string;
      read_seq: number;
      attempt: { key: string } | null;
      successful_calls: number;
      schedule?: {
        caller: string;
        issued: number | null;
        failures: number;
      } | null;
    }>;
    discovery: {
      attempt?: string | null;
      schedule?: { issued: number | null } | null;
    } | null;
  };
  /** The task's durable catch-up records as the page's database holds them (IndexedDB: no request). */
  const retained = (page: Page, account: string, taskId: string) =>
    page.evaluate(
      async ({ a, t }) => {
        const data = window.__atlasData;
        if (!data) throw new Error("no data harness");
        const rows = (
          (await data.rows(a, "materialise_sequences")) as Array<{
            task_id: string;
          }>
        ).filter((r) => r.task_id === t);
        const sync = await data.syncState(a);
        const all = sync?.materialise_discovery as
          | Record<string, unknown>
          | undefined;
        return { rows, discovery: all?.[t] ?? null };
      },
      { a: account, t: taskId },
    ) as Promise<Retained>;

  /** The old page: its first `materialise` succeeds and its position read is held until the page is closed. */
  async function closedWhileHeld(context: BrowserContext, backlog: number) {
    const { page, id } = await bootAs(context, main);
    const made = await makeTask(page, id, backdated(backlog), {
      title: "I-10C-M4",
    });
    const keys: string[] = [];
    let held = false;
    await page.route(`**${API}/tasks/${made.taskId}`, async (route) => {
      if (route.request().headers()[HELPER] !== undefined)
        return route.fallback();
      if (keys.length > 0 && !held) {
        held = true;
        if (QUALIFY === "old-page-settles") return route.fallback();
        // Never answered: the page is closed with it outstanding.
        return;
      }
      return route.fallback();
    });
    page.on("request", (request) => {
      if (request.headers()[HELPER] !== undefined) return;
      const body =
        request.method() === "POST"
          ? (request.postDataJSON() as { command?: { kind?: string } } | null)
          : null;
      if (body?.command?.kind === "materialise")
        keys.push(request.headers()["idempotency-key"] ?? "");
    });
    await go(page, `/today?day=${today()}&tz=${encodeURIComponent(ZONE)}`);
    await expect.poll(() => held, { timeout: 60_000 }).toBe(true);
    // PRECONDITION: the retained continuation, before the page closes, and still so a moment later (an answered read would move it).
    const awaiting = async () => {
      const { rows } = await retained(page, id.account_id, made.taskId);
      const row = rows[0];
      return rows.length === 1 &&
        row?.phase === "awaiting_position_read" &&
        row.attempt === null &&
        row.read_seq === 1 &&
        row.schedule?.caller === "position" &&
        row.schedule.issued != null
        ? row
        : null;
    };
    await expect
      .poll(async () => (await awaiting()) !== null, {
        timeout: 30_000,
      })
      .toBe(true);
    const before = (await awaiting()) as Retained["rows"][number];
    await page.waitForTimeout(2_000);
    expect(await awaiting(), "the old page's read is still unanswered").toEqual(
      before,
    );
    expect(keys).toHaveLength(1);
    await page.close();
    return { id, made, before, oldKey: keys[0] as string };
  }

  /**
   * The new page of the same browser: its product traffic logged from creation (helpers excluded), and its first `hold` reads of the
   * task held at barriers the test releases (`release`).
   */
  async function recovering(
    context: BrowserContext,
    account: string,
    taskId: string,
    hold: number,
  ) {
    const page = await context.newPage();
    const product: Array<{ kind: "materialise" | "position"; key?: string }> =
      [];
    page.on("request", (request) => {
      const url = new URL(request.url());
      if (!url.pathname.startsWith(API)) return;
      if (request.headers()[HELPER] !== undefined) return;
      const path = url.pathname.slice(API.length);
      if (request.method() === "GET" && path === `/tasks/${taskId}`)
        product.push({ kind: "position" });
      if (request.method() === "POST" && path === "/task-commands") {
        const body = request.postDataJSON() as {
          command?: { kind?: string; task_id?: string };
        } | null;
        if (
          body?.command?.kind === "materialise" &&
          body.command.task_id === taskId
        )
          product.push({
            kind: "materialise",
            key: request.headers()["idempotency-key"],
          });
      }
    });
    const held: Array<{ release(): Promise<void> }> = [];
    let seen = 0;
    await page.route(`**${API}/tasks/${taskId}`, async (route) => {
      if (
        route.request().headers()[HELPER] !== undefined ||
        route.request().method() !== "GET"
      )
        return route.fallback();
      seen += 1;
      if (seen > hold) return route.fallback();
      held.push({ release: () => route.fallback() });
    });
    await reopenBound(page, account, "/tasks");
    return { page, product, held };
  }

  test("I-10C-M4a: the new page recovers the retained row with its OWN position read; another client finished the backlog, so no new materialise at all", async ({
    context,
    browser,
  }) => {
    const { id, made, before } = await closedWhileHeld(context, 30);
    const r = await recovering(context, id.account_id, made.taskId, 2);
    // Before any trigger: the retained row is there, as the old page left it, and the new page has asked nothing.
    expect((await retained(r.page, id.account_id, made.taskId)).rows).toEqual([
      before,
    ]);
    expect(r.product).toEqual([]);
    await go(r.page, `/today?day=${today()}&tz=${encodeURIComponent(ZONE)}`);
    // BARRIER 1 = the discovery read: its claim is durable, and the row is untouched.
    await expect.poll(() => r.held.length, { timeout: 60_000 }).toBe(1);
    const atDiscovery = await retained(r.page, id.account_id, made.taskId);
    expect(atDiscovery.discovery?.attempt ?? null).not.toBeNull();
    expect(atDiscovery.discovery?.schedule?.issued ?? null).not.toBeNull();
    expect(atDiscovery.rows).toEqual([before]);
    // Another client (its own browser context and session) finishes the backlog meanwhile: its traffic is never the page's.
    const other = await browser.newContext({
      baseURL: test.info().project.use.baseURL,
    });
    try {
      const arranger = await apiAs(other, main);
      expect(
        (await materialise(arranger.page, arranger.id, made.taskId, today()))
          .status,
      ).toBe(200);
      expect(
        (await position(arranger.page, arranger.id, made.taskId))?.pending,
      ).toBe(false);
      await r.held[0]?.release();
      if (QUALIFY === "helper-get")
        // An untagged GET of the task from the page (it looks like the page's own): the oracle below must not take it for recovery.
        void r.page.evaluate(
          async ({ a, e, t }) => {
            await window.__s.api
              .fetchFor(
                "ordinary",
                a,
                e,
              )(
                new Request(
                  `${location.origin}/api/experimental/v1/tasks/${t}`,
                ),
              )
              .catch(() => undefined);
          },
          { a: id.account_id, e: id.epoch, t: made.taskId },
        );
      // BARRIER 2 = the row's own position read: the discovery is over (its entry gone) and the row's read is admitted anew, its old
      // unanswered read counted as lost; still the same generation and read, and no command.
      await expect.poll(() => r.held.length, { timeout: 60_000 }).toBe(2);
      const atRecovery = await retained(r.page, id.account_id, made.taskId);
      expect(atRecovery.discovery).toBeNull();
      expect(atRecovery.rows).toHaveLength(1);
      const row = atRecovery.rows[0];
      expect(row).toMatchObject({
        sequence_generation: before.sequence_generation,
        phase: "awaiting_position_read",
        read_seq: 1,
        attempt: null,
        schedule: { caller: "position", failures: 1 },
      });
      expect(row?.schedule?.issued ?? 0).toBeGreaterThan(
        before.schedule?.issued ?? Number.POSITIVE_INFINITY,
      );
      expect(r.product.filter((e) => e.kind === "materialise")).toEqual([]);
      await r.held[1]?.release();
      // Its continuation settles the row (the position covers the day) and nothing else is sent.
      await expect
        .poll(
          async () =>
            (await retained(r.page, id.account_id, made.taskId)).rows.length,
          { timeout: 60_000 },
        )
        .toBe(0);
      await r.page.waitForTimeout(3_000);
      expect(r.product).toEqual([{ kind: "position" }, { kind: "position" }]);
      expect(
        (await retained(r.page, id.account_id, made.taskId)).discovery,
      ).toBeNull();
    } finally {
      await other.close();
    }
  });

  test("I-10C-M4b: with backlog left, the recovered first action is the row's own read; only then a materialise with a NEW key, until the day is covered", async ({
    context,
  }) => {
    const { id, made, before, oldKey } = await closedWhileHeld(context, 40);
    const r = await recovering(context, id.account_id, made.taskId, 2);
    expect((await retained(r.page, id.account_id, made.taskId)).rows).toEqual([
      before,
    ]);
    await go(r.page, `/today?day=${today()}&tz=${encodeURIComponent(ZONE)}`);
    await expect.poll(() => r.held.length, { timeout: 60_000 }).toBe(1);
    expect((await retained(r.page, id.account_id, made.taskId)).rows).toEqual([
      before,
    ]);
    await r.held[0]?.release();
    await expect.poll(() => r.held.length, { timeout: 60_000 }).toBe(2);
    const atRecovery = (await retained(r.page, id.account_id, made.taskId))
      .rows[0];
    expect(atRecovery).toMatchObject({
      sequence_generation: before.sequence_generation,
      phase: "awaiting_position_read",
      read_seq: 1,
      schedule: { caller: "position", failures: 1 },
    });
    expect(r.product.filter((e) => e.kind === "materialise")).toEqual([]);
    await r.held[1]?.release();
    await expect
      .poll(
        async () =>
          (await retained(r.page, id.account_id, made.taskId)).rows.length,
        { timeout: 120_000 },
      )
      .toBe(0);
    await r.page.waitForTimeout(3_000);
    expect(r.product.slice(0, 3).map((e) => e.kind)).toEqual([
      "position",
      "position",
      "materialise",
    ]);
    const keys = r.product
      .filter((e) => e.kind === "materialise")
      .map((e) => e.key);
    expect(keys.length).toBeGreaterThan(0);
    expect(keys).not.toContain(oldKey);
    expect(new Set(keys).size).toBe(keys.length);
    expect((await position(r.page, id, made.taskId))?.pending).toBe(false);
  });
});

test.describe("I-10C-M5: an archived task's refusal is terminal (A4; CM-434)", () => {
  test("archived during a held sequence: the next call is refused 422, the stop says so, nothing more is sent", async ({
    context,
    provokes,
  }) => {
    provokes(422);
    const { page, id } = await bootAs(context, main);
    const made = await makeTask(page, id, backdated(40), { title: "I-10C-M5" });
    let n = 0;
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    await page.route(`**${API}/task-commands`, async (route) => {
      const body = route.request().postDataJSON() as {
        command?: { kind?: string };
      } | null;
      if (body?.command?.kind !== "materialise") return route.fallback();
      n += 1;
      if (n === 2) await gate;
      return route.fallback();
    });
    const log = requestLog(page, made.taskId);
    await go(page, `/today?day=${today()}&tz=${encodeURIComponent(ZONE)}`);
    await expect.poll(() => n, { timeout: 60_000 }).toBe(2);
    const task = (await call(page, id, "GET", `/tasks/${made.taskId}`))
      .body as { task: { version: number } };
    const archived = await call(
      page,
      id,
      "POST",
      "/task-commands",
      commands
        .archive({ taskId: made.taskId, archived: true })
        .build({ [made.taskId]: task.task.version }).command,
      crypto.randomUUID(),
    );
    expect(archived.status, JSON.stringify(archived.body)).toBe(200);
    release();
    await expect(
      page.locator(`[data-catch-up-task="${made.taskId}"]`),
    ).toHaveAttribute("data-catch-up-stopped", "rejected", { timeout: 60_000 });
    const sent = log.filter((e) => e.kind === "materialise").length;
    await page.waitForTimeout(3_000);
    expect(log.filter((e) => e.kind === "materialise").length).toBe(sent);
  });
});

// ---- streak -----------------------------------------------------------------------------------------------------------------------
test.describe("I-10C-S1: the streak needs the days first (A5; CM-395; TASK-5)", () => {
  test("409 materialisation_required → caught up → the figures", async ({
    context,
    provokes,
  }) => {
    provokes(409);
    const { page, id } = await bootAs(context, main);
    const made = await makeTask(page, id, backdated(5), { title: "I-10C-S1" });
    expect(
      (
        await call(
          page,
          id,
          "GET",
          `/tasks/${made.taskId}/streak?scope=personal`,
        )
      ).body,
    ).toMatchObject({
      code: "materialisation_required",
    });
    await go(page, `/tasks/${made.taskId}/streak`);
    await expect(page.locator("[data-streak-scope=personal]")).toHaveAttribute(
      "data-streak-state",
      "ready",
      {
        timeout: 90_000,
      },
    );
    expect((await position(page, id, made.taskId))?.pending).toBe(false);
    const figures = (
      await call(page, id, "GET", `/tasks/${made.taskId}/streak?scope=personal`)
    ).body as {
      current: number;
    };
    // The unit comes from this device's copy of the task (it arrives by sync).
    await expect(page.locator("[data-streak-scope=personal]")).toContainText(
      `On a run of ${figures.current} ${figures.current === 1 ? "day" : "days"}`,
      { timeout: 60_000 },
    );
  });
});

test.describe("I-10C-S2: a withheld joint figure; my own readable (A6; CM-368)", () => {
  test("a reader who cannot see a participant's progress sees the shared figures Withheld, and their own as numbers (never 0 for unknown, never unknown for 0)", async ({
    context,
    browser,
  }) => {
    const { page, id } = await bootAs(context, main);
    const bContext = await browser.newContext();
    try {
      const b = await bootAs(bContext, "frank");
      // The owner's progress is private (only me): a reader of the task cannot see it, so each closed day's shared result is unknown.
      const definition = def(
        { participation: "everyone", carry: "close_incomplete" },
        { start_date: addDays(today(), -2), repeat: daily },
      );
      const made = await makeTask(page, id, definition, {
        title: "I-10C-S2",
        grants: [{ kind: "account", id: b.id.account_id, edit: false }],
      });
      expect((await materialise(page, id, made.taskId, today())).status).toBe(
        200,
      );
      const joint = (
        await call(
          b.page,
          b.id,
          "GET",
          `/tasks/${made.taskId}/streak?scope=joint`,
        )
      ).body as {
        current: number | null;
      };
      expect(joint.current).toBeNull();
      const mine = (
        await call(
          b.page,
          b.id,
          "GET",
          `/tasks/${made.taskId}/streak?scope=personal`,
        )
      ).body as {
        current: number | null;
      };
      expect(mine.current).toBe(0);
      await go(b.page, `/tasks/${made.taskId}/streak`);
      await expect(b.page.locator("[data-streak-scope=joint]")).toContainText(
        "Withheld — someone keeps their part private",
        { timeout: 90_000 },
      );
      await expect(
        b.page.locator("[data-streak-scope=joint]"),
      ).not.toContainText("0");
      await expect(
        b.page.locator("[data-streak-scope=personal]"),
      ).toContainText("On a run of 0", {
        timeout: 60_000,
      });
    } finally {
      await bContext.close();
    }
  });
});

// ---- dependencies -----------------------------------------------------------------------------------------------------------------
test.describe("I-10C-D1/D2: a chain set in the UI, previewed and completed (A8; CM-354)", () => {
  test("set in the editor → the preview lists it in completion order → 'Tick the others off' completes both in one command; strict withholds Start anyway and the server refuses an override", async ({
    context,
    provokes,
  }) => {
    provokes(409);
    const { page, id } = await bootAs(context, main);
    const first = await makeTask(page, id, def(), { title: "I-10C-D1 first" });
    const root = await makeTask(page, id, def(), { title: "I-10C-D1 root" });
    await page.evaluate(() => window.__atlasData?.retryOutbox());
    await go(page, `/tasks/${root.taskId}?occurrence=${root.occurrenceId}`);
    await expect(page.locator("[data-dependencies-none]")).toBeVisible({
      timeout: 60_000,
    });
    await page
      .locator("[data-dependencies]")
      .getByRole("button", { name: "Set what this waits for" })
      .click();
    const editor = page.getByRole("dialog");
    await editor.getByLabel("Task").selectOption(first.taskId);
    await editor.getByLabel("Day").selectOption(first.occurrenceId);
    await editor.getByRole("button", { name: "Add" }).click();
    await editor.getByLabel("Don't allow starting early").check();
    await editor.getByRole("button", { name: "Save" }).click();
    await expect(editor).toHaveCount(0);
    await page.evaluate(() => window.__atlasData?.retryOutbox());
    await expect
      .poll(
        async () => (await preview(page, id, root.occurrenceId)).items.length,
        { timeout: 60_000 },
      )
      .toBe(2);
    const p = await preview(page, id, root.occurrenceId);
    expect(p.items.map((i) => i.occurrence_id)).toEqual([
      first.occurrenceId,
      root.occurrenceId,
    ]);
    expect(p.strict).toBe(true);
    // The server refuses a strict override (D2).
    expect(
      (
        await completeWith(
          page,
          id,
          root.occurrenceId,
          p.token,
          "advisory_override",
        )
      ).status,
    ).toBe(409);
    await page
      .locator("[data-dependencies]")
      .getByRole("button", { name: "Refresh" })
      .click();
    await page
      .locator("[data-dependencies]")
      .getByRole("button", { name: "See what needs doing first" })
      .click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.locator("[data-dependency-list] li")).toHaveCount(2);
    await expect(
      dialog.getByRole("radio", { name: "Start anyway" }),
    ).toHaveCount(0);
    await dialog
      .getByRole("radio", { name: "Tick the others off as well" })
      .click();
    await dialog
      .getByRole("button", { name: "Tick the others off as well" })
      .click();
    await page.evaluate(() => window.__atlasData?.retryOutbox());
    await expect
      .poll(
        async () =>
          (await preview(page, id, root.occurrenceId)).items.every(
            (i) => i.complete,
          ),
        {
          timeout: 60_000,
        },
      )
      .toBe(true);
    expect(
      (await viewOf(page, id, root.taskId, root.occurrenceId, "personal"))
        ?.outcome,
    ).toBe("complete");
  });
});

test.describe("I-10C-D3: one atomic command (A9; TASK-14)", () => {
  test("a checkbox prerequisite completable before a numeric one that is not: refused 409 with nothing committed; a strict root's override refused", async ({
    context,
    provokes,
  }) => {
    provokes(409);
    const { page, id } = await bootAs(context, main);
    const checkbox = await makeTask(page, id, def(), {
      title: "I-10C-D3 checkbox",
    });
    const numeric = await makeTask(
      page,
      id,
      def({
        goal: { kind: "numeric", minimum: "5", maximum: null, unit: "km" },
      }),
      { title: "I-10C-D3 numeric" },
    );
    const root = await makeTask(page, id, def(), { title: "I-10C-D3 root" });
    expect(
      (
        await setDeps(
          page,
          id,
          numeric.taskId,
          numeric.occurrenceId,
          [checkbox.occurrenceId],
          false,
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await setDeps(
          page,
          id,
          root.taskId,
          root.occurrenceId,
          [numeric.occurrenceId],
          true,
        )
      ).status,
    ).toBe(200);
    const p = await preview(page, id, root.occurrenceId);
    expect(p.items.map((i) => i.occurrence_id)).toEqual([
      checkbox.occurrenceId,
      numeric.occurrenceId,
      root.occurrenceId,
    ]);
    expect(
      p.items.find((i) => i.occurrence_id === numeric.occurrenceId)
        ?.can_complete,
    ).toBe(false);
    expect(
      (
        await completeWith(
          page,
          id,
          root.occurrenceId,
          p.token,
          "complete_prerequisites",
        )
      ).status,
    ).toBe(409);
    for (const t of [checkbox, numeric, root])
      expect(
        (await viewOf(page, id, t.taskId, t.occurrenceId, "personal"))?.outcome,
      ).not.toBe("complete");
    expect(
      (await preview(page, id, root.occurrenceId)).items.every(
        (i) => !i.complete,
      ),
    ).toBe(true);
    expect(
      (
        await completeWith(
          page,
          id,
          root.occurrenceId,
          p.token,
          "advisory_override",
        )
      ).status,
    ).toBe(409);
  });
});

test.describe("I-10C-D4: the unavailable boundary (A10; TASK-14a)", () => {
  test("a reader who cannot see a prerequisite: unavailable, the count of what is visible only, the token unchanged when the owner completes it, the cascade refused, the editor withheld", async ({
    context,
    browser,
    provokes,
  }) => {
    provokes(409);
    const { page, id } = await bootAs(context, main);
    const bContext = await browser.newContext();
    try {
      const b = await bootAs(bContext, "frank");
      const hidden = await makeTask(page, id, def(), {
        title: "I-10C-D4 private",
      });
      const root = await makeTask(page, id, def(), {
        title: "I-10C-D4 shared",
        grants: [{ kind: "account", id: b.id.account_id, edit: true }],
      });
      expect(
        (
          await setDeps(
            page,
            id,
            root.taskId,
            root.occurrenceId,
            [hidden.occurrenceId],
            false,
          )
        ).status,
      ).toBe(200);
      const before = await preview(b.page, b.id, root.occurrenceId);
      expect(before.unavailable).toBe(true);
      expect(before.items.map((i) => i.occurrence_id)).toEqual([
        root.occurrenceId,
      ]);
      const own = await preview(page, id, hidden.occurrenceId);
      expect(
        (
          await completeWith(
            page,
            id,
            hidden.occurrenceId,
            own.token,
            "require_satisfied",
          )
        ).status,
      ).toBe(200);
      const after = await preview(b.page, b.id, root.occurrenceId);
      expect(after.token).toBe(before.token);
      expect(
        (
          await completeWith(
            b.page,
            b.id,
            root.occurrenceId,
            after.token,
            "complete_prerequisites",
          )
        ).status,
      ).toBe(409);
      await b.page.evaluate(() => window.__atlasData?.retryOutbox());
      await go(b.page, `/tasks/${root.taskId}?occurrence=${root.occurrenceId}`);
      const row = b.page.locator("[data-dependencies]");
      await expect(row).toContainText(
        "Some of it is private to someone else.",
        { timeout: 60_000 },
      );
      await expect(row).not.toContainText("I-10C-D4 private");
      await expect(
        row.getByRole("button", { name: "Set what this waits for" }),
      ).toHaveCount(0);
    } finally {
      await bContext.close();
    }
  });
});

test.describe("I-10C-D6/D7: conflicts said from what the server holds (A11; CM-424)", () => {
  test("an offline tick of a day still waiting is refused 409 when sent, and says what it waits for; a cycle set in the editor is refused with neutral words and kept for editing", async ({
    context,
    provokes,
  }) => {
    provokes(409);
    const { page, id } = await bootAs(context, main);
    const first = await makeTask(page, id, def(), { title: "I-10C-D6 first" });
    const root = await makeTask(page, id, def(), { title: "I-10C-D6 root" });
    expect(
      (
        await setDeps(
          page,
          id,
          root.taskId,
          root.occurrenceId,
          [first.occurrenceId],
          false,
        )
      ).status,
    ).toBe(200);
    await page.evaluate(() => window.__atlasData?.retryOutbox());
    await go(page, `/tasks/${root.taskId}?occurrence=${root.occurrenceId}`);
    await expect(page.locator("[data-dependencies-progress]")).toBeVisible({
      timeout: 60_000,
    });
    await offline(page);
    await page
      .locator("[data-record-card]")
      .getByRole("button", { name: "Mark done" })
      .click();
    await online(page);
    await page.evaluate(() => window.__atlasData?.retryOutbox());
    await expect(page.locator("[data-unmet-conflict]")).toContainText(
      "This can't be marked done until “I-10C-D6 first” is.",
      { timeout: 60_000 },
    );
    // The refused tick is discarded (a later change naming this day would otherwise wait behind it in the queue).
    await page
      .locator("[data-unmet-conflict]")
      .getByRole("button", { name: "Discard" })
      .click();
    await expect(page.locator("[data-unmet-conflict]")).toHaveCount(0, {
      timeout: 30_000,
    });
    // D7: the first day may not wait for its own dependant.
    await go(page, `/tasks/${first.taskId}?occurrence=${first.occurrenceId}`);
    await page
      .locator("[data-dependencies]")
      .getByRole("button", { name: "Set what this waits for" })
      .click({ timeout: 60_000 });
    const editor = page.getByRole("dialog");
    await editor.getByLabel("Task").selectOption(root.taskId);
    await editor.getByLabel("Day").selectOption(root.occurrenceId);
    await editor.getByRole("button", { name: "Add" }).click();
    await editor.getByRole("button", { name: "Save" }).click();
    await page.evaluate(() => window.__atlasData?.retryOutbox());
    const block = page.locator("[data-set-conflict]");
    await expect(block).toContainText(
      "Couldn't set what this waits for as sent.",
      { timeout: 60_000 },
    );
    await expect(block).not.toContainText("I-10C-D6 root");
    await block.getByRole("button", { name: "Keep editing" }).click();
    await expect(
      page.locator(`[data-editor-item="${root.occurrenceId}"]`),
    ).toBeVisible();
  });
});

// ---- timers (B6) ------------------------------------------------------------------------------------------------------------------
test.describe("I-10C-TM1/TM2: timers in the UI, one per day, days independent (A12; CM-355, CM-394 under B6)", () => {
  test("start and stop in the UI records seconds; two days run at once; a second start on the same day is refused 409", async ({
    context,
    provokes,
  }) => {
    provokes(409);
    const { page, id } = await bootAs(context, main);
    const one = await makeTask(page, id, def({ goal: SECONDS }), {
      title: "I-10C-TM1 one",
    });
    const two = await makeTask(page, id, def({ goal: SECONDS }), {
      title: "I-10C-TM1 two",
    });
    await page.evaluate(() => window.__atlasData?.retryOutbox());
    await go(page, `/tasks/${one.taskId}?occurrence=${one.occurrenceId}`);
    const block = page.locator("[data-timer-block]");
    await block
      .getByRole("button", { name: "Start" })
      .click({ timeout: 60_000 });
    await page.evaluate(() => window.__atlasData?.retryOutbox());
    // The UI's start has reached the server.
    await expect
      .poll(
        async () =>
          (
            (
              await call(
                page,
                id,
                "GET",
                `/occurrences/${one.occurrenceId}/timers`,
              )
            ).body as { items: unknown[] }
          ).items.length,
        { timeout: 60_000 },
      )
      .toBe(1);
    // The other day's timer starts while this one runs (B6).
    const started = Math.floor(Date.now() / 1000);
    const other = await call(
      page,
      id,
      "POST",
      "/task-commands",
      commands
        .startTimer({
          occurrenceId: two.occurrenceId,
          sessionId: crypto.randomUUID(),
          progressId: two.progressId,
          startedAt: started,
          firstAnyoneStream: false,
          defaults: null,
        })
        .build({}).command,
      crypto.randomUUID(),
    );
    expect(other.status, JSON.stringify(other.body)).toBe(200);
    // A second session on the SAME day is refused.
    const again = await call(
      page,
      id,
      "POST",
      "/task-commands",
      commands
        .startTimer({
          occurrenceId: one.occurrenceId,
          sessionId: crypto.randomUUID(),
          progressId: one.progressId,
          startedAt: started,
          firstAnyoneStream: false,
          defaults: null,
        })
        .build({}).command,
      crypto.randomUUID(),
    );
    expect(again.status).toBe(409);
    await expect
      .poll(
        async () =>
          (
            (await call(page, id, "GET", "/timer-sessions?state=running"))
              .body as { items: unknown[] }
          ).items.length,
        { timeout: 60_000 },
      )
      .toBe(2);
    await page.waitForTimeout(1_200);
    await block.getByRole("button", { name: "Stop" }).click();
    await page.evaluate(() => window.__atlasData?.retryOutbox());
    await expect
      .poll(
        async () => {
          const items = await progressOf(page, id, one.occurrenceId);
          const mine = items.find((p) => p.id === one.progressId);
          return (
            (mine?.value as { action?: { amount?: string } } | undefined)
              ?.action?.amount ?? null
          );
        },
        { timeout: 60_000 },
      )
      .not.toBeNull();
  });
});

test.describe("I-10C-TM3: a stop that would complete a day still waiting (A13; CM-422; TASK-25)", () => {
  test("refused 409 when sent; the block claims no cause; the session is still open and nothing was recorded", async ({
    context,
    provokes,
  }) => {
    provokes(409);
    const { page, id } = await bootAs(context, main);
    const first = await makeTask(page, id, def(), { title: "I-10C-TM3 first" });
    const timed = await makeTask(
      page,
      id,
      def({
        goal: { kind: "numeric", minimum: "1", maximum: null, unit: "seconds" },
      }),
      { title: "I-10C-TM3 timed" },
    );
    expect(
      (
        await setDeps(
          page,
          id,
          timed.taskId,
          timed.occurrenceId,
          [first.occurrenceId],
          false,
        )
      ).status,
    ).toBe(200);
    await page.evaluate(() => window.__atlasData?.retryOutbox());
    await go(page, `/tasks/${timed.taskId}?occurrence=${timed.occurrenceId}`);
    const block = page.locator("[data-timer-block]");
    await block
      .getByRole("button", { name: "Start" })
      .click({ timeout: 60_000 });
    await page.evaluate(() => window.__atlasData?.retryOutbox());
    await expect
      .poll(
        async () =>
          (
            (
              await call(
                page,
                id,
                "GET",
                `/occurrences/${timed.occurrenceId}/timers`,
              )
            ).body as { items: unknown[] }
          ).items.length,
        { timeout: 60_000 },
      )
      .toBe(1);
    await page.waitForTimeout(2_200);
    await offline(page);
    await block.getByRole("button", { name: "Stop" }).click();
    await online(page);
    await page.evaluate(() => window.__atlasData?.retryOutbox());
    const conflict = page.locator("[data-timer-conflict]");
    await expect(conflict).toBeVisible({ timeout: 60_000 });
    expect((await conflict.textContent()) ?? "").not.toMatch(
      /overlap|already running/i,
    );
    const sessions = (
      await call(page, id, "GET", `/occurrences/${timed.occurrenceId}/timers`)
    ).body as {
      items: Array<{ stopped_at: number | null }>;
    };
    expect(sessions.items).toHaveLength(1);
    expect(sessions.items[0]?.stopped_at).toBeNull();
    const mine = (await progressOf(page, id, timed.occurrenceId)).find(
      (p) => p.id === timed.progressId,
    );
    expect(
      (mine?.value as { entry_count?: number } | undefined)?.entry_count ?? 0,
    ).toBe(0);
  });
});

test.describe("I-10C-TM4: version bases across a timer (A14; WEB-04 §5.2)", () => {
  test("offline: start, stop, then a checkbox-free exclusion of the same stream are all applied with no conflict", async ({
    context,
  }) => {
    const { page, id } = await bootAs(context, main);
    const timed = await makeTask(
      page,
      id,
      def({ goal: SECONDS, allow_streak_exclusions: true }),
      {
        title: "I-10C-TM4",
      },
    );
    await page.evaluate(() => window.__atlasData?.retryOutbox());
    await go(page, `/tasks/${timed.taskId}?occurrence=${timed.occurrenceId}`);
    const block = page.locator("[data-timer-block]");
    await expect(block).toHaveAttribute("data-timer-block", "idle", {
      timeout: 60_000,
    });
    await offline(page);
    await block.getByRole("button", { name: "Start" }).click();
    await page.waitForTimeout(1_200);
    await block.getByRole("button", { name: "Stop" }).click();
    await page.getByRole("button", { name: "Exclude from my streak" }).click();
    await online(page);
    await page.evaluate(() => window.__atlasData?.retryOutbox());
    await expect
      .poll(
        async () =>
          (
            (await page.evaluate(
              (a) => window.__atlasData?.rows(a, "drafts"),
              id.account_id,
            )) as Array<{ status: string }>
          ).filter((d) => d.status !== "acknowledged").length,
        { timeout: 60_000 },
      )
      .toBe(0);
    const drafts = (await page.evaluate(
      (a) => window.__atlasData?.rows(a, "drafts"),
      id.account_id,
    )) as Array<{ status: string; kind: string }>;
    expect(drafts.filter((d) => d.status === "version_conflict")).toEqual([]);
    const mine = (await progressOf(page, id, timed.occurrenceId)).find(
      (p) => p.id === timed.progressId,
    );
    expect((mine?.value as { excluded?: boolean } | undefined)?.excluded).toBe(
      true,
    );
  });
});

test.describe("I-10C-TM6: the account's timers, restricted when sharing changes (A15; B6)", () => {
  test("B's running timer on a task shared with B is listed with its title; after A revokes the share it is restricted with no actions; restored, it is available again", async ({
    context,
    browser,
  }) => {
    const { page, id } = await bootAs(context, main);
    const bContext = await browser.newContext();
    try {
      const b = await bootAs(bContext, "frank");
      const made = await makeTask(
        page,
        id,
        def({ goal: SECONDS, participation: "anyone" }),
        {
          title: "I-10C-TM6",
          grants: [{ kind: "account", id: b.id.account_id, edit: true }],
        },
      );
      const session = crypto.randomUUID();
      const bProg = await progressId(made.occurrenceId, b.id.account_id);
      const started = await call(
        b.page,
        b.id,
        "POST",
        "/task-commands",
        commands
          .startTimer({
            occurrenceId: made.occurrenceId,
            sessionId: session,
            progressId: bProg,
            startedAt: Math.floor(Date.now() / 1000),
            firstAnyoneStream: true,
            defaults: null,
          })
          .build({}).command,
        crypto.randomUUID(),
      );
      expect(started.status, JSON.stringify(started.body)).toBe(200);
      await go(b.page, "/tasks/timers");
      await expect(
        b.page.locator(`[data-account-timer="${session}"]`),
      ).toContainText("I-10C-TM6", { timeout: 60_000 });
      const policy = async (grants: unknown[]) => {
        const task = (await call(page, id, "GET", `/tasks/${made.taskId}`))
          .body as { task: { policy_version: number } };
        return call(
          page,
          id,
          "POST",
          "/management-commands",
          {
            commands: [
              {
                kind: "replace_policy",
                id: made.taskId,
                expected_version: task.task.policy_version,
                policy: { grants, exclude_accounts: [] },
              },
            ],
          },
          crypto.randomUUID(),
        );
      };
      expect((await policy([])).status).toBe(200);
      await b.page.reload();
      await reopenBound(b.page, b.id.account_id, "/tasks/timers");
      const row = b.page.locator(`[data-account-timer="${session}"]`);
      await expect(row).toHaveAttribute("data-access", "restricted", {
        timeout: 60_000,
      });
      await expect(row.getByRole("button")).toHaveCount(0);
      expect(
        (await policy([{ kind: "account", id: b.id.account_id, edit: true }]))
          .status,
      ).toBe(200);
      await reopenBound(b.page, b.id.account_id, "/tasks/timers");
      await expect(
        b.page.locator(`[data-account-timer="${session}"]`),
      ).toHaveAttribute("data-access", "available", {
        timeout: 60_000,
      });
    } finally {
      await bContext.close();
    }
  });
});

// ---- successors (TASK-30, client-observable) ---------------------------------------------------------------------------------------
test.describe("I-10C-SU1: one successor after completion (A16; TASK-30 checks 2 and 4)", () => {
  test("completing an after-completion task gives exactly one successor, in sync, at its date; a correction of the completion leaves it single", async ({
    context,
  }) => {
    const { page, id } = await bootAs(context, main);
    const definition = def(
      {},
      { repeat: { frequency: "after_completion", interval: 2 } },
    );
    const made = await makeTask(page, id, definition, { title: "I-10C-SU1" });
    const entry = crypto.randomUUID();
    const done = await send(
      page,
      id,
      record(
        made.occurrenceId,
        made.progressId,
        id.account_id,
        { kind: "checkbox", complete: true },
        { entryId: entry },
      ),
      { [made.progressId]: 1 },
    );
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    await expect
      .poll(
        async () => (await views(page, id, made.taskId, "personal")).length,
        { timeout: 60_000 },
      )
      .toBe(2);
    const all = await views(page, id, made.taskId, "personal");
    const next = all.find((v) => v.id !== made.occurrenceId) as OccurrenceView;
    expect(next.data.slot.date).toBe(addDays(today(), 2));
    await page.evaluate(() => window.__atlasData?.retryOutbox());
    await expect
      .poll(async () => (await cacheRow(page, id.account_id, next.id))?.id, {
        timeout: 60_000,
      })
      .toBe(next.id);
    // Correcting the completing entry does not make a second successor.
    const fixed = await send(
      page,
      id,
      record(
        made.occurrenceId,
        made.progressId,
        id.account_id,
        { kind: "checkbox", complete: true },
        { replaces: entry },
      ),
    );
    expect(fixed.status, JSON.stringify(fixed.body)).toBe(200);
    await page.waitForTimeout(2_000);
    expect(await views(page, id, made.taskId, "personal")).toHaveLength(2);
  });
});

// ---- revision 1 (review R9): the defaults review (A14, I-TM5) and a hidden completion (A16, TASK-30 check 6) ------------------------

/** The person's sharing defaults are on this device (WEB-12a's `sync_state.defaults`): what a command captures when it is queued. */
const untilDefaultsKept = (page: Page, account: string) =>
  expect
    .poll(
      async () =>
        (
          (await page.evaluate(
            (a) => window.__atlasData?.rows(a, "sync_state"),
            account,
          )) as Array<{ defaults?: unknown }>
        )[0]?.defaults != null,
      { timeout: 60_000 },
    )
    .toBe(true);
/** The defaults move on the server (the progress template), as another device would move them. */
async function moveDefaults(page: Page, id: Id): Promise<void> {
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
  expect(moved.status, JSON.stringify(moved.body)).toBe(200);
}
/** The queued command of `kind` this device holds (its stored body). */
const queuedBody = async (page: Page, account: string, kind: string) => {
  const drafts = (await page.evaluate(
    (a) => window.__atlasData?.rows(a, "drafts"),
    account,
  )) as Array<{ local_id: string; kind: string }>;
  const bodies = (await page.evaluate(
    (a) => window.__atlasData?.rows(a, "draft_commands"),
    account,
  )) as Array<{ local_id: string; command: Record<string, unknown> }>;
  const draft = drafts.find((d) => d.kind === kind);
  return bodies.find((b) => b.local_id === draft?.local_id)?.command as
    | { command: Record<string, unknown>; defaults_revision?: string }
    | undefined;
};
/** Review and confirm the audience in the Sync screen's conflicts (WEB-12a), then let the outbox send again. */
async function reviewAndConfirm(page: Page): Promise<void> {
  await page.evaluate(() => window.__atlasData?.retryOutbox());
  await go(page, "/sync?tab=conflicts");
  await page
    .getByRole("button", { name: /^Review sharing/ })
    .first()
    .click({ timeout: 60_000 });
  const review = page.getByRole("dialog", { name: "Review sharing" });
  await expect(review).toContainText("Sharing defaults have changed", {
    timeout: 30_000,
  });
  await review.locator("[data-confirm]").click();
  await expect(review).toBeHidden({ timeout: 30_000 });
  await page.evaluate(() => window.__atlasData?.retryOutbox());
}

test.describe("I-10C-TM5: the first Anyone timer and a completion each wait for a defaults review (A14; WEB-04 §5.7 items 3–4)", () => {
  test("a first Anyone start queued offline under the defaults it saw: the defaults move, it is refused defaults_changed, reviewed and confirmed, then applied once", async ({
    context,
    browser,
    provokes,
  }) => {
    provokes(409);
    const { page, id } = await bootAs(context, main);
    const ownerContext = await browser.newContext();
    try {
      const owner = await apiAs(ownerContext, "frank");
      // Someone else's Anyone task shared with me: my first start creates my stream, so it captures my progress defaults.
      const made = await makeTask(
        owner.page,
        owner.id,
        def({ goal: SECONDS, participation: "anyone", carry: "retain_one" }),
        {
          title: "I-10C-TM5 timer",
          grants: [{ kind: "account", id: id.account_id, edit: true }],
        },
      );
      await expect
        .poll(
          async () =>
            (await cacheRow(page, id.account_id, made.occurrenceId))?.id,
          {
            timeout: 60_000,
          },
        )
        .toBe(made.occurrenceId);
      await go(page, `/tasks/${made.taskId}?occurrence=${made.occurrenceId}`);
      const block = page.locator("[data-timer-block]");
      await expect(block).toHaveAttribute("data-timer-block", "idle", {
        timeout: 60_000,
      });
      // The timer block reads my sharing defaults (WEB-12a): what its first Anyone start captures.
      await untilDefaultsKept(page, id.account_id);
      await offline(page);
      await block.getByRole("button", { name: "Start" }).click();
      await expect(block).toHaveAttribute("data-timer-block", "running");
      const queued = await queuedBody(page, id.account_id, "start_timer");
      // The precondition the case rests on: the start captured the defaults it was queued under.
      expect(queued?.defaults_revision, JSON.stringify(queued)).toBeTruthy();
      const session = queued?.command.session_id as string;
      await moveDefaults(page, id);
      await online(page);
      await reviewAndConfirm(page);
      await expect
        .poll(
          async () => {
            const out = await call(
              page,
              id,
              "GET",
              `/occurrences/${made.occurrenceId}/timers`,
            );
            return out.status === 200
              ? (
                  out.body as {
                    items: Array<{ id: string; stopped_at: unknown }>;
                  }
                ).items.map((i) => [i.id, i.stopped_at])
              : [out.status, out.body];
          },
          { timeout: 60_000 },
        )
        .toEqual([[session, null]]);
    } finally {
      await ownerContext.close();
    }
  });

  test("a completion composed online and held before it is sent: the defaults move, it is refused defaults_changed, reviewed and confirmed, then applied once", async ({
    context,
    provokes,
  }) => {
    provokes(409);
    const { page, id } = await bootAs(context, main);
    const first = await makeTask(page, id, def(), { title: "I-10C-TM5 first" });
    const root = await makeTask(page, id, def(), { title: "I-10C-TM5 root" });
    expect(
      (
        await setDeps(
          page,
          id,
          root.taskId,
          root.occurrenceId,
          [first.occurrenceId],
          false,
        )
      ).status,
    ).toBe(200);
    await page.evaluate(() => window.__atlasData?.retryOutbox());
    await go(page, `/tasks/${root.taskId}?occurrence=${root.occurrenceId}`);
    await expect(page.locator("[data-dependencies-progress]")).toBeVisible({
      timeout: 60_000,
    });
    // The detail reads my sharing defaults (WEB-12a): what the completion captures.
    await untilDefaultsKept(page, id.account_id);
    // Queue first, send after: the outbox keeps what is saved and sends nothing until it begins again.
    await page.evaluate(async (a) => {
      const data = window.__atlasData;
      if (!data) throw new Error("no data harness");
      data.stopOutbox();
      await data.startOutbox(a, { start: false });
    }, id.account_id);
    await page
      .locator("[data-dependencies]")
      .getByRole("button", { name: "See what needs doing first" })
      .click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.locator("[data-dependency-list] li")).toHaveCount(2);
    await dialog
      .getByRole("radio", { name: "Tick the others off as well" })
      .click();
    await dialog
      .getByRole("button", { name: "Tick the others off as well" })
      .click();
    await expect(dialog).toHaveCount(0);
    const queued = await queuedBody(
      page,
      id.account_id,
      "complete_dependencies",
    );
    expect(queued?.defaults_revision, JSON.stringify(queued)).toBeTruthy();
    await moveDefaults(page, id);
    await page.evaluate(() => window.__atlasData?.beginOutbox());
    await reviewAndConfirm(page);
    await expect
      .poll(
        async () =>
          (await preview(page, id, root.occurrenceId)).items.every(
            (i) => i.complete,
          ),
        { timeout: 60_000 },
      )
      .toBe(true);
    // Applied once: one completion entry on each stream.
    for (const occ of [first.occurrenceId, root.occurrenceId]) {
      const mine = (await progressOf(page, id, occ)).find(
        (p) =>
          p.id ===
          (occ === root.occurrenceId ? root.progressId : first.progressId),
      );
      expect(
        (mine?.value as { entry_count?: number } | undefined)?.entry_count,
      ).toBe(1);
    }
  });
});

test.describe("I-10C-SU1 check 6: a hidden completion exposes and triggers no successor (A16; TASK-30)", () => {
  test("B completes an Anyone after-completion task of mine on a stream I cannot see: no successor through a whole reconciliation; once B shares the stream, exactly one, dated from that completion", async ({
    context,
    browser,
  }) => {
    const { page, id } = await bootAs(context, main);
    const bContext = await browser.newContext();
    try {
      const b = await apiAs(bContext, "frank");
      // The server's own case (`successors.rs`, completion_relative_does_not_reveal_private_anyone_timestamp): a second participant's
      // completion on a stream another schedule reader cannot see is not common evidence. B's first record creates B's stream with B's
      // progress defaults (`commands.rs`), private here; the successor is decided only on evidence every reader can see.
      const made = await makeTask(
        page,
        id,
        def(
          { participation: "anyone", carry: "accumulate" },
          { repeat: { frequency: "after_completion", interval: 2 } },
        ),
        {
          title: "I-10C-SU1 check 6",
          grants: [{ kind: "account", id: b.id.account_id, edit: true }],
        },
      );
      const stream = await progressId(made.occurrenceId, b.id.account_id);
      // B's first record creates B's stream (seeded at 1, as the client's builder resolves it: `seedIfUntracked`).
      const done = await send(
        b.page,
        b.id,
        record(
          made.occurrenceId,
          stream,
          b.id.account_id,
          { kind: "checkbox", complete: true },
          { firstAnyoneStream: true },
        ),
        { [stream]: 1 },
      );
      expect(done.status, JSON.stringify(done.body)).toBe(200);
      const recordedAt = Date.now();
      // The precondition the case rests on: B's stream (and its timestamp) is hidden from me.
      expect(
        (await progressOf(page, id, made.occurrenceId)).map((p) => p.id),
      ).not.toContain(stream);
      // The server re-checks a pending completion a minute later on its 15 s worker tick (`successors.rs`, `main.rs`): wait through one
      // whole reconciliation, never a shortened one, then look from both readers.
      await page.waitForTimeout(
        Math.max(0, 80_000 - (Date.now() - recordedAt)),
      );
      // Seen from the schedule's owner: still the one day. B's own listing is not evidence either way: it lists only the days B takes
      // part in, so it shows no successor even once one exists (observed in the control below).
      expect(await views(page, id, made.taskId, "personal")).toHaveLength(1);
      // Control (the server case's own second step): B shares the stream with me; the same completion is now common evidence and the
      // next reconciliation gives exactly one successor, dated from it (interval 2), so the absence above was the hidden evidence.
      const mine = (await progressOf(b.page, b.id, made.occurrenceId)).find(
        (p) => p.id === stream,
      ) as { policy_version?: number } | undefined;
      const shared = await call(
        b.page,
        b.id,
        "POST",
        "/management-commands",
        {
          commands: [
            {
              kind: "replace_policy",
              id: stream,
              expected_version: mine?.policy_version,
              policy: {
                grants: [{ kind: "account", id: id.account_id, edit: false }],
                exclude_accounts: [],
              },
            },
          ],
        },
        crypto.randomUUID(),
      );
      expect(shared.status, JSON.stringify(shared.body)).toBe(200);
      await expect
        .poll(
          async () => (await views(page, id, made.taskId, "personal")).length,
          { timeout: 120_000 },
        )
        .toBe(2);
      const next = (await views(page, id, made.taskId, "personal")).find(
        (v) => v.id !== made.occurrenceId,
      ) as OccurrenceView;
      expect(next.data.slot.date).toBe(addDays(today(), 2));
    } finally {
      await bContext.close();
    }
  });
});

// ---- rotas ------------------------------------------------------------------------------------------------------------------------
test.describe("I-10C-R1: consent, order and the turns it gives (A17; CM-356; TASK-15, 29)", () => {
  test("both agree; the editor sets the order in the UI; the next days take turns; a new order leaves set turns alone; a reader sees no candidates; an empty order sets none", async ({
    context,
    browser,
  }) => {
    const { page, id } = await bootAs(context, main);
    const bContext = await browser.newContext();
    const cContext = await browser.newContext();
    try {
      const b = await apiAs(bContext, "frank");
      const c = await apiAs(cContext, "grace");
      const definition = def(
        { participation: "anyone", carry: "accumulate" },
        { repeat: daily },
      );
      const made = await makeTask(page, id, definition, {
        title: "I-10C-R1",
        grants: [
          { kind: "account", id: b.id.account_id, edit: true },
          { kind: "account", id: c.id.account_id, edit: false },
        ],
      });
      expect(
        (
          await access(b.page, b.id, {
            kind: "enrol",
            task_id: made.taskId,
            expected_version: 0,
            active: true,
            aggregate_consent: true,
            initial_policy: { grants: [], exclude_accounts: [] },
          })
        ).status,
      ).toBe(200);
      expect(
        (
          await access(b.page, b.id, {
            kind: "rota_consent",
            task_id: made.taskId,
            expected_version: 0,
            accepted: true,
          })
        ).status,
      ).toBe(200);
      await go(page, `/tasks/${made.taskId}?occurrence=${made.occurrenceId}`);
      const consent = page.getByLabel("Take turns on this task");
      await expect(consent).toBeEnabled({ timeout: 60_000 });
      await consent.click();
      await expect(consent).toBeChecked({ timeout: 30_000 });
      // A reader sees no candidates (TASK-15).
      const asReader = (
        await call(c.page, c.id, "GET", `/tasks/${made.taskId}/rota`)
      ).body as {
        eligible_participants: string[];
      };
      expect(asReader.eligible_participants).toEqual([]);
      await page.getByRole("button", { name: "Turn order…" }).click();
      const dialog = page.getByRole("dialog");
      // Both people who joined and agreed are offered; both are added, in the order offered.
      await expect(dialog.getByRole("button", { name: /^Add: / })).toHaveCount(
        2,
        { timeout: 30_000 },
      );
      await dialog
        .getByRole("button", { name: /^Add: / })
        .first()
        .click();
      await dialog
        .getByRole("button", { name: /^Add: / })
        .first()
        .click();
      await expect(dialog.locator("[data-rota-count]")).toContainText("2 of 8");
      await dialog.getByRole("button", { name: "Save order" }).click();
      await expect(dialog).toHaveCount(0, { timeout: 30_000 });
      const state = (await call(page, id, "GET", `/tasks/${made.taskId}/rota`))
        .body as {
        version: number;
        participants: string[];
      };
      expect(state.version).toBe(1);
      expect(state.participants.sort()).toEqual(
        [id.account_id, b.id.account_id].sort(),
      );
      expect(
        (await materialise(page, id, made.taskId, addDays(today(), 2))).status,
      ).toBe(200);
      const turns = async () =>
        (await views(page, id, made.taskId, "personal"))
          .filter((v) => v.data.rota)
          .sort((x, y) =>
            (x.data.slot.date ?? "").localeCompare(y.data.slot.date ?? ""),
          )
          .map((v) => [v.id, v.data.rota?.account_id ?? null] as const);
      const set = await turns();
      expect(set).toHaveLength(2);
      expect(new Set(set.map(([, a]) => a)).size).toBe(2);
      // A new (empty) order: already-set turns keep their person, and no further turn is set (TASK-29).
      expect(
        (
          await access(page, id, {
            kind: "set_rota",
            task_id: made.taskId,
            expected_version: 1,
            participants: [],
          })
        ).status,
      ).toBe(200);
      expect(
        (await materialise(page, id, made.taskId, addDays(today(), 3))).status,
      ).toBe(200);
      const later = await turns();
      expect(later.slice(0, 2)).toEqual(set);
      expect(later).toHaveLength(2);
    } finally {
      await bContext.close();
      await cContext.close();
    }
  });
});

test.describe("I-10C-R4: the rota's preconditions (A17; TASK-32)", () => {
  test("a non-Anyone task refuses both commands 422; consent without enrolment 409; an order naming someone who has not agreed 409 with nothing applied; on /task-commands 422", async ({
    context,
    browser,
    provokes,
  }) => {
    provokes(409, 422);
    const { page, id } = await bootAs(context, main);
    const bContext = await browser.newContext();
    try {
      const b = await apiAs(bContext, "frank");
      const personal = await makeTask(page, id, def(), {
        title: "I-10C-R4 personal",
      });
      expect(
        (
          await access(page, id, {
            kind: "set_rota",
            task_id: personal.taskId,
            expected_version: 0,
            participants: [],
          })
        ).status,
      ).toBe(422);
      expect(
        (
          await access(page, id, {
            kind: "rota_consent",
            task_id: personal.taskId,
            expected_version: 0,
            accepted: true,
          })
        ).status,
      ).toBe(422);
      const anyone = await makeTask(
        page,
        id,
        def({ participation: "anyone" }, { repeat: daily }),
        {
          title: "I-10C-R4 anyone",
          grants: [{ kind: "account", id: b.id.account_id, edit: true }],
        },
      );
      expect(
        (
          await access(b.page, b.id, {
            kind: "rota_consent",
            task_id: anyone.taskId,
            expected_version: 0,
            accepted: true,
          })
        ).status,
      ).toBe(409);
      expect(
        (
          await access(page, id, {
            kind: "set_rota",
            task_id: anyone.taskId,
            expected_version: 0,
            participants: [b.id.account_id],
          })
        ).status,
      ).toBe(409);
      expect(
        (
          (await call(page, id, "GET", `/tasks/${anyone.taskId}/rota`))
            .body as { version: number }
        ).version,
      ).toBe(0);
      const onCommands = await call(
        page,
        id,
        "POST",
        "/task-commands",
        {
          command: {
            kind: "set_rota",
            task_id: anyone.taskId,
            expected_version: 0,
            participants: [],
          },
        },
        crypto.randomUUID(),
      );
      expect(onCommands.status).toBe(422);
    } finally {
      await bContext.close();
    }
  });
});
