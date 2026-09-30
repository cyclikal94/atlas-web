import { useSyncExternalStore } from "react";

/** Breakpoints from ia.md 1.1: desktop 1280 and up, tablet 768 to 1279, mobile 767 and below. */
export type LayoutMode = "desktop" | "tablet" | "mobile";
const DESKTOP = "(min-width: 1280px)";
const TABLET = "(min-width: 768px)";

function read(): LayoutMode {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function")
    return "desktop";
  if (window.matchMedia(DESKTOP).matches) return "desktop";
  return window.matchMedia(TABLET).matches ? "tablet" : "mobile";
}

function subscribe(onChange: () => void): () => void {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function")
    return () => {};
  const queries = [window.matchMedia(DESKTOP), window.matchMedia(TABLET)];
  for (const query of queries) query.addEventListener("change", onChange);
  return () => {
    for (const query of queries) query.removeEventListener("change", onChange);
  };
}

/** Exactly one navigation landmark is rendered for the current mode, so two never reach assistive technology. */
export function useLayoutMode(): LayoutMode {
  return useSyncExternalStore(subscribe, read, () => "desktop");
}
