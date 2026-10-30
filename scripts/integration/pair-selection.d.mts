export const PAIR_SELECTION: {
  readonly label: string;
  readonly authority: Readonly<Record<string, string>>;
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
