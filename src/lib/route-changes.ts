/**
 * The document's own record of where it is (WEB-13a revision 6, R13; design assessment C2): every change of `location.pathname`,
 * whether or not a protected tree, a router or any screen is mounted when it happens.
 *
 * The protected tree is unmounted and mounted again by the session (an Atlas `403` is re-checked behind a protective closure), and every
 * mount makes a new router. A screen that wants to know whether the person LEFT it therefore cannot ask its router or its own cleanup:
 * the person can press Back while no tree is mounted at all. This observes the document instead:
 *
 *  - `popstate` (Back, Forward, `history.go`), and
 *  - every `history.pushState` / `history.replaceState`, whoever calls it (the routers write the address through them; so do the
 *    authentication hand-off and the public-path normalisation).
 *
 * It is installed once per document (`documentRouteChanges`), before the first router: `createProtectedTree` calls it when the session
 * composes the tree, so every router's history wraps these methods rather than the reverse, and no router's teardown can remove them.
 * It never navigates, blocks or delays anything, and it has no subscribers of its own: what to make of a change is the subscriber's.
 * A change of only the query or the fragment is not a change of path, and is not told.
 */
export interface RouteChanges {
  /** The document's current path (`location.pathname`). */
  pathname(): string;
  /** Told after the path changed (once per change, with the new path). */
  subscribe(listener: (pathname: string) => void): () => void;
}

type HistoryWindow = Pick<
  Window,
  "addEventListener" | "removeEventListener"
> & {
  readonly history: Pick<History, "pushState" | "replaceState">;
  readonly location: Pick<Location, "pathname">;
};

/** Observes `win` (tests: a window of their own). `destroy` puts its methods back, if no one wrapped them since. */
export function createRouteChanges(
  win: HistoryWindow,
): RouteChanges & { destroy(): void } {
  const listeners = new Set<(pathname: string) => void>();
  let last = win.location.pathname;
  const changed = (): void => {
    const now = win.location.pathname;
    if (now === last) return;
    last = now;
    for (const listener of [...listeners]) listener(now);
  };
  const { history } = win;
  const push = history.pushState;
  const replace = history.replaceState;
  const pushState: History["pushState"] = function (this: History, ...args) {
    const result = push.apply(this, args);
    changed();
    return result;
  };
  const replaceState: History["replaceState"] = function (
    this: History,
    ...args
  ) {
    const result = replace.apply(this, args);
    changed();
    return result;
  };
  history.pushState = pushState;
  history.replaceState = replaceState;
  win.addEventListener("popstate", changed);
  return {
    pathname: () => win.location.pathname,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    destroy() {
      win.removeEventListener("popstate", changed);
      if (history.pushState === pushState) history.pushState = push;
      if (history.replaceState === replaceState) history.replaceState = replace;
      listeners.clear();
    },
  };
}

let installed: RouteChanges | null = null;

/** The document's route changes, installed by the first call. */
export function documentRouteChanges(): RouteChanges {
  installed ??= createRouteChanges(window);
  return installed;
}

/**
 * The same record over a router's own history (WEB-10a revision 22): a memory history (the component tests' routers) never moves the
 * document, so a screen observing the document there would never see a departure. Told once per change of path, with the new path, after
 * the history moved (push, replace, back, forward, go); a change of only the query or the fragment is not told.
 */
export function createHistoryRouteChanges(history: {
  readonly location: { readonly pathname: string };
  subscribe(listener: () => void): () => void;
}): RouteChanges {
  const listeners = new Set<(pathname: string) => void>();
  let last = history.location.pathname;
  history.subscribe(() => {
    const now = history.location.pathname;
    if (now === last) return;
    last = now;
    for (const listener of [...listeners]) listener(now);
  });
  return {
    pathname: () => history.location.pathname,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
