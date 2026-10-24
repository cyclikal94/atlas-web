// @vitest-environment node
import { describe, expect, test } from "vitest";
import {
  authRequests,
  checkProperties,
  firstCommitSeq,
  grantedBetween,
} from "../support/session/properties";
import {
  attemptOf,
  fenceList,
  fencesOf,
  holdAnswers,
  holdLock,
  identityReadsSoFar,
  installAttempt,
  leaseIds,
  newWorld,
  openPage,
  ordinaryGet,
  signedInPage,
  stateOf,
} from "../support/session/scenarios";

/**
 * F-REC-*: T23 A to D and B2, then E to H. The observing page records a detected invalidation WITHOUT requesting
 * `atlas-auth`, however long a frozen holder keeps it; nothing is dropped; a stale stamp writes nothing.
 * These are fixture tests against a stub of the contract: they show the module behaves as specified.
 */
async function settleRequest<T>(
  f: Awaited<ReturnType<typeof newWorld>>,
  promise: Promise<T>,
) {
  const result = promise.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({
      ok: false as const,
      error: error as { kind?: string; name?: string },
    }),
  );
  await f.world.runUntilIdle();
  return result;
}

describe("T23 variant A: a 401 with a current stamp while a frozen tab holds atlas-auth", () => {
  test("is recorded with ZERO atlas-auth requests, closes a second tab, pauses replay, and survives the resolution and an offline reload", async () => {
    const f = await newWorld();
    const l = await signedInPage(f);
    const second = await openPage(f);
    expect(second.session.view.get().kind).toBe("displaying");
    // L has a request in flight that was sent (stamp 1) BEFORE the gate rose; its answer is held.
    const held = holdAnswers(f, (r) => r.path.endsWith("/probe"));
    f.server.revoke(l.sessionId);
    const request = settleRequest(f, ordinaryGet(l.page, l.account, l.epoch));
    await f.world.runUntilIdle();
    expect(leaseIds(f)).toHaveLength(1);
    // Then a frozen tab H holds atlas-auth inside its lock callback and gates: attempt {2, activating}.
    const releaseAuth = await holdLock(f, "H", "atlas-auth");
    installAttempt(f, {
      epoch: 2,
      phase: "activating",
      serverGrant: { account: "acct-2", state: "issued" },
    });
    held.stop();
    const before = f.world.logs.length;
    held.release();
    await f.world.runUntilIdle();
    const outcome = await request;
    // t1: the observation is recorded lock-free: fence added, lease deleted, no atlas-auth request from L or the second tab.
    expect(outcome).toMatchObject({ ok: false, error: { kind: "auth_state" } });
    expect(fencesOf(f, l.account)).toEqual(["invalid_session"]);
    expect(stateOf(f).fences[l.account]?.[0]).toMatchObject({
      seq: 1,
      epoch: 1,
      kind: "invalid_session",
      reason: "unauthenticated",
    });
    expect(stateOf(f).attempt?.observations_deferred).toBeNull(); // a 401 is never deferred
    expect(leaseIds(f)).toEqual([]);
    // The recording committed BEFORE this page made any atlas-auth request, and no page was granted atlas-auth while H held it.
    const committed = firstCommitSeq(f, l.page.id, "record", before);
    expect(authRequests(f, l.page.id, before, committed)).toBe(0);
    expect(authRequests(f, second.id, before, committed)).toBe(0);
    expect(grantedBetween(f, l.page.id, "atlas-auth", before)).toBe(false);
    expect(grantedBetween(f, second.id, "atlas-auth", before)).toBe(false);
    // Neutral in every tab, and the second tab (a hint) closed too.
    for (const page of [l.page, second])
      expect(page.session.view.get().kind).toBe("neutral");
    expect(second.surface.mounted).toBeNull();
    // t4: H resumes; the attempt is resolved; the fence is NOT touched by the clearing transaction.
    releaseAuth();
    l.page.session.actions.retry();
    await f.world.runUntilIdle();
    expect(stateOf(f).attempt).toBeNull();
    expect(fencesOf(f, l.account)).toEqual(["invalid_session"]);
    expect(f.server.grants.get("grant-2")?.state).toBe("cancelled");
    // t5: the browser is closed and reopened OFFLINE: nothing of C is mounted (state 1b).
    l.page.destroy();
    second.destroy();
    const reopened = f.addPage();
    reopened.goOffline();
    await f.boot(reopened);
    expect(reopened.session.view.get()).toMatchObject({
      kind: "neutral",
      state: "1b",
    });
    expect(reopened.surface.mounted).toBeNull();
    expect(checkProperties(f)).toEqual([]);
  });
});

describe("T23 variant B: a 403 credential_mismatch during a gating attempt", () => {
  test("sets the deferral marker instead of a fence; the cancel result turns the clear into `verifying`, and OBSERVE ends it", async () => {
    const f = await newWorld();
    const l = await signedInPage(f);
    // The cookie now names another session of the same account: the request's CSRF token no longer matches it.
    f.server.adoptCookie(f.server.createSession(l.account, "dev-2"));
    const held = holdAnswers(f, (r) => r.path.endsWith("/probe"));
    const request = settleRequest(f, ordinaryGet(l.page, l.account, l.epoch));
    await f.world.runUntilIdle();
    const releaseAuth = await holdLock(f, "H", "atlas-auth");
    installAttempt(f, {
      epoch: 2,
      phase: "activating",
      serverGrant: { account: "acct-2", state: "issued" },
    });
    held.stop();
    const before = f.world.logs.length;
    held.release();
    const outcome = await request;
    expect(outcome).toMatchObject({ ok: false, error: { kind: "auth_state" } });
    expect(stateOf(f).attempt?.observations_deferred).toBe(1);
    expect(fencesOf(f, l.account)).toEqual([]);
    expect(leaseIds(f)).toEqual([]);
    expect(
      authRequests(
        f,
        l.page.id,
        before,
        firstCommitSeq(f, l.page.id, "record", before),
      ),
    ).toBe(0);
    expect(grantedBetween(f, l.page.id, "atlas-auth", before)).toBe(false);
    // H resumes and the attempt is resolved: the marker turns `not_activated` into `verifying`; it is NOT cleared.
    releaseAuth();
    l.page.session.actions.retry();
    await f.world.runUntilIdle();
    // OBSERVE (`s` = 1): current() names the same account with a different session_id, marker 1 <= s: the attempt clears.
    expect(stateOf(f).attempt).toBeNull();
    expect(f.server.grants.get("grant-2")?.state).toBe("cancelled");
    expect(checkProperties(f, { invalidating: [401, 403] })).toEqual([]);
  });
});

describe("T23 variant B2: the marker is written while the resolution is in progress", () => {
  test("(a) a marker that lands during the cancel request is read INSIDE the clearing transaction: `verifying`, not cleared", async () => {
    const f = await newWorld();
    const l = await signedInPage(f);
    installAttempt(f, {
      epoch: 2,
      phase: "indeterminate",
      serverGrant: { account: "acct-2", state: "issued" },
    });
    const held = holdAnswers(f, (r) => r.path.endsWith("/activate/cancel"));
    l.page.session.actions.retry();
    await f.world.runUntilIdle();
    expect(f.world.heldCount("Da")).toBe(1);
    // L's mismatch commits after the cancel was sent and before `not_activated` arrives.
    attemptOf(f).observations_deferred = 8;
    stateOf(f).fence_seq = 8;
    held.stop();
    held.release();
    await f.world.runUntilIdle();
    // The clearing transaction found marker 8, so the attempt went to `verifying` and OBSERVE then ended it (marker 8 <= s).
    expect(
      f.server.requests.some((r) =>
        r.path.endsWith("/browser-sessions/current"),
      ),
    ).toBe(true);
    expect(stateOf(f).attempt).toBeNull();
    expect(checkProperties(f, { invalidating: [401, 403] })).toEqual([]);
  });

  test("(b) a marker that lands while OBSERVE's current() is in flight is newer than `s`: the attempt stays `verifying` and observes again", async () => {
    const f = await newWorld();
    const l = await signedInPage(f);
    installAttempt(f, {
      epoch: 2,
      phase: "verifying",
      cancel: "session_revoked",
    });
    // ADAPTED (WEB-08c revision 2, HF1-SHARED-CONFIRMATION-20261013): was `r.ordinal === 2` (the first identity read after the post-sign-in
    // resume verification, which the shared confirmation now spares); the same "OBSERVE's own read".
    const before = identityReadsSoFar(f);
    const held = holdAnswers(
      f,
      (r) =>
        r.path.endsWith("/browser-sessions/current") &&
        r.ordinal === before + 1,
    );
    l.page.session.actions.retry();
    await f.world.runUntilIdle();
    expect(f.world.heldCount("Da")).toBe(1);
    attemptOf(f).observations_deferred = stateOf(f).fence_seq + 1;
    stateOf(f).fence_seq += 1;
    held.stop();
    held.release();
    await f.world.runUntilIdle();
    const reads = f.server.requests.filter((r) =>
      r.path.endsWith("/browser-sessions/current"),
    );
    // ADAPTED (WEB-08c revision 2, HF1-SHARED-CONFIRMATION-20261013): was `>= 3` (this page's own CSRF read + the held answer + the second
    // observation); the token is now the settlement's shared one, so: the held answer and the second observation, after the baseline.
    expect(reads.length).toBeGreaterThanOrEqual(before + 2);
    expect(stateOf(f).attempt).toBeNull();
    expect(leaseIds(f)).toEqual([]);
  });
});

describe("T23 variant C: the activation is definitively refused while a marker is set", () => {
  test("the clearing transaction promotes the marker to credential_unverified, and one current() read then settles it", async () => {
    const f = await newWorld();
    const l = await signedInPage(f);
    f.server.deviceCapacity = 1; // an Atlas 503 device_capacity is a definitive refusal
    const begun = await f.runWith(l.page.session.attempts.begin("password"));
    if (begun.kind !== "started") throw new Error("not started");
    const held = holdAnswers(f, (r) =>
      r.path.endsWith("/browser-sessions/activate"),
    );
    const outcome = l.page.session.attempts.signInWithPassword(begun.handle, {
      username: "sam",
      password: "pw2",
    });
    await f.world.runUntilIdle();
    expect(stateOf(f).attempt?.phase).toBe("activating");
    // A mismatch recorded while the activation was in flight.
    attemptOf(f).observations_deferred = stateOf(f).fence_seq + 1;
    stateOf(f).fence_seq += 1;
    held.stop();
    held.release();
    const result = await f.runWith(outcome);
    expect(result).toMatchObject({ kind: "refused", definitive: true });
    expect(stateOf(f).attempt).toBeNull();
    await f.world.runUntilIdle();
    // The credential_unverified fence was verified by one leased current() read (same account, same session): cleared.
    expect(fencesOf(f, l.account)).toEqual([]);
    expect(
      f.server.requests.filter((r) =>
        r.path.endsWith("/browser-sessions/current"),
      ).length,
    ).toBeGreaterThan(0);
  });
});

describe("T23 variant D: a genuinely newer settlement must not inherit or lose an observation", () => {
  async function held401(f: Awaited<ReturnType<typeof newWorld>>) {
    const l = await signedInPage(f);
    const held = holdAnswers(f, (r) => r.path.endsWith("/probe"));
    f.server.revoke(l.sessionId);
    const request = settleRequest(f, ordinaryGet(l.page, l.account, l.epoch));
    await f.world.runUntilIdle();
    return { l, held, request };
  }
  test("D1: X settles before L's recording runs: STALE, nothing recorded, l1 deleted, X renders", async () => {
    const f = await newWorld();
    const { l, held, request } = await held401(f);
    const h = f.addPage();
    await f.boot(h);
    const settled = await f.signIn(h, "sam", "pw2");
    expect(settled).toMatchObject({ kind: "settled", epoch: 2 });
    await f.settle();
    held.stop();
    held.release();
    await f.world.runUntilIdle();
    await request;
    expect(stateOf(f).fences).toEqual({});
    expect(leaseIds(f)).toEqual([]);
    expect(h.session.view.get().kind).toBe("displaying");
    expect(stateOf(f).settled).toMatchObject({ epoch: 2 });
    expect(
      l.page.session.view.get().kind === "displaying" ||
        l.page.session.view.get().kind === "neutral",
    ).toBe(true);
  });
  test("D2: the observation first, then X settles: C's fence stays keyed to C and never applies to X", async () => {
    const f = await newWorld();
    const { l, held, request } = await held401(f);
    held.stop();
    held.release();
    await f.world.runUntilIdle();
    await request;
    expect(fencesOf(f, l.account)).toEqual(["invalid_session"]);
    const h = f.addPage();
    await f.boot(h);
    expect(await f.signIn(h, "sam", "pw2")).toMatchObject({
      kind: "settled",
      epoch: 2,
    });
    await f.settle();
    expect(fencesOf(f, l.account)).toEqual(["invalid_session"]);
    expect(stateOf(f).fences["acct-2"]).toBeUndefined();
    expect(h.session.view.get().kind).toBe("displaying");
  });
  test("D3: the person re-authenticates as C: the epoch-1 fence stays until catch-up; a 401 recorded on the NEW session survives the clear", async () => {
    const f = await newWorld();
    const { l, held, request } = await held401(f);
    held.stop();
    held.release();
    await request;
    await f.world.runUntilIdle();
    expect(await f.signIn(l.page, "kieran", "pw")).toMatchObject({
      kind: "settled",
      epoch: 2,
    });
    await f.settle();
    expect(l.page.session.view.get()).toMatchObject({
      kind: "neutral",
      state: "2",
    });
    expect(stateOf(f).fences[l.account]).toHaveLength(1);
    // Recovery begins (`s` captured), then a 401 on the new session is recorded under epoch 2 with a higher seq.
    const begun = await f.runWith(l.page.session.recovery.begin(l.account));
    if (begun.kind !== "eligible")
      throw new Error(`recovery not eligible: ${begun.reason}`);
    fenceList(f, l.account).push({
      seq: 5,
      epoch: 2,
      obs_id: "late",
      kind: "invalid_session",
      reason: "unauthenticated",
      created_at: "x",
    });
    stateOf(f).fence_seq = 5;
    const finished = await f.runWith(
      l.page.session.recovery.finish(begun.handle),
    );
    expect(finished).toBe("not_eligible"); // an entry of the CURRENT epoch makes the account ineligible
    expect(stateOf(f).fences[l.account]).toHaveLength(2); // nothing was cleared that the recovery did not cover
  });
});

describe("T23 variants E to H: the write itself fails", () => {
  test("E: a 401, an aborted recording, every tab closed, an offline reload with a working canary: state 1e (offline); online verification then fences (401)", async () => {
    const f = await newWorld();
    const l = await signedInPage(f);
    f.store.inject({ match: (tx) => tx.label === "record", mode: "abort" });
    f.server.revoke(l.sessionId);
    const request = settleRequest(f, ordinaryGet(l.page, l.account, l.epoch));
    await f.world.runUntilIdle();
    expect(await request).toMatchObject({
      ok: false,
      error: { kind: "auth_state" },
    });
    // Atomic: nothing changed. The lease is still in the record and its lock was surrendered.
    expect(leaseIds(f)).toHaveLength(1);
    expect(fencesOf(f, l.account)).toEqual([]);
    expect(l.page.session.view.get().kind).toBe("neutral"); // the owner holds it in memory
    await f.world.advance(70_000); // retries keep failing; nothing is dropped
    expect(leaseIds(f)).toHaveLength(1);
    // Every tab closes before any retry commits.
    l.page.destroy();
    f.store.clearInjections();
    const reopened = f.addPage();
    reopened.goOffline();
    await f.boot(reopened);
    expect(reopened.session.view.get()).toMatchObject({
      kind: "neutral",
      state: "1e.interrupted_offline",
    });
    expect(reopened.surface.mounted).toBeNull();
    // Back online: one verification answers 401: the lease becomes an invalid_session fence (E4).
    reopened.goOnline();
    await f.world.runUntilIdle();
    expect(fencesOf(f, l.account)).toEqual(["invalid_session"]);
    expect(stateOf(f).fences[l.account]?.[0]).toMatchObject({
      reason: "unresolved_response",
    });
    expect(leaseIds(f)).toEqual([]);
    expect(reopened.session.view.get()).toMatchObject({
      kind: "neutral",
      state: "1b",
    });
  });

  test("F: a 403 credential_mismatch, recording aborted, every tab closed: offline 1e; online 200 with the SAME session reopens (E3)", async () => {
    const f = await newWorld();
    const l = await signedInPage(f);
    f.store.inject({ match: (tx) => tx.label === "record", mode: "abort" });
    f.server.adoptCookie(f.server.createSession(l.account, "dev-2")); // spurious mismatch: a different session cookie
    const request = settleRequest(f, ordinaryGet(l.page, l.account, l.epoch));
    await f.world.runUntilIdle();
    expect(await request).toMatchObject({
      ok: false,
      error: { kind: "auth_state" },
    });
    expect(leaseIds(f)).toHaveLength(1);
    l.page.destroy();
    f.store.clearInjections();
    const reopened = f.addPage();
    reopened.goOffline();
    await f.boot(reopened);
    expect(reopened.session.view.get()).toMatchObject({
      kind: "neutral",
      state: "1e.interrupted_offline",
    });
    // The cookie now names the settled session again: the strict match retires the lease with no re-authentication.
    f.server.adoptCookie(
      [...f.server.sessions.values()].find((s) => s.id === l.sessionId) ??
        f.server.createSession(l.account, "dev"),
    );
    f.server.sessions.set(
      l.sessionId,
      f.server.sessions.get(l.sessionId) ?? {
        id: l.sessionId,
        account: l.account,
        device: "dev",
        created: 0,
        authentication: "local",
        token: `tok.${l.sessionId}`,
      },
    );
    const original = f.server.sessions.get(l.sessionId);
    if (original) f.server.adoptCookie(original);
    reopened.goOnline();
    await f.world.runUntilIdle();
    expect(leaseIds(f)).toEqual([]);
    expect(fencesOf(f, l.account)).toEqual([]);
    expect(reopened.session.view.get().kind).toBe("displaying");
  });

  test("G: the gating attempt and the cancel with the recording aborted: the cancel touches no lease, so the account stays closed", async () => {
    const f = await newWorld();
    const l = await signedInPage(f);
    const held = holdAnswers(f, (r) => r.path.endsWith("/probe"));
    f.server.adoptCookie(f.server.createSession(l.account, "dev-2"));
    const request = settleRequest(f, ordinaryGet(l.page, l.account, l.epoch));
    await f.world.runUntilIdle();
    const releaseAuth = await holdLock(f, "H", "atlas-auth");
    installAttempt(f, {
      epoch: 2,
      phase: "activating",
      serverGrant: { account: "acct-2", state: "issued" },
    });
    f.store.inject({ match: (tx) => tx.label === "record", mode: "abort" });
    held.stop();
    held.release();
    await request;
    expect(leaseIds(f)).toHaveLength(1);
    releaseAuth();
    f.store.clearInjections();
    const other = await openPage(f);
    l.page.destroy();
    other.session.actions.retry();
    await f.world.runUntilIdle();
    // The attempt is gone (cancel: not_activated, marker null) but the unresolved lease still closes the account.
    expect(stateOf(f).attempt).toBeNull();
    expect(other.surface.mounted).toBeNull();
  });

  test("H: the recording pending at destruction: (H1) it commits -> 1b offline; (H2) it does not -> 1e offline", async () => {
    for (const commit of [true, false]) {
      const f = await newWorld();
      const l = await signedInPage(f);
      f.store.inject({
        match: (tx) => tx.label === "record",
        mode: "pending_blocking",
      });
      f.server.revoke(l.sessionId);
      const request = settleRequest(f, ordinaryGet(l.page, l.account, l.epoch));
      await f.world.runUntilIdle();
      void request;
      // The specification is silent on whether a transaction pending at unload commits; the design does not need to know.
      l.page.destroy(commit ? "commit" : "abort");
      f.store.clearInjections();
      const reopened = f.addPage();
      reopened.goOffline();
      await f.boot(reopened);
      expect(reopened.session.view.get()).toMatchObject({
        kind: "neutral",
        state: commit ? "1b" : "1e.interrupted_offline",
      });
      expect(reopened.surface.mounted).toBeNull();
    }
  });
});

describe("T23 variants I to K: controls", () => {
  test("J: the clean ordinary-offline control renders from IndexedDB with no gate and no network", async () => {
    const f = await newWorld();
    const l = await signedInPage(f);
    await f.runWith(ordinaryGet(l.page, l.account, l.epoch));
    expect(leaseIds(f)).toEqual([]);
    l.page.destroy();
    const before = f.server.requests.length;
    const reopened = f.addPage();
    reopened.goOffline();
    await f.boot(reopened);
    expect(reopened.session.view.get().kind).toBe("displaying");
    expect(f.server.requests.length).toBe(before); // an exposure makes no network call (offline, nothing can reach the server)
    expect(
      f.world.logs.some(
        (l) => l.type === "fetch.sent" && l.page === reopened.id,
      ),
    ).toBe(false);
  });

  test("K: a benign orphan is resolved by ONE strict current() with no re-authentication", async () => {
    const f = await newWorld();
    const l = await signedInPage(f);
    const held = holdAnswers(f, (r) => r.path.endsWith("/probe"));
    void ordinaryGet(l.page, l.account, l.epoch).catch(() => undefined);
    await f.world.runUntilIdle();
    expect(leaseIds(f)).toHaveLength(1);
    l.page.destroy(); // the tab closes while the request is outstanding
    held.stop();
    const reopened = f.addPage();
    reopened.goOffline();
    await f.boot(reopened);
    expect(reopened.session.view.get()).toMatchObject({
      kind: "neutral",
      state: "1e.interrupted_offline",
    });
    reopened.goOnline();
    await f.world.runUntilIdle();
    expect(leaseIds(f)).toEqual([]);
    expect(fencesOf(f, l.account)).toEqual([]);
    expect(reopened.session.view.get().kind).toBe("displaying");
    expect(
      f.server.requests.filter((r) =>
        r.path.endsWith("/browser-sessions/current"),
      ).length,
    ).toBeGreaterThan(0);
  });

  test("I2: an unresolved lease of another account never closes a newly settled account", async () => {
    const f = await newWorld();
    const l = await signedInPage(f);
    f.store.inject({ match: (tx) => tx.label === "record", mode: "abort" });
    f.server.revoke(l.sessionId);
    await settleRequest(f, ordinaryGet(l.page, l.account, l.epoch));
    l.page.destroy();
    f.store.clearInjections();
    // The verification cannot complete (a gateway answers 502), so the lease of C stays unresolved.
    f.server.addRule({
      match: (r) => r.path.endsWith("/browser-sessions/current"),
      rewrite: {
        status: 502,
        body: "<html>bad gateway</html>",
        contentType: "text/html",
      },
    });
    const h = f.addPage();
    await f.boot(h);
    expect(await f.signIn(h, "sam", "pw2")).toMatchObject({ kind: "settled" });
    await f.settle();
    expect(h.session.view.get().kind).toBe("displaying");
    expect(leaseIds(f)).toHaveLength(1); // C's lease never closes X
  });

  test("I3: the same account re-authenticates: the older-epoch unresolved lease becomes a fence (E5), recovery eligible", async () => {
    const f = await newWorld();
    const l = await signedInPage(f);
    f.store.inject({ match: (tx) => tx.label === "record", mode: "abort" });
    f.server.revoke(l.sessionId);
    await settleRequest(f, ordinaryGet(l.page, l.account, l.epoch));
    l.page.destroy();
    f.store.clearInjections();
    const h = f.addPage();
    await f.boot(h);
    expect(await f.signIn(h, "kieran", "pw")).toMatchObject({
      kind: "settled",
      epoch: 2,
    });
    await f.settle();
    expect(stateOf(f).fences[l.account]?.[0]).toMatchObject({
      kind: "invalid_session",
      reason: "unresolved_response",
      epoch: 1,
    });
    expect(leaseIds(f)).toEqual([]);
    expect(h.session.view.get()).toMatchObject({
      kind: "neutral",
      state: "2",
    });
  });

  test("I4: an OUTSTANDING sibling's lease defers a new tab; a clean 200 opens it, a 401 closes it", async () => {
    for (const status of [200, 401]) {
      const f = await newWorld();
      const m = await signedInPage(f);
      const held = holdAnswers(f, (r) => r.path.endsWith("/probe"));
      if (status === 401) f.server.revoke(m.sessionId);
      const request = settleRequest(f, ordinaryGet(m.page, m.account, m.epoch));
      await f.world.runUntilIdle();
      const n = f.addPage();
      const booted = f.boot(n);
      await f.world.runUntilIdle();
      expect(n.surface.mounted).toBeNull(); // waits for M: a held lock is not evidence
      held.stop();
      held.release();
      await request;
      await booted;
      await f.world.runUntilIdle();
      if (status === 200) expect(n.session.view.get().kind).toBe("displaying");
      else expect(n.session.view.get().kind).toBe("neutral");
      expect(checkProperties(f)).toEqual([]);
    }
  });
});
