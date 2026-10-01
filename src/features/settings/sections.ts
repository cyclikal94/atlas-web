import type { AnyRoute } from "@tanstack/react-router";
import { buildAppearanceSection } from "./appearance-section";
import { buildSessionsDevicesSection } from "./sessions-devices/section";
import { buildYourDataSection } from "./your-data/section";

/**
 * The Settings registry (plan 8.3). `SettingsHome` renders it and `settingsRoute` builds its child routes from it, so a
 * later slice adds ONE entry here and never edits the home list. WEB-13a appends a calendar entry (owner "WEB-13", a
 * `build` that returns a route with `staticData: { settingsPage: true }`) and edits nothing else.
 */
export interface SettingsSection {
  id: string;
  label: string;
  /** A static, one-line description shown under the label on the home list. */
  description: string;
  /** The path segment under `/settings`. */
  route: string;
  /** Lower numbers first. */
  order: number;
  owner: "WEB-07" | "WEB-08" | "WEB-13";
  /** Builds this section's child route under the `/settings` route. */
  build(settings: AnyRoute): AnyRoute;
}

const SECTIONS: readonly SettingsSection[] = [
  {
    id: "sessions",
    label: "Sessions & devices",
    description: "Where you're signed in, and the devices that sync.",
    route: "sessions",
    order: 30,
    owner: "WEB-08",
    build: buildSessionsDevicesSection,
  },
  {
    id: "appearance",
    label: "Appearance",
    description: "Dark, light, or match your system.",
    route: "appearance",
    order: 50,
    owner: "WEB-07",
    build: buildAppearanceSection,
  },
  {
    id: "data",
    label: "Your data",
    description: "What this device is holding.",
    route: "data",
    order: 70,
    owner: "WEB-08",
    build: buildYourDataSection,
  },
];

export const settingsSections = (): readonly SettingsSection[] =>
  [...SECTIONS].sort((a, b) => a.order - b.order);

/**
 * The link target of a registry section. Its routes are built at run time (see `settingsRoute`), so the typed router does not
 * know them; this is the one place that says so.
 */
export const sectionPath = (section: SettingsSection): "/settings" =>
  `/settings/${section.route}` as "/settings";
