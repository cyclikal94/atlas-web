import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import type { ReactNode } from "react";
import { cn } from "../../lib/utils";
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
 * shadcn/ui's tooltip: shows on hover and on keyboard focus; dismissible (Escape), hoverable and persistent while hovered or
 * focused (WCAG 1.4.13). The content renders in the registered portal container, never document.body. The trigger keeps its
 * own accessible name: the tooltip repeats it and never replaces it.
 */
export function Tooltip({ content, side = "right", children }: TooltipProps) {
  const container = useRequiredPortalContainer();
  return (
    <TooltipPrimitive.Root>
      <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
      {container ? (
        <TooltipPrimitive.Portal container={container}>
          <TooltipPrimitive.Content
            data-slot="tooltip-content"
            side={side}
            sideOffset={8}
            className={cn(
              "z-50 w-fit max-w-[260px] rounded-md border bg-popover px-3 py-2 text-xs text-popover-foreground shadow-md",
              "animate-in fade-in-0 zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2",
            )}
          >
            {content}
          </TooltipPrimitive.Content>
        </TooltipPrimitive.Portal>
      ) : null}
    </TooltipPrimitive.Root>
  );
}
