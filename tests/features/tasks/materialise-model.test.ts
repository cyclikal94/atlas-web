// @vitest-environment node
import { describe, expect, test } from "vitest";
import { canonicalBody } from "../../../src/features/tasks/model/attempt";
import {
  begin,
  beyondHorizon,
  expectationOf,
  LIMIT,
  materialiseCommand,
  onRead,
  onSent,
  recover,
  rediscover,
  type Sequence,
  satisfied,
  submit,
  tryAgain,
} from "../../../src/features/tasks/model/materialise";
import { issue, WINDOW_MS } from "../../../src/features/tasks/model/retry";

/**
 * The catch-up state machine (WEB-04 §3.2/§5.8, plan §4.1; A2, A3, A4): every transition, its bounds and its keys. PURE: no store, no
 * network. The runner's tests drive the same transitions through W27 and a scripted client.
 */
const TASK = "aaaaaaaa-0000-4000-8000-000000000001";
const TODAY = "2026-10-25";
/** The device clock of each answer (revision 10: every answer is observed at a time). */
const T = 1_000_000;
let keys = 0;
const newKey = () => {
  keys += 1;
  return `k${keys}`;
};

const start = (over: Partial<Parameters<typeof begin>[0]> = {}) =>
  begin({
    taskId: TASK,
    throughDate: TODAY,
    trigger: "daily",
    generation: "g1",
    nowMs: 5,
    position: { last_date: "2026-10-01", pending: true },
    today: TODAY,
    ...over,
  }) as Sequence;

describe("begin and the end of a sequence", () => {
  test("nothing to do is written as nothing: a satisfied position begins no sequence", () => {
    expect(
      begin({
        taskId: TASK,
        throughDate: TODAY,
        trigger: "daily",
        generation: "g",
        nowMs: 1,
        position: { last_date: TODAY, pending: false },
        today: TODAY,
      }),
    ).toBeNull();
    expect(
      satisfied({ last_date: "2026-10-01", pending: false }, TODAY, TODAY),
    ).toBe(true);
    expect(
      satisfied({ last_date: "2026-10-01", pending: true }, TODAY, TODAY),
    ).toBe(false);
    // A day ahead of the server's today is satisfied only once generated through it.
    expect(
      satisfied({ last_date: TODAY, pending: false }, "2026-10-26", TODAY),
    ).toBe(false);
    expect(
      satisfied(
        { last_date: "2026-10-26", pending: false },
        "2026-10-26",
        TODAY,
      ),
    ).toBe(true);
  });

  test("a new sequence is ready, with the position it was begun from and no attempt", () => {
    expect(start()).toEqual({
      task_id: TASK,
      through_date: TODAY,
      sequence_generation: "g1",
      phase: "ready",
      attempt: null,
      read_seq: 0,
      successful_calls: 0,
      last_known_position: "2026-10-01",
      started_at: 5,
      read_failures: 0,
      stop: null,
      trigger: "daily",
      // Revision 10: a row of this build carries its schedule (none yet).
      schedule: null,
    });
  });

  test("MU-10C-09: the horizon is strictly beyond today + 31 (today + 31 is still allowed); beyond it nothing is sent", () => {
    expect(beyondHorizon("2026-11-25", TODAY)).toBe(false);
    expect(beyondHorizon("2026-11-26", TODAY)).toBe(true);
    const far = start({ throughDate: "2026-11-26" });
    expect(far.phase).toBe("stopped");
    expect(far.stop).toEqual({ reason: "horizon" });
    expect(recover(far)).toBe("stopped");
    expect(start({ throughDate: "2026-11-25" }).phase).toBe("ready");
  });
});

describe("sending: the attempt is written before it is sent", () => {
  test("submit takes a fresh key for a new body and keeps an uncertain attempt's key", () => {
    const sent = submit(start(), newKey);
    expect(sent.phase).toBe("submitting");
    expect(sent.attempt?.body).toBe(
      canonicalBody({
        kind: "materialise",
        task_id: TASK,
        through_date: TODAY,
        limit: LIMIT,
      }),
    );
    expect(materialiseCommand(TASK, TODAY).limit).toBe(16);
    const uncertain = onSent(sent, { kind: "uncertain" }, T);
    // MU-10C-06: an uncertain retry with a fresh key could commit the call twice under two keys.
    expect(uncertain.attempt).toEqual(sent.attempt);
    expect(submit(uncertain, newKey).attempt?.key).toBe(sent.attempt?.key);
  });

  test("a success moves to awaiting the position: read_seq + 1, the attempt cleared", () => {
    const sent = submit(start(), newKey);
    const ok = onSent(sent, { kind: "ok" }, T);
    expect(ok).toMatchObject({
      phase: "awaiting_position_read",
      read_seq: 1,
      attempt: null,
      read_failures: 0,
    });
    expect(expectationOf(ok)).toEqual({
      sequence_generation: "g1",
      phase: "awaiting_position_read",
      read_seq: 1,
      attempt_key: null,
      // Revision 4 (review R20): the row's revision as stored (W27 stamps it; a row not yet written has none: 0).
      revision: 0,
    });
    expect(expectationOf({ ...ok, revision: 7 })?.revision).toBe(7);
  });

  /**
   * ADAPTATION (revision 10, Decision B supersedes "three consecutive uncertain answers" for the command): uncertain answers keep the
   * attempt while the 180-second window runs; the answer that leaves no admissible time in it stops it as unreachable, KEEPING the
   * attempt for Try again.
   */
  test("uncertain answers through the 180 s window stop it as unreachable, KEEPING the attempt for Try again", () => {
    let row = submit(start(), newKey);
    let now = T;
    for (let i = 1; i < 10; i += 1) {
      row = onSent(row, { kind: "uncertain" }, now);
      expect(row.phase).toBe("submitting");
      expect(row.read_failures).toBe(i);
      expect(row.schedule?.since).toBe(T);
      now = row.schedule?.next as number;
      expect(now).toBeLessThan(T + WINDOW_MS);
    }
    expect(now - T).toBe(151_000);
    const attempt = row.attempt;
    row = onSent(row, { kind: "uncertain", requestId: "r9" }, now);
    expect(row.phase).toBe("stopped");
    expect(row.stop).toEqual({ reason: "unreachable", request_id: "r9" });
    expect(row.attempt).toEqual(attempt);
    // "Try again" resends that exact attempt.
    const again = tryAgain(row, T);
    expect(again).toMatchObject({
      phase: "submitting",
      attempt,
      successful_calls: 0,
      read_failures: 0,
      stop: null,
    });
  });

  test("MU-10C-10: a definite refusal (the archived task's 422 among them) stops it as rejected and clears the attempt; capacity likewise", () => {
    const sent = submit(start(), newKey);
    expect(
      onSent(sent, { kind: "rejected", requestId: "r1" }, T),
    ).toMatchObject({
      phase: "stopped",
      attempt: null,
      stop: { reason: "rejected", request_id: "r1" },
    });
    expect(onSent(sent, { kind: "capacity" }, T)).toMatchObject({
      phase: "stopped",
      attempt: null,
      stop: { reason: "capacity" },
    });
  });
});

describe("the position after a call", () => {
  const awaiting = (row = start()) =>
    onSent(submit(row, newKey), { kind: "ok" }, T);

  test("a call that moved the position counts and continues; a satisfied one ends the sequence", () => {
    const next = onRead(
      awaiting(),
      { kind: "ok", position: { last_date: "2026-10-17", pending: true } },
      TODAY,
      T,
    ) as Sequence;
    expect(next).toMatchObject({
      phase: "ready",
      successful_calls: 1,
      last_known_position: "2026-10-17",
    });
    expect(
      onRead(
        awaiting(),
        { kind: "ok", position: { last_date: TODAY, pending: false } },
        TODAY,
        T,
      ),
    ).toBeNull();
  });

  test("MU-10C-02: a call that did not move the position stops it (no progress), e.g. a device clock behind the server's", () => {
    const stuck = onRead(
      awaiting(),
      { kind: "ok", position: { last_date: "2026-10-01", pending: true } },
      TODAY,
      T,
    ) as Sequence;
    expect(stuck).toMatchObject({
      phase: "stopped",
      stop: { reason: "no_progress" },
      successful_calls: 1,
    });
  });

  test("MU-10C-01: the budget is exactly eight counted calls, then a stop (bound) from the position reached", () => {
    let row: Sequence = start({
      position: { last_date: "2026-01-01", pending: true },
    });
    let date = 1;
    // Eight, written out: the constant itself is what is under test.
    for (let call = 1; call <= 8; call += 1) {
      row = awaiting(row);
      date += 16;
      const last = `2026-${String(Math.ceil(date / 28)).padStart(2, "0")}-${String((date % 28) + 1).padStart(2, "0")}`;
      row = onRead(
        row,
        { kind: "ok", position: { last_date: last, pending: true } },
        TODAY,
        T,
      ) as Sequence;
      expect(row.successful_calls).toBe(call);
      if (call < 8) expect(row.phase).toBe("ready");
    }
    expect(row.phase).toBe("stopped");
    expect(row.stop).toEqual({ reason: "bound" });
    // MU-10C-03 / MU-10C-04: "Try again" keeps the position and gives a fresh budget.
    const again = tryAgain(row, T);
    expect(again).toMatchObject({
      phase: "ready",
      successful_calls: 0,
      read_failures: 0,
      last_known_position: row.last_known_position,
      sequence_generation: "g1",
      stop: null,
    });
  });

  test("uncertain reads keep the phase until the third stops it; a refused read stops it as rejected", () => {
    // Revision 10 (Decision B): an answer with no recognised cause is an unrecognised read: the third pauses it for the person.
    let row = awaiting();
    row = onRead(row, { kind: "uncertain" }, TODAY, T) as Sequence;
    expect(row).toMatchObject({
      phase: "awaiting_position_read",
      read_failures: 1,
    });
    row = onRead(row, { kind: "uncertain" }, TODAY, T + 1_000) as Sequence;
    row = onRead(row, { kind: "uncertain" }, TODAY, T + 3_000) as Sequence;
    expect(row).toMatchObject({
      phase: "stopped",
      stop: { reason: "unreachable" },
      schedule: { caller: "position", pause: "unrecognised", unknown: 3 },
    });
    // Its press reads again: a paused position read stays a read (never another `materialise`).
    expect(tryAgain(row, T + 4_000)).toMatchObject({
      phase: "awaiting_position_read",
      attempt: null,
      schedule: null,
    });
    expect(
      onRead(awaiting(), { kind: "rejected", requestId: "r2" }, TODAY, T),
    ).toMatchObject({ stop: { reason: "rejected", request_id: "r2" } });
  });
});

describe("recovery after a reload, a takeover or a crash", () => {
  test("MU-10C-05: submitting resends the stored attempt; awaiting only reads again (never a new materialise); ready continues; a stop stays", () => {
    const ready = start();
    const sending = submit(ready, newKey);
    const awaiting = onSent(sending, { kind: "ok" }, T);
    expect(recover(ready)).toBe("continue");
    expect(recover(sending)).toBe("send");
    expect(recover(awaiting)).toBe("read");
    expect(recover(onSent(sending, { kind: "rejected" }, T))).toBe("stopped");
  });

  test("MU-10C-08: only the person's Try again leaves a stop; nothing else restarts it", () => {
    const stop = onSent(submit(start(), newKey), { kind: "capacity" }, T);
    expect(recover(stop)).toBe("stopped");
    expect(tryAgain(stop, T).phase).toBe("ready");
    expect(tryAgain(start(), T)).toEqual(start());
  });
});

/** Revision 17 (review 18's R36-K; Kieran's decision approval/web10c-r36k-conservative-recovery-20261102.json). */
describe("REVISION17 R36-K: a row's lost answer rediscovered", () => {
  test("an uncertain command keeps its attempt (same key and body); counted at the rediscovery and paced from it", () => {
    const sending = submit(start(), newKey);
    const issued = { ...sending, schedule: issue(null, "command", T) };
    const out = rediscover(issued, T + 30_000) as Sequence;
    expect(out.phase).toBe("submitting");
    expect(out.attempt).toEqual(sending.attempt);
    expect(out.read_failures).toBe(1);
    expect(out.schedule).toMatchObject({
      caller: "command",
      issued: null,
      failures: 1,
      since: T,
      next: T + 31_000,
      cause: "transport",
    });
  });

  test("a position read after a known success stays the row's own read (never another materialise)", () => {
    const awaiting = onSent(submit(start(), newKey), { kind: "ok" }, T);
    const issued = { ...awaiting, schedule: issue(null, "position", T + 1) };
    const out = rediscover(issued, T + 10_000) as Sequence;
    expect(out.phase).toBe("awaiting_position_read");
    expect(out.attempt).toBeNull();
    expect(out.read_seq).toBe(awaiting.read_seq);
    expect(out.schedule).toMatchObject({
      caller: "position",
      failures: 1,
      next: T + 11_000,
    });
  });

  test("nothing outstanding (no issue, no schedule, untrusted, a stop) is never rediscovered; past the window it stops", () => {
    const ready = start();
    expect(rediscover(ready, T)).toBeNull();
    expect(rediscover({ ...ready, schedule: { v: 9 } as never }, T)).toBeNull();
    const stop = onSent(submit(start(), newKey), { kind: "capacity" }, T);
    expect(rediscover(stop, T)).toBeNull();
    const issued = {
      ...submit(start(), newKey),
      schedule: issue(null, "command", T),
    };
    expect(rediscover(issued, T + WINDOW_MS)).toMatchObject({
      phase: "stopped",
      stop: { reason: "unreachable" },
    });
  });
});
