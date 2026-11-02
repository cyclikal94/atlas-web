import type { BrowserContext, Page } from "@playwright/test";
import { recoverySample } from "../../scripts/integration/pair-capture.mjs";
import {
  admissibilityProblems,
  captureProblems,
  establishedProblems,
  hiddenProblems,
  holdsComplete,
  type RecoveryReader,
  renderingProblems,
  resolved,
  shownProblems,
  storedProblemsAt,
  surfaceOf,
} from "../../scripts/integration/pair-recovery.mjs";
import { renderingOf } from "../pair/rendering";
import { stored } from "../pair/stored";
import {
  ACCOUNT,
  arrange,
  deltaPage,
  displayed,
  fencedWithCursor,
  fresh,
  held,
  holdFinishWhileFlagged,
  type LeaderNet,
  leaderOf,
  leaderPage,
  leaderPageAfter,
  snapshotPage,
  status,
} from "./data-leader-helpers";
import { atlasError, upsert } from "./data-sync-helpers";
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
/** A reader's sample with only what the rendering rules read (the stored state is not part of these rendering-only cases). */
async function sample(
  page: Page,
  reader: "leader" | "follower",
): Promise<RecoveryReader & { auth: { status: string } }> {
  const seen = await renderingOf(page, ACCOUNT);
  return {
    reader,
    page: reader,
    account: ACCOUNT,
    ...seen,
  } as unknown as RecoveryReader & { auth: { status: string } };
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
    expect(renderingProblems(hidden, { account: ACCOUNT })).toEqual([]);
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
    expect(renderingProblems(shown, { account: ACCOUNT })).toEqual([]);
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
    expect(renderingProblems(fenced, { account: ACCOUNT })).toEqual([]);
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
    expect(renderingProblems(shown, { account: ACCOUNT })).toEqual([]);
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
    expect(renderingProblems(f, { account: ACCOUNT })).toEqual([]);
    expect(observed(f)?.document).not.toBe(observed(first)?.document);
    // The follower sampled AS a leader is refused for its role.
    expect(
      renderingProblems({ ...f, reader: "leader" }, { account: ACCOUNT }),
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

  test("revision 29 (C5/Q8), restated in revision 30: the capture is ONE turn between two fence reads; a fence changed across it is a CHANGED auth bracket", async ({
    context,
  }) => {
    const net = await fresh(context);
    const page = await leaderPage(context, net, "bracket");
    await expose(page);
    const healthy = await until(
      page,
      "leader",
      (r) => shownProblems(r).length === 0,
      "the fresh account is shown",
    );
    expect(healthy.auth).toEqual({ status: "stable" });
    expect(healthy.fenced).toBe(false);
    // A deterministic pause at the auth-record reads: the FIRST read of a sample reports a fence and, as it returns, gates the protected
    // root; the SECOND reports none and, before it returns, lifts the root again. A capture made before the first read or after the
    // second would see the root lifted; the bracketed capture sees it gated, and the changed fence makes the auth bracket `changed`.
    await page.evaluate((account) => {
      const session = window.__atlasFixture?.session as unknown as {
        readRecords: () => Promise<{
          auth_state?: { fences?: Record<string, unknown[]> };
        }>;
      };
      const original = session.readRecords.bind(session);
      let calls = 0;
      session.readRecords = async () => {
        const records = await original();
        calls += 1;
        const root = document.getElementById("protected-root");
        if (calls === 1) {
          root?.setAttribute("inert", "");
          root?.setAttribute("aria-hidden", "true");
          return {
            ...records,
            auth_state: {
              ...records.auth_state,
              fences: {
                ...(records.auth_state?.fences ?? {}),
                [account]: [{ kind: "probe" }],
              },
            },
          };
        }
        if (calls === 2) {
          root?.removeAttribute("inert");
          root?.removeAttribute("aria-hidden");
        }
        return records;
      };
    }, ACCOUNT);
    const mixed = await sample(page, "leader");
    const g = observed(mixed);
    expect(g?.root.gated).toBe(true);
    expect(mixed.auth).toEqual({
      status: "changed",
      reason: "the account's auth fences changed during the capture",
    });
    expect(mixed.fenced).toBeNull();
    // The rendering itself is a complete observation; only its fence relation is indeterminate.
    expect(renderingProblems(mixed, { account: ACCOUNT })).toEqual([]);
    // After the probe's two reads, the auth bracket is stable again (the wrapper passes the records through), and the page is shown.
    const after = await sample(page, "leader");
    expect(after.auth).toEqual({ status: "stable" });
    expect(after.fenced).toBe(false);
    expect(shownProblems(after)).toEqual([]);
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
    // Revision 30: the rendering's unavailability is its own outcome; the auth bracket is whatever the fence reads gave, never a proxy.
    expect(["stable", "unavailable"]).toContain(r.auth.status);
    expect(renderingProblems(r, { account: ACCOUNT }).join()).toMatch(
      /rendering was not observed \(unavailable: .*session view is not readable/,
    );
    expect(hiddenProblems(r, { caller: "ordinary", what: "x" })).not.toEqual(
      [],
    );
    expect(shownProblems(r)).not.toEqual([]);
    await page.close();
    const closed = await sample(page, "follower");
    expect(closed.rendering.status).toBe("unavailable");
    expect(closed.auth.status).toBe("unavailable");
    expect(closed.fenced).toBeNull();
    expect(
      hiddenProblems(closed, { caller: "recovery", what: "x" }),
    ).not.toEqual([]);
  });
});

/**
 * WEB-09c revision 30 (R30-DIAG; design assessment Q6b): the MAINTAINED composition (pair-capture.mjs `recoverySample`: the raw stored read,
 * `renderingOf`, the stored read again — exactly as tests/pair/support.ts `recoveryReader` composes it) on REAL IndexedDB and the real DOM.
 * A real ADMITTED product write on ANOTHER connection (the follower page's production outbox facade: W2 enqueue, which advances
 * `composition_seq` in its own transaction) is committed INSIDE the capture's auth bracket, i.e. after the first stored read and before the
 * second. The observation faults (a fence reported by the auth read while the page displays; the session hook hidden for one capture) are
 * labelled TEST INTERVENTIONS: they show the harness keeps an independently established failure across a real storage change, never
 * product exposure. FIXTURE evidence: the network is stubbed; no backend runs.
 */
const createPerson = (id: string, name: string) => ({
  endpoint: "/commands",
  targets: [
    {
      resourceId: id,
      role: "primary" as const,
      basis: "resource" as const,
      versionChecked: false,
      seedIfUntracked: 1,
    },
  ],
  command: { commands: [{ kind: "create_person", id, name }] },
  displayPatch: { [id]: { label: name } },
});
/**
 * Installs ONE capture's schedule in `page`: its second auth read waits (`window.__pairLatch`) until released; `fence` makes BOTH auth
 * reads report the account's fence (intervention); `hideView` removes the session hook for this capture only (intervention). Restored by
 * the second read.
 */
const latchCapture = (page: Page, o: { fence?: boolean; hideView?: boolean }) =>
  page.evaluate(
    ({ account, fence, hideView }) => {
      const w = window as unknown as {
        __s?: unknown;
        __pairLatch?: { reached: boolean; release?: () => void };
        __atlasFixture: {
          session: {
            readRecords: () => Promise<{
              auth_state?: { fences?: Record<string, unknown[]> };
            }>;
          };
        };
      };
      const session = w.__atlasFixture.session;
      const original = session.readRecords;
      const view = w.__s;
      const latch: { reached: boolean; release?: () => void } = {
        reached: false,
      };
      const gate = new Promise<void>((resolve) => {
        latch.release = resolve;
      });
      w.__pairLatch = latch;
      let calls = 0;
      const withFence = async () => {
        const records = await original.call(session);
        return fence
          ? {
              ...records,
              auth_state: {
                ...records.auth_state,
                fences: {
                  ...(records.auth_state?.fences ?? {}),
                  [account]: [{ kind: "probe-intervention" }],
                },
              },
            }
          : records;
      };
      session.readRecords = async () => {
        calls += 1;
        if (calls === 1) {
          const out = await withFence();
          if (hideView) w.__s = undefined;
          return out;
        }
        latch.reached = true;
        await gate;
        session.readRecords = original;
        w.__s = view;
        return withFence();
      };
    },
    {
      account: ACCOUNT,
      fence: o.fence ?? false,
      hideView: o.hideView ?? false,
    },
  );
/** Revision 31 (R31-DIAG; labelled TEST INTERVENTION): the cache digest one stored transaction is reported with (never written). */
const INTERVENTION_DIGEST = "intervention-wrong-live-cache";
async function capturedAcrossWrite(
  leader: Page,
  follower: Page,
  o: { fence?: boolean; hideView?: boolean; corrupt?: 1 | 2 },
) {
  await latchCapture(leader, o);
  let reads = 0;
  let first: Awaited<ReturnType<typeof stored>> = null;
  const pending = recoverySample(
    {
      stored: async (rows: boolean, local: string[] | null) => {
        reads += 1;
        const s = await stored(leader, ACCOUNT, rows, local);
        if (reads === 1) first = s;
        // Revision 31: the REAL transaction, reported with a wrong live cache (intervention) when `corrupt` names this read.
        return s && o.corrupt === reads
          ? { ...s, cache_digest: INTERVENTION_DIGEST }
          : s;
      },
      rendering: () => renderingOf(leader, ACCOUNT),
    },
    { reader: "leader", page: "leader-page", account: ACCOUNT },
  );
  await expect
    .poll(
      () =>
        leader.evaluate(
          () =>
            (window as unknown as { __pairLatch?: { reached: boolean } })
              .__pairLatch?.reached ?? false,
        ),
      { timeout: 15_000, message: "the capture is latched inside its bracket" },
    )
    .toBe(true);
  // The admitted write, on the FOLLOWER's own connection, committed while the leader's capture is open.
  const id = crypto.randomUUID();
  const queued = (await follower.evaluate(
    (given) =>
      (
        window as unknown as {
          __atlasFixture: {
            session: { enqueue(spec: unknown): Promise<unknown> };
          };
        }
      ).__atlasFixture.session.enqueue(given),
    createPerson(id, "R30 Q6b"),
  )) as { kind: string; localId?: string };
  expect(queued.kind, JSON.stringify(queued)).toBe("queued");
  const base = (first as unknown as { composition_seq: number })
    .composition_seq;
  await expect
    .poll(
      async () =>
        ((await stored(leader, ACCOUNT)) as { composition_seq: number } | null)
          ?.composition_seq ?? -1,
      { timeout: 15_000, message: "the write committed natively" },
    )
    .toBeGreaterThan(base);
  await leader.evaluate(() =>
    (
      window as unknown as { __pairLatch: { release: () => void } }
    ).__pairLatch.release(),
  );
  const out = (await pending) as unknown as RecoveryReader & {
    capture: {
      auth: { status: string };
      storage: {
        status: string;
        fields?: string[];
        before?: { composition_seq?: number };
        after?: { composition_seq?: number };
      };
    };
  };
  expect(reads).toBe(2);
  // The native commit and the stamp change it caused, recorded by the bracket itself.
  expect(out.capture.storage.status).toBe("changed");
  expect(out.capture.storage.fields).toContain("composition_seq");
  expect(out.capture.storage.after?.composition_seq ?? 0).toBeGreaterThan(
    out.capture.storage.before?.composition_seq ?? Infinity,
  );
  expect(captureProblems(out)).toEqual([]);
  expect(resolved(out)).toBe(false);
  return out;
}
async function shownPair(context: BrowserContext) {
  const net = await fresh(context);
  const leader = await leaderPage(context, net, "leader");
  await expose(leader);
  await until(
    leader,
    "leader",
    (r) => shownProblems(r).length === 0,
    "the leader shows the account",
  );
  const follower = await leaderPage(context, net, "follower");
  await expose(follower);
  await until(
    follower,
    "follower",
    (r) => observed(r)?.attachment === "follower",
    "the second page follows",
  );
  return { leader, follower };
}
const AFTER = {
  caller: "ordinary",
  phase: "after_activation",
  what: "x",
} as const;

/**
 * WEB-09c revision 31 (R31-DIAG; design assessment Q6b): BOTH coherent stored transactions of a capture across a REAL admitted
 * second-connection write (the follower's W2 enqueue committed between them) are judged on their own by the maintained stored predicate
 * (`storedProblemsAt`, the activated barrier bound to the page's real live cache). Lawful: both transactions pass, the second retained with
 * the real later `composition_seq`. The wrong live cache in the FIRST or the SECOND transaction is a labelled intervention on the reported
 * value (no product write is altered): it is refused on that transaction whatever the real storage movement. The full observer over held
 * real snapshot answers is the diagnostic qualification's (Q7), not this fixture's.
 */
async function realCache(page: Page) {
  const now = await stored(page, ACCOUNT);
  expect(now?.cache_status, "a valid live cache before the capture").toBe(
    "valid",
  );
  return {
    barrier: "activated",
    label: "x",
    oldDigest: "no-earlier-cache-in-this-fixture",
    digest: (now as { cache_digest: string }).cache_digest,
  };
}
const endpointsOf = (out: RecoveryReader, ctx: Record<string, unknown>) => [
  storedProblemsAt(out, ctx, { who: "leader" }),
  storedProblemsAt(
    (out as unknown as { stored_after: RecoveryReader }).stored_after,
    ctx,
    { who: "leader" },
  ),
];

test.describe("WEB-09c r31: both coherent stored transactions judged across a REAL second-connection write (Q6b)", () => {
  test("lawful: both real transactions hold the bound live cache; the second is retained with the real later composition", async ({
    context,
  }) => {
    const { leader, follower } = await shownPair(context);
    const ctx = await realCache(leader);
    const out = await capturedAcrossWrite(leader, follower, {});
    const second = (out as unknown as { stored_after: Record<string, unknown> })
      .stored_after;
    expect(second.incarnation).toBe(out.incarnation);
    expect(second.composition_seq as number).toBeGreaterThan(
      out.composition_seq as number,
    );
    expect(endpointsOf(out, ctx)).toEqual([[], []]);
  });
  for (const corrupt of [1, 2] as const)
    test(`refused: the ${corrupt === 1 ? "FIRST" : "SECOND"} transaction reported with a wrong live cache (intervention) — refused on that transaction despite the real storage change`, async ({
      context,
    }) => {
      const { leader, follower } = await shownPair(context);
      const ctx = await realCache(leader);
      const out = await capturedAcrossWrite(leader, follower, { corrupt });
      expect(out.capture.storage.fields).toContain("composition_seq");
      const [first, second] = endpointsOf(out, ctx);
      const wrong = (corrupt === 1 ? first : second) ?? [];
      expect(wrong.join()).toMatch(
        /leader does not hold the activated cache .* \(intervention-wrong-live-cache\)/,
      );
      expect(corrupt === 1 ? second : first).toEqual([]);
    });
});

test.describe("WEB-09c r30: the maintained capture composition across a REAL second-connection write (Q6b)", () => {
  test("lawful: the shown, unfenced page with a real write committed inside its bracket is a CHANGED storage bracket, admissible — re-read, never refused", async ({
    context,
  }) => {
    const { leader, follower } = await shownPair(context);
    const out = await capturedAcrossWrite(leader, follower, {});
    expect(out.capture.auth).toEqual({ status: "stable" });
    expect(out.fenced).toBe(false);
    expect(renderingProblems(out, { account: ACCOUNT })).toEqual([]);
    expect(establishedProblems(out, AFTER)).toEqual([]);
    expect(shownProblems(out)).toEqual([]);
  });
  test("refused: the SAME schedule with a stable fence reported while the page displays (intervention) — established despite the real storage change", async ({
    context,
  }) => {
    const { leader, follower } = await shownPair(context);
    const out = await capturedAcrossWrite(leader, follower, { fence: true });
    expect(out.capture.auth).toEqual({ status: "stable" });
    expect(out.fenced).toBe(true);
    expect(out.rendering.status).toBe("observed");
    expect(establishedProblems(out, AFTER).join()).toMatch(
      /leader is shown while the recovery fence stands/,
    );
  });
  test("refused: the SAME schedule with the session hook hidden for that capture (intervention) — an unavailable rendering, the stable auth bracket kept", async ({
    context,
  }) => {
    const { leader, follower } = await shownPair(context);
    const out = await capturedAcrossWrite(leader, follower, { hideView: true });
    expect(out.capture.auth).toEqual({ status: "stable" });
    expect(renderingProblems(out, { account: ACCOUNT }).join()).toMatch(
      /rendering was not observed \(unavailable: the session view is not readable\)/,
    );
    // The page is shown again once the capture's schedule is restored.
    expect(shownProblems(await sample(leader, "leader"))).toEqual([]);
  });

  /**
   * Design assessment Q6b, second part: the REAL fenced recovery's final data commit with `finish` HELD (data-leader-helpers.ts
   * `holdFinishWhileFlagged`, the named E-R7 hold: exclusive `atlas-auth` requests after the final `data.recovery_commit` are never granted
   * while flagged). Both pages are sampled through the maintained composition: complete data under the standing fence is HIDDEN on each.
   * Then the hold is lifted and every sample of each page until both show is judged on its own (asymmetric settlement permitted).
   */
  test("the fenced recovery's complete data with `finish` held: both pages hidden; then each page lawful on its own until both show", async ({
    context,
  }) => {
    const net = await fencedWithCursor(context);
    net.answer = async (call) =>
      call.cursor === "delta-0"
        ? deltaPage([upsert(8, { n: 8 })], "delta-1")
        : deltaPage([], call.cursor ?? "x");
    const one = await leaderPageAfter(
      context,
      net,
      "one",
      holdFinishWhileFlagged,
    );
    await expose(one);
    await expect
      .poll(
        () =>
          one.evaluate(
            () =>
              (window as unknown as { __finishHeldCount?: number })
                .__finishHeldCount ?? 0,
          ),
        { timeout: 30_000, message: "finish is held after the final commit" },
      )
      .toBeGreaterThan(0);
    const two = await leaderPage(context, net, "two");
    await expose(two);
    const composedSample = (page: Page, reader: "leader" | "follower") =>
      recoverySample(
        {
          stored: (rows: boolean, local: string[] | null) =>
            stored(page, ACCOUNT, rows, local),
          rendering: () => renderingOf(page, ACCOUNT),
        },
        { reader, page: `${reader}-page`, account: ACCOUNT },
      ) as unknown as Promise<RecoveryReader>;
    // Revision 31 (R31-DIAG): once the first resolved complete sample binds the activated cache, BOTH stored transactions of every later
    // capture of either page are judged against it (the observer's settlement context; no earlier cache is known to this fixture).
    let bound: Record<string, unknown> | null = null;
    /** A resolved sample, judging every capture on the way for what it establishes (as the observer's read does). */
    const resolvedOf = async (page: Page, reader: "leader" | "follower") => {
      for (let i = 0; i < 21; i += 1) {
        const r = await composedSample(page, reader);
        expect(captureProblems(r), JSON.stringify(r)).toEqual([]);
        if (bound !== null)
          expect(
            [
              storedProblemsAt(r, bound, { who: reader }),
              storedProblemsAt(
                (r as unknown as { stored_after: RecoveryReader }).stored_after,
                bound,
                { who: reader },
              ),
            ],
            JSON.stringify(r),
          ).toEqual([[], []]);
        expect(
          renderingProblems(r, { account: ACCOUNT }),
          JSON.stringify(r),
        ).toEqual([]);
        expect(
          establishedProblems(r, {
            caller: "recovery",
            phase: "after_activation",
            what: "x",
          }),
          JSON.stringify(r),
        ).toEqual([]);
        if (resolved(r)) return r;
      }
      throw new Error(`no resolved sample of the ${reader} in 21 reads`);
    };
    for (const [page, reader] of [
      [one, "leader"],
      [two, "follower"],
    ] as const) {
      const r = await resolvedOf(page, reader);
      expect(holdsComplete(r), "the complete data is committed").toBe(true);
      bound ??= {
        barrier: "activated",
        label: "x",
        oldDigest: "no-earlier-cache-in-this-fixture",
        digest: r.cache_digest,
      };
      expect(r.cursor).toBe("delta-1");
      expect(r.fenced, `${reader}: the fence stands while finish is held`).toBe(
        true,
      );
      expect(
        admissibilityProblems(r, {
          caller: "recovery",
          phase: "after_activation",
          what: "x",
        }),
      ).toEqual([]);
      expect(r.rendering.status === "observed" && r.rendering.view?.kind).toBe(
        "neutral",
      );
      expect(r.rendering.status === "observed" && surfaceOf(r.rendering)).toBe(
        "protected_hidden",
      );
    }
    await one.evaluate(() => {
      (window as unknown as { __finishHold?: boolean }).__finishHold = false;
    });
    const shownAt: Record<string, number> = {};
    for (
      let poll = 0;
      poll < 600 && Object.keys(shownAt).length < 2;
      poll += 1
    ) {
      for (const [page, reader] of [
        [one, "leader"],
        [two, "follower"],
      ] as const) {
        if (shownAt[reader] !== undefined) continue;
        const r = await resolvedOf(page, reader);
        if (shownProblems(r).length === 0) {
          expect(r.fenced, `${reader} is shown only with its fence clear`).toBe(
            false,
          );
          shownAt[reader] = poll;
        }
      }
      if (Object.keys(shownAt).length < 2) await one.waitForTimeout(50);
    }
    expect(Object.keys(shownAt).sort(), JSON.stringify(shownAt)).toEqual([
      "follower",
      "leader",
    ]);
    test.info().annotations.push({
      type: "settlement",
      description: JSON.stringify(shownAt),
    });
  });
});
