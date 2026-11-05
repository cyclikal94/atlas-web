export const CANDIDATE_ROOT: string;
export const PRODUCTION_MODULES: Readonly<{
  scan: string;
  validate: string;
  config: string;
}>;
export const PRODUCTION_INPUTS: readonly string[];
export const PRODUCTION_CONFIG: Readonly<Record<string, unknown>>;
export function productionRefusal(
  bytes: Uint8Array,
  options: { limit: number },
): string | null;
