// @vitest-environment node
import { describe, expect, test } from "vitest";
import {
  type CallAttempt,
  type FirstObserverInput,
  type FirstObserverVerdict,
  judgeFirstObserver,
  type KernelEvent,
  type PageAnswer,
  type WireEntry,
} from "../integration/first-observer";
import type { FakePage, Fixture } from "../support/session/harness";
import {
  fencesOf,
  newWorld,
  ordinaryGet,
  type SignedIn,
  signedInPage,
} from "../support/session/scenarios";

/**
 * WEB-08d revision 32 (review 33 R33-N1, family `i04-first-stamped-request-premise`): I-05's credential mismatch in every first-
 * observer order, over the REAL kernel and operations (the fake world's scheduler holds and releases each answer), each outcome
 * judged by the same witness the released-backend I-05 cases use (tests/integration/first-observer.ts), fed with this world's
 * records: the page's `trace.*` log entries are its kernel trace, its `fetch.sent`/`fetch.answered` entries the proxy's log, and the
 * stub server's answer bodies the page's answers.
 *
 * - The list call observes first: `auth_state`, its own observation, for the same and for another account.
 * - A competing read observes first (the stamped transport on `/defaults/snapshot`, review 33's first observer; and another
 *   invocation of `listSessions()`, so the route does not identify the caller): `closed`, unsent.
 * - Both are issued before either answer arrives: the earlier answer observes first, the list call still answers `auth_state` from
 *   its own observation, and both observations are kept.
 * - Unrelated closure (a 401's invalid_session) refuses the list call `closed` too, and the witness rejects it.
 * Every schedule holds the verification so `credential_unverified` and the neutral card are seen while it is outstanding; then the
 * same account clears, refreshes its session and reads again, and another account drifts (1d).
 */
const API = "/api/experimental/v1";
const LIST = `${API}/sessions`;
const SNAPSHOT = `${API}/defaults/snapshot`;
const CHECK = `${API}/browser-sessions/current`;

interface Cut {
  trace: number;
  wire: number;
  account: string;
  epoch: number;
}

/** Records every answer body's Atlas `code`, by page, method, path and per-route ordinal (the order the stub server numbers them). */
function recordCodes(f: Fixture) {
  const codes = new Map<string, string | null>();
  const process = f.server.process.bind(f.server);
  f.server.process = (page, method, path, headers, body, cookie) => {
    const out = process(page, method, path, headers, body, cookie);
    const sent = (out.rule?.rewrite?.body ?? out.answer.body) as {
      code?: unknown;
    } | null;
    codes.set(
      `${page} ${method} ${path} ${out.ordinal}`,
      typeof sent?.code === "string" ? sent.code : null,
    );
    return out;
  };
  return codes;
}

const traceOf = (f: Fixture, page: FakePage): KernelEvent[] =>
  f.world.logs
    .filter(
      (entry) => entry.page === page.id && entry.type.startsWith("trace."),
    )
    .map(({ type, seq: _seq, t: _t, page: _page, ...data }) => ({
      event: type.slice("trace.".length),
      data,
    }));

const cutHere = (f: Fixture, l: SignedIn): Cut => ({
  trace: traceOf(f, l.page).length,
  wire: f.world.logs.at(-1)?.seq ?? 0,
  account: l.account,
  epoch: l.epoch,
});

/** The page's requests as the proxy logs them: arrival order, the backend's status, and whether the answer was delivered. */
function wireOf(f: Fixture, page: FakePage): WireEntry[] {
  const delivered = new Set(
    f.world.logs
      .filter((e) => e.type === "fetch.answered" && e.page === page.id)
      .map((e) => `${e.method} ${e.path} ${e.ordinal}`),
  );
  return f.world.logs
    .filter((e) => e.type === "fetch.sent" && e.page === page.id)
    .map((e) => ({
      id: e.seq,
      method: String(e.method),
      path: String(e.path),
      status: Number(e.status),
      events: [
        { event: "upstream_response", status: Number(e.status) },
        ...(delivered.has(`${e.method} ${e.path} ${e.ordinal}`)
          ? [{ event: "delivered", status: Number(e.status) }]
          : []),
      ],
    }));
}

function answersOf(
  f: Fixture,
  page: FakePage,
  cut: Cut,
  codes: Map<string, string | null>,
): PageAnswer[] {
  return f.world.logs
    .filter(
      (e) =>
        e.type === "fetch.answered" && e.page === page.id && e.seq > cut.wire,
    )
    .map((e) => ({
      method: String(e.method),
      path: String(e.path),
      status: Number(e.status),
      code: codes.get(`${page.id} ${e.method} ${e.path} ${e.ordinal}`) ?? null,
    }));
}

/** One attempt: the activity `send` creates synchronously inside the call, and the call's result once the world has run. */
function attempt(
  f: Fixture,
  page: FakePage,
  call: () => Promise<{ ok: boolean; error?: string }>,
) {
  const from = traceOf(f, page).length;
  const pending = call();
  const created = traceOf(f, page)
    .slice(from)
    .find((e) => e.event === "activity.create");
  const n = typeof created?.data?.n === "number" ? created.data.n : null;
  const settled = pending.then((r) =>
    r.ok ? { ok: true } : { ok: false, error: r.error },
  );
  return { n, settled };
}

/** The explicit call, retried while NOT_SENT exactly as the integration `__retry` does (100 ms apart). */
async function listWitnessed(f: Fixture, page: FakePage) {
  const attempts: CallAttempt[] = [];
  for (let i = 0; i < 60; i += 1) {
    const { n, settled } = attempt(f, page, () =>
      page.session.operations.listSessions(),
    );
    await f.world.runUntilIdle();
    const result = await settled;
    attempts.push({ n, result });
    if (result.ok || result.error !== "not_sent") break;
    await f.world.advance(100);
  }
  return attempts;
}

/** The stamped transport the typed client uses, as `readDefaultsSnapshotThrough` reaches it: `auth_state` is its rejection's kind. */
const typedSnapshot = (l: SignedIn) => () =>
  ordinaryGet(l.page, l.account, l.epoch, "/defaults/snapshot").then(
    () => ({ ok: true }),
    (error: { kind?: string }) => ({
      ok: false,
      error: error?.kind ?? String(error),
    }),
  );

function judge(
  f: Fixture,
  l: SignedIn,
  cut: Cut,
  codes: Map<string, string | null>,
  call: CallAttempt[],
  exclusive: NonNullable<FirstObserverInput["exclusive"]>,
): FirstObserverVerdict {
  return judgeFirstObserver({
    identity: { account: cut.account, epoch: cut.epoch },
    document: { atCut: l.page.id, atJudgement: l.page.id },
    trace: traceOf(f, l.page),
    cut: cut.trace,
    call,
    wire: wireOf(f, l.page),
    wireCut: cut.wire,
    answers: answersOf(f, l.page, cut, codes),
    exclusive,
  });
}

/** Holds the answers of matching requests until `release(path)` (the fake world's `Da` delivery, filtered). */
function holdPaths(f: Fixture, paths: string[]) {
  const stop = f.server.addRule({
    match: (r) => paths.includes(r.path),
    delay: "unbounded",
  });
  return {
    release: (path: string) =>
      f.world.release("Da", (meta) => meta.path === path),
    stop,
  };
}

async function setup(who: "same" | "other") {
  const f = await newWorld();
  const codes = recordCodes(f);
  const l = await signedInPage(f);
  const sam = [...f.server.accounts.values()].find((a) => a.username === "sam");
  if (!sam) throw new Error("setup: no sam");
  const session = f.server.createSession(
    who === "same" ? l.account : sam.id,
    "dev-2",
  );
  const holds = holdPaths(f, [CHECK]);
  const cut = cutHere(f, l);
  f.server.adoptCookie(session);
  return { f, l, codes, session, holds, cut };
}

/** While the verification is held: credential_unverified and the neutral card; the verification was issued after the witness. */
function closedWhileChecking(
  f: Fixture,
  l: SignedIn,
  verdict: FirstObserverVerdict,
) {
  expect(fencesOf(f, l.account)).toContain("credential_unverified");
  expect(l.page.session.view.get()).toMatchObject({
    kind: "neutral",
    state: expect.stringMatching(/^1e\.session_/),
  });
  expect(
    traceOf(f, l.page)
      .slice(verdict.first?.classified ?? 0)
      .some(
        (e) => e.event === "request.issued" && e.data?.klass === "verification",
      ),
  ).toBe(true);
  expect(
    f.world.heldCount("Da", (meta) => meta.path === CHECK),
  ).toBeGreaterThanOrEqual(1);
}

async function sameAccountRecovers(
  f: Fixture,
  l: SignedIn,
  holds: { release: (path: string) => number; stop: () => void },
  session: { id: string },
) {
  holds.stop();
  holds.release(CHECK);
  await f.world.runUntilIdle();
  expect(fencesOf(f, l.account)).toEqual([]);
  expect(l.page.session.identity.get()).toMatchObject({
    account_id: l.account,
    session_id: session.id,
  });
  expect(l.page.session.view.get().kind).toBe("displaying");
  // The refreshed token works with the new cookie.
  expect((await listWitnessed(f, l.page)).at(-1)?.result).toEqual({ ok: true });
}

async function otherAccountDrifts(
  f: Fixture,
  l: SignedIn,
  holds: { release: (path: string) => number; stop: () => void },
) {
  holds.stop();
  holds.release(CHECK);
  await f.world.runUntilIdle();
  expect(fencesOf(f, l.account)).toContain("drift");
  expect(l.page.session.view.get()).toMatchObject({
    kind: "neutral",
    state: "1d",
  });
}

describe("I-05 schedules over the real kernel, judged by the first-observer witness", () => {
  test.each(["same", "other"] as const)(
    "the list call observes first (%s account): auth_state from its own recorded observation",
    async (who) => {
      const { f, l, codes, session, holds, cut } = await setup(who);
      const listed = await listWitnessed(f, l.page);
      expect(listed.at(-1)?.result).toEqual({
        ok: false,
        error: "auth_state",
      });
      const verdict = judge(f, l, cut, codes, listed, [
        { method: "GET", path: LIST, calls: [listed] },
      ]);
      expect(verdict.problems).toEqual([]);
      expect(verdict.observer).toBe("self");
      expect(verdict.first?.n).toBe(listed.at(-1)?.n);
      // Order: the call's request, its 403, the classification, the durable record, then the verification.
      const trace = traceOf(f, l.page);
      const own = listed.at(-1)?.n;
      const issued = trace.findIndex(
        (e, i) =>
          i >= cut.trace && e.event === "request.issued" && e.data?.n === own,
      );
      expect(issued).toBeGreaterThanOrEqual(cut.trace);
      expect(verdict.first?.surrendered).toBeGreaterThan(issued);
      expect(verdict.first?.recorded).toBeGreaterThan(
        verdict.first?.classified ?? Number.POSITIVE_INFINITY,
      );
      closedWhileChecking(f, l, verdict);
      if (who === "same") await sameAccountRecovers(f, l, holds, session);
      else await otherAccountDrifts(f, l, holds);
    },
  );

  test.each([
    ["same", "the stamped transport on /defaults/snapshot"],
    ["other", "the stamped transport on /defaults/snapshot"],
    ["same", "another invocation of listSessions()"],
    ["other", "another invocation of listSessions()"],
  ] as const)(
    "a competing read observes first (%s account, %s): the list call is refused closed, unsent",
    async (who, reader) => {
      const { f, l, codes, session, holds, cut } = await setup(who);
      const sameRoute = reader.includes("listSessions");
      const competing = attempt(
        f,
        l.page,
        sameRoute
          ? () => l.page.session.operations.listSessions()
          : typedSnapshot(l),
      );
      await f.world.runUntilIdle();
      expect(await competing.settled).toEqual({
        ok: false,
        error: "auth_state",
      });
      const listed = await listWitnessed(f, l.page);
      expect(listed.at(-1)?.result).toEqual({ ok: false, error: "closed" });
      const raced: CallAttempt = {
        n: competing.n,
        result: { ok: false, error: "auth_state" },
      };
      const verdict = judge(
        f,
        l,
        cut,
        codes,
        listed,
        sameRoute
          ? [{ method: "GET", path: LIST, calls: [listed, [raced]] }]
          : [
              { method: "GET", path: LIST, calls: [listed] },
              { method: "GET", path: SNAPSHOT, calls: [[raced]] },
            ],
      );
      expect(verdict.problems).toEqual([]);
      expect(verdict.observer).toBe("other");
      expect(verdict.witness?.n).toBe(competing.n);
      expect(verdict.first?.n).toBe(competing.n);
      closedWhileChecking(f, l, verdict);
      if (who === "same") await sameAccountRecovers(f, l, holds, session);
      else await otherAccountDrifts(f, l, holds);
    },
  );

  test("both issued before either answer arrives: the earlier answer observes first, the list call answers auth_state from its own, both are kept", async () => {
    const { f, l, codes, session, holds, cut } = await setup("same");
    const answers = holdPaths(f, [SNAPSHOT, LIST]);
    const competing = attempt(f, l.page, typedSnapshot(l));
    const listing = attempt(f, l.page, () =>
      l.page.session.operations.listSessions(),
    );
    await f.world.runUntilIdle();
    answers.stop();
    answers.release(SNAPSHOT);
    await f.world.runUntilIdle();
    answers.release(LIST);
    await f.world.runUntilIdle();
    const listed: CallAttempt[] = [
      { n: listing.n, result: await listing.settled },
    ];
    expect(listed[0]?.result).toEqual({ ok: false, error: "auth_state" });
    expect(await competing.settled).toEqual({ ok: false, error: "auth_state" });
    const verdict = judge(f, l, cut, codes, listed, [
      { method: "GET", path: LIST, calls: [listed] },
    ]);
    expect(verdict.problems).toEqual([]);
    expect(verdict.observer).toBe("self");
    expect(verdict.first?.n).toBe(competing.n);
    expect(verdict.observations.map((o) => o.n)).toEqual([
      competing.n,
      listing.n,
    ]);
    closedWhileChecking(f, l, verdict);
    await sameAccountRecovers(f, l, holds, session);
  });

  test("an unrelated closure (a 401's invalid_session) also refuses the list call closed, and the witness rejects it", async () => {
    const f = await newWorld();
    const codes = recordCodes(f);
    const l = await signedInPage(f);
    const cut = cutHere(f, l);
    f.server.revoke(l.sessionId);
    const competing = attempt(f, l.page, typedSnapshot(l));
    await f.world.runUntilIdle();
    expect(await competing.settled).toEqual({ ok: false, error: "auth_state" });
    const listed = await listWitnessed(f, l.page);
    expect(listed.at(-1)?.result).toEqual({ ok: false, error: "closed" });
    expect(fencesOf(f, l.account)).toEqual(["invalid_session"]);
    const verdict = judge(f, l, cut, codes, listed, [
      { method: "GET", path: LIST, calls: [listed] },
    ]);
    expect(verdict.observer).toBeNull();
    expect(verdict.problems.join("\n")).toMatch(
      /no other activity's credential_mismatch observation/,
    );
  });
});
