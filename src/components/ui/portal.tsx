import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import { usePortalContainerState } from "../../protected-surface/PortalContainer";

/**
 * The only module that may create portals (lint rule R3). It resolves its container from the registry, never from
 * document.body. With no registry the content is not rendered, and development builds throw so the mistake is
 * found in tests rather than by a leak. During the first render the container is not attached yet: nothing renders.
 */
export function useRequiredPortalContainer(): HTMLElement | null {
  const state = usePortalContainerState();
  if (!state) {
    if (import.meta.env.DEV)
      throw new Error("Portal used outside a PortalContainer");
    return null;
  }
  return state.container;
}

export function Portal({ children }: { children: ReactNode }) {
  const container = useRequiredPortalContainer();
  return container ? createPortal(children, container) : null;
}
