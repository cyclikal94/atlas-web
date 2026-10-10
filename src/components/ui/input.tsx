import { type InputHTMLAttributes, type Ref, useId } from "react";
/**
 * The shared input (Q17). Its edge is always field-edge, never hairline, and it fills only from canvas or panel:
 * light field-edge is below 3:1 on raised and chrome (docs/design-tokens.md, finding F1).
 */
export type InputSurface = "canvas" | "panel";

type LabelProps =
  | { label: string; "aria-labelledby"?: undefined; "aria-label"?: undefined }
  | { label?: undefined; "aria-labelledby": string; "aria-label"?: undefined }
  | { label?: undefined; "aria-labelledby"?: undefined; "aria-label": string };

export type InputProps = Omit<
  InputHTMLAttributes<HTMLInputElement>,
  "className" | "aria-label" | "aria-labelledby"
> &
  LabelProps & {
    surface?: InputSurface;
    /** React 19 passes `ref` as a prop: a form moves focus to the field a message belongs to. */
    ref?: Ref<HTMLInputElement>;
  };

const SURFACE: Record<InputSurface, string> = {
  canvas: "bg-canvas",
  panel: "bg-panel",
};

export function Input({ label, surface = "canvas", id, ...rest }: InputProps) {
  const generated = useId();
  const inputId = id ?? generated;
  const field = (
    <input
      {...rest}
      id={inputId}
      data-field-edge=""
      className={`atlas-transition min-h-11 w-full rounded-control border border-field-edge px-3 py-2.5 text-[14px] text-ink-1 placeholder:text-ink-3 disabled:opacity-60 ${SURFACE[surface]}`}
    />
  );
  if (!label) return field;
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={inputId} className="text-[13px] font-medium text-ink-1">
        {label}
      </label>
      {field}
    </div>
  );
}
