import { AtlasLockup } from "../../components/ui/brand";
import { List } from "../../components/ui/list";
import { SyncStatusChip } from "../../components/ui/sync-status";
import { cn } from "../../lib/utils";
import { destinations } from "./destinations";
import { renderSlot, useShellEnv } from "./env";
import type { LayoutMode } from "./layout-mode";
import { RailItem } from "./nav-item";

export function WorkspaceChip({ collapsed }: { collapsed: boolean }) {
  return (
    <div
      className={cn(
        "flex flex-none items-center",
        collapsed ? "size-11 justify-center" : "h-11 px-3",
      )}
    >
      <AtlasLockup collapsed={collapsed} />
    </div>
  );
}

/**
 * The desktop rail (236px) and the tablet icon rail (64px), on shadcn/ui's sidebar tokens. One primary navigation landmark,
 * two groups split by a divider; the footer holds the sync chip and then the account row.
 *
 * The rail is sticky and exactly one viewport tall, so it and its status footer stay in view however long the page. When
 * the window is too short for every destination, the navigation scrolls inside the rail and the footer stays put.
 * The navigation carries a little padding (and an equal negative margin) so the scroll container does not clip the
 * 2px focus ring at a 2px offset.
 */
export function Rail({ mode }: { mode: Exclude<LayoutMode, "mobile"> }) {
  const env = useShellEnv();
  const collapsed = mode === "tablet";
  const group = (id: 1 | 2) => (
    <List className="flex flex-col gap-0.5">
      {destinations
        .filter((destination) => destination.group === id)
        .map((destination) => (
          <li key={destination.id} className="list-none">
            <RailItem destination={destination} mode={mode} />
          </li>
        ))}
    </List>
  );
  return (
    <section
      aria-label="Workspace"
      className={cn(
        "sticky top-0 flex h-dvh flex-none flex-col self-start border-r border-sidebar-border bg-sidebar text-sidebar-foreground pb-3 pt-3",
        collapsed ? "w-16 items-center px-[9px]" : "w-[236px] px-3",
      )}
    >
      <div className={cn("mb-4 flex-none", collapsed ? "" : "mx-0")}>
        {renderSlot(env.workspaceSlot, collapsed) ?? (
          <WorkspaceChip collapsed={collapsed} />
        )}
      </div>
      <nav
        aria-label="Primary"
        // A classic scrollbar would not fit beside the 44px icons in the 64px rail, so it is hidden there (wheel, touch and focus
        // still scroll); the wide rail has room for a thin one.
        className={cn(
          "-mx-1 -my-1 flex min-h-0 flex-1 flex-col self-stretch overflow-y-auto px-1 py-1",
          collapsed ? "[scrollbar-width:none]" : "[scrollbar-width:thin]",
        )}
      >
        {group(1)}
        <div
          aria-hidden="true"
          className={cn(
            "h-px bg-sidebar-border",
            collapsed ? "mx-auto my-3 w-8" : "mx-3 my-3",
          )}
        />
        {group(2)}
      </nav>
      <div
        className={cn(
          "mt-3 flex flex-none flex-col gap-1",
          collapsed ? "items-center" : "",
        )}
      >
        <SyncStatusChip variant={collapsed ? "rail-collapsed" : "rail"} />
        {renderSlot(env.accountSlot, collapsed)}
      </div>
    </section>
  );
}
