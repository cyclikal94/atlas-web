import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { useDataEnv } from "../../data";
import { useApiCompatibility, useIdentity, useSession } from "../../session";
import { createTasksApi, type TasksApi } from "./api";
import { registerTaskCommands } from "./register";

/**
 * What the task screens need besides the data layer (the SharingEnv pattern): the online client for the DISPLAYED `(account, epoch)`, whose
 * account it is, the identity key that page memory is kept for, connectivity, whether writes are allowed (the B2 rule: only while the
 * server's contract is `supported`), the clock and id sources, and the `/daily` page size (the fixture may lower it for TASK-7).
 *
 * Keyed by the identity: another account or epoch builds another client, so nothing read under one identity is shown under another.
 */
export interface TasksEnv {
  api: TasksApi;
  accountId: string;
  /** `account:epoch`. */
  identity: string;
  online: boolean;
  writable: boolean;
  now(): number;
  newId(): string;
  dailyPageSize: number;
}

const TasksEnvContext = createContext<TasksEnv | null>(null);

export function TasksEnvProvider({
  value,
  children,
}: {
  value: TasksEnv;
  children: ReactNode;
}) {
  return (
    <TasksEnvContext.Provider value={value}>
      {children}
    </TasksEnvContext.Provider>
  );
}

export function useTasksEnv(): TasksEnv {
  const env = useContext(TasksEnvContext);
  if (env === null)
    throw new Error("useTasksEnv must be used inside a TasksBoundary");
  return env;
}

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

/** FIXTURE ONLY reads it: a smaller `/daily` page so a test can make a read take several pages (TASK-7). Production never sets it. */
function dailyPageSize(): number {
  const raw =
    typeof window === "undefined"
      ? undefined
      : (window as unknown as { __atlasTasksDailyPageSize?: unknown })
          .__atlasTasksDailyPageSize;
  return typeof raw === "number" &&
    Number.isSafeInteger(raw) &&
    raw >= 1 &&
    raw <= 200
    ? raw
    : 200;
}

function ProductionTasksEnv({ children }: { children: ReactNode }) {
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
        : createTasksApi(session, account, epoch),
    [session, account, epoch],
  );
  const value = useMemo<TasksEnv | null>(
    () =>
      api === null || account === null
        ? null
        : {
            api,
            accountId: account,
            identity: `${account}:${epoch}`,
            online,
            writable: compat.status === "supported",
            now: () => Date.now(),
            newId: () => crypto.randomUUID(),
            dailyPageSize: dailyPageSize(),
          },
    [api, account, epoch, online, compat.status],
  );
  if (value === null) return null;
  return <TasksEnvProvider value={value}>{children}</TasksEnvProvider>;
}

/** Provides the production env unless one is already provided (a test, the fixture, an outer boundary). */
export function TasksBoundary({ children }: { children: ReactNode }) {
  const outer = useContext(TasksEnvContext);
  // Idempotent per registry: a test's or the fixture's own registry gets the task kinds too.
  registerTaskCommands(useDataEnv().commands);
  if (outer !== null) return <>{children}</>;
  return <ProductionTasksEnv>{children}</ProductionTasksEnv>;
}
