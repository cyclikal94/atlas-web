import {
  MAX_EXCLUSIONS,
  MAX_GRANTS,
  type Policy,
  type PrincipalGrant,
} from "../../../data";

/**
 * The grant and exclusion editor's state (WF-SHARING-04, and WF-SHARING-03's explicit template). PURE: a reducer over a `Policy`.
 *
 * Rules (docs/sharing.md, Resource policies; the contract's `Policy`):
 *  - one grant per principal: adding an account or household that is already granted changes nothing;
 *  - at most 100 grants and 100 exclusions, exclusions unique;
 *  - the OWNER's own account is never a grantee or an exclusion: the owner always keeps management access ("You always keep access as
 *    owner"), so a policy that names it would say something untrue;
 *  - a direct grant never lifts an exclusion: adding a grant for an excluded account leaves it excluded (the effective audience says so).
 */
export type PolicyAction =
  | { type: "add_account"; id: string; edit?: boolean }
  | { type: "add_household"; id: string; edit?: boolean }
  | {
      type: "set_edit";
      kind: PrincipalGrant["kind"];
      id: string;
      edit: boolean;
    }
  | { type: "remove"; kind: PrincipalGrant["kind"]; id: string }
  | { type: "exclude"; id: string }
  | { type: "include"; id: string }
  | { type: "reset"; policy: Policy };

export type PolicyRefusal = "owner" | "grant_limit" | "exclusion_limit";

export interface PolicyDraftState {
  policy: Policy;
  /** Why the last action changed nothing, for the editor to say; null when it applied (or was a harmless repeat). */
  refused: PolicyRefusal | null;
}

export const emptyPolicy = (): Policy => ({ grants: [], exclude_accounts: [] });

const has = (policy: Policy, kind: PrincipalGrant["kind"], id: string) =>
  policy.grants.some((grant) => grant.kind === kind && grant.id === id);

export function reducePolicy(
  state: PolicyDraftState,
  action: PolicyAction,
  ownerId: string,
): PolicyDraftState {
  const { policy } = state;
  const keep = (next: Policy): PolicyDraftState => ({
    policy: next,
    refused: null,
  });
  switch (action.type) {
    case "reset":
      return keep(action.policy);
    case "add_account":
    case "add_household": {
      const kind = action.type === "add_account" ? "account" : "household";
      if (kind === "account" && action.id === ownerId)
        return { policy, refused: "owner" };
      if (has(policy, kind, action.id)) return keep(policy);
      if (policy.grants.length >= MAX_GRANTS)
        return { policy, refused: "grant_limit" };
      return keep({
        ...policy,
        grants: [
          ...policy.grants,
          { kind, id: action.id, edit: action.edit ?? false },
        ],
      });
    }
    case "set_edit":
      return keep({
        ...policy,
        grants: policy.grants.map((grant) =>
          grant.kind === action.kind && grant.id === action.id
            ? { ...grant, edit: action.edit }
            : grant,
        ),
      });
    case "remove":
      return keep({
        ...policy,
        grants: policy.grants.filter(
          (grant) => !(grant.kind === action.kind && grant.id === action.id),
        ),
      });
    case "exclude": {
      if (action.id === ownerId) return { policy, refused: "owner" };
      if (policy.exclude_accounts.includes(action.id)) return keep(policy);
      if (policy.exclude_accounts.length >= MAX_EXCLUSIONS)
        return { policy, refused: "exclusion_limit" };
      return keep({
        ...policy,
        exclude_accounts: [...policy.exclude_accounts, action.id],
      });
    }
    case "include":
      return keep({
        ...policy,
        exclude_accounts: policy.exclude_accounts.filter(
          (id) => id !== action.id,
        ),
      });
  }
}

/** The policy as it is SENT: households first, then accounts, each by id; exclusions by id. One draft has one body. */
export function toWirePolicy(policy: Policy): Policy {
  const order = (kind: PrincipalGrant["kind"]) =>
    kind === "household" ? 0 : 1;
  return {
    grants: [...policy.grants]
      .sort((a, b) =>
        a.kind === b.kind
          ? a.id.localeCompare(b.id)
          : order(a.kind) - order(b.kind),
      )
      .map((grant) => ({ kind: grant.kind, id: grant.id, edit: grant.edit })),
    exclude_accounts: [...policy.exclude_accounts].sort(),
  };
}

export const samePolicy = (a: Policy, b: Policy): boolean =>
  JSON.stringify(toWirePolicy(a)) === JSON.stringify(toWirePolicy(b));
