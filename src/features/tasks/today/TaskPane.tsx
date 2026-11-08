import { type ReactNode, useEffect, useRef } from "react";
import type { TaskWrapper } from "../../../app/shell/preferences";
import { Dialog } from "../../../components/ui/dialog";
import { enterFocusLoop } from "../../../components/ui/focus-loop";
import { cn } from "../../../lib/utils";

export const PANE_COPY = {
  label: "Task",
  newLabel: "New task",
  previous: "Previous task",
  next: "Next task",
} as const;

/**
 * The container a task opens in beside a list (Settings · Layout, the Final design): the split pane's right half, the side peek
 * floating over the list, or the overlay centred over it. The list is the caller's; this draws only the container and what it holds.
 * The peek and the overlay close on Escape; the peek moves to the previous or next row on ↑ and ↓ when the caller gives it a way.
 */
export function TaskPane({
  wrapper,
  label,
  onClose,
  onStep,
  children,
}: {
  wrapper: Exclude<TaskWrapper, "page">;
  label: string;
  onClose(): void;
  /** ↑ (-1) and ↓ (+1) in the peek: the previous or next task of the list. */
  onStep?(direction: -1 | 1): void;
  children: ReactNode;
}) {
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (wrapper !== "peek") return;
    const node = panel.current;
    if (!node) return;
    const release = enterFocusLoop(node);
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
      } else if (
        (event.key === "ArrowUp" || event.key === "ArrowDown") &&
        onStep &&
        !(event.target instanceof HTMLInputElement) &&
        !(event.target instanceof HTMLTextAreaElement) &&
        !(event.target instanceof HTMLSelectElement)
      ) {
        event.preventDefault();
        onStep(event.key === "ArrowUp" ? -1 : 1);
      }
    };
    node.addEventListener("keydown", onKey);
    return () => {
      release();
      node.removeEventListener("keydown", onKey);
    };
  }, [wrapper, onClose, onStep]);
  if (wrapper === "split")
    return (
      <section
        className="atlas-enter min-w-0"
        data-task-pane="split"
        aria-label={label}
      >
        {children}
      </section>
    );
  if (wrapper === "peek")
    return (
      <div
        ref={panel}
        role="dialog"
        aria-label={label}
        tabIndex={-1}
        data-task-pane="peek"
        className={cn(
          "atlas-peek fixed inset-y-3 right-3 z-40 flex w-[620px] max-w-[calc(100vw-96px)] flex-col overflow-y-auto rounded-[14px] border border-border bg-card p-6 shadow-[0_24px_60px_-20px_rgba(0,0,0,.85)]",
        )}
      >
        {children}
      </div>
    );
  return (
    <Dialog
      open
      onClose={onClose}
      title={label}
      syncControl={false}
      size="wide"
      sheetBelow="tablet"
    >
      <div data-task-pane="overlay">{children}</div>
    </Dialog>
  );
}
