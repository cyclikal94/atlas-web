import { useCallback, useSyncExternalStore } from "react";
import type { Policy } from "../../data";
import type { Attempt } from "./model/attempt";
import type { LinkageState } from "./model/linkage";
import type { FieldValue } from "./model/values";

/**
 * The people screens' PAGE memory (§3.2 `memory.ts`): what this page learnt or kept for ONE displayed identity (`account:epoch`), outside
 * the components, so that it outlives a remount of the protected tree (a `403` anywhere remounts it, D-12a-13; the WEB-13a lesson):
 *
 *  - `linkage`: the answer of `GET /people/{id}` per person (D-11a-2), and the reads still on their way (shared, never made twice);
 *  - `refused`: a person read that was refused (`403`/`404`), remembered until an explicit "Try again" (D-12a-13);
 *  - `prefetched`: the people whose linkage the list asked for already (once per identity per page lifetime, D-11a-3);
 *  - `dismissed`: duplicate pairs hidden with "Not the same" (D-11a-9);
 *  - `held`: audience changes held until the connection returns (D-11a-12);
 *  - `drafts`: editor input kept by the in-dialog sync control or across a remount (field editor, rename);
 *  - `attempts`: the uncertain attempt of an online-only command, per target (same key and body on "Try again").
 *
 * Nothing is written to storage: a reload forgets it, and so does any other identity. Memory for one identity is dropped the moment
 * another identity asks for its own, so nothing learnt or kept under one account (or an earlier sign-in of it) is shown or sent under
 * another. A continuation that finishes after that writes into a memory nobody reads any more.
 */
export interface LinkageEntry {
  state: LinkageState;
  /** The person as that answer gave it (its label and version), for the rename and unlink bases. */
  person: { id: string; label: string; version: number } | null;
}

export interface HeldChange {
  fieldId: string;
  personId: string;
  label: string;
  value: FieldValue;
  sameKind: boolean;
  /** The field's content version when the edit began: the content step is refused if the field changed since. */
  baseVersion: number;
  /** The policy as last read on this page (owner only), with its version: the policy change is guarded by it. */
  from: { version: number; policy: Policy };
  to: Policy;
  /** What happened when it last ran; `waiting` until then. */
  status:
    | { kind: "waiting" }
    | { kind: "running" }
    | {
        kind: "failed";
        reason:
          | "changed"
          | "conflict"
          | "forbidden"
          | "uncertain"
          | "content_changed"
          | "not_saved";
      };
}

type Listener = () => void;

export class PeopleMemory {
  readonly linkage = new Map<string, LinkageEntry>();
  readonly linkageReads = new Map<string, Promise<unknown>>();
  readonly refused = new Map<string, "forbidden" | "not_found">();
  /** People whose last linkage read failed for another reason (asked again on reconnect or "Try again"). */
  readonly failed = new Set<string>();
  readonly prefetched = new Set<string>();
  readonly dismissed = new Map<string, Set<string>>();
  readonly held = new Map<string, HeldChange>();
  readonly drafts = new Map<string, unknown>();
  /** Field policies this page read (owner-only `GET /policies/{id}`), with their versions: the only audiences the table names. */
  readonly policies = new Map<string, { version: number; policy: Policy }>();
  /** Policy reads on their way, shared by every editor that asks (never made twice). */
  readonly policyReads = new Set<string>();
  /** Policy reads that did not answer with a policy (`403`: remembered for the page; others until the next try). */
  readonly policyRefusals = new Map<string, "forbidden" | "failed">();
  /** The count "Possible duplicates" showed from its first page, per person ("2", "2+"; null: none claimed). */
  readonly duplicateCounts = new Map<string, string | null>();
  readonly attempts = new Map<string, Attempt>();
  private listeners = new Set<Listener>();
  private revision = 0;

  constructor(readonly identity: string) {}

  /** Something changed: every screen that reads this memory renders again. */
  touch(): void {
    this.revision += 1;
    for (const listener of [...this.listeners]) listener();
  }
  readonly subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  readonly version = (): number => this.revision;

  /** The pairs of `personId` hidden with "Not the same". */
  dismissedOf(personId: string): ReadonlySet<string> {
    return this.dismissed.get(personId) ?? new Set();
  }
  dismiss(personId: string, otherId: string): void {
    const set = new Set(this.dismissedOf(personId));
    set.add(otherId);
    this.dismissed.set(personId, set);
    // The pair is one pair whichever person's list it is seen from.
    const back = new Set(this.dismissedOf(otherId));
    back.add(personId);
    this.dismissed.set(otherId, back);
    this.touch();
  }
}

let current: PeopleMemory | null = null;

/** The memory of `identity`, forgetting any other identity's. */
export function peopleMemory(identity: string): PeopleMemory {
  if (current === null || current.identity !== identity) {
    const previous = current;
    current = new PeopleMemory(identity);
    previous?.touch();
  }
  return current;
}

/** Whether `memory` is still the one kept (a continuation of another identity must not act on what it finds). */
export const isCurrentMemory = (memory: PeopleMemory): boolean =>
  current === memory;

/** For tests: forget everything. */
export function forgetAllPeopleMemory(): void {
  const previous = current;
  current = null;
  previous?.touch();
}

/** Re-renders the caller whenever `memory` changes. */
export function useMemoryRevision(memory: PeopleMemory): number {
  const subscribe = useCallback(
    (listener: Listener) => memory.subscribe(listener),
    [memory],
  );
  return useSyncExternalStore(subscribe, memory.version, memory.version);
}
