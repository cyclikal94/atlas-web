import type { RequestBoundary, SnapshotHousehold } from "../../../data";
import {
  type DirectoryEntry,
  type Invitation,
  type ManagementCommand,
  untilSent,
} from "../api";
import * as base from "../copy";
import { type Attempt, nextAttempt } from "../model/submission";
import type { HouseholdApi, HouseholdResult } from "./api";
import * as copy from "./copy";
import {
  type HouseholdsMemory,
  householdOf,
  isCurrentHouseholds,
  listOf,
  readHouseholds,
  readInvitations,
  readSignup,
  type Unresolved,
  walkSent,
} from "./memory";
import {
  type AccountInvitationSummary,
  cmd,
  conflictCause,
  type SentInvitation,
  signupLink,
} from "./model";

/**
 * The households screens' operations (D-12b-3), carried over from WEB-12a's `HouseholdsMinimal` with every guarantee it held:
 *
 *  - ONE operation at a time per identity across the whole households surface, owned SYNCHRONOUSLY from the click (DA-H1): a second
 *    click, a Try again, an invite's directory lookup or a signup issuance cannot start another while one is being prepared or sent;
 *  - one attempt per body (D-12a-2): an uncertain command is kept with the identity that made it, and Try again resends the SAME key and
 *    body; a Try again that is not sent proves nothing about the earlier request, so the attempt stays and nothing new is sent until a
 *    receipt or the server's own refusal ends it (R8); Reload re-reads without ending it;
 *  - after any success the lists and the B5 sharing snapshot are read again, the snapshot by a read asked AFTER the change (R7);
 *  - a continuation (the answer of a command, a lookup) checks that it still owns the page for the identity that started it, and the
 *    connection and the server's compatibility as they are NOW; after a `403` the tree it was asked from is gone, and what it says is
 *    written into page memory for the remounted screens.
 */
export interface Ctx {
  memory: HouseholdsMemory;
  api: HouseholdApi;
  accountId: string;
  defaults: {
    boundary(): RequestBoundary | null;
    acquire(boundary: RequestBoundary | null): Promise<unknown>;
  };
  announce(text: string): void;
  newId(): string;
  /** Navigates the app (the mounted router's). */
  go(path: string): void;
}

/** The unresolved attempt of the identity this memory is for (never another identity's). */
export const unresolvedOf = (memory: HouseholdsMemory): Unresolved | null =>
  memory.unresolved !== null && memory.unresolved.identity === memory.identity
    ? memory.unresolved
    : null;

/** Why an operation cannot start now, or null. A new operation waits for an unresolved one; a Try again is only for it. */
export function refusal(
  memory: HouseholdsMemory,
  retry: boolean,
): string | null {
  const now = memory.live;
  if (now === null || !now.online) return base.SAVE_OFFLINE_REASON;
  if (!now.writable) return base.SAVE_COMPAT_REASON;
  if (memory.operation !== null) return base.SAVE_BUSY_REASON;
  if (retry)
    return unresolvedOf(memory) === null ? base.UNCERTAIN_PENDING : null;
  return unresolvedOf(memory) !== null ? base.UNCERTAIN_PENDING : null;
}

/** Admits an operation, or returns null. Synchronous: what it checked cannot change before the operation is owned. */
export function admit(memory: HouseholdsMemory, retry: boolean): number | null {
  if (!isCurrentHouseholds(memory) || refusal(memory, retry) !== null)
    return null;
  memory.tokens += 1;
  memory.operation = { token: memory.tokens };
  memory.touch();
  return memory.tokens;
}

/** Whether `token` still owns the page for the identity that started it. */
export const owns = (memory: HouseholdsMemory, token: number): boolean =>
  isCurrentHouseholds(memory) &&
  memory.operation?.token === token &&
  memory.live?.identity === memory.identity;

export function release(memory: HouseholdsMemory, token: number): void {
  if (memory.operation?.token !== token) return;
  memory.operation = null;
  memory.touch();
}

function hold(memory: HouseholdsMemory, next: Unresolved | null): void {
  memory.unresolved = next;
  memory.touch();
}

/** Why a continuation may not send now, or null (the connection or the server's compatibility as they are NOW). */
function liveReason(memory: HouseholdsMemory): string | null {
  const now = memory.live;
  if (now === null || !now.online) return base.SAVE_OFFLINE_REASON;
  if (!now.writable) return base.SAVE_COMPAT_REASON;
  return null;
}

/** What a refusal or failure says, by kind. */
export function messageOf(
  failure: Exclude<HouseholdResult<never>, { ok: true }>,
): string {
  switch (failure.kind) {
    case "gone":
      return base.INVITATION_EXPIRED;
    case "uncertain":
      return base.UNCERTAIN;
    case "not_sent":
      return base.NOT_SENT;
    case "offline":
      return base.SAVE_OFFLINE_REASON;
    case "capacity":
      return copy.CAPACITY_REFUSED;
    case "limit":
      return copy.SIGNUP_LIMIT;
    case "last_manager":
      return copy.LAST_MANAGER_REFUSED;
    case "forbidden":
      return copy.FORBIDDEN;
    case "conflict":
      return copy.CHANGED_ELSEWHERE;
    case "not_found":
      return copy.NOT_FOUND;
    case "operation_conflict":
      return base.OPERATION_CONFLICT;
    case "closed":
      return base.NOT_SENT;
    default:
      return base.REFUSED("message" in failure ? failure.message : undefined);
  }
}

const requestIdOf = (failure: object): { requestId?: string } =>
  "requestId" in failure && typeof failure.requestId === "string"
    ? { requestId: failure.requestId }
    : {};

/** Everything a membership change may have moved, read again (the B5 snapshot by a read asked after it: R7). */
function refreshAfterChange(ctx: Ctx): void {
  void readHouseholds(ctx.memory, ctx.api);
  void readInvitations(ctx.memory, ctx.api);
  void walkSent(ctx.memory, ctx.api);
  if (ctx.memory.signup.status !== "idle") void readSignup(ctx.memory, ctx.api);
  // Asked AFTER the change (R7): a snapshot read already under way may predate it.
  void ctx.defaults.acquire(ctx.defaults.boundary());
}

export interface SendMeta {
  done: string;
  surface: string;
  target: string | null;
}

/**
 * One management command under the admitted operation `token`, idempotent per body (D-12a-2). Returns its answer, or null when the
 * operation no longer owns the page (unmounted and remounted is still owned; another identity is not).
 */
export async function sendAttempt(
  ctx: Ctx,
  token: number,
  attempt: Attempt,
  meta: SendMeta,
): Promise<HouseholdResult<{ revision: number }> | null> {
  const { memory, api } = ctx;
  const result = await untilSent(
    () => api.command(JSON.parse(attempt.body), attempt.key),
    { isCurrent: () => owns(memory, token) },
  );
  if (!owns(memory, token)) {
    // Another identity is displayed: nothing here is for it (the attempt stays with the identity that made it).
    release(memory, token);
    return null;
  }
  release(memory, token);
  const identity = memory.identity;
  // The unresolved attempt this send was a Try again of, if it was one.
  const unresolved = unresolvedOf(memory);
  const earlier = unresolved?.attempt.key === attempt.key ? unresolved : null;
  if (result.ok) {
    if (earlier !== null) hold(memory, null);
    memory.note(meta.surface, null);
    ctx.announce(meta.done);
    refreshAfterChange(ctx);
    return result;
  }
  switch (result.kind) {
    case "uncertain":
      hold(memory, { attempt, ...meta, identity, sent: true, heldBack: false });
      memory.note(meta.surface, null);
      return result;
    case "not_sent":
      hold(memory, {
        attempt,
        ...meta,
        identity,
        sent: earlier?.sent === true,
        heldBack: true,
      });
      memory.note(meta.surface, null);
      return result;
    case "offline":
    case "closed":
      // Not sent this time: an earlier attempt that may have committed stays exactly as it was (R8). A first attempt was never sent.
      if (earlier !== null) {
        hold(memory, { ...earlier, heldBack: false });
        return result;
      }
      if (result.kind === "offline")
        memory.note(meta.surface, { message: base.SAVE_OFFLINE_REASON });
      return result;
    default:
      // The server's own refusal of this key and body: it was not made.
      if (earlier !== null) hold(memory, null);
      memory.note(meta.surface, {
        message: messageOf(result),
        ...requestIdOf(result),
      });
      // What the refusal says may be out of date here: read again what it concerns (a lost role, a changed household, a stale row).
      void readHouseholds(memory, api);
      if (
        result.kind === "gone" ||
        result.kind === "conflict" ||
        result.kind === "not_found"
      ) {
        void readInvitations(memory, api);
        void walkSent(memory, api);
      }
      return result;
  }
}

/** A new command (not a Try again): admitted, then sent as a fresh attempt. */
export async function run(
  ctx: Ctx,
  command: ManagementCommand,
  meta: SendMeta,
): Promise<HouseholdResult<{ revision: number }> | null> {
  const token = admit(ctx.memory, false);
  if (token === null) return null;
  return sendAttempt(ctx, token, nextAttempt(null, [command], ctx.newId), meta);
}

/** Try again: the unresolved attempt as it was (same key, same body). */
export async function retry(ctx: Ctx): Promise<void> {
  const earlier = unresolvedOf(ctx.memory);
  const token = earlier === null ? null : admit(ctx.memory, true);
  if (earlier === null || token === null) return;
  const result = await sendAttempt(ctx, token, earlier.attempt, {
    done: earlier.done,
    surface: earlier.surface,
    target: earlier.target,
  });
  // A create that is now known to have been made: show the household it made.
  if (result?.ok && earlier.surface === "new" && earlier.target !== null)
    ctx.go(`/sharing/households/${encodeURIComponent(earlier.target)}`);
}

/** Reload while an attempt is unresolved: the lists again; the attempt is NOT ended (R8). */
export function reloadAll(ctx: Ctx): void {
  void readHouseholds(ctx.memory, ctx.api);
  void readInvitations(ctx.memory, ctx.api);
  void walkSent(ctx.memory, ctx.api);
}

/**
 * Invite an existing account to `household` by EXACT username (D-12b-14). The lookup is part of the operation: the page is owned from
 * the click, so nothing else is sent while its answer is awaited; the continuation checks ownership, identity, connection and
 * compatibility again. A `conflict` is explained from a read made after it: already a member, already invited by you, or changed.
 */
export async function invite(
  ctx: Ctx,
  household: SnapshotHousehold,
  username: string,
  surface: string,
): Promise<boolean> {
  const { memory } = ctx;
  const token = admit(memory, false);
  if (token === null) return false;
  memory.note(surface, null);
  const api = ctx.api;
  const found = await untilSent(() => api.lookup(username), {
    isCurrent: () => owns(memory, token),
  });
  if (!owns(memory, token)) {
    release(memory, token);
    return false;
  }
  const reason = liveReason(memory);
  if (reason !== null) {
    release(memory, token);
    memory.note(surface, { message: reason });
    return false;
  }
  const match: DirectoryEntry | undefined = found.ok
    ? found.value.find((entry) => entry.username === username)
    : undefined;
  if (!found.ok || match === undefined) {
    release(memory, token);
    memory.note(
      surface,
      found.ok
        ? { message: base.INVITE_NOT_FOUND }
        : { message: base.LOOKUP_FAILED, ...requestIdOf(found) },
    );
    return false;
  }
  if (match.id === ctx.accountId) {
    release(memory, token);
    memory.note(surface, { message: copy.INVITE_SELF });
    return false;
  }
  const result = await sendAttempt(
    ctx,
    token,
    nextAttempt(
      null,
      [cmd.invite(ctx.newId(), household, match.id)],
      ctx.newId,
    ),
    { done: copy.INVITED(username), surface, target: household.id },
  );
  if (result !== null && !result.ok && result.kind === "conflict") {
    await Promise.all([readHouseholds(memory, api), walkSent(memory, api)]);
    if (!isCurrentHouseholds(memory)) return false;
    const cause = conflictCause(
      {
        household: householdOf(memory, household.id),
        sent: memory.sent.last?.value.items ?? [],
      },
      match.id,
      household.id,
    );
    memory.note(surface, {
      message: copy.INVITE_CONFLICT[cause](username),
      ...requestIdOf(result),
    });
  }
  return result?.ok === true;
}

export const respond = (ctx: Ctx, invitation: Invitation, accept: boolean) =>
  run(ctx, cmd.respond(invitation, accept), {
    done: accept
      ? copy.ACCEPTED(invitation.household_name)
      : copy.DECLINED(invitation.household_name),
    surface: `respond:${invitation.id}`,
    target: invitation.household_id,
  });

export const revokeSent = (ctx: Ctx, sent: SentInvitation, surface: string) =>
  run(ctx, cmd.revoke(sent), {
    done: copy.SENT_REVOKED(sent.recipient_username),
    surface,
    target: sent.household_id,
  });

// ---- signup invitations (Q21 group 2, D-12b-9) -----------------------------------------------------------------------------------
const signature = (
  list: readonly AccountInvitationSummary[],
  householdId: string,
) =>
  list
    .filter((i) => i.household_id === householdId)
    .map((i) => i.id)
    .sort()
    .join(",");

/** The active signup invitations of `householdId` as last read, or null when never read. */
export const signupOf = (
  memory: HouseholdsMemory,
  householdId: string,
): AccountInvitationSummary[] | null =>
  memory.signup.last?.value.filter((i) => i.household_id === householdId) ??
  null;

/** Whether New invitation is still held by an earlier `limit` refusal (until the household's list changes). */
export function stillLimited(
  memory: HouseholdsMemory,
  householdId: string,
): boolean {
  const at = memory.limited.get(householdId);
  if (at === undefined) return false;
  const list = memory.signup.last?.value;
  return list !== undefined && signature(list, householdId) === at;
}

/**
 * Issue a signup invitation (SHARE-7). NOT idempotent, so an uncertain answer is never sent again: the list is read again instead, and
 * an id that was not listed before is flagged "may have just been created". The link (the token in the fragment) is held only in page
 * memory until Done.
 */
export async function issueSignup(
  ctx: Ctx,
  householdId: string,
  origin: string,
): Promise<void> {
  const { memory, api } = ctx;
  const surface = `signup:${householdId}`;
  const token = admit(memory, false);
  if (token === null) return;
  memory.note(surface, null);
  const before = new Set(
    (signupOf(memory, householdId) ?? []).map((invitation) => invitation.id),
  );
  const result = await untilSent(() => api.signupIssue(householdId), {
    isCurrent: () => owns(memory, token),
  });
  const owned = owns(memory, token);
  release(memory, token);
  if (!owned) return;
  if (result.ok) {
    memory.issued.set(householdId, {
      ...result.value,
      link: signupLink(origin, result.value.token),
    });
    memory.touch();
    ctx.announce(copy.SIGNUP_READY);
    void readSignup(memory, api);
    return;
  }
  if (result.kind === "limit") {
    const list = memory.signup.last?.value ?? [];
    memory.limited.set(householdId, signature(list, householdId));
    memory.note(surface, {
      message: copy.SIGNUP_LIMIT,
      ...requestIdOf(result),
    });
    void readSignup(memory, api).then(() => {
      // Read again just after the refusal: hold New invitation against THAT list (a change after it frees it).
      const now = memory.signup.last?.value;
      if (now !== undefined && memory.limited.has(householdId))
        memory.limited.set(householdId, signature(now, householdId));
    });
    return;
  }
  if (result.kind === "uncertain" || result.kind === "not_sent") {
    memory.note(surface, {
      message: copy.SIGNUP_UNCERTAIN,
      ...requestIdOf(result),
    });
    await readSignup(memory, api);
    const after = signupOf(memory, householdId);
    if (after !== null) {
      const fresh = after.filter((i) => !before.has(i.id)).map((i) => i.id);
      if (fresh.length > 0) {
        const flagged = memory.flagged.get(householdId) ?? new Set<string>();
        for (const id of fresh) flagged.add(id);
        memory.flagged.set(householdId, flagged);
        memory.touch();
      }
    }
    return;
  }
  if (result.kind === "closed") return;
  memory.note(surface, { message: messageOf(result), ...requestIdOf(result) });
  if (result.kind === "forbidden") void readHouseholds(memory, api);
}

/** Revoke a signup invitation. Its effect is idempotent, so after an uncertain answer it may be tried again. */
export async function revokeSignup(
  ctx: Ctx,
  id: string,
  householdId: string,
): Promise<void> {
  const { memory, api } = ctx;
  const surface = `signup-row:${id}`;
  const token = admit(memory, false);
  if (token === null) return;
  memory.note(surface, null);
  const result = await untilSent(() => api.signupRevoke(id), {
    isCurrent: () => owns(memory, token),
  });
  const owned = owns(memory, token);
  release(memory, token);
  if (!owned) return;
  if (result.ok || result.kind === "not_found") {
    memory.revokeUncertain.delete(id);
    memory.flagged.get(householdId)?.delete(id);
    memory.touch();
    if (result.ok) ctx.announce(copy.SIGNUP_REVOKED);
    else memory.note(`signup:${householdId}`, { message: copy.SIGNUP_GONE });
    void readSignup(memory, api);
    return;
  }
  if (result.kind === "uncertain" || result.kind === "not_sent") {
    memory.revokeUncertain.add(id);
    memory.note(surface, {
      message: copy.SIGNUP_REVOKE_UNCERTAIN,
      ...requestIdOf(result),
    });
    return;
  }
  if (result.kind === "closed") return;
  memory.note(surface, { message: messageOf(result), ...requestIdOf(result) });
  if (result.kind === "forbidden") void readHouseholds(memory, api);
}

/** The complete list's count (never B5's subset: MU-6219), or null when the list was never read on this page. */
export const membershipCount = (memory: HouseholdsMemory): number | null =>
  listOf(memory)?.length ?? null;
