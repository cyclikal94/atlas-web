export const W2_SEED: Readonly<{
  fields: number;
  items: number;
  checked: number;
  item_label: string;
  changes: number;
}>;
export const RESOURCE_KINDS: readonly string[];
export const PROJECTION_REQUIRED: readonly string[];
export interface W2Observation {
  problems: string[];
  page: {
    phase: unknown;
    has_more: unknown;
    batches: number;
    changes: number;
    revisions: unknown[];
  } | null;
  target: {
    index: number;
    revision: number;
    person: string;
    fields: number;
    field_ids: string[];
    value_bytes: number | null;
    digest: string;
  } | null;
}
export function changeProblem(change: unknown): string | null;
export function denseChecklistProblem(value: unknown): string | null;
export function observeW2Capture(
  bytes: Uint8Array,
  options: { person: unknown; limit: number },
): W2Observation;
export function sameTargetProblems(
  a: W2Observation,
  b: W2Observation,
): string[];
