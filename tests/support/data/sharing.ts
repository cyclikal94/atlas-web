import type {
  DefaultsRecord,
  DefaultTemplate,
  SharingSnapshot,
  SnapshotHousehold,
} from "../../../src/data";

/**
 * Builders of B5 sharing snapshots (`GET /defaults/snapshot`) that satisfy the pinned contract, for the WEB-12a unit and component tests.
 * FIXTURE data: nothing here says what a real server returns (the I-SH integration cases do).
 */
export const ME = "11111111-1111-4111-8111-111111111111";
export const SAM = "22222222-2222-4222-8222-222222222222";
export const PRIYA = "33333333-3333-4333-8333-333333333333";
export const JAMIE = "44444444-4444-4444-8444-444444444444";
export const HOME = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
export const FLAT = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
export const ELSEWHERE = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

export const revision = (n: number): string => n.toString(16).padStart(64, "0");

export function household(
  over: Partial<SnapshotHousehold> & { id: string },
): SnapshotHousehold {
  return {
    name: "Home",
    version: 1,
    role: "manager",
    members: [{ account_id: ME, username: "me", role: "manager" }],
    ...over,
  };
}

export function snapshot(
  over: {
    revision?: string;
    primary?: string | null;
    templates?: Partial<
      Record<"person" | "field" | "task" | "list" | "progress", DefaultTemplate>
    >;
    households?: SnapshotHousehold[];
  } = {},
): SharingSnapshot {
  const primary = over.primary === undefined ? HOME : over.primary;
  return {
    defaults: {
      revision: over.revision ?? revision(1),
      preferences_version: 1,
      primary_household_id: primary,
      person: { kind: "primary_household", edit: true },
      field: { kind: "private" },
      task: { kind: "private" },
      list: { kind: "private" },
      progress: { kind: "primary_household", edit: false },
      ...over.templates,
    },
    households:
      over.households ??
      (primary === null
        ? []
        : [
            household({
              id: primary,
              members: [
                { account_id: ME, username: "me", role: "manager" },
                { account_id: SAM, username: "sam", role: "member" },
              ],
            }),
          ]),
  };
}

export function record(
  snap: SharingSnapshot = snapshot(),
  over: Partial<DefaultsRecord> = {},
): DefaultsRecord {
  return {
    format: 1,
    snapshot: snap,
    fetched_at: 1_000,
    issued_at: 900,
    epoch: 1,
    ...over,
  };
}
