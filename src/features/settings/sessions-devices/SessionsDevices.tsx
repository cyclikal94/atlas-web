import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { PageHeading } from "../../../components/ui/page-heading";
import { DevicesSection } from "./DevicesSection";
import { SessionsSection } from "./SessionsSection";
import { WipeConfirmDialog } from "./WipeConfirmDialog";

/**
 * WF-SETTINGS-02, Sessions & devices: two sections with independent loads and independent error banners, each with its
 * own consequence statement. "Sign out" on the current row and "Retire" on the current device open the warning that
 * precedes a wipe; on another row they call the ordinary operations directly.
 */
export function SessionsDevices() {
  const [loggingOut, setLoggingOut] = useState(false);
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <Link
          to="/settings"
          className="atlas-transition inline-flex min-h-11 w-fit items-center text-[13.5px] text-ink-2 hover:text-ink-1"
        >
          Settings
        </Link>
        <PageHeading>Sessions &amp; devices</PageHeading>
      </div>
      <SessionsSection onSignOutCurrent={() => setLoggingOut(true)} />
      <DevicesSection />
      {loggingOut ? (
        <WipeConfirmDialog kind="logout" onClose={() => setLoggingOut(false)} />
      ) : null}
    </div>
  );
}
