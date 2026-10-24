export interface Stack {
  name: string;
  suffix: string;
  files?: string[];
  grep?: string;
  grepInvert?: string;
  args?: string[];
  oidc: boolean;
  deliberateThrottle?: boolean;
  /** What the stack's cases change in their own backend (documentation for the isolation argument). */
  mutates?: string;
  passthrough?: string[];
}
export interface SkipContext {
  env: Record<string, string | undefined>;
  oidc: boolean;
  postgres: boolean;
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
export const PLAYWRIGHT_POLICY: string[];
export function passthroughProblems(passthrough: string[]): string[];
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
export const SOURCE_BUDGET: { limit: number; windowMs: number };
export const SOURCE_BUDGET_CONSUMERS: Array<[string, string]>;
export function consumesSourceBudget(method: string, path: string): boolean;
export interface Exchange {
  method: string;
  path: string;
  /** The backend's status; null when the upstream connection failed. */
  status: number | null;
  at: number;
}
export function throttleRecord(exchanges: Exchange[]): {
  requests: number;
  source_budget_requests: number;
  source_budget_by_route: Record<string, number>;
  source_budget_peak_60s: number;
  source_budget_limit: number;
  refusals_429: Array<{ method: string; path: string; at: number }>;
};
