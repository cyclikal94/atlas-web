export const SCHEMA: string;
export function validateInterval(
  record: unknown,
  options?: { readBody?: (file: string) => Buffer | Uint8Array },
): string[];
