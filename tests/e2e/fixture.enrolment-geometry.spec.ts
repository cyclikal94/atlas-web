import {
  type BrowserContext,
  expect,
  type Locator,
  type Page,
  type Route,
  test,
} from "@playwright/test";
import { serveIdentityReads } from "./data-local-faults";
import { ACCOUNT, seedSettled, stubNetwork } from "./data-sync-helpers";
import { serveTasks10c } from "./tasks-10c-helpers";
import { buildTask, cacheTasks, serveTaskReads } from "./tasks-helpers";

/**
 * WEB-13b revision 36 (Review 43 F43-1; design assessment 4062d86c, I1, I2, I7 and Q4/Q5, family `task-detail-pending-layout-shift`).
 *
 * E-T46: a press in the enrolment panel never brings ANOTHER enabled control under the pointer while it is pending. E-T16 presses Join
 * with `dblclick()` and then clicks through `page.evaluate`, which does not hit-test, so it passed or failed on the length of the page.
 * These cases look at the page the way a person's second press does:
 *
 * - press 1 is a real mouse click at the control's centre after `scrollIntoViewIfNeeded` (where Playwright's own click would put it);
 * - while the change is pending (its request held), the element at the centre and at four inset corners of the control's ORIGINAL box is
 *   the control itself (or its disabled replacement), or is disabled, inert or not interactive at all (I1);
 * - a real second press is then made at each of those five points, and nothing more is sent and no dialog opens;
 * - for Join and Save sharing, whose audience chooser above them drops its editing controls while blocked, the control's top moves by at
 *   most 1 px (I2; device-pixel rounding);
 * - every row runs in the fixture's natural page and in the same page with a tall spacer appended after boot (I7), so a pass cannot come
 *   from the browser clamping the scroll of a short document.
 *
 * Join and Save sharing also run with the chooser's own state changed after the parent's last render (the household picker open, the
 * directory lookup open, the household list answered late, a refusal line), which a reserve measured by the parent got wrong (DA-1).
 * E-T46b holds the follow-up read (the "Checking…" phase), answers with a refusal or no answer, and resizes while held (Q5).
 *
 * Out of scope here, reported in `.agtx/execute.md` (decision D-1 of the design assessment): Cancel, Discard and a settled Join or Save,
 * where the layout change is the intended result of the press.
 */

const SHARED = {
  grants: [
    {
      kind: "account",
      id: "22222222-2222-4222-8222-222222222222",
      edit: false,
    },
  ],
  exclude_accounts: [] as string[],
};
const PRIVATE = { grants: [] as unknown[], exclude_accounts: [] as string[] };
/** `n` account grants (the chooser refuses a grant past 100: a refusal line it shows on its own, with no render of its parent). */
const grants = (n: number) => ({
  grants: Array.from({ length: n }, (_, i) => ({
    kind: "account",
    id: `33333333-3333-4333-8333-${String(i).padStart(12, "0")}`,
    edit: false,
  })),
  exclude_accounts: [] as string[],
});
const JAMIE = "44444444-4444-4444-8444-444444444444";
const KIM = "55555555-5555-4555-8555-555555555555";

type Row =
  | "join"
  | "save"
  | "leave"
  | "consent"
  | "change"
  | "retry-join"
  | "retry-save";
type State = "plain" | "picker" | "lookup" | "late" | "refusal";
type Layout = "natural" | "spacer";
type Participation = "everyone" | "anyone";

/**
 * What counts as the pressed control (or its disabled replacement) at a sample point. "Change…" is replaced by the editor, so for it
 * nothing counts as the same control: whatever comes under the pointer must be disabled or not interactive.
 */
const NOTHING = "[data-matches-nothing]";
const SAME: Record<Row, string> = {
  join: '[data-enrol-act="join"]',
  save: '[data-enrol-act="save-audience"]',
  leave: '[data-enrol-act="leave"]',
  consent: "[data-enrolment] input[type=checkbox]",
  change: NOTHING,
  "retry-join": "[data-enrolment-uncertain] button",
  "retry-save": "[data-enrolment-uncertain] button",
};

interface Hold {
  promise: Promise<void>;
  release(): void;
}
function hold(): Hold {
  let release: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

async function bootAt(context: BrowserContext, route: string): Promise<Page> {
  const page = await context.newPage();
  await page.goto(`/__session?route=${encodeURIComponent(route)}`);
  await page.waitForFunction(
    () => window.__atlasFixture?.session?.booted !== undefined,
  );
  await page.evaluate(() => window.__atlasFixture?.session?.ready);
  await page.waitForFunction(() => window.__atlasData !== undefined);
  return page;
}

/** A route predicate on the API path alone (a glob does not match a URL with a query, `?username=` or `?scope=`). */
const at = (path: string) => (url: URL) =>
  url.pathname === `/api/experimental/v1${path}`;

const json = (route: Route, status: number, body: unknown) =>
  route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  });

interface World {
  page: Page;
  settings: Locator;
  /** Every enrolment command sent (`POST /task-access-commands`), in order. */
  calls: string[];
  /** Set to make the next enrolment reads wait (the "Checking…" phase). */
  reads: { hold: Hold | null; count: number };
  /** Answers enrolment commands in order: "hold" waits for `commands.held`; "abort" sends no answer; a number is a definite status. */
  commands: { script: Array<"hold" | "abort" | number>; held: Hold };
  households: Hold | null;
  enrolment: { value: Record<string, unknown> };
}

async function world(
  context: BrowserContext,
  opts: {
    n: number;
    participation: Participation;
    enrolment: Record<string, unknown>;
    lateHouseholds?: boolean;
  },
): Promise<World> {
  const task = buildTask({
    n: opts.n,
    title: "Shared",
    participation: opts.participation,
  });
  const net = await stubNetwork(context);
  await serveIdentityReads(context);
  await serveTaskReads(context);
  const r10c = await serveTasks10c(context);
  // A rota the account takes part in: for "anyone" the controls after the enrolment panel are the rota's own writers.
  r10c.rota = () => ({
    status: 200,
    body: {
      version: 3,
      participants: [ACCOUNT],
      consent_version: 4,
      accepted: true,
      eligible_participants: [ACCOUNT],
    },
  });
  const w: Omit<World, "page" | "settings"> = {
    calls: [],
    reads: { hold: null, count: 0 },
    commands: { script: ["hold"], held: hold() },
    households: opts.lateHouseholds ? hold() : null,
    enrolment: { value: opts.enrolment },
  };
  await context.route(at(`/tasks/${task.taskId}/enrolment`), async (route) => {
    w.reads.count += 1;
    const waiting = w.reads.hold;
    if (waiting !== null) await waiting.promise;
    return json(route, 200, w.enrolment.value);
  });
  await context.route(at("/households"), async (route) => {
    const waiting = w.households;
    if (waiting !== null) await waiting.promise;
    return json(route, 200, []);
  });
  await context.route(at("/directory"), (route) => {
    const username = new URL(route.request().url()).searchParams.get(
      "username",
    );
    return json(
      route,
      200,
      [
        { id: JAMIE, username: "jamie" },
        { id: KIM, username: "kim" },
      ].filter((entry) => entry.username === username),
    );
  });
  await context.route(at("/task-access-commands"), async (route) => {
    const body = route.request().postData() ?? "";
    if (!body.includes('"enrol"')) return route.fallback();
    w.calls.push(body);
    const next = w.commands.script.shift() ?? "hold";
    if (next === "abort") return route.abort("failed");
    if (next === "hold") {
      await w.commands.held.promise;
      return json(route, 200, { revision: 3 });
    }
    return json(route, next, {
      code: next === 409 ? "conflict" : "forbidden",
      message: "m",
      request_id: "11111111-1111-4111-8111-111111111111",
      details: [],
    });
  });
  await seedSettled(context);
  const page = await bootAt(
    context,
    `/tasks/${task.taskId}?occurrence=${task.occurrenceId}`,
  );
  await cacheTasks(page, net, [task]);
  const settings = page.locator("[data-enrolment]");
  return { ...w, page, settings } as World;
}

/** A tall spacer after the app (appended after boot, outside React's tree): the page stays long whatever the panel does. */
async function appendSpacer(page: Page): Promise<void> {
  await page.evaluate(() => {
    const spacer = document.createElement("div");
    spacer.setAttribute("data-geometry-spacer", "");
    spacer.style.height = "3000px";
    document.body.append(spacer);
  });
}

const frames = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );

interface Point {
  x: number;
  y: number;
  name: string;
}

/** The centre and four corners of `box`, inset by 4 px (or a quarter of a side, whichever is smaller). */
function pointsOf(box: {
  x: number;
  y: number;
  width: number;
  height: number;
}): Point[] {
  const dx = Math.min(4, box.width / 4);
  const dy = Math.min(4, box.height / 4);
  const left = box.x + dx;
  const right = box.x + box.width - dx;
  const top = box.y + dy;
  const bottom = box.y + box.height - dy;
  return [
    { name: "centre", x: box.x + box.width / 2, y: box.y + box.height / 2 },
    { name: "top-left", x: left, y: top },
    { name: "top-right", x: right, y: top },
    { name: "bottom-left", x: left, y: bottom },
    { name: "bottom-right", x: right, y: bottom },
  ];
}

/**
 * I1 at each point: what is there, and whether it is acceptable (the pressed control or its replacement, something disabled or inert, or
 * nothing interactive). The list of violations is returned for one assertion that names them all.
 */
async function hits(page: Page, points: Point[], same: string) {
  return page.evaluate(
    ({ points, same }) =>
      points.map((p) => {
        const at = document.elementFromPoint(p.x, p.y);
        if (at === null) return { point: p.name, ok: true, what: "nothing" };
        const interactive =
          'button, a[href], input, select, textarea, summary, [role="button"], [role="link"], [role="checkbox"], [role="radio"], [role="switch"], [role="tab"], [role="menuitem"], [tabindex]:not([tabindex="-1"])';
        let control: Element | null = at.closest(interactive);
        if (control === null) {
          const label = at.closest("label");
          control = label?.control ?? null;
        }
        const describe = (el: Element) =>
          `${el.tagName.toLowerCase()} "${(el.textContent ?? "").trim().slice(0, 40)}"`;
        if (control === null)
          return { point: p.name, ok: true, what: `text ${describe(at)}` };
        if (control.matches(same) || control.closest(same) !== null)
          return { point: p.name, ok: true, what: `same ${describe(control)}` };
        const disabled =
          (control as HTMLButtonElement).disabled === true ||
          control.getAttribute("aria-disabled") === "true" ||
          control.closest("[inert]") !== null;
        return {
          point: p.name,
          ok: disabled,
          what: `${disabled ? "disabled" : "ENABLED"} ${describe(control)}`,
        };
      }),
    { points, same },
  );
}

const dialogs = (page: Page) => page.getByRole("dialog").count();

interface Press {
  /** The control pressed (located again after the press: its replacement keeps the same marker). */
  control: Locator;
  same: string;
  /** Waits until the press has taken effect (its request sent, the editor opened). */
  pending(): Promise<void>;
  /** Requests that must exist after the second presses (nothing more is sent). */
  sent(): number;
  expectSent: number;
  /** Join and Save sharing: the control's top may move by at most 1 px. */
  steady: boolean;
}

/** Press 1 at the centre, then I1 at five points, then a real press at each of them; returns the sample of what was under them. */
async function pressTwice(page: Page, press: Press) {
  await expect(press.control).toBeEnabled();
  await press.control.scrollIntoViewIfNeeded();
  const before = await press.control.boundingBox();
  expect(before, "the control has a box before the press").not.toBeNull();
  const box = before as NonNullable<typeof before>;
  const points = pointsOf(box);
  const centre = points[0] as Point;
  const opened = await dialogs(page);
  expect(opened, "no dialog is open before the press").toBe(0);
  await page.mouse.click(centre.x, centre.y);
  await press.pending();
  await frames(page);
  const seen = await hits(page, points, press.same);
  expect(
    seen.filter((s) => !s.ok),
    `an enabled control came under the pointer: ${JSON.stringify(seen)}`,
  ).toEqual([]);
  if (press.steady) {
    const after = await press.control.boundingBox();
    expect(after, "the control has a box while pending").not.toBeNull();
    expect(
      Math.abs((after?.y ?? Number.NaN) - box.y),
      `the pressed control moved from ${box.y} to ${after?.y}`,
    ).toBeLessThanOrEqual(1);
  }
  for (const point of points) {
    await page.mouse.click(point.x, point.y);
    await frames(page);
    expect(
      await dialogs(page),
      `the second press at ${point.name} opened a dialog`,
    ).toBe(0);
  }
  expect(press.sent()).toBe(press.expectSent);
  return { box, seen };
}

/** Changes the chooser's OWN state after the parent's last render (the reserve must still be its height at the press). */
async function chooserState(w: World, state: State): Promise<void> {
  const ready = () =>
    expect(w.settings.locator('[data-membership="loading"]')).toHaveCount(0);
  if (state === "late") {
    w.households?.release();
    await ready();
    return;
  }
  await ready();
  if (state === "picker") {
    await w.settings
      .getByRole("button", { name: "+ Add household grant" })
      .click();
    await expect(w.settings.locator("[data-household-picker]")).toBeVisible();
  } else if (state === "lookup" || state === "refusal") {
    await w.settings
      .getByRole("button", { name: "+ Add account grant" })
      .click();
    await expect(w.settings.locator('[data-lookup="exact"]')).toBeVisible();
    if (state === "refusal") {
      // The policy already holds 100 grants: the chooser refuses this one and says why.
      await choose(w, "kim");
      await expect(w.settings).toContainText(
        "A policy can have at most 100 grants.",
      );
    }
  }
}

/** Chooses `username` through the open directory lookup's exact search (the lookup closes on a choice). */
async function choose(w: World, username: string): Promise<void> {
  await w.settings
    .getByRole("textbox", { name: "Exact username" })
    .fill(username);
  await w.settings.getByRole("button", { name: "Look up" }).click();
  await w.settings.getByRole("button", { name: `Choose: ${username}` }).click();
  await expect(w.settings.locator('[data-lookup="exact"]')).toHaveCount(0);
}

const joinEnrolment = {
  version: 1,
  active: false,
  aggregate_consent: true,
  policy: PRIVATE,
};
const enrolledEnrolment = {
  version: 2,
  active: true,
  aggregate_consent: true,
  policy: SHARED,
};

/** Opens the editor ("Change…") and makes an edit, so Save sharing is enabled (the parent's last render). */
async function editAudience(w: World): Promise<void> {
  await w.settings
    .getByRole("button", { name: "Change…", exact: true })
    .click();
  await w.settings.getByRole("button", { name: "Only me (private)" }).click();
}

const sentAfter = (w: World, n: number) => async () => {
  await expect.poll(() => w.calls.length).toBe(n);
};

interface Case {
  row: Row;
  state: State;
  layout: Layout;
  participation: Participation;
}

const CASES: Case[] = [];
for (const layout of ["natural", "spacer"] as const) {
  for (const row of ["join", "save"] as const) {
    for (const state of [
      "plain",
      "picker",
      "lookup",
      "late",
      "refusal",
    ] as const)
      CASES.push({ row, state, layout, participation: "everyone" });
    CASES.push({ row, state: "plain", layout, participation: "anyone" });
  }
  for (const row of ["leave", "consent", "change"] as const)
    for (const participation of ["everyone", "anyone"] as const)
      CASES.push({ row, state: "plain", layout, participation });
  for (const row of ["retry-join", "retry-save"] as const)
    CASES.push({ row, state: "plain", layout, participation: "everyone" });
}

test.describe("E-T46: a press in the enrolment panel brings no other enabled control under the pointer while it is pending (A15; WEB-13b revision 36, F43-1)", () => {
  for (const c of CASES)
    test(`${c.row} (${c.state}, ${c.participation}, ${c.layout} page): real presses at the centre and four corners reach nothing else`, async ({
      context,
    }) => {
      const enrolled =
        c.row === "save" ||
        c.row === "leave" ||
        c.row === "consent" ||
        c.row === "change" ||
        c.row === "retry-save";
      const w = await world(context, {
        n: 46,
        participation: c.participation,
        enrolment:
          c.state === "refusal"
            ? // Join: the last audience is already full. Save sharing: one grant short, so the edit that enables Save fills it.
              {
                ...(enrolled ? enrolledEnrolment : joinEnrolment),
                policy: grants(enrolled ? 99 : 100),
              }
            : enrolled
              ? enrolledEnrolment
              : joinEnrolment,
        lateHouseholds: c.state === "late",
      });
      const { page, settings } = w;
      if (c.layout === "spacer") await appendSpacer(page);
      try {
        let press: Press;
        if (c.row === "join") {
          await settings
            .getByRole("radio", { name: "Yes, include my contribution" })
            .check();
          await chooserState(w, c.state);
          press = {
            control: page.locator(SAME.join),
            same: SAME.join,
            pending: sentAfter(w, 1),
            sent: () => w.calls.length,
            expectSent: 1,
            steady: true,
          };
        } else if (c.row === "save") {
          if (c.state === "refusal") {
            // The parent's last render is the edit that fills the policy (the 100th grant); the refusal comes after it.
            await settings
              .getByRole("button", { name: "Change…", exact: true })
              .click();
            await expect(
              settings.locator('[data-membership="loading"]'),
            ).toHaveCount(0);
            await settings
              .getByRole("button", { name: "+ Add account grant" })
              .click();
            await choose(w, "jamie");
          } else await editAudience(w);
          await chooserState(w, c.state);
          press = {
            control: page.locator(SAME.save),
            same: SAME.save,
            pending: sentAfter(w, 1),
            sent: () => w.calls.length,
            expectSent: 1,
            steady: true,
          };
        } else if (c.row === "leave" || c.row === "consent") {
          await chooserState(w, "plain");
          press = {
            control: page.locator(SAME[c.row]).first(),
            same: SAME[c.row],
            pending: sentAfter(w, 1),
            sent: () => w.calls.length,
            expectSent: 1,
            steady: false,
          };
        } else if (c.row === "change") {
          await chooserState(w, "plain");
          press = {
            control: settings.getByRole("button", {
              name: "Change…",
              exact: true,
            }),
            same: SAME.change,
            pending: async () => {
              await expect(
                settings.getByRole("button", { name: "Save sharing" }),
              ).toBeVisible();
            },
            sent: () => w.calls.length,
            expectSent: 0,
            steady: false,
          };
        } else {
          // The first attempt has no answer (uncertain): Try again appears; the second is held.
          w.commands.script = ["abort", "hold"];
          if (c.row === "retry-join") {
            await settings
              .getByRole("radio", { name: "Yes, include my contribution" })
              .check();
            await chooserState(w, "plain");
            await page.locator(SAME.join).click();
          } else {
            await editAudience(w);
            await chooserState(w, "plain");
            await page.locator(SAME.save).click();
          }
          const retry = settings
            .locator("[data-enrolment-uncertain]")
            .getByRole("button", { name: "Try again" });
          await expect(retry).toBeEnabled({ timeout: 10_000 });
          press = {
            control: retry,
            same: SAME[c.row],
            pending: sentAfter(w, 2),
            sent: () => w.calls.length,
            expectSent: 2,
            steady: false,
          };
        }
        await pressTwice(page, press);
      } finally {
        w.households?.release();
        w.commands.held.release();
      }
    });
});

test.describe("E-T46b: the reserve through the attempt's schedule (A15; WEB-13b revision 36, F43-1; design assessment Q5)", () => {
  for (const row of ["join", "save"] as const) {
    const enrol = row === "join" ? joinEnrolment : enrolledEnrolment;
    const ready = async (w: World) => {
      if (row === "join")
        await w.settings
          .getByRole("radio", { name: "Yes, include my contribution" })
          .check();
      else await editAudience(w);
      await expect(
        w.settings.locator('[data-membership="loading"]'),
      ).toHaveCount(0);
      return w.page.locator(row === "join" ? SAME.join : SAME.save);
    };

    test(`${row}: answered, then the follow-up read held ("Checking…"): the control has not moved and the second presses reach nothing else`, async ({
      context,
    }) => {
      const w = await world(context, {
        n: 47,
        participation: "everyone",
        enrolment: enrol,
      });
      const control = await ready(w);
      const reads = hold();
      try {
        await control.scrollIntoViewIfNeeded();
        const box = await control.boundingBox();
        expect(box).not.toBeNull();
        const points = pointsOf(box as NonNullable<typeof box>);
        const centre = points[0] as Point;
        await w.page.mouse.click(centre.x, centre.y);
        await expect.poll(() => w.calls.length).toBe(1);
        // The answer arrives; the read asked after it is held, so the change stays blocked as "Checking…".
        const asked = w.reads.count;
        w.reads.hold = reads;
        w.commands.held.release();
        await expect.poll(() => w.reads.count).toBeGreaterThan(asked);
        await expect(w.settings).toContainText("Checking your settings…");
        await frames(w.page);
        const after = await control.boundingBox();
        expect(
          Math.abs((after?.y ?? Number.NaN) - (box?.y ?? Number.NaN)),
        ).toBeLessThanOrEqual(1);
        const seen = await hits(
          w.page,
          points,
          row === "join" ? SAME.join : SAME.save,
        );
        expect(
          seen.filter((s) => !s.ok),
          JSON.stringify(seen),
        ).toEqual([]);
        for (const point of points) {
          await w.page.mouse.click(point.x, point.y);
          await frames(w.page);
          expect(await dialogs(w.page)).toBe(0);
        }
        expect(w.calls).toHaveLength(1);
      } finally {
        reads.release();
        w.commands.held.release();
      }
    });

    for (const answer of [409, "abort"] as const)
      test(`${row}: ${answer === 409 ? "a definite refusal" : "no answer"} gives the chooser back where it was, with no jump of the control`, async ({
        context,
      }) => {
        const w = await world(context, {
          n: 48,
          participation: "everyone",
          enrolment: enrol,
        });
        w.commands.script = [answer];
        const control = await ready(w);
        await control.scrollIntoViewIfNeeded();
        const box = await control.boundingBox();
        expect(box).not.toBeNull();
        const audience = w.settings.locator("[data-held-height]");
        const height = await audience.evaluate(
          (el) => el.getBoundingClientRect().height,
        );
        await control.click();
        await expect.poll(() => w.calls.length).toBe(1);
        if (answer === 409)
          await expect(w.settings).toContainText(
            "This change wasn't accepted",
            {
              timeout: 10_000,
            },
          );
        else
          await expect(
            w.settings.locator("[data-enrolment-uncertain]"),
          ).toBeVisible({ timeout: 10_000 });
        await expect(control).toBeEnabled();
        await frames(w.page);
        // The block has ended: no reserve is left, and the chooser is its own height again, so the control is where it was.
        expect(
          await audience.evaluate((el) => (el as HTMLElement).style.minHeight),
        ).toBe("");
        expect(
          Math.abs(
            (await audience.evaluate(
              (el) => el.getBoundingClientRect().height,
            )) - height,
          ),
        ).toBeLessThanOrEqual(1);
        const after = await control.boundingBox();
        expect(
          Math.abs((after?.y ?? Number.NaN) - (box?.y ?? Number.NaN)),
        ).toBeLessThanOrEqual(1);
      });

    test(`${row}: resized while held, the reserve neither clips nor overlaps; released, it is gone`, async ({
      context,
    }) => {
      const w = await world(context, {
        n: 49,
        participation: "everyone",
        enrolment: enrol,
      });
      const control = await ready(w);
      try {
        await control.click();
        await expect.poll(() => w.calls.length).toBe(1);
        await w.page.setViewportSize({ width: 390, height: 844 });
        await frames(w.page);
        const audience = w.settings.locator("[data-held-height]");
        const layout = await audience.evaluate((el) => {
          const box = el.getBoundingClientRect();
          const content = el.firstElementChild?.getBoundingClientRect();
          return {
            bottom: box.bottom,
            contentBottom: content?.bottom ?? Number.NaN,
            minHeight: (el as HTMLElement).style.minHeight,
          };
        });
        expect(layout.minHeight).not.toBe("");
        // The content fits inside the reserve (nothing is clipped or drawn over what follows).
        expect(layout.contentBottom).toBeLessThanOrEqual(layout.bottom + 1);
        const controlBox = await control.boundingBox();
        expect(controlBox?.y ?? Number.NaN).toBeGreaterThanOrEqual(
          layout.bottom - 1,
        );
        // The read after the answer shows the change made (Join: enrolled at the next version).
        if (row === "join") w.enrolment.value = { ...enrolledEnrolment };
        w.commands.held.release();
        // Saved and confirmed (the block ends with the read after the answer): the form is replaced by the enrolled controls (Join) or
        // the editor closes (Save sharing), and no reserve is left anywhere in the panel.
        await expect(
          row === "join"
            ? w.settings.getByRole("button", { name: "Leave this task" })
            : w.settings.getByRole("button", { name: "Change…", exact: true }),
        ).toBeEnabled({ timeout: 10_000 });
        expect(
          await w.page.evaluate(
            () =>
              [
                ...document.querySelectorAll<HTMLElement>("[data-held-height]"),
              ].filter((el) => el.style.minHeight !== "").length,
          ),
        ).toBe(0);
      } finally {
        w.commands.held.release();
      }
    });
  }
});
