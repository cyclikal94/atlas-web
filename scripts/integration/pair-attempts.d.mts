export const CORRELATION_HEADER: string;
export function outcomeOf(
  entry: { events: Array<{ event: string }> } | undefined,
): string;
interface Correlated {
  seq: number;
  proxy_id?: number | null;
  status: number | null;
}
export function pickHeld<R extends Correlated>(
  heldIds: number[],
  records: R[],
): { proxyId: number; record: R } | null;
interface ModelLike {
  stage: { revision: number; next_index: number } | null;
  activated: number | null;
  restarted: number;
  pages?: number;
}
export function effectOf(before: ModelLike, after: ModelLike): string;
export interface Attempt {
  step: number | null;
  seq: number;
  proxy_id: number | null;
  request_cursor: string | null;
  segment: { index: number; last: boolean } | null;
  revision: number | null;
  sha256: string | null;
  /** The server's answer to the workload (pair-driver.mjs roleOf) and where the drive was (revision 25). */
  role: string | null;
  phase: string | null;
  client: "received" | "lost" | "dropped" | null;
  downstream: string | null;
  effect: string | null;
}
export interface Persisted {
  applied_seq: number;
  observed_at_seq: number;
  next_index: number | null;
}
export function createLedger(): {
  attempts: Attempt[];
  persisted: Persisted[];
  open(a: {
    step: number;
    record: {
      seq: number;
      query?: { cursor: string | null };
      segment?: { index: number; last: boolean } | null;
      revision?: number | null;
      sha256?: string;
    };
    proxyId: number;
    role?: string | null;
    phase?: string | null;
  }): Attempt;
  observe(o: {
    atSeq: number;
    stage: { next_index: number } | null;
  }): Persisted | null;
  settle(
    attempt: Attempt,
    s: { reached: boolean; downstream: string; effect: string },
  ): Attempt;
  unheld(
    record: {
      seq: number;
      dropped?: string;
      proxy_id?: number | null;
      query?: { cursor: string | null };
    },
    downstream: string,
    view?: { role?: string | null; phase?: string | null },
  ): Attempt;
  received(): Attempt[];
};
export function seenOf(r: unknown): {
  status: number | null;
  batches: number | null;
  revision: number | null;
  last_revision: number | null;
  segment: { index: number; last: boolean } | null;
  has_more: boolean | null;
  next_cursor: string | null;
};
export function reachedClient(r: unknown): boolean;
export function activates(r: unknown, revision: number | null): boolean;
export function terminalOf(
  requests: unknown[],
  revision: number | null,
): { final_seq: number; activated_by_seq: number } | null;
export function segmentedProblems(
  answers: Array<{
    seq: number;
    status: number | null;
    query?: { max_changes: string | null };
    changes?: number | null;
    revision?: number | null;
    segment?: { index: number; last: boolean } | null;
  }>,
  m: number,
  revision?: number | null,
): string[];
