import type { ComponentProps } from "react";
import { cn } from "../../lib/utils";

/** A loading placeholder. Decorative: the caller supplies the `sr-only` sentence and `aria-busy`. */
export function Skeleton({ className, ...props }: ComponentProps<"span">) {
  return (
    <span
      data-slot="skeleton"
      aria-hidden="true"
      className={cn("block animate-pulse rounded-md bg-muted", className)}
      {...props}
    />
  );
}
