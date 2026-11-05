import { liveRegions } from "../../components/ui/announcer";
import { type EnqueueRequest, type Outbox, useDataEnv } from "../../data";
import * as copy from "./copy";
import { usePeopleEnv } from "./env";
import { admit, isPending, preparedFor, settle } from "./lifetime";
import {
  isCurrentMemory,
  type PeopleMemory,
  useMemoryRevision,
} from "./memory";
import { archiveRequest } from "./model/commands";
import { useOutboxSave } from "./parts";

/**
 * ARCHIVE AND RESTORE, one owner per target (review 8, finding 2). Every view that archives or restores a person or a field (the detail's
 * buttons, the editor's Archive, the Settings "Archived items" rows of every kind) asks through the identity's PAGE memory, never through
 * itself:
 *
 *  - one at a time per target (`archive:<id>`), whichever view asks: the claim is taken before anything is awaited and held until the save
 *    settles, so a view that was remounted meanwhile (another reading of the ledger, another of its pages, a parent read hidden and shown,
 *    the protected tree remounted) shows it as saving and admits nothing more. After it settles, the next deliberate action (the opposite
 *    one, or the same one after a refusal) is admitted;
 *  - a retry of the same action on the same version is the SAME request (`localId`), so one whose answer was lost while it was written is
 *    recognised by the outbox and not made twice; another action, or another version, is a new request;
 *  - what it says (a refusal) is kept by target for whichever view shows the target now, and its success is announced by the page's live
 *    regions as they are then; both only while the identity that asked is still the one shown (its memory, and the same account's queue).
 *
 * Page memory only: a reload forgets a running claim (the queue keeps what was written), and another page's actions are its own (the
 * outbox orders both by their bases).
 */
export const archiveTarget = (id: string): string => `archive:${id}`;

/** The request archiving (or restoring) `id` from `version` is made as: the same while neither changes, until it succeeds. */
export function archiveRequestFor(
  memory: PeopleMemory,
  id: string,
  archived: boolean,
  version: number,
  newId: () => string,
): EnqueueRequest {
  const { localId } = preparedFor(
    memory,
    archiveTarget(id),
    `${archived}:${version}`,
    () => ({ localId: newId() }),
  );
  return archiveRequest({ id, archived, localId });
}

/** An archive or restore of `id` was saved: its request is spent and no earlier refusal of it is shown any more. */
export function archiveSaved(memory: PeopleMemory, id: string): void {
  const target = archiveTarget(id);
  memory.prepared.delete(target);
  memory.actionReports.delete(target);
  memory.touch();
}

export interface ArchiveAction {
  /** An archive or restore of the target runs (asked from any view). */
  pending: boolean;
  /** What the last one said, while it is to be shown. */
  message: string | null;
  run(archived: boolean, version: number): Promise<void>;
}

export function useArchiveAction(id: string): ArchiveAction {
  const env = usePeopleEnv();
  const data = useDataEnv();
  const save = useOutboxSave();
  useMemoryRevision(env.memory);
  const { memory, newId } = env;
  const target = archiveTarget(id);
  return {
    pending: isPending(memory, target),
    message: memory.actionReports.get(target) ?? null,
    run: async (archived, version) => {
      const admission = admit(memory, [target], newId);
      if (admission === null) return;
      const request = archiveRequestFor(memory, id, archived, version, newId);
      const used: { outbox: Outbox | null } = { outbox: null };
      let outcome: Awaited<ReturnType<typeof save>>;
      try {
        outcome = await save((outbox) => {
          used.outbox = outbox;
          return outbox.enqueue(request);
        });
      } finally {
        settle(admission);
      }
      if (
        !isCurrentMemory(memory) ||
        (used.outbox !== null && data.outbox() !== used.outbox)
      )
        return;
      if (outcome.ok) {
        archiveSaved(memory, id);
        // Said by the page's announcer as it is NOW: the tree that pressed may have been remounted since (its live region is gone).
        liveRegions.announce(copy.SAVED_NOT_SENT, "polite");
      } else if (outcome.message !== null) {
        memory.actionReports.set(target, outcome.message);
        memory.touch();
      }
    },
  };
}
