import type { Policy, SnapshotHousehold } from "../../../data";

/**
 * The EFFECTIVE visibility of a policy as it is being edited (WF-SHARING-04: "reflects the policy being built, not only the last-saved
 * state"). PURE. The rules (docs/sharing.md, Resource policies and recovery):
 *
 *  - the owner always keeps management access, whatever the grants say;
 *  - an exclusion applies to EVERY grant: a direct grant cannot override it, and an excluded member of a granted household is excluded;
 *  - a direct grant never removes a household grant (the two add up); edit beats read for one person reached twice;
 *  - a household you are not in is shown as such: its members are not known here, and the server evaluates membership live; only a
 *    COMPLETE membership list says so (WEB-12a R11): without one, a household it does not name is one whose members couldn't be loaded;
 *  - a resource with a parent is also limited by who can see the parent.
 *
 * This is a DISPLAY of the policy, labelled with the read times of its inputs; the server decides who can see what.
 */
export interface Person {
  id: string;
  label: string;
}
export interface Audience {
  owner: Person;
  readers: Person[];
  editors: Person[];
  /** Granted households whose members are not known here (you are not in them). */
  unknownHouseholds: Array<{ id: string; edit: boolean }>;
  /** Granted households whose members couldn't be loaded: no complete membership list says whether you are in them (R11). */
  uncheckedHouseholds: Array<{ id: string; edit: boolean }>;
  excluded: Person[];
  parentLimited: boolean;
}

/** A label for an account that nothing on this page has named: never a guessed name, only an abbreviated id. */
export const anonymousLabel = (id: string): string =>
  `Account ${id.slice(0, 4)}…`;

export function effectiveAudience(input: {
  ownerId: string;
  policy: Policy;
  households: readonly SnapshotHousehold[];
  /** Whether `households` is your complete membership list (a read that answered), not a last-known or missing one. */
  complete: boolean;
  /** Usernames this page learnt (household members, directory lookups), by account id. */
  labels: ReadonlyMap<string, string>;
  parentLimited: boolean;
}): Audience {
  const label = (id: string): Person => ({
    id,
    label: input.labels.get(id) ?? anonymousLabel(id),
  });
  const excluded = new Set(input.policy.exclude_accounts);
  excluded.delete(input.ownerId);
  const reach = new Map<string, boolean>();
  const add = (id: string, edit: boolean): void => {
    if (id === input.ownerId || excluded.has(id)) return;
    reach.set(id, (reach.get(id) ?? false) || edit);
  };
  const unknownHouseholds: Audience["unknownHouseholds"] = [];
  const uncheckedHouseholds: Audience["uncheckedHouseholds"] = [];
  for (const grant of input.policy.grants) {
    if (grant.kind === "account") {
      add(grant.id, grant.edit);
      continue;
    }
    const household = input.households.find((h) => h.id === grant.id);
    if (household === undefined) {
      (input.complete ? unknownHouseholds : uncheckedHouseholds).push({
        id: grant.id,
        edit: grant.edit,
      });
      continue;
    }
    for (const member of household.members) add(member.account_id, grant.edit);
  }
  const byLabel = (a: Person, b: Person) => a.label.localeCompare(b.label);
  return {
    owner: label(input.ownerId),
    readers: [...reach]
      .filter(([, edit]) => !edit)
      .map(([id]) => label(id))
      .sort(byLabel),
    editors: [...reach]
      .filter(([, edit]) => edit)
      .map(([id]) => label(id))
      .sort(byLabel),
    unknownHouseholds,
    uncheckedHouseholds,
    excluded: [...excluded].map(label).sort(byLabel),
    parentLimited: input.parentLimited,
  };
}

/** Every username a page has learnt from household member lists, by account id. */
export function labelsFrom(
  households: readonly SnapshotHousehold[],
  extra: Iterable<[string, string]> = [],
): Map<string, string> {
  const labels = new Map<string, string>();
  for (const household of households)
    for (const member of household.members)
      labels.set(member.account_id, member.username);
  for (const [id, name] of extra) labels.set(id, name);
  return labels;
}
