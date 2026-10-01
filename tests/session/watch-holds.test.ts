// @vitest-environment node
import { describe, expect, test } from "vitest";
import { checkProperties } from "../support/session/properties";
import {
  fencesOf,
  holdAnswers,
  leaseIds,
  newWorld,
  openPage,
  ordinaryGet,
  signedInPage,
} from "../support/session/scenarios";

/**
 * F-WATCH-*: every `w:<lease>` hold a displaying page takes for an orphaned foreign lease is released when THAT lease has
 * been resolved (matrix 3.7.2 "Unresolved lease found"; evidence E3; T23 K). Two watches could fire for two orphaned leases;
 * the second found a verification already running and was handed `in_flight`, and nothing ever released its hold, so the
 * page stayed on "Checking your account" with a clear record until it was reloaded.
 */
async function twoOrphanedRequests() {
  const f = await newWorld();
  const l = await signedInPage(f);
  const m = await openPage(f);
  expect(m.session.view.get().kind).toBe("displaying");
  const held = holdAnswers(f, (r) => r.path.endsWith("/probe"));
  void ordinaryGet(l.page, l.account, l.epoch).catch(() => undefined);
  void ordinaryGet(l.page, l.account, l.epoch).catch(() => undefined);
  await f.world.runUntilIdle();
  const leases = leaseIds(f);
  expect(leases).toHaveLength(2);
  return { f, l, m, held, leases: leases as [string, string] };
}

const holdNames = (page: {
  kernel: { memory: { holds: Map<string, Set<string>> } };
}) => [...page.kernel.memory.holds.values()].flatMap((set) => [...set]).sort();

describe("two watches for two orphaned request leases", () => {
  test("a strict successful verification clears both durable leases and BOTH holds, and the page displays again without reloading", async () => {
    const { f, l, m, held } = await twoOrphanedRequests();
    l.page.destroy();
    held.stop();
    await f.world.runUntilIdle();
    expect(leaseIds(f)).toEqual([]);
    expect([...m.kernel.memory.holds.entries()]).toEqual([]);
    expect(m.session.view.get().kind).toBe("displaying");
    expect(m.surface.mounted?.account).toBe(l.account);
    expect(m.kernel.neutral.unresolvedLeaseKnown).toBe(false);
    expect(checkProperties(f)).toEqual([]);
  });

  test("the same with THREE orphaned leases", async () => {
    const f = await newWorld();
    const l = await signedInPage(f);
    const m = await openPage(f);
    const held = holdAnswers(f, (r) => r.path.endsWith("/probe"));
    for (let i = 0; i < 3; i += 1)
      void ordinaryGet(l.page, l.account, l.epoch).catch(() => undefined);
    await f.world.runUntilIdle();
    expect(leaseIds(f)).toHaveLength(3);
    l.page.destroy();
    held.stop();
    await f.world.runUntilIdle();
    expect(leaseIds(f)).toEqual([]);
    expect([...m.kernel.memory.holds.entries()]).toEqual([]);
    expect(m.session.view.get().kind).toBe("displaying");
  });

  test("a verification that cannot complete (the server answers 503) keeps BOTH holds, and is repeated until it does", async () => {
    const { f, l, m, held, leases } = await twoOrphanedRequests();
    const unavailable = f.server.addRule({
      match: (r) => r.path.endsWith("/browser-sessions/current"),
      rewrite: { status: 503, body: { code: "unavailable", message: "x" } },
      times: 1,
    });
    l.page.destroy();
    held.stop();
    await f.world.runUntilIdle();
    // The evidence failed: the leases are still in the record, so the holds stay and the page shows nothing.
    expect(leaseIds(f)).toHaveLength(2);
    expect(holdNames(m)).toEqual(leases.map((id) => `w:${id}`).sort());
    expect(m.surface.mounted).toBeNull();
    await f.world.advance(10_000);
    unavailable();
    expect(leaseIds(f)).toEqual([]);
    expect([...m.kernel.memory.holds.entries()]).toEqual([]);
    expect(m.session.view.get().kind).toBe("displaying");
    expect(checkProperties(f)).toEqual([]);
  });

  test("a settlement that replaces the identity while the verification runs does not strand the hold", async () => {
    const { f, l, m, held } = await twoOrphanedRequests();
    const identity = holdAnswers(f, (r) =>
      r.path.endsWith("/browser-sessions/current"),
    );
    l.page.destroy();
    held.stop();
    await f.world.runUntilIdle();
    expect(holdNames(m)).toHaveLength(2);
    // The person signs in as another account in this page while its verification for the first account is unanswered.
    expect((await f.signIn(m, "sam", "pw2")).kind).toBe("settled");
    await f.settle();
    identity.stop();
    identity.release();
    await f.world.advance(10_000);
    expect(m.kernel.memory.settled?.account).not.toBe(l.account);
    expect([...m.kernel.memory.holds.entries()]).toEqual([]);
    expect(m.session.view.get().kind).toBe("displaying");
    expect(checkProperties(f)).toEqual([]);
  });

  test("offline the evidence cannot be gathered: both holds stay, nothing is displayed, and they clear when the page is online again", async () => {
    const { f, l, m, held, leases } = await twoOrphanedRequests();
    m.goOffline();
    l.page.destroy();
    held.stop();
    await f.world.runUntilIdle();
    await f.world.advance(20_000);
    expect(holdNames(m)).toEqual(leases.map((id) => `w:${id}`).sort());
    expect(leaseIds(f)).toHaveLength(2);
    expect(m.surface.mounted).toBeNull();
    m.goOnline();
    await f.world.advance(20_000);
    expect(leaseIds(f)).toEqual([]);
    expect([...m.kernel.memory.holds.entries()]).toEqual([]);
    expect(m.session.view.get().kind).toBe("displaying");
    expect(checkProperties(f)).toEqual([]);
  });

  test("a verification that finds the session invalid fences the account; no hold is left behind either", async () => {
    const { f, l, m, held } = await twoOrphanedRequests();
    f.server.revoke(l.sessionId);
    l.page.destroy();
    held.stop();
    await f.world.runUntilIdle();
    await f.world.advance(10_000);
    expect(fencesOf(f, l.account)).toEqual(["invalid_session"]);
    expect(leaseIds(f)).toEqual([]);
    expect([...m.kernel.memory.holds.entries()]).toEqual([]);
    expect(m.surface.mounted).toBeNull();
    expect(m.session.view.get()).toMatchObject({
      kind: "neutral",
      state: "1b",
    });
    expect(checkProperties(f)).toEqual([]);
  });
});
