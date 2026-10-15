export interface Stack {
  name: string;
  suffix: string;
  files?: string[];
  grep?: string;
  grepInvert?: string;
  args?: string[];
  oidc: boolean;
  deliberateThrottle?: boolean;
  passthrough?: string[];
}
export interface SkipContext {
  env: Record<string, string | undefined>;
  oidc: boolean;
  app: string;
}
export const DEFAULT_STACKS: Stack[];
export const SEPARATE: Array<{
  name: string;
  files: string[];
  obligation: string;
}>;
export const DESIGNED_SKIPS: Array<{
  file: string;
  description?: string;
  prefix?: string;
  when: (context: SkipContext) => boolean;
}>;
export function stackArgs(stack: Stack): string[];
export function planStacks(options: {
  grep: string;
  passthrough: string[];
  oidc: boolean;
  postgres: boolean;
  only?: string[];
}): {
  narrowed: boolean;
  partial: boolean;
  manifest?: Stack[];
  stacks: Stack[];
};
export function reportCases(
  report: unknown,
): Array<{ key: string; project: string; file: string; test: unknown }>;
export function assignCases(options: {
  all: string[];
  stacks: Array<{ name: string; keys: string[] }>;
  separate: Array<{ name: string; keys: string[] }>;
  browsers: string[];
}): { ok: boolean; problems: string[] };
export function designedSkip(
  file: string,
  test: unknown,
  context: SkipContext,
): string | null;
export interface Counts {
  passed: number;
  designed_skips: number;
  failed: number;
  interrupted: number;
  /** In the report, but never executed and not a designed skip. */
  not_run: number;
  /** Planned, but the evidence does not show what happened to it (no, unreadable, malformed or contradictory result). */
  unproven: number;
  /** Planned, but its stack was never started (or ended before Playwright started). */
  not_launched: number;
}
export function emptyCounts(): Counts;
export function reportShapeProblems(parsed: unknown): string[];
export interface Judged {
  verdict: "passed" | "failed" | "incomplete";
  reasons: string[];
  counts: Counts;
  designed_skips: Array<{ key: string; reason: string }>;
}
export function judgeStack(options: {
  planned: Map<string, number>;
  report: string | null;
  exitCode: number | null;
  startedAt: number;
  finishedAt?: number;
  project: string;
  context: SkipContext;
  refusals?: Array<{ method: string; path: string; at: number }>;
  deliberateThrottle?: boolean;
}): Judged;
export function throttleRecord(
  exchanges: Array<{
    method: string;
    path: string;
    status: number;
    at: number;
  }>,
): {
  requests: number;
  sign_in_class_posts: number;
  sign_in_class_peak_60s: number;
  refusals_429: Array<{ method: string; path: string; at: number }>;
};
