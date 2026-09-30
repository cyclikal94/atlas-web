import { type AnyRoute, createRoute } from "@tanstack/react-router";
import { Placeholder } from "../../app/Placeholder";

export const peopleRoute = (parent: AnyRoute) =>
  createRoute({
    getParentRoute: () => parent,
    path: "people",
    component: () => <Placeholder title="People" />,
  });
