import type {
  ConditionalFormPort,
  FormCopiesPage,
  FormCopyCursor,
  FormRecoveryRow,
  HandOff,
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
 *
 * DURABLE AUTHORITY AND OUTCOMES (review 4 of 23 October 2026, findings 1–3; the third design assessment's C7–C10). What may run, and
 * what already happened, are never inferred from which copies are still live:
 *
 *  - Each field has a HEAD (`HeldHead`: a terminal row `~head` of the field's context, so it is never listed, restored or counted as
 *    unsynced work): the field's generation and its CURRENT hold. A hold and the head that makes it current are written in ONE
 *    transaction (`create`, through the port's `apply`); the head never goes back, so ending, retiring or handing off the current hold
 *    never makes an earlier one current again. Only the head's current hold may run.
 *  - An ended hold keeps a TOMBSTONE (`HeldTombstone`): its generation and WHY it ended (`discarded`, `replaced`, `forgotten`, or
 *    `transferred` to the outbox under its local id). A hand-off ends the copy in the same transaction as its draft is written (`handOffOf`,
 *    the outbox's `HandOff`), so it is never queued twice, whatever Sync does with the draft afterwards.
 *  - Copies of the earlier shapes (v 1–3) are LEGACY: they were written before heads and tombstones, so whether they were already queued
 *    and discarded in Sync, or replaced by a hold that has since ended, cannot be known. They are kept, shown and discardable, never run,
 *    never written again and never retired automatically.
 *
 * THE SAVE ITS CONTENT WAS TYPED OVER (WEB-11a review 12, R12.1; v 5). The edit's content follows the field's newest outstanding save as
 * the editor showed it, or nothing. A hold keeps that binding (`predecessor`), and its content step is queued only while that save is
 * stored with exactly that body (`EnqueueRequest.expectPredecessor`, judged in the hand-off's own transaction). A v 4 copy never recorded
 * it: its binding is `unknown`, which is never guessed from what is queued now and never taken as consent. Such a hold is kept and shown
 * with its value and attempt, never sent (automatically, by "Send now" or by "Try again"), and the person reviews the field and saves it
 * again (a new hold replaces it) or discards it (the decision of 24 October 2026,
 * `delivery/handoffs/web11a-v4-held-review-before-send-20261024.md`).
 */
export const HELD_FORM = "people-held:";
/** The tab id of a field's head row (sorts after every hold id: hold ids are UUIDs). */
export const HEAD_TAB = "~head";

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
  | "not_saved"
  /** The save the content was typed over is not known (a v 4 copy): it is reviewed, never sent (review 12). */
  | "needs_review";

/**
 * The save a hold's content was typed over (review 12, R12.1): its local id and the digest of its body as the editor showed it; `null`
 * when nothing was outstanding (the base guard alone decides); `unknown` for a copy that never recorded it (v 4).
 */
export type HeldPredecessor =
  | { localId: string; digest: string }
  | null
  | "unknown";

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
  /** The save the content follows, as the editor showed it (`EnqueueRequest.expectPredecessor`); `unknown` is never sent. */
  predecessor: HeldPredecessor;
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
  /** Read from an earlier shape (v 1–3, before heads and tombstones): kept and discardable, never run or written again. Never stored. */
  legacy: boolean;
}

/** Why a hold ended (its tombstone), or null for a copy ended before tombstones (its fields were cleared). */
export type HeldEndCause =
  | "discarded"
  | "replaced"
  | "transferred"
  | "forgotten";

export interface HeldTombstone {
  /** The ended hold's generation, or null when not known (an unreadable copy, or an end before tombstones). */
  seq: number | null;
  cause: HeldEndCause | null;
  /** `transferred`: the local id its content was queued under. */
  localId: string | null;
}

/** A field's head: its generation and its current hold, with the digest of the stored row (the only state a create may replace). */
export interface HeldHead {
  seq: number;
  current: string;
  digest: string;
}

export type HeadRead =
  | { kind: "head"; head: HeldHead }
  /** No hold of this field was ever made by this shape: its holds (if any) are legacy. */
  | { kind: "none" }
  /** The head could not be read, or cannot be understood: nothing about the field's current hold is known. */
  | { kind: "failed" };

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
  | { kind: "ended"; tombstone: HeldTombstone }
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
  "needs_review",
]);

/** A stored binding (v 5): `null`, `"unknown"` or the save's id and digest; anything else is not one (the copy is unreadable). PURE. */
function parsePredecessor(raw: unknown): HeldPredecessor | undefined {
  if (raw === null || raw === "unknown") return raw;
  return isObject(raw) &&
    typeof raw.localId === "string" &&
    raw.localId !== "" &&
    typeof raw.digest === "string" &&
    raw.digest !== ""
    ? { localId: raw.localId, digest: raw.digest }
    : undefined;
}

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
  if (
    !isObject(raw) ||
    (raw.v !== 1 && raw.v !== 2 && raw.v !== 3 && raw.v !== 4 && raw.v !== 5)
  )
    return null;
  // The first shape (v 1) had no state number and no content admission: it is read as state 0, not admitted. Neither it nor v 2 had a
  // generation or a retirement: generation 0, live. v 4 and v 5 have no content admission (a hand-off is one commit with its draft).
  // Only v 5 records the save the content was typed over; before it, that is not known (never guessed).
  const current = raw.v === 4 || raw.v === 5;
  const rev = raw.v === 1 ? 0 : raw.rev;
  const queued = raw.v === 1 || current ? false : raw.queued;
  const seq = raw.v === 3 || current ? raw.seq : 0;
  const retired = raw.v === 3 || current ? raw.retired : false;
  const predecessor =
    raw.v === 5 ? parsePredecessor(raw.predecessor) : "unknown";
  if (
    predecessor === undefined ||
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
    predecessor,
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
    legacy: !current,
  };
}

/** The form copy's text of a held change. PURE. */
export function encodeHeld(change: HeldChange): Record<string, string> {
  return {
    held: JSON.stringify({
      v: 5,
      rev: change.rev,
      seq: change.seq,
      retired: change.retired,
      fieldId: change.fieldId,
      personId: change.personId,
      label: change.label,
      value: change.value,
      sameKind: change.sameKind,
      version: change.version,
      expectedBase: change.expectedBase,
      predecessor: change.predecessor,
      from: change.from,
      to: change.to,
      attempt: change.attempt,
      failed: change.status.kind === "failed" ? change.status.reason : null,
      heldAt: change.heldAt,
    }),
  };
}

const CAUSES: ReadonlySet<string> = new Set<HeldEndCause>([
  "discarded",
  "replaced",
  "transferred",
  "forgotten",
]);

/** The fields an ended hold keeps. PURE. */
export const encodeTombstone = (
  seq: number | null,
  cause: HeldEndCause,
  localId: string | null = null,
): Record<string, string> => ({
  held_end: JSON.stringify({ v: 1, seq, cause, localId }),
});

/** What an ended copy's fields say; an end before tombstones (cleared fields) or one this page cannot read says nothing. PURE. */
export function decodeTombstone(fields: Record<string, string>): HeldTombstone {
  const unknown: HeldTombstone = { seq: null, cause: null, localId: null };
  const text = fields.held_end;
  if (typeof text !== "string") return unknown;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return unknown;
  }
  if (!isObject(raw) || raw.v !== 1) return unknown;
  return {
    seq: isVersion(raw.seq) ? raw.seq : null,
    cause:
      typeof raw.cause === "string" && CAUSES.has(raw.cause)
        ? (raw.cause as HeldEndCause)
        : null,
    localId: typeof raw.localId === "string" ? raw.localId : null,
  };
}

const encodeHead = (seq: number, current: string): Record<string, string> => ({
  held_head: JSON.stringify({ v: 1, seq, current }),
});

/** A field's head from its row's fields, or null when they cannot be understood. PURE. */
export function decodeHead(
  fields: Record<string, string>,
  digest: string,
): HeldHead | null {
  const text = fields.held_head;
  if (typeof text !== "string") return null;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  return isObject(raw) &&
    raw.v === 1 &&
    isVersion(raw.seq) &&
    typeof raw.current === "string"
    ? { seq: raw.seq, current: raw.current, digest }
    : null;
}

/**
 * The outbox HAND-OFF of a hold's content (review 4, finding 1): the hold's copy, live exactly as `copy` was read, ends as `transferred`
 * (with the local id) in the same transaction as its draft is written, and only while the field's head is still `head`. PURE.
 */
export const handOffOf = (copy: HeldCopy, head: HeldHead): HandOff => ({
  source: {
    formContext: heldContextOf(copy.change.personId, copy.change.fieldId),
    tabInstanceId: copy.change.holdId,
    digest: copy.digest,
  },
  tombstone: encodeTombstone(
    copy.change.seq,
    "transferred",
    copy.change.holdId,
  ),
  also: [
    {
      formContext: heldContextOf(copy.change.personId, copy.change.fieldId),
      tabInstanceId: HEAD_TAB,
      terminal: true,
      digest: head.digest,
    },
  ],
});

/**
 * The held changes of the displayed account (production: the CONDITIONAL port over the account's database). Every answer is typed and
 * none is inferred: `create` writes a hold whose copy must not exist yet; `update` writes the next state of the one read as `from` (its
 * `rev` is `from`'s plus one and its `seq` is `from`'s, whatever `next` says; a retired hold stays retired); `end` makes the copy read as `digest` terminal; `read` says what is stored; `list` is
 * one bounded, resumable page of a person's (or one field's) holds, or null when it could not be read.
 */
export interface HeldStore {
  /**
   * CREATE AND PROMOTE: the new hold (whose copy must not exist yet) and its field's head (`seq` = the hold's, `current` = the hold) in ONE
   * transaction, only while the head is exactly `head` (null: the field has none yet). `changed` otherwise; nothing written.
   */
  create(change: HeldChange, head: HeldHead | null): Promise<HeldWrite>;
  /** The next state. A legacy copy is only ever RETIRED (its content cleared, its attempt kept); any other write of one is `failed`. */
  update(from: HeldCopy, next: HeldChange): Promise<HeldWrite>;
  /** Ends the copy read as `digest`, keeping its tombstone (`seq`: its generation, when known). */
  end(
    hold: HeldKey,
    digest: string,
    cause: HeldEndCause,
    seq?: number | null,
  ): Promise<HeldEnd>;
  read(hold: HeldKey): Promise<HeldRead>;
  /** The field's head. */
  head(personId: string, fieldId: string): Promise<HeadRead>;
  list(
    personId: string,
    fieldId: string | null,
    after: FormCopyCursor | null,
  ): Promise<FormCopiesPage | null>;
  /** This store bound to the account service displayed now (one per operation: a later call under another binding fails). */
  pinned(): HeldStore;
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
  const headKey = (personId: string, fieldId: string) =>
    [heldContextOf(personId, fieldId), HEAD_TAB] as const;
  return {
    create: async (change, head) => {
      const [context, tab] = headKey(change.personId, change.fieldId);
      const savedAt = now();
      const answer = await port.apply([
        {
          snapshot: {
            formContext: context,
            tabInstanceId: change.holdId,
            values: encodeHeld(change),
            savedAt,
          },
          terminal: false,
          expect: { state: "absent" },
        },
        {
          snapshot: {
            formContext: context,
            tabInstanceId: tab,
            values: encodeHead(change.seq, change.holdId),
            savedAt,
          },
          terminal: true,
          expect:
            head === null
              ? { state: "absent" }
              : { state: "ended", digest: head.digest },
        },
      ]);
      if (answer.kind === "saved")
        return {
          kind: "saved",
          copy: {
            change: { ...change, legacy: false },
            digest: answer.digests[0] as string,
          },
        };
      return answer.kind === "changed"
        ? { kind: "changed", stored: answer.stored }
        : answer;
    },
    update: (from, next) =>
      from.change.legacy && !next.retired
        ? Promise.resolve({ kind: "failed" })
        : write(
            {
              ...next,
              holdId: from.change.holdId,
              personId: from.change.personId,
              fieldId: from.change.fieldId,
              rev: from.change.rev + 1,
              // A hold keeps its place among its field's holds; a retired one is never live again.
              seq: from.change.seq,
              retired: from.change.retired || next.retired,
              legacy: false,
            },
            from.digest,
          ),
    end: (hold, digest, cause, seq = null) =>
      port.end(
        heldContextOf(hold.personId, hold.fieldId),
        hold.holdId,
        digest,
        encodeTombstone(seq, cause),
      ),
    read: async (hold) => {
      const stored = await port.read(
        heldContextOf(hold.personId, hold.fieldId),
        hold.holdId,
      );
      if (stored.kind === "ended")
        return { kind: "ended", tombstone: decodeTombstone(stored.fields) };
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
    head: async (personId, fieldId) => {
      const [context, tab] = headKey(personId, fieldId);
      const stored = await port.read(context, tab);
      if (stored.kind === "absent") return { kind: "none" };
      if (stored.kind !== "ended") return { kind: "failed" };
      const head = decodeHead(stored.fields, stored.digest);
      return head === null ? { kind: "failed" } : { kind: "head", head };
    },
    pinned: () => heldStoreOver(port.pinned(), now),
  };
}
