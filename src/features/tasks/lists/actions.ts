import { useMemo } from "react";
import { useAnnouncer } from "../../../components/ui/announcer";
import {
  type CacheRow,
  type DraftWithCommand,
  type EnqueueRequest,
  readResourceViewNow,
  readSaveEvidence,
  useDataEnv,
} from "../../../data";
import { type SaveOutcome, useTaskActions } from "../actions";
import * as copy from "../copy";
import { useTasksEnv } from "../env";
import { listItem } from "../model/lists";
import { projectCreateTask } from "../register";
import { RENAME } from "./copy";

/**
 * The Lists screens' acts (plan §3.5): every save goes through the outbox (`useTaskActions().enqueue`: writability, refusal copy and the
 * announcement), and a rename of a list whose create is still queued edits that create in place. An act on a list this device knows
 * denies edits is refused before the outbox is asked (`denied`); the writing transaction decides a denial committed after the screen was
 * drawn (`requiresEdit`), another tab's included.
 */
export interface ListActions {
  enqueue(request: EnqueueRequest, announce?: string): Promise<SaveOutcome>;
  /** A known denial on screen: nothing is asked of the outbox. */
  denied(): { ok: false; message: string | null };
  /** An in-place edit of a queued draft (D-10b-8). */
  editQueued(
    localId: string,
    request: EnqueueRequest,
    announce: string,
  ): Promise<SaveOutcome>;
  /** The database (its incarnation) a save issued now is written to: what an answer that is lost is later looked up in. */
  scope(): string | null;
  /**
   * What became of an issued save whose answer was lost (WEB-10b revision 3, D1), read only, never by sending it again: `stored` (a draft
   * under its id is that save as it was sent: recorded on this device, not proof the server applied it), `changed` (a draft under its id
   * is not that save as sent, or was refused, discarded or replaced) or `unknown` (nothing under its id now, the read failed, or the
   * database is not the one it was issued to: no evidence either way).
   */
  reconcile(save: Issued): Promise<Evidence>;
  /**
   * The add of a task to a list, admitted on what this device holds of the TASK now (revision 4, D1 / DA-N1), never on what a selection
   * remembered: one read (`readResourceViewNow`) finds the task cached (the add needs no create) or the create that will make it (the add
   * waits for THAT create), and the request states what the read saw (`observed`), so the transaction that writes it refuses (`changed`)
   * if the task's create was replaced, discarded, sent or published after the read. `gone`: nothing on this device makes the task now;
   * `unread`: the read failed or its database changed. Neither wrote anything. Nothing is enqueued here.
   */
  prepareAdd(input: {
    listId: string;
    taskId: string;
    localId: string;
  }): Promise<PreparedAdd>;
}

export type PreparedAdd =
  | { kind: "ready"; request: EnqueueRequest; scope: string }
  | { kind: "gone" | "unread" };

/** The statuses of a task's create that still make the task: waiting, being sent, waiting for the person (`blocked`), or accepted. */
const MAKING: ReadonlySet<string> = new Set([
  "queued",
  "in_flight",
  "blocked",
  "acknowledged",
]);

/**
 * What an add of `taskId` waits for, from one read of the task (revision 4): the task cached (as a task) needs nothing; otherwise its
 * newest create, if that create still makes it and projects it as a task, is waited for; anything else (no row and no create, a create
 * refused, discarded in conflict or replaced, another kind at the id) is `gone`. Absence is never read as "already sent".
 */
export function admitTask(
  view: { merged: CacheRow | null; create: DraftWithCommand | null },
  taskId: string,
): { kind: "ready"; after: string | null } | { kind: "gone" } {
  if (view.merged !== null)
    return view.merged.kind === "task"
      ? { kind: "ready", after: null }
      : { kind: "gone" };
  const create = view.create;
  if (
    create !== null &&
    MAKING.has(create.status) &&
    projectCreateTask(create, taskId)?.kind === "task"
  )
    return { kind: "ready", after: create.local_id };
  return { kind: "gone" };
}

/** An issued save whose answer was lost: its local id, its exact request as sent, and the database it was issued to. */
export interface Issued {
  localId: string;
  request: EnqueueRequest;
  scope: string | null;
}

export type Evidence = "stored" | "changed" | "unknown";

export function useListActions(): ListActions {
  const env = useTasksEnv();
  const data = useDataEnv();
  const announcer = useAnnouncer();
  const actions = useTaskActions();
  return useMemo<ListActions>(() => {
    const refuse = (
      message: string | null,
    ): { ok: false; message: string | null } => {
      if (message) announcer.announce(message, "assertive");
      return { ok: false, message };
    };
    return {
      enqueue: actions.enqueue,
      denied: () => refuse(copy.refusalMessage("denied")),
      async editQueued(localId, request, announce) {
        if (!env.writable) return refuse(copy.NOT_WRITABLE);
        const outbox = data.outbox();
        if (outbox === null) return refuse(copy.NO_DATABASE);
        let edited: Awaited<ReturnType<typeof outbox.editQueued>>;
        try {
          edited = await outbox.editQueued(localId, request);
        } catch {
          return refuse(copy.refusalMessage("storage"));
        }
        if (edited.kind === "edited") {
          announcer.announce(announce, "polite");
          return { ok: true, localId };
        }
        return refuse(
          edited.reason === "draft_changed"
            ? RENAME.changedElsewhere
            : edited.reason === "not_queued" || edited.reason === "not_found"
              ? RENAME.waitSync
              : copy.refusalMessage(edited.reason),
        );
      },
      scope: () => data.service()?.incarnationId ?? null,
      async reconcile(save) {
        const read = await readSaveEvidence(data, save);
        if (!read.ok || read.value === "absent") return "unknown";
        return read.value === "stored" ? "stored" : "changed";
      },
      async prepareAdd({ listId, taskId, localId }) {
        const read = await readResourceViewNow(data, taskId, {
          create: "create_task",
        });
        if (!read.ok) return { kind: "unread" };
        const admitted = admitTask(read.value.view, taskId);
        if (admitted.kind === "gone") return admitted;
        return {
          kind: "ready",
          scope: read.value.scope,
          request: listItem({
            listId,
            taskId,
            included: true,
            after: admitted.after,
            localId,
            observed: read.value.view.observation,
          }),
        };
      },
    };
  }, [env.writable, data, announcer, actions]);
}
