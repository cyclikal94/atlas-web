import { useCallback, useEffect, useRef, useState } from "react";
import type { Result } from "../../../session";
import { untilSent } from "./until-sent";

export interface LoadError {
  reason: "offline" | "failed";
  /** Copyable, from the Atlas error body when there was one. */
  requestId?: string;
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
});

/**
 * One independent load. Sessions and devices are two requests with their own loading and error states (WF-SETTINGS-02, F5).
 * A `StampedRequestError('auth_state')` needs no screen: the session view has already switched to a neutral state and this
 * tree is being unmounted. A stale answer never overwrites a newer one.
 */
export function useLoad<T>(
  load: () => Promise<Result<T>>,
): [Load<T>, () => void] {
  const [state, setState] = useState<Load<T>>({ status: "loading" });
  const generation = useRef(0);
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

  useEffect(() => {
    run();
    return () => {
      generation.current += 1;
    };
  }, [run]);

  return [state, run];
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
