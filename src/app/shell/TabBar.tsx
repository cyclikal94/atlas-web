import { Link } from "@tanstack/react-router";
import { List } from "../../components/ui/list";
import { destinations } from "./destinations";

/**
 * Phone bottom navigation: Today, Upcoming, Calendar, People and Lists (min-height 48px, design README); Sharing, Settings and the
 * account live behind "More" in the header. Sticky to the bottom of the viewport, so it stays in reach on a long page and sits at
 * the end of a short one. The active tab carries an accent bar, a filled icon pill and the heavier label: never colour alone.
 */
export function TabBar({
  barRef,
}: {
  /** The bar itself, for AppShell to measure (chrome-insets.ts). */
  barRef: (element: HTMLElement | null) => void;
}) {
  const item =
    "atlas-transition group relative flex min-h-12 flex-1 flex-col items-center justify-center gap-0.5 rounded-md text-[11px] text-sidebar-foreground";
  const pill =
    "atlas-transition flex h-7 w-11 items-center justify-center rounded-full";
  return (
    <nav
      ref={barRef}
      aria-label="Primary"
      className="sticky bottom-0 z-30 border-t border-sidebar-border bg-sidebar px-1 pb-[max(8px,env(safe-area-inset-bottom))] pt-1.5"
    >
      <List className="flex gap-0.5">
        {destinations
          .filter((destination) => destination.mobile === "tab")
          .map((destination) => {
            const Icon = destination.icon;
            return (
              <li
                key={destination.id}
                className="flex min-w-0 flex-1 list-none"
              >
                <Link
                  to={destination.to}
                  className={`${item} data-[status=active]:font-semibold data-[status=active]:text-sidebar-accent-foreground`}
                >
                  <span
                    aria-hidden="true"
                    className="absolute inset-x-5 -top-1.5 hidden h-[3px] rounded-full bg-primary group-data-[status=active]:block"
                  />
                  <span
                    aria-hidden="true"
                    className={`${pill} group-data-[status=active]:bg-sidebar-accent group-data-[status=active]:text-primary`}
                  >
                    <Icon className="size-5" strokeWidth={1.9} />
                  </span>
                  <span className="truncate">{destination.label}</span>
                </Link>
              </li>
            );
          })}
      </List>
    </nav>
  );
}
