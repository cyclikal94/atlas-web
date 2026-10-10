import { RouterProvider } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { invitationMemory } from "../features/authentication/handoff";
import { isJoinPath } from "../features/authentication/public-route";
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
 * The sign-in and join surfaces (WEB-08b) are what lead here; `/join` is normalised to `/` below, before the router exists.
 */
const SHELL_ENV: ShellEnv = {
  syncModel: { phase: "interrupted", pendingCount: 0, conflictCount: 0 },
  onOpenSync: () => {},
};

/**
 * A person who has just registered must not land on `/join`: it is a public path. It is replaced by `/` BEFORE the router is
 * created, synchronously, inside the factory. It is kept only when this tab still holds an unused invitation, so a person who
 * was already signed in (or signed in in another tab) is told why the link does not register anyone (the `/join` route).
 */
function normalisePublicPath(): void {
  if (!isJoinPath(location.pathname) || invitationMemory.peek() !== null)
    return;
  history.replaceState(null, "", `/${location.search}`);
}

export function createProtectedTree(session: Session) {
  return (): ReactNode => {
    normalisePublicPath();
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
