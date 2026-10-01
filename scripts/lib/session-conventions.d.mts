export interface Diagnostic {
  rule: string;
  path: string;
  line: number;
  message: string;
}
export interface FoundFunction {
  name: string;
  start: number;
  bodyOpen: number;
  bodyClose: number;
  line: number;
}
export function mask(text: string): string;
export function functionsIn(masked: string): FoundFunction[];
export function firstStatements(body: string, count?: number): string[];
export function checkR7(path: string, source: string): Diagnostic[];
export function checkR8(path: string, source: string): Diagnostic[];
export function checkR9(path: string, source: string): Diagnostic[];
export function checkR10(path: string, source: string): Diagnostic[];
export function checkR11(path: string, source: string): Diagnostic[];
export function checkR12(path: string, source: string): Diagnostic[];
export function checkActivityConstruction(
  path: string,
  source: string,
): Diagnostic[];
export const REQUIRED: ReadonlyArray<{
  rule: string;
  file: string;
  names: string[];
}>;
export const SCOPES: ReadonlyArray<{
  rule: string;
  check: (path: string, source: string) => Diagnostic[];
  files: string[];
}>;
export function checkTree(root: string): Diagnostic[];
export function format(diagnostic: Diagnostic): string;
