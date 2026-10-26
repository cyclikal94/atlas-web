import type { AccountService } from "../engine/account-service";
import { utf8Length } from "../model/outbox";
import type {
  Captured,
  JsonObject,
  MaterialiseDiscovery,
  MaterialiseSequenceRow,
} from "../model/types";
import {
  type DiscoveryWrite,
  pruneMaterialiseSequences,
  readMaterialiseDiscovery,
  readMaterialiseSequence,
  readMaterialiseSequences,
  type SequenceExpectation,
  type SequenceKey,
  type SequenceWrite,
  writeMaterialiseDiscovery,
  writeMaterialiseSequence,
} from "../plans/materialise";
import {
  issueTimerOrder,
  readTimerCopy,
  reconcileTimerCopy,
  type TimerCopyRecord,
  writeTimerCopy,
} from "../plans/timer-copy";
import type { Loadable } from "../store/port";
import type { DataEnv } from "./env";
import { useWatch } from "./react";

/**
 * WEB-10c's records in the account database (W27 catch-up sequences, W28 the running-timer copy), in a module of their own: only the
 * lazy task screens import it, so its plans stay out of every initial bundle. The task slice owns what the rows mean; this owns how they
 * are read, compared and committed.
 */

/** The sequences of one task (`taskId`) or of the account (`null`), live: re-read when the store changes, in this page or another. */
export function useMaterialiseSequences(
  taskId: string | null,
): Loadable<MaterialiseSequenceRow[]> {
  return useWatch(
    (env) => {
      const service = env.service();
      return service
        ? service.store.watch(readMaterialiseSequences, {
            incarnationId: service.incarnationId,
            taskId,
          })
        : null;
    },
    [taskId],
  );
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

/** The running-timer copy of the displayed account's database, live (`null`: none, or none readable). */
export function useTimerCopy(): Loadable<TimerCopyRecord | null> {
  return useWatch((env) => {
    const service = env.service();
    return service
      ? service.store.watch(readTimerCopy, {
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

/** W27's compare-and-set of one task's discovery entry (G1, G2, G5; INC, CLS, EPO). Never throws. */
export async function commitMaterialiseDiscovery(
  service: AccountService,
  captured: Captured,
  input: {
    task_id: string;
    expected: MaterialiseDiscovery | null;
    next: MaterialiseDiscovery | null;
  },
): Promise<RecordCommit<DiscoveryWrite>> {
  try {
    return settled(
      await service.commit(writeMaterialiseDiscovery, { captured, ...input }),
    );
  } catch {
    return { kind: "failed" };
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

/** W28: the copy corrected by a read of one occurrence's sessions (`reconcileTimerCopy`). Never throws. */
export async function commitTimerCorrection(
  service: AccountService,
  captured: Captured,
  input: { order: number; drop(row: JsonObject, newer: boolean): boolean },
): Promise<RecordCommit<{ removed: number; applied: boolean }>> {
  try {
    return settled(
      await service.commit(reconcileTimerCopy, { captured, ...input }),
    );
  } catch {
    return { kind: "failed" };
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
} from "../plans/materialise";
export { TIMER_COPY_ROWS, type TimerCopyRecord } from "../plans/timer-copy";
