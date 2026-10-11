import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { PageHeading } from "../../../components/ui/page-heading";
import type { SessionSummary } from "../../../session";
import { DevicesSection } from "./DevicesSection";
import { SessionsSection } from "./SessionsSection";
import { WipeConfirmDialog } from "./WipeConfirmDialog";

/**
 * WF-SETTINGS-02, Sessions & devices: two sections with independent loads and independent error banners, each with its
 * own consequence statement. "Sign out" on the current row and "Retire" on the current device open the warning that
 * precedes a wipe; on another row they call the ordinary operations directly.
 */
export function SessionsDevices() {
  const [loggingOut, setLoggingOut] = useState<SessionSummary | null>(null);
  // A device's name is shown on the sessions list too, so a naming change there reads the sessions again.
  const [namesChanged, setNamesChanged] = useState(0);
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
      <SessionsSection
        onSignOutCurrent={(row) => setLoggingOut(row)}
        refresh={namesChanged}
      />
      <DevicesSection onNamesChanged={() => setNamesChanged((n) => n + 1)} />
      {loggingOut ? (
        <WipeConfirmDialog
          kind="logout"
          current={loggingOut}
          onClose={() => setLoggingOut(null)}
        />
      ) : null}
    </div>
  );
}
