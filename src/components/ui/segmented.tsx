import { cn } from "../../lib/utils";

/**
 * A segmented control (the Final design's "Graph | List", "This week | This month | All"): a few pressed buttons in one recessed track.
 * One is pressed at a time; the words carry the choice.
 */
export function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
  className,
}: {
  label: string;
  value: T;
  options: readonly { value: T; label: string }[];
  onChange(value: T): void;
  className?: string;
}) {
  return (
    <fieldset
      className={cn(
        "m-0 inline-flex gap-1 rounded-[10px] border-0 bg-muted p-1",
        className,
      )}
    >
      <legend className="sr-only">{label}</legend>
      {options.map((option) => {
        const pressed = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={pressed}
            onClick={() => onChange(option.value)}
            className={cn(
              "atlas-transition h-9 rounded-[7px] px-3.5 text-[13px]",
              pressed
                ? "bg-card font-semibold text-foreground shadow-xs"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {option.label}
          </button>
        );
      })}
    </fieldset>
  );
}
