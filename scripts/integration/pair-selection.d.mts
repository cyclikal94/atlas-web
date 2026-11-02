export const PAIR_SELECTION: {
  readonly label: string;
  readonly authority: Readonly<Record<string, string>>;
  /** R40-PAIR: the pinned path-reconciliation authority and the pinned records its content must name (each a key of `authority`). */
  readonly reconciliation: {
    readonly authority: string;
    readonly original: string;
    readonly review: string;
  };
  readonly manifest: { readonly path: string; readonly sha256: string };
  readonly backend: {
    readonly checkout: string;
    readonly head: string;
    readonly tree: string;
    readonly executable: string;
    readonly apiVersion: string;
  };
  readonly files: Readonly<Record<string, string>>;
  readonly types: {
    readonly path: string;
    readonly sha256: string;
    readonly version: string;
  };
  readonly platform: { readonly os: string; readonly arch: string };
};
export type PairSelection = typeof PAIR_SELECTION;
export interface SelectionDeps {
  read(path: string): Buffer | Uint8Array | string;
  hashFile(path: string): string;
  git(args: string[]): string;
  platform: string;
  arch: string;
}
export function sha256Of(bytes: Buffer | Uint8Array | string): string;
export function realSelectionDeps(
  run: (
    cmd: string,
    args: string[],
  ) => { status: number | null; stdout: string; stderr: string },
): SelectionDeps;
export function verifySelection(
  deps: SelectionDeps,
  selection?: PairSelection,
): {
  ok: boolean;
  problems: string[];
  record: {
    label: string;
    expected: PairSelection;
    observed: Record<string, unknown>;
  };
};
export function stageExecutable(
  dir: string,
  deps?: {
    copy(from: string, to: string): void;
    chmod(path: string, mode: number): void;
    hashFile(path: string): string;
  },
  selection?: PairSelection,
): { path: string; sha256: string };

/** Revision 26 (R26-DIAG): the approved diagnostic executable's selection. */
export const DIAGNOSTIC_SELECTION: {
  readonly mode: "diagnostic";
  readonly label: string;
  readonly authority: Readonly<Record<string, string>>;
  readonly review: {
    readonly named_path: string;
    readonly preserved_path: string;
    readonly sha256: string;
  };
  readonly recipe: { readonly path: string; readonly sha256: string };
  readonly backend: {
    readonly checkout: string;
    readonly head: string;
    readonly tree: string;
    readonly apiVersion: string;
  };
  readonly executable: {
    readonly path: string;
    readonly name: string;
    readonly sha256: string;
  };
  readonly files: Readonly<Record<string, string>>;
  readonly features: Readonly<Record<string, boolean>>;
  readonly retentionSeconds: number;
  readonly consumer: { readonly task_id: string; readonly worktree: string };
  readonly platform: { readonly os: string; readonly arch: string };
};
export type DiagnosticSelection = typeof DIAGNOSTIC_SELECTION;
export function selectionIdentity(selection?: unknown): string;
export function realDiagnosticDeps(
  run: (
    cmd: string,
    args: string[],
  ) => { status: number | null; stdout: string; stderr: string },
): SelectionDeps;
export function verifyDiagnosticSelection(
  deps: SelectionDeps,
  selection?: DiagnosticSelection,
): {
  ok: boolean;
  problems: string[];
  record: {
    label: string;
    identity: string;
    expected: unknown;
    observed: unknown;
  };
};
export function stageDiagnosticExecutable(
  dir: string,
  deps?: {
    copy(from: string, to: string): void;
    chmod(path: string, mode: number): void;
    hashFile(path: string): string;
  },
  selection?: DiagnosticSelection,
): { path: string; sha256: string };
