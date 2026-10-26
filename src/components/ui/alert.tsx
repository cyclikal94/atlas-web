import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentProps } from "react";
import { cn } from "../../lib/utils";

/**
 * shadcn/ui's alert, with the Atlas tones. An alert here is STATIC content (rule R6): a caller that needs an announcement goes
 * through the announcer. Tone is never colour alone: the title and the words carry the state.
 */
export const alertVariants = cva(
  "relative grid w-full grid-cols-[0_1fr] items-start gap-y-1 rounded-lg border px-4 py-3.5 text-sm has-[>svg]:grid-cols-[calc(var(--spacing)*4)_1fr] has-[>svg]:gap-x-3 [&>svg]:size-4 [&>svg]:translate-y-0.5",
  {
    variants: {
      variant: {
        default: "bg-card text-card-foreground [&>svg]:text-primary",
        destructive:
          "border-destructive/35 bg-destructive/10 text-foreground [&>svg]:text-destructive",
        warning:
          "border-warning/35 bg-warning/10 text-foreground [&>svg]:text-warning",
        success:
          "border-success/35 bg-success/10 text-foreground [&>svg]:text-success",
        accent:
          "border-primary/25 bg-accent text-accent-foreground [&>svg]:text-primary",
      },
    },
    defaultVariants: { variant: "default" },
  },
);

export type AlertVariant = NonNullable<
  VariantProps<typeof alertVariants>["variant"]
>;

export function Alert({
  className,
  variant,
  ...props
}: ComponentProps<"section"> & VariantProps<typeof alertVariants>) {
  return (
    <section
      data-slot="alert"
      className={cn(alertVariants({ variant }), className)}
      {...props}
    />
  );
}

export function AlertTitle({ className, ...props }: ComponentProps<"h2">) {
  return (
    <h2
      data-slot="alert-title"
      className={cn(
        "col-start-2 min-h-4 font-semibold leading-snug tracking-tight",
        className,
      )}
      {...props}
    />
  );
}

export function AlertDescription({
  className,
  ...props
}: ComponentProps<"div">) {
  return (
    <div
      data-slot="alert-description"
      className={cn(
        "col-start-2 grid justify-items-start gap-1.5 text-sm leading-relaxed text-muted-foreground [&_p]:leading-relaxed",
        className,
      )}
      {...props}
    />
  );
}
