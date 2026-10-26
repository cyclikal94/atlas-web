import * as RadioGroupPrimitive from "@radix-ui/react-radio-group";
import type { ReactNode } from "react";
import { cn } from "../../lib/utils";

export interface RadioCardOption<Value extends string> {
  value: Value;
  label: string;
  /** Decorative preview; hidden from assistive technology. */
  preview?: ReactNode;
  /** Stable contract identifier for tests. Never used as a title or an accessible name. */
  contractId?: string;
}

export interface RadioCardGroupProps<Value extends string> {
  label: string;
  value: Value;
  onValueChange(value: Value): void;
  options: readonly RadioCardOption<Value>[];
}

/**
 * Card-style radio group (accessibility.md 1.5): role radiogroup, roving tabindex, arrows move and select, Space checks. The
 * state is never colour alone: a 16px ring (`border-input`) holds a primary dot when selected, and the selected card also takes
 * the primary border and the accent tint.
 */
export function RadioCardGroup<Value extends string>({
  label,
  value,
  onValueChange,
  options,
}: RadioCardGroupProps<Value>) {
  return (
    <RadioGroupPrimitive.Root
      aria-label={label}
      value={value}
      onValueChange={(next) => onValueChange(next as Value)}
      className="grid grid-cols-3 gap-2"
    >
      {options.map((option) => (
        <RadioGroupPrimitive.Item
          key={option.value}
          value={option.value}
          data-contract-id={option.contractId}
          className={cn(
            "atlas-transition flex min-w-0 flex-col gap-3 rounded-lg border border-border bg-background p-3 text-left shadow-xs",
            "hover:border-input hover:bg-accent/40 data-[state=checked]:border-primary data-[state=checked]:bg-accent",
          )}
        >
          {option.preview ? (
            <span aria-hidden="true" className="block">
              {option.preview}
            </span>
          ) : null}
          <span className="flex items-center gap-2">
            <span
              aria-hidden="true"
              className="flex size-4 flex-none items-center justify-center rounded-full border border-input bg-background"
            >
              <RadioGroupPrimitive.Indicator className="size-2 rounded-full bg-primary" />
            </span>
            <span className="text-sm font-medium text-foreground">
              {option.label}
            </span>
          </span>
        </RadioGroupPrimitive.Item>
      ))}
    </RadioGroupPrimitive.Root>
  );
}
