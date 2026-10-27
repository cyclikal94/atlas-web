import type { Result } from "../../../session";

/**
 * `not_sent` means the session refused to put the request on the wire for a moment (a hold or a closing write was in force,
 * typically the resume verification that follows display): nothing was sent and no attempt was counted. The stamped-call
 * contract says the caller makes the same call again, so the screens do so quietly instead of showing an error for a condition
 * that clears in milliseconds. The wait is bounded (about six seconds in all); a window that long is a real failure and the
 * last `not_sent` is returned for the screen's own error handling.
 */
export const NOT_SENT_DELAYS_MS: readonly number[] = [
  50, 100, 200, 400, 800, 1_000, 1_000, 1_000, 1_000,
];

const wait = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * WEB-08d (review R3): `isCurrent` is asked before EVERY call, the first included, so an owner that has gone (a dialog dismissed or
 * replaced, a screen left, the identity moved on) never makes another one: the result is then `not_sent`, which is true, since this
 * helper sent nothing more. A call already made is not withdrawn by this helper; the caller passes its own `withdraw` signal to the
 * operation for that (`SendOptions`).
 */
export async function untilSent<T>(
  call: () => Promise<Result<T>>,
  options: {
    /** False once the caller no longer wants the answer (unmounted or superseded): stop calling. */
    isCurrent?: () => boolean;
    sleep?: (ms: number) => Promise<void>;
  } = {},
): Promise<Result<T>> {
  const isCurrent = options.isCurrent ?? (() => true);
  const sleep = options.sleep ?? wait;
  let last: Result<T> = { ok: false, error: "not_sent" };
  for (let attempt = 0; ; attempt += 1) {
    if (!isCurrent()) return last;
    last = await call();
    if (last.ok || last.error !== "not_sent") return last;
    const delay = NOT_SENT_DELAYS_MS[attempt];
    if (delay === undefined || !isCurrent()) return last;
    await sleep(delay);
  }
}
