import { type AnyRoute, createRoute } from "@tanstack/react-router";
import { ArchivedItems } from "./ArchivedItems";

/** The Settings "Archived items" page (D-11a-11): a page of its own under `/settings/archived`. */
export const buildArchivedSection = (settings: AnyRoute): AnyRoute =>
  createRoute({
    getParentRoute: () => settings,
    path: "archived",
    component: ArchivedItems,
    staticData: { settingsPage: true },
  });
