import type { Exchange, Stack } from "./stacks.mjs";

export const OWNER: string;

export function evidencePaths(
  evidence: string,
  browsers: string[],
  stacks: Stack[],
): string[];
export function playwrightLister(options: {
  root: string;
  browsers: string[];
  dir: string;
  env: Record<string, string | undefined>;
}): (selection: string[], label: string) => Promise<string>;
export interface Launched {
  exitCode: number | null;
  signal?: string | null;
  exchanges?: Exchange[];
}
export function runIntegration(options: {
  options: {
    browsers: string[];
    stacks: Stack[];
    manifest?: Stack[];
    partial?: boolean;
    narrowed: boolean;
    evidence: string;
    env: Record<string, string | undefined>;
    postgres: boolean;
    layer: string;
  };
  deps: {
    list: (selection: string[], label: string) => Promise<string>;
    execute: (stack: Stack, browser: string) => Promise<Launched>;
    cleanup: () => Promise<{ problems: string[]; notes?: string[] }>;
    readReport: (file: string) => string | null;
    exists: (path: string) => boolean;
    /** Creates `file` only if it does not exist (throws otherwise): this invocation's exclusive claim on its evidence directory. */
    claim: (file: string, text: string) => void;
    write: (file: string, text: string) => void;
    now: () => number;
    log: (message: string) => void;
    interrupted: () => string | null;
    backend: () => unknown;
  };
}): Promise<number>;
