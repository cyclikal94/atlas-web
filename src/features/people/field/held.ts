import type { CacheRow, EnqueueOutcome, Outbox } from "../../../data";
import { applyPolicyChange, samePolicy } from "../../sharing";
import type { PeopleEnv } from "../env";
import { type HeldChange, isCurrentMemory } from "../memory";
import { putFieldUpdateRequest } from "../model/commands";

/**
 * Runs ONE held audience change (D-11a-12; WF-PEOPLE-03 "Hold it as a draft until I'm online"): the audience first, then the content.
 *
 *  1. The field must still be at the content version the edit began on (`baseVersion`): otherwise the content step would land on
 *     someone else's change, and nothing is sent (`content_changed`).
 *  2. The policy change, through the sharing slice (`applyPolicyChange`: read, version guard against the policy shown, one replace_policy,
 *     confirming read). Anything but a confirmed change leaves the held draft as it is, with its reason; a change that was not sent
 *     (offline, held, closed) just waits again.
 *  3. Only then is the content queued, with `expected_policy_version` = the CONFIRMED new policy version (Q1): a policy moved in between
 *     makes the server refuse it (`conflict`), so the content never lands under an audience nobody chose.
 *
 * The two steps cannot be one atomic operation; Q1 makes the second fail closed. Returns the held change's new status, or `done`.
 */
export type HeldResult = HeldChange["status"] | { kind: "done" };

export async function runHeldChange(
  env: PeopleEnv,
  held: HeldChange,
  current: CacheRow | null,
  enqueue: (
    run: (outbox: Outbox) => Promise<EnqueueOutcome>,
  ) => Promise<
    { ok: true; localId: string } | { ok: false; message: string | null }
  >,
): Promise<HeldResult> {
  if (current === null || current.version !== held.baseVersion)
    return { kind: "failed", reason: "content_changed" };
  const memory = env.memory;
  // Already confirmed by an earlier run whose content step was not saved: only the content step remains (still guarded by Q1).
  if (samePolicy(held.from.policy, held.to))
    return enqueueContent(held, held.from.version, enqueue);
  const key = `policy:${held.fieldId}`;
  const outcome = await applyPolicyChange(
    { api: env.sharing, newId: env.newId },
    {
      resourceId: held.fieldId,
      from: held.from,
      to: held.to,
      attempt: memory.attempts.get(key) ?? null,
      isCurrent: () => isCurrentMemory(memory),
    },
  );
  if (!isCurrentMemory(memory)) return { kind: "waiting" };
  if (outcome.attempt === null) memory.attempts.delete(key);
  else memory.attempts.set(key, outcome.attempt);
  const result = outcome.result;
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
  memory.policies.set(held.fieldId, {
    version: result.policyVersion,
    policy: held.to,
  });
  // The audience is now the one asked for: a later retry must not try to change it again.
  held.from = { version: result.policyVersion, policy: held.to };
  return enqueueContent(held, result.policyVersion, enqueue);
}

async function enqueueContent(
  held: HeldChange,
  policyVersion: number,
  enqueue: Parameters<typeof runHeldChange>[3],
): Promise<HeldResult> {
  const saved = await enqueue((outbox) =>
    outbox.enqueue(
      putFieldUpdateRequest({
        fieldId: held.fieldId,
        personId: held.personId,
        label: held.label,
        value: held.value,
        policyVersion,
        sameKind: held.sameKind,
      }),
    ),
  );
  return saved.ok ? { kind: "done" } : { kind: "failed", reason: "not_saved" };
}
