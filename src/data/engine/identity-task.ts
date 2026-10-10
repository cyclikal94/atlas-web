import type { Identity, Store } from "../../session";
import { DATA_CONFIG, type DataConfig } from "../model/config";
import {
  initialReadRetry,
  isInitialReadRetry,
  mergeReadRetry,
  nextDelay,
  onReadFailure,
  onReadSuccess,
  onUnrecognised,
  type RetryConfig,
  resumeOnOnline,
  sameReadRetry,
} from "../model/retry";
import type { AccountId, ReadRetryState } from "../model/types";
import {
  persistReadRetry,
  type ReadOutcome,
  readReadRetry,
  recordReadOutcome,
  resumeReadCaller,
  resumeReadCallerOnOnline,
} from "../plans/retry-state";
import type { AccountService } from "./account-service";

/**
 * What one ordinary (non-`/sync`) read ended in, as the retry table (plan 5.6) tells them apart. The adapters over the session
 * classify; nothing downstream guesses from a missing body.
 *
 *  - `ok`: the answer, decoded.
 *  - `failure`: a network error, a time-out, a `5xx` or a `429`: COUNTED (class 2), backed off, paused after a sustained duration.
 *  - `unrecognised`: any other status (a `404`, a `403`...): COUNTED (class 3), three in a row pause that caller.
 *  - `not_sent`: nothing was sent, or the answer was dropped as no longer this identity's (`not_sent`, `not_covered`, `stale`):
 *    NEVER counted, asked again on a short, bounded schedule.
 *  - `closed`: the session has closed the request or is about to (`closed`, `closed_unresolved`, `auth_state`): NEVER counted and
 *    not asked again until something changes (a new identity, a database, connectivity).
 */
export type ReadResult<T> =
  | { kind: "ok"; value: T }
  | { kind: "failure" }
  | { kind: "unrecognised" }
  | { kind: "not_sent" }
  | { kind: "closed" };

/**
 * What one attempt of a task reports to `followIdentity`. `quiet`: nothing was counted, and the task is asked again a few times on a
 * short, bounded schedule (a request that was not sent, a commit that could not be verified in time, a local write that failed).
 * `wait`: nothing was asked of the server or the session closed the request; only an event (a database, `online`, a new identity)
 * asks again.
 */
export type TaskOutcome =
  | "done"
  | "failure"
  | "unrecognised"
  | "quiet"
  | "wait";

/** The outcome of a read that did not produce an answer. */
export function unreadOutcome(
  result: Exclude<ReadResult<unknown>, { kind: "ok" }>,
): TaskOutcome {
  switch (result.kind) {
    case "not_sent":
      return "quiet";
    case "closed":
      return "wait";
    default:
      return result.kind;
  }
}

export interface IdentityTaskDeps {
  /**
   * The family of this caller's `read_retry_states` entry. The entry is keyed by the sign-in as well (`<caller>:<epoch>`): a new
   * epoch re-verifies, and what an earlier sign-in counted, or paused, is not carried into it.
   */
  caller: string;
  identity: Store<Identity | null>;
  online(): boolean;
  onOnline(listener: () => void): () => void;
  /** The OPEN service of an account, or null. The durable budget lives in its database; this never opens or creates one. */
  service(account: AccountId): AccountService | null;
  /**
   * True while it is NOT YET KNOWN whether the account has a database to hold this caller's budget: the page is still looking (its
   * runtime is loading, or the database is being opened). A genuinely absent database is not pending. Nothing is asked of the server
   * while it is, because what an earlier page counted, or paused, cannot be read yet. Default: never pending.
   */
  databasePending?(account: AccountId): boolean;
  /**
   * A database for the displayed account has opened (late, or created by another tab), or the page has finished looking and found
   * none (`databasePending` turned false): a wake, never a record. Default: none.
   */
  onService?(listener: () => void): () => void;
  /** `random` is for the back-off's jitter: `Math.random` when omitted. */
  clock: { now(): number; random?(): number };
  /** The page's own timers when omitted. */
  timers?: {
    setTimeout(fn: () => void, ms: number): unknown;
    clearTimeout(handle: unknown): void;
  };
  config?: RetryConfig & Pick<DataConfig, "notSentBackoffMs">;
  run(identity: Identity): Promise<TaskOutcome>;
}

export interface IdentityTask {
  stop(): void;
  /** This caller's own "Retry now": ends a back-off and either pause, and asks again. No screen offers it yet. */
  retry(): void;
}

interface Work {
  readonly identity: Identity;
  readonly key: string;
  /** The working copy of this caller's durable entry for this sign-in. */
  state: ReadRetryState;
  /** The database whose entry `state` has taken in, and how many entries of an earlier sign-in it held (the next write drops them). */
  adopted: AccountService | null;
  others: number;
  done: boolean;
  running: boolean;
  /** A wake arrived while an attempt was under way. */
  again: boolean;
  /** Nothing was asked because the page had not finished looking for the account's database: it finishing is a wake. */
  waitingForBinding: boolean;
  timer: unknown;
  /** The first attempt of this page has been considered (an inherited back-off is waited out once). */
  started: boolean;
  /** Consecutive counted failures in this page: the back-off exponent. */
  failures: number;
  /** Consecutive quiet outcomes, in this page. */
  quiet: number;
  /** Outcomes counted by this work: a reset decided before one of them is not applied after it (R59, revision 38). */
  outcomes: number;
}

/**
 * Runs a task once per `(account, epoch)` while the page is online (plan 5.8: the profile read and the device mirror), and keeps its
 * retries inside the data layer's own per-caller budget (plan 5.6, classes 2 and 3):
 *
 *  - The IDENTITY is a key, not an event. The session publishes a new identity object at every evaluation, and every request it
 *    sends makes more of them (its lease hints reach this and every other tab), so a notification for the identity already being
 *    worked on does nothing. Only a different `(account, epoch)` starts work, and a sign-in that leaves starts none.
 *  - A task that could not finish is asked again on a TIMER, never by a notification: network, time-out, `5xx` and `429` back off
 *    (2 s doubling to 60 s, +/-20 %) and pause once the failure has lasted `retrySustainedMs`; three consecutive unrecognised
 *    answers pause that caller; a quiet outcome (a read that was not sent) is asked again a few times, uncounted, then waits.
 *  - A pause ends on `online` (not a pause that unrecognised answers caused) or `retry()`. A new epoch is new work.
 *  - With a database open, the counts live in its `sync_state.read_retry_states[<caller>:<epoch>]`, so a reload does not restart the
 *    sustained-failure clock and a second tab shares the pause. Without one, the page's memory holds them, and what it knew is folded
 *    into the durable entry when it first has one. The healthy path writes nothing.
 *
 * Never throws and never creates a database.
 */
export function followIdentity(deps: IdentityTaskDeps): IdentityTask {
  const config = deps.config ?? DATA_CONFIG;
  const random = (): number => deps.clock.random?.() ?? Math.random();
  const timers = deps.timers ?? {
    setTimeout: (fn: () => void, ms: number): unknown => setTimeout(fn, ms),
    clearTimeout: (handle: unknown): void => clearTimeout(handle as never),
  };
  let stopped = false;
  let work: Work | null = null;

  const keyOf = (identity: Identity): string =>
    `${identity.account_id}:${identity.epoch}`;
  const callerOf = (identity: Identity): string =>
    `${deps.caller}:${identity.epoch}`;
  const live = (w: Work): boolean => !stopped && work === w;
  const openService = (w: Work): AccountService | null => {
    const service = deps.service(w.identity.account_id);
    return service?.live === true ? service : null;
  };
  /**
   * Whether `service` (or no service: `null`) is still the binding that stands for the work (R59, revision 38). What an await answered
   * is evidence about the binding it was read from or written to, and only while that binding stands: one that ended, or was replaced
   * by another database, says nothing of the one that stands now.
   */
  const stands = (w: Work, service: AccountService | null): boolean =>
    live(w) && openService(w) === service;

  const clear = (w: Work): void => {
    if (w.timer !== null) timers.clearTimeout(w.timer);
    w.timer = null;
  };
  const later = (w: Work, ms: number): void => {
    clear(w);
    w.timer = timers.setTimeout(() => {
      w.timer = null;
      if (live(w)) consider();
    }, ms);
  };

  /**
   * The durable entry of this caller, taken into the working copy the first time a database is open for the identity, and what the
   * page already counted before that (its memory) taken into the durable entry in return, a pause included: a caller that is already
   * paused asks nothing more, so no later outcome would ever write it. `none`: no database is open. `failed`: one is open, but its
   * entry could not be read, so the budget is not known. `stale`: the database it read from is no longer the one that stands (it ended,
   * or another replaced it, while the read was answered), and what it read is not taken in (R59, revision 38).
   *
   * Every answer is about the binding that stood when it was given, never permission to ask: the attempt reads the binding again
   * immediately before it asks (`bound`).
   */
  const adopt = async (
    w: Work,
  ): Promise<"none" | "adopted" | "failed" | "stale"> => {
    const service = openService(w);
    if (service === null) return "none";
    if (w.adopted === service) return "adopted";
    try {
      const stored = await service.store.run(readReadRetry, {
        incarnationId: service.incarnationId,
        caller: callerOf(w.identity),
        family: `${deps.caller}:`,
      });
      // A read of a database that ended meanwhile, or was replaced, is not that of the one that stands: it is neither taken in nor
      // marked adopted, so a replacement's own entry is read before anything is asked under it.
      if (!stands(w, service)) return "stale";
      const known = w.state;
      w.state = mergeReadRetry(known, stored.state);
      w.others = stored.others;
      w.adopted = service;
      // This page knew something the database did not: it is written now, whether or not anything is ever asked again.
      if (!sameReadRetry(w.state, stored.state)) await persist(w, service);
      return "adopted";
    } catch {
      // The entry could not be read: the budget is not known, and nothing is asked until it is. A failure of a database that is no
      // longer the one that stands says nothing of the one that does.
      return stands(w, service) ? "failed" : "stale";
    }
  };

  const persist = async (w: Work, service: AccountService): Promise<void> => {
    try {
      const out = await service.commit(persistReadRetry, {
        captured: service.capture(w.identity.epoch),
        caller: callerOf(w.identity),
        known: w.state,
        supersedes: `${deps.caller}:`,
      });
      if (out.kind === "applied" && stands(w, service)) {
        w.state = mergeReadRetry(w.state, out.value.state);
        w.others = 0;
      }
    } catch {
      // The entry could not be written; the working copy still counts, and a later outcome carries it again (`known`).
    }
  };

  /** Counts an outcome in the working copy and, with a database open, in its durable entry. */
  const record = async (w: Work, outcome: ReadOutcome): Promise<void> => {
    w.outcomes += 1;
    // A success writes only to end something, so it first learns what the database holds: a caller that has never failed, with no
    // entry of an earlier sign-in to drop, leaves no trace.
    if (outcome.kind === "success") await adopt(w);
    if (!live(w)) return;
    const now = deps.clock.now();
    const known = w.state;
    w.state =
      outcome.kind === "failure"
        ? onReadFailure(known, now, config)
        : outcome.kind === "unrecognised"
          ? onUnrecognised(known, config)
          : onReadSuccess();
    const service = openService(w);
    if (service === null) return;
    if (
      outcome.kind === "success" &&
      w.adopted === service &&
      w.others === 0 &&
      isInitialReadRetry(known)
    )
      return;
    try {
      const out = await service.commit(recordReadOutcome, {
        captured: service.capture(w.identity.epoch),
        caller: callerOf(w.identity),
        supersedes: `${deps.caller}:`,
        outcome,
        now,
        known,
      });
      // The entry written is the budget of the work only while its database stands (R59, revision 38); otherwise the working copy,
      // which has counted the outcome, is kept, and the database that stands is read before anything is asked under it.
      if (out.kind === "applied" && stands(w, service)) {
        w.state = out.value.state;
        w.others = 0;
        w.adopted = service;
      }
    } catch {
      // The durable entry could not be written; the working copy still counts, and the schedule below still backs off.
    }
  };

  /** Asks again a few times on the short, bounded schedule, counting nothing; then waits for an event. */
  const quietly = (w: Work): void => {
    // A timer that is already pending is a back-off or an earlier quiet step: it is never replaced by a sooner one.
    if (w.timer !== null) return;
    const schedule = config.notSentBackoffMs;
    if (w.quiet < schedule.length) {
      const ms = schedule[w.quiet] as number;
      w.quiet += 1;
      later(w, ms);
    } else w.quiet = 0;
  };

  const settle = async (w: Work, outcome: TaskOutcome): Promise<void> => {
    if (outcome !== "quiet") w.quiet = 0;
    switch (outcome) {
      case "done":
        await record(w, { kind: "success" });
        w.failures = 0;
        w.done = true;
        return;
      case "wait":
        return;
      case "quiet":
        quietly(w);
        return;
      default:
        await record(w, { kind: outcome });
        w.failures += 1;
        if (!w.state.paused && live(w))
          later(w, nextDelay(w.failures, random(), config));
    }
  };

  /**
   * Whether the budget the work holds is that of the binding that stands NOW (R59, revision 38). It is decided synchronously, in the
   * turn that asks: an earlier answer (`adopt`'s, a cached one included: awaiting it yields) is evidence only about the binding that
   * stood when it was given, and the database may have ended or been replaced since.
   *
   *  - A database is open whose entry the work has taken in: it is the budget.
   *  - One is open that it has not (it opened late, or replaced the one taken in): it is read first (`again`: the attempt ends and the
   *    work takes it in).
   *  - None is open and the page has not finished looking for one (a binding that ended is unknown, not absent): nothing is asked until
   *    it is known; the page's notice that it opened, or that there is none, asks again. Nothing here opens one.
   *  - None is open and the page found none: the page's memory is the budget (the profile's memory-only verification).
   */
  const bound = (w: Work): boolean => {
    const service = openService(w);
    if (service !== null) {
      if (w.adopted === service) return true;
      w.again = true;
      return false;
    }
    if (deps.databasePending?.(w.identity.account_id) === true) {
      w.waitingForBinding = true;
      return false;
    }
    return true;
  };

  const attempt = async (w: Work): Promise<void> => {
    w.running = true;
    try {
      const adopted = await adopt(w);
      if (!live(w)) return;
      if (adopted === "failed") {
        // The budget cannot be read: nothing is asked, nothing is counted, and it is looked at again a few times.
        quietly(w);
        return;
      }
      // From here to the call that asks, nothing is awaited: what admits the request is the binding, the connectivity, the identity
      // and the budget as they stand in the turn that asks (R59, revision 38).
      if (!bound(w)) return;
      w.waitingForBinding = false;
      if (w.again) return;
      if (w.state.paused) return;
      if (!w.started) {
        w.started = true;
        // A page that starts while a back-off is under way (a reload) waits the first step of the schedule before it asks.
        if (w.state.backing_off_since !== null) {
          later(w, nextDelay(1, random(), config));
          return;
        }
      }
      // Connectivity is an event (`online` asks again); an identity that moved has work of its own.
      if (!deps.online()) return;
      const identity = deps.identity.get();
      if (identity === null || keyOf(identity) !== w.key) return;
      let outcome: TaskOutcome;
      try {
        outcome = await deps.run(w.identity);
      } catch {
        outcome = "failure";
      }
      // The identity moved while the task ran: what it found is not this work's, and the new identity has its own.
      if (!live(w)) return;
      await settle(w, outcome);
    } finally {
      w.running = false;
      if (w.again) {
        w.again = false;
        if (live(w)) {
          if (needsAdopt(w)) adoptNow(w);
          else consider();
        }
      }
    }
  };

  function consider(): void {
    const w = work;
    if (w === null || stopped) return;
    if (w.done || w.running || w.timer !== null || w.state.paused) return;
    if (!deps.online()) return;
    const identity = deps.identity.get();
    if (identity === null || keyOf(identity) !== w.key) return;
    void attempt(w);
  }

  /** A database is open that this work has not taken in (it opened late, or another tab created it). */
  const needsAdopt = (w: Work): boolean => {
    if (w.done) return false;
    const service = openService(w);
    return service !== null && w.adopted !== service;
  };

  /**
   * Takes in a database that has just opened, whatever the work is doing and whether or not anything will be asked: what the page
   * counted before it is written (a pause included) and what an earlier page recorded is read. Then the work considers itself.
   */
  const adoptNow = (w: Work): void => {
    if (w.running) {
      w.again = true;
      return;
    }
    w.running = true;
    void (async () => {
      let adopted: Awaited<ReturnType<typeof adopt>> = "none";
      try {
        adopted = await adopt(w);
      } finally {
        w.running = false;
      }
      if (!live(w)) return;
      // A database that is still not taken in after its adoption answered (revision 38) is not taken in again at once: the attempt it
      // would wake reads the binding again and asks for one more adoption, and nothing in that cycle need wait on storage, so it could
      // repeat without ever yielding. It is looked at again on the short, bounded schedule, then waits for an event, like a budget that
      // cannot be read.
      if (adopted === "failed" || (adopted === "adopted" && needsAdopt(w))) {
        quietly(w);
        return;
      }
      if (w.again) w.again = false;
      consider();
    })();
  };

  /**
   * Something about the database changed. A database that is open and not yet taken in is taken in; the end of the page's look for it
   * ends a wait for it; anything else (another account's database, a change that concerns nothing this work waits for) is no wake.
   */
  const binding = (w: Work): void => {
    if (needsAdopt(w)) adoptNow(w);
    else if (
      w.waitingForBinding &&
      deps.databasePending?.(w.identity.account_id) !== true
    ) {
      w.waitingForBinding = false;
      wake(w);
    }
  };

  const wake = (w: Work): void => {
    if (w.running) w.again = true;
    else consider();
  };

  const begin = (identity: Identity | null): void => {
    const key = identity === null ? null : keyOf(identity);
    if (key === (work?.key ?? null)) return;
    if (work !== null) clear(work);
    work =
      identity === null
        ? null
        : {
            identity,
            key: keyOf(identity),
            state: initialReadRetry(),
            adopted: null,
            others: 0,
            done: false,
            running: false,
            again: false,
            waitingForBinding: false,
            timer: null,
            started: false,
            failures: 0,
            quiet: 0,
            outcomes: 0,
          };
    consider();
  };

  /**
   * Whether a reset of the work's schedule decided before an awaited write (`online`, "Retry now") still applies after it (R59, revision
   * 38). It was decided over what the work knew then: no outcome may have been counted meanwhile (the newer outcome's back-off or pause
   * stands), and the work must not have taken in another database's budget meanwhile (a replacement's pause, recorded by another page,
   * is newer than the decision and is not undone by it). A binding that merely ended meanwhile changes neither: the reset applies, and
   * the database's own entry (which the write reached, or did not) is read again when the work next takes one in. Either way the work is
   * woken, so it considers itself under what stands now; a pending back-off is never shortened by a reset that does not apply.
   */
  const resetStands = (
    w: Work,
    outcomes: number,
    adopted: AccountService | null,
  ): boolean => live(w) && w.outcomes === outcomes && w.adopted === adopted;

  const cameOnline = (): void => {
    const w = work;
    if (w === null) return;
    void (async () => {
      const resumed = resumeOnOnline(w.state, config);
      if (resumed !== null) w.state = resumed;
      const outcomes = w.outcomes;
      const adopted = w.adopted;
      const service = openService(w);
      if (service !== null) {
        try {
          await service.store.run(resumeReadCallerOnOnline, {
            incarnationId: service.incarnationId,
            caller: callerOf(w.identity),
            unrecognisedAfter: config.unrecognisedPauseAfter,
          });
        } catch {
          // Resuming is best effort; the working copy has resumed.
        }
      }
      if (!live(w)) return;
      if (resetStands(w, outcomes, adopted)) {
        w.failures = 0;
        w.quiet = 0;
        clear(w);
      }
      wake(w);
    })();
  };

  const offs = [
    deps.identity.subscribe(() => begin(deps.identity.get())),
    deps.onOnline(cameOnline),
    (deps.onService ?? (() => () => undefined))(() => {
      const w = work;
      if (w !== null) binding(w);
    }),
  ];
  begin(deps.identity.get());

  return {
    stop() {
      stopped = true;
      if (work !== null) clear(work);
      work = null;
      for (const off of offs) off();
    },
    retry() {
      const w = work;
      if (w === null) return;
      void (async () => {
        const outcomes = w.outcomes;
        const adopted = w.adopted;
        const service = openService(w);
        if (service !== null) {
          try {
            await service.store.run(resumeReadCaller, {
              incarnationId: service.incarnationId,
              caller: callerOf(w.identity),
            });
          } catch {
            // Resuming is best effort; the working copy has resumed.
          }
        }
        if (!live(w)) return;
        if (resetStands(w, outcomes, adopted)) {
          w.state = initialReadRetry();
          w.failures = 0;
          w.quiet = 0;
          clear(w);
        }
        wake(w);
      })();
    },
  };
}
