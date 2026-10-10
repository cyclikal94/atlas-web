import { recordEvidence } from "./data-evidence";
import {
  installMarkerReadFaults,
  markerReads,
  NO_READ_FAULTS,
} from "./data-local-faults";
import {
  ACCOUNT,
  bootSession,
  seedSettled,
  startOutbox,
  stubNetwork,
  untilTreeSettled,
} from "./data-sync-helpers";
import { expect, test } from "./helpers";

/**
 * E-R55 (revision 36): the PUBLIC warning of a follower recovers, in a real engine, when the page's `localStorage` reads come back with no
 * event. The review of revision 35 reproduced the gap in Chromium, Firefox and WebKit with a diagnostic of its own: a standing immutable
 * `draft:*` failure marker that no directory lists, the page's marker reads refused (a named `SecurityError` of `length` and of `getItem` of
 * the marker keys), the production gate controller started as a follower (`startGate`, isolated, `established: false`, ready once its
 * facts read has emitted), then the reads restored without any `storage` event: the gate reopened and the existing "local storage isn't
 * responding" notice never came. The facade now looks again by itself while unsure, at the facts' re-read pace.
 *
 * Nothing in a case makes a look, a wake, an action or an event after the reads come back: the notice is POLLED, within the production
 * bound of that pace (`factsReadRetryMaxMs`, 10 s, plus the read itself), and the timers are the browser's own. The readable and absent
 * arrangements are the controls. FIXTURE evidence: an injected refusal, not a naturally occurring storage outage; no backend.
 */
const OPERATION = "draft:saved-before-close";
/** `factsReadRetryMaxMs` (10 s), the longest the paced look waits, and two seconds for the read itself and the page's turn. */
const RECOVERY_BOUND_MS = 12_000;
/** How long the refusal lasts before access returns (real time): the pace has moved past its first waits by then. */
const OUTAGE_MS = 2_000;

interface Seen {
  gate: string | null;
  notice: boolean;
  probe: string;
  raw: string | null;
}

test.describe("E-R55 (revision 36): a follower started while its marker reads are refused shows the existing notice once they are readable, with no event", () => {
  for (const blocked of [false, true])
    for (const present of [false, true])
      test(`E-R55: reads refused=${blocked}, marker standing=${present}`, async ({
        context,
      }, testInfo) => {
        await stubNetwork(context);
        await seedSettled(context);
        const page = await bootSession(context);
        // The account's database exists (the harness outbox creates it), and its outbox is let go of at once: the follower is the only
        // observer under test.
        await startOutbox(page, ACCOUNT, { start: false });
        await untilTreeSettled(page);
        await installMarkerReadFaults(page);
        const { key, incarnation } = await page.evaluate(
          async ({ account, operation, present }) => {
            const h = window.__atlasData;
            if (!h) throw new Error("no fixture harness");
            h.stopOutbox();
            const state = await h.syncState(account);
            const incarnation = String(state?.incarnation_id);
            // A failure as a page with NO directory slot publishes it: the key is its only trace (the snapshot of the keys finds it).
            const name = `atlas-write-failing:${encodeURIComponent(account)}:${encodeURIComponent(incarnation)}:${operation}#independent.1`;
            if (present) localStorage.setItem(name, "1");
            return { key: name, incarnation };
          },
          { account: ACCOUNT, operation: OPERATION, present },
        );
        if (blocked)
          await markerReads(page, { enumeration: true, getItem: true });
        await page.evaluate(
          (account) =>
            window.__atlasData?.startGate(account, {
              isolated: true,
              established: false,
            }),
          ACCOUNT,
        );
        // Ready once the controller's own facts read has emitted (the gate is deliberately not established when the marker is unread).
        await page.waitForFunction(
          () => (window.__atlasData?.gateFactsReads().emissions ?? 0) > 0,
          null,
          { timeout: 10_000 },
        );
        const seen = (): Promise<Seen> =>
          page.evaluate(
            ({ key, operation, scope }) => {
              const h = window.__atlasData;
              if (!h) throw new Error("no fixture harness");
              let raw: string | null = null;
              try {
                raw = localStorage.getItem(key);
              } catch {
                raw = "unreadable";
              }
              return {
                gate: h.gate(),
                notice: h
                  .gateNotices()
                  .some((n) => n.kind === "storage_not_responding"),
                probe: h.markers.probe(scope, operation),
                raw,
              };
            },
            {
              key,
              operation: OPERATION,
              scope: { account: ACCOUNT, incarnationId: incarnation },
            },
          );
        const before = await seen();
        if (blocked) expect(before.probe).toBe("unknown");
        await page.waitForTimeout(OUTAGE_MS);
        // Unknown is not a stop: nothing is invented while the reads are refused.
        const during = await seen();
        expect(during.notice).toBe(present && !blocked);
        // Access returns. Restoring the Storage methods mutates nothing, so no `storage` event is raised; the test makes no look.
        const restoredAt = Date.now();
        await markerReads(page, NO_READ_FAULTS);
        let after = await seen();
        if (present) {
          await expect
            .poll(async () => (await seen()).notice, {
              timeout: RECOVERY_BOUND_MS,
              intervals: [100],
            })
            .toBe(true);
        } else {
          // The absent control: the gate opens on its own pace and the read that lands establishes the absence; no notice comes.
          await expect
            .poll(async () => (await seen()).gate, {
              timeout: RECOVERY_BOUND_MS,
              intervals: [100],
            })
            .toBe("open");
          await page.waitForTimeout(1_000);
        }
        after = await seen();
        const recoveredMs = Date.now() - restoredAt;
        recordEvidence(testInfo, "e-r55-public-recovery", {
          blocked,
          present,
          before,
          during,
          after,
          recoveredMs,
          factsReads: await page.evaluate(() =>
            window.__atlasData?.gateFactsReads(),
          ),
        });
        expect(after.raw).toBe(present ? "1" : null);
        expect(after.probe).toBe(present ? "marked" : "unmarked");
        expect(after.gate).toBe("open");
        expect(after.notice).toBe(present);
        await page.evaluate(() => window.__atlasData?.stopGate());
      });
});
