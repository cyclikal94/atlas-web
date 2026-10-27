import { Check, ChevronDown } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "../../../lib/utils";

/**
 * The timeline rail (the Final design): a grey rail down the left of every day view, a time column before it, a node per row (filled
 * once its time has passed, outlined ahead of it), the section labels and day headings on the same rail, a dotted stretch where two
 * hours or more lie between tasks, the red "now" mark, and the fold that leads from today into the days after it.
 *
 * Every piece draws its own stretch of rail, so a row's hover background never cuts the line, and a list of pieces reads as one
 * continuous rail. Geometry (the time column 52px at the left edge, the rail at 71px, 94px of inset for the content) is shared here so
 * the pieces line up. Nothing here is colour alone: the time, the words and the controls carry the meaning; the rail is decoration.
 */
export const RAIL_INSET = "pl-[94px]";
const RAIL_LINE =
  "pointer-events-none absolute left-[71px] top-0 bottom-0 w-0.5 bg-border";
const RAIL_DOTTED =
  "pointer-events-none absolute left-[71px] top-0 bottom-0 w-0 border-l-2 border-dotted border-input";
const TIME_COLUMN =
  "pointer-events-none absolute left-0 w-[52px] truncate font-num text-xs text-muted-foreground";

export function RailLine({ dotted = false }: { dotted?: boolean }) {
  return (
    <span aria-hidden="true" className={dotted ? RAIL_DOTTED : RAIL_LINE} />
  );
}

/** A row's node: filled once its time has passed, outlined before; dashed for a row that is only proposed (the add row). */
export function RailNode({
  past,
  dashed = false,
}: {
  past: boolean;
  dashed?: boolean;
}) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "pointer-events-none absolute left-[66px] top-1/2 size-3 -translate-y-1/2 rounded-full border-2 border-input",
        dashed
          ? "border-dashed bg-transparent"
          : past
            ? "bg-input"
            : "bg-background",
      )}
    />
  );
}

/** A section label ("Morning", "Wednesday · 28") on the rail. The heading element is the caller's, so its level fits the page. */
export function RailLabel({
  heading,
  sub,
  className,
}: {
  heading: ReactNode;
  sub?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "relative flex h-[34px] items-center gap-2.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground [&>h2]:text-[11px] [&>h2]:font-semibold [&>h3]:text-[11px] [&>h3]:font-semibold",
        RAIL_INSET,
        className,
      )}
    >
      <RailLine />
      {heading}
      {sub ? (
        <span className="text-xs font-normal normal-case tracking-normal text-muted-foreground">
          {sub}
        </span>
      ) : null}
    </div>
  );
}

/** A day group's heading on the rail ("Tomorrow", "Rest of the week"), with a line of detail beside it. */
export function RailHeading({
  heading,
  sub,
}: {
  heading: ReactNode;
  sub?: ReactNode;
}) {
  return (
    <div
      className={cn(
        "relative flex min-h-16 flex-wrap items-baseline gap-x-3 gap-y-0 py-3 [&>h2]:text-xl [&>h2]:font-semibold [&>h2]:tracking-[-0.02em] [&>h2]:text-foreground",
        RAIL_INSET,
      )}
    >
      <RailLine />
      {heading}
      {sub ? (
        <span className="text-[13px] text-muted-foreground">{sub}</span>
      ) : null}
    </div>
  );
}

/**
 * The gap between two tasks two hours or more apart: the rail turns dotted and says how long ("5 h 30 m"). A list item among the
 * rows, or a block before a section label when the gap ends the section before.
 */
export function RailGap({
  label,
  as: Tag = "li",
}: {
  label: string;
  as?: "li" | "div";
}) {
  return (
    <Tag
      className={cn(
        "relative flex h-9 list-none items-center text-xs text-muted-foreground",
        RAIL_INSET,
      )}
      data-rail-gap=""
    >
      <RailLine dotted />
      {label}
    </Tag>
  );
}

/** The present moment on the rail: the time in red, a red dot on the rail and a line across. */
export function RailNow({
  time,
  label,
  as: Tag = "li",
}: {
  time: string;
  label: string;
  as?: "li" | "div";
}) {
  return (
    <Tag
      aria-label={label}
      data-rail-now=""
      className={cn("relative flex h-6 list-none items-center", RAIL_INSET)}
    >
      <RailLine />
      <span
        aria-hidden="true"
        className={cn(TIME_COLUMN, "font-medium text-destructive")}
      >
        {time}
      </span>
      <span
        aria-hidden="true"
        className="pointer-events-none absolute left-[66px] size-3 rounded-full bg-destructive ring-4 ring-destructive/20"
      />
      <span
        aria-hidden="true"
        className="h-0 flex-1 border-t-[1.5px] border-destructive"
      />
    </Tag>
  );
}

/** A line on the rail that folds a few rows away ("3 routine tasks") with a control to show them. */
export function RailFoldLine({
  children,
  action,
  expanded,
  onToggle,
}: {
  children: ReactNode;
  action: string;
  expanded: boolean;
  onToggle(): void;
}) {
  return (
    <li
      className={cn(
        "relative flex min-h-9 list-none items-center gap-3 text-[13px] text-muted-foreground",
        RAIL_INSET,
      )}
      data-rail-fold-line=""
    >
      <RailLine />
      <span className="min-w-0 flex-1 truncate">{children}</span>
      <button
        type="button"
        aria-expanded={expanded}
        onClick={onToggle}
        className="atlas-transition flex min-h-11 items-center px-3 text-xs text-muted-foreground hover:text-foreground"
      >
        {action}
      </button>
    </li>
  );
}

/** The fold between today and the days after it: a pill on a dotted rail, a dashed line across. */
export function RailFold({
  label,
  expanded,
  controls,
  onToggle,
}: {
  label: string;
  expanded: boolean;
  controls: string;
  onToggle(): void;
}) {
  return (
    <div className={cn("relative flex h-14 items-center gap-3", RAIL_INSET)}>
      <RailLine dotted />
      <button
        type="button"
        aria-expanded={expanded}
        aria-controls={controls}
        data-today-fold=""
        onClick={onToggle}
        className="atlas-transition inline-flex h-11 items-center gap-1.5 rounded-full border border-border px-3.5 text-xs text-muted-foreground hover:bg-accent hover:text-accent-foreground"
      >
        {label}
        <ChevronDown
          aria-hidden="true"
          className={cn(
            "size-3.5 transition-transform",
            expanded ? "rotate-180" : "",
          )}
        />
      </button>
      <span
        aria-hidden="true"
        className="h-0 flex-1 border-t border-dashed border-border"
      />
    </div>
  );
}

/**
 * A row on the rail: the time column, the node, and the row's content; `trailing` holds the badges and the quick action. The row is an
 * `li` (the list is the caller's). Everything but the content is positioned, so the content keeps a 48px line that wraps on its own.
 */
export function RailRow({
  time,
  past,
  children,
  trailing,
  className,
  compact = false,
  ...rest
}: {
  time: string;
  past: boolean;
  children: ReactNode;
  trailing?: ReactNode;
  className?: string;
  /** 44px rows for the days ahead. */
  compact?: boolean;
  [data: `data-${string}`]: string | undefined;
} & { "aria-labelledby"?: string }) {
  return (
    <li
      {...rest}
      className={cn(
        "atlas-transition group relative flex list-none items-center gap-3 rounded-r-[10px] pr-2 hover:bg-accent/50",
        compact ? "min-h-11" : "min-h-12",
        RAIL_INSET,
        className,
      )}
    >
      <RailLine />
      <RailNode past={past} />
      <span
        className={cn(TIME_COLUMN, "top-1/2 -translate-y-1/2")}
        data-row-time=""
      >
        {time}
      </span>
      {children}
      {trailing}
    </li>
  );
}

/** The 28px tick at the end of a row, inside a 44px target: empty before, filled with a check when done. */
export function TickGlyph({ done }: { done: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "atlas-transition flex size-7 items-center justify-center rounded-full border-2",
        done
          ? "border-success bg-success text-success-foreground"
          : "border-input bg-transparent group-hover:border-foreground",
      )}
    >
      {done ? <Check className="size-3.5" strokeWidth={3} /> : null}
    </span>
  );
}

/** "5 h 30 m" for a gap in seconds (whole minutes; "3 h" when the minutes are nought). */
export function gapLabel(seconds: number): string {
  const minutes = Math.round(seconds / 60);
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m} m`;
  return m === 0 ? `${h} h` : `${h} h ${m} m`;
}
