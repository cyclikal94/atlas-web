import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { PageHeading } from "../../../components/ui/page-heading";
import type { SessionSummary } from "../../../session";
import { DevicesSection } from "./DevicesSection";
import { type Interaction, useInteractions } from "./ownership";
import { SessionsSection } from "./SessionsSection";
import { WipeConfirmDialog } from "./WipeConfirmDialog";

/**
 * WF-SETTINGS-02, Sessions & devices: two sections with independent loads and independent error banners, each with its
 * own consequence statement. "Sign out" on the current row and "Retire" on the current device open the warning that
 * precedes a wipe; on another row they call the ordinary operations directly.
 */
export function SessionsDevices() {
  const interactions = useInteractions();
  // Review R3: the logout warning closes only itself (a late answer of an older warning cannot close a newer one). Both lists read
  // again after a change through `ownership.ts` (review R1), whichever section or dialog made it.
  const [loggingOut, setLoggingOut] = useState<{
    row: SessionSummary;
    interaction: Interaction;
  } | null>(null);
  const closeLogout = (interaction: Interaction) => {
    interaction.end();
    setLoggingOut((open) => (open?.interaction === interaction ? null : open));
  };
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <Link
          to="/settings"
          className="atlas-transition inline-flex min-h-11 w-fit items-center text-sm text-muted-foreground hover:text-foreground"
        >
          Settings
        </Link>
        <PageHeading>Sessions &amp; devices</PageHeading>
      </div>
      <SessionsSection
        onSignOutCurrent={(row) => {
          loggingOut?.interaction.end();
          setLoggingOut({ row, interaction: interactions.begin() });
        }}
      />
      <DevicesSection />
      {loggingOut ? (
        <WipeConfirmDialog
          key={loggingOut.interaction.id}
          kind="logout"
          current={loggingOut.row}
          onClose={() => closeLogout(loggingOut.interaction)}
        />
      ) : null}
    </div>
  );
}
