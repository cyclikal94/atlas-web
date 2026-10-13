// @vitest-environment node

import { describe, expect, test } from "vitest";
import {
  type CalendarApi,
  createCalendarApi,
} from "../../../src/features/calendars/api";
import type {
  CalendarResult,
  LiveSources,
} from "../../../src/features/calendars/model/result";
import { createRefreshController } from "../../../src/features/calendars/refresh-controller";
import { createRefreshOwnership } from "../../../src/features/calendars/refresh-ownership";
import { StampedRequestError } from "../../../src/session";

/**
 * The refresh controller (WEB-13a, D-13a-6) performs what the reducer decides. Its timers and its client are doubles the test drives
 * by hand: a send is answered when the test says, and a wait fires when the test advances it. What is asserted is what went on the wire
 * (each refresh call and its key), and that nothing is sent after offline, after `dispose()` (unmount or identity change) or on
 * reconnect.
 */
type Answer = CalendarResult<{ revision: number }>;

function harness() {
  const sends: Array<{
    id: string;
    key: string;
    /** What the controller asked the client to check before admitting this request (and each repeat of it). */
    live: () => boolean;
    answer(a: Answer): void;
  }> = [];
  const lives: Array<(r: CalendarResult<LiveSources>) => void> = [];
  const liveChecks: Array<() => boolean> = [];
  const timers = new Map<number, { fn: () => void; ms: number }>();
  let next = 0;
  let keys = 0;
  const api: CalendarApi = {
    identity: { account: "acct", epoch: 1 },
    refresh: (id, key, live = () => true) =>
      new Promise((resolve) => sends.push({ id, key, live, answer: resolve })),
    liveSources: (live = () => true) =>
      new Promise((resolve) => {
        lives.push(resolve);
        liveChecks.push(live);
      }),
    command: () => Promise.reject(new Error("not used")),
    capabilities: () => Promise.reject(new Error("not used")),
  };
  const controller = createRefreshController({
    api,
    mintKey: () => `key-${++keys}`,
    timers: {
      setTimeout: (fn, ms) => {
        next += 1;
        timers.set(next, { fn, ms });
        return next;
      },
      clearTimeout: (handle) => void timers.delete(handle as number),
    },
  });
  let notified = 0;
  controller.subscribe(() => {
    notified += 1;
  });
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
  return {
    controller,
    sends,
    lives,
    liveChecks,
    timers,
    notified: () => notified,
    flush,
    /** Fires every pending wait (as if its time had passed). */
    async elapse() {
      const due = [...timers.entries()];
      timers.clear();
      for (const [, timer] of due) timer.fn();
      await flush();
    },
    async answer(a: Answer) {
      const send = sends.at(-1);
      if (!send) throw new Error("nothing was sent");
      send.answer(a);
      await flush();
    },
  };
}

const busy: Answer = {
  ok: false,
  kind: "refused",
  status: 409,
  code: "refresh_in_progress",
};
const ok: Answer = { ok: true, value: { revision: 3 } };

describe("one press, one key", () => {
  test("a press sends once; refresh_in_progress waits 5 s and resends with the SAME key; success ends the run", async () => {
    const h = harness();
    h.controller.refresh("S");
    expect(h.sends.map((s) => [s.id, s.key])).toEqual([["S", "key-1"]]);
    expect(h.controller.view("S")).toEqual({ kind: "refreshing" });
    await h.answer(busy);
    expect([...h.timers.values()].map((t) => t.ms)).toEqual([5_000]);
    expect(h.sends).toHaveLength(1);
    await h.elapse();
    expect(h.sends.map((s) => s.key)).toEqual(["key-1", "key-1"]);
    await h.answer(ok);
    expect(h.controller.view("S")).toEqual({ kind: "succeeded" });
    expect(h.controller.running("S")).toBe(false);
    expect(h.notified()).toBeGreaterThan(0);
  });

  test("a second press while running is ignored; a press after the end mints a NEW key; Check again keeps the old one", async () => {
    const h = harness();
    h.controller.refresh("S");
    h.controller.refresh("S");
    expect(h.sends).toHaveLength(1);
    await h.answer(ok);
    h.controller.refresh("S");
    expect(h.sends.map((s) => s.key)).toEqual(["key-1", "key-2"]);
    // Exhaust the in-progress retries of the second press.
    for (let i = 0; i < 5; i += 1) {
      await h.answer(busy);
      await h.elapse();
    }
    expect(h.controller.view("S")).toEqual({ kind: "still_refreshing" });
    const sent = h.sends.length;
    h.controller.checkAgain("S");
    expect(h.sends.length).toBe(sent + 1);
    expect(h.sends.at(-1)?.key).toBe("key-2");
  });

  test("two sources run independently", async () => {
    const h = harness();
    h.controller.refresh("A");
    h.controller.refresh("B");
    expect(h.sends.map((s) => [s.id, s.key])).toEqual([
      ["A", "key-1"],
      ["B", "key-2"],
    ]);
  });
});

describe("stopping", () => {
  test("offline mid-wait: the wait is cleared, the view says Needs a connection, and NOTHING is sent afterwards (not on reconnect either)", async () => {
    const h = harness();
    h.controller.refresh("S");
    await h.answer(busy);
    expect(h.timers.size).toBe(1);
    h.controller.offline();
    expect(h.timers.size).toBe(0);
    expect(h.controller.view("S")).toEqual({ kind: "needs_connection" });
    await h.elapse();
    expect(h.sends).toHaveLength(1);
  });

  test("offline while a request is out: its later answer is dropped", async () => {
    const h = harness();
    h.controller.refresh("S");
    h.controller.offline();
    await h.answer(ok);
    expect(h.controller.view("S")).toEqual({ kind: "needs_connection" });
  });

  test("dispose (unmount, identity change): every wait is cleared, answers still to come are dropped, nothing more is sent", async () => {
    const h = harness();
    h.controller.refresh("S");
    await h.answer(busy);
    h.controller.dispose();
    expect(h.timers.size).toBe(0);
    await h.elapse();
    expect(h.sends).toHaveLength(1);
    h.controller.refresh("S");
    expect(h.sends).toHaveLength(1);
    expect(h.controller.view("S")).toBeNull();
  });

  test("dispose while a live read is out drops its answer", async () => {
    const h = harness();
    h.controller.refresh("S");
    await h.answer({
      ok: false,
      kind: "refused",
      status: 409,
      code: "stale_refresh",
      reason: "lease_expired",
    });
    expect(h.lives).toHaveLength(1);
    h.controller.dispose();
    h.lives[0]?.({
      ok: true,
      value: { sources: new Map(), complete: true },
    });
    await h.flush();
    expect(h.sends).toHaveLength(1);
  });
});

describe("an outcome outlives a remount of the screen under the same identity (the session's re-check of a 403)", () => {
  test("an answer that arrives AFTER dispose ends the run in the memory and performs nothing; the next controller shows it", async () => {
    // Revision 6 (R12): the identity's memory of ended runs is its refresh ownership (`refresh-ownership.ts`); same assertions.
    const remembered = createRefreshOwnership();
    const h = harness();
    const first = createRefreshController({
      api: {
        identity: { account: "acct", epoch: 1 },
        refresh: () =>
          Promise.resolve({
            ok: false,
            kind: "refused",
            status: 403,
            code: "forbidden",
          } as const),
        liveSources: () => Promise.reject(new Error("not used")),
        command: () => Promise.reject(new Error("not used")),
        capabilities: () => Promise.reject(new Error("not used")),
      },
      mintKey: () => "k1",
      ownership: remembered,
    });
    first.refresh("S");
    first.dispose();
    await h.flush();
    expect(remembered.shown("S")?.run.view).toEqual({
      kind: "failed",
      cause: "unavailable",
    });
    const second = createRefreshController({
      api: {
        identity: { account: "acct", epoch: 1 },
        // Never answers: only the new press below sends, and its answer is not needed.
        refresh: () => new Promise(() => undefined),
        liveSources: () => Promise.reject(new Error("not used")),
        command: () => Promise.reject(new Error("not used")),
        capabilities: () => Promise.reject(new Error("not used")),
      },
      mintKey: () => "k2",
      ownership: remembered,
    });
    expect(second.view("S")).toEqual({ kind: "failed", cause: "unavailable" });
    expect(second.running("S")).toBe(false);
    // A new press is a new operation: the remembered outcome is forgotten (it would be stale after a remount mid-run).
    second.refresh("S");
    expect(remembered.shown("S")).toBeNull();
  });

  test("revision 5: the NEXT controller is already built when the late answer arrives: it adopts the outcome, unless a run of its own is going", async () => {
    // Revision 6 (R12): told through the shared ownership's subscription instead of `onLate`/`adopt`; an OLDER admission's outcome is
    // refused by the ownership itself (it no longer owns the source), so it cannot replace the press of its own.
    const remembered = createRefreshOwnership();
    const h = harness();
    let answer: (r: never) => void = () => undefined;
    const api = (refresh: CalendarApi["refresh"]) => ({
      identity: { account: "acct", epoch: 1 },
      refresh,
      liveSources: () => Promise.reject(new Error("not used")),
      command: () => Promise.reject(new Error("not used")),
      capabilities: () => Promise.reject(new Error("not used")),
    });
    const first = createRefreshController({
      api: api(() => new Promise((resolve) => (answer = resolve as never))),
      mintKey: () => "k1",
      ownership: remembered,
    });
    first.refresh("S");
    first.dispose();
    // The remount finished first: the next controller is built while the answer is still out.
    const second = createRefreshController({
      api: api(() => new Promise(() => undefined)),
      mintKey: () => "k2",
      ownership: remembered,
    });
    let notified = 0;
    second.subscribe(() => {
      notified += 1;
    });
    expect(second.view("S")).toBeNull();
    answer({
      ok: false,
      kind: "refused",
      status: 403,
      code: "forbidden",
    } as never);
    await h.flush();
    expect(second.view("S")).toEqual({ kind: "failed", cause: "unavailable" });
    expect(second.running("S")).toBe(false);
    expect(notified).toBe(1);
    // A press of its own owns the row: a later outcome of an older admission does not replace it.
    const older = remembered.claim("T", "k0");
    second.refresh("T");
    const ended = remembered.shown("S")?.run;
    if (ended === undefined) throw new Error("no outcome");
    expect(remembered.publish(older, ended)).toBe(false);
    expect(second.running("T")).toBe(true);
    // A disposed controller adopts nothing.
    second.dispose();
    expect(remembered.publish(remembered.claim("S", "k3"), ended)).toBe(true);
    expect(second.view("S")).toBeNull();
  });

  test("a run that was only WAITING to retry at dispose ends with nothing remembered, and nothing resumes", async () => {
    const remembered = createRefreshOwnership();
    const sends: string[] = [];
    const timers = new Map<number, () => void>();
    let n = 0;
    const api = {
      identity: { account: "acct", epoch: 1 },
      refresh: (_id: string, key: string) => {
        sends.push(key);
        return Promise.resolve({
          ok: false,
          kind: "refused",
          status: 409,
          code: "refresh_in_progress",
        } as const);
      },
      liveSources: () => Promise.reject(new Error("not used")),
      command: () => Promise.reject(new Error("not used")),
      capabilities: () => Promise.reject(new Error("not used")),
    };
    const controller = createRefreshController({
      api,
      mintKey: () => "k",
      ownership: remembered,
      timers: {
        setTimeout: (fn) => {
          n += 1;
          timers.set(n, fn);
          return n;
        },
        clearTimeout: (handle) => void timers.delete(handle as number),
      },
    });
    controller.refresh("S");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(timers.size).toBe(1);
    controller.dispose();
    expect(timers.size).toBe(0);
    expect(remembered.outcomes()).toHaveLength(0);
    expect(sends).toEqual(["k"]);
  });

  test("the memory of one identity is dropped when another (or a new epoch) is taken", async () => {
    const { identityMemory, forgetIdentityMemories } = await import(
      "../../../src/features/calendars/memory"
    );
    forgetIdentityMemories();
    const a = identityMemory("A", 1);
    a.notices.set("S", "words");
    expect(identityMemory("A", 1).notices.get("S")).toBe("words");
    const b = identityMemory("B", 1);
    expect(b.notices.size).toBe(0);
    expect(identityMemory("A", 1).notices.size).toBe(0);
    // A re-authentication (a new epoch) is another identity too.
    identityMemory("B", 1).notices.set("S", "b");
    expect(identityMemory("B", 2).notices.size).toBe(0);
  });
});

describe("admission: nothing is started or sent for a run that is no longer current (revision 1, R3 and R4)", () => {
  test("while offline neither Refresh nor Check again starts a run; once online a NEW press does, and Check again keeps its key", async () => {
    const h = harness();
    h.controller.refresh("S");
    for (let i = 0; i < 5; i += 1) {
      await h.answer(busy);
      await h.elapse();
    }
    expect(h.controller.view("S")).toEqual({ kind: "still_refreshing" });
    expect(h.sends).toHaveLength(5);
    h.controller.offline();
    h.controller.checkAgain("S");
    h.controller.refresh("T");
    expect(h.sends).toHaveLength(5);
    expect(h.controller.running("S")).toBe(false);
    expect(h.controller.view("T")).toBeNull();
    // Control: online again, the same actions start runs (nothing resumed by itself in between).
    h.controller.online();
    await h.elapse();
    expect(h.sends).toHaveLength(5);
    h.controller.checkAgain("S");
    expect(h.sends.map((s) => s.key).at(-1)).toBe("key-1");
    h.controller.refresh("T");
    expect(h.sends.map((s) => [s.id, s.key]).slice(5)).toEqual([
      ["S", "key-1"],
      ["T", "key-2"],
    ]);
  });

  test("every send and every live read is admitted only while its run is current: dispose, offline and a new run each end it", async () => {
    const h = harness();
    h.controller.refresh("S");
    const first = h.sends[0];
    expect(first?.live()).toBe(true);
    h.controller.offline();
    expect(first?.live()).toBe(false);
    h.controller.online();
    h.controller.refresh("S");
    const second = h.sends[1];
    expect(second?.live()).toBe(true);
    await h.answer({
      ok: false,
      kind: "refused",
      status: 409,
      code: "stale_refresh",
      reason: "lease_expired",
    });
    expect(h.liveChecks[0]?.()).toBe(true);
    h.controller.dispose();
    expect(second?.live()).toBe(false);
    expect(h.liveChecks[0]?.()).toBe(false);
  });

  test("composed with the real client: a refresh still waiting to be sent (not_sent) is never sent once the controller is disposed", async () => {
    for (const dispose of [false, true]) {
      let release: () => void = () => undefined;
      let calls = 0;
      let sent = 0;
      const client = {
        POST: async () => {
          calls += 1;
          if (calls === 1) throw new StampedRequestError("not_sent");
          sent += 1;
          return {
            data: { revision: 1 },
            response: new Response(null, { status: 200 }),
          };
        },
      };
      const api = createCalendarApi(
        { api: { client: () => client } } as never,
        "acct",
        1,
        {
          sleep: () =>
            new Promise<void>((resolve) => {
              release = resolve;
            }),
        },
      );
      const controller = createRefreshController({
        api,
        mintKey: () => "operation",
      });
      controller.refresh("S");
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(calls).toBe(1);
      if (dispose) controller.dispose();
      release();
      await new Promise((resolve) => setTimeout(resolve, 0));
      // The control (still mounted) sends once; disposed, nothing is ever sent and nothing is remembered to show.
      expect(sent).toBe(dispose ? 0 : 1);
      expect(calls).toBe(dispose ? 1 : 2);
      controller.dispose();
    }
  });
});
