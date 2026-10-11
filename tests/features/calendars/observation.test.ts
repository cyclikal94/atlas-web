// @vitest-environment node
import { describe, expect, test } from "vitest";
import type { CalendarApi } from "../../../src/features/calendars/api";
import {
  expire,
  OBSERVE_LIMIT_MS,
  OBSERVE_POLL_MS,
  type Observation,
  observe,
} from "../../../src/features/calendars/model/observation";
import type {
  CalendarResult,
  LiveSource,
  LiveSources,
} from "../../../src/features/calendars/model/result";
import { createSourceObserver } from "../../../src/features/calendars/observation-controller";
import { createRefreshController } from "../../../src/features/calendars/refresh-controller";

/**
 * The observer of refresh activity (WEB-13a, D-13a-13; revision 4, R10): what the screen shows of a refresh it did not start (one that
 * was running before a reload, another tab's, the server's own), read from the live list ONLY. Its clock and timers are doubles the test
 * advances by hand, and every read is answered when the test says, so each schedule (a read held across a press, the time limit, offline,
 * a new page) is forced, not waited for. What is asserted is every request made (only `liveSources`, never a refresh or a command, so
 * no key) and what each source's observation is.
 */
type Read = CalendarResult<LiveSources>;

const source = (
  refreshInProgress: boolean,
  over: Partial<LiveSource> = {},
): LiveSource => ({
  refreshInProgress,
  health: "healthy",
  lastSuccess: 1_790_000_000,
  ...over,
});
const list = (entries: Record<string, LiveSource>, complete = true): Read => ({
  ok: true,
  value: { sources: new Map(Object.entries(entries)), complete },
});

function harness() {
  let clock = 0;
  const timers = new Map<number, { fn: () => void; at: number }>();
  let next = 0;
  const reads: Array<{ live: () => boolean; answer(r: Read): void }> = [];
  const forbidden: string[] = [];
  const api: CalendarApi = {
    identity: { account: "acct", epoch: 1 },
    liveSources: (live = () => true) =>
      new Promise((resolve) => reads.push({ live, answer: resolve })),
    refresh: (id) => {
      forbidden.push(`refresh ${id}`);
      return Promise.reject(new Error("an observation sends nothing"));
    },
    command: () => {
      forbidden.push("command");
      return Promise.reject(new Error("an observation sends nothing"));
    },
    capabilities: () => {
      forbidden.push("capabilities");
      return Promise.reject(new Error("not used"));
    },
  };
  const fakeTimers = {
    setTimeout: (fn: () => void, ms: number) => {
      next += 1;
      timers.set(next, { fn, at: clock + ms });
      return next;
    },
    clearTimeout: (handle: unknown) => void timers.delete(handle as number),
  };
  const observer = createSourceObserver({
    api,
    timers: fakeTimers,
    now: () => clock,
  });
  // One mounted screen (revision 5: the screen attaches to the visit's observer).
  const attachment = observer.attach();
  let notified = 0;
  observer.subscribe(() => {
    notified += 1;
  });
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
  return {
    api,
    observer,
    attachment,
    reads,
    forbidden,
    timers,
    fakeTimers,
    notified: () => notified,
    now: () => clock,
    flush,
    /** Moves the clock on by `ms`, firing every timer due by then, in order (a timer set by one that fires is due from then). */
    async advance(ms: number) {
      const until = clock + ms;
      for (;;) {
        const due = [...timers.entries()]
          .filter(([, t]) => t.at <= until)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (due === undefined) break;
        timers.delete(due[0]);
        clock = due[1].at;
        due[1].fn();
        await flush();
      }
      clock = until;
      await flush();
    },
    /** Answers the newest read still out. */
    async answer(r: Read) {
      const read = reads.at(-1);
      if (!read) throw new Error("nothing was read");
      read.answer(r);
      await flush();
    },
    state: (id: string) => observer.observation(id)?.kind ?? null,
  };
}

describe("the pure model", () => {
  test("only a read that RETURNED the source is evidence; absent (complete or not) and failures are unknown", () => {
    const checking: Observation = { kind: "checking" };
    const busy: Observation = { kind: "busy" };
    expect(observe(checking, "S", list({ S: source(true) }))).toEqual(busy);
    expect(observe(checking, "S", list({ S: source(false) }))).toEqual({
      kind: "idle",
    });
    expect(observe(checking, "S", list({}, true))).toEqual({
      kind: "unknown",
      seenBusy: false,
    });
    expect(observe(busy, "S", list({}, false))).toEqual({
      kind: "unknown",
      seenBusy: true,
    });
    // A source found in an incomplete walk is evidence.
    expect(observe(busy, "S", list({ S: source(false) }, false))).toEqual({
      kind: "idle",
    });
    for (const failure of [
      { ok: false, kind: "uncertain" },
      { ok: false, kind: "not_sent" },
      { ok: false, kind: "refused", status: 429, code: "rate_limited" },
    ] as Read[])
      expect(observe(busy, "S", failure)).toEqual({
        kind: "unknown",
        seenBusy: true,
      });
    for (const stop of [
      { ok: false, kind: "offline" },
      { ok: false, kind: "closed" },
    ] as Read[])
      expect(observe(busy, "S", stop)).toEqual({ kind: "ended" });
  });

  test("final states never change; the time limit makes an open observation unknown", () => {
    const idle: Observation = { kind: "idle" };
    expect(observe(idle, "S", list({ S: source(true) }))).toBe(idle);
    expect(expire({ kind: "checking" })).toEqual({
      kind: "unknown",
      seenBusy: false,
    });
    expect(expire({ kind: "busy" })).toEqual({
      kind: "unknown",
      seenBusy: true,
    });
    expect(expire(idle)).toBe(idle);
  });

  test("the bounds are the successor wait's: a read every 5 s for at most 75 s", () => {
    expect(OBSERVE_POLL_MS).toBe(5_000);
    expect(OBSERVE_LIMIT_MS).toBe(75_000);
  });
});

describe("reading the live list (S1, S4, S5)", () => {
  test("nothing is read before the server is known compatible; then ONE walk serves every listed source", async () => {
    const h = harness();
    h.attachment.watch(["A", "B"]);
    expect(h.reads).toHaveLength(0);
    expect(h.state("A")).toBe("checking");
    h.observer.compatible(true);
    expect(h.reads).toHaveLength(1);
    await h.answer(list({ A: source(true), B: source(false) }));
    expect(h.state("A")).toBe("busy");
    expect(h.state("B")).toBe("idle");
    expect(h.forbidden).toEqual([]);
  });

  test("busy is read again after 5 s, until a read returns it idle: then nothing more is read, and nothing is sent", async () => {
    const h = harness();
    h.observer.compatible(true);
    h.attachment.watch(["S"]);
    await h.answer(list({ S: source(true) }));
    expect(h.reads).toHaveLength(1);
    await h.advance(OBSERVE_POLL_MS - 1);
    expect(h.reads).toHaveLength(1);
    await h.advance(1);
    expect(h.reads).toHaveLength(2);
    await h.answer(list({ S: source(true) }));
    await h.advance(OBSERVE_POLL_MS);
    await h.answer(list({ S: source(false) }));
    expect(h.state("S")).toBe("idle");
    await h.advance(10 * OBSERVE_LIMIT_MS);
    expect(h.reads).toHaveLength(3);
    expect(h.timers.size).toBe(0);
    expect(h.forbidden).toEqual([]);
  });

  test("S4: idle at once: one read, no polling, no timer left", async () => {
    const h = harness();
    h.observer.compatible(true);
    h.attachment.watch(["S"]);
    await h.answer(list({ S: source(false) }));
    await h.advance(10 * OBSERVE_LIMIT_MS);
    expect(h.reads).toHaveLength(1);
    expect(h.state("S")).toBe("idle");
    expect(h.timers.size).toBe(0);
  });

  test.each([
    ["absent from a complete list", list({}, true)],
    ["beyond an incomplete walk", list({ X: source(true) }, false)],
    ["a failed read", { ok: false, kind: "uncertain" } as Read],
    ["a read never sent", { ok: false, kind: "not_sent" } as Read],
  ])("S5: %s is unknown, not idle: nothing more is read", async (_, read) => {
    const h = harness();
    h.observer.compatible(true);
    h.attachment.watch(["S"]);
    await h.answer(read);
    expect(h.observer.observation("S")).toEqual({
      kind: "unknown",
      seenBusy: false,
    });
    await h.advance(10 * OBSERVE_LIMIT_MS);
    expect(h.reads).toHaveLength(1);
  });

  test("S6/S7: seen busy, then gone from the list or a failed read: unknown AFTER busy (never finished, never idle)", async () => {
    for (const later of [
      list({}, true),
      { ok: false, kind: "uncertain" } as Read,
    ]) {
      const h = harness();
      h.observer.compatible(true);
      h.attachment.watch(["S"]);
      await h.answer(list({ S: source(true) }));
      await h.advance(OBSERVE_POLL_MS);
      await h.answer(later);
      expect(h.observer.observation("S")).toEqual({
        kind: "unknown",
        seenBusy: true,
      });
    }
  });

  test("S7: busy then not, with nothing written (a lapsed lease): idle, never a success (the model has no success state)", async () => {
    const h = harness();
    h.observer.compatible(true);
    h.attachment.watch(["S"]);
    await h.answer(list({ S: source(true) }));
    await h.advance(OBSERVE_POLL_MS);
    await h.answer(list({ S: source(false) }));
    expect(h.observer.observation("S")).toEqual({ kind: "idle" });
  });

  test("a read that rejects is unknown, and nothing more is read", async () => {
    const h = harness();
    const observer = createSourceObserver({
      api: { liveSources: () => Promise.reject(new Error("boom")) },
      timers: h.fakeTimers,
      now: h.now,
    });
    observer.compatible(true);
    observer.attach().watch(["S"]);
    await h.flush();
    expect(observer.observation("S")).toEqual({
      kind: "unknown",
      seenBusy: false,
    });
  });
});

describe("the time limit (S13)", () => {
  test("busy throughout: reads stop at 75 s from the first walk and it ends unknown after busy; at most 16 walks", async () => {
    const h = harness();
    h.observer.compatible(true);
    h.attachment.watch(["S"]);
    // Every read is answered busy as soon as it is made.
    let answered = 0;
    for (let i = 0; i < 40; i += 1) {
      while (answered < h.reads.length) {
        h.reads[answered]?.answer(list({ S: source(true) }));
        answered += 1;
        await h.flush();
      }
      await h.advance(OBSERVE_POLL_MS);
    }
    expect(h.observer.observation("S")).toEqual({
      kind: "unknown",
      seenBusy: true,
    });
    expect(h.reads.length).toBeLessThanOrEqual(16);
    // The last read was ADMITTED before the limit.
    expect(h.reads.length).toBe(15);
    expect(h.timers.size).toBe(0);
    const count = h.reads.length;
    await h.advance(10 * OBSERVE_LIMIT_MS);
    expect(h.reads).toHaveLength(count);
  });

  test("a read still out at the limit is not waited for: unknown AT the limit, its pages are no longer admitted, its late answer changes nothing", async () => {
    const h = harness();
    h.observer.compatible(true);
    h.attachment.watch(["S"]);
    await h.answer(list({ S: source(true) }));
    await h.advance(OBSERVE_LIMIT_MS - 1_000);
    const held = h.reads.at(-1);
    expect(held?.live()).toBe(true);
    await h.advance(1_000);
    expect(h.observer.observation("S")).toEqual({
      kind: "unknown",
      seenBusy: true,
    });
    expect(held?.live()).toBe(false);
    held?.answer(list({ S: source(false) }));
    await h.flush();
    expect(h.observer.observation("S")).toEqual({
      kind: "unknown",
      seenBusy: true,
    });
  });

  test("a suspended timer: the answer arrives after the limit before its timer ran: unknown, not idle or busy", async () => {
    let clock = 0;
    const reads: Array<(r: Read) => void> = [];
    const observer = createSourceObserver({
      api: {
        liveSources: () => new Promise((resolve) => reads.push(resolve)),
      },
      // Timers that never fire (a suspended page).
      timers: { setTimeout: () => 1, clearTimeout: () => undefined },
      now: () => clock,
    });
    observer.compatible(true);
    observer.attach().watch(["S"]);
    clock = OBSERVE_LIMIT_MS + 1;
    reads[0]?.(list({ S: source(true) }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(observer.observation("S")).toEqual({
      kind: "unknown",
      seenBusy: false,
    });
  });

  test("S19: listing the same sources again (an ordinary re-render) neither reads again nor moves the limit", async () => {
    const h = harness();
    h.observer.compatible(true);
    h.attachment.watch(["S"]);
    await h.answer(list({ S: source(true) }));
    await h.advance(OBSERVE_LIMIT_MS - OBSERVE_POLL_MS - 1);
    const reads = h.reads.length;
    h.attachment.watch(["S"]);
    h.attachment.watch(["S"]);
    expect(h.reads).toHaveLength(reads);
    await h.answer(list({ S: source(true) }));
    await h.advance(OBSERVE_POLL_MS + 1);
    expect(h.state("S")).toBe("unknown");
  });
});

describe("a press on this screen (S9, C4)", () => {
  test("a read held across a press: its answer changes nothing for the pressed source, and nothing more is read for it", async () => {
    const h = harness();
    h.observer.compatible(true);
    h.attachment.watch(["S", "T"]);
    h.observer.yieldTo("S");
    expect(h.observer.observation("S")).toBeNull();
    await h.answer(list({ S: source(true), T: source(true) }));
    expect(h.observer.observation("S")).toBeNull();
    expect(h.state("T")).toBe("busy");
    // Listing it again does not observe it again.
    h.attachment.watch(["S", "T"]);
    expect(h.observer.observation("S")).toBeNull();
    await h.advance(OBSERVE_POLL_MS);
    expect(h.reads).toHaveLength(2);
    await h.answer(list({ S: source(true), T: source(false) }));
    expect(h.observer.observation("S")).toBeNull();
    expect(h.state("T")).toBe("idle");
  });

  test("the refresh controller yields the source when a press is ADMITTED, before its request; a refused press yields nothing", async () => {
    const h = harness();
    const order: string[] = [];
    const sends: string[] = [];
    const controller = createRefreshController({
      api: {
        ...h.api,
        refresh: (id) => {
          order.push(`send ${id}`);
          sends.push(id);
          return new Promise(() => undefined);
        },
      },
      mintKey: () => "k",
      timers: h.fakeTimers,
      onBegin: (id) => {
        order.push(`yield ${id}`);
        h.observer.yieldTo(id);
      },
    });
    h.observer.compatible(true);
    h.attachment.watch(["S", "T"]);
    controller.offline();
    controller.refresh("T");
    expect(order).toEqual([]);
    controller.online();
    controller.refresh("S");
    expect(order).toEqual(["yield S", "send S"]);
    controller.refresh("S");
    expect(sends).toEqual(["S"]);
    expect(h.observer.observation("S")).toBeNull();
    expect(h.state("T")).toBe("checking");
  });
});

describe("what the screen lists (S10)", () => {
  test("a source listed while a walk is out is read with the NEXT walk (walks never overlap), with its own limit", async () => {
    const h = harness();
    h.observer.compatible(true);
    h.attachment.watch(["A"]);
    await h.answer(list({ A: source(true) }));
    await h.advance(OBSERVE_LIMIT_MS / 2);
    h.attachment.watch(["A", "B"]);
    // A's poll read is out (or due): B joins the next one.
    expect(h.reads.filter((r) => r.live()).length).toBeLessThanOrEqual(1);
    await h.answer(list({ A: source(true) }));
    expect(h.state("B")).toBe("checking");
    // B is read at once after the walk that was out.
    expect(h.reads.filter((r) => r.live()).length).toBe(1);
    await h.answer(list({ A: source(true), B: source(true) }));
    expect(h.state("B")).toBe("busy");
    // A's limit is A's: it runs out first, B goes on.
    for (let i = 0; i < 20 && h.state("A") === "busy"; i += 1) {
      await h.advance(OBSERVE_POLL_MS);
      if (h.reads.at(-1)?.live())
        await h.answer(list({ A: source(true), B: source(true) }));
    }
    expect(h.state("A")).toBe("unknown");
    expect(h.state("B")).toBe("busy");
  });

  test("a source listed while a poll waits for its time is read AT ONCE, in one walk with the busy one; the waiting poll is not made as well", async () => {
    const h = harness();
    h.observer.compatible(true);
    h.attachment.watch(["A"]);
    await h.answer(list({ A: source(true) }));
    expect(h.timers.size).toBe(2);
    await h.advance(1_000);
    h.attachment.watch(["A", "B"]);
    expect(h.reads).toHaveLength(2);
    await h.answer(list({ A: source(true), B: source(false) }));
    expect(h.state("A")).toBe("busy");
    expect(h.state("B")).toBe("idle");
    // The next read is 5 s after this walk, not at the old poll's time.
    await h.advance(OBSERVE_POLL_MS - 1);
    expect(h.reads).toHaveLength(2);
    await h.advance(1);
    expect(h.reads).toHaveLength(3);
  });

  test("another page: the old sources are dropped (a read out for them changes nothing), the new ones are read", async () => {
    const h = harness();
    h.observer.compatible(true);
    h.attachment.watch(["A"]);
    const old = h.reads.at(-1);
    h.attachment.watch(["B"]);
    expect(h.observer.observation("A")).toBeNull();
    expect(old?.live()).toBe(false);
    expect(h.reads).toHaveLength(1);
    old?.answer(list({ A: source(true), B: source(true) }));
    await h.flush();
    expect(h.observer.observation("A")).toBeNull();
    // B was not in that walk: it is read now.
    expect(h.state("B")).toBe("checking");
    expect(h.reads).toHaveLength(2);
    await h.answer(list({ B: source(true) }));
    expect(h.state("B")).toBe("busy");
  });

  test("nothing listed: nothing read; the list emptied (the cache gate closed) drops every observation and its timers", async () => {
    const h = harness();
    h.observer.compatible(true);
    h.attachment.watch([]);
    expect(h.reads).toHaveLength(0);
    h.attachment.watch(["S"]);
    await h.answer(list({ S: source(true) }));
    h.attachment.watch([]);
    expect(h.observer.observation("S")).toBeNull();
    await h.advance(10 * OBSERVE_LIMIT_MS);
    expect(h.reads).toHaveLength(1);
    expect(h.timers.size).toBe(0);
  });
});

describe("offline, compatibility, identity and unmount (S11, S12, S17)", () => {
  test("S11: offline mid-observation stops everything for good: nothing shown, a held read changes nothing, coming back online reads nothing", async () => {
    const h = harness();
    h.observer.compatible(true);
    h.attachment.watch(["S"]);
    await h.answer(list({ S: source(true) }));
    await h.advance(OBSERVE_POLL_MS);
    const held = h.reads.at(-1);
    h.observer.offline();
    expect(h.state("S")).toBe("ended");
    expect(held?.live()).toBe(false);
    held?.answer(list({ S: source(true) }));
    await h.flush();
    expect(h.state("S")).toBe("ended");
    h.observer.compatible(true);
    h.attachment.watch(["S", "T"]);
    expect(h.state("T")).toBe("ended");
    await h.advance(10 * OBSERVE_LIMIT_MS);
    expect(h.reads).toHaveLength(2);
    expect(h.timers.size).toBe(0);
    expect(h.forbidden).toEqual([]);
  });

  test("S11: offline when the screen opens: nothing is ever read", async () => {
    const h = harness();
    h.attachment.watch(["S"]);
    h.observer.offline();
    h.observer.compatible(true);
    await h.advance(OBSERVE_LIMIT_MS);
    expect(h.reads).toHaveLength(0);
    expect(h.state("S")).toBe("ended");
  });

  test("S17: an incompatible server is never read; one that stops being compatible ends it", async () => {
    const h = harness();
    h.observer.compatible(false);
    h.attachment.watch(["S"]);
    expect(h.reads).toHaveLength(0);
    h.observer.compatible(true);
    await h.answer(list({ S: source(true) }));
    h.observer.compatible(false);
    expect(h.state("S")).toBe("ended");
    await h.advance(OBSERVE_LIMIT_MS);
    expect(h.reads).toHaveLength(1);
  });

  test("S12: dispose (unmount, another identity) drops a read still out and every timer; nothing is notified after", async () => {
    const h = harness();
    h.observer.compatible(true);
    h.attachment.watch(["S"]);
    await h.answer(list({ S: source(true) }));
    await h.advance(OBSERVE_POLL_MS);
    const held = h.reads.at(-1);
    const notified = h.notified();
    h.observer.dispose();
    h.observer.dispose();
    expect(held?.live()).toBe(false);
    held?.answer(list({ S: source(true) }));
    await h.advance(10 * OBSERVE_LIMIT_MS);
    expect(h.notified()).toBe(notified);
    expect(h.reads).toHaveLength(2);
    expect(h.timers.size).toBe(0);
    h.attachment.watch(["T"]);
    expect(h.reads).toHaveLength(2);
  });

  test("a read whose session closed (identity changed while it ran) ends the observation: nothing shown", async () => {
    const h = harness();
    h.observer.compatible(true);
    h.attachment.watch(["S"]);
    await h.answer({ ok: false, kind: "closed" });
    expect(h.state("S")).toBe("ended");
    await h.advance(OBSERVE_LIMIT_MS);
    expect(h.reads).toHaveLength(1);
  });
});

/**
 * Revision 5 (R11; design assessment C1, C2, Q1, Q2, Q6, Q7, Q14): the observer belongs to the screen's VISIT, and a mounted screen only
 * attaches to it. An Atlas `403` unmounts the protected tree and mounts it again (the session's re-check): the screen detaches and a new
 * one attaches. What the visit read is never read again because of that, and its time limits are not restarted.
 */
describe("a visit outlives its screen (revision 5, R11)", () => {
  const refused: Read = {
    ok: false,
    kind: "refused",
    status: 403,
    code: "forbidden",
  };

  test("Q1: the first read is refused 403 while the screen is remounted: ONE read in all, however often it is remounted; nothing is sent", async () => {
    const h = harness();
    h.observer.compatible(true);
    h.attachment.watch(["S"]);
    expect(h.reads).toHaveLength(1);
    // The session takes its hold and closes the display before the answer reaches the caller: the screen unmounts.
    h.attachment.watch([]);
    h.attachment.detach();
    // ... and mounts again under the same identity, while the read is still out.
    let screen = h.observer.attach();
    screen.watch(["S"]);
    expect(h.reads).toHaveLength(1);
    await h.answer(refused);
    expect(h.state("S")).toBe("unknown");
    for (let i = 0; i < 6; i += 1) {
      screen.watch([]);
      screen.detach();
      screen = h.observer.attach();
      screen.watch(["S"]);
      await h.advance(OBSERVE_POLL_MS);
    }
    expect(h.reads).toHaveLength(1);
    expect(h.observer.observation("S")).toEqual({
      kind: "unknown",
      seenBusy: false,
    });
    await h.advance(10 * OBSERVE_LIMIT_MS);
    expect(h.reads).toHaveLength(1);
    expect(h.timers.size).toBe(0);
    expect(h.forbidden).toEqual([]);
  });

  test("Q1, the other order: the screen's cleanup runs after its detachment; the answer comes once the new screen is attached; one read", async () => {
    const h = harness();
    h.observer.compatible(true);
    h.attachment.watch(["S"]);
    h.attachment.detach();
    // A late call of the old screen's cleanup changes nothing.
    h.attachment.watch([]);
    const screen = h.observer.attach();
    screen.watch(["S"]);
    await h.answer(list({ S: source(true) }));
    expect(h.state("S")).toBe("busy");
    expect(h.reads).toHaveLength(1);
    // Read again only at the 5 s pace (from when the new screen attached).
    await h.advance(OBSERVE_POLL_MS - 1);
    expect(h.reads).toHaveLength(1);
    await h.advance(1);
    expect(h.reads).toHaveLength(2);
  });

  test("Q1: a read answered while NO screen is attached is still the visit's: the next screen shows it and reads nothing", async () => {
    for (const [answer, shown, pollsAfter] of [
      [refused, { kind: "unknown", seenBusy: false }, 1],
      [list({ S: source(true) }), { kind: "busy" }, 2],
    ] as const) {
      const h = harness();
      h.observer.compatible(true);
      h.attachment.watch(["S"]);
      h.attachment.watch([]);
      h.attachment.detach();
      await h.answer(answer);
      const screen = h.observer.attach();
      screen.watch(["S"]);
      expect(h.observer.observation("S")).toEqual(shown);
      expect(h.reads).toHaveLength(1);
      // A busy answer is followed at the 5 s pace, as if no remount had happened.
      await h.advance(OBSERVE_POLL_MS);
      expect(h.reads).toHaveLength(pollsAfter);
    }
  });

  test("Q2: busy, then the poll refused 403 and the remount: two reads, no third; it could not check (after busy)", async () => {
    const h = harness();
    h.observer.compatible(true);
    h.attachment.watch(["S"]);
    await h.answer(list({ S: source(true) }));
    await h.advance(OBSERVE_POLL_MS);
    expect(h.reads).toHaveLength(2);
    h.attachment.watch([]);
    h.attachment.detach();
    const screen = h.observer.attach();
    screen.watch(["S"]);
    await h.answer(refused);
    expect(h.observer.observation("S")).toEqual({
      kind: "unknown",
      seenBusy: true,
    });
    await h.advance(10 * OBSERVE_LIMIT_MS);
    expect(h.reads).toHaveLength(2);
  });

  test("Q12: nothing is admitted while no screen is attached; a walk refused that way SENT nothing, so the next screen reads it once", async () => {
    const h = harness();
    h.observer.compatible(true);
    h.attachment.watch(["S"]);
    const out = h.reads.at(-1);
    expect(out?.live()).toBe(true);
    h.attachment.detach();
    // Its next admission (a page, or a wait after `not_sent`) is declined: the client answers `closed`.
    expect(out?.live()).toBe(false);
    await h.answer({ ok: false, kind: "closed" });
    const screen = h.observer.attach();
    screen.watch(["S"]);
    expect(h.reads).toHaveLength(2);
    await h.answer(list({ S: source(true) }));
    expect(h.state("S")).toBe("busy");
  });

  test("a walk the session refused before its send boundary (`closed`, unsent) stays unread: the SAME screen does not read it again (no loop), the next screen does", async () => {
    const h = harness();
    h.observer.compatible(true);
    h.attachment.watch(["S"]);
    await h.answer({ ok: false, kind: "closed", unsent: true });
    expect(h.state("S")).toBe("checking");
    await h.advance(2 * OBSERVE_POLL_MS);
    h.attachment.watch(["S"]);
    expect(h.reads).toHaveLength(1);
    h.attachment.detach();
    const screen = h.observer.attach();
    screen.watch(["S"]);
    expect(h.reads).toHaveLength(2);
    await h.answer(list({ S: source(false) }));
    expect(h.state("S")).toBe("idle");
  });

  test("control: `closed` after the request was sent (the identity moved on) ends it; no later screen of the visit reads it", async () => {
    const h = harness();
    h.observer.compatible(true);
    h.attachment.watch(["S"]);
    await h.answer({ ok: false, kind: "closed" });
    expect(h.state("S")).toBe("ended");
    h.attachment.detach();
    h.observer.attach().watch(["S"]);
    await h.advance(OBSERVE_LIMIT_MS);
    expect(h.reads).toHaveLength(1);
  });

  test("Q6 (Strict Mode): attach, detach and attach again in one go, before the read is answered: one read, and its answer is shown", async () => {
    const h = harness();
    h.observer.compatible(true);
    h.attachment.watch(["S"]);
    h.attachment.watch([]);
    h.attachment.detach();
    const screen = h.observer.attach();
    screen.watch(["S"]);
    expect(h.reads.at(-1)?.live()).toBe(true);
    await h.answer(list({ S: source(false) }));
    expect(h.state("S")).toBe("idle");
    expect(h.reads).toHaveLength(1);
  });

  test("Q7/Q14: remounts neither restart nor extend the time limit: busy throughout with a remount every 4 s, it ends at 75 s from the first walk", async () => {
    const h = harness();
    h.observer.compatible(true);
    h.attachment.watch(["S"]);
    await h.answer(list({ S: source(true) }));
    let screen = h.attachment;
    let answered = 1;
    for (let t = 0; t < OBSERVE_LIMIT_MS - 4_000; t += 4_000) {
      screen.watch([]);
      screen.detach();
      screen = h.observer.attach();
      screen.watch(["S"]);
      await h.advance(4_000);
      while (answered < h.reads.length) {
        h.reads[answered]?.answer(list({ S: source(true) }));
        answered += 1;
        await h.flush();
      }
    }
    expect(h.state("S")).toBe("busy");
    // A remount every 4 s holds each 5 s poll back: nothing is read early.
    expect(h.reads).toHaveLength(1);
    // The last screen's poll is due 5 s after it attached (within the limit); its answer is still out at 75 s.
    await h.advance(4_000 + 1);
    expect(h.now()).toBeGreaterThanOrEqual(OBSERVE_LIMIT_MS);
    expect(h.observer.observation("S")).toEqual({
      kind: "unknown",
      seenBusy: true,
    });
    expect(h.reads).toHaveLength(2);
    expect(h.reads[1]?.live()).toBe(false);
    const after = h.observer.attach();
    after.watch(["S"]);
    await h.advance(10 * OBSERVE_LIMIT_MS);
    expect(h.reads).toHaveLength(2);
    expect(h.timers.size).toBe(0);
  });

  test("Q7: the SAME screen lists a source again (the cache gate opened again) while it is still observed: it is read at once, within its first limit", async () => {
    const h = harness();
    h.observer.compatible(true);
    h.attachment.watch(["S"]);
    await h.answer(list({ S: source(true) }));
    await h.advance(1_000);
    h.attachment.watch([]);
    expect(h.observer.observation("S")).toBeNull();
    // Hidden: not read while not listed.
    await h.advance(OBSERVE_POLL_MS);
    expect(h.reads).toHaveLength(1);
    h.attachment.watch(["S"]);
    expect(h.state("S")).toBe("busy");
    expect(h.reads).toHaveLength(2);
    await h.answer(list({ S: source(true) }));
    // The limit is still the first walk's: at 75 s it ends.
    for (let i = 0; i < 20 && h.state("S") === "busy"; i += 1) {
      await h.advance(OBSERVE_POLL_MS);
      if (h.reads.at(-1)?.live()) await h.answer(list({ S: source(true) }));
    }
    expect(h.state("S")).toBe("unknown");
    expect(h.now()).toBeLessThanOrEqual(OBSERVE_LIMIT_MS + OBSERVE_POLL_MS);
  });

  test("Q7: listed again after a FINAL answer (refused, idle, the limit, offline) by the same screen: nothing is read again", async () => {
    for (const final of [refused, list({ S: source(false) })]) {
      const h = harness();
      h.observer.compatible(true);
      h.attachment.watch(["S"]);
      await h.answer(final);
      h.attachment.watch([]);
      h.attachment.watch(["S"]);
      await h.advance(OBSERVE_LIMIT_MS);
      expect(h.reads).toHaveLength(1);
    }
  });

  test("Q7: a NEW screen lists a source the old one had stopped listing: continued, not read at once", async () => {
    const h = harness();
    h.observer.compatible(true);
    h.attachment.watch(["S"]);
    await h.answer(list({ S: source(true) }));
    h.attachment.watch([]);
    h.attachment.detach();
    const screen = h.observer.attach();
    screen.watch(["S"]);
    expect(h.reads).toHaveLength(1);
    await h.advance(OBSERVE_POLL_MS);
    expect(h.reads).toHaveLength(2);
  });

  test("Q8: a press yields the source for the visit: a later screen of the same visit does not observe it again", async () => {
    const h = harness();
    h.observer.compatible(true);
    h.attachment.watch(["S", "T"]);
    h.observer.yieldTo("S");
    await h.answer(list({ S: source(true), T: source(false) }));
    h.attachment.detach();
    const screen = h.observer.attach();
    screen.watch(["S", "T"]);
    expect(h.observer.observation("S")).toBeNull();
    expect(h.state("T")).toBe("idle");
    await h.advance(OBSERVE_LIMIT_MS);
    expect(h.reads).toHaveLength(1);
  });

  test("an older screen's calls do nothing once a newer one is attached; a disposed observer's attachment does nothing", async () => {
    const h = harness();
    h.observer.compatible(true);
    const newer = h.observer.attach();
    h.attachment.watch(["S"]);
    expect(h.reads).toHaveLength(0);
    expect(h.observer.observation("S")).toBeNull();
    h.attachment.detach();
    newer.watch(["S"]);
    expect(h.reads).toHaveLength(1);
    h.observer.dispose();
    const late = h.observer.attach();
    late.watch(["T"]);
    expect(h.reads).toHaveLength(1);
  });
});
