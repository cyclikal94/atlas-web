import {
  createContext,
  type ReactNode,
  useContext,
  useMemo,
  useState,
} from "react";

/**
 * A container for dialogs, tooltips and sheets, created inside whichever root owns the tree that
 * renders them. In the protected tree that is #protected-root, so no portal can render account data
 * outside the gate (matrix section 3.7.1).
 */
interface PortalContainerState {
  /** Null for the first render, until the container element is attached. */
  container: HTMLElement | null;
}

const PortalContainerContext = createContext<PortalContainerState | null>(null);

export function PortalContainer({ children }: { children: ReactNode }) {
  const [container, setContainer] = useState<HTMLElement | null>(null);
  const value = useMemo(() => ({ container }), [container]);
  return (
    <PortalContainerContext.Provider value={value}>
      {children}
      <div data-portal-root ref={setContainer} />
    </PortalContainerContext.Provider>
  );
}

/** Returns null when no PortalContainer is registered above the caller (a programming error). */
export function usePortalContainerState(): PortalContainerState | null {
  return useContext(PortalContainerContext);
}
