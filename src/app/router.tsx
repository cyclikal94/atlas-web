import {
  createMemoryHistory,
  createRoute,
  createRouter,
  type RouterHistory,
  redirect,
} from "@tanstack/react-router";
import { peopleRoute } from "../features/people/route";
import { settingsRoute } from "../features/settings/route";
import { sharingRoute } from "../features/sharing/route";
import { tasksRoute } from "../features/tasks/route";
import { todayRoute } from "../features/today/route";
import { rootRoute } from "./root-route";

/**
 * The protected application's route tree. Production does not mount it: WEB-08 mounts it under the exposure gate.
 * Browser history is used (never hash routing), because the OIDC return carries its grant in the URL fragment.
 */
export function createAppRouter(
  options: { history?: RouterHistory; initialPath?: string } = {},
) {
  const home = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    beforeLoad: () => {
      throw redirect({ to: "/today", replace: true });
    },
  });
  const routeTree = rootRoute.addChildren([
    home,
    todayRoute(rootRoute),
    tasksRoute(rootRoute),
    peopleRoute(rootRoute),
    sharingRoute(rootRoute),
    settingsRoute(rootRoute),
  ]);
  return createRouter({
    routeTree,
    history:
      options.history ??
      (options.initialPath
        ? createMemoryHistory({ initialEntries: [options.initialPath] })
        : undefined),
  });
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof createAppRouter>;
  }
}
