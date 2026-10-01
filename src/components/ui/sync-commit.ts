import { flushSync } from "react-dom";

/**
 * Commits a React update SYNCHRONOUSLY: when this returns, the DOM is updated and layout effects and the effects of the
 * synchronous lane have run. The session's `act` mounts the protected tree and releases the exposure lock in one
 * synchronous step (matrix 3.6.3), so the mount cannot be left to React's scheduler. It lives here because `react-dom`
 * is imported only from `src/components/ui` (lint rule R3).
 */
export function commitSync(update: () => void): void {
  flushSync(update);
}
