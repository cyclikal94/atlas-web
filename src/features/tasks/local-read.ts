import { useEffect, useRef, useState } from "react";
import type { LocalRead } from "../../data";

/**
 * A certified read of this device's data for one screen (WEB-10a revision 3, design assessment C3): `run` reads every input of a
 * composition between two reads of the local basis (`readCoherently`), and this hook decides WHEN it runs and what is kept.
 *
 * - It runs when `scope` changes (another identity, day, zone or target: the run in progress is abandoned and nothing of the old scope is
 *   kept) and when `trigger` changes (the composition generation moved, the server listed other rows, a retry). A trigger that arrives
 *   while a run is in progress is remembered and runs once that one has ended: a burst of commits costs one more read, not one each, and
 *   the last change is always read.
 * - `complete` is the last complete read of the scope: kept while a later read is in progress, failed or kept changing, so the screen can
 *   show it as stale rather than empty. `latest` is how the last finished read ended. Nothing here turns a failed read into an empty one.
 */
export interface ScopedRead<T> {
  /** The last complete read of the current scope, or null. */
  complete: { value: T; scope: string } | null;
  /** How the last finished read of the current scope ended, or null before any. */
  latest: LocalRead<T>["kind"] | null;
  /** A read of the current scope is in progress (or due). */
  reading: boolean;
}

export function useScopedRead<T>(
  scope: string,
  trigger: string,
  run: (signal: AbortSignal) => Promise<LocalRead<T>>,
  /** False: nothing to read (no database on this device); the hook stays idle. */
  enabled = true,
): ScopedRead<T> {
  const [state, setState] = useState<{
    scope: string;
    complete: T | null;
    latest: LocalRead<T>["kind"] | null;
    reading: boolean;
  }>({ scope, complete: null, latest: null, reading: enabled });
  const latestRun = useRef(run);
  latestRun.current = run;
  const flight = useRef<{
    scope: string;
    controller: AbortController;
    again: boolean;
  } | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `trigger` is the reason to read again; its value is not used
  useEffect(() => {
    if (!enabled) {
      flight.current?.controller.abort();
      flight.current = null;
      return;
    }
    const current = flight.current;
    if (current !== null && current.scope === scope) {
      // The same scope is being read: read once more when it ends (its result may predate this trigger).
      current.again = true;
      return;
    }
    current?.controller.abort();
    const start = (): void => {
      const controller = new AbortController();
      const mine = { scope, controller, again: false };
      flight.current = mine;
      setState((prev) =>
        prev.scope === scope
          ? prev.reading
            ? prev
            : { ...prev, reading: true }
          : { scope, complete: null, latest: null, reading: true },
      );
      void latestRun.current(controller.signal).then((read) => {
        if (flight.current !== mine || controller.signal.aborted) return;
        flight.current = null;
        setState((prev) => {
          if (prev.scope !== scope) return prev;
          return {
            scope,
            complete: read.kind === "complete" ? read.value : prev.complete,
            latest: read.kind === "aborted" ? prev.latest : read.kind,
            reading: mine.again,
          };
        });
        if (mine.again) start();
      });
    };
    start();
  }, [scope, trigger, enabled]);

  // The scope's flight is abandoned when the screen goes.
  useEffect(
    () => () => {
      flight.current?.controller.abort();
      flight.current = null;
    },
    [],
  );

  if (state.scope !== scope)
    return { complete: null, latest: null, reading: enabled };
  return {
    complete: state.complete === null ? null : { value: state.complete, scope },
    latest: state.latest,
    reading: state.reading,
  };
}
