// @vitest-environment node
import { describe, expect, test } from "vitest";
import {
  call,
  classifyAnswer as classify,
  classifyThrown,
  retryAfterMs,
  untilSent,
} from "../../../src/features/tasks/api";
import {
  DELAYS_MS,
  failed,
  gate,
  issue,
  lostPause,
  paused,
  readSchedule,
  rediscovered,
  reset,
  resumable,
  type Schedule,
  unanswered,
  WINDOW_MS,
  withdrawn,
} from "../../../src/features/tasks/model/retry";
import { StampedRequestError } from "../../../src/session";

/**
 * Revision 10 (Decision B, review R36; WEB-04 §5.11): the catch-up's retry protocol as PURE policy (`model/retry.ts`) and the transport
 * facts it is decided from (`api.ts`). The runner's schedules over W28 are in `catchup-retry.test.ts`.
 */
const T0 = 1_800_000_000_000;
const atlas = (code: string) => ({
  code,
  message: "m",
  request_id: "r-1",
  details: [],
});
const JSON_TYPE = "application/json";
/** The production classifier, read as an uncertain answer (its `retry` facts), or as it is. */
const classifyAnswer = (
  ...args: Parameters<typeof classify>
): Extract<ReturnType<typeof classify>, { kind: "uncertain" }> =>
  classify(...args) as never;

describe("the transport says what an uncertain answer is (Decision B causes)", () => {
  test("recognised transient answers: 500 internal_error and 503 temporarily_unavailable only", () => {
    expect(classifyAnswer(500, JSON_TYPE, atlas("internal_error"))).toEqual({
      ok: false,
      kind: "uncertain",
      requestId: "r-1",
      code: "internal_error",
      retry: { cause: "transient" },
    });
    expect(
      classifyAnswer(503, JSON_TYPE, atlas("temporarily_unavailable")).retry,
    ).toEqual({ cause: "transient" });
    // Control: the same statuses with another code, a code at another status, and no Atlas body are not recognised.
    expect(classifyAnswer(500, JSON_TYPE, atlas("internal")).retry).toEqual({
      cause: "unrecognised",
    });
    expect(
      classifyAnswer(503, JSON_TYPE, atlas("internal_error")).retry,
    ).toEqual({
      cause: "unrecognised",
    });
    expect(classifyAnswer(502, "text/html", "<html>")).toEqual({
      ok: false,
      kind: "uncertain",
      retry: { cause: "unrecognised" },
    });
    expect(classifyAnswer(404, "text/html", "<html>")).toEqual({
      ok: false,
      kind: "uncertain",
      retry: { cause: "unrecognised" },
    });
    // A capacity answer keeps its code, which the runner stops on before any retry cause is read.
    expect(
      classifyAnswer(503, JSON_TYPE, atlas("slice_capacity")),
    ).toMatchObject({
      kind: "uncertain",
      code: "slice_capacity",
    });
  });

  test("a definite refusal and a closed session carry no retry facts (unchanged for every other caller)", () => {
    expect(classifyAnswer(409, JSON_TYPE, atlas("conflict"))).toEqual({
      ok: false,
      kind: "conflict",
      requestId: "r-1",
      code: "conflict",
    });
    expect(classifyAnswer(401, null, null)).toEqual({
      ok: false,
      kind: "closed",
    });
    expect(
      classifyThrown(new StampedRequestError("not_sent" as never)),
    ).toEqual({ ok: false, kind: "not_sent" });
  });

  test("no answer is transport; a 200 that is not the contract's answer is unrecognised", async () => {
    expect(classifyThrown(new TypeError("network"))).toEqual({
      ok: false,
      kind: "uncertain",
      retry: { cause: "transport" },
    });
    const malformed = await call(
      async () => ({
        data: { nope: true },
        response: new Response("{}", {
          status: 200,
          headers: { "x-request-id": "r-200" },
        }),
      }),
      () => null,
    );
    expect(malformed).toEqual({
      ok: false,
      kind: "uncertain",
      requestId: "r-200",
      retry: { cause: "unrecognised" },
    });
  });

  test("429 keeps its distinct cause; a valid Retry-After (delay-seconds or an HTTP-date) is its minimum, an invalid one is none", async () => {
    const answer = (retryAfter?: string) =>
      call<null>(
        async () => ({
          error: atlas("rate_limited"),
          response: new Response("", {
            status: 429,
            headers: {
              "content-type": JSON_TYPE,
              ...(retryAfter === undefined
                ? {}
                : { "retry-after": retryAfter }),
            },
          }),
        }),
        () => null,
      ) as Promise<
        Extract<Awaited<ReturnType<typeof classify>>, { kind: "uncertain" }>
      >;
    expect(await answer("60")).toMatchObject({
      kind: "uncertain",
      code: "rate_limited",
      retry: { cause: "rate_limited", afterMs: 60_000 },
    });
    expect((await answer()).retry).toEqual({ cause: "rate_limited" });
    for (const invalid of ["-1", "1.5", "soon", ""])
      expect((await answer(invalid)).retry, invalid).toEqual({
        cause: "rate_limited",
      });
    // A very large delay is valid: held at about 31 years (an exact time), so the caller pauses rather than retrying sooner.
    expect((await answer("99999999999")).retry).toEqual({
      cause: "rate_limited",
      afterMs: 1e12,
    });
    // Without an Atlas body a 429 is still rate limited.
    expect(classifyAnswer(429, "text/plain", "slow down", "5").retry).toEqual({
      cause: "rate_limited",
      afterMs: 5_000,
    });
    // HTTP-date: relative to now; a past date is no delay.
    const now = Date.UTC(2026, 9, 29, 12, 0, 0);
    expect(retryAfterMs("Thu, 29 Oct 2026 12:01:30 GMT", now)).toBe(90_000);
    expect(retryAfterMs("Thu, 29 Oct 2026 11:00:00 GMT", now)).toBe(0);
    expect(retryAfterMs("0", now)).toBe(0);
    expect(
      retryAfterMs("Thursday, 29-Oct-26 12:00:00 GMT", now),
    ).toBeUndefined();
    expect(retryAfterMs(null, now)).toBeUndefined();
  });

  test("a resend the session held back stops once its caller no longer admits it (a window that ended while it waited)", async () => {
    let calls = 0;
    let admitted = true;
    const out = await untilSent(
      async () => {
        calls += 1;
        if (calls === 2) admitted = false;
        return { ok: false, kind: "not_sent" } as const;
      },
      () => admitted,
    );
    expect(out).toEqual({ ok: false, kind: "not_sent" });
    expect(calls).toBe(2);
  });
});

describe("pacing and the 180-second window", () => {
  test("delays 1, 2, 4, 8, 16, then 30 s; with immediate answers the retries are at 1, 3, 7, 15, 31, 61, 91, 121, 151 s and none at 180 s or later", () => {
    expect(DELAYS_MS).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 30_000]);
    expect(WINDOW_MS).toBe(180_000);
    const at: number[] = [];
    let s: Schedule | null = null;
    let now = T0;
    for (let i = 0; i < 20; i += 1) {
      const g = gate(s, now);
      if (g.kind === "pause") break;
      if (g.kind === "wait") {
        now = g.at;
        continue;
      }
      at.push(now - T0);
      s = failed(
        issue(s, "command", now),
        "command",
        { cause: "transient" },
        now,
        false,
      );
    }
    expect(at).toEqual([
      0, 1_000, 3_000, 7_000, 15_000, 31_000, 61_000, 91_000, 121_000, 151_000,
    ]);
    expect(s).toMatchObject({ pause: "window", since: T0, failures: 10 });
  });

  test("the window's end admits nothing: end − 1 ms is admitted, end and end + 1 ms pause", () => {
    const s: Schedule = {
      ...(failed(
        null,
        "discovery",
        { cause: "transient" },
        T0,
        true,
      ) as Schedule),
    };
    expect(gate(s, T0 + WINDOW_MS - 1)).toEqual({ kind: "now" });
    expect(gate(s, T0 + WINDOW_MS)).toEqual({ kind: "pause", pause: "window" });
    expect(gate(s, T0 + WINDOW_MS + 1)).toEqual({
      kind: "pause",
      pause: "window",
    });
    // Before its pace: a wait, never a send.
    expect(gate(s, T0 + 999)).toEqual({ kind: "wait", at: T0 + 1_000 });
  });

  test("a failure whose pace falls at or after the window's end pauses at once", () => {
    let s = failed(null, "command", { cause: "transport" }, T0, false);
    // The second failure's pace (2 s) ends 1 ms before the window: admitted.
    s = failed(s, "command", { cause: "transport" }, T0 + 177_999, false);
    expect(s).toMatchObject({ pause: null, next: T0 + 179_999 });
    // The third's (4 s) would fall after it: paused at once, nothing waits for a time that admits nothing.
    expect(
      failed(s, "command", { cause: "transport" }, T0 + 178_000, false).pause,
    ).toBe("window");
    // Exactly at the end is not admitted either.
    expect(
      failed(
        failed(null, "command", { cause: "transport" }, T0, false),
        "command",
        { cause: "transport" },
        T0 + 178_000,
        false,
      ).pause,
    ).toBe("window");
  });

  test("an issued call that answers after the window is recorded (a success ends it; a failure pauses), never resent", () => {
    const s = issue(
      failed(null, "position", { cause: "transient" }, T0, true),
      "position",
      T0 + 179_999,
    );
    const late = failed(
      s,
      "position",
      { cause: "transient" },
      T0 + 200_000,
      true,
    );
    expect(late).toMatchObject({ pause: "window", issued: null });
    expect(gate(late, T0 + 200_001)).toEqual({
      kind: "pause",
      pause: "window",
    });
  });
});

describe("429 and the server's deadline", () => {
  test("the next transmission is no earlier than the later of the deadline and the back-off", () => {
    const longer = failed(
      null,
      "discovery",
      { cause: "rate_limited", afterMs: 60_000 },
      T0,
      true,
    );
    expect(longer).toMatchObject({
      next: T0 + 60_000,
      server: T0 + 60_000,
      cause: "rate_limited",
    });
    const shorter = failed(
      null,
      "discovery",
      { cause: "rate_limited", afterMs: 200 },
      T0,
      true,
    );
    expect(shorter.next).toBe(T0 + 1_000);
    const missing = failed(
      null,
      "discovery",
      { cause: "rate_limited" },
      T0,
      true,
    );
    expect(missing).toMatchObject({ next: T0 + 1_000, server: null });
    const zero = failed(
      null,
      "discovery",
      { cause: "rate_limited", afterMs: 0 },
      T0,
      true,
    );
    expect(zero.next).toBe(T0 + 1_000);
    // A later failure without a deadline keeps an earlier one still in the future.
    const kept = failed(
      longer,
      "discovery",
      { cause: "transient" },
      T0 + 1_000,
      true,
    );
    expect(kept).toMatchObject({ server: T0 + 60_000, next: T0 + 60_000 });
    // Unrecognised read answers do not count as rate limited.
    expect(longer.unknown).toBe(0);
  });

  test("a deadline at or beyond the window's end pauses; invalid or huge deadlines never make an immediate or unbounded schedule", () => {
    expect(
      failed(
        null,
        "command",
        { cause: "rate_limited", afterMs: WINDOW_MS },
        T0,
        false,
      ).pause,
    ).toBe("window");
    expect(
      failed(
        null,
        "command",
        { cause: "rate_limited", afterMs: WINDOW_MS - 1 },
        T0,
        false,
      ).pause,
    ).toBeNull();
    for (const afterMs of [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      -5,
      1.5,
      2 ** 60,
    ]) {
      const s = failed(
        null,
        "command",
        { cause: "rate_limited", afterMs },
        T0,
        false,
      );
      expect(Number.isSafeInteger(s.next), String(afterMs)).toBe(true);
      expect(s.next, String(afterMs)).toBeGreaterThanOrEqual(T0 + 1_000);
    }
  });

  test("neither the person's reset nor a reconnection forgets a future deadline", () => {
    const s = paused(
      failed(
        null,
        "position",
        { cause: "rate_limited", afterMs: 600_000 },
        T0,
        true,
      ),
      "position",
      "window",
      T0,
    );
    for (const manual of [true, false]) {
      const after = reset(s, T0 + 10_000, manual) as Schedule;
      expect(after).toMatchObject({
        server: T0 + 600_000,
        pause: null,
        since: null,
      });
      expect(gate(after, T0 + 10_000)).toEqual({
        kind: "wait",
        at: T0 + 600_000,
      });
    }
    // Past its deadline, nothing remains of it.
    expect(reset(s, T0 + 600_000, true)).toBeNull();
  });
});

describe("the unrecognised read streak", () => {
  test("three unrecognised read answers pause the caller; recognised transient answers between them do not end the streak", () => {
    let s = failed(null, "discovery", { cause: "unrecognised" }, T0, true);
    s = failed(s, "discovery", { cause: "transient" }, T0 + 1_000, true);
    s = failed(s, "discovery", { cause: "unrecognised" }, T0 + 3_000, true);
    expect(s).toMatchObject({ unknown: 2, pause: null });
    s = failed(s, "discovery", { cause: "transport" }, T0 + 7_000, true);
    expect(s.pause).toBeNull();
    s = failed(s, "discovery", undefined, T0 + 15_000, true);
    expect(s).toMatchObject({ unknown: 3, pause: "unrecognised" });
    expect(resumable(s)).toBe(false);
  });

  test("an unrecognised COMMAND answer is duration-governed, never a streak", () => {
    let s: Schedule | null = null;
    for (let i = 0; i < 5; i += 1)
      s = failed(
        s,
        "command",
        { cause: "unrecognised" },
        T0 + i * 1_000,
        false,
      );
    expect(s).toMatchObject({ unknown: 0, pause: null, failures: 5 });
  });

  test("only the person's reset ends the streak; a reconnection keeps it (and lifts only a window pause)", () => {
    let s = failed(null, "discovery", { cause: "unrecognised" }, T0, true);
    s = failed(s, "discovery", { cause: "unrecognised" }, T0 + 1_000, true);
    const windowed = paused(s, "discovery", "window", T0 + 2_000);
    expect(resumable(windowed)).toBe(true);
    expect(reset(windowed, T0 + 3_000, false)).toMatchObject({
      unknown: 2,
      since: null,
      failures: 0,
    });
    expect(reset(windowed, T0 + 3_000, true)).toBeNull();
    for (const pause of ["unrecognised", "clock", "legacy"] as const)
      expect(resumable(paused(s, "discovery", pause, T0)), pause).toBe(false);
  });
});

describe("clocks, issues and stored records", () => {
  test("a clock behind the last time written, or a time that is not a time, pauses (clock) rather than granting a window", () => {
    const s = failed(null, "command", { cause: "transient" }, T0, false);
    expect(gate(s, T0 - 1)).toEqual({ kind: "pause", pause: "clock" });
    expect(gate(null, Number.NaN)).toEqual({ kind: "pause", pause: "clock" });
    expect(gate(s, Number.NaN)).toEqual({ kind: "pause", pause: "clock" });
    expect(
      failed(s, "command", { cause: "transient" }, T0 - 5, false),
    ).toMatchObject({
      pause: "clock",
      failures: 1,
    });
    // An equal clock is not backwards and mints no new episode.
    const again = failed(s, "command", { cause: "transient" }, T0, false);
    expect(again).toMatchObject({ since: T0, failures: 2 });
  });

  test("an issue never answered counts as lost WHEN it was issued; a transmission not made is withdrawn, uncounted", () => {
    const issued = issue(null, "command", T0);
    expect(issued).toMatchObject({ issued: T0, failures: 0 });
    expect(unanswered(issued, "command")).toMatchObject({
      issued: null,
      since: T0,
      failures: 1,
      next: T0 + 1_000,
      cause: "transport",
    });
    expect(withdrawn(issued)).toBeNull();
    const counted = issue(
      failed(null, "command", { cause: "transient" }, T0, false),
      "command",
      T0 + 1_000,
    );
    expect(withdrawn(counted)).toMatchObject({ issued: null, failures: 1 });
  });

  test("a stored schedule is read strictly: another caller's, a future format, or damaged fields are untrusted", () => {
    const s = failed(null, "position", { cause: "transient" }, T0, true);
    expect(readSchedule(s, "position")).toEqual(s);
    expect(readSchedule(null, "position")).toBeNull();
    expect(readSchedule(undefined, "position")).toBeNull();
    expect(readSchedule(s, "command")).toBe("invalid");
    for (const damaged of [
      { ...s, v: 2 },
      { ...s, next: -1 },
      { ...s, next: Number.NaN },
      { ...s, since: "yesterday" },
      { ...s, failures: 1.5 },
      { ...s, cause: "gremlins" },
      { ...s, pause: "forever" },
      { ...s, seen: undefined },
      "schedule",
    ])
      expect(readSchedule(damaged, "position"), JSON.stringify(damaged)).toBe(
        "invalid",
      );
  });
});

/**
 * Revision 17 (review 18's R36-K; Kieran's decision approval/web10c-r36k-conservative-recovery-20261102.json): an issued call whose
 * transport failure a page observed and no page recorded, counted lost when it is REDISCOVERED.
 */
describe("REVISION17 R36-K: a lost answer rediscovered", () => {
  test("counted as one transport failure at the rediscovery and paced from it, never from its issue; the window from the issue", () => {
    const issued = issue(null, "command", T0);
    const at = T0 + 25_000;
    expect(rediscovered(issued, "command", at)).toEqual({
      ...failed(null, "command", { cause: "transport" }, at, false),
      since: T0,
      seen: at,
    });
    expect(rediscovered(issued, "command", at)).toMatchObject({
      issued: null,
      failures: 1,
      next: at + (DELAYS_MS[0] as number),
      cause: "transport",
      pause: null,
    });
    // Never sooner than the lost call counted at its issue (the existing recovery of an unanswered call).
    expect(rediscovered(issued, "command", at).next).toBeGreaterThan(
      unanswered(issued, "command").next,
    );
  });

  test("an episode under way keeps its start, its count, its unrecognised streak and a server minimum still ahead", () => {
    const first = failed(null, "position", { cause: "unrecognised" }, T0, true);
    const limited = failed(
      first,
      "position",
      { cause: "rate_limited", afterMs: 60_000 },
      T0 + 2_000,
      true,
    );
    const issued = issue(limited, "position", T0 + 62_000);
    const at = T0 + 63_000;
    const out = rediscovered(issued, "position", at);
    expect(out).toMatchObject({
      since: T0,
      failures: 3,
      unknown: 1,
      next: at + (DELAYS_MS[2] as number),
      cause: "transport",
    });
    const ahead = issue(limited, "position", T0 + 3_000);
    expect(rediscovered(ahead, "position", T0 + 4_000)).toMatchObject({
      server: T0 + 62_000,
      next: T0 + 62_000,
    });
  });

  test("a rediscovery at or past the window's end pauses (window); a clock behind the issue pauses (clock)", () => {
    const issued = issue(null, "discovery", T0);
    expect(rediscovered(issued, "discovery", T0 + WINDOW_MS)).toMatchObject({
      pause: "window",
      failures: 1,
    });
    expect(rediscovered(issued, "discovery", T0 - 1)).toMatchObject({
      pause: "clock",
    });
  });
});

describe("REVISION18 R36-L: the stop a lost call's outcome or rediscovery leaves", () => {
  test("a lost call counted past its window, or under a clock moved back (no failure, no cause), leaves a lost call's pause", () => {
    for (const caller of ["discovery", "command", "position"] as const) {
      const issued = issue(null, caller, T0);
      const windowed = rediscovered(issued, caller, T0 + WINDOW_MS);
      expect(windowed).toMatchObject({
        issued: null,
        pause: "window",
        cause: "transport",
        failures: 1,
      });
      expect(lostPause(windowed)).toBe(true);
      // `failed` pauses an untrusted clock before it counts: no failure, the earlier cause (none).
      const clocked = rediscovered(issued, caller, T0 - 1);
      expect(clocked).toMatchObject({
        issued: null,
        pause: "clock",
        failures: 0,
        cause: null,
      });
      expect(lostPause(clocked)).toBe(true);
      // The owner's own outcome of a lost call in an episode under way (no rediscovery) alike: its window ends.
      const under = failed(null, caller, { cause: "transport" }, T0, false);
      const own = failed(
        issue(under, caller, T0 + WINDOW_MS - 1_000),
        caller,
        { cause: "transport" },
        T0 + WINDOW_MS,
        false,
      );
      expect(own).toMatchObject({ pause: "window", failures: 2 });
      expect(lostPause(own)).toBe(true);
      expect(
        lostPause(
          failed(issued, caller, { cause: "transport" }, Number.NaN, false),
        ),
      ).toBe(true);
      // A clock pause keeps an earlier episode's facts (its count, a received cause): still the lost call's clock.
      const earlier = failed(
        null,
        caller,
        { cause: "transient" },
        T0,
        caller !== "command",
      );
      const later = rediscovered(
        issue(earlier, caller, T0 + 5_000),
        caller,
        T0 + 4_000,
      );
      expect(later).toMatchObject({
        pause: "clock",
        failures: 1,
        cause: "transient",
      });
      expect(lostPause(later)).toBe(true);
    }
  });

  test("anything else is not: unpaused, outstanding, untrusted, an unrecognised streak, legacy, a window after received answers or with no failure", () => {
    const issued = issue(null, "position", T0);
    expect(lostPause(null)).toBe(false);
    expect(lostPause("invalid")).toBe(false);
    expect(lostPause(issued), "a call still outstanding").toBe(false);
    expect(
      lostPause(rediscovered(issued, "position", T0 + 1_000)),
      "paced, not paused",
    ).toBe(false);
    const windowed = rediscovered(issued, "position", T0 + WINDOW_MS);
    expect(
      lostPause({ ...windowed, issued: T0 + WINDOW_MS }),
      "issued again",
    ).toBe(false);
    expect(
      lostPause({ ...windowed, cause: "transient" }),
      "a window after received failures",
    ).toBe(false);
    expect(lostPause({ ...windowed, cause: "rate_limited" })).toBe(false);
    expect(lostPause({ ...windowed, cause: "unrecognised" })).toBe(false);
    expect(
      lostPause({ ...windowed, failures: 0 }),
      "a window with no failure",
    ).toBe(false);
    expect(lostPause({ ...windowed, pause: "unrecognised" })).toBe(false);
    expect(
      lostPause(paused(null, "position", "legacy", T0)),
      "an earlier build's",
    ).toBe(false);
    let streak: Schedule | null = null;
    for (let k = 0; k < 3; k += 1)
      streak = failed(
        streak,
        "position",
        { cause: "unrecognised" },
        T0 + k,
        true,
      );
    expect(streak?.pause).toBe("unrecognised");
    expect(lostPause(streak)).toBe(false);
  });

  test("what a lift goes on from keeps nothing of a lost call: the person's reset and a reconnection keep only a server minimum and the unrecognised streak", () => {
    const issued = issue(null, "command", T0);
    const windowed = rediscovered(issued, "command", T0 + WINDOW_MS);
    // Retiring a lost call's fence beside its stop therefore changes nothing a lift goes on from.
    expect(reset(windowed, T0 + WINDOW_MS + 1, true)).toBeNull();
    expect(reset(windowed, T0 + WINDOW_MS + 1, false)).toBeNull();
    const limited = failed(
      null,
      "command",
      { cause: "rate_limited", afterMs: 400_000 },
      T0,
      false,
    );
    const lost = rediscovered(
      issue({ ...limited, next: T0 }, "command", T0 + 1),
      "command",
      T0 + WINDOW_MS,
    );
    expect(lost.pause).toBe("window");
    expect(reset(lost, T0 + WINDOW_MS + 1, true)).toMatchObject({
      server: T0 + 400_000,
      failures: 0,
      since: null,
      unknown: 0,
    });
  });
});
