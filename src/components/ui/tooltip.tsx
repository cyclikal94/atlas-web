import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import type { ReactNode } from "react";
import { useRequiredPortalContainer } from "./portal";

export function TooltipProvider({ children }: { children: ReactNode }) {
  return (
    <TooltipPrimitive.Provider delayDuration={250}>
      {children}
    </TooltipPrimitive.Provider>
  );
}

export interface TooltipProps {
  content: ReactNode;
  side?: "top" | "right" | "bottom" | "left";
  children: ReactNode;
}

/**
 * Shows on hover and on keyboard focus; dismissible (Escape), hoverable and persistent while hovered or
 * focused (WCAG 1.4.13). The content renders in the registered portal container, never document.body.
 * The trigger keeps its own accessible name: the tooltip repeats it and never replaces it.
 */
export function Tooltip({ content, side = "right", children }: TooltipProps) {
  const container = useRequiredPortalContainer();
  return (
    <TooltipPrimitive.Root>
      <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
      {container ? (
        <TooltipPrimitive.Portal container={container}>
          <TooltipPrimitive.Content
            side={side}
            sideOffset={8}
            className="z-50 max-w-[260px] rounded-control border border-chrome-edge bg-chrome-inset px-3 py-2 text-[12.5px] text-ink-1"
          >
            {content}
          </TooltipPrimitive.Content>
        </TooltipPrimitive.Portal>
      ) : null}
    </TooltipPrimitive.Root>
  );
}
