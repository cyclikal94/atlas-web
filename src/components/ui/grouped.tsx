import { ChevronDown } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "../../lib/utils";

/**
 * The grouped box of the Final design: one card whose sections sit on hairlines, each a disclosure with a dot, a heading, a line of
 * summary at the right and a chevron. Decisions and reference live here (a task's "Needs doing first", a person's fields and sharing);
 * the facts of a page stay in its facts strip. Sections are open unless the caller says otherwise, so nothing a test or a reader looks
 * for is folded away by default.
 */
export function GroupedBox({
  children,
  className,
  ...rest
}: {
  children: ReactNode;
  className?: string;
  [data: `data-${string}`]: string | undefined;
}) {
  return (
    <div
      {...rest}
      className={cn(
        "divide-y divide-border overflow-hidden rounded-[14px] border border-border bg-card",
        className,
      )}
    >
      {children}
    </div>
  );
}

const DOT: Record<NonNullable<GroupedSectionProps["dot"]>, string> = {
  muted: "bg-border",
  primary: "bg-primary",
  success: "bg-success",
  warning: "bg-warning",
  destructive: "bg-destructive",
};

export interface GroupedSectionProps {
  /** The heading element (an h2 or h3 with its id), so the section keeps its level and its label. */
  heading: ReactNode;
  /** Said beside the heading: a count, a state, a short answer. */
  summary?: ReactNode;
  /** The dot before the heading: muted unless the section needs attention. */
  dot?: "muted" | "primary" | "success" | "warning" | "destructive";
  open?: boolean;
  children: ReactNode;
  "aria-labelledby"?: string;
  className?: string;
  [data: `data-${string}`]: string | undefined;
}

export function GroupedSection({
  heading,
  summary,
  dot = "muted",
  open = true,
  children,
  className,
  ...rest
}: GroupedSectionProps) {
  return (
    <section {...rest} className={cn("flex flex-col", className)}>
      <details open={open} className="group/section">
        <summary className="flex min-h-[52px] cursor-pointer list-none items-center gap-3.5 px-4 text-sm font-semibold text-foreground tablet:px-5 [&::-webkit-details-marker]:hidden">
          <span
            aria-hidden="true"
            className={cn("size-2 flex-none rounded-full", DOT[dot])}
          />
          <span className="min-w-0 flex-1 [&>h2]:text-sm [&>h2]:font-semibold [&>h3]:text-sm [&>h3]:font-semibold">
            {heading}
          </span>
          {summary ? (
            <span className="min-w-0 truncate text-[13px] font-normal text-muted-foreground">
              {summary}
            </span>
          ) : null}
          <ChevronDown
            aria-hidden="true"
            className="size-4 flex-none text-muted-foreground transition-transform group-open/section:rotate-180"
          />
        </summary>
        <div className="flex flex-col gap-3 px-4 pb-4 tablet:pl-[42px] tablet:pr-5 tablet:pb-[18px]">
          {children}
        </div>
      </details>
    </section>
  );
}
