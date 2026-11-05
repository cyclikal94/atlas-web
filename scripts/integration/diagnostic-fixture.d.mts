// Revision 26 (R26-DIAG): the parts of diagnostic-fixture.mjs the spec uses.
export const RETENTION_SECONDS: number;
export const SPEC_OPERATIONS: readonly string[];
export interface ContinuationHeader {
  boundary: number;
  expiry: number;
  revision: number;
  index: number;
}
export function continuationOf(
  token: string | null | undefined,
): ContinuationHeader | null;
export function controlCall(
  at: { socketPath: string; token: string },
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: Record<string, unknown> }>;
