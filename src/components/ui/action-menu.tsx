import { Link } from "@tanstack/react-router";
import { Ellipsis } from "lucide-react";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { cn } from "../../lib/utils";
import { enterFocusLoop } from "./focus-loop";

export type MenuItem =
  | {
      kind?: "action";
      label: string;
      onSelect(): void;
      /** A disabled item states why, beside it. */
      reason?: string;
      tone?: "default" | "destructive";
    }
  | {
      kind: "link";
      label: string;
      to: string;
      params?: Record<string, string>;
      search?: Record<string, unknown>;
    };

export const MENU_COPY = { more: "More" } as const;

/**
 * The "More" control of a page header (the Final design): a square button that opens a short menu of the page's other actions (edit,
 * sharing, archive), so the header keeps the title and one primary act. A disabled item keeps its words and says why. Escape, a choice
 * and a click outside close it; arrow keys move between items.
 */
export function ActionMenu({
  items,
  label = MENU_COPY.more,
  children,
  className,
  ...rest
}: {
  items: readonly MenuItem[];
  label?: string;
  /** The button's content; the ellipsis glyph by default. */
  children?: ReactNode;
  className?: string;
  [data: `data-${string}`]: string | undefined;
}) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const id = useId();
  useEffect(() => {
    if (!open) return;
    const node = menu.current;
    if (!node) return;
    const itemsOf = () =>
      Array.from(
        node.querySelectorAll<HTMLElement>("[role=menuitem]:not([disabled])"),
      );
    itemsOf()[0]?.focus();
    const release = enterFocusLoop(node);
    const onKey = (event: KeyboardEvent) => {
      const list = itemsOf();
      const index = list.indexOf(document.activeElement as HTMLElement);
      if (event.key === "Escape") {
        event.stopPropagation();
        setOpen(false);
      } else if (event.key === "ArrowDown") {
        event.preventDefault();
        list[(index + 1) % list.length]?.focus();
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        list[(index - 1 + list.length) % list.length]?.focus();
      }
    };
    const onPointer = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (node.contains(target) || button.current?.contains(target)) return;
      setOpen(false);
    };
    node.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointer, true);
    return () => {
      release();
      node.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointer, true);
      if (button.current?.isConnected) button.current.focus();
    };
  }, [open]);
  const item =
    "atlas-transition flex min-h-11 w-full items-center justify-between gap-3 rounded-md px-3 text-left text-sm text-foreground hover:bg-accent hover:text-accent-foreground disabled:cursor-not-allowed disabled:opacity-60";
  return (
    <div className={cn("relative flex-none", className)}>
      <button
        {...rest}
        ref={button}
        type="button"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((value) => !value)}
        className="atlas-transition flex size-11 items-center justify-center rounded-[10px] border border-border text-muted-foreground hover:bg-accent hover:text-accent-foreground"
      >
        {children ?? <Ellipsis aria-hidden="true" className="size-[18px]" />}
      </button>
      {open ? (
        <div
          ref={menu}
          id={id}
          role="menu"
          aria-label={label}
          className="absolute right-0 top-full z-30 mt-2 flex w-64 flex-col gap-0.5 rounded-[12px] border border-border bg-popover p-1.5 text-popover-foreground shadow-[0_24px_60px_-20px_rgba(0,0,0,.85)]"
        >
          {items.map((entry, index) =>
            entry.kind === "link" ? (
              <Link
                key={entry.label}
                role="menuitem"
                to={entry.to}
                params={entry.params}
                search={entry.search}
                onClick={() => setOpen(false)}
                className={item}
              >
                {entry.label}
              </Link>
            ) : (
              <button
                key={entry.label}
                role="menuitem"
                type="button"
                // The name is the label alone; the reason under it is the description.
                aria-label={entry.label}
                disabled={entry.reason !== undefined}
                aria-describedby={entry.reason ? `${id}-${index}` : undefined}
                onClick={() => {
                  setOpen(false);
                  entry.onSelect();
                }}
                className={cn(
                  item,
                  "flex-col items-start justify-center gap-0.5 py-2",
                  entry.tone === "destructive" ? "text-destructive" : "",
                )}
              >
                <span>{entry.label}</span>
                {entry.reason ? (
                  <span
                    id={`${id}-${index}`}
                    className="text-xs font-normal text-muted-foreground"
                  >
                    {entry.reason}
                  </span>
                ) : null}
              </button>
            ),
          )}
        </div>
      ) : null}
    </div>
  );
}
