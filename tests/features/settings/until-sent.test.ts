import { describe, expect, test, vi } from "vitest";
import {
  NOT_SENT_DELAYS_MS,
  untilSent,
} from "../../../src/features/settings/sessions-devices/until-sent";
import type { Result } from "../../../src/session";

const notSent: Result<string> = { ok: false, error: "not_sent" };
const okay: Result<string> = { ok: true, value: "fine" };
const noSleep = (_ms: number) => Promise.resolve();

describe("untilSent: a not_sent answer is called again, nothing else is", () => {
  test("an answer that is not not_sent is returned at once, whatever it is", async () => {
    for (const result of [
      okay,
      { ok: false, error: "offline" },
      { ok: false, error: "auth_state" },
      { ok: false, error: "closed" },
      { ok: false, error: "http", status: 500 },
    ] as Result<string>[]) {
      const call = vi.fn(async () => result);
      const sleep = vi.fn(noSleep);
      expect(await untilSent(call, { sleep })).toBe(result);
      expect(call).toHaveBeenCalledTimes(1);
      expect(sleep).not.toHaveBeenCalled();
    }
  });

  test("not_sent twice, then success: three calls, waiting the first two delays", async () => {
    const answers = [notSent, notSent, okay];
    const call = vi.fn(async () => answers.shift() as Result<string>);
    const sleep = vi.fn(noSleep);
    expect(await untilSent(call, { sleep })).toBe(okay);
    expect(call).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual(
      NOT_SENT_DELAYS_MS.slice(0, 2),
    );
  });

  test("the wait is bounded: after the last delay the final not_sent is returned", async () => {
    const call = vi.fn(async () => notSent);
    const sleep = vi.fn(noSleep);
    expect(await untilSent(call, { sleep })).toBe(notSent);
    expect(call).toHaveBeenCalledTimes(NOT_SENT_DELAYS_MS.length + 1);
    expect(sleep).toHaveBeenCalledTimes(NOT_SENT_DELAYS_MS.length);
    // About six seconds in all: long enough for any hold, short enough that a real fault is shown.
    const total = NOT_SENT_DELAYS_MS.reduce((sum, ms) => sum + ms, 0);
    expect(total).toBeGreaterThan(4_000);
    expect(total).toBeLessThan(8_000);
  });

  test("a caller that no longer wants the answer stops calling", async () => {
    let current = true;
    const call = vi.fn(async () => notSent);
    const sleep = vi.fn(async () => {
      current = false;
    });
    expect(await untilSent(call, { sleep, isCurrent: () => current })).toBe(
      notSent,
    );
    expect(call).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  // Adapted, labelled (WEB-08d review R3, revision 2): this case used to allow ONE call from a caller already superseded. The design
  // assessment showed that is how a dismissed dialog's retry was still sent; the helper now asks before every call, the first included.
  test("a caller that is already superseded makes no call and does not wait", async () => {
    const call = vi.fn(async () => notSent);
    const sleep = vi.fn(noSleep);
    expect(await untilSent(call, { sleep, isCurrent: () => false })).toEqual(
      notSent,
    );
    expect(call).not.toHaveBeenCalled();
    expect(sleep).not.toHaveBeenCalled();
  });
});

describe("untilSent: the owner is asked before every call (WEB-08d review R3)", () => {
  test("ended during a call that answers not_sent: no wait and no further call", async () => {
    let current = true;
    const call = vi.fn(async () => {
      current = false;
      return notSent;
    });
    const sleep = vi.fn(noSleep);
    expect(await untilSent(call, { sleep, isCurrent: () => current })).toBe(
      notSent,
    );
    expect(call).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  test.each(NOT_SENT_DELAYS_MS.map((ms, index) => [index, ms] as const))(
    "ended during delay %i (%i ms): the call after it is never made",
    async (index) => {
      let current = true;
      const call = vi.fn(async () => notSent);
      let sleeps = 0;
      const sleep = vi.fn(async () => {
        if (sleeps++ === index) current = false;
      });
      expect(await untilSent(call, { sleep, isCurrent: () => current })).toBe(
        notSent,
      );
      expect(call).toHaveBeenCalledTimes(index + 1);
      expect(sleep).toHaveBeenCalledTimes(index + 1);
    },
  );

  test("a current owner keeps the whole bounded schedule, unchanged", async () => {
    const call = vi.fn(async () => notSent);
    const sleep = vi.fn(noSleep);
    await untilSent(call, { sleep, isCurrent: () => true });
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([...NOT_SENT_DELAYS_MS]);
    expect(NOT_SENT_DELAYS_MS).toEqual([
      50, 100, 200, 400, 800, 1_000, 1_000, 1_000, 1_000,
    ]);
    expect(call).toHaveBeenCalledTimes(NOT_SENT_DELAYS_MS.length + 1);
  });
});
