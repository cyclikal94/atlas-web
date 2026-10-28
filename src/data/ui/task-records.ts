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
  liftMaterialiseStops,
  type MaterialiseLift,
  pruneMaterialiseSequences,
  readLatestSequences,
  readMaterialiseDiscovery,
  readMaterialiseSequence,
  SEQUENCE_WINDOW,
  type SequenceExpectation,
  type SequenceKey,
  type SequenceWrite,
  writeMaterialiseDiscovery,
  writeMaterialiseSequence,
} from "../plans/materialise";
import {
  issueTimerOrder,
  readTimerAuthority,
  reconcileTimerCopy,
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
 * The latest day's sequence of each of `taskIds`, live: re-read when the store changes, in this page or another (revision 4, review R21:
 * by task, never a prefix of the account's rows, so another task's rows cannot hide a stop). Read `SEQUENCE_WINDOW` tasks at a time, each
 * read bounded; the result is ready only once every read is.
 */
export function useLatestSequences(
  taskIds: readonly string[],
): Loadable<ReadonlyMap<string, MaterialiseSequenceRow>> {
  const key = [...new Set(taskIds)].sort().join(",");
  return useWatch(
    (env) => {
      const service = env.service();
      if (!service) return null;
      const tasks = key === "" ? [] : key.split(",");
      const batches: Watchable<Record<string, MaterialiseSequenceRow>>[] = [];
      for (let i = 0; i < tasks.length; i += SEQUENCE_WINDOW)
        batches.push(
          service.store.watch(readLatestSequences, {
            incarnationId: service.incarnationId,
            taskIds: tasks.slice(i, i + SEQUENCE_WINDOW),
          }),
        );
      return allOf(batches);
    },
    [key],
  );
}

const NO_SEQUENCES: Loadable<ReadonlyMap<string, MaterialiseSequenceRow>> = {
  status: "ready",
  value: new Map(),
};

/** Several watches as one: ready when all are (their rows merged), else the first that is not; the same object while none changes. */
function allOf(
  parts: readonly Watchable<Record<string, MaterialiseSequenceRow>>[],
): Watchable<ReadonlyMap<string, MaterialiseSequenceRow>> {
  let seen: readonly Loadable<Record<string, MaterialiseSequenceRow>>[] = [];
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
        const rows = new Map<string, MaterialiseSequenceRow>();
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

/** W27's compare-and-set write, through the service's commit (G1, G2, G5 and the plan's INC, CLS, EPO). Never throws. */
export async function commitMaterialiseSequence(
  service: AccountService,
  captured: Captured,
  input: {
    key: SequenceKey;
    expected: SequenceExpectation;
    next: MaterialiseSequenceRow | null;
  },
): Promise<RecordCommit<SequenceWrite>> {
  try {
    return settled(
      await service.commit(writeMaterialiseSequence, { captured, ...input }),
    );
  } catch {
    return { kind: "failed" };
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

/** W27's housekeeping: the task's stopped or ready sequences of days before `before`. Never throws. */
export async function pruneOlderSequences(
  service: AccountService,
  captured: Captured,
  input: { task_id: string; before: string },
): Promise<RecordCommit<{ removed: number }>> {
  try {
    return settled(
      await service.commit(pruneMaterialiseSequences, { captured, ...input }),
    );
  } catch {
    return { kind: "failed" };
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
        utf8Length(JSON.stringify(input.scope)) + SCOPE_OVERHEAD,
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
} from "../plans/materialise";
export {
  DISCOVERY_ENTRY_BYTES,
  DISCOVERY_REQUEST_ID,
} from "../plans/materialise";
export {
  TIMER_COPY_ROWS,
  type TimerAuthorityRecord,
  type TimerCopyRecord,
  type TimerScopeObservation,
  type TimerScopeRecord,
} from "../plans/timer-copy";
