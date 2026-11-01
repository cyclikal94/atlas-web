import type { BrowserContext, Page } from "@playwright/test";
import {
  hiddenProblems,
  observationProblems,
  type RecoveryReader,
  shownProblems,
  surfaceOf,
} from "../../scripts/integration/pair-recovery.mjs";
import { renderingOf } from "../pair/rendering";
import {
  ACCOUNT,
  arrange,
  deltaPage,
  displayed,
  fencedWithCursor,
  fresh,
  held,
  type LeaderNet,
  leaderOf,
  leaderPage,
  snapshotPage,
  status,
} from "./data-leader-helpers";
import { atlasError } from "./data-sync-helpers";
import { expect, test } from "./helpers";

/**
 * WEB-09c revision 28 (R28-DIAG.b; design assessment Q3): the recovery observer's RENDERING adapter (tests/pair/rendering.ts `renderingOf`,
 * the very function the pair spec's readers use) against the REAL fixture DOM of the production session composition (`/__session`, the
 * production leader, the protected root, the Today route's CacheGate) in each engine, with the maintained rules of pair-recovery.mjs:
 *   - the ordinary recovery's hidden state is the displaying account behind the VISIBLE refreshing placeholder; the same placeholder made
 *     invisible is not hidden; once the cache is valid the page SHOWS it (no placeholder);
 *   - the fenced recovery's hidden state is the neutral session over the gated (or unmounted) protected tree; after the recovery finishes
 *     the fence is cleared and the account is shown;
 *   - a second page is positively attached as a FOLLOWER; each document has its own identity and a reload is another document;
 *   - with no session hook the observation is UNAVAILABLE, never hidden; a closed page too.
 * FIXTURE evidence: the network is stubbed (data-leader-helpers.ts), no backend runs, and the approved diagnostic executable is not involved.
 */

/** The harness page's session as `window.__s` (the pair pages get it from tests/integration/helpers.ts `exposeSession`). */
const expose = (page: Page) =>
  page.evaluate(async () => {
    const booted = await window.__atlasFixture?.session?.ready;
    if (booted)
      (window as unknown as { __s: unknown }).__s = (
        booted as { session: unknown }
      ).session;
  });
/** A reader's sample with only what the rendering rules read (the stored state is not part of this qualification). */
async function sample(
  page: Page,
  reader: "leader" | "follower",
): Promise<RecoveryReader> {
  const seen = await renderingOf(page, ACCOUNT);
  return { reader, page: reader, account: ACCOUNT, ...seen } as RecoveryReader;
}
async function until(
  page: Page,
  reader: "leader" | "follower",
  accept: (r: RecoveryReader) => boolean,
  what: string,
  timeout = 30_000,
): Promise<RecoveryReader> {
  let last: RecoveryReader | null = null;
  try {
    await expect
      .poll(
        async () => {
          last = await sample(page, reader);
          return accept(last);
        },
        { timeout },
      )
      .toBe(true);
  } catch (error) {
    throw new Error(
      `${what}: not reached; last sample ${JSON.stringify(last)} (${String((error as Error).message).split("\n")[0]})`,
    );
  }
  return last as unknown as RecoveryReader;
}
const observed = (r: RecoveryReader) =>
  r.rendering.status === "observed" ? r.rendering : null;
/** Holds every `/sync` until released; then answers as the network's default (an empty snapshot, then empty deltas). */
function holdSync(net: LeaderNet) {
  const gate = held();
  const answer = net.answer;
  net.answer = async (call) => {
    await gate.promise;
    return answer(call);
  };
  return gate;
}

test.describe("WEB-09c r28: the recovery observer's rendering adapter on the real DOM", () => {
  test("ordinary: the displaying account behind the VISIBLE refreshing placeholder is hidden; an invisible placeholder is not; the valid cache is shown", async ({
    context,
  }) => {
    // The ordinary recovery (W18): an established delta cache, the server's 410 to its continuation (the engine invalidates and asks for
    // a snapshot), and the snapshot HELD — the page then shows what an ordinary recovery shows while its snapshot is fetched.
    const net = await fresh(context);
    await arrange(context, (page) =>
      page.evaluate(async (account) => {
        const data = window.__atlasData;
        await data?.seedDelta(account, "delta-0");
        await data?.put(account, "cache", [
          {
            id: "00000000-0000-4000-8000-000000000041",
            kind: "task",
            parent_id: null,
            label: "before the recovery",
            value: null,
            version: 1,
            can_edit: true,
            archived: false,
            kind_date: null,
          },
        ]);
      }, ACCOUNT),
    );
    const gate = held();
    net.answer = async (call) => {
      if (call.cursor === "delta-0")
        return { ...status(410), body: atlasError("resync_required") };
      await gate.promise;
      return call.cursor === null
        ? snapshotPage([], "delta-1", false)
        : deltaPage([], call.cursor);
    };
    const page = await leaderPage(context, net, "leader");
    await expose(page);
    // The recovery's own cursor-less request is held: the client committed the invalidation before making it (the boot's own `unverified`
    // gate, before the first read of the facts, is NOT this state).
    await expect
      .poll(
        () =>
          net.calls.some((c) => c.cursor === "delta-0") &&
          net.calls.some((c) => c.cursor === null),
        { timeout: 30_000, message: "the 410 answered and the snapshot held" },
      )
      .toBe(true);
    const hidden = await until(
      page,
      "leader",
      (r) =>
        observed(r)?.view?.kind === "displaying" &&
        observed(r)?.attachment === "leader" &&
        (observed(r)?.placeholders.refreshing_visible ?? 0) > 0,
      "the leader displays the account behind the refreshing placeholder",
    );
    expect(observationProblems(hidden, { account: ACCOUNT })).toEqual([]);
    const g = observed(hidden);
    expect(g?.view?.account_id).toBe(ACCOUNT);
    expect(g?.root).toEqual({ present: true, gated: false, mounted: true });
    expect(g && surfaceOf(g)).toBe("refreshing");
    expect(hiddenProblems(hidden, { caller: "ordinary", what: "x" })).toEqual(
      [],
    );
    expect(shownProblems(hidden)).not.toEqual([]);
    // Element count alone is no evidence: the same placeholder made invisible is NOT hidden.
    await page.evaluate(() => {
      for (const el of document.querySelectorAll<HTMLElement>(
        '[data-cache-gate="refreshing"]',
      ))
        el.style.visibility = "hidden";
    });
    const invisible = await sample(page, "leader");
    expect(
      observed(invisible)?.placeholders,
      JSON.stringify(invisible),
    ).toEqual({
      present: g?.placeholders.present,
      refreshing_visible: 0,
    });
    expect(
      hiddenProblems(invisible, { caller: "ordinary", what: "x" }).join(),
    ).toMatch(/placeholder_not_visible/);
    await page.evaluate(() => {
      for (const el of document.querySelectorAll<HTMLElement>(
        '[data-cache-gate="refreshing"]',
      ))
        el.style.visibility = "";
    });
    gate.release();
    const shown = await until(
      page,
      "leader",
      (r) => shownProblems(r).length === 0,
      "the valid cache is shown",
    );
    expect(observationProblems(shown, { account: ACCOUNT })).toEqual([]);
    expect(
      hiddenProblems(shown, { caller: "ordinary", what: "x" }).join(),
    ).toMatch(/shows the account's cache content .*\(shown\)/);
  });

  test("fenced recovery: the neutral session over the gated protected tree is hidden; after the recovery the fence is cleared and the account is shown", async ({
    context,
  }) => {
    const net = await fencedWithCursor(context);
    const gate = holdSync(net);
    net.answer = ((answer) => async (call: Parameters<typeof answer>[0]) => {
      await gate.promise;
      return deltaPage(
        [],
        call.cursor === "delta-0" ? "delta-1" : (call.cursor ?? "x"),
      );
    })(net.answer);
    const page = await leaderPage(context, net, "fenced");
    await expose(page);
    const fenced = await until(
      page,
      "leader",
      (r) =>
        observed(r)?.view?.kind === "neutral" &&
        observed(r)?.attachment === "leader",
      "the fenced page is neutral while its recovery waits",
    );
    expect(observationProblems(fenced, { account: ACCOUNT })).toEqual([]);
    expect(fenced.fenced).toBe(true);
    const g = observed(fenced);
    expect(g && surfaceOf(g)).toBe("protected_hidden");
    expect(hiddenProblems(fenced, { caller: "recovery", what: "x" })).toEqual(
      [],
    );
    expect(shownProblems(fenced)).not.toEqual([]);
    gate.release();
    await displayed(page, 60_000);
    const shown = await until(
      page,
      "leader",
      (r) => shownProblems(r).length === 0 && r.fenced === false,
      "the recovered account is shown with the fence cleared",
      60_000,
    );
    expect(observationProblems(shown, { account: ACCOUNT })).toEqual([]);
    expect(
      hiddenProblems(shown, { caller: "recovery", what: "x" }).join(),
    ).toMatch(/never displayed/);
  });

  test("a second page is POSITIVELY attached as a follower; each document has its own identity, and a reload is another document", async ({
    context,
  }) => {
    const net = await fresh(context);
    const leader = await leaderPage(context, net, "leader");
    await expose(leader);
    const first = await until(
      leader,
      "leader",
      (r) => observed(r)?.attachment === "leader",
      "the first page leads",
    );
    const follower = await leaderPage(context, net, "follower");
    await expose(follower);
    expect(
      ((await leaderOf(follower)) as { attachment?: string } | null)
        ?.attachment,
    ).not.toBe("leader");
    const f = await until(
      follower,
      "follower",
      (r) => observed(r)?.attachment === "follower",
      "the second page attaches as a follower",
    );
    expect(observationProblems(f, { account: ACCOUNT })).toEqual([]);
    expect(observed(f)?.document).not.toBe(observed(first)?.document);
    // The follower sampled AS a leader is refused for its role.
    expect(
      observationProblems({ ...f, reader: "leader" }, { account: ACCOUNT }),
    ).toEqual(["leader's page is attached as follower, not leader"]);
    const before = observed(await sample(leader, "leader"))?.document;
    expect(observed(await sample(leader, "leader"))?.document).toBe(before);
    // A reload: the harness page navigated again (its address was rewritten to the route, so the harness URL is loaded anew).
    await leaderPage(context, net, "leader", leader);
    await expose(leader);
    const after = await until(
      leader,
      "leader",
      (r) => observed(r) !== null,
      "the reloaded page is observed",
    );
    expect(observed(after)?.document).not.toBe(before);
  });

  test("without the session hook, or on a closed page, the observation is UNAVAILABLE — never hidden, never shown", async ({
    context,
  }: {
    context: BrowserContext;
  }) => {
    const page = await context.newPage();
    await page.goto("/__session?boot=off");
    await page.waitForFunction(
      () => window.__atlasFixture?.session !== undefined,
    );
    const r = await sample(page, "leader");
    expect(r.rendering.status).toBe("unavailable");
    expect(r.fenced).toBeNull();
    expect(observationProblems(r, { account: ACCOUNT }).join()).toMatch(
      /rendering was not observed \(unavailable: .*session view is not readable/,
    );
    expect(hiddenProblems(r, { caller: "ordinary", what: "x" })).not.toEqual(
      [],
    );
    expect(shownProblems(r)).not.toEqual([]);
    await page.close();
    const closed = await sample(page, "follower");
    expect(closed.rendering.status).toBe("unavailable");
    expect(
      hiddenProblems(closed, { caller: "recovery", what: "x" }),
    ).not.toEqual([]);
  });
});
