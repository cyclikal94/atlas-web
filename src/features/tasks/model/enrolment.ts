import type { DefaultsRecord, Policy } from "../../../data";
import type { EnrolCommand } from "../api";
import type { Enrolment } from "./contract";

/**
 * The enrolment command and its audience (revision 10, R22; task `states.md` R2/F1). PURE.
 *
 * `enrol` REPLACES the whole enrolment: active, aggregate consent and the audience of the progress generated from now on. An omitted
 * `initial_policy` is not "unchanged": the server resolves the CURRENT progress defaults and stores them as the audience. So every command
 * is the complete reviewed enrolment with only the person's change applied, and its policy is always explicit (Private is an empty one).
 * Aggregate consent and who can read progress are independent: neither is derived from the other.
 */

/** A copy of `policy` sharing nothing with it: what a command carries never changes when its source does. */
export const copyPolicy = (policy: Policy): Policy => ({
  grants: policy.grants.map((grant) => ({
    kind: grant.kind,
    id: grant.id,
    edit: grant.edit,
  })),
  exclude_accounts: [...policy.exclude_accounts],
});

/** The enrolment `base` (as read, its version the guard) with `change` applied; every field not changed is resent as it was. */
export function enrolCommand(
  taskId: string,
  base: Enrolment,
  change: { active?: boolean; aggregate_consent?: boolean; policy?: Policy },
): EnrolCommand {
  return {
    kind: "enrol",
    task_id: taskId,
    expected_version: base.version,
    active: change.active ?? base.active,
    aggregate_consent: change.aggregate_consent ?? base.aggregate_consent,
    initial_policy: copyPolicy(change.policy ?? base.policy),
  };
}

/**
 * The audience the server would give new progress: the resolved `progress` template of a defaults snapshot, as the server resolves it
 * (a primary-household template with no primary household grants nobody). Only ever a suggestion the person sees before choosing.
 */
export function progressDefaultPolicy(record: DefaultsRecord): Policy {
  const { defaults } = record.snapshot;
  const template = defaults.progress;
  if (template.kind === "explicit") return copyPolicy(template.policy);
  if (template.kind === "private" || defaults.primary_household_id === null)
    return { grants: [], exclude_accounts: [] };
  return {
    grants: [
      {
        kind: "household",
        id: defaults.primary_household_id,
        edit: template.edit,
      },
    ],
    exclude_accounts: [],
  };
}
