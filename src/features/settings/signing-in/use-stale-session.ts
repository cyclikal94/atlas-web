import { useEffect, useReducer } from "react";
import { freshUntil, isFresh } from "../../authentication/validation";

/** The longest delay a timer honours (a signed 32-bit count of milliseconds): a longer one fires at once. */
const LONGEST_TIMER_MS = 2 ** 31 - 1;

/**
 * Whether the current session is too old to link or unlink single sign-on (review R8). The answer is read from the clock on every
 * render, and a timer renders again at the moment the window ends, so a screen that stays open does not keep offering a control
 * past the point at which it stops being eligible. `recheck` reads the clock now and is for the moment of activation: a timer can
 * run late (a suspended device, a hidden tab), and a late timer must not be the only thing between a click and the request.
 *
 * Only a session start time that is KNOWN is judged: `null` (it could not be read) never expires, and the server decides. The
 * comparison is against this device's clock, so a skewed clock can still reach the backend's own refusal, which fails closed
 * (docs/session.md, gap G-23); the server stays authoritative and this is a hint that spares the normal case that refusal.
 */
export function useStaleSession(startedAt: string | null): {
  stale: boolean;
  recheck(): boolean;
} {
  const [, rerender] = useReducer((count: number) => count + 1, 0);
  const staleNow = () => startedAt !== null && !isFresh(startedAt, Date.now());
  const stale = staleNow();

  useEffect(() => {
    const until = startedAt === null ? null : freshUntil(startedAt);
    if (until === null || stale) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Re-arm for what remains: the clock the timer ran on and the one `isFresh` reads can differ, so the render is asked for only
    // once the clock itself says the window has ended. A start far in the future (a clock set back) is waited for in steps.
    const arm = () => {
      const remaining = until - Date.now();
      if (remaining > 0)
        timer = setTimeout(arm, Math.min(remaining, LONGEST_TIMER_MS));
      else rerender();
    };
    arm();
    return () => clearTimeout(timer);
  }, [startedAt, stale]);

  return {
    stale,
    recheck: () => {
      const now = staleNow();
      if (now && !stale) rerender();
      return now;
    },
  };
}
