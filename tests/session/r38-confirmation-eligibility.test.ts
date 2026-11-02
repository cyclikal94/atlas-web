// @vitest-environment node
import { describe, expect, test } from "vitest";
import { checkProperties } from "../support/session/properties";
import {
  holdAnswers,
  newWorld,
  ordinaryGet,
  signedInPage,
  stateOf,
} from "../support/session/scenarios";

/**
 * WEB-14a revision 35 (review R38, family `r43-premise-shared-confirmation`; design assessment Q2/Q3): the eligibility rules the
 * corrected browser schedules rely on, deterministically, on the unchanged product (HF1-SHARED-CONFIRMATION-20261013). A displaying
 * page's resume verification needs BOTH its own last verification (page memory) and the record's shared confirmation of exactly the
 * settled session to be at least the interval old; a new document has no memory of its own; a peer's clean read refreshes the shared
 * confirmation for everyone. tests/session/web08c-shared-confirmation.test.ts keeps the original twelve cases.
 */
const reads = (f: Awaited<ReturnType<typeof newWorld>>, page?: string) =>
  f.server.requests.filter(
    (r) =>
      r.path.endsWith("/browser-sessions/current") &&
      (page === undefined || r.page === page),
  );

type World = Awaited<ReturnType<typeof newWorld>>;
type Signed = Awaited<ReturnType<typeof signedInPage>>;

/** Rewrites only the shared confirmation's time, `ageMs` before the page's clock (what tests/e2e/shared-confirmation.ts does). */
function age(f: World, l: Signed, ageMs: number) {
  const shared = stateOf(f).confirmation;
  if (!shared) throw new Error("no confirmation");
  shared.confirmed_at = new Date(
    l.page.kernel.ports.clock.now() - ageMs,
  ).toISOString();
}

/** Gate the page and lift it again in the same document (the visibility lifecycle the I-04 schedule uses). */
async function hideAndLift(f: World, page: Signed["page"]) {
  page.hide();
  await f.settle();
  page.show();
  await f.world.runUntilIdle();
}

describe("R38: when a displaying page's resume verification is eligible", () => {
  test("one millisecond younger than the interval, the confirmation still spares the same document's re-exposure", async () => {
    const f = await newWorld();
    const l = await signedInPage(f);
    age(f, l, l.page.kernel.config.resumeVerificationMinIntervalMs - 1);
    await hideAndLift(f, l.page);
    expect(reads(f)).toEqual([]);
  });

  test("exactly the interval old, the same document, which has never verified, verifies once on re-exposure (the I-04 premise); its clean answer refreshes the confirmation and keeps the token", async () => {
    const f = await newWorld();
    const l = await signedInPage(f);
    const token = stateOf(f).confirmation?.csrf_token;
    // The settlement's display made no read: the fresh confirmation returned before the page recorded a verification of its own.
    expect(reads(f)).toEqual([]);
    age(f, l, l.page.kernel.config.resumeVerificationMinIntervalMs);
    await hideAndLift(f, l.page);
    expect(reads(f, l.page.id)).toHaveLength(1);
    const refreshed = stateOf(f).confirmation;
    expect(refreshed?.session_id).toBe(l.sessionId);
    expect(refreshed?.csrf_token).toBe(token);
    expect(Date.parse(refreshed?.confirmed_at ?? "")).toBe(
      l.page.kernel.ports.clock.now(),
    );
    expect(checkProperties(f)).toEqual([]);
  });

  test("a document that has already attempted a verification within the interval does not verify again, however old the record's confirmation (page memory)", async () => {
    const f = await newWorld();
    const l = await signedInPage(f);
    const interval = l.page.kernel.config.resumeVerificationMinIntervalMs;
    age(f, l, 4 * interval);
    await hideAndLift(f, l.page);
    expect(reads(f, l.page.id)).toHaveLength(1);
    // Aged again at once: the record would allow it, the page's own last verification does not.
    age(f, l, 4 * interval);
    await hideAndLift(f, l.page);
    expect(reads(f, l.page.id)).toHaveLength(1);
    // Control: once the page's own interval has passed too, the same lift verifies.
    await f.world.advance(interval);
    age(f, l, 4 * interval);
    await hideAndLift(f, l.page);
    expect(reads(f, l.page.id)).toHaveLength(2);
  });

  test("a NEW document finding an aged confirmation adopts the token from the record before any answer, and makes exactly one identity read: its verification", async () => {
    const f = await newWorld();
    const l = await signedInPage(f);
    age(f, l, 4 * l.page.kernel.config.resumeVerificationMinIntervalMs);
    const n = f.addPage();
    const held = holdAnswers(
      f,
      (r) => r.path.endsWith("/browser-sessions/current") && r.page === n.id,
    );
    await f.boot(n);
    await f.world.runUntilIdle();
    expect(
      n.kernel.memory.csrf.get(n.kernel.memory.csrfKey(l.account, l.epoch)),
    ).toBe(`csrf.${l.sessionId}`);
    expect(reads(f, n.id)).toHaveLength(1);
    held.stop();
    held.release();
    await f.world.runUntilIdle();
    await f.runWith(ordinaryGet(n, l.account, l.epoch));
    await f.world.runUntilIdle();
    expect(reads(f, n.id)).toHaveLength(1);
    expect(reads(f, l.page.id)).toEqual([]);
    expect(checkProperties(f)).toEqual([]);
  });

  test("a peer's clean verification after the ageing refreshes the confirmation: the target's re-exposure then makes no read (lost eligibility, which a setup must detect, never repair by ageing again)", async () => {
    const f = await newWorld();
    const l = await signedInPage(f);
    const m = f.addPage();
    await f.boot(m);
    await f.world.runUntilIdle();
    expect(reads(f)).toEqual([]);
    age(f, l, 4 * l.page.kernel.config.resumeVerificationMinIntervalMs);
    // The peer, which has never verified either, verifies first and confirms the session again.
    await hideAndLift(f, m);
    expect(reads(f, m.id)).toHaveLength(1);
    expect(Date.parse(stateOf(f).confirmation?.confirmed_at ?? "")).toBe(
      l.page.kernel.ports.clock.now(),
    );
    await hideAndLift(f, l.page);
    expect(reads(f, l.page.id)).toEqual([]);
    expect(checkProperties(f)).toEqual([]);
  });
});
