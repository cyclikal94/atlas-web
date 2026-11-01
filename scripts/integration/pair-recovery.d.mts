// Revision 27 (R27-DIAG.b): the recovery observer (pair-recovery.mjs).
export interface RecoveryReader {
  reader: "leader" | "follower";
  page: string;
  cache_status: string | null;
  cursor: string | null;
  phase: string | null;
  delta_stage: unknown | null;
  staged: number;
  staging_rows: number;
  staging_generations: number[];
  recovery_generation: number | null;
  cache_digest: string;
  applied_revision: number | null;
  gate: string | null;
  view: string | null;
  notice: { reason?: string } | null;
  fenced: boolean;
  rows?: unknown[];
  [key: string]: unknown;
}
export function isHidden(r: RecoveryReader): boolean;
export function invalidatedProblems(
  r: RecoveryReader,
  o: { caller: string; oldDigest: string; refusalGeneration: number },
): string[];
export function stagedProblems(
  r: RecoveryReader,
  o: {
    caller: string;
    oldDigest: string;
    generation: number;
    rowsAtLeast?: number;
  },
): string[];
export function exposedProblems(
  r: RecoveryReader,
  o: { oldDigest: string },
): string[];
export function observeRecovery(
  io: {
    held(ruleId: string): Promise<number[]>;
    records(): Promise<Array<{ seq: number; proxy_id?: number | null }>>;
    release(
      ruleId: string,
      proxyId: number,
    ): Promise<{
      released: number;
      outcomes?: Array<{ outcome: string | null }>;
    }>;
    read(
      reader: "leader" | "follower",
      o?: { rows?: boolean },
    ): Promise<RecoveryReader>;
    recordRelease(r: {
      proxy_id: number;
      outcome: string | null;
      reason: string;
    }): Promise<void> | void;
    observe(
      kind: string,
      atSeq: number,
      cacheDigest: string,
      detail: Record<string, unknown>,
    ): Promise<void> | void;
    onPage?(
      kind: string,
      record: Record<string, unknown>,
      leader: RecoveryReader,
    ): Promise<void> | void;
    now(): number;
    sleep(ms: number): Promise<void>;
  },
  o: {
    ruleId: string;
    caller: "ordinary" | "recovery";
    refusal: { seq: number; generation: number };
    oldDigest: string;
    expectFinal(rows: unknown[]): string[];
    maxPages?: number;
    heldTimeoutMs?: number;
    settleTimeoutMs?: number;
  },
): Promise<{ pages: number[]; final: RecoveryReader }>;
