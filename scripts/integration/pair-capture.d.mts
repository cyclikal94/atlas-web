// Revision 30 (R30-DIAG, C1): the capture contract of one recovery sample (pair-capture.mjs).
export const AUTH_BRACKETS: readonly ["stable", "changed", "unavailable"];
export const STORAGE_BRACKETS: readonly [
  "stable",
  "changed",
  "replaced",
  "unavailable",
];
export const STAMP_FIELDS: readonly string[];
/** Revision 31 (R31-DIAG, C3): the fields of the second coherent stored transaction a sample retains as `stored_after`. */
export const ENDPOINT_FIELDS: readonly string[];
export type AuthBracket =
  | { status: "stable" }
  | { status: "changed"; reason: string }
  | { status: "unavailable"; error: string };
export type StorageBracket =
  | { status: "stable" }
  | {
      status: "changed";
      fields: string[];
      before: Record<string, unknown>;
      after: Record<string, unknown>;
    }
  | { status: "replaced"; reason: string; incarnation_after: string | null }
  | { status: "unavailable"; reason: string };
export function captureInPage(who: string): Promise<unknown>;
export function renderingOf(
  page: { evaluate(fn: unknown, arg: unknown): Promise<unknown> },
  account: string,
): Promise<{
  rendering: unknown;
  notice: unknown;
  fenced: boolean | null;
  auth: AuthBracket;
}>;
export function storageBracket(
  before: Record<string, unknown>,
  after: Record<string, unknown> | null,
  error?: string | null,
): StorageBracket;
export function recoverySample<S extends object>(
  io: {
    stored(rows: boolean, local: string[] | null): Promise<S | null>;
    rendering(): Promise<{
      rendering: unknown;
      notice: unknown;
      fenced: boolean | null;
      auth: AuthBracket;
    }>;
  },
  o: {
    reader: "leader" | "follower";
    page: string;
    account: string;
    rows?: boolean;
    local?: string[] | null;
  },
): Promise<
  S & {
    reader: "leader" | "follower";
    page: string;
    account: string;
    rendering: unknown;
    notice: unknown;
    fenced: boolean | null;
    /** Revision 31 (C3): the second stored transaction's `ENDPOINT_FIELDS`; null when that read failed or found no database. */
    stored_after: Record<string, unknown> | null;
    capture: { auth: AuthBracket | null; storage: StorageBracket };
  }
>;
