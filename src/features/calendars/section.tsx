import {
  type AnyRoute,
  createRoute,
  lazyRouteComponent,
} from "@tanstack/react-router";

/**
 * The Settings registry entry's route (`/settings/calendars`, WEB-13a). The screen is a chunk of its own, loaded when the route is
 * visited, so the shell (and the fixture's initial bundle) carry only this route record.
 */
export const buildCalendarsSection = (settings: AnyRoute): AnyRoute =>
  createRoute({
    getParentRoute: () => settings,
    path: "calendars",
    component: lazyRouteComponent(
      () => import("./CalendarSources"),
      "CalendarSources",
    ),
    staticData: { settingsPage: true },
  });
