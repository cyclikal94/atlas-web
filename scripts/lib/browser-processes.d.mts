export interface ProcessRow {
  pid: number;
  ppid: number;
  rss_kib: number;
  start: string;
  command: string;
}
export interface Inventory {
  rss_kib: number;
  processes: Array<{
    pid: number;
    start: string;
    rss_kib: number;
    role: string;
  }>;
  webkit_hosts: number;
  scope: string;
  complete: boolean;
  errors: string[];
}
export const WEBKIT_HOST: RegExp;
export const WEBKIT_XPC: RegExp;
export const SCOPE_DESCENDANTS: string;
export const SCOPE_WITH_LAUNCHD: string;
export function parsePs(text: string): ProcessRow[];
export function parseLaunchdServices(
  text: string,
): Array<{ pid: number; label: string }> | null;
export function browserInventory(
  rows: ProcessRow[],
  rootPid: number,
  options: {
    servicesOf: (pid: number) => {
      ok: boolean;
      services?: Array<{ pid: number; label: string }>;
      error?: string;
    };
  },
): Inventory;
export function launchdServices(pid: number): {
  ok: boolean;
  services?: Array<{ pid: number; label: string }>;
  error?: string;
};
export function sampleBrowserMemory(rootPid?: number): Inventory;
export function sampleBrowserMemoryAsync(rootPid?: number): Promise<Inventory>;
