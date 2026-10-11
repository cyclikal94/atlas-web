import type { AccountId, Epoch } from "../../data";
import type { RefreshRun } from "./model/refresh";
import type { CalendarVisit } from "./visit";

/**
 * What the person must still see after the protected tree is REMOUNTED under the same identity (WEB-13a). An Atlas `401` or `403` is
 * classified by the session, which closes the protected display and opens it again (session matrix 3.6.2), so the Calendars screen,
 * its refresh controller and any open form are unmounted by the very answer they were waiting for: a refresh refused `403` (cause 6b)
 * or a connection change refused for access would otherwise end with nothing shown.
 *
 * Memory only, never persisted, and per displayed identity (`account`, `epoch`): taking the memory of one identity drops every other
 * identity's, so nothing is ever shown under another account or after a re-authentication. It holds the ENDED refresh runs (their
 * outcome and key, for "Check again"), short refusal notices and the screen's current visit (`visit.ts`, revision 5: what the screen
 * read by itself, so that the remount does not read it again); never a form's values, and so never a secret.
 */
export interface IdentityMemory {
  /** Ended refresh runs by source id. */
  readonly runs: Map<string, RefreshRun>;
  /** Refusal notices by source id (or `link` for the Link form): the words only. */
  readonly notices: Map<string, string>;
  /**
   * Told when a disposed refresh controller records a run's outcome (its answer came after the remount): the screen's current controller
   * adopts it (revision 5).
   */
  readonly lateRuns: Set<(sourceId: string) => void>;
  /** The Calendars screen's current visit, or null when none is (`visit.ts`): dropped (disposed) with the memory. */
  visit: CalendarVisit | null;
}

const memories = new Map<string, IdentityMemory>();

export function identityMemory(
  account: AccountId,
  epoch: Epoch,
): IdentityMemory {
  const key = `${account}\u0000${epoch}`;
  for (const [other, dropped] of [...memories])
    if (other !== key) {
      memories.delete(other);
      dropped.visit?.dispose();
    }
  let memory = memories.get(key);
  if (memory === undefined) {
    memory = {
      runs: new Map(),
      notices: new Map(),
      lateRuns: new Set(),
      visit: null,
    };
    memories.set(key, memory);
  }
  return memory;
}

/** Forgets everything (tests). */
export function forgetIdentityMemories(): void {
  for (const memory of memories.values()) memory.visit?.dispose();
  memories.clear();
}
