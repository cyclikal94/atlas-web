import { useCallback, useEffect, useRef, useState } from "react";
import type { Result } from "../../../session";
import { untilSent } from "./until-sent";

export interface LoadError {
  reason: "offline" | "failed";
  /** Copyable, from the Atlas error body when there was one. */
  requestId?: string;
  /** The result's own error, for a screen that must tell "the session ended" (the neutral state takes over) from a failure. */
  cause?: Extract<Result<unknown>, { ok: false }>["error"];
}
export type Load<T> =
  | { status: "loading" }
  | { status: "ready"; value: T }
  | { status: "error"; error: LoadError };

export const toLoadError = (
  result: Extract<Result<unknown>, { ok: false }>,
): LoadError => ({
  reason: result.error === "offline" ? "offline" : "failed",
  requestId: result.atlasError?.request_id,
  cause: result.error,
});

/**
 * One independent load. Sessions and devices are two requests with their own loading and error states (WF-SETTINGS-02, F5).
 * A `StampedRequestError('auth_state')` needs no screen: the session view has already switched to a neutral state and this
 * tree is being unmounted. A stale answer never overwrites a newer one.
 *
 * Returns the state, `reload` (shows the loading state, as on entry and Retry) and `refresh`, a QUIET read
 * (WEB08D-NAVIGATION-FRESHNESS-20261011, the person came back to the tab or window): what is on screen stays while it is read, so
 * rows keep their identity and focus; the answer replaces it as a load's would (a failure shows the usual error and its Retry, it is
 * never presented as fresh data). Only a list on screen is refreshed: a load in flight answers anyway, an error keeps its Retry,
 * and a refresh already in flight is not doubled. `isCurrent` (the identity the return happened under) is asked before every call
 * and before the answer is shown; a newer load or refresh supersedes it.
 */
export function useLoad<T>(
  load: () => Promise<Result<T>>,
): [Load<T>, () => void, (isCurrent?: () => boolean) => void] {
  const [state, setState] = useState<Load<T>>({ status: "loading" });
  const shown = useRef(state);
  shown.current = state;
  const generation = useRef(0);
  const refreshing = useRef<number | null>(null);
  const loader = useRef(load);
  loader.current = load;

  const run = useCallback(() => {
    const mine = ++generation.current;
    setState({ status: "loading" });
    // A `not_sent` answer (the moment after display, while the resume verification holds requests) is called again, not shown.
    untilSent(() => loader.current(), {
      isCurrent: () => mine === generation.current,
    }).then(
      (result) => {
        if (mine !== generation.current) return;
        setState(
          result.ok
            ? { status: "ready", value: result.value }
            : { status: "error", error: toLoadError(result) },
        );
      },
      () => {
        if (mine !== generation.current) return;
        setState({ status: "error", error: { reason: "failed" } });
      },
    );
  }, []);

  const refresh = useCallback((isCurrent: () => boolean = () => true) => {
    if (
      shown.current.status !== "ready" ||
      refreshing.current === generation.current
    )
      return;
    const mine = ++generation.current;
    refreshing.current = mine;
    const current = () => mine === generation.current && isCurrent();
    const settle = (next: Load<T>) => {
      if (refreshing.current === mine) refreshing.current = null;
      if (current()) setState(next);
    };
    untilSent(() => loader.current(), { isCurrent: current }).then(
      (result) =>
        settle(
          result.ok
            ? { status: "ready", value: result.value }
            : { status: "error", error: toLoadError(result) },
        ),
      () => settle({ status: "error", error: { reason: "failed" } }),
    );
  }, []);

  useEffect(() => {
    run();
    return () => {
      generation.current += 1;
    };
  }, [run]);

  return [state, run, refresh];
}

/** Whether the browser believes it is online. A hint only: the requests themselves are the evidence. */
export function useOnline(): boolean {
  const [online, setOnline] = useState(() => navigator.onLine);
  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    return () => {
      window.removeEventListener("online", on);
      window.removeEventListener("offline", off);
    };
  }, []);
  return online;
}
