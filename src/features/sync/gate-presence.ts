import { useSyncExternalStore } from "react";

/**
 * Which screens draw the floor state (b) IN PLACE. A view that reads from the cache is wrapped in `CacheGate`, which draws the floor
 * message where the hidden content would be; the shell's global notices then must not draw the same banner again above it (two
 * identical landmarks on one screen is a defect axe reports, and the same words twice is no kindness). A screen with no gate has the
 * global banner. A module-level count, observable, so the swap happens before the next paint.
 */
let mounted = 0;
const listeners = new Set<() => void>();

export function registerGate(): () => void {
  mounted += 1;
  for (const listener of [...listeners]) listener();
  return () => {
    mounted -= 1;
    for (const listener of [...listeners]) listener();
  };
}

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

export function useGateMounted(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => mounted > 0,
    () => false,
  );
}
