import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { type ButtonHTMLAttributes, type ReactNode, useId } from "react";
import { cn } from "../../lib/utils";

/**
 * shadcn/ui's button, with the Atlas touch rule folded into the size scale: the default control is 44px tall (design README),
 * `sm` is for dense rows and `icon` is a 44px square.
 */
export const buttonVariants = cva(
  "atlas-transition inline-flex shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default:
          "bg-primary text-primary-foreground shadow-xs hover:bg-primary/90",
        destructive:
          "bg-destructive text-destructive-foreground shadow-xs hover:bg-destructive/90",
        outline:
          "border border-border bg-card text-foreground shadow-xs hover:bg-accent hover:text-accent-foreground",
        secondary:
          "bg-secondary text-secondary-foreground shadow-xs hover:bg-secondary/80",
        ghost: "text-foreground hover:bg-accent hover:text-accent-foreground",
        link: "text-primary underline-offset-4 hover:underline",
      },
      size: {
        default: "h-11 px-4 py-2 has-[>svg]:px-3.5",
        sm: "h-9 gap-1.5 rounded-md px-3 has-[>svg]:px-2.5",
        lg: "h-12 rounded-md px-6 has-[>svg]:px-5",
        icon: "size-11",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

export type ButtonVariant = NonNullable<
  VariantProps<typeof buttonVariants>["variant"]
>;
export type ButtonSize = NonNullable<
  VariantProps<typeof buttonVariants>["size"]
>;

type BaseProps = Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  "disabled" | "children"
> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Render the child element (a router Link) with the button's classes instead of a <button>. */
  asChild?: boolean;
  children: ReactNode;
};

/** A disabled control always states why, beside it (design README: never an enabled control that fails on submit). */
export type ButtonProps = BaseProps &
  (
    | { disabled?: false; reason?: undefined }
    | { disabled: true; reason: string }
  );

export function Button({
  variant = "outline",
  size = "default",
  asChild = false,
  className,
  disabled,
  reason,
  type = "button",
  children,
  ...rest
}: ButtonProps) {
  const reasonId = useId();
  const Comp = asChild ? Slot : "button";
  // A disabled control is described by its reason FIRST and then by anything the caller associated with it (a consequence, a rule).
  const extra = rest["aria-describedby"];
  const button = (
    <Comp
      data-slot="button"
      {...rest}
      {...(asChild ? {} : { type })}
      disabled={disabled}
      aria-describedby={
        disabled ? (extra ? `${reasonId} ${extra}` : reasonId) : extra
      }
      className={cn(buttonVariants({ variant, size }), className)}
    >
      {children}
    </Comp>
  );
  if (!disabled) return button;
  return (
    <span className="inline-flex flex-col items-start gap-1">
      {button}
      <span
        id={reasonId}
        className="text-xs leading-[1.5] text-muted-foreground"
      >
        {reason}
      </span>
    </span>
  );
}
