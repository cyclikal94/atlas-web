export const COLD_METHOD: "engine-state-log/2";
export const LIVE_METHOD: "live-dense-commit/3";
export const REFUSED_STATES: readonly string[];
export const STEP_EVENTS: readonly string[];
export const LIVE_DENSITY: number;
export function sameValue(a: unknown, b: unknown): boolean;
export function tracePayload(line: unknown): Record<string, unknown> | null;
export function traceEvent(line: unknown): string | null;
export function commitsOfTrace(lines: string[]): Record<string, unknown>[];
export function verdictOfState(state: unknown): {
  verdict: "admitted" | "refused" | null;
  problem: string | null;
};
export function coldObservationRules(
  observation: unknown,
  context: { servedBytes: number | null; requests: number | null },
): {
  shows: "admitted" | "refused" | null;
  problems: string[];
  first: Record<string, unknown> | null;
};
export interface LivePublication {
  index: number;
  generation: number;
  at: number;
  trace: number;
  state: { kind: string; [key: string]: unknown };
}
export interface LiveStepEvent {
  trace: number;
  event: string;
  payload: Record<string, unknown> | null;
  line: string;
}
export function liveTerminalRelation(
  published: LivePublication[],
  events: LiveStepEvent[],
  dense: LiveStepEvent | null,
): {
  end: LiveStepEvent | null;
  terminal: LivePublication | null;
  shows: "admitted" | "refused" | null;
  problem: string | null;
};
export function liveObservationRules(
  observation: unknown,
  context: {
    capturedBytes: number | null;
    traceLines: string[] | null;
    tracePage: string | null;
  },
): { shows: "admitted" | "refused" | null; problems: string[] };
export function deviceRunOutcomeProblems(
  run: Record<string, unknown>,
): string[];
