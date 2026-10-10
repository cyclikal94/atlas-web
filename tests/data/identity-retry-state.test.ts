// @vitest-environment node
import { describe, expect, test } from "vitest";
import { DATA_CONFIG } from "../../src/data/model/config";
import {
  initialReadRetry,
  isFailureStatus,
  isInitialReadRetry,
  mergeReadRetry,
  resumeOnOnline,
  sameReadRetry,
} from "../../src/data/model/retry";
import {
  persistReadRetry,
  readReadRetry,
  recordReadOutcome,
  resumeReadCallerOnOnline,
} from "../../src/data/plans/retry-state";
import { pageWorld } from "../support/data/page-world";

/**
 * R16 (revision 8): what the identity reads added to the retry state (plan 5.6): the pure helpers (`resumeOnOnline`,
 * `mergeReadRetry`, `isInitialReadRetry`), and the two things a caller can ask of `recordReadOutcome` (`known`, `supersedes`) with
 * the read-only plan `readReadRetry`. Through the production plans over the double of IndexedDB.
 */
const state = (
  backing_off_since: number | null,
  paused: boolean,
  unrecognised_streak: number,
) => ({ backing_off_since, paused, unrecognised_streak });

describe("resumeOnOnline: what `online` ends for one caller", () => {
  test("a back-off and a pause by duration end; the initial state has nothing to end", () => {
    expect(resumeOnOnline(state(5, false, 0))).toEqual(initialReadRetry());
    expect(resumeOnOnline(state(5, true, 0))).toEqual(initialReadRetry());
    expect(resumeOnOnline(initialReadRetry())).toBeNull();
  });

  test("a pause that unrecognised answers caused is not a connectivity problem: `online` leaves it", () => {
    const bound = DATA_CONFIG.unrecognisedPauseAfter;
    expect(resumeOnOnline(state(null, true, bound))).toBeNull();
    expect(resumeOnOnline(state(5, true, bound + 1))).toBeNull();
    // Below the bound a back-off still ends (the streak goes with it, as the plan has always done).
    expect(resumeOnOnline(state(5, false, bound - 1))).toEqual(
      initialReadRetry(),
    );
    // A streak with no back-off and no pause has nothing to end.
    expect(resumeOnOnline(state(null, false, 2))).toBeNull();
  });

  test("the bound is the caller's own", () => {
    expect(
      resumeOnOnline(state(5, true, 2), { unrecognisedPauseAfter: 2 }),
    ).toBeNull();
    expect(
      resumeOnOnline(state(5, true, 2), { unrecognisedPauseAfter: 3 }),
    ).toEqual(initialReadRetry());
  });
});

describe("mergeReadRetry: neither record loses what the other knew", () => {
  test("the earlier start of a continuous failure, a pause either has, the longer streak", () => {
    expect(mergeReadRetry(state(10, false, 1), state(4, false, 2))).toEqual(
      state(4, false, 2),
    );
    expect(mergeReadRetry(state(10, true, 0), state(4, false, 0))).toEqual(
      state(4, true, 0),
    );
    expect(mergeReadRetry(state(null, false, 0), state(4, false, 0))).toEqual(
      state(4, false, 0),
    );
    expect(mergeReadRetry(state(4, false, 0), state(null, false, 0))).toEqual(
      state(4, false, 0),
    );
  });

  test("a caller that has never failed stays at its initial state, and the merge is symmetric", () => {
    expect(
      isInitialReadRetry(
        mergeReadRetry(initialReadRetry(), initialReadRetry()),
      ),
    ).toBe(true);
    const a = state(3, false, 1);
    const b = state(9, true, 2);
    expect(mergeReadRetry(a, b)).toEqual(mergeReadRetry(b, a));
  });

  test("isInitialReadRetry is true only for the state a caller starts in", () => {
    expect(isInitialReadRetry(initialReadRetry())).toBe(true);
    expect(isInitialReadRetry(state(1, false, 0))).toBe(false);
    expect(isInitialReadRetry(state(null, true, 0))).toBe(false);
    expect(isInitialReadRetry(state(null, false, 1))).toBe(false);
  });
});

describe("recordReadOutcome: `known` and `supersedes`", () => {
  const now = 1_000;
  const unrecognised = { kind: "unrecognised" } as const;
  const failure = { kind: "failure" } as const;

  test("what the page knew is folded into the durable entry in the same transaction", async () => {
    const w = await pageWorld();
    const out = await w.service.commit(recordReadOutcome, {
      captured: w.capture(),
      caller: "profile:1",
      outcome: unrecognised,
      now,
      known: state(null, false, 2),
    });
    expect(out).toMatchObject({
      kind: "applied",
      value: { state: { unrecognised_streak: 3, paused: true } },
    });
    expect(w.sync().read_retry_states["profile:1"]).toEqual(
      state(null, true, 3),
    );
  });

  test("the earlier start of a failure the page knew is kept, so the sustained clock is not shortened", async () => {
    const w = await pageWorld();
    await w.service.commit(recordReadOutcome, {
      captured: w.capture(),
      caller: "profile:1",
      outcome: failure,
      now: now + DATA_CONFIG.retrySustainedMs,
      known: state(now, false, 0),
    });
    expect(w.sync().read_retry_states["profile:1"]).toEqual(
      state(now, true, 0),
    );
  });

  test("without `known` the plan is what it was", async () => {
    const w = await pageWorld();
    await w.service.commit(recordReadOutcome, {
      captured: w.capture(),
      caller: "profile:1",
      outcome: unrecognised,
      now,
    });
    expect(w.sync().read_retry_states["profile:1"]).toEqual(
      state(null, false, 1),
    );
  });

  test("`supersedes` drops the OTHER entries of a family in the same transaction, and nothing outside it", async () => {
    const w = await pageWorld();
    w.setSync({
      read_retry_states: {
        "profile:1": state(5, true, 0),
        "profile:2": state(6, false, 1),
        "profiled:1": state(7, false, 0),
        "device:1": state(8, false, 0),
        sync: state(9, false, 0),
      },
    });
    await w.service.commit(recordReadOutcome, {
      captured: w.capture(),
      caller: "profile:3",
      supersedes: "profile:",
      outcome: failure,
      now,
    });
    const states = w.sync().read_retry_states;
    expect(Object.keys(states).sort()).toEqual([
      "device:1",
      "profile:3",
      "profiled:1",
      "sync",
    ]);
    expect(states["profile:3"]).toEqual(state(now, false, 0));
    expect(states["device:1"]).toEqual(state(8, false, 0));
    expect(states.sync).toEqual(state(9, false, 0));
  });

  test("an entry the caller already has is its own, even when its key starts with the family", async () => {
    const w = await pageWorld();
    w.setSync({ read_retry_states: { "profile:3": state(5, false, 1) } });
    await w.service.commit(recordReadOutcome, {
      captured: w.capture(),
      caller: "profile:3",
      supersedes: "profile:",
      outcome: unrecognised,
      now,
    });
    expect(w.sync().read_retry_states["profile:3"]).toEqual(state(5, false, 2));
  });

  test("the response-derived guards still apply: a late answer of an earlier epoch is dropped and writes nothing", async () => {
    const w = await pageWorld({ epoch: 2 });
    // Publish epoch 2, as the page's first guarded write does.
    await w.service.commit(recordReadOutcome, {
      captured: w.service.capture(2),
      caller: "profile:2",
      outcome: failure,
      now,
    });
    const before = JSON.stringify(w.sync().read_retry_states);
    const late = await w.service.commit(recordReadOutcome, {
      captured: w.service.capture(1),
      caller: "profile:1",
      supersedes: "profile:",
      outcome: unrecognised,
      now,
    });
    expect(late.kind).toBe("dropped");
    expect(JSON.stringify(w.sync().read_retry_states)).toBe(before);
  });
});

describe("a success of a family caller", () => {
  const now = 1_000;

  test("leaves no entry at all, and drops the family's other entries, when `supersedes` is given", async () => {
    const w = await pageWorld();
    w.setSync({
      read_retry_states: {
        "profile:1": state(5, true, 0),
        "profile:2": state(6, false, 2),
        "device:2": state(8, false, 0),
      },
    });
    const out = await w.service.commit(recordReadOutcome, {
      captured: w.capture(),
      caller: "profile:2",
      supersedes: "profile:",
      outcome: { kind: "success" },
      now,
    });
    expect(out).toMatchObject({
      kind: "applied",
      value: { state: initialReadRetry() },
    });
    expect(Object.keys(w.sync().read_retry_states)).toEqual(["device:2"]);
  });

  test("the sync caller's success is still the initial state, stored (the plan is what it was)", async () => {
    const w = await pageWorld();
    await w.service.commit(recordReadOutcome, {
      captured: w.capture(),
      caller: "sync",
      outcome: { kind: "success" },
      now,
    });
    expect(w.sync().read_retry_states.sync).toEqual(initialReadRetry());
  });
});

describe("readReadRetry and the resume plan", () => {
  const read = (
    w: Awaited<ReturnType<typeof pageWorld>>,
    caller: string,
    family?: string,
  ) =>
    w.service.store.run(readReadRetry, {
      incarnationId: w.service.incarnationId,
      caller,
      ...(family === undefined ? {} : { family }),
    });

  test("a caller with no entry reads as the initial state, and reading writes nothing", async () => {
    const w = await pageWorld();
    const before = JSON.stringify(w.snapshot());
    expect(await read(w, "profile:1", "profile:")).toEqual({
      state: initialReadRetry(),
      others: 0,
    });
    expect(JSON.stringify(w.snapshot())).toBe(before);
  });

  test("it returns exactly that caller's entry, and how many OTHER entries its family holds", async () => {
    const w = await pageWorld();
    w.setSync({
      read_retry_states: {
        "profile:1": state(5, true, 0),
        "profile:2": state(7, false, 1),
        "profiled:9": state(7, false, 1),
        "device:1": state(6, false, 2),
      },
    });
    expect(await read(w, "profile:1", "profile:")).toEqual({
      state: state(5, true, 0),
      others: 1,
    });
    expect(await read(w, "profile:3", "profile:")).toEqual({
      state: initialReadRetry(),
      others: 2,
    });
    expect(await read(w, "device:1", "device:")).toEqual({
      state: state(6, false, 2),
      others: 0,
    });
    // Without a family nothing is counted.
    expect(await read(w, "profile:1")).toEqual({
      state: state(5, true, 0),
      others: 0,
    });
  });

  test("the `online` plan shares `resumeOnOnline`: a duration pause ends, an unrecognised pause stays, an unknown caller is untouched", async () => {
    const w = await pageWorld();
    w.setSync({
      read_retry_states: {
        "profile:1": state(5, true, 0),
        "device:1": state(null, true, 3),
      },
    });
    const resume = (caller: string) =>
      w.service.store.run(resumeReadCallerOnOnline, {
        incarnationId: w.service.incarnationId,
        caller,
        unrecognisedAfter: DATA_CONFIG.unrecognisedPauseAfter,
      });
    expect(await resume("profile:1")).toEqual({ resumed: true });
    expect(await resume("device:1")).toEqual({ resumed: false });
    expect(await resume("nobody")).toEqual({ resumed: false });
    const states = w.sync().read_retry_states;
    expect(states["profile:1"]).toEqual(initialReadRetry());
    expect(states["device:1"]).toEqual(state(null, true, 3));
    expect(states.nobody).toBeUndefined();
  });
});

describe("R16 (revision 9): persistReadRetry takes a page's memory into the record without recording an outcome", () => {
  test("a page's paused memory is written although nothing will ever ask again, and a record that knows more is not lowered", async () => {
    const w = await pageWorld();
    const out = await w.service.commit(persistReadRetry, {
      captured: w.capture(),
      caller: "profile:1",
      known: state(null, true, 3),
    });
    expect(out).toMatchObject({
      kind: "applied",
      value: { state: state(null, true, 3) },
    });
    expect(w.sync().read_retry_states["profile:1"]).toEqual(
      state(null, true, 3),
    );
    // A record that holds an earlier start of the failure and a longer streak keeps both.
    w.setSync({
      read_retry_states: { "profile:1": state(2, false, 4) },
    });
    await w.service.commit(persistReadRetry, {
      captured: w.capture(),
      caller: "profile:1",
      known: state(9, false, 1),
    });
    expect(w.sync().read_retry_states["profile:1"]).toEqual(state(2, false, 4));
  });

  test("the family's other entries (an earlier sign-in's) go in the same transaction; another family's stay", async () => {
    const w = await pageWorld();
    w.setSync({
      read_retry_states: {
        "profile:1": state(5, true, 0),
        "device:1": state(7, false, 0),
        sync: state(8, false, 0),
      },
    });
    await w.service.commit(persistReadRetry, {
      captured: w.capture(),
      caller: "profile:2",
      known: state(null, false, 2),
      supersedes: "profile:",
    });
    expect(w.sync().read_retry_states).toEqual({
      "profile:2": state(null, false, 2),
      "device:1": state(7, false, 0),
      sync: state(8, false, 0),
    });
  });

  test("a caller with nothing to remember leaves no entry", async () => {
    const w = await pageWorld();
    await w.service.commit(persistReadRetry, {
      captured: w.capture(),
      caller: "profile:1",
      known: initialReadRetry(),
      supersedes: "profile:",
    });
    expect(w.sync().read_retry_states).toEqual({});
  });

  test("it is response-derived and guarded: a stamp of another epoch or another incarnation writes nothing", async () => {
    const w = await pageWorld();
    const before = JSON.stringify(w.sync());
    const stale = await w.service.commit(persistReadRetry, {
      captured: { ...w.capture(), epoch: 99 },
      caller: "profile:1",
      known: state(null, true, 3),
    });
    expect(stale.kind).toBe("dropped");
    const other = await w.service.commit(persistReadRetry, {
      captured: { ...w.capture(), incarnationId: "another" },
      caller: "profile:1",
      known: state(null, true, 3),
    });
    expect(other.kind).toBe("dropped");
    expect(JSON.stringify(w.sync())).toBe(before);
  });
});

describe("R16 and R19 (revision 9): the pure helpers", () => {
  test("sameReadRetry compares all three fields", () => {
    expect(sameReadRetry(state(1, true, 2), state(1, true, 2))).toBe(true);
    expect(sameReadRetry(state(1, true, 2), state(2, true, 2))).toBe(false);
    expect(sameReadRetry(state(1, true, 2), state(1, false, 2))).toBe(false);
    expect(sameReadRetry(state(1, true, 2), state(1, true, 3))).toBe(false);
    expect(sameReadRetry(state(null, false, 0), initialReadRetry())).toBe(true);
  });

  test("isFailureStatus: the whole 5xx family and 429, nothing else", () => {
    for (const status of [429, 500, 501, 502, 503, 504, 505, 507, 520, 599])
      expect(isFailureStatus(status), `${status}`).toBe(true);
    for (const status of [
      0, 200, 204, 301, 400, 401, 403, 404, 408, 409, 410, 422, 499,
    ])
      expect(isFailureStatus(status), `${status}`).toBe(false);
  });
});
