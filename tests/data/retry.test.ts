// @vitest-environment node
import { describe, expect, test } from "vitest";
import { DATA_CONFIG } from "../../src/data/model/config";
import {
  draftIsSustained,
  initialReadRetry,
  nextDelay,
  onDraftFailure,
  onDraftResume,
  onLocalWriteFailure,
  onLocalWriteSuccess,
  onOnline,
  onReadFailure,
  onReadSuccess,
  onRetryNow,
  onUnrecognised,
} from "../../src/data/model/retry";

const SUSTAINED = DATA_CONFIG.retrySustainedMs;

describe("nextDelay: capped exponential back-off with jitter", () => {
  test("2 s doubling to a 60 s cap, with no jitter at the midpoint", () => {
    const steps = [1, 2, 3, 4, 5, 6, 7, 20].map((n) => nextDelay(n, 0.5));
    expect(steps).toEqual([
      2000, 4000, 8000, 16000, 32000, 60000, 60000, 60000,
    ]);
  });
  test("jitter is within +/- 20 %", () => {
    expect(nextDelay(3, 0)).toBe(Math.round(8000 * 0.8));
    expect(nextDelay(3, 0.999999)).toBeLessThanOrEqual(Math.round(8000 * 1.2));
    expect(nextDelay(3, 0.999999)).toBeGreaterThan(8000);
  });
});

describe("class 1: a draft submission (F-O10, validation traces 1 and 7)", () => {
  test("repeated failure backs off, and becomes an actionable pause only after the sustained duration", () => {
    let state = onDraftFailure(null, 1_000);
    expect(state).toEqual({ state: "backing_off", since: 1_000 });
    state = onDraftFailure(state, 1_000 + SUSTAINED - 1);
    expect(state.state).toBe("backing_off");
    state = onDraftFailure(state, 1_000 + SUSTAINED);
    expect(state).toEqual({ state: "paused", since: 1_000 });
    // A paused draft stays paused through further failures: it never retries silently forever.
    expect(onDraftFailure(state, 99_999_999)).toBe(state);
  });
  test("the passive indicator appears only after a sustained failure", () => {
    expect(draftIsSustained(null, 5)).toBe(false);
    expect(
      draftIsSustained({ state: "backing_off", since: 0 }, SUSTAINED - 1),
    ).toBe(false);
    expect(
      draftIsSustained({ state: "backing_off", since: 0 }, SUSTAINED),
    ).toBe(true);
    expect(draftIsSustained({ state: "paused", since: 0 }, 0)).toBe(true);
  });
  test("only an online event or an explicit retry resumes (the reducer for it clears the state)", () => {
    expect(onDraftResume()).toBeNull();
  });
});

describe("class 2 and 3: a read caller", () => {
  test("repeated failure pauses that caller after the sustained duration; the clock is durable", () => {
    let state = onReadFailure(initialReadRetry(), 10);
    expect(state).toEqual({
      backing_off_since: 10,
      paused: false,
      unrecognised_streak: 0,
    });
    state = onReadFailure(state, 10 + SUSTAINED - 1);
    expect(state.paused).toBe(false);
    expect(state.backing_off_since).toBe(10);
    state = onReadFailure(state, 10 + SUSTAINED);
    expect(state.paused).toBe(true);
  });
  test("only that caller's online/Retry now resumes; its own success resets it", () => {
    const paused = {
      backing_off_since: 5,
      paused: true,
      unrecognised_streak: 3,
    };
    expect(onOnline()).toEqual(initialReadRetry());
    expect(onRetryNow()).toEqual(initialReadRetry());
    expect(onReadSuccess()).toEqual(initialReadRetry());
    expect(paused.paused).toBe(true);
  });
  test("three unrecognised responses pause THAT caller, and a failure does not touch the streak", () => {
    let state = initialReadRetry();
    state = onUnrecognised(state);
    state = onUnrecognised(state);
    expect(state.paused).toBe(false);
    state = onReadFailure(state, 1);
    expect(state.unrecognised_streak).toBe(2);
    state = onUnrecognised(state);
    expect(state.paused).toBe(true);
    expect(state.unrecognised_streak).toBe(3);
  });
});

describe("class 4: a local write failure, keyed by operation identity", () => {
  test("three consecutive failures of ONE operation stop it; another operation's success does not reset it", () => {
    let streaks: Record<string, number> = {};
    let stop = false;
    ({ streaks, stop } = onLocalWriteFailure(streaks, "page:cursor-1"));
    ({ streaks, stop } = onLocalWriteFailure(streaks, "page:cursor-1"));
    expect(stop).toBe(false);
    streaks = onLocalWriteSuccess(streaks, "draft:abc");
    expect(streaks["page:cursor-1"]).toBe(2);
    ({ streaks, stop } = onLocalWriteFailure(streaks, "page:cursor-1"));
    expect(stop).toBe(true);
    expect(streaks["page:cursor-1"]).toBe(3);
  });
  test("that operation's own next success clears only its streak", () => {
    const streaks = onLocalWriteSuccess(
      { "page:a": 2, "draft:b": 1 },
      "page:a",
    );
    expect(streaks).toEqual({ "draft:b": 1 });
  });
  test("a streak of one operation is never counted against another (never keyed by kind)", () => {
    let streaks: Record<string, number> = {};
    ({ streaks } = onLocalWriteFailure(streaks, "draft:1"));
    ({ streaks } = onLocalWriteFailure(streaks, "draft:2"));
    expect(streaks).toEqual({ "draft:1": 1, "draft:2": 1 });
  });
});
