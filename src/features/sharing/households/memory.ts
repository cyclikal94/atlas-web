import { useCallback, useSyncExternalStore } from "react";
import type { SnapshotHousehold } from "../../../data";
import {
  type Invitation,
  type SharingFailure,
  type SharingResult,
  untilSent,
} from "../api";
import type { Attempt } from "../model/submission";
import type { HouseholdApi } from "./api";
import {
  dropped,
  forgetHouseholdRecovery,
  retireHouseholdRecoveryExcept,
} from "./form-recovery";
import type {
  AccountInvitationSummary,
  IssuedInvitation,
  SentInvitation,
} from "./model";

/**
 * The households screens' PAGE memory (D-12b-3; the `people/memory.ts` pattern): what this page learnt or kept for ONE displayed identity
 * (`account:epoch`), outside the components, so that it outlives a remount of the protected tree. Every manager command a member sends is
 * refused `403`, and any `403` makes the session re-check and REMOUNT the protected tree (D-12a-13): the dialog that asked is unmounted
 * before it sees the answer, and its route reopens it. What it needs then is here:
 *
 *  - the reads: the complete membership list (`GET /households`), the invitations for you (`GET /invitations`), the walk of what you sent
 *    (`GET /invitations/sent`), the active signup invitations (`GET /account-invitations`), each with its own time; a read supersedes an
 *    earlier one of the same kind, and an answer for an older generation is dropped;
 *  - `browseRefused`: the server's directory is disabled (`GET /directory` answered `403`), asked once per page lifetime;
 *  - the single OPERATION owner (DA-H1) and the unresolved attempt (R8, Decision H), with the identity that made it;
 *  - the last problem of each surface, the form drafts, and a signup link issued and not yet dismissed.
 *
 * The three typed drafts (New household, Rename, an invitation's username) are also followed by app-update recovery models (WEB-12b merge
 * correction M-1, `form-recovery.ts`): page memory stays their authority; a draft it drops ends its model's session, and another identity's
 * models leave the page's registry with its memory.
 *
 * Nothing is written to storage, the URL or history: a reload forgets it (Decision H, D-12b-2), and so does any other identity. Memory for
 * one identity is dropped the moment another identity asks for its own; a continuation that finishes after that writes into a memory
 * nobody reads any more (`isCurrentHouseholds`).
 */
export interface Read<T> {
  status: "idle" | "loading" | "ready" | "failed";
  /** The last answer that was the contract's, with when it arrived (kept while a later read is under way or failed). */
  last: { value: T; at: number } | null;
  failure: SharingFailure | null;
  generation: number;
}
const idle = <T>(): Read<T> => ({
  status: "idle",
  last: null,
  failure: null,
  generation: 0,
});

export interface Problem {
  message: string;
  requestId?: string;
}

/** An attempt whose outcome is not known (R8): Try again resends it as it is; only a receipt or the server's refusal ends it. */
export interface Unresolved {
  attempt: Attempt;
  done: string;
  identity: string;
  /** Whether it may have reached the server (an uncertain answer), not only been held back. */
  sent: boolean;
  /** Whether its LATEST try was held back by the session (nothing sent that time): "Couldn't send the change". */
  heldBack: boolean;
  /** Where it was made (a dialog or the detail), so that surface says so too. */
  surface: string;
  /** The household it concerns, if any (a create's is the id it chose). */
  target: string | null;
}

/** What the sent walk read: every row in id order, and whether the 10-page bound stopped it. */
export interface SentRead {
  items: SentInvitation[];
  truncated: boolean;
}

/** What the page needs of the render that is mounted NOW: a continuation checks the connection and the identity as they are now. */
export interface Live {
  identity: string;
  online: boolean;
  writable: boolean;
  now(): number;
}

type Listener = () => void;

export const SENT_MAX_PAGES = 10;

export class HouseholdsMemory {
  households: Read<SnapshotHousehold[]> = idle();
  invitations: Read<Invitation[]> = idle();
  sent: Read<SentRead> = idle();
  signup: Read<AccountInvitationSummary[]> = idle();
  browseRefused = false;
  /** The households this page has seen you manage: a later member role there is a LOSS of manager rights (D-12b-7). */
  readonly managed = new Set<string>();
  operation: { token: number } | null = null;
  tokens = 0;
  unresolved: Unresolved | null = null;
  readonly problems = new Map<string, Problem>();
  readonly drafts = new Map<string, string>();
  /** M-1: the household version a RESTORED rename was composed against, by draft key (its Save is guarded by it, never an overwrite). */
  readonly bases = new Map<string, number>();
  /** A signup link just issued, by household, until Done or the dialog is dismissed (never storage, the URL or the announcer). */
  readonly issued = new Map<string, IssuedInvitation & { link: string }>();
  /** Signup invitations that may have been created by an issuance whose answer was lost, by household (SHARE-7). */
  readonly flagged = new Map<string, Set<string>>();
  /** A signup issuance refused `limit`, by household, with the list it was refused against: New invitation waits for a change. */
  readonly limited = new Map<string, string>();
  /** A signup revoke whose answer was lost: Try again may resend it (the effect is idempotent). */
  readonly revokeUncertain = new Set<string>();
  live: Live | null = null;
  private listeners = new Set<Listener>();
  private revision = 0;

  constructor(readonly identity: string) {}

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

  note(surface: string, problem: Problem | null): void {
    if (problem === null) this.problems.delete(surface);
    else this.problems.set(surface, problem);
    this.touch();
  }
  draft(key: string, value: string | null): void {
    if (value === null) {
      this.drafts.delete(key);
      this.bases.delete(key);
      // M-1: the draft is gone from page memory, so its recovery session ends (its copies are discarded).
      dropped(this.identity, key);
    } else this.drafts.set(key, value);
    this.touch();
  }
  /**
   * M-1: the recovery model's own write, never the person's edit and never the end of its session: a restored copy (with the version a
   * rename was composed against), or "Discard instead"'s reset to what the form shows untouched (`null`).
   */
  recovered(
    key: string,
    value: string | null,
    base: number | null = null,
  ): void {
    if (value === null) this.drafts.delete(key);
    else this.drafts.set(key, value);
    if (base === null) this.bases.delete(key);
    else this.bases.set(key, base);
    this.touch();
  }
}

let current: HouseholdsMemory | null = null;

/** The memory of `identity`, forgetting any other identity's. */
export function householdsMemory(identity: string): HouseholdsMemory {
  if (current === null || current.identity !== identity) {
    const previous = current;
    // M-1: the previous identity's recovery models leave the page's registry with its memory (F-INT-PEOPLE-Q4's rule).
    retireHouseholdRecoveryExcept(identity);
    current = new HouseholdsMemory(identity);
    previous?.touch();
  }
  return current;
}

export const isCurrentHouseholds = (memory: HouseholdsMemory): boolean =>
  current === memory;

/** For tests: forget everything. */
export function forgetHouseholdsMemory(): void {
  const previous = current;
  current = null;
  forgetHouseholdRecovery();
  previous?.touch();
}

/** Re-renders the caller whenever `memory` changes. */
export function useHouseholdsMemory(identity: string): HouseholdsMemory {
  const memory = householdsMemory(identity);
  const subscribe = useCallback(
    (listener: Listener) => memory.subscribe(listener),
    [memory],
  );
  useSyncExternalStore(subscribe, memory.version, memory.version);
  return memory;
}

/** Whether an answer asked under `generation` of `read` may still land (same memory, nothing asked since). */
const landing = (
  memory: HouseholdsMemory,
  read: () => Read<unknown>,
  generation: number,
) => isCurrentHouseholds(memory) && read().generation === generation;

/**
 * One read of `which`, superseding any earlier one: the answer lands only while it is still the latest read of this memory. A `closed`
 * answer (the session closed the request, the gate has taken over) leaves the read idle, to be asked by the next mount.
 */
function readInto<T>(
  memory: HouseholdsMemory,
  get: () => Read<T>,
  set: (next: Read<T>) => void,
  run: () => Promise<SharingResult<T>>,
  after?: (value: T) => void,
): Promise<void> {
  const generation = get().generation + 1;
  set({ ...get(), status: "loading", failure: null, generation });
  memory.touch();
  return untilSent(run, {
    isCurrent: () => landing(memory, get as () => Read<unknown>, generation),
  }).then(
    (result) => {
      if (!landing(memory, get as () => Read<unknown>, generation)) return;
      const now = memory.live?.now() ?? Date.now();
      if (result.ok) {
        set({
          status: "ready",
          last: { value: result.value, at: now },
          failure: null,
          generation,
        });
        after?.(result.value);
      } else if (result.kind === "closed")
        set({ ...get(), status: "idle", failure: null, generation });
      else set({ ...get(), status: "failed", failure: result, generation });
      memory.touch();
    },
    () => {
      if (!landing(memory, get as () => Read<unknown>, generation)) return;
      set({
        ...get(),
        status: "failed",
        failure: { ok: false, kind: "uncertain" },
        generation,
      });
      memory.touch();
    },
  );
}

export function readHouseholds(
  memory: HouseholdsMemory,
  api: HouseholdApi,
): Promise<void> {
  return readInto(
    memory,
    () => memory.households,
    (next) => {
      memory.households = next;
    },
    () => api.households(),
    (list) => {
      for (const h of list) if (h.role === "manager") memory.managed.add(h.id);
    },
  );
}

export function readInvitations(
  memory: HouseholdsMemory,
  api: HouseholdApi,
): Promise<void> {
  return readInto(
    memory,
    () => memory.invitations,
    (next) => {
      memory.invitations = next;
    },
    () => api.invitations(),
  );
}

export function readSignup(
  memory: HouseholdsMemory,
  api: HouseholdApi,
): Promise<void> {
  return readInto(
    memory,
    () => memory.signup,
    (next) => {
      memory.signup = next;
    },
    () => api.signupList(),
  );
}

/**
 * The walk of `GET /invitations/sent` (D-12b-4): 200 rows a page, to `next_after === null`, at most 10 pages (2,000 rows; beyond that the
 * page says older ones are not shown). An EMPTY page with a cursor goes on (the cursor is the authority, not the page's size). A `422`
 * (an invalid cursor) restarts the walk once. Every status is the server's, verbatim.
 */
export function walkSent(
  memory: HouseholdsMemory,
  api: HouseholdApi,
): Promise<void> {
  return readInto(
    memory,
    () => memory.sent,
    (next) => {
      memory.sent = next;
    },
    async (): Promise<SharingResult<SentRead>> => {
      const generation = memory.sent.generation;
      const current = () => landing(memory, () => memory.sent, generation);
      let restarted = false;
      let items: SentInvitation[] = [];
      let after: string | undefined;
      let pages = 0;
      while (pages < SENT_MAX_PAGES) {
        const page = await untilSent(() => api.sent(after), {
          isCurrent: current,
        });
        if (!page.ok) {
          if (page.kind === "invalid" && !restarted) {
            restarted = true;
            items = [];
            after = undefined;
            pages = 0;
            continue;
          }
          return page;
        }
        items = items.concat(page.value.items);
        pages += 1;
        if (page.value.next_after === null)
          return { ok: true, value: { items, truncated: false } };
        after = page.value.next_after;
      }
      return { ok: true, value: { items, truncated: true } };
    },
  );
}

/** The complete list as last read, or null when it was never read on this page. */
export const listOf = (memory: HouseholdsMemory): SnapshotHousehold[] | null =>
  memory.households.last?.value ?? null;
export const householdOf = (
  memory: HouseholdsMemory,
  id: string,
): SnapshotHousehold | null => listOf(memory)?.find((h) => h.id === id) ?? null;
