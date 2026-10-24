import type { Page } from "@playwright/test";
import {
  ACCOUNT,
  abortAuthWritesAfterFinalCommit,
  abortAuthWritesWhenArmed,
  arrange,
  BLOCKED,
  deltaPage,
  displayed,
  draft,
  fencedAfterReauth,
  fencedWithCursor,
  fencesOf,
  fresh,
  goOffline,
  goOnline,
  held,
  holdFinishWhileFlagged,
  leaderNetwork,
  leaderOf,
  leaderPage,
  leaderPageAfter,
  reauthenticatedAt,
  rowsOf,
  SNAP,
  seedAuth,
  settleElsewhere,
  snapshotPage,
  status,
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
 * WEB-09b review cycle 1 (10 October 2026), R9 and the real-engine counterparts of R1 to R3 and R8: the PRODUCTION session, boot
 * composition and leader on `/__session?leader=production` in Chromium, Firefox and macOS WebKit (real Web Locks, real IndexedDB, real
 * BroadcastChannel), the network stubbed by the test. FIXTURE evidence: the `/sync` and verification answers are scripted, there is no
 * backend, and nothing here is integration or release evidence.
 *
 *   E-R7   T24 G and R1: `finish` cannot take its lock, then a second re-authentication; the new epoch catches up BEFORE it finishes;
 *   E-R7b  the same with the other failure outcome: `finish`'s release transaction FAILS (a named abort of `atlas-auth` writes);
 *   E-R10  T24 H and R3: an unverified credential (O11) refuses `begin`; the session's own verification resolves it in the SAME epoch,
 *          with the view still neutral, and the recovery then runs;
 *   E-R12  T24 H and R3: a gating attempt refuses `begin`; another tab finishes it in the same epoch, and the recovery then runs;
 *   E-R13  T24 H: an unresolved lease of the settled epoch is resolved by the session's verification before anything is read;
 *   E-R11  R8: the recovery writes NOTHING of the queue (acknowledged work too); the owed bookkeeping follows the display (W26);
 *   E-B5   case (d): an older owner's held answer is dropped by the ownership guard in a real engine (the newer owner SEEDED);
 *   E-B9   case (e): `409 access_changed` mid-snapshot restarts it cursor-less under a new generation, counting nothing, with the notice;
 *   E-B13u trace 6, the UNRECOGNISED variant: three cursor-less unrecognised answers across reloads block; no fourth automatic request.
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
        {
          violations: oracle.violations(),
          pages: context.pages().length,
          // WEB-08c revision 5: the per-document ledger (diagnostic only; a failed case stays failed).
          ledger: await oracle
            .coverage()
            .catch((error: unknown) => String(error)),
        },
        null,
        1,
      ),
      contentType: "application/json",
    });
    return;
  }
  await oracle.assertClean(testInfo.title);
});

const inert = (page: Page) =>
  page.evaluate(() =>
    document.getElementById("protected-root")?.hasAttribute("inert"),
  );
type TraceEvent = {
  at: number;
  event: string;
  data?: Record<string, unknown>;
};
const traceOf = (page: Page): Promise<TraceEvent[]> =>
  page.evaluate(
    () => (window.__atlasFixture?.session?.trace ?? []) as TraceEvent[],
  );
/** The recovery job's own trace events, in order (a fixed vocabulary: no cursor, no content). */
const jobTrace = async (page: Page) =>
  (await traceOf(page))
    .filter((e) =>
      [
        "data.recovery_begin",
        "data.recovery_request",
        "data.recovery_commit",
        "data.recovery_finish",
      ].includes(e.event),
    )
    .map((e): { event: string; kind?: unknown; result?: unknown } => ({
      event: e.event.replace("data.recovery_", ""),
      ...e.data,
    }));

/**
 * The session's own record of the recovery (review cycle 1, R1; strengthened after MU-1256 survived its first real-engine run): the clearing
 * `finish` must follow a RECOVERY-class read issued at `epoch`, the epoch of the handle it clears. Counting the job's request events is not
 * enough: one catch-up can issue two (a request the session cancels at its post-display hold is issued again), and the ordinary engine's
 * first request after the display reads the same cursor.
 */
async function clearedAfterOwnRead(page: Page, epoch: number) {
  const kernel = await traceOf(page);
  const read = kernel.findIndex(
    (e) =>
      e.event === "request.issued" &&
      e.data?.klass === "recovery" &&
      e.data?.epoch === epoch,
  );
  const cleared = kernel.findIndex(
    (e) => e.event === "data.recovery_finish" && e.data?.result === "cleared",
  );
  expect(
    read,
    `a recovery-class read issued at epoch ${epoch}`,
  ).toBeGreaterThan(-1);
  expect(cleared, "the clearing finish").toBeGreaterThan(read);
}

test.describe("E-R: matrix 3.7.3 recovery while fenced (review cycle 1)", () => {
  test("E-R7 T24 G and R1: a `finish` that cannot take its lock, then a second re-authentication: the new epoch makes its OWN catch-up before it finishes; only then is the fence cleared", async ({
    context,
  }, info) => {
    info.setTimeout(150_000);
    const net = await fencedWithCursor(context);
    net.answer = (call) =>
      call.cursor === "delta-0"
        ? deltaPage([upsert(7, { n: 7 })], "delta-1")
        : call.cursor === "delta-1"
          ? deltaPage([upsert(8, { n: 8 })], "delta-2")
          : deltaPage([], call.cursor ?? "x");
    const page = await leaderPageAfter(
      context,
      net,
      "one",
      holdFinishWhileFlagged,
    );
    // Epoch 2's data commit is made; its `finish` waits for the lock (held) and will answer `lock_timeout` at its own bound.
    await expect
      .poll(
        () =>
          page.evaluate(
            () =>
              (window as unknown as { __finishHeldCount?: number })
                .__finishHeldCount ?? 0,
          ),
        { timeout: 15_000 },
      )
      .toBeGreaterThan(0);
    expect((await syncStateOf(page))?.cursor).toBe("delta-1");
    expect(await fencesOf(page)).toHaveLength(1);
    // A second re-authentication in another tab (epoch 3, the same epoch-1 entry), then the lock is the platform's again.
    await settleElsewhere(context, reauthenticatedAt(3));
    await page.evaluate(() => {
      (window as unknown as { __finishHold?: boolean }).__finishHold = false;
    });
    await displayed(page, 90_000);
    expect(await fencesOf(page)).toEqual([]);
    expect((await syncStateOf(page))?.cursor).toBe("delta-2");
    expect(net.calls.slice(0, 2).map((c) => c.cursor)).toEqual([
      "delta-0",
      "delta-1",
    ]);
    const steps = await jobTrace(page);
    await info.attach("e-r7-job-trace", {
      body: JSON.stringify({ steps, calls: net.calls }, null, 2),
      contentType: "application/json",
    });
    // The finish that clears comes after the SECOND request (epoch 3's own catch-up), never on epoch 2's commit alone.
    const cleared = steps.findIndex(
      (s) => s.event === "finish" && s.result === "cleared",
    );
    const requests = steps
      .map((s, i) => (s.event === "request" ? i : -1))
      .filter((i) => i >= 0);
    expect(requests.length).toBeGreaterThanOrEqual(2);
    expect(cleared).toBeGreaterThan(requests[1] as number);
    // Epoch 3 made its OWN catch-up before the clearing `finish` (the session's trace, not the job's request count).
    await clearedAfterOwnRead(page, 3);
    expect(
      steps.filter((s) => s.event === "finish").map((s) => s.result)[0],
    ).toBe("lock_timeout");
    expect(
      steps.filter((s) => s.event === "begin" && s.kind === "eligible"),
    ).toHaveLength(2);
  });

  test("E-R7b T24 G and R1, the other failure outcome: a `finish` that FAILS (its release transaction aborts), then a second re-authentication: the new epoch makes its own catch-up before it finishes", async ({
    context,
  }, info) => {
    info.setTimeout(150_000);
    const net = await fencedWithCursor(context);
    net.answer = (call) =>
      call.cursor === "delta-0"
        ? deltaPage([upsert(17, { n: 17 })], "delta-1")
        : call.cursor === "delta-1"
          ? deltaPage([upsert(18, { n: 18 })], "delta-2")
          : deltaPage([], call.cursor ?? "x");
    const page = await leaderPageAfter(context, net, "one", (p) =>
      abortAuthWritesAfterFinalCommit(p),
    );
    // Epoch 2's data commit is made; every `atlas-auth` write of this page now aborts, so `finish` answers `failed` (and keeps failing).
    await expect
      .poll(
        async () =>
          (await jobTrace(page)).filter(
            (s) => s.event === "finish" && s.result === "failed",
          ).length,
        { timeout: 30_000 },
      )
      .toBeGreaterThan(0);
    expect((await syncStateOf(page))?.cursor).toBe("delta-1");
    // A second re-authentication in ANOTHER tab (its writes are not this page's), then this page's writes are the platform's again.
    await settleElsewhere(context, reauthenticatedAt(3));
    await page.evaluate(() => {
      (window as unknown as { __abortAuthWrites?: boolean }).__abortAuthWrites =
        false;
    });
    try {
      await displayed(page, 90_000);
    } catch (error) {
      // Kept with the result: what the job and the session were doing when the display did not come.
      await info.attach("e-r7b-not-displayed", {
        body: JSON.stringify(
          {
            leader: await leaderOf(page),
            view: await page.evaluate(() =>
              window.__atlasFixture?.session?.booted?.session.view.get(),
            ),
            steps: await jobTrace(page),
            kernel: (await traceOf(page)).slice(-80),
            calls: net.calls,
          },
          null,
          2,
        ),
        contentType: "application/json",
      });
      throw error;
    }
    expect(await fencesOf(page)).toEqual([]);
    expect((await syncStateOf(page))?.cursor).toBe("delta-2");
    expect(net.calls.slice(0, 2).map((c) => c.cursor)).toEqual([
      "delta-0",
      "delta-1",
    ]);
    const steps = await jobTrace(page);
    await info.attach("e-r7b-job-trace", {
      body: JSON.stringify({ steps, calls: net.calls }, null, 2),
      contentType: "application/json",
    });
    const cleared = steps.findIndex(
      (s) => s.event === "finish" && s.result === "cleared",
    );
    const requests = steps
      .map((s, i) => (s.event === "request" ? i : -1))
      .filter((i) => i >= 0);
    expect(requests.length).toBeGreaterThanOrEqual(2);
    expect(cleared).toBeGreaterThan(requests[1] as number);
    // Epoch 3 made its OWN catch-up before the clearing `finish` (the session's trace, not the job's request count).
    await clearedAfterOwnRead(page, 3);
  });

  test("E-R10 T24 H and R3: an unverified credential refuses `begin`; the session's own O11 verification resolves it in the SAME epoch with the view still neutral, and the recovery then catches up and clears", async ({
    context,
  }) => {
    const net = await fencedWithCursor(context);
    const record = fencedAfterReauth();
    record.fence_seq = 2;
    (record.fences[ACCOUNT] as unknown[]).push({
      seq: 2,
      epoch: 2,
      obs_id: "obs-2",
      created_at: new Date().toISOString(),
      kind: "credential_unverified",
    });
    await seedAuth(context, record);
    const verification = held();
    const answer = net.current;
    net.current = async () => {
      await verification.promise;
      return {
        status: 200,
        body: JSON.stringify({
          account_id: ACCOUNT,
          session_id: "s1",
          expires_at: new Date(Date.now() + 86_400_000).toISOString(),
          csrf_token: "csrf.s1",
        }),
      };
    };
    void answer;
    net.answer = (call) =>
      call.cursor === "delta-0"
        ? deltaPage([upsert(9, { n: 9 })], "delta-1")
        : deltaPage([], call.cursor ?? "x");
    const page = await leaderPage(context, net, "one");
    const waiting = await untilLeader(page, (v) =>
      JSON.stringify(v.job).includes("credential_unverified"),
    );
    expect(waiting.job).toMatchObject({
      kind: "eligible_wait",
      reason: "credential_unverified",
    });
    await page.waitForTimeout(1_000);
    expect(net.calls).toEqual([]);
    expect(await inert(page)).toBe(true);
    const viewBefore = await page.evaluate(
      () => window.__atlasFixture?.session?.booted?.session.view.get().kind,
    );
    expect(viewBefore).toBe("neutral");
    // The verification answers 200 for the same session: O11 clears the `credential_unverified` entry; the account, its epoch and the
    // neutral view are unchanged. The job must still notice and begin.
    verification.release();
    await displayed(page);
    expect(await fencesOf(page)).toEqual([]);
    expect(net.calls[0]?.cursor).toBe("delta-0");
    expect((await syncStateOf(page))?.cursor).toBe("delta-1");
  });

  test("E-R13 T24 H: an unresolved lease of the settled epoch (another tab's request whose outcome is unknown) is resolved by the session's verification before anything is read; then the recovery runs", async ({
    context,
  }) => {
    const net = await fencedWithCursor(context);
    const record = fencedAfterReauth();
    (record as { leases: Record<string, unknown> }).leases = {
      "lease-foreign": {
        account_id: ACCOUNT,
        epoch: 2,
        boot_id: "another-tab",
        class: "ordinary",
        created_at: new Date().toISOString(),
      },
    };
    await seedAuth(context, record);
    net.answer = (call) =>
      call.cursor === "delta-0"
        ? deltaPage([upsert(10, { n: 10 })], "delta-1")
        : deltaPage([], call.cursor ?? "x");
    const page = await leaderPage(context, net, "one");
    await displayed(page);
    const steps = await jobTrace(page);
    // Nothing was read before the lease was resolved: the first `begin` that is eligible precedes the first request.
    const firstEligible = steps.findIndex(
      (s) => s.event === "begin" && s.kind === "eligible",
    );
    const firstRequest = steps.findIndex((s) => s.event === "request");
    expect(firstEligible).toBeGreaterThanOrEqual(0);
    expect(firstRequest).toBeGreaterThan(firstEligible);
    const records = (await page.evaluate(() =>
      window.__atlasFixture?.session?.readRecords(),
    )) as { auth_state: { leases: Record<string, unknown> } };
    expect(Object.keys(records.auth_state.leases)).not.toContain(
      "lease-foreign",
    );
    expect(await fencesOf(page)).toEqual([]);
  });

  test("E-R11 R8: while fenced the recovery writes NOTHING of the queue (an acknowledged draft and its effect too); once the account is displayed the owed bookkeeping releases the acknowledged receipt and leaves unsent work byte-identical", async ({
    context,
  }) => {
    const net = await leaderNetwork(context);
    await seedAuth(context, fencedAfterReauth());
    const ACKED = "11111111-0000-4000-8000-000000000003";
    const acked = draft(ACKED, "acknowledged", 3);
    const ackedHeader = {
      ...acked.header,
      held_pending_cache: true,
      receipt_revision: 15,
      target_resource_ids: [uuid(11)],
    };
    const unsent = draft(BLOCKED, "blocked", 2);
    const effects = [
      {
        resource_id: uuid(11),
        local_id: ACKED,
        receipt_revision: 15,
        no_publication_floor: 0,
        last_mentioned_page_seq: null,
        resolved: null,
        display: { label: "sent" },
      },
    ];
    await arrange(context, async (page) => {
      await page.evaluate(
        async ([account, rows, effectRows]) => {
          const data = window.__atlasData;
          await data?.seedDelta(account, "delta-0");
          await data?.put(
            account,
            "drafts",
            rows.map((r) => r.header),
          );
          await data?.put(
            account,
            "draft_commands",
            rows.map((r) => r.body),
          );
          await data?.put(account, "pending_effects", effectRows);
        },
        [
          ACCOUNT,
          [{ header: ackedHeader, body: acked.body }, unsent],
          effects,
        ] as const,
      );
    });
    const queue = async (page: Page) =>
      JSON.stringify([
        await rowsOf(page, "drafts"),
        await rowsOf(page, "draft_commands"),
        await rowsOf(page, "pending_effects"),
      ]);
    // The catch-up page mentions the acknowledged draft's resource at a revision that covers its receipt.
    const commit = held();
    net.answer = async (call) => {
      if (call.cursor === "delta-0") {
        await commit.promise;
        return deltaPage([upsert(11, { n: 11 })], "delta-1", 20);
      }
      return deltaPage([], call.cursor ?? "x");
    };
    const look = await context.newPage();
    await look.goto("/__session?boot=off");
    await look.waitForFunction(() => window.__atlasData !== undefined);
    const before = await queue(look);
    await look.close();
    const page = await leaderPageAfter(
      context,
      net,
      "one",
      holdFinishWhileFlagged,
    );
    commit.release();
    await expect
      .poll(
        () =>
          page.evaluate(
            () =>
              (window as unknown as { __finishHeldCount?: number })
                .__finishHeldCount ?? 0,
          ),
        { timeout: 15_000 },
      )
      .toBeGreaterThan(0);
    // The data commit is made and the account is still fenced: the whole queue is byte-identical, and the bookkeeping is owed.
    expect((await syncStateOf(page))?.cursor).toBe("delta-1");
    expect(await queue(page)).toBe(before);
    expect((await syncStateOf(page))?.recovery_reconcile_pending).toBe(true);
    await page.evaluate(() => {
      (window as unknown as { __finishHold?: boolean }).__finishHold = false;
    });
    await displayed(page, 60_000);
    const settled = await untilSync(
      page,
      (s) => s?.recovery_reconcile_pending === false,
    );
    expect(settled?.recovery_reconcile_pending).toBe(false);
    const drafts = (await rowsOf(page, "drafts")) as Array<{
      local_id: string;
    }>;
    // The acknowledged, finished draft is released and leaves; the unsent draft and its body are exactly as arranged.
    expect(drafts.map((d) => d.local_id)).toEqual([BLOCKED]);
    const header = drafts[0] as Record<string, unknown>;
    expect({ ...header, created_at: unsent.header.created_at }).toEqual(
      unsent.header,
    );
    expect(
      (
        (await rowsOf(page, "draft_commands")) as Array<{ local_id: string }>
      ).find((b) => b.local_id === BLOCKED),
    ).toEqual(unsent.body);
  });
});

test.describe("E-B: reconciliation row 6 cases (d) and (e), and trace 6's unrecognised variant, in a real engine", () => {
  test("E-B5 case (d): an older owner's held answer is dropped by the ownership guard; nothing of it is staged (the newer owner's token SEEDED, as a takeover would write it)", async ({
    context,
  }) => {
    const net = await fresh(context);
    const stall = held();
    let stalled = 0;
    net.answer = async (call) => {
      if (call.cursor === null) return snapshotPage(SNAP([1]), "snap-1", true);
      if (call.cursor === "snap-1") {
        stalled += 1;
        await stall.promise;
        return snapshotPage(SNAP([2]), "delta-1", false);
      }
      return deltaPage([], call.cursor ?? "x");
    };
    const page = await leaderPage(context, net, "one");
    await untilSync(page, (s) => s?.staging_position === "snap-1");
    await expect.poll(() => stalled, { timeout: 15_000 }).toBe(1);
    // A newer binding owns the database now (SEEDED through the harness: the ownership W20 would write for another binding).
    const seeded = await page.evaluate(async (account) => {
      const data = window.__atlasData;
      const sync = (await data?.syncState(account)) as Record<string, unknown>;
      const owner = {
        ...(sync.owner as Record<string, unknown>),
        ownership_token: "a-newer-binding",
      };
      await data?.put(account, "sync_state", [{ ...sync, owner }]);
      return (await data?.syncState(account)) as Record<string, unknown>;
    }, ACCOUNT);
    const stagedBefore = await rowsOf(page, "cache_staging");
    stall.release();
    // The older owner's final page and activation are dropped (OWN): nothing is staged or activated, and the newer owner is untouched.
    await page.waitForTimeout(2_000);
    const after = await syncStateOf(page);
    expect(after).toMatchObject({
      cache_status: seeded.cache_status,
      staging_position: "snap-1",
      owner: { ownership_token: "a-newer-binding" },
    });
    expect(await rowsOf(page, "cache_staging")).toEqual(stagedBefore);
    expect(await rowsOf(page, "cache")).toEqual([]);
  });

  test("E-B9 case (e): `409 access_changed` on a staged page restarts the snapshot cursor-less under a new generation, counting nothing; the person is told once and Acknowledge only dismisses", async ({
    context,
  }, info) => {
    const net = await fresh(context);
    let refused = 0;
    // The refusal is held until the staged state has been read, so the generation it abandons is the one observed.
    const refusal = held();
    net.answer = async (call) => {
      if (call.cursor === null && refused === 0)
        return snapshotPage(SNAP([1]), "snap-1", true);
      if (call.cursor === "snap-1") {
        refused += 1;
        await refusal.promise;
        return status(409, { code: "access_changed" });
      }
      if (call.cursor === null)
        return snapshotPage(SNAP([3]), "delta-1", false);
      return deltaPage([], call.cursor ?? "x");
    };
    const page = await leaderPage(context, net, "one", undefined, {
      route: "/sync",
    });
    const first = await untilSync(
      page,
      (s) => s?.staging_position === "snap-1",
    );
    expect(first?.staging_position).toBe("snap-1");
    const generation = first?.recovery_generation as number;
    refusal.release();
    const done = await untilSync(page, (s) => s?.cache_status === "valid");
    await info.attach("e-b9-record", {
      body: JSON.stringify(
        {
          first,
          done,
          calls: net.calls,
          leader: await leaderOf(page),
          trace: await jobTrace(page),
        },
        null,
        2,
      ),
      contentType: "application/json",
    });
    expect(done).toMatchObject({
      recovery_generation: generation + 1,
      recovery_attempt_streak: 0,
      sync_error_streak: 0,
      staging_position: null,
    });
    expect(net.calls.slice(0, 3).map((c) => c.cursor)).toEqual([
      null,
      "snap-1",
      null,
    ]);
    const cached = (await rowsOf(page, "cache")) as Array<{ id: string }>;
    expect(cached.map((r) => r.id)).toEqual([uuid(3)]);
    expect(await rowsOf(page, "cache_staging")).toEqual([]);
    // Q24: the automatic restart is told once, with a single Acknowledge that only dismisses it.
    const view = await leaderOf(page);
    expect(view.notice).toMatchObject({ reason: "access_changed" });
    const acknowledge = page.getByRole("button", {
      name: "Acknowledge",
      exact: true,
    });
    await expect(acknowledge).toBeVisible();
    const calls = net.calls.length;
    await acknowledge.click();
    await expect(acknowledge).toHaveCount(0);
    expect((await leaderOf(page)).notice).toBeNull();
    expect(net.calls.length).toBe(calls);
  });

  test("E-B13u trace 6, the UNRECOGNISED variant: three unrecognised cursor-less answers, with a reload between each, reach the blocking state; no fourth automatic request", async ({
    context,
  }) => {
    const net = await fresh(context);
    net.answer = () => status(418, { code: "teapot" });
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
      blocked: "sync_error",
    });
    expect((await syncStateOf(page))?.sync_error_streak).toBe(3);
    const count = net.calls.length;
    await page.waitForTimeout(3_000);
    expect(net.calls.length).toBe(count);
    expect(net.calls).toHaveLength(3);
  });
});

/** Arranges `sync_state` fields of ACCOUNT's database (a FIXTURE arrangement through the harness, before any leader page boots). */
const arrangeSync = (context: Parameters<typeof arrange>[0], patch: object) =>
  arrange(context, async (page) => {
    await page.evaluate(
      async ([account, fields]) => {
        const data = window.__atlasData;
        const sync = (await data?.syncState(account)) as Record<
          string,
          unknown
        >;
        await data?.put(account, "sync_state", [{ ...sync, ...fields }]);
      },
      [ACCOUNT, patch] as const,
    );
  });

test.describe("R2 and R6: a follower page and the recovery owner (review cycle 1)", () => {
  test("E-B15 R2: a FOLLOWER's 'Try again' on the blocking state is applied by the leading page: a fresh budget, one request by the leader, none by the follower", async ({
    context,
  }) => {
    const net = await fresh(context);
    // The whole-attempt budget is at its bound (ARRANGED: as three earlier failed attempts leave it).
    await arrangeSync(context, {
      recovery_attempt_streak: 3,
      recovery_budget_version: 5,
    });
    let healthy = false;
    net.answer = (call) =>
      !healthy
        ? status(400, { code: "bad_request" })
        : call.cursor === null
          ? snapshotPage(SNAP([1]), "delta-1", false)
          : deltaPage([], call.cursor ?? "x");
    const one = await leaderPage(context, net, "one");
    // The page load's one permitted attempt fails; the job stops in the blocking state.
    const blocked = await untilLeader(one, (v) =>
      JSON.stringify(v.job).includes("sync_blocked"),
    );
    expect(blocked.job).toMatchObject({
      kind: "stopped",
      cause: "sync_blocked",
    });
    const two = await leaderPage(context, net, "two", undefined, {
      route: "/sync",
    });
    expect(
      (await untilLeader(two, (v) => v.attachment === "follower")).role,
    ).toBe("follower");
    await expect(
      two
        .getByText("Sync can't proceed on this version of Atlas", {
          exact: false,
        })
        .first(),
    ).toBeVisible();
    const count = net.calls.length;
    await two.waitForTimeout(2_000);
    expect(net.calls).toHaveLength(count);
    healthy = true;
    await two.getByRole("button", { name: "Try again", exact: true }).click();
    const done = await untilSync(one, (s) => s?.cache_status === "valid");
    expect(done).toMatchObject({
      cache_status: "valid",
      recovery_attempt_streak: 0,
    });
    expect(net.calls.slice(count).length).toBeGreaterThan(0);
    expect(net.calls.filter((c) => c.page === "two")).toEqual([]);
    await expect(
      two.getByText("Sync can't proceed on this version of Atlas", {
        exact: false,
      }),
    ).toHaveCount(0);
  });

  test("E-B16 R6 and R2: a follower shows the leader's DURABLE pause ('Updates stopped', 'Retry now'), never 'Up to date'; its 'Retry now' resumes the leader's engine", async ({
    context,
  }) => {
    const net = await fresh(context);
    await arrange(context, async (page) => {
      await page.evaluate(
        (account) => window.__atlasData?.seedDelta(account, "delta-0"),
        ACCOUNT,
      );
    });
    // The `sync` read caller is PAUSED after a sustained failure (ARRANGED as the engine records it), on a cache that has synced.
    await arrangeSync(context, {
      last_synced_at: new Date(Date.now() - 600_000).toISOString(),
      read_retry_states: {
        sync: {
          backing_off_since: Date.now() - 600_000,
          paused: true,
          unrecognised_streak: 0,
        },
      },
    });
    net.answer = () => deltaPage([upsert(12, { n: 12 })], "delta-1");
    const one = await leaderPage(context, net, "one");
    const two = await leaderPage(context, net, "two", undefined, {
      route: "/sync",
    });
    expect(
      (await untilLeader(two, (v) => v.attachment === "follower")).role,
    ).toBe("follower");
    await expect(
      two.getByRole("heading", { name: "Still trying to update" }),
    ).toBeVisible();
    await expect(two.getByText("Up to date")).toHaveCount(0);
    await expect(two.getByText("Updates stopped").first()).toBeVisible();
    await two.waitForTimeout(1_000);
    expect(net.calls).toEqual([]);
    await two.getByRole("button", { name: "Retry now", exact: true }).click();
    const done = await untilSync(one, (s) => s?.cursor === "delta-1");
    expect(done?.cursor).toBe("delta-1");
    const retry = done?.read_retry_states as
      | { sync?: { paused: boolean } }
      | undefined;
    expect(retry?.sync?.paused).toBe(false);
    expect(net.calls.map((c) => c.page)).toEqual(net.calls.map(() => "one"));
    await expect(
      two.getByRole("heading", { name: "Still trying to update" }),
    ).toHaveCount(0);
  });
});

test.describe("T24 H: a gating attempt (review cycle 1, R3)", () => {
  test("E-R12 T24 H and R3: a gating attempt refuses `begin`; when it is resolved in the SAME epoch (another tab finished it), the recovery runs with no other change", async ({
    context,
  }) => {
    const net = await fencedWithCursor(context);
    const record = fencedAfterReauth();
    const gating = {
      ...record,
      attempt: {
        epoch: 3,
        method: "password",
        phase: "activating",
        previous_account_id: ACCOUNT,
        target_account_id: ACCOUNT,
        verifier: "v".repeat(43),
        observations_deferred: null,
        cancel_result: null,
        started_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + 600_000).toISOString(),
      },
    };
    await seedAuth(context, gating);
    net.answer = (call) =>
      call.cursor === "delta-0"
        ? deltaPage([upsert(13, { n: 13 })], "delta-1")
        : deltaPage([], call.cursor ?? "x");
    const page = await leaderPage(context, net, "one");
    const waiting = await untilLeader(page, (v) =>
      JSON.stringify(v.job).includes("attempt_gating"),
    );
    expect(waiting.job).toMatchObject({
      kind: "eligible_wait",
      reason: "attempt_gating",
    });
    await page.waitForTimeout(1_000);
    expect(net.calls).toEqual([]);
    expect(await inert(page)).toBe(true);
    // Another tab's attempt ends (it was not for this page) and the record is as it was before it: the same account and epoch.
    await settleElsewhere(context, record);
    await displayed(page);
    expect(net.calls[0]?.cursor).toBe("delta-0");
    expect(await fencesOf(page)).toEqual([]);
  });
});

/** A settled record of `account` at `epoch` (a sign-in, in this or another tab). */
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
const B = "22222222-2222-4222-8222-222222222222";
const LEADER_LOCK = "atlas-sync-leader";
/** From a page that runs no session: is the leader's lock free? (`ifAvailable`: a probe that never queues; never `locks.query`.) */
async function lockProbe(context: Parameters<typeof arrange>[0]) {
  const probe = await context.newPage();
  await probe.goto("/__session?boot=off");
  await probe.waitForFunction(() => window.__atlasData !== undefined);
  return () =>
    probe.evaluate(
      (name) =>
        navigator.locks.request(
          name,
          { ifAvailable: true },
          async (lock) => lock !== null,
        ),
      LEADER_LOCK,
    );
}

test.describe("reconciliation row 6: lock scope and case (f) across real account switches (review cycle 1, R9)", () => {
  test("E-B8 lock scope: the leader's ONE lock is never released across A to B to A and a re-authentication; a probe from another page is refused throughout and the follower is never granted", async ({
    context,
  }) => {
    const net = await fresh(context);
    const one = await leaderPage(context, net, "one");
    await untilSync(one, (s) => s?.cache_status === "valid");
    const two = await leaderPage(context, net, "two");
    expect(
      (await untilLeader(two, (v) => v.attachment === "follower")).role,
    ).toBe("follower");
    const free = await lockProbe(context);
    expect(await free()).toBe(false);
    for (const [account, epoch, session] of [
      [B, 2, "s2"],
      [ACCOUNT, 3, "s3"],
      [ACCOUNT, 4, "s4"],
    ] as const) {
      net.identity = { account, session };
      await settleElsewhere(context, settledAt(account, epoch, session));
      // The leading page follows the new settlement (its binding moves to the account, whose cache it brings up to date).
      const synced = await untilSync(
        one,
        (s) => s?.cache_status === "valid",
        account,
      );
      expect(synced?.cache_status, `${account}@${epoch}`).toBe("valid");
      expect(await free(), `${account}@${epoch}`).toBe(false);
      expect((await leaderOf(one)).role, `${account}@${epoch}`).toBe("leader");
      expect((await leaderOf(two)).role, `${account}@${epoch}`).toBe(
        "follower",
      );
    }
    // Only the follower's page never issued `/sync`.
    expect(net.calls.filter((c) => c.page !== "one")).toEqual([]);
  });

  test("E-B7 case (f) variant 2: a command stalls in flight under A; B binds; A's late answer is discarded; A returns and the command is sent again ONCE, with its original key", async ({
    context,
  }) => {
    const net = await leaderNetwork(context);
    await seedAuth(context);
    const queued = draft(QUEUED_F, "queued", 1);
    await arrange(context, async (page) => {
      await page.evaluate(
        async ([account, row]) => {
          const data = window.__atlasData;
          await data?.seedDelta(account, "delta-0");
          await data?.put(account, "drafts", [row.header]);
          await data?.put(account, "draft_commands", [row.body]);
        },
        [ACCOUNT, queued] as const,
      );
    });
    const stall = held();
    let stalled = false;
    net.command = async () => {
      if (!stalled) {
        stalled = true;
        await stall.promise;
      }
      return status(200, { revision: 300 + net.commands.length });
    };
    const one = await leaderPage(context, net, "one");
    await expect.poll(() => net.commands.length, { timeout: 15_000 }).toBe(1);
    net.identity = { account: B, session: "s2" };
    await settleElsewhere(context, settledAt(B, 2, "s2"));
    await untilSync(one, (s) => s?.cache_status === "valid", B);
    // A's late answer arrives while B is bound: it is discarded (nothing of it is written to A's database).
    stall.release();
    await one.waitForTimeout(1_000);
    const pending = (await rowsOf(one, "drafts")) as Array<{
      local_id: string;
      status: string;
    }>;
    expect(pending.find((d) => d.local_id === QUEUED_F)?.status).not.toBe(
      "acknowledged",
    );
    expect(net.commands).toHaveLength(1);
    net.identity = { account: ACCOUNT, session: "s3" };
    await settleElsewhere(context, settledAt(ACCOUNT, 3, "s3"));
    await expect.poll(() => net.commands.length, { timeout: 30_000 }).toBe(2);
    await one.waitForTimeout(2_000);
    expect(net.commands.map((c) => [c.page, c.key])).toEqual([
      ["one", QUEUED_F],
      ["one", QUEUED_F],
    ]);
  });

  test("E-B6 case (f) variant 1: a delta read of A stalls; A is logged out and its database wiped; B signs in; then A again: the stalled answer writes nothing to the second A database", async ({
    context,
  }, info) => {
    info.setTimeout(120_000);
    const net = await fresh(context);
    const stall = held();
    let stalled = false;
    let incarnationOfA = 0;
    net.answer = async (call) => {
      if (net.identity.account === B)
        return call.cursor === null
          ? snapshotPage(SNAP([2]), "delta-b1", false)
          : deltaPage([], call.cursor);
      if (call.cursor === null) {
        incarnationOfA += 1;
        return incarnationOfA === 1
          ? snapshotPage(SNAP([1]), "delta-a1", false)
          : snapshotPage(SNAP([3]), "delta-a2", false);
      }
      if (call.cursor === "delta-a1" && !stalled) {
        stalled = true;
        await stall.promise;
        return deltaPage([upsert(99, { n: 99 })], "delta-stale");
      }
      return deltaPage([], call.cursor);
    };
    const one = await leaderPage(context, net, "one");
    const first = await untilSync(one, (s) => s?.cursor === "delta-a1");
    await expect.poll(() => stalled, { timeout: 15_000 }).toBe(true);
    const firstIncarnation = first?.incarnation_id;
    // A confirmed logout of A (no unsynced work): the DELETE is answered confirmed, and A's database is wiped.
    const started = await one.evaluate(async () => {
      const session = window.__atlasFixture?.session?.booted?.session;
      if (!session) throw new Error("no session");
      const unsynced = await session.operations.summariseLocalWork();
      if (!unsynced) throw new Error("nobody is settled");
      return session.operations.logout({ unsynced });
    });
    expect(started?.kind).toBe("started");
    await expect.poll(() => net.logouts.length, { timeout: 15_000 }).toBe(1);
    const name = `atlas-${ACCOUNT}`;
    await expect
      .poll(
        async () =>
          (
            (await one.evaluate(
              () => window.__atlasData?.list() ?? [],
            )) as string[]
          ).some((n) => n.includes(ACCOUNT)),
        { timeout: 15_000, message: `${name} should be wiped` },
      )
      .toBe(false);
    net.identity = { account: B, session: "s2" };
    await settleElsewhere(context, settledAt(B, 2, "s2"));
    await untilSync(one, (s) => s?.cache_status === "valid", B);
    net.identity = { account: ACCOUNT, session: "s3" };
    await settleElsewhere(context, settledAt(ACCOUNT, 3, "s3"));
    const second = await untilSync(one, (s) => s?.cursor === "delta-a2");
    expect(second?.incarnation_id).not.toBe(firstIncarnation);
    // The first A database's stalled answer now arrives: it writes nothing to the second.
    stall.release();
    await one.waitForTimeout(2_000);
    const after = await syncStateOf(one);
    expect(after?.cursor).toBe("delta-a2");
    expect(after?.incarnation_id).toBe(second?.incarnation_id);
    const cached = (await rowsOf(one, "cache")) as Array<{ id: string }>;
    expect(cached.map((r) => r.id)).toEqual([uuid(3)]);
  });
});
const QUEUED_F = "11111111-0000-4000-8000-000000000007";

test.describe("T24 C, the aborted-recording variant (review cycle 1, R9)", () => {
  test("E-R3b a recovery-time 401 whose recording is ABORTED; every tab closed; an OFFLINE reload reads nothing and counts nothing; back online the session's own verification records the current-epoch entry, and the account stays hidden with nothing read", async ({
    context,
  }, info) => {
    info.setTimeout(120_000);
    const net = await fencedWithCursor(context);
    let leader: Page | null = null;
    let armed = false;
    net.answer = async (call) => {
      if (call.cursor === "delta-0" && !armed && leader !== null) {
        armed = true;
        // From the moment the 401 is served, this page's writes to `atlas-auth` abort: its recording cannot commit.
        await leader.evaluate(() => {
          (
            window as unknown as { __abortAuthWrites?: boolean }
          ).__abortAuthWrites = true;
        });
        return status(401, { code: "unauthenticated" });
      }
      return deltaPage([], call.cursor ?? "x");
    };
    leader = await leaderPageAfter(
      context,
      net,
      "one",
      abortAuthWritesWhenArmed,
    );
    const one = leader;
    await expect
      .poll(
        () =>
          one.evaluate(
            () =>
              (window as unknown as { __abortedAuthWrites?: number })
                .__abortedAuthWrites ?? 0,
          ),
        { timeout: 15_000 },
      )
      .toBeGreaterThan(0);
    const stopped = await untilLeader(one, (v) =>
      JSON.stringify(v.job).includes("eligible_wait"),
    );
    // The run stops for the session with nothing more asked: the 401's own outcome (`current_epoch_entry`), or, once this page's record
    // reads fail too under the injected abort, `stale` (the record cannot be read; paced, never a request).
    expect(stopped.job).toMatchObject({ kind: "eligible_wait" });
    expect(["current_epoch_entry", "stale"]).toContain(
      (stopped.job as { reason: string }).reason,
    );
    await one.waitForTimeout(2_000);
    expect(net.calls).toHaveLength(1);
    // Every tab closes before any retry of the recording commits.
    await one.close();
    const look = await context.newPage();
    await look.goto("/__session?boot=off");
    await look.waitForFunction(
      () => window.__atlasFixture?.session !== undefined,
    );
    const left = (await look.evaluate(() =>
      window.__atlasFixture?.session?.readRecords(),
    )) as {
      auth_state: {
        fences: Record<string, Array<{ epoch: number }>>;
        leases: Record<string, unknown>;
      };
    };
    // Atomic: the recording changed nothing; the request's lease is still in the record, unresolved.
    expect(left.auth_state.fences[ACCOUNT]?.map((f) => f.epoch)).toEqual([1]);
    expect(Object.keys(left.auth_state.leases)).toHaveLength(1);
    await look.close();
    // An OFFLINE reload: the page is loaded, then the browser goes offline before the session starts.
    net.current = () => status(401, { code: "unauthenticated" });
    net.offline = true;
    const two = await leaderPageAfter(context, net, "two", goOffline);
    await two.waitForTimeout(3_000);
    expect(net.calls.filter((c) => c.page === "two")).toEqual([]);
    expect(await inert(two)).toBe(true);
    const offlineView = await two.evaluate(() =>
      window.__atlasFixture?.session?.booted?.session.view.get(),
    );
    expect(offlineView).toMatchObject({ kind: "neutral" });
    // Back online: one verification answers 401; the unresolved lease becomes a CURRENT-epoch entry; nothing is read.
    net.offline = false;
    await goOnline(two);
    await expect
      .poll(
        async () =>
          ((await fencesOf(two)) as Array<{ epoch: number }>).map(
            (f) => f.epoch,
          ),
        { timeout: 60_000 },
      )
      .toContain(2);
    await two.waitForTimeout(3_000);
    expect(net.calls.filter((c) => c.page === "two")).toEqual([]);
    expect(await inert(two)).toBe(true);
    const sync = await syncStateOf(two);
    expect(sync?.cursor).toBe("delta-0");
    expect(sync?.read_retry_states).toEqual({});
    expect(sync?.sync_error_streak ?? 0).toBe(0);
    expect(sync?.recovery_attempt_streak ?? 0).toBe(0);
    await info.attach("e-r3b-offline-view", {
      body: JSON.stringify({ offlineView, calls: net.calls }, null, 2),
      contentType: "application/json",
    });
  });
});

/**
 * WEB-09b review cycle 2 (10 October 2026), R3 and R7 at their real boundaries (FIXTURE evidence, as above):
 *
 *   E-R14c control: an eligible recovery with nothing in its way catches up and the account is displayed;
 *   E-R14  R3: the cover CLOSES after `begin` said eligible (another tab adds an unverified credential while the recovery request waits
 *          to be admitted, the reviewer's schedule of cycle 2), then the session's own O11 verification resolves it in the SAME epoch:
 *          the job waits without sending, then begins again and the account is displayed;
 *   E-R15  R3: the page cannot get its CSRF token (`/browser-sessions/current` fails), so every recovery request is refused BEFORE it is
 *          sent (`not_sent`) beyond the immediate retries; nothing is sent to `/sync` meanwhile; once verification answers again the job's
 *          paced attempt recovers with no notification;
 *   E-R16c control: the authorised current read through the production controller returns the server's current value;
 *   E-R16  R7: the read's LATER interpretation is held; ANOTHER tab re-authenticates the account (epoch 2) and posts NO hint, so this
 *          page's identity still names epoch 1; the read's whole result is refused at the durable record.
 *
 * The request of E-R14 is held by wrapping the page's own `session.api.fetchFor` (test instrumentation that orders the call; the
 * refusal is the real cover's). E-R16's command is a TEST-ONLY kind registered in a private registry (`currentRead`, fixture only).
 */
const admissionTrace = async (page: Page) =>
  (await traceOf(page))
    .filter((e) => e.event === "data.recovery_admission")
    .map((e) => e.data ?? {});

test.describe("review cycle 2: R3 refusals before sending, and R7's final release, in a real engine", () => {
  test("E-R14c control: an eligible recovery with nothing in its way catches up and the account is displayed", async ({
    context,
  }) => {
    const net = await fencedWithCursor(context);
    net.answer = (call) =>
      deltaPage(
        [],
        call.cursor === "delta-0" ? "delta-1" : (call.cursor ?? "x"),
      );
    const page = await leaderPage(context, net, "control");
    await displayed(page);
    expect(await fencesOf(page)).toEqual([]);
    expect((await syncStateOf(page))?.cursor).toBe("delta-1");
    expect(await admissionTrace(page)).toEqual([]);
  });

  test("E-R14 R3: the cover closes AFTER `begin` (another tab adds an unverified credential); the job waits without sending; the session's own O11 verification resolves it in the same epoch and the recovery then runs", async ({
    context,
  }, info) => {
    info.setTimeout(90_000);
    const net = await fencedWithCursor(context);
    net.answer = (call) =>
      call.cursor === "delta-0"
        ? {
            status: 200,
            body: JSON.stringify({
              phase: "delta",
              batches: [],
              next_cursor: "delta-mid",
              has_more: true,
            }),
          }
        : deltaPage([], "delta-1");
    const page = await leaderPageAfter(context, net, "leader", async (p) =>
      p.evaluate(() => {
        const harness = window.__atlasFixture?.session;
        if (!harness) throw new Error("no harness");
        const flags = window as unknown as {
          __requestHeld?: boolean;
          __releaseRequest?: () => void;
          __requestOutcomes?: string[];
        };
        flags.__requestOutcomes = [];
        const push = harness.trace.push.bind(harness.trace);
        let installed = false;
        harness.trace.push = (...events) => {
          const result = push(...events);
          if (
            !installed &&
            events.some(
              (e) =>
                e.event === "data.recovery_begin" &&
                e.data?.kind === "eligible",
            )
          ) {
            installed = true;
            const api = harness.booted?.session.api;
            if (!api) throw new Error("no session");
            const original = api.fetchFor.bind(api);
            let count = 0;
            api.fetchFor = (klass, account, epoch) => {
              const fetch = original(klass, account, epoch);
              return async (request) => {
                // The SECOND recovery call (the first one establishes the page's token) waits before it is admitted.
                if (klass === "recovery" && ++count === 2) {
                  flags.__requestHeld = true;
                  await new Promise<void>((resolve) => {
                    flags.__releaseRequest = resolve;
                  });
                }
                try {
                  return await fetch(request);
                } catch (error) {
                  flags.__requestOutcomes?.push(
                    (error as { kind?: string }).kind ?? String(error),
                  );
                  throw error;
                }
              };
            };
          }
          return result;
        };
      }),
    );
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window as unknown as { __requestHeld?: boolean }).__requestHeld,
        ),
      )
      .toBe(true);
    // Another tab adds a current-epoch unverified credential; the session starts its O11 verification, which is held.
    const verification = held();
    let verifies = 0;
    net.current = async () => {
      verifies += 1;
      await verification.promise;
      return {
        status: 200,
        body: JSON.stringify({
          account_id: ACCOUNT,
          session_id: "s1",
          expires_at: new Date(Date.now() + 86_400_000).toISOString(),
          csrf_token: "csrf.s1",
        }),
      };
    };
    const record = fencedAfterReauth();
    record.fence_seq = 2;
    (record.fences[ACCOUNT] as unknown[]).push({
      seq: 2,
      epoch: 2,
      obs_id: "cycle-2-mid-request",
      created_at: new Date().toISOString(),
      kind: "credential_unverified",
    });
    await settleElsewhere(context, record);
    await expect.poll(() => verifies, { timeout: 15_000 }).toBeGreaterThan(0);
    await page.evaluate(() =>
      (
        window as unknown as { __releaseRequest: () => void }
      ).__releaseRequest(),
    );
    await expect
      .poll(
        () =>
          page.evaluate(
            () =>
              (window as unknown as { __requestOutcomes: string[] })
                .__requestOutcomes,
          ),
        { timeout: 15_000 },
      )
      .toContain("closed");
    // The refusal is an explicit wait: nothing is sent while the gate stands.
    const waiting = await untilLeader(page, (v) =>
      JSON.stringify(v.job).includes("admission_wait"),
    );
    expect(waiting.job).toMatchObject({
      kind: "admission_wait",
      mode: "recovery",
    });
    const sentAtRefusal = net.calls.length;
    await page.waitForTimeout(1_000);
    expect(net.calls).toHaveLength(sentAtRefusal);
    expect(await inert(page)).toBe(true);
    // O11 resolves the credential in the same epoch; the view stays neutral.
    verification.release();
    try {
      await displayed(page);
    } finally {
      await info.attach("e-r14-trace", {
        body: JSON.stringify(
          {
            leader: await leaderOf(page),
            calls: net.calls,
            admission: await admissionTrace(page),
            trace: await traceOf(page),
          },
          null,
          2,
        ),
        contentType: "application/json",
      });
    }
    expect(await fencesOf(page)).toEqual([]);
    expect((await syncStateOf(page))?.cursor).toBe("delta-1");
    const admission = await admissionTrace(page);
    expect(admission).toContainEqual(
      expect.objectContaining({ phase: "wait", cause: "closed" }),
    );
    expect(admission).toContainEqual(
      expect.objectContaining({ phase: "resume", cause: "closed" }),
    );
    // The session issued a recovery-class read at epoch 2 AFTER the refusal (a real request, not a wrapper call) before it cleared.
    await clearedAfterOwnRead(page, 2);
  });

  test("E-R15 R3: the page cannot get its CSRF token, so every recovery request is refused before it is sent beyond the immediate retries; nothing reaches `/sync`; when verification answers again the paced attempt recovers with no notification", async ({
    context,
  }, info) => {
    info.setTimeout(120_000);
    const net = await fencedWithCursor(context);
    net.answer = (call) =>
      deltaPage(
        [],
        call.cursor === "delta-0" ? "delta-1" : (call.cursor ?? "x"),
      );
    let verifies = 0;
    let failing = true;
    net.current = () => {
      verifies += 1;
      if (failing) return status(503, { code: "unavailable" });
      return {
        status: 200,
        body: JSON.stringify({
          account_id: ACCOUNT,
          session_id: "s1",
          expires_at: new Date(Date.now() + 86_400_000).toISOString(),
          csrf_token: "csrf.s1",
        }),
      };
    };
    const page = await leaderPage(context, net, "leader");
    const waiting = await untilLeader(
      page,
      (v) => JSON.stringify(v.job).includes("admission_wait"),
      30_000,
    );
    expect(waiting.job).toMatchObject({
      kind: "admission_wait",
      mode: "recovery",
    });
    expect(net.calls).toEqual([]);
    const verifiesAtWait = verifies;
    // A few seconds: the paced attempts are bounded (1 s doubling), never a burst.
    await page.waitForTimeout(3_000);
    expect(verifies - verifiesAtWait).toBeLessThanOrEqual(3);
    expect(net.calls).toEqual([]);
    expect(await inert(page)).toBe(true);
    // Verification answers again. Nothing notifies the job: its own paced attempt fetches the token and the recovery runs.
    failing = false;
    try {
      await displayed(page, 60_000);
    } finally {
      await info.attach("e-r15-trace", {
        body: JSON.stringify(
          {
            leader: await leaderOf(page),
            verifies,
            calls: net.calls,
            admission: await admissionTrace(page),
            trace: await traceOf(page),
          },
          null,
          2,
        ),
        contentType: "application/json",
      });
    }
    expect((await syncStateOf(page))?.cursor).toBe("delta-1");
    expect(await admissionTrace(page)).toContainEqual(
      expect.objectContaining({ phase: "wait", cause: "not_sent" }),
    );
    // Nothing was counted by the unsent attempts: the read caller's state is the clean one the successful read wrote.
    expect(
      (
        (await syncStateOf(page))?.read_retry_states as
          | Record<string, unknown>
          | undefined
      )?.sync,
    ).toMatchObject({
      paused: false,
      backing_off_since: null,
      unrecognised_streak: 0,
    });
  });

  async function currentReadPage(context: Parameters<typeof fresh>[0]) {
    const net = await fresh(context);
    await arrange(context, async (page) => {
      const row = draft(BLOCKED, "blocked", 1);
      await page.evaluate(
        async ([account, header, body]) => {
          await window.__atlasData?.put(account, "drafts", [header]);
          await window.__atlasData?.put(account, "draft_commands", [body]);
        },
        [ACCOUNT, row.header, row.body] as const,
      );
    });
    const reads: string[] = [];
    await context.route("**/api/experimental/v1/tasks/**", (route) => {
      reads.push(new URL(route.request().url()).pathname);
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ label: "Currently saved", version: 7 }),
      });
    });
    const page = await leaderPage(context, net, "reader");
    await displayed(page);
    return { net, page, reads };
  }

  test("E-R16c control: the authorised current read through the production controller returns the server's current value", async ({
    context,
  }) => {
    const { page, reads } = await currentReadPage(context);
    const result = await page.evaluate(
      (id) => window.__atlasFixture?.session?.currentRead(id),
      BLOCKED,
    );
    expect(result).toMatchObject({
      kind: "loaded",
      value: { label: "Currently saved", version: 7 },
    });
    expect(reads).toEqual([`/api/experimental/v1/tasks/${BLOCKED}`]);
  });

  test("E-R16 R7: the read's later interpretation is held; ANOTHER tab re-authenticates (epoch 2) and posts NO hint; the page still names epoch 1, and the whole result is refused at the durable record", async ({
    context,
  }) => {
    const { page, reads } = await currentReadPage(context);
    await page.evaluate(() => {
      (window as unknown as { __currentReadHold: boolean }).__currentReadHold =
        true;
    });
    const pending = page.evaluate(
      (id) => window.__atlasFixture?.session?.currentRead(id),
      BLOCKED,
    );
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window as unknown as { __currentReadHeld?: boolean })
              .__currentReadHeld,
        ),
      )
      .toBe(true);
    // Another tab settles epoch 2 of the same account and its hint is never posted: only the durable record knows.
    const other = await context.newPage();
    await other.goto("/__session?boot=off");
    await other.waitForFunction(
      () => window.__atlasFixture?.session !== undefined,
    );
    await other.evaluate(async (account) => {
      await window.__atlasFixture?.session?.seedAuthState({
        schema: 1,
        latest_epoch: 2,
        fence_seq: 0,
        attempt: null,
        settled: {
          account_id: account,
          epoch: 2,
          settled_at: new Date().toISOString(),
          session_id: "s2",
        },
        fences: {},
        leases: {},
      });
    }, ACCOUNT);
    await other.close();
    expect(
      await page.evaluate(
        () =>
          window.__atlasFixture?.session?.booted?.session.identity.get()?.epoch,
      ),
    ).toBe(1);
    await page.evaluate(() => {
      (window as unknown as { __currentReadHold: boolean }).__currentReadHold =
        false;
    });
    expect(await pending).toEqual({ kind: "failed", reason: "unavailable" });
    expect(reads).toHaveLength(1);
  });
});
