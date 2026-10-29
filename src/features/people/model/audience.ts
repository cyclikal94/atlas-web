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
 * The policy a save of the field editor leaves the field with, for its audience choice (review 22, R22.1): the ONE derivation behind
 * both the policy the save sends and the subject note, so the note never describes another policy than the one saved. Null for
 * "Use my defaults" (the server resolves it) and whenever it is not known: an existing field whose policy at the edit's version was not
 * read (never an empty policy in its place), a custom policy that is not the current one, or Home with no primary household. An
 * unchanged choice keeps the current policy exactly; a change to Home keeps its exclusions (D-11a-7), however the choice got there.
 */
export function selectedPolicy(input: {
  choice: "defaults" | "only_you" | "home" | "custom";
  isNew: boolean;
  /** The existing field's policy at the version the edit is bound to, or null (a new field, or not read). */
  current: Policy | null;
  /** The choice differs from the existing field's current one. */
  changed: boolean;
  primaryHouseholdId: string | null;
}): Policy | null {
  const { choice } = input;
  if (choice === "defaults") return null;
  if (input.isNew)
    return choice === "custom"
      ? null
      : quickPolicy(choice, null, input.primaryHouseholdId);
  if (input.current === null) return null;
  if (!input.changed) return input.current;
  if (choice === "custom") return null;
  return quickPolicy(choice, input.current, input.primaryHouseholdId);
}

/**
 * The PPL-6 note under the audience choice, when the person is known to be linked to ANOTHER account (D-11a-7). Without an explicit
 * policy (defaults), the server excludes the subject from a field authored about them; with an explicit one, the policy is used exactly,
 * so it is the policy a save leaves (`selectedPolicy`) that is described (review 22, R22.1): a subject it excludes won't see the field,
 * whoever it grants. A grant is not a promise either: the subject also has to be able to see the person the field is on (the server
 * hides a field whose parent its reader cannot see), which this page cannot know, so the positive note says so. Null when nothing true
 * can be said (linkage unknown or not another account, "Only you", or Home known not to include the subject).
 */
export function subjectNote(input: {
  linkage: LinkageState;
  choice: "defaults" | "only_you" | "home" | "custom";
  /** The policy a save leaves (`selectedPolicy`), or null: defaults, or not known. */
  policy: Policy | null;
  personName: string;
  /** The primary household's member list from the B5 record, or null when it is not known. */
  homeMembers: readonly string[] | null;
  homeName: string | null;
}): string | null {
  const { linkage, choice, policy, personName } = input;
  if (!linkage.known || linkage.kind !== "other" || linkage.accountId === null)
    return null;
  if (choice === "defaults")
    return `${personName} won't see this field unless you share it with them.`;
  if (choice === "only_you") return null;
  // An exclusion of the subject wins over every grant, Home's included (the server's visibility rule).
  if (policy?.exclude_accounts.includes(linkage.accountId))
    return `${personName} is excluded from this field's sharing, so they won't see it.`;
  // Who a custom policy reaches is the policy editor's to show: membership of Home says nothing about it. Nor can anything be said
  // of a policy that is not known: its exclusions are not.
  if (choice === "custom" || policy === null || input.homeMembers === null)
    return `${personName} may be able to see it.`;
  return input.homeMembers.includes(linkage.accountId)
    ? `${personName} is in ${input.homeName ?? "Home"}, so this sharing includes them. They'll see it if they can also see this profile.`
    : null;
}
