import {
  type AnyRoute,
  createRoute,
  Outlet,
  useMatches,
} from "@tanstack/react-router";
import { useRef } from "react";
import { SettingsFocusContext } from "./focus";
import { SettingsHome } from "./SettingsHome";
import { settingsSections } from "./sections";

declare module "@tanstack/react-router" {
  interface StaticDataRouteOption {
    /** A Settings section that is a page of its own: the home list is not drawn beside it. */
    settingsPage?: boolean;
  }
}

/**
 * The Settings routes. The home list is drawn for `/settings` and, behind it, by a dialog route (Appearance); a page
 * section (Sessions & devices, Your data) replaces it. Child routes come from the registry (`sections.ts`).
 */
function SettingsLayout() {
  const openedByLink = useRef(false);
  const leaf = useMatches().at(-1);
  const drawsHome =
    !leaf?.staticData?.settingsPage && !leaf?.staticData?.dialog;
  return (
    <SettingsFocusContext.Provider value={openedByLink}>
      {drawsHome ? <SettingsHome /> : null}
      <Outlet />
    </SettingsFocusContext.Provider>
  );
}

export const settingsRoute = (parent: AnyRoute) => {
  const settings = createRoute({
    getParentRoute: () => parent,
    path: "settings",
    component: SettingsLayout,
  });
  const index = createRoute({ getParentRoute: () => settings, path: "/" });
  // The registry's routes exist at run time, so the typed router deliberately does not know them (an `AnyRoute` in the
  // tree would widen every `Link` in the application); `never[]` adds them to the tree without adding them to its type.
  const sections = settingsSections().map((section) =>
    section.build(settings),
  ) as never[];
  return settings.addChildren([index, ...sections]);
};
