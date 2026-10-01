import {
  type AnyRoute,
  createRoute,
  useNavigate,
} from "@tanstack/react-router";
import { AppearanceDialog } from "./AppearanceDialog";
import { useOpenedByLink } from "./focus";
import { SettingsHome } from "./SettingsHome";

/** WF-SETTINGS-05, migrated to the registry unchanged: a dialog route that opens over the Settings home. */
function AppearanceRoute() {
  const navigate = useNavigate();
  const openedByLink = useOpenedByLink();
  return (
    <>
      <SettingsHome />
      <AppearanceDialog
        open
        onClose={() => void navigate({ to: "/settings" })}
        onCloseAutoFocus={(event) => {
          // Return to the link that opened the dialog; a cold load has no opener, so land on the page heading.
          event.preventDefault();
          const target = openedByLink.current
            ? document.querySelector<HTMLElement>(
                '[data-settings-link="appearance"]',
              )
            : document.querySelector<HTMLElement>("main [data-page-heading]");
          openedByLink.current = false;
          target?.focus();
        }}
      />
    </>
  );
}

export const buildAppearanceSection = (settings: AnyRoute): AnyRoute =>
  createRoute({
    getParentRoute: () => settings,
    path: "appearance",
    component: AppearanceRoute,
    staticData: { dialog: true },
  });
