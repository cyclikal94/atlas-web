import { type AnyRoute, createRoute } from "@tanstack/react-router";
import { AppearancePage } from "./AppearancePage";

/** WF-SETTINGS-05 in the registry: a page of its own under `/settings/appearance`, as every section is (8 November 2026). */
export const buildAppearanceSection = (settings: AnyRoute): AnyRoute =>
  createRoute({
    getParentRoute: () => settings,
    path: "appearance",
    component: AppearancePage,
    staticData: { settingsPage: true },
  });
