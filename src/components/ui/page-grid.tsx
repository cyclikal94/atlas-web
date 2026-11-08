import type { ReactNode } from "react";
import { cn } from "../../lib/utils";

/**
 * The two columns of a detail page (the Final design): the work in the wide column, and beside it from the desktop up a 300px column
 * that stays in view while the page scrolls (the activity of a task or a person, the goals of the timers). Below the desktop the
 * aside follows the main column, so nothing is lost on a narrower screen.
 */
export function PageGrid({
  children,
  aside,
  className,
}: {
  children: ReactNode;
  aside?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "grid items-start gap-8",
        aside ? "desktop:grid-cols-[minmax(0,1fr)_300px]" : "",
        className,
      )}
      data-page-grid=""
    >
      <div className="flex min-w-0 flex-col gap-5">{children}</div>
      {aside ? (
        <div
          className="min-w-0 desktop:sticky desktop:top-9"
          data-page-aside=""
        >
          {aside}
        </div>
      ) : null}
    </div>
  );
}

/** The small uppercase heading of a side column or a row group ("Activity", "The Lane household", "Running now"). */
export function AsideHeading({
  children,
  action,
  id,
  as: Tag = "h2",
  className,
}: {
  children: ReactNode;
  action?: ReactNode;
  id?: string;
  as?: "h2" | "h3";
  className?: string;
}) {
  return (
    <div className={cn("flex items-center justify-between gap-3", className)}>
      <Tag
        id={id}
        className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground"
      >
        {children}
      </Tag>
      {action}
    </div>
  );
}
