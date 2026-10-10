import { accountDatabaseName } from "../model/schema";
import type { AccountId } from "../model/types";
import type { DatabaseHost } from "./host";
import type { OpenResult } from "./port";
import type { ConnectionRegistry } from "./registry";

/**
 * `openAccountData` (plan 5.1.2): the only way a page obtains an account's database. It exists to make two guarantees:
 *
 * 1. Opening an existing database NEVER creates one: an absent database is `{ kind: "absent" }`, because `exists` goes
 *    through `indexedDB.databases()` and the engine's open is made to refuse creation (`create: false`).
 * 2. Creation happens only when the MAY-CREATE PREDICATE holds, inside `atlas-delete:<account>`: the page's identity is that
 *    account, and no logout or retirement is pending for it (both are FACTS, read synchronously, and fail closed). The
 *    lock is the session's own wipe lock, so creation is serialised with a running wipe, which holds the same lock for its
 *    whole procedure. The data layer takes `atlas-delete:` nowhere else (Web Locks are not re-entrant, and no port method
 *    the kernel calls while it holds that lock may take it again). *
 * The predicate is a fact about the CREATING BOUNDARY, not about the moment of the call (R36, revision 21): it is read again after every
 * wait (the lock, the listing made under it), in the step that starts the creating open, and the opener reads it a last time inside the
 * creating upgrade itself (`permit`), so a fact that changed while the request was queued in the engine creates nothing either.
 * A refusal leaves no database behind and deletes none: removing a database is the wipe's decision.
 *
 * An open has a LIFETIME (R37, revision 21): it begins when it is asked for, and a CLOSURE of the account on this page (`registry.closeAll`,
 * a latch to anything but `open`: a wipe, another tab's deletion or upgrade, the identity leaving) ends it. An open whose lifetime ended
 * neither lifts the latch nor yields a store: it lets go of exactly the handles it opened and answers `closed`. The registry's
 * `generation(account)` is what tells such an open from a deliberately authorised NEW one, which begins while the account is latched.
 */
export interface EngineOpener {
  /**
   * Opens the account's database with this page's two connections. With `create: false` an absent database is
   * `{ kind: "absent" }` and nothing is created (the upgrade is aborted). With `create: true` the database is created
   * and its singleton seeded in the same versionchange transaction, with `incarnation`.
   */
  open(
    account: AccountId,
    options: {
      create: boolean;
      incarnation: string;
      /**
       * One connection instead of two. For the short-lived handles of the deletion ports, which are opened under their OWN
       * registry (so a latch on the page's registry does not refuse them) and closed straight after use.
       */
      single?: boolean;
      /**
       * Asked a last time INSIDE the creating upgrade (`create: true`), synchronously, in the versionchange transaction that would create
       * the database. `false` aborts that transaction exactly as `create: false` does, so nothing is created and the open answers
       * `absent` (R36). An opener that does not ask it is still covered by the check made in the step that starts the open.
       */
      permit?: () => boolean;
    },
  ): Promise<OpenResult>;
}

export interface LockLike {
  acquire(
    name: string,
    options?: { signal?: AbortSignal },
  ): Promise<{ release(): void } | null>;
}

export interface OpenDeps {
  host: DatabaseHost;
  opener: EngineOpener;
  registry: ConnectionRegistry;
  locks: LockLike;
  /** The account the page's settled identity names, or null. A FACT, never a permission. */
  identityAccount(): AccountId | null;
  /** True when a logout or retirement is pending for the account (`session.operations.pending`). */
  operationPending(account: AccountId): boolean;
  newIncarnation(): string;
  /** How long creation waits behind a running wipe. */
  lockWaitMs: number;
  /** A signal that aborts after `ms`; injectable for the fake world. */
  abortAfter(ms: number): AbortSignal;
}

/** The session's own wipe lock name (`LOCKS.wipe`); a test pins equality with the constant. */
export const wipeLockName = (account: AccountId): string =>
  `atlas-delete:${account}`;

export type OpenRefusal =
  | "identity"
  | "operation_pending"
  | "wipe_in_progress"
  | "abandoned"
  /** A closure of the account on this page (a wipe, a deletion, an upgrade, the identity leaving) ended this open (R37). */
  | "closed";
export type OpenOutcome = OpenResult | { kind: "refused"; reason: OpenRefusal };

export interface OpenOptions {
  create?: boolean;
  /**
   * The lifetime of whoever asked (R35, revision 20): true once that caller has been disposed and no longer wants an outcome. It is
   * read at every point where `openAccountData` is about to START something (a native open, a creation) and wherever a native open
   * has just FINISHED, so an abandoned open starts no connection it can avoid and releases exactly the handles it opened when it
   * could not. It is a fact about the caller and never a permission: nothing is allowed because it is false.
   */
  abandoned?: () => boolean;
}

export async function openAccountData(
  deps: OpenDeps,
  account: AccountId,
  options: OpenOptions = {},
): Promise<OpenOutcome> {
  const create = options.create === true;
  const abandoned = options.abandoned ?? (() => false);
  const refuse = (reason: OpenRefusal): OpenOutcome => ({
    kind: "refused",
    reason,
  });
  // A caller that is already gone starts nothing.
  if (abandoned()) return refuse("abandoned");
  // The page's identity must be this account: a late code path of another account cannot reopen a latched database.
  if (deps.identityAccount() !== account) return refuse("identity");
  const name = accountDatabaseName(account);
  // THE LIFETIME OF THIS OPEN begins here (R37): a closure of the account on this page after this point ends it. A closure BEFORE it (the
  // account is latched because a wipe ran) is the state a deliberately authorised new open starts from, and lifts when it finishes.
  const born = deps.registry.generation(account);
  const closedSince = (): boolean => deps.registry.generation(account) !== born;

  /**
   * Whether this open may START something or PUBLISH a result now, and if not, the answer it gives instead. Read in the step that starts
   * every native open, after every wait, and where a native open has finished; it is a set of FACTS, read synchronously, and nothing is
   * allowed because it returns null. In this order: the caller (`abandoned`), for a creation the page's identity and a pending logout or
   * retirement (R36: the may-create predicate), then a closure of the account since this open began (R37).
   */
  const lapsed = (creating: boolean): OpenOutcome | null => {
    if (abandoned()) return refuse("abandoned");
    if (creating) {
      if (deps.identityAccount() !== account) return refuse("identity");
      if (deps.operationPending(account)) return refuse("operation_pending");
    }
    if (closedSince()) return refuse("closed");
    return null;
  };

  /**
   * Whichever way a native open ends for a caller that has gone, or whose lifetime a closure ended, it ends in the caller's own handles
   * being let go: `store.close()` closes THIS open's two connections and removes only THEIR entries from the page's registry. It is never
   * `registry.closeAll`, which would close every connection of the account on the page, including those of a healthy runtime that
   * replaced the abandoned one, and it leaves the account's latch exactly as it was (a wipe may have latched it meanwhile; only an open
   * somebody still wants, and that no closure has ended, lifts a latch).
   */
  const settled = (opened: OpenResult): OpenOutcome => {
    if (opened.kind !== "opened") return opened;
    const over = lapsed(false);
    if (over !== null) {
      opened.store.close();
      return over;
    }
    deps.registry.setLatch(account, "open");
    return opened;
  };

  /**
   * A native open. An opener that finds a closure ended its lifetime lets go of its handles and fails; the failure is the closure's
   * consequence, so the answer is `closed` (a failure of an open no closure touched is still a failure).
   */
  const native = async (
    start: () => Promise<OpenResult>,
  ): Promise<OpenOutcome> => {
    let opened: OpenResult;
    try {
      opened = await start();
    } catch (error) {
      if (closedSince()) return refuse("closed");
      throw error;
    }
    return settled(opened);
  };

  const openExisting = async (): Promise<OpenOutcome> => {
    // The listing (or the lock) took time: a caller that went meanwhile, or a closure since, gets no native open at all.
    const early = lapsed(false);
    if (early !== null) return early;
    return native(() =>
      deps.opener.open(account, {
        create: false,
        incarnation: deps.newIncarnation(),
      }),
    );
  };

  // `list` rejects when `indexedDB.databases()` is unavailable: an unknown answer is never "absent" (MU-41).
  const present = (await deps.host.list()).includes(name);
  if (present) return openExisting();
  // An absent database is the answer of the look, whether or not the caller is still there to read it.
  if (!create) return { kind: "absent" };

  if (deps.operationPending(account)) return refuse("operation_pending");
  const lock = await deps.locks.acquire(wipeLockName(account), {
    signal: deps.abortAfter(deps.lockWaitMs),
  });
  if (lock === null) return refuse("wipe_in_progress");
  try {
    // Re-check under the lock: the facts may have changed while it was waited for. A caller that went while it waited creates nothing.
    const underLock = lapsed(true);
    if (underLock !== null) return underLock;
    if ((await deps.host.list()).includes(name)) return await openExisting();
    // The listing took time too (R36): the whole predicate is read AGAIN, in the very step that starts the creating open. The wipe lock
    // does not freeze the page's facts while the databases are being listed.
    const beforeCreating = lapsed(true);
    if (beforeCreating !== null) return beforeCreating;
    // A creating upgrade that has begun cannot be taken back (and deleting a database is the wipe's decision, not this function's): an
    // abandoned creation leaves the database it made and lets go of its own handles. What can still be refused is the creation itself:
    // the opener asks `permit` inside the upgrade, so a fact that changed while the request was queued creates nothing.
    const refusal: { outcome: OpenOutcome | null } = { outcome: null };
    const permit = (): boolean => {
      refusal.outcome = lapsed(true);
      return refusal.outcome === null;
    };
    const outcome = await native(() =>
      deps.opener.open(account, {
        create: true,
        incarnation: deps.newIncarnation(),
        permit,
      }),
    );
    // The opener answers `absent` when the upgrade was refused: say why, not that the database is missing.
    if (outcome.kind === "absent" && refusal.outcome !== null)
      return refusal.outcome;
    return outcome;
  } finally {
    lock.release();
  }
}
