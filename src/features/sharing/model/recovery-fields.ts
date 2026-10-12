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
