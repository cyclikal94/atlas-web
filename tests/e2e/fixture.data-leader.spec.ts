import {
  ACCOUNT,
  arrange,
  BLOCKED,
  deltaPage,
  displayed,
  draft,
  failStagingWrites,
  failStoreWrites,
  fencedAfterReauth,
  fencedWithCursor,
  fencesOf,
  fresh,
  held,
  holdActivation,
  holdFinishAfterCommit,
  leaderNetwork,
  leaderOf,
  leaderPage,
  leaderPageAfter,
  ownerTab,
  QUEUED,
  rowsOf,
  SNAP,
  seedAuth,
  snapshotPage,
  stagingFaultHits,
  status,
  storeFaultHits,
  syncStateOf,
  untilLeader,
  untilSync,
} from "./data-leader-helpers";
import { upsert, uuid } from "./data-sync-helpers";
import {
  type DisplayOracle,
  FIXTURE_ACCOUNT_MARKERS,
  installDisplayOracle,
} from "./display-oracle";
import { expect, test } from "./helpers";

/**
 * WEB-09b's PRODUCTION leader in real engines (Chromium, Firefox, macOS WebKit): real Web Locks, real IndexedDB, real BroadcastChannel,
 * the production session and boot composition on `/__session?leader=production`, the network stubbed by the test. FIXTURE evidence: the
 * `/sync` answers are scripted, there is no backend, and nothing here is integration or release evidence.
 *
 *   E-B1  one leader among three pages; the followers send nothing and report a follower's status;
 *   E-B2  the leader's page closes mid-snapshot: the next page leads and ADOPTS the staged attempt (case (b));
 *   E-B3  the leader's page reloads mid-snapshot: it adopts the staged attempt and asks for the staged position (case (a));
 *   E-B4  an attempt older than the lifetime restarts cursor-less under a new generation (case (c), the age SEEDED);
 *   E-B10 a first snapshot over three pages, activated atomically, then an ordinary delta on top;
 *   E-B13 three cursor-less 400s across reloads reach the blocking state and no fourth request is sent (trace 6);
 *   E-R1  matrix 3.7.3: a fenced account (settled at epoch 2 over an epoch-1 `invalid_session` entry) is caught up from its saved cursor
 *         while hidden, then `finish` clears the fence and the account is displayed; unsent drafts are byte-identical.
 */

// WEB-08c revision 3 (R5; design assessment P1/P2): every case of this file ALSO runs under the continuous no-early-display oracle
// (`display-oracle.ts`, qualified by `fixture.lifecycle-oracle.spec.ts`): no page mounts or lifts an account, or shows a protected title,
// before its own last committed `atlas-auth` record names that account settled with no fence entry, and every page of the context was
// enrolled before its application ran. The cases' own assertions are unchanged; this adds a check over the whole run.
let displayOracle: DisplayOracle | null = null;
test.beforeEach(async ({ context }) => {
  // WEB-08c revision 4 (DA-H1): with the account's verified name as its marker, as every production-session fixture caller has.
  displayOracle = await installDisplayOracle(context, {
    markers: [...FIXTURE_ACCOUNT_MARKERS],
  });
});
test.afterEach(async ({ context }, testInfo) => {
  const oracle = displayOracle;
  displayOracle = null;
  if (!oracle) return;
  if (testInfo.status !== testInfo.expectedStatus) {
    await testInfo.attach("display-oracle-violations.json", {
      body: JSON.stringify(
        { violations: oracle.violations(), pages: context.pages().length },
        null,
        1,
      ),
      contentType: "application/json",
    });
    return;
  }
  await oracle.assertClean(testInfo.title);
});

test.describe("E-B: production leadership and the first snapshot", () => {
  test("E-B1 one leader among three pages; the followers send nothing and report a follower's status", async ({
    context,
  }) => {
    const net = await fresh(context);
    const one = await leaderPage(context, net, "one");
    const first = await untilSync(one, (s) => s?.cache_status === "valid");
    expect(first).toMatchObject({ cache_status: "valid", phase: "delta" });
    const two = await leaderPage(context, net, "two");
    const three = await leaderPage(context, net, "three");
    const views = await Promise.all(
      [two, three].map((page) =>
        untilLeader(page, (v) => v.attachment === "follower"),
      ),
    );
    expect(views.map((v) => v.role)).toEqual(["follower", "follower"]);
    expect((await leaderOf(one)).role).toBe("leader");
    // The followers' pages never issued `/sync`; the database's owner is the leader's tab.
    await one.waitForTimeout(500);
    expect(net.calls.filter((c) => c.page !== "one")).toEqual([]);
    expect(await ownerTab(one)).toBe(
      await one.evaluate(() => window.__atlasData?.tabId ?? null),
    );
    // A follower's chip does not say "Updates stopped" merely because another page leads.
    await expect(two.getByText("Updates stopped")).toHaveCount(0);
  });

  test("E-B10 a first snapshot over three pages is staged and activated atomically, then an ordinary delta applies on top", async ({
    context,
  }) => {
    const net = await fresh(context);
    const delta = held();
    let deltas = 0;
    net.answer = async (call) => {
      if (call.cursor === null)
        return snapshotPage(SNAP([1, 2]), "snap-1", true);
      if (call.cursor === "snap-1")
        return snapshotPage(SNAP([3]), "snap-2", true);
      if (call.cursor === "snap-2")
        return snapshotPage(SNAP([4]), "delta-1", false);
      deltas += 1;
      if (deltas === 1) {
        await delta.promise;
        return deltaPage([upsert(5, { n: 5 })], "delta-2");
      }
      return deltaPage([], call.cursor ?? "x");
    };
    const page = await leaderPage(context, net, "one");
    const activated = await untilSync(page, (s) => s?.cache_status === "valid");
    expect(activated).toMatchObject({
      phase: "delta",
      cursor: "delta-1",
      applied_revision: 10,
      staging_position: null,
    });
    const cached = (await rowsOf(page, "cache")) as Array<{ id: string }>;
    expect(cached.map((r) => r.id).sort()).toEqual(
      [1, 2, 3, 4].map(uuid).sort(),
    );
    expect(await rowsOf(page, "cache_staging")).toEqual([]);
    expect(net.calls.slice(0, 3).map((c) => c.cursor)).toEqual([
      null,
      "snap-1",
      "snap-2",
    ]);
    delta.release();
    const after = await untilSync(page, (s) => s?.cursor === "delta-2");
    expect(after?.cursor).toBe("delta-2");
    const rows = (await rowsOf(page, "cache")) as Array<{ id: string }>;
    expect(rows.map((r) => r.id)).toContain(uuid(5));
  });

  test("E-B3 the leader's page reloads mid-snapshot: the reloaded page adopts the staged attempt and asks for the staged position", async ({
    context,
  }) => {
    const net = await fresh(context);
    const stall = held();
    net.answer = async (call) => {
      if (call.cursor === null) return snapshotPage(SNAP([1]), "snap-1", true);
      if (call.cursor === "snap-1" && call.page === "one") {
        await stall.promise;
        return status(503);
      }
      if (call.cursor === "snap-1")
        return snapshotPage(SNAP([2]), "delta-1", false);
      return deltaPage([], call.cursor ?? "x");
    };
    const page = await leaderPage(context, net, "one");
    const staged = await untilSync(
      page,
      (s) => s?.staging_position === "snap-1",
    );
    const generation = staged?.recovery_generation;
    const token = (staged?.owner as { ownership_token: string } | null)
      ?.ownership_token;
    net.label(page, "one-reloaded");
    await leaderPage(context, net, "one-reloaded", page);
    const done = await untilSync(page, (s) => s?.cache_status === "valid");
    stall.release();
    expect(done).toMatchObject({
      cache_status: "valid",
      recovery_generation: generation,
    });
    expect(
      (done?.owner as { ownership_token?: string } | undefined)
        ?.ownership_token,
    ).not.toBe(token);
    const reloaded = net.calls.filter((c) => c.page === "one-reloaded");
    expect(reloaded[0]?.cursor).toBe("snap-1");
    const rows = (await rowsOf(page, "cache")) as Array<{ id: string }>;
    expect(rows.map((r) => r.id).sort()).toEqual([uuid(1), uuid(2)].sort());
  });

  test("E-B4 an attempt older than the lifetime is not adopted: a new generation restarts cursor-less and the old staged rows are gone", async ({
    context,
  }) => {
    const net = await fresh(context);
    await arrange(context, async (page) => {
      await page.evaluate(async (account) => {
        const data = window.__atlasData;
        await data?.put(account, "cache_staging", [
          {
            id: "00000000-0000-4000-8000-000000000099",
            kind: "person",
            parent_id: null,
            label: "old",
            value: null,
            version: 1,
            can_edit: true,
            archived: false,
            kind_date: null,
            recovery_generation: 0,
          },
        ]);
        const sync = (await data?.syncState(account)) as Record<
          string,
          unknown
        >;
        await data?.put(account, "sync_state", [
          {
            ...sync,
            staging_position: "stale-snap",
            // SEEDED age: two hours ago (no production constant is changed).
            staging_started_at: Date.now() - 2 * 3_600_000,
          },
        ]);
      }, ACCOUNT);
    });
    const page = await leaderPage(context, net, "one");
    const done = await untilSync(page, (s) => s?.cache_status === "valid");
    expect(done?.recovery_generation).toBeGreaterThan(0);
    expect(net.calls[0]?.cursor).toBeNull();
    const rows = (await rowsOf(page, "cache")) as Array<{ id: string }>;
    expect(rows.map((r) => r.id)).not.toContain(
      "00000000-0000-4000-8000-000000000099",
    );
  });

  test("E-B2 the leader's page closes mid-snapshot: the follower leads, adopts the staged attempt and continues it", async ({
    context,
  }) => {
    const net = await fresh(context);
    const stall = held();
    net.answer = async (call) => {
      if (call.cursor === null) return snapshotPage(SNAP([1]), "snap-1", true);
      if (call.cursor === "snap-1" && call.page === "one") {
        await stall.promise;
        return status(503);
      }
      if (call.cursor === "snap-1")
        return snapshotPage(SNAP([2]), "delta-1", false);
      return deltaPage([], call.cursor ?? "x");
    };
    const one = await leaderPage(context, net, "one");
    await untilSync(one, (s) => s?.staging_position === "snap-1");
    const two = await leaderPage(context, net, "two");
    expect(
      (await untilLeader(two, (v) => v.attachment === "follower")).role,
    ).toBe("follower");
    const generation = (await syncStateOf(two))?.recovery_generation;
    // The held transaction is the activation: page one had staged page one and asked for the final page.
    expect(net.calls.map((c) => [c.page, c.cursor])).toEqual([
      ["one", null],
      ["one", "snap-1"],
    ]);
    await one.close();
    const led = await untilLeader(two, (v) => v.role === "leader");
    expect(led.role).toBe("leader");
    const done = await untilSync(two, (s) => s?.cache_status === "valid");
    stall.release();
    expect(done).toMatchObject({ recovery_generation: generation });
    expect(net.calls.filter((c) => c.page === "two")[0]?.cursor).toBe("snap-1");
  });
});

test.describe("E-B13: the recovery-scoped budget in a real engine (trace 6)", () => {
  test("three cursor-less 400s, with a reload between each, reach the blocking state; no fourth request follows; a page load permits one attempt", async ({
    context,
  }, info) => {
    const net = await fresh(context);
    net.answer = () => status(400, { code: "bad_request" });
    let page = await leaderPage(context, net, "load-1");
    await untilSync(page, (s) => (s?.sync_error_streak as number) >= 1);
    for (const load of [2, 3]) {
      net.label(page, `load-${load}`);
      page = await leaderPage(context, net, `load-${load}`, page);
      await untilSync(page, (s) => (s?.sync_error_streak as number) >= load);
    }
    const blocked = await untilLeader(page, (v) =>
      JSON.stringify(v.job).includes("sync_blocked"),
    );
    expect(blocked.job).toMatchObject({
      kind: "stopped",
      cause: "sync_blocked",
    });
    const count = net.calls.length;
    await page.waitForTimeout(3_000);
    expect(net.calls.length).toBe(count);
    // A reload permits exactly one attempt, subject to the same counter.
    net.label(page, "load-4");
    page = await leaderPage(context, net, "load-4", page);
    await untilSync(page, (s) => (s?.sync_error_streak as number) >= 4);
    await page.waitForTimeout(3_000);
    // The load's own record, kept with the result: the kernel trace (fixed vocabulary) and the leader view.
    await info.attach("e-b13-load-4", {
      body: JSON.stringify(
        {
          calls: net.calls,
          leader: await leaderOf(page),
          trace: await page.evaluate(
            () => window.__atlasFixture?.session?.trace ?? [],
          ),
        },
        null,
        2,
      ),
      contentType: "application/json",
    });
    expect(net.calls.filter((c) => c.page === "load-4")).toHaveLength(1);
  });
});

test.describe("E-R: matrix 3.7.3 recovery while fenced", () => {
  test("E-R1 T24 A and E: a valid saved cursor is caught up while hidden, `finish` clears the fence, the account is displayed; the unsent work is byte-identical and the queued draft is sent once, after, with its own key", async ({
    context,
  }) => {
    const net = await fencedWithCursor(context);
    net.answer = (call) =>
      call.cursor === "delta-0"
        ? deltaPage([upsert(7, { n: 7 })], "delta-1")
        : deltaPage([], call.cursor ?? "x");
    const page = await leaderPage(context, net, "one");
    const done = await untilSync(page, (s) => s?.cursor === "delta-1");
    expect(done?.cursor).toBe("delta-1");
    await displayed(page);
    expect(await fencesOf(page)).toEqual([]);
    expect(net.calls[0]?.cursor).toBe("delta-0");
    // The blocked draft (never sent automatically) and its body are exactly as they were arranged.
    const drafts = (await rowsOf(page, "drafts")) as Array<{
      local_id: string;
    }>;
    const bodies = (await rowsOf(page, "draft_commands")) as Array<{
      local_id: string;
    }>;
    const arranged = draft(BLOCKED, "blocked", 2);
    const blocked = drafts.find((d) => d.local_id === BLOCKED) as Record<
      string,
      unknown
    >;
    expect({ ...blocked, created_at: arranged.header.created_at }).toEqual(
      arranged.header,
    );
    expect(bodies.find((b) => b.local_id === BLOCKED)).toEqual(arranged.body);
    // The queued draft is sent once the account is displayed, under its own key, by the leader alone.
    await expect.poll(() => net.commands.length, { timeout: 15_000 }).toBe(1);
    expect(net.commands).toEqual([
      { page: "one", path: "/commands", key: QUEUED },
    ]);
  });

  test("E-R2 T24 B: a 410 on the first recovery page builds a replacement snapshot while hidden; nothing of the queue is written by the recovery", async ({
    context,
  }) => {
    const net = await fencedWithCursor(context);
    net.answer = (call) =>
      call.cursor === "delta-0"
        ? status(410, { code: "resync_required" })
        : call.cursor === null
          ? snapshotPage(SNAP([50, 51]), "delta-9", false)
          : deltaPage([], call.cursor);
    const page = await leaderPage(context, net, "one");
    const done = await untilSync(page, (s) => s?.cursor === "delta-9");
    expect(done).toMatchObject({ cache_status: "valid", phase: "delta" });
    expect(net.calls.slice(0, 2).map((c) => c.cursor)).toEqual([
      "delta-0",
      null,
    ]);
    await displayed(page);
    expect(await fencesOf(page)).toEqual([]);
    const cached = (await rowsOf(page, "cache")) as Array<{ id: string }>;
    expect(cached.map((r) => r.id).sort()).toEqual([uuid(50), uuid(51)].sort());
    const blocked = (
      (await rowsOf(page, "drafts")) as Array<{
        local_id: string;
        status: string;
      }>
    ).find((d) => d.local_id === BLOCKED);
    expect(blocked?.status).toBe("blocked");
  });

  test("E-R3 T24 C: a recovery-time 401 stops the run: nothing more is asked, the account stays hidden, and nothing was counted", async ({
    context,
  }) => {
    const net = await fencedWithCursor(context);
    net.answer = (call) =>
      call.cursor === "delta-0"
        ? status(401, { code: "unauthenticated" })
        : deltaPage([], call.cursor ?? "x");
    const page = await leaderPage(context, net, "one");
    await expect
      .poll(() => net.calls.length, { timeout: 15_000 })
      .toBeGreaterThan(0);
    const view = await untilLeader(page, (v) =>
      JSON.stringify(v.job).includes("eligible_wait"),
    );
    expect(view.job).toMatchObject({ kind: "eligible_wait" });
    const asked = net.calls.length;
    await page.waitForTimeout(3_000);
    expect(net.calls.length).toBe(asked);
    expect(
      await page.evaluate(() =>
        document.getElementById("protected-root")?.hasAttribute("inert"),
      ),
    ).toBe(true);
    const sync = await syncStateOf(page);
    expect(sync?.cursor).toBe("delta-0");
    expect(sync?.read_retry_states).toEqual({});
  });
});

test.describe("E-B14 and E-B11: local writes of the snapshot in a real engine", () => {
  test("E-B14 three failed writes of a staged page stop it (each a request of the same page); a reload keeps the stop; the retry resumes it", async ({
    context,
  }) => {
    const net = await fresh(context);
    net.answer = (call) =>
      call.cursor === null
        ? snapshotPage(SNAP([1]), "delta-1", false)
        : deltaPage([], call.cursor);
    let page = await leaderPageAfter(context, net, "one", (p) =>
      failStagingWrites(p, 3),
    );
    const stopped = await untilLeader(page, (v) =>
      JSON.stringify(v.job).includes("local_storage"),
    );
    expect(stopped.job).toMatchObject({
      kind: "stopped",
      cause: "local_storage",
    });
    expect(await stagingFaultHits(page)).toBe(3);
    expect(net.calls.map((c) => c.cursor)).toEqual([null, null, null]);
    // The stop is durable: the reloaded page sends nothing. It is reloaded on the queue screen (`/sync`), whose notices are the
    // person's.
    net.label(page, "reloaded");
    page = await leaderPage(context, net, "reloaded", page, { route: "/sync" });
    const still = await untilLeader(page, (v) =>
      JSON.stringify(v.job).includes("local_storage"),
    );
    expect(still.job).toMatchObject({
      kind: "stopped",
      cause: "local_storage",
    });
    await page.waitForTimeout(1_000);
    expect(net.calls.filter((c) => c.page === "reloaded")).toEqual([]);
    // "Retry applying changes": the whole page is asked for again and activates. ADAPTED (R2 of the review of 10 October 2026): the
    // person's VISIBLE action on the notice, not the fixture-only `leaderRetry()` this case first called (a fixture method is not
    // evidence for the action).
    await page
      .getByRole("button", { name: "Retry applying changes", exact: true })
      .click();
    const done = await untilSync(page, (s) => s?.cache_status === "valid");
    expect(done?.cursor).toBe("delta-1");
  });

  test("E-B11 the activation is held open and its page closed: nothing of it is durable, and the next leader adopts the attempt and activates it whole", async ({
    context,
  }) => {
    const net = await fresh(context);
    net.answer = (call) =>
      call.cursor === null
        ? snapshotPage(SNAP([1, 2]), "snap-1", true)
        : call.cursor === "snap-1"
          ? snapshotPage(SNAP([3]), "delta-1", false)
          : deltaPage([], call.cursor);
    const one = await leaderPageAfter(context, net, "one", holdActivation);
    const two = await leaderPage(context, net, "two");
    await expect
      .poll(
        () =>
          one.evaluate(
            () =>
              (window as unknown as { __activationHeld?: number })
                .__activationHeld ?? 0,
          ),
        { timeout: 15_000 },
      )
      .toBeGreaterThan(0);
    await one.close();
    const led = await untilLeader(two, (v) => v.role === "leader");
    expect(led.role).toBe("leader");
    const done = await untilSync(two, (s) => s?.cache_status === "valid");
    expect(done?.cursor).toBe("delta-1");
    // The new leader resumed at the staged position of the final page: it never restarted cursor-less.
    expect(
      net.calls.filter((c) => c.page === "two").map((c) => c.cursor)[0],
    ).toBe("snap-1");
    const cached = (await rowsOf(two, "cache")) as Array<{ id: string }>;
    expect(cached.map((r) => r.id).sort()).toEqual([1, 2, 3].map(uuid).sort());
    expect(await rowsOf(two, "cache_staging")).toEqual([]);
  });
});

test.describe("E-R: matrix 3.7.3 recovery while fenced (the failures)", () => {
  test("E-R4 T24 D: three failed writes of the catch-up page stop it (each a request of the same page); the account stays hidden; the retry applies it and the fence clears", async ({
    context,
  }) => {
    const net = await fencedWithCursor(context);
    net.answer = (call) =>
      call.cursor === "delta-0"
        ? deltaPage([upsert(8, { n: 8 })], "delta-1")
        : deltaPage([], call.cursor ?? "x");
    const page = await leaderPageAfter(context, net, "one", (p) =>
      failStoreWrites(p, "cache", 3),
    );
    const stopped = await untilLeader(page, (v) =>
      JSON.stringify(v.job).includes("local_storage"),
    );
    expect(stopped.job).toMatchObject({
      kind: "stopped",
      cause: "local_storage",
    });
    expect(await storeFaultHits(page, "cache")).toBe(3);
    expect(net.calls.map((c) => c.cursor)).toEqual([
      "delta-0",
      "delta-0",
      "delta-0",
    ]);
    expect(await fencesOf(page)).toHaveLength(1);
    expect(
      await page.evaluate(() =>
        document.getElementById("protected-root")?.hasAttribute("inert"),
      ),
    ).toBe(true);
    expect((await syncStateOf(page))?.cursor).toBe("delta-0");
    // State 3's "Try again": the whole page again, from the same position; then the data commit and `finish`. ADAPTED (R2 of the review
    // of 10 October 2026): the person's VISIBLE action on the neutral state ("Couldn't finish catching up"), not the fixture-only
    // `leaderRetry()` this case first called. The reviewer's comparison (`.agtx/evidence/review-1/native-retry-2*`) found this click did
    // nothing before the fix.
    await expect(
      page.getByRole("heading", { name: "Couldn't finish catching up" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Try again", exact: true }).click();
    await displayed(page);
    expect((await syncStateOf(page))?.cursor).toBe("delta-1");
    expect(await fencesOf(page)).toEqual([]);
    expect(net.calls.map((c) => c.cursor).slice(0, 4)).toEqual([
      "delta-0",
      "delta-0",
      "delta-0",
      "delta-0",
    ]);
  });

  test("E-R6 T24 F: the page closes between the data commit and `finish`: the commit is durable and the fence stands; the next page catches up with one request and clears it", async ({
    context,
  }) => {
    const net = await fencedWithCursor(context);
    net.answer = (call) =>
      call.cursor === "delta-0"
        ? deltaPage([upsert(9, { n: 9 })], "delta-1")
        : deltaPage([], call.cursor ?? "x");
    const one = await leaderPageAfter(
      context,
      net,
      "one",
      holdFinishAfterCommit,
    );
    await expect
      .poll(
        () =>
          one.evaluate(
            () =>
              (window as unknown as { __finishHeld?: boolean }).__finishHeld ===
              true,
          ),
        { timeout: 15_000 },
      )
      .toBe(true);
    await one.close();
    // In a page that runs no session: the data commit is durable, and the fence was not cleared.
    const look = await context.newPage();
    await look.goto("/__session?boot=off");
    await look.waitForFunction(() => window.__atlasData !== undefined);
    expect((await syncStateOf(look))?.cursor).toBe("delta-1");
    expect(await fencesOf(look)).toHaveLength(1);
    await look.close();
    const two = await leaderPage(context, net, "two");
    await displayed(two);
    expect(await fencesOf(two)).toEqual([]);
    expect(
      net.calls.filter((c) => c.page === "two").map((c) => c.cursor)[0],
    ).toBe("delta-1");
    const cached = (await rowsOf(two, "cache")) as Array<{ id: string }>;
    expect(cached.map((r) => r.id)).toContain(uuid(9));
  });

  test("E-R8 T24 H: a current-epoch entry (the settled epoch's own 401) makes the account ineligible: nothing is read and it stays hidden", async ({
    context,
  }) => {
    const net = await leaderNetwork(context);
    const record = fencedAfterReauth();
    // The same entry, but of the settled epoch itself: a current-epoch entry.
    record.fences = {
      [ACCOUNT]: (record.fences[ACCOUNT] ?? []).map((fence) => ({
        ...fence,
        epoch: 2,
      })),
    };
    await seedAuth(context, record);
    await arrange(context, async (page) => {
      await page.evaluate(
        (account) => window.__atlasData?.seedDelta(account, "delta-0"),
        ACCOUNT,
      );
    });
    const page = await leaderPage(context, net, "one");
    const view = await untilLeader(page, (v) =>
      JSON.stringify(v.job).includes("current_epoch_entry"),
    );
    expect(view.job).toMatchObject({
      kind: "eligible_wait",
      reason: "current_epoch_entry",
    });
    await page.waitForTimeout(3_000);
    expect(net.calls).toEqual([]);
    expect(
      await page.evaluate(() =>
        document.getElementById("protected-root")?.hasAttribute("inert"),
      ),
    ).toBe(true);
  });
});

test.describe("E-B12: trace 5 in a real engine", () => {
  test("a healthy page one and an unrecognised page two, across reloads: the whole-attempt counter reaches 3 although page one succeeds every time, and the client stops", async ({
    context,
  }, info) => {
    info.setTimeout(120_000);
    const net = await fresh(context);
    net.answer = (call) =>
      call.cursor === null
        ? snapshotPage(SNAP([1]), "snap-1", true)
        : status(418, { code: "teapot" });
    let page = await leaderPage(context, net, "load-1");
    await untilSync(
      page,
      (s) => (s?.recovery_attempt_streak as number) >= 1,
      ACCOUNT,
      45_000,
    );
    for (const load of [2, 3]) {
      net.label(page, `load-${load}`);
      page = await leaderPage(context, net, `load-${load}`, page);
      await untilSync(
        page,
        (s) => (s?.recovery_attempt_streak as number) >= load,
        ACCOUNT,
        45_000,
      );
    }
    const sync = await syncStateOf(page);
    expect(sync).toMatchObject({
      recovery_attempt_streak: 3,
      sync_error_streak: 0,
    });
    const blocked = await untilLeader(page, (v) =>
      JSON.stringify(v.job).includes("sync_blocked"),
    );
    expect(blocked.job).toMatchObject({
      kind: "stopped",
      cause: "sync_blocked",
      blocked: "attempts",
    });
    // Every cycle's page one succeeded (a cursor-less 200 each time) and never reset the counter.
    expect(
      net.calls.filter((c) => c.cursor === null).length,
    ).toBeGreaterThanOrEqual(3);
    const count = net.calls.length;
    await page.waitForTimeout(3_000);
    expect(net.calls.length).toBe(count);
  });
});
