import { afterEach, describe, expect, test } from "vitest";
import type { CacheLifetime, CacheService } from "../../../src/data";
import {
  pageCacheLifetime,
  publishCacheLifetime,
} from "../../../src/data/ui/cache-lifetime";
import {
  discardImport,
  forgetImportSessions,
  hideImport,
  type ImportEntry,
  type ImportOwnerContext,
  importOwned,
  importStatus,
  openImport,
  resumeChooser,
  showImport,
} from "../../../src/features/calendars/import-kept";
import type { RouteChanges } from "../../../src/lib/route-changes";

/**
 * WEB-13b revision 6 (review 6 R7; design assessment C1/C2, invariants 1-3, 7-8, schedules I11-I13): the owner of the import dialog's
 * editing session, over a route record and an identity the test moves itself.
 */
function routesAt(start: string) {
  let path = start;
  const listeners = new Set<(pathname: string) => void>();
  const routes: RouteChanges = {
    pathname: () => path,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  return {
    routes,
    go(to: string) {
      if (to === path) return;
      path = to;
      for (const listener of [...listeners]) listener(to);
    },
    listeners: () => listeners.size,
  };
}

function store<T>(initial: T) {
  let value = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    set(next: T) {
      value = next;
      for (const listener of [...listeners]) listener();
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    listeners: () => listeners.size,
  };
}

/**
 * What a controller bound to database `i1` of account `a` publishes (revision 7). Revision 8 (R7b): the lifetime names the cache's
 * invalidation witness (`invalidations`) where revision 7 named its `recovery_generation` (`generation`). W18 moves both by one, so the
 * revision-7 cases below keep their values and their meaning with the field renamed; the two whose meaning differs (the first fill, L4, and
 * a reopening before the facts are read, C3) are adapted and labelled.
 */
const life = (over: Partial<CacheLifetime> = {}): CacheLifetime => ({
  account: "a",
  incarnationId: "i1",
  invalidations: 4,
  invalidated: false,
  valid: true,
  ...over,
});
/** The facts not established yet (a new controller's first read, an unreadable marker). */
const UNREAD = life({ invalidations: null, valid: false });
const INVALID = (invalidations: number) =>
  life({ invalidations, invalidated: true, valid: false });

const A = { account_id: "a", epoch: 1 };
const B = { account_id: "b", epoch: 1 };

function world(start = "/settings/calendars") {
  const route = routesAt(start);
  forgetImportSessions(route.routes);
  const identities = store<{ account_id: string; epoch: number } | null>(A);
  const cache = store<CacheLifetime | null>(life());
  const context = (
    over: Partial<ImportOwnerContext> = {},
  ): ImportOwnerContext => ({
    identity: "a:1",
    identities,
    incarnation: "i1",
    cache,
    today: "2026-10-27",
    ...over,
  });
  return { route, identities, cache, context };
}

const ROW = { kind: "row", sourceId: "s1" } as const;
const OTHER_ROW = { kind: "row", sourceId: "s2" } as const;
const CHOOSER = { kind: "chooser" } as const;

afterEach(() => forgetImportSessions());

describe("the import's visit (I13)", () => {
  test("kept through the sync screens and back; the same row shows the SAME session", () => {
    const w = world();
    const first = openImport(ROW, w.context());
    first.editWindow({ from: "2026-01-01" });
    hideImport(first);
    w.route.go("/sync");
    w.route.go("/settings/calendars");
    const again = openImport(ROW, w.context());
    expect(again).toBe(first);
    expect(again.state().window.from).toBe("2026-01-01");
  });

  test("an ordinary departure (from the screen, or from the sync screens) ends it, mounted or not", () => {
    for (const away of [["/settings"], ["/sync", "/tasks"]]) {
      const w = world();
      const first = openImport(ROW, w.context());
      hideImport(first);
      for (const to of away) w.route.go(to);
      expect(first.ended()).toBe(true);
      w.route.go("/settings/calendars");
      expect(openImport(ROW, w.context())).not.toBe(first);
    }
  });

  test("rapid away and back in one turn still ends it (the document's every change is heard)", () => {
    const w = world();
    const first = openImport(ROW, w.context());
    w.route.go("/settings");
    w.route.go("/settings/calendars");
    expect(first.ended()).toBe(true);
  });

  test("a session ended by its visit holds no subscription", () => {
    const w = world();
    const first = openImport(ROW, w.context());
    expect(w.route.listeners()).toBe(1);
    w.route.go("/settings");
    expect(first.ended()).toBe(true);
    expect(w.route.listeners()).toBe(0);
    expect(w.identities.listeners()).toBe(0);
    expect(w.cache.listeners()).toBe(0);
  });

  test("a session opened outside the Calendars screen is kept only while shown", () => {
    const w = world("/elsewhere");
    const first = openImport(ROW, w.context());
    hideImport(first);
    expect(first.ended()).toBe(true);
  });
});

describe("entries and discards (C2, I4, I11)", () => {
  test("a different row is a deliberate new edit: the kept session ends", () => {
    const w = world();
    const first = openImport(ROW, w.context());
    hideImport(first);
    const other = openImport(OTHER_ROW, w.context());
    expect(other).not.toBe(first);
    expect(first.ended()).toBe(true);
  });

  test("Browse resumes only the chooser's kept session; a row's kept session is not a chooser", () => {
    const w = world();
    const row = openImport(ROW, w.context());
    hideImport(row);
    expect(resumeChooser(w.context())).toBeNull();
    expect(row.ended()).toBe(false);
    const chooser = openImport(CHOOSER, w.context());
    expect(row.ended()).toBe(true);
    hideImport(chooser);
    expect(resumeChooser(w.context())).toBe(chooser);
  });

  test("discard ends that session only; a stale discard of an old session never ends the new one", () => {
    const w = world();
    const first = openImport(ROW, w.context());
    discardImport(first);
    expect(first.ended()).toBe(true);
    const second = openImport(ROW, w.context());
    expect(second).not.toBe(first);
    discardImport(first);
    hideImport(first);
    expect(second.ended()).toBe(false);
    expect(openImport(ROW, w.context())).toBe(second);
  });

  test("a consumed session leaves (the next open is new)", async () => {
    const w = world();
    const first = openImport(ROW, w.context());
    first.submit(
      { source: "s1", from: "x", through: "y", file: 1 },
      async () => ({ kind: "queued" }),
    );
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
    expect(first.ended()).toBe(true);
    expect(openImport(ROW, w.context())).not.toBe(first);
  });
});

describe("identity, database and cache (I12)", () => {
  test("A→B→A while hidden: the session ends at B and A gets a NEW session", () => {
    const w = world();
    const first = openImport(ROW, w.context());
    first.editWindow({ from: "2026-01-01" });
    hideImport(first);
    w.identities.set(B);
    expect(first.ended()).toBe(true);
    w.identities.set(A);
    const again = openImport(ROW, w.context());
    expect(again).not.toBe(first);
    expect(again.state().window.from).not.toBe("2026-01-01");
  });

  test("signed out while hidden ends it; the same identity told again keeps it (control)", () => {
    const w = world();
    const first = openImport(ROW, w.context());
    hideImport(first);
    w.identities.set({ ...A });
    expect(first.ended()).toBe(false);
    w.identities.set(null);
    expect(first.ended()).toBe(true);
  });

  test("another database for the same identity: not shown again, not saved", () => {
    const w = world();
    const first = openImport(ROW, w.context());
    expect(importOwned(first, w.context())).toBe(true);
    expect(importOwned(first, w.context({ incarnation: "i2" }))).toBe(false);
    hideImport(first);
    const again = openImport(ROW, w.context({ incarnation: "i2" }));
    expect(again).not.toBe(first);
    expect(first.ended()).toBe(true);
  });

  test("no database yet is not another database (nothing can be saved without one)", () => {
    const w = world();
    const first = openImport(ROW, w.context({ incarnation: null }));
    hideImport(first);
    expect(openImport(ROW, w.context())).toBe(first);
    expect(importOwned(first, w.context({ incarnation: "i2" }))).toBe(false);
  });

  // Revision 7: the gate's states became the page's cache lifetime (`invalidated`, `generation`); "hidden to be brought up to date" is an
  // invalidation (a cache only unverified is a remount's first read and proves nothing, below). Same intent, same ordering of steps.
  test("the cache hidden to be brought up to date ends a kept session; a shown one is the dialog's (E9) (adapted, revision 7)", () => {
    const w = world();
    const first = openImport(ROW, w.context());
    w.cache.set(INVALID(5));
    expect(first.ended()).toBe(false);
    w.cache.set(life({ invalidations: 5 }));
    hideImport(first);
    // Revision 8 (strengthened): shown through the refresh, it followed it, so the hide keeps it; only the next invalidation ends it.
    expect(first.ended()).toBe(false);
    w.cache.set(INVALID(6));
    expect(first.ended()).toBe(true);
  });

  test("shown again (a remount of the same dialog) is not hidden (adapted, revision 7)", () => {
    const w = world();
    const first = openImport(ROW, w.context());
    hideImport(first);
    showImport(first);
    w.cache.set(INVALID(5));
    expect(first.ended()).toBe(false);
  });
});

/**
 * WEB-13b revision 7 (review 7 R7; design assessment C1-C3, L3-L5): the kept session observes the PAGE's cache lifetime, which every mounted
 * controller publishes in turn (`DataEnvProvider`), and compares the cache's durable generation with the one it was last shown against, so
 * an invalidation and its recovery that happened while no controller (or another one) was observing still end it. Over the real registry
 * (`pageCacheLifetime`), with each controller a store the test moves itself.
 */
describe("R7 (revision 7): the page's cache lifetime, across controllers (L3-L5)", () => {
  const withdrawals: Array<() => void> = [];
  afterEach(() => {
    for (const withdraw of withdrawals.splice(0)) withdraw();
  });
  /** A mounted controller: it publishes `initial` until withdrawn. */
  function controller(initial: CacheLifetime | null) {
    const cell = store<CacheLifetime | null>(initial);
    const withdraw = publishCacheLifetime(cell);
    withdrawals.push(withdraw);
    return { ...cell, withdraw };
  }
  function pageWorld() {
    const w = world();
    const context = (over: Partial<ImportOwnerContext> = {}) =>
      w.context({ cache: pageCacheLifetime, ...over });
    return { ...w, context };
  }
  /** Opened on the first controller, edited, hidden by the sync control (the visit goes on at `/sync`). */
  function kept(w: ReturnType<typeof pageWorld>, entry: ImportEntry = ROW) {
    const first = openImport(entry, w.context());
    first.editWindow({ from: "2026-01-01", through: "2026-12-31" });
    hideImport(first);
    w.route.go("/sync");
    return first;
  }
  const back = (w: ReturnType<typeof pageWorld>) =>
    w.route.go("/settings/calendars");

  test("L3 control: a remount (the controller withdrawn, another published whose first read is pending, then the same generation) keeps it", () => {
    const w = pageWorld();
    const old = controller(life());
    const first = kept(w);
    old.withdraw();
    const next = controller(null);
    next.set(UNREAD);
    next.set(life());
    expect(first.ended()).toBe(false);
    back(w);
    expect(openImport(ROW, w.context())).toBe(first);
    expect(first.state().window).toEqual({
      from: "2026-01-01",
      through: "2026-12-31",
    });
  });

  test("L3: invalidated and recovered while NO controller was published: the next one's valid cache of another generation ends it", () => {
    const w = pageWorld();
    const old = controller(life());
    const first = kept(w);
    old.withdraw();
    // W18 (generation 5) and W23 (valid, generation kept) were committed meanwhile; the new controller only ever reads the result.
    controller(life({ invalidations: 5 }));
    expect(first.ended()).toBe(true);
    back(w);
    const again = openImport(ROW, w.context());
    expect(again).not.toBe(first);
    expect(again.state().window.from).not.toBe("2026-01-01");
  });

  test("L3: the replacement controller publishes only the final valid state (the invalid interval never read): ends it", () => {
    const w = pageWorld();
    const old = controller(life());
    const first = kept(w);
    old.withdraw();
    const next = controller(UNREAD);
    next.set(life());
    expect(first.ended()).toBe(false);
    next.set(life({ invalidations: 5 }));
    expect(first.ended()).toBe(true);
  });

  test("L3: an invalidation seen while hidden ends it once; the cache valid again never resurrects it", () => {
    const w = pageWorld();
    const ctl = controller(life());
    const first = kept(w);
    ctl.set(INVALID(5));
    expect(first.ended()).toBe(true);
    ctl.set(life({ invalidations: 5 }));
    back(w);
    expect(openImport(ROW, w.context())).not.toBe(first);
  });

  test("L3: the OLD controller's late publications after it was withdrawn are not the page's (its disposal says nothing)", () => {
    const w = pageWorld();
    const old = controller(life());
    const first = kept(w);
    old.withdraw();
    const next = controller(life());
    old.set(null);
    old.set(INVALID(5));
    expect(first.ended()).toBe(false);
    expect(pageCacheLifetime.get()).toBe(next.get());
  });

  test("L5: an admitted invalidation not yet written (known invalid, the generation unchanged) ends a hidden session", () => {
    const w = pageWorld();
    const ctl = controller(life());
    const first = kept(w);
    ctl.set(INVALID(4));
    expect(first.ended()).toBe(true);
  });

  test("L5 control: facts that cannot be read (unverified, no generation) end nothing; read again unchanged, the session is the same", () => {
    const w = pageWorld();
    const ctl = controller(life());
    const first = kept(w);
    ctl.set(UNREAD);
    ctl.set(life());
    back(w);
    expect(openImport(ROW, w.context())).toBe(first);
  });

  test("C3: shown through an invalidation (a pending source's dialog stays open), hidden while it stands: ends at the hide", () => {
    const w = pageWorld();
    const ctl = controller(life());
    const first = openImport(ROW, w.context());
    ctl.set(INVALID(5));
    expect(first.ended()).toBe(false);
    hideImport(first);
    expect(first.ended()).toBe(true);
  });

  test("C3 control: shown through the invalidation AND the recovery, it follows the cache it is shown against; hidden afterwards it is kept", () => {
    const w = pageWorld();
    const ctl = controller(life());
    const first = openImport(ROW, w.context());
    ctl.set(INVALID(5));
    ctl.set(life({ invalidations: 5 }));
    const kept_ = first;
    hideImport(kept_);
    w.route.go("/sync");
    back(w);
    expect(openImport(ROW, w.context())).toBe(first);
  });

  // ADAPTED (revision 8, review 8 R7b). Revision 7's oracle: opened against an empty cache, the session ADOPTED the first valid generation
  // (W20 restarts move `recovery_generation` during a first fill), so generation 0 -> 1 -> 2 (valid) kept it and 3 ended it. That adoption is
  // the defect R7b reproduced: a fill, an invalidation and a refill while hidden also end at a valid cache. The same intent (a first fill
  // keeps it; a later invalidation ends it) is now told by the invalidation witness, which a first fill does not move.
  test("L4 control: opened before the cache was ever valid, the first fill (no invalidation: the witness stays) keeps it; an invalidation after it ends it (adapted, revision 8)", () => {
    const w = pageWorld();
    const ctl = controller(life({ invalidations: 0, valid: false }));
    const first = kept(w);
    ctl.set(life({ invalidations: 0, valid: false }));
    ctl.set(life({ invalidations: 0 }));
    expect(first.ended()).toBe(false);
    ctl.set(life({ invalidations: 1 }));
    expect(first.ended()).toBe(true);
  });

  // ADAPTED (revision 8, review 8 R7a; design assessment C6). Revision 7's oracle expected Import events, while the new controller's facts
  // were unread, to END the kept session and open an empty one: the loss review 8 reproduced. Its intent (the kept input is not used before
  // its cache can be compared) is kept as the session WAITING: the same session, its input intact, nothing saved; the comparison then
  // resumes it, or ends it when the witness moved (next test).
  // ADAPTED AGAIN (revision 9, review 9 R7c; design assessment C6, invariant 2). Revision 8's last step expected the controller's
  // publication that agrees (`next.set(life())`) to make it ready: the shortcut review 9 reproduced (a publication says nothing of when it
  // was read). With no service in hand here, nothing can verify it: it keeps WAITING, with its input. The ready path is a read made for
  // the showing (`R7c` below).
  test("C3: not ready before its witness can be compared: Import events while the new controller's facts are unread shows the SAME session, waiting; a publication that agrees does not make it ready (adapted, revision 9)", () => {
    const w = pageWorld();
    const old = controller(life());
    const first = kept(w);
    old.withdraw();
    const next = controller(UNREAD);
    back(w);
    const again = openImport(ROW, w.context());
    expect(again).toBe(first);
    expect(first.ended()).toBe(false);
    expect(importStatus(first)).toBe("pending");
    expect(first.state().window).toEqual({
      from: "2026-01-01",
      through: "2026-12-31",
    });
    next.set(life());
    expect(importStatus(first)).toBe("pending");
    expect(first.ended()).toBe(false);
  });

  test("C3: waiting, the witness read past its basis ends it (expired), and the next Import events is a new session", () => {
    const w = pageWorld();
    const old = controller(life());
    const first = kept(w);
    old.withdraw();
    const next = controller(UNREAD);
    back(w);
    expect(openImport(ROW, w.context())).toBe(first);
    next.set(life({ invalidations: 5 }));
    expect(first.ended()).toBe(true);
    expect(importStatus(first)).toBe("expired");
    expect(openImport(ROW, w.context())).not.toBe(first);
  });

  test("C3: the chooser's Browse is judged the same way (missed history ends it; the same generation resumes it)", () => {
    for (const generation of [5, 4]) {
      const w = pageWorld();
      const old = controller(life());
      const first = kept(w, CHOOSER);
      old.withdraw();
      // Published with nobody observing it: the kept session must compare it when Browse asks.
      const quiet = store<CacheLifetime | null>(null);
      withdrawals.push(publishCacheLifetime(quiet));
      first.editWindow({ from: "2026-02-02" });
      quiet.get = () => life({ invalidations: generation });
      back(w);
      const resumed = resumeChooser(w.context());
      if (generation === 5) {
        expect(resumed).toBeNull();
        expect(first.ended()).toBe(true);
      } else expect(resumed).toBe(first);
      forgetImportSessions();
      for (const withdraw of withdrawals.splice(0)) withdraw();
    }
  });

  test("L7: another database's publication is the incarnation rule's: it ends nothing by itself, and is never saved into", () => {
    const w = pageWorld();
    const ctl = controller(life());
    const first = kept(w);
    ctl.set(life({ incarnationId: "i2", invalidations: 9 }));
    expect(first.ended()).toBe(false);
    back(w);
    expect(openImport(ROW, w.context({ incarnation: "i2" }))).not.toBe(first);
  });

  test("the registry: a late or replayed withdrawal never withdraws a successor, nor another publication of the same store", () => {
    const a = store<CacheLifetime | null>(life());
    const b = store<CacheLifetime | null>(life({ invalidations: 7 }));
    const offA = publishCacheLifetime(a);
    const offA2 = publishCacheLifetime(a);
    const offB = publishCacheLifetime(b);
    offA();
    offA();
    expect(pageCacheLifetime.get()?.invalidations).toBe(7);
    offB();
    expect(pageCacheLifetime.get()?.invalidations).toBe(4);
    offA2();
    expect(pageCacheLifetime.get()).toBeNull();
    expect(a.listeners()).toBe(0);
    expect(b.listeners()).toBe(0);
  });

  test("a kept session holds ONE subscription to the page's lifetime, gone with the session", () => {
    const w = pageWorld();
    controller(life());
    let heard = 0;
    const off = pageCacheLifetime.subscribe(() => {
      heard += 1;
    });
    const first = kept(w);
    const ctl = controller(life());
    expect(heard).toBeGreaterThan(0);
    discardImport(first);
    ctl.set(INVALID(5));
    expect(first.ended()).toBe(true);
    off();
  });
});

/**
 * WEB-13b revision 8 (review 8 R7a/R7b; design assessment C1-C3, T1, T2, T4, T9): the session's BASIS is the cache's invalidation witness
 * of its database, and it is also observed through the page runtime's service in hand when it opened (`observeCache`), which outlives the
 * protected tree; shown again, it waits for a read made then (`readCache`). The service here is a double whose reads are made at
 * their call (IndexedDB's ordering: a read sees what was committed before it was created) and delivered when the test lets them.
 */
describe("R7a/R7b (revision 8): the invalidation witness, the page runtime's service and the waiting session", () => {
  type Facts = {
    cacheStatus: "empty" | "valid" | "invalid";
    invalidating: boolean;
    invalidations: number | null;
  };
  function service(incarnationId = "i1") {
    let facts: Facts = {
      cacheStatus: "valid",
      invalidating: false,
      invalidations: 4,
    };
    const watchers = new Set<() => void>();
    const ends = new Set<() => void>();
    const reads: Array<{ value: Facts | null; deliver: () => void }> = [];
    let holding = false;
    let failing = false;
    // The live reading lands only once the test says so (a first read still under way when the observation began).
    let established = true;
    const double = {
      incarnationId,
      ended: false,
      onEnd(listener: () => void) {
        ends.add(listener);
        return () => {
          ends.delete(listener);
        };
      },
      store: {
        run: () =>
          new Promise((resolve, reject) => {
            // The value is the database's when the read is made, whenever it is delivered.
            const value = failing ? null : { ...facts };
            const deliver = () =>
              value === null
                ? reject(new Error("read failed"))
                : resolve(value);
            if (holding) reads.push({ value, deliver });
            else deliver();
          }),
        watch: () => ({
          get: () =>
            established
              ? { status: "ready", value: facts }
              : { status: "loading" },
          subscribe(listener: () => void) {
            watchers.add(listener);
            return () => {
              watchers.delete(listener);
            };
          },
        }),
      },
    };
    return {
      double: double as unknown as CacheService,
      /** A committed write: the live reading hears it (unless `quiet`). */
      commit(next: Partial<Facts>, quiet = false) {
        facts = { ...facts, ...next };
        if (!quiet) for (const listener of [...watchers]) listener();
      },
      hold(on = true) {
        holding = on;
      },
      unestablished() {
        established = false;
      },
      establish() {
        established = true;
        for (const listener of [...watchers]) listener();
      },
      fail(on = true) {
        failing = on;
      },
      reads,
      watchers: () => watchers.size,
      end() {
        double.ended = true;
        for (const listener of [...ends]) listener();
      },
    };
  }
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  const withdrawals: Array<() => void> = [];
  afterEach(() => {
    for (const withdraw of withdrawals.splice(0)) withdraw();
  });
  function controller(initial: CacheLifetime | null) {
    const cell = store<CacheLifetime | null>(initial);
    const withdraw = publishCacheLifetime(cell);
    withdrawals.push(withdraw);
    return { ...cell, withdraw };
  }
  function pageWorld(svc: ReturnType<typeof service>) {
    const w = world();
    const context = (over: Partial<ImportOwnerContext> = {}) =>
      w.context({ cache: pageCacheLifetime, service: svc.double, ...over });
    return { ...w, context };
  }
  async function kept(
    w: ReturnType<typeof pageWorld>,
    entry: ImportEntry = ROW,
  ) {
    const first = openImport(entry, w.context());
    await settle();
    first.editWindow({ from: "2026-01-01", through: "2026-12-31" });
    hideImport(first);
    w.route.go("/sync");
    return first;
  }
  const back = (w: ReturnType<typeof pageWorld>) =>
    w.route.go("/settings/calendars");

  test("R7b: opened on an EMPTY cache, a first fill while no controller is mounted keeps it (control); the witness is unchanged", async () => {
    const svc = service();
    svc.commit({ cacheStatus: "empty", invalidations: 0 });
    const w = pageWorld(svc);
    const ctl = controller(life({ invalidations: 0, valid: false }));
    const first = await kept(w);
    ctl.withdraw();
    // W20 -> W21 -> W23: the first snapshot made valid; `recovery_generation` moved, the witness did not.
    svc.commit({ cacheStatus: "valid" });
    controller(life({ invalidations: 0 }));
    back(w);
    expect(openImport(ROW, w.context())).toBe(first);
    await settle();
    expect(importStatus(first)).toBe("ready");
    expect(first.state().window.from).toBe("2026-01-01");
  });

  test("R7b: opened on an EMPTY cache, first fill -> W18 -> refill while no controller is mounted and the live reading heard nothing: the witness ends it", async () => {
    const svc = service();
    svc.commit({ cacheStatus: "empty", invalidations: 0 });
    const w = pageWorld(svc);
    const ctl = controller(life({ invalidations: 0, valid: false }));
    const first = await kept(w);
    ctl.withdraw();
    // Committed with nobody hearing it: only the witness tells.
    svc.commit({ cacheStatus: "valid" }, true);
    svc.commit({ cacheStatus: "invalid", invalidations: 1 }, true);
    svc.commit({ cacheStatus: "valid" }, true);
    expect(first.ended()).toBe(false);
    controller(life({ invalidations: 1 }));
    expect(first.ended()).toBe(true);
    back(w);
    const again = openImport(ROW, w.context());
    expect(again).not.toBe(first);
    expect(again.state().window.from).toBe("2026-10-27");
  });

  test("R7b: the page runtime's service observed while no controller is mounted: an invalid cache heard there ends a hidden session at once", async () => {
    const svc = service();
    const w = pageWorld(svc);
    const ctl = controller(life());
    const first = await kept(w);
    ctl.withdraw();
    svc.commit({ cacheStatus: "invalid", invalidations: 5 });
    expect(first.ended()).toBe(true);
    expect(importStatus(first)).toBe("expired");
  });

  test("R7b: a durable streak of an admitted invalidation heard through the service ends a hidden session (no controller mounted)", async () => {
    const svc = service();
    const w = pageWorld(svc);
    const ctl = controller(life());
    const first = await kept(w);
    ctl.withdraw();
    svc.commit({ invalidating: true });
    expect(first.ended()).toBe(true);
  });

  test("the opening read is the basis whenever it lands: hidden before any reading of the database, a later witness past it ends the session", async () => {
    const svc = service();
    svc.hold();
    svc.unestablished();
    const w = pageWorld(svc);
    // No controller has read anything yet, and the live reading has not landed either.
    const first = openImport(ROW, w.context({ cache: null }));
    first.editWindow({ from: "2026-01-01" });
    hideImport(first);
    w.route.go("/sync");
    svc.commit({ cacheStatus: "invalid", invalidations: 5 }, true);
    svc.commit({ cacheStatus: "valid" }, true);
    // The opening read was made before those commits: it says 4.
    expect(svc.reads).toHaveLength(1);
    svc.reads[0]?.deliver();
    await settle();
    expect(first.ended()).toBe(false);
    // The live reading lands now, after the commits: only the opening read's basis tells that it moved.
    svc.establish();
    expect(first.ended()).toBe(true);
  });

  test("R7a: shown again, it waits for a read made THEN: a publication that agrees but predates a commit does not let it be saved past the read", async () => {
    const svc = service();
    const w = pageWorld(svc);
    const ctl = controller(life());
    const first = await kept(w);
    ctl.withdraw();
    svc.hold();
    svc.commit({ cacheStatus: "invalid", invalidations: 5 }, true);
    svc.commit({ cacheStatus: "valid" }, true);
    back(w);
    // The new controller's publication is older than the commits (it agrees with the basis).
    controller(life());
    expect(openImport(ROW, w.context())).toBe(first);
    expect(svc.reads.length).toBeGreaterThan(0);
    for (const read of svc.reads.splice(0)) read.deliver();
    await settle();
    expect(first.ended()).toBe(true);
    expect(importStatus(first)).toBe("expired");
  });

  // ADAPTED (revision 9, review 9 R7c). Revision 8's last step expected a publication that agrees to resume it (the shortcut review 9
  // reproduced). Same steps up to it; it keeps waiting. Its intent (it resumes once something can say its basis stands) is now a showing
  // with a live service of its database, whose read verifies it.
  test("R7a: shown again while no read can be made (the service it observed has ended) and no reading agrees: WAITING, never discarded, never ready; a publication that agrees does not resume it, a read made at a later showing does (adapted, revision 9)", async () => {
    const svc = service();
    const w = pageWorld(svc);
    const ctl = controller(life());
    const first = await kept(w);
    ctl.withdraw();
    svc.end();
    const next = controller(UNREAD);
    back(w);
    expect(openImport(ROW, w.context())).toBe(first);
    await settle();
    expect(importStatus(first)).toBe("pending");
    expect(first.ended()).toBe(false);
    expect(first.state().window.through).toBe("2026-12-31");
    next.set(life());
    await settle();
    expect(importStatus(first)).toBe("pending");
    // The page's next service of the same database (the old one ended): shown again with it, its read verifies the basis.
    const replacement = service();
    hideImport(first);
    w.route.go("/sync");
    back(w);
    expect(openImport(ROW, w.context({ service: replacement.double }))).toBe(
      first,
    );
    await settle();
    expect(importStatus(first)).toBe("ready");
    expect(first.state().window.through).toBe("2026-12-31");
  });

  test("R7a: a read made at an EARLIER showing that lands late does not verify the later showing", async () => {
    const svc = service();
    const w = pageWorld(svc);
    const ctl = controller(life());
    // Opened with no service in hand (only the controller observed, whose facts become unread): only the reads made at each showing can
    // verify it.
    const first = openImport(ROW, w.context({ service: null }));
    hideImport(first);
    w.route.go("/sync");
    ctl.set(UNREAD);
    svc.hold();
    back(w);
    openImport(ROW, w.context());
    const stale = svc.reads.splice(0);
    // Revision 9 (adapted count): the showing's read, and the opening read of the observation the session now begins of that service
    // (it had none), which is never a basis (made after the hiding).
    expect(stale).toHaveLength(2);
    hideImport(first);
    w.route.go("/sync");
    back(w);
    openImport(ROW, w.context());
    expect(svc.reads).toHaveLength(1);
    for (const read of stale) read.deliver();
    await settle();
    expect(importStatus(first)).toBe("pending");
    svc.reads[0]?.deliver();
    await settle();
    expect(importStatus(first)).toBe("ready");
  });

  test("R7a: the chooser's Browse while it waits shows the SAME session (never a fresh picker)", async () => {
    const svc = service();
    const w = pageWorld(svc);
    const old = controller(life());
    const first = await kept(w, CHOOSER);
    old.withdraw();
    svc.end();
    controller(UNREAD);
    back(w);
    expect(resumeChooser(w.context())).toBe(first);
    await settle();
    expect(importStatus(first)).toBe("pending");
  });

  test("with no basis (nothing ever read of its database), a cache KNOWN invalid when it is shown again still ends it", async () => {
    const w = pageWorld(service());
    const quiet = store<CacheLifetime | null>(UNREAD);
    withdrawals.push(publishCacheLifetime(quiet));
    const first = openImport(ROW, w.context({ service: null }));
    hideImport(first);
    w.route.go("/sync");
    // Published with nobody hearing it: only the judgement made when it is shown again can see it.
    quiet.get = () => INVALID(5);
    back(w);
    expect(openImport(ROW, w.context({ service: null }))).not.toBe(first);
    expect(first.ended()).toBe(true);
  });

  test("the observation ends with the service, and never reads another incarnation's", async () => {
    const svc = service();
    const w = pageWorld(svc);
    controller(life());
    const first = await kept(w);
    expect(svc.watchers()).toBe(1);
    svc.end();
    expect(svc.watchers()).toBe(0);
    svc.commit({ cacheStatus: "invalid", invalidations: 5 });
    expect(first.ended()).toBe(false);
    forgetImportSessions();
    const other = service("i2");
    const v = pageWorld(other);
    openImport(ROW, v.context());
    expect(other.watchers()).toBe(0);
  });

  /*
   * WEB-13b revision 9 (review 9 R7c; design assessment C1, C6, invariants 2, 4, 5; schedules T1, T3, T4, T10): ONLY a read made for the
   * showing verifies a session shown again. The publication that agrees with its basis (here the controller's `life()`, witness 4, the same
   * as when it was hidden) is OLD: the commits below are quiet, so neither it nor the live reading heard them. Every assertion of the
   * waiting state is made BEFORE the showing's read is delivered.
   */
  for (const entry of [ROW, CHOOSER])
    for (const invalidated of [false, true])
      test(`R7c (${entry.kind}): an old publication that agrees does not make it ready before the showing's read lands; that read ${invalidated ? "after W18 and a refill (witness 5) ends it" : "unchanged (control) makes it ready"}`, async () => {
        const svc = service();
        const w = pageWorld(svc);
        controller(life());
        const first = await kept(w, entry);
        svc.hold();
        if (invalidated) {
          svc.commit({ cacheStatus: "invalid", invalidations: 5 }, true);
          svc.commit({ cacheStatus: "valid" }, true);
        }
        back(w);
        const again =
          entry.kind === "chooser"
            ? resumeChooser(w.context())
            : openImport(ROW, w.context());
        expect(again).toBe(first);
        await settle();
        // Held: the old agreeing publication is all there is, and it verifies nothing.
        expect(svc.reads).toHaveLength(1);
        expect(importStatus(first)).toBe("pending");
        expect(first.ended()).toBe(false);
        expect(first.state().window.from).toBe("2026-01-01");
        for (const read of svc.reads.splice(0)) read.deliver();
        await settle();
        expect(importStatus(first)).toBe(invalidated ? "expired" : "ready");
        expect(first.ended()).toBe(invalidated);
      });

  for (const tells of [true, false])
    test(`R7c: hidden again (parked) while its read is under way, that read ${tells ? "telling an invalidation still ends it" : "agreeing verifies nothing; the next showing's read does"}`, async () => {
      const svc = service();
      const w = pageWorld(svc);
      controller(life());
      const first = await kept(w);
      svc.hold();
      if (tells) svc.commit({ cacheStatus: "valid", invalidations: 5 }, true);
      back(w);
      openImport(ROW, w.context());
      const early = svc.reads.splice(0);
      expect(early).toHaveLength(1);
      hideImport(first);
      w.route.go("/sync");
      // Past the turn that hid it: parked.
      await settle();
      for (const read of early) read.deliver();
      await settle();
      if (tells) {
        expect(importStatus(first)).toBe("expired");
        return;
      }
      expect(importStatus(first)).toBe("pending");
      back(w);
      expect(openImport(ROW, w.context())).toBe(first);
      await settle();
      expect(importStatus(first)).toBe("pending");
      expect(svc.reads).toHaveLength(1);
      svc.reads[0]?.deliver();
      await settle();
      expect(importStatus(first)).toBe("ready");
    });

  test("R7c: a read that fails leaves it waiting; a later publication asks again, one read at a time, and that read verifies it", async () => {
    const svc = service();
    const w = pageWorld(svc);
    const ctl = controller(life());
    const first = await kept(w);
    svc.fail();
    back(w);
    openImport(ROW, w.context());
    await settle();
    expect(importStatus(first)).toBe("pending");
    expect(first.ended()).toBe(false);
    svc.fail(false);
    svc.hold();
    // A hint, not a proof: it asks for another read.
    ctl.set(life());
    ctl.set(life());
    expect(svc.reads).toHaveLength(1);
    expect(importStatus(first)).toBe("pending");
    svc.reads[0]?.deliver();
    await settle();
    expect(importStatus(first)).toBe("ready");
  });

  for (const variant of ["invalid", "streak", "lower"] as const)
    test(`R7c: the showing's read ends it when it says ${variant === "invalid" ? "the cache is invalid" : variant === "streak" ? "an admitted invalidation is not written yet (its durable streak)" : "a witness BELOW its basis (another history)"}, though no publication heard it`, async () => {
      const svc = service();
      const w = pageWorld(svc);
      controller(life());
      const first = await kept(w);
      svc.commit(
        variant === "invalid"
          ? { cacheStatus: "invalid" }
          : variant === "streak"
            ? { invalidating: true }
            : { invalidations: 1 },
        true,
      );
      back(w);
      openImport(ROW, w.context());
      await settle();
      expect(importStatus(first)).toBe("expired");
    });

  for (const zero of [true, false])
    test(`R7c: with no basis (hidden before any reading landed), a showing's read of ${zero ? "the witness's first value (0) verifies it" : "another value keeps it waiting (never ended) until its opening read lands as its basis; the next read then verifies it"}`, async () => {
      const svc = service();
      svc.commit({ invalidations: zero ? 0 : 3 });
      svc.hold();
      svc.unestablished();
      const w = pageWorld(svc);
      const first = openImport(ROW, w.context({ cache: null }));
      hideImport(first);
      w.route.go("/sync");
      back(w);
      expect(openImport(ROW, w.context({ cache: null }))).toBe(first);
      // The opening read and the showing's read, both held.
      const [opening, showing] = svc.reads.splice(0);
      showing?.deliver();
      await settle();
      expect(importStatus(first)).toBe(zero ? "ready" : "pending");
      if (zero) return;
      expect(first.ended()).toBe(false);
      opening?.deliver();
      await settle();
      expect(importStatus(first)).toBe("pending");
      expect(svc.reads).toHaveLength(1);
      svc.reads[0]?.deliver();
      await settle();
      expect(importStatus(first)).toBe("ready");
    });

  test("R7c (C3): with no basis and no observation at its opening, the observation begun at a later showing is no basis: another witness keeps it waiting", async () => {
    const svc = service();
    svc.commit({ invalidations: 3 });
    const w = pageWorld(svc);
    const first = openImport(ROW, w.context({ cache: null, service: null }));
    hideImport(first);
    w.route.go("/sync");
    back(w);
    expect(openImport(ROW, w.context({ cache: null }))).toBe(first);
    await settle();
    // Observed from now on (its opening read lands, 3), and read for the showing (3): neither says what it was when it was hidden.
    expect(svc.watchers()).toBe(1);
    expect(importStatus(first)).toBe("pending");
    expect(first.ended()).toBe(false);
  });

  test("R7c: what an ENDED service last read no longer stands: shown through its invalidation and the refill another controller published, hidden afterwards, it is kept", async () => {
    const svc = service();
    const w = pageWorld(svc);
    const ctl = controller(life());
    const first = openImport(ROW, w.context());
    await settle();
    // Heard through the service while shown (a pending source's dialog stays open through a refresh): known invalid, witness 5.
    svc.commit({ cacheStatus: "invalid", invalidations: 5 });
    expect(first.ended()).toBe(false);
    svc.end();
    // The refill, published by the page's controller: shown, the session follows it (its basis 5).
    ctl.set(life({ invalidations: 5 }));
    hideImport(first);
    w.route.go("/sync");
    expect(first.ended()).toBe(false);
    expect(importStatus(first)).toBe("ready");
  });

  test("R7c: the dialog remounted after it was really hidden waits for its read; Strict Mode's hide and show in one turn is no hiding (control)", async () => {
    const svc = service();
    const w = pageWorld(svc);
    controller(life());
    const first = openImport(ROW, w.context());
    await settle();
    svc.hold();
    hideImport(first);
    showImport(first);
    await settle();
    expect(importStatus(first)).toBe("ready");
    expect(svc.reads).toHaveLength(0);
    hideImport(first);
    await settle();
    showImport(first);
    expect(importStatus(first)).toBe("pending");
    expect(svc.reads).toHaveLength(1);
    svc.reads[0]?.deliver();
    await settle();
    expect(importStatus(first)).toBe("ready");
  });

  test("R7c: a read whose service ended before it landed verifies nothing", async () => {
    const svc = service();
    const w = pageWorld(svc);
    controller(life());
    const first = await kept(w);
    svc.hold();
    back(w);
    openImport(ROW, w.context());
    expect(svc.reads).toHaveLength(1);
    svc.end();
    svc.reads[0]?.deliver();
    await settle();
    expect(importStatus(first)).toBe("pending");
    expect(first.ended()).toBe(false);
  });

  test("R7c (C3): the service it observed ended: shown with the page's next service of the same database, it observes that one; another database's service is neither read nor observed", async () => {
    const svc = service();
    const w = pageWorld(svc);
    controller(life());
    const first = await kept(w);
    svc.end();
    const other = service("i2");
    back(w);
    expect(openImport(ROW, w.context({ service: other.double }))).toBe(first);
    await settle();
    expect(other.watchers()).toBe(0);
    expect(importStatus(first)).toBe("pending");
    const replacement = service();
    hideImport(first);
    w.route.go("/sync");
    back(w);
    openImport(ROW, w.context({ service: replacement.double }));
    await settle();
    expect(replacement.watchers()).toBe(1);
    expect(importStatus(first)).toBe("ready");
    hideImport(first);
    w.route.go("/sync");
    replacement.commit({ cacheStatus: "invalid", invalidations: 5 });
    expect(importStatus(first)).toBe("expired");
  });
});
