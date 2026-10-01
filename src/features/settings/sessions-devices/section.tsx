import { type AnyRoute, createRoute } from "@tanstack/react-router";
import { SessionsDevices } from "./SessionsDevices";

export const buildSessionsDevicesSection = (settings: AnyRoute): AnyRoute =>
  createRoute({
    getParentRoute: () => settings,
    path: "sessions",
    component: SessionsDevices,
    staticData: { settingsPage: true },
  });
