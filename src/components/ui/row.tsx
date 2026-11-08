import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { cn } from "../../lib/utils";

/**
 * A row of a list page (the Final design's People and Lists): a leading mark (an avatar, a colour dot), a name, one short fact in grey,
 * and at the right a badge only when something needs the reader, a count, a chevron. 52px tall, rounded on hover, the row's edge
 * reaching 14px past the column so the hover tint frames the text. A row is a link to the thing it names, or a plain row.
 */
export function ListRow({
  leading,
  children,
  fact,
  trailing,
  current = false,
  className,
  ...rest
}: {
  leading?: ReactNode;
  children: ReactNode;
  fact?: ReactNode;
  trailing?: ReactNode;
  current?: boolean;
  className?: string;
  [data: `data-${string}`]: string | undefined;
} & (
  | {
      to: string;
      params?: Record<string, string>;
      search?: Record<string, unknown>;
    }
  | { to?: undefined; onClick?(): void }
)) {
  const classes = cn(
    "atlas-transition group -mx-3.5 flex min-h-[52px] items-center gap-3.5 rounded-[10px] px-3.5 text-[15px] text-foreground hover:bg-accent/60",
    current ? "bg-accent text-accent-foreground" : "",
    className,
  );
  const inner = (
    <>
      {leading}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {fact ? (
        <span className="hidden min-w-0 shrink truncate text-xs text-muted-foreground tablet:inline">
          {fact}
        </span>
      ) : null}
      {trailing}
    </>
  );
  const data = Object.fromEntries(
    Object.entries(rest).filter(([key]) => key.startsWith("data-")),
  );
  if ("to" in rest && rest.to !== undefined)
    return (
      <Link
        {...data}
        to={rest.to}
        params={rest.params}
        search={rest.search}
        aria-current={current ? "page" : undefined}
        className={classes}
      >
        {inner}
      </Link>
    );
  if ("onClick" in rest && rest.onClick)
    return (
      <button
        {...data}
        type="button"
        onClick={rest.onClick}
        className={cn(classes, "w-[calc(100%+28px)] text-left")}
      >
        {inner}
      </button>
    );
  return (
    <div {...data} className={classes}>
      {inner}
    </div>
  );
}

/** The small uppercase heading over a group of rows ("The Lane household", "Pinned"). */
export function RowGroupHeading({
  children,
  sub,
  id,
  as: Tag = "h2",
}: {
  children: ReactNode;
  sub?: ReactNode;
  id?: string;
  as?: "h2" | "h3";
}) {
  return (
    <Tag
      id={id}
      className="mt-3 mb-0.5 flex items-baseline gap-2.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground"
    >
      {children}
      {sub ? (
        <span className="text-xs font-normal normal-case tracking-normal">
          {sub}
        </span>
      ) : null}
    </Tag>
  );
}

/** A coloured dot for a list, from its id, so it keeps its colour in the rail and on its rows. */
export function ColourDot({
  id,
  size = 10,
  className,
}: {
  id: string;
  size?: 8 | 10;
  className?: string;
}) {
  let hash = 0;
  for (const char of id) hash = (hash * 31 + (char.codePointAt(0) ?? 0)) % 360;
  return (
    <span
      aria-hidden="true"
      className={cn(
        "flex-none rounded-full",
        size === 8 ? "size-2" : "size-2.5",
        className,
      )}
      style={{ backgroundColor: `oklch(0.75 0.14 ${hash})` }}
    />
  );
}
