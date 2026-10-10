import type { Page } from "@playwright/test";
import { recordEvidence } from "./data-evidence";
import { arm, boot, edit, hits, streaks, warning } from "./data-local-faults";
import {
  untilOutboxBound,
  withSettledOutboxPeers,
} from "./data-operation-barriers";
import {
  ACCOUNT,
  bootSession,
  startOutbox,
  untilTreeSettled,
} from "./data-sync-helpers";
import { expect, test } from "./helpers";

/**
 * E-R60 (revision 37): a durable stop one page records reaches a HEALTHY follower page, in a real engine. The review of revision 36
 * showed, in Chromium, Firefox and WebKit, a follower facade that had completed an empty observation staying clear after another page's
 * three failed saves had put `draft:<id>` at its bound in `sync_state.local_write_streaks`: the writer's announcement reached only its own
 * page, and the follower skipped even a same-account hint because it was healthy. The writer now posts a hint naming the stop records
 * (`LOCAL_WRITE_STOPS_STORE`) when it records a durable stop or ends a durable failure it saw, and a facade reads its records on that hint
 * whatever it shows.
 *
 * Two pages of one context, each with the production outbox facade over REAL IndexedDB and `localStorage`, joined by the REAL
 * `BroadcastChannel` (`atlas-sync`): the spec makes no look, sends no message and delivers nothing between them. The writer's saves fail by
 * a fault the spec installs in its page (a `put` of the draft's row throws, aborting the transaction); the follower's warning is POLLED.
 * Two failures (below the bound) are the control. FIXTURE evidence: injected write failures, not a failing disk; the dispatchers are the
 * fixture's test leaders and send nothing (the saves never queue); no backend.
 */
const DRAFT = "e-r60-save";
/** The hint's delivery and the follower's one read of its records, with room for a loaded machine; not a duration requirement. */
const VISIBLE_MS = 10_000;
/** How long the control is watched for a warning that must not come. */
const QUIET_MS = 2_000;

const save = (page: Page) =>
  page.evaluate((spec) => window.__atlasData?.enqueue(spec), edit("r", DRAFT));

test.describe("E-R60 (revision 37): a durable stop one page records is shown by a healthy follower page, and its end is too, in a real engine", () => {
  for (const failures of [2, 3])
    test(`E-R60: the writer's ${failures} failed saves (${failures === 3 ? "a durable stop" : "below the bound, the control"}) and a healthy follower page`, async ({
      context,
    }, testInfo) => {
      const { page: writer } = await boot(context);
      const readiness: Awaited<ReturnType<typeof untilOutboxBound>>[] = [];
      const follower = await withSettledOutboxPeers(
        async () => {
          const peer = await bootSession(context);
          await untilTreeSettled(peer, { connections: 2 });
          await startOutbox(peer, ACCOUNT, { start: false });
          return peer;
        },
        [writer],
        readiness,
      );
      readiness.push(await untilOutboxBound(follower));
      // The follower has completed a healthy observation: nothing stands.
      await expect
        .poll(() => warning(follower), { timeout: VISIBLE_MS })
        .toEqual({ notResponding: false, memoryOnly: false });

      await arm(writer, { id: DRAFT, armed: failures });
      const outcomes = [];
      for (let i = 0; i < failures; i += 1) outcomes.push(await save(writer));
      const recorded = await streaks(writer);
      const writerWarning = await warning(writer);
      recordEvidence(testInfo, "e-r60-stop-publication", {
        failures,
        readiness,
        outcomes,
        hits: await hits(writer),
        recorded,
        writerWarning,
      });
      expect(outcomes).toEqual(
        Array.from({ length: failures }, () => ({
          kind: "refused",
          reason: "storage",
        })),
      );
      expect(recorded).toEqual({ [`draft:${DRAFT}`]: failures });
      expect(writerWarning?.notResponding).toBe(failures === 3);

      if (failures < 3) {
        await follower.waitForTimeout(QUIET_MS);
        expect(await warning(follower)).toEqual({
          notResponding: false,
          memoryOnly: false,
        });
        return;
      }
      // The stop reaches the healthy follower through the writer's hint alone.
      await expect
        .poll(async () => (await warning(follower))?.notResponding, {
          timeout: VISIBLE_MS,
          intervals: [100],
        })
        .toBe(true);
      // The writer's "Try again" ends the durable failure it saw; the follower takes its warning down through the hint that posts.
      await writer.evaluate((id) => window.__atlasData?.retryOutbox(id), DRAFT);
      await expect
        .poll(() => streaks(writer), { timeout: VISIBLE_MS })
        .toEqual({});
      await expect
        .poll(async () => (await warning(follower))?.notResponding, {
          timeout: VISIBLE_MS,
          intervals: [100],
        })
        .toBe(false);
    });

  /**
   * DA-R60-C (revision 38): the three failed saves created NO draft; the writer's public discard of it answers `not_found`, and its plan
   * ends the stop in the same transaction (R46). Nothing else of that act announces it (no draft changed): the writer posts the stop
   * hint, and the follower, which showed the stop, takes its warning down through that hint alone.
   */
  test("E-R60-C (revision 38): a discard of the draft the failed saves never created ends its stop, and the healthy follower page takes the warning down", async ({
    context,
  }, testInfo) => {
    const { page: writer } = await boot(context);
    const readiness: Awaited<ReturnType<typeof untilOutboxBound>>[] = [];
    const follower = await withSettledOutboxPeers(
      async () => {
        const peer = await bootSession(context);
        await untilTreeSettled(peer, { connections: 2 });
        await startOutbox(peer, ACCOUNT, { start: false });
        return peer;
      },
      [writer],
      readiness,
    );
    readiness.push(await untilOutboxBound(follower));
    await expect
      .poll(() => warning(follower), { timeout: VISIBLE_MS })
      .toEqual({ notResponding: false, memoryOnly: false });
    await arm(writer, { id: DRAFT, armed: 3 });
    for (let i = 0; i < 3; i += 1) await save(writer);
    expect(await streaks(writer)).toEqual({ [`draft:${DRAFT}`]: 3 });
    await expect
      .poll(async () => (await warning(follower))?.notResponding, {
        timeout: VISIBLE_MS,
        intervals: [100],
      })
      .toBe(true);
    const discarded = await writer.evaluate(
      (id) => window.__atlasData?.discardDraft(id),
      DRAFT,
    );
    const recorded = await streaks(writer);
    recordEvidence(testInfo, "e-r60c-discard-clearance", {
      readiness,
      hits: await hits(writer),
      discarded,
      recorded,
    });
    expect(discarded).toEqual({ kind: "refused", reason: "not_found" });
    expect(recorded).toEqual({});
    await expect
      .poll(async () => (await warning(follower))?.notResponding, {
        timeout: VISIBLE_MS,
        intervals: [100],
      })
      .toBe(false);
  });
});
