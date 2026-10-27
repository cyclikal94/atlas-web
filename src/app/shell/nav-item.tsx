import { Link, useRouterState } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { Tooltip } from "../../components/ui/tooltip";
import { cn } from "../../lib/utils";
import { type Destination, destinationFor, destinations } from "./destinations";

const ITEM =
  "atlas-transition group relative flex items-center rounded-md text-sm text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground data-[status=active]:bg-sidebar-accent data-[status=active]:font-semibold data-[status=active]:text-sidebar-accent-foreground";

/**
 * A rail item, styled as shadcn/ui's sidebar menu button. The active item is marked by more than colour (finding F6):
 * aria-current, heavier weight, and an accent bar. Collapsed items are icon-only with 44px targets; the label shows on
 * hover and on focus.
 */
export function RailItem({
  destination,
  collapsed,
}: {
  destination: Destination;
  collapsed: boolean;
}) {
  const Icon = destination.icon;
  const label = destination.railLabel ?? destination.label;
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  });
  // A destination whose path begins another's (`/tasks` and `/tasks/lists`) is active only where the longest match says so, never by
  // the router's prefix rule alone.
  const nested = destinations.some(
    (other) =>
      other !== destination && other.to.startsWith(`${destination.to}/`),
  );
  return (
    <RailLink
      to={destination.to}
      label={label}
      collapsed={collapsed}
      {...(nested
        ? { active: destinationFor(pathname)?.id === destination.id }
        : {})}
      icon={
        <Icon
          aria-hidden="true"
          className="size-[18px] flex-none group-data-[status=active]:text-primary"
          strokeWidth={1.9}
        />
      }
    />
  );
}

/** A link in the rail with the item styling: a destination, or a pinned list (a dot for its icon). */
export function RailLink({
  to,
  params,
  label,
  collapsed,
  icon,
  trailing,
  exact = false,
  active,
}: {
  to: string;
  params?: Record<string, string>;
  label: string;
  collapsed: boolean;
  icon: ReactNode;
  trailing?: ReactNode;
  /** Active only on the exact path (a pinned list, so the lists pane does not light every pin). */
  exact?: boolean;
  /** The caller decides the active state (the router then marks only the exact path itself). */
  active?: boolean;
}) {
  const link = (
    <Link
      to={to}
      params={params}
      activeOptions={
        exact || active !== undefined ? { exact: true } : undefined
      }
      {...(active ? { "data-status": "active", "aria-current": "page" } : {})}
      aria-label={label}
      className={cn(
        ITEM,
        collapsed ? "size-11 justify-center" : "h-10 gap-3 px-3",
      )}
    >
      <span
        aria-hidden="true"
        className="absolute inset-y-2.5 left-0 hidden w-[3px] rounded-full bg-primary group-data-[status=active]:block"
      />
      {icon}
      {collapsed ? null : (
        <span className="min-w-0 flex-1 truncate">{label}</span>
      )}
      {collapsed ? null : trailing}
    </Link>
  );
  return collapsed ? <Tooltip content={label}>{link}</Tooltip> : link;
}
