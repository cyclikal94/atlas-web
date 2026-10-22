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
 * The refresh activity of the sources the calendar screen shows during ONE VISIT, observed by reading the live list (WEB-13a,
 * D-13a-13; revision 4, R10; revision 5, R11): it performs what `model/observation.ts` decides and nothing else. It only ever reads
 * `GET /calendar-sources`: it has no key and no way to send a refresh, a command or a draft, and it writes nothing (no cache, no
 * storage, no form).
 *
 *  - It belongs to the visit (`visit.ts`), not to a mounted screen: a screen ATTACHES to it and detaches when it unmounts. An Atlas
 *    `403` unmounts the protected tree and mounts it again under the same identity (the session's re-check), so a screen's lifetime
 *    cannot bound anything; the observer's entries, their time limits, their final states and the read still out all outlive a
 *    detachment, and the next attachment continues them: it never reads afresh what was already read (R11). Nothing is read while no
 *    screen is attached (a read out is not admitted another page or another attempt), and a walk's answer is the visit's evidence
 *    whichever attachment is current when it arrives.
 *  - It reads the sources the attached screen lists (`watch`, one page of the list): ONE bounded walk serves every source due, never
 *    one per row, and walks never overlap. A source listed later (a new page, a create the cache now holds) is read at once (a poll
 *    waiting for its time is made then, with it), or with the next walk if one is out. A source the SAME attachment stops listing (the
 *    cache gate closing, another page) keeps what was observed and its time limit; listed again by that attachment while still
 *    observed, it is read at once within that limit. Nothing listed by an earlier attachment is read again because a new one lists it.
 *  - A source seen busy is read again every `OBSERVE_POLL_MS`, until a read returns it idle, fails or does not return it, or its
 *    `OBSERVE_LIMIT_MS` (from the first walk that included it) runs out. The time limit is not extended by anything, and a read still out
 *    at it is not waited for: its answer is dropped for that source, and no further page of the walk is admitted.
 *  - A press of Refresh or "Check again" on this screen (`yieldTo`) ends the source's observation for the life of the observer: its own
 *    run shows what it learns, and a read made before the press can no longer change the row.
 *  - It reads only once the server is known to be compatible, and only while online. Going offline (or the server becoming incompatible)
 *    stops it for good: nothing it did is resumed, and coming back online reads nothing more until the screen is opened again.
 *  - The visit disposes it when the person leaves the screen or the identity changes: a read still out is then dropped.
 */
export interface SourceObserver {
  /** A mounted screen attaches (one at a time: a newer attachment replaces an older one). */
  attach(): ObserverAttachment;
  /** A refresh of `id` was started on this screen: its observation ends here, and nothing more is read for it. */
  yieldTo(id: string): void;
  /** What was observed of `id`, or null when it is not observed (or not listed by the attached screen). */
  observation(id: string): Observation | null;
  /** Whether the server is compatible: nothing is read until it is, and it stops for good if it no longer is. */
  compatible(ok: boolean): void;
  /** The page went offline: every observation stops for good (nothing shown, nothing resumed). */
  offline(): void;
  subscribe(listener: () => void): () => void;
  /** Stops everything and drops every read still out. Idempotent. */
  dispose(): void;
}

/** One mounted screen's hold on the observer. Both methods do nothing once it is detached or replaced. */
export interface ObserverAttachment {
  /**
   * The sources the screen lists now. Unchanged ids keep their observation (and its time limit); ids no longer listed keep theirs too,
   * but are neither shown nor read until listed again.
   */
  watch(ids: readonly string[]): void;
  /** The screen unmounted: nothing more is read until a screen attaches again (which continues, never restarts). Idempotent. */
  detach(): void;
}

interface Watched {
  observation: Observation;
  /** Bumped whenever the observation changes or stops: a read made for an older generation is dropped. */
  generation: number;
  /** When the observation's time runs out (`now()`), set by the first walk that includes it. */
  deadline: number | null;
  deadlineTimer: unknown;
  /** Whether the attached screen lists it now: only a listed source is shown or makes a read due. */
  listed: boolean;
  /** The attachment that stopped listing it (the cache gate, another page), so that ITS listing it again reads it at once. */
  leftBy: number | null;
  /** Listed again by the attachment that left it while still observed: read with the next walk, at once. */
  due: boolean;
  /**
   * A walk that included it was never SENT (its admission declined, or the session refused it before its send boundary): it stays
   * unread, and is read by the NEXT attachment, never again by this one (0: no attachment at the time), so nothing loops.
   */
  waitsFor: number | null;
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
  /** The attached screen (its number), or null while none is: nothing is read then. */
  let attached: number | null = null;
  let attachments = 0;

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

  /** Reads the live list for every source due; false when none is (or a walk is out, or no screen is attached). */
  const walk = (): boolean => {
    if (stopped || !compatible || walking || attached === null) return false;
    const started = now();
    const cohort = [...watched]
      .filter(
        ([, entry]) =>
          entry.listed &&
          entry.waitsFor !== attached &&
          observing(entry.observation) &&
          (entry.deadline === null || started < entry.deadline),
      )
      .map(([id, entry]) => ({ id, entry, generation: entry.generation }));
    if (cohort.length === 0) return false;
    for (const { id, entry } of cohort) {
      entry.due = false;
      entry.waitsFor = null;
      if (entry.deadline === null) {
        entry.deadline = started + OBSERVE_LIMIT_MS;
        entry.deadlineTimer = timers.setTimeout(() => {
          entry.deadlineTimer = null;
          lapse(id, entry);
          schedule();
        }, OBSERVE_LIMIT_MS);
      }
    }
    walking = true;
    // Every page (and every wait for one to be sent) is admitted only while some source of the walk is still listed (so a screen is
    // attached: a detachment unlists everything) and observed in time. A walk refused a page this way ends as `closed` having sent
    // nothing more: no page of it was refused by the server (that answer would be `refused`), so its sources stay unread for the next
    // attachment, like a walk the session refused before its send boundary (`unsent`).
    let declined = false;
    const live = (): boolean => {
      const admitted =
        compatible &&
        cohort.some(
          ({ id, entry, generation }) =>
            current(id, generation) !== null &&
            entry.listed &&
            now() < (entry.deadline ?? 0),
        );
      if (!admitted) declined = true;
      return admitted;
    };
    // The answer is the visit's: it is taken whichever screen is attached by then (or none), so a remount never reads it again.
    const answer = (result: CalendarResult<LiveSources>): void => {
      walking = false;
      if (disposed) return;
      const unsent =
        !result.ok &&
        result.kind === "closed" &&
        (declined || result.unsent === true);
      let changed = false;
      for (const { id, generation } of cohort) {
        const entry = current(id, generation);
        if (entry === null) continue;
        entry.due = false;
        if (unsent) {
          entry.waitsFor = attached ?? 0;
          continue;
        }
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
    if (stopped || !compatible || walking || attached === null) return;
    const entries = [...watched.values()].filter((entry) => entry.listed);
    if (
      entries.some(
        (entry) =>
          entry.waitsFor !== attached &&
          (entry.observation.kind === "checking" ||
            (entry.due && observing(entry.observation))),
      )
    ) {
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
    clearPoll();
    for (const entry of watched.values()) {
      drop(entry);
      entry.observation = ENDED;
    }
  };

  const clearPoll = (): void => {
    if (pollTimer !== null) timers.clearTimeout(pollTimer);
    pollTimer = null;
  };

  const watch = (attachment: number, ids: readonly string[]): void => {
    if (disposed || attached !== attachment) return;
    const listed = new Set(ids);
    let changed = false;
    for (const [id, entry] of watched)
      if (entry.listed && !listed.has(id)) {
        entry.listed = false;
        entry.leftBy = attachment;
        entry.due = false;
        changed = true;
      }
    for (const id of listed) {
      const entry = watched.get(id);
      if (entry !== undefined) {
        if (entry.listed) continue;
        entry.listed = true;
        entry.due = entry.leftBy === attachment && observing(entry.observation);
        entry.leftBy = null;
        changed = true;
      } else if (!yielded.has(id)) {
        generations += 1;
        watched.set(id, {
          observation: stopped ? ENDED : CHECKING,
          generation: generations,
          deadline: null,
          deadlineTimer: null,
          listed: true,
          leftBy: null,
          due: false,
          waitsFor: null,
        });
        changed = true;
      }
    }
    // Nothing listed is busy any more: a poll waiting for its time has nothing to read.
    if (
      ![...watched.values()].some((e) => e.listed && observing(e.observation))
    )
      clearPoll();
    if (changed) notify();
    schedule();
  };

  const detach = (attachment: number): void => {
    if (attached !== attachment) return;
    attached = null;
    clearPoll();
    // What the screen listed is not "left" by it: a later screen listing it again continues it, it does not read it afresh.
    for (const entry of watched.values()) {
      entry.listed = false;
      entry.leftBy = null;
      entry.due = false;
    }
  };

  return {
    attach() {
      attachments += 1;
      const attachment = attachments;
      if (!disposed) {
        if (attached !== null) detach(attached);
        attached = attachment;
      }
      return {
        watch: (ids) => watch(attachment, ids),
        detach: () => detach(attachment),
      };
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
    observation: (id) => {
      const entry = watched.get(id);
      return entry?.listed ? entry.observation : null;
    },
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
