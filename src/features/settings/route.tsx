import {
  type AnyRoute,
  createRoute,
  Link,
  Outlet,
  useNavigate,
} from "@tanstack/react-router";
import { ChevronRight } from "lucide-react";
import { useRef } from "react";
import { List } from "../../components/ui/list";
import { PageHeading } from "../../components/ui/page-heading";
import { AppearanceDialog } from "./AppearanceDialog";
import { SettingsFocusContext, useOpenedByLink } from "./focus";

/**
 * A deliberately thin placeholder for WF-SETTINGS-01: WEB-08 replaces it with the real Settings home.
 * WEB-07 needs a route to open Appearance from. Account and export disclosure (WF-SETTINGS-06) belong to WEB-08,
 * and calendar connection settings to WEB-13.
 */
function SettingsLayout() {
  const openedByLink = useRef(false);
  return (
    <SettingsFocusContext.Provider value={openedByLink}>
      <SettingsHome />
      <Outlet />
    </SettingsFocusContext.Provider>
  );
}

function SettingsHome() {
  const openedByLink = useOpenedByLink();
  return (
    <div className="flex max-w-[620px] flex-col gap-4">
      <PageHeading>Settings</PageHeading>
      <List className="flex flex-col">
        <li className="list-none">
          <Link
            to="/settings/appearance"
            data-settings-appearance-link=""
            onClick={() => {
              openedByLink.current = true;
            }}
            className="atlas-transition flex min-h-12 items-center justify-between rounded-row border border-hairline-strong bg-panel px-4 text-[14px] text-ink-1 hover:bg-row-hover"
          >
            Appearance
            <ChevronRight aria-hidden="true" size={16} className="text-ink-2" />
          </Link>
        </li>
      </List>
      <p className="text-[14px] leading-[1.6] text-ink-2">
        More settings arrive in later releases.
      </p>
    </div>
  );
}

function AppearanceRoute() {
  const navigate = useNavigate();
  const openedByLink = useOpenedByLink();
  return (
    <AppearanceDialog
      open
      onClose={() => void navigate({ to: "/settings" })}
      onCloseAutoFocus={(event) => {
        // Return to the link that opened the dialog; a cold load has no opener, so land on the page heading.
        event.preventDefault();
        const target = openedByLink.current
          ? document.querySelector<HTMLElement>(
              "[data-settings-appearance-link]",
            )
          : document.querySelector<HTMLElement>("main [data-page-heading]");
        openedByLink.current = false;
        target?.focus();
      }}
    />
  );
}

export const settingsRoute = (parent: AnyRoute) => {
  const settings = createRoute({
    getParentRoute: () => parent,
    path: "settings",
    component: SettingsLayout,
  });
  const index = createRoute({ getParentRoute: () => settings, path: "/" });
  const appearance = createRoute({
    getParentRoute: () => settings,
    path: "appearance",
    component: AppearanceRoute,
    staticData: { dialog: true },
  });
  return settings.addChildren([index, appearance]);
};
