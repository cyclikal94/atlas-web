import { type AnyRoute, createRoute } from "@tanstack/react-router";
import { Placeholder } from "../../app/Placeholder";

export const tasksRoute = (parent: AnyRoute) =>
  createRoute({
    getParentRoute: () => parent,
    path: "tasks",
    component: () => <Placeholder title="Tasks" />,
  });
