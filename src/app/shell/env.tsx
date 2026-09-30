import { createContext, type ReactNode, useContext } from "react";
import type { ChipDestination, SyncStatusModel } from "../../lib/sync-chip";

/**
 * What the shell needs from the rest of the application. WEB-09 supplies the sync model, WEB-08 the account
 * slots and WEB-12 the workspace slot. The fixture entry supplies fixed values; production never mounts the shell.
 */
/**
 * A slot is content, or a function of the rail state. On the tablet icon rail (64px) a slot has room for one 44px control, so a
 * function slot receives `collapsed` and returns a compact form (an avatar, an icon) with its own accessible name.
 */
export type ShellSlot =
  | ReactNode
  | ((state: { collapsed: boolean }) => ReactNode);

export interface ShellEnv {
  syncModel: SyncStatusModel;
  onOpenSync(destination: ChipDestination): void;
  workspaceSlot?: ShellSlot;
  accountSlot?: ShellSlot;
}

export function renderSlot(
  slot: ShellSlot | undefined,
  collapsed: boolean,
): ReactNode {
  return typeof slot === "function" ? slot({ collapsed }) : slot;
}

const ShellEnvContext = createContext<ShellEnv | null>(null);

export function ShellEnvProvider({
  value,
  children,
}: {
  value: ShellEnv;
  children: ReactNode;
}) {
  return (
    <ShellEnvContext.Provider value={value}>
      {children}
    </ShellEnvContext.Provider>
  );
}

export function useShellEnv(): ShellEnv {
  const value = useContext(ShellEnvContext);
  if (!value)
    throw new Error("useShellEnv must be used inside ShellEnvProvider");
  return value;
}
