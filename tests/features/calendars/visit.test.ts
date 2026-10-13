// @vitest-environment node
import { afterEach, describe, expect, test } from "vitest";
import type { CalendarApi, Live } from "../../../src/features/calendars/api";
import {
  forgetIdentityMemories,
  identityMemory,
} from "../../../src/features/calendars/memory";
import type {
  CalendarResult,
  LiveSources,
} from "../../../src/features/calendars/model/result";
import {
  createVisitBoundary,
  enterVisit,
} from "../../../src/features/calendars/visit";
import type { RouteChanges } from "../../../src/lib/route-changes";

/**
 * Revision 5 (R11; design assessment C1, C3, DA-1, Q3, Q6, Q15): the Calendars screen's VISIT. What the screen reads by itself (the live
 * list and the capability) is admitted once per visit, which a remount under the same identity continues; another identity disposes
 * it. Every read is answered when the test says, so each schedule (a remount while a read is out, a read never sent) is forced.
 */
type Caps = CalendarResult<{ calendarLinks: boolean }>;

function client() {
  const caps: Array<{ live: Live; answer(r: Caps): void }> = [];
  const lists: Array<{
    live: Live;
    answer(r: CalendarResult<LiveSources>): void;
  }> = [];
  const api: Pick<CalendarApi, "liveSources" | "capabilities"> = {
    capabilities: (live = () => true) =>
      new Promise((resolve) => caps.push({ live, answer: resolve })),
    liveSources: (live = () => true) =>
      new Promise((resolve) => lists.push({ live, answer: resolve })),
  };
  return { api, caps, lists };
}
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const always = () => true;
/**
 * Revision 6 (R13): the document's path, moved by the test (`route-changes.ts` is the production record; `visit-screen` composes it with
 * the real history). Every visit here is entered at the Calendars screen and ends only at a departure from it.
 */
function route(start = "/settings/calendars") {
  let path = start;
  const listeners = new Set<(pathname: string) => void>();
  const changes: RouteChanges = {
    pathname: () => path,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return {
    changes,
    go(to: string) {
      if (to === path) return;
      path = to;
      for (const listener of [...listeners]) listener(to);
    },
  };
}
let at = createVisitBoundary(route().changes);

afterEach(() => {
  forgetIdentityMemories();
  at = createVisitBoundary(route().changes);
});

describe("one visit per identity, continued across remounts (C1, Q6, Q15)", () => {
  test("the same identity's screen mounted again gets the SAME visit; disposing it (leaving the screen) begins a new one next time", () => {
    const c = client();
    const memory = identityMemory("acct", 1);
    const first = enterVisit(memory, c.api, at);
    expect(enterVisit(identityMemory("acct", 1), c.api, at)).toBe(first);
    first.dispose();
    first.dispose();
    expect(memory.visit).toBeNull();
    const second = enterVisit(memory, c.api, at);
    expect(second).not.toBe(first);
  });

  test("another identity (another account, or a new epoch) disposes the visit: a read out for it then changes nothing", async () => {
    const c = client();
    const visit = enterVisit(identityMemory("acct", 1), c.api, at);
    visit.capability.read(always);
    const screen = visit.observer.attach();
    visit.observer.compatible(true);
    screen.watch(["S"]);
    expect(c.lists).toHaveLength(1);
    const other = identityMemory("acct", 2);
    expect(other.visit).toBeNull();
    expect(c.lists[0]?.live()).toBe(false);
    c.caps[0]?.answer({ ok: true, value: { calendarLinks: false } });
    c.lists[0]?.answer({
      ok: true,
      value: {
        sources: new Map([
          ["S", { refreshInProgress: true, health: "healthy", lastSuccess: 1 }],
        ]),
        complete: true,
      },
    });
    await flush();
    expect(visit.capability.get()).toBeNull();
    expect(visit.observer.observation("S")).toEqual({ kind: "ended" });
    // The new identity's visit is its own, and reads afresh.
    const fresh = enterVisit(other, c.api, at);
    expect(fresh).not.toBe(visit);
    fresh.capability.read(always);
    expect(c.caps).toHaveLength(2);
  });
});

describe("the capability read: once per visit (D-13a-10; DA-1, Q3)", () => {
  test("answered: its value is the visit's; a remount's read asks nothing", async () => {
    const c = client();
    const visit = enterVisit(identityMemory("acct", 1), c.api, at);
    let notified = 0;
    visit.capability.subscribe(() => {
      notified += 1;
    });
    visit.capability.read(always);
    visit.capability.read(always);
    expect(c.caps).toHaveLength(1);
    expect(visit.capability.get()).toBeNull();
    c.caps[0]?.answer({ ok: true, value: { calendarLinks: false } });
    await flush();
    expect(visit.capability.get()).toBe(false);
    expect(notified).toBe(1);
    visit.capability.read(always);
    expect(c.caps).toHaveLength(1);
  });

  test.each([
    [
      "refused 403 (the answer that remounts the tree)",
      { ok: false, kind: "refused", status: 403, code: "forbidden" },
    ],
    ["refused 503", { ok: false, kind: "refused", status: 503, code: "x" }],
    ["uncertain (a network error)", { ok: false, kind: "uncertain" }],
    ["closed by the session after it was sent", { ok: false, kind: "closed" }],
  ] as Array<[string, Caps]>)(
    "Q3: %s: unknown, and not read again within the visit, however often the screen is mounted",
    async (_, failure) => {
      const c = client();
      const visit = enterVisit(identityMemory("acct", 1), c.api, at);
      visit.capability.read(always);
      c.caps[0]?.answer(failure);
      await flush();
      for (let i = 0; i < 6; i += 1)
        enterVisit(identityMemory("acct", 1), c.api, at).capability.read(
          always,
        );
      expect(c.caps).toHaveLength(1);
      expect(visit.capability.get()).toBeNull();
    },
  );

  test("Q3: a read never SENT (`not_sent` throughout) leaves it unread: the next mount reads it", async () => {
    const c = client();
    const visit = enterVisit(identityMemory("acct", 1), c.api, at);
    visit.capability.read(always);
    c.caps[0]?.answer({ ok: false, kind: "not_sent" });
    await flush();
    visit.capability.read(always);
    expect(c.caps).toHaveLength(2);
  });

  test("Q3/Q13: the caller gone before the request was admitted (`closed` after it declined): unread, read by the next mount", async () => {
    const c = client();
    const visit = enterVisit(identityMemory("acct", 1), c.api, at);
    let mounted = true;
    visit.capability.read(() => mounted);
    mounted = false;
    // The client asks before its next admission (after a `not_sent`): the caller says no, and the answer is `closed`.
    expect(c.caps[0]?.live()).toBe(false);
    c.caps[0]?.answer({ ok: false, kind: "closed" });
    await flush();
    visit.capability.read(always);
    expect(c.caps).toHaveLength(2);
  });

  test("Q3: a read the session refused before its send boundary (`closed`, unsent) leaves it unread: the next mount reads it", async () => {
    const c = client();
    const visit = enterVisit(identityMemory("acct", 1), c.api, at);
    visit.capability.read(always);
    c.caps[0]?.answer({ ok: false, kind: "closed", unsent: true });
    await flush();
    visit.capability.read(always);
    expect(c.caps).toHaveLength(2);
  });

  test("a read out across a remount is admitted for the screen mounted NOW (the newest caller's liveness is asked)", async () => {
    const c = client();
    const visit = enterVisit(identityMemory("acct", 1), c.api, at);
    let first = true;
    visit.capability.read(() => first);
    first = false;
    visit.capability.read(always);
    expect(c.caps).toHaveLength(1);
    expect(c.caps[0]?.live()).toBe(true);
    c.caps[0]?.answer({ ok: true, value: { calendarLinks: true } });
    await flush();
    expect(visit.capability.get()).toBe(true);
  });

  test("a rejected read is unknown and not read again", async () => {
    const visit = enterVisit(
      identityMemory("acct", 1),
      {
        capabilities: () => Promise.reject(new Error("boom")),
        liveSources: () => new Promise(() => undefined),
      },
      at,
    );
    visit.capability.read(always);
    await flush();
    expect(visit.capability.get()).toBeNull();
  });
});

/**
 * Revision 6 (R13; design assessment C2, invariants 4-6, Q8-Q11): a visit ends when the DOCUMENT leaves the screen, observed by the
 * document (`route-changes.ts`), not by a mounted screen: so leaving while no screen is attached (Back during the session's protective
 * closure) ends it too, and the next entry is a new visit with one new opportunity for each automatic read. Staying on the screen (a
 * remount, the same path, a trailing slash) continues it. Here the document's path is moved by the test; `visit-screen` composes the
 * real history.
 */
describe("revision 6 (R13): a departure ends the visit as it happens, attached or not", () => {
  const busy = (id: string) => ({
    ok: true as const,
    value: {
      sources: new Map([
        [id, { refreshInProgress: true, health: "healthy", lastSuccess: 1 }],
      ]),
      complete: true,
    },
  });

  test("leaving disposes the visit at once, attached or detached; a read still out then changes nothing; the next entry reads afresh, once", async () => {
    for (const attached of [true, false]) {
      forgetIdentityMemories();
      const r = route();
      const boundary = createVisitBoundary(r.changes);
      const c = client();
      const memory = identityMemory("acct", 1);
      const visit = enterVisit(memory, c.api, boundary);
      const screen = visit.observer.attach();
      visit.observer.compatible(true);
      screen.watch(["S"]);
      visit.capability.read(always);
      expect(c.lists).toHaveLength(1);
      if (!attached) screen.detach();
      r.go("/settings");
      expect(memory.visit).toBeNull();
      expect(boundary.departures()).toBe(1);
      c.lists[0]?.answer(busy("S"));
      c.caps[0]?.answer({ ok: true, value: { calendarLinks: false } });
      await flush();
      // Disposed: what was out is dropped (ended while listed, nothing once detached; never the busy answer).
      expect(visit.observer.observation("S")).toEqual(
        attached ? { kind: "ended" } : null,
      );
      expect(visit.capability.get()).toBeNull();
      r.go("/settings/calendars");
      const next = enterVisit(memory, c.api, boundary);
      expect(next).not.toBe(visit);
      const again = next.observer.attach();
      next.observer.compatible(true);
      again.watch(["S"]);
      next.capability.read(always);
      expect(c.lists).toHaveLength(2);
      expect(c.caps).toHaveLength(2);
      // The same entry, mounted again: nothing more.
      enterVisit(memory, c.api, boundary).capability.read(always);
      expect(c.caps).toHaveLength(2);
    }
  });

  test("staying on the screen is no departure: a remount, a trailing slash, the same path again", () => {
    const r = route();
    const boundary = createVisitBoundary(r.changes);
    const c = client();
    const memory = identityMemory("acct", 1);
    const visit = enterVisit(memory, c.api, boundary);
    r.go("/settings/calendars/");
    r.go("/settings/calendars");
    expect(boundary.departures()).toBe(0);
    expect(enterVisit(memory, c.api, boundary)).toBe(visit);
  });

  test("leaving and coming back before any screen attaches again is a departure: the visit there is not continued", () => {
    const r = route();
    const boundary = createVisitBoundary(r.changes);
    const c = client();
    const memory = identityMemory("acct", 1);
    const visit = enterVisit(memory, c.api, boundary);
    visit.observer.attach().detach();
    r.go("/settings");
    r.go("/settings/calendars");
    expect(boundary.departures()).toBe(1);
    expect(enterVisit(memory, c.api, boundary)).not.toBe(visit);
  });

  test("a visit entered before a departure it did not see (entered, then the boundary moved on) is replaced at the next entry", () => {
    const r = route();
    const boundary = createVisitBoundary(r.changes);
    const c = client();
    const memory = identityMemory("acct", 1);
    const visit = enterVisit(memory, c.api, boundary);
    // A stale entry: the memory still holds it, but the document has left since (as if its disposal were lost).
    r.go("/settings");
    memory.visit = visit;
    r.go("/settings/calendars");
    const next = enterVisit(memory, c.api, boundary);
    expect(next).not.toBe(visit);
    expect(next.departures).toBe(boundary.departures());
  });

  for (const terminal of [
    "capability refused",
    "list refused",
    "list idle",
    "source yielded to a press",
    "offline",
  ] as const)
    test(`a terminal visit (${terminal}) is never revived by attaching again, and gets ONE new opportunity on a genuine re-entry`, async () => {
      const r = route();
      const boundary = createVisitBoundary(r.changes);
      const c = client();
      const memory = identityMemory("acct", 1);
      const visit = enterVisit(memory, c.api, boundary);
      const screen = visit.observer.attach();
      visit.observer.compatible(true);
      screen.watch(["S"]);
      visit.capability.read(always);
      if (terminal === "capability refused")
        c.caps[0]?.answer({
          ok: false,
          kind: "refused",
          status: 403,
          code: "forbidden",
        });
      else c.caps[0]?.answer({ ok: true, value: { calendarLinks: true } });
      if (terminal === "list refused")
        c.lists[0]?.answer({
          ok: false,
          kind: "refused",
          status: 403,
          code: "forbidden",
        });
      else if (terminal === "list idle")
        c.lists[0]?.answer({
          ok: true,
          value: {
            sources: new Map([
              [
                "S",
                { refreshInProgress: false, health: "healthy", lastSuccess: 1 },
              ],
            ]),
            complete: true,
          },
        });
      else c.lists[0]?.answer(busy("S"));
      await flush();
      if (terminal === "source yielded to a press") visit.observer.yieldTo("S");
      if (terminal === "offline") visit.observer.offline();
      screen.detach();
      const same = enterVisit(memory, c.api, boundary);
      expect(same).toBe(visit);
      same.observer.attach().watch(["S"]);
      same.capability.read(always);
      expect(c.lists).toHaveLength(1);
      expect(c.caps).toHaveLength(1);
      r.go("/settings");
      r.go("/settings/calendars");
      const next = enterVisit(memory, c.api, boundary);
      next.observer.compatible(true);
      next.observer.attach().watch(["S"]);
      next.capability.read(always);
      expect(c.lists).toHaveLength(2);
      expect(c.caps).toHaveLength(2);
      c.lists[1]?.answer(busy("S"));
      await flush();
      expect(next.observer.observation("S")?.kind).toBe("busy");
    });

  test("a late dispose of an ended visit never ends the current one (an old holder cannot dispose the next visit)", async () => {
    const r = route();
    const boundary = createVisitBoundary(r.changes);
    const c = client();
    const memory = identityMemory("acct", 1);
    const old = enterVisit(memory, c.api, boundary);
    r.go("/settings");
    r.go("/settings/calendars");
    const current = enterVisit(memory, c.api, boundary);
    old.dispose();
    expect(memory.visit).toBe(current);
    expect(enterVisit(memory, c.api, boundary)).toBe(current);
    const screen = current.observer.attach();
    current.observer.compatible(true);
    screen.watch(["S"]);
    expect(c.lists).toHaveLength(1);
  });

  test("ending a visit leaves the manual refreshes' ownership alone (a press admitted before the departure still owns its source)", () => {
    const r = route();
    const boundary = createVisitBoundary(r.changes);
    const c = client();
    const memory = identityMemory("acct", 1);
    enterVisit(memory, c.api, boundary);
    const ticket = memory.refresh.claim("S", "k");
    r.go("/settings");
    expect(memory.visit).toBeNull();
    expect(memory.refresh.owns(ticket)).toBe(true);
  });
});
