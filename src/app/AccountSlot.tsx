/**
 * The rail's account slot: the VERIFIED username only (plan 5.8, HO-9). It is rendered only while the label is verified for the
 * current epoch, so a stale or unverified name is never shown, and nothing is ever derived from the opaque account id. The account
 * switcher and a richer name display are WEB-08c's; this is the smallest honest slot.
 */
export function AccountSlot({
  label,
  collapsed,
}: {
  label: string;
  collapsed: boolean;
}) {
  if (collapsed)
    return (
      <div
        role="img"
        aria-label={label}
        className="flex size-11 items-center justify-center rounded-nav text-[13px] font-semibold text-ink-2"
      >
        {Array.from(label)[0]?.toUpperCase()}
      </div>
    );
  return (
    <div className="min-w-0 truncate px-2.5 py-2 text-[13px] text-ink-2">
      {label}
    </div>
  );
}
