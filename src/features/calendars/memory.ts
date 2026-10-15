import type { AccountId, Epoch } from "../../data";
import {
  createRefreshOwnership,
  type RefreshOwnership,
} from "./refresh-ownership";
import type { CalendarVisit } from "./visit";

/**
 * What the person must still see after the protected tree is REMOUNTED under the same identity (WEB-13a). An Atlas `401` or `403` is
 * classified by the session, which closes the protected display and opens it again (session matrix 3.6.2), so the Calendars screen,
 * its refresh controller and any open form are unmounted by the very answer they were waiting for: a refresh refused `403` (cause 6b)
 * or a connection change refused for access would otherwise end with nothing shown.
 *
 * Memory only, never persisted, and per displayed identity (`account`, `epoch`) in this document: taking the memory of one identity
 * drops every other identity's (its refresh ownership is revoked and its visit disposed), so nothing is ever shown under another account
 * or after a re-authentication. It holds the manual refreshes' ownership (`refresh-ownership.ts`, revision 6, R12: which admission of
 * each source may still record an outcome, and the owners' ENDED runs with their keys, for "Check again"), short refusal notices and the
 * screen's current visit (`visit.ts`: what the screen read by itself, so that a remount does not read it again); never a form's values,
 * and so never a secret.
 */
export interface IdentityMemory {
  /** The manual refreshes of this identity: who owns each source, and the owners' ended runs (`refresh-ownership.ts`). */
  readonly refresh: RefreshOwnership;
  /** Refusal notices by source id (or `link` for the Link form): the words only. */
  readonly notices: Map<string, string>;
  /** The Calendars screen's current visit, or null when none is (`visit.ts`): dropped (disposed) with the memory. */
  visit: CalendarVisit | null;
}

const memories = new Map<string, IdentityMemory>();

const drop = (memory: IdentityMemory): void => {
  memory.refresh.revoke();
  memory.visit?.dispose();
};

export function identityMemory(
  account: AccountId,
  epoch: Epoch,
): IdentityMemory {
  const key = `${account}\u0000${epoch}`;
  for (const [other, dropped] of [...memories])
    if (other !== key) {
      memories.delete(other);
      drop(dropped);
    }
  let memory = memories.get(key);
  if (memory === undefined) {
    memory = {
      refresh: createRefreshOwnership(),
      notices: new Map(),
      visit: null,
    };
    memories.set(key, memory);
  }
  return memory;
}

/** Forgets everything (tests). */
export function forgetIdentityMemories(): void {
  for (const memory of memories.values()) drop(memory);
  memories.clear();
}
