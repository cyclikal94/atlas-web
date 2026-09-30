import { type AnyRoute, createRoute } from "@tanstack/react-router";
import { Placeholder } from "../../app/Placeholder";

export const sharingRoute = (parent: AnyRoute) =>
  createRoute({
    getParentRoute: () => parent,
    path: "sharing",
    component: () => <Placeholder title="Sharing" />,
  });
