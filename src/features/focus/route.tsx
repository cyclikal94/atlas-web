import { type AnyRoute, createRoute } from "@tanstack/react-router";
import { lazy, Suspense } from "react";
import { PageHeading } from "../../components/ui/page-heading";
import { useOptionalDataEnv } from "../../data";
import { CacheGate } from "../sync/CacheGate";
import { isContractDate, isKnownZone } from "../tasks/model/primitives";

const FocusScreen = lazy(() =>
  import("../tasks/screens").then((m) => ({ default: m.FocusScreen })),
);

export interface FocusSearch {
  day?: string;
  tz?: string;
}

/** Focus mode (the Final design): one thing at a time, from the day; `/focus?day=&tz=` as Today's address. */
export const focusRoute = (parent: AnyRoute) => {
  const route = createRoute({
    getParentRoute: () => parent,
    path: "focus",
    validateSearch: (search: Record<string, unknown>): FocusSearch => ({
      ...(isContractDate(search.day) ? { day: search.day } : {}),
      ...(isKnownZone(search.tz) ? { tz: search.tz } : {}),
    }),
    component: function FocusRoute() {
      if (useOptionalDataEnv() === null)
        return <PageHeading>Focus</PageHeading>;
      return (
        <CacheGate>
          <FromSearch />
        </CacheGate>
      );
    },
  });
  function FromSearch() {
    const search = route.useSearch();
    return (
      <Suspense fallback={null}>
        <FocusScreen search={search} />
      </Suspense>
    );
  }
  return route;
};
