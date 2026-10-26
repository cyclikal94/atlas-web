import { Link, useRouterState } from "@tanstack/react-router";
import { Ellipsis } from "lucide-react";
import type { RefObject } from "react";
import { List } from "../../components/ui/list";
import { destinationFor, destinations } from "./destinations";

/**
 * Mobile bottom navigation: Today, Tasks, People, then More (min-height 48px, design README). Sticky to the bottom of the
 * viewport, so it stays in reach on a long page and sits at the end of a short one. The active tab carries an accent bar,
 * a filled icon pill and the heavier label: never colour alone.
 */
export function TabBar({
  barRef,
  onOpenMore,
  moreOpen,
  moreRef,
}: {
  /** The bar itself, for AppShell to measure (chrome-insets.ts). */
  barRef: (element: HTMLElement | null) => void;
  onOpenMore(): void;
  moreOpen: boolean;
  moreRef: RefObject<HTMLButtonElement | null>;
}) {
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  });
  const inMore = destinationFor(pathname)?.mobile === "more";
  const item =
    "atlas-transition group relative flex min-h-12 flex-1 flex-col items-center justify-center gap-1 rounded-md text-[11px] text-sidebar-foreground";
  const pill =
    "atlas-transition flex h-7 w-12 items-center justify-center rounded-full";
  return (
    <nav
      ref={barRef}
      aria-label="Primary"
      className="sticky bottom-0 z-30 border-t border-sidebar-border bg-sidebar px-2 pb-[max(8px,env(safe-area-inset-bottom))] pt-1.5"
    >
      <List className="flex gap-1">
        {destinations
          .filter((destination) => destination.mobile === "tab")
          .map((destination) => {
            const Icon = destination.icon;
            return (
              <li key={destination.id} className="flex flex-1 list-none">
                <Link
                  to={destination.to}
                  className={`${item} data-[status=active]:font-semibold data-[status=active]:text-sidebar-accent-foreground`}
                >
                  <span
                    aria-hidden="true"
                    className="absolute inset-x-6 -top-1.5 hidden h-[3px] rounded-full bg-primary group-data-[status=active]:block"
                  />
                  <span
                    aria-hidden="true"
                    className={`${pill} group-data-[status=active]:bg-sidebar-accent group-data-[status=active]:text-primary`}
                  >
                    <Icon className="size-5" strokeWidth={1.9} />
                  </span>
                  <span>{destination.label}</span>
                </Link>
              </li>
            );
          })}
        <li className="flex flex-1 list-none">
          <button
            ref={moreRef}
            type="button"
            aria-haspopup="dialog"
            aria-expanded={moreOpen}
            data-active={inMore ? "" : undefined}
            onClick={onOpenMore}
            className={`${item} data-[active]:font-semibold data-[active]:text-sidebar-accent-foreground`}
          >
            <span
              aria-hidden="true"
              className="absolute inset-x-6 -top-1.5 hidden h-[3px] rounded-full bg-primary group-data-[active]:block"
            />
            <span
              aria-hidden="true"
              className={`${pill} group-data-[active]:bg-sidebar-accent group-data-[active]:text-primary`}
            >
              <Ellipsis className="size-5" strokeWidth={1.9} />
            </span>
            <span>More</span>
          </button>
        </li>
      </List>
    </nav>
  );
}
