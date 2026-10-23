import type {
  ConditionalFormPort,
  FormCopiesPage,
  FormCopyCursor,
  FormRecoveryRow,
  Policy,
} from "../../../data";
import type { Attempt } from "../model/attempt";
import { type FieldValue, parseFieldValue } from "../model/values";

/**
 * The HELD audience changes of the account (D-11a-12, "Hold it as a draft until I'm online"), kept DURABLY (finding 6 of the review of
 * 13 October 2026; the human decision of 13 October: durable, in WEB-11a). Each held change is one form copy of the account's own
 * database (`form_recovery`, written through the conditional port below, read through `readFormCopies`):
 *
 *  - `form_context` = `people-held:<person>:<field>`, `tab_instance_id` = the hold's own id. One row per hold. WEB-14a's Q4 recovery must
 *    leave the `people-held:` family alone; the ordinary form port cannot write these rows at all (they hold the highest writer generation).
 *  - It survives a reload, an account switch without logout, an expired session and a password change (Q3, Q20(a)), and is deleted with the
 *    account's data only by a confirmed logout or self-retirement; it is counted in the unsynced work a logout warns about (category
 *    `form_copy`) and its consent binds to; it is admitted by the quota guard and refused while signing out (D-16); it is read only inside
 *    the account's protected tree, so it is never shown while the account's display is restricted (Q20(b)), and never under another account.
 *  - Its text is the change the person made (name, typed value), the edit's snapshot (content version, expected base, the policy shown), the
 *    audience asked for, and the uncertain attempt of its policy step (the same key and body on a retry). No secret is stored.
 *  - Nothing is queued until it runs (online, writable, on the person's page): the policy step is online-only and is never queued (WEB-04
 *    §5.1); the content step is queued only after the policy step is confirmed.
 *
 * A HOLD IS AN OPERATION, NOT A FORM (review 2 of 22 October 2026, finding 2). Its copy is written only through the CONDITIONAL port
 * (`createConditionalFormPort`): every write names the state it was decided on (the copy's digest; `rev` grows with every write, so a
 * digest never comes back) and is refused (`changed`) when another state is stored, ended included; ending it is a terminal write from
 * the state read, never a removal inferred from a call that returned. Every answer is typed (`saved`/`ended`, `changed`, `refused`,
 * `failed`): the screens claim a hold ended, or a step admitted, only when the store committed it. Its progress is a state of the copy:
 * the uncertain policy attempt is written BEFORE it is sent (`attempt`), and the content step is recorded as admitted (`queued`) BEFORE
 * it is queued, so a page that ends the hold afterwards says truthfully what may already have happened.
 *
 * ONE CURRENT HOLD PER FIELD (review 3 of 22 October 2026, finding 2). Each hold carries its field's GENERATION (`seq`), given under the
 * field's lock from every hold of the field stored then (`holdChange`), so the new copy and its place after every earlier one are ONE
 * write: the field's current hold is its live hold of the highest generation. Only it may run; an earlier one that is still kept (a page
 * closed before it was retired, a retirement that was refused) is never run, and is retired by the next run of its field. Copies of the
 * first shapes (v 1, v 2) are generation 0.
 *
 * AN UNRESOLVED ATTEMPT OUTLIVES ITS CONTENT (finding 2 of review 3; the design assessment's C3c). A hold whose policy step MAY have been
 * made (its attempt has no definite answer) is never ended by a discard or a replacement: it is RETIRED (`retired`), a reconciliation
 * record that keeps the attempt, the audience asked for and the version it was guarded by, and no content (its value is cleared). It never
 * runs and never queues anything; the person checks it ("Check now", one owner-only read) or discards it, and a later hold of exactly the
 * same change takes its attempt over (the same key and body) before it is ended.
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
  /** The number of this state: every write of the hold is the next (0: as it was held, or a copy of the first shape). */
  rev: number;
  /** The content step was admitted: its draft may be queued (an end after it says so). */
  queued: boolean;
  /** The field's generation of this hold: the live hold of the highest one is the field's current hold (0: a copy of the first shapes). */
  seq: number;
  /** Retired with its policy attempt unresolved: a reconciliation record, never run (its content is cleared). */
  retired: boolean;
}

/** A held change with the digest of the stored state it was read as: the only state a write of it may replace. */
export interface HeldCopy {
  change: HeldChange;
  digest: string;
}

export interface HeldKey {
  personId: string;
  fieldId: string;
  holdId: string;
}

/** What is stored now, when a conditional write found another state. */
export type HeldStored = "absent" | "ended" | "live";

export type HeldWrite =
  | { kind: "saved"; copy: HeldCopy }
  | { kind: "changed"; stored: HeldStored }
  | { kind: "refused" }
  | { kind: "failed" };

export type HeldEnd =
  | { kind: "ended" }
  | { kind: "changed"; stored: HeldStored }
  | { kind: "refused" }
  | { kind: "failed" };

export type HeldRead =
  | { kind: "live"; copy: HeldCopy }
  /** A live copy this page cannot read (an older shape, a damaged value): it can only be ended, from its digest. */
  | { kind: "unreadable"; digest: string }
  | { kind: "ended" }
  | { kind: "absent" }
  /** The store could not be read: never taken for absence. */
  | { kind: "failed" };

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
  if (!isObject(raw) || (raw.v !== 1 && raw.v !== 2 && raw.v !== 3))
    return null;
  // The first shape (v 1) had no state number and no content admission: it is read as state 0, not admitted. Neither it nor v 2 had a
  // generation or a retirement: generation 0, live.
  const rev = raw.v === 1 ? 0 : raw.rev;
  const queued = raw.v === 1 ? false : raw.queued;
  const seq = raw.v === 3 ? raw.seq : 0;
  const retired = raw.v === 3 ? raw.retired : false;
  if (
    !isVersion(rev) ||
    typeof queued !== "boolean" ||
    !isVersion(seq) ||
    typeof retired !== "boolean"
  )
    return null;
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
    rev,
    queued,
    seq,
    retired,
  };
}

/** The form copy's text of a held change. PURE. */
export function encodeHeld(change: HeldChange): Record<string, string> {
  return {
    held: JSON.stringify({
      v: 3,
      rev: change.rev,
      queued: change.queued,
      seq: change.seq,
      retired: change.retired,
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
 * The held changes of the displayed account (production: the CONDITIONAL port over the account's database). Every answer is typed and
 * none is inferred: `create` writes a hold whose copy must not exist yet; `update` writes the next state of the one read as `from` (its
 * `rev` is `from`'s plus one and its `seq` is `from`'s, whatever `next` says; a retired hold stays retired); `end` makes the copy read as `digest` terminal; `read` says what is stored; `list` is
 * one bounded, resumable page of a person's (or one field's) holds, or null when it could not be read.
 */
export interface HeldStore {
  create(change: HeldChange): Promise<HeldWrite>;
  update(from: HeldCopy, next: HeldChange): Promise<HeldWrite>;
  end(hold: HeldKey, digest: string): Promise<HeldEnd>;
  read(hold: HeldKey): Promise<HeldRead>;
  list(
    personId: string,
    fieldId: string | null,
    after: FormCopyCursor | null,
  ): Promise<FormCopiesPage | null>;
}

/** The hold a live copy carries, with its digest, or the copy's digest alone when this page cannot read it. PURE. */
export function heldOf(row: FormRecoveryRow): HeldCopy | null {
  const change = decodeHeld(row);
  return change === null ? null : { change, digest: row.content_digest };
}

export function heldStoreOver(
  port: ConditionalFormPort,
  now: () => string,
): HeldStore {
  const write = async (
    change: HeldChange,
    expect: string | null,
  ): Promise<HeldWrite> => {
    const answer = await port.put(
      {
        formContext: heldContextOf(change.personId, change.fieldId),
        tabInstanceId: change.holdId,
        values: encodeHeld(change),
        savedAt: now(),
      },
      expect,
    );
    return answer.kind === "saved"
      ? { kind: "saved", copy: { change, digest: answer.digest } }
      : answer;
  };
  return {
    create: (change) => write(change, null),
    update: (from, next) =>
      write(
        {
          ...next,
          holdId: from.change.holdId,
          personId: from.change.personId,
          fieldId: from.change.fieldId,
          rev: from.change.rev + 1,
          // A hold keeps its place among its field's holds; a retired one is never live again.
          seq: from.change.seq,
          retired: from.change.retired || next.retired,
        },
        from.digest,
      ),
    end: (hold, digest) =>
      port.end(heldContextOf(hold.personId, hold.fieldId), hold.holdId, digest),
    read: async (hold) => {
      const stored = await port.read(
        heldContextOf(hold.personId, hold.fieldId),
        hold.holdId,
      );
      if (stored.kind !== "live") return stored;
      const copy = heldOf(stored.row);
      return copy === null ||
        copy.change.personId !== hold.personId ||
        copy.change.fieldId !== hold.fieldId
        ? { kind: "unreadable", digest: stored.row.content_digest }
        : { kind: "live", copy };
    },
    list: async (personId, fieldId, after) => {
      if (fieldId === null) return port.list(heldPrefixOf(personId), after);
      // One field's holds: its context is the prefix, and only rows of exactly that context are its own.
      const context = heldContextOf(personId, fieldId);
      const page = await port.list(context, after);
      return page === null
        ? null
        : {
            ...page,
            copies: page.copies.filter((row) => row.form_context === context),
          };
    },
  };
}
