// @vitest-environment node
import { describe, expect, test } from "vitest";
import { accountDatabaseName } from "../../src/data/model/schema";
import { watchTransactions } from "../support/data/identity-reads";
import { RealData } from "../support/data/real-ports";
import {
  answerHealthy,
  controllerOverSession,
  createDatabase,
  ME,
  requestsTo,
  SESSIONS,
} from "../support/data/session-controller";
import { EPOCH_BASE } from "../support/session/env";
import type { FakePage, Fixture } from "../support/session/harness";
import {
  newWorld,
  openPage,
  type SignedIn,
  signedInPage,
} from "../support/session/scenarios";

/**
 * R16 (revision 8): the profile read and the device mirror, in the production composition. THE REAL SESSION of the 08a fixture
 * (two tabs of one origin: every request a tab sends writes a lease the other hears, and each hint makes the session evaluate and
 * publish a NEW identity object), the production adapters over it (`GET /me`, `GET /sessions`), the production controller, and the
 * real account database over the data layer's double of IndexedDB. Only the platform is a double.
 *
 * Before the fix a failed read of either endpoint was asked again by every identity notification, so two tabs fed each other: one
 * tab's request wrote a lease, the other tab evaluated, published an identity, and asked again. The review measured about 800
 * requests to each endpoint in two seconds across two tabs, for a 404, a 503 and a connection reset alike (`native/` of the review,
 * and E-C9 here, in three real engines). The fake world's session evaluates only on its own schedule (every 30 s per tab), so the
 * amplification of a real browser is not reproduced here; what these bound is every other way a notification could ask again.
 *
 * Everything below counts requests that REACHED THE SERVER, from both tabs, per endpoint.
 */
interface Scene {
  f: Fixture;
  real: RealData;
  signed: SignedIn;
  pages: [FakePage, FakePage];
  account: string;
}

async function scene(options: { database?: boolean } = {}): Promise<Scene> {
  const f = await newWorld();
  const real = new RealData();
  real.attach(f.world);
  const signed = await signedInPage(f);
  const other = await openPage(f);
  await f.settle();
  if (options.database !== false) await createDatabase(real, signed.account);
  return {
    f,
    real,
    signed,
    pages: [signed.page, other],
    account: signed.account,
  };
}

type Mode = "healthy" | "404" | "503" | "reset";

/** The server's behaviour for both endpoints; `healthy` answers `/me` with the account's profile (the stub does not route it). */
function serve(t: Scene, mode: Mode): void {
  if (mode === "healthy") {
    answerHealthy(t.f, t.account, "kieran");
    return;
  }
  for (const path of [ME, SESSIONS])
    t.f.server.addRule({
      match: (r) => r.method === "GET" && r.path === path,
      ...(mode === "reset"
        ? { dropAfterForward: true }
        : {
            rewrite: {
              status: Number(mode),
              body: { code: "injected", message: "Injected by the test" },
            },
          }),
    });
}

const both = (t: Scene) => ({
  me: requestsTo(t.f, ME),
  sessions: requestsTo(t.f, SESSIONS),
});

async function run(t: Scene, ms: number): Promise<void> {
  await t.f.world.advance(ms);
  await t.f.settle();
}

const profileEntries = (t: Scene) =>
  Object.keys(t.real.sync(t.account)?.read_retry_states ?? {}).sort();

describe("two real tabs, one account, a database that exists", () => {
  test("a healthy control: one read of each endpoint per tab, the label shown, and nothing more for a minute", async () => {
    const t = await scene();
    serve(t, "healthy");
    const seen = watchTransactions(t.real.idb);
    const controllers = t.pages.map((page) =>
      controllerOverSession(t.f, t.real, page),
    );
    await t.f.settle();
    await run(t, 60_000);
    expect(both(t)).toEqual({ me: 2, sessions: 2 });
    // No retry state was written, whatever the order in which each tab's database opened and its reads answered.
    expect(seen.count("data.recordReadOutcome")).toBe(0);
    seen.stop();
    for (const c of controllers) {
      expect(c.ui.profile.labelFor(c.page.session.identity.get())).toBe(
        "kieran",
      );
      c.dispose();
    }
    // The healthy path leaves no retry state.
    expect(t.real.sync(t.account)?.read_retry_states).toEqual({});
    // The device mirror wrote the device of the current session.
    expect(t.real.sync(t.account)).toMatchObject({ device_verified: true });
  });

  test.each([["404"], ["503"], ["reset"]] as const)(
    "a %s on both endpoints: bounded in the first seconds, bounded in an hour, then quiet",
    async (mode) => {
      const t = await scene();
      serve(t, mode);
      const controllers = t.pages.map((page) =>
        controllerOverSession(t.f, t.real, page),
      );
      await t.f.settle();
      // The review's window: 1.2 s of settling, then 2 s of counting, at most five reads per endpoint across both tabs.
      await run(t, 1_200);
      const before = both(t);
      await run(t, 2_000);
      const after = both(t);
      expect(after.me - before.me).toBeLessThanOrEqual(5);
      expect(after.sessions - before.sessions).toBeLessThanOrEqual(5);
      // The whole outage: eight attempts at most per tab for the network class (the sustained duration), and three answers for
      // the unrecognised class, shared by the tabs through the database.
      await run(t, 3_600_000);
      const hour = both(t);
      const bound = mode === "404" ? 4 : 16;
      expect(hour.me).toBeLessThanOrEqual(bound);
      expect(hour.sessions).toBeLessThanOrEqual(bound);
      // And nothing after that: a further hour asks nothing.
      await run(t, 3_600_000);
      expect(both(t)).toEqual(hour);
      // The budget is the caller's own, in the shared database: paused, for this sign-in only.
      const epoch = t.signed.page.session.identity.get()?.epoch;
      const states = t.real.sync(t.account)?.read_retry_states ?? {};
      expect(Object.keys(states).sort()).toEqual([
        `device:${epoch}`,
        `profile:${epoch}`,
      ]);
      expect(states[`profile:${epoch}`]).toMatchObject({ paused: true });
      expect(states[`device:${epoch}`]).toMatchObject({ paused: true });
      // Nothing was shown that was not verified.
      for (const c of controllers) {
        expect(c.ui.profile.labelFor(c.page.session.identity.get())).toBeNull();
        c.dispose();
      }
    },
  );

  test("online ends a pause by duration (a 503), and the reads are made again, boundedly", async () => {
    const t = await scene();
    serve(t, "503");
    const controllers = t.pages.map((page) =>
      controllerOverSession(t.f, t.real, page),
    );
    await t.f.settle();
    await run(t, 3_600_000);
    const paused = both(t);
    for (const c of controllers) {
      c.setOnline(false);
      c.setOnline(true);
    }
    await t.f.settle();
    // Each tab asks once more at once, and the schedule begins again.
    expect(both(t).me).toBeGreaterThan(paused.me);
    expect(both(t).me - paused.me).toBeLessThanOrEqual(2);
    await run(t, 3_600_000);
    expect(both(t).me - paused.me).toBeLessThanOrEqual(16);
    for (const c of controllers) c.dispose();
  });

  test("online does NOT end the pause that three unrecognised answers caused (a 404)", async () => {
    const t = await scene();
    serve(t, "404");
    const controllers = t.pages.map((page) =>
      controllerOverSession(t.f, t.real, page),
    );
    await t.f.settle();
    await run(t, 3_600_000);
    const paused = both(t);
    for (const c of controllers) {
      c.setOnline(false);
      c.setOnline(true);
    }
    await run(t, 3_600_000);
    expect(both(t)).toEqual(paused);
    for (const c of controllers) c.dispose();
  });

  test("a reload does not restart the budget: the durable pause stands from the first moment, so neither the profile nor the mirror asks anything (R16)", async () => {
    const t = await scene();
    serve(t, "503");
    const first = t.pages.map((page) =>
      controllerOverSession(t.f, t.real, page),
    );
    await t.f.settle();
    await run(t, 3_600_000);
    const paused = both(t);
    const epoch = t.signed.page.session.identity.get()?.epoch;
    const since = t.real.sync(t.account)?.read_retry_states[`profile:${epoch}`]
      ?.backing_off_since;
    for (const c of first) c.dispose();
    const reloaded = t.pages.map((page) =>
      controllerOverSession(t.f, t.real, page),
    );
    await t.f.settle();
    await run(t, 3_600_000);
    // Nothing at all: the page does not ask `/me` until it has looked for the account's database, and the paused entry it finds there
    // is the budget. (The first revision of this test allowed one more `/me` per tab, made before the database was bound.)
    expect(both(t)).toEqual(paused);
    const after = both(t);
    await run(t, 3_600_000);
    expect(both(t)).toEqual(after);
    // The clock is the same one: the first failure of the outage, not the reload.
    expect(
      t.real.sync(t.account)?.read_retry_states[`profile:${epoch}`],
    ).toMatchObject({ paused: true, backing_off_since: since });
    for (const c of reloaded) c.dispose();
  });

  test("a reload after a healthy run asks once more per tab, as a new page does, and never more", async () => {
    const t = await scene();
    serve(t, "healthy");
    const first = t.pages.map((page) =>
      controllerOverSession(t.f, t.real, page),
    );
    await t.f.settle();
    await run(t, 60_000);
    for (const c of first) c.dispose();
    const reloaded = t.pages.map((page) =>
      controllerOverSession(t.f, t.real, page),
    );
    await t.f.settle();
    await run(t, 600_000);
    expect(both(t)).toEqual({ me: 4, sessions: 4 });
    for (const c of reloaded) c.dispose();
  });

  test("a new epoch is new work: it is asked at once, held by nothing of the earlier sign-in, and leaves nothing of it behind", async () => {
    const t = await scene();
    serve(t, "404");
    const controllers = t.pages.map((page) =>
      controllerOverSession(t.f, t.real, page),
    );
    await t.f.settle();
    await run(t, 3_600_000);
    const paused = both(t);
    const earlier = t.signed.page.session.identity.get()?.epoch as number;
    expect(
      Object.keys(t.real.sync(t.account)?.read_retry_states ?? {}),
    ).toEqual(expect.arrayContaining([`profile:${earlier}`]));
    // A re-authentication of the same account: a new epoch, in both tabs. The server now answers.
    t.f.server.rules = [];
    serve(t, "healthy");
    const outcome = await t.f.signIn(t.signed.page, "kieran", "pw");
    expect(outcome).toMatchObject({ kind: "settled" });
    await t.f.settle();
    const later = t.signed.page.session.identity.get()?.epoch as number;
    expect(later).toBeGreaterThan(earlier);
    await run(t, 600_000);
    // Asked again for the new epoch: at least once per tab that saw it, and the older sign-in's entries are gone.
    expect(both(t).me).toBeGreaterThan(paused.me);
    expect(t.signed.page.session.identity.get()?.epoch).toBe(later);
    const entries = profileEntries(t);
    expect(entries.some((key) => key.endsWith(`:${earlier}`))).toBe(false);
    for (const c of controllers) c.dispose();
  });

  test("a request the session closed (the credential was revoked) counts nothing and is not asked again", async () => {
    const t = await scene();
    // The server no longer knows the session: its first answer is a 401, which the session treats as an invalidation.
    t.f.server.revoke(t.signed.sessionId);
    const controllers = t.pages.map((page) =>
      controllerOverSession(t.f, t.real, page),
    );
    await t.f.settle();
    await run(t, 3_600_000);
    const total = both(t);
    expect(total.me).toBeLessThanOrEqual(2);
    expect(total.sessions).toBeLessThanOrEqual(2);
    // Nothing was counted against either caller, and no timer is left asking.
    expect(t.real.sync(t.account)?.read_retry_states).toEqual({});
    await run(t, 3_600_000);
    expect(both(t)).toEqual(total);
    for (const c of controllers) c.dispose();
  });
});

describe("two real tabs, no database for the account", () => {
  test("a healthy control asks once per tab, and creates nothing", async () => {
    const t = await scene({ database: false });
    serve(t, "healthy");
    const controllers = t.pages.map((page) =>
      controllerOverSession(t.f, t.real, page),
    );
    await t.f.settle();
    await run(t, 60_000);
    // The profile is asked (it needs no database); the device mirror has nothing to mirror into and asks nothing.
    expect(both(t)).toEqual({ me: 2, sessions: 0 });
    expect(t.real.hasDb(t.account)).toBe(false);
    for (const c of controllers) {
      expect(c.ui.profile.labelFor(c.page.session.identity.get())).toBe(
        "kieran",
      );
      c.dispose();
    }
  });

  test.each([["404"], ["503"]] as const)(
    "a %s is counted in each page's memory, bounded, and still creates nothing",
    async (mode) => {
      const t = await scene({ database: false });
      serve(t, mode);
      const controllers = t.pages.map((page) =>
        controllerOverSession(t.f, t.real, page),
      );
      await t.f.settle();
      await run(t, 3_600_000);
      const total = both(t);
      // Per tab: three answers for the unrecognised class, eight failures for the sustained network class.
      expect(total.me).toBe(mode === "404" ? 6 : 16);
      expect(total.sessions).toBe(0);
      await run(t, 3_600_000);
      expect(both(t)).toEqual(total);
      expect(t.real.hasDb(t.account)).toBe(false);
      for (const c of controllers) c.dispose();
    },
  );
});

// Shared by the R16 describes below: the durable entries a page that is paused left behind, and a held promise (the lazy chunk).
const UNRECOGNISED = {
  backing_off_since: null,
  paused: true,
  unrecognised_streak: 3,
};
const DURATION = {
  backing_off_since: 1,
  paused: true,
  unrecognised_streak: 0,
};

/** A held promise: the lazy runtime chunk that has not arrived yet. */
const gate = () => {
  let open: () => void = () => undefined;
  const held = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { held, open };
};

const seedPause = (
  t: Scene,
  entry: {
    backing_off_since: number | null;
    paused: boolean;
    unrecognised_streak: number;
  },
) => {
  const epoch = t.signed.page.session.identity.get()?.epoch;
  const sync = t.real.sync(t.account);
  if (sync === undefined) throw new Error("setup: no database");
  t.real.idb.seed(accountDatabaseName(t.account), "sync_state", [
    {
      ...sync,
      read_retry_states: {
        [`profile:${epoch}`]: entry,
        [`device:${epoch}`]: entry,
      },
    },
  ]);
};

describe("R16 (revision 9): the database binds late, in the production composition", () => {
  test.each([
    ["a pause by three unrecognised answers", UNRECOGNISED],
    ["a pause by duration", DURATION],
  ])(
    "%s that is already durable: not one request while the runtime loads, none after, and none across repeated remounts",
    async (_name, entry) => {
      const t = await scene();
      seedPause(t, entry);
      serve(t, "404");
      const hold = gate();
      const first = t.pages.map((page) =>
        controllerOverSession(t.f, t.real, page, { hold: hold.held }),
      );
      await t.f.settle();
      await run(t, 600_000);
      expect(both(t)).toEqual({ me: 0, sessions: 0 });
      hold.open();
      await t.f.settle();
      await run(t, 3_600_000);
      expect(both(t)).toEqual({ me: 0, sessions: 0 });
      // Three remounts, each with the runtime held for a while before it loads: the same.
      for (const c of first) c.dispose();
      for (let i = 0; i < 3; i += 1) {
        const next = gate();
        const mounted = t.pages.map((page) =>
          controllerOverSession(t.f, t.real, page, { hold: next.held }),
        );
        await run(t, 5_000);
        next.open();
        await t.f.settle();
        await run(t, 60_000);
        for (const c of mounted) c.dispose();
      }
      expect(both(t)).toEqual({ me: 0, sessions: 0 });
    },
  );

  test("control: an existing database with no pause: nothing while the runtime loads, then each tab asks, and a 404 is bounded as before", async () => {
    const t = await scene();
    serve(t, "404");
    const hold = gate();
    const controllers = t.pages.map((page) =>
      controllerOverSession(t.f, t.real, page, { hold: hold.held }),
    );
    await t.f.settle();
    await run(t, 60_000);
    expect(both(t)).toEqual({ me: 0, sessions: 0 });
    hold.open();
    await t.f.settle();
    await run(t, 3_600_000);
    const asked = both(t);
    expect(asked.me).toBeGreaterThanOrEqual(1);
    expect(asked.sessions).toBeGreaterThanOrEqual(1);
    expect(asked.me).toBeLessThanOrEqual(8);
    expect(asked.sessions).toBeLessThanOrEqual(8);
    for (const c of controllers) c.dispose();
  });

  test("control: no database at all: the page asks `/me` once it has looked and found none, the mirror asks nothing, and nothing is created", async () => {
    const t = await scene({ database: false });
    serve(t, "healthy");
    const hold = gate();
    const controllers = t.pages.map((page) =>
      controllerOverSession(t.f, t.real, page, { hold: hold.held }),
    );
    await t.f.settle();
    await run(t, 60_000);
    expect(both(t)).toEqual({ me: 0, sessions: 0 });
    hold.open();
    await t.f.settle();
    await run(t, 60_000);
    expect(both(t).me).toBeGreaterThanOrEqual(1);
    expect(both(t).sessions).toBe(0);
    expect(t.real.hasDb(t.account)).toBe(false);
    for (const c of controllers) {
      expect(c.ui.profile.labelFor(c.page.session.identity.get())).toBe(
        "kieran",
      );
      c.dispose();
    }
  });

  // ADAPTATION (revision 10, R16), for the reviewer to accept or reject. The ORIGINAL test, kept verbatim in
  // `.agtx/evidence/WEB-09a/regression/revision-10/adapted/identity-reads-session.original-never-loads.txt`, was named "a runtime that
  // never loads (offline, the chunk uncached) is looked at and given up on: the page then asks on its memory" and asserted `GET /me`
  // three times (three unrecognised answers pause the page's memory). That is the defect the review reports: a look that FAILS was
  // taken for "there is no database", and a page that reloads starts a fresh memory budget over a database that may hold a durable
  // pause. Its two intents are kept, each as an assertion of the current requirement: (1) a failed look is BOUNDED (it is made again
  // at a paced rate and never spins); (2) the page's memory is the budget once it KNOWS that there is no database (three
  // unrecognised answers pause it): in the second test, after the chunk loads.
  test("ADAPTATION: a runtime that never loads (offline, the chunk uncached) asks nothing, and the look is made again at a paced rate, not spun", async () => {
    const t = await scene({ database: false });
    serve(t, "404");
    const c = controllerOverSession(t.f, t.real, t.pages[0], {
      faults: { load: true },
    });
    await t.f.settle();
    await run(t, 60_000);
    // 250 ms doubling to 10 s: the first attempt, six paced ones in the first 16 s, then one per 10 s.
    expect(c.looks.loads).toBeLessThanOrEqual(12);
    expect(c.looks.loads).toBeGreaterThanOrEqual(8);
    await run(t, 3_600_000);
    expect(c.looks.loads).toBeLessThanOrEqual(12 + 360 + 1);
    expect(both(t)).toEqual({ me: 0, sessions: 0 });
    c.dispose();
  });

  test("ADAPTATION: once the chunk loads and there is NO database, the page asks on its memory: three unrecognised answers pause it", async () => {
    const t = await scene({ database: false });
    serve(t, "404");
    const faults = { load: true };
    const c = controllerOverSession(t.f, t.real, t.pages[0], { faults });
    await t.f.settle();
    await run(t, 120_000);
    expect(both(t)).toEqual({ me: 0, sessions: 0 });
    faults.load = false;
    await run(t, 20_000);
    await run(t, 3_600_000);
    expect(requestsTo(t.f, ME)).toBe(3);
    expect(t.real.hasDb(t.account)).toBe(false);
    c.dispose();
  });
});

describe("R16 (revision 10): a look that FAILS is not an answer, in the production composition", () => {
  /**
   * The review's remaining R16 (the tenth revision): `attach` finished its look when the runtime failed to load or when the listing or
   * the open rejected, so with no bound database the profile read started from an EMPTY memory budget even over a database that holds a
   * durable pause; each remount repeated it (nine `/me` requests over three mounts, in the unit probe and, with `indexedDB.databases()`
   * rejecting, six over three pages in each of Chromium, Firefox and WebKit). Here the REAL 08a session (two tabs of one origin), the
   * production controller and adapters and the real account database over the double of IndexedDB; only the platform is a double and
   * every fault is a NAMED injection (`LookFaults`), not a genuine device storage failure.
   */
  const FAULTS = ["load", "list", "open"] as const;
  const BUDGETS = [
    ["a pause by three unrecognised answers", UNRECOGNISED],
    ["a pause by duration", DURATION],
  ] as const;

  test.each(
    FAULTS.flatMap((fault) =>
      BUDGETS.map(([name, entry]) => [fault, name, entry] as const),
    ),
  )(
    "the look fails (%s), %s is durable: not one request, however long it lasts and however often the page is mounted",
    async (fault, _name, entry) => {
      const t = await scene();
      seedPause(t, entry);
      serve(t, "404");
      const faults = { [fault]: true };
      const looks: number[] = [];
      for (let mount = 0; mount < 3; mount += 1) {
        const mounted = t.pages.map((page) =>
          controllerOverSession(t.f, t.real, page, { faults }),
        );
        await t.f.settle();
        await run(t, 600_000);
        for (const c of mounted) {
          // The failure is visible to the screens (the queue, the conflicts and the summary say they could not be read), and the
          // account's name is not shown (nothing was verified).
          expect(c.ui.summary.get()).toMatchObject({ status: "unavailable" });
          expect(
            c.ui.profile.labelFor(c.page.session.identity.get()),
          ).toBeNull();
          looks.push(c.looks.loads);
          c.dispose();
        }
      }
      expect(both(t)).toEqual({ me: 0, sessions: 0 });
      // The look is the only thing a failure schedules, and it is paced: far fewer than a per-notification look.
      for (const n of looks) expect(n).toBeLessThanOrEqual(80);
      // The durable entries are untouched.
      expect(profileEntries(t)).toHaveLength(2);
    },
  );

  test.each(
    FAULTS.flatMap((fault) =>
      BUDGETS.map(([name, entry]) => [fault, name, entry] as const),
    ),
  )(
    "the look fails (%s) and then RECOVERS, %s is durable: the budget is read, and still not one request",
    async (fault, _name, entry) => {
      const t = await scene();
      seedPause(t, entry);
      serve(t, "404");
      const faults: Record<string, boolean> = { [fault]: true };
      const controllers = t.pages.map((page) =>
        controllerOverSession(t.f, t.real, page, { faults }),
      );
      await t.f.settle();
      await run(t, 45_000);
      expect(both(t)).toEqual({ me: 0, sessions: 0 });
      faults[fault] = false;
      await run(t, 15_000);
      await run(t, 3_600_000);
      expect(both(t)).toEqual({ me: 0, sessions: 0 });
      // The database is bound now, and the look is over: it is not made again.
      for (const c of controllers) {
        expect(c.ui.service()).not.toBeNull();
        const settled = c.looks.loads;
        await run(t, 600_000);
        expect(c.looks.loads).toBe(settled);
        c.dispose();
      }
    },
  );

  test.each(FAULTS)(
    "control: the look fails (%s) and recovers, no pause is durable: nothing is asked while it fails, then each tab asks, boundedly",
    async (fault) => {
      const t = await scene();
      serve(t, "404");
      const faults: Record<string, boolean> = { [fault]: true };
      const controllers = t.pages.map((page) =>
        controllerOverSession(t.f, t.real, page, { faults }),
      );
      await t.f.settle();
      await run(t, 45_000);
      expect(both(t)).toEqual({ me: 0, sessions: 0 });
      faults[fault] = false;
      await run(t, 15_000);
      await run(t, 3_600_000);
      const asked = both(t);
      expect(asked.me).toBeGreaterThanOrEqual(1);
      expect(asked.sessions).toBeGreaterThanOrEqual(1);
      expect(asked.me).toBeLessThanOrEqual(8);
      expect(asked.sessions).toBeLessThanOrEqual(8);
      for (const c of controllers) c.dispose();
    },
  );

  test("a durable BACK-OFF (not yet a pause) is waited out from its own clock after the look recovers: the page does not start a fresh budget", async () => {
    const t = await scene();
    const epoch = t.signed.page.session.identity.get()?.epoch;
    const sync = t.real.sync(t.account);
    if (sync === undefined) throw new Error("setup: no database");
    // An outage that began 170 s ago (the sustained window is 180 s): the earlier page's clock, in the shared database.
    t.real.idb.seed(accountDatabaseName(t.account), "sync_state", [
      {
        ...sync,
        read_retry_states: {
          [`profile:${epoch}`]: {
            backing_off_since: EPOCH_BASE + t.f.world.time - 170_000,
            paused: false,
            unrecognised_streak: 0,
          },
        },
      },
    ]);
    serve(t, "503");
    const faults = { list: true };
    const c = controllerOverSession(t.f, t.real, t.pages[0], { faults });
    await t.f.settle();
    await run(t, 30_000);
    expect(both(t).me).toBe(0);
    faults.list = false;
    await run(t, 3_600_000);
    // The sustained-failure clock was the database's (it began before this page): the page asks once or twice and pauses. A fresh
    // budget would have run the whole 180 s (eight requests).
    expect(both(t).me).toBeGreaterThanOrEqual(1);
    expect(both(t).me).toBeLessThanOrEqual(3);
    expect(
      t.real.sync(t.account)?.read_retry_states[`profile:${epoch}`],
    ).toMatchObject({ paused: true });
    c.dispose();
  });

  test("genuine ABSENCE after a failed look: the listing recovers and finds no database, and the page asks on its memory, three answers at most, creating nothing", async () => {
    const t = await scene({ database: false });
    serve(t, "404");
    const faults = { list: true };
    const c = controllerOverSession(t.f, t.real, t.pages[0], { faults });
    await t.f.settle();
    await run(t, 120_000);
    expect(both(t)).toEqual({ me: 0, sessions: 0 });
    faults.list = false;
    await run(t, 20_000);
    await run(t, 3_600_000);
    expect(both(t).me).toBe(3);
    expect(both(t).sessions).toBe(0);
    expect(t.real.hasDb(t.account)).toBe(false);
    c.dispose();
  });

  test("`online` makes the look again at once (the chunk could not load offline): a durable pause is still honoured, a healthy database is read", async () => {
    for (const paused of [true, false]) {
      const t = await scene();
      if (paused) seedPause(t, UNRECOGNISED);
      serve(t, "404");
      const faults = { load: true };
      const c = controllerOverSession(t.f, t.real, t.pages[0], { faults });
      c.setOnline(false);
      await t.f.settle();
      await run(t, 5_000);
      expect(both(t)).toEqual({ me: 0, sessions: 0 });
      const before = c.looks.loads;
      faults.load = false;
      c.setOnline(true);
      await t.f.settle();
      // At once: not after the next paced attempt.
      expect(c.looks.loads, `paused=${paused}`).toBeGreaterThan(before);
      expect(c.ui.service(), `paused=${paused}`).not.toBeNull();
      await run(t, 3_600_000);
      if (paused) expect(both(t)).toEqual({ me: 0, sessions: 0 });
      else expect(both(t).me).toBeGreaterThanOrEqual(1);
      c.dispose();
    }
  });

  test("the person's own `Try again` (retryLoad) looks at once", async () => {
    const t = await scene();
    seedPause(t, UNRECOGNISED);
    const faults = { open: true };
    const c = controllerOverSession(t.f, t.real, t.pages[0], { faults });
    await t.f.settle();
    await run(t, 30_000);
    faults.open = false;
    const before = c.looks.opens;
    c.ui.actions.retryLoad();
    await t.f.settle();
    expect(c.looks.opens).toBeGreaterThan(before);
    expect(c.ui.service()).not.toBeNull();
    expect(both(t)).toEqual({ me: 0, sessions: 0 });
    c.dispose();
  });

  test("a failed look does not leave a timer behind: a controller that is disposed looks no more", async () => {
    const t = await scene();
    seedPause(t, UNRECOGNISED);
    const faults = { list: true };
    const c = controllerOverSession(t.f, t.real, t.pages[0], { faults });
    await t.f.settle();
    await run(t, 30_000);
    c.dispose();
    const stopped = c.looks.lists;
    await run(t, 3_600_000);
    expect(c.looks.lists).toBe(stopped);
  });
});

describe("R16 (revision 11): what a look found belongs to one binding, in the production composition", () => {
  /**
   * The review's remaining R16 (the tenth revision): the answer of a finished look survived the binding it described, so a read that
   * woke after the service had ended (a back-off timer, `online`) took "the page has looked" for "the database is known" and asked on
   * its memory without reading the durable count. Here the REAL 08a session (two tabs of one origin), the production controller and
   * adapters and the real account database over the double of IndexedDB; the service is ended by the page (`dispose("closed")`, as a
   * wipe's latch or an upgrade by another tab would end it) and the reopening is a NAMED injection (`LookFaults.open`).
   */
  test("a read that is backing off when its service ends: its timer fires into a page that cannot read what it counted, and asks nothing until a look lands", async () => {
    const t = await scene();
    serve(t, "503");
    const faults = { open: false };
    const c = controllerOverSession(t.f, t.real, t.pages[0], { faults });
    await t.f.settle();
    await run(t, 1_000);
    const asked = both(t);
    expect(asked.me).toBeGreaterThanOrEqual(1);
    expect(asked.sessions).toBeGreaterThanOrEqual(0);
    // The service ends, and the reopening fails: the back-off timers (2 s, 4 s, 8 s ...) fall due into a page that does not know.
    faults.open = true;
    c.ui.service()?.dispose("closed");
    await run(t, 170_000);
    expect(c.ui.service()).toBeNull();
    expect(both(t)).toEqual(asked);
    // The look lands: the durable count is read and the bounded schedule goes on from where it was (it is not a fresh budget).
    faults.open = false;
    await run(t, 60_000);
    expect(c.ui.service()).not.toBeNull();
    await run(t, 3_600_000);
    const after = both(t);
    expect(after.me).toBeGreaterThan(asked.me);
    // Bounded: a sustained failure pauses the caller after `retrySustainedMs`, whatever the page does meanwhile.
    expect(after.me).toBeLessThanOrEqual(asked.me + 12);
    c.dispose();
  });

  test("the same page with a durable pause: ended service, failing reopening, then a recovery: still not one request", async () => {
    const t = await scene();
    seedPause(t, UNRECOGNISED);
    serve(t, "404");
    const faults = { open: false };
    const c = controllerOverSession(t.f, t.real, t.pages[0], { faults });
    await t.f.settle();
    await run(t, 5_000);
    expect(c.ui.service()).not.toBeNull();
    faults.open = true;
    c.ui.service()?.dispose("closed");
    await run(t, 600_000);
    faults.open = false;
    await run(t, 120_000);
    await run(t, 3_600_000);
    expect(both(t)).toEqual({ me: 0, sessions: 0 });
    c.dispose();
  });
});
