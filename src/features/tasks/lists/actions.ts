import { useMemo } from "react";
import { useAnnouncer } from "../../../components/ui/announcer";
import { type EnqueueRequest, readDraftNow, useDataEnv } from "../../../data";
import { type SaveOutcome, useTaskActions } from "../actions";
import * as copy from "../copy";
import { useTasksEnv } from "../env";
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
  /**
   * Whether a save made under `localId` is stored now (R2, revision 2): `true` (found, whatever its state), `false` (nothing is under that
   * id now, which is not proof that nothing ever was), `null` (no answer: no database, or the read failed).
   */
  stored(localId: string): Promise<boolean | null>;
}

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
      async stored(localId) {
        const read = await readDraftNow(data, localId);
        return read.ok ? read.value !== null : null;
      },
    };
  }, [env.writable, data, announcer, actions]);
}
