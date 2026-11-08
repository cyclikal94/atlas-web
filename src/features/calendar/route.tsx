import { type AnyRoute, createRoute } from "@tanstack/react-router";
import { lazy, type ReactNode, Suspense } from "react";
import { PageHeading } from "../../components/ui/page-heading";
import { useOptionalDataEnv } from "../../data";
import { CacheGate } from "../sync/CacheGate";
import { isContractDate, isKnownZone } from "../tasks/model/primitives";

const CalendarScreen = lazy(() =>
  import("../tasks/screens").then((m) => ({ default: m.CalendarScreen })),
);

export interface CalendarSearch {
  /** The month or week in view: `month` (the default) or `week`. */
  view?: "month" | "week";
  /** Saturday and Sunday shown (the default) or not. */
  weekends?: boolean;
  /** The day the view is at (`YYYY-MM-DD`); absent: today. */
  at?: string;
  tz?: string;
}
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

/**
 * The household calendar (the Final design): the month, or the week, scrolled through without end, from what this device holds,
 * under the destination's eyebrow heading. `month=YYYY-MM` is still read as the first of that month for one release.
 */
export const calendarRoute = (parent: AnyRoute) => {
  const route = createRoute({
    getParentRoute: () => parent,
    path: "calendar",
    validateSearch: (search: Record<string, unknown>): CalendarSearch => ({
      ...(search.view === "week" ? { view: "week" as const } : {}),
      ...(search.weekends === false ||
      search.weekends === "false" ||
      search.weekends === 0 ||
      search.weekends === "0"
        ? { weekends: false }
        : {}),
      ...(isContractDate(search.at)
        ? { at: search.at }
        : typeof search.month === "string" && MONTH.test(search.month)
          ? { at: `${search.month}-01` }
          : {}),
      ...(isKnownZone(search.tz) ? { tz: search.tz } : {}),
    }),
    component: function CalendarRoute() {
      // The page draws its own eyebrow heading inside its header (which stays at the top); while the gate hides the page, or its
      // lazy screen is still loading, the heading is shown instead, so the page always has its one h1.
      const heading = <PageHeading eyebrow>Calendar</PageHeading>;
      if (useOptionalDataEnv() === null) return heading;
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
        <CalendarScreen search={search} />
      </Suspense>
    );
  }
  return route;
};
