import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { type ReactNode, StrictMode, useState } from "react";
import { AnnouncerProvider } from "../components/ui/announcer";
import { TooltipProvider } from "../components/ui/tooltip";
import { ThemeProvider } from "../design/ThemeProvider";
import { PortalContainer } from "../protected-surface/PortalContainer";

/** Providers for a tree that renders dialogs, tooltips and announcements: the protected tree and its fixtures. */
export function ProtectedProviders({ children }: { children: ReactNode }) {
  const [queryClient] = useState(() => new QueryClient());
  return (
    <StrictMode>
      <ThemeProvider>
        <QueryClientProvider client={queryClient}>
          <AnnouncerProvider>
            <PortalContainer>
              <TooltipProvider>{children}</TooltipProvider>
            </PortalContainer>
          </AnnouncerProvider>
        </QueryClientProvider>
      </ThemeProvider>
    </StrictMode>
  );
}
