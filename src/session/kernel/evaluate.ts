import { deriveNeutral, deriveSignedOut } from "../model/neutral-state";
import type { AccountId, AuthRecords, PendingDeletion } from "../model/types";
import type { ConsentTicket } from "../model/view";
import {
  closeDisplay,
  recordClosesDisplay,
  tryExpose,
  watchForeignLeases,
} from "./expose";
import type { Kernel } from "./state";

/**
 * The page's decision routine: read the record, learn the settled identity, close what the record closes, and
 * otherwise try to display. It is triggered by boot, hints, visibility, `online`, the end of a closing write and the
 * scan. It NEVER decides to display: only an exposure (`expose` then `act`) does, and only inside its own cover
 * transaction. The record read here is a hint for the view, not a permission (matrix G3).
 *
 * Single flight: a trigger that arrives while a read is under way runs one more read afterwards.
 */
const running = new WeakMap<Kernel, { again: boolean; done: Promise<void> }>();

/** Returns a promise that settles when the read that follows this call has been fully applied. */
export function evaluate(k: Kernel, reason: string): Promise<void> {
  if (k.disposed) return Promise.resolve();
  const state = running.get(k);
  if (state) {
    state.again = true;
    return state.done;
  }
  const mine = { again: false, done: Promise.resolve() };
  mine.done = (async () => {
    try {
      do {
        mine.again = false;
        await evaluateOnce(k, reason);
      } while (mine.again && !k.disposed);
    } finally {
      running.delete(k);
    }
  })();
  running.set(k, mine);
  return mine.done;
}

/**
 * A snapshot of the record, or `null` when it cannot be read within `bound` (hard: a later answer is ignored). Every caller but the
 * display check uses the 5 s recording bound; the display check passes its own `displayReadStallMs` (T22-READ-BOUND-20261012).
 */
export async function readRecords(
  k: Kernel,
  bound = k.config.recordingStallMs,
): Promise<AuthRecords | null> {
  try {
    const outcome = await k.withStall(
      k.transact(
        (records) => ({ write: null, result: structuredClone(records) }),
        "read",
        false,
      ),
      bound,
    );
    return outcome === "stalled" ? null : outcome;
  } catch {
    return null;
  }
}

/**
 * The entry whose prompt this page shows: the settled account's, else the oldest waiting one. A fixed order, so two pages (and
 * two reads) agree on which prompt is showing; the choice itself is bound to the entry by its ticket, never by this order.
 */
export function selectConsent(
  records: AuthRecords,
  settled: AccountId | null,
): PendingDeletion | undefined {
  return Object.values(records.pending_deletions)
    .filter(
      (entry) =>
        entry.status === "awaiting_consent" &&
        (settled === null || settled === entry.account_id),
    )
    .sort(
      (a, b) =>
        a.created_at.localeCompare(b.created_at) ||
        a.account_id.localeCompare(b.account_id),
    )[0];
}

/** The ticket of the prompt for `entry`: the same while the entry is unchanged, a new one when it or the prompt changes. */
function publishConsent(k: Kernel, entry: PendingDeletion): ConsentTicket {
  const shown = k.memory.consentPrompt;
  if (
    shown &&
    shown.account === entry.account_id &&
    shown.operationId === entry.operation_id &&
    shown.digest === entry.digest
  )
    return shown.ticket;
  const ticket = k.ports.ids.uuid() as ConsentTicket;
  k.memory.consentPrompt = {
    ticket,
    account: entry.account_id,
    operationId: entry.operation_id,
    digest: entry.digest,
  };
  return ticket;
}

/**
 * The synchronous closing path for a page that cannot tell what the record says: the exposure attempt is cancelled in
 * whatever state (a reserved one's `act` then refuses), and the displayed or mounted tree is unmounted, which also clears
 * the protected title, live regions, focus and saved position. No `await`: it runs in the step that learns of the failure.
 */
function failClosed(k: Kernel): void {
  k.memory.exposure?.cancel("read_failure");
  const display = k.memory.display;
  if (display.kind === "displaying")
    closeDisplay(k, display.account, "read_failure");
  const mounted = k.memory.mountedAccount;
  if (mounted !== null) closeDisplay(k, mounted, "read_failure");
}

async function evaluateOnce(k: Kernel, reason: string): Promise<void> {
  const records = await readRecords(k, k.config.displayReadStallMs);
  if (k.disposed) return;
  if (records === null) {
    // Fail closed (matrix 3.7.2 item 3): a page that cannot read the record shows nothing protected, so what is displayed,
    // mounted or being reserved is closed in this same step, BEFORE the read-failure card replaces the view. The card is in
    // a separate root; changing the view alone would leave the protected tree mounted, visible and exposed to assistive
    // technology beneath it.
    failClosed(k);
    k.neutral = { ...k.neutral, readFailure: true };
    k.view.set({ kind: "neutral", state: "1e.read_failure" });
    // Nothing is shown until a read succeeds, and then only through the normal exposure protocol; retry on the back-off.
    void k.sleep(k.backoff(0)).then(() => evaluate(k, "read_retry"));
    return;
  }
  if (k.neutral.readFailure) k.neutral = { ...k.neutral, readFailure: false };
  const record = records.auth_state;
  k.lastRecord = record;
  const settled = record.settled;
  // HF1-SHARED-CONFIRMATION-20261013: the settled session's shared CSRF token, tagged (account, epoch) like the page's own. It is the token of
  // exactly this settlement (an epoch is never reused), so it is adopted only when the page has none for it.
  const shared = record.confirmation;
  if (
    settled &&
    shared &&
    shared.account_id === settled.account_id &&
    shared.epoch === settled.epoch &&
    shared.session_id === settled.session_id
  ) {
    const key = k.memory.csrfKey(settled.account_id, settled.epoch);
    if (!k.memory.csrf.has(key)) k.memory.csrf.set(key, shared.csrf_token);
  }
  k.emit("evaluate", { reason, settled: settled?.account_id ?? null });

  k.memory.settled = settled
    ? {
        account: settled.account_id,
        epoch: settled.epoch,
        sessionId: settled.session_id,
      }
    : null;
  k.identity.set(
    settled
      ? {
          account_id: settled.account_id,
          epoch: settled.epoch,
          session_id: settled.session_id,
        }
      : null,
  );

  // A read that shows (X, e) is no longer the settled identity cancels the exposure attempt (Ex5(d)).
  const attempt = k.memory.exposure;
  if (
    attempt &&
    (settled === null ||
      settled.account_id !== attempt.account ||
      settled.epoch !== attempt.epoch)
  )
    attempt.cancel("settlement_changed");

  const display = k.memory.display;
  if (
    display.kind === "displaying" &&
    (settled === null ||
      settled.account_id !== display.account ||
      settled.epoch !== display.epoch)
  )
    closeDisplay(k, display.account, "settlement_changed");
  // A tree still mounted behind the level-0 gate for an account that is no longer settled is unmounted, never lifted.
  const mounted = k.memory.mountedAccount;
  if (mounted !== null && (settled === null || settled.account_id !== mounted))
    closeDisplay(k, mounted, "settlement_changed");
  // "This foreign lease is unresolved" was decided for one (account, epoch); after a new settlement the exposure
  // decides afresh, so E5 can convert an older-epoch lease.
  if (
    k.neutral.unresolvedLeaseKnown &&
    k.memory.unresolvedKnownFor &&
    (settled === null ||
      settled.account_id !== k.memory.unresolvedKnownFor.account ||
      settled.epoch !== k.memory.unresolvedKnownFor.epoch)
  ) {
    k.neutral = { ...k.neutral, unresolvedLeaseKnown: false };
    k.memory.unresolvedKnownFor = null;
  }

  k.hooks.onRecord(records);

  const env = { online: k.ports.page.isOnline() };
  // The post-success prompt shows from the durable `awaiting_consent` entry after every reload. It carries a count only,
  // and the opaque ticket that binds the person's choice to THIS entry (account, operation and consent digest).
  const consent = selectConsent(records, settled?.account_id ?? null);
  if (consent) {
    if (k.memory.display.kind === "displaying")
      closeDisplay(k, k.memory.display.account, "wipe_consent");
    k.view.set({
      kind: "neutral",
      state: "wipe.consent",
      consent: {
        count: consent.count ?? 0,
        ticket: publishConsent(k, consent),
      },
    });
    return;
  }
  k.memory.consentPrompt = null;
  if (settled === null) {
    k.view.set({
      kind: "signed_out",
      state: deriveSignedOut(record, k.neutral, env),
    });
    return;
  }

  const account = settled.account_id;
  const named = deriveNeutral(
    record,
    { ...k.neutral, hold: k.memory.hasHold(account) },
    env,
  );
  const shown = k.memory.display;
  if (
    shown.kind === "displaying" &&
    shown.account === account &&
    shown.epoch === settled.epoch
  ) {
    if (named !== null || recordClosesDisplay(record, account, settled.epoch)) {
      closeDisplay(k, account, "record_closes");
      k.view.set({ kind: "neutral", state: named ?? "1e.checking" });
      return;
    }
    watchForeignLeases(k, record, account);
    return;
  }
  // A tree still mounted behind the level-0 gate for THIS account, when the record now closes it (a fence, a gating
  // attempt): the neutral state replaces it, so nothing protected remains (level 1). Found by the real-engine gate spec.
  if (
    k.memory.mountedAccount === account &&
    (named !== null || recordClosesDisplay(record, account, settled.epoch))
  ) {
    closeDisplay(k, account, "record_closes");
    k.view.set({ kind: "neutral", state: named ?? "1e.checking" });
    return;
  }
  if (named !== null) {
    k.view.set({ kind: "neutral", state: named });
    return;
  }
  if (k.memory.hasHold(account)) {
    k.view.set({ kind: "neutral", state: "1e.checking" });
    return;
  }
  // Nothing in the record closes the account: ask the exposure protocol, which decides inside its own transaction.
  k.view.set({ kind: "neutral", state: "1e.checking" });
  tryExpose(k, account, settled.epoch);
}
