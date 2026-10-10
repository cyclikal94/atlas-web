import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { useApiCompatibility, useIdentity, useSession } from "../../session";
import { createSharingApi, type SharingApi } from "./api";

/**
 * What the sharing screens need besides the data layer: the online-only client for the DISPLAYED `(account, epoch)`, whose account that
 * is (the owner whose own grant is meaningless), connectivity, and whether writes are allowed (the B2 rule: only while the server's
 * contract is `supported`). Production builds it from the session; a test or the fixture provides its own.
 *
 * It is keyed by the identity: a different account or epoch builds a different client, so nothing read or sent under one identity is
 * shown or sent under another (the protected tree is also unmounted by the gate on any change, 20(b)).
 */
export interface SharingEnv {
  api: SharingApi;
  accountId: string;
  /** The displayed `(account, epoch)` as one key: what unsaved editor input is kept for (`retained.ts`), never shown to another. */
  identity: string;
  online: boolean;
  /** `session.compat` is `supported`. */
  writable: boolean;
  newId(): string;
  now(): number;
}

const SharingEnvContext = createContext<SharingEnv | null>(null);

export function SharingEnvProvider({
  value,
  children,
}: {
  value: SharingEnv;
  children: ReactNode;
}) {
  return (
    <SharingEnvContext.Provider value={value}>
      {children}
    </SharingEnvContext.Provider>
  );
}

export function useSharingEnv(): SharingEnv {
  const env = useContext(SharingEnvContext);
  if (env === null)
    throw new Error("useSharingEnv must be used inside a SharingBoundary");
  return env;
}

/** Whether the browser believes it is online. A hint only: the requests themselves are the evidence. */
function useOnline(): boolean {
  const [online, setOnline] = useState(() =>
    typeof navigator === "undefined" ? true : navigator.onLine,
  );
  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    return () => {
      window.removeEventListener("online", on);
      window.removeEventListener("offline", off);
    };
  }, []);
  return online;
}

function ProductionSharingEnv({ children }: { children: ReactNode }) {
  const session = useSession();
  const identity = useIdentity();
  const compat = useApiCompatibility();
  const online = useOnline();
  const account = identity?.account_id ?? null;
  const epoch = identity?.epoch ?? null;
  const api = useMemo(
    () =>
      account === null || epoch === null
        ? null
        : createSharingApi(session, account, epoch),
    [session, account, epoch],
  );
  const value = useMemo<SharingEnv | null>(
    () =>
      api === null || account === null
        ? null
        : {
            api,
            accountId: account,
            identity: `${account}:${epoch}`,
            online,
            writable: compat.status === "supported",
            newId: () => crypto.randomUUID(),
            now: () => Date.now(),
          },
    [api, account, epoch, online, compat.status],
  );
  // No identity is displayed: there is nothing to show (the gate has taken over).
  if (value === null) return null;
  return <SharingEnvProvider value={value}>{children}</SharingEnvProvider>;
}

/** Provides the production sharing env unless one is already provided (a test, the fixture, an outer boundary). */
export function SharingBoundary({ children }: { children: ReactNode }) {
  const outer = useContext(SharingEnvContext);
  if (outer !== null) return <>{children}</>;
  return <ProductionSharingEnv>{children}</ProductionSharingEnv>;
}
