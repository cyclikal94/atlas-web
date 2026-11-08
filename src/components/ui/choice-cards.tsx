import { Lock } from "lucide-react";
import { type ReactNode, useId } from "react";
import { cn } from "../../lib/utils";

export interface ChoiceCardOption<Value extends string> {
  value: Value;
  label: ReactNode;
  /** One line under the label: what choosing it means. */
  description?: ReactNode;
}

/**
 * A group of choices as cards (the Final design's form kit, 8 November 2026): one fieldset with its legend, native radios (so a label
 * query, a form library and a password manager all see ordinary controls), each option a card with its label and one line of meaning,
 * the chosen one marked by its ring's dot, the primary border and the accent tint, never colour alone. `locked` names why the choice
 * cannot change (the cards are disabled and a lock glyph says so); `columns` lays short options side by side from the tablet up.
 */
export function ChoiceCards<Value extends string>({
  legend,
  name,
  value,
  onChange,
  options,
  locked,
  hint,
  error,
  errorId,
  columns = 1,
  legendHidden = false,
  ...rest
}: {
  legend: string;
  /** The legend is for assistive technology only (the section around the cards already carries the words). */
  legendHidden?: boolean;
  name: string;
  value: Value;
  onChange(value: Value): void;
  options: readonly ChoiceCardOption<Value>[];
  /** Why the choice cannot change now (the cards are disabled). */
  locked?: string;
  hint?: ReactNode;
  error?: string;
  errorId?: string;
  columns?: 1 | 2 | 3;
  [data: `data-${string}`]: string | undefined;
}) {
  const ids = useId();
  const grid =
    columns === 3
      ? "grid gap-2 tablet:grid-cols-3"
      : columns === 2
        ? "grid gap-2 tablet:grid-cols-2"
        : "grid gap-2";
  return (
    <fieldset
      {...rest}
      className="flex min-w-0 flex-col gap-2"
      aria-describedby={error && errorId ? errorId : undefined}
    >
      <legend
        className={
          legendHidden ? "sr-only" : "mb-2 text-sm font-medium text-foreground"
        }
      >
        {legend}
      </legend>
      <div className={grid}>
        {options.map((option) => (
          // The radio is named by its label alone (`aria-labelledby`) and described by the line under it, so a query by name finds it.
          <label
            key={option.value}
            className={cn(
              "atlas-transition flex min-h-11 cursor-pointer items-start gap-3 rounded-lg border border-border bg-background px-3 py-2.5 text-sm text-foreground shadow-xs",
              "has-[:checked]:border-primary has-[:checked]:bg-accent has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-ring hover:border-input hover:bg-accent/40",
              locked
                ? "cursor-not-allowed opacity-70 hover:border-border hover:bg-background"
                : "",
            )}
          >
            <span className="relative mt-0.5 flex size-4 flex-none items-center justify-center rounded-full border border-input bg-background has-[:checked]:border-primary">
              <input
                type="radio"
                name={name}
                value={option.value}
                checked={value === option.value}
                disabled={locked !== undefined}
                aria-labelledby={`${ids}-${option.value}-label`}
                aria-describedby={
                  option.description
                    ? `${ids}-${option.value}-description`
                    : undefined
                }
                onChange={() => onChange(option.value)}
                className="peer absolute inset-0 z-[1] size-full cursor-pointer appearance-none rounded-full disabled:cursor-not-allowed"
              />
              {/* The dot never takes the pointer: a click (a person's or a test's) lands on the radio itself. */}
              <span
                aria-hidden="true"
                className="pointer-events-none size-2 rounded-full bg-primary opacity-0 peer-checked:opacity-100"
              />
            </span>
            <span className="flex min-w-0 flex-col gap-0.5">
              <span id={`${ids}-${option.value}-label`} className="font-medium">
                {option.label}
              </span>
              {option.description ? (
                <span
                  id={`${ids}-${option.value}-description`}
                  className="text-xs text-muted-foreground"
                >
                  {option.description}
                </span>
              ) : null}
            </span>
          </label>
        ))}
      </div>
      {locked ? (
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Lock aria-hidden="true" className="size-3.5 flex-none" />
          {locked}
        </p>
      ) : hint ? (
        <p className="text-xs text-muted-foreground">{hint}</p>
      ) : null}
      {error ? (
        <p id={errorId} className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </fieldset>
  );
}
