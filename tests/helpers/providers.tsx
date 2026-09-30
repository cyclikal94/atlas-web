import { type ReactNode, useEffect } from "react";
import { AnnouncerProvider } from "../../src/components/ui/announcer";
import {
  SyncStatusProvider,
  type SyncStatusValue,
} from "../../src/components/ui/sync-status";
import { TooltipProvider } from "../../src/components/ui/tooltip";
import { PortalContainer } from "../../src/protected-surface/PortalContainer";

export const SYNCED: SyncStatusValue["model"] = {
  phase: "synced",
  pendingCount: 0,
  conflictCount: 0,
};

/** The providers a component that renders dialogs, tooltips and sync status needs. */
export function UiProviders({
  children,
  sync,
}: {
  children: ReactNode;
  sync?: Partial<SyncStatusValue>;
}) {
  const value: SyncStatusValue = { model: SYNCED, onOpen: () => {}, ...sync };
  return (
    <AnnouncerProvider>
      <PortalContainer>
        <TooltipProvider>
          <SyncStatusProvider value={value}>{children}</SyncStatusProvider>
        </TooltipProvider>
      </PortalContainer>
    </AnnouncerProvider>
  );
}

/** Adds the protected root to the document for tests that check where content lands. */
export function useProtectedRootFixture() {
  useEffect(() => {
    const root = document.createElement("div");
    root.id = "protected-root";
    document.body.append(root);
    return () => root.remove();
  }, []);
}
