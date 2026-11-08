import { Link } from "@tanstack/react-router";
import type { ComponentProps, ReactNode } from "react";
import { cn } from "../../lib/utils";

/**
 * The facts strip of the Final design: a bordered grid of short labelled cells (a small uppercase label over one line of value), three
 * across from the tablet up and two on the phone. A cell is plain, a link (to the thing it names) or a button (it opens the editor of
 * the fact it names: a popover for a short choice, a dialog for one with consequences). The dot after a label says the fact needs
 * attention; the words beside it say why.
 */
export function FactsStrip({
  columns = 3,
  className,
  children,
  ...rest
}: {
  columns?: 2 | 3 | 4;
  className?: string;
  children: ReactNode;
  [data: `data-${string}`]: string | undefined;
}) {
  return (
    <div
      {...rest}
      className={cn(
        "grid grid-cols-2 gap-px overflow-hidden rounded-[14px] border border-border bg-border",
        columns === 2
          ? "tablet:grid-cols-2"
          : columns === 4
            ? "tablet:grid-cols-4"
            : "tablet:grid-cols-3",
        className,
      )}
    >
      {children}
    </div>
  );
}

const CELL =
  "flex min-h-[64px] w-full min-w-0 flex-col justify-center gap-1.5 bg-card px-3.5 py-2.5 text-left text-foreground tablet:px-4";
const INTERACTIVE =
  "atlas-transition hover:bg-accent/60 focus-visible:z-[1] focus-visible:outline-offset-[-2px]";

export type FactCellProps = {
  label: ReactNode;
  children: ReactNode;
  /** The label carries a dot: the fact needs the reader (warning) or is a choice made (primary). */
  dot?: "warning" | "primary" | "success";
  /** The cell is pressed (its editor is open). */
  pressed?: boolean;
  className?: string;
  [data: `data-${string}`]: string | undefined;
} & (
  | { as?: "div" }
  | {
      as: "button";
      onClick(): void;
      "aria-label"?: string;
      ref?: ComponentProps<"button">["ref"];
    }
  | {
      as: "link";
      to: string;
      params?: Record<string, string>;
      search?: Record<string, unknown>;
      "aria-label"?: string;
    }
);

const DOT: Record<NonNullable<FactCellProps["dot"]>, string> = {
  warning: "bg-warning",
  primary: "bg-primary",
  success: "bg-success",
};

export function FactCell(props: FactCellProps) {
  const { label, children, dot, pressed, className } = props;
  const data = Object.fromEntries(
    Object.entries(props).filter(([key]) => key.startsWith("data-")),
  );
  const inner = (
    <>
      <span className="flex items-center gap-1.5 whitespace-nowrap text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
        {label}
        {dot ? (
          <span
            aria-hidden="true"
            className={cn("size-1.5 rounded-full", DOT[dot])}
          />
        ) : null}
      </span>
      <span className="flex min-w-0 items-center gap-2 overflow-hidden text-sm font-medium [&>span]:min-w-0 [&>span]:truncate">
        {children}
      </span>
    </>
  );
  if (props.as === "button")
    return (
      <button
        {...data}
        ref={props.ref}
        type="button"
        aria-label={props["aria-label"]}
        aria-expanded={pressed}
        onClick={props.onClick}
        className={cn(
          CELL,
          INTERACTIVE,
          pressed ? "bg-accent/70 shadow-[inset_0_0_0_1px_var(--primary)]" : "",
          className,
        )}
      >
        {inner}
      </button>
    );
  if (props.as === "link")
    return (
      <Link
        {...data}
        to={props.to}
        params={props.params}
        search={props.search}
        aria-label={props["aria-label"]}
        className={cn(CELL, INTERACTIVE, className)}
      >
        {inner}
      </Link>
    );
  return (
    <div {...data} className={cn(CELL, className)}>
      {inner}
    </div>
  );
}
