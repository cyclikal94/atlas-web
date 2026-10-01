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
  for (let attempt = 0; ; attempt += 1) {
    const result = await call();
    if (result.ok || result.error !== "not_sent") return result;
    const delay = NOT_SENT_DELAYS_MS[attempt];
    if (delay === undefined || !isCurrent()) return result;
    await sleep(delay);
    if (!isCurrent()) return result;
  }
}
