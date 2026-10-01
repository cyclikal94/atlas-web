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

  test("a caller that is already superseded does not wait at all", async () => {
    const call = vi.fn(async () => notSent);
    const sleep = vi.fn(noSleep);
    await untilSent(call, { sleep, isCurrent: () => false });
    expect(call).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });
});
