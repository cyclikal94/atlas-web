import type { Page } from "@playwright/test";
import type { OutboxBinding } from "../../src/fixture/data-harness/main";
import { untilTreeSettled } from "./data-sync-helpers";
import { expect } from "./helpers";

/** Invocation is an observation point only; it does not prove a durable commit. */
export const untilOutboxPlanCalled = (page: Page) =>
  expect
    .poll(() => page.evaluate(() => window.__atlasData?.outboxPlanHeld()), {
      timeout: 20_000,
    })
    .toBe(true);

/** Preserve the existing durable-row assertion and timeout, without a timing guess. */
export const untilDraftWriteCommitted = (
  page: Page,
  account: string,
  text: string,
) =>
  expect
    .poll(
      async () =>
        JSON.stringify(
          (await page.evaluate(
            (owner) => window.__atlasData?.rows(owner, "draft_commands"),
            account,
          )) ?? [],
        ),
      { timeout: 20_000 },
    )
    .toContain(text);

/** What a page's harness outbox is bound to now, or null when it has none (R57, revision 33). */
export const outboxBinding = (page: Page): Promise<OutboxBinding | null> =>
  page.evaluate(() => window.__atlasData?.outboxBinding() ?? null);

/** What `untilOutboxBound` found and did, for the evidence of the case that waited. */
export interface OutboxReadiness {
  /** The page had no harness outbox: nothing to wait for. */
  none: boolean;
  /** The outbox's service had ended and the facade was built again over the page's current one. */
  rebound: boolean;
  before: OutboxBinding | null;
  after: OutboxBinding | null;
}

const bound = (binding: OutboxBinding | null): boolean =>
  binding?.live === true && binding.sameService;

/**
 * Waits until the page's harness OUTBOX is bound to a service that is live and is the page's current one (R57, revision 33).
 *
 * The readiness the helper below had (`untilTreeSettled` with the registry's open count) is about the page's PROTECTED TREE: after another
 * page boots, the tree can be disposed and mounted again, which closes the registry's connections and opens new ones, so the count
 * reaches its number again while the facade a harness started EARLIER stays bound to a service that is now ended for good (`live:
 * false`): its next `enqueue` is refused `identity_changed`, before the schedule the case is about. A count of connections says nothing
 * of one captured service, so this reads the binding itself (`outboxBinding`). When the captured service has ended it records what ended
 * it (the registry's closes, with their stacks) and builds the outbox again over the current service with the options it was started
 * with (`rebindOutbox`), and then asserts that the new binding is live and current before the measured action. It does not retry an
 * operation, loop on `identity_changed` or lengthen a quiet period: a binding that cannot be made live is an error that says what it saw.
 */
export async function untilOutboxBound(
  page: Page,
  timeoutMs = 20_000,
): Promise<OutboxReadiness> {
  const before = await outboxBinding(page);
  if (before === null)
    return { none: true, rebound: false, before: null, after: null };
  if (bound(before))
    return { none: false, rebound: false, before, after: before };
  await page.evaluate(() => window.__atlasData?.rebindOutbox());
  let after: OutboxBinding | null = null;
  try {
    await expect
      .poll(
        async () => {
          after = await outboxBinding(page);
          return bound(after);
        },
        { timeout: timeoutMs },
      )
      .toBe(true);
  } catch (error) {
    throw new Error(
      `the harness outbox is not bound to a live, current service after it was built again: before ${JSON.stringify(before)}, now ${JSON.stringify(after)} (${String(error)})`,
    );
  }
  return { none: false, rebound: true, before, after };
}

/**
 * Booting a peer can remount existing pages. Re-establish their existing readiness contract (the protected tree is bound again), and then
 * the one the aggregate numbers cannot show: that each page's harness outbox is bound to a live, current service (R57, revision 33). The
 * readiness of each page is returned in order, so a case can record it as evidence.
 */
export async function withSettledOutboxPeers(
  createPeer: () => Promise<Page>,
  existingPages: Page[],
  readiness?: OutboxReadiness[],
): Promise<Page> {
  const peer = await createPeer();
  for (const page of existingPages) {
    await untilTreeSettled(page, { connections: 2 });
    const found = await untilOutboxBound(page);
    readiness?.push(found);
  }
  return peer;
}
