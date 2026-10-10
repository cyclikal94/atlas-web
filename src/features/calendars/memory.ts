import type { AccountId, Epoch } from "../../data";
import type { RefreshRun } from "./model/refresh";

/**
 * What the person must still see after the protected tree is REMOUNTED under the same identity (WEB-13a). An Atlas `401` or `403` is
 * classified by the session, which closes the protected display and opens it again (session matrix 3.6.2), so the Calendars screen,
 * its refresh controller and any open form are unmounted by the very answer they were waiting for: a refresh refused `403` (cause 6b)
 * or a connection change refused for access would otherwise end with nothing shown.
 *
 * Memory only, never persisted, and per displayed identity (`account`, `epoch`): taking the memory of one identity drops every other
 * identity's, so nothing is ever shown under another account or after a re-authentication. It holds the ENDED refresh runs (their
 * outcome and key, for "Check again") and short refusal notices; never a form's values, and so never a secret.
 */
export interface IdentityMemory {
  /** Ended refresh runs by source id. */
  readonly runs: Map<string, RefreshRun>;
  /** Refusal notices by source id (or `link` for the Link form): the words only. */
  readonly notices: Map<string, string>;
}

const memories = new Map<string, IdentityMemory>();

export function identityMemory(
  account: AccountId,
  epoch: Epoch,
): IdentityMemory {
  const key = `${account}\u0000${epoch}`;
  for (const other of [...memories.keys()])
    if (other !== key) memories.delete(other);
  let memory = memories.get(key);
  if (memory === undefined) {
    memory = { runs: new Map(), notices: new Map() };
    memories.set(key, memory);
  }
  return memory;
}

/** Forgets everything (tests). */
export function forgetIdentityMemories(): void {
  memories.clear();
}
