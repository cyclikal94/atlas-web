import type { CalendarApi } from "./api";
import {
  CHECKING,
  ENDED,
  expire,
  OBSERVE_LIMIT_MS,
  OBSERVE_POLL_MS,
  type Observation,
  observe,
  observing,
} from "./model/observation";
import type { CalendarResult, LiveSources } from "./model/result";
import type { Timers } from "./refresh-controller";

/**
 * The refresh activity of the sources ONE mounted calendar screen shows, observed by reading the live list (WEB-13a, D-13a-13;
 * revision 4, R10): it performs what `model/observation.ts` decides and nothing else. It only ever reads `GET /calendar-sources`: it has
 * no key and no way to send a refresh, a command or a draft, and it writes nothing (no cache, no storage, no form).
 *
 *  - It reads the sources the screen lists (`watch`, one page of the list): ONE bounded walk serves every source due, never one per row,
 *    and walks never overlap. A source listed later (a new page, a create the cache now holds) is read at once (a poll waiting for its
 *    time is made then, with it), or with the next walk if one is out.
 *  - A source seen busy is read again every `OBSERVE_POLL_MS`, until a read returns it idle, fails or does not return it, or its
 *    `OBSERVE_LIMIT_MS` (from the first walk that included it) runs out. The time limit is not extended by anything, and a read still out
 *    at it is not waited for: its answer is dropped for that source, and no further page of the walk is admitted.
 *  - A press of Refresh or "Check again" on this screen (`yieldTo`) ends the source's observation for the life of the observer: its own
 *    run shows what it learns, and a read made before the press can no longer change the row.
 *  - It reads only once the server is known to be compatible, and only while online. Going offline (or the server becoming incompatible)
 *    stops it for good: nothing it did is resumed, and coming back online reads nothing more until the screen is opened again.
 *  - The screen builds one per client (identity) and disposes it on unmount: a read still out is then dropped.
 */
export interface SourceObserver {
  /** The sources the screen lists now. Unchanged ids keep their observation (and its time limit); removed ones are dropped. */
  watch(ids: readonly string[]): void;
  /** A refresh of `id` was started on this screen: its observation ends here, and nothing more is read for it. */
  yieldTo(id: string): void;
  /** What was observed of `id`, or null when it is not observed. */
  observation(id: string): Observation | null;
  /** Whether the server is compatible: nothing is read until it is, and it stops for good if it no longer is. */
  compatible(ok: boolean): void;
  /** The page went offline: every observation stops for good (nothing shown, nothing resumed). */
  offline(): void;
  subscribe(listener: () => void): () => void;
  /** Stops everything and drops every read still out. Idempotent. */
  dispose(): void;
}

interface Watched {
  observation: Observation;
  /** Bumped whenever the observation changes or stops: a read made for an older generation is dropped. */
  generation: number;
  /** When the observation's time runs out (`now()`), set by the first walk that includes it. */
  deadline: number | null;
  deadlineTimer: unknown;
}

export function createSourceObserver(deps: {
  api: Pick<CalendarApi, "liveSources">;
  timers?: Timers;
  /** A monotonic clock in milliseconds. */
  now?: () => number;
}): SourceObserver {
  const timers: Timers = deps.timers ?? {
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (handle) => clearTimeout(handle as never),
  };
  const now = deps.now ?? (() => performance.now());
  const watched = new Map<string, Watched>();
  const yielded = new Set<string>();
  const listeners = new Set<() => void>();
  let generations = 0;
  let disposed = false;
  let stopped = false;
  let compatible = false;
  let walking = false;
  let pollTimer: unknown = null;

  const notify = (): void => {
    for (const listener of [...listeners]) listener();
  };

  const current = (id: string, generation: number): Watched | null => {
    const entry = watched.get(id);
    return !stopped && entry !== undefined && entry.generation === generation
      ? entry
      : null;
  };

  const set = (entry: Watched, observation: Observation): void => {
    generations += 1;
    entry.generation = generations;
    entry.observation = observation;
    if (!observing(observation) && entry.deadlineTimer !== null) {
      timers.clearTimeout(entry.deadlineTimer);
      entry.deadlineTimer = null;
    }
  };

  const drop = (entry: Watched): void => {
    if (entry.deadlineTimer !== null) timers.clearTimeout(entry.deadlineTimer);
    entry.deadlineTimer = null;
    generations += 1;
    entry.generation = generations;
  };

  /** The time of `entry` ran out (its timer, or a read answered after it). */
  const lapse = (id: string, entry: Watched): void => {
    if (stopped || watched.get(id) !== entry || !observing(entry.observation))
      return;
    set(entry, expire(entry.observation));
    notify();
  };

  /** Reads the live list for every source due; false when none is (or a walk is out). */
  const walk = (): boolean => {
    if (stopped || !compatible || walking) return false;
    const started = now();
    const cohort = [...watched]
      .filter(
        ([, entry]) =>
          observing(entry.observation) &&
          (entry.deadline === null || started < entry.deadline),
      )
      .map(([id, entry]) => ({ id, entry, generation: entry.generation }));
    if (cohort.length === 0) return false;
    for (const { id, entry } of cohort)
      if (entry.deadline === null) {
        entry.deadline = started + OBSERVE_LIMIT_MS;
        entry.deadlineTimer = timers.setTimeout(() => {
          entry.deadlineTimer = null;
          lapse(id, entry);
          schedule();
        }, OBSERVE_LIMIT_MS);
      }
    walking = true;
    // Every page (and every wait for one to be sent) is admitted only while some source of the walk is still observed in time.
    const live = (): boolean =>
      compatible &&
      cohort.some(
        ({ id, entry, generation }) =>
          current(id, generation) !== null && now() < (entry.deadline ?? 0),
      );
    const answer = (result: CalendarResult<LiveSources>): void => {
      walking = false;
      if (disposed) return;
      let changed = false;
      for (const { id, generation } of cohort) {
        const entry = current(id, generation);
        if (entry === null) continue;
        if (entry.deadline !== null && now() >= entry.deadline)
          set(entry, expire(entry.observation));
        else set(entry, observe(entry.observation, id, result));
        changed = true;
      }
      if (changed) notify();
      schedule();
    };
    void deps.api
      .liveSources(live)
      .then(answer, () => answer({ ok: false, kind: "uncertain" }));
    return true;
  };

  /**
   * Starts the next walk: at once for a source not read yet (with every source due, so a poll waiting for its time is replaced by it),
   * after `OBSERVE_POLL_MS` for one seen busy.
   */
  const schedule = (): void => {
    if (stopped || !compatible || walking) return;
    const entries = [...watched.values()];
    if (entries.some((entry) => entry.observation.kind === "checking")) {
      const waiting = pollTimer;
      pollTimer = null;
      if (walk()) {
        if (waiting !== null) timers.clearTimeout(waiting);
        return;
      }
      pollTimer = waiting;
    }
    if (
      pollTimer === null &&
      entries.some((entry) => entry.observation.kind === "busy")
    )
      pollTimer = timers.setTimeout(() => {
        pollTimer = null;
        walk();
      }, OBSERVE_POLL_MS);
  };

  const stop = (): void => {
    stopped = true;
    if (pollTimer !== null) timers.clearTimeout(pollTimer);
    pollTimer = null;
    for (const entry of watched.values()) {
      drop(entry);
      entry.observation = ENDED;
    }
  };

  return {
    watch(ids) {
      if (disposed) return;
      const listed = new Set(ids);
      let changed = false;
      for (const [id, entry] of watched)
        if (!listed.has(id)) {
          drop(entry);
          watched.delete(id);
          changed = true;
        }
      for (const id of listed)
        if (!watched.has(id) && !yielded.has(id)) {
          generations += 1;
          watched.set(id, {
            observation: stopped ? ENDED : CHECKING,
            generation: generations,
            deadline: null,
            deadlineTimer: null,
          });
          changed = true;
        }
      if (changed) notify();
      schedule();
    },
    yieldTo(id) {
      if (disposed) return;
      yielded.add(id);
      const entry = watched.get(id);
      if (entry === undefined) return;
      drop(entry);
      watched.delete(id);
      notify();
    },
    observation: (id) => watched.get(id)?.observation ?? null,
    compatible(ok) {
      if (disposed || stopped) return;
      if (ok) {
        compatible = true;
        schedule();
      } else if (compatible) {
        compatible = false;
        stop();
        notify();
      }
    },
    offline() {
      if (disposed || stopped) return;
      stop();
      notify();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      stop();
      listeners.clear();
    },
  };
}
