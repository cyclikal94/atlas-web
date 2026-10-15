/**
 * The page's completed in-app navigation signal (WEB-14a, revision 17, R24; WEB-04 wireframe 6: a dismissed update banner reappears on the
 * next natural navigation or app focus). It is in the initial chunk, so it is deliberately tiny: the router's adapter (`NavigationSignal`)
 * raises it and the lazily loaded coordinator listens. It carries nothing (no location, account or form) and keeps nothing: a navigation
 * before the coordinator listens is not told later, because nothing can have been dismissed then.
 */
type Listener = () => void;

const listeners = new Set<Listener>();

/** The active router rendered a different destination of this document (never its first load). */
export function noteNavigation(): void {
  for (const listener of [...listeners]) listener();
}

export function onNavigation(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
