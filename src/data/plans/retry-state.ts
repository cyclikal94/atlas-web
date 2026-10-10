import {
  initialReadRetry,
  isInitialReadRetry,
  mergeReadRetry,
  onOnline,
  onReadFailure,
  onReadSuccess,
  onUnrecognised,
  recordWriteFailure,
  resetWriteFailure,
  resumeOnOnline,
} from "../model/retry";
import type { Captured, ReadRetryState } from "../model/types";
import { guardedPlan, readPlan, singletonPlan } from "./builders";

/**
 * W11: the durable retry state (plan 5.6). `read_retry_states[caller]` and `local_write_streaks[operation]` live in `sync_state`
 * so a reload does not restart a back-off clock, and one caller's success never resets another's.
 *
 * Writers that derive from a RESPONSE (a read failure or an unrecognised answer is a fact about THIS response) carry the full
 * guard set (G1 G2 INC CLS EPO) so a late response of a former account or epoch cannot change the current one's retry state.
 * The ones that follow a person's action or an event on this page (`online`, "Retry now", a local write outcome) need only the
 * incarnation.
 */
export type ReadOutcome =
  | { kind: "failure" }
  | { kind: "unrecognised" }
  | { kind: "success" };

/**
 * The entries of `read_retry_states` once `caller` holds `next`: the family's other entries (an earlier sign-in's) are dropped when
 * `supersedes` names a family, and `none` leaves the caller with NO entry (an absent entry reads as the initial state).
 */
function entriesWith(
  entries: Record<string, ReadRetryState>,
  caller: string,
  next: ReadRetryState,
  supersedes: string | undefined,
  none: boolean,
): Record<string, ReadRetryState> {
  const states: Record<string, ReadRetryState> = {};
  for (const [other, state] of Object.entries(entries))
    if (
      supersedes === undefined ||
      !other.startsWith(supersedes) ||
      other === caller
    )
      states[other] = state;
  if (none) delete states[caller];
  else states[caller] = next;
  return states;
}

/**
 * `known` is what the page that asks already knew of this caller before its database was open (the memory of a page that started
 * while the database was still being opened): it is folded into the entry in the SAME transaction, so the durable record never holds
 * less than the page's own count.
 *
 * `supersedes` names a FAMILY of callers keyed by sign-in (`profile:<epoch>`): the entry belongs to one sign-in, so the other entries
 * of the family are dropped in the same transaction (a person who signs in again leaves nothing of the earlier sign-in behind), and
 * the caller's own success leaves NO entry at all (an absent entry reads as the initial state, so there is nothing to remember).
 */
export const recordReadOutcome = guardedPlan<
  {
    captured: Captured;
    caller: string;
    outcome: ReadOutcome;
    now: number;
    known?: ReadRetryState;
    supersedes?: string;
  },
  null,
  { state: ReadRetryState }
>({
  name: "data.recordReadOutcome",
  meta: { writer: "W11", guards: ["INC", "CLS", "EPO"], quota: null },
  scope: [],
  durability: "default",
  read: async () => null,
  decide: ({ sync, input }) => {
    const stored = sync.read_retry_states[input.caller] ?? initialReadRetry();
    const current =
      input.known === undefined ? stored : mergeReadRetry(stored, input.known);
    const next =
      input.outcome.kind === "failure"
        ? onReadFailure(current, input.now)
        : input.outcome.kind === "unrecognised"
          ? onUnrecognised(current)
          : onReadSuccess();
    const states = entriesWith(
      sync.read_retry_states,
      input.caller,
      next,
      input.supersedes,
      input.supersedes !== undefined && input.outcome.kind === "success",
    );
    return {
      sync: { ...sync, read_retry_states: states },
      result: { state: next },
    };
  },
});

/**
 * Takes what a page already knew of a caller (`known`: its memory, before its database was open) into that caller's durable entry,
 * WITHOUT recording an outcome: the page's own count may already be a pause that no later outcome will ever write, because a paused
 * caller asks nothing more. The entry never holds less than either record (`mergeReadRetry`), the family's other entries go in the
 * same transaction, and a caller with nothing to remember leaves no entry. Response-derived, so the full guard set.
 */
export const persistReadRetry = guardedPlan<
  {
    captured: Captured;
    caller: string;
    known: ReadRetryState;
    supersedes?: string;
  },
  null,
  { state: ReadRetryState }
>({
  name: "data.persistReadRetry",
  meta: { writer: "W11", guards: ["INC", "CLS", "EPO"], quota: null },
  scope: [],
  durability: "default",
  read: async () => null,
  decide: ({ sync, input }) => {
    const next = mergeReadRetry(
      sync.read_retry_states[input.caller] ?? initialReadRetry(),
      input.known,
    );
    return {
      sync: {
        ...sync,
        read_retry_states: entriesWith(
          sync.read_retry_states,
          input.caller,
          next,
          input.supersedes,
          isInitialReadRetry(next),
        ),
      },
      result: { state: next },
    };
  },
});

/**
 * The durable entry of one caller (the initial state when it has none), and how many OTHER entries its family holds (an earlier
 * sign-in's, which its next recorded outcome drops): read-only, so it can never create anything.
 */
export const readReadRetry = readPlan<
  { incarnationId: string; caller: string; family?: string },
  null,
  { state: ReadRetryState; others: number }
>({
  name: "data.readReadRetry",
  scope: [],
  read: async () => null,
  decide: ({ sync, input }) => ({
    state: sync?.read_retry_states[input.caller] ?? initialReadRetry(),
    others:
      input.family === undefined
        ? 0
        : Object.keys(sync?.read_retry_states ?? {}).filter(
            (caller) =>
              caller !== input.caller && caller.startsWith(input.family ?? ""),
          ).length,
  }),
});

/** `online` or that caller's own "Retry now": resume that caller. An unrelated caller's success never does. */
export const resumeReadCaller = singletonPlan<
  { incarnationId: string; caller: string },
  null,
  { state: ReadRetryState }
>({
  name: "data.resumeReadCaller",
  meta: { writer: "W11", guards: ["INC"], quota: null },
  scope: [],
  durability: "default",
  read: async () => null,
  decide: ({ sync, input }) => {
    const next = onOnline();
    if (sync === undefined || sync.incarnation_id !== input.incarnationId)
      return { result: { state: next } };
    return {
      sync: {
        ...sync,
        read_retry_states: { ...sync.read_retry_states, [input.caller]: next },
      },
      result: { state: next },
    };
  },
});

/**
 * `online` for ONE caller (the sync caller): the browser is reachable again, so a duration-based back-off or pause ends. It does not
 * clear a pause that three unrecognised answers caused (`unrecognised_streak` at its bound): that is not a connectivity problem,
 * and only the caller's own explicit "Retry now" (`resumeReadCaller`) leaves it. Another caller's state is never touched.
 */
export const resumeReadCallerOnOnline = singletonPlan<
  { incarnationId: string; caller: string; unrecognisedAfter: number },
  null,
  { resumed: boolean }
>({
  name: "data.resumeReadCallerOnOnline",
  meta: { writer: "W11", guards: ["INC"], quota: null },
  scope: [],
  durability: "default",
  read: async () => null,
  decide: ({ sync, input }) => {
    if (sync === undefined || sync.incarnation_id !== input.incarnationId)
      return { result: { resumed: false } };
    const current = sync.read_retry_states[input.caller];
    const resumed =
      current === undefined
        ? null
        : resumeOnOnline(current, {
            unrecognisedPauseAfter: input.unrecognisedAfter,
          });
    if (resumed === null) return { result: { resumed: false } };
    return {
      sync: {
        ...sync,
        read_retry_states: {
          ...sync.read_retry_states,
          [input.caller]: resumed,
        },
      },
      result: { resumed: true },
    };
  },
});

/** `online` resumes EVERY paused caller (the browser is reachable again). */
export const resumeAllReadCallers = singletonPlan<
  { incarnationId: string },
  null,
  { resumed: string[] }
>({
  name: "data.resumeAllReadCallers",
  meta: { writer: "W11", guards: ["INC"], quota: null },
  scope: [],
  durability: "default",
  read: async () => null,
  decide: ({ sync, input }) => {
    if (sync === undefined || sync.incarnation_id !== input.incarnationId)
      return { result: { resumed: [] } };
    const resumed = Object.entries(sync.read_retry_states)
      .filter(([, state]) => state.paused || state.backing_off_since !== null)
      .map(([caller]) => caller);
    if (resumed.length === 0) return { result: { resumed } };
    const next = { ...sync.read_retry_states };
    for (const caller of resumed) next[caller] = onOnline();
    return { sync: { ...sync, read_retry_states: next }, result: { resumed } };
  },
});

/**
 * A failure of the operation's local write, counted; or the RESET of its failure state, which is conditional (R53, revision 32): it
 * carries the version of the failure it was decided over (`expect`, `null`: none stood) and ends that failure only. A failure
 * recorded after the decision has a version of its own and is left, however late this transaction is admitted or its result delivered.
 */
export type LocalWriteOutcome =
  | { kind: "failure" }
  | { kind: "success"; expect: number | null };

/** The streak of ONE operation identity; a different operation's success does not reset it. */
export const recordLocalWriteOutcome = singletonPlan<
  { incarnationId: string; operation: string; outcome: LocalWriteOutcome },
  null,
  {
    streak: number;
    stop: boolean;
    /** The version of the failure that stands under the operation after this transaction (`null`: none). */
    version: number | null;
    /** A reset: no failure of the operation stands that was not seen (`false`: a newer one was left). */
    cleared: boolean;
  }
>({
  name: "data.recordLocalWriteOutcome",
  meta: { writer: "W11", guards: ["INC"], quota: null },
  scope: [],
  durability: "default",
  read: async () => null,
  decide: ({ sync, input }) => {
    if (sync === undefined || sync.incarnation_id !== input.incarnationId)
      return {
        result: { streak: 0, stop: false, version: null, cleared: false },
      };
    if (input.outcome.kind === "success") {
      const reset = resetWriteFailure(
        sync,
        input.operation,
        input.outcome.expect,
      );
      const result = {
        streak: sync.local_write_streaks[input.operation] ?? 0,
        stop: false,
        version: reset.cleared ? null : reset.version,
        cleared: reset.cleared,
      };
      if (reset.patch === null) return { result };
      return {
        sync: { ...sync, ...reset.patch },
        result: { ...result, streak: 0 },
      };
    }
    const failed = recordWriteFailure(sync, input.operation);
    return {
      sync: { ...sync, ...failed.patch },
      result: {
        streak: failed.streak,
        stop: failed.stop,
        version: failed.version,
        cleared: false,
      },
    };
  },
});
