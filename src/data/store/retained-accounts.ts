import type { AccountId } from "../model/types";
import type { summariseWork } from "../plans/fence";
import type { readProfile } from "../plans/profile";
import type { DatabaseHost } from "./host";
import { createIdbHost } from "./idb-host";
import type { AccountStore } from "./port";
import {
  type ConnectionRegistry,
  createRegistry,
  getPageRegistry,
} from "./registry";

/**
 * The retained-account directory (WEB-08c, WF-SWITCH-01, decision D-8c-01): the accounts that have a database in this browser
 * profile, for the account picker. It is a LOCAL record of who used this computer before, never a live session (there is one cookie
 * per origin: switching is always a fresh sign-in, `wireframes/switch/states.md`).
 *
 * - **Discovery** is `indexedDB.databases()`, matched by `accountDatabaseName`'s exact pattern (`atlas-<uuid>`; `atlas-auth` shares the
 *   prefix and is never one). A listing that is unavailable or rejects is `unknown`, never "no other accounts" (a failed look is not
 *   an absence, R12/R16).
 * - **Reading** is ONE short-lived open of an EXISTING database per account, under a private registry (the deletion ports' opener,
 *   `create: false`), closed in the same call. It never creates a database, writes nothing (both plans are read-only), takes no
 *   latch and joins no page connection: the page's registry is only READ, to skip an account this page has latched
 *   `closed_for_deletion`. An account whose `atlas-delete:<account>` is held (a deletion is running in some page) is skipped too; that
 *   is asked by a non-blocking `ifAvailable` request that is let go at once (never `navigator.locks.query()`). A database that vanished
 *   is omitted; one that exists but cannot be read is listed with `waiting: "unknown"` (its work is never reported as none).
 * - **The label** is that account's OWN persisted profile record (the username last verified for it, `writeProfile`), never inferred
 *   from its id and never the current account's identity. The picker presents it only as "Used on this computer before".
 *
 * It is never called on the boot path: only the switcher's lazily loaded chunk imports it. Its browser composition takes the opener and
 * both read plans from the deletion ports' lazily loaded browser module (`ports/ports-browser.ts`), so the switcher's chunk adds no
 * new chunk boundary through the data model (a static import of the plans here split a shared initial chunk of the fixture shell).
 */
export interface RetainedAccount {
  readonly account_id: AccountId;
  /** The username last VERIFIED for this account id (its own persisted profile record), or null when it holds none. */
  readonly lastVerifiedName: string | null;
  /** Unsynced changes, counted exactly as `LocalWorkPort.summarise` counts them; "unknown" when the read failed. */
  readonly waiting: number | "unknown";
}

export type RetainedListing =
  | { kind: "ok"; accounts: readonly RetainedAccount[] }
  /** `indexedDB.databases()` is unavailable or rejected: never reported as "no other accounts". */
  | { kind: "unknown" };

export interface RetainedAccountsDeps {
  host: DatabaseHost;
  /** The page's registry, READ only (its latch). */
  registry: Pick<ConnectionRegistry, "latch">;
  /** `true` when `atlas-delete:<account>` is free at this moment (an `ifAvailable` request let go at once). `false` proves nothing more. */
  deletionFree(account: AccountId): Promise<boolean>;
  /** An EXISTING database, one short-lived connection, or null when there is none. The caller closes it. */
  openExisting(account: AccountId): Promise<AccountStore | null>;
  /** The two read-only plans: the account's own profile record and its unsynced-work summary. */
  plans: RetainedAccountPlans;
}

export interface RetainedAccountPlans {
  readonly readProfile: typeof readProfile;
  readonly summariseWork: typeof summariseWork;
}

const ACCOUNT_DATABASE =
  /^atlas-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

/** The account a database name belongs to, or null when the name is not an account database (`atlas-auth`, anything else). */
export function accountOfDatabase(name: string): AccountId | null {
  const match = ACCOUNT_DATABASE.exec(name);
  return match ? (match[1] as AccountId) : null;
}

const abortedError = (): Error =>
  new DOMException("The listing was aborted", "AbortError");

export async function listRetainedAccountsWith(
  deps: RetainedAccountsDeps,
  options: {
    readonly exclude: AccountId | null;
    readonly signal?: AbortSignal;
  },
): Promise<RetainedListing> {
  const { signal } = options;
  if (signal?.aborted) throw abortedError();
  let names: readonly string[];
  try {
    names = await deps.host.list();
  } catch {
    return { kind: "unknown" };
  }
  const accounts: RetainedAccount[] = [];
  const seen = new Set<string>();
  for (const name of names) {
    if (signal?.aborted) throw abortedError();
    const account = accountOfDatabase(name);
    if (account === null || account === options.exclude || seen.has(account))
      continue;
    seen.add(account);
    if (deps.registry.latch(account) === "closed_for_deletion") continue;
    let free: boolean;
    try {
      free = await deps.deletionFree(account);
    } catch {
      free = false;
    }
    if (!free) continue;
    const read = await readOne(deps, account);
    if (read !== null) accounts.push(read);
  }
  if (signal?.aborted) throw abortedError();
  return { kind: "ok", accounts };
}

async function readOne(
  deps: RetainedAccountsDeps,
  account: AccountId,
): Promise<RetainedAccount | null> {
  let store: AccountStore | null;
  try {
    store = await deps.openExisting(account);
  } catch {
    return (await stillListed(deps, account))
      ? { account_id: account, lastVerifiedName: null, waiting: "unknown" }
      : null;
  }
  // Gone between the listing and the open: a database that no longer exists is no retained account.
  if (store === null) return null;
  try {
    let lastVerifiedName: string | null = null;
    try {
      const profile = await store.run(deps.plans.readProfile, {
        incarnationId: store.incarnationId,
      });
      lastVerifiedName =
        typeof profile?.username === "string" && profile.username.length > 0
          ? profile.username
          : null;
    } catch {
      lastVerifiedName = null;
    }
    let waiting: number | "unknown";
    try {
      waiting = (
        await store.run(deps.plans.summariseWork, {
          incarnationId: store.incarnationId,
        })
      ).count;
    } catch {
      waiting = "unknown";
    }
    return { account_id: account, lastVerifiedName, waiting };
  } finally {
    store.close();
  }
}

async function stillListed(
  deps: RetainedAccountsDeps,
  account: AccountId,
): Promise<boolean> {
  try {
    return (await deps.host.list()).some(
      (name) => accountOfDatabase(name) === account,
    );
  } catch {
    // Unknown: keep the row (with its work unknown) rather than hide an account that may hold unsynced changes.
    return true;
  }
}

/** The browser composition: raw IndexedDB listing, the page's registry, Web Locks, and the Dexie opener and plans loaded on demand. */
export async function listRetainedAccounts(options: {
  readonly exclude: AccountId | null;
  readonly signal?: AbortSignal;
}): Promise<RetainedListing> {
  const browser = await import("../ports/ports-browser");
  return listRetainedAccountsWith(
    {
      host: createIdbHost(),
      registry: getPageRegistry(),
      deletionFree: (account) => {
        const locks = globalThis.navigator?.locks;
        if (!locks) return Promise.resolve(false);
        return locks.request(
          `atlas-delete:${account}`,
          { ifAvailable: true },
          (lock) => lock !== null,
        );
      },
      plans: browser.retainedAccountPlans,
      async openExisting(account) {
        // A private registry per call, exactly as the deletion ports open: the page's latch must not refuse this read, and this
        // short-lived connection must not be counted as the page's.
        const opened = await browser
          .createDexieOpener({
            registry: createRegistry("retained"),
          })
          .open(account, {
            create: false,
            single: true,
            incarnation: globalThis.crypto.randomUUID(),
          });
        return opened.kind === "opened" ? opened.store : null;
      },
    },
    options,
  );
}
