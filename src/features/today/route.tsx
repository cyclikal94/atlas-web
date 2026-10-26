import { type AnyRoute, createRoute } from "@tanstack/react-router";
import { lazy, Suspense } from "react";
import { PageHeading } from "../../components/ui/page-heading";
import { useOptionalDataEnv } from "../../data";
import { CacheGate } from "../sync/CacheGate";
import { isContractDate, isKnownZone } from "../tasks/model/primitives";
import { TODAY_TITLE } from "../tasks/titles";

const TodayScreen = lazy(() =>
  import("../tasks/screens").then((m) => ({ default: m.TodayScreen })),
);

/** `/today?day=YYYY-MM-DD&tz=Area/City` (D-10a-10): the day and the display zone live in the address; nothing new is stored. */
export interface TodaySearch {
  day?: string;
  tz?: string;
}
export const todayPath = (day?: string, zone?: string): string => {
  const params = new URLSearchParams();
  if (day) params.set("day", day);
  if (zone) params.set("tz", zone);
  const query = params.toString();
  return query ? `/today?${query}` : "/today";
};

export const todayRoute = (parent: AnyRoute) => {
  const route = createRoute({
    getParentRoute: () => parent,
    path: "today",
    validateSearch: (search: Record<string, unknown>): TodaySearch => ({
      ...(isContractDate(search.day) ? { day: search.day } : {}),
      ...(isKnownZone(search.tz) ? { tz: search.tz } : {}),
    }),
    component: function TodayRoute() {
      // A shell rendered without the data layer (the shell's own tests) shows the destination's heading and no account data.
      if (useOptionalDataEnv() === null)
        return <PageHeading>{TODAY_TITLE}</PageHeading>;
      // The heading is the route's, outside the cache gate and the lazy screen (revision 2): the page has its one level-one heading in every
      // gate state and at once, so a route change can move focus to it (RouteFocus), as the placeholder this replaced did.
      return (
        <div className="flex flex-col gap-1">
          <PageHeading>{TODAY_TITLE}</PageHeading>
          <CacheGate>
            <TodayFromSearch />
          </CacheGate>
        </div>
      );
    },
  });
  function TodayFromSearch() {
    const search = route.useSearch();
    return (
      <Suspense fallback={null}>
        <TodayScreen search={search} />
      </Suspense>
    );
  }
  return route;
};
