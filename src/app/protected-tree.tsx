import { RouterProvider } from "@tanstack/react-router";
import { type ReactNode, useMemo } from "react";
import {
  DataProvider,
  getPageDataHost,
  useAccountLabel,
  useSyncStatusModel,
} from "../data";
import { invitationMemory } from "../features/authentication/handoff";
import { isJoinPath } from "../features/authentication/public-route";
import { type Session, SessionProvider } from "../session";
import { AccountSlot } from "./AccountSlot";
import { ProtectedProviders } from "./providers";
import { createAppRouter } from "./router";
import { SessionNotices } from "./SessionNotices";
import { type ShellEnv, ShellEnvProvider } from "./shell/env";

type AppRouter = ReturnType<typeof createAppRouter>;

/**
 * The tree that `act` mounts into `#protected-root` (plan decision D-19). It is loaded by a dynamic import at boot, after the
 * canary and BEFORE `expose` starts (D-10), so `act` never awaits an import.
 *
 * The sync chip reads the data layer's status model; the page's production leader drives sync and recovery (WEB-09b).
 * The account slot shows the verified username for the current epoch. The sign-in and join surfaces (WEB-08b) lead here;
 * `/join` is normalised below before the router exists, unless this tab still holds an unused invitation.
 */
function ShellFromData({
  router,
  children,
}: {
  router: AppRouter;
  children: ReactNode;
}) {
  const syncModel = useSyncStatusModel();
  const label = useAccountLabel();
  const env = useMemo<ShellEnv>(
    () => ({
      syncModel,
      onOpenSync: (destination) => {
        void router.navigate({
          to: "/sync",
          search: { tab: destination === "conflicts" ? "conflicts" : "queue" },
        });
      },
      ...(label === null
        ? {}
        : {
            accountSlot: ({ collapsed }: { collapsed: boolean }) => (
              <AccountSlot label={label} collapsed={collapsed} />
            ),
          }),
    }),
    [syncModel, label, router],
  );
  return <ShellEnvProvider value={env}>{children}</ShellEnvProvider>;
}

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
  // WEB-10a: the task kinds are registered once into the page's registry (the leader's dispatcher and the queue screens share it), so
  // `/sync` describes and offers task drafts whichever screen is open first.
  // Loaded as its own chunk (it is not needed to draw the shell, and the fixture's initial bundle has no room for it).
  void import("../features/tasks/register").then(({ registerTaskCommands }) =>
    registerTaskCommands(getPageDataHost().commands),
  );
  return (): ReactNode => {
    normalisePublicPath();
    // A new router per mount: an account change must not inherit the previous account's location or loaders.
    const router = createAppRouter();
    return (
      <SessionProvider session={session}>
        <ProtectedProviders>
          <DataProvider session={session}>
            <ShellFromData router={router}>
              <RouterProvider router={router} />
              <SessionNotices />
            </ShellFromData>
          </DataProvider>
        </ProtectedProviders>
      </SessionProvider>
    );
  };
}
