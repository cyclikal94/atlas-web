import { type AnyRoute, createRoute, useRouter } from "@tanstack/react-router";
import { QueuePanel } from "./QueuePanel";
import type { Tab } from "./rows";

/**
 * `/sync` (plan 5.7): the Waiting-to-send panel. `?tab=queue` (the default) and `?tab=conflicts` are the panel's two tabs; the chip
 * opens whichever the status model selects. The route is client-only (no server counterpart), so the route-parity check is unaffected.
 */
export type SyncSearch = { tab: "queue" | "conflicts" };

export const syncRoute = (parent: AnyRoute) => {
  const route = createRoute({
    getParentRoute: () => parent,
    path: "sync",
    validateSearch: (search: Record<string, unknown>): SyncSearch => ({
      tab: search.tab === "conflicts" ? "conflicts" : "queue",
    }),
    component: SyncPage,
  });

  function SyncPage() {
    const router = useRouter();
    const { tab } = route.useSearch();
    const navigate = route.useNavigate();
    return (
      <QueuePanel
        tab={tab === "conflicts" ? "decision" : "waiting"}
        onTabChange={(next: Tab) =>
          void navigate({
            search: { tab: next === "decision" ? "conflicts" : "queue" },
            replace: true,
          })
        }
        onClose={() => {
          // Back to where the person came from; with no history (a direct visit) to Today.
          if (router.history.canGoBack()) router.history.back();
          else void router.navigate({ to: "/today" });
        }}
      />
    );
  }
  return route;
};
