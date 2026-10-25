// @vitest-environment node
import { describe, expect, test } from "vitest";
import { canonicalBody } from "../../../src/features/tasks/model/attempt";
import {
  begin,
  beyondHorizon,
  expectationOf,
  LIMIT,
  MAX_READ_FAILURES,
  materialiseCommand,
  onRead,
  onSent,
  recover,
  type Sequence,
  satisfied,
  submit,
  tryAgain,
} from "../../../src/features/tasks/model/materialise";

/**
 * The catch-up state machine (WEB-04 §3.2/§5.8, plan §4.1; A2, A3, A4): every transition, its bounds and its keys. PURE: no store, no
 * network. The runner's tests drive the same transitions through W27 and a scripted client.
 */
const TASK = "aaaaaaaa-0000-4000-8000-000000000001";
const TODAY = "2026-10-25";
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
    const uncertain = onSent(sent, { kind: "uncertain" });
    // MU-10C-06: an uncertain retry with a fresh key could commit the call twice under two keys.
    expect(uncertain.attempt).toEqual(sent.attempt);
    expect(submit(uncertain, newKey).attempt?.key).toBe(sent.attempt?.key);
  });

  test("a success moves to awaiting the position: read_seq + 1, the attempt cleared", () => {
    const sent = submit(start(), newKey);
    const ok = onSent(sent, { kind: "ok" });
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
    });
  });

  test("three consecutive uncertain answers stop it as unreachable, KEEPING the attempt for Try again", () => {
    let row = submit(start(), newKey);
    for (let i = 1; i < MAX_READ_FAILURES; i += 1) {
      row = onSent(row, { kind: "uncertain" });
      expect(row.phase).toBe("submitting");
      expect(row.read_failures).toBe(i);
    }
    const attempt = row.attempt;
    row = onSent(row, { kind: "uncertain", requestId: "r9" });
    expect(row.phase).toBe("stopped");
    expect(row.stop).toEqual({ reason: "unreachable", request_id: "r9" });
    expect(row.attempt).toEqual(attempt);
    // "Try again" resends that exact attempt.
    const again = tryAgain(row);
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
    expect(onSent(sent, { kind: "rejected", requestId: "r1" })).toMatchObject({
      phase: "stopped",
      attempt: null,
      stop: { reason: "rejected", request_id: "r1" },
    });
    expect(onSent(sent, { kind: "capacity" })).toMatchObject({
      phase: "stopped",
      attempt: null,
      stop: { reason: "capacity" },
    });
  });
});

describe("the position after a call", () => {
  const awaiting = (row = start()) =>
    onSent(submit(row, newKey), { kind: "ok" });

  test("a call that moved the position counts and continues; a satisfied one ends the sequence", () => {
    const next = onRead(
      awaiting(),
      { kind: "ok", position: { last_date: "2026-10-17", pending: true } },
      TODAY,
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
      ),
    ).toBeNull();
  });

  test("MU-10C-02: a call that did not move the position stops it (no progress), e.g. a device clock behind the server's", () => {
    const stuck = onRead(
      awaiting(),
      { kind: "ok", position: { last_date: "2026-10-01", pending: true } },
      TODAY,
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
      ) as Sequence;
      expect(row.successful_calls).toBe(call);
      if (call < 8) expect(row.phase).toBe("ready");
    }
    expect(row.phase).toBe("stopped");
    expect(row.stop).toEqual({ reason: "bound" });
    // MU-10C-03 / MU-10C-04: "Try again" keeps the position and gives a fresh budget.
    const again = tryAgain(row);
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
    let row = awaiting();
    row = onRead(row, { kind: "uncertain" }, TODAY) as Sequence;
    expect(row).toMatchObject({
      phase: "awaiting_position_read",
      read_failures: 1,
    });
    row = onRead(row, { kind: "uncertain" }, TODAY) as Sequence;
    row = onRead(row, { kind: "uncertain" }, TODAY) as Sequence;
    expect(row).toMatchObject({
      phase: "stopped",
      stop: { reason: "unreachable" },
    });
    expect(
      onRead(awaiting(), { kind: "rejected", requestId: "r2" }, TODAY),
    ).toMatchObject({ stop: { reason: "rejected", request_id: "r2" } });
  });
});

describe("recovery after a reload, a takeover or a crash", () => {
  test("MU-10C-05: submitting resends the stored attempt; awaiting only reads again (never a new materialise); ready continues; a stop stays", () => {
    const ready = start();
    const sending = submit(ready, newKey);
    const awaiting = onSent(sending, { kind: "ok" });
    expect(recover(ready)).toBe("continue");
    expect(recover(sending)).toBe("send");
    expect(recover(awaiting)).toBe("read");
    expect(recover(onSent(sending, { kind: "rejected" }))).toBe("stopped");
  });

  test("MU-10C-08: only the person's Try again leaves a stop; nothing else restarts it", () => {
    const stop = onSent(submit(start(), newKey), { kind: "capacity" });
    expect(recover(stop)).toBe("stopped");
    expect(tryAgain(stop).phase).toBe("ready");
    expect(tryAgain(start())).toEqual(start());
  });
});
