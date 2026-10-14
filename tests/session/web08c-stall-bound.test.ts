// @vitest-environment node
import { describe, expect, test } from "vitest";
import { DEFAULT_CONFIG } from "../../src/session/constants";
import { evaluate, readRecords } from "../../src/session/kernel/evaluate";
import { Kernel, type SessionPorts } from "../../src/session/kernel/state";
import { checkProperties } from "../support/session/properties";
import {
  leaseIds,
  newWorld,
  ordinaryGet,
  signedInPage,
} from "../support/session/scenarios";
import type { Knob } from "../support/session/world";

/**
 * WEB-08c, R4 of the reviews of 11 October 2026 (revision 2). The kernel's stall bound is HARD: matrix §3.6.2 step 1 cancels an ordinary
 * request whose lease has no `complete` within 5 s, and Ex5 says its later completion cannot revive it. Revision 1 had added a 250 ms grace
 * after every bound (`stallGraceMs`), so a lease completing at 5,200 ms was sent; the independent review's chronological probe showed it.
 * The grace is removed and these tests pin the original contract: whichever the page observes first decides, a completion observed after
 * the bound's timer is late, however close it was due, and nothing about it sends, reserves or revives the ended activity.
 *
 * Time is delivered CHRONOLOGICALLY (`advance`), never by `runUntilIdle` alone, which skips future timers and once let a delayed completion
 * overtake the bound in a reviewer probe (`evidence/review-2/stall-contract-prepared`).
 */
function chronologicalClock() {
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
    /** Runs due timers in (deadline, creation) order, draining microtasks between them: one timer task at a time. */
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

function kernelWith(clock: ReturnType<typeof chronologicalClock>["clock"]) {
  return new Kernel(
    {
      clock,
      page: { bootId: "boot-1" },
    } as unknown as SessionPorts,
    DEFAULT_CONFIG,
  );
}

const BOUND = 5_000;

/** `withStall(work, BOUND)` with the answer's own timer created before or after the bound's, due at `answerAt`. */
async function verdictFor(answerAt: number | null, answerFirst = false) {
  const c = chronologicalClock();
  const k = kernelWith(c.clock);
  let answer: (value: string) => void = () => undefined;
  const work = new Promise<string>((resolve) => {
    answer = resolve;
  });
  if (answerFirst && answerAt !== null)
    c.clock.setTimeout(() => answer("read"), answerAt);
  const verdict = k.withStall(work, BOUND);
  if (!answerFirst && answerAt !== null)
    c.clock.setTimeout(() => answer("read"), answerAt);
  await c.advanceTo(BOUND + 1_000);
  return verdict;
}

describe("withStall: the bound is hard (R4, revision 2)", () => {
  test("control: an answer well inside the bound is an answer", async () => {
    expect(await verdictFor(10)).toBe("read");
  });

  test("an answer observed BEFORE the bound's timer at the same instant is an answer (its task ran first)", async () => {
    expect(await verdictFor(BOUND, true)).toBe("read");
  });

  test("an answer due at the same instant but observed AFTER the bound's timer is late: stalled", async () => {
    expect(await verdictFor(BOUND, false)).toBe("stalled");
  });

  for (const late of [BOUND + 1, BOUND + 200, BOUND + 500])
    test(`an answer at ${late} ms is late: stalled (no grace)`, async () => {
      expect(await verdictFor(late)).toBe("stalled");
      expect(await verdictFor(late, true)).toBe("stalled");
    });

  test("an answer that never comes is stalled at the bound", async () => {
    expect(await verdictFor(null)).toBe("stalled");
  });

  test("no grace member remains in the configuration", () => {
    expect(Object.keys(DEFAULT_CONFIG)).not.toContain("stallGraceMs");
    expect(DEFAULT_CONFIG.coverStallMs).toBe(5_000);
    expect(DEFAULT_CONFIG.recordingStallMs).toBe(5_000);
  });
});

describe("an ordinary cover's lease completion, delivered chronologically (Q-D1)", () => {
  const cases: Array<{ delay: Knob; sent: boolean; label: string }> = [
    { delay: 10, sent: true, label: "10 ms (healthy control)" },
    {
      delay: 5_000,
      sent: false,
      label: "due at the bound, delivered after the bound's timer",
    },
    { delay: 5_001, sent: false, label: "5,001 ms" },
    { delay: 5_200, sent: false, label: "5,200 ms (the review's probe)" },
    { delay: 5_500, sent: false, label: "5,500 ms" },
    { delay: "unbounded", sent: false, label: "never" },
  ];
  for (const { delay, sent, label } of cases)
    test(`lease \`complete\` at ${label}: ${sent ? "sent once" : "NOT_COVERED, never sent, and its late lease is retired"}`, async () => {
      const f = await newWorld();
      const l = await signedInPage(f);
      f.world.setKnob("D0", delay, (meta) => meta.label === "cover:ordinary");
      let result = "pending";
      const pending = ordinaryGet(l.page, l.account, l.epoch).then(
        () => {
          result = "sent";
        },
        (e: { kind?: string }) => {
          result = e.kind ?? "unknown";
        },
      );
      await f.world.advance(0);
      await f.world.advance(6_000);
      await pending;
      const sends = () =>
        f.world.logs.filter(
          (e) => e.type === "fetch.sent" && String(e.path).endsWith("/probe"),
        ).length;
      expect(result).toBe(sent ? "sent" : "not_covered");
      expect(sends()).toBe(sent ? 1 : 0);
      // The late completion (if any) arrives now; it neither sends nor leaves an unresolved lease behind.
      f.world.clearKnobs();
      f.world.release();
      await f.world.advance(70_000);
      expect(sends()).toBe(sent ? 1 : 0);
      if (delay !== "unbounded") expect(leaseIds(f)).toEqual([]);
      expect(checkProperties(f)).toEqual([]);
    });
});

/**
 * Human decision T22-READ-BOUND-20261012 (Kieran, 12 October 2026): ONLY the display check's record read (`evaluate`) waits up to
 * `displayReadStallMs` (6 s) before the page fails closed; every other reader keeps the hard 5 s. The display read's bound is hard too.
 */
describe("the display read's own bound (T22-READ-BOUND-20261012)", () => {
  const displayRead = (page: string) => (meta: { [key: string]: unknown }) =>
    meta.label === "read" && meta.page === page;

  test("configuration: 6 s for the display read only", () => {
    expect(DEFAULT_CONFIG.displayReadStallMs).toBe(6_000);
  });

  for (const delay of [5_000, 5_500, 5_999])
    test(`a display read answered at ${delay} ms is an answer: the page stays displayed, nothing fails closed`, async () => {
      const f = await newWorld();
      const l = await signedInPage(f);
      const attached = l.page.surface.attachCount;
      f.world.setKnob("D0", delay, displayRead(l.page.id));
      const reading = evaluate(l.page.kernel, "t22-held-read");
      await f.world.advance(0);
      await f.world.advance(7_000);
      await reading;
      expect(l.page.session.view.get().kind).toBe("displaying");
      expect(l.page.surface.mounted?.account).toBe(l.account);
      expect(l.page.surface.attachCount).toBe(attached);
      expect(checkProperties(f)).toEqual([]);
    });

  for (const delay of [6_001, 6_200] as const)
    test(`a display read answered at ${delay} ms is late: the page fails closed (hard bound)`, async () => {
      const f = await newWorld();
      const l = await signedInPage(f);
      f.world.setKnob("D0", delay, displayRead(l.page.id));
      const reading = evaluate(l.page.kernel, "t22-late-read");
      await f.world.advance(0);
      await f.world.advance(7_000);
      await reading;
      expect(l.page.session.view.get()).toMatchObject({
        kind: "neutral",
        state: "1e.read_failure",
      });
      expect(l.page.surface.mounted).toBeNull();
      expect(checkProperties(f)).toEqual([]);
    });

  test("every other reader keeps the hard 5 s: `readRecords` without the display bound gives up at 5,001 ms", async () => {
    const f = await newWorld();
    const l = await signedInPage(f);
    f.world.setKnob("D0", 5_500, displayRead(l.page.id));
    let outcome: unknown = "pending";
    const read = readRecords(l.page.kernel).then((records) => {
      outcome = records === null ? "unreadable" : "read";
    });
    await f.world.advance(0);
    await f.world.advance(5_001);
    // Asserted before awaiting: a reader with a longer bound has not answered yet.
    expect(outcome).toBe("unreadable");
    await f.world.advance(2_000);
    await read;
  });
});
