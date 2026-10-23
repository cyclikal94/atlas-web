import type { CacheRow, EnqueueOutcome, Outbox, Policy } from "../../../data";
import { canonicalBody, samePolicy, untilSent } from "../../sharing";
import {
  applyPolicyChange,
  policyChangeCommands,
} from "../../sharing/apply-policy-change";
import type { PeopleEnv } from "../env";
import { type HeldRun, isCurrentMemory, notePolicy } from "../memory";
import type { Attempt } from "../model/attempt";
import { baseGuard, putFieldUpdateRequest } from "../model/commands";
import { sentSomething } from "../online";
import {
  type HeldChange,
  type HeldCopy,
  type HeldEnd,
  type HeldFailure,
  type HeldKey,
  type HeldStore,
  type HeldWrite,
  handOffOf,
  heldOf,
} from "./held-store";

/**
 * Runs ONE held audience change (D-11a-12; WF-PEOPLE-03 "Hold it as a draft until I'm online"): the audience first, then the content.
 * The caller holds the field's lock (one run of the field's holds at a time, in every page of the browser) for the WHOLE run, including
 * its last durable write: nothing here lets go of it before the outcome is committed. Every store call of the run goes through ONE binding
 * taken at its start (`HeldStore.pinned`, review 4 C10): once another account or database is displayed, nothing more is written.
 *
 * THE DURABLE STATE GOVERNS (review 2 of 22 October 2026, finding 2; review 4 of 23 October 2026, findings 1–3). The run begins by READING
 * the hold again under the lock and runs only if the stored state is exactly the one the page showed (`shown.digest`) and the field's
 * HEAD names it as the field's current hold (review 4 finding 2: the head never goes back, so an earlier hold never becomes current again
 * when a later one ends; it is retired instead, never run). Every step is a CONDITIONAL write of the next state (`HeldStore.update`, from
 * the last state this run read or wrote), and the run stops on any answer but `saved`, without claiming anything it did not commit:
 *
 *  1. The field must still be the one the edit began on (else `content_changed`, or `gone` when it is no longer on this device).
 *  2. The policy change, through the sharing slice (`applyPolicyChange`: read, version guard against the policy shown, one replace_policy,
 *     confirming read). Its EXACT attempt is written to the hold BEFORE it may be sent (`admit`), so an end of the hold after that point
 *     says the audience may already have changed. The confirmed audience (or the attempt still uncertain) is written after it.
 *  3. The field is checked again, and the content is HANDED OFF to the outbox (review 4 finding 1; the assessment's C8): the draft
 *     (`expected_policy_version` = the CONFIRMED policy version, Q1; the hold's id as its local id; its base guarded inside the outbox
 *     transaction) and the end of the hold's copy (`transferred`) are ONE transaction, only while the copy and the field's head are as this
 *     run read them. Nothing is queued unless the hold ends with it, and once it has ended nothing can queue it again: a lost answer is
 *     read back from the copy's own tombstone, never retried, whatever Sync did with the draft since (edited, discarded, superseded, sent).
 *
 * STOPPING IS NOT DISCARDING (review 3 of 22 October 2026, finding 1). Two different things stop a run at its admission boundaries (after
 * the policy read, before the policy write, before the content step and inside its writing transaction):
 *
 *  - `run.cancelled`: the person discarded the hold in THIS page while it ran. The run ends it there (`discardHold`: a terminal write, or a
 *    reconciliation record when its policy step may have been made) and says truthfully what was already done.
 *  - Losing the page: the row unmounted (navigation, another page of the held list) or another identity is displayed. The run only STOPS
 *    (`suspended`): nothing is ended, its input stays exactly as stored, an admitted attempt and its answer are written as progress (under
 *    the same identity only). It runs again where it may (D1: in the page whose authority it has, or after "Send now").
 *
 * A discard in ANOTHER page is a conditional write from the state that page showed: before an admission it wins and this run's next
 * write (or its hand-off) is refused (`changed`, nothing more is sent or queued); after one it is told what may already have happened. A
 * policy step that was confirmed cannot be taken back; the run says so.
 */
export type HeldResult =
  /** The content is queued and the hold's copy ended with it (one commit; `ended` is always true). */
  | { kind: "done"; ended: boolean }
  /** Not sent (offline, held back, closing): the hold is as it was. */
  | { kind: "waiting" }
  /** `kept`: the failure is written to the hold; otherwise it is this page's only (the store refused or failed). */
  | { kind: "failed"; reason: HeldFailure; kept: boolean }
  /**
   * Discarded while it ran, here or in another page. `policy`: the audience step was confirmed (`done`), may have been made (`maybe`),
   * or was never sent (`none`). `ended`: the hold's content is gone (its copy is terminal, by this run or another page, or `retired`: kept
   * as a reconciliation record of its unresolved attempt); otherwise it is still kept.
   */
  | {
      kind: "cancelled";
      policy: "none" | "maybe" | "done";
      ended: boolean;
      retired: boolean;
      /** The policy attempt that may have been sent (kept durably by the reconciliation record), or null. */
      attempt: Attempt | null;
    }
  /**
   * This page stopped running it (its row is no longer shown, or another identity is): NOTHING was ended. The hold is kept as it was last
   * written, with any attempt and progress of its policy step; it runs again only where it may (D1).
   */
  | { kind: "suspended" }
  /**
   * The field's head names another hold as its current one: this one did not run. `ended`/`retired` as for `cancelled` (it was retired as
   * that hold's predecessor), or neither when that write was not committed (it stays, and never runs).
   */
  | { kind: "superseded"; ended: boolean; retired: boolean }
  /** The stored hold is not the one the page showed (moved on elsewhere, a reconciliation record, a legacy copy): nothing was done. */
  | { kind: "stale" };

export interface HeldDeps {
  /** The field as the cache shows it NOW (a direct read of that one row), or null when it is not on this device. */
  current(): CacheRow | null;
  /** The hold's row is still shown on this page (navigating away, or to another page of the held list, STOPS the run; it never ends it). */
  mounted(): boolean;
  enqueue(
    run: (outbox: Outbox) => Promise<EnqueueOutcome>,
  ): Promise<
    { ok: true; localId: string } | { ok: false; message: string | null }
  >;
}

/**
 * What a hold's stored state says was already done: the field's audience is already the one asked for (`done`: established by this
 * hold's run, which is what its content step needs; it says nothing about WHO changed it), its attempt may have been made (`maybe`: an
 * attempt was admitted and has no definite answer), or none was sent (`none`); `content`: a LEGACY copy's content step was admitted (its
 * draft may be queued). PURE.
 */
export function progressOf(change: HeldChange): {
  policy: "none" | "maybe" | "done";
  content: boolean;
} {
  return {
    policy: samePolicy(change.from.policy, change.to)
      ? "done"
      : change.attempt !== null
        ? "maybe"
        : "none",
    content: change.queued,
  };
}

/** The lock of one field's holds: one run of them at a time in the whole browser (a replacement hold has another id, the same field). */
export const lockOf = (
  env: Pick<PeopleEnv, "accountId">,
  fieldId: string,
): string => `atlas-people-held:${env.accountId}:${fieldId}`;

export const keyOf = (change: HeldChange): HeldKey => ({
  personId: change.personId,
  fieldId: change.fieldId,
  holdId: change.holdId,
});

/**
 * Settling one hold: `ended` (terminal), `retired` (kept as a reconciliation record), `kept` (a reconciliation record that automatic
 * cleanup leaves as it is), or why nothing was written.
 */
export type HeldSettle =
  | HeldEnd
  | { kind: "retired"; copy: HeldCopy }
  | { kind: "kept" };

/** Whether the hold's content is gone after `answer` (ended or retired here, or already ended by another page). PURE. */
export const isSettled = (answer: HeldSettle): boolean =>
  answer.kind === "ended" ||
  answer.kind === "retired" ||
  (answer.kind === "changed" && answer.stored !== "live");

/** `copy`'s policy attempt may have been made and nothing else here keeps it: `carrier` is a hold that carries the same key and body. */
const unresolvedIn = (copy: HeldCopy, carrier: HeldChange | null): boolean => {
  const attempt = copy.change.attempt;
  return (
    attempt !== null &&
    progressOf(copy.change).policy === "maybe" &&
    !(
      carrier?.attempt?.key === attempt.key &&
      carrier.attempt.body === attempt.body
    )
  );
};

/** Retires `copy` (content cleared, attempt, audience asked for and guard kept), from the state it was read in. */
async function retire(store: HeldStore, copy: HeldCopy): Promise<HeldSettle> {
  const written = await store.update(copy, {
    ...copy.change,
    retired: true,
    value: { kind: "text", text: "" },
    status: { kind: "waiting" },
  });
  return written.kind === "saved"
    ? { kind: "retired", copy: written.copy }
    : written;
}

/**
 * The person DISCARDED a hold's content (review 3, C3c; review 4 finding 3: three different transitions, never one generic end). It ENDS
 * (`discarded`), unless its policy step may have been made: then it is RETIRED, a reconciliation record that keeps the attempt, the
 * audience asked for and its guard, with the content cleared, never run.
 */
export function discardHold(
  store: HeldStore,
  copy: HeldCopy,
): Promise<HeldSettle> {
  return unresolvedIn(copy, null)
    ? retire(store, copy)
    : store.end(keyOf(copy.change), copy.digest, "discarded", copy.change.seq);
}

/** The person chose "Discard" on ONE reconciliation record: only that record ends (`forgotten`); nothing else is touched. */
export const forgetRecord = (
  store: HeldStore,
  copy: HeldCopy,
): Promise<HeldEnd> =>
  store.end(keyOf(copy.change), copy.digest, "forgotten", copy.change.seq);

/**
 * AUTOMATIC cleanup of an earlier hold that `successor` (the field's current hold) replaced: housekeeping, never authority (the head
 * already decided), and never a way to forget an unresolved attempt (review 4 finding 3). A reconciliation record is KEPT as it is,
 * unless the successor carries its exact attempt; a live hold whose attempt is unresolved and not carried is retired; anything else ends
 * (`replaced`). `successor` null: the replacing hold is not known here (nothing is taken to be carried).
 */
export function retireForReplacement(
  store: HeldStore,
  copy: HeldCopy,
  successor: HeldChange | null,
): Promise<HeldSettle> {
  const carried = !unresolvedIn(copy, successor);
  if (copy.change.retired && !carried) return Promise.resolve({ kind: "kept" });
  return !copy.change.retired && !carried
    ? retire(store, copy)
    : store.end(keyOf(copy.change), copy.digest, "replaced", copy.change.seq);
}

/** The bound on the pages one read of a field's holds makes (each at most 1,000 rows): beyond it the field's holds are not known. */
const FIELD_PAGES = 10;

/** Every live hold of one field (and the ids of copies this page cannot read). */
interface FieldHolds {
  holds: HeldCopy[];
  unreadable: string[];
}

/**
 * Every live hold of ONE field, through bounded, resumable reads of the field's own copies (never a display page), or null when they
 * could not all be read (a page failed, or more than the bound). Never authority: who is current is the head's to say.
 */
async function holdsOf(
  store: HeldStore,
  personId: string,
  fieldId: string,
): Promise<FieldHolds | null> {
  const holds: HeldCopy[] = [];
  const unreadable: string[] = [];
  let after: Parameters<HeldStore["list"]>[2] = null;
  for (let page = 0; page < FIELD_PAGES; page += 1) {
    const read = await store.list(personId, fieldId, after);
    if (read === null) return null;
    for (const row of read.copies) {
      const copy = heldOf(row);
      if (
        copy === null ||
        copy.change.personId !== personId ||
        copy.change.fieldId !== fieldId
      )
        unreadable.push(row.tab_instance_id);
      else holds.push(copy);
    }
    if (read.next === null) return { holds, unreadable };
    after = read.next;
  }
  return null;
}

/**
 * Retires every other hold of `field` as `winner`'s predecessor (`winner` is the field's current hold: the head names it), each from the
 * state it was read in, and tells this page's memory (they never run here; an ended one is not shown while the list catches up).
 * Reconciliation records that the winner does not carry are kept as they are; LEGACY copies and copies this page cannot read are kept.
 * True when no earlier hold is left (a kept record is not a hold).
 */
async function retireEarlier(
  env: PeopleEnv,
  store: HeldStore,
  winner: HeldChange,
  field: FieldHolds,
): Promise<boolean> {
  const memory = env.memory;
  let complete = field.unreadable.length === 0;
  for (const earlier of field.holds) {
    const change = earlier.change;
    if (change.holdId === winner.holdId) continue;
    if (change.legacy) {
      complete = false;
      continue;
    }
    const settled = await retireForReplacement(store, earlier, winner);
    if (settled.kind === "kept") continue;
    if (!isSettled(settled)) {
      complete = false;
      continue;
    }
    memory.heldAuthority.delete(change.holdId);
    if (settled.kind !== "retired") memory.heldEnded.add(change.holdId);
  }
  if (isCurrentMemory(memory)) memory.touch();
  return complete;
}

export async function runHeldChange(
  env: PeopleEnv,
  shown: HeldCopy,
  run: HeldRun,
  deps: HeldDeps,
): Promise<HeldResult> {
  const memory = env.memory;
  const store = env.held.pinned();
  const key = keyOf(shown.change);
  /** This page still runs it: its identity is the one displayed and its row is shown. */
  const present = () => isCurrentMemory(memory) && deps.mounted();
  const owns = () => !run.cancelled && present();
  /** The last state this run read or wrote: the only one its next write may replace. */
  let copy = shown;
  let refusal: HeldWrite | null = null;
  const write = async (next: HeldChange): Promise<boolean> => {
    const answer = await store.update(copy, next);
    if (answer.kind === "saved") {
      copy = answer.copy;
      return true;
    }
    refusal = answer;
    return false;
  };
  /** Why the hold is not stored as this run last read or wrote it, as a refused write (or null: it is). */
  const differs = (
    now: Awaited<ReturnType<HeldStore["read"]>>,
  ): HeldWrite | null =>
    now.kind === "live" && now.copy.digest === copy.digest
      ? null
      : now.kind === "failed"
        ? { kind: "failed" }
        : {
            kind: "changed",
            stored:
              now.kind === "live" || now.kind === "unreadable"
                ? "live"
                : now.kind,
          };
  /** The hold is still stored exactly as this run last read or wrote it (a check with no write), else why not (as a refused write). */
  const unchanged = async (): Promise<boolean> => {
    refusal = differs(await store.read(key));
    return refusal === null;
  };
  const policyState = (): "none" | "maybe" | "done" =>
    run.policyDone ? "done" : progressOf(copy.change).policy;
  /** Discarded in this page: the hold is retired from the state this run holds, and what happened before is said truthfully. */
  const cancel = async (): Promise<HeldResult> => {
    // A policy step this run saw confirmed is resolved (whatever is stored yet): the hold simply ends.
    const settled = run.policyDone
      ? await store.end(key, copy.digest, "discarded", copy.change.seq)
      : await discardHold(store, copy);
    return {
      kind: "cancelled",
      policy: policyState(),
      ended: isSettled(settled),
      retired: settled.kind === "retired",
      attempt: copy.change.attempt,
    };
  };
  /** Stopped at a boundary: retired only when the person discarded it here; losing the page (or the identity) keeps it as it is. */
  const stop = (): Promise<HeldResult> | HeldResult =>
    run.cancelled && isCurrentMemory(memory) ? cancel() : { kind: "suspended" };
  /** A write was refused: by another page's end (cancelled there), by another state (stale), or by the store (not saved). */
  const refused = (): HeldResult => {
    const answer = refusal as HeldWrite | null;
    if (answer?.kind === "changed")
      return answer.stored === "live"
        ? { kind: "stale" }
        : {
            kind: "cancelled",
            policy: policyState(),
            ended: true,
            retired: false,
            attempt: copy.change.attempt,
          };
    return { kind: "failed", reason: "not_saved", kept: false };
  };
  const fail = async (reason: HeldFailure): Promise<HeldResult> => {
    const kept = await write({
      ...copy.change,
      status: { kind: "failed", reason },
    });
    return kept || refusal?.kind !== "changed"
      ? { kind: "failed", reason, kept }
      : refused();
  };
  const bound = (): HeldFailure | null => {
    const current = deps.current();
    if (current === null) return "gone";
    if (current.version !== copy.change.version) return "content_changed";
    return null;
  };

  // The authoritative state, read under the lock: only the hold the page showed is run.
  const stored = await store.read(key);
  if (stored.kind === "failed")
    return { kind: "failed", reason: "not_saved", kept: false };
  if (stored.kind === "unreadable" || stored.kind === "absent")
    return { kind: "stale" };
  if (stored.kind === "ended")
    // Handed off already (an earlier run whose answer was lost): it is done, and never queued again.
    return stored.tombstone.cause === "transferred"
      ? { kind: "done", ended: true }
      : {
          kind: "cancelled",
          policy: "none",
          ended: true,
          retired: false,
          attempt: null,
        };
  if (
    stored.copy.digest !== shown.digest ||
    stored.copy.change.retired ||
    stored.copy.change.legacy
  )
    return { kind: "stale" };
  copy = stored.copy;
  if (!owns()) return stop();
  // Only the field's CURRENT hold runs (review 4, finding 2): the head names it, and it never goes back.
  const headRead = await store.head(key.personId, key.fieldId);
  if (headRead.kind === "failed")
    return { kind: "failed", reason: "not_saved", kept: false };
  // A hold of this shape is always written with its head: without one, nothing says it may run.
  if (headRead.kind === "none") return { kind: "stale" };
  const head = headRead.head;
  if (head.current !== key.holdId) {
    const settled = await retireForReplacement(store, copy, null);
    if (isSettled(settled)) {
      memory.heldAuthority.delete(key.holdId);
      if (settled.kind !== "retired") memory.heldEnded.add(key.holdId);
    }
    return {
      kind: "superseded",
      ended: isSettled(settled),
      retired: settled.kind === "retired",
    };
  }
  // The current hold: anything earlier of its field that a replacement left (a page closed in between, a refused write) is retired now.
  // Housekeeping only: a field whose holds cannot all be read is cleaned up by a later run.
  const field = await holdsOf(store, key.personId, key.fieldId);
  if (field !== null) await retireEarlier(env, store, copy.change, field);
  if (!owns()) return stop();
  const before = bound();
  if (before !== null) return fail(before);

  // Already confirmed by an earlier run whose content step was not saved: only the content step remains (still guarded by Q1).
  if (!samePolicy(copy.change.from.policy, copy.change.to)) {
    const held = copy.change;
    const outcome = await applyPolicyChange(
      { api: env.sharing, newId: env.newId },
      {
        resourceId: held.fieldId,
        from: held.from,
        to: held.to,
        attempt: held.attempt,
        isCurrent: owns,
        // The exact attempt is durable before it may be sent; the same one again (a retry) already is, and is sent only while the hold is
        // still stored as this run read it (review 3, H7: a discard elsewhere before this point wins, as it does against a write).
        admit: async (attempt) =>
          owns() &&
          (copy.change.attempt?.key === attempt.key &&
          copy.change.attempt.body === attempt.body
            ? await unchanged()
            : await write({ ...copy.change, attempt })) &&
          owns(),
      },
    );
    if (refusal !== null) return refused();
    const result = outcome.result;
    // A command was sent (whatever its answer said): the summaries shown are read again.
    if (isCurrentMemory(memory) && sentSomething(result))
      memory.invalidateSummaries();
    if (result.ok) {
      run.policyDone = true;
      if (isCurrentMemory(memory))
        notePolicy(memory, held.fieldId, {
          version: result.policyVersion,
          policy: held.to,
          checkedAt: env.now(),
        });
    }
    // Another identity is displayed: this page writes nothing more (the attempt was durable before it could be sent).
    if (!isCurrentMemory(memory)) return { kind: "suspended" };
    // Discarded here meanwhile: the hold is retired from what is stored; what was already done is said.
    if (run.cancelled) return cancel();
    // The audience is now the one asked for (a later run must not change it again), or the attempt still uncertain is kept: written
    // also when the row is no longer shown, so what was done is never lost with the page.
    const progressed = await write({
      ...copy.change,
      ...(result.ok
        ? {
            from: { version: result.policyVersion, policy: held.to },
            attempt: null,
          }
        : { attempt: outcome.attempt }),
    });
    if (!progressed) return refused();
    if (!owns()) return stop();
    if (!result.ok) {
      switch (result.kind) {
        case "offline":
        case "not_sent":
        case "closed":
          return { kind: "waiting" };
        case "changed":
        case "conflict":
        case "forbidden":
        case "uncertain":
          return fail(result.kind);
        default:
          return fail("changed");
      }
    }
  }
  // The policy step may have taken long: the content must still be the one the edit began on.
  const after = bound();
  if (after !== null) return fail(after);
  if (!owns()) return stop();
  // The HAND-OFF: the draft and the end of this copy are one commit, only while the copy and the field's head are as read here.
  const held = copy.change;
  const guard = baseGuard(held.expectedBase);
  const request = putFieldUpdateRequest({
    fieldId: held.fieldId,
    personId: held.personId,
    label: held.label,
    value: held.value,
    policyVersion: held.from.version,
    sameKind: held.sameKind,
    guard,
  });
  let refusedByOwner = false;
  const saved = await deps.enqueue((outbox) =>
    outbox.enqueue(
      {
        ...request,
        localId: held.holdId,
        build: (bases) => {
          // The last admission boundary, inside the writing transaction: a hold discarded or left here meanwhile queues nothing.
          if (!owns()) {
            refusedByOwner = true;
            throw new Error("the held change is no longer owned by this run");
          }
          return request.build(bases);
        },
      },
      handOffOf(copy, head),
    ),
  );
  if (saved.ok) return { kind: "done", ended: true };
  // Not queued, or its answer was lost: the copy's own state says which (a committed hand-off ended it as `transferred`).
  const now = await store.read(key);
  if (now.kind === "ended" && now.tombstone.cause === "transferred")
    return { kind: "done", ended: true };
  refusal = differs(now);
  if (refusal !== null) return refused();
  if (refusedByOwner) return stop();
  return fail(guard.moved ? "content_changed" : "not_saved");
}

/** `earlier` keeps an unresolved attempt of exactly the change from policy version `from` to `to` (its body included). PURE. */
const unresolvedFor = (earlier: HeldChange, from: number, to: Policy) =>
  earlier.attempt !== null &&
  progressOf(earlier).policy === "maybe" &&
  earlier.from.version === from &&
  samePolicy(earlier.to, to) &&
  earlier.attempt.body ===
    canonicalBody(policyChangeCommands(earlier.fieldId, from, to));

/** What `heldAttemptOf` found. */
export type AttemptLookup =
  | { kind: "found"; attempt: Attempt }
  /** Every hold of the field was read, and none keeps an unresolved attempt of this change. */
  | { kind: "none" }
  /** The holds could not all be read (a failed or bounded read, a copy this page cannot read), or two different attempts match. */
  | { kind: "unknown" };

/**
 * The unresolved attempt a hold of this field on this device (a kept hold or a reconciliation record) carries for EXACTLY the change from
 * policy version `from` to `to`, for a direct change of the field's audience (the same key and body, never a second attempt beside it).
 * A read that could not establish it is `unknown`, never `none` (review 4; the assessment's C9): a fresh key is never made for a change
 * whose earlier attempt may exist.
 */
export async function heldAttemptOf(
  env: PeopleEnv,
  personId: string,
  fieldId: string,
  from: number,
  to: Policy,
): Promise<AttemptLookup> {
  const field = await holdsOf(env.held, personId, fieldId);
  if (field === null || field.unreadable.length > 0) return { kind: "unknown" };
  const found = new Map<string, Attempt>();
  for (const { change } of field.holds)
    if (unresolvedFor(change, from, to) && change.attempt !== null)
      found.set(change.attempt.key, change.attempt);
  const [first, ...others] = [...found.values()];
  if (first === undefined) return { kind: "none" };
  return others.length === 0
    ? { kind: "found", attempt: first }
    : { kind: "unknown" };
}

/** What `holdChange` did. */
export type HoldOutcome =
  /** Kept, as its field's current hold. `complete`: no earlier hold of the field is left; otherwise some are still kept (said). */
  | { kind: "held"; copy: HeldCopy; complete: boolean }
  /** The field's lock is taken (a run of its holds, another page's hold): nothing was written, and the editor keeps the edit. */
  | { kind: "busy" }
  /** Nothing was kept: `refused` while signing out (D-16); otherwise the store failed, or the field's head or holds could not be read. */
  | { kind: "failed"; refused: boolean }
  /** The field's head or the new copy changed under it (another page): nothing was written, and the editor keeps the edit. */
  | { kind: "changed" };

/**
 * "Hold as draft" (D-11a-12): ONE operation of the field, under the field's lock (review 3 of 22 October 2026, finding 2), through ONE
 * binding (`pinned`).
 *
 *  1. The field's head and every live hold of the field are read (bounded; an incomplete read keeps nothing new).
 *  2. CREATE AND PROMOTE (review 4, finding 2): the new hold and the field's head naming it, at the next generation, are ONE transaction,
 *     only while the head is as read. From this commit it is the field's current hold, and no earlier one can ever run again, whatever
 *     follows (a closed page, a refused cleanup, the new hold itself ending later: the head never goes back). An unresolved attempt of an
 *     earlier hold of exactly this change is carried over in the same write.
 *  3. Earlier holds are retired as housekeeping (`retireForReplacement`): reconciliation records it does not carry are kept as they are.
 *
 * The page's authority to run it (D1) is the caller's to give, after this answers `held`.
 */
export async function holdChange(
  env: PeopleEnv,
  change: Omit<HeldChange, "seq" | "retired" | "attempt" | "legacy">,
): Promise<HoldOutcome> {
  const store = env.held.pinned();
  const answer = await env.exclusive(
    lockOf(env, change.fieldId),
    async (): Promise<HoldOutcome> => {
      const headRead = await store.head(change.personId, change.fieldId);
      if (headRead.kind === "failed") return { kind: "failed", refused: false };
      const field = await holdsOf(store, change.personId, change.fieldId);
      if (field === null) return { kind: "failed", refused: false };
      const head = headRead.kind === "head" ? headRead.head : null;
      // Above the head and above every copy still kept (a field's first head comes after its legacy copies).
      const seq =
        field.holds.reduce(
          (top, copy) => Math.max(top, copy.change.seq),
          head?.seq ?? 0,
        ) + 1;
      if (!Number.isSafeInteger(seq)) return { kind: "failed", refused: false };
      const taken = field.holds.find(({ change: earlier }) =>
        unresolvedFor(earlier, change.from.version, change.to),
      );
      const created = await store.create(
        {
          ...change,
          attempt: taken?.change.attempt ?? null,
          seq,
          retired: false,
          legacy: false,
        },
        head,
      );
      if (created.kind === "changed") return { kind: "changed" };
      if (created.kind !== "saved")
        return { kind: "failed", refused: created.kind === "refused" };
      const complete = await retireEarlier(
        env,
        store,
        created.copy.change,
        field,
      );
      return { kind: "held", copy: created.copy, complete };
    },
  );
  return answer ?? { kind: "busy" };
}

/** What "Check now" of a reconciliation record observed. */
export type CheckResult =
  /**
   * The field's policy as it is NOW (owner-only read; noted with its time): `unchanged` = still the version the attempt was guarded by
   * (the attempt may still be made), `matches` = it is the audience the attempt asked for. Neither says whether the attempt was made.
   */
  | { kind: "observed"; unchanged: boolean; matches: boolean }
  /** The policy could not be read (offline, refused, failed), or another identity is displayed. */
  | { kind: "failed" };

/**
 * "Check now" of a RETIRED hold (a reconciliation record): one owner-only read of the field's policy. It says what the audience IS now
 * and nothing about what the attempt did (review 4, finding 4; the assessment's C9): an unchanged version may still be changed by it, a
 * matching policy may have been set by someone else, and a different one may have been set after it. The record is KEPT: nothing is sent
 * and nothing is ended (D1: no background policy change); only "Discard" forgets it.
 */
export async function checkRetired(
  env: PeopleEnv,
  shown: HeldCopy,
): Promise<CheckResult> {
  const memory = env.memory;
  const change = shown.change;
  const read = await untilSent(() => env.sharing.readPolicy(change.fieldId));
  if (!read.ok || !isCurrentMemory(memory)) return { kind: "failed" };
  notePolicy(memory, change.fieldId, {
    ...read.value,
    checkedAt: env.now(),
  });
  memory.touch();
  return {
    kind: "observed",
    unchanged: read.value.version === change.from.version,
    matches: samePolicy(read.value.policy, change.to),
  };
}
