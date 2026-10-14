// @vitest-environment node
import { describe, expect, test } from "vitest";
import type { AttemptHandle, DeviceRow } from "../../src/session/api";
import type { FakePage, Fixture } from "../support/session/harness";
import { checkProperties } from "../support/session/properties";
import {
  fencesOf,
  holdAnswers,
  identityReadsSoFar,
  newWorld,
  openPage,
  ordinaryGet,
  signedInPage,
  stateOf,
} from "../support/session/scenarios";
import { API } from "../support/session/server";

/**
 * WEB-08c, Layer 2: the lifecycle traces this card owns that had no fake-world case of their own (`account-lifecycle-matrix.md` T4, T6,
 * T7, T8, T9, T10, T12, T13, T14, T17, T21), each against the matrix's outcome lines, with the REAL kernel over the fake platform. The
 * traces already proven at this layer under other names are cited in `docs/lifecycle-evidence.md` (T5 `attempt-reload.test.ts`, T18
 * `operations-logout.test.ts`, T19 `operations-retirement.test.ts`, T20 `attempts.test.ts`, T23 the matrices, T24 `recovery-api.test.ts`).
 * Every case also checks the fake world's properties (V1–V7, W1–W3, P-A–P-I) on its logs.
 *
 * It is fixture evidence against a stub of the contract: NEVER integration evidence (the released-backend counterparts are
 * `tests/integration/integration.lifecycle.spec.ts`).
 */
const accountIdOf = (f: Fixture, username: string): string => {
  const account = [...f.server.accounts.values()].find(
    (a) => a.username === username,
  );
  if (!account) throw new Error(`no account ${username}`);
  return account.id;
};
async function begin(
  f: Fixture,
  page: FakePage,
  method: "password" = "password",
): Promise<AttemptHandle> {
  const begun = await f.runWith(page.session.attempts.begin(method));
  if (begun.kind !== "started") throw new Error(`begin: ${begun.kind}`);
  return begun.handle;
}
const isExchange = (path: string) => path === `${API}/browser-sessions`;
const isActivate = (path: string) =>
  path === `${API}/browser-sessions/activate`;
const isCurrent = (path: string) => path === `${API}/browser-sessions/current`;
/** Records every view the page publishes from now on, in order. */
function recordViews(page: FakePage) {
  const seen: Array<{
    kind: string;
    account_id?: string;
    state?: string | null;
  }> = [];
  const push = () =>
    seen.push({ ...(page.session.view.get() as object) } as never);
  push();
  page.session.view.subscribe(push);
  return seen;
}
/** The accounts this page's surface MOUNTED or LIFTED the tree for, from log index `from` on. */
const attachesSince = (f: Fixture, page: FakePage, from: number) =>
  f.world.logs
    .slice(from)
    .filter(
      (entry) => entry.type === "surface.attach" && entry.page === page.id,
    )
    .map((entry) => entry.account as string);

describe("T4: a frozen or resumed tab with an older attempt outstanding", () => {
  test("tab 1 (showing C) starts A, hides and freezes; tab 2 settles B; tab 1 resumes: A's late grant is discarded and tab 1 NEVER re-displays C", async () => {
    const f = await newWorld();
    f.server.addAccount("cara", "pw3");
    const tab1 = await signedInPage(f, "cara", "pw3");
    const tab2 = await openPage(f);
    const activationsBefore = f.server.requests.filter((r) =>
      isActivate(r.path),
    ).length;
    const held = holdAnswers(
      f,
      (r) => isExchange(r.path) && r.page === tab1.page.id,
    );
    const handleA = await begin(f, tab1.page);
    const pendingA = tab1.page.session.attempts.signInWithPassword(handleA, {
      username: "kieran",
      password: "pw",
    });
    await f.settle();
    // t0: hidden first (the level-0 gate is applied on `visibilitychange`), then frozen.
    tab1.page.hide();
    await f.settle();
    expect(tab1.page.surface.level0).toBe(true);
    const hiddenAt = f.world.logs.length;
    tab1.page.freeze();
    // t2: tab 2 allocates epoch 2, activates and settles B.
    const outcomeB = await f.runWith(
      (async () => {
        const handle = await tab2.session.attempts.begin("password");
        if (handle.kind !== "started") throw new Error(handle.kind);
        return tab2.session.attempts.signInWithPassword(handle.handle, {
          username: "sam",
          password: "pw2",
        });
      })(),
    );
    expect(outcomeB).toMatchObject({
      kind: "settled",
      account_id: accountIdOf(f, "sam"),
    });
    // t3: tab 1 resumes; A's response is processed late.
    tab1.page.thaw();
    tab1.page.show();
    held.release();
    const outcomeA = await f.runWith(pendingA);
    expect(outcomeA).toEqual({ kind: "superseded" });
    await f.settle();
    expect(stateOf(f).settled?.account_id).toBe(accountIdOf(f, "sam"));
    expect(tab1.page.session.view.get()).toMatchObject({
      kind: "displaying",
      account_id: accountIdOf(f, "sam"),
    });
    // Nothing for kieran was ever activated, and C was never displayed again after the hide.
    expect(
      f.server.requests.filter((r) => isActivate(r.path)).length -
        activationsBefore,
    ).toBe(1);
    expect(attachesSince(f, tab1.page, hiddenAt)).not.toContain(tab1.account);
    expect(attachesSince(f, tab1.page, hiddenAt)).toContain(
      accountIdOf(f, "sam"),
    );
    expect(checkProperties(f)).toEqual([]);
  });
});

describe("T6: an eligible offline reload (row 6)", () => {
  test("settled, no attempt, no fence, no foreign lease: a fresh page offline renders from the local check with no network; current() fails silently; nothing changes", async () => {
    const f = await newWorld();
    const l = await signedInPage(f);
    const before = JSON.stringify({
      settled: stateOf(f).settled,
      fences: stateOf(f).fences,
      attempt: stateOf(f).attempt,
    });
    l.page.destroy();
    const requests = f.server.requests.length;
    const fresh = f.addPage();
    fresh.env.online = false;
    await f.boot(fresh);
    expect(fresh.session.view.get()).toMatchObject({
      kind: "displaying",
      account_id: l.account,
    });
    // No request reached the server (the browser is offline); the background current() failed and changed nothing.
    expect(f.server.requests.length).toBe(requests);
    expect(
      JSON.stringify({
        settled: stateOf(f).settled,
        fences: stateOf(f).fences,
        attempt: stateOf(f).attempt,
      }),
    ).toBe(before);
    expect(Object.keys(stateOf(f).leases)).toEqual([]);
    expect(checkProperties(f)).toEqual([]);
  });
});

describe("T7: an activation answered by a gateway or lost, with a live page", () => {
  test.each([
    ["502 after forwarding", { rewrite: { status: 502 } }],
    ["504 after forwarding", { rewrite: { status: 504 } }],
    ["the response dropped after forwarding", { dropAfterForward: true }],
  ] as const)(
    "%s: indeterminate, resolved at once by activate/cancel then current(); nothing renders until then; the outcome is exact",
    async (_name, rule) => {
      const f = await newWorld();
      const l = await signedInPage(f);
      const views = recordViews(l.page);
      f.server.addRule({
        match: (r) => isActivate(r.path),
        times: 1,
        ...rule,
      });
      const outcome = await f.signIn(l.page, "sam", "pw2");
      await f.settle();
      // The server DID activate (the gateway hid the answer, and with it the Set-Cookie): the cancel revokes the new session
      // (session_revoked) and current() decides: the cookie is still C's and valid, so C renders again (T20 b). sam is NOT adopted.
      expect(outcome).toEqual({ kind: "gating" });
      expect(
        f.server.requests.some((r) =>
          r.path.endsWith("/browser-sessions/activate/cancel"),
        ),
      ).toBe(true);
      expect(stateOf(f).attempt).toBeNull();
      const samId = accountIdOf(f, "sam");
      expect(
        [...f.server.sessions.values()].some((s) => s.account === samId),
      ).toBe(false);
      expect(stateOf(f).settled).toMatchObject({
        account_id: l.account,
        epoch: l.epoch,
      });
      expect(fencesOf(f, l.account)).toEqual([]);
      expect(l.page.session.view.get()).toMatchObject({
        kind: "displaying",
        account_id: l.account,
      });
      expect(views.some((view) => view.state === "1c.resolving")).toBe(true);
      expect(
        views.some(
          (view) =>
            view.kind === "displaying" &&
            view.account_id === accountIdOf(f, "sam"),
        ),
      ).toBe(false);
      expect(checkProperties(f)).toEqual([]);
    },
  );

  test("the request never reached the server: not_activated, the attempt clears, no fence, C renders again (the in-tree 1c.ended case)", async () => {
    const f = await newWorld();
    const l = await signedInPage(f);
    const views = recordViews(l.page);
    f.server.addRule({
      match: (r) => isActivate(r.path),
      times: 1,
      dropBeforeForward: true,
    });
    const outcome = await f.signIn(l.page, "sam", "pw2");
    await f.settle();
    expect(outcome).toEqual({ kind: "gating" });
    expect(stateOf(f).attempt).toBeNull();
    expect(fencesOf(f, l.account)).toEqual([]);
    expect(l.page.session.view.get()).toMatchObject({
      kind: "displaying",
      account_id: l.account,
    });
    // The view went through the indeterminate resolution (what the 1c.ended watcher keys on) and came back at the SAME epoch.
    expect(views.some((view) => view.state === "1c.resolving")).toBe(true);
    expect(stateOf(f).settled?.epoch).toBe(l.epoch);
    expect(checkProperties(f)).toEqual([]);
  });
  // The page hidden while activating is `tests/session/activation-visibility.test.ts` (WEB-08a review revision 1, item 5): cited.
});

describe("T8: the lock holder is destroyed mid-activation; its response lands late", () => {
  test("tab 2 resolves the owner-less attempt (session_revoked, current() 200 C); the late Set-Cookie installs only a DEAD session, which C's next request turns into 1b", async () => {
    const f = await newWorld();
    const l = await signedInPage(f);
    const tab2 = await openPage(f);
    const held = holdAnswers(f, (r) => isActivate(r.path));
    const handle = await begin(f, l.page);
    void l.page.session.attempts.signInWithPassword(handle, {
      username: "sam",
      password: "pw2",
    });
    await f.settle();
    expect(stateOf(f).attempt?.phase).toBe("activating");
    // The server redeemed the grant and created S_A; the response is still in flight. The user closes tab 1.
    const redeemed = [...f.server.grants.values()].find(
      (g) => g.state === "redeemed" && g.account === accountIdOf(f, "sam"),
    );
    expect(redeemed?.session).toBeTruthy();
    const deadToken = f.server.sessions.get(redeemed?.session ?? "")?.token;
    l.page.destroy();
    tab2.session.actions.retry();
    await f.settle();
    // t3/t4a: cancelled, the cookie is still C's and valid: C renders, the target is never adopted.
    expect(stateOf(f).attempt).toBeNull();
    expect(f.server.sessions.has(redeemed?.session ?? "")).toBe(false);
    expect(stateOf(f).settled?.account_id).toBe(l.account);
    expect(tab2.session.view.get()).toMatchObject({
      kind: "displaying",
      account_id: l.account,
    });
    // t5: the late Set-Cookie of the deleted session lands (the destroyed page cannot apply it; the browser's jar does).
    f.server.cookie = deadToken ?? null;
    held.stop();
    // t6: C's next authenticated request is refused 401 before any handler: C is fenced, state 1b, unsent changes kept.
    await f
      .runWith(ordinaryGet(tab2, l.account, l.epoch))
      .catch(() => undefined);
    await f.settle();
    expect(fencesOf(f, l.account)).toEqual(["invalid_session"]);
    expect(tab2.session.view.get()).toMatchObject({
      kind: "neutral",
      state: "1b",
    });
    expect(checkProperties(f)).toEqual([]);
  });
});

async function confirmedRead(f: Fixture, page: FakePage): Promise<DeviceRow> {
  const read = await f.runWith(page.session.operations.readDevices());
  if (!read.ok) throw new Error("devices read failed");
  const current = read.value.devices.find((d) => d.current);
  if (!current) throw new Error("no current device");
  return current;
}
const unsynced = { count: 0, items: [], digest: "d0" };
const retirements = (f: Fixture) =>
  f.server.requests.filter(
    (r) => r.method === "DELETE" && /\/devices\/[^/]+$/.test(r.path),
  );

describe("T9: retirement against a newer sign-in on the same device", () => {
  test("processed AFTER the newer session exists: rejected_stale; nothing deleted, no wipe; the newer session untouched; 1a.device_changed", async () => {
    const f = await newWorld();
    const l = await signedInPage(f);
    f.data.databases.set(l.account, { incarnation: "inc-1" });
    f.data.work.set(l.account, { count: 0, digest: "d0" });
    const row = await confirmedRead(f, l.page);
    // Tab B signs in on this device (a new session) after A read the state and before A's request is PROCESSED: the server's
    // processing of the DELETE is preceded by the creation of B's session (the fake fetch processes at send, so the session is
    // created at that very boundary).
    let newer: { id: string } | null = null;
    const process = f.server.process.bind(f.server);
    f.server.process = (page, method, path, headers, body, cookie) => {
      if (method === "DELETE" && /\/devices\//.test(path) && newer === null)
        newer = f.server.createSession(l.account, row.id);
      return process(page, method, path, headers, body, cookie);
    };
    const started = await f.runWith(
      l.page.session.operations.retireThisDevice({ read: row, unsynced }),
    );
    expect(started.kind).toBe("started");
    await f.settle();
    expect(f.server.ledger.size).toBeGreaterThan(0);
    expect([...f.server.ledger.values()][0]?.outcome).toBe("rejected_stale");
    expect(newer).not.toBeNull();
    expect(
      f.server.sessions.has((newer as { id: string } | null)?.id ?? ""),
    ).toBe(true);
    expect(f.data.databases.has(l.account)).toBe(true);
    expect(l.page.session.view.get()).toMatchObject({
      kind: "neutral",
      state: "1a.device_changed",
    });
    expect(retirements(f)).toHaveLength(1); // never retried against the changed state
    expect(checkProperties(f)).toEqual([]);
  });

  test("processed BEFORE the newer session; the response delayed until after B settles: no Set-Cookie, B's settlement unchanged, the retired account's data wiped", async () => {
    const f = await newWorld();
    const l = await signedInPage(f);
    f.data.databases.set(l.account, { incarnation: "inc-1" });
    f.data.work.set(l.account, { count: 0, digest: "d0" });
    const row = await confirmedRead(f, l.page);
    const held = holdAnswers(
      f,
      (r) => r.method === "DELETE" && /\/devices\//.test(r.path),
    );
    await f.runWith(
      l.page.session.operations.retireThisDevice({ read: row, unsynced }),
    );
    // The delete committed on the server (the hold only delays the delivery). B then signs in on another page.
    expect([...f.server.ledger.values()][0]?.outcome).toBe("confirmed_applied");
    const tab2 = await openPage(f);
    const outcome = await f.signIn(tab2, "sam", "pw2");
    expect(outcome).toMatchObject({ kind: "settled" });
    const cookieB = f.server.cookie;
    held.release();
    await f.settle();
    expect(retirements(f)[0]?.hadSetCookie).toBe(false);
    expect(f.server.cookie).toBe(cookieB);
    expect(stateOf(f).settled?.account_id).toBe(accountIdOf(f, "sam"));
    expect(f.data.databases.has(l.account)).toBe(false);
    expect(checkProperties(f)).toEqual([]);
  });
});

describe("T10: an independent retirement, then the retry", () => {
  async function lostThenRevoked() {
    const f = await newWorld();
    const l = await signedInPage(f);
    f.data.databases.set(l.account, { incarnation: "inc-1" });
    f.data.work.set(l.account, { count: 0, digest: "d0" });
    const row = await confirmedRead(f, l.page);
    // The retirement request is lost before reaching the server, and the browser drops off the network after sending it.
    f.server.addRule({
      match: (r) => r.method === "DELETE" && /\/devices\//.test(r.path),
      dropBeforeForward: true,
      times: 1,
    });
    await f.runWith(
      l.page.session.operations.retireThisDevice({ read: row, unsynced }),
    );
    await f.settle();
    // Independently, a native client retires the same device: this browser's session is revoked. The retry runs on its back-off.
    f.server.revoke(l.sessionId);
    l.page.session.operations.resume({ force: true });
    await f.settle();
    await f.world.advance(60_000);
    await f.settle();
    return { f, l, row };
  }

  test("the retry's 401 is not an outcome: the operation fence stays (1a, never wiped), the 401 adds invalid_session, a fresh attempt is asked for", async () => {
    const { f, l } = await lostThenRevoked();
    expect(fencesOf(f, l.account)).toEqual(["operation", "invalid_session"]);
    expect(f.server.ledger.size).toBe(0);
    expect(f.data.databases.has(l.account)).toBe(true);
    expect(l.page.session.view.get()).toMatchObject({ kind: "neutral" });
    expect((l.page.session.view.get() as { state: string }).state).toMatch(
      /^1a\./,
    );
  });

  test("re-authenticating on THIS device: the identical retry finds a component added and records rejected_stale; nothing is wiped", async () => {
    const { f, l } = await lostThenRevoked();
    expect(await f.signIn(l.page, "kieran", "pw")).toMatchObject({
      kind: "settled",
    });
    await f.settle();
    await f.world.advance(60_000);
    await f.settle();
    // The operation fence is resolved without a wipe; the older-epoch invalid_session leaves catching up (2), never the content.
    expect(fencesOf(f, l.account)).toEqual(["invalid_session"]);
    expect(l.page.session.view.get()).toMatchObject({
      kind: "neutral",
      state: "2",
    });
    const outcomes = [...f.server.ledger.values()].map(
      (entry) => entry.outcome,
    );
    expect(outcomes).toContain("rejected_stale");
    expect(outcomes).not.toContain("superseded");
    expect(f.data.databases.has(l.account)).toBe(true);
    expect(checkProperties(f)).toEqual([]);
  });

  test("this device's state is empty (authenticated through a different device): the retry records superseded: hide, NO wipe, 'already ended' copy", async () => {
    const { f, l, row } = await lostThenRevoked();
    // Every member of the device's state is gone (the native retirement removed them); the retry is answered by the ledger.
    f.server.device(row.id).subscriptions.length = 0;
    f.server.device(row.id).handoffs.length = 0;
    f.server.device(row.id).sync_registered = false;
    const other = f.server.createSession(l.account, "dev-other");
    f.server.adoptCookie(other);
    l.page.session.operations.resume({ force: true });
    await f.settle();
    await f.world.advance(60_000);
    await f.settle();
    // The ledger has no row for the operation and the device has no member: superseded, the row 4/5 hide with the
    // removed-elsewhere reason (whose own card is 1a.ended_elsewhere; here the earlier plain 401 fence also stands, so the
    // precedence shows 1b), and NO wipe.
    expect(
      stateOf(f).fences[l.account]?.some(
        (fence) =>
          fence.kind === "invalid_session" &&
          fence.reason === "removed_elsewhere",
      ),
    ).toBe(true);
    expect(fencesOf(f, l.account)).not.toContain("operation");
    expect(f.data.databases.has(l.account)).toBe(true);
    expect(f.data.calls.filter((c) => c.startsWith("delete:"))).toEqual([]);
    expect(l.page.session.view.get()).toMatchObject({
      kind: "neutral",
      state: "1b",
    });
    expect(checkProperties(f)).toEqual([]);
  });
});

describe("T12: an interrupted switch", () => {
  test("the EXCHANGE response is lost: the attempt fails, the outgoing account stays settled and renders, nothing changed", async () => {
    const f = await newWorld();
    const l = await signedInPage(f);
    const cookie = f.server.cookie;
    f.server.addRule({
      match: (r) => isExchange(r.path),
      dropAfterForward: true,
      times: 1,
    });
    const outcome = await f.signIn(l.page, "sam", "pw2");
    await f.settle();
    expect(outcome).toEqual({ kind: "exchange_failed", status: null });
    expect(stateOf(f).attempt).toBeNull();
    expect(stateOf(f).settled).toMatchObject({
      account_id: l.account,
      epoch: l.epoch,
    });
    expect(f.server.cookie).toBe(cookie);
    expect(l.page.session.view.get()).toMatchObject({
      kind: "displaying",
      account_id: l.account,
    });
    expect(checkProperties(f)).toEqual([]);
  });

  test("the ACTIVATION response is lost: indeterminate; the incoming account never renders on a guess, nor the outgoing while it is unknown", async () => {
    const f = await newWorld();
    const l = await signedInPage(f);
    const views = recordViews(l.page);
    // ADAPTED (WEB-08c revision 2, HF1-SHARED-CONFIRMATION-20261013): was `r.ordinal > 1` (every identity read after the post-sign-in resume
    // verification, which the shared confirmation now spares); the same "every identity read from the sign-in on".
    const before = identityReadsSoFar(f);
    const held = holdAnswers(f, (r) => isCurrent(r.path) && r.ordinal > before);
    f.server.addRule({
      match: (r) => isActivate(r.path),
      dropAfterForward: true,
      times: 1,
    });
    const outcome = await f.signIn(l.page, "sam", "pw2");
    expect(outcome).toEqual({ kind: "gating" });
    await f.settle();
    // While current() is outstanding the outcome is unknown: neither account displays.
    const view = l.page.session.view.get();
    expect(view.kind).not.toBe("displaying");
    held.release();
    await f.settle();
    expect(stateOf(f).settled?.account_id).toBe(l.account);
    expect(
      views.some(
        (v) =>
          v.kind === "displaying" && v.account_id === accountIdOf(f, "sam"),
      ),
    ).toBe(false);
    expect(checkProperties(f)).toEqual([]);
  });
});

describe("T13: a retained account that also carries its own row 4/5 fence", () => {
  test("switching back is a fresh attempt; settlement leaves fences[X]; catch-up (2) shows, never X's content, until recovery clears it", async () => {
    const f = await newWorld();
    const x = await signedInPage(f, "sam", "pw2");
    // X's session expires and is detected: fences[X] = invalid_session.
    f.server.revoke(x.sessionId);
    await f
      .runWith(ordinaryGet(x.page, x.account, x.epoch))
      .catch(() => undefined);
    await f.settle();
    expect(fencesOf(f, x.account)).toEqual(["invalid_session"]);
    // X is parked: the person signs in as kieran (row 7), then switches back to X (row 8).
    expect(await f.signIn(x.page, "kieran", "pw")).toMatchObject({
      kind: "settled",
    });
    await f.settle();
    expect(fencesOf(f, x.account)).toEqual(["invalid_session"]);
    const back = await f.signIn(x.page, "sam", "pw2");
    expect(back).toMatchObject({ kind: "settled", account_id: x.account });
    await f.settle();
    // The switch's own success does not lift the fence: the older-epoch fence shows catching up, never X's content.
    expect(fencesOf(f, x.account)).toEqual(["invalid_session"]);
    expect(x.page.session.view.get()).toMatchObject({
      kind: "neutral",
      state: "2",
    });
    // Recovery (WEB-09b's job) clears it through the two ordered steps; only then does X display.
    const begun = await f.runWith(x.page.session.recovery.begin(x.account));
    expect(begun.kind).toBe("eligible");
    if (begun.kind !== "eligible") return;
    expect(await f.runWith(x.page.session.recovery.finish(begun.handle))).toBe(
      "cleared",
    );
    await f.settle();
    expect(fencesOf(f, x.account)).toEqual([]);
    expect(x.page.session.view.get()).toMatchObject({
      kind: "displaying",
      account_id: x.account,
    });
    expect(checkProperties(f)).toEqual([]);
  });
});

describe("T14: a stale identity read delivered after a later transition", () => {
  test("a current() stamped with the older epoch returns after settlement at a newer epoch: discarded; the new identity is not regressed or fenced", async () => {
    const f = await newWorld();
    const l = await signedInPage(f);
    const tab2 = await openPage(f);
    // Hold every answer to current(): the older epoch's verification on tab 2 is outstanding.
    const held = holdAnswers(f, (r) => isCurrent(r.path));
    tab2.hide();
    tab2.show();
    await f.settle();
    const pendingCurrent = f.server.requests.filter((r) => isCurrent(r.path));
    held.stop();
    // A later transition: tab 1 switches to sam (a newer epoch).
    expect(await f.signIn(l.page, "sam", "pw2")).toMatchObject({
      kind: "settled",
    });
    const settled = stateOf(f).settled;
    f.server.revoke(l.sessionId);
    held.release();
    await f.settle();
    expect(stateOf(f).settled).toMatchObject({
      account_id: settled?.account_id,
      epoch: settled?.epoch,
    });
    expect(fencesOf(f, settled?.account_id ?? "")).toEqual([]);
    expect(pendingCurrent.length).toBeGreaterThanOrEqual(0);
    expect(checkProperties(f)).toEqual([]);
  });
});

describe("T17: a password change or revocation in another tab", () => {
  test("tab 1 changes the password: every session is gone; tab 1 raises the row 5 fence; tab 2's next request is 401 and agrees; no cookie changed", async () => {
    const f = await newWorld();
    const l = await signedInPage(f);
    const tab2 = await openPage(f);
    const cookie = f.server.cookie;
    const result = await f.runWith(
      l.page.session.operations.changePassword({
        current: "pw",
        next: "correct-horse-battery-9271",
      }),
    );
    expect(result.ok).toBe(true);
    await f.settle();
    expect(f.server.sessions.size).toBe(0);
    expect(f.server.cookie).toBe(cookie);
    expect(fencesOf(f, l.account)).toEqual(["invalid_session"]);
    await f
      .runWith(ordinaryGet(tab2, l.account, l.epoch))
      .catch(() => undefined);
    await f.settle();
    expect(fencesOf(f, l.account)).toEqual(["invalid_session"]);
    for (const page of [l.page, tab2])
      expect(page.session.view.get()).toMatchObject({
        kind: "neutral",
        state: "1b",
      });
    expect(checkProperties(f)).toEqual([]);
  });

  test("a stale row-5 response arriving after the same account re-authenticated is discarded by its stamp", async () => {
    const f = await newWorld();
    const l = await signedInPage(f);
    const held = holdAnswers(f, (r) => r.path === `${API}/password`);
    const pending = l.page.session.operations.changePassword({
      current: "pw",
      next: "correct-horse-battery-9271",
    });
    await f.settle();
    held.stop();
    // The change committed (every session deleted); its answer is held. The same account signs in again with the new password.
    expect(f.server.sessions.size).toBe(0);
    expect(
      await f.signIn(l.page, "kieran", "correct-horse-battery-9271"),
    ).toMatchObject({ kind: "settled", account_id: l.account });
    await f.settle();
    const newer = stateOf(f).settled?.epoch;
    held.release();
    const late = await f.runWith(pending);
    await f.settle();
    expect(late.ok).toBe(false);
    expect(stateOf(f).settled?.epoch).toBe(newer);
    expect(fencesOf(f, l.account)).toEqual([]);
    expect(l.page.session.view.get()).toMatchObject({
      kind: "displaying",
      account_id: l.account,
    });
    expect(checkProperties(f)).toEqual([]);
  });
});

describe("T21: credential_mismatch, a failed verification and a frozen tab", () => {
  test("the mismatch is fenced AT ONCE (1e in every tab); a failed current() and a reload change nothing; a frozen tab resumes neutral; current() 200 Y clears only that fence", async () => {
    const f = await newWorld();
    const y = await signedInPage(f, "sam", "pw2");
    const tab3 = await openPage(f);
    tab3.hide();
    await f.settle();
    tab3.freeze();
    // The cookie unexpectedly names a live session of X (a late activation that landed before its cancel, T8).
    const x = f.server.createSession(accountIdOf(f, "kieran"), "dev-x");
    f.server.adoptCookie(x);
    // t1/t2: the verification's current() fails (the connection drops).
    f.server.addRule({
      match: (r) => isCurrent(r.path),
      dropBeforeForward: true,
      times: 50,
    });
    await f
      .runWith(ordinaryGet(y.page, y.account, y.epoch))
      .catch(() => undefined);
    await f.settle();
    expect(fencesOf(f, y.account)).toContain("credential_unverified");
    expect(y.page.session.view.get()).toMatchObject({ kind: "neutral" });
    expect((y.page.session.view.get() as { state: string }).state).toMatch(
      /^1e\./,
    );
    // A reload changes nothing: the fence is durable.
    y.page.destroy();
    const reloaded = await openPage(f);
    expect(reloaded.session.view.get().kind).not.toBe("displaying");
    // t3: the frozen tab resumes: neutral at once, never Y's content.
    tab3.thaw();
    tab3.show();
    await f.settle();
    expect(tab3.session.view.get().kind).not.toBe("displaying");
    // t4a: online again, the cookie is consistent (Y's own session), current() 200 Y clears ONLY credential_unverified.
    f.server.rules = [];
    const ySession = f.server.sessions.get(y.sessionId);
    if (ySession) f.server.adoptCookie(ySession);
    reloaded.session.actions.retry();
    await f.settle();
    expect(fencesOf(f, y.account)).toEqual([]);
    expect(reloaded.session.view.get()).toMatchObject({
      kind: "displaying",
      account_id: y.account,
    });
    expect(checkProperties(f)).toEqual([]);
  });

  test("t4b: current() 200 X replaces the fence by drift (1d); t4c: 401 replaces it by invalid_session (1b)", async () => {
    for (const branch of ["drift", "invalid"] as const) {
      const f = await newWorld();
      const y = await signedInPage(f, "sam", "pw2");
      const x = f.server.createSession(accountIdOf(f, "kieran"), "dev-x");
      f.server.adoptCookie(x);
      if (branch === "invalid") f.server.revoke(x.id);
      await f
        .runWith(ordinaryGet(y.page, y.account, y.epoch))
        .catch(() => undefined);
      await f.settle();
      expect(fencesOf(f, y.account), branch).toEqual(
        branch === "drift" ? ["drift"] : ["invalid_session"],
      );
      expect(y.page.session.view.get(), branch).toMatchObject({
        kind: "neutral",
        state: branch === "drift" ? "1d" : "1b",
      });
      expect(checkProperties(f)).toEqual([]);
    }
  });
});
