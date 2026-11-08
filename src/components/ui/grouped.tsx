import { ChevronDown } from "lucide-react";
import { type ReactNode, type Ref, useId, useState } from "react";
import { cn } from "../../lib/utils";

/**
 * The grouped box of the Final design: one card whose sections sit on hairlines, each with a dot, a heading, a line of summary at the
 * right and a chevron that folds the section. Decisions and reference live here (a task's "What needs doing first", a person's fields
 * and sharing); the facts of a page stay in its facts strip. Sections are open unless the caller says otherwise, so nothing a test or a
 * reader looks for is folded away by default, and only the chevron folds one: the heading is a heading, never a control, so a click on
 * it (a reader's, or a test's focus anchor) changes nothing.
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

export const GROUPED_COPY = {
  fold: "Fold this section",
  unfold: "Unfold this section",
} as const;

export interface GroupedSectionProps {
  /** The heading element (an h2 or h3 with its id), so the section keeps its level and its label. */
  heading: ReactNode;
  /** Said beside the heading: a count, a state, a short answer. */
  summary?: ReactNode;
  /** The dot before the heading: muted unless the section needs attention. */
  dot?: "muted" | "primary" | "success" | "warning" | "destructive";
  open?: boolean;
  children: ReactNode;
  /** The section element itself, for a caller that scrolls to it or measures it. */
  sectionRef?: Ref<HTMLElement>;
  "aria-labelledby"?: string;
  "aria-label"?: string;
  className?: string;
  [data: `data-${string}`]: string | undefined;
}

export function GroupedSection({
  heading,
  summary,
  dot = "muted",
  open: initiallyOpen = true,
  children,
  sectionRef,
  className,
  ...rest
}: GroupedSectionProps) {
  const [open, setOpen] = useState(initiallyOpen);
  const bodyId = useId();
  return (
    <section
      {...rest}
      ref={sectionRef}
      className={cn("flex flex-col", className)}
    >
      <div className="flex min-h-[52px] items-center gap-3.5 px-4 text-sm font-semibold text-foreground tablet:px-5">
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
        <button
          type="button"
          aria-expanded={open}
          aria-controls={bodyId}
          aria-label={open ? GROUPED_COPY.fold : GROUPED_COPY.unfold}
          data-grouped-toggle=""
          onClick={() => setOpen((value) => !value)}
          className="atlas-transition -mr-2 flex size-11 flex-none items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-accent-foreground"
        >
          <ChevronDown
            aria-hidden="true"
            className={cn(
              "size-4 transition-transform",
              open ? "rotate-180" : "",
            )}
          />
        </button>
      </div>
      <div
        id={bodyId}
        hidden={!open}
        className="flex flex-col gap-3 px-4 pb-4 tablet:pr-5 tablet:pb-[18px] tablet:pl-[42px]"
      >
        {children}
      </div>
    </section>
  );
}
