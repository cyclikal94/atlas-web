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
/** The page's own reading. A document whose lazily loaded page has not mounted yet says so by name (revision 5), never as "no results". */
const NOT_MOUNTED = "the profile page has not mounted in this document";
const collected = (page: Page, which: "results" | "manual") =>
  page.evaluate(
    ({ w, notMounted }) => {
      const profile = (
        window as unknown as {
          __profile?: Record<string, () => unknown>;
        }
      ).__profile;
      if (profile === undefined) throw new Error(notMounted);
      return profile[w]?.() as Collected;
    },
    { w: which, notMounted: NOT_MOUNTED },
  );

/**
 * The protocol reloads its own page between runs: a read waits for the lazily loaded page to have mounted, and one that lands on a
 * navigation is retried (only that error), never taken as "no results". Used by the cases that read a protocol while it runs.
 * Revision 5 (harness, found by the pool's Chromium run of request-b4721ac119d44b39a381): the wait can see the OLD document mounted and
 * the read then run in the new one before its page mounts; that read is retried too (`NOT_MOUNTED`), as a navigation is.
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
      if (
        !/Execution context was destroyed|navigat/i.test(String(error)) &&
        !String(error).includes(NOT_MOUNTED)
      )
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
  // The owner's protocol is still running (it reloads its page between runs): read it as a running protocol is read (revision 5).
  const owned = await collectedWhileRunning(page, "results");
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
  // Revision 4 (review 4 R5; design assessment Q-M3, Q-M6, Q-F1-Q-F4): forced schedules and labelled fault injections.
  __lockHeld?: boolean;
  __releaseLock?: () => void;
  __holdNextDigest?: boolean;
  __digestHeld?: boolean;
  __releaseDigest?: () => void;
  __stops: number;
  __stopsAtResultWrites: number[];
  __failCaptureWrite?: boolean;
  __alterCaptureRead?: boolean;
  __failRemove?: string;
  __failList?: boolean;
}
interface Instrumented {
  /** Every engine start waits for `__release()`; with `holdOnce` only the tab's first one (its reloads run freely). */
  hold?: boolean;
  holdOnce?: boolean;
  holdList?: boolean;
  /** The tab's first request of the collector Web Lock waits for `__releaseLock()`: a page stopped BEFORE it reads or reserves anything. */
  holdLock?: boolean;
  /** With `__holdNextDigest` armed, the next SHA-256 the page computes waits for `__releaseDigest()`: a pick held after its file is read. */
  holdDigest?: boolean;
  /** The run's observation after its engine settled throws (N-1): `syncState` rejects. */
  throwSyncState?: boolean;
  /** A write of `key` whose value contains `contains` is refused by the storage (QuotaExceededError). */
  failSetOn?: { key: string; contains: string };
  /** Reading `key` throws (an unreadable record, which is never "absent"). */
  failGet?: string;
}
/**
 * Instruments ONE page (and its reloads): its profiling writes and its engine starts are counted; with `hold`, every engine start waits
 * for `__release()` (the page then sits inside its reserved attempt, before any work); with `holdList`, the database listing a deletion
 * starts with waits for `__releaseList()`. Page errors are collected for the case's final check. Revision 4 adds the schedules and the
 * labelled fault injections of `Instrumented`, the engine stops (`__stops`) and how many stops each stored result followed
 * (`__stopsAtResultWrites`), and run-time faults a case arms by setting `__failCaptureWrite`, `__alterCaptureRead`, `__failRemove` or
 * `__failList` on the page.
 */
async function instrument(
  page: Page,
  options: Instrumented = {},
): Promise<string[]> {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript((o) => {
    const w = window as unknown as Probe;
    w.__profileWrites = 0;
    w.__engineStarts = 0;
    w.__stops = 0;
    w.__stopsAtResultWrites = [];
    const once = (flag: string) => {
      if (sessionStorage.getItem(flag)) return false;
      sessionStorage.setItem(flag, "1");
      return true;
    };
    const set = Storage.prototype.setItem;
    const get = Storage.prototype.getItem;
    const remove = Storage.prototype.removeItem;
    Storage.prototype.setItem = function (key: string, value: string) {
      if (this === localStorage && key.startsWith("atlas-profile")) {
        if (o.failSetOn?.key === key && value.includes(o.failSetOn.contains))
          throw new DOMException("refused by the test", "QuotaExceededError");
        if (value.includes('"outcome":"'))
          w.__stopsAtResultWrites.push(w.__stops);
        w.__profileWrites += 1;
      }
      if (
        this === sessionStorage &&
        key === "atlas-profile-w2-capture" &&
        w.__failCaptureWrite
      )
        throw new DOMException("refused by the test", "QuotaExceededError");
      return set.call(this, key, value);
    };
    Storage.prototype.getItem = function (key: string) {
      if (this === localStorage && key === o.failGet)
        throw new DOMException("unreadable by the test", "SecurityError");
      const value = get.call(this, key);
      if (
        this === sessionStorage &&
        key === "atlas-profile-w2-capture" &&
        w.__alterCaptureRead &&
        value !== null
      ) {
        const kept = JSON.parse(value) as { name: string; text: string };
        return JSON.stringify({ ...kept, text: `${kept.text} ` });
      }
      return value;
    };
    Storage.prototype.removeItem = function (key: string) {
      if (this === localStorage && key.startsWith("atlas-profile")) {
        if (w.__failRemove === key)
          throw new DOMException("refused by the test", "SecurityError");
        w.__profileWrites += 1;
      }
      return remove.call(this, key);
    };
    if (o.holdLock && navigator.locks) {
      const locks = navigator.locks;
      const request = locks.request.bind(locks) as (
        ...a: unknown[]
      ) => Promise<unknown>;
      (locks as unknown as { request: unknown }).request = async (
        ...args: unknown[]
      ) => {
        // Only the collector guard's own lock (the data layer's locks are never held).
        if (args[0] === "atlas-profile-collector" && once("__lockHeldOnce")) {
          w.__lockHeld = true;
          await new Promise<void>((resolve) => {
            w.__releaseLock = resolve;
          });
        }
        return request(...args);
      };
    }
    if (o.holdDigest) {
      const digest = crypto.subtle.digest.bind(crypto.subtle);
      crypto.subtle.digest = async (...args: Parameters<typeof digest>) => {
        // Armed by the case just before its pick (`__holdNextDigest`), so no earlier hash of the page can take the hold.
        if (w.__holdNextDigest) {
          w.__holdNextDigest = false;
          w.__digestHeld = true;
          await new Promise<void>((resolve) => {
            w.__releaseDigest = resolve;
          });
        }
        return digest(...args);
      };
    }
    Object.defineProperty(window, "__atlasData", {
      configurable: true,
      set(data: {
        startSyncLocal: (...a: unknown[]) => Promise<unknown>;
        list: () => Promise<string[]>;
        stopSync: () => void;
        syncState: (...a: unknown[]) => Promise<unknown>;
      }) {
        Object.defineProperty(window, "__atlasData", {
          value: data,
          configurable: true,
          writable: true,
        });
        const start = data.startSyncLocal.bind(data);
        data.startSyncLocal = async (...args: unknown[]) => {
          w.__engineStarts += 1;
          if (o.hold || (o.holdOnce && once("__heldOnce"))) {
            w.__held = true;
            await new Promise<void>((resolve) => {
              w.__release = resolve;
            });
          }
          return start(...args);
        };
        const stop = data.stopSync.bind(data);
        data.stopSync = () => {
          w.__stops += 1;
          stop();
        };
        const syncState = data.syncState.bind(data);
        data.syncState = async (...args: unknown[]) => {
          if (o.throwSyncState)
            throw new Error("syncState refused by the test (N-1)");
          return syncState(...args);
        };
        const list = data.list.bind(data);
        data.list = async () => {
          if (o.holdList) {
            w.__listHeld = true;
            await new Promise<void>((resolve) => {
              w.__releaseList = resolve;
            });
          }
          if (w.__failList)
            throw new DOMException(
              "listing refused by the test",
              "UnknownError",
            );
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
  // Revision 4 (labelled adaptation of the revision-3 wording; same refusal): the reason names the collection that pins the capture.
  await expect(next.locator("#profile-status")).toContainText(
    "NOT replaced: another tab owns protocol collection lost-tab, which pins a W2 capture",
  );
  expect(await keptCapture(next)).toBeNull();
  await next.locator("#profile-take-over").click();
  await expect(next.locator("#profile-status")).toContainText(
    "now owns collection lost-tab (recorded; the protocol collection).",
  );
  await expect(next.locator("#profile-status")).toContainText(
    `Its W2 capture was kept only in the lost tab: choose the same file again (SHA-256 ${SHA})`,
  );
  const takenOver = await stored(next);
  // Another file is refused, the capture pinned at the start never changes.
  await pickOn(next, OTHER, "other.json");
  await expect(next.locator("#profile-status")).toContainText(
    `NOT replaced: protocol collection lost-tab pins W2 capture ${SHA}, and its capture never changes after it starts`,
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
  // Revision 4 (B2): the take-over records the outstanding reservation as killed in the same write (before revision 4 the next protocol
  // load did); the attempts that result are the same.
  await expect(next.locator("#profile-status")).toContainText(
    "now owns collection lost-reserved (recorded; the protocol collection). Its interrupted attempt W2 run 1 is recorded as killed",
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

// ---- Revision 4 (review 4 R5, R5a, R5b, N-1; design assessment B1-B6, Q-M1-Q-M6, Q-F1-Q-F4) ---------------------------------------------
const OTHER_SHA = createHash("sha256").update(OTHER).digest("hex");
const statusOf = (page: Page) => page.locator("#profile-status");
/** Clicks an action and waits for the page's answer (actions run in the page's serial queue under the guard: never read at once). */
async function act(page: Page, selector: string): Promise<string> {
  await page.evaluate(() => {
    (document.querySelector("#profile-status") as HTMLElement).textContent =
      "Ready.";
  });
  await page.locator(selector).click();
  await expect(statusOf(page)).not.toHaveText("Ready.");
  return (await statusOf(page).textContent()) ?? "";
}
const manualOf = async (page: Page) =>
  JSON.parse((await stored(page)).manual ?? "null") as {
    protocol_id: string;
    owner: string;
    w2sha256: string | null;
    next: number;
    reserved: { name: string; run: number } | null;
    runs: Run[];
    takeovers: Array<{ from: string; to: string }>;
  } | null;
/**
 * Waits until no page holds the collector guard (a closed page's lock is released by the browser after `close()` returns): an
 * `ifAvailable` probe that takes and at once releases it. A readiness condition, not a timing assertion.
 */
const guardFree = (page: Page) =>
  expect
    .poll(
      () =>
        page.evaluate(() =>
          navigator.locks.request(
            "atlas-profile-collector",
            { ifAvailable: true },
            (lock) => lock !== null,
          ),
        ),
      { timeout: 30_000 },
    )
    .toBe(true);
/** Seeds the manual collection a lost tab leaves (owned by `owner`). */
const seedManual = (page: Page, envelope: Record<string, unknown>) =>
  page.evaluate((e) => {
    localStorage.setItem(
      "atlas-profile-manual",
      JSON.stringify({
        schema: 2,
        kind: "manual",
        workload_version: 1,
        plan: [],
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
const exportedOf = (page: Page) =>
  page.evaluate(() =>
    (
      window as unknown as { __profile: { exported: () => string } }
    ).__profile.exported(),
  );

test("case (Q-M1): a gone tab's COMPLETED manual collection is taken over deliberately: refused while its page lives, then moved once with its id, results and pin, and continued by the new owner", async ({
  context,
}) => {
  test.setTimeout(240_000);
  const a = await context.newPage();
  const errors = await instrument(a);
  await a.goto("/profile-harness?w=W3&run=1");
  await expect(statusOf(a)).toContainText("W3 run 1:", { timeout: 120_000 });
  const tokenA = await tokenOf(a);
  const b = await context.newPage();
  errors.push(...(await instrument(b)));
  await b.goto("/profile-harness");
  await settled(b);
  const before = await stored(b);
  const original = JSON.parse(before.manual ?? "null");
  expect(original.runs).toHaveLength(1);
  // While its page lives (it keeps the collector guard after its run), nothing is taken over, cleared or deleted.
  expect(await act(b, "#profile-take-over")).toContain(
    "Not taken over: a live page is collecting on this origin",
  );
  expect(await act(b, "#profile-clear")).toContain(
    "Refused: another tab owns the active collection",
  );
  expect(await act(b, "#profile-delete-databases")).toContain("Refused:");
  expect(await counters(b)).toEqual({ writes: 0, engineStarts: 0 });
  expect(await stored(b)).toEqual(before);
  await a.close();
  await guardFree(b);
  expect(await act(b, "#profile-take-over")).toContain(
    `This tab now owns collection ${original.protocol_id} (recorded; the manual collection). A further manual run takes an unused run number`,
  );
  const after = await manualOf(b);
  expect(after?.protocol_id).toBe(original.protocol_id);
  expect(after?.runs).toEqual(original.runs);
  expect(after?.w2sha256).toBe(original.w2sha256);
  expect(after?.reserved).toBeNull();
  expect(after?.owner).toBe(await tokenOf(b));
  expect(after?.takeovers).toEqual([
    expect.objectContaining({ from: tokenA, to: await tokenOf(b) }),
  ]);
  expect(await counters(b)).toEqual({ writes: 1, engineStarts: 0 });
  await expect(b.locator("#profile-ownership")).toContainText(
    `This tab owns manual collection ${original.protocol_id} (1 attempt(s) recorded)`,
  );
  // The usable next action: the same collection goes on under the new owner.
  await b.goto("/profile-harness?w=W3&run=2");
  await expect(statusOf(b)).toContainText("W3 run 2:", { timeout: 120_000 });
  const continued = await manualOf(b);
  expect(continued?.protocol_id).toBe(original.protocol_id);
  expect(continued?.runs.map((r) => [r.workload, r.run])).toEqual([
    ["W3", 1],
    ["W3", 2],
  ]);
  expect(errors).toEqual([]);
});

test("case (Q-M2): a manual attempt left RESERVED by a closed tab is recovered as exactly one killed result by a take-over that runs nothing; only then may a protocol start", async ({
  context,
}) => {
  test.setTimeout(240_000);
  const a = await context.newPage();
  const errors = await instrument(a, { hold: true });
  await a.goto("/profile-harness?w=W3&run=1");
  await heldInsideAttempt(a);
  const b = await context.newPage();
  errors.push(...(await instrument(b)));
  await b.goto("/profile-harness");
  await settled(b);
  expect(await act(b, "#profile-take-over")).toContain(
    "Not taken over: a live page is collecting on this origin",
  );
  await b.goto("/profile-harness?protocol=1");
  await settled(b);
  await expect(statusOf(b)).toContainText(
    "another live page is collecting on this origin",
  );
  expect(await counters(b)).toEqual({ writes: 0, engineStarts: 0 });
  await a.close();
  await guardFree(b);
  const reserved = await stored(b);
  expect(JSON.parse(reserved.manual ?? "null").reserved).toMatchObject({
    name: "W3",
    run: 1,
  });
  await b.goto("/profile-harness?protocol=1");
  await settled(b);
  await expect(statusOf(b)).toContainText(
    'a manual attempt (W3 run 1) is reserved: let its page record it (or reopen its link in its tab); if its tab is gone, "Take over or recover" records it as killed',
  );
  expect(await counters(b)).toEqual({ writes: 0, engineStarts: 0 });
  expect(await stored(b)).toEqual(reserved);
  await b.goto("/profile-harness");
  await settled(b);
  expect(await act(b, "#profile-take-over")).toContain(
    "(recorded; the manual collection). Its interrupted attempt W3 run 1 is recorded as killed; it is never run again under that identity.",
  );
  const recovered = await manualOf(b);
  expect(recovered?.reserved).toBeNull();
  expect(recovered?.runs.map((r) => [r.workload, r.run, r.outcome])).toEqual([
    ["W3", 1, "killed"],
  ]);
  expect(recovered?.takeovers).toHaveLength(1);
  expect(await counters(b)).toEqual({ writes: 1, engineStarts: 0 });
  // A second recovery finds nothing to do (one killed result per attempt).
  expect(await act(b, "#profile-take-over")).toContain(
    "Not taken over: nothing to take over or recover",
  );
  expect((await manualOf(b))?.runs).toHaveLength(1);
  // Now a protocol may start (it reserves its first attempt; held there).
  const c = await context.newPage();
  errors.push(...(await instrument(c, { hold: true })));
  await c.goto("/profile-harness?protocol=1");
  await heldInsideAttempt(c);
  expect(
    JSON.parse((await stored(c)).protocol ?? "null").reserved,
  ).toMatchObject({ name: "W1", run: 1 });
  expect(errors).toEqual([]);
});

test("case (Q-M3): a reloaded manual link never runs an attempt twice: after its reservation it records the attempt killed and runs nothing; after its result it changes nothing; before its reservation it runs normally", async ({
  context,
}) => {
  test.setTimeout(300_000);
  const page = await context.newPage();
  const errors = await instrument(page, { holdOnce: true, holdLock: true });
  // Before any reservation: the first load is held on the collector lock (nothing read or written), and its reload runs the attempt.
  await page.goto("/profile-harness?w=W4&run=1");
  // A bounded assertion (never the test's time-out): a page that never gets there fails here, by name.
  await expect
    .poll(
      () =>
        page.evaluate(() => (window as unknown as Probe).__lockHeld === true),
      { timeout: 60_000 },
    )
    .toBe(true);
  expect(await stored(page)).toEqual({ protocol: null, manual: null });
  await page.reload();
  // A bounded assertion (never the test's time-out): a page that never gets there fails here, by name.
  await expect
    .poll(
      () => page.evaluate(() => (window as unknown as Probe).__held === true),
      { timeout: 60_000 },
    )
    .toBe(true);
  // The engine start of that run is held once (its reservation is stored); the reload records it killed and does not run it again.
  const reserved = await manualOf(page);
  expect(reserved?.reserved).toMatchObject({ name: "W4", run: 1 });
  await page.reload();
  await settled(page);
  await expect(statusOf(page)).toHaveText(
    "W4 run 1 is recorded (killed: its attempt was interrupted and is never run again under its identity): nothing was run. The next unused run is 2.",
  );
  expect(await counters(page)).toEqual({ writes: 1, engineStarts: 0 });
  const recovered = await manualOf(page);
  expect(recovered?.runs.map((r) => [r.workload, r.run, r.outcome])).toEqual([
    ["W4", 1, "killed"],
  ]);
  expect(recovered?.takeovers).toEqual([]);
  // The same link again: already recorded, nothing written.
  const bytes = await stored(page);
  await page.goto("/profile-harness?w=W4&run=1");
  await settled(page);
  await expect(statusOf(page)).toContainText(
    "W4 run 1 is already recorded in this collection (the next unused run is 2): nothing was run or written.",
  );
  expect(await counters(page)).toEqual({ writes: 0, engineStarts: 0 });
  expect(await stored(page)).toEqual(bytes);
  // A new identity collects; its reload after the result changes nothing.
  await page.goto("/profile-harness?w=W4&run=2");
  await expect(statusOf(page)).toContainText("W4 run 2:", { timeout: 120_000 });
  const done = await stored(page);
  await page.reload();
  await settled(page);
  await expect(statusOf(page)).toContainText("W4 run 2 is already recorded");
  expect(await counters(page)).toEqual({ writes: 0, engineStarts: 0 });
  expect(await stored(page)).toEqual(done);
  expect(
    (await manualOf(page))?.runs.map((r) => [r.workload, r.run, r.outcome]),
  ).toEqual([
    ["W4", 1, "killed"],
    ["W4", 2, "admitted"],
  ]);
  expect(errors).toEqual([]);
});

test("case (Q-M4): a gone tab's manual W2 collection is taken over, its outstanding W2 reservation recorded killed once, its pinned capture restored by the identical file only, and the next W2 run uses those bytes", async ({
  context,
}) => {
  test.setTimeout(240_000);
  const lost = await context.newPage();
  const errors = await instrument(lost);
  await lost.goto("/profile-harness");
  await settled(lost);
  await seedManual(lost, {
    protocol_id: "lost-manual",
    owner: await tokenOf(lost),
    w2sha256: SHA,
    next: 1,
    reserved: { name: "W2", run: 2, index: 1, at: "t1", page: "lost" },
    runs: [{ ...storedRun("W2", 1, "lost-manual"), sha256: SHA }],
  });
  await lost.close();
  const next = await context.newPage();
  errors.push(...(await instrument(next)));
  await next.goto("/profile-harness");
  await settled(next);
  await pickOn(next, STAND_IN);
  await expect(statusOf(next)).toContainText(
    "NOT replaced: another tab owns manual collection lost-manual, which pins a W2 capture",
  );
  expect(await keptCapture(next)).toBeNull();
  const taken = await act(next, "#profile-take-over");
  expect(taken).toContain(
    "now owns collection lost-manual (recorded; the manual collection). Its interrupted attempt W2 run 2 is recorded as killed",
  );
  expect(taken).toContain(`choose the same file again (SHA-256 ${SHA})`);
  await pickOn(next, OTHER, "other.json");
  await expect(statusOf(next)).toContainText(
    `NOT replaced: manual collection lost-manual pins W2 capture ${SHA}, and its capture never changes after it starts (this file's SHA-256 is ${OTHER_SHA})`,
  );
  expect(await keptCapture(next)).toBeNull();
  const before = await stored(next);
  await pickOn(next, STAND_IN);
  await expect(statusOf(next)).toContainText(
    `W2 capture restored for collection lost-manual: ${NAME}, ${STAND_IN.length} bytes, SHA-256 ${SHA}`,
  );
  expect(await stored(next)).toEqual(before);
  await next.goto(`/profile-harness?w=W2&run=3&w2sha256=${SHA}`);
  await expect(statusOf(next)).toContainText("W2 run 3:", { timeout: 120_000 });
  const runs = (await manualOf(next))?.runs ?? [];
  expect(runs.map((r) => [r.workload, r.run, r.outcome])).toEqual([
    ["W2", 1, "admitted"],
    ["W2", 2, "killed"],
    ["W2", 3, "admitted"],
  ]);
  expect(runs[2]).toMatchObject({
    sha256: SHA,
    sha256_verified: true,
    source: NAME,
  });
  expect(errors).toEqual([]);
});

test("case (Q-M5): a manual history and a protocol side by side: an automatic take-over asks for a choice, each is taken over alone, two different pins need the chosen collection, and clear is scoped", async ({
  context,
}) => {
  test.setTimeout(240_000);
  const lost = await context.newPage();
  const errors = await instrument(lost);
  await lost.goto("/profile-harness");
  await settled(lost);
  const lostToken = await tokenOf(lost);
  await seedProtocol(lost, {
    protocol_id: "co-protocol",
    owner: lostToken,
    w2sha256: SHA,
    plan: [
      { name: "W1", run: 1 },
      { name: "W2", run: 1 },
    ],
    next: 0,
    reserved: null,
    runs: [],
  });
  await seedManual(lost, {
    protocol_id: "co-manual",
    owner: lostToken,
    w2sha256: OTHER_SHA,
    next: 1,
    reserved: null,
    runs: [storedRun("W3", 1, "co-manual")],
  });
  await lost.close();
  const b = await context.newPage();
  errors.push(...(await instrument(b)));
  await b.goto("/profile-harness");
  await settled(b);
  const seeded = await stored(b);
  expect(await act(b, "#profile-take-over")).toContain(
    "Not taken over: two collections can be taken over (protocol co-protocol, manual co-manual): choose one",
  );
  expect(await stored(b)).toEqual(seeded);
  await b.selectOption("#profile-target", "manual");
  expect(await act(b, "#profile-take-over")).toContain(
    "now owns collection co-manual (recorded; the manual collection)",
  );
  expect((await stored(b)).protocol).toBe(seeded.protocol);
  // The protocol is still active and another tab's: a manual run is still refused beside it.
  const manualPage = await context.newPage();
  errors.push(...(await instrument(manualPage)));
  await manualPage.addInitScript(
    (t) => {
      sessionStorage.setItem("atlas-profile-owner", t as string);
    },
    await tokenOf(b),
  );
  await manualPage.goto("/profile-harness?w=W3&run=2");
  await settled(manualPage);
  await expect(statusOf(manualPage)).toContainText(
    "protocol co-protocol is active on this origin: a manual run is refused",
  );
  expect(await counters(manualPage)).toEqual({ writes: 0, engineStarts: 0 });
  await manualPage.close();
  const manualTaken = (await stored(b)).manual;
  await b.selectOption("#profile-target", "protocol");
  expect(await act(b, "#profile-take-over")).toContain(
    "now owns collection co-protocol (recorded; the protocol collection)",
  );
  expect((await stored(b)).manual).toBe(manualTaken);
  // Both are this tab's now, pinning different captures: no silent choice.
  await b.selectOption("#profile-target", "auto");
  await pickOn(b, STAND_IN);
  await expect(statusOf(b)).toContainText(
    "NOT replaced: this tab's collections pin different W2 captures",
  );
  expect(await keptCapture(b)).toBeNull();
  await b.selectOption("#profile-target", "protocol");
  await pickOn(b, STAND_IN);
  await expect(statusOf(b)).toContainText(
    `W2 capture restored for collection co-protocol: ${NAME}`,
  );
  await expect(statusOf(b)).toContainText(
    `NOTE: this tab no longer keeps the capture of manual collection co-manual (SHA-256 ${OTHER_SHA})`,
  );
  // Clear is scoped to the chosen collection; what it removed is in the box.
  const protocolNow = (await stored(b)).protocol;
  await b.selectOption("#profile-target", "manual");
  expect(await act(b, "#profile-clear")).toBe(
    "Results cleared: the manual collection only.",
  );
  expect(await stored(b)).toEqual({ protocol: protocolNow, manual: null });
  expect(await exportedOf(b)).toContain("co-manual");
  expect(errors).toEqual([]);
});

test("case (Q-M6): a capture pick held after its file was read, while another tab starts collecting, keeps nothing and writes nothing", async ({
  context,
}) => {
  test.setTimeout(240_000);
  const picker = await context.newPage();
  const errors = await instrument(picker, { holdDigest: true });
  await picker.goto("/profile-harness");
  await settled(picker);
  await picker.evaluate(() => {
    (window as unknown as Probe).__holdNextDigest = true;
  });
  await pickOn(picker, STAND_IN);
  // A bounded assertion (never the test's time-out): a page that never gets there fails here, by name.
  await expect
    .poll(
      () =>
        picker.evaluate(
          () => (window as unknown as Probe).__digestHeld === true,
        ),
      { timeout: 60_000 },
    )
    .toBe(true);
  const collector = await context.newPage();
  errors.push(...(await instrument(collector, { hold: true })));
  await collector.goto(`/profile-harness?protocol=1&w2sha256=${SHA}`);
  await heldInsideAttempt(collector);
  await picker.evaluate(() => (window as unknown as Probe).__releaseDigest?.());
  await expect(statusOf(picker)).toContainText(
    "The W2 capture was NOT kept: a live page is collecting on this origin",
  );
  expect(await keptCapture(picker)).toBeNull();
  expect(await counters(picker)).toEqual({ writes: 0, engineStarts: 0 });
  expect(errors).toEqual([]);
});

test("case (Q-F1): refused or unreadable storage at the reservation, the result and the take-over changes nothing it did not report, runs nothing before a reservation, and stays recoverable", async ({
  browser,
}) => {
  test.setTimeout(240_000);
  const errors: string[] = [];
  // The reservation refused: nothing runs.
  const one = await browser.newContext();
  const p1 = await one.newPage();
  errors.push(
    ...(await instrument(p1, {
      failSetOn: {
        key: "atlas-profile-manual",
        contains: '"reserved":{"name"',
      },
    })),
  );
  await p1.goto("/profile-harness?w=W3&run=1");
  await settled(p1);
  await expect(statusOf(p1)).toContainText(
    "Stopped: the storage refused the write",
  );
  expect((await counters(p1)).engineStarts).toBe(0);
  const created = await manualOf(p1);
  expect(created?.runs).toEqual([]);
  expect(created?.reserved).toBeNull();
  await one.close();
  // The result refused: the run happened, its result is NOT stored and says so; its reservation stays for recovery.
  const two = await browser.newContext();
  const p2 = await two.newPage();
  errors.push(
    ...(await instrument(p2, {
      failSetOn: { key: "atlas-profile-manual", contains: '"outcome":"' },
    })),
  );
  await p2.goto("/profile-harness?w=W3&run=1");
  await expect(statusOf(p2)).toContainText(
    "the result was NOT stored: the storage refused the write",
    { timeout: 120_000 },
  );
  const left = await stored(p2);
  expect(JSON.parse(left.manual ?? "null").reserved).toMatchObject({
    name: "W3",
    run: 1,
  });
  expect(JSON.parse(left.manual ?? "null").runs).toEqual([]);
  // Its own recovery is refused by the same storage: nothing changes.
  await p2.goto("/profile-harness");
  await settled(p2);
  expect(await act(p2, "#profile-take-over")).toContain(
    "Not taken over: the storage refused the write",
  );
  expect(await stored(p2)).toEqual(left);
  // Another tab with working storage recovers it once.
  await p2.close();
  const p3 = await two.newPage();
  errors.push(...(await instrument(p3)));
  await p3.goto("/profile-harness");
  await settled(p3);
  expect(await act(p3, "#profile-take-over")).toContain(
    "Its interrupted attempt W3 run 1 is recorded as killed",
  );
  expect(
    (await manualOf(p3))?.runs.map((r) => [r.workload, r.run, r.outcome]),
  ).toEqual([["W3", 1, "killed"]]);
  await two.close();
  // An unreadable record is not an absent one: nothing is created over it.
  const three = await browser.newContext();
  const p4 = await three.newPage();
  errors.push(...(await instrument(p4, { failGet: "atlas-profile-manual" })));
  await p4.goto("/profile-harness?w=W3&run=1");
  await settled(p4);
  await expect(statusOf(p4)).toContainText(
    "the stored manual collection is unreadable (unreadable:",
  );
  expect(await counters(p4)).toEqual({ writes: 0, engineStarts: 0 });
  await three.close();
  expect(errors).toEqual([]);
});

test("case (Q-F2): a held attempt whose collection moved A to B and back to A behind its back (labelled fault injection) is not stored: the transfer consumed its reservation", async ({
  context,
}) => {
  test.setTimeout(240_000);
  const owner = await context.newPage();
  const errors = await instrument(owner, { hold: true });
  await owner.goto("/profile-harness?w=W3&run=1");
  await heldInsideAttempt(owner);
  const other = await reader(context);
  // What a take-over by B and a take-over back by A write (the reservation recorded killed by B's), written directly by the TEST.
  await other.evaluate(() => {
    const e = JSON.parse(localStorage.getItem("atlas-profile-manual") ?? "{}");
    const a = e.owner;
    const r = e.reserved;
    e.runs = [
      {
        workload: r.name,
        run: r.run,
        cold: true,
        expected: "admitted",
        outcome: "killed",
        detail: "test",
        sha256: "",
        sha256_verified: false,
        bytes: 0,
        elapsed_ms: 0,
        scan_ms: null,
        commit_ms: null,
        request_count: 0,
        limit: null,
        changes_written: null,
        cursor_after: null,
        heap_baseline_bytes: null,
        heap_peak_bytes: null,
        heap_after_bytes: null,
        user_agent: "test",
        at: "t8",
        protocol_id: e.protocol_id,
      },
    ];
    e.next = 1;
    e.reserved = null;
    e.takeovers = [
      { at: "t8", from: a, to: "tab-b" },
      { at: "t9", from: "tab-b", to: a },
    ];
    localStorage.setItem("atlas-profile-manual", JSON.stringify(e));
  });
  const moved = await stored(other);
  await release(owner);
  await expect(statusOf(owner)).toContainText(
    "was NOT stored: it no longer holds the reservation this page made",
    { timeout: 120_000 },
  );
  expect(await stored(other)).toEqual(moved);
  expect(errors).toEqual([]);
});

test("case (Q-F3): a run whose observation throws after its engine started is an error attempt, and its engine is stopped BEFORE its result is stored; a normal run stops first too", async ({
  browser,
}) => {
  test.setTimeout(240_000);
  const errors: string[] = [];
  for (const thrown of [true, false]) {
    const context = await browser.newContext();
    const page = await context.newPage();
    errors.push(...(await instrument(page, { throwSyncState: thrown })));
    await page.goto("/profile-harness?w=W3&run=1");
    await expect(statusOf(page)).toContainText("W3 run 1:", {
      timeout: 120_000,
    });
    const run = (await manualOf(page))?.runs[0] as Run & { detail: string };
    if (thrown) {
      expect(run.outcome).toBe("error");
      expect(run.detail).toContain("the run threw");
      expect(run.detail).toContain("syncState refused by the test");
    } else expect(run.outcome).toBe("admitted");
    const stops = await page.evaluate(() => {
      const w = window as unknown as Probe;
      return { stops: w.__stops, atResult: w.__stopsAtResultWrites };
    });
    expect(stops.atResult, `thrown ${thrown}`).toHaveLength(1);
    expect(stops.atResult[0], `thrown ${thrown}`).toBeGreaterThanOrEqual(1);
    expect(
      await page.evaluate(
        () =>
          (
            window as unknown as {
              __atlasData: { engineState: () => unknown };
            }
          ).__atlasData.engineState() ?? null,
      ),
    ).toBeNull();
    expect(await act(page, "#profile-clear")).toBe("Results cleared.");
    await context.close();
  }
  expect(errors).toEqual([]);
});

test("case (Q-F4): a refused capture write keeps the previous capture, a read-back failure is reported uncertain, a partial clear and a refused listing are reported as such, and the chosen collection's diagnostic copy holds its reservation", async ({
  context,
}) => {
  test.setTimeout(240_000);
  const page = await context.newPage();
  const errors = await instrument(page);
  await page.goto("/profile-harness");
  await settled(page);
  await pickOn(page, STAND_IN);
  await expect(statusOf(page)).toHaveText(
    `W2 capture kept: ${NAME}, ${STAND_IN.length} bytes, SHA-256 ${SHA}`,
  );
  const kept = await keptCapture(page);
  await page.evaluate(() => {
    (window as unknown as Probe).__failCaptureWrite = true;
  });
  await pickOn(page, OTHER, "other.json");
  await expect(statusOf(page)).toContainText(
    "The W2 capture could not be kept (the previous one, if any, is unchanged)",
  );
  expect(await keptCapture(page)).toBe(kept);
  await page.evaluate(() => {
    const w = window as unknown as Probe;
    w.__failCaptureWrite = false;
    w.__alterCaptureRead = true;
  });
  await pickOn(page, OTHER, "other.json");
  await expect(statusOf(page)).toContainText(
    "did NOT read back as picked: what this tab keeps is now UNCERTAIN",
  );
  await page.evaluate(() => {
    (window as unknown as Probe).__alterCaptureRead = false;
  });
  // Two collections of this tab: a finished protocol and a manual one holding a reservation of a page that ended.
  const token = await tokenOf(page);
  await seedProtocol(page, {
    protocol_id: "done-protocol",
    owner: token,
    w2sha256: null,
    plan: [{ name: "W3", run: 1 }],
    next: 1,
    reserved: null,
    runs: [storedRun("W3", 1, "done-protocol")],
    terminal: "complete",
  });
  await seedManual(page, {
    protocol_id: "held-manual",
    owner: token,
    w2sha256: null,
    next: 0,
    reserved: { name: "W4", run: 1, index: 0, at: "t5", page: "ended" },
    runs: [],
  });
  await page.reload();
  await settled(page);
  await page.selectOption("#profile-target", "manual");
  await act(page, "#profile-copy");
  const copied = JSON.parse(await exportedOf(page));
  expect(copied).toMatchObject({
    kind: "manual",
    protocol_id: "held-manual",
    owner: token,
    reserved: { name: "W4", run: 1 },
  });
  await act(page, "#profile-copy-diagnostic");
  const diagnostic = JSON.parse(await exportedOf(page));
  expect(diagnostic.manual.reserved).toMatchObject({ name: "W4", run: 1 });
  expect(diagnostic.raw["atlas-profile-manual"]).toContain("held-manual");
  expect(diagnostic.raw["atlas-profile-protocol"]).toContain("done-protocol");
  // The reservation is recorded (this tab's own: no take-over), then a partial clear is reported as partial.
  expect(await act(page, "#profile-take-over")).toContain(
    "This tab recovered collection held-manual (the manual collection). Its interrupted attempt W4 run 1 is recorded as killed",
  );
  await page.selectOption("#profile-target", "auto");
  await page.evaluate(() => {
    (window as unknown as Probe).__failRemove = "atlas-profile-manual";
  });
  const partial = await act(page, "#profile-clear");
  expect(partial).toContain(
    "NOT fully cleared: removed protocol; NOT removed manual",
  );
  const left = await stored(page);
  expect(left.protocol).toBeNull();
  expect(left.manual).toContain("held-manual");
  expect(await exportedOf(page)).toContain("done-protocol");
  // A refused database listing stops the deletion and says how far it got; the history stays.
  await page.evaluate(() => {
    const w = window as unknown as Probe;
    w.__failRemove = undefined;
    w.__failList = true;
  });
  expect(await act(page, "#profile-delete-databases")).toContain(
    "Deleting stopped after 0 profiling database(s):",
  );
  expect(await stored(page)).toEqual(left);
  expect(errors).toEqual([]);
});
