// @vitest-environment node
import { writeFileSync } from "node:fs";
import { afterAll, describe, expect, test } from "vitest";
import type { AttemptHandle, AttemptOutcome } from "../../src/session/api";
import { LOCKS } from "../../src/session/constants";
import type { FakePage, Fixture } from "../support/session/harness";
import { checkProperties } from "../support/session/properties";
import {
  attemptOf,
  holdLock,
  newWorld,
  signedInPage,
  stateOf,
} from "../support/session/scenarios";
import { API } from "../support/session/server";

/**
 * The ordering traces WEB-08b owns (lifecycle matrix T1, T2, T3, T15, T16), in the fake world: every server-processing
 * order, every delivery window and every cookie that changes. Layer B (fixture) evidence: it shows the module follows the
 * protocol against a stub of the contract. It is NEVER integration evidence; the same traces run against the released
 * backend in `tests/integration/integration.web08b-traces.spec.ts` (Layer C).
 *
 * When `ATLAS_TRACE_EVIDENCE` names a file the cells that passed are written there as JSON.
 */
const cells: { trace: string; cell: string; layer: "B"; result: "pass" }[] = [];
const passed = (trace: string, cell: string) =>
  cells.push({ trace, cell, layer: "B", result: "pass" });
afterAll(() => {
  const out = process.env.ATLAS_TRACE_EVIDENCE;
  if (out) writeFileSync(out, `${JSON.stringify(cells, null, 2)}\n`);
});

const PASSWORD = "correct-horse-battery-9271";
const isExchange = (path: string) =>
  path.endsWith("/browser-sessions") || path.endsWith("/browser-registration");
const isActivate = (path: string) =>
  path.endsWith("/browser-sessions/activate");

async function booted(f: Fixture, config?: { activationAbortMs?: number }) {
  const page = f.addPage(config ? { config } : {});
  await f.boot(page);
  return page;
}
async function begin(
  f: Fixture,
  page: FakePage,
  method: "password" | "registration" | "oidc",
): Promise<AttemptHandle> {
  const begun = await f.runWith(page.session.attempts.begin(method));
  if (begun.kind !== "started") throw new Error(`begin: ${begun.kind}`);
  return begun.handle;
}
const accountIdOf = (f: Fixture, username: string): string => {
  const account = [...f.server.accounts.values()].find(
    (a) => a.username === username,
  );
  if (!account) throw new Error(`no account ${username}`);
  return account.id;
};
const hintsPosted = (f: Fixture) =>
  f.world.logs.filter((entry) => entry.type === "hint.post").length;
const cookieWriters = (f: Fixture) =>
  f.server.requests.filter((r) => r.hadSetCookie);

/** The password sign-in of the other account ("sam"), run to completion by whoever calls it. */
const signInAsSam = (page: FakePage, handle: AttemptHandle) =>
  page.session.attempts.signInWithPassword(handle, {
    username: "sam",
    password: "pw2",
  });

// ---- T1 and T16 ----------------------------------------------------------------------------------------------------
type Order = "A-first" | "B-first";
type Window =
  | "before-B-starts"
  | "B-exchanging"
  | "B-gating"
  | "after-B-settled";
type AKind = "password" | "registration";

/**
 * Tab 1 starts attempt A (epoch 1, account X); tab 2 starts attempt B (epoch 2, account Y). `order` says whose login the
 * server processes first; `window` says when A's response reaches tab 1. For T16 attempt A is a registration, whose
 * account and invitation are committed on the server whatever happens to its response.
 */
async function runCell(aKind: AKind, order: Order, window: Window) {
  const f = await newWorld();
  const tab1 = await booted(f);
  const tab2 = await booted(f);
  const invitation = f.server.addInvitation();
  const xId = () =>
    aKind === "password" ? accountIdOf(f, "kieran") : accountIdOf(f, "newbie");
  const startA = (handle: AttemptHandle) =>
    aKind === "password"
      ? tab1.session.attempts.signInWithPassword(handle, {
          username: "kieran",
          password: "pw",
        })
      : tab1.session.attempts.registerWithInvitation(handle, {
          token: invitation.token,
          username: "newbie",
          password: PASSWORD,
        });
  const ySession = () => accountIdOf(f, "sam");

  if (window === "before-B-starts") {
    // A is still the newest attempt when its response arrives: it activates and settles; B's later start supersedes it.
    const handleA = await begin(f, tab1, aKind);
    const outcomeA = await f.runWith(startA(handleA));
    expect(outcomeA).toMatchObject({ kind: "settled", account_id: xId() });
    const cookieAfterA = f.server.cookie;
    const handleB = await begin(f, tab2, "password");
    expect(handleB.epoch).toBe(2);
    const outcomeB = await f.runWith(signInAsSam(tab2, handleB));
    expect(outcomeB).toMatchObject({ kind: "settled", account_id: ySession() });
    await f.settle();
    // The cookie changed exactly twice, each time at the newest attempt's own activation.
    const writers = cookieWriters(f);
    expect(writers.map((r) => r.path)).toEqual([
      `${API}/browser-sessions/activate`,
      `${API}/browser-sessions/activate`,
    ]);
    expect(writers.map((r) => r.page)).toEqual([tab1.id, tab2.id]);
    expect(cookieAfterA).not.toBeNull();
    expect(f.server.cookie).not.toBe(cookieAfterA);
    expect(tab1.session.identity.get()?.account_id).toBe(ySession());
    expect(stateOf(f).settled?.account_id).toBe(ySession());
    expect(checkProperties(f)).toEqual([]);
    return f;
  }

  const handleA = await begin(f, tab1, aKind);
  const handleB = await begin(f, tab2, "password");
  expect([handleA.epoch, handleB.epoch]).toEqual([1, 2]);
  const exchanges = f.server.addRule({
    match: ({ path }) => isExchange(path),
    delay: "unbounded",
  });
  const activations = f.server.addRule({
    match: ({ path }) => isActivate(path),
    delay: "unbounded",
  });
  const releaseExchange = (page: FakePage) =>
    f.world.release(
      "Da",
      (meta) => meta.page === page.id && isExchange(String(meta.path)),
    );
  // The server processes the two logins in `order`; both answers are held in the network.
  const runA = () => startA(handleA);
  const runB = () => signInAsSam(tab2, handleB);
  let pendingA: Promise<AttemptOutcome>;
  let pendingB: Promise<AttemptOutcome>;
  if (order === "A-first") {
    pendingA = runA();
    await f.world.runUntilIdle();
    pendingB = runB();
    await f.world.runUntilIdle();
  } else {
    pendingB = runB();
    await f.world.runUntilIdle();
    pendingA = runA();
    await f.world.runUntilIdle();
  }
  const exchangeOrder = f.server.requests
    .filter((r) => isExchange(r.path))
    .map((r) => r.page);
  expect(exchangeOrder).toEqual(
    order === "A-first" ? [tab1.id, tab2.id] : [tab2.id, tab1.id],
  );
  const cookieBefore = f.server.cookie;
  const verifierB = attemptOf(f).verifier;

  const discardA = async () => {
    const before = hintsPosted(f);
    const attemptBefore = structuredClone(stateOf(f).attempt);
    releaseExchange(tab1);
    const outcome = await f.runWith(pendingA);
    // A's late response is discarded: no state changes and nothing is broadcast.
    expect(outcome).toEqual({ kind: "superseded" });
    expect(stateOf(f).attempt).toEqual(attemptBefore);
    expect(hintsPosted(f)).toBe(before);
    expect(f.server.cookie).toBe(cookieBefore);
  };

  if (window === "B-exchanging") {
    // After B has started, before B's own response: B's attempt is `exchanging` and untouched by the discard.
    await discardA();
    expect(attemptOf(f)).toMatchObject({
      epoch: 2,
      phase: "exchanging",
      verifier: verifierB,
    });
    activations();
    releaseExchange(tab2);
    expect(await f.runWith(pendingB)).toMatchObject({ kind: "settled" });
  } else if (window === "B-gating") {
    // B is `activating` (its activate request is in flight) when A's response arrives.
    releaseExchange(tab2);
    await f.world.runUntilIdle();
    expect(attemptOf(f)).toMatchObject({ epoch: 2, phase: "activating" });
    await discardA();
    expect(attemptOf(f)).toMatchObject({
      epoch: 2,
      phase: "activating",
      verifier: verifierB,
    });
    activations();
    f.world.release("Da", (meta) => isActivate(String(meta.path)));
    expect(await f.runWith(pendingB)).toMatchObject({ kind: "settled" });
  } else {
    // B has settled and its attempt record is gone: the worst case.
    releaseExchange(tab2);
    await f.world.runUntilIdle();
    activations();
    f.world.release("Da", (meta) => isActivate(String(meta.path)));
    expect(await f.runWith(pendingB)).toMatchObject({ kind: "settled" });
    await f.settle();
    expect(stateOf(f).attempt).toBeNull();
    const settledB = structuredClone(stateOf(f).settled);
    const cookieSettled = f.server.cookie;
    const before = hintsPosted(f);
    releaseExchange(tab1);
    expect(await f.runWith(pendingA)).toEqual({ kind: "superseded" });
    expect(stateOf(f).settled).toEqual(settledB);
    expect(stateOf(f).attempt).toBeNull();
    expect(f.server.cookie).toBe(cookieSettled);
    expect(hintsPosted(f)).toBe(before);
  }
  exchanges();
  await f.settle();

  // In every cell: B settled; A's grant was never redeemed; the only response that set the cookie was B's activation.
  expect(stateOf(f).settled?.account_id).toBe(ySession());
  expect(tab1.session.identity.get()?.account_id).toBe(ySession());
  expect(tab2.session.identity.get()?.account_id).toBe(ySession());
  const writers = cookieWriters(f);
  expect(writers.map((r) => r.path)).toEqual([
    `${API}/browser-sessions/activate`,
  ]);
  expect(writers[0]?.page).toBe(tab2.id);
  expect(f.server.recordsFor(`${API}/browser-sessions/activate`)).toHaveLength(
    1,
  );
  const grantA = [...f.server.grants.values()].find((g) => g.account === xId());
  expect(grantA?.state).toBe("issued");
  expect(f.server.sessions.size).toBe(1);
  expect(f.store.violations).toEqual([]);
  expect(checkProperties(f)).toEqual([]);
  return f;
}

const ORDERS: Order[] = ["A-first", "B-first"];
const WINDOWS: Window[] = [
  "before-B-starts",
  "B-exchanging",
  "B-gating",
  "after-B-settled",
];

describe("T1: a delayed password login response after B has started (server order x delivery window)", () => {
  for (const order of ORDERS)
    for (const window of WINDOWS) {
      if (window === "before-B-starts" && order === "B-first") {
        // B's login cannot be processed before B has started, and B starts only after A's response was delivered.
        test.skip(`server order ${order} x ${window}: structurally impossible`, () =>
          undefined);
        continue;
      }
      test(`server order ${order} x A's response delivered ${window}`, async () => {
        await runCell("password", order, window);
        passed("T1", `${order} x ${window}`);
      });
    }
});

describe("T16: registration by invitation, delayed response", () => {
  for (const order of ORDERS)
    for (const window of WINDOWS) {
      if (window === "before-B-starts" && order === "B-first") {
        test.skip(`server order ${order} x ${window}: structurally impossible`, () =>
          undefined);
        continue;
      }
      test(`registration, server order ${order} x response delivered ${window}`, async () => {
        const f = await runCell("registration", order, window);
        // The account and the invitation were committed on the server whatever happened to the response.
        expect(
          [...f.server.accounts.values()].some((a) => a.username === "newbie"),
        ).toBe(true);
        expect([...f.server.invitations.values()][0]?.state).toBe("redeemed");
        // The person signs in with the credentials they chose.
        const page = f.pages[0];
        if (!page) throw new Error("no page");
        const outcome = await f.signIn(page, "newbie", PASSWORD);
        expect(outcome).toMatchObject({
          kind: "settled",
          method: "password",
          account_id: accountIdOf(f, "newbie"),
        });
        passed("T16", `${order} x ${window}`);
      });
    }
});

// ---- T2 ------------------------------------------------------------------------------------------------------------
describe("T2: a stale OIDC redirect arriving after B has started or settled", () => {
  async function startedOidc(f: Fixture) {
    const tab1 = await booted(f);
    const handleA = await begin(f, tab1, "oidc");
    const started = await f.runWith(tab1.session.attempts.startOidc(handleA));
    expect(started.kind).toBe("redirect");
    // The tab navigates to the provider.
    tab1.destroy("commit");
    return handleA;
  }

  test("(a) the provider completes after B has settled: the landing is discarded, B stays", async () => {
    const f = await newWorld();
    const handleA = await startedOidc(f);
    const tab2 = await booted(f);
    const handleB = await begin(f, tab2, "password");
    expect(handleB.epoch).toBe(handleA.epoch + 1);
    expect(await f.runWith(signInAsSam(tab2, handleB))).toMatchObject({
      kind: "settled",
    });
    await f.settle();
    const cookie = f.server.cookie;
    const settled = structuredClone(stateOf(f).settled);
    const fragment = f.server.completeOidc(
      f.server.latestOidcFlow(),
      accountIdOf(f, "kieran"),
    );
    const landing = await booted(f);
    expect(await f.runWith(landing.session.attempts.landing(fragment))).toEqual(
      {
        kind: "superseded",
      },
    );
    await f.settle();
    expect(f.server.cookie).toBe(cookie);
    expect(stateOf(f).settled).toEqual(settled);
    expect(landing.session.identity.get()?.account_id).toBe(
      accountIdOf(f, "sam"),
    );
    expect(f.server.grants.get(fragment.grant)?.state).toBe("issued");
    expect(
      f.server.recordsFor(`${API}/browser-sessions/activate`),
    ).toHaveLength(1);
    expect(checkProperties(f)).toEqual([]);
    passed("T2", "(a) after B settled, landing tab with a settled identity");
  });

  test("(b) the provider completes while B is `exchanging`: discarded, B's attempt untouched, no identity is ever the provider's", async () => {
    const f = await newWorld();
    const handleA = await startedOidc(f);
    const tab2 = await booted(f);
    const handleB = await begin(f, tab2, "password");
    expect(handleB.epoch).toBe(handleA.epoch + 1);
    f.server.addRule({
      match: ({ path }) => isExchange(path),
      delay: "unbounded",
    });
    const pendingB = signInAsSam(tab2, handleB);
    await f.world.runUntilIdle();
    const attemptBefore = structuredClone(stateOf(f).attempt);
    const fragment = f.server.completeOidc(
      f.server.latestOidcFlow(),
      accountIdOf(f, "kieran"),
    );
    const landing = await booted(f);
    expect(await f.runWith(landing.session.attempts.landing(fragment))).toEqual(
      {
        kind: "superseded",
      },
    );
    // The landing tab has no settled identity: it stays on the sign-in screen and nothing was changed.
    expect(stateOf(f).settled).toBeNull();
    expect(stateOf(f).attempt).toEqual(attemptBefore);
    expect(landing.session.view.get().kind).toBe("signed_out");
    expect(f.server.cookie).toBeNull();
    expect(f.server.grants.get(fragment.grant)?.state).toBe("issued");
    f.world.release("Da");
    expect(await f.runWith(pendingB)).toMatchObject({ kind: "settled" });
    expect(f.server.grants.get(fragment.grant)?.state).toBe("issued");
    passed(
      "T2",
      "(b) while B exchanging, landing tab without a settled identity",
    );
  });

  test("(c) the callback was processed before B started but the redirect is delivered after B settles: discarded", async () => {
    const f = await newWorld();
    await startedOidc(f);
    // The server consumed the provider flow and issued G_A before B was ever started.
    const fragment = f.server.completeOidc(
      f.server.latestOidcFlow(),
      accountIdOf(f, "kieran"),
    );
    const tab2 = await booted(f);
    const handleB = await begin(f, tab2, "password");
    expect(await f.runWith(signInAsSam(tab2, handleB))).toMatchObject({
      kind: "settled",
    });
    await f.settle();
    const cookie = f.server.cookie;
    const landing = await booted(f);
    expect(await f.runWith(landing.session.attempts.landing(fragment))).toEqual(
      {
        kind: "superseded",
      },
    );
    expect(f.server.cookie).toBe(cookie);
    expect(f.server.grants.get(fragment.grant)?.state).toBe("issued");
    expect(
      f.server.requests.filter((r) => r.hadSetCookie).map((r) => r.page),
    ).toEqual([tab2.id]);
    passed("T2", "(c) callback before B starts, delivered after B settled");
  });
});

// ---- T3 ------------------------------------------------------------------------------------------------------------
describe("T3: an unsuspended writer whose stale result fails the epoch check", () => {
  test("a stale GRANT is discarded: nothing but the stale attempt's own owner lock changes, and nothing is broadcast", async () => {
    const f = await newWorld();
    const tab1 = await booted(f);
    const tab2 = await booted(f);
    const handleA = await begin(f, tab1, "password");
    const handleB = await begin(f, tab2, "password");
    const attempt = structuredClone(stateOf(f).attempt);
    const before = hintsPosted(f);
    const outcome = await f.runWith(
      tab1.session.attempts.signInWithPassword(handleA, {
        username: "kieran",
        password: "pw",
      }),
    );
    expect(outcome).toEqual({ kind: "superseded" });
    expect(stateOf(f).attempt).toEqual(attempt);
    expect(attemptOf(f).epoch).toBe(handleB.epoch);
    expect(hintsPosted(f)).toBe(before);
    expect(f.server.requests.some((r) => r.hadSetCookie)).toBe(false);
    passed("T3", "stale grant");
  });

  test("a stale ERROR (wrong-password 401) does not clear B's attempt (K-1)", async () => {
    const f = await newWorld();
    const tab1 = await booted(f);
    const tab2 = await booted(f);
    const handleA = await begin(f, tab1, "password");
    await begin(f, tab2, "password");
    const attempt = structuredClone(stateOf(f).attempt);
    const before = hintsPosted(f);
    const outcome = await f.runWith(
      tab1.session.attempts.signInWithPassword(handleA, {
        username: "kieran",
        password: "WRONG",
      }),
    );
    expect(outcome).toEqual({ kind: "superseded" });
    expect(stateOf(f).attempt).toEqual(attempt);
    expect(hintsPosted(f)).toBe(before);
    passed("T3", "stale error while B exchanging");
  });

  test("a stale ERROR arriving after B settled does not touch B's settlement", async () => {
    const f = await newWorld();
    const tab1 = await booted(f);
    const tab2 = await booted(f);
    const handleA = await begin(f, tab1, "password");
    const handleB = await begin(f, tab2, "password");
    expect(await f.runWith(signInAsSam(tab2, handleB))).toMatchObject({
      kind: "settled",
    });
    await f.settle();
    const settled = structuredClone(stateOf(f).settled);
    const cookie = f.server.cookie;
    const before = hintsPosted(f);
    const outcome = await f.runWith(
      tab1.session.attempts.signInWithPassword(handleA, {
        username: "kieran",
        password: "WRONG",
      }),
    );
    expect(outcome).toEqual({ kind: "superseded" });
    expect(stateOf(f).settled).toEqual(settled);
    expect(stateOf(f).attempt).toBeNull();
    expect(f.server.cookie).toBe(cookie);
    expect(hintsPosted(f)).toBe(before);
    expect(tab1.session.identity.get()?.account_id).toBe(accountIdOf(f, "sam"));
    passed("T3", "stale error after B settled");
  });
});

// ---- T15 -----------------------------------------------------------------------------------------------------------
describe("T15: two live tabs start sign-ins at once", () => {
  test("(a) both exchange: tab 1's grant is discarded, tab 2 settles", async () => {
    const f = await newWorld();
    const tab1 = await booted(f);
    const tab2 = await booted(f);
    const handleA = await begin(f, tab1, "password");
    const handleB = await begin(f, tab2, "password");
    const [a, b] = await Promise.all([
      f.runWith(
        tab1.session.attempts.signInWithPassword(handleA, {
          username: "kieran",
          password: "pw",
        }),
      ),
      f.runWith(signInAsSam(tab2, handleB)),
    ]);
    expect(a).toEqual({ kind: "superseded" });
    expect(b).toMatchObject({
      kind: "settled",
      account_id: accountIdOf(f, "sam"),
    });
    passed("T15", "(a) both exchange");
  });

  test("(b) tab 2 fails: its attempt clears, the previous identity still renders, tab 1 is superseded", async () => {
    const f = await newWorld();
    const previous = await signedInPage(f);
    const tab1 = await booted(f);
    const tab2 = await booted(f);
    const handleA = await begin(f, tab1, "password");
    const handleB = await begin(f, tab2, "password");
    const failed = await f.runWith(
      tab2.session.attempts.signInWithPassword(handleB, {
        username: "sam",
        password: "WRONG",
      }),
    );
    expect(failed).toMatchObject({ kind: "refused", definitive: true });
    expect(stateOf(f).attempt).toBeNull();
    const late = await f.runWith(
      tab1.session.attempts.signInWithPassword(handleA, {
        username: "sam",
        password: "pw2",
      }),
    );
    expect(late).toEqual({ kind: "superseded" });
    for (const page of [previous.page, tab1, tab2])
      expect(page.session.identity.get()?.account_id).toBe(previous.account);
    expect(stateOf(f).settled?.account_id).toBe(previous.account);
    passed("T15", "(b) tab 2 fails");
  });

  test("(c) tab 2 is activating when tab 1 begins: tab 1 waits for the lock and then supersedes", async () => {
    const f = await newWorld();
    const tab1 = await booted(f);
    const tab2 = await booted(f);
    const handleB = await begin(f, tab2, "password");
    const activations = f.server.addRule({
      match: ({ path }) => isActivate(path),
      delay: "unbounded",
    });
    const pendingB = signInAsSam(tab2, handleB);
    await f.world.runUntilIdle();
    expect(attemptOf(f).phase).toBe("activating");
    let began: Awaited<ReturnType<typeof tab1.session.attempts.begin>> | null =
      null;
    const pendingBegin = tab1.session.attempts.begin("password").then((v) => {
      began = v;
      return v;
    });
    await f.world.advance(5_000);
    expect(began).toBeNull();
    // Tab 1 never opened an activation of its own.
    expect(
      f.server.recordsFor(`${API}/browser-sessions/activate`),
    ).toHaveLength(1);
    activations();
    f.world.release("Da", (meta) => isActivate(String(meta.path)));
    expect(await f.runWith(pendingB)).toMatchObject({ kind: "settled" });
    const result = await f.runWith(pendingBegin);
    expect(result.kind).toBe("started");
    if (result.kind === "started")
      expect(result.handle.epoch).toBe(handleB.epoch + 1);
    expect(stateOf(f).settled?.account_id).toBe(accountIdOf(f, "sam"));
    passed("T15", "(c) waits for the lock, within 20 s, then supersedes");
  });

  test("(c) beyond 20 s tab 1 gives up with `lock_timeout` and sends nothing", async () => {
    const f = await newWorld();
    const tab1 = await booted(f);
    const tab2 = await booted(f, { activationAbortMs: 120_000 });
    const handleB = await begin(f, tab2, "password");
    f.server.addRule({
      match: ({ path }) => isActivate(path),
      delay: "unbounded",
    });
    const pendingB = signInAsSam(tab2, handleB);
    await f.world.runUntilIdle();
    expect(attemptOf(f).phase).toBe("activating");
    const start = f.world.time;
    const pendingBegin = tab1.session.attempts.begin("password");
    await f.world.advance(20_001);
    expect(await f.runWith(pendingBegin)).toEqual({ kind: "lock_timeout" });
    expect(f.world.time - start).toBeGreaterThanOrEqual(20_000);
    // Never a steal: tab 2 still owns its attempt and tab 1 sent no activation.
    expect(attemptOf(f)).toMatchObject({
      epoch: handleB.epoch,
      phase: "activating",
    });
    expect(
      f.server.recordsFor(`${API}/browser-sessions/activate`),
    ).toHaveLength(1);
    f.world.release("Da", (meta) => isActivate(String(meta.path)));
    expect(await f.runWith(pendingB)).toMatchObject({ kind: "settled" });
    passed("T15", "(c) beyond 20 s: lock_timeout, nothing sent");
  });

  test("(d) a holder that never releases `atlas-auth` (a frozen tab): waiters time out and never steal", async () => {
    const f = await newWorld();
    const tab1 = await booted(f);
    const release = await holdLock(f, "frozen", LOCKS.auth);
    const start = f.world.time;
    const pendingBegin = tab1.session.attempts.begin("password");
    await f.world.advance(20_001);
    expect(await f.runWith(pendingBegin)).toEqual({ kind: "lock_timeout" });
    const waited = f.world.time - start;
    expect(waited).toBeGreaterThanOrEqual(20_000);
    expect(waited).toBeLessThan(21_000);
    // The lock is still the holder's: it was not stolen.
    expect(await f.runWith(tab1.kernel.ports.locks.probe(LOCKS.auth))).toBe(
      false,
    );
    expect(stateOf(f).attempt).toBeNull();
    release();
    const again = await begin(f, tab1, "password");
    expect(again.epoch).toBe(1);
    passed("T15", "(d) a holder that never releases: 20 s bound, never steals");
  });
});
