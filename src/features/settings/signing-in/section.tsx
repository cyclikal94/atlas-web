import {
  type AnyRoute,
  createRoute,
  useNavigate,
} from "@tanstack/react-router";
import { useOpenedByLink } from "../focus";
import { SettingsHome } from "../SettingsHome";
import { SigningInDialog } from "./SigningInDialog";

/** WF-SETTINGS-03: a dialog route that opens over the Settings home, like Appearance. */
function SigningInRoute() {
  const navigate = useNavigate();
  const openedByLink = useOpenedByLink();
  return (
    <>
      <SettingsHome />
      <SigningInDialog
        open
        onClose={() => void navigate({ to: "/settings" })}
        onCloseAutoFocus={(event) => {
          // Return to the link that opened the dialog; a cold load has no opener, so land on the page heading.
          event.preventDefault();
          const target = openedByLink.current
            ? document.querySelector<HTMLElement>(
                '[data-settings-link="signing-in"]',
              )
            : document.querySelector<HTMLElement>("main [data-page-heading]");
          openedByLink.current = false;
          target?.focus();
        }}
      />
    </>
  );
}

export const buildSigningInSection = (settings: AnyRoute): AnyRoute =>
  createRoute({
    getParentRoute: () => settings,
    path: "signing-in",
    component: SigningInRoute,
    staticData: { dialog: true },
  });
