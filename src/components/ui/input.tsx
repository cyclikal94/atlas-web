import { type InputHTMLAttributes, type Ref, useId } from "react";
import { cn } from "../../lib/utils";
import { Label } from "./label";

/**
 * shadcn/ui's input, held to Q17: the edge is always `border-input` (declared at 3:1 against the page and a card, never a
 * hairline) and the fill is `background`, so the border reads wherever the field sits. 44px tall for touch.
 */
export const inputClass =
  "atlas-transition h-11 w-full min-w-0 rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground shadow-xs placeholder:text-muted-foreground hover:border-foreground/60 focus-visible:border-ring disabled:cursor-not-allowed disabled:opacity-60 aria-invalid:border-destructive file:border-0 file:bg-transparent file:text-sm file:font-medium";

type LabelProps =
  | { label: string; "aria-labelledby"?: undefined; "aria-label"?: undefined }
  | { label?: undefined; "aria-labelledby": string; "aria-label"?: undefined }
  | { label?: undefined; "aria-labelledby"?: undefined; "aria-label": string };

export type InputProps = Omit<
  InputHTMLAttributes<HTMLInputElement>,
  "aria-label" | "aria-labelledby"
> &
  LabelProps & {
    /** React 19 passes `ref` as a prop: a form moves focus to the field a message belongs to. */
    ref?: Ref<HTMLInputElement>;
  };

export function Input({ label, id, className, ...rest }: InputProps) {
  const generated = useId();
  const inputId = id ?? generated;
  const field = (
    <input
      data-slot="input"
      {...rest}
      id={inputId}
      data-field-edge=""
      className={cn(inputClass, className)}
    />
  );
  if (!label) return field;
  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor={inputId}>{label}</Label>
      {field}
    </div>
  );
}
