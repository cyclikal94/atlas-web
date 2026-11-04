// Revision 27 (R27-DIAG.a): the causal journal of one diagnostic attempt (causal-journal.mjs).
export const JOURNAL_SCHEMA: string;
export const CLOCK: string;
export const PRODUCERS: Readonly<Record<string, string[]>>;
export interface JournalEvent {
  schema: string;
  attempt: string;
  j: number;
  producer: string;
  kind: string;
  ref: Record<string, unknown>;
  at: number;
  clock: string;
}
export interface Journal {
  attempt: string;
  record(producer: string, kind: string, ref?: Record<string, unknown>): number;
  state(): {
    events: number;
    complete: boolean;
    overflowed: boolean;
    write_errors: Array<{ j: number; error: string }>;
  };
}
export function createJournal(options: {
  attempt: string;
  append?: (line: string) => void;
  now?: () => number;
  maxEvents?: number;
}): Journal;
export function journalProblems(
  bytes: Buffer | string | null | undefined,
  expected: { attempt: string; sha256?: string; events?: number },
): { problems: string[]; events: Map<number, JournalEvent> };
export function bindingProblem(
  events: Map<number, JournalEvent>,
  j: unknown,
  producer: string,
  kind: string,
  match: Record<string, unknown> | undefined,
  what: string,
): string | null;
export function before(a: unknown, b: unknown): boolean;
