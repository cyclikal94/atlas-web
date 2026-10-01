import { RouterProvider } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { type Session, SessionProvider } from "../session";
import { ProtectedProviders } from "./providers";
import { createAppRouter } from "./router";
import { SessionNotices } from "./SessionNotices";
import { type ShellEnv, ShellEnvProvider } from "./shell/env";

/**
 * The tree that `act` mounts into `#protected-root` (plan decision D-19). It is loaded by a dynamic import at boot, after the
 * canary and BEFORE `expose` starts (D-10), so `act` never awaits an import.
 *
 * Until a sync engine exists (WEB-09a) the sync chip reads "Updates stopped": that is literally true, because nothing syncs.
 * "Up to date" would be a false claim. The account slot stays empty until a profile read exists (design gap G-9).
 * Production cannot reach this tree until a sign-in surface exists (WEB-08b), so nothing false is ever shown.
 */
const SHELL_ENV: ShellEnv = {
  syncModel: { phase: "interrupted", pendingCount: 0, conflictCount: 0 },
  onOpenSync: () => {},
};

export function createProtectedTree(session: Session) {
  return (): ReactNode => {
    // A new router per mount: an account change must not inherit the previous account's location or loaders.
    const router = createAppRouter();
    return (
      <SessionProvider session={session}>
        <ProtectedProviders>
          <ShellEnvProvider value={SHELL_ENV}>
            <RouterProvider router={router} />
            <SessionNotices />
          </ShellEnvProvider>
        </ProtectedProviders>
      </SessionProvider>
    );
  };
}
