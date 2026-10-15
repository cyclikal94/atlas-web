export const SYNC_WITNESS_METHOD: "sync-request-sample/2";
export const DRAFT_WITNESS_METHOD: "draft-request-sample/2";
export const TRACE_ROUNDING_MS: number;
export const RESOURCE_BUFFER: number;

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
export function draftBindingChange(
  before: unknown,
  after: unknown,
  where: string,
): string | null;
export function draftWitnessSelection(
  witness: unknown,
): WitnessSelection<DraftSelected, DraftValues>;
