import type { Policy } from "../../data";
import { type SharingApi, type SharingResult, untilSent } from "./api";
import { samePolicy, toWirePolicy } from "./model/policy-draft";
import { type Attempt, nextAttempt } from "./model/submission";

/**
 * A QUICK change of one resource's policy, from a policy the caller showed to one it chose (WEB-11a D-11a-8: a field's "Only you" /
 * "Home · can view"). An extension of WEB-12a's editor rules, not a second editor: it renders nothing, and the same online-only API, attempt
 * and classification rules apply (docs/sharing.md, "applyPolicyChange").
 *
 *  1. Read `GET /policies/{id}` (owner-only; a `403` is remembered for the page by the API, D-12a-13, and never asked again).
 *  2. Refuse with `changed` when its version is not the one the caller showed (`from.version`): the person reviews, nothing is sent.
 *  3. Send ONE `replace_policy {id, expected_version: read.version, policy: to}` under the attempt's key (one attempt per body: after an
 *     uncertain outcome the same key and byte-identical body are sent again, D-12a-2).
 *  4. Read again and require that the policy now IS `to`: only then is the change confirmed (`ok`, with the new policy version).
 *
 * A retry after an uncertain send that did commit finds the version moved and the policy already `to`: that is confirmed, never sent
 * twice. Every other answer is classified: `changed` (the policy is not the one shown, or not the one asked for afterwards), `conflict`
 * (the server refused the version), `forbidden`, `not_found`, `uncertain` (no definite answer: keep the attempt), `offline`, `not_sent`,
 * `closed`.
 */
export type PolicyChangeResult =
  | { ok: true; policyVersion: number }
  | {
      ok: false;
      kind:
        | "changed"
        | "conflict"
        | "forbidden"
        | "not_found"
        | "invalid"
        | "uncertain"
        | "offline"
        | "not_sent"
        | "closed";
      requestId?: string;
    };

export interface PolicyChangeInput {
  resourceId: string;
  /** The policy the person saw, with its version. */
  from: { version: number; policy: Policy };
  to: Policy;
  /** The uncertain attempt of an earlier try of this same change, or null. */
  attempt: Attempt | null;
  /** False once the caller's identity or target changed: nothing more is asked. */
  isCurrent?: () => boolean;
  sleep?: (ms: number) => Promise<void>;
}

export interface PolicyChangeOutcome {
  result: PolicyChangeResult;
  /** The attempt still uncertain after this try (keep it for "Try again"), or null. */
  attempt: Attempt | null;
}

function failure<T>(
  result: Extract<SharingResult<T>, { ok: false }>,
): PolicyChangeResult {
  switch (result.kind) {
    case "conflict":
    case "operation_conflict":
      return {
        ok: false,
        kind: "conflict",
        ...(result.requestId ? { requestId: result.requestId } : {}),
      };
    case "forbidden":
      return { ok: false, kind: "forbidden" };
    case "not_found":
    case "gone":
      return { ok: false, kind: "not_found" };
    case "invalid":
    case "last_manager":
      return {
        ok: false,
        kind: "invalid",
        ...(result.requestId ? { requestId: result.requestId } : {}),
      };
    case "uncertain":
      return {
        ok: false,
        kind: "uncertain",
        ...(result.requestId ? { requestId: result.requestId } : {}),
      };
    case "offline":
    case "not_sent":
    case "closed":
      return { ok: false, kind: result.kind };
  }
}

export async function applyPolicyChange(
  env: { api: SharingApi; newId(): string },
  input: PolicyChangeInput,
): Promise<PolicyChangeOutcome> {
  const options = {
    ...(input.isCurrent ? { isCurrent: input.isCurrent } : {}),
    ...(input.sleep ? { sleep: input.sleep } : {}),
  };
  const current = input.isCurrent ?? (() => true);
  const read = await untilSent(
    () => env.api.readPolicy(input.resourceId),
    options,
  );
  if (!current())
    return { result: { ok: false, kind: "closed" }, attempt: input.attempt };
  if (!read.ok) return { result: failure(read), attempt: input.attempt };
  if (read.value.version !== input.from.version) {
    // An earlier uncertain try of THIS change that did commit: the policy is already the one asked for.
    if (input.attempt !== null && samePolicy(read.value.policy, input.to))
      return {
        result: { ok: true, policyVersion: read.value.version },
        attempt: null,
      };
    return { result: { ok: false, kind: "changed" }, attempt: input.attempt };
  }
  const commands = [
    {
      kind: "replace_policy" as const,
      id: input.resourceId,
      expected_version: read.value.version,
      policy: toWirePolicy(input.to),
    },
  ];
  const attempt = nextAttempt(input.attempt, commands, env.newId);
  const sent = await untilSent(
    () => env.api.management(commands, attempt.key),
    options,
  );
  if (!current()) return { result: { ok: false, kind: "closed" }, attempt };
  if (!sent.ok) {
    switch (sent.kind) {
      case "uncertain":
        return { result: failure(sent), attempt };
      case "offline":
      case "not_sent":
      case "closed":
        // Never sent: the earlier uncertain attempt (if any) stays as it was.
        return { result: failure(sent), attempt: input.attempt };
      default:
        return { result: failure(sent), attempt: null };
    }
  }
  // Receipted. Confirmed only by a read that shows the policy asked for.
  const confirm = await untilSent(
    () => env.api.readPolicy(input.resourceId),
    options,
  );
  if (!current()) return { result: { ok: false, kind: "closed" }, attempt };
  if (!confirm.ok)
    // The change was receipted but not seen: keep the attempt, so a retry recognises the committed change instead of sending another.
    return { result: { ok: false, kind: "uncertain" }, attempt };
  if (!samePolicy(confirm.value.policy, input.to))
    return { result: { ok: false, kind: "changed" }, attempt: null };
  return {
    result: { ok: true, policyVersion: confirm.value.version },
    attempt: null,
  };
}
