import { type AnyRoute, createRoute } from "@tanstack/react-router";
import { lazy, Suspense } from "react";
import { PageHeading } from "../../components/ui/page-heading";
import { useOptionalDataEnv } from "../../data";
import { CacheGate } from "../sync/CacheGate";
import { isContractDate, isKnownZone } from "../tasks/model/primitives";
import { TODAY_TITLE, UPCOMING_TITLE } from "../tasks/titles";

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

const validateSearch = (search: Record<string, unknown>): TodaySearch => ({
  ...(isContractDate(search.day) ? { day: search.day } : {}),
  ...(isKnownZone(search.tz) ? { tz: search.tz } : {}),
});

/**
 * Today and Upcoming are one page (the day, then the days after it under an "Upcoming" fold), reached by two addresses: `/upcoming`
 * opens the fold and starts at it, so it can be linked to and the Upcoming item in the navigation lights up there.
 */
function dayRoute(
  parent: AnyRoute,
  path: "today" | "upcoming",
  title: string,
  section: "today" | "upcoming",
) {
  const route = createRoute({
    getParentRoute: () => parent,
    path,
    validateSearch,
    component: function DayRoute() {
      // A shell rendered without the data layer (the shell's own tests) shows the destination's heading and no account data.
      if (useOptionalDataEnv() === null)
        return <PageHeading>{title}</PageHeading>;
      // The heading is the route's, outside the cache gate and the lazy screen (revision 2): the page has its one level-one heading in every
      // gate state and at once, so a route change can move focus to it (RouteFocus), as the placeholder this replaced did. It is the small
      // eyebrow above the day's date (the Final design): the date is the page's large title, the destination its heading.
      return (
        <div className="flex flex-col gap-1">
          <PageHeading eyebrow>{title}</PageHeading>
          <CacheGate>
            <FromSearch />
          </CacheGate>
        </div>
      );
    },
  });
  function FromSearch() {
    const search = route.useSearch();
    return (
      <Suspense fallback={null}>
        <TodayScreen search={search} section={section} />
      </Suspense>
    );
  }
  return route;
}

export const todayRoute = (parent: AnyRoute) =>
  dayRoute(parent, "today", TODAY_TITLE, "today");
export const upcomingRoute = (parent: AnyRoute) =>
  dayRoute(parent, "upcoming", UPCOMING_TITLE, "upcoming");
