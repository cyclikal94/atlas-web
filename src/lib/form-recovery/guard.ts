import type { RecoverableFieldSpec, RecoverySnapshot } from "./port";

/**
 * The recovery guard. Passwords and connection secrets are never saved (Q4, Q22): the recovery copy lives in
 * browser storage that anyone with the profile can read, and calendar connection details are online-only.
 * A field is refused when it is type="password", has an autocomplete token for a secret, or is marked
 * data-atlas-sensitive. Development builds throw so a mistake is found immediately; production builds drop the field.
 */
const SECRET_AUTOCOMPLETE = new Set([
  "current-password",
  "new-password",
  "one-time-code",
]);

export function isSensitiveField(element: Element): boolean {
  if (
    element instanceof HTMLInputElement &&
    element.type.toLowerCase() === "password"
  )
    return true;
  if (element.hasAttribute("data-atlas-sensitive")) return true;
  const tokens = (element.getAttribute("autocomplete") ?? "")
    .toLowerCase()
    .split(/\s+/);
  return tokens.some((token) => SECRET_AUTOCOMPLETE.has(token));
}

export class SensitiveFieldError extends Error {
  constructor(readonly fieldName: string) {
    super(
      `Field "${fieldName}" is sensitive and can never be part of a recovery snapshot`,
    );
    this.name = "SensitiveFieldError";
  }
}

export interface SnapshotInput {
  form: HTMLFormElement;
  formContext: string;
  tabInstanceId: string;
  allow: readonly RecoverableFieldSpec[];
  now?: Date;
  /** Development builds throw on a sensitive field; production drops it. Injectable for tests. */
  strict?: boolean;
}

/** Reads only the allow-listed fields from the form, in text form. */
export function buildSnapshot({
  form,
  formContext,
  tabInstanceId,
  allow,
  now = new Date(),
  strict = import.meta.env.DEV,
}: SnapshotInput): RecoverySnapshot {
  const values: Record<string, string> = {};
  for (const { name } of allow) {
    const element = form.elements.namedItem(name);
    if (
      !(
        element instanceof HTMLInputElement ||
        element instanceof HTMLTextAreaElement ||
        element instanceof HTMLSelectElement
      )
    ) {
      continue;
    }
    if (isSensitiveField(element)) {
      if (strict) throw new SensitiveFieldError(name);
      continue;
    }
    values[name] = element.value;
  }
  return { formContext, tabInstanceId, values, savedAt: now.toISOString() };
}

/** Restores saved values into the allow-listed fields. It never submits the form. */
export function restoreSnapshot(
  form: HTMLFormElement,
  snapshot: RecoverySnapshot,
  allow: readonly RecoverableFieldSpec[],
): void {
  for (const { name } of allow) {
    const value = snapshot.values[name];
    if (value === undefined) continue;
    const element = form.elements.namedItem(name);
    if (
      !(
        element instanceof HTMLInputElement ||
        element instanceof HTMLTextAreaElement ||
        element instanceof HTMLSelectElement
      )
    ) {
      continue;
    }
    if (isSensitiveField(element)) continue;
    element.value = value;
  }
}
