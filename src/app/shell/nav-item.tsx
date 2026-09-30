import { Link } from "@tanstack/react-router";
import { Tooltip } from "../../components/ui/tooltip";
import type { Destination } from "./destinations";
import type { LayoutMode } from "./layout-mode";

/**
 * A rail item. The active item is marked by more than colour (finding F6): aria-current, heavier weight,
 * and an accent bar, because nav-active on chrome is only 1.4:1 in dark and 1.2:1 in light.
 * Collapsed items are icon-only with 44px targets; the label shows on hover and on focus.
 */
export function RailItem({
  destination,
  mode,
}: {
  destination: Destination;
  mode: Exclude<LayoutMode, "mobile">;
}) {
  const Icon = destination.icon;
  const collapsed = mode === "tablet";
  const link = (
    <Link
      to={destination.to}
      aria-label={destination.label}
      className={`atlas-transition group relative flex items-center rounded-nav text-[14px] text-ink-2 hover:bg-rail-hover data-[status=active]:bg-nav-active data-[status=active]:font-semibold data-[status=active]:text-ink-1 ${
        collapsed ? "size-11 justify-center" : "min-h-10 gap-2.5 px-2.5 py-2"
      }`}
    >
      <span
        aria-hidden="true"
        className="absolute inset-y-2 left-0 hidden w-[3px] rounded-round bg-action-ink group-data-[status=active]:block"
      />
      <Icon
        aria-hidden="true"
        size={18}
        className="flex-none group-data-[status=active]:text-action-ink"
      />
      {collapsed ? null : <span>{destination.label}</span>}
    </Link>
  );
  return collapsed ? (
    <Tooltip content={destination.label}>{link}</Tooltip>
  ) : (
    link
  );
}
