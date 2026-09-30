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
    setProtectedTitle([destinationFor(pathname)?.label ?? "Not found"]);
  }, [pathname]);
  return null;
}
