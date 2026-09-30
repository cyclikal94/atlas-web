import { type ButtonHTMLAttributes, type ReactNode, useId } from "react";

export type ButtonVariant = "primary" | "secondary" | "quiet";

type BaseProps = Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  "className" | "disabled" | "children"
> & {
  variant?: ButtonVariant;
  children: ReactNode;
};

/** A disabled control always states why, beside it (design README: never an enabled control that fails on submit). */
export type ButtonProps = BaseProps &
  (
    | { disabled?: false; reason?: undefined }
    | { disabled: true; reason: string }
  );

const VARIANT: Record<ButtonVariant, string> = {
  primary: "bg-action-fill text-action-on hover:bg-action-hover font-medium",
  secondary:
    "bg-raised border border-hairline-strong text-ink-1 hover:bg-row-hover",
  quiet: "text-ink-2 hover:text-ink-1",
};

export function Button({
  variant = "secondary",
  disabled,
  reason,
  type = "button",
  children,
  ...rest
}: ButtonProps) {
  const reasonId = useId();
  const button = (
    <button
      {...rest}
      type={type}
      disabled={disabled}
      aria-describedby={disabled ? reasonId : rest["aria-describedby"]}
      className={`atlas-transition inline-flex min-h-11 items-center justify-center gap-2 rounded-control px-4 py-2.5 text-[13.5px] disabled:opacity-60 ${VARIANT[variant]}`}
    >
      {children}
    </button>
  );
  if (!disabled) return button;
  return (
    <span className="inline-flex flex-col items-start gap-1">
      {button}
      <span id={reasonId} className="text-[12px] text-ink-2">
        {reason}
      </span>
    </span>
  );
}
