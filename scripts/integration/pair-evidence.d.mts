export const SCHEMA: string;
export function validateInterval(
  record: unknown,
  options?: { readBody?: (file: string) => Buffer | Uint8Array },
): string[];
export function identityProblems(
  record: unknown,
  where: {
    file: string;
    engine: string;
    backend: string;
    manifest: string | null;
    row: { workload: string | null } | undefined;
  },
): string[];
export function joinExchanges<
  R extends { seq: number; proxy_id?: number | null },
>(
  records: R[],
  proxyEntries: Array<{ id: number; events: Array<{ event: string }> }>,
  attempts: Array<{
    seq: number;
    step: number | null;
    client: string | null;
    effect: string | null;
  }>,
): Array<
  R & {
    downstream: { outcome: string; events: string[] | null };
    attempt?: {
      step: number | null;
      client: string | null;
      effect: string | null;
    };
  }
>;
export function overheadOf(
  syncs: unknown[],
  person: string,
  readBody: (file: string) => Buffer | Uint8Array,
): Array<{
  seq: number;
  client: string | null;
  downstream: string | null;
  bytes: number;
  changes: number;
  person_upserts: number;
  removals: number;
  server_ms: number | null;
}>;
export interface IntervalParts {
  id: string;
  caseId: string;
  engine: string;
  barriers: Array<{ name: string; at: number; detail?: unknown }>;
  piecesPersisted: number;
  attempts: unknown[];
  target: {
    revisions: number[];
    through: number | null;
    sources: unknown[];
  } | null;
  handOff: { at_seq: number; reason: string } | null;
  /** Revision 27: the recovery caller's re-armed hold. */
  rearm?: { at_seq: number; reason: string; released_rule: string };
  /** Revision 28: the account the recovery observations are of. */
  readerAccount?: string;
  opening: unknown;
  holdReleases: unknown[];
  observations: unknown[];
  terminal: { final_seq: number; activated_by_seq: number } | null;
  traces: unknown[];
}
export const RECOVERY_KINDS: readonly string[];
export const RECOVERY_OBSERVATION_SCHEMA: string;
export function assembleInterval<
  R extends { seq: number; method: string; path: string },
>(parts: {
  iv: IntervalParts;
  records: R[];
  collection: unknown;
  details: {
    backend: string;
    selection: string;
    apiVersion: string;
    workload: "W-real" | "W-synthetic";
    preGrantCursor: string;
    driven: "full" | "prefix" | "none" | "rearmed_prefix";
    requiredObservations: string[];
    /** Revision 27: the matrix row's caller and local-work declaration (recovery-observed cases only). */
    caller?: "none" | "ordinary" | "recovery";
    localWork?: boolean;
    terminal: "activated" | "recovered";
    appliedRevision: number | null;
    oracle: { verdict: "match" | "mismatch"; problems: string[] };
    person: string;
    injectedOutsideTap?: string;
    extra?: Record<string, unknown>;
  };
  memory: unknown;
  readBody: (file: string) => Buffer | Uint8Array;
}): {
  schema: string;
  requests: R[];
  overhead: Array<{ seq: number; changes: number; person_upserts: number }>;
  [key: string]: unknown;
};
