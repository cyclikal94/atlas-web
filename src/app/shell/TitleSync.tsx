import { useRouterState } from "@tanstack/react-router";
import { useEffect } from "react";
import { setProtectedTitle } from "../../protected-surface/title";
import { destinationFor } from "./destinations";

/** Generic destination names only. setProtectedTitle is a no-op while the protected root is gated. */
export function TitleSync() {
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  });
  useEffect(() => {
    // `/sync` is a screen, not a navigation destination: it has a generic name of its own (never account data).
    setProtectedTitle([
      pathname === "/sync"
        ? "Sync"
        : (destinationFor(pathname)?.label ?? "Not found"),
    ]);
  }, [pathname]);
  return null;
}
