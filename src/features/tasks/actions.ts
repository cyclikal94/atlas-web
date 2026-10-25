import { useMemo } from "react";
import { useAnnouncer } from "../../components/ui/announcer";
import {
  type EnqueueRequest,
  OutboxRequestError,
  useDataEnv,
  useSharingDefaults,
} from "../../data";
import * as copy from "./copy";
import { useTasksEnv } from "./env";
import * as commands from "./model/commands";
import type { Evidence } from "./model/contract";
import type { RowModel } from "./view";

/**
 * The person's acts on an occurrence or a task, saved through the outbox (never React Query mutations). A save is shown as saved only when
 * the enqueue transaction answered `queued`; every refusal is a plain message and nothing is shown as saved (§4.6). Announced through the
 * announcer only (lint R6).
 */
export type SaveOutcome =
  | { ok: true; localId: string }
  /**
   * `uncertain`: the save may have been stored all the same (a store that failed or threw, a service that ended during it): a retry under
   * the same local id must send the same request (WEB-10b R1). Otherwise nothing was stored.
   */
  | { ok: false; message: string | null; uncertain?: boolean };

/** Refusals after which the writing transaction may nonetheless have committed (its answer was lost with the store or the service). */
const UNCERTAIN: ReadonlySet<string> = new Set([
  "storage",
  "closed",
  "identity_changed",
]);

export interface TaskActions {
  enqueue(request: EnqueueRequest, announce?: string): Promise<SaveOutcome>;
  record(
    row: RowModel,
    evidence: Evidence,
    replaces?: string | null,
    announce?: string,
  ): Promise<SaveOutcome>;
  resolve(row: RowModel, resolved: boolean): Promise<SaveOutcome>;
  exclude(row: RowModel, excluded: boolean): Promise<SaveOutcome>;
  archive(taskId: string, archived: boolean): Promise<SaveOutcome>;
}

export function useTaskActions(): TaskActions {
  const env = useTasksEnv();
  const data = useDataEnv();
  const announcer = useAnnouncer();
  const defaults = useSharingDefaults();
  const record = defaults.record;
  return useMemo<TaskActions>(() => {
    const enqueue = async (
      request: EnqueueRequest,
      announce: string = copy.ANNOUNCE_SAVED,
    ): Promise<SaveOutcome> => {
      if (!env.writable) {
        announcer.announce(copy.NOT_WRITABLE, "assertive");
        return { ok: false, message: copy.NOT_WRITABLE };
      }
      const outbox = data.outbox();
      if (outbox === null) {
        announcer.announce(copy.NO_DATABASE, "assertive");
        return { ok: false, message: copy.NO_DATABASE };
      }
      let outcome: Awaited<ReturnType<typeof outbox.enqueue>>;
      try {
        outcome = await outbox.enqueue(request);
      } catch (error) {
        // A request this slice built wrongly (`OutboxRequestError`, or one JSON cannot carry) stored nothing; anything else that threw
        // may have thrown after the write committed.
        const message = copy.refusalMessage("storage");
        if (message) announcer.announce(message, "assertive");
        return {
          ok: false,
          message,
          uncertain: !(
            error instanceof OutboxRequestError || error instanceof TypeError
          ),
        };
      }
      if (outcome.kind === "queued") {
        announcer.announce(announce, "polite");
        return { ok: true, localId: outcome.localId };
      }
      const message = copy.refusalMessage(outcome.reason);
      if (message) announcer.announce(message, "assertive");
      return { ok: false, message, uncertain: UNCERTAIN.has(outcome.reason) };
    };
    /**
     * A known denial already on screen admits nothing (DA17-N1/N2): the outbox is not asked. The writing transaction is what decides a
     * denial committed after the screen was drawn; this is the act's own check of what it was offered.
     */
    const denied = async (): Promise<SaveOutcome> => {
      const message = copy.refusalMessage("denied");
      if (message) announcer.announce(message, "assertive");
      return { ok: false, message };
    };
    return {
      enqueue,
      record: (row, evidence, replaces = null, announce) => {
        const firstAnyoneStream =
          row.data.definition.participation === "anyone" &&
          !row.streamPresent &&
          !row.streamPending;
        // Joining an Anyone occurrence by its first record needs its edit access; an existing participant records without it.
        if (firstAnyoneStream && !row.canEdit) return denied();
        return enqueue(
          commands.record({
            occurrenceId: row.id,
            progressId: row.progressId,
            me: env.accountId,
            entryId: env.newId(),
            evidence,
            // The instant of the person's act, taken now (never at send).
            happenedAt: Math.floor(env.now() / 1000),
            replaces,
            firstAnyoneStream,
            defaults: record,
          }),
          announce,
        );
      },
      // Closing or reopening a day needs the occurrence's edit access.
      resolve: (row, resolved) =>
        row.canEdit
          ? enqueue(commands.resolve({ occurrenceId: row.id, resolved }))
          : denied(),
      exclude: (row, excluded) =>
        enqueue(
          commands.exclude({
            occurrenceId: row.id,
            progressId: row.progressId,
            excluded,
          }),
        ),
      archive: (taskId, archived) =>
        enqueue(commands.archive({ taskId, archived })),
    };
  }, [env, data, announcer, record]);
}
