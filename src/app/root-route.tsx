import { createRootRoute, Outlet } from "@tanstack/react-router";
import { NotFound } from "./NotFound";
import { AppShell } from "./shell/AppShell";
import { useShellEnv } from "./shell/env";

declare module "@tanstack/react-router" {
  interface StaticDataRouteOption {
    /** A dialog route manages its own focus; RouteFocus leaves navigations into and out of it alone. */
    dialog?: boolean;
  }
}

function ShellLayout() {
  const env = useShellEnv();
  return (
    <AppShell {...env}>
      <Outlet />
    </AppShell>
  );
}

export const rootRoute = createRootRoute({
  component: ShellLayout,
  notFoundComponent: NotFound,
});
