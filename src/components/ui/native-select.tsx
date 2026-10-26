import { ChevronDownIcon } from "lucide-react";
import type { ComponentProps } from "react";
import { cn } from "../../lib/utils";

/**
 * shadcn/ui's native select: the platform's own picker (keyboard, screen readers and mobile sheets all come for free, and
 * nothing injects a style element, which the content security policy would refuse) with the kit's field styling.
 */
export function NativeSelect({
  className,
  ...props
}: ComponentProps<"select">) {
  return (
    <span className="relative inline-flex w-full">
      <select
        data-slot="native-select"
        data-field-edge=""
        className={cn(
          "atlas-transition h-11 w-full min-w-0 appearance-none rounded-md border border-input bg-background py-2 pl-3 pr-9 text-sm text-foreground shadow-xs hover:border-foreground/60 focus-visible:border-ring disabled:cursor-not-allowed disabled:opacity-60",
          className,
        )}
        {...props}
      />
      <ChevronDownIcon
        aria-hidden="true"
        className="pointer-events-none absolute right-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
      />
    </span>
  );
}
