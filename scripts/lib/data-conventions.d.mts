export interface Diagnostic {
  rule: string;
  path: string;
  line: number;
  message: string;
}
export function checkR13(path: string, source: string): Diagnostic[];
export function checkR14Imports(path: string, source: string): Diagnostic[];
export function checkR14Read(path: string, source: string): Diagnostic[];
export function checkR15(path: string, source: string): Diagnostic[];
export function checkR16(path: string, source: string): Diagnostic[];
export function checkR17(path: string, source: string): Diagnostic[];
export function checkR18(path: string, source: string): Diagnostic[];
export function readBodies(
  masked: string,
): Array<{ text: string; start: number }>;
export const REQUIRED: ReadonlyArray<{
  rule: string;
  file: string;
  pattern: RegExp;
}>;
export const CHECKS: ReadonlyArray<
  (path: string, source: string) => Diagnostic[]
>;
export function checkTree(root: string): Diagnostic[];
export function format(diagnostic: Diagnostic): string;
