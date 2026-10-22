import type { CacheRow, EnqueueOutcome, Outbox } from "../../../data";
import { applyPolicyChange, samePolicy } from "../../sharing";
import type { PeopleEnv } from "../env";
import { type HeldRun, isCurrentMemory } from "../memory";
import type { Attempt } from "../model/attempt";
import { baseGuard, putFieldUpdateRequest } from "../model/commands";
import { sentSomething } from "../online";
import {
  decodeHeld,
  type HeldChange,
  type HeldCopy,
  type HeldFailure,
  type HeldKey,
  type HeldWrite,
} from "./held-store";

/**
 * Runs ONE held audience change (D-11a-12; WF-PEOPLE-03 "Hold it as a draft until I'm online"): the audience first, then the content.
 * The caller holds the field's lock (one run of the field's holds at a time, in every page of the browser) for the WHOLE run, including
 * its last durable write: nothing here lets go of it before the outcome is committed.
 *
 * THE DURABLE STATE GOVERNS (review 2 of 22 October 2026, finding 2). The run begins by READING the hold again under the lock and runs
 * only if the stored state is exactly the one the page showed (`shown.digest`): a hold another page ended or moved on is not run from a
 * stale list. Every step is a CONDITIONAL write of the next state (`HeldStore.update`, from the last state this run read or wrote), and
 * the run stops on any answer but `saved`, without claiming anything it did not commit:
 *
 *  1. The field must still be the one the edit began on (else `content_changed`, or `gone` when it is no longer on this device).
 *  2. The policy change, through the sharing slice (`applyPolicyChange`: read, version guard against the policy shown, one replace_policy,
 *     confirming read). Its EXACT attempt is written to the hold BEFORE it may be sent (`admit`), so an end of the hold after that point
 *     says the audience may already have changed. The confirmed audience (or the attempt still uncertain) is written after it.
 *  3. The field is checked again; the content step is recorded as ADMITTED (`queued`) before it is queued, with
 *     `expected_policy_version` = the CONFIRMED policy version (Q1), under the hold's id as its local id, and its base guarded inside the
 *     outbox transaction (`expectedBase`). A repeat after a lost completion is the same save, and a repeat after the save landed is refused
 *     by its own version guard.
 *  4. The hold is ended (a conditional terminal write) only after that.
 *
 * OWNERSHIP (finding 2 of the review of 13 October 2026, kept). `run.cancelled` is set when the person discards the hold in THIS page while
 * it runs; it, this identity's memory and the row being mounted are checked at every admission boundary (after the policy read, before
 * the policy write, before the content step and inside its writing transaction). A discard in ANOTHER page is a conditional end from the
 * state that page showed: before an admission it wins and this run's next write is refused (`changed`, nothing more is sent); after one
 * it is told what may already have happened. A policy step that was confirmed cannot be taken back; the run says so.
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
   * or was never sent (`none`). `ended`: the hold's copy is terminal (by this run or another page); otherwise it is still kept.
   */
  | {
      kind: "cancelled";
      policy: "none" | "maybe" | "done";
      ended: boolean;
      /** The policy attempt that may have been sent (kept by the page for a later change of the field's audience), or null. */
      attempt: Attempt | null;
    }
  /** The stored hold is not the one the page showed (moved on elsewhere): nothing was done. */
  | { kind: "stale" };

export interface HeldDeps {
  /** The field as the cache shows it NOW (a direct read of that one row), or null when it is not on this device. */
  current(): CacheRow | null;
  /** The hold's row is still mounted on this page (navigating away stops the run at its next boundary). */
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

export async function runHeldChange(
  env: PeopleEnv,
  shown: HeldCopy,
  run: HeldRun,
  deps: HeldDeps,
): Promise<HeldResult> {
  const memory = env.memory;
  const store = env.held;
  const key = keyOf(shown.change);
  const owns = () =>
    isCurrentMemory(memory) && !run.cancelled && deps.mounted();
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
  const policyState = (): "none" | "maybe" | "done" =>
    run.policyDone ? "done" : progressOf(copy.change).policy;
  /** Ends the hold from the state this run holds, and says truthfully what happened before. */
  const cancel = async (): Promise<HeldResult> => {
    const ended = await store.end(key, copy.digest);
    return {
      kind: "cancelled",
      policy: policyState(),
      ended:
        ended.kind === "ended" ||
        (ended.kind === "changed" && ended.stored !== "live"),
      attempt: copy.change.attempt,
    };
  };
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
    return { kind: "cancelled", policy: "none", ended: true, attempt: null };
  if (stored.copy.digest !== shown.digest) return { kind: "stale" };
  copy = stored.copy;
  if (!owns()) return cancel();
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
        // The exact attempt is durable before it may be sent; the same one again (a retry) is already.
        admit: async (attempt) =>
          owns() &&
          (copy.change.attempt?.key === attempt.key &&
          copy.change.attempt.body === attempt.body
            ? true
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
        memory.policies.set(held.fieldId, {
          version: result.policyVersion,
          policy: held.to,
        });
    }
    // Discarded here meanwhile: the hold ends from what is stored; what was already done is said.
    if (run.cancelled || !isCurrentMemory(memory)) return cancel();
    // The audience is now the one asked for (a later run must not change it again), or the attempt still uncertain is kept.
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
    if (!owns()) return cancel();
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
  if (!owns()) return cancel();
  // The content step is ADMITTED before it is queued: an end of the hold from here on says the content may be saved.
  if (!(await write({ ...copy.change, queued: true }))) return refused();
  if (!owns()) return cancel();
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
    outbox.enqueue({
      ...request,
      localId: held.holdId,
      build: (bases) => {
        // The last admission boundary, inside the writing transaction: a hold discarded here meanwhile queues nothing.
        if (!owns()) {
          refusedByOwner = true;
          throw new Error("the held change is no longer owned by this run");
        }
        return request.build(bases);
      },
    }),
  );
  if (refusedByOwner) {
    // Nothing was queued: the admission is withdrawn before the hold ends, so nobody is told the content may be saved.
    await write({ ...copy.change, queued: false });
    return cancel();
  }
  if (saved.ok) {
    const ended = await store.end(key, copy.digest);
    return {
      kind: "done",
      ended:
        ended.kind === "ended" ||
        (ended.kind === "changed" && ended.stored !== "live"),
    };
  }
  await write({ ...copy.change, queued: false });
  return fail(guard.moved ? "content_changed" : "not_saved");
}

/** The bound on the pages one replacement reads (each at most 1,000 rows): beyond it the rest is kept, and said so. */
const REPLACE_PAGES = 10;

/**
 * A new hold of a field REPLACES the earlier ones (review 2 of 22 October 2026, finding 4): every earlier live hold of exactly that field
 * is found by a bounded, resumable read of the field's own copies (never a display page), and ended from the state it is stored in. The
 * caller holds the field's lock, so no run of the field is between its steps; a hold this page is running, a hold whose end the store did
 * not commit, a page that could not be read and anything past the bound are KEPT (and the answer is false, so the person is told).
 * Uncertain policy attempts of the ended holds are kept for the field (the same key and body on a later change of its audience).
 */
export async function endEarlierHolds(
  env: PeopleEnv,
  personId: string,
  fieldId: string,
  keep: string,
): Promise<boolean> {
  const memory = env.memory;
  let after: Parameters<PeopleEnv["held"]["list"]>[2] = null;
  let complete = true;
  for (let page = 0; page < REPLACE_PAGES; page += 1) {
    const read = await env.held.list(personId, fieldId, after);
    if (read === null) return false;
    for (const row of read.copies) {
      const holdId = row.tab_instance_id;
      if (holdId === keep) continue;
      if (memory.heldRuns.has(holdId)) {
        complete = false;
        continue;
      }
      const end = await env.held.end(
        { personId, fieldId, holdId },
        row.content_digest,
      );
      if (
        end.kind === "ended" ||
        (end.kind === "changed" && end.stored !== "live")
      ) {
        memory.heldAuthority.delete(holdId);
        memory.heldEnded.add(holdId);
        const held = decodeHeld(row);
        if (held?.attempt && progressOf(held).policy === "maybe")
          memory.attempts.set(`policy:${fieldId}`, held.attempt);
      } else complete = false;
    }
    if (read.next === null) {
      memory.touch();
      return complete;
    }
    after = read.next;
  }
  memory.touch();
  return false;
}
