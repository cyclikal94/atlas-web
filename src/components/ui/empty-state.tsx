import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "../../lib/utils";

/**
 * shadcn/ui's empty pattern: an icon in a tinted tile, one line of copy, and optionally an action. The copy is the caller's
 * (the accepted deck), so this only frames it. The tile is decorative; the text carries the meaning.
 */
export function EmptyState({
  icon: Icon,
  children,
  action,
  compact = false,
  className,
  ...rest
}: {
  icon: LucideIcon;
  children: ReactNode;
  action?: ReactNode;
  /** Less vertical room, for a pane rather than a page. */
  compact?: boolean;
  className?: string;
  [data: `data-${string}`]: string | undefined;
}) {
  return (
    <div
      {...rest}
      className={cn(
        "flex flex-col items-center gap-3 rounded-xl border border-dashed p-6 text-center",
        compact ? "py-8" : "py-12",
        className,
      )}
    >
      <span
        aria-hidden="true"
        className="flex size-11 items-center justify-center rounded-lg border border-primary/25 bg-accent text-primary"
      >
        <Icon className="size-5" strokeWidth={1.75} />
      </span>
      <p className="max-w-[360px] text-sm leading-relaxed text-muted-foreground">
        {children}
      </p>
      {action ? <div className="mt-1">{action}</div> : null}
    </div>
  );
}
