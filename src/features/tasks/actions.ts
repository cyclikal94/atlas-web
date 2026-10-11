import { useMemo } from "react";
import { useAnnouncer } from "../../components/ui/announcer";
import {
  type EnqueueRequest,
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
  | { ok: false; message: string | null };

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
      } catch {
        // A request this slice built wrongly (`OutboxRequestError`) or a store that threw: nothing was saved.
        const message = copy.refusalMessage("storage");
        if (message) announcer.announce(message, "assertive");
        return { ok: false, message };
      }
      if (outcome.kind === "queued") {
        announcer.announce(announce, "polite");
        return { ok: true, localId: outcome.localId };
      }
      const message = copy.refusalMessage(outcome.reason);
      if (message) announcer.announce(message, "assertive");
      return { ok: false, message };
    };
    return {
      enqueue,
      record: (row, evidence, replaces = null, announce) =>
        enqueue(
          commands.record({
            occurrenceId: row.id,
            progressId: row.progressId,
            me: env.accountId,
            entryId: env.newId(),
            evidence,
            // The instant of the person's act, taken now (never at send).
            happenedAt: Math.floor(env.now() / 1000),
            replaces,
            firstAnyoneStream:
              row.data.definition.participation === "anyone" &&
              !row.streamPresent &&
              !row.streamPending,
            defaults: record,
          }),
          announce,
        ),
      resolve: (row, resolved) =>
        enqueue(commands.resolve({ occurrenceId: row.id, resolved })),
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
