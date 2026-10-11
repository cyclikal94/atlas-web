// @vitest-environment node
import { describe, expect, test } from "vitest";
import { DEFAULT_CONFIG } from "../../src/session/constants";
import { Kernel, type SessionPorts } from "../../src/session/kernel/state";

/**
 * WEB-08c, R4 of the review of 11 October 2026: the kernel's stall bound is the matrix's "stalls BEYOND 5 s". T22 holds the resume's
 * local check for exactly 5 s; its completion then falls due within milliseconds of the bound's timer, and an engine may run the bound's
 * timer first (creation order, coalescing). The verdict waits `stallGraceMs` (250 ms) after the bound, so an answer due AT the bound,
 * or a little after it through timer jitter, is an answer in every engine; one that has not come by the end of the grace is a stall.
 *
 * The clock below runs due timers in (deadline, creation) order with the microtasks between them drained, which is that batch.
 */
function batchClock() {
  let now = 0;
  let seq = 0;
  const timers = new Map<number, { at: number; seq: number; fn: () => void }>();
  return {
    clock: {
      now: () => now,
      setTimeout(fn: () => void, ms: number) {
        seq += 1;
        timers.set(seq, { at: now + ms, seq, fn });
        return seq;
      },
      clearTimeout(handle: unknown) {
        timers.delete(handle as number);
      },
    },
    async advanceTo(t: number) {
      for (;;) {
        const due = [...timers.values()]
          .filter((timer) => timer.at <= t)
          .sort((a, b) => a.at - b.at || a.seq - b.seq)[0];
        if (!due) break;
        timers.delete(due.seq);
        now = due.at;
        due.fn();
        for (let i = 0; i < 10; i += 1) await Promise.resolve();
      }
      now = t;
    },
  };
}

function kernelWith(clock: ReturnType<typeof batchClock>["clock"]) {
  return new Kernel(
    {
      clock,
      page: { bootId: "boot-1" },
    } as unknown as SessionPorts,
    DEFAULT_CONFIG,
  );
}

const BOUND = 5_000;

describe("withStall: an answer due AT the bound is an answer; later is a stall (R4)", () => {
  test("the answer falls due at the same instant as the bound, its timer created after the bound's (the batch order that lost T22's restore)", async () => {
    const c = batchClock();
    const k = kernelWith(c.clock);
    let answer: (value: string) => void = () => undefined;
    const work = new Promise<string>((resolve) => {
      answer = resolve;
    });
    const verdict = k.withStall(work, BOUND);
    c.clock.setTimeout(() => answer("read"), BOUND);
    await c.advanceTo(BOUND + 100);
    expect(await verdict).toBe("read");
  });

  test("an answer due within the grace (timer jitter: 200 ms after the bound) is an answer", async () => {
    const c = batchClock();
    const k = kernelWith(c.clock);
    let answer: (value: string) => void = () => undefined;
    const work = new Promise<string>((resolve) => {
      answer = resolve;
    });
    const verdict = k.withStall(work, BOUND);
    c.clock.setTimeout(() => answer("read"), BOUND + 200);
    await c.advanceTo(BOUND + 1_000);
    expect(await verdict).toBe("read");
  });

  test("control: an answer that has not come by the end of the grace is a stall (the O-3 branch: 5.5 s)", async () => {
    const c = batchClock();
    const k = kernelWith(c.clock);
    let answer: (value: string) => void = () => undefined;
    const work = new Promise<string>((resolve) => {
      answer = resolve;
    });
    const verdict = k.withStall(work, BOUND);
    c.clock.setTimeout(() => answer("read"), BOUND + 500);
    await c.advanceTo(BOUND + 1_000);
    expect(await verdict).toBe("stalled");
    expect(DEFAULT_CONFIG.stallGraceMs).toBe(250);
  });

  test("control: an answer well inside the bound is an answer, and nothing waits for the bound", async () => {
    const c = batchClock();
    const k = kernelWith(c.clock);
    let answer: (value: string) => void = () => undefined;
    const work = new Promise<string>((resolve) => {
      answer = resolve;
    });
    const verdict = k.withStall(work, BOUND);
    c.clock.setTimeout(() => answer("read"), 10);
    await c.advanceTo(10);
    expect(await verdict).toBe("read");
  });
});
