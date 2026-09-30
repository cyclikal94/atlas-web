import { Link, useRouterState } from "@tanstack/react-router";
import { Ellipsis } from "lucide-react";
import type { RefObject } from "react";
import { List } from "../../components/ui/list";
import { destinationFor, destinations } from "./destinations";

/**
 * Mobile bottom navigation: Today, Tasks, People, then More (min-height 48px, design README). Sticky to the bottom of the
 * viewport, so it stays in reach on a long page and sits at the end of a short one.
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
    "atlas-transition group relative flex min-h-12 flex-1 flex-col items-center justify-center gap-1 rounded-nav text-[11px] text-ink-2";
  return (
    <nav
      ref={barRef}
      aria-label="Primary"
      className="sticky bottom-0 z-30 border-t border-hairline bg-tab-bar px-2 pb-[max(8px,env(safe-area-inset-bottom))] pt-2"
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
                  className={`${item} data-[status=active]:font-semibold data-[status=active]:text-ink-1`}
                >
                  <span
                    aria-hidden="true"
                    className="absolute inset-x-4 top-0 hidden h-[3px] rounded-round bg-action-ink group-data-[status=active]:block"
                  />
                  <Icon
                    aria-hidden="true"
                    size={20}
                    className="group-data-[status=active]:text-action-ink"
                  />
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
            className={`${item} data-[active]:font-semibold data-[active]:text-ink-1`}
          >
            <span
              aria-hidden="true"
              className="absolute inset-x-4 top-0 hidden h-[3px] rounded-round bg-action-ink group-data-[active]:block"
            />
            <Ellipsis
              aria-hidden="true"
              size={20}
              className="group-data-[active]:text-action-ink"
            />
            <span>More</span>
          </button>
        </li>
      </List>
    </nav>
  );
}
