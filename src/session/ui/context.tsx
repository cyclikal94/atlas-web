import {
  createContext,
  type ReactNode,
  useContext,
  useSyncExternalStore,
} from "react";
import type { Session, SessionNotice, Store } from "../api";
import type { ApiCompatibility, Identity, SessionView } from "../model/view";

/**
 * React bindings for the session (no gate imports). `createSession` and `start()` are called OUTSIDE any component
 * effect, because React StrictMode double-invokes effects (risk R-8); the provider only carries the finished object.
 */
const SessionContext = createContext<Session | null>(null);

export function SessionProvider({
  session,
  children,
}: {
  session: Session;
  children: ReactNode;
}) {
  return (
    <SessionContext.Provider value={session}>
      {children}
    </SessionContext.Provider>
  );
}

export function useSession(): Session {
  const session = useContext(SessionContext);
  if (!session)
    throw new Error("useSession must be used inside SessionProvider");
  return session;
}

function useStore<T>(store: Store<T>): T {
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}

export const useSessionView = (): SessionView => useStore(useSession().view);
export const useIdentity = (): Identity | null =>
  useStore(useSession().identity);
export const useApiCompatibility = (): ApiCompatibility =>
  useStore(useSession().compat);
export const useSessionNotices = (): readonly SessionNotice[] =>
  useStore(useSession().notices);
