import { type AnyRoute, createRoute } from "@tanstack/react-router";
import { Placeholder } from "../../app/Placeholder";

/** The household calendar destination: its month view arrives with the calendar events slice; the destination exists in the shell now. */
export const calendarRoute = (parent: AnyRoute) =>
  createRoute({
    getParentRoute: () => parent,
    path: "calendar",
    component: () => <Placeholder title="Calendar" />,
  });
