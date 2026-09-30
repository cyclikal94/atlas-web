import { afterEach, beforeEach } from "vitest";

/**
 * A controllable window.matchMedia. Queries are evaluated against a viewport width and a colour scheme, so shell
 * tests can put the layout in any mode and theme tests can flip the device preference.
 */
export interface MediaState {
  width: number;
  prefersLight: boolean;
}

type Listener = (event: MediaQueryListEvent) => void;

/**
 * Registers hooks: a fresh matchMedia (and default state) is installed before each test and removed after it.
 */
export function installMatchMedia(initial: Partial<MediaState> = {}) {
  const defaults: MediaState = { width: 1440, prefersLight: false, ...initial };
  const state: MediaState = { ...defaults };
  let lists = new Set<{
    query: string;
    listeners: Set<Listener>;
    matches: boolean;
  }>();
  const evaluate = (query: string): boolean => {
    const min = /\(min-width:\s*(\d+)px\)/.exec(query);
    if (min?.[1]) return state.width >= Number(min[1]);
    if (query.includes("prefers-color-scheme: light"))
      return state.prefersLight;
    if (query.includes("prefers-color-scheme: dark"))
      return !state.prefersLight;
    return false;
  };
  const original = window.matchMedia;
  const install = () => {
    Object.assign(state, defaults);
    lists = new Set();
    window.matchMedia = ((query: string) => {
      const entry = {
        query,
        listeners: new Set<Listener>(),
        matches: evaluate(query),
      };
      lists.add(entry);
      return {
        get matches() {
          return entry.matches;
        },
        media: query,
        onchange: null,
        addEventListener: (_: string, listener: Listener) =>
          entry.listeners.add(listener),
        removeEventListener: (_: string, listener: Listener) =>
          entry.listeners.delete(listener),
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => false,
      } as unknown as MediaQueryList;
    }) as typeof window.matchMedia;
  };
  beforeEach(install);
  afterEach(() => {
    window.matchMedia = original;
  });
  return {
    set(next: Partial<MediaState>) {
      Object.assign(state, next);
      for (const entry of lists) {
        const matches = evaluate(entry.query);
        if (matches === entry.matches) continue;
        entry.matches = matches;
        for (const listener of entry.listeners)
          listener({ matches, media: entry.query } as MediaQueryListEvent);
      }
    },
  };
}
