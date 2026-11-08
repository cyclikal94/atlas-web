import { useSyncExternalStore } from "react";

/**
 * Two preferences of the shell, kept on this device only (like the appearance choice, `design/theme.ts`): whether the sidebar is
 * collapsed to its 64px icon rail, and which lists are pinned under "Pinned lists". Neither is account data: a pinned list is named
 * by its id and label only, and both are read defensively (storage may be absent, full or hold something else).
 */
export const SIDEBAR_STORAGE_KEY = "atlas.sidebar.v1";
export const PINNED_LISTS_STORAGE_KEY = "atlas.pinned-lists.v1";
/** No stored choice: the desktop rail is open and the tablet rail is collapsed. */
export type SidebarPreference = "auto" | "expanded" | "collapsed";

export interface PinnedList {
  id: string;
  label: string;
}

const listeners = new Set<() => void>();
const notify = () => {
  for (const listener of listeners) listener();
};
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  const onStorage = (event: StorageEvent) => {
    if (
      event.key === null ||
      event.key === SIDEBAR_STORAGE_KEY ||
      event.key === PINNED_LISTS_STORAGE_KEY ||
      event.key === TASK_WRAPPER_STORAGE_KEY
    )
      listener();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
};

function storage(): Storage | null {
  try {
    return globalThis.localStorage;
  } catch {
    return null;
  }
}
function readRaw(key: string): string | null {
  try {
    return storage()?.getItem(key) ?? null;
  } catch {
    return null;
  }
}
function writeRaw(key: string, value: string | null) {
  try {
    const store = storage();
    if (!store) return;
    if (value === null) store.removeItem(key);
    else store.setItem(key, value);
  } catch {
    // Full or blocked storage keeps the preference for this page only.
  }
}

export function readSidebarPreference(): SidebarPreference {
  const raw = readRaw(SIDEBAR_STORAGE_KEY);
  return raw === "expanded" || raw === "collapsed" ? raw : "auto";
}
export function writeSidebarPreference(value: SidebarPreference) {
  writeRaw(SIDEBAR_STORAGE_KEY, value === "auto" ? null : value);
  notify();
}
export function useSidebarPreference(): SidebarPreference {
  return useSyncExternalStore(subscribe, readSidebarPreference, () => "auto");
}

let pinnedCache: { raw: string | null; value: PinnedList[] } | null = null;
export function readPinnedLists(): PinnedList[] {
  const raw = readRaw(PINNED_LISTS_STORAGE_KEY);
  if (pinnedCache !== null && pinnedCache.raw === raw) return pinnedCache.value;
  let value: PinnedList[] = [];
  if (raw !== null) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed))
        value = parsed
          .filter(
            (item): item is PinnedList =>
              typeof item === "object" &&
              item !== null &&
              typeof (item as PinnedList).id === "string" &&
              typeof (item as PinnedList).label === "string",
          )
          .slice(0, 12)
          .map((item) => ({ id: item.id, label: item.label }));
    } catch {
      value = [];
    }
  }
  pinnedCache = { raw, value };
  return value;
}
const EMPTY: PinnedList[] = [];
export function usePinnedLists(): PinnedList[] {
  return useSyncExternalStore(subscribe, readPinnedLists, () => EMPTY);
}
export function isPinned(id: string): boolean {
  return readPinnedLists().some((list) => list.id === id);
}
export function pinList(list: PinnedList) {
  const next = readPinnedLists().filter((item) => item.id !== list.id);
  next.push(list);
  writeRaw(PINNED_LISTS_STORAGE_KEY, JSON.stringify(next));
  notify();
}
export function unpinList(id: string) {
  const next = readPinnedLists().filter((item) => item.id !== id);
  writeRaw(PINNED_LISTS_STORAGE_KEY, next.length ? JSON.stringify(next) : null);
  notify();
}
/** A pinned list's label follows a rename. */
export function renamePinnedList(id: string, label: string) {
  const lists = readPinnedLists();
  if (!lists.some((list) => list.id === id && list.label !== label)) return;
  writeRaw(
    PINNED_LISTS_STORAGE_KEY,
    JSON.stringify(lists.map((l) => (l.id === id ? { ...l, label } : l))),
  );
  notify();
}

/**
 * How a task opens from a list on a wide screen (Settings · Layout, the Final design): the task replaces the list (`page`), fills the
 * right of a split pane (`split`, the default), floats over the list as a side peek (`peek`) or is centred over the dimmed list
 * (`overlay`). The task itself is the same in all four; only the container changes. The phone always opens it as a page, and a
 * split pane needs the desktop width: below it the setting falls back to a page.
 */
export const TASK_WRAPPER_STORAGE_KEY = "atlas.task-wrapper.v1";
export type TaskWrapper = "page" | "split" | "peek" | "overlay";
export const TASK_WRAPPERS: readonly TaskWrapper[] = [
  "page",
  "split",
  "peek",
  "overlay",
];
export function readTaskWrapper(): TaskWrapper {
  const raw = readRaw(TASK_WRAPPER_STORAGE_KEY);
  return (TASK_WRAPPERS as readonly string[]).includes(raw ?? "")
    ? (raw as TaskWrapper)
    : "split";
}
export function writeTaskWrapper(value: TaskWrapper) {
  writeRaw(TASK_WRAPPER_STORAGE_KEY, value === "split" ? null : value);
  notify();
}
export function useTaskWrapper(): TaskWrapper {
  return useSyncExternalStore(subscribe, readTaskWrapper, () => "split");
}
