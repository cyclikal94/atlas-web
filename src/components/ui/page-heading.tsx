import type { ReactNode } from "react";
import { cn } from "../../lib/utils";

/**
 * The page's one h1. Route changes move focus here (RouteFocus), so it is programmatically focusable. `eyebrow` is the small
 * uppercase form the day views use above their large date (the heading stays the h1; the date is a title below it).
 */
export function PageHeading({
  children,
  eyebrow = false,
  className,
}: {
  children: ReactNode;
  eyebrow?: boolean;
  className?: string;
}) {
  return (
    <h1
      data-page-heading=""
      tabIndex={-1}
      className={cn(
        eyebrow
          ? "text-xs font-semibold uppercase tracking-[0.08em] text-primary"
          : "text-2xl font-semibold leading-tight tracking-tight text-foreground tablet:text-3xl",
        className,
      )}
    >
      {children}
    </h1>
  );
}
