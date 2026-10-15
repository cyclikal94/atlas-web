import type { CacheRow, EnqueueOutcome, Outbox } from "../../../data";
import { applyPolicyChange, samePolicy } from "../../sharing";
import type { PeopleEnv } from "../env";
import { type HeldRun, isCurrentMemory } from "../memory";
import { baseGuard, putFieldUpdateRequest } from "../model/commands";
import { sentSomething } from "../online";
import type { HeldChange, HeldFailure } from "./held-store";

/**
 * Runs ONE held audience change (D-11a-12; WF-PEOPLE-03 "Hold it as a draft until I'm online"): the audience first, then the content.
 *
 * OWNERSHIP (finding 2 of the review of 13 October 2026). A run belongs to its hold: `run.cancelled` is set when the person discards the
 * hold while it runs, and `owns()` (this identity's memory is still the current one, the run was not cancelled, and the hold is still
 * listed) is checked at EVERY admission boundary: before the policy step is sent (`applyPolicyChange`'s `isCurrent`, asked after its read
 * and before its write), after it, before the content step and inside the content step's writing transaction (its build refuses).
 * Nothing is sent or queued once the hold is not owned. A policy step that was already confirmed cannot be taken back: the run reports it
 * (`cancelled` with `policyDone`), and the person is told the audience changed and their text was not saved.
 *
 * BINDING (finding 1). The content step is bound to the edit's snapshot: the field must still be at the content version the edit began on
 * (`version`), checked before the policy step AND again after it (the read may take long, and a change may be published meanwhile), and
 * its command must resolve the base the edit began on (`expectedBase`, inside the outbox transaction). Otherwise nothing is queued
 * (`content_changed`).
 *
 *  1. The field must still be the one the edit began on (else `content_changed`, or `gone` when it is no longer on this device).
 *  2. The policy change, through the sharing slice (`applyPolicyChange`: read, version guard against the policy shown, one replace_policy,
 *     confirming read). Anything but a confirmed change leaves the hold as it is, with its reason; a change that was not sent (offline,
 *     held, closed) just waits again. The uncertain attempt is kept with the hold (the same key and body on a retry).
 *  3. Only then is the content queued, with `expected_policy_version` = the CONFIRMED new policy version (Q1), under the hold's id as its
 *     local id (a run repeated after a lost completion is the same save, never a second one).
 *
 * The two steps cannot be one atomic operation; Q1 makes the second fail closed.
 */
export type HeldResult =
  | { kind: "done" }
  | { kind: "waiting" }
  | { kind: "failed"; reason: HeldFailure }
  | { kind: "cancelled"; policyDone: boolean };

export interface HeldDeps {
  /** The field as the cache shows it NOW (a direct read of that one row), or null when it is not on this device. */
  current(): CacheRow | null;
  /** The hold is still listed (another page did not finish or discard it). */
  listed(): boolean;
  /** Writes the hold's progress (its confirmed audience, its uncertain attempt) so that a later run continues from it. */
  persist(change: HeldChange): Promise<unknown>;
  enqueue(
    run: (outbox: Outbox) => Promise<EnqueueOutcome>,
  ): Promise<
    { ok: true; localId: string } | { ok: false; message: string | null }
  >;
}

export async function runHeldChange(
  env: PeopleEnv,
  held: HeldChange,
  run: HeldRun,
  deps: HeldDeps,
): Promise<HeldResult> {
  const memory = env.memory;
  const owns = () => isCurrentMemory(memory) && !run.cancelled && deps.listed();
  const cancelled = (): HeldResult => ({
    kind: "cancelled",
    policyDone: run.policyDone,
  });
  const bound = (): HeldResult | null => {
    const current = deps.current();
    if (current === null) return { kind: "failed", reason: "gone" };
    if (current.version !== held.version)
      return { kind: "failed", reason: "content_changed" };
    return null;
  };
  if (!owns()) return cancelled();
  const before = bound();
  if (before !== null) return before;
  // Already confirmed by an earlier run whose content step was not saved: only the content step remains (still guarded by Q1).
  if (!samePolicy(held.from.policy, held.to)) {
    const outcome = await applyPolicyChange(
      { api: env.sharing, newId: env.newId },
      {
        resourceId: held.fieldId,
        from: held.from,
        to: held.to,
        attempt: held.attempt,
        isCurrent: owns,
      },
    );
    const result = outcome.result;
    held.attempt = outcome.attempt;
    // A command was sent (whatever its answer said): the summaries shown are read again.
    if (isCurrentMemory(memory) && sentSomething(result))
      memory.invalidateSummaries();
    if (result.ok) {
      run.policyDone = true;
      // The audience is now the one asked for: a later run must not try to change it again.
      held.from = { version: result.policyVersion, policy: held.to };
      if (isCurrentMemory(memory))
        memory.policies.set(held.fieldId, {
          version: result.policyVersion,
          policy: held.to,
        });
    }
    if (!run.cancelled && isCurrentMemory(memory)) await deps.persist(held);
    if (!owns()) return cancelled();
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
          return { kind: "failed", reason: result.kind };
        default:
          return { kind: "failed", reason: "changed" };
      }
    }
  }
  // The policy step may have taken long: the content must still be the one the edit began on.
  const after = bound();
  if (after !== null) return after;
  if (!owns()) return cancelled();
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
        // The last admission boundary, inside the writing transaction: a hold discarded meanwhile queues nothing.
        if (!owns()) {
          refusedByOwner = true;
          throw new Error("the held change is no longer owned by this run");
        }
        return request.build(bases);
      },
    }),
  );
  if (refusedByOwner) return cancelled();
  if (saved.ok) return { kind: "done" };
  return guard.moved
    ? { kind: "failed", reason: "content_changed" }
    : { kind: "failed", reason: "not_saved" };
}
