import { PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { AtlasLockup } from "../../components/ui/brand";
import { List } from "../../components/ui/list";
import { SyncStatusChip } from "../../components/ui/sync-status";
import { Tooltip } from "../../components/ui/tooltip";
import { cn } from "../../lib/utils";
import { type Destination, destinations } from "./destinations";
import { renderSlot, useShellEnv } from "./env";
import type { LayoutMode } from "./layout-mode";
import { RailItem, RailLink } from "./nav-item";
import {
  usePinnedLists,
  useSidebarPreference,
  writeSidebarPreference,
} from "./preferences";

export const RAIL_COPY = {
  workspace: "Workspace",
  primary: "Primary",
  pinned: "Pinned lists",
  collapse: "Collapse sidebar",
  expand: "Expand sidebar",
} as const;

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

/** Whether the rail is collapsed for this width: the person's choice, else open on the desktop and collapsed on the tablet. */
export function useRailCollapsed(mode: Exclude<LayoutMode, "mobile">): boolean {
  const preference = useSidebarPreference();
  if (preference === "auto") return mode === "tablet";
  return preference === "collapsed";
}

/**
 * The sidebar (240px) and its collapsed icon rail (64px), on shadcn/ui's sidebar tokens: one primary navigation landmark with the
 * day views, the pinned lists with "All lists" and "All tasks", then the household's Sharing and Settings; the footer holds the sync
 * status, the account row and the collapse toggle. The toggle's choice is kept on this device; without one the desktop is open and
 * the tablet collapsed.
 *
 * The rail is sticky and exactly one viewport tall, so it and its status footer stay in view however long the page. When the
 * window is too short for every destination, the navigation scrolls inside the rail and the footer stays put. The navigation
 * carries a little padding (and an equal negative margin) so the scroll container does not clip the 2px focus ring at a 2px offset.
 */
export function Rail({ mode }: { mode: Exclude<LayoutMode, "mobile"> }) {
  const env = useShellEnv();
  const collapsed = useRailCollapsed(mode);
  const pinned = usePinnedLists();
  const group = (id: Destination["group"]) => (
    <List className="flex flex-col gap-0.5">
      {destinations
        .filter((destination) => destination.group === id)
        .map((destination) => (
          <li key={destination.id} className="list-none">
            <RailItem destination={destination} collapsed={collapsed} />
          </li>
        ))}
    </List>
  );
  const divider = (
    <div
      aria-hidden="true"
      className={cn(
        "h-px bg-sidebar-border",
        collapsed ? "mx-auto my-3 w-8" : "mx-3 my-3",
      )}
    />
  );
  const toggle = (
    <button
      type="button"
      aria-label={collapsed ? RAIL_COPY.expand : RAIL_COPY.collapse}
      aria-expanded={!collapsed}
      data-rail-toggle=""
      onClick={() =>
        writeSidebarPreference(collapsed ? "expanded" : "collapsed")
      }
      className="atlas-transition flex size-11 flex-none items-center justify-center rounded-md text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
    >
      {collapsed ? (
        <PanelLeftOpen aria-hidden="true" className="size-[18px]" />
      ) : (
        <PanelLeftClose aria-hidden="true" className="size-[18px]" />
      )}
    </button>
  );
  return (
    <section
      aria-label={RAIL_COPY.workspace}
      data-rail={collapsed ? "collapsed" : "expanded"}
      className={cn(
        "sticky top-0 flex h-dvh flex-none flex-col self-start border-r border-sidebar-border bg-sidebar pb-3 pt-3 text-sidebar-foreground",
        collapsed ? "w-16 items-center px-[9px]" : "w-[240px] px-3",
      )}
    >
      <div className="mb-4 flex-none">
        {renderSlot(env.workspaceSlot, collapsed) ?? (
          <WorkspaceChip collapsed={collapsed} />
        )}
      </div>
      <nav
        aria-label={RAIL_COPY.primary}
        // A classic scrollbar would not fit beside the 44px icons in the 64px rail, so it is hidden there (wheel, touch and focus
        // still scroll); the wide rail has room for a thin one.
        className={cn(
          "-mx-1 -my-1 flex min-h-0 flex-1 flex-col self-stretch overflow-y-auto px-1 py-1",
          collapsed ? "[scrollbar-width:none]" : "[scrollbar-width:thin]",
        )}
      >
        {group("main")}
        {collapsed ? (
          divider
        ) : (
          <p className="mt-5 mb-1.5 px-3 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
            {RAIL_COPY.pinned}
          </p>
        )}
        {pinned.length > 0 && !collapsed ? (
          <List className="flex flex-col gap-0.5" data-pinned-lists="">
            {pinned.map((list) => (
              <li key={list.id} className="list-none">
                <RailLink
                  to="/tasks/lists/$listId"
                  params={{ listId: list.id }}
                  label={list.label}
                  collapsed={false}
                  exact
                  icon={
                    <span
                      aria-hidden="true"
                      className="flex w-[18px] flex-none justify-center"
                    >
                      <span className="size-2 rounded-full bg-chart-2 group-data-[status=active]:bg-primary" />
                    </span>
                  }
                />
              </li>
            ))}
          </List>
        ) : null}
        {group("lists")}
        {divider}
        {group("system")}
      </nav>
      <div
        className={cn(
          "mt-3 flex flex-none flex-col gap-1",
          collapsed ? "items-center" : "",
        )}
      >
        <SyncStatusChip variant={collapsed ? "rail-collapsed" : "rail"} />
        {renderSlot(env.accountSlot, collapsed)}
        <div
          className={cn("flex", collapsed ? "justify-center" : "justify-end")}
        >
          {collapsed ? (
            <Tooltip content={RAIL_COPY.expand}>{toggle}</Tooltip>
          ) : (
            toggle
          )}
        </div>
      </div>
    </section>
  );
}
