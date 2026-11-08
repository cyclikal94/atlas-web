import { ChevronDown } from "lucide-react";
import { type ReactNode, useId, useState } from "react";
import { useLayoutMode } from "../../app/shell/layout-mode";
import { cn } from "../../lib/utils";
import { Button } from "./button";

export const PAGE_ACTIONS_COPY = {
  show: "Actions",
} as const;

/**
 * A page header's actions (the Final design, 8 November 2026). From the tablet up the controls sit in one wrapping row under the title,
 * as before. On the phone they fold behind one "Actions" disclosure, so the title, its facts and the day's work are reached first and a
 * row of four or five buttons (and their reasons) does not take the first screen. The disclosure is a plain button with `aria-expanded`
 * and `aria-controls`; the controls render in place when open, so nothing is portalled or trapped.
 */
export function PageActions({
  children,
  label = PAGE_ACTIONS_COPY.show,
  className,
  ...rest
}: {
  children: ReactNode;
  /** The phone disclosure's label. */
  label?: string;
  className?: string;
  [data: `data-${string}`]: string | undefined;
}) {
  const mode = useLayoutMode();
  const [open, setOpen] = useState(false);
  const id = useId();
  const row = (
    <div
      id={id}
      className={cn("flex flex-wrap items-start gap-2", className)}
      data-page-actions-row=""
    >
      {children}
    </div>
  );
  if (mode !== "mobile") return row;
  return (
    <div
      className="flex flex-col gap-3"
      data-page-actions={open ? "open" : "folded"}
      {...rest}
    >
      <span>
        <Button
          variant="outline"
          aria-expanded={open}
          aria-controls={id}
          onClick={() => setOpen((value) => !value)}
        >
          {label}
          <ChevronDown
            aria-hidden="true"
            className={cn(
              "size-4 transition-transform",
              open ? "rotate-180" : "",
            )}
          />
        </Button>
      </span>
      {open ? row : null}
    </div>
  );
}
