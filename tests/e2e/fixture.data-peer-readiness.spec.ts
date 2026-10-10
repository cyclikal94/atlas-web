import type { BrowserContext, Page } from "@playwright/test";
import { recordEvidence } from "./data-evidence";
import { arm, boot, edit, install } from "./data-local-faults";
import {
  type OutboxReadiness,
  outboxBinding,
  untilOutboxBound,
  withSettledOutboxPeers,
} from "./data-operation-barriers";
import {
  ACCOUNT,
  bootSession,
  startOutbox,
  untilTreeSettled,
  uuid,
} from "./data-sync-helpers";
import { expect, test } from "./helpers";

/**
 * E-H1 (revision 33, R57): a peer's readiness is the readiness of the CAPTURED WRITER, not of the page's connection count.
 *
 * In author request `request-9b853011c9be42c6a533` the unmutated WebKit control of MU-990 failed its first `enqueue` (`refused`,
 * `reason: identity_changed`) after the helper had said the page was ready. The helper waited for the protected tree (two open connections,
 * no leases, 300 ms of quiet). A harness outbox is built over ONE service, captured when it starts; when another page boots, the tree can be
 * disposed and mounted again, which closes the page's registry (every connection of the account) and opens new ones for the new tree, so
 * the count reaches its number again while the facade stays bound to a service that has ended for good. The old run was then repeated
 * unchanged and passed; that explained nothing, and the failed attempt stays a failure.
 *
 * What the cases below do, in order of strength.
 *   H1. The failure mode is MADE deterministic: the service the facade is bound to is ended (and nothing else), and the facade's next
 *       `enqueue` is refused `identity_changed` at once. The aggregate readiness the helper used (`untilTreeSettled`) still passes, which
 *       is the gap; the corrected helper (`untilOutboxBound`) reads the binding, sees `live: false`, builds the outbox again over the page's
 *       current service, and asserts that the new binding is live and current BEFORE the measured action.
 *   H2. The positive control: no transition, no rebuild, the first `enqueue` is queued.
 *   H3. The natural transition: another page boots (the peer), the helper settles the tree and then the outbox; the first `enqueue` is queued.
 *       Its evidence records, for every repetition, the binding before and after, whether a rebuild was needed, and the registry's closes
 *       with the top of their stacks at the enqueue boundary. Run five times per engine by the shared driver with no retries (a bounded
 *       stability diagnostic, not an acceptance minimum); a refusal at the boundary fails with the binding in its message and is never
 *       retried, relabelled as infrastructure or read as readiness.
 *
 * The initial `queued` assertion of the schedules this helper protects is unchanged.
 *
 * Revision 35 (R57): the ORIGINAL failure, read from its preserved trace (`trace.zip` of the failed WebKit control of
 * `request-9b853011c9be42c6a533`, extracted and analysed in `.agtx/evidence/WEB-09a/revision-35/r57-original/`). The settle helper
 * returns, among other things, how many closes of the page's registry the page has logged (`gateDiagnostics().closes.length`). On the
 * FIRST page it returned 0 after the page's own outbox started (two connections) and 1 after the peer had booted (two connections again,
 * the tree's reopened ones), and the measured `enqueue`, 3 ms later, answered `identity_changed`: the facade refuses with that reason
 * only when its service is no longer live, and a service of the page's registry stops being live only through a close of that registry
 * (or its own end, which also closes it). So the original refusal was a facade DEAD AT ENTRY, its service ended by the one close of the
 * page's registry during the peer's boot, after which the aggregate readiness passed on the tree's reopened connections: the gap H1
 * makes deterministic, and the binding check `untilOutboxBound` closes. What the trace cannot say is which caller made that close (the
 * settle helper returned the count, not the stack); the established mechanism of revisions 23 and 24 (a bound tree disposed when another
 * page boots closes the registry) is the one H5 shows natively, and it is not claimed for that one run beyond what the trace shows.
 *
 *   H6. The diagnostic gap the design assessment of revision 34 found: the refusal log read the page's CURRENT binding after the action
 *       had awaited, so an outbox rebuilt meanwhile would be described instead of the facade that refused. The harness now captures the
 *       invoked facade and its binding as the action begins: a refusal that arrives after the service ended and the outbox was rebuilt
 *       records the entry binding (live), the invoked service's binding at the answer (ended) and `rebound: true`, while the page's
 *       current binding is live.
 */
const A = uuid(81);

const enqueue = (page: Page, localId: string, target: string, label: string) =>
  page.evaluate(
    (spec) => window.__atlasData?.enqueue(spec),
    edit(target, localId, label),
  );

/**
 * The measured action: the facade's first `enqueue`. A refusal is an error that says what the page's outbox was bound to at that
 * boundary (its service, its lifetime and whether it lived, the page's current service, the registry's open count, latch and last closes).
 */
async function enqueueAtBoundary(
  page: Page,
  localId: string,
  target: string,
  label: string,
) {
  const before = await outboxBinding(page);
  const outcome = await enqueue(page, localId, target, label);
  if (outcome?.kind !== "queued")
    throw new Error(
      `the first enqueue was not queued: ${JSON.stringify(outcome)}; the outbox was bound to ${JSON.stringify(before)}`,
    );
  return { outcome, before };
}

/**
 * Another page with its own running outbox (no dispatcher: it never sends) over the same database and `localStorage`. With `holdMs` the
 * peer's FIRST identity read is answered that much later (a named latency injection, `bootSession`'s `holdIdentityReadMs`, R43): the
 * schedule a loaded machine gives the stub's answer, which makes the first page's tree dispose and mount again about a third of the time.
 */
async function anotherOutbox(
  context: BrowserContext,
  holdMs = 0,
): Promise<Page> {
  const page = await bootSession(
    context,
    holdMs > 0 ? { holdIdentityReadMs: holdMs } : {},
  );
  await untilTreeSettled(page, { connections: 0 });
  await startOutbox(page, ACCOUNT, { start: false });
  await untilTreeSettled(page, { connections: 2 });
  await install(page);
  return page;
}

test.describe("E-H1 (revision 33, R57): the readiness of a page's harness outbox is the binding of its captured service", () => {
  test("H1 control: the captured service is ended (nothing else): the first enqueue is refused `identity_changed`, the aggregate readiness still passes, and the corrected helper rebuilds the outbox and verifies the new binding before the measured action", async ({
    context,
  }, info) => {
    const { page } = await boot(context);
    await context.setOffline(true);
    expect((await outboxBinding(page))?.live).toBe(true);
    // The transition: the captured service ends. The registry keeps its connections and the tree its own.
    await page.evaluate(() => window.__atlasData?.endOutboxService());
    const dead = await outboxBinding(page);
    expect(dead).toMatchObject({ live: false });
    // The aggregate readiness the helper used before this revision looks at the page's session, its registry's open count, the leases and the
    // quiet, and never at the service one facade was built over. Ending the captured service closes the account's connections on this page
    // (the registry is closed with it), so the count the production tree needs (2) is not what is asked here: with the threshold the page now
    // has (0) the aggregate readiness is satisfied at once, the facade being dead, which is all it can say.
    const settled = await untilTreeSettled(page, { connections: 0 });
    expect(settled.leases).toBe(0);
    // The failure mode: the facade refuses at once, before any schedule.
    expect(await enqueue(page, A, "r", "original")).toMatchObject({
      kind: "refused",
      reason: "identity_changed",
    });
    // Revision 34 (R57): the refusal names its cause at the measured action. The harness recorded it with the binding at that moment
    // (the captured service ended, no longer the page's current one), the registry's closes say who ended it, and the same state is what a
    // failed spec has attached to its report (`harnessDiagnostics`). This is the observation the original MU-990 failure lacked.
    const diagnosed = await page.evaluate(() =>
      window.__atlasData?.diagnostics(),
    );
    expect(diagnosed?.refusals.at(-1)).toMatchObject({
      operation: "enqueue",
      reason: "identity_changed",
      binding: { live: false, sameService: false },
    });
    expect(diagnosed?.outbox).toMatchObject({ live: false });
    expect(diagnosed?.gate.closes.length).toBeGreaterThan(0);
    recordEvidence(info, "h1-refusal-diagnostics", diagnosed);
    // The corrected readiness sees it, rebuilds, and verifies.
    const readiness = await untilOutboxBound(page);
    expect(readiness.rebound).toBe(true);
    expect(readiness.before).toMatchObject({ live: false });
    expect(readiness.after).toMatchObject({ live: true, sameService: true });
    expect(readiness.after?.incarnationId).toBe(
      readiness.before?.incarnationId,
    );
    const { outcome } = await enqueueAtBoundary(page, A, "r", "original");
    expect(outcome).toMatchObject({ kind: "queued" });
    recordEvidence(info, "h1-dead-service-control", {
      dead,
      settled,
      readiness,
    });
  });

  test("H2 control: no transition: the helper finds the binding live and current, builds nothing, and the first enqueue is queued", async ({
    context,
  }, info) => {
    const { page } = await boot(context);
    await context.setOffline(true);
    const readiness = await untilOutboxBound(page);
    expect(readiness.rebound).toBe(false);
    expect(readiness.before).toMatchObject({ live: true, sameService: true });
    const { outcome, before } = await enqueueAtBoundary(
      page,
      A,
      "r",
      "original",
    );
    expect(outcome).toMatchObject({ kind: "queued" });
    recordEvidence(info, "h2-no-transition", { readiness, before });
  });

  test("H3: another page boots (a peer): the helper settles the tree and then the captured service, and the first enqueue is queued; the binding at the boundary is the evidence", async ({
    context,
  }, info) => {
    const { page } = await boot(context);
    const readiness: OutboxReadiness[] = [];
    const peer = await withSettledOutboxPeers(
      () => anotherOutbox(context),
      [page],
      readiness,
    );
    await context.setOffline(true);
    expect(readiness).toHaveLength(1);
    expect(readiness[0]?.none).toBe(false);
    const { outcome, before } = await enqueueAtBoundary(
      page,
      A,
      "r",
      "original",
    );
    expect(outcome).toMatchObject({ kind: "queued" });
    // The peer is bound too.
    expect((await outboxBinding(peer))?.live).toBe(true);
    recordEvidence(info, "h3-peer-boot", {
      rebound: readiness[0]?.rebound,
      readiness: readiness[0],
      atBoundary: before,
      peer: await outboxBinding(peer),
    });
  });

  // The natural transition, with the schedule that makes it likely: the peer's first identity read is held 150 ms. Whether the first page's
  // service ended is whatever the engine did; the CASE is that the helper's answer is right either way.
  test("H4: another page boots with its first identity read held: whether or not the first page's service ended, the helper leaves a live, current binding and the first enqueue is queued", async ({
    context,
  }, info) => {
    const { page } = await boot(context);
    const readiness: OutboxReadiness[] = [];
    await withSettledOutboxPeers(
      () => anotherOutbox(context, 150),
      [page],
      readiness,
    );
    await context.setOffline(true);
    const { outcome, before } = await enqueueAtBoundary(
      page,
      A,
      "r",
      "original",
    );
    expect(outcome).toMatchObject({ kind: "queued" });
    expect(before).toMatchObject({ live: true, sameService: true });
    recordEvidence(info, "h4-peer-boot-held", {
      rebound: readiness[0]?.rebound,
      before: readiness[0]?.before,
      after: readiness[0]?.after,
      atBoundary: before,
    });
  });

  // DIAGNOSIS (not a gate): what the tree-only readiness left behind. After the peer booted with its first identity read held, the page's
  // tree is settled by the old criteria (`untilTreeSettled`, two connections), and the captured service is read as it is. The case asserts
  // the CAUSE where the service ended: a close of the page's registry is on record (the tree's disposal and mount again closed every
  // connection of the account), never a service that ended by itself; and that the corrected helper repairs it. Which way a run went is
  // evidence, not an expectation: the transition is the engine's, and the number of runs that saw it is what the stability diagnostic
  // reports.
  test("H5 diagnosis: after the peer boots (its first identity read held) and the tree-only readiness passes, a captured service that ended has a close of the page's registry on record, and the corrected helper repairs it", async ({
    context,
  }, info) => {
    const { page } = await boot(context);
    await anotherOutbox(context, 150);
    await untilTreeSettled(page, { connections: 2 });
    const tree = await outboxBinding(page);
    const readiness = await untilOutboxBound(page);
    if (tree !== null && !tree.live) {
      // The transition happened: it is explained by a close of the registry, and the helper rebuilt the outbox.
      expect(tree.closes.length).toBeGreaterThan(0);
      expect(readiness.rebound).toBe(true);
    } else {
      expect(readiness.rebound).toBe(false);
    }
    expect(readiness.after).toMatchObject({ live: true, sameService: true });
    recordEvidence(info, "h5-diagnosis", {
      endedByTreeOnlyReadiness: tree !== null && !tree.live,
      binding: tree,
      readiness,
    });
  });

  test("H6 (revision 35): a refusal is recorded against the facade that was INVOKED, captured at entry: the outbox rebuilt while the action awaited is not what the record describes", async ({
    context,
  }, info) => {
    const { page } = await boot(context);
    await context.setOffline(true);
    // The draft's own write fails, so the facade writes its failure counter; that write's answer is held, so the action awaits.
    await arm(page, { id: A, armed: 1 });
    await page.evaluate(() =>
      window.__atlasData?.holdOutboxPlan("data.recordLocalWriteOutcome"),
    );
    const pending = enqueue(page, A, "r", "original");
    await expect
      .poll(() => page.evaluate(() => window.__atlasData?.outboxPlanHeld()), {
        timeout: 20_000,
      })
      .toBe(true);
    // While it awaits, the captured service ends and the outbox is rebuilt over the page's current service.
    await page.evaluate(() => window.__atlasData?.endOutboxService());
    const readiness = await untilOutboxBound(page);
    expect(readiness.rebound).toBe(true);
    await page.evaluate(() => window.__atlasData?.releaseOutboxPlan());
    // The OLD facade's answer: its lifetime is over (R56), so it refuses `identity_changed`.
    expect(await pending).toMatchObject({
      kind: "refused",
      reason: "identity_changed",
    });
    const diagnosed = await page.evaluate(() =>
      window.__atlasData?.diagnostics(),
    );
    const refusal = diagnosed?.refusals.at(-1);
    expect(refusal).toMatchObject({
      operation: "enqueue",
      reason: "identity_changed",
      entry: { live: true, sameService: true },
      binding: { live: false, sameService: false },
      rebound: true,
    });
    expect(refusal?.binding?.incarnationId).toBe(refusal?.entry?.incarnationId);
    expect(refusal?.entryMs).toBeGreaterThanOrEqual(0);
    expect(refusal?.at).toBeGreaterThanOrEqual(refusal?.entryMs ?? 0);
    // The page's CURRENT outbox is the rebuilt one, live: what a log read at the answer would have described instead.
    expect(diagnosed?.outbox).toMatchObject({ live: true, sameService: true });
    recordEvidence(info, "h6-invoked-facade", { readiness, diagnosed });
  });
});
