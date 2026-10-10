import { createHash } from "node:crypto";
import type { BrowserContext, Page } from "@playwright/test";
import {
  allWorkloads,
  denseChecklistPage,
} from "../../scripts/lib/profile-workloads.mjs";
import { protocolPlan } from "../../src/fixture/data-harness/profile-capture";
import { expect, test } from "./helpers";

/**
 * The device page's W2 route (`/profile-harness`, fixture only; review finding R3): the operator picks the capture file once, the page
 * keeps it on the origin, and every W2 run reads it back, hashes what it read, runs it through the production processing path and records
 * what it ran. These are the desktop CONTROLS of that exact path in Chromium, Firefox and WebKit, not measurements and not a device run.
 * The bytes are a STAND-IN: a 200-change dense checklist page from the workload generator, where an operator picks the hand-over's real W2
 * capture (the profiling programme's `device` stage runs the whole protocol with the released backend's capture;
 * docs/profiling-devices.md).
 *
 * Revision 2 (design assessment DA-1): the protocol's state is one envelope owned by the tab that started it. The cases below also hold
 * that another tab only reads (it neither runs, recovers nor clears), that an attempt interrupted by a reload is recorded once as killed
 * and the protocol goes on, and that a duplicate of the owning tab (same owner token) does not act while the owner's page lives.
 *
 * Revision 3 (review 3 R5; design assessment D1-D9): ONE collector per origin. Forced schedules (an engine start held inside a reserved
 * attempt, a held database listing) hold that a manual run is refused while a protocol's attempt is reserved (another tab, or a copy of
 * the owner's token) and a protocol start while a manual attempt runs or is left reserved; that of two tabs starting together exactly one
 * collects; that a page without Web Locks collects nothing; that a live owner cannot be taken over and a result whose reservation is gone
 * is not stored; that after a lost tab the new owner restores exactly the pinned capture (a different file, or another tab, changes
 * nothing) and the protocol goes on; that clear and delete serialise with collection; and that an illegal workload, run, unreadable
 * envelope or refused owner token starts nothing. A refused page shows ZERO profiling writes and ZERO engine starts. The long-lived
 * pages are pages of their own (WebKit's idle-page preload warning on this fixture route, F-1); their page errors are asserted absent.
 */
const STAND_IN = Buffer.from(denseChecklistPage(200));
const SHA = createHash("sha256").update(STAND_IN).digest("hex");
const NAME = "W2-captured.stand-in.limit-1.json";

interface Run {
  protocol_id: string;
  workload: string;
  run: number;
  expected: string;
  outcome: string;
  sha256: string;
  sha256_verified: boolean;
  source?: string;
  bytes: number;
  request_count: number;
}

/** Picks the capture on the page, as an operator does: the page reports what it kept. */
async function pick(page: Page): Promise<void> {
  await page.goto("/profile-harness");
  await page.setInputFiles("#w2-capture", {
    name: NAME,
    mimeType: "application/json",
    buffer: STAND_IN,
  });
  await expect(page.locator("#profile-status")).toHaveText(
    `W2 capture kept: ${NAME}, ${STAND_IN.length} bytes, SHA-256 ${SHA}`,
  );
}

type Collected = { protocol_id: string; runs: Run[] } | null;
const collected = (page: Page, which: "results" | "manual") =>
  page.evaluate(
    (w) =>
      (
        window as unknown as {
          __profile: Record<string, () => unknown>;
        }
      ).__profile[w]?.() as Collected,
    which,
  );

/**
 * The protocol reloads its own page between runs: a read waits for the lazily loaded page to have mounted, and one that lands on a
 * navigation is retried (only that error), never taken as "no results". Used by the cases that read a protocol while it runs.
 */
async function collectedWhileRunning(
  page: Page,
  which: "results" | "manual",
  { unreadable = "throw" }: { unreadable?: "throw" | "return" } = {},
) {
  for (let i = 0; i < 50; i += 1) {
    try {
      // The page module is lazy: until it has mounted (after every reload) there is nothing to read yet.
      await page.waitForFunction(
        () =>
          (window as unknown as { __profile?: unknown }).__profile !==
          undefined,
        undefined,
        { timeout: 30_000 },
      );
      const read = await collected(page, which);
      if (read && !Array.isArray(read.runs) && unreadable === "throw")
        throw new Error(
          `the stored collection is unreadable: ${JSON.stringify(read).slice(0, 200)}`,
        );
      return read;
    } catch (error) {
      if (!/Execution context was destroyed|navigat/i.test(String(error)))
        throw error;
      await page.waitForLoadState("domcontentloaded").catch(() => undefined);
    }
  }
  throw new Error("the page kept navigating for every read");
}

async function oneRun(page: Page, w2sha256: string): Promise<Run[]> {
  await page.goto(`/profile-harness?w=W2&run=1&w2sha256=${w2sha256}`);
  await expect(page.locator("#profile-status")).toContainText("W2 run 1:", {
    timeout: 120_000,
  });
  return (await collected(page, "manual"))?.runs ?? [];
}

/** Counts this page's writes to the profiling keys (a page that only reads makes none). */
const countWrites = (context: BrowserContext) =>
  context.addInitScript(() => {
    const w = window as unknown as { __profileWrites: number };
    w.__profileWrites = 0;
    const set = Storage.prototype.setItem;
    const remove = Storage.prototype.removeItem;
    Storage.prototype.setItem = function (key: string, value: string) {
      if (this === localStorage && key.startsWith("atlas-profile"))
        w.__profileWrites += 1;
      return set.call(this, key, value);
    };
    Storage.prototype.removeItem = function (key: string) {
      if (this === localStorage && key.startsWith("atlas-profile"))
        w.__profileWrites += 1;
      return remove.call(this, key);
    };
  });
const writesOf = (page: Page) =>
  page.evaluate(
    () => (window as unknown as { __profileWrites: number }).__profileWrites,
  );

test("control: the picked W2 capture is kept, read back, verified against the SHA-256 the URL names and run through the production path", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await pick(page);
  const runs = await oneRun(page, SHA);
  expect(runs).toHaveLength(1);
  expect(runs[0]?.protocol_id).toMatch(/^manual-/);
  expect(runs[0]).toMatchObject({
    workload: "W2",
    run: 1,
    expected: "admitted",
    outcome: "admitted",
    sha256: SHA,
    sha256_verified: true,
    source: NAME,
    bytes: STAND_IN.length,
    request_count: 1,
  });
  // Every link of the page keeps the capture: the protocol, and the next single run of W2.
  await expect(page.getByRole("link", { name: /W2 included/ })).toHaveAttribute(
    "href",
    `?protocol=1&w2sha256=${SHA}`,
  );
  await expect(
    page.getByRole("link", { name: "W2", exact: true }),
  ).toHaveAttribute("href", `?w=W2&run=2&w2sha256=${SHA}`);
});

test("case: bytes that are not the named capture are recorded with their own hash, NOT verified, and NOT run (an error run)", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await pick(page);
  const runs = await oneRun(page, "0".repeat(64));
  expect(runs).toHaveLength(1);
  expect(runs[0]).toMatchObject({
    workload: "W2",
    outcome: "error",
    sha256: SHA,
    sha256_verified: false,
    request_count: 0,
  });
});

test("case: a W2 run with no capture kept is an error run, and nothing stands in for the capture", async ({
  page,
}) => {
  const runs = await oneRun(page, SHA);
  expect(runs).toHaveLength(1);
  expect(runs[0]).toMatchObject({
    workload: "W2",
    outcome: "error",
    sha256: "",
    sha256_verified: false,
    bytes: 0,
    request_count: 0,
  });
});

test("case: without a named capture the protocol has no W2, and the page says so", async ({
  page,
}) => {
  await page.goto("/profile-harness");
  await expect(
    page.getByRole("link", { name: /NO W2: choose the capture/ }),
  ).toHaveAttribute("href", "?protocol=1");
  await expect(page.getByRole("link", { name: "W2", exact: true })).toHaveCount(
    0,
  );
});

test("case: another tab, a plain menu page or the protocol URL, only reads the active protocol: it neither runs, recovers nor clears", async ({
  context,
  page,
}) => {
  test.setTimeout(180_000);
  await countWrites(context);
  await page.goto("/profile-harness?protocol=1");
  await expect(page.locator("#profile-status")).toContainText(
    "Running W1 (run 1)",
    {
      timeout: 60_000,
    },
  );
  const other = await context.newPage();
  for (const path of ["/profile-harness", "/profile-harness?protocol=1"]) {
    await other.goto(path);
    await expect(other.locator("#profile-ownership")).toContainText(
      "is owned by another tab",
    );
    if (path.includes("protocol"))
      await expect(other.locator("#profile-status")).toContainText(
        "belongs to another tab: this page does not run, recover or change it",
      );
    await other.locator("#profile-clear").click();
    await expect(other.locator("#profile-status")).toContainText(
      "Refused: another tab owns the active collection",
    );
    await other.locator("#profile-delete-databases").click();
    await expect(other.locator("#profile-status")).toContainText("Refused:");
    expect(await writesOf(other)).toBe(0);
  }
  const owned = await collected(page, "results");
  expect(owned?.protocol_id).toBeTruthy();
});

test("case: an attempt left reserved by a killed page is recorded once, as killed, by the owner's next load, and the protocol goes on", async ({
  page,
}) => {
  test.setTimeout(240_000);
  // The exact state a page killed mid-attempt leaves (the deterministic schedule): this tab's protocol, W1 run 1 reserved, nothing stored.
  await page.goto("/profile-harness");
  // The page is lazy-loaded: its owner token exists once it has mounted (seeding before that would name no owner).
  await page.waitForFunction(
    () => sessionStorage.getItem("atlas-profile-owner") !== null,
  );
  const token = await page.evaluate(() =>
    sessionStorage.getItem("atlas-profile-owner"),
  );
  expect(token).toMatch(/^[0-9a-f-]{36}$/);
  const plan = protocolPlan(
    allWorkloads().map((w) => w.name),
    (name) => (["W1", "W3", "W4", "W6"].includes(name) ? 5 : 1),
    false,
  );
  await page.evaluate(
    ([owner, attempts]) =>
      localStorage.setItem(
        "atlas-profile-protocol",
        JSON.stringify({
          schema: 2,
          kind: "protocol",
          protocol_id: "seeded",
          owner,
          workload_version: 1,
          w2sha256: null,
          plan: attempts,
          created_at: "t0",
          recorded_at: "t0",
          machine: {},
          next: 0,
          reserved: { name: "W1", run: 1, index: 0, at: "t0", page: "killed" },
          runs: [],
          terminal: null,
          error: null,
          takeovers: [],
        }),
      ),
    [token, plan] as const,
  );
  await page.goto("/profile-harness?protocol=1");
  // Revision 3: every read is ASSERTED readable (a recovery that leaves an inconsistent envelope fails here, by an assertion, at once);
  // the wait for two recorded attempts is bounded well inside the test's time-out.
  let runs: Run[] = [];
  for (const deadline = Date.now() + 180_000; Date.now() < deadline; ) {
    const read = await collectedWhileRunning(page, "results", {
      unreadable: "return",
    });
    // The unreadable state itself is the received value (the report shows it under the standard expect() header).
    expect(
      read === null || Array.isArray(read.runs)
        ? "readable"
        : `the stored collection is unreadable: ${JSON.stringify(read).slice(0, 200)}`,
    ).toBe("readable");
    runs = read?.runs ?? [];
    if (runs.length >= 2) break;
    await page.waitForTimeout(100);
  }
  expect(runs.length).toBeGreaterThanOrEqual(2);
  const [first, second] = runs;
  expect(first).toMatchObject({
    protocol_id: "seeded",
    workload: "W1",
    run: 1,
    outcome: "killed",
  });
  expect(second).toMatchObject({
    protocol_id: "seeded",
    workload: "W1",
    run: 2,
  });
  expect(second?.outcome).not.toBe("killed");
});

test("case: a REAL reload during the protocol, whenever it lands, leaves every attempt recorded once, in plan order, none skipped", async ({
  page,
}) => {
  test.setTimeout(240_000);
  await page.goto("/profile-harness?protocol=1");
  await expect(page.locator("#profile-status")).toContainText(
    "Running W1 (run 1)",
    {
      timeout: 60_000,
    },
  );
  await page.reload();
  await expect
    .poll(
      async () =>
        (await collectedWhileRunning(page, "results"))?.runs.length ?? 0,
      {
        timeout: 180_000,
      },
    )
    .toBeGreaterThanOrEqual(3);
  const results = await collectedWhileRunning(page, "results");
  const keys = (results?.runs ?? []).map((r) => `${r.workload}#${r.run}`);
  expect(keys.slice(0, 3)).toEqual(["W1#1", "W1#2", "W1#3"]);
  expect(new Set(keys).size).toBe(keys.length);
  const killed = (results?.runs ?? []).filter((r) => r.outcome === "killed");
  expect(killed.length).toBeLessThanOrEqual(1);
  if (killed[0]) expect(killed[0]).toMatchObject({ workload: "W1", run: 1 });
  expect(new Set(results?.runs.map((r) => r.protocol_id))).toEqual(
    new Set([results?.protocol_id]),
  );
});

test("case: a duplicate of the owning tab (the same owner token) does not act while the owner's page lives", async ({
  context,
}) => {
  test.setTimeout(180_000);
  // The owner must stay open for several seconds while the duplicate waits for the page lock. WebKit then logs a console warning on
  // ANY idle /profile-harness page ("…fixture-*.js was preloaded using link preload but not used within a few seconds"; it reproduces
  // on the committed base build too and never on /today: the fixture route's own preload behaviour, unrelated to this case). The
  // owner is therefore a page of its own, as the device-stage case's is, and the warning is reported in the execution report.
  const page = await context.newPage();
  await page.goto("/profile-harness?w=W3&run=1");
  await expect(page.locator("#profile-status")).toContainText("W3 run 1:", {
    timeout: 120_000,
  });
  const token = await page.evaluate(() =>
    sessionStorage.getItem("atlas-profile-owner"),
  );
  const duplicate = await context.newPage();
  await duplicate.addInitScript((t) => {
    sessionStorage.setItem("atlas-profile-owner", t as string);
  }, token);
  await duplicate.goto("/profile-harness?w=W3&run=2");
  await expect(duplicate.locator("#profile-status")).toContainText(
    "another live page is collecting on this origin",
    { timeout: 30_000 },
  );
  const manual = await collected(duplicate, "manual");
  expect(manual?.runs.map((r) => `${r.workload}#${r.run}`)).toEqual(["W3#1"]);
});

// ---- revision 3: one collector per origin (review 3 R5; design assessment D1-D9) ------------------------------------------------------
interface Probe {
  __profileWrites: number;
  __engineStarts: number;
  __held?: boolean;
  __release?: () => void;
  __listHeld?: boolean;
  __releaseList?: () => void;
}
/**
 * Instruments ONE page (and its reloads): its profiling writes and its engine starts are counted; with `hold`, every engine start waits
 * for `__release()` (the page then sits inside its reserved attempt, before any work); with `holdList`, the database listing a deletion
 * starts with waits for `__releaseList()`. Page errors are collected for the case's final check.
 */
async function instrument(
  page: Page,
  options: { hold?: boolean; holdList?: boolean } = {},
): Promise<string[]> {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript((o) => {
    const w = window as unknown as Probe;
    w.__profileWrites = 0;
    w.__engineStarts = 0;
    const set = Storage.prototype.setItem;
    const remove = Storage.prototype.removeItem;
    Storage.prototype.setItem = function (key: string, value: string) {
      if (this === localStorage && key.startsWith("atlas-profile"))
        w.__profileWrites += 1;
      return set.call(this, key, value);
    };
    Storage.prototype.removeItem = function (key: string) {
      if (this === localStorage && key.startsWith("atlas-profile"))
        w.__profileWrites += 1;
      return remove.call(this, key);
    };
    Object.defineProperty(window, "__atlasData", {
      configurable: true,
      set(data: {
        startSyncLocal: (...a: unknown[]) => Promise<unknown>;
        list: () => Promise<string[]>;
      }) {
        Object.defineProperty(window, "__atlasData", {
          value: data,
          configurable: true,
          writable: true,
        });
        const start = data.startSyncLocal.bind(data);
        data.startSyncLocal = async (...args: unknown[]) => {
          w.__engineStarts += 1;
          if (o.hold) {
            w.__held = true;
            await new Promise<void>((resolve) => {
              w.__release = resolve;
            });
          }
          return start(...args);
        };
        const list = data.list.bind(data);
        data.list = async () => {
          if (o.holdList) {
            w.__listHeld = true;
            await new Promise<void>((resolve) => {
              w.__releaseList = resolve;
            });
          }
          return list();
        };
      },
    });
  }, options);
  return errors;
}
const counters = (page: Page) =>
  page.evaluate(() => {
    const w = window as unknown as Probe;
    return { writes: w.__profileWrites, engineStarts: w.__engineStarts };
  });
/** The page module has mounted and settled (`__profile.done`); a page held inside its attempt never gets there. */
const settled = (page: Page, timeout = 60_000) =>
  page.waitForFunction(
    () =>
      (window as unknown as { __profile?: { done: boolean } }).__profile
        ?.done === true,
    undefined,
    { timeout },
  );
const heldInsideAttempt = (page: Page) =>
  page.waitForFunction(
    () => (window as unknown as Probe).__held === true,
    undefined,
    { timeout: 60_000 },
  );
const release = (page: Page) =>
  page.evaluate(() => (window as unknown as Probe).__release?.());
/** Both collections exactly as stored (raw text), read without writing. */
const stored = (page: Page) =>
  page.evaluate(() => ({
    protocol: localStorage.getItem("atlas-profile-protocol"),
    manual: localStorage.getItem("atlas-profile-manual"),
  }));
const tokenOf = (page: Page) =>
  page.evaluate(() => sessionStorage.getItem("atlas-profile-owner"));
const keptCapture = (page: Page) =>
  page.evaluate(() => sessionStorage.getItem("atlas-profile-w2-capture"));
/** A reader on the menu (it writes nothing): where a case reads storage while a collecting page reloads itself. */
async function reader(context: BrowserContext): Promise<Page> {
  const page = await context.newPage();
  await page.goto("/profile-harness");
  await settled(page);
  return page;
}
const OTHER = Buffer.from(denseChecklistPage(100));
async function pickOn(page: Page, buffer: Buffer, name = NAME) {
  await page.setInputFiles("#w2-capture", {
    name,
    mimeType: "application/json",
    buffer,
  });
}
/** A run record as the page stores one (the earlier attempts of a seeded protocol). */
const storedRun = (workload: string, run: number, protocolId: string) => ({
  protocol_id: protocolId,
  workload,
  run,
  cold: true,
  expected: "admitted",
  outcome: "admitted",
  detail: "seeded earlier attempt",
  sha256: "1".repeat(64),
  sha256_verified: true,
  bytes: 1,
  elapsed_ms: 1,
  scan_ms: 1,
  commit_ms: 1,
  request_count: 1,
  limit: 1,
  changes_written: 1,
  cursor_after: "c",
  heap_baseline_bytes: null,
  heap_peak_bytes: null,
  heap_after_bytes: null,
  user_agent: "seeded",
  at: "t0",
});
/** Seeds the protocol a lost tab leaves between attempts (or with an outstanding reservation), owned by `owner`. */
const seedProtocol = (
  page: Page,
  envelope: Record<string, unknown>,
): Promise<void> =>
  page.evaluate((e) => {
    localStorage.setItem(
      "atlas-profile-protocol",
      JSON.stringify({
        schema: 2,
        kind: "protocol",
        workload_version: 1,
        created_at: "t0",
        recorded_at: "t0",
        machine: {},
        terminal: null,
        error: null,
        takeovers: [],
        ...e,
      }),
    );
  }, envelope);

test("case: while a protocol's attempt is reserved, a manual run in another tab, or in a copy of the owner's tab, runs nothing and writes nothing; the owner's own result is then stored", async ({
  context,
}) => {
  test.setTimeout(240_000);
  const owner = await context.newPage();
  const errors = await instrument(owner, { hold: true });
  await owner.goto("/profile-harness?protocol=1");
  await heldInsideAttempt(owner);
  const before = await stored(owner);
  expect(JSON.parse(before.protocol ?? "null")?.reserved).toMatchObject({
    name: "W1",
    run: 1,
  });
  const token = await tokenOf(owner);
  for (const copy of [false, true]) {
    const other = await context.newPage();
    if (copy)
      await other.addInitScript((t) => {
        sessionStorage.setItem("atlas-profile-owner", t as string);
      }, token);
    errors.push(...(await instrument(other)));
    // An engine workload and a processing-only one (W5 starts no engine, so its refusal is the collector rule, not the engine's).
    for (const url of [
      "/profile-harness?w=W3&run=1",
      "/profile-harness?w=W5-limit-1&run=1",
    ]) {
      await other.goto(url);
      await settled(other);
      await expect(other.locator("#profile-status")).toContainText(
        "is active on this origin: a manual run is refused",
      );
      expect(await counters(other), `${url}, copied token ${copy}`).toEqual({
        writes: 0,
        engineStarts: 0,
      });
    }
    expect(await stored(other)).toEqual(before);
    await other.close();
  }
  // Control: the owner's own attempt, let go, is stored into its reservation (its next attempt is then held again).
  const look = await reader(context);
  await release(owner);
  await expect
    .poll(
      async () =>
        JSON.parse((await stored(look)).protocol ?? "null")?.runs?.length ?? 0,
      { timeout: 120_000 },
    )
    .toBe(1);
  const after = JSON.parse((await stored(look)).protocol ?? "null");
  expect(after.runs[0]).toMatchObject({ workload: "W1", run: 1 });
  expect(after.runs[0].outcome).not.toBe("killed");
  expect((await stored(look)).manual).toBeNull();
  expect(errors).toEqual([]);
});

test("case: a manual attempt in progress keeps a protocol from starting in another tab, and one left reserved by a closed tab does too until it is recorded", async ({
  context,
}) => {
  test.setTimeout(240_000);
  const manual = await context.newPage();
  const errors = await instrument(manual, { hold: true });
  await manual.goto("/profile-harness?w=W3&run=1");
  await heldInsideAttempt(manual);
  const other = await context.newPage();
  errors.push(...(await instrument(other)));
  await other.goto("/profile-harness?protocol=1");
  await settled(other);
  await expect(other.locator("#profile-status")).toContainText(
    "another live page is collecting on this origin",
  );
  expect(await counters(other)).toEqual({ writes: 0, engineStarts: 0 });
  expect((await stored(other)).protocol).toBeNull();
  // Control: the manual run, let go, is recorded.
  await release(manual);
  await expect(manual.locator("#profile-status")).toContainText("W3 run 1:", {
    timeout: 120_000,
  });
  await manual.close();
  // The state a manual page killed inside its attempt leaves: its next attempt reserved, nothing stored for it.
  await other.evaluate(() => {
    const e = JSON.parse(localStorage.getItem("atlas-profile-manual") ?? "{}");
    e.reserved = { name: "W3", run: 2, index: 1, at: "t9", page: "closed" };
    localStorage.setItem("atlas-profile-manual", JSON.stringify(e));
  });
  const seeded = await stored(other);
  await other.goto("/profile-harness?protocol=1");
  await settled(other);
  await expect(other.locator("#profile-status")).toContainText(
    "a manual attempt (W3 run 2) is reserved",
  );
  expect(await counters(other)).toEqual({ writes: 0, engineStarts: 0 });
  expect(await stored(other)).toEqual(seeded);
  expect(errors).toEqual([]);
});

test("case: two tabs starting at the same moment (protocol and protocol, manual and manual, protocol and manual): exactly one collects, the other writes nothing", async ({
  context,
}) => {
  test.setTimeout(300_000);
  const errors: string[] = [];
  for (const [first, second] of [
    ["?protocol=1", "?protocol=1"],
    ["?w=W3&run=1", "?w=W4&run=1"],
    ["?protocol=1", "?w=W3&run=1"],
  ] as const) {
    const pages = [await context.newPage(), await context.newPage()];
    for (const p of pages)
      errors.push(...(await instrument(p, { hold: true })));
    await Promise.all([
      pages[0]?.goto(`/profile-harness${first}`),
      pages[1]?.goto(`/profile-harness${second}`),
    ]);
    const held = async () =>
      Promise.all(
        pages.map((p) =>
          p.evaluate(() => (window as unknown as Probe).__held === true),
        ),
      );
    await expect.poll(async () => (await held()).some(Boolean)).toBe(true);
    // The loser settles (refused); the winner stays inside its attempt.
    await expect
      .poll(
        async () =>
          (
            await Promise.all(
              pages.map((p) =>
                p.evaluate(
                  () =>
                    (window as unknown as { __profile?: { done: boolean } })
                      .__profile?.done === true,
                ),
              ),
            )
          ).some(Boolean),
        { timeout: 30_000 },
      )
      .toBe(true);
    const flags = await held();
    expect(flags.filter(Boolean), `${first} / ${second}`).toHaveLength(1);
    const winner = pages[flags.indexOf(true)] as Page;
    const loser = pages[flags.indexOf(false)] as Page;
    await expect(loser.locator("#profile-status")).toContainText(
      /another live page is collecting on this origin|belongs to another tab|is active on this origin/,
    );
    expect(await counters(loser)).toEqual({ writes: 0, engineStarts: 0 });
    const now = await stored(winner);
    const mine = await tokenOf(winner);
    const winnerUrl = flags[0] ? first : second;
    if (winnerUrl.includes("protocol")) {
      expect(JSON.parse(now.protocol ?? "null")?.owner).toBe(mine);
      expect(now.manual).toBeNull();
    } else {
      expect(JSON.parse(now.manual ?? "null")?.owner).toBe(mine);
      expect(now.protocol).toBeNull();
    }
    for (const p of pages) await p.close();
    const clean = await context.newPage();
    await clean.goto("/profile-harness");
    await clean.evaluate(() => localStorage.clear());
    await clean.close();
  }
  expect(errors).toEqual([]);
});

test("case: a page without Web Locks collects nothing and changes nothing (exclusion cannot be established, so it is never assumed)", async ({
  context,
}) => {
  const page = await context.newPage();
  const errors = await instrument(page);
  await page.addInitScript(() => {
    Object.defineProperty(Navigator.prototype, "locks", {
      configurable: true,
      get: () => undefined,
    });
  });
  for (const url of [
    "/profile-harness?w=W3&run=1",
    "/profile-harness?protocol=1",
  ]) {
    await page.goto(url);
    await settled(page);
    await expect(page.locator("#profile-status")).toContainText(
      "this browser has no Web Locks",
    );
    expect(await counters(page)).toEqual({ writes: 0, engineStarts: 0 });
  }
  await page.locator("#profile-clear").click();
  await expect(page.locator("#profile-status")).toContainText(
    "Refused: this browser has no Web Locks",
  );
  expect(await stored(page)).toEqual({ protocol: null, manual: null });
  expect(errors).toEqual([]);
});

test("case: a live owner cannot be taken over, and a result whose reservation is gone when its run ends (taken over, or cleared) is not stored", async ({
  context,
}) => {
  test.setTimeout(240_000);
  const errors: string[] = [];
  for (const meanwhile of ["taken over", "cleared"] as const) {
    const owner = await context.newPage();
    errors.push(...(await instrument(owner, { hold: true })));
    await owner.goto("/profile-harness?protocol=1");
    await heldInsideAttempt(owner);
    const other = await context.newPage();
    errors.push(...(await instrument(other)));
    await other.goto("/profile-harness");
    await settled(other);
    const before = await stored(other);
    await other.locator("#profile-take-over").click();
    await expect(other.locator("#profile-status")).toContainText(
      "Not taken over: a live page is collecting on this origin",
    );
    expect(await stored(other)).toEqual(before);
    // The continuation is then invalidated behind the guard's back (a TEST adapter writes storage directly), and the run let go.
    await other.evaluate((what) => {
      if (what === "cleared") {
        localStorage.removeItem("atlas-profile-protocol");
        return;
      }
      const e = JSON.parse(
        localStorage.getItem("atlas-profile-protocol") ?? "{}",
      );
      e.takeovers = [{ at: "t9", from: e.owner, to: "intruder" }];
      e.owner = "intruder";
      localStorage.setItem("atlas-profile-protocol", JSON.stringify(e));
    }, meanwhile);
    const invalidated = await stored(other);
    await release(owner);
    await expect(owner.locator("#profile-status")).toContainText(
      meanwhile === "cleared"
        ? "was NOT stored: the collection is no longer stored (cleared)"
        : "was NOT stored: its owner changed (a take-over)",
      { timeout: 120_000 },
    );
    expect(await stored(other)).toEqual(invalidated);
    expect(
      await owner.evaluate(
        () =>
          (
            window as unknown as { __profile: { stale: () => unknown[] } }
          ).__profile.stale().length,
      ),
    ).toBe(1);
    await owner.close();
    await other.evaluate(() => localStorage.clear());
    await other.close();
  }
  expect(errors).toEqual([]);
});

test("case: after a lost tab, the take-over restores exactly the collection's own capture: another tab or another file changes nothing, and the next W2 attempt runs those bytes", async ({
  context,
}) => {
  test.setTimeout(240_000);
  const lost = await context.newPage();
  const errors = await instrument(lost);
  await lost.goto("/profile-harness");
  await settled(lost);
  await pickOn(lost, STAND_IN);
  await expect(lost.locator("#profile-status")).toHaveText(
    `W2 capture kept: ${NAME}, ${STAND_IN.length} bytes, SHA-256 ${SHA}`,
  );
  const lostToken = await tokenOf(lost);
  const earlier = storedRun("W1", 1, "lost-tab");
  await seedProtocol(lost, {
    protocol_id: "lost-tab",
    owner: lostToken,
    w2sha256: SHA,
    plan: [
      { name: "W1", run: 1 },
      { name: "W2", run: 1 },
    ],
    next: 1,
    reserved: null,
    runs: [earlier],
  });
  await lost.close();
  const next = await context.newPage();
  errors.push(...(await instrument(next)));
  await next.goto("/profile-harness");
  await settled(next);
  const seeded = await stored(next);
  // Before any take-over this tab is foreign: its identical file restores nothing.
  await pickOn(next, STAND_IN);
  await expect(next.locator("#profile-status")).toContainText(
    "NOT replaced: another tab owns the active collection",
  );
  expect(await keptCapture(next)).toBeNull();
  await next.locator("#profile-take-over").click();
  await expect(next.locator("#profile-status")).toContainText(
    `now owns collection lost-tab (recorded). Its W2 capture was kept only in the lost tab: choose the same file again (SHA-256 ${SHA})`,
  );
  const takenOver = await stored(next);
  // Another file is refused, the capture pinned at the start never changes.
  await pickOn(next, OTHER, "other.json");
  await expect(next.locator("#profile-status")).toContainText(
    "NOT replaced: a collection is active, and its capture never changes",
  );
  expect(await keptCapture(next)).toBeNull();
  // The identical file is restored, and the stored collection is untouched by it.
  await pickOn(next, STAND_IN);
  await expect(next.locator("#profile-status")).toContainText(
    `W2 capture restored for collection lost-tab: ${NAME}, ${STAND_IN.length} bytes, SHA-256 ${SHA}`,
  );
  expect(await stored(next)).toEqual(takenOver);
  expect(await counters(next)).toEqual({ writes: 1, engineStarts: 0 });
  await next.goto(`/profile-harness?protocol=1&w2sha256=${SHA}`);
  await expect
    .poll(
      async () =>
        (await collectedWhileRunning(next, "results"))?.runs.length ?? 0,
      { timeout: 180_000 },
    )
    .toBe(2);
  const results = (await next.evaluate(() =>
    (
      window as unknown as { __profile: { results: () => unknown } }
    ).__profile.results(),
  )) as {
    protocol_id: string;
    takeovers: Array<{ from: string; to: string }>;
    runs: Run[];
  };
  expect(results.protocol_id).toBe("lost-tab");
  expect(results.runs[0]).toEqual(earlier);
  expect(results.runs[1]).toMatchObject({
    protocol_id: "lost-tab",
    workload: "W2",
    run: 1,
    outcome: "admitted",
    sha256: SHA,
    sha256_verified: true,
    source: NAME,
    request_count: 1,
  });
  expect(results.takeovers).toEqual([
    expect.objectContaining({ from: lostToken, to: await tokenOf(next) }),
  ]);
  expect(JSON.parse(seeded.protocol ?? "null").takeovers).toEqual([]);
  expect(errors).toEqual([]);
});

test("case: a lost tab's outstanding W2 reservation is recorded once as killed under the new owner, then the restored capture runs the next attempt", async ({
  context,
}) => {
  test.setTimeout(240_000);
  const lost = await context.newPage();
  const errors = await instrument(lost);
  await lost.goto("/profile-harness");
  await settled(lost);
  await seedProtocol(lost, {
    protocol_id: "lost-reserved",
    owner: await tokenOf(lost),
    w2sha256: SHA,
    plan: [
      { name: "W2", run: 1 },
      { name: "W2", run: 2 },
    ],
    next: 0,
    reserved: { name: "W2", run: 1, index: 0, at: "t1", page: "lost" },
    runs: [],
  });
  await lost.close();
  const next = await context.newPage();
  errors.push(...(await instrument(next)));
  await next.goto("/profile-harness");
  await settled(next);
  await next.locator("#profile-take-over").click();
  await expect(next.locator("#profile-status")).toContainText(
    "now owns collection lost-reserved (recorded)",
  );
  await pickOn(next, STAND_IN);
  await expect(next.locator("#profile-status")).toContainText(
    "W2 capture restored for collection lost-reserved",
  );
  await next.goto(`/profile-harness?protocol=1&w2sha256=${SHA}`);
  await expect
    .poll(
      async () =>
        (await collectedWhileRunning(next, "results"))?.runs.length ?? 0,
      { timeout: 180_000 },
    )
    .toBe(2);
  const runs = (await collectedWhileRunning(next, "results"))?.runs ?? [];
  expect(runs.map((r) => [r.workload, r.run, r.outcome])).toEqual([
    ["W2", 1, "killed"],
    ["W2", 2, "admitted"],
  ]);
  expect(runs[1]).toMatchObject({ sha256: SHA, sha256_verified: true });
  expect(errors).toEqual([]);
});

test("case: clear and delete serialise with collection: refused for another tab's collection, allowed to its idle owner, and a deletion in progress keeps a new collector out", async ({
  context,
}) => {
  test.setTimeout(240_000);
  const owner = await context.newPage();
  const errors = await instrument(owner);
  await owner.goto("/profile-harness?w=W3&run=1");
  await expect(owner.locator("#profile-status")).toContainText("W3 run 1:", {
    timeout: 120_000,
  });
  const other = await context.newPage();
  errors.push(...(await instrument(other)));
  await other.goto("/profile-harness");
  await settled(other);
  const before = await stored(other);
  await other.locator("#profile-clear").click();
  await expect(other.locator("#profile-status")).toContainText(
    "Refused: another tab owns the active collection",
  );
  expect(await counters(other)).toEqual({ writes: 0, engineStarts: 0 });
  expect(await stored(other)).toEqual(before);
  // The idle owner clears its own collection, on its own (collecting) page.
  await owner.locator("#profile-clear").click();
  await expect(owner.locator("#profile-status")).toHaveText("Results cleared.");
  expect(await stored(owner)).toEqual({ protocol: null, manual: null });
  await owner.close();
  // A deletion holds the guard through its listing and deletions: a collector arriving meanwhile is refused, writing nothing.
  const cleaner = await context.newPage();
  errors.push(...(await instrument(cleaner, { holdList: true })));
  await cleaner.goto("/profile-harness");
  await settled(cleaner);
  await cleaner.locator("#profile-delete-databases").click();
  await cleaner.waitForFunction(
    () => (window as unknown as Probe).__listHeld === true,
  );
  const arriving = await context.newPage();
  errors.push(...(await instrument(arriving)));
  await arriving.goto("/profile-harness?w=W3&run=1");
  await settled(arriving);
  await expect(arriving.locator("#profile-status")).toContainText(
    "another live page is collecting on this origin",
  );
  expect(await counters(arriving)).toEqual({ writes: 0, engineStarts: 0 });
  await cleaner.evaluate(() => (window as unknown as Probe).__releaseList?.());
  await expect(cleaner.locator("#profile-status")).toContainText(
    /^Deleted \d+ profiling database\(s\)\.$/,
  );
  expect(errors).toEqual([]);
});

test("case: an unknown workload, a run that is not a run number, an unreadable envelope and a refused owner token start nothing and change nothing", async ({
  context,
}) => {
  const page = await context.newPage();
  const errors = await instrument(page);
  for (const [url, text] of [
    ["/profile-harness?w=W99&run=1", '"W99" is not a workload of this page'],
    ["/profile-harness?w=W3&run=0", 'run "0" is not a run number'],
    ["/profile-harness?w=W3&run=abc", 'run "abc" is not a run number'],
  ] as const) {
    await page.goto(url);
    await settled(page);
    await expect(page.locator("#profile-status")).toContainText(text);
    expect(await counters(page), url).toEqual({ writes: 0, engineStarts: 0 });
  }
  await page.evaluate(() =>
    localStorage.setItem("atlas-profile-manual", '{"schema":2,"torn'),
  );
  for (const url of [
    "/profile-harness?w=W3&run=1",
    "/profile-harness?protocol=1",
  ]) {
    await page.goto(url);
    await settled(page);
    await expect(page.locator("#profile-status")).toContainText(
      "the stored manual collection is unreadable",
    );
    expect(await counters(page), url).toEqual({ writes: 0, engineStarts: 0 });
    expect((await stored(page)).manual).toBe('{"schema":2,"torn');
  }
  const refused = await context.newPage();
  errors.push(...(await instrument(refused)));
  await refused.addInitScript(() => {
    const set = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key: string, value: string) {
      if (this === sessionStorage && key === "atlas-profile-owner")
        throw new DOMException("denied", "SecurityError");
      return set.call(this, key, value);
    };
  });
  await refused.goto("/profile-harness?w=W3&run=1");
  await settled(refused);
  await expect(refused.locator("#profile-status")).toContainText(
    "this tab's owner token cannot be kept in sessionStorage",
  );
  expect(await counters(refused)).toEqual({ writes: 0, engineStarts: 0 });
  expect(errors).toEqual([]);
});
