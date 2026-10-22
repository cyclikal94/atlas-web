import { useCallback, useSyncExternalStore } from "react";
import type { Policy } from "../../data";
import type { Attempt } from "./model/attempt";
import type { LinkageState } from "./model/linkage";

/**
 * The people screens' PAGE memory (§3.2 `memory.ts`): what this page learnt or kept for ONE displayed identity (`account:epoch`), outside
 * the components, so that it outlives a remount of the protected tree (a `403` anywhere remounts it, D-12a-13; the WEB-13a lesson):
 *
 *  - `linkage`: the answer of `GET /people/{id}` per person (D-11a-2), and the reads still on their way (shared, never made twice);
 *  - `refused`: a person read that was refused (`403`/`404`), remembered until an explicit "Try again" (D-12a-13);
 *  - `prefetched`: the people whose linkage the list asked for already (once per identity per page lifetime, D-11a-3);
 *  - `dismissed`: duplicate pairs hidden with "Not the same" (D-11a-9);
 *  - `heldRuns`: the held audience changes this page is running now, and whether the person discarded one while it ran (the held
 *    changes themselves are DURABLE, in the account's database: `field/held-store.ts`, finding 6 of the review of 13 October);
 *  - `heldAuthority`: the holds this page may run by itself (D1 of 22 October 2026); every other hold waits for "Send now";
 *  - `drafts`: editor input kept by the in-dialog sync control or across a remount (field editor, rename);
 *  - `attempts`: the uncertain attempt of an online-only command, per target (same key and body on "Try again");
 *  - `summaries`: the viewer-safe summaries read for this identity (finding 8, `summaries.tsx`), per query, for the CURRENT invalidation
 *    `summaryGeneration` only, with the highest `preferences_version` applied and each row's highest versions (the contract's
 *    monotonicity rules: an older answer is never applied over a newer one in the same epoch). Display data only, never a permission.
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

/**
 * One held change this page is running (`field/held.ts`). `cancelled`: the person discarded it while it ran; every later admission boundary
 * of the run checks it, and nothing more is sent or queued. `policyDone`: the audience step was confirmed before that (it cannot be
 * undone; the person is told so).
 */
export interface HeldRun {
  holdId: string;
  cancelled: boolean;
  policyDone: boolean;
}

/** One summary read, by its query (`summaries.tsx`): what it answered under the generation it was asked at. */
export interface SummaryEntry {
  generation: number;
  state:
    | { kind: "loading" }
    | { kind: "ready"; value: unknown; checkedAt: number }
    | { kind: "failed"; reason: "failed" | "not_found" | "stale" };
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
  /** The held changes running on this page, by hold id (at most one at a time). */
  readonly heldRuns = new Map<string, HeldRun>();
  /**
   * Holds this page finished or discarded: never run again here, and not shown, even while the durable list has not caught up yet (its
   * read is live but asynchronous).
   */
  readonly heldEnded = new Set<string>();
  /**
   * Holds this page may RUN by itself (D1, decided 22 October 2026: "explicit Send now"): the holds made in this page, and those the
   * person chose "Send now" or "Try again" for here. A hold recovered from the database (after a reload, an account switch back, in
   * another page) is shown, and waits for the person; it never sends merely because the page that ended or stopped it is gone.
   */
  readonly heldAuthority = new Set<string>();
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
  /** Bumped by every invalidation: every earlier summary read is superseded, and none of its answers is applied. */
  summaryGeneration = 0;
  /** The highest `preferences_version` a summary applied in this epoch (0: none yet). */
  summaryPreferences = 0;
  /** The highest `version`/`policy_version` applied for each summarised row (person or field), by id. */
  readonly summaryFloors = new Map<
    string,
    { version: number; policyVersion: number }
  >();
  /** The summary reads of the current generation, by query key. */
  readonly summaries = new Map<string, SummaryEntry>();
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

  /**
   * Something a summary depends on may have changed (a projection, a receipt, a reconnection, households or the primary household, the
   * 60-second refresh, the view becoming visible): every summary is read again, and every read still on its way is superseded.
   */
  invalidateSummaries(): void {
    this.summaryGeneration += 1;
    this.summaries.clear();
    this.touch();
  }

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
