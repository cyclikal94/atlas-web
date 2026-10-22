export const EVIDENCE_KEY: string;
export const EVIDENCE_OWNER: string;
export const STAGE_OUTPUTS: Record<string, string[]>;
export const STAGES: string[];
export function profileOutFromEnv(
  env?: Record<string, string | undefined>,
): string | null;
export function evidenceArg(
  args: string[],
  root: string,
  usage: string,
): string;
export function recordedStages(dir: string, stages: string[]): string[];
export function refuseRecorded(
  dir: string,
  stages: string[],
  log?: (message: string) => void,
): void;
export function loadSnapshot(): Record<string, unknown>;
export function candidate(root: string): Record<string, unknown>;
export function recordStage(
  dir: string,
  stage: string,
  extra?: Record<string, unknown>,
): Record<string, unknown>;
export function finishStage(
  dir: string,
  stage: string,
  status: number,
): Record<string, unknown>;
/** The terminal result `startLoadSampler`'s `stop()` resolves with (revision 15). */
export interface SamplerStopped {
  exit_code?: number | null;
  samples?: number;
  final_sample?: boolean;
  final_error?: string | null;
  error?: string;
}
export interface StageSampler {
  ready: boolean;
  ready_at?: string;
  pid?: number;
  owner_pid?: number;
  stop(): Promise<SamplerStopped>;
}
/** Why a required sampler's terminal result is not a success, or null (revision 15, review 15 R15-S1). */
export function samplerTerminalProblem(stopped: unknown): string | null;
/** Runs and seals one stage; resolves with the reduced action and sampler status (revision 15). */
export function runStage(
  dir: string,
  stage: string,
  action: () => Promise<number | null | undefined> | number | null | undefined,
  options: {
    sample:
      | ((
          dir: string,
          stage: string,
          context: unknown,
        ) => Promise<StageSampler | null>)
      | null;
    invocation: string;
    context?: unknown;
    extra?: Record<string, unknown>;
  },
): Promise<number>;
export const CONSUMER_KEYS: string[];
export const DEVICE_KEYS: string[];
export const CONSUMER_STATUSES: string[];
export const ENGINES: string[];
export const PROGRAMME_STAGES: string[];
export const REQUIRED_CASES: Record<string, string[]>;
export const REQUIRED_COLD_RUNS: number;
export const COLD_RUN_WORKLOADS: string[];
export const COLLECTION_LOG: string;
