import type { ComponentType } from "react";
import type { CacheRow } from "../../data";

/**
 * The actions a calendar row offers beyond Refresh and Manage, as an APPEND-ONLY registry (like the Settings registry): WEB-13b adds
 * ONE entry here for "Import events" and edits nothing else. Each action renders after Manage on every row, cached or pending (the
 * wireframe keeps "Import events" enabled on a pending source: the import queues behind its create).
 */
export interface CalendarSourceView {
  id: string;
  label: string;
  /** The row as the cache and its overlay say it, or the projection of this device's pending create. */
  row: CacheRow;
  /** True for a create this device saved that the server has not confirmed yet. */
  pending: boolean;
}

export interface CalendarRowAction {
  id: string;
  owner: "WEB-13";
  Render: ComponentType<{ source: CalendarSourceView }>;
}

const ROW_ACTIONS: readonly CalendarRowAction[] = [];

export const calendarRowActions = (): readonly CalendarRowAction[] =>
  ROW_ACTIONS;
