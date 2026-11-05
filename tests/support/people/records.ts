import type { DefaultsRecord } from "../../../src/data";

/** Identities and a B5 defaults record for the people tests. */
export const ME = "11111111-1111-4111-8111-111111111111";
export const MO = "22222222-2222-4222-8222-222222222222";
export const HOME = "33333333-3333-4333-8333-333333333333";
export const OTHER_HH = "44444444-4444-4444-8444-444444444444";
export const REVISION = "a".repeat(64);

export function record(
  over: {
    field?: DefaultsRecord["snapshot"]["defaults"]["field"];
    person?: DefaultsRecord["snapshot"]["defaults"]["person"];
    primary?: string | null;
    members?: string[];
  } = {},
): DefaultsRecord {
  const primary = over.primary === undefined ? HOME : over.primary;
  return {
    format: 1,
    epoch: 1,
    fetched_at: 1,
    issued_at: 1,
    snapshot: {
      defaults: {
        revision: REVISION,
        preferences_version: 1,
        primary_household_id: primary,
        person: over.person ?? { kind: "primary_household", edit: true },
        field: over.field ?? { kind: "private" },
        task: { kind: "private" },
        list: { kind: "private" },
        progress: { kind: "primary_household", edit: false },
      },
      households:
        primary === null
          ? []
          : [
              {
                id: HOME,
                name: "Home",
                version: 1,
                role: "manager",
                members: (over.members ?? [ME, MO]).map((id, i) => ({
                  account_id: id,
                  username: `user${i}`,
                  role: "member" as const,
                })),
              },
            ],
    },
  };
}
