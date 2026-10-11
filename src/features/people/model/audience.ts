import type {
  DefaultsRecord,
  DefaultTemplate,
  Policy,
  SnapshotHousehold,
} from "../../../data";
import type { LinkageState } from "./linkage";

/**
 * Who can see a field, as the people screens SAY it (D-11a-7, D-11a-13). PURE.
 *
 * The quick choices are "Only you" (an explicit empty policy), "Home · can view" (one read grant to the primary household of the B5
 * record) and, for anything else, "Custom" with a short summary; the full editor is WEB-12a's `ResourcePolicyEditor`. A policy is only
 * known from an owner-only `GET /policies/{id}` this page made; nothing here guesses one.
 */
export type AudienceClass =
  | { kind: "only_you" }
  | { kind: "home_view"; householdId: string; excluded: number }
  | { kind: "custom"; summary: string };

export const ONLY_YOU_POLICY = (): Policy => ({
  grants: [],
  exclude_accounts: [],
});

/** A policy is "Only you" when it grants nobody (an exclusion of nobody-granted changes nothing). */
export function classify(
  policy: Policy,
  primaryHouseholdId: string | null,
): AudienceClass {
  if (policy.grants.length === 0) return { kind: "only_you" };
  const [only] = policy.grants;
  if (
    policy.grants.length === 1 &&
    only !== undefined &&
    only.kind === "household" &&
    only.id === primaryHouseholdId &&
    !only.edit
  )
    return {
      kind: "home_view",
      householdId: only.id,
      excluded: policy.exclude_accounts.length,
    };
  return { kind: "custom", summary: customSummary(policy, primaryHouseholdId) };
}

function customSummary(
  policy: Policy,
  primaryHouseholdId: string | null,
): string {
  const households = policy.grants.filter((g) => g.kind === "household");
  const accounts = policy.grants.filter((g) => g.kind === "account");
  if (
    households.length === 1 &&
    accounts.length === 0 &&
    households[0]?.id === primaryHouseholdId
  )
    return households[0]?.edit ? "Home · can edit" : "Home · can view";
  const parts: string[] = [];
  if (households.length > 0)
    parts.push(
      `${households.length} household${households.length === 1 ? "" : "s"}`,
    );
  if (accounts.length > 0)
    parts.push(
      `${accounts.length} ${accounts.length === 1 ? "person" : "people"}`,
    );
  const mixed = new Set(policy.grants.map((g) => g.edit)).size > 1;
  return `${parts.join(", ")}${mixed ? " · mixed" : ""}`;
}

/** The label of a classified audience ("Only you", "Home · can view", "Home · can view · 1 excluded", or the custom summary). */
export function audienceLabel(
  audience: AudienceClass,
  homeName: string | null,
): string {
  switch (audience.kind) {
    case "only_you":
      return "Only you";
    case "home_view": {
      const base = `${homeName ?? "Home"} · can view`;
      return audience.excluded === 0
        ? base
        : `${base} · ${audience.excluded} excluded`;
    }
    case "custom":
      return audience.summary;
  }
}

/**
 * The policy a quick choice sets, from the current one: "Only you" grants nobody; "Home · can view" grants the primary household read
 * access and KEEPS the current exclusions (D-11a-7). Null when the choice cannot be made (no primary household is known).
 */
export function quickPolicy(
  choice: "only_you" | "home",
  current: Policy | null,
  primaryHouseholdId: string | null,
): Policy | null {
  if (choice === "only_you") return ONLY_YOU_POLICY();
  if (primaryHouseholdId === null) return null;
  return {
    grants: [{ kind: "household", id: primaryHouseholdId, edit: false }],
    exclude_accounts: [...(current?.exclude_accounts ?? [])],
  };
}

/** The primary household of the B5 record, with its name when the record lists it; null when there is none or no record. */
export function primaryHousehold(
  record: DefaultsRecord | null,
): { id: string; household: SnapshotHousehold | null } | null {
  const id = record?.snapshot.defaults.primary_household_id ?? null;
  if (record === null || id === null) return null;
  return {
    id,
    household: record.snapshot.households.find((h) => h.id === id) ?? null,
  };
}

/** What a resolved template means for a new record, in the people screens' words ("Only you", "Home · can view", …). */
export function templateLabel(
  template: DefaultTemplate,
  record: DefaultsRecord,
): string {
  const home = primaryHousehold(record);
  const homeName = home?.household?.name ?? "Home";
  switch (template.kind) {
    case "private":
      return "Only you";
    case "primary_household":
      return home === null
        ? "Only you"
        : `${homeName} · ${template.edit ? "can edit" : "can view"}`;
    case "explicit":
      return audienceLabel(
        classify(template.policy, home?.id ?? null),
        homeName,
      );
  }
}

/** "Use my defaults" for a new FIELD, resolved from the B5 record; null while no record is known (never "private" by assumption). */
export function fieldDefaultsLabel(
  record: DefaultsRecord | null,
): string | null {
  return record === null
    ? null
    : templateLabel(record.snapshot.defaults.field, record);
}
/** The same for a new PERSON. */
export function personDefaultsLabel(
  record: DefaultsRecord | null,
): string | null {
  return record === null
    ? null
    : templateLabel(record.snapshot.defaults.person, record);
}

/**
 * The PPL-6 note under the audience choice, when the person is known to be linked to ANOTHER account (D-11a-7). Without an explicit
 * policy (defaults), the server excludes the subject from a field authored about them; with an explicit one, the policy is used exactly.
 * Null when nothing true can be said (linkage unknown or not another account, or "Only you").
 */
export function subjectNote(input: {
  linkage: LinkageState;
  choice: "defaults" | "only_you" | "home" | "custom";
  personName: string;
  /** The primary household's member list from the B5 record, or null when it is not known. */
  homeMembers: readonly string[] | null;
  homeName: string | null;
}): string | null {
  const { linkage, choice, personName } = input;
  if (!linkage.known || linkage.kind !== "other" || linkage.accountId === null)
    return null;
  switch (choice) {
    case "only_you":
      return null;
    case "defaults":
      return `${personName} won't see this field unless you share it with them.`;
    case "custom":
      // Who a custom policy reaches is the policy editor's to show: membership of Home says nothing about it.
      return `${personName} may be able to see it.`;
    case "home":
      if (input.homeMembers === null)
        return `${personName} may be able to see it.`;
      return input.homeMembers.includes(linkage.accountId)
        ? `${personName} is in ${input.homeName ?? "Home"} and will be able to see it.`
        : null;
  }
}
