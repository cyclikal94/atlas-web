// @vitest-environment node
import { describe, expect, test } from "vitest";
import { DATA_CONFIG } from "../../src/data/model/config";
import {
  recordReadOutcome,
  resumeAllReadCallers,
  resumeReadCaller,
} from "../../src/data/plans/retry-state";
import { pageWorld } from "../support/data/page-world";

/**
 * Retry state is PER CALLER and durable (plan 5.6; WEB-04 D:5015-5075): a caller's pause is resumed only by `online` or by that
 * caller's own "Retry now", and never by an unrelated caller's success. Through the production plans over the double of IndexedDB.
 */
describe("per-caller read retry state, as stored", () => {
  const failure = { kind: "failure" } as const;
  const now = 1_000;

  test("an UNRELATED caller's success does not resume a paused caller, reset its streak or touch its clock", async () => {
    const w = await pageWorld();
    const sustained = DATA_CONFIG.retrySustainedMs;
    // `households:1` has been failing for longer than the sustained duration: paused. `materialise:7` has two unrecognised answers.
    w.setSync({
      read_retry_states: {
        "households:1": {
          backing_off_since: now - sustained,
          paused: true,
          unrecognised_streak: 0,
        },
        "materialise:7": {
          backing_off_since: null,
          paused: false,
          unrecognised_streak: 2,
        },
        sync: {
          backing_off_since: now - 5_000,
          paused: false,
          unrecognised_streak: 0,
        },
      },
    });
    const out = await w.service.commit(recordReadOutcome, {
      captured: w.capture(),
      caller: "sync",
      outcome: { kind: "success" },
      now,
    });
    expect(out.kind).toBe("applied");
    const states = w.sync().read_retry_states;
    // Only `sync` was reset.
    expect(states.sync).toEqual({
      backing_off_since: null,
      paused: false,
      unrecognised_streak: 0,
    });
    expect(states["households:1"]).toEqual({
      backing_off_since: now - sustained,
      paused: true,
      unrecognised_streak: 0,
    });
    expect(states["materialise:7"]).toEqual({
      backing_off_since: null,
      paused: false,
      unrecognised_streak: 2,
    });
  });

  test("a failure of one caller does not start another's clock, and the clock survives a reload (it is in the store)", async () => {
    const w = await pageWorld();
    await w.service.commit(recordReadOutcome, {
      captured: w.capture(),
      caller: "households:1",
      outcome: failure,
      now,
    });
    await w.service.commit(recordReadOutcome, {
      captured: w.capture(),
      caller: "households:1",
      outcome: failure,
      now: now + DATA_CONFIG.retrySustainedMs,
    });
    const states = w.sync().read_retry_states;
    expect(states["households:1"]).toEqual({
      backing_off_since: now,
      paused: true,
      unrecognised_streak: 0,
    });
    expect(states.sync).toBeUndefined();
  });

  test("`online` resumes every paused caller; a caller's own Retry now resumes only that caller", async () => {
    const w = await pageWorld();
    w.setSync({
      read_retry_states: {
        a: { backing_off_since: 1, paused: true, unrecognised_streak: 0 },
        b: { backing_off_since: 2, paused: true, unrecognised_streak: 0 },
      },
    });
    await w.service.store.run(resumeReadCaller, {
      incarnationId: w.service.incarnationId,
      caller: "a",
    });
    expect(w.sync().read_retry_states.a?.paused).toBe(false);
    expect(w.sync().read_retry_states.b?.paused).toBe(true);
    await w.service.store.run(resumeAllReadCallers, {
      incarnationId: w.service.incarnationId,
    });
    expect(w.sync().read_retry_states.b).toEqual({
      backing_off_since: null,
      paused: false,
      unrecognised_streak: 0,
    });
  });

  test("three unrecognised answers pause THAT caller only, and the pause survives a success of another", async () => {
    const w = await pageWorld();
    for (let i = 0; i < 3; i += 1)
      await w.service.commit(recordReadOutcome, {
        captured: w.capture(),
        caller: "households:1",
        outcome: { kind: "unrecognised" },
        now,
      });
    expect(w.sync().read_retry_states["households:1"]?.paused).toBe(true);
    await w.service.commit(recordReadOutcome, {
      captured: w.capture(),
      caller: "other",
      outcome: { kind: "success" },
      now,
    });
    expect(w.sync().read_retry_states["households:1"]?.paused).toBe(true);
    expect(w.sync().read_retry_states.sync).toBeUndefined();
  });
});
