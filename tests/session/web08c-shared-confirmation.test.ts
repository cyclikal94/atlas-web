// @vitest-environment node
import { describe, expect, test } from "vitest";
import { retireOwnLease } from "../../src/session/model/reducers/observation";
import { checkProperties } from "../support/session/properties";
import { records as recordsWith } from "../support/session/records";
import {
  forceResumeVerification,
  holdAnswers,
  newWorld,
  ordinaryGet,
  signedInPage,
  stateOf,
} from "../support/session/scenarios";

/**
 * WEB-08c revision 2, human decision HF1-SHARED-CONFIRMATION-20261013 (HF-1, WEB08D-NAVIGATION-FRESHNESS-20261011). After a settlement every
 * other page used to make identity reads of its own (its resume verification and its CSRF token); matrix §3.6.1 rule 14 makes each answer
 * SURRENDER its lease, and the page that had just signed in, watching it, closed its tree for a few milliseconds: a click then was lost. The
 * settlement now records the session's CSRF token and its first server confirmation in `auth_state.confirmation`; a clean identity read of
 * the SAME session refreshes it. A page adopts the token only for exactly the settled (account, epoch, session) and skips its resume
 * verification while the confirmation is less than the interval old. Surrender and watch rules are unchanged.
 */
const reads = (f: Awaited<ReturnType<typeof newWorld>>, page?: string) =>
  f.server.requests.filter(
    (r) =>
      r.path.endsWith("/browser-sessions/current") &&
      (page === undefined || r.page === page),
  );

/**
 * The token page `n` holds for (account, epoch) BEFORE any identity read of its own can answer (their answers are held): what it adopted from
 * the record alone. Released afterwards.
 */
async function adoptedBy(
  f: Awaited<ReturnType<typeof newWorld>>,
  account: string,
  epoch: number,
) {
  const n = f.addPage();
  const held = holdAnswers(
    f,
    (r) => r.path.endsWith("/browser-sessions/current") && r.page === n.id,
  );
  await f.boot(n);
  await f.world.runUntilIdle();
  const token = n.kernel.memory.csrf.get(
    n.kernel.memory.csrfKey(account, epoch),
  );
  held.stop();
  held.release();
  await f.world.runUntilIdle();
  return { n, token };
}

describe("the settlement shares its token and confirmation (HF1-SHARED-CONFIRMATION-20261013)", () => {
  test("the settlement writes the confirmation of exactly the settled session, with the activation's token", async () => {
    const f = await newWorld();
    const l = await signedInPage(f);
    const settled = stateOf(f).settled;
    expect(stateOf(f).confirmation).toMatchObject({
      account_id: l.account,
      epoch: l.epoch,
      session_id: l.sessionId,
      csrf_token: `csrf.${l.sessionId}`,
      confirmed_at: settled?.settled_at,
    });
    // The page that signed in makes no identity read of its own after the settlement.
    expect(reads(f, l.page.id)).toEqual([]);
  });

  test("a second page adopts the token and the confirmation: no identity read, so nothing surrenders and no watching page closes", async () => {
    const f = await newWorld();
    const l = await signedInPage(f);
    const n = f.addPage();
    await f.boot(n);
    await f.runWith(ordinaryGet(n, l.account, l.epoch));
    await f.world.runUntilIdle();
    expect(reads(f)).toEqual([]);
    const probe = f.server.requests
      .filter((r) => r.path.endsWith("/probe") && r.page === n.id)
      .at(-1);
    expect(probe?.headers["x-csrf-token"]).toBe(`csrf.${l.sessionId}`);
    expect(
      f.world.logs.filter(
        (e) => e.type === "trace.surrender" && e.identityRead === true,
      ),
    ).toEqual([]);
    expect(
      f.world.logs.filter(
        (e) =>
          e.type === "trace.display.closed" &&
          e.page === l.page.id &&
          e.cause === "hold",
      ),
    ).toEqual([]);
    expect(checkProperties(f)).toEqual([]);
  });

  test("control: from the record alone a new page adopts exactly the settled session's token", async () => {
    const f = await newWorld();
    const l = await signedInPage(f);
    expect((await adoptedBy(f, l.account, l.epoch)).token).toBe(
      `csrf.${l.sessionId}`,
    );
  });

  test("after the interval a returning page verifies again, and its clean answer refreshes the shared confirmation for every page", async () => {
    const f = await newWorld();
    const l = await signedInPage(f);
    const first = stateOf(f).confirmation?.confirmed_at;
    await forceResumeVerification(f, l.page);
    expect(reads(f, l.page.id)).toHaveLength(1);
    const refreshed = stateOf(f).confirmation;
    expect(refreshed?.session_id).toBe(l.sessionId);
    expect(Date.parse(refreshed?.confirmed_at ?? "")).toBeGreaterThan(
      Date.parse(first ?? ""),
    );
    // A page that boots now finds a fresh confirmation: no identity read.
    const n = f.addPage();
    await f.boot(n);
    await f.world.runUntilIdle();
    expect(reads(f, n.id)).toEqual([]);
    expect(stateOf(f).settled?.session_id).toBe(l.sessionId);
    expect(checkProperties(f)).toEqual([]);
  });

  test("a confirmation that names ANOTHER session is neither adopted nor trusted: the page obtains its own token by an identity read", async () => {
    const f = await newWorld();
    const l = await signedInPage(f);
    const shared = stateOf(f).confirmation;
    if (!shared) throw new Error("no confirmation");
    shared.session_id = "sess-other";
    shared.csrf_token = "csrf.not-this-session";
    // From the record alone, the page adopts nothing; it obtains its own token (its identity read, released by `adoptedBy`).
    const { n, token } = await adoptedBy(f, l.account, l.epoch);
    expect(token).toBeUndefined();
    await f.runWith(ordinaryGet(n, l.account, l.epoch));
    await f.world.runUntilIdle();
    expect(reads(f, n.id).length).toBeGreaterThanOrEqual(1);
    const sent = f.server.requests.filter(
      (r) => r.page === n.id && r.headers["x-csrf-token"] !== undefined,
    );
    expect(sent.length).toBeGreaterThan(0);
    expect(
      sent.every((r) => r.headers["x-csrf-token"] === `csrf.${l.sessionId}`),
    ).toBe(true);
  });

  test("a confirmation that names ANOTHER session does not spare the resume verification: the returning page verifies", async () => {
    const f = await newWorld();
    const l = await signedInPage(f);
    const shared = stateOf(f).confirmation;
    if (!shared) throw new Error("no confirmation");
    shared.session_id = "sess-other";
    l.page.hide();
    await f.settle();
    l.page.show();
    await f.world.runUntilIdle();
    expect(reads(f, l.page.id)).toHaveLength(1);
  });

  test("a confirmation of an older epoch (the session before a re-authentication) is never adopted", async () => {
    const f = await newWorld();
    const l = await signedInPage(f);
    const shared = stateOf(f).confirmation;
    if (!shared) throw new Error("no confirmation");
    shared.epoch = l.epoch - 1;
    shared.csrf_token = "csrf.older-epoch";
    const { n, token } = await adoptedBy(f, l.account, l.epoch);
    expect(token).toBeUndefined();
    await f.runWith(ordinaryGet(n, l.account, l.epoch));
    await f.world.runUntilIdle();
    expect(
      f.server.requests.some(
        (r) => r.headers["x-csrf-token"] === "csrf.older-epoch",
      ),
    ).toBe(false);
    expect(reads(f, n.id).length).toBeGreaterThanOrEqual(1);
  });

  test("a confirmation dated in the FUTURE (a clock moved back) proves nothing: the returning page verifies", async () => {
    const f = await newWorld();
    const l = await signedInPage(f);
    await f.world.advance(l.page.kernel.config.resumeVerificationMinIntervalMs);
    const shared = stateOf(f).confirmation;
    if (!shared) throw new Error("no confirmation");
    shared.confirmed_at = new Date(
      l.page.kernel.ports.clock.now() + 3_600_000,
    ).toISOString();
    l.page.hide();
    await f.settle();
    l.page.show();
    await f.world.runUntilIdle();
    expect(reads(f, l.page.id)).toHaveLength(1);
  });

  test("a record written before the decision (no confirmation) behaves as before: the second page obtains its token by an identity read", async () => {
    const f = await newWorld();
    const l = await signedInPage(f);
    delete stateOf(f).confirmation;
    const n = f.addPage();
    await f.boot(n);
    await f.runWith(ordinaryGet(n, l.account, l.epoch));
    await f.world.runUntilIdle();
    expect(reads(f, n.id).length).toBeGreaterThanOrEqual(1);
    expect(checkProperties(f)).toEqual([]);
  });
});

describe("the lease retirement's confirmation (reducer)", () => {
  const base = () =>
    recordsWith({
      settled: {
        account_id: "acct-1",
        epoch: 3,
        settled_at: "2026-10-13T00:00:00.000Z",
        session_id: "sess-3",
      },
      leases: {
        "lease-1": {
          account_id: "acct-1",
          epoch: 3,
          boot_id: "boot-1",
          class: "verification",
        } as never,
      },
    });
  const confirm = (session_id: string, epoch = 3) => ({
    account_id: "acct-1",
    epoch,
    session_id,
    csrf_token: "csrf.sess-3",
    now: "2026-10-13T00:01:00.000Z",
  });

  test("a clean read of the settled session deletes its lease and writes the confirmation; `settled` is untouched (P-F)", () => {
    const before = base();
    const out = retireOwnLease(before, {
      lease_id: "lease-1",
      confirm: confirm("sess-3"),
    });
    expect(out.write?.auth_state?.leases).toEqual({});
    expect(out.write?.auth_state?.settled).toEqual(before.auth_state.settled);
    expect(out.write?.auth_state?.confirmation).toMatchObject({
      session_id: "sess-3",
      confirmed_at: "2026-10-13T00:01:00.000Z",
    });
  });

  for (const [name, c] of [
    ["another session", confirm("sess-other")],
    ["another epoch", confirm("sess-3", 2)],
  ] as const)
    test(`a read of ${name} deletes its lease and writes NO confirmation`, () => {
      const out = retireOwnLease(base(), { lease_id: "lease-1", confirm: c });
      expect(out.write?.auth_state?.leases).toEqual({});
      expect(out.write?.auth_state?.confirmation).toBeUndefined();
    });
});
