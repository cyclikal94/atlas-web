// @vitest-environment node

import { afterEach, describe, expect, test } from "vitest";
import type { CalendarApi } from "../../../src/features/calendars/api";
import {
  forgetIdentityMemories,
  identityMemory,
} from "../../../src/features/calendars/memory";
import type {
  CalendarResult,
  LiveSources,
} from "../../../src/features/calendars/model/result";
import { createRefreshController } from "../../../src/features/calendars/refresh-controller";
import {
  createRefreshOwnership,
  type RefreshOwnership,
} from "../../../src/features/calendars/refresh-ownership";

/**
 * Revision 6 (R12; design assessment C1, invariants 1-3, Q1-Q5, Q17): who may say how a manual refresh ended is decided by ADMISSION,
 * across the refresh controllers of one identity. A controller lives as long as one mounted screen (a `403` remounts the protected tree;
 * the person may leave and come back), but its answers do not. Every controller here is the production one, sharing one ownership as the
 * screens of one identity do (`memory.ts`); every answer is released when the test says, so each order is forced, and what is asserted is
 * the shared memory (`shown`), each screen's view and notifications, a third screen's hydration and the wire (each send and its key).
 */
type Answer = CalendarResult<{ revision: number }>;
type Live = CalendarResult<LiveSources>;

const S = "S";
const T = "T";
const success: Answer = { ok: true, value: { revision: 7 } };
const invalidIcs: Answer = {
  ok: false,
  kind: "refused",
  status: 422,
  code: "invalid_ics",
};
const forbidden: Answer = {
  ok: false,
  kind: "refused",
  status: 403,
  code: "forbidden",
};
const superseded = {
  ok: false,
  kind: "refused",
  status: 409,
  code: "stale_refresh",
  reason: "generation_changed",
} as Answer;
const idle = (id: string): Live => ({
  ok: true,
  value: {
    sources: new Map([
      [id, { refreshInProgress: false, health: "healthy", lastSuccess: 1_790 }],
    ]),
    complete: true,
  },
});
const failedFeed = {
  kind: "failed",
  cause: "feed_unreadable",
  code: "invalid_ics",
};

/** The wire every screen of the identity sends on: each refresh and live read waits until the test answers it. */
function wire() {
  const sends: Array<{ id: string; key: string; answer(a: Answer): void }> = [];
  const lives: Array<{ answer(r: Live): void }> = [];
  const api: CalendarApi = {
    identity: { account: "acct", epoch: 1 },
    refresh: (id, key) =>
      new Promise((resolve) => sends.push({ id, key, answer: resolve })),
    liveSources: () =>
      new Promise((resolve) => lives.push({ answer: resolve })),
    command: () => Promise.reject(new Error("not used")),
    capabilities: () => Promise.reject(new Error("not used")),
  };
  return { api, sends, lives };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/** One mounted screen's controller of the identity (its waits are held by the test and never fire by themselves). */
function screen(w: ReturnType<typeof wire>, ownership: RefreshOwnership) {
  const timers = new Map<number, () => void>();
  let next = 0;
  const controller = createRefreshController({
    api: w.api,
    mintKey: () => `key-${w.sends.length + 1}-${next++}`,
    ownership,
    timers: {
      setTimeout: (fn) => {
        next += 1;
        timers.set(next, fn);
        return next;
      },
      clearTimeout: (handle) => void timers.delete(handle as number),
    },
  });
  let notified = 0;
  controller.subscribe(() => {
    notified += 1;
  });
  return { controller, timers, notified: () => notified };
}

afterEach(() => forgetIdentityMemories());

describe("an answer after the remount, with NO newer press: still recorded and shown (Q1, the legitimate late outcome)", () => {
  for (const [label, answer, view] of [
    ["success", success, { kind: "succeeded" }],
    ["403 refusal", forbidden, { kind: "failed", cause: "unavailable" }],
  ] as const)
    test(`A's late ${label} is shown once by the screen mounted now, and remembered; nothing more is sent or read`, async () => {
      const w = wire();
      const ownership = createRefreshOwnership();
      const first = screen(w, ownership);
      first.controller.refresh(S);
      first.controller.dispose();
      const second = screen(w, ownership);
      expect(second.controller.view(S)).toBeNull();
      w.sends[0]?.answer(answer);
      await flush();
      expect(second.controller.view(S)).toEqual(view);
      expect(second.notified()).toBe(1);
      expect(ownership.shown(S)?.run.key).toBe(w.sends[0]?.key);
      expect(screen(w, ownership).controller.view(S)).toEqual(view);
      expect(w.sends).toHaveLength(1);
      expect(w.lives).toHaveLength(0);
      expect(second.timers.size + first.timers.size).toBe(0);
    });

  test("control: answered BEFORE the remount, the next screen shows it from memory", async () => {
    const w = wire();
    const ownership = createRefreshOwnership();
    const first = screen(w, ownership);
    first.controller.refresh(S);
    w.sends[0]?.answer(success);
    await flush();
    first.controller.dispose();
    expect(screen(w, ownership).controller.view(S)).toEqual({
      kind: "succeeded",
    });
  });
});

describe("a NEWER press owns the source for good (R12, Q2-Q4)", () => {
  for (const [label, older, newer, newerView] of [
    ["A succeeds after B failed", success, invalidIcs, failedFeed],
    ["A fails after B succeeded", invalidIcs, success, { kind: "succeeded" }],
  ] as const)
    test(`R12's order — ${label}: B stays in memory, on the screen and on a third screen; A announces nothing`, async () => {
      const w = wire();
      const ownership = createRefreshOwnership();
      const first = screen(w, ownership);
      first.controller.refresh(S);
      first.controller.dispose();
      const second = screen(w, ownership);
      second.controller.refresh(S);
      expect(w.sends.map((s) => s.key)).toHaveLength(2);
      expect(w.sends[1]?.key).not.toBe(w.sends[0]?.key);
      w.sends[1]?.answer(newer);
      await flush();
      expect(second.controller.view(S)).toEqual(newerView);
      const seen = second.notified();
      w.sends[0]?.answer(older);
      await flush();
      expect(second.controller.view(S)).toEqual(newerView);
      expect(second.notified()).toBe(seen);
      expect(ownership.shown(S)?.run.key).toBe(w.sends[1]?.key);
      expect(ownership.shown(S)?.run.view).toEqual(newerView);
      expect(screen(w, ownership).controller.view(S)).toEqual(newerView);
      expect(w.sends).toHaveLength(2);
    });

  test("Q3: B still running when A answers, then B's screen goes before B's answer: A never enters memory, the third screen shows and resumes nothing, and B's own late answer is then recorded", async () => {
    const w = wire();
    const ownership = createRefreshOwnership();
    const first = screen(w, ownership);
    first.controller.refresh(S);
    first.controller.dispose();
    const second = screen(w, ownership);
    second.controller.refresh(S);
    w.sends[0]?.answer(success);
    await flush();
    expect(second.controller.running(S)).toBe(true);
    expect(ownership.shown(S)).toBeNull();
    second.controller.dispose();
    const third = screen(w, ownership);
    expect(third.controller.view(S)).toBeNull();
    expect(third.controller.running(S)).toBe(false);
    expect(w.sends).toHaveLength(2);
    w.sends[1]?.answer(invalidIcs);
    await flush();
    expect(third.controller.view(S)).toEqual(failedFeed);
    expect(ownership.shown(S)?.run.key).toBe(w.sends[1]?.key);
    expect(w.sends).toHaveLength(2);
  });

  test("Q3 control: B stays mounted and finishes after A's answer: B's result is shown", async () => {
    const w = wire();
    const ownership = createRefreshOwnership();
    const first = screen(w, ownership);
    first.controller.refresh(S);
    first.controller.dispose();
    const second = screen(w, ownership);
    second.controller.refresh(S);
    w.sends[0]?.answer(success);
    await flush();
    w.sends[1]?.answer(invalidIcs);
    await flush();
    expect(second.controller.view(S)).toEqual(failedFeed);
  });

  for (const how of [
    "offline",
    "forgotten",
    "unmounted after it ended",
  ] as const)
    test(`Q4: B ended and was then ${how}: an older answer still cannot be recorded, before or after reconnecting, and nothing is sent`, async () => {
      const w = wire();
      const ownership = createRefreshOwnership();
      const first = screen(w, ownership);
      first.controller.refresh(S);
      first.controller.dispose();
      const second = screen(w, ownership);
      second.controller.refresh(S);
      if (how === "offline") second.controller.offline();
      else {
        w.sends[1]?.answer(invalidIcs);
        await flush();
        if (how === "forgotten") second.controller.forget(S);
        else second.controller.dispose();
      }
      w.sends[0]?.answer(success);
      await flush();
      second.controller.online();
      const third = screen(w, ownership);
      expect(ownership.shown(S)?.run.view ?? null).toEqual(
        how === "unmounted after it ended" ? failedFeed : null,
      );
      expect(third.controller.view(S)).toEqual(
        how === "unmounted after it ended" ? failedFeed : null,
      );
      if (how !== "unmounted after it ended")
        expect(second.controller.view(S)).toEqual(
          how === "offline" ? { kind: "needs_connection" } : null,
        );
      expect(w.sends).toHaveLength(2);
    });

  test("Q4: an older run's late LIVE READ (its successor check) cannot end it over a newer press either; control: with no newer press it does", async () => {
    for (const newer of [true, false]) {
      forgetIdentityMemories();
      const w = wire();
      const ownership = createRefreshOwnership();
      const first = screen(w, ownership);
      first.controller.refresh(S);
      w.sends[0]?.answer(superseded);
      await flush();
      expect(w.lives).toHaveLength(1);
      first.controller.dispose();
      const second = screen(w, ownership);
      if (newer) {
        second.controller.refresh(S);
        w.sends[1]?.answer(success);
        await flush();
      }
      w.lives[0]?.answer(idle(S));
      await flush();
      expect(second.controller.view(S)).toEqual(
        newer ? { kind: "succeeded" } : { kind: "failed", cause: "superseded" },
      );
      expect(w.lives).toHaveLength(1);
      expect(w.sends).toHaveLength(newer ? 2 : 1);
    }
  });

  test("other sources are independent: a newer press of T fences nothing of S", async () => {
    const w = wire();
    const ownership = createRefreshOwnership();
    const first = screen(w, ownership);
    first.controller.refresh(S);
    first.controller.dispose();
    const second = screen(w, ownership);
    second.controller.refresh(T);
    w.sends[0]?.answer(success);
    await flush();
    expect(second.controller.view(S)).toEqual({ kind: "succeeded" });
    expect(second.controller.running(T)).toBe(true);
  });
});

describe("the ticket is local, never the wire key (Q5)", () => {
  test("Check again under the SAME key is a new admission: the earlier admission of that key can no longer publish", () => {
    const ownership = createRefreshOwnership();
    const run = {
      key: "same",
      inProgress: 4,
      transient: 0,
      leaseRetried: false,
      checking: null,
      waitedMs: 0,
      seen: null,
      view: { kind: "still_refreshing" },
      ended: true,
    } as const;
    const earlier = ownership.claim(S, "same");
    const again = ownership.claim(S, "same");
    expect(again).not.toBe(earlier);
    expect(ownership.owns(earlier)).toBe(false);
    expect(ownership.publish(earlier, run)).toBe(false);
    expect(ownership.shown(S)).toBeNull();
    expect(ownership.publish(again, run)).toBe(true);
    expect(ownership.shown(S)?.ticket).toBe(again);
  });

  test("the controller claims a new ticket for Check again, with the run's key, before it sends", async () => {
    const w = wire();
    const shared = createRefreshOwnership();
    const claims: Array<{ source: string; key: string; sent: number }> = [];
    const ownership: RefreshOwnership = {
      ...shared,
      claim(source, key) {
        claims.push({ source, key, sent: w.sends.length });
        return shared.claim(source, key);
      },
    };
    const s = screen(w, ownership);
    s.controller.refresh(S);
    // Four same-key retries after refresh_in_progress, then "Check again".
    for (let i = 0; i < 5; i += 1) {
      w.sends.at(-1)?.answer({
        ok: false,
        kind: "refused",
        status: 409,
        code: "refresh_in_progress",
      });
      await flush();
      for (const fn of [...s.timers.values()]) fn();
      s.timers.clear();
      await flush();
    }
    expect(s.controller.view(S)).toEqual({ kind: "still_refreshing" });
    expect(claims).toHaveLength(1);
    s.controller.checkAgain(S);
    expect(claims).toHaveLength(2);
    expect(claims[1]?.key).toBe(claims[0]?.key);
    expect(claims[1]?.sent).toBe(5);
    expect(w.sends.at(-1)?.key).toBe(claims[0]?.key);
  });
});

describe("another identity revokes the ownership (Q17)", () => {
  test("an answer still out for the old identity records nothing, there or under the new one", async () => {
    const w = wire();
    const old = identityMemory("acct", 1);
    const first = screen(w, old.refresh);
    first.controller.refresh(S);
    first.controller.dispose();
    const next = identityMemory("acct", 2);
    w.sends[0]?.answer(success);
    await flush();
    expect(old.refresh.shown(S)).toBeNull();
    expect(next.refresh.outcomes()).toEqual([]);
    expect(screen(w, next.refresh).controller.view(S)).toBeNull();
  });
});
