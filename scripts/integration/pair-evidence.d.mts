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
