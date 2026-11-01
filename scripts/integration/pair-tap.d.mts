export const FAULT_KINDS: string[];
export const INJECTED_410: {
  code: string;
  message: string;
  details: unknown[];
};
export function tamper(cursor: string): string;
export function describeSync(bytes: Buffer): Record<string, unknown>;
export function applyFault(
  fault: { kind: string; value?: string; delta?: number },
  page: unknown,
  previous: Buffer | null,
): unknown;
export function createTap(options: {
  upstream: string;
  port?: number;
  controlPort?: number;
  bodiesDir: string;
  maxRecords?: number;
  now?: () => number;
  clockLabel?: string;
  correlation?: string | null;
  journal?: {
    attempt: string;
    record(producer: string, kind: string, ref?: unknown): number;
  } | null;
}): {
  start(): Promise<{ tapUrl: string; controlUrl: string }>;
  stop(): Promise<{ ok: boolean }>;
  records: Array<Record<string, unknown>>;
  faults: Array<Record<string, unknown>>;
};
