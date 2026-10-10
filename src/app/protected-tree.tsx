import { RouterProvider } from "@tanstack/react-router";
import { type ReactNode, useMemo } from "react";
import { DataProvider, useAccountLabel, useSyncStatusModel } from "../data";
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
 * The sync chip is driven by the data layer's status model (plan 5.7). Production starts no sync engine and no dispatcher until
 * WEB-09b supplies leadership, so the model reads "Updates stopped" (or "Offline"), which is true: "Up to date" is never shown
 * unless a sync has actually completed. The account slot shows the VERIFIED username only, while it is verified for the current
 * epoch. Production cannot reach this tree until a sign-in surface exists (WEB-08b), so nothing false is ever shown.
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

export function createProtectedTree(session: Session) {
  return (): ReactNode => {
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
