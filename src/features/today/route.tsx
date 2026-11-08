import { type AnyRoute, createRoute, redirect } from "@tanstack/react-router";
import { lazy, type ReactNode, Suspense } from "react";
import { PageHeading } from "../../components/ui/page-heading";
import { useOptionalDataEnv } from "../../data";
import { CacheGate } from "../sync/CacheGate";
import { isContractDate, isKnownZone } from "../tasks/model/primitives";
import { TODAY_TITLE, UPCOMING_HASH } from "../tasks/titles";

const TodayScreen = lazy(() =>
  import("../tasks/screens").then((m) => ({ default: m.TodayScreen })),
);

/** `/today?day=YYYY-MM-DD&tz=Area/City` (D-10a-10): the day and the display zone live in the address; nothing new is stored. */
export interface TodaySearch {
  day?: string;
  tz?: string;
  /** A task opened beside or over the day (Settings · Layout, "How tasks open"): the task and the day of it shown. */
  task?: string;
  occurrence?: string;
  /** A new task being made in the same container. */
  new?: boolean;
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
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
  ...(typeof search.task === "string" && UUID.test(search.task)
    ? { task: search.task }
    : {}),
  ...(typeof search.occurrence === "string" && UUID.test(search.occurrence)
    ? { occurrence: search.occurrence }
    : {}),
  ...(search.new === true || search.new === "true" ? { new: true } : {}),
});

/**
 * Today and Upcoming are ONE page (the day, then the days after it on the same rail), with Upcoming an anchor of it: `/today#upcoming`
 * starts at the fold, and the address's hash follows the reader's scroll, so the Upcoming item in the navigation lights up when the
 * days ahead are under the sticky bar (`TodayPage`). `/upcoming`, the old address, redirects there.
 */
export const todayRoute = (parent: AnyRoute) => {
  const route = createRoute({
    getParentRoute: () => parent,
    path: "today",
    validateSearch,
    component: function DayRoute() {
      // A shell rendered without the data layer (the shell's own tests) shows the destination's heading and no account data.
      if (useOptionalDataEnv() === null)
        return <PageHeading>{TODAY_TITLE}</PageHeading>;
      // The heading is the route's, outside the cache gate and the lazy screen (revision 2): the page has its one level-one heading in every
      // gate state and at once, so a route change can move focus to it (RouteFocus), as the placeholder this replaced did. It is the small
      // eyebrow above the day's date (the Final design): the date is the page's large title, the destination its heading.
      // The page draws the heading itself, inside its header that stays at the top (revised 8 November 2026); while the gate hides
      // the page, or its lazy screen is still loading, the heading is shown instead, so the page always has its one h1.
      const heading = <PageHeading eyebrow>{TODAY_TITLE}</PageHeading>;
      return (
        <CacheGate heading={heading}>
          <FromSearch heading={heading} />
        </CacheGate>
      );
    },
  });
  function FromSearch({ heading }: { heading: ReactNode }) {
    const search = route.useSearch();
    return (
      <Suspense fallback={heading}>
        <TodayScreen search={search} />
      </Suspense>
    );
  }
  return route;
};

export const upcomingRoute = (parent: AnyRoute) =>
  createRoute({
    getParentRoute: () => parent,
    path: "upcoming",
    validateSearch,
    beforeLoad: ({ search }) => {
      throw redirect({
        to: "/today",
        search: search as TodaySearch,
        hash: UPCOMING_HASH,
        replace: true,
      });
    },
  });
