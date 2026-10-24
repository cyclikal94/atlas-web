import { watchAttemptEnd } from "../features/authentication/attempt-end";
import {
  SESSIONS_SECTION_ROUTE,
  settingsPath,
} from "../features/settings/section-routes";
import type { Session } from "../session";
import { returnDestination } from "./return-destination";

/**
 * WEB-08c's composition-root wiring, loaded by `boot` together with the protected tree and the neutral forms (D-10: after the canary,
 * before the session starts), so none of it reaches the initial chunk and nothing waits for an import during a transition.
 */

/** Starts the `1c.ended` producer (D-8c-04). Returns a function that stops it. */
export function startAttemptEndWatcher(session: Session): () => void {
  return watchAttemptEnd(session);
}

/**
 * "Review this device" on state 1a.device_changed (gap G-10). The kernel has already cleared the notice and re-evaluates; this records
 * where to put the person when the display returns: the Sessions & devices screen, focused on this device's row, for the account the
 * notice concerned (read from the settled identity now, at the click) and only that account (D-8c-03). With nobody settled it does
 * nothing. The path comes from `section-routes`, not the Settings registry: the registry carries every section's route builder, and
 * importing it from this lazy chunk split the fixture shell's entry (revision 12, `section-routes.ts`).
 */
export function reviewDevice(
  session: Session,
  now: () => number = Date.now,
): void {
  const identity = session.identity.get();
  if (identity === null) return;
  returnDestination.set({
    account: identity.account_id,
    epoch: identity.epoch,
    when: "same-or-newer",
    path: settingsPath(SESSIONS_SECTION_ROUTE),
    focusKey: "device-this",
    requestedAt: now(),
  });
}
