import { Link } from "@tanstack/react-router";
import { Tooltip } from "../../components/ui/tooltip";
import { cn } from "../../lib/utils";
import type { Destination } from "./destinations";
import type { LayoutMode } from "./layout-mode";

/**
 * A rail item, styled as shadcn/ui's sidebar menu button. The active item is marked by more than colour (finding F6):
 * aria-current, heavier weight, and an accent bar. Collapsed items are icon-only with 44px targets; the label shows on
 * hover and on focus.
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
      className={cn(
        "atlas-transition group relative flex items-center rounded-md text-sm text-sidebar-foreground",
        "hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
        "data-[status=active]:bg-sidebar-accent data-[status=active]:font-semibold data-[status=active]:text-sidebar-accent-foreground",
        collapsed ? "size-11 justify-center" : "h-10 gap-3 px-3",
      )}
    >
      <span
        aria-hidden="true"
        className="absolute inset-y-2.5 left-0 hidden w-[3px] rounded-full bg-primary group-data-[status=active]:block"
      />
      <Icon
        aria-hidden="true"
        className="size-[18px] flex-none group-data-[status=active]:text-primary"
        strokeWidth={1.9}
      />
      {collapsed ? null : <span className="truncate">{destination.label}</span>}
    </Link>
  );
  return collapsed ? (
    <Tooltip content={destination.label}>{link}</Tooltip>
  ) : (
    link
  );
}
