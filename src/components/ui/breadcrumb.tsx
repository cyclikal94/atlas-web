import { Link } from "@tanstack/react-router";
import { Fragment } from "react";

export interface Crumb {
  label: string;
  to?: string;
  params?: Record<string, string>;
  search?: Record<string, unknown>;
}

/**
 * The breadcrumb of a page under a destination (the Final design): "Today / Monday 26 October", small and quiet, the last item being
 * where the reader is. On the phone the shell's header carries the way back instead, so it is hidden there.
 */
export function Breadcrumb({
  items,
  current,
}: {
  items: readonly Crumb[];
  current: string;
}) {
  return (
    <nav
      aria-label="Breadcrumb"
      className="flex flex-wrap items-center gap-1.5 text-[13px] text-muted-foreground max-tablet:hidden"
      data-breadcrumb=""
    >
      {items.map((item) => (
        <Fragment key={item.label}>
          {item.to ? (
            <Link
              to={item.to}
              params={item.params}
              search={item.search}
              className="atlas-transition inline-flex min-h-11 items-center hover:text-foreground"
            >
              {item.label}
            </Link>
          ) : (
            <span className="inline-flex min-h-11 items-center">
              {item.label}
            </span>
          )}
          <span aria-hidden="true">/</span>
        </Fragment>
      ))}
      <span aria-current="page" className="inline-flex min-h-11 items-center">
        {current}
      </span>
    </nav>
  );
}
