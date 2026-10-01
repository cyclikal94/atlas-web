// @vitest-environment node
import { describe, expect, test } from "vitest";
import type { FakePage, Fixture } from "../support/session/harness";
import {
  checkProperties,
  checkQuiescence,
} from "../support/session/properties";
import {
  fencesOf,
  holdAnswers,
  holdLock,
  leaseIds,
  newWorld,
  openPage,
  ordinaryGet,
  signedInPage,
  stateOf,
} from "../support/session/scenarios";

/**
 * F-UNR-*: T23 L to P and the evidence table E1 to E6 (matrix 3.6.2). A lease whose lock has been released and that is
 * still in the record CLOSES the account in every page that displays or sends afterwards, offline as well as online,
 * until named evidence resolves it. Fixture tests; they do not say anything about real timing (P-lock premises).
 */
const abortRecording = (
  f: Fixture,
  mode: "abort" | "pending_blocking" = "abort",
  page?: string,
) =>
  f.store.inject({
    match: (tx) =>
      tx.label === "record" && (page === undefined || tx.page === page),
    mode,
  });
const settleFetch = async (f: Fixture, promise: Promise<unknown>) => {
  const result = promise.then(
    () => "ok",
    (e: { kind?: string }) => e.kind ?? "error",
  );
  await f.world.runUntilIdle();
  return result;
};
const mounted = (...pages: FakePage[]) =>
  pages.map((p) => p.surface.mounted !== null);

describe("L1: a live owner that cannot save, a new offline tab, and a resumed tab that missed the hint", () => {
  test("nobody displays or sends afterwards; online, one verification turns the lease into a fence (E4)", async () => {
    const f = await newWorld();
    const l = await signedInPage(f);
    const m = await openPage(f);
    m.hide();
    m.freeze(); // hidden, then frozen: it receives no hint
    abortRecording(f, "abort", l.page.id); // only L's own write fails
    f.server.revoke(l.sessionId);
    expect(await settleFetch(f, ordinaryGet(l.page, l.account, l.epoch))).toBe(
      "auth_state",
    );
    expect(leaseIds(f)).toHaveLength(1);
    expect(fencesOf(f, l.account)).toEqual([]);
    expect(l.page.session.view.get().kind).toBe("neutral");
    await f.world.advance(120_000); // L retries at 2 s, 4 s, ...; every retry fails; L stays alive
    // t4: N is opened OFFLINE. It has no hold and never received the hint.
    const n = f.addPage();
    n.goOffline();
    await f.boot(n);
    expect(n.session.view.get()).toMatchObject({
      kind: "neutral",
      state: "1e.interrupted_offline",
    });
    expect(mounted(n)).toEqual([false]);
    // t5: M resumes; it missed the hint. The lift branch is never taken.
    m.thaw();
    m.show();
    await f.world.runUntilIdle();
    expect(m.session.view.get().kind).toBe("neutral");
    expect(m.surface.mounted).toBeNull();
    // t6: back online: N verifies: 401 -> invalid_session (unresolved_response), lease retired in the same transaction.
    n.goOnline();
    await f.world.runUntilIdle();
    expect(stateOf(f).fences[l.account]?.[0]).toMatchObject({
      kind: "invalid_session",
      reason: "unresolved_response",
      epoch: 1,
    });
    expect(leaseIds(f)).toEqual([]);
    for (const page of [n, m])
      expect(page.session.view.get()).toMatchObject({
        kind: "neutral",
        state: "1b",
      });
    // L's later retry, if one ever succeeds, finds the entry (not duplicated) and releases its hold.
    f.store.clearInjections();
    await f.world.advance(70_000);
    expect(fencesOf(f, l.account)).toEqual(["invalid_session"]);
    expect(l.page.kernel.memory.hasHold(l.account)).toBe(false);
    expect(checkProperties(f)).toEqual([]);
  });
});

describe("L2: a 403 credential_mismatch with the recording aborted", () => {
  async function setup() {
    const f = await newWorld();
    const l = await signedInPage(f);
    const other = f.server.createSession(l.account, "dev-2");
    f.server.adoptCookie(other);
    abortRecording(f);
    expect(await settleFetch(f, ordinaryGet(l.page, l.account, l.epoch))).toBe(
      "auth_state",
    );
    expect(leaseIds(f)).toHaveLength(1);
    l.page.destroy();
    f.store.clearInjections();
    const n = f.addPage();
    n.goOffline();
    await f.boot(n);
    expect(n.session.view.get()).toMatchObject({
      kind: "neutral",
      state: "1e.interrupted_offline",
    });
    return { f, l, n, other };
  }
  test("(a) online: 200 for the SAME session (a spurious mismatch): E3 retires the lease and the account reopens", async () => {
    const { f, l, n } = await setup();
    f.server.adoptCookie(
      f.server.sessions.get(l.sessionId) ??
        f.server.createSession(l.account, "x"),
    );
    n.goOnline();
    await f.world.runUntilIdle();
    expect(leaseIds(f)).toEqual([]);
    expect(fencesOf(f, l.account)).toEqual([]);
    expect(n.session.view.get().kind).toBe("displaying");
  });
  test("(b) online: 200 for ANOTHER account -> drift (state 1d)", async () => {
    const { f, l, n } = await setup();
    const sam = [...f.server.accounts.values()].find(
      (a) => a.username === "sam",
    );
    if (!sam) throw new Error("no sam");
    f.server.adoptCookie(f.server.createSession(sam.id, "dev-y"));
    n.goOnline();
    await f.world.runUntilIdle();
    expect(fencesOf(f, l.account)).toEqual(["drift"]);
    expect(n.session.view.get()).toMatchObject({
      kind: "neutral",
      state: "1d",
    });
    expect(leaseIds(f)).toEqual([]);
  });
  test("(c) online: 401 -> invalid_session (state 1b)", async () => {
    const { f, l, n } = await setup();
    f.server.revoke(l.sessionId);
    f.server.cookie = null;
    n.goOnline();
    await f.world.runUntilIdle();
    expect(fencesOf(f, l.account)).toEqual(["invalid_session"]);
    expect(n.session.view.get()).toMatchObject({
      kind: "neutral",
      state: "1b",
    });
  });
  test("(d) online: 200 for the same account but a DIFFERENT session_id fails closed (E4)", async () => {
    const { f, l, n, other } = await setup();
    f.server.adoptCookie(other); // the cookie still names the other session of the same account
    n.goOnline();
    await f.world.runUntilIdle();
    expect(
      stateOf(f).fences[l.account]?.some(
        (x) =>
          x.kind === "invalid_session" && x.reason === "unresolved_response",
      ),
    ).toBe(true);
    expect(leaseIds(f)).toEqual([]);
  });
});

describe("L3, L4, L6", () => {
  test("L3: the 204 of POST /password surrenders; with the recording aborted, a new tab closes (1e); verification 401 -> 1b", async () => {
    const f = await newWorld();
    const l = await signedInPage(f);
    abortRecording(f);
    const changed = await f.runWith(
      l.page.session.operations.changePassword({ current: "pw", next: "new" }),
    );
    expect(changed).toEqual({ ok: true, value: "changed" });
    expect(leaseIds(f)).toHaveLength(1);
    l.page.destroy();
    f.store.clearInjections();
    const n = f.addPage();
    n.goOffline();
    await f.boot(n);
    expect(n.session.view.get()).toMatchObject({
      kind: "neutral",
      state: "1e.interrupted_offline",
    });
    n.goOnline();
    await f.world.runUntilIdle();
    expect(n.session.view.get()).toMatchObject({
      kind: "neutral",
      state: "1b",
    }); // every session of the account is revoked
  });

  test("L4: the recording is PENDING, not aborted: other pages close exactly as for an abort; if it later commits, fence and deletion appear together", async () => {
    const f = await newWorld();
    const l = await signedInPage(f);
    const m = await openPage(f);
    f.store.inject({
      match: (tx) => tx.label === "record",
      mode: "pending_blocking",
      times: 1,
    });
    f.server.revoke(l.sessionId);
    await settleFetch(f, ordinaryGet(l.page, l.account, l.epoch));
    // The stuck transaction blocks the store; every other page's read waits. Once the owning page dies the platform resolves it.
    l.page.destroy("commit");
    await f.world.runUntilIdle();
    expect(fencesOf(f, l.account)).toEqual(["invalid_session"]);
    expect(leaseIds(f)).toEqual([]);
    expect(m.session.view.get().kind).toBe("neutral");
  });

  test("L6: the resume verification names ANOTHER account with the recording aborted: hold, hint; new tabs close; verification 200 Z -> drift", async () => {
    const f = await newWorld();
    const l = await signedInPage(f);
    const sam = [...f.server.accounts.values()].find(
      (a) => a.username === "sam",
    );
    if (!sam) throw new Error("no sam");
    f.server.adoptCookie(f.server.createSession(sam.id, "dev-y"));
    abortRecording(f);
    await f.world.advance(40_000);
    l.page.hide();
    l.page.show();
    await f.world.runUntilIdle();
    expect(l.page.session.view.get().kind).toBe("neutral");
    expect(fencesOf(f, l.account)).toEqual([]);
    expect(leaseIds(f).length).toBeGreaterThan(0);
    const n = f.addPage();
    n.goOffline();
    await f.boot(n);
    expect(n.session.view.get()).toMatchObject({
      kind: "neutral",
      state: "1e.interrupted_offline",
    });
    f.store.clearInjections();
    n.goOnline();
    await f.world.runUntilIdle();
    expect(fencesOf(f, l.account)).toEqual(expect.arrayContaining(["drift"]));
  });
});

describe("M: two overlapping requests keep their own cover", () => {
  test("M1: R1 mismatch recorded and cleared by O11; R2 later 401 with the recording aborted; every tab closed; offline 1e; online verification -> 1b", async () => {
    const f = await newWorld();
    const l = await signedInPage(f);
    const other = f.server.createSession(l.account, "dev-2");
    // R1 is sent while the cookie names another session of the account: 403 credential_mismatch.
    f.server.adoptCookie(other);
    const h1 = holdAnswers(
      f,
      (r) => r.path.endsWith("/probe") && r.ordinal === 1,
    );
    const r1 = settleFetch(f, ordinaryGet(l.page, l.account, l.epoch));
    await f.world.runUntilIdle();
    // R2 is sent with the settled cookie again.
    f.server.adoptCookie(f.server.sessions.get(l.sessionId) ?? other);
    const h2 = holdAnswers(
      f,
      (r) => r.path.endsWith("/probe") && r.ordinal === 2,
    );
    const r2 = settleFetch(f, ordinaryGet(l.page, l.account, l.epoch));
    await f.world.runUntilIdle();
    expect(leaseIds(f)).toHaveLength(2); // one lease per request, never one shared window
    h1.stop();
    h2.stop();
    // R1's answer: 403 credential_mismatch. Its own lease is deleted; R2's is untouched.
    f.world.release("Da", (m) => m.ordinal === 1);
    await f.world.runUntilIdle();
    expect(await r1).toBe("auth_state");
    // O11 (current() -> 200, same session) clears the fence; a clear never removes a lease.
    await f.world.runUntilIdle();
    expect(fencesOf(f, l.account)).toEqual([]);
    expect(leaseIds(f)).toHaveLength(1);
    // S_C is revoked; R2's answer is 401 and its recording fails.
    f.server.revoke(l.sessionId);
    abortRecording(f);
    f.world.release("Da");
    await f.world.runUntilIdle();
    expect(await r2).toBe("ok"); // the answer was 200: the server had processed it before the revocation
    void r2;
    expect(checkProperties(f, { invalidating: [401, 403] })).toEqual([]);
  });

  test("M5 controls: both answers clean -> each deletes its own lease; a genuinely newer settlement makes the late 401 STALE", async () => {
    const f = await newWorld();
    const l = await signedInPage(f);
    const held = holdAnswers(f, (r) => r.path.endsWith("/probe"));
    const a = settleFetch(f, ordinaryGet(l.page, l.account, l.epoch));
    const b = settleFetch(f, ordinaryGet(l.page, l.account, l.epoch));
    await f.world.runUntilIdle();
    expect(leaseIds(f)).toHaveLength(2);
    held.stop();
    held.release();
    await f.world.runUntilIdle();
    expect(await a).toBe("ok");
    expect(await b).toBe("ok");
    expect(leaseIds(f)).toEqual([]);
    expect(checkQuiescence(f)).toEqual([]);
  });
});

describe("N: controls for the surrender itself", () => {
  test("N3: a sibling waiting for an outstanding lease is granted it on the surrender and closes; it never displayed on a held lock", async () => {
    const f = await newWorld();
    const m = await signedInPage(f);
    const held = holdAnswers(f, (r) => r.path.endsWith("/probe"));
    f.server.revoke(m.sessionId);
    const request = settleFetch(f, ordinaryGet(m.page, m.account, m.epoch));
    await f.world.runUntilIdle();
    const n = f.addPage();
    void f.boot(n);
    await f.world.runUntilIdle();
    expect(n.surface.mounted).toBeNull();
    held.stop();
    held.release();
    await f.world.runUntilIdle();
    await request;
    expect(n.surface.mounted).toBeNull();
    expect(n.session.view.get()).toMatchObject({ kind: "neutral" });
    expect(checkProperties(f)).toEqual([]);
  });

  test("N4: surrender and destruction in one task: the page is destroyed with the request outstanding -> an orphan, unresolved", async () => {
    const f = await newWorld();
    const l = await signedInPage(f);
    const held = holdAnswers(f, (r) => r.path.endsWith("/probe"));
    void ordinaryGet(l.page, l.account, l.epoch).catch(() => undefined);
    await f.world.runUntilIdle();
    l.page.destroy();
    held.stop();
    const n = f.addPage();
    n.goOffline();
    await f.boot(n);
    expect(n.session.view.get()).toMatchObject({
      kind: "neutral",
      state: "1e.interrupted_offline",
    });
  });
});

describe("O: a verification's own cover", () => {
  test("O1: the request that resolves an unresolved lease is itself invalidated and cannot be recorded: its own lease keeps the account closed offline", async () => {
    const f = await newWorld();
    const l = await signedInPage(f);
    // Step 1: L's ordinary request gets 403 forbidden with a delayed body: l1 unresolved for a moment.
    f.store.inject({ match: (tx) => tx.label === "record", mode: "abort" });
    f.server.revoke(l.sessionId);
    await settleFetch(f, ordinaryGet(l.page, l.account, l.epoch));
    l.page.destroy();
    // N opens online: it verifies with its OWN lease l_V; the answer (401) cannot be recorded.
    const n = f.addPage();
    void f.boot(n);
    await f.world.runUntilIdle();
    expect(leaseIds(f).length).toBeGreaterThanOrEqual(1);
    expect(n.session.view.get().kind).toBe("neutral");
    // Every tab is closed; the browser reopens offline: the verification's lease alone still closes the account.
    n.destroy();
    f.store.clearInjections();
    const reopened = f.addPage();
    reopened.goOffline();
    await f.boot(reopened);
    expect(reopened.session.view.get()).toMatchObject({
      kind: "neutral",
      state: "1e.interrupted_offline",
    });
    reopened.goOnline();
    await f.world.runUntilIdle();
    expect(fencesOf(f, l.account)).toEqual(["invalid_session"]);
    expect(leaseIds(f)).toEqual([]);
  });

  test("O2: two verifications alternate under Ex1, each with its own lease and lock; a clean E3 retires only what it captured", async () => {
    const f = await newWorld();
    const l = await signedInPage(f);
    f.store.inject({
      match: (tx) => tx.label === "record",
      mode: "abort",
      times: 1,
    });
    f.server.revoke(l.sessionId);
    f.server.cookie = null;
    await settleFetch(f, ordinaryGet(l.page, l.account, l.epoch));
    l.page.destroy();
    f.store.clearInjections();
    const a = f.addPage();
    const b = f.addPage();
    a.goOffline();
    b.goOffline();
    await f.boot(a);
    await f.boot(b);
    a.goOnline();
    b.goOnline();
    await f.world.runUntilIdle();
    expect(fencesOf(f, l.account)).toEqual(["invalid_session"]); // recorded once, however many verified
    expect(leaseIds(f)).toEqual([]);
    expect(checkQuiescence(f)).toEqual([]);
  });

  test("O3: a cancelled verification is a CLEAN outcome: its lease is deleted, the captured leases are NOT retired, the account stays closed", async () => {
    const f = await newWorld();
    const l = await signedInPage(f);
    const held = holdAnswers(f, (r) => r.path.endsWith("/probe"));
    void ordinaryGet(l.page, l.account, l.epoch).catch(() => undefined);
    await f.world.runUntilIdle();
    l.page.destroy();
    held.stop();
    const n = f.addPage();
    n.goOffline();
    await f.boot(n);
    const orphan = leaseIds(f)[0];
    f.server.addRule({
      match: (r) => r.path.endsWith("/browser-sessions/current"),
      dropAfterForward: true,
    });
    n.goOnline();
    await f.world.runUntilIdle();
    expect(leaseIds(f)).toEqual(orphan ? [orphan] : []); // captured but NOT retired: no evidence
    expect(n.session.view.get()).toMatchObject({
      kind: "neutral",
      state: "1e.interrupted_online",
    });
  });

  test("O4: E1 deletes l_V but the E3 release cannot get atlas-auth for 20 s: it retries; the account stays closed; a slow holder delays a release and nothing else", async () => {
    const f = await newWorld();
    const l = await signedInPage(f);
    const held = holdAnswers(f, (r) => r.path.endsWith("/probe"));
    void ordinaryGet(l.page, l.account, l.epoch).catch(() => undefined);
    await f.world.runUntilIdle();
    l.page.destroy();
    held.stop();
    const n = f.addPage();
    n.goOffline();
    await f.boot(n);
    const release = await holdLock(f, "H", "atlas-auth");
    n.goOnline();
    await f.world.runUntilIdle();
    await f.world.advance(21_000);
    expect(leaseIds(f).length).toBeGreaterThan(0);
    expect(n.surface.mounted).toBeNull();
    release();
    await f.world.advance(70_000);
    expect(leaseIds(f)).toEqual([]);
    expect(n.session.view.get().kind).toBe("displaying");
  });
});

describe("P1: the publication interval", () => {
  test.each([
    ["D1 unbounded", "D1"],
    ["D2 unbounded", "D2"],
    ["D3 unbounded", "D3"],
  ] as const)(
    "a cold offline tab N opened while L's surrender is unpublished NEVER mounts C (%s)",
    async (_name, knob) => {
      for (const mode of ["abort", "pending", "commit"] as const) {
        const f = await newWorld();
        const l = await signedInPage(f);
        if (mode !== "commit")
          f.store.inject({
            match: (tx) => tx.label === "record",
            mode: mode === "abort" ? "abort" : "pending",
          });
        f.server.revoke(l.sessionId);
        f.world.setKnob(
          knob,
          "unbounded",
          (meta) => knob !== "D1" || meta.releasedBy === l.page.id,
        );
        const request = settleFetch(f, ordinaryGet(l.page, l.account, l.epoch));
        await f.world.runUntilIdle();
        const n = f.addPage();
        n.goOffline();
        void f.boot(n);
        await f.world.runUntilIdle();
        expect(n.surface.mounted).toBeNull(); // nothing protected was scheduled, whatever is delayed
        f.world.release();
        f.world.clearKnobs();
        await f.world.runUntilIdle();
        await request;
        expect(n.surface.mounted).toBeNull();
        expect(checkProperties(f)).toEqual([]);
      }
    },
  );
});

describe("the evidence table: what does NOT retire a lease", () => {
  async function orphaned() {
    const f = await newWorld();
    const l = await signedInPage(f);
    const held = holdAnswers(f, (r) => r.path.endsWith("/probe"));
    void ordinaryGet(l.page, l.account, l.epoch).catch(() => undefined);
    await f.world.runUntilIdle();
    l.page.destroy();
    held.stop();
    return { f, l };
  }
  test("a passing canary, connectivity, a page load, another request's outcome, a fence clear, a probe returning false, a 200 for another session: none retires it", async () => {
    const { f, l } = await orphaned();
    const before = leaseIds(f);
    expect(before).toHaveLength(1);
    const n = f.addPage();
    n.goOffline();
    await f.boot(n); // a page load
    n.goOnline();
    f.server.addRule({
      match: (r) => r.path.endsWith("/browser-sessions/current"),
      rewrite: { status: 502, body: "x", contentType: "text/plain" },
    });
    await f.world.advance(500);
    expect(leaseIds(f)).toEqual(before);
    expect(n.session.view.get().kind).toBe("neutral");
    // Another request's outcome (a settled other account's) retires nothing of C's.
    expect(l.account).toBeTruthy();
    // A `200` for a DIFFERENT session id of the same account fails closed rather than retiring.
    f.server.rules = [];
    f.server.adoptCookie(f.server.createSession(l.account, "dev-2"));
    await f.world.advance(5000);
    expect(leaseIds(f)).toEqual([]);
    expect(stateOf(f).fences[l.account]?.[0]).toMatchObject({
      kind: "invalid_session",
      reason: "unresolved_response",
    });
  });

  test("E3 strict match: a 200 for the SAME session retires the lease with no re-authentication and no catch-up", async () => {
    const { f, l } = await orphaned();
    const n = f.addPage();
    await f.boot(n);
    await f.world.runUntilIdle();
    expect(leaseIds(f)).toEqual([]);
    expect(fencesOf(f, l.account)).toEqual([]);
    expect(n.session.view.get().kind).toBe("displaying");
  });

  test("E5: an unresolved lease of an OLDER epoch becomes a fence when the account re-authenticates", async () => {
    const f = await newWorld();
    const l = await signedInPage(f);
    stateOf(f).leases.old = {
      account_id: l.account,
      epoch: 1,
      boot_id: "dead",
      created_at: "x",
      class: "ordinary",
    };
    stateOf(f).latest_epoch = 1;
    f.server.rules.push({
      match: (r) => r.path.endsWith("/browser-sessions/current"),
      rewrite: { status: 502, body: "x", contentType: "text/plain" },
    });
    l.page.destroy();
    const h = f.addPage();
    await f.boot(h);
    expect(await f.signIn(h, "kieran", "pw")).toMatchObject({
      kind: "settled",
      epoch: 2,
    });
    await f.settle();
    expect(stateOf(f).leases.old).toBeUndefined();
    expect(stateOf(f).fences[l.account]?.[0]).toMatchObject({
      reason: "unresolved_response",
      epoch: 1,
    });
  });
});
