export type PairBackend = "development" | "released";
export interface PairCase {
  id: string;
  backends: PairBackend[];
  workload: "W-real" | "W-synthetic" | null;
  m: number | null;
  caller: "none" | "ordinary" | "recovery";
  injected: string | null;
}
export interface PairUnrun {
  id: string;
  kind: "capability" | "transferred";
  what: string;
  reason: string;
  owner: string;
}
export const SPEC: string;
export const BACKENDS: PairBackend[];
export const BROWSERS: string[];
export const CASES: readonly PairCase[];
export const UNSUPPORTED: readonly PairUnrun[];
export function accountNames(): string[];
export function titleId(title: string): string | null;
export function applicable(row: PairCase, backend: string): boolean;
export function designedSkipReason(backend: string): string;
export function discoveryProblems(
  report: unknown,
  options: { browsers: string[]; cases?: readonly PairCase[] },
): string[];
export function judgeResults(
  report: unknown,
  options: {
    browser: string;
    backend: string;
    cases?: readonly PairCase[];
    unsupported?: readonly PairUnrun[];
  },
): {
  complete: boolean;
  counts: {
    passed: number;
    designed_skip: number;
    failed: number;
    interrupted: number;
    unrun: number;
  };
  outcomes: Record<
    string,
    "passed" | "designed_skip" | "failed" | "interrupted" | "unrun"
  >;
  problems: string[];
  unsupported: Array<PairUnrun & { outcome: "unrun" }>;
};
