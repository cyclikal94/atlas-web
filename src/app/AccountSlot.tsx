import type { RefObject } from "react";
import { openSwitcher } from "../features/switch/entry";
import { slotLabel } from "../features/switch/switch-labels";

/**
 * The rail's account slot: the VERIFIED username only (plan 5.8, HO-9, gaps G-9/G-21). It is rendered only while the label is verified
 * for the current epoch (the caller passes no slot otherwise), so a stale or unverified name is never shown, and nothing is ever derived
 * from the opaque account id. WEB-08c (G-8): it is the switcher's entry point, a button that opens WF-SWITCH-01 for the displayed
 * account; on mobile the same control sits in the More sheet.
 */
export function AccountSlot({
  label,
  account,
  collapsed,
  returnFocus,
}: {
  label: string;
  /** The displayed account the label was verified for: the flow opens for it, and only it. */
  account: string;
  collapsed: boolean;
  /**
   * Where the switcher returns focus when this control closes with the sheet it sits in (the mobile More sheet: the More button).
   * Without it the control itself is the return target (R10 of the review of 15 October 2026).
   */
  returnFocus?: RefObject<HTMLElement | null>;
}) {
  const open = (trigger: HTMLElement) =>
    openSwitcher(account, returnFocus?.current ?? trigger);
  if (collapsed)
    return (
      <button
        type="button"
        aria-haspopup="dialog"
        aria-label={slotLabel(label)}
        data-account-slot=""
        onClick={(event) => open(event.currentTarget)}
        className="atlas-transition flex size-11 items-center justify-center rounded-md text-sm font-semibold text-muted-foreground hover:bg-accent hover:text-foreground"
      >
        <span aria-hidden="true">{Array.from(label)[0]?.toUpperCase()}</span>
      </button>
    );
  return (
    <button
      type="button"
      aria-haspopup="dialog"
      aria-label={slotLabel(label)}
      data-account-slot=""
      onClick={(event) => open(event.currentTarget)}
      className="atlas-transition flex min-h-11 w-full min-w-0 items-center rounded-md px-2.5 py-2 text-left text-sm text-muted-foreground hover:bg-accent hover:text-foreground"
    >
      <span className="min-w-0 truncate">{label}</span>
    </button>
  );
}
