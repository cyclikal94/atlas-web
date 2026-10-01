import { type AnyRoute, createRoute } from "@tanstack/react-router";
import { YourData } from "./YourData";

export const buildYourDataSection = (settings: AnyRoute): AnyRoute =>
  createRoute({
    getParentRoute: () => settings,
    path: "data",
    component: YourData,
    staticData: { settingsPage: true },
  });
