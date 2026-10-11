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
}: {
  label: string;
  /** The displayed account the label was verified for: the flow opens for it, and only it. */
  account: string;
  collapsed: boolean;
}) {
  const open = (trigger: HTMLElement) => openSwitcher(account, trigger);
  if (collapsed)
    return (
      <button
        type="button"
        aria-haspopup="dialog"
        aria-label={slotLabel(label)}
        data-account-slot=""
        onClick={(event) => open(event.currentTarget)}
        className="atlas-transition flex size-11 items-center justify-center rounded-nav text-[13px] font-semibold text-ink-2 hover:bg-row-hover hover:text-ink-1"
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
      className="atlas-transition flex min-h-11 w-full min-w-0 items-center rounded-nav px-2.5 py-2 text-left text-[13px] text-ink-2 hover:bg-row-hover hover:text-ink-1"
    >
      <span className="min-w-0 truncate">{label}</span>
    </button>
  );
}
