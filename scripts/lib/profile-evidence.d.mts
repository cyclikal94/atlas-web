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
export const CONSUMER_KEYS: string[];
export const DEVICE_KEYS: string[];
export const CONSUMER_STATUSES: string[];
export const ENGINES: string[];
export const PROGRAMME_STAGES: string[];
export const REQUIRED_CASES: Record<string, string[]>;
export const REQUIRED_COLD_RUNS: number;
export const COLD_RUN_WORKLOADS: string[];
export const COLLECTION_LOG: string;
