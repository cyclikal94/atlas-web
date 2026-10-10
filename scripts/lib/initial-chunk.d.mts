export const FORBIDDEN: ReadonlyArray<{
  why: string;
  patterns: readonly string[];
}>;
export function initialScripts(html: string): string[];
export function checkInitialChunk(root: string): string[];
