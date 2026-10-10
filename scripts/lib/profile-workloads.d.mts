export const WORKLOAD_VERSION: number;
export const W5_LIMITS: readonly number[];
export const uuid: (n: number) => string;
export function pageBody(
  batches: unknown[][],
  nextCursor: string,
  hasMore?: boolean,
  phase?: "delta" | "snapshot",
): string;
export function checklistValue(
  seed: number,
  items?: number,
  checked?: number,
): {
  kind: "checklist";
  items: Array<{ id: string; label: string }>;
  checked: string[];
};
export const w1: () => string;
export const denseChecklistPage: (changes: number, items?: number) => string;
export const ordinaryPage: (changes: number, round?: number) => string;
export function textOf(n: number, seed: number): string;
export const w3: () => string;
export const w4: () => string;
export const w5: (limit: number) => string;
export const w6: () => string;
export const w7: () => Record<
  | "truncated"
  | "deep_value"
  | "unknown_field"
  | "bad_kind"
  | "raw_control_char"
  | "oversize_change",
  string
>;
export const VALID: Record<"W1" | "W3" | "W4" | "W6", () => string>;
export function sha256Hex(text: string): Promise<string>;
export function countNodes(value: unknown): number;
export function allWorkloads(): Array<{ name: string; body: string }>;
