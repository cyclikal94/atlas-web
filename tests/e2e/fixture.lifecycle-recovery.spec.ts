import type { BrowserContext, Page } from "@playwright/test";
import {
  ACCOUNT,
  arrange,
  BLOCKED,
  deltaPage,
  displayed,
  fencedAfterReauth,
  fencedWithCursor,
  fencesOf,
  goOffline,
  goOnline,
  held,
  holdFinishAfterCommit,
  holdFinishWhileFlagged,
  type LeaderNet,
  leaderNetwork,
  leaderOf,
  leaderPage,
  leaderPageAfter,
  QUEUED,
  rowsOf,
  type Scripted,
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
import { type DisplayOracle, installDisplayOracle } from "./display-oracle";
import { expect, test } from "./helpers";

/**
 * WEB-08c revision 3 (R5 of the review of 14 October 2026; design assessment P1/P2, S4–S12): T24's branches that no existing case
 * composed, over the PRODUCTION session, boot and leader (`/__session?leader=production`) in Chromium, Firefox and macOS WebKit: real
 * Web Locks, real IndexedDB and BroadcastChannel; `/sync`, the verification and the commands stubbed and scripted by the test, as T24's
 * working-client checks allow (fake/real locks, a fault-injecting IndexedDB, a stub `/sync`). FIXTURE evidence: no backend, nothing here
 * is integration or release evidence. The existing WEB-09b cases these build on (E-R1–E-R16, E-B9) keep their own scope; the mapping is
 * in `docs/lifecycle-evidence.md`.
 *
 * Every case runs under the qualified continuous display oracle (`display-oracle.ts`): no page of the context mounts or lifts the account,
 * or shows a protected title or the account's name, before its OWN last committed `atlas-auth` record shows the account settled with no
 * fence. Every boundary before the display compares the WHOLE retained work (drafts, command bodies, pending effects, unfinished forms)
 * byte for byte with the baseline taken before the recovery could run; replay is allowed only after the display (T24 E).
 *
 *   LR-1  A, E, S4, S13: two catch-up pages (an access removal in the first), the final page HELD, then `finish` HELD after the final data
 *         commit; a follower page opened mid-recovery; each page is displayed by its own exposure; the queued draft is sent once, after.
 *   LR-2  B′: a 410, a snapshot whose second staged page answers `409 access_changed`: the staged generation is abandoned, never active;
 *         the restarted snapshot is activated whole; only then the clear and the display.
 *   LR-3  C: the FIRST catch-up page commits; the SECOND answers 401: a current-epoch entry is recorded for the RECOVERY request itself,
 *         the committed page stays, nothing more is read; a re-authentication (epoch 3) catches up and clears BOTH entries.
 *   LR-4  C3: after the final data commit, while `finish` waits, another tab records a current-epoch entry: `finish` answers NOT_ELIGIBLE
 *         and clears nothing.
 *   LR-5  C3, the other outcome: an entry of the OLDER epoch above the captured `s`: `finish` answers RERUN, keeps it, catches up again and
 *         clears both.
 *   LR-6  D: an injected QUOTA error on the second row of the catch-up page: nothing of the page is durable (one transaction), the fence
 *         stands, state 3 at once (the recorded policy of the recovery job: a quota failure is not counted); the FOLLOWER's "Try again"
 *         makes the leader ask for the whole page again, which applies; then the clear and the display.
 *   LR-7  F: the page closes between the data commit and the clear; the next page boots OFFLINE: the fence stands, nothing is read or shown;
 *         online, the recovery finds nothing to apply and clears at once.
 *   LR-8  H(ii): an operation entry: the recovery does not start and nothing is read while the operation is unresolved.
 *   LR-9  H(iv): an unresolved lease of the OLDER epoch from a dead page is converted (E5) and the recovery then covers it.
 *   LR-10 G: a second re-authentication while the recovery's first read is in flight: the old epoch's answer is dropped and writes
 *         nothing; the new epoch makes its own catch-up before the clear.
 */
const MARKERS = ["alice"];
const KEPT = "00000000-0000-4000-8000-000000000040";
const FORM = {
  form_context: "task-editor:new",
  tab_instance_id: "tab-retained",
  fields: { title: "Unfinished task", notes: "typed before the revocation" },
  redacted: [],
  saved_at: new Date().toISOString(),
  capture_seq: 3,
  writer_gen: 1,
  terminal: false,
  content_digest: "f".repeat(64),
};

/** A delta page that is not the last (`has_more`). */
const morePage = (changes: unknown[], next: string): Scripted => ({
  status: 200,
  body: JSON.stringify({
    phase: "delta",
    batches: changes.length === 0 ? [] : [{ revision: 20, changes }],
    next_cursor: next,
    has_more: true,
  }),
});
const remove = (id: string) => ({ kind: "remove", id });

/** Canonical JSON (object keys sorted, arrays sorted by their canonical text), so a comparison is of content, byte for byte. */
const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).sort().join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.keys(value as object)
      .sort()
      .map(
        (k) =>
          `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`,
      )
      .join(",")}}`;
  return JSON.stringify(value);
};
/** The WHOLE retained work of the account: queued and blocked drafts, their bodies, pending effects and unfinished forms. */
async function retainedWork(page: Page): Promise<string> {
  const stores = [
    "drafts",
    "draft_commands",
    "pending_effects",
    "form_recovery",
  ] as const;
  const out: Record<string, unknown> = {};
  for (const store of stores) out[store] = await rowsOf(page, store);
  return canonical(out);
}
const exposed = (page: Page) =>
  page.evaluate(() => {
    const root = document.getElementById("protected-root");
    return {
      inert: root?.hasAttribute("inert") ?? null,
      children: root?.childNodes.length ?? null,
    };
  });
const HIDDEN = { inert: true, children: 0 };
const cacheIds = async (page: Page) =>
  ((await rowsOf(page, "cache")) as Array<{ id: string }>)
    .map((r) => r.id)
    .sort();
type TraceEvent = { event: string; data?: Record<string, unknown> };
const traceOf = (page: Page): Promise<TraceEvent[]> =>
  page.evaluate(
    () => (window.__atlasFixture?.session?.trace ?? []) as TraceEvent[],
  );
const finishResults = async (page: Page) =>
  (await traceOf(page))
    .filter((e) => e.event === "data.recovery_finish")
    .map((e) => e.data?.result);
type Records = {
  auth_state: {
    latest_epoch: number;
    fence_seq: number;
    settled: { account_id: string; epoch: number; session_id: string };
    fences: Record<string, Array<Record<string, unknown>>>;
    leases: Record<string, unknown>;
  };
};
const recordsOf = (page: Page) =>
  page.evaluate(() =>
    window.__atlasFixture?.session?.readRecords(),
  ) as Promise<Records>;
/** The account's database arranged with an unfinished form beside the queued and blocked drafts of `fencedWithCursor`. */
const withForm = (context: BrowserContext) =>
  arrange(context, async (page) => {
    await page.evaluate(
      ([account, form]) =>
        window.__atlasData?.put(account, "form_recovery", [form]),
      [ACCOUNT, FORM] as const,
    );
  });
/** The queued draft replays once, after the display, by the leader, under its own key; nothing of it was sent before. */
async function replaysOnceAfter(net: LeaderNet) {
  await expect.poll(() => net.commands.length, { timeout: 15_000 }).toBe(1);
  expect(net.commands[0]).toMatchObject({ path: "/commands", key: QUEUED });
}

let oracle: DisplayOracle | null = null;
test.beforeEach(async ({ context }) => {
  oracle = await installDisplayOracle(context, { markers: MARKERS });
});
test.afterEach(async ({ context }, testInfo) => {
  const current = oracle;
  oracle = null;
  if (!current) return;
  if (testInfo.status !== testInfo.expectedStatus) {
    await testInfo.attach("display-oracle.json", {
      body: JSON.stringify(
        { violations: current.violations(), pages: context.pages().length },
        null,
        1,
      ),
      contentType: "application/json",
    });
    for (const [index, page] of context.pages().entries()) {
      const trace = await traceOf(page).catch(() => null);
      if (trace)
        await testInfo.attach(`kernel-trace-page-${index}.json`, {
          body: JSON.stringify(trace, null, 1),
          contentType: "application/json",
        });
    }
    return;
  }
  await current.assertClean(testInfo.title);
});

test.describe("T24 composed over the production leader with the continuous display oracle (WEB-08c revision 3)", () => {
  test("LR-1 T24 A, E, S4, S13: two catch-up pages with an access removal, the final page held, then `finish` held; a follower opened mid-recovery; nothing is mounted or lifted in either page before the clear, the whole retained work is byte-identical at every boundary, each page is displayed by its own exposure, and the queued draft is sent once after", async ({
    context,
  }) => {
    const net = await fencedWithCursor(context);
    await withForm(context);
    const finalPage = held();
    net.answer = async (call) => {
      if (call.cursor === "delta-0")
        return morePage([remove(KEPT), upsert(7, { n: 7 })], "delta-1");
      if (call.cursor === "delta-1") {
        await finalPage.promise;
        return deltaPage([upsert(8, { n: 8 })], "delta-2");
      }
      return deltaPage([], call.cursor ?? "x");
    };
    const one = await leaderPageAfter(context, net, "one", async (page) => {
      await holdFinishWhileFlagged(page);
    });
    const baseline = await retainedWork(one);
    expect(baseline).toContain(QUEUED);
    expect(baseline).toContain("Unfinished task");
    // Boundary 1: the first page is committed (the removal with it), the final page is held.
    await expect
      .poll(() => net.calls.filter((c) => c.cursor === "delta-1").length, {
        timeout: 15_000,
      })
      .toBe(1);
    const first = await untilSync(one, (s) => s?.cursor === "delta-1");
    expect(first?.cursor).toBe("delta-1");
    expect(await cacheIds(one)).toEqual([uuid(7)]);
    expect(await fencesOf(one)).toHaveLength(1);
    expect(await exposed(one)).toEqual(HIDDEN);
    expect(await retainedWork(one)).toBe(baseline);
    // A follower opened during the recovery: it reads nothing and shows nothing.
    const two = await leaderPage(context, net, "two");
    expect(await exposed(two)).toEqual(HIDDEN);
    finalPage.release();
    // Boundary 2: the final data commit is durable; `finish` cannot take its lock yet.
    await untilSync(one, (s) => s?.cursor === "delta-2");
    await expect
      .poll(
        () =>
          one.evaluate(
            () =>
              (window as unknown as { __finishHeldCount?: number })
                .__finishHeldCount ?? 0,
          ),
        { timeout: 15_000 },
      )
      .toBeGreaterThan(0);
    expect(await cacheIds(one)).toEqual([uuid(7), uuid(8)].sort());
    expect(await fencesOf(one)).toHaveLength(1);
    expect(await exposed(one)).toEqual(HIDDEN);
    expect(await exposed(two)).toEqual(HIDDEN);
    expect(await retainedWork(one)).toBe(baseline);
    expect(net.commands).toEqual([]);
    expect(net.calls.filter((c) => c.page === "two")).toEqual([]);
    // The hold is lifted: `finish` clears, and each page displays through its own exposure.
    await one.evaluate(() => {
      (window as unknown as { __finishHold?: boolean }).__finishHold = false;
    });
    await displayed(one, 30_000);
    await displayed(two, 30_000);
    expect(await fencesOf(one)).toEqual([]);
    expect(await finishResults(one)).toContain("cleared");
    await replaysOnceAfter(net);
    // Unsent work other than the replayed draft is exactly as it was.
    const after = JSON.parse(await retainedWork(one)) as Record<
      string,
      Array<{ local_id?: string }>
    >;
    const before = JSON.parse(baseline) as typeof after;
    expect(after.form_recovery).toEqual(before.form_recovery);
    expect(after.draft_commands?.find((b) => b.local_id === BLOCKED)).toEqual(
      before.draft_commands?.find((b) => b.local_id === BLOCKED),
    );
  });

  test("LR-2 T24 B′: a 410, then a snapshot whose second staged page answers `409 access_changed`: the staged generation is abandoned and never active, the restarted snapshot is activated whole, and only then the clear and the display", async ({
    context,
  }) => {
    const net = await fencedWithCursor(context);
    await withForm(context);
    let snapshots = 0;
    const refusal = held();
    const restarted = held();
    net.answer = async (call) => {
      if (call.cursor === "delta-0")
        return status(410, { code: "resync_required" });
      if (call.cursor === null) {
        snapshots += 1;
        if (snapshots === 1) return snapshotPage(SNAP([50]), "snap-1", true);
        await restarted.promise;
        return snapshotPage(SNAP([51, 52]), "delta-9", false);
      }
      if (call.cursor === "snap-1") {
        await refusal.promise;
        return status(409, { code: "access_changed" });
      }
      return deltaPage([], call.cursor ?? "x");
    };
    const page = await leaderPage(context, net, "one");
    const baseline = await retainedWork(page);
    const staged = await untilSync(
      page,
      (s) => s?.staging_position === "snap-1",
    );
    expect(staged?.staging_position).toBe("snap-1");
    const generation = staged?.recovery_generation as number;
    // The old cache is not shown and is still the old cache; the staged page is not active.
    expect(await cacheIds(page)).toEqual([KEPT]);
    expect(
      ((await rowsOf(page, "cache_staging")) as Array<{ id: string }>).map(
        (r) => r.id,
      ),
    ).toEqual([uuid(50)]);
    expect(await exposed(page)).toEqual(HIDDEN);
    expect(await retainedWork(page)).toBe(baseline);
    refusal.release();
    // The refusal abandons the staged generation: a new snapshot is asked for, cursor-less, under a new generation.
    await expect.poll(() => snapshots, { timeout: 15_000 }).toBe(2);
    const restarting = await untilSync(
      page,
      (s) => (s?.recovery_generation as number) === generation + 1,
    );
    expect(restarting?.recovery_generation).toBe(generation + 1);
    // A server-instructed restart counts nothing (as E-B9 in ordinary mode): an answer handled as UNRECOGNISED would be counted
    // (found by MU-1302, whose restart by the unrecognised path passed this case in two engines before these checks).
    expect(restarting).toMatchObject({
      recovery_attempt_streak: 0,
      sync_error_streak: 0,
    });
    expect(await cacheIds(page)).toEqual([KEPT]);
    expect(await fencesOf(page)).toHaveLength(1);
    expect(await exposed(page)).toEqual(HIDDEN);
    expect(await retainedWork(page)).toBe(baseline);
    restarted.release();
    await displayed(page);
    // Activated whole: the restarted snapshot only; the abandoned page and the old cache are gone.
    expect(await cacheIds(page)).toEqual([uuid(51), uuid(52)].sort());
    expect(await rowsOf(page, "cache_staging")).toEqual([]);
    expect(await fencesOf(page)).toEqual([]);
    expect(await finishResults(page)).toEqual(["cleared"]);
    // Q24: the automatic restart is the one the person is told about (`access_changed`), as E-B9.
    expect((await leaderOf(page)).notice).toMatchObject({
      reason: "access_changed",
    });
    await replaysOnceAfter(net);
  });

  test("LR-3 T24 C: the first catch-up page commits and the SECOND answers 401: the recovery request's own observation records a current-epoch entry, the committed page stays, nothing more is read; a re-authentication catches up from the committed position and clears BOTH entries", async ({
    context,
  }) => {
    const net = await fencedWithCursor(context);
    await withForm(context);
    let reauthenticated = false;
    net.answer = (call) => {
      if (call.cursor === "delta-0")
        return morePage([upsert(7, { n: 7 })], "delta-1");
      if (call.cursor === "delta-1" && !reauthenticated)
        return status(401, { code: "unauthenticated" });
      if (call.cursor === "delta-1")
        return deltaPage([upsert(8, { n: 8 })], "delta-2");
      return deltaPage([], call.cursor ?? "x");
    };
    const page = await leaderPage(context, net, "one");
    const baseline = await retainedWork(page);
    const view = await untilLeader(page, (v) =>
      JSON.stringify(v.job).includes("current_epoch_entry"),
    );
    expect(view.job).toMatchObject({
      kind: "eligible_wait",
      reason: "current_epoch_entry",
    });
    // The current-epoch entry is the RECOVERY request's own observation: its 401 was surrendered as a recovery-class request at epoch 2.
    const kernel = await traceOf(page);
    expect(
      kernel.some(
        (e) =>
          e.event === "surrender" &&
          e.data?.klass === "recovery" &&
          e.data?.status === 401 &&
          e.data?.epoch === 2,
      ),
    ).toBe(true);
    const fences = (await fencesOf(page)) as Array<{
      epoch: number;
      seq: number;
      kind: string;
    }>;
    expect(fences.map((f) => [f.epoch, f.kind]).sort()).toEqual([
      [1, "invalid_session"],
      [2, "invalid_session"],
    ]);
    // The committed first page stays applied; nothing more is read; nothing is shown; the work is untouched.
    expect((await syncStateOf(page))?.cursor).toBe("delta-1");
    expect(await cacheIds(page)).toEqual([KEPT, uuid(7)].sort());
    const asked = net.calls.length;
    await page.waitForTimeout(2_000);
    expect(net.calls.length).toBe(asked);
    expect(await exposed(page)).toEqual(HIDDEN);
    expect(await retainedWork(page)).toBe(baseline);
    expect(net.commands).toEqual([]);
    // Re-authentication (epoch 3) in another tab, keeping both entries: the recovery restarts from the committed position.
    const records = await recordsOf(page);
    reauthenticated = true;
    net.identity = { account: ACCOUNT, session: "s3" };
    await settleElsewhere(context, {
      ...records.auth_state,
      latest_epoch: 3,
      settled: {
        account_id: ACCOUNT,
        epoch: 3,
        session_id: "s3",
        settled_at: new Date().toISOString(),
      },
    });
    await displayed(page, 30_000);
    expect(await fencesOf(page)).toEqual([]);
    const resumed = net.calls.slice(asked).map((c) => c.cursor);
    expect(resumed).toContain("delta-1");
    expect(resumed).not.toContain("delta-0");
    expect((await syncStateOf(page))?.cursor).toBe("delta-2");
    await replaysOnceAfter(net);
  });

  for (const variant of ["not_eligible", "rerun"] as const)
    test(`LR-${variant === "not_eligible" ? "4" : "5"} T24 C3: after the final data commit, while \`finish\` waits, another tab records ${variant === "not_eligible" ? "a CURRENT-epoch entry: `finish` answers NOT_ELIGIBLE and clears nothing; the account stays hidden" : "an OLDER-epoch entry above the captured `s`: `finish` answers RERUN and keeps it; a second catch-up clears both"}`, async ({
      context,
    }) => {
      const net = await fencedWithCursor(context);
      await withForm(context);
      net.answer = (call) =>
        call.cursor === "delta-0"
          ? deltaPage([upsert(7, { n: 7 })], "delta-1")
          : deltaPage([], call.cursor ?? "x");
      const page = await leaderPageAfter(context, net, "one", async (p) => {
        await holdFinishWhileFlagged(p);
      });
      const baseline = await retainedWork(page);
      await untilSync(page, (s) => s?.cursor === "delta-1");
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
      // Another tab records an entry while this page's `finish` waits for its lock.
      const records = await recordsOf(page);
      const seq = records.auth_state.fence_seq + 1;
      const added = {
        seq,
        epoch: variant === "not_eligible" ? 2 : 1,
        obs_id: `elsewhere-${seq}`,
        created_at: new Date().toISOString(),
        kind: "invalid_session",
        reason: "current_401",
      };
      await settleElsewhere(context, {
        ...records.auth_state,
        fence_seq: seq,
        fences: {
          [ACCOUNT]: [...(records.auth_state.fences[ACCOUNT] ?? []), added],
        },
      });
      await page.evaluate(() => {
        (window as unknown as { __finishHold?: boolean }).__finishHold = false;
      });
      if (variant === "not_eligible") {
        await expect
          .poll(() => finishResults(page), { timeout: 30_000 })
          .toContain("not_eligible");
        const left = (await fencesOf(page)) as Array<{ seq: number }>;
        expect(left.map((f) => f.seq).sort()).toEqual([1, seq]);
        await page.waitForTimeout(2_000);
        expect(await exposed(page)).toEqual(HIDDEN);
        expect(await retainedWork(page)).toBe(baseline);
        expect(net.commands).toEqual([]);
        expect(await finishResults(page)).not.toContain("cleared");
      } else {
        await displayed(page, 30_000);
        const results = await finishResults(page);
        expect(results.indexOf("rerun")).toBeGreaterThan(-1);
        expect(results.indexOf("cleared")).toBeGreaterThan(
          results.indexOf("rerun"),
        );
        expect(await fencesOf(page)).toEqual([]);
        await replaysOnceAfter(net);
      }
    });

  test("LR-10 T24 G: a second re-authentication while the recovery's FIRST read is in flight: its answer (stamped with the old epoch) is dropped, nothing of it is written, and the new epoch makes its own catch-up from the saved position before the clear", async ({
    context,
  }) => {
    const net = await fencedWithCursor(context);
    await withForm(context);
    const inFlight = held();
    let first = true;
    net.answer = async (call) => {
      if (call.cursor === "delta-0" && first) {
        first = false;
        await inFlight.promise;
        return deltaPage([upsert(70, { n: 70 })], "delta-stale");
      }
      if (call.cursor === "delta-0")
        return deltaPage([upsert(71, { n: 71 })], "delta-1");
      return deltaPage([], call.cursor ?? "x");
    };
    const page = await leaderPage(context, net, "one");
    const baseline = await retainedWork(page);
    await expect.poll(() => net.calls.length, { timeout: 15_000 }).toBe(1);
    // Another tab re-authenticates (epoch 3) while the epoch-2 read is outstanding; the old entry stands.
    const records = await recordsOf(page);
    net.identity = { account: ACCOUNT, session: "s3" };
    await settleElsewhere(context, {
      ...records.auth_state,
      latest_epoch: 3,
      settled: {
        account_id: ACCOUNT,
        epoch: 3,
        session_id: "s3",
        settled_at: new Date().toISOString(),
      },
    });
    await expect
      .poll(async () => (await recordsOf(page)).auth_state.settled.epoch)
      .toBe(3);
    expect(await exposed(page)).toEqual(HIDDEN);
    expect(await retainedWork(page)).toBe(baseline);
    inFlight.release();
    await displayed(page, 30_000);
    // The stale answer wrote nothing: the cursor and the cache are the new epoch's catch-up only.
    expect((await syncStateOf(page))?.cursor).toBe("delta-1");
    expect(await cacheIds(page)).toEqual([KEPT, uuid(71)].sort());
    expect(await fencesOf(page)).toEqual([]);
    // Both recovery reads were from the saved position; nothing ever read from the dropped answer's cursor (later reads are the ordinary
    // engine's, after the display).
    expect(net.calls.slice(0, 2).map((c) => c.cursor)).toEqual([
      "delta-0",
      "delta-0",
    ]);
    expect(net.calls.map((c) => c.cursor)).not.toContain("delta-stale");
    await replaysOnceAfter(net);
  });

  test("LR-6 T24 D: an injected QUOTA error on the second row of the catch-up page: nothing of the page is durable, the fence stands, state 3 at once; the FOLLOWER's 'Try again' makes the leader ask for the whole page again, which applies; then the clear and the display", async ({
    context,
  }) => {
    const net = await fencedWithCursor(context);
    await withForm(context);
    net.answer = (call) =>
      call.cursor === "delta-0"
        ? deltaPage(
            [upsert(7, { n: 7 }), upsert(8, { n: 8 }), upsert(9, { n: 9 })],
            "delta-1",
          )
        : deltaPage([], call.cursor ?? "x");
    // NAMED FAULT (test-only): the SECOND `put` into `cache` of this page throws a QuotaExceededError inside its transaction, once.
    const one = await leaderPageAfter(context, net, "one", async (page) => {
      await page.evaluate(() => {
        const w = window as unknown as {
          __quota?: { skip: number; armed: number; hits: number };
        };
        w.__quota = { skip: 1, armed: 1, hits: 0 };
        const put = IDBObjectStore.prototype.put;
        IDBObjectStore.prototype.put = function (
          this: IDBObjectStore,
          ...args: Parameters<IDBObjectStore["put"]>
        ) {
          const fault = w.__quota;
          if (fault && this.name === "cache" && fault.armed > 0) {
            if (fault.skip > 0) fault.skip -= 1;
            else {
              fault.armed -= 1;
              fault.hits += 1;
              throw new DOMException("injected quota", "QuotaExceededError");
            }
          }
          return put.apply(this, args);
        } as IDBObjectStore["put"];
      });
    });
    const baseline = await retainedWork(one);
    const stopped = await untilLeader(one, (v) =>
      JSON.stringify(v.job).includes("storage_full"),
    );
    expect(stopped.job).toMatchObject({
      kind: "stopped",
      cause: "storage_full",
    });
    expect(
      await one.evaluate(
        () =>
          (window as unknown as { __quota?: { hits: number } }).__quota?.hits,
      ),
    ).toBe(1);
    // One transaction: the first row's write did not stay; the cursor did not move; the fence stands; nothing shown; work untouched.
    expect(await cacheIds(one)).toEqual([KEPT]);
    expect((await syncStateOf(one))?.cursor).toBe("delta-0");
    expect(await fencesOf(one)).toHaveLength(1);
    expect(await exposed(one)).toEqual(HIDDEN);
    expect(await retainedWork(one)).toBe(baseline);
    // The recorded policy: a quota failure is not retried automatically (no second request before the person acts).
    await one.waitForTimeout(1_500);
    expect(net.calls.map((c) => c.cursor)).toEqual(["delta-0"]);
    await expect(
      one.getByRole("heading", { name: "Couldn't finish catching up" }),
    ).toBeVisible();
    // A follower page shows the same state and its "Try again" reaches the leader.
    const two = await leaderPage(context, net, "two");
    await expect(
      two.getByRole("heading", { name: "Couldn't finish catching up" }),
    ).toBeVisible({ timeout: 15_000 });
    await two.getByRole("button", { name: "Try again", exact: true }).click();
    await displayed(one, 30_000);
    await displayed(two, 30_000);
    expect(net.calls.map((c) => [c.page, c.cursor]).slice(0, 2)).toEqual([
      ["one", "delta-0"],
      ["one", "delta-0"],
    ]);
    expect(await cacheIds(one)).toEqual(
      [KEPT, uuid(7), uuid(8), uuid(9)].sort(),
    );
    expect(await fencesOf(one)).toEqual([]);
    await replaysOnceAfter(net);
  });

  test("LR-7 T24 F: the page closes between the data commit and the clear; the next page boots OFFLINE: the fence stands and nothing is read or shown; online, the recovery finds nothing to apply and clears at once", async ({
    context,
  }) => {
    const net = await fencedWithCursor(context);
    await withForm(context);
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
    const baseline = await retainedWork(one);
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
    // Every `/sync` the pages ASK for is counted here, before the stub's offline refusal (which records nothing).
    const asked: string[] = [];
    await context.route("**/api/experimental/v1/sync*", (route) => {
      asked.push(
        new URL(route.request().url()).searchParams.get("cursor") ?? "",
      );
      return route.fallback();
    });
    net.offline = true;
    const two = await leaderPageAfter(context, net, "two", goOffline);
    await two.waitForTimeout(2_000);
    expect(asked, "nothing is asked while offline").toEqual([]);
    expect(net.calls.filter((c) => c.page === "two")).toEqual([]);
    expect(await fencesOf(two)).toHaveLength(1);
    expect(await exposed(two)).toEqual(HIDDEN);
    expect((await syncStateOf(two))?.cursor).toBe("delta-1");
    expect(await cacheIds(two)).toContain(uuid(9));
    expect(await retainedWork(two)).toBe(baseline);
    net.offline = false;
    await goOnline(two);
    await displayed(two, 30_000);
    expect(await fencesOf(two)).toEqual([]);
    expect(
      net.calls.filter((c) => c.page === "two").map((c) => c.cursor)[0],
    ).toBe("delta-1");
    await replaysOnceAfter(net);
  });

  test("LR-8 T24 H(ii): an operation entry beside the older-epoch entry: the recovery does not start, nothing is bound or read and the operation's card is shown while the operation is unresolved", async ({
    context,
  }) => {
    const net = await leaderNetwork(context);
    // The operation's own resolution is held (never answered here): T18/T19 compose it against the released backend (I-L8).
    await context.route("**/api/experimental/v1/sessions/*", () => undefined);
    const record = fencedAfterReauth();
    record.fence_seq = 2;
    record.fences[ACCOUNT]?.push({
      seq: 2,
      epoch: 2,
      obs_id: "o2",
      created_at: new Date().toISOString(),
      kind: "operation",
      envelope: {
        operation_id: "op9",
        op: "logout",
        account_id: ACCOUNT,
        target: { session_id: "s1" },
        initiated_epoch: 2,
      },
    } as never);
    await seedAuth(context, record);
    await arrange(context, async (page) => {
      await page.evaluate(
        (account) => window.__atlasData?.seedDelta(account, "delta-0"),
        ACCOUNT,
      );
    });
    const page = await leaderPage(context, net, "one");
    // Row 3: while the operation is unresolved the leader binds nothing for the account (no database opened, no job run), so nothing is
    // read; the person sees the operation's own card, not the recovery's.
    await expect(page.locator("[data-neutral-state]")).toHaveAttribute(
      "data-neutral-state",
      /^1a\./,
      { timeout: 15_000 },
    );
    await page.waitForTimeout(2_000);
    const view = await leaderOf(page);
    expect(view.job).toEqual({ kind: "idle" });
    expect(net.calls).toEqual([]);
    expect(await exposed(page)).toEqual(HIDDEN);
    expect(await fencesOf(page)).toHaveLength(2);
  });

  test("LR-9 T24 H(iv): an unresolved lease of the OLDER epoch left by a dead page is converted to an entry of that epoch (E5); the recovery then covers it, catches up and clears both", async ({
    context,
  }) => {
    const net = await fencedWithCursor(context);
    // The dead page's lease (epoch 1, another boot): written over the arranged record before any session page boots.
    const record = fencedAfterReauth();
    (record.leases as Record<string, unknown>)["old-lease"] = {
      account_id: ACCOUNT,
      epoch: 1,
      boot_id: "dead-boot",
      created_at: new Date().toISOString(),
      class: "ordinary",
    };
    await seedAuth(context, record);
    net.answer = (call) =>
      call.cursor === "delta-0"
        ? deltaPage([upsert(7, { n: 7 })], "delta-1")
        : deltaPage([], call.cursor ?? "x");
    const page = await leaderPage(context, net, "one");
    await displayed(page, 30_000);
    expect(await fencesOf(page)).toEqual([]);
    const records = await recordsOf(page);
    expect(records.auth_state.leases["old-lease"]).toBeUndefined();
    // The conversion happened: a committed record of this page held TWO entries for the account (the original one and the converted
    // lease of epoch 1), and both were cleared by the recovery's finish. (Found by MU-1309: without E5 the session's verification resolves
    // the dead page's lease instead, and the end state alone is the same.)
    const committed = ((await oracle?.log(page)) ?? []).filter(
      (e) => e.op === "auth.commit",
    ) as Array<{ record: { fences: Record<string, number> } }>;
    expect(
      committed.some((e) => e.record.fences[ACCOUNT] === 2),
      "E5 converted the dead page's lease into a second entry",
    ).toBe(true);
    const kernel = await traceOf(page);
    expect(
      kernel.some(
        (e) =>
          e.event === "data.recovery_finish" && e.data?.result === "cleared",
      ),
    ).toBe(true);
    expect((await syncStateOf(page))?.cursor).toBe("delta-1");
    await replaysOnceAfter(net);
  });
});
