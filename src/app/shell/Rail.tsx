import { List } from "../../components/ui/list";
import { SyncStatusChip } from "../../components/ui/sync-status";
import { destinations } from "./destinations";
import { renderSlot, useShellEnv } from "./env";
import type { LayoutMode } from "./layout-mode";
import { RailItem } from "./nav-item";

export function WorkspaceChip({ collapsed }: { collapsed: boolean }) {
  return (
    <div
      className={`flex items-center gap-2.5 rounded-control border border-chrome-inset-edge bg-chrome-inset ${
        collapsed ? "size-11 justify-center" : "px-2.5 py-2"
      }`}
    >
      <span
        aria-hidden="true"
        className="size-6 flex-none rounded-nav bg-action-fill"
      />
      {collapsed ? (
        <span className="sr-only">Atlas</span>
      ) : (
        <span className="text-[14px] font-semibold text-ink-1">Atlas</span>
      )}
    </div>
  );
}

/**
 * The desktop rail (236px) and the tablet icon rail (64px). One primary navigation landmark, two groups split by a
 * chrome-edge divider; the footer holds the sync chip and then the account row.
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
    <List className="flex flex-col gap-px">
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
      className={`sticky top-0 flex h-dvh flex-none flex-col self-start border-r border-chrome-edge bg-chrome pb-3 pt-3.5 ${
        collapsed ? "w-16 items-center px-[9px]" : "w-[236px] px-2"
      }`}
    >
      <div className={collapsed ? "mb-4 flex-none" : "mx-2 mb-4 flex-none"}>
        {renderSlot(env.workspaceSlot, collapsed) ?? (
          <WorkspaceChip collapsed={collapsed} />
        )}
      </div>
      <nav
        aria-label="Primary"
        // A classic scrollbar would not fit beside the 44px icons in the 64px rail, so it is hidden there (wheel, touch and focus
        // still scroll); the wide rail has room for a thin one.
        className={`-mx-1 -my-1 flex min-h-0 flex-1 flex-col self-stretch overflow-y-auto px-1 py-1 ${
          collapsed ? "[scrollbar-width:none]" : "[scrollbar-width:thin]"
        }`}
      >
        {group(1)}
        <div
          aria-hidden="true"
          className={`h-px bg-chrome-edge ${collapsed ? "my-3.5 w-8" : "mx-2 my-3.5"}`}
        />
        {group(2)}
      </nav>
      <div
        className={`mt-3 flex flex-none flex-col gap-0.5 ${collapsed ? "items-center" : ""}`}
      >
        <SyncStatusChip variant={collapsed ? "rail-collapsed" : "rail"} />
        {renderSlot(env.accountSlot, collapsed)}
      </div>
    </section>
  );
}
