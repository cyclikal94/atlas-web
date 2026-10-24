import type { AnyRoute } from "@tanstack/react-router";
import { buildCalendarsSection } from "../calendars/section";
import { buildAppearanceSection } from "./appearance-section";
import { SESSIONS_SECTION_ROUTE, settingsPath } from "./section-routes";
import { buildSessionsDevicesSection } from "./sessions-devices/section";
import { buildSigningInSection } from "./signing-in/section";
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
    id: "signing-in",
    label: "Signing in",
    // Provisional (design gap G-24): the board's "Password, and your corp-sso link" names a provider this client cannot know.
    description: "Your password and single sign-on link.",
    route: "signing-in",
    order: 20,
    owner: "WEB-08",
    build: buildSigningInSection,
  },
  {
    id: "sessions",
    label: "Sessions & devices",
    description: "Where you're signed in, and the devices that sync.",
    route: SESSIONS_SECTION_ROUTE,
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
    id: "calendars",
    label: "Calendars",
    description: "Calendars you've added, and their connections.",
    route: "calendars",
    order: 60,
    owner: "WEB-13",
    build: buildCalendarsSection,
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

/** The link target of a registry section (see `settingsPath`). */
export const sectionPath = (section: SettingsSection): "/settings" =>
  settingsPath(section.route);
