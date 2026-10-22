import { SUCCESSOR_LIMIT_MS, SUCCESSOR_POLL_MS } from "./refresh";
import type { CalendarResult, LiveSources } from "./result";

/**
 * What the screen has SEEN of a source's refresh activity without doing anything itself (WEB-13a, D-13a-13; revision 4, R10), as PURE
 * functions. The observer (`observation-controller.ts`) reads the live list when the screen opens (a reload, another tab's or another
 * device's refresh, the server's own scheduled refresh or an import): while a read returns the source holding a lease it shows
 * "Refreshing…", and once one returns it not holding one the row shows its synced history again.
 *
 * An observation is not an operation: it has no key, sends nothing and resumes nothing, and it never says that a refresh succeeded (the
 * flag turning false is also what a lapsed lease or a settings change looks like, R9). Only a read that RETURNED the source is evidence;
 * a failed read, or one that did not return it, is `unknown`. It is bounded: at most `OBSERVE_LIMIT_MS` from its first read, read
 * again every `OBSERVE_POLL_MS` while busy.
 */

export const OBSERVE_POLL_MS = SUCCESSOR_POLL_MS;
export const OBSERVE_LIMIT_MS = SUCCESSOR_LIMIT_MS;

export type Observation =
  /** Not read yet. */
  | { kind: "checking" }
  /** The last read returned the source holding a lease. */
  | { kind: "busy" }
  /** A read returned the source not holding one: the row's synced health is the rest. Final. */
  | { kind: "idle" }
  /**
   * A read failed or did not return the source, or the time ran out: whether anything is running is not known. Final. `seenBusy`
   * says whether an earlier read had shown it running (the row then says it could not check, rather than dropping "Refreshing…").
   */
  | { kind: "unknown"; seenBusy: boolean }
  /** Stopped (offline, the session or identity changed, the screen closed): nothing to show. Final. */
  | { kind: "ended" };

export const CHECKING: Observation = { kind: "checking" };
export const ENDED: Observation = { kind: "ended" };

/** Whether the observation may still change (a read is due or out). */
export function observing(observation: Observation): boolean {
  return observation.kind === "checking" || observation.kind === "busy";
}

/** What a read of the live list says about the source `id`. */
export function observe(
  previous: Observation,
  id: string,
  result: CalendarResult<LiveSources>,
): Observation {
  if (!observing(previous)) return previous;
  const seenBusy = previous.kind === "busy";
  if (!result.ok)
    return result.kind === "offline" || result.kind === "closed"
      ? ENDED
      : { kind: "unknown", seenBusy };
  const entry = result.value.sources.get(id);
  // Absent from a complete list or beyond an incomplete walk: either way it says nothing about a lease (R9).
  if (entry === undefined) return { kind: "unknown", seenBusy };
  return entry.refreshInProgress ? { kind: "busy" } : { kind: "idle" };
}

/** The observation's time ran out. */
export function expire(previous: Observation): Observation {
  if (!observing(previous)) return previous;
  return { kind: "unknown", seenBusy: previous.kind === "busy" };
}
