import type { ChildProcess, SpawnOptions } from "node:child_process";

export interface OwnedGroups {
  spawn(
    label: string,
    command: string,
    args: string[],
    options?: SpawnOptions,
    extra?: { interruptWith?: NodeJS.Signals },
  ): ChildProcess;
  interrupt(reason?: string): void;
  stopAll(): Promise<{ problems: string[]; notes: string[] }>;
  readonly closed: string | null;
  owned(): Array<{ pgid: number; label: string }>;
}
export function ownedGroups(options?: {
  spawn?: (
    command: string,
    args: string[],
    options: SpawnOptions,
  ) => ChildProcess;
  kill?: (pid: number, signal: NodeJS.Signals | 0) => void;
  sleep?: (ms: number) => Promise<void>;
  schedule?: (fn: () => void, ms: number) => void;
  graceMs?: number;
  killWaitMs?: number;
  pollMs?: number;
  interruptTermMs?: number;
  interruptKillMs?: number;
  /** Told of every owned group as it starts (the runner logs it, so evidence can name each group it owned). */
  onSpawn?: (group: { pgid: number; label: string }) => void;
}): OwnedGroups;
