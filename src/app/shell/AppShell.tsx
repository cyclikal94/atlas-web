import { Link } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";
import { type ReactNode, useRef, useState } from "react";
import { SkipLink } from "../../components/ui/skip-link";
import {
  SyncAnnouncements,
  SyncStatusChip,
  SyncStatusProvider,
} from "../../components/ui/sync-status";
import { useChromeInsets } from "./chrome-insets";
import { type ShellEnv, ShellEnvProvider } from "./env";
import { useLayoutMode } from "./layout-mode";
import { MoreSheet } from "./MoreSheet";
import { Rail, WorkspaceChip } from "./Rail";
import { RouteFocus } from "./RouteFocus";
import { TabBar } from "./TabBar";
import { TitleSync } from "./TitleSync";

export interface AppShellProps extends ShellEnv {
  /** Routed content. */
  children: ReactNode;
  /** Detail screens hide the tab bar and show a back affordance on mobile. */
  mobileBack?: { label: string; to: string };
}

/**
 * The shared chrome: skip link, rail (236px), icon rail (64px) or bottom tabs, the persistent sync chip
 * and the main landmark. Exactly one primary navigation is rendered for the current width.
 * It renders no account data itself: the slots are supplied by later slices.
 *
 * The document scrolls, and the chrome stays in the viewport while it does: the rail is sticky and exactly one viewport
 * tall (its navigation scrolls inside it when the window is short, the status below it does not), and on mobile the
 * header and the bottom tabs are sticky. A screen supplies ordinary long content in <main> and does nothing else.
 * Sticky bars cover part of the viewport, so `useChromeInsets` keeps focus scrolling clear of them.
 */
export function AppShell({ children, mobileBack, ...env }: AppShellProps) {
  const mode = useLayoutMode();
  const [moreOpen, setMoreOpen] = useState(false);
  const moreButton = useRef<HTMLButtonElement>(null);
  const [header, setHeader] = useState<HTMLElement | null>(null);
  const [tabBar, setTabBar] = useState<HTMLElement | null>(null);
  useChromeInsets(header, tabBar);
  const main = (
    <main
      id="main"
      tabIndex={-1}
      // isolate: nothing a screen positions inside main can be stacked above the sticky chrome.
      className="isolate min-w-0 flex-1 px-4 py-3 tablet:px-9 tablet:py-8 desktop:px-12 desktop:py-10"
    >
      {children}
    </main>
  );
  return (
    <ShellEnvProvider value={env}>
      <SyncStatusProvider
        value={{ model: env.syncModel, onOpen: env.onOpenSync }}
      >
        <SkipLink />
        <SyncAnnouncements model={env.syncModel} />
        <RouteFocus />
        <TitleSync />
        {mode === "mobile" ? (
          <div className="flex min-h-dvh flex-col bg-background">
            <header
              ref={setHeader}
              className="sticky top-0 z-30 flex items-center gap-3 border-b bg-background px-4 py-2"
            >
              {mobileBack ? (
                <Link
                  to={mobileBack.to}
                  className="atlas-transition -ml-2 flex min-h-11 items-center gap-1.5 rounded-md px-2 text-sm font-medium text-muted-foreground hover:bg-accent hover:text-accent-foreground"
                >
                  <ArrowLeft aria-hidden="true" className="size-[18px]" />
                  {mobileBack.label}
                </Link>
              ) : (
                <WorkspaceChip collapsed={false} />
              )}
              <div className="ml-auto">
                <SyncStatusChip variant="topbar" />
              </div>
            </header>
            {main}
            {mobileBack ? null : (
              <TabBar
                barRef={setTabBar}
                moreOpen={moreOpen}
                moreRef={moreButton}
                onOpenMore={() => setMoreOpen(true)}
              />
            )}
            <MoreSheet
              open={moreOpen}
              returnFocusRef={moreButton}
              onClose={() => setMoreOpen(false)}
            />
          </div>
        ) : (
          <div className="flex min-h-dvh bg-background">
            <Rail mode={mode} />
            {main}
          </div>
        )}
      </SyncStatusProvider>
    </ShellEnvProvider>
  );
}
