import type { AccountService } from "../engine/account-service";
import { utf8Length } from "../model/outbox";
import type {
  Captured,
  JsonObject,
  MaterialiseDiscovery,
  MaterialiseSequenceRow,
} from "../model/types";
import {
  DISCOVERY_ENTRY_BYTES,
  type DiscoveryWrite,
  deleteSatisfiedSequences,
  liftMaterialiseStops,
  type MaterialiseLift,
  readMaterialiseDiscovery,
  readMaterialiseSequence,
  readMaterialiseSequences,
  readTaskSequences,
  SEQUENCE_ROW_BYTES,
  type SequenceExpectation,
  type SequenceKey,
  type SequenceWrite,
  TASK_SEQUENCE_DAYS,
  TASK_SEQUENCE_TASKS,
  type TaskSequences,
  type TaskSequencesAsk,
  writeMaterialiseDiscovery,
  writeMaterialiseSequence,
} from "../plans/materialise";
import {
  issueTimerOrder,
  readTimerAuthority,
  reconcileTimerCopy,
  recordTimerEnded,
  type TimerAuthorityRecord,
  type TimerCopyRecord,
  type TimerScopeObservation,
  writeTimerCopy,
} from "../plans/timer-copy";
import type { Loadable, Watchable } from "../store/port";
import type { DataEnv } from "./env";
import { useWatch } from "./react";

/**
 * WEB-10c's records in the account database (W27 catch-up sequences, W28 the running-timer copy), in a module of their own: only the
 * lazy task screens import it, so its plans stay out of every initial bundle. The task slice owns what the rows mean; this owns how they
 * are read, compared and committed.
 */

/**
 * The recovery rows of each task asked for, live: re-read when the store changes, in this page or another (revision 5, review R24; by
 * task, revision 4's R21, so another task's rows cannot hide a stop): the row of the exact day a screen works for (`throughDate`, when it
 * is known) and the task's latest days. Read `TASK_SEQUENCE_TASKS` tasks at a time, each read bounded; the result is ready only once every
 * read is.
 */
export function useTaskSequences(
  targets: ReadonlyArray<TaskSequencesAsk>,
): Loadable<ReadonlyMap<string, TaskSequences>> {
  // One ask per task (revision 6, R28): its exact day, EVERY further day asked (none overwrites another) and the most rows asked.
  const byTask = new Map<string, TaskSequencesAsk>();
  for (const t of targets) {
    const held = byTask.get(t.taskId);
    const throughDate = held?.throughDate ?? t.throughDate;
    // In the order asked (the first are kept when there are more than one read looks up), then sorted for a stable key.
    const days = [...new Set([...(held?.days ?? []), ...(t.days ?? [])])]
      .filter((day) => day !== throughDate)
      .slice(0, TASK_SEQUENCE_DAYS)
      .sort();
    const rows = Math.max(held?.rows ?? 0, t.rows ?? 0);
    byTask.set(t.taskId, {
      taskId: t.taskId,
      ...(throughDate === undefined ? {} : { throughDate }),
      ...(days.length === 0 ? {} : { days }),
      ...(rows === 0 ? {} : { rows }),
    });
  }
  const key = JSON.stringify(
    [...byTask.values()].sort((a, b) =>
      a.taskId < b.taskId ? -1 : a.taskId > b.taskId ? 1 : 0,
    ),
  );
  return useWatch(
    (env) => {
      const service = env.service();
      if (!service) return null;
      const tasks = JSON.parse(key) as TaskSequencesAsk[];
      const batches: Watchable<Record<string, TaskSequences>>[] = [];
      for (let i = 0; i < tasks.length; i += TASK_SEQUENCE_TASKS)
        batches.push(
          service.store.watch(readTaskSequences, {
            incarnationId: service.incarnationId,
            tasks: tasks.slice(i, i + TASK_SEQUENCE_TASKS),
          }),
        );
      return allOf(batches);
    },
    [key],
  );
}

const NO_SEQUENCES: Loadable<ReadonlyMap<string, TaskSequences>> = {
  status: "ready",
  value: new Map(),
};

/** Several watches as one: ready when all are (their rows merged), else the first that is not; the same object while none changes. */
function allOf(
  parts: readonly Watchable<Record<string, TaskSequences>>[],
): Watchable<ReadonlyMap<string, TaskSequences>> {
  let seen: readonly Loadable<Record<string, TaskSequences>>[] = [];
  let out = NO_SEQUENCES;
  return {
    get() {
      const now = parts.map((p) => p.get());
      if (now.length === seen.length && now.every((v, i) => v === seen[i]))
        return out;
      seen = now;
      const pending = now.find((v) => v.status !== "ready");
      if (pending !== undefined) out = pending as typeof out;
      else {
        const rows = new Map<string, TaskSequences>();
        for (const v of now)
          if (v.status === "ready")
            for (const [taskId, row] of Object.entries(v.value))
              rows.set(taskId, row);
        out = { status: "ready", value: rows };
      }
      return out;
    },
    subscribe(listener) {
      const stops = parts.map((p) => p.subscribe(listener));
      return () => {
        for (const stop of stops) stop();
      };
    },
  };
}

/** The failed catch-up discoveries of the displayed account's database, by task, live (every page's). */
export function useMaterialiseDiscovery(): Loadable<
  Record<string, MaterialiseDiscovery>
> {
  return useWatch((env) => {
    const service = env.service();
    return service
      ? service.store.watch(readMaterialiseDiscovery, {
          incarnationId: service.incarnationId,
        })
      : null;
  }, []);
}

/**
 * The running-timer copy of the displayed account's database with every day's scope and the floor, read together and live (every page's):
 * ONE snapshot, so a consumer never judges the copy against scopes of another moment (revision 4, review R19).
 */
export function useTimerAuthority(): Loadable<TimerAuthorityRecord> {
  return useWatch((env) => {
    const service = env.service();
    return service
      ? service.store.watch(readTimerAuthority, {
          incarnationId: service.incarnationId,
        })
      : null;
  }, []);
}

export type RecordCommit<O> =
  | { kind: "applied"; value: O }
  /** The service's guards refused it (another identity, epoch or incarnation; a wipe closing): nothing was written. */
  | { kind: "dropped" }
  /** The store failed: nothing was written. */
  | { kind: "failed" };

const settled = <O>(
  out: Awaited<ReturnType<AccountService["commit"]>>,
): RecordCommit<O> =>
  out.kind === "applied"
    ? { kind: "applied", value: out.value as O }
    : out.kind === "dropped"
      ? { kind: "dropped" }
      : { kind: "failed" };

/**
 * W27's compare-and-set write, through the service's commit (G1, G2, G5 and the plan's INC, CLS, EPO). A NEW row grows the store: with
 * `env`, it is admitted through the origin's quota ledger first (revision 5), and a refusal is `refused` (nothing written). Never throws.
 */
export async function commitMaterialiseSequence(
  service: AccountService,
  captured: Captured,
  input: {
    key: SequenceKey;
    expected: SequenceExpectation;
    next: MaterialiseSequenceRow | null;
  },
  env: Pick<DataEnv, "quota"> | null = null,
): Promise<RecordCommit<SequenceWrite>> {
  const grows = input.expected === null && input.next !== null;
  let reservation: Awaited<ReturnType<DataEnv["quota"]["reserve"]>> | null =
    null;
  let written = false;
  try {
    if (grows && env !== null)
      reservation = await env.quota.reserve("cache", SEQUENCE_ROW_BYTES);
    const lease = reservation;
    const out = await service.commit(writeMaterialiseSequence, {
      captured,
      ...input,
      ...(lease === null
        ? {}
        : lease.verdict === "refuse"
          ? { admitted: false }
          : { leaseLive: () => lease.live() }),
    });
    written = out.kind === "applied" && out.value.kind === "written";
    return settled(out);
  } catch {
    return { kind: "failed" };
  } finally {
    reservation?.settle(written ? "written" : "not_written");
  }
}

/**
 * W27: the person's "Try again" over the stops it was pressed on, as one compare-and-set (revision 4, review R20): `written` lifted them
 * all, `stale` lifted nothing (one no longer stands as seen). Never throws.
 */
export async function commitMaterialiseLift(
  service: AccountService,
  captured: Captured,
  input: MaterialiseLift,
): Promise<RecordCommit<{ kind: "written" } | { kind: "stale" }>> {
  try {
    return settled(
      await service.commit(liftMaterialiseStops, { captured, ...input }),
    );
  } catch {
    return { kind: "failed" };
  }
}

/**
 * W27 (revision 5): removes the task's rows whose need the caller established is satisfied, each only while it is still the row decided
 * on (`deleteSatisfiedSequences`). Never throws.
 */
export async function clearSatisfiedSequences(
  service: AccountService,
  captured: Captured,
  input: {
    task_id: string;
    rows: ReadonlyArray<{
      through_date: string;
      expected: Exclude<SequenceExpectation, null>;
    }>;
  },
): Promise<RecordCommit<{ removed: number }>> {
  try {
    return settled(
      await service.commit(deleteSatisfiedSequences, { captured, ...input }),
    );
  } catch {
    return { kind: "failed" };
  }
}

/** One task's rows as stored now, in key order (its earliest `SEQUENCE_WINDOW`); `undefined`: the store could not be read. */
export async function readTaskSequencesNow(
  service: AccountService,
  taskId: string,
): Promise<MaterialiseSequenceRow[] | undefined> {
  try {
    return await service.store.run(readMaterialiseSequences, {
      incarnationId: service.incarnationId,
      taskId,
    });
  } catch {
    return undefined;
  }
}

/** One sequence as stored now, or `null` (absent); `undefined`: the store could not be read. */
export async function readMaterialiseSequenceNow(
  service: AccountService,
  key: SequenceKey,
): Promise<MaterialiseSequenceRow | null | undefined> {
  try {
    return await service.store.run(readMaterialiseSequence, {
      incarnationId: service.incarnationId,
      key,
    });
  } catch {
    return undefined;
  }
}

/** The failed discoveries as stored now; `undefined`: the store could not be read. */
export async function readMaterialiseDiscoveryNow(
  service: AccountService,
): Promise<Record<string, MaterialiseDiscovery> | undefined> {
  try {
    return await service.store.run(readMaterialiseDiscovery, {
      incarnationId: service.incarnationId,
    });
  } catch {
    return undefined;
  }
}

/**
 * W27's compare-and-set of one task's discovery entry (G1, G2, G5; INC, CLS, EPO). An entry that ADDS a task (expected absent) grows the
 * singleton: with `env`, it is admitted through the origin's quota ledger first (revision 3, R16), and a refusal is `refused` (nothing
 * written). Never throws.
 */
export async function commitMaterialiseDiscovery(
  service: AccountService,
  captured: Captured,
  input: {
    task_id: string;
    expected: MaterialiseDiscovery | null;
    next: MaterialiseDiscovery | null;
  },
  env: Pick<DataEnv, "quota"> | null = null,
): Promise<RecordCommit<DiscoveryWrite>> {
  const grows = input.expected === null && input.next !== null;
  let reservation: Awaited<ReturnType<DataEnv["quota"]["reserve"]>> | null =
    null;
  let written = false;
  try {
    if (grows && env !== null)
      reservation = await env.quota.reserve("cache", DISCOVERY_ENTRY_BYTES);
    const lease = reservation;
    const out = await service.commit(writeMaterialiseDiscovery, {
      captured,
      ...input,
      ...(lease === null
        ? {}
        : lease.verdict === "refuse"
          ? { admitted: false }
          : { leaseLive: () => lease.live() }),
    });
    written = out.kind === "applied" && out.value.kind === "written";
    return settled(out);
  } catch {
    return { kind: "failed" };
  } finally {
    reservation?.settle(written ? "written" : "not_written");
  }
}

/**
 * W28's observation order: the place of a timer read about to be sent (`captured`: the stamp of its issue). `null`: none was given (no
 * service, another identity, a store failure): the read is then shown but decides nothing against the copy and writes nothing to it.
 */
export async function issueTimerOrderNow(
  service: AccountService,
  captured: Captured,
): Promise<number | null> {
  try {
    const out = await service.commit(issueTimerOrder, { captured });
    return out.kind === "applied"
      ? (out.value as { order: number | null }).order
      : null;
  } catch {
    return null;
  }
}

/**
 * W28: the copy corrected by a read of one occurrence's sessions, and that read's observation of its day recorded (`reconcileTimerCopy`;
 * revision 3, DA-T3). The observation's growth is admitted as a cache write through the origin's quota ledger first; a refusal still
 * corrects the copy and raises the floor instead. Never throws.
 */
export async function commitTimerCorrection(
  env: Pick<DataEnv, "quota">,
  service: AccountService,
  captured: Captured,
  input: {
    order: number;
    drop(row: JsonObject, newer: boolean): boolean;
    scope: TimerScopeObservation;
  },
): Promise<
  RecordCommit<{ removed: number; applied: boolean; scoped: boolean }>
> {
  let reservation: Awaited<ReturnType<DataEnv["quota"]["reserve"]>> | null =
    null;
  let scoped = false;
  try {
    try {
      reservation = await env.quota.reserve(
        "cache",
        utf8Length(JSON.stringify(input.scope)) +
          SCOPE_OVERHEAD +
          endedBytes(input.scope.ended),
      );
    } catch {
      reservation = null;
    }
    const lease = reservation?.verdict === "refuse" ? null : reservation;
    const out = await service.commit(reconcileTimerCopy, {
      captured,
      ...input,
      admitted: lease !== null,
      ...(lease === null ? {} : { leaseLive: () => lease.live() }),
    });
    if (out.kind === "applied") scoped = out.value.scoped;
    return settled(out);
  } catch {
    return { kind: "failed" };
  } finally {
    reservation?.settle(scoped ? "written" : "not_written");
  }
}

/** A scope's own fields beside its lists (orders and names): what a new day's record adds beyond the ids it lists. */
const SCOPE_OVERHEAD = 128;

/** What recording `ids` as finished adds to `timer_ended` at most (revision 5, R23): each id with the largest order it can carry. */
const endedBytes = (ids: readonly string[]) =>
  ids.length === 0
    ? 0
    : utf8Length(
        JSON.stringify(ids.map((id) => [id, Number.MAX_SAFE_INTEGER])),
      );

/**
 * W28 (revision 5, review R23): the sessions a page of the account's history listed, recorded as finished and taken out of the copy
 * (`recordTimerEnded`), the growth admitted as a cache write through the origin's quota ledger first; a refusal still takes them out of
 * the copy and records the loss. `captured` is the stamp of the history read's issue. Never throws.
 */
export async function commitTimerEnded(
  env: Pick<DataEnv, "quota">,
  service: AccountService,
  captured: Captured,
  ids: readonly string[],
): Promise<RecordCommit<{ recorded: boolean; removed: number }>> {
  let reservation: Awaited<ReturnType<DataEnv["quota"]["reserve"]>> | null =
    null;
  let recorded = false;
  try {
    try {
      reservation = await env.quota.reserve("cache", endedBytes(ids));
    } catch {
      reservation = null;
    }
    const lease = reservation?.verdict === "refuse" ? null : reservation;
    const out = await service.commit(recordTimerEnded, {
      captured,
      ids,
      admitted: lease !== null,
      ...(lease === null ? {} : { leaseLive: () => lease.live() }),
    });
    if (out.kind === "applied")
      recorded = (out.value as { recorded: boolean }).recorded;
    return settled(out);
  } catch {
    return { kind: "failed" };
  } finally {
    reservation?.settle(recorded ? "written" : "not_written");
  }
}

/**
 * W28's authority as stored NOW (revision 5, review R23): what an act re-checks after its own waits, so a correction whose watch has not
 * been delivered yet still counts. `undefined`: the store could not be read.
 */
export async function readTimerAuthorityNow(
  service: AccountService,
): Promise<TimerAuthorityRecord | undefined> {
  try {
    return await service.store.run(readTimerAuthority, {
      incarnationId: service.incarnationId,
    });
  } catch {
    return undefined;
  }
}

/**
 * W28: replaces the running-timer copy with `copy` (or removes it), admitted as a cache write through the origin's quota ledger first (a
 * refusal writes nothing), then committed through the service (G1, G2, G5; INC, CLS, EPO). `captured` is the stamp of the READ's issue.
 */
export async function commitTimerCopy(
  env: Pick<DataEnv, "quota">,
  service: AccountService,
  captured: Captured,
  copy: TimerCopyRecord | null,
): Promise<RecordCommit<{ written: boolean }>> {
  let reservation: Awaited<ReturnType<DataEnv["quota"]["reserve"]>> | null =
    null;
  let written = false;
  try {
    reservation = await env.quota.reserve(
      "cache",
      utf8Length(JSON.stringify(copy)),
    );
    if (reservation.verdict === "refuse") return { kind: "dropped" };
    const lease = reservation;
    const out = await service.commit(writeTimerCopy, {
      captured,
      copy,
      leaseLive: () => lease.live(),
    });
    if (out.kind === "applied") written = out.value.written;
    return out.kind === "applied"
      ? { kind: "applied", value: { written } }
      : settled(out);
  } catch {
    return { kind: "failed" };
  } finally {
    reservation?.settle(written ? "written" : "not_written");
  }
}

export type {
  DiscoveryWrite,
  SequenceExpectation,
  SequenceKey,
  SequenceWrite,
  TaskSequences,
  TaskSequencesAsk,
} from "../plans/materialise";
export {
  DISCOVERY_ENTRY_BYTES,
  DISCOVERY_REQUEST_ID,
  TASK_SEQUENCE_ROWS,
} from "../plans/materialise";
export {
  TIMER_COPY_ROWS,
  type TimerAuthorityRecord,
  type TimerCopyRecord,
  type TimerScopeObservation,
  type TimerScopeRecord,
  timerAuthorityOf,
} from "../plans/timer-copy";
