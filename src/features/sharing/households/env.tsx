import { createContext, type ReactNode, useContext, useMemo } from "react";
import { useIdentity, useSession } from "../../../session";
import { createHouseholdApi, type HouseholdApi } from "./api";

/**
 * The household client for the DISPLAYED `(account, epoch)` (plan §4.2), inside the lazy chunk. Production builds it from the session, like
 * `ProductionSharingEnv`; a test or a fixture provides its own. Identity, connectivity, writability, ids and time come from `SharingEnv`.
 */
export interface HouseholdsEnv {
  api: HouseholdApi;
}

const HouseholdsEnvContext = createContext<HouseholdsEnv | null>(null);

export function HouseholdsEnvProvider({
  value,
  children,
}: {
  value: HouseholdsEnv;
  children: ReactNode;
}) {
  return (
    <HouseholdsEnvContext.Provider value={value}>
      {children}
    </HouseholdsEnvContext.Provider>
  );
}

export function useHouseholdsEnv(): HouseholdsEnv {
  const env = useContext(HouseholdsEnvContext);
  if (env === null)
    throw new Error(
      "useHouseholdsEnv must be used inside a HouseholdsBoundary",
    );
  return env;
}

function ProductionHouseholdsEnv({ children }: { children: ReactNode }) {
  const session = useSession();
  const identity = useIdentity();
  const account = identity?.account_id ?? null;
  const epoch = identity?.epoch ?? null;
  const value = useMemo<HouseholdsEnv | null>(
    () =>
      account === null || epoch === null
        ? null
        : { api: createHouseholdApi(session, account, epoch) },
    [session, account, epoch],
  );
  if (value === null) return null;
  return (
    <HouseholdsEnvProvider value={value}>{children}</HouseholdsEnvProvider>
  );
}

/** Provides the production household env unless one is already provided (a test, the fixture, an outer boundary). */
export function HouseholdsBoundary({ children }: { children: ReactNode }) {
  const outer = useContext(HouseholdsEnvContext);
  if (outer !== null) return <>{children}</>;
  return <ProductionHouseholdsEnv>{children}</ProductionHouseholdsEnv>;
}
