import * as RadioGroup from "@radix-ui/react-radio-group";
import type { ReactNode } from "react";

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
 * Card-style radio group (accessibility.md 1.5): role radiogroup, roving tabindex, arrows move and select,
 * Space checks. The state is never colour alone: a 15px ring (field-edge) holds a filled dot when selected,
 * and the selected card also takes the action-fill border (findings F5, F8).
 */
export function RadioCardGroup<Value extends string>({
  label,
  value,
  onValueChange,
  options,
}: RadioCardGroupProps<Value>) {
  return (
    <RadioGroup.Root
      aria-label={label}
      value={value}
      onValueChange={(next) => onValueChange(next as Value)}
      className="flex gap-2"
    >
      {options.map((option) => (
        <RadioGroup.Item
          key={option.value}
          value={option.value}
          data-contract-id={option.contractId}
          className="atlas-transition flex min-w-0 flex-1 flex-col gap-2 rounded-row border border-hairline-strong bg-canvas p-3 text-left hover:border-field-edge data-[state=checked]:border-action-fill"
        >
          {option.preview ? (
            <span aria-hidden="true" className="block">
              {option.preview}
            </span>
          ) : null}
          <span className="flex items-center gap-2">
            <span
              aria-hidden="true"
              className="flex size-[15px] flex-none items-center justify-center rounded-round border-[1.5px] border-field-edge"
            >
              <RadioGroup.Indicator className="size-[7px] rounded-round bg-action-fill" />
            </span>
            <span className="text-[13px] font-medium text-ink-1">
              {option.label}
            </span>
          </span>
        </RadioGroup.Item>
      ))}
    </RadioGroup.Root>
  );
}
