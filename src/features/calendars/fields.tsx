import { type InputHTMLAttributes, useId } from "react";

/**
 * The calendar forms' fields: a label, the shared field look (`components/ui/input.tsx`), and the field's own message under it. A
 * SECRET field (a connection's URL or token) is marked `data-atlas-sensitive` and never autocompleted, so `buildSnapshot` refuses it
 * (Q4, Q22), and its callers leave it UNCONTROLLED: React mirrors a controlled input's value into its `value` attribute, which any
 * serialisation of the page (a DOM snapshot, an error report) would carry. A secret lives in the element's property and in the
 * form's state only, and leaves with the form.
 */
export function Field({
  label,
  error,
  hint,
  secret = false,
  ...rest
}: Omit<InputHTMLAttributes<HTMLInputElement>, "className"> & {
  label: string;
  error?: string | null;
  hint?: string;
  secret?: boolean;
}) {
  const id = useId();
  const errorId = `${id}-error`;
  const hintId = `${id}-hint`;
  const described = [hint ? hintId : null, error ? errorId : null]
    .filter(Boolean)
    .join(" ");
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-medium text-foreground">
        {label}
      </label>
      <input
        {...rest}
        id={id}
        {...(secret
          ? {
              "data-atlas-sensitive": "",
              autoComplete: "off",
              spellCheck: false,
            }
          : {})}
        aria-invalid={error ? true : undefined}
        aria-describedby={described === "" ? undefined : described}
        data-field-edge=""
        className="atlas-transition box-border min-h-11 w-full rounded-md border border-input bg-background px-3 py-2.5 text-sm text-foreground placeholder:text-muted-foreground"
      />
      {hint ? (
        <p id={hintId} className="text-xs leading-[1.5] text-muted-foreground">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p
          id={errorId}
          data-field-error=""
          className="text-xs leading-[1.5] text-foreground"
        >
          {error}
        </p>
      ) : null}
    </div>
  );
}

/** IANA zones the browser knows, as suggestions for a timezone field (the field accepts any name; the server decides). */
export function TimezoneSuggestions({ id }: { id: string }) {
  const zones: readonly string[] = (() => {
    try {
      const supported = (
        Intl as unknown as { supportedValuesOf?(key: string): string[] }
      ).supportedValuesOf;
      return supported ? supported("timeZone") : [];
    } catch {
      return [];
    }
  })();
  return (
    <datalist id={id}>
      {zones.map((zone) => (
        <option key={zone} value={zone} />
      ))}
    </datalist>
  );
}

/** A message the form shows above its actions (a refusal, a failed save): text only, never a value the person typed. */
export function FormMessage({ message }: { message: string | null }) {
  if (message === null) return null;
  return (
    <p
      data-form-message=""
      className="rounded-lg border border-border bg-card p-3 text-xs leading-relaxed text-foreground"
    >
      {message}
    </p>
  );
}
