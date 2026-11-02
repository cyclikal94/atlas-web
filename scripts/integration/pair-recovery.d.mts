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
    /** Revision 30 (C3): receives the first failure's reason and the failing capture's facts before the observer throws. */
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
