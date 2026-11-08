import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "../../lib/utils";

export type ChipTone =
  | "muted"
  | "primary"
  | "success"
  | "warning"
  | "destructive";

const TONE: Record<ChipTone, string> = {
  muted: "bg-muted text-muted-foreground",
  primary: "bg-muted text-primary",
  success: "bg-success/12 text-success",
  warning: "bg-muted text-warning",
  destructive: "bg-muted text-destructive",
};

/**
 * A badge on a row (the Final design): 28px, a small glyph and a short figure or word, in the tone of what it says. Never colour alone:
 * the words, or the glyph's accessible name, carry the meaning.
 */
export function Chip({
  tone = "muted",
  icon: Icon,
  iconLabel,
  children,
  className,
  ...rest
}: {
  tone?: ChipTone;
  icon?: LucideIcon;
  /** The glyph's meaning when the figure alone would not say it ("streak", "waits on"). */
  iconLabel?: string;
  children: ReactNode;
  className?: string;
  [data: `data-${string}`]: string | undefined;
}) {
  return (
    <span
      {...rest}
      className={cn(
        "inline-flex h-7 flex-none items-center gap-1.5 rounded-full px-2.5 text-xs leading-none",
        TONE[tone],
        className,
      )}
    >
      {Icon ? (
        <Icon
          aria-hidden={iconLabel ? undefined : "true"}
          aria-label={iconLabel}
          role={iconLabel ? "img" : undefined}
          className="size-3.5"
          strokeWidth={1.9}
        />
      ) : null}
      {children}
    </span>
  );
}

/** The classes of a pressed pill (a choice among a few: "Skip", "Later", "This week"), 34px and rounded, lit when pressed. */
export const pillClass = (pressed: boolean) =>
  cn(
    "atlas-transition inline-flex h-[34px] items-center justify-center gap-1.5 rounded-full border px-3 text-[13px]",
    pressed
      ? "border-primary bg-accent font-semibold text-accent-foreground"
      : "border-border bg-background text-foreground hover:bg-accent hover:text-accent-foreground",
  );

/** A pressed pill: a button with `aria-pressed`. */
export function Pill({
  pressed = false,
  className,
  children,
  ...rest
}: {
  pressed?: boolean;
  className?: string;
  children: ReactNode;
  onClick?(): void;
  disabled?: boolean;
  "aria-label"?: string;
  [data: `data-${string}`]: string | undefined;
}) {
  return (
    <button
      {...rest}
      type="button"
      aria-pressed={pressed}
      className={cn(pillClass(pressed), "disabled:opacity-50", className)}
    >
      {children}
    </button>
  );
}
