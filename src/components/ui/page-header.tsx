import type { ReactNode } from "react";
import { cn } from "../../lib/utils";

/**
 * The header of every page (the Final design): at the left the small uppercase eyebrow, the large title and ONE summary line; at
 * the right the page's controls (the search pill, a primary act, "More"), aligned to the title's baseline from the tablet up and on
 * their own line on the phone. A page whose h1 is drawn by its route above this (Tasks, Lists) passes no `title`; a day view passes
 * the date as its title under the route's eyebrow heading.
 */
export function PageHeader({
  eyebrow,
  title,
  summary,
  actions,
  className,
  ...rest
}: {
  eyebrow?: ReactNode;
  title?: ReactNode;
  summary?: ReactNode;
  actions?: ReactNode;
  className?: string;
  [data: `data-${string}`]: string | undefined;
}) {
  return (
    <header
      {...rest}
      className={cn(
        "flex flex-wrap items-end justify-between gap-x-6 gap-y-3",
        className,
      )}
    >
      {/* The title keeps its width (it wraps only past the whole header): the controls wrap first. */}
      <div className="flex max-w-full shrink-0 flex-col gap-1.5">
        {eyebrow}
        {title}
        {summary ? (
          <p className="text-[15px] text-muted-foreground" data-page-summary="">
            {summary}
          </p>
        ) : null}
      </div>
      {actions ? (
        <div
          className="flex w-full flex-wrap items-center gap-2 tablet:w-auto"
          data-page-actions=""
        >
          {actions}
        </div>
      ) : null}
    </header>
  );
}

/** The small uppercase line above a title when it is not the page's heading (the heading is elsewhere, or there is none). */
export function Eyebrow({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <p
      className={cn(
        "text-xs font-semibold uppercase tracking-[0.08em] text-primary",
        className,
      )}
    >
      {children}
    </p>
  );
}

/** A page's large title when it is not its h1 (a day view's date under the "Today" heading, a month under "Calendar"). */
export function TitleText({
  children,
  className,
  ...rest
}: {
  children: ReactNode;
  className?: string;
  [data: `data-${string}`]: string | undefined;
}) {
  return (
    <p
      {...rest}
      className={cn(
        "text-[30px] font-semibold leading-[1.05] tracking-[-0.035em] text-foreground tablet:text-[40px]",
        className,
      )}
    >
      {children}
    </p>
  );
}
