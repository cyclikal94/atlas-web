import {
  type ReactNode,
  type RefObject,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { cn } from "../../lib/utils";
import { enterFocusLoop } from "./focus-loop";

/**
 * The box a popover is placed in (the Final design, FD_EditPopover): a short editor opens directly under the control that was pressed,
 * left-aligned with it and clamped to this box's width (on a narrow box it spans the box). The host is the positioned ancestor the
 * popover measures against, so it wraps the controls and nothing clips it.
 */
export function PopoverHost({
  className,
  children,
  ...rest
}: {
  className?: string;
  children: ReactNode;
  [data: `data-${string}`]: string | undefined;
}) {
  return (
    <div {...rest} className={cn("relative", className)}>
      {children}
    </div>
  );
}

const GAP = 6;

/**
 * A popover under its anchor: a dialog of short choices that saves on choice and closes on Escape, a click outside or when its work is
 * done. Focus moves to the pressed choice (or the first control) when it opens and returns to the anchor when it closes.
 */
export function Popover({
  anchor,
  open,
  onClose,
  label,
  width = 320,
  className,
  children,
  ...rest
}: {
  anchor: RefObject<HTMLElement | null>;
  open: boolean;
  onClose(): void;
  label: string;
  /** The popover's width before it is clamped to the host. */
  width?: number;
  className?: string;
  children: ReactNode;
  [data: `data-${string}`]: string | undefined;
}) {
  const node = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<{
    left: number;
    top: number;
    width: number;
  } | null>(null);
  useLayoutEffect(() => {
    if (!open) {
      setPlace(null);
      return;
    }
    const measure = () => {
      const cell = anchor.current;
      const host = cell?.offsetParent;
      if (!cell || !(host instanceof HTMLElement)) {
        setPlace({ left: 0, top: 0, width });
        return;
      }
      const room = host.clientWidth;
      const wide = Math.min(width, room);
      const left = Math.max(0, Math.min(cell.offsetLeft, room - wide));
      setPlace({
        left,
        top: cell.offsetTop + cell.offsetHeight + GAP,
        width: wide,
      });
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [open, anchor, width]);
  useEffect(() => {
    if (!open) return;
    const box = node.current;
    if (!box) return;
    const first =
      box.querySelector<HTMLElement>('[aria-pressed="true"]') ??
      box.querySelector<HTMLElement>(
        "button:not([disabled]), input:not([disabled]), a[href]",
      );
    first?.focus();
    const release = enterFocusLoop(box);
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      onClose();
    };
    const onPointer = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (box.contains(target) || anchor.current?.contains(target)) return;
      onClose();
    };
    box.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointer, true);
    const back = anchor.current;
    return () => {
      release();
      box.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointer, true);
      if (back?.isConnected) back.focus();
    };
  }, [open, onClose, anchor]);
  if (!open) return null;
  return (
    <div
      {...rest}
      ref={node}
      role="dialog"
      aria-label={label}
      style={
        place === null
          ? { left: 0, top: 0, width }
          : { left: place.left, top: place.top, width: place.width }
      }
      className={cn(
        "atlas-popover absolute z-30 flex flex-col gap-2.5 rounded-[14px] border border-border bg-popover p-3 text-popover-foreground shadow-[0_24px_60px_-20px_rgba(0,0,0,.85)]",
        className,
      )}
    >
      <span className="px-1 pt-0.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
        {label}
      </span>
      {children}
    </div>
  );
}

/** One choice of a popover: a pill that is pressed when it is the current value; the choice saves as it is pressed. */
export function Choice({
  pressed = false,
  disabled = false,
  onClick,
  className,
  children,
  ...rest
}: {
  pressed?: boolean;
  disabled?: boolean;
  onClick(): void;
  className?: string;
  children: ReactNode;
  "aria-label"?: string;
  [data: `data-${string}`]: string | undefined;
}) {
  return (
    <button
      {...rest}
      type="button"
      aria-pressed={pressed}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "atlas-press inline-flex h-[34px] min-w-0 items-center justify-center rounded-full border px-2.5 text-[13px] leading-none disabled:cursor-not-allowed disabled:opacity-60",
        pressed
          ? "border-primary bg-primary/15 font-semibold text-foreground"
          : "border-border bg-background text-muted-foreground hover:bg-accent hover:text-accent-foreground",
        className,
      )}
    >
      {children}
    </button>
  );
}
