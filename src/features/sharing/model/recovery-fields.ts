import {
  type DefaultTemplate,
  type Policy,
  parsePolicy,
  parseTemplate,
} from "../../../data";

/**
 * Form recovery readiness for the editors (Q4; WEB-14a supplies the app-update event that captures them). PURE. The recoverable value
 * is the editor's draft as canonical JSON, keyed by a form context; there are no secrets in it. Restoring NEVER submits: the restored
 * draft is shown against a fresh read and Save stays the person's act. A value that does not parse restores nothing.
 */
export const policyFormContext = (resourceId: string) =>
  `sharing-policy:${resourceId}`;
/** WEB-14a revision 37 (R40): one defaults layer form: its layer, household (or personal) and kind. */
export const defaultsFormContext = (target: string) => `sharing-${target}`;
export const templateFormContext = (
  kind: string,
  layer: "personal" | "household",
) => `sharing-defaults:${kind}:${layer}`;

export function policyRecoveryValues(policy: Policy): Record<string, string> {
  return { policy: JSON.stringify(policy) };
}
export function restorePolicyDraft(
  values: Readonly<Record<string, string>>,
): Policy | null {
  try {
    return parsePolicy(JSON.parse(values.policy ?? "null"));
  } catch {
    return null;
  }
}

/** A template choice; `null` is "inherit" (no override). */
export function templateRecoveryValues(
  template: DefaultTemplate | null,
): Record<string, string> {
  return { template: JSON.stringify(template) };
}
export function restoreTemplateDraft(
  values: Readonly<Record<string, string>>,
): { template: DefaultTemplate | null } | null {
  try {
    const raw: unknown = JSON.parse(values.template ?? "undefined");
    if (raw === null) return { template: null };
    const template = parseTemplate(raw);
    return template === null ? null : { template };
  } catch {
    return null;
  }
}

/**
 * WEB-14a revision 37 (R40): the policy editor's draft and the policy version it was composed against, as one recoverable text (version
 * 1). A restored draft confers no authority: Save still sends `expected_version` = that base, so a policy changed meanwhile is a conflict.
 */
export function encodePolicyDraft(draft: {
  policy: Policy;
  base: number;
}): string {
  return JSON.stringify({ v: 1, policy: draft.policy, base: draft.base });
}
export function decodePolicyDraft(
  text: string,
): { policy: Policy; base: number } | null {
  try {
    const raw = JSON.parse(text) as Record<string, unknown> | null;
    if (raw === null || typeof raw !== "object" || raw.v !== 1) return null;
    if (typeof raw.base !== "number" || !Number.isInteger(raw.base))
      return null;
    const policy = parsePolicy(raw.policy);
    return policy === null ? null : { policy, base: raw.base };
  } catch {
    return null;
  }
}
