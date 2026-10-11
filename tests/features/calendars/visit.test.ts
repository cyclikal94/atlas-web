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
import { enterVisit } from "../../../src/features/calendars/visit";

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

afterEach(() => forgetIdentityMemories());

describe("one visit per identity, continued across remounts (C1, Q6, Q15)", () => {
  test("the same identity's screen mounted again gets the SAME visit; disposing it (leaving the screen) begins a new one next time", () => {
    const c = client();
    const memory = identityMemory("acct", 1);
    const first = enterVisit(memory, c.api);
    expect(enterVisit(identityMemory("acct", 1), c.api)).toBe(first);
    first.dispose();
    first.dispose();
    expect(memory.visit).toBeNull();
    const second = enterVisit(memory, c.api);
    expect(second).not.toBe(first);
  });

  test("another identity (another account, or a new epoch) disposes the visit: a read out for it then changes nothing", async () => {
    const c = client();
    const visit = enterVisit(identityMemory("acct", 1), c.api);
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
    const fresh = enterVisit(other, c.api);
    expect(fresh).not.toBe(visit);
    fresh.capability.read(always);
    expect(c.caps).toHaveLength(2);
  });
});

describe("the capability read: once per visit (D-13a-10; DA-1, Q3)", () => {
  test("answered: its value is the visit's; a remount's read asks nothing", async () => {
    const c = client();
    const visit = enterVisit(identityMemory("acct", 1), c.api);
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
      const visit = enterVisit(identityMemory("acct", 1), c.api);
      visit.capability.read(always);
      c.caps[0]?.answer(failure);
      await flush();
      for (let i = 0; i < 6; i += 1)
        enterVisit(identityMemory("acct", 1), c.api).capability.read(always);
      expect(c.caps).toHaveLength(1);
      expect(visit.capability.get()).toBeNull();
    },
  );

  test("Q3: a read never SENT (`not_sent` throughout) leaves it unread: the next mount reads it", async () => {
    const c = client();
    const visit = enterVisit(identityMemory("acct", 1), c.api);
    visit.capability.read(always);
    c.caps[0]?.answer({ ok: false, kind: "not_sent" });
    await flush();
    visit.capability.read(always);
    expect(c.caps).toHaveLength(2);
  });

  test("Q3/Q13: the caller gone before the request was admitted (`closed` after it declined): unread, read by the next mount", async () => {
    const c = client();
    const visit = enterVisit(identityMemory("acct", 1), c.api);
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
    const visit = enterVisit(identityMemory("acct", 1), c.api);
    visit.capability.read(always);
    c.caps[0]?.answer({ ok: false, kind: "closed", unsent: true });
    await flush();
    visit.capability.read(always);
    expect(c.caps).toHaveLength(2);
  });

  test("a read out across a remount is admitted for the screen mounted NOW (the newest caller's liveness is asked)", async () => {
    const c = client();
    const visit = enterVisit(identityMemory("acct", 1), c.api);
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
    const visit = enterVisit(identityMemory("acct", 1), {
      capabilities: () => Promise.reject(new Error("boom")),
      liveSources: () => new Promise(() => undefined),
    });
    visit.capability.read(always);
    await flush();
    expect(visit.capability.get()).toBeNull();
  });
});
