import { type AnyRoute, createRoute } from "@tanstack/react-router";
import { Placeholder } from "../../app/Placeholder";

export const todayRoute = (parent: AnyRoute) =>
  createRoute({
    getParentRoute: () => parent,
    path: "today",
    component: () => <Placeholder title="Today" />,
  });
