export interface Mutant {
  id: string;
}
export function catalogueProblems(
  catalogue: readonly Mutant[],
  expected: number,
  name?: string,
): string[];
export function selectionProblems(
  catalogue: readonly Mutant[],
  only: readonly string[],
): string[];
export function completionProblems(run: {
  catalogue: readonly Mutant[];
  expected: number;
  only: readonly string[];
  ran: readonly string[];
  unapplied: readonly string[];
}): string[];
