import type { CalendarApi } from "./api";
import {
  type RefreshEffect,
  type RefreshEvent,
  type RefreshRun,
  type RefreshView,
  refreshStep,
  startRefresh,
} from "./model/refresh";
import {
  createRefreshOwnership,
  type RefreshOwnership,
  type RefreshTicket,
} from "./refresh-ownership";

/**
 * The manual refreshes of ONE mounted calendar screen (WEB-13a, D-13a-6): it performs what `model/refresh.ts` decides (send with the
 * run's key, read the live list, wait) and nothing else. Memory only. It is disposed when the screen unmounts and replaced when the
 * identity changes (the screen builds one per client): nothing it started is resumed, and nothing is sent on reconnect. Every request
 * it makes asks the client to admit it only while its run is current, so a request still waiting to be sent (`not_sent`) is never sent
 * once its run was stopped, replaced or disposed. While the page is offline it starts nothing, whichever action asks (Refresh or
 * "Check again").
 *
 * Who may say how a run ended is decided by ADMISSION, across controllers (`refresh-ownership.ts`, revision 6, R12): every admitted
 * execution claims its source with a new ticket before anything is sent, and only the source's latest ticket may record or show an
 * outcome. An answer that arrives after `dispose()` (the remount a `403` causes) is therefore recorded only if it ENDS the run and no
 * newer press of that source was admitted since, by this controller or a later one; it performs nothing (no send, no read, no wait).
 * Every other late answer is dropped: one whose run was stopped, replaced or superseded, and one that does not end its run.
 */
export interface Timers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface RefreshController {
  /** A press of Refresh: a NEW operation with a new key. Ignored while one of this source is running. */
  refresh(sourceId: string): void;
  /** "Check again" after the retries ran out: the SAME operation, under its key. */
  checkAgain(sourceId: string): void;
  /** What the row shows, or null. */
  view(sourceId: string): RefreshView | null;
  /** Whether a run of this source is going (a request, a read or a wait). */
  running(sourceId: string): boolean;
  /** The page went offline: every run stops and says "Needs a connection", and no run starts until `online()`. Nothing resumes. */
  offline(): void;
  /** The page is online again: a NEW press may start a run (nothing that `offline()` stopped resumes by itself). */
  online(): void;
  /** Clears what a row shows after the person has seen it (for example after a new press elsewhere). */
  forget(sourceId: string): void;
  subscribe(listener: () => void): () => void;
  /**
   * Stops every run and makes no further request. An answer still to come may only record its run's outcome, if it ends the run and
   * its ticket still owns the source (`refresh-ownership.ts`). Idempotent.
   */
  dispose(): void;
}

interface Entry {
  run: RefreshRun;
  /** The admission this run belongs to (`refresh-ownership.ts`): it shows and records only while the ticket owns its source. */
  ticket: RefreshTicket;
  /** Bumped whenever the entry is replaced or stopped: a completion of an older generation is dropped. */
  generation: number;
  timer: unknown;
}

export function createRefreshController(deps: {
  api: CalendarApi;
  mintKey(): string;
  timers?: Timers;
  /**
   * The identity's ownership of manual refreshes (`memory.ts`, `refresh-ownership.ts`), shared by every controller of the identity: the
   * owners' ended runs outlive a remount of the screen and are shown by the next controller, and an outcome another controller records
   * later (its answer came after its remount) is shown here too. A new one (nothing shared) when not given.
   */
  ownership?: RefreshOwnership;
  /**
   * A run of `sourceId` was admitted (a press of Refresh or "Check again"), before its request: the screen's observer of refresh activity
   * stops observing that source (`observation-controller.ts`, revision 4), so a read it made earlier cannot change what the run shows.
   */
  onBegin?(sourceId: string): void;
}): RefreshController {
  const timers: Timers = deps.timers ?? {
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (handle) => clearTimeout(handle as never),
  };
  const entries = new Map<string, Entry>();
  const listeners = new Set<() => void>();
  const ownership = deps.ownership ?? createRefreshOwnership();
  let disposed = false;
  let connected = true;
  let generations = 0;
  for (const { ticket, run } of ownership.outcomes()) {
    generations += 1;
    entries.set(ticket.source, {
      run,
      ticket,
      generation: generations,
      timer: null,
    });
  }

  const notify = (): void => {
    for (const listener of [...listeners]) listener();
  };

  const current = (id: string, generation: number): Entry | null => {
    const entry = entries.get(id);
    return !disposed &&
      entry !== undefined &&
      entry.generation === generation &&
      ownership.owns(entry.ticket)
      ? entry
      : null;
  };

  const perform = (id: string, entry: Entry, effect: RefreshEffect): void => {
    const generation = entry.generation;
    switch (effect.type) {
      case "stop":
        return;
      case "send":
        void deps.api
          .refresh(id, entry.run.key, () => current(id, generation) !== null)
          .then((answer) => {
            if (current(id, generation))
              dispatch(id, { type: "answer", answer });
            else late(id, generation, { type: "answer", answer });
          });
        return;
      case "live":
        void deps.api
          .liveSources(() => current(id, generation) !== null)
          .then((result) => {
            if (current(id, generation))
              dispatch(id, { type: "live", id, result });
            else late(id, generation, { type: "live", id, result });
          });
        return;
      case "wait":
        entry.timer = timers.setTimeout(() => {
          const live = current(id, generation);
          if (!live) return;
          live.timer = null;
          perform(id, live, { type: effect.after });
        }, effect.ms);
        return;
    }
  };

  const dispatch = (id: string, event: RefreshEvent): void => {
    const entry = entries.get(id);
    if (entry === undefined) return;
    const next = refreshStep(entry.run, event);
    entry.run = next.run;
    perform(id, entry, next.effect);
    // Remembered for a later screen only if it ended with something to show; listeners (this controller included) are told.
    ownership.publish(entry.ticket, next.run);
    notify();
  };

  /** Runs that were current when the controller was disposed, whose answers arrive afterwards. */
  const atDisposal = new Map<
    string,
    { generation: number; ticket: RefreshTicket; run: RefreshRun }
  >();
  /**
   * An answer to a run this controller no longer drives. After `dispose()` (the screen was unmounted, typically by the session's re-check
   * of a `403`), the run's OUTCOME is recorded for the screen of this identity mounted now if it ends the run and its ticket still owns
   * the source; nothing is performed. An answer of a run that was replaced or stopped (a new press, offline), or superseded by a newer
   * press on a later screen, is dropped.
   */
  const late = (id: string, generation: number, event: RefreshEvent): void => {
    const held = atDisposal.get(id);
    if (!disposed || held === undefined || held.generation !== generation)
      return;
    atDisposal.delete(id);
    if (!ownership.owns(held.ticket)) return;
    ownership.publish(held.ticket, refreshStep(held.run, event).run);
  };

  /** Another controller of this identity recorded the outcome of `id` (its answer came after its remount): it is shown here. */
  const adopt = (id: string): void => {
    if (disposed) return;
    const shown = ownership.shown(id);
    if (shown === null) return;
    const entry = entries.get(id);
    if (entry !== undefined && entry.ticket === shown.ticket) return;
    if (entry?.timer) timers.clearTimeout(entry.timer);
    generations += 1;
    entries.set(id, {
      run: shown.run,
      ticket: shown.ticket,
      generation: generations,
      timer: null,
    });
    notify();
  };
  const offOwnership = ownership.subscribe(adopt);

  const begin = (id: string, key: () => string): void => {
    if (disposed || !connected) return;
    const old = entries.get(id);
    if (old !== undefined && !old.run.ended && ownership.owns(old.ticket))
      return;
    if (old?.timer) timers.clearTimeout(old.timer);
    const { run, effect } = startRefresh(key());
    // Claimed before anything else (the observer's yield, the request): from now on no older admission of this source may record or
    // show an outcome, here or on any screen of this identity.
    const ticket = ownership.claim(id, run.key);
    deps.onBegin?.(id);
    generations += 1;
    const entry: Entry = { run, ticket, generation: generations, timer: null };
    entries.set(id, entry);
    perform(id, entry, effect);
    notify();
  };

  const owned = (id: string): Entry | null => {
    const entry = entries.get(id);
    return entry !== undefined && ownership.owns(entry.ticket) ? entry : null;
  };

  return {
    refresh: (id) => begin(id, deps.mintKey),
    checkAgain(id) {
      const entry = owned(id);
      if (entry === null || !entry.run.ended) return;
      const key = entry.run.key;
      begin(id, () => key);
    },
    view: (id) => owned(id)?.run.view ?? null,
    running: (id) => {
      const entry = owned(id);
      return entry !== null && !entry.run.ended;
    },
    offline() {
      connected = false;
      for (const entry of entries.values()) {
        if (entry.run.ended) continue;
        if (entry.timer) timers.clearTimeout(entry.timer);
        entry.timer = null;
        // A request still out stays out; its answer is dropped (a new generation), and nothing waits to be sent.
        generations += 1;
        entry.generation = generations;
        entry.run = refreshStep(entry.run, { type: "offline" }).run;
      }
      notify();
    },
    online() {
      connected = true;
    },
    forget(id) {
      const entry = entries.get(id);
      if (entry === undefined || !entry.run.ended) return;
      entries.delete(id);
      // What was shown is cleared; the admission keeps owning the source (an older answer still cannot be recorded).
      ownership.clear(entry.ticket);
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
      offOwnership();
      for (const [id, entry] of entries) {
        if (entry.timer) timers.clearTimeout(entry.timer);
        // A request or read still out may still END the run: its outcome is recorded if its ticket still owns the source, never acted
        // on (`late`). A run that is only waiting to retry ends here with nothing to show: nothing resumes.
        if (!entry.run.ended && entry.timer === null)
          atDisposal.set(id, {
            generation: entry.generation,
            ticket: entry.ticket,
            run: entry.run,
          });
      }
      entries.clear();
      listeners.clear();
    },
  };
}
