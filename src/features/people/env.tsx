import { createContext, type ReactNode, useContext, useMemo } from "react";
import { useIdentity, useSession } from "../../session";
import { type SharingApi, SharingBoundary, useSharingEnv } from "../sharing";
import { createPeopleApi, type PeopleApi } from "./api";
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
  /** How many people the list reads the linkage of while online (D-11a-3: 25). */
  prefetchLinkage: number;
  memory: PeopleMemory;
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
            prefetchLinkage: 25,
            memory: peopleMemory(sharing.identity),
          },
    [api, sharing, account],
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
