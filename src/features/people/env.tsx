import { createContext, type ReactNode, useContext, useMemo } from "react";
import { createFormRecoveryPort, useDataEnv } from "../../data";
import { useIdentity, useSession } from "../../session";
import { type SharingApi, SharingBoundary, useSharingEnv } from "../sharing";
import { createPeopleApi, type PeopleApi } from "./api";
import { type HeldStore, heldStoreOver } from "./field/held-store";
import { type PeopleMemory, peopleMemory } from "./memory";

/**
 * What the people screens need besides the data layer (the SharingEnv pattern, WEB-12a): the online-only people client and the sharing
 * client for the DISPLAYED `(account, epoch)`, whose account that is, connectivity, whether writes are allowed (the B2 rule: only while the
 * server's contract is `supported`), and the page memory of that identity. Production builds it from the session and the sharing env; a
 * test or the fixture provides its own.
 *
 * It is keyed by the identity: another account or epoch is another env, another client and another memory, so nothing read, kept or sent
 * under one identity is shown or sent under another (the protected tree is also remounted by the gate on any change, 20(b)).
 */
export interface PeopleEnv {
  api: PeopleApi;
  /** The sharing slice's client for the same identity (the quick policy change, D-11a-8). */
  sharing: SharingApi;
  accountId: string;
  /** The displayed `(account, epoch)` as one key. */
  identity: string;
  online: boolean;
  /** `session.compat` is `supported`. */
  writable: boolean;
  newId(): string;
  now(): number;
  memory: PeopleMemory;
  /** The account's DURABLE held audience changes (form copies of its database, finding 6). */
  held: HeldStore;
  /**
   * Runs `run` while this page holds the lock `name` across every page of the browser (Web Locks, Q12), or does nothing and answers
   * null when another page holds it: a held change is run by one page at a time.
   */
  exclusive<T>(name: string, run: () => Promise<T>): Promise<T | null>;
}

/** `exclusive` over Web Locks (`ifAvailable`: never queued behind another page's run). */
export function webLocksExclusive<T>(
  name: string,
  run: () => Promise<T>,
): Promise<T | null> {
  return navigator.locks.request(name, { ifAvailable: true }, (lock) =>
    lock === null ? null : run(),
  ) as Promise<T | null>;
}

const PeopleEnvContext = createContext<PeopleEnv | null>(null);

export function PeopleEnvProvider({
  value,
  children,
}: {
  value: PeopleEnv;
  children: ReactNode;
}) {
  return (
    <PeopleEnvContext.Provider value={value}>
      {children}
    </PeopleEnvContext.Provider>
  );
}

export function usePeopleEnv(): PeopleEnv {
  const env = useContext(PeopleEnvContext);
  if (env === null)
    throw new Error("usePeopleEnv must be used inside a PeopleBoundary");
  return env;
}

function ProductionPeopleEnv({ children }: { children: ReactNode }) {
  const sharing = useSharingEnv();
  const data = useDataEnv();
  const session = useSession();
  const identity = useIdentity();
  const epoch = identity?.epoch ?? null;
  const account = sharing.accountId;
  const api = useMemo(
    () =>
      epoch === null || identity?.account_id !== account
        ? null
        : createPeopleApi(session, account, epoch),
    [session, account, epoch, identity?.account_id],
  );
  // The port writes to whichever account's database the data env has bound; the protected tree is remounted on any change of identity.
  const held = useMemo(() => {
    const now = () => new Date().toISOString();
    return heldStoreOver(
      createFormRecoveryPort({
        service: () => data.service(),
        quota: data.quota,
        now,
      }),
      now,
    );
  }, [data]);
  const value = useMemo<PeopleEnv | null>(
    () =>
      api === null
        ? null
        : {
            api,
            sharing: sharing.api,
            accountId: account,
            identity: sharing.identity,
            online: sharing.online,
            writable: sharing.writable,
            newId: sharing.newId,
            now: sharing.now,
            memory: peopleMemory(sharing.identity),
            held,
            exclusive: webLocksExclusive,
          },
    [api, sharing, account, held],
  );
  // No identity is displayed: there is nothing to show (the gate has taken over).
  if (value === null) return null;
  return <PeopleEnvProvider value={value}>{children}</PeopleEnvProvider>;
}

/** Provides the production people env unless one is already provided (a test, the fixture, an outer boundary). */
export function PeopleBoundary({ children }: { children: ReactNode }) {
  const outer = useContext(PeopleEnvContext);
  if (outer !== null) return <>{children}</>;
  return (
    <SharingBoundary>
      <ProductionPeopleEnv>{children}</ProductionPeopleEnv>
    </SharingBoundary>
  );
}
