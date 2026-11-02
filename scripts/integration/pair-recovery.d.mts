// Revision 27 (R27-DIAG.b): the recovery observer (pair-recovery.mjs). Revision 28 (R28-DIAG.b): a separate rendering observation.
import type { AuthBracket, StorageBracket } from "./pair-capture.mjs";
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
  /** The account's auth fences in force throughout the capture; null unless the auth bracket is stable. */
  fenced: boolean | null;
  /** Revision 30 (R30-DIAG, C1): the database lifetime the sample read (`sync_state.incarnation_id`). */
  incarnation?: string | null;
  /** Revision 30 (C1): the separate capture brackets (pair-capture.mjs); only a sample with both stable is usable. */
  capture?: { auth: AuthBracket | null; storage: StorageBracket };
  /** Revision 30 (C3): the unresolved captures of this read re-read before this one, by cause. */
  rereads?: { total: number; auth: number; storage: number };
  /** Revision 31 (R31-DIAG, C3): the capture's SECOND coherent stored transaction (pair-capture.mjs `ENDPOINT_FIELDS`). */
  stored_after?: Record<string, unknown> | null;
  /** Revision 31: the read number of the capture the observer returned. */
  read?: number;
  rows?: unknown[];
  [key: string]: unknown;
}
export const OBSERVATION_SCHEMA: string;
export const MAX_UNRESOLVED_REREADS: number;
export const RECOVERY_VIEW_KINDS: readonly string[];
export function renderingProblems(
  r: RecoveryReader,
  o: { account: string },
): string[];
export function captureProblems(r: RecoveryReader): string[];
export function resolved(r: RecoveryReader): boolean;
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
// Revision 29 (R29-DIAG): per-page, per-sample fence/render admissibility.
export const ADMISSIBILITY_PHASES: readonly [
  "before_activation",
  "activation",
  "after_activation",
];
export function holdsComplete(r: RecoveryReader): boolean;
export function admissibilityProblems(
  r: RecoveryReader,
  o: {
    caller: string;
    phase: "before_activation" | "activation" | "after_activation";
    what: string;
  },
): string[];
export function interpretations(
  r: RecoveryReader,
  phase: "before_activation" | "activation" | "after_activation",
): Array<{
  fenced: boolean | null;
  phase: "before_activation" | "after_activation" | "activation";
}>;
export function establishedProblems(
  r: RecoveryReader,
  o: {
    caller: string;
    phase: "before_activation" | "activation" | "after_activation";
    what: string;
  },
): string[];
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
// Revision 31 (R31-DIAG; design assessment C1/C2): the stored-data predicates on ONE coherent transaction and an explicit context.
/** One coherent stored transaction: a sample's own stored fields, or its `stored_after`. */
export type StoredEndpoint = Record<string, unknown>;
export const STORED_BARRIERS: readonly [
  "invalidated",
  "staged",
  "activation",
  "activated",
];
export function storedInvalidatedProblems(
  s: StoredEndpoint,
  o: {
    who: string;
    caller: string;
    oldDigest: string;
    refusalGeneration: number;
    generation?: number | null;
  },
): string[];
export function invalidatedRenderingProblems(
  r: RecoveryReader,
  o: { caller: string },
): string[];
export function storedStagedProblems(
  s: StoredEndpoint,
  o: {
    who: string;
    oldDigest: string;
    generation: number;
    rowsAtLeast?: number;
  },
): string[];
export function stagedRenderingProblems(
  r: RecoveryReader,
  o: { caller: string },
): string[];
export function storedActivatedProblems(
  s: StoredEndpoint,
  o: {
    who: string;
    oldDigest: string;
    digest?: string | null;
    mismatch?: string | null;
  },
): string[];
export function activationProblems(
  s: StoredEndpoint,
  o: {
    who: string;
    oldDigest: string;
    generation: number;
    rowsAtLeast: number;
    witness?: string | null;
  },
): string[];
/** The stored problems of one transaction at a read context (`ctx.barrier` one of STORED_BARRIERS, with its expectations). */
export function storedProblemsAt(
  s: StoredEndpoint,
  ctx: Record<string, unknown>,
  o: { who: string; rowsAtLeast?: number; witness?: string | null },
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
    /**
     * Revision 30 (C3): receives the first failure's reason and the failing capture's facts before the observer throws. Revision 31 (C5):
     * every failure has facts (reader, barrier, held_seq, phase, read, rereads, predicate, endpoint, expected, both brackets, fence,
     * notice, document, incarnation, both stored transactions and, for the oracle, the rows' count/hash/problems).
     */
    failed?(f: { reason: string; capture: unknown }): void;
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
