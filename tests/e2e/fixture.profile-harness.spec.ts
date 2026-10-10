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
async function collectedWhileRunning(page: Page, which: "results" | "manual") {
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
      if (read && !Array.isArray(read.runs))
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
  await expect
    .poll(
      async () =>
        (await collectedWhileRunning(page, "results"))?.runs.length ?? 0,
      {
        timeout: 180_000,
      },
    )
    .toBeGreaterThanOrEqual(2);
  const [first, second] =
    (await collectedWhileRunning(page, "results"))?.runs ?? [];
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
    "another live page of this tab's collection holds it",
    { timeout: 30_000 },
  );
  const manual = await collected(duplicate, "manual");
  expect(manual?.runs.map((r) => `${r.workload}#${r.run}`)).toEqual(["W3#1"]);
});
