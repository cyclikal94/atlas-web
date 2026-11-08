import type { ReactNode } from "react";
import { cn } from "../../lib/utils";

/**
 * The page's one h1. Route changes move focus here (RouteFocus), so it is programmatically focusable. `eyebrow` is the small
 * uppercase form the day views use above their large date (the heading stays the h1; the date is a title below it).
 */
export function PageHeading({
  children,
  eyebrow = false,
  as: Tag = "h1",
  className,
}: {
  children: ReactNode;
  eyebrow?: boolean;
  /** An `h2` when the page is drawn inside another page (a task opened beside the day), which keeps its own h1. */
  as?: "h1" | "h2";
  className?: string;
}) {
  return (
    <Tag
      {...(Tag === "h1" ? { "data-page-heading": "" } : {})}
      tabIndex={-1}
      // Route focus lands here: the ring hugs the words (`w-fit`), not the whole column.
      className={cn(
        "w-fit max-w-full rounded-sm",
        eyebrow
          ? "text-xs font-semibold uppercase tracking-[0.08em] text-primary"
          : "text-[28px] font-semibold leading-[1.08] tracking-[-0.03em] text-foreground tablet:text-[40px] tablet:leading-[1.05] tablet:tracking-[-0.035em]",
        className,
      )}
    >
      {children}
    </Tag>
  );
}
