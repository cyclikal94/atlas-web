import type { CacheRow, EnqueueOutcome, Outbox, Policy } from "../../../data";
import { samePolicy, untilSent } from "../../sharing";
import { applyPolicyChange } from "../../sharing/apply-policy-change";
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
  heldOf,
} from "./held-store";

/**
 * Runs ONE held audience change (D-11a-12; WF-PEOPLE-03 "Hold it as a draft until I'm online"): the audience first, then the content.
 * The caller holds the field's lock (one run of the field's holds at a time, in every page of the browser) for the WHOLE run, including
 * its last durable write: nothing here lets go of it before the outcome is committed.
 *
 * THE DURABLE STATE GOVERNS (review 2 of 22 October 2026, finding 2). The run begins by READING the hold again under the lock and runs
 * only if the stored state is exactly the one the page showed (`shown.digest`), and only if it is its field's CURRENT hold (no live hold
 * of the field has a later generation, review 3 finding 2: an earlier hold still kept is retired instead, never run). Every step is a
 * CONDITIONAL write of the next state (`HeldStore.update`, from the last state this run read or wrote), and the run stops on any answer
 * but `saved`, without claiming anything it did not commit:
 *
 *  1. The field must still be the one the edit began on (else `content_changed`, or `gone` when it is no longer on this device).
 *  2. The policy change, through the sharing slice (`applyPolicyChange`: read, version guard against the policy shown, one replace_policy,
 *     confirming read). Its EXACT attempt is written to the hold BEFORE it may be sent (`admit`), so an end of the hold after that point
 *     says the audience may already have changed. The confirmed audience (or the attempt still uncertain) is written after it.
 *  3. The field is checked again; the content step is recorded as ADMITTED (`queued`) before it is queued, with
 *     `expected_policy_version` = the CONFIRMED policy version (Q1), under the hold's id as its local id, and its base guarded inside the
 *     outbox transaction (`expectedBase`). A repeat after a lost completion is the same save, and a repeat after the save landed is refused
 *     by its own version guard.
 *  4. The hold is ended (a conditional terminal write) only after that: the content is the outbox's now (completion), so this end is
 *     written even when the row has gone from the page meanwhile.
 *
 * STOPPING IS NOT DISCARDING (review 3 of 22 October 2026, finding 1). Two different things stop a run at its admission boundaries (after
 * the policy read, before the policy write, before the content step and inside its writing transaction):
 *
 *  - `run.cancelled`: the person discarded the hold in THIS page while it ran. The run ends it there (`settleHold`: a terminal write, or a
 *    reconciliation record when its policy step may have been made) and says truthfully what was already done.
 *  - Losing the page: the row unmounted (navigation, another page of the held list) or another identity is displayed. The run only STOPS
 *    (`suspended`): nothing is ended, its input stays exactly as stored, an admitted attempt and its answer are written as progress (under
 *    the same identity only), and an admitted content step that queued nothing is withdrawn. It runs again where it may (D1: in the page
 *    whose authority it has, or after "Send now").
 *
 * A discard in ANOTHER page is a conditional write from the state that page showed: before an admission it wins and this run's next
 * write is refused (`changed`, nothing more is sent); after one it is told what may already have happened. A policy step that was
 * confirmed cannot be taken back; the run says so.
 */
export type HeldResult =
  /** The content is queued. `ended`: the hold's copy ended; otherwise it stays, and a repeat is refused by its own guard. */
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
      /** The policy attempt that may have been sent (kept by the page for a later change of the field's audience), or null. */
      attempt: Attempt | null;
    }
  /**
   * This page stopped running it (its row is no longer shown, or another identity is): NOTHING was ended. The hold is kept as it was last
   * written, with any attempt and progress of its policy step; it runs again only where it may (D1).
   */
  | { kind: "suspended" }
  /**
   * A later hold of its field is the field's current one: this one did not run. `ended`/`retired` as for `cancelled` (it was retired as
   * the later hold's predecessor), or neither when that write was not committed (it stays, and never runs).
   */
  | { kind: "superseded"; ended: boolean; retired: boolean }
  /** The stored hold is not the one the page showed (moved on elsewhere, or a reconciliation record): nothing was done. */
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
 * What a hold's stored state says was already done: its audience step was confirmed (`done`: a hold is made only for a change of audience,
 * so an audience that is now the one asked for was changed by it), may have been made (`maybe`: an attempt was admitted and has no definite
 * answer), or was never sent (`none`); `content`: its content step was admitted (its draft may be queued). PURE.
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

/** Retiring one hold: `ended` (terminal), `retired` (kept as a reconciliation record), or why nothing was written. */
export type HeldSettle = HeldEnd | { kind: "retired"; copy: HeldCopy };

/** Whether the hold's content is gone after `answer` (ended or retired here, or already ended by another page). PURE. */
export const isSettled = (answer: HeldSettle): boolean =>
  answer.kind === "ended" ||
  answer.kind === "retired" ||
  (answer.kind === "changed" && answer.stored !== "live");

/**
 * Discards (or replaces) ONE hold from the state it was read in. It ENDS (a terminal write), unless its policy step may have been made
 * and nothing else keeps that attempt: then it is RETIRED (review 3, C3c): a reconciliation record that keeps the attempt, the audience
 * asked for and its guard, with the content cleared, never run. `successor`: the new hold that replaces it; when that hold carries the
 * same attempt (the same change: it took the attempt over), this one simply ends. A reconciliation record that is discarded ends.
 */
export async function settleHold(
  store: HeldStore,
  copy: HeldCopy,
  successor: HeldChange | null = null,
): Promise<HeldSettle> {
  const change = copy.change;
  const attempt = change.attempt;
  const unresolved =
    !change.retired &&
    attempt !== null &&
    progressOf(change).policy === "maybe" &&
    !(
      successor?.attempt?.key === attempt.key &&
      successor.attempt.body === attempt.body
    );
  if (!unresolved) return store.end(keyOf(change), copy.digest);
  const written = await store.update(copy, {
    ...change,
    retired: true,
    value: { kind: "text", text: "" },
    status: { kind: "waiting" },
  });
  return written.kind === "saved"
    ? { kind: "retired", copy: written.copy }
    : written;
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
 * could not all be read (a page failed, or more than the bound): an incomplete read never says who the field's current hold is.
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

/** The live holds of `field` that come AFTER `change` (a later generation, not retired): any one makes `change` an earlier hold. PURE. */
const laterThan = (field: FieldHolds, change: HeldChange): HeldChange[] =>
  field.holds
    .map((copy) => copy.change)
    .filter(
      (other) =>
        other.holdId !== change.holdId &&
        !other.retired &&
        other.seq > change.seq,
    );

/**
 * Retires every hold of `field` that came BEFORE `winner` (an earlier generation), each from the state it was read in, and tells this
 * page's memory (they never run here; an ended one is not shown while the list catches up; an unresolved attempt is also kept for the
 * field's next audience change). Holds of the same generation (two copies of the first shapes) and copies this page cannot read are
 * kept. True when no earlier or unreadable hold is left.
 */
async function retireEarlier(
  env: PeopleEnv,
  winner: HeldChange,
  field: FieldHolds,
): Promise<boolean> {
  const memory = env.memory;
  let complete = field.unreadable.length === 0;
  for (const earlier of field.holds) {
    const change = earlier.change;
    if (change.holdId === winner.holdId || change.seq >= winner.seq) continue;
    const settled = await settleHold(env.held, earlier, winner);
    if (!isSettled(settled)) {
      complete = false;
      continue;
    }
    memory.heldAuthority.delete(change.holdId);
    if (settled.kind !== "retired") memory.heldEnded.add(change.holdId);
    if (change.attempt !== null && progressOf(change).policy === "maybe")
      memory.attempts.set(`policy:${change.fieldId}`, change.attempt);
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
  const store = env.held;
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
  /** The hold is still stored exactly as this run last read or wrote it (a check with no write), else why not (as a refused write). */
  const unchanged = async (): Promise<boolean> => {
    const now = await store.read(key);
    if (now.kind === "live" && now.copy.digest === copy.digest) return true;
    refusal =
      now.kind === "failed"
        ? { kind: "failed" }
        : {
            kind: "changed",
            stored:
              now.kind === "live" || now.kind === "unreadable"
                ? "live"
                : now.kind,
          };
    return false;
  };
  const policyState = (): "none" | "maybe" | "done" =>
    run.policyDone ? "done" : progressOf(copy.change).policy;
  /** Discarded in this page: the hold is retired from the state this run holds, and what happened before is said truthfully. */
  const cancel = async (): Promise<HeldResult> => {
    // A policy step this run saw confirmed is resolved (whatever is stored yet): the hold simply ends.
    const settled = run.policyDone
      ? await store.end(key, copy.digest)
      : await settleHold(store, copy);
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
    return {
      kind: "cancelled",
      policy: "none",
      ended: true,
      retired: false,
      attempt: null,
    };
  if (stored.copy.digest !== shown.digest || stored.copy.change.retired)
    return { kind: "stale" };
  copy = stored.copy;
  if (!owns()) return stop();
  // Only the field's CURRENT hold runs (review 3, finding 2): a later hold of the field retires this one instead.
  const field = await holdsOf(store, key.personId, key.fieldId);
  if (field === null)
    return { kind: "failed", reason: "not_saved", kept: false };
  const later = laterThan(field, copy.change);
  if (later.length > 0) {
    const winner = later.reduce((a, b) => (b.seq > a.seq ? b : a));
    const settled = await settleHold(store, copy, winner);
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
  await retireEarlier(env, copy.change, field);
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
  // The content step is ADMITTED before it is queued: an end of the hold from here on says the content may be saved.
  if (!(await write({ ...copy.change, queued: true }))) return refused();
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
  let refusedByOwner = !owns();
  const saved = refusedByOwner
    ? null
    : await deps.enqueue((outbox) =>
        outbox.enqueue({
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
        }),
      );
  if (refusedByOwner || saved === null) {
    // Nothing was queued: the admission is withdrawn first, so nobody is told the content may be saved.
    if (isCurrentMemory(memory)) await write({ ...copy.change, queued: false });
    return stop();
  }
  if (saved.ok) {
    const ended = await store.end(key, copy.digest);
    return { kind: "done", ended: isSettled(ended) };
  }
  await write({ ...copy.change, queued: false });
  return fail(guard.moved ? "content_changed" : "not_saved");
}

/** `earlier` keeps an unresolved attempt of exactly the change from policy version `from` to `to`. PURE. */
const unresolvedFor = (earlier: HeldChange, from: number, to: Policy) =>
  earlier.attempt !== null &&
  progressOf(earlier).policy === "maybe" &&
  earlier.from.version === from &&
  samePolicy(earlier.to, to);

/**
 * The unresolved attempt a hold of this field on this device (a kept hold or a reconciliation record) carries for EXACTLY the change from
 * policy version `from` to `to`, for a direct change of the field's audience (the same key and body, never a second attempt beside it),
 * or null (none, or the holds could not be read).
 */
export async function heldAttemptOf(
  env: PeopleEnv,
  personId: string,
  fieldId: string,
  from: number,
  to: Policy,
): Promise<Attempt | null> {
  const field = await holdsOf(env.held, personId, fieldId);
  return (
    field?.holds.find(({ change }) => unresolvedFor(change, from, to))?.change
      .attempt ?? null
  );
}

/** What `holdChange` did. */
export type HoldOutcome =
  /** Kept, as its field's current hold. `complete`: every earlier hold of the field was retired; otherwise some are still kept (said). */
  | { kind: "held"; copy: HeldCopy; complete: boolean }
  /** The field's lock is taken (a run of its holds, another page's hold): nothing was written, and the editor keeps the edit. */
  | { kind: "busy" }
  /** Nothing was kept: `refused` while signing out (D-16); otherwise the store failed or the field's holds could not all be read. */
  | { kind: "failed"; refused: boolean }
  /** Kept, but another page changed or ended the new hold before its earlier ones were retired: none of them was retired. */
  | { kind: "changed" };

/**
 * "Hold as draft" (D-11a-12): ONE operation of the field, under the field's lock from before the hold is written until its earlier holds
 * are retired (review 3 of 22 October 2026, finding 2: two pages' saves can no longer interleave and retire each other's holds).
 *
 *  1. Every live hold of the field is read (bounded; an incomplete read keeps nothing new: the field's current hold would not be known).
 *  2. The new hold is written as the field's NEXT generation, in the same write as its content: from this commit it is the field's current
 *     hold, and every earlier one can never run again, even if what follows is cut short (a closed page, a refused write).
 *     An unresolved attempt of an earlier hold of exactly this change (the same policy version and audience asked for) is taken over.
 *  3. Only while the new hold is still stored as written, every earlier one is retired from the state it was read in (`settleHold`).
 *
 * The page's authority to run it (D1) is the caller's to give, after this answers `held`.
 */
export async function holdChange(
  env: PeopleEnv,
  change: Omit<HeldChange, "seq" | "retired" | "attempt">,
): Promise<HoldOutcome> {
  const answer = await env.exclusive(
    lockOf(env, change.fieldId),
    async (): Promise<HoldOutcome> => {
      const store = env.held;
      const field = await holdsOf(store, change.personId, change.fieldId);
      if (field === null) return { kind: "failed", refused: false };
      const seq =
        field.holds.reduce((top, copy) => Math.max(top, copy.change.seq), 0) +
        1;
      const taken = field.holds.find(({ change: earlier }) =>
        unresolvedFor(earlier, change.from.version, change.to),
      );
      const created = await store.create({
        ...change,
        attempt: taken?.change.attempt ?? null,
        seq,
        retired: false,
      });
      if (created.kind !== "saved")
        return { kind: "failed", refused: created.kind === "refused" };
      const now = await store.read(keyOf(created.copy.change));
      if (now.kind !== "live" || now.copy.digest !== created.copy.digest)
        return { kind: "changed" };
      const complete = await retireEarlier(env, created.copy.change, field);
      return { kind: "held", copy: created.copy, complete };
    },
  );
  return answer ?? { kind: "busy" };
}

/** What "Check now" of a reconciliation record found. */
export type CheckResult =
  /** The field's audience now IS the one asked for (the attempt, or the same change made elsewhere): the record ended. */
  | "made"
  /** It is not: still the version the attempt was guarded by (nothing of it was committed), or another one (it never can be): ended. */
  | "not_made"
  /** The field's lock is taken: nothing was read or written. */
  | "busy"
  /** The policy could not be read, or the record could not be ended: it is kept. */
  | "kept";

/**
 * "Check now" of a RETIRED hold (a reconciliation record, `settleHold`): one owner-only read of the field's policy, under the field's
 * lock, decides what its unresolved attempt did, and the record then ends from the state it was read in. Nothing is sent: the attempt is
 * never sent again from here (D1: no background policy change).
 */
export async function checkRetired(
  env: PeopleEnv,
  shown: HeldCopy,
): Promise<CheckResult> {
  const memory = env.memory;
  const change = shown.change;
  const answer = await env.exclusive(
    lockOf(env, change.fieldId),
    async (): Promise<CheckResult> => {
      const read = await untilSent(() =>
        env.sharing.readPolicy(change.fieldId),
      );
      if (!read.ok || !isCurrentMemory(memory)) return "kept";
      notePolicy(memory, change.fieldId, {
        ...read.value,
        checkedAt: env.now(),
      });
      const made =
        read.value.version !== change.from.version &&
        samePolicy(read.value.policy, change.to);
      if (!isSettled(await env.held.end(keyOf(change), shown.digest)))
        return "kept";
      if (
        memory.attempts.get(`policy:${change.fieldId}`)?.key ===
        change.attempt?.key
      )
        memory.attempts.delete(`policy:${change.fieldId}`);
      memory.touch();
      return made ? "made" : "not_made";
    },
  );
  return answer ?? "busy";
}
