import { RouterProvider } from "@tanstack/react-router";
import { type ReactNode, useEffect, useMemo } from "react";
import { SyncStatusProvider } from "../components/ui/sync-status";
import { DataProvider, useAccountLabel, useSyncStatusModel } from "../data";
import { invitationMemory } from "../features/authentication/handoff";
import { isJoinPath } from "../features/authentication/public-route";
import { SwitchHost } from "../features/switch/entry";
import { documentRouteChanges } from "../lib/route-changes";
import { type Session, SessionProvider, useSessionView } from "../session";
import { AccountSlot } from "./AccountSlot";
import { appCommands } from "./commands";
import { ProtectedProviders } from "./providers";
import { focusWhenPresent, returnDestination } from "./return-destination";
import { createAppRouter } from "./router";
import { SessionNotices } from "./SessionNotices";
import {
  type ShellEnv,
  ShellEnvProvider,
  type ShellSlotState,
} from "./shell/env";

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
  const view = useSessionView();
  const account = view.kind === "displaying" ? view.account_id : null;
  const epoch = view.kind === "displaying" ? view.epoch : null;
  // WEB-08c (D-8c-03): put the person back where an in-place re-authentication or "Review this device" was asked from, once, and only
  // for the same account at the epoch the destination asks for (`return-destination.ts`). A navigation convenience, never a permission.
  useEffect(() => {
    if (account === null || epoch === null) return;
    const destination = returnDestination.take(account, epoch, Date.now());
    if (destination === null) return;
    void router.navigate({ to: destination.path as "/settings" });
    return focusWhenPresent(destination.focusKey);
  }, [account, epoch, router]);
  const env = useMemo<ShellEnv>(
    () => ({
      syncModel,
      onOpenSync: (destination) => {
        void router.navigate({
          to: "/sync",
          search: { tab: destination === "conflicts" ? "conflicts" : "queue" },
        });
      },
      ...(label === null || account === null
        ? {}
        : {
            accountSlot: ({ collapsed, returnFocus }: ShellSlotState) => (
              <AccountSlot
                label={label}
                account={account}
                collapsed={collapsed}
                returnFocus={returnFocus}
              />
            ),
          }),
    }),
    [syncModel, label, account, router],
  );
  return (
    <ShellEnvProvider value={env}>
      {children}
      {/* WEB-08c: the switcher's host, beside the routed shell. Its dialogs carry the in-dialog sync control, so it has the same sync status. */}
      <SyncStatusProvider
        value={{ model: env.syncModel, onOpen: env.onOpenSync }}
      >
        <SwitchHost />
      </SyncStatusProvider>
    </ShellEnvProvider>
  );
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
  // Once per document, before the first router: the document's own record of where it is outlives every mount of the tree and every
  // router, so a screen can tell that the person left it while the tree was unmounted (WEB-13a revision 6, `route-changes.ts`).
  documentRouteChanges();
  /** The account this page mounted a tree for last (page memory). */
  let lastMounted: string | null = null;
  return (account?: string): ReactNode => {
    // WEB-08c (R4 of the review of 11 October 2026; matrix 3.7.2 "the settled account changed", T22 t5(i), lifecycle row 7): a tree for a
    // DIFFERENT account than this page mounted last starts at `/`, so nothing of the previous account's location survives (its route, a
    // Settings dialog's route, a search) and focus goes to the new shell's main heading. The page's first tree keeps the address it was
    // opened at (a deep link, a reload), and the same account's tree keeps its place.
    if (account !== undefined) {
      if (lastMounted !== null && lastMounted !== account)
        history.replaceState(null, "", "/");
      lastMounted = account;
    }
    normalisePublicPath();
    // A new router per mount: an account change must not inherit the previous account's location or loaders.
    const router = createAppRouter();
    return (
      <SessionProvider session={session}>
        <ProtectedProviders>
          <DataProvider session={session} commands={appCommands()}>
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
