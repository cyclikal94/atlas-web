// Revision 27 (R27-DIAG.b): the recovery observer (pair-recovery.mjs). Revision 28 (R28-DIAG.b): a separate rendering observation.
/** One page's rendering, read in one evaluation of its own document; `unavailable` is incomplete evidence, never hidden. */
export type RecoveryRendering =
  | {
      status: "observed";
      /** A per-document identity (a reload or a replaced page is another document). */
      document: string;
      /** The page's data attachment: "leader" | "follower" | "none". */
      attachment: string | null;
      /** The session's own view: its real discriminant (booting, incompatible, signed_out, neutral, displaying). */
      view: {
        kind: string;
        account_id?: string | null;
        state?: string | null;
      } | null;
      /** #protected-root: gated = inert AND aria-hidden="true"; mounted = it has children. */
      root: { present: boolean; gated: boolean; mounted: boolean };
      /** The cache gate's placeholders inside the root: all present, and those visible. */
      placeholders: { present: number; refreshing_visible: number };
    }
  | { status: "unavailable"; error: string };
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
  /** The account the read asked for (its database). */
  account: string;
  rendering: RecoveryRendering;
  notice: { reason?: string } | null;
  /** The account's auth fences; null when they could not be read (incomplete). */
  fenced: boolean | null;
  rows?: unknown[];
  [key: string]: unknown;
}
export const OBSERVATION_SCHEMA: string;
export const RECOVERY_VIEW_KINDS: readonly string[];
export function observationProblems(
  r: RecoveryReader,
  o: { account: string },
): string[];
export function surfaceOf(
  g: Extract<RecoveryRendering, { status: "observed" }>,
): string;
export function hiddenProblems(
  r: RecoveryReader,
  o: { caller: string; what: string },
): string[];
export function shownProblems(r: RecoveryReader): string[];
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
export function activatedProblems(
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
    account: string;
    refusal: { seq: number; generation: number };
    oldDigest: string;
    expectFinal(rows: unknown[]): string[];
    maxPages?: number;
    heldTimeoutMs?: number;
    settleTimeoutMs?: number;
  },
): Promise<{
  pages: number[];
  final: RecoveryReader;
  rendered: { leader: RecoveryReader; follower: RecoveryReader };
}>;
