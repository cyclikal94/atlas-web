export const EFFECTS_METHOD: "cache-rows/1";
export interface RecordedEffects {
  method: typeof EFFECTS_METHOD;
  rows: number;
  entries_sha256: string;
}
export function entriesOfRows(rows: unknown): {
  entries: string[] | null;
  problem: string | null;
};
export function entriesOfPage(text: string): {
  entries: string[] | null;
  problem: string | null;
};
export function effectsText(entries: string[]): string;
export function effectsProblems(
  effects: unknown,
  expected: { rows: number; entries_sha256: string } | null,
): string[];
