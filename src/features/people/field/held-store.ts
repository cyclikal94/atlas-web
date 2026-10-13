import type { FormRecoveryRow, Policy } from "../../../data";
import type {
  FormRecoveryPort,
  SaveResult,
} from "../../../lib/form-recovery/port";
import type { Attempt } from "../model/attempt";
import { type FieldValue, parseFieldValue } from "../model/values";

/**
 * The HELD audience changes of the account (D-11a-12, "Hold it as a draft until I'm online"), kept DURABLY (finding 6 of the review of
 * 13 October 2026; the human decision of 13 October: durable, in WEB-11a). Each held change is one form copy of the account's own
 * database (`form_recovery`, written through WEB-09a's `FormRecoveryPort`, read through `readFormCopies`):
 *
 *  - `form_context` = `people-held:<person>:<field>`, `tab_instance_id` = the hold's own id. One row per hold, written only by the page that
 *    made it (or, to finish or discard it, by the page that runs it), so the port's writer order never refuses a later hold of the same field.
 *  - It survives a reload, an account switch without logout, an expired session and a password change (Q3, Q20(a)), and is deleted with the
 *    account's data only by a confirmed logout or self-retirement; it is counted in the unsynced work a logout warns about (category
 *    `form_copy`) and its consent binds to; it is admitted by the quota guard and refused while signing out (D-16); it is read only inside
 *    the account's protected tree, so it is never shown while the account's display is restricted (Q20(b)), and never under another account.
 *  - Its text is the change the person made (name, typed value), the edit's snapshot (content version, expected base, the policy shown), the
 *    audience asked for, and the uncertain attempt of its policy step (the same key and body on a retry). No secret is stored.
 *  - Nothing is queued until it runs (online, writable, on the person's page): the policy step is online-only and is never queued (WEB-04
 *    §5.1); the content step is queued only after the policy step is confirmed.
 */
export const HELD_FORM = "people-held:";

export const heldPrefixOf = (personId: string): string =>
  `${HELD_FORM}${personId}:`;
export const heldContextOf = (personId: string, fieldId: string): string =>
  `${HELD_FORM}${personId}:${fieldId}`;

export type HeldFailure =
  | "changed"
  | "conflict"
  | "forbidden"
  | "uncertain"
  | "content_changed"
  | "gone"
  | "not_saved";

export interface HeldChange {
  /** The hold's id: its row's `tab_instance_id`, and the local id its content draft is queued under (never queued twice). */
  holdId: string;
  fieldId: string;
  personId: string;
  label: string;
  value: FieldValue;
  sameKind: boolean;
  /** The field's content version when the edit began: the content step is refused if the field changed since. */
  version: number;
  /** The outbox base the content step must resolve (`BaseGuard`). */
  expectedBase: number;
  /** The policy shown when the edit began, with its version: the policy change is guarded by it. Once confirmed, it is `to`. */
  from: { version: number; policy: Policy };
  to: Policy;
  /** The uncertain attempt of the policy step, kept for a retry (same key and byte-identical body), or null. */
  attempt: Attempt | null;
  /** `waiting` until it runs; a failure keeps its reason until "Try again". */
  status: { kind: "waiting" } | { kind: "failed"; reason: HeldFailure };
  heldAt: string;
}

/** A held row the page could not read (an older shape, a damaged value): listed so it can be discarded, never run. */
export interface UnreadableHeld {
  holdId: string;
  formContext: string;
}

const FAILURES: ReadonlySet<string> = new Set<HeldFailure>([
  "changed",
  "conflict",
  "forbidden",
  "uncertain",
  "content_changed",
  "gone",
  "not_saved",
]);

type Obj = Record<string, unknown>;
const isObject = (value: unknown): value is Obj =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isVersion = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

function parsePolicy(raw: unknown): Policy | null {
  if (
    !isObject(raw) ||
    !Array.isArray(raw.grants) ||
    !Array.isArray(raw.exclude_accounts)
  )
    return null;
  const grants: Policy["grants"] = [];
  for (const grant of raw.grants) {
    if (
      !isObject(grant) ||
      (grant.kind !== "account" && grant.kind !== "household") ||
      typeof grant.id !== "string" ||
      typeof grant.edit !== "boolean"
    )
      return null;
    grants.push({ kind: grant.kind, id: grant.id, edit: grant.edit });
  }
  if (raw.exclude_accounts.some((id) => typeof id !== "string")) return null;
  return { grants, exclude_accounts: [...(raw.exclude_accounts as string[])] };
}

/** The held change a form copy carries, or null when it is not one this page can read. PURE. */
export function decodeHeld(row: FormRecoveryRow): HeldChange | null {
  const text = row.fields.held;
  if (typeof text !== "string") return null;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isObject(raw) || raw.v !== 1) return null;
  const value = parseFieldValue(raw.value);
  const fromRaw = raw.from;
  const from =
    isObject(fromRaw) && isVersion(fromRaw.version)
      ? parsePolicy(fromRaw.policy)
      : null;
  const to = parsePolicy(raw.to);
  const attemptRaw = raw.attempt;
  const attempt =
    attemptRaw === null
      ? null
      : isObject(attemptRaw) &&
          typeof attemptRaw.key === "string" &&
          typeof attemptRaw.body === "string"
        ? { key: attemptRaw.key, body: attemptRaw.body }
        : undefined;
  const status = raw.failed;
  if (
    value === null ||
    from === null ||
    to === null ||
    attempt === undefined ||
    typeof raw.fieldId !== "string" ||
    typeof raw.personId !== "string" ||
    typeof raw.label !== "string" ||
    typeof raw.sameKind !== "boolean" ||
    !isVersion(raw.version) ||
    !isVersion(raw.expectedBase) ||
    typeof raw.heldAt !== "string" ||
    (status !== null && (typeof status !== "string" || !FAILURES.has(status)))
  )
    return null;
  // A copy is the change of the field its context names, and of no other.
  if (row.form_context !== heldContextOf(raw.personId, raw.fieldId))
    return null;
  return {
    holdId: row.tab_instance_id,
    fieldId: raw.fieldId,
    personId: raw.personId,
    label: raw.label,
    value,
    sameKind: raw.sameKind,
    version: raw.version,
    expectedBase: raw.expectedBase,
    from: { version: (fromRaw as Obj).version as number, policy: from },
    to,
    attempt,
    status:
      status === null
        ? { kind: "waiting" }
        : { kind: "failed", reason: status as HeldFailure },
    heldAt: raw.heldAt,
  };
}

/** The form copy's text of a held change. PURE. */
export function encodeHeld(change: HeldChange): Record<string, string> {
  return {
    held: JSON.stringify({
      v: 1,
      fieldId: change.fieldId,
      personId: change.personId,
      label: change.label,
      value: change.value,
      sameKind: change.sameKind,
      version: change.version,
      expectedBase: change.expectedBase,
      from: change.from,
      to: change.to,
      attempt: change.attempt,
      failed: change.status.kind === "failed" ? change.status.reason : null,
      heldAt: change.heldAt,
    }),
  };
}

/**
 * Writes the held changes of the displayed account (production: `FormRecoveryPort` over the account's database). `save` is `saved` only
 * when THIS content is durable; `refused` while signing out; `failed` otherwise (nothing is claimed).
 */
export interface HeldStore {
  save(change: HeldChange): Promise<SaveResult>;
  /** Ends a hold (finished, discarded): its copy is cleared and is never listed again. */
  discard(hold: {
    personId: string;
    fieldId: string;
    holdId: string;
  }): Promise<"discarded" | "failed">;
}

export function heldStoreOver(
  port: FormRecoveryPort,
  now: () => string,
): HeldStore {
  return {
    save: (change) =>
      port.save({
        formContext: heldContextOf(change.personId, change.fieldId),
        tabInstanceId: change.holdId,
        values: encodeHeld(change),
        savedAt: now(),
      }),
    discard: async (hold) => {
      try {
        await port.discard(
          heldContextOf(hold.personId, hold.fieldId),
          hold.holdId,
        );
        return "discarded";
      } catch {
        return "failed";
      }
    },
  };
}
