import type { DeviceRow, OperationStart } from "../../../session";

/**
 * The words of the warning before a wipe-producing action (WEB-04 wireframes section 4; answers Q20(a)), and the proposed
 * words for what the wireframes do not draw (design gaps G-5 and G-13). Explicit logout and self-retirement of THIS
 * device share the warning: both end in the canonical physical wipe of this browser's data for the account.
 */
export type WipeKind = "logout" | "retire";

const NOUN = { logout: "Log out", retire: "Retire this device" } as const;

export const titleFor = (kind: WipeKind): string => `${NOUN[kind]}?`;

export const changesLine = (n: number): string =>
  n === 1
    ? "1 change hasn't finished syncing yet:"
    : `${n} changes haven't finished syncing yet:`;

export const deleteLine = (kind: WipeKind): string =>
  `${kind === "logout" ? "Logging out" : "Retiring this device"} now will permanently delete these unsynced changes from this device. They cannot be recovered.`;

/** The corrected re-confirmation when the count changed between the warning and the confirmation. */
export const actuallyLine = (n: number, kind: WipeKind): string =>
  `Actually ${n} ${n === 1 ? "change" : "changes"} — still ${kind === "logout" ? "log out" : "retire this device"}?`;

export const NO_UNSYNCED_LINE =
  "Signing out here ends your current session immediately — you'll need to log in again.";
export const RETIRE_NOW_LINE =
  "Retiring this device signs you out here, right now.";
export const STAY_LABEL = "Stay logged in";

export const confirmLabel = (kind: WipeKind, unsynced: boolean): string =>
  unsynced ? `${NOUN[kind]} anyway →` : NOUN[kind];

/** PROPOSED (gap G-5): one line per non-zero component of the device summary. */
export function summaryLines(summary: DeviceRow["summary"]): string[] {
  const count = (n: number, one: string, many: string) =>
    `${n} ${n === 1 ? one : many}`;
  const lines: string[] = [];
  if (summary.sessions > 0)
    lines.push(
      `${count(summary.sessions, "sign-in", "sign-ins")} on this device`,
    );
  if (summary.native_handoffs > 0)
    lines.push(
      `${count(summary.native_handoffs, "app hand-off", "app hand-offs")} waiting`,
    );
  if (summary.notification_subscriptions > 0)
    lines.push(
      count(
        summary.notification_subscriptions,
        "notification subscription",
        "notification subscriptions",
      ),
    );
  if (summary.pending_sign_ins > 0)
    lines.push(
      `${count(summary.pending_sign_ins, "sign-in", "sign-ins")} in progress`,
    );
  if (summary.sync_registered)
    lines.push("This device syncs with this account");
  return lines;
}

/** PROPOSED (gap G-13): why the operation could not start. Nothing was changed in any of these cases. */
export const REFUSAL: Record<
  Extract<OperationStart, { kind: "refused" }>["reason"],
  string
> = {
  operation_pending: "Another sign-out is already in progress.",
  not_settled: "You're not signed in here any more.",
  attempt_gating: "A sign-in is still finishing. Try again in a moment.",
  no_current_device:
    "We couldn't identify this device. Reload Atlas and try again.",
  offline: "Retiring a device needs a connection.",
  fence_exists: "This account is being checked. Try again in a moment.",
  closing_write_gave_up:
    "Another Atlas window is busy. Close any you're not using and try again.",
  storage_unavailable:
    "This browser wouldn't let us save that, so nothing was changed.",
};
