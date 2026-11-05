import { type AnyRoute, createRoute } from "@tanstack/react-router";
import { lazy, Suspense } from "react";

// The ledger is served by the people screens' lazy chunk (`../screens`): Settings' sections are part of the initial bundle, the ledger is
// not. A lazy chunk of its own made the bundler split shared modules out of the fixture entry (measured, +4.5 KB gzip).
const ArchivedItems = lazy(() =>
  import("../screens").then((m) => ({ default: m.ArchivedItems })),
);

/** The Settings "Archived items" page (D-11a-11): a page of its own under `/settings/archived`. */
export const buildArchivedSection = (settings: AnyRoute): AnyRoute =>
  createRoute({
    getParentRoute: () => settings,
    path: "archived",
    component: function ArchivedItemsRoute() {
      return (
        <Suspense fallback={null}>
          <ArchivedItems />
        </Suspense>
      );
    },
    staticData: { settingsPage: true },
  });
