export const SYNC_WITNESS_METHOD: "sync-request-sample/4";
export const DRAFT_WITNESS_METHOD: "draft-request-sample/6";
export const P2_SAMPLE_METHOD: "p2-sample/4";
export const SYNC_PATH: "/api/experimental/v1/sync";
export const COMMANDS_PATH: "/api/experimental/v1/commands";
export const TRACE_ROUNDING_MS: number;
export const RESOURCE_BUFFER: number;
export const RAW_CLOCK_ALLOWANCE_MS: number;

export interface RequestEntry {
  name: string;
  startTime: number;
  requestStart: number;
  responseEnd: number;
}

export interface WitnessSelection<S, V> {
  status: "complete" | "pending" | "invalid";
  problem: string | null;
  selected: S | null;
  values: V | null;
}

export interface SyncSelected {
  start: number;
  commit: number;
  end: number;
  request: number;
}
export interface SyncValues {
  pre_issue_ms: number;
  request_ms: number;
  post_response_ms: number;
  total_ms: number;
  duration_ms: number;
}
export interface DraftSelected {
  send: number;
  answer: number;
  request: number;
  /** The sequence numbers of the dispatcher's claim, its request, its receipt call and the receipt's result (revision 14). */
  claim: number;
  issued: number;
  receipt: number;
  received: number;
}
export interface DraftValues {
  enqueue_ms: number;
  claim_ms: number;
  stamping_ms: number;
  request_ms: number;
  record_ms: number;
  total_ms: number;
}

export function syncWitnessSelection(
  witness: unknown,
): WitnessSelection<SyncSelected, SyncValues>;
export interface BufferSnapshot {
  /** The whole ResourceTiming buffer's entry count at the read. */
  total: number;
  /** The endpoint's entries the same read retained or counted. */
  retained: number;
}
export function bufferLifetimeProblem(
  earlier: BufferSnapshot,
  later: BufferSnapshot,
): string | null;
export function draftBindingChange(
  before: unknown,
  after: unknown,
  where: string,
): string | null;
export function draftWitnessSelection(
  witness: unknown,
): WitnessSelection<DraftSelected, DraftValues>;

/** A P-2 mark (`from`) or read (`to`): one page lifetime and engine start, a trace position and the page time (revision 18). */
export interface P2Frame {
  page: string;
  time_origin: number;
  /** Engine starts recorded on the page (`engineEpochs.length`). */
  epochs: number;
  /** The current engine start's generation. */
  generation: number;
  at: number;
}
export type P2MarkFrame = P2Frame & { from: number };
export type P2ReadFrame = P2Frame & { to: number };
export interface P2Selected {
  commit: number;
  end: number;
}
export interface P2Values {
  scan_ms: number;
  commit_ms: number;
}
export function p2IterationSelection(
  witness: unknown,
  bytes: number,
): WitnessSelection<P2Selected, P2Values>;
export function p2SequenceProblem(
  previous: unknown,
  mark: unknown,
): string | null;
