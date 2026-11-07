import { createRootRoute, Outlet } from "@tanstack/react-router";
import { lazy, Suspense } from "react";
import { GlobalNotices } from "../features/sync/NoticeBanners";
import { useAppUpdate } from "../lib/pwa/store";
import { NotFound } from "./NotFound";
import { AppShell } from "./shell/AppShell";
import { useShellEnv } from "./shell/env";
import { NavigationSignal } from "./shell/NavigationSignal";

declare module "@tanstack/react-router" {
  interface StaticDataRouteOption {
    /** A dialog route manages its own focus; RouteFocus leaves navigations into and out of it alone. */
    dialog?: boolean;
  }
}

// The shell's update banner (WEB-14a) is loaded only when there is something to say, as the neutral root's is (revision 6, R14: the
// initial chunk carries the import, not the banner). It announces through the shell's announcer, which is mounted before it loads.
const AppUpdateBanner = lazy(() =>
  import("../lib/pwa/UpdateBanner").then((module) => ({
    default: module.AppUpdateBanner,
  })),
);

function UpdateSlot() {
  const update = useAppUpdate();
  if (update.kind === "none") return null;
  return (
    <Suspense fallback={null}>
      <AppUpdateBanner />
    </Suspense>
  );
}

// A dismissed update banner comes back on the next in-app navigation (revision 17, R24): the slot stays mounted beside the outlet, so the
// router's rendered navigations are told to the coordinator (`NavigationSignal`), which alone decides what the banner shows.
function ShellLayout() {
  const env = useShellEnv();
  return (
    <AppShell {...env} updateSlot={<UpdateSlot />}>
      <NavigationSignal />
      <GlobalNotices />
      <Outlet />
    </AppShell>
  );
}

export const rootRoute = createRootRoute({
  component: ShellLayout,
  notFoundComponent: NotFound,
});
