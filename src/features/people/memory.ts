import { useCallback, useSyncExternalStore } from "react";
import type { Policy } from "../../data";
import {
  forgetPeopleRecovery,
  retirePeopleRecoveryExcept,
} from "./form-recovery";
import type { EditingSession } from "./lifetime";
import type { Attempt } from "./model/attempt";
import type { LinkageState } from "./model/linkage";

/**
 * The people screens' PAGE memory (§3.2 `memory.ts`): what this page learnt or kept for ONE displayed identity (`account:epoch`), outside
 * the components, so that it outlives a remount of the protected tree (a `403` anywhere remounts it, D-12a-13; the WEB-13a lesson):
 *
 *  - `linkage`: the answer of `GET /people/{id}` per person (D-11a-2), and the read on its way (an ordinary caller joins it; a forced read
 *    supersedes it, and only the latest read of the person is applied: review 20, R20.1);
 *  - `personVersions` and `linkageAsked`: the highest version of each person this page saw, and the version a linkage read was last asked
 *    at; a kept answer older than what is known of the person is not shown as current (review 25, R25.1, `personFloor`);
 *  - `refused`: a person read that was refused (`403`/`404`), remembered until an explicit "Try again" (D-12a-13);
 *  - `dismissed`: duplicate pairs hidden with "Not the same" (D-11a-9);
 *  - `heldRuns`: the held audience changes this page is running now, and whether the person discarded one while it ran (the held
 *    changes themselves are DURABLE, in the account's database: `field/held-store.ts`, finding 6 of the review of 13 October);
 *  - `heldAuthority`: the holds this page may run by itself (D1 of 22 October 2026); every other hold waits for "Send now";
 *  - `drafts`: editor input kept by the in-dialog sync control or across a remount (field editor, rename, new person), each with its
 *    editing session; `sessions`: the mounted form of each session, the only one a save's completion may close (`lifetime.ts`);
 *    `pending`, `reports` and `prepared`: each session's running save, what its last one said, and the request it was prepared as;
 *    `actionReports`: what an archive or restore of a target last said (`archive.ts`);
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

/** A field policy this page read (or confirmed by its own change), with its version and the time it was read (`env.now()`). */
export interface PolicyRead {
  version: number;
  policy: Policy;
  checkedAt: number;
}

/** One summary read, by its query (`summaries.tsx`): what it answered under the generation it was asked at. */
export interface SummaryEntry {
  generation: number;
  state:
    | { kind: "loading" }
    | { kind: "ready"; value: unknown; checkedAt: number }
    | { kind: "failed"; reason: "failed" | "not_found" | "stale" };
}

/** A request command's last word (`requestReports`): the message, a copyable reference, and whether its outcome is uncertain. */
export interface RequestReport {
  text: string;
  requestId?: string;
  uncertain?: boolean;
}

/**
 * WEB-11b (R7 of review 2): the dispatches of one request read key (`requests/reads.ts`). `issued`: the number of the latest dispatch;
 * `answered`: the number of the newest dispatch whose answer counted (an answer numbered at or below it is obsolete and has no effect);
 * `latest`: the latest dispatch, with a promise settled once its answer has been taken into account, while it is on its way.
 */
export interface RequestReadLedger {
  issued: number;
  answered: number;
  latest: { dispatch: number; settled: Promise<void>; done: boolean } | null;
}

/** WEB-11b: a request read's remembered `403` (`requests/reads.ts`), with the dispatch that answered it. */
export interface RequestRefusal {
  refusal: {
    ok: false;
    kind: "forbidden";
    requestId?: string;
    message?: string;
  };
  dispatch: number;
}

type Listener = () => void;

export class PeopleMemory {
  readonly linkage = new Map<string, LinkageEntry>();
  readonly linkageReads = new Map<string, Promise<unknown>>();
  readonly refused = new Map<string, "forbidden" | "not_found">();
  /** People whose last linkage read failed for another reason (asked again on reconnect or "Try again"). */
  readonly failed = new Set<string>();
  /**
   * The highest server version of each person a linkage answer or the synced row showed (with `summaryFloors`, `personFloor`). Kept when
   * an answer is withdrawn (a refusal) or a summary read again: what is known of a person never goes back.
   */
  readonly personVersions = new Map<string, number>();
  /** The `personFloor` each person's latest linkage read was asked at: an answer older than it is not asked for again by itself. */
  readonly linkageAsked = new Map<string, number>();
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
  /** The mounted form of each editing session (`lifetime.ts`): what a save's completion may close (review 6, finding 1). */
  readonly sessions = new Map<string, EditingSession>();
  /**
   * The saves still running, by what they were admitted for (an editing session's id, or an action's target such as `archive:<id>`),
   * each with its claim's token (`lifetime.ts` `admit`, review 7, finding 1): while one runs, no other is admitted for the same thing,
   * whichever mount asks.
   */
  readonly pending = new Map<string, string>();
  /** What a session's last save said, kept for its next mount while none is mounted (`lifetime.ts` `reportSession`). */
  readonly reports = new Map<string, unknown>();
  /**
   * The request a session's save was prepared as, with the input it was prepared from (`lifetime.ts` `prepared`); also, by target
   * (`archive:<id>`), the request an archive or restore was prepared as (`archive.ts`).
   */
  readonly prepared = new Map<string, { basis: string; value: unknown }>();
  /**
   * What an action on a target (`archive:<id>`) last said, a refusal, for whichever view shows the target NOW (review 8, finding 2): the
   * row or button that pressed it may be gone (a remount, another page of the ledger), and another view of the same target says it too.
   */
  readonly actionReports = new Map<string, string>();
  /**
   * Field policies this page read or confirmed (owner-only `GET /policies/{id}`), with their versions and when they were read: the only
   * audiences the table names besides the summaries, and only while no later policy version of the field is known (`policyShownFor`).
   * Written through `notePolicy`, so a late answer never replaces a later one.
   */
  readonly policies = new Map<string, PolicyRead>();
  /**
   * Field policies whose kept read may be out of date: the shared sharing editor was open on the field (it reads and saves on its own), or
   * a kept edit came back after the page was elsewhere (review 23, R23.1). By field, the generation of that doubt. While doubted, the kept
   * read still sets the version nothing lower replaces, but it is not shown as who can see the field NOW; only a read asked after the
   * doubt (`doubtPolicy`, then `notePolicy` with that generation) ends it.
   */
  readonly policyDoubts = new Map<string, number>();
  policyGeneration = 0;
  /** Policy reads on their way, by field, each with its owner: only the latest read asked for a field ends or refuses it. */
  readonly policyReads = new Map<string, object>();
  /** Policy reads that did not answer with a policy (`403`: remembered for the page; others until the next try). */
  readonly policyRefusals = new Map<string, "forbidden" | "failed">();
  /** The count "Possible duplicates" showed from its first page, per person ("2", "2+"; null: none claimed). */
  readonly duplicateCounts = new Map<string, string | null>();
  readonly attempts = new Map<string, Attempt>();
  /**
   * WEB-11b: what a request command last said that is not a success (a refusal, an uncertain outcome), by its attempt key
   * (`respond:<id>`, `cancel:<id>`, `request-link:<person>`, `merge:<source>:<target>`), for whichever row or dialog shows that request
   * now: the one that pressed may be gone (a remount, another page of the history). Cleared by the key's next send.
   */
  readonly requestReports = new Map<string, RequestReport>();
  /**
   * WEB-11b: the request reads' `403`s remembered for the page, by read key (N1 of revision 1, R7 of review 2; `requests/reads.ts`). Kept
   * across invalidations and remounts; ended only by the key's explicit retry, a newer answer of the key, or the end of this memory.
   */
  readonly requestRefusals = new Map<string, RequestRefusal>();
  /** WEB-11b: the request reads' dispatches, by read key: which answer is the newest (`requests/reads.ts`). Compact; never a payload. */
  readonly requestReads = new Map<string, RequestReadLedger>();
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

/**
 * Keeps `read` as the field's policy unless a later version of it is already kept (an answer that arrives late never lowers it). `answers`:
 * the doubt the read was asked after; it ends that doubt only while that is still the field's latest one.
 */
export function notePolicy(
  memory: PeopleMemory,
  fieldId: string,
  read: PolicyRead,
  answers?: number,
): void {
  const known = memory.policies.get(fieldId);
  if (known === undefined || read.version >= known.version)
    memory.policies.set(fieldId, read);
  if (answers !== undefined && memory.policyDoubts.get(fieldId) === answers)
    memory.policyDoubts.delete(fieldId);
}

/**
 * The field's kept policy may have changed (review 23, R23.1): it is not shown as current until a read asked from now on answers, and a
 * read already on its way answers nothing about it (it no longer owns the field's read). The kept version stays as the floor.
 */
export function doubtPolicy(memory: PeopleMemory, fieldId: string): void {
  memory.policyGeneration += 1;
  memory.policyDoubts.set(fieldId, memory.policyGeneration);
  memory.policyReads.delete(fieldId);
  memory.touch();
}

/**
 * The latest version of the person this page knows of (review 25, R25.1): from its linkage answers, the synced row and the summaries
 * applied. A linkage answer of an earlier version may be out of date (an unlink increments the version), so it is not current.
 */
export function personFloor(memory: PeopleMemory, personId: string): number {
  return Math.max(
    memory.personVersions.get(personId) ?? 0,
    memory.summaryFloors.get(personId)?.version ?? 0,
  );
}

/** Keeps `version` as the person's latest known one unless a later one is known already. */
export function notePersonVersion(
  memory: PeopleMemory,
  personId: string,
  version: number,
): void {
  if (version > (memory.personVersions.get(personId) ?? 0))
    memory.personVersions.set(personId, version);
}

let current: PeopleMemory | null = null;

/** The memory of `identity`, forgetting any other identity's. */
export function peopleMemory(identity: string): PeopleMemory {
  if (current === null || current.identity !== identity) {
    const previous = current;
    current = new PeopleMemory(identity);
    // WEB-14a (F-INT-PEOPLE-Q4): the forms' recoverable models of another identity leave the page's registry with its page memory.
    retirePeopleRecoveryExcept(identity);
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
  forgetPeopleRecovery();
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
