export interface SnapshotLink {
  id: string;
  file: string;
  states: string;
  holds: boolean;
}
export const SNAPSHOT_LINKS: ReadonlyArray<{
  id: string;
  file: string;
  states: string;
  holds(code: string): boolean;
}>;
export function snapshotSourceFacts(root?: string): {
  snapshot_requests: true | null;
  links: SnapshotLink[];
};
