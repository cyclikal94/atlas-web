import { type AnyRoute, createRoute } from "@tanstack/react-router";
import { LayoutPage } from "./LayoutPage";

/** Settings · Layout ("How things open"), a page of its own under `/settings/layout`. */
export const buildLayoutSection = (settings: AnyRoute): AnyRoute =>
  createRoute({
    getParentRoute: () => settings,
    path: "layout",
    component: LayoutPage,
    staticData: { settingsPage: true },
  });
