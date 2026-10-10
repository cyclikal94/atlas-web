import type { Wipe, WipeOutcome } from "../api";
import { LOCKS } from "../constants";
import { applyOperationOutcome } from "../model/reducers/operation";
import type {
  AccountId,
  LeaseId,
  OperationId,
  PendingDeletion,
} from "../model/types";
import type { ConsentTicket } from "../model/view";
import type { Kernel } from "./state";

/**
 * The canonical deletion procedure (WEB-04 design 7.8 steps 0 to 5; delivery-slices amendment 26; decisions D-03,
 * D-04, D-14, D-18). The FULL procedure, not the abbreviated four-step version. Entered on a confirmed
 * `confirmed_applied` (logout or self-retirement) and re-entered from recovery; idempotent at step 0.
 *
 * ONE CRITICAL SECTION. Every writer or clearer of the ledger entry, and every caller of `AccountDatabasePort.delete`,
 * performs its WHOLE sequence inside one held `atlas-delete:<account>`: recording the entry, the consent choice (validation,
 * status change and "Keep for now"'s three writes), and steps 0 to 5. The lock is taken before the first read and released
 * only at a terminal outcome, never acquired again by a caller that already holds it (the locked sequences are private
 * methods that assume it). Lock order: `atlas-delete:<account>`, then `atlas-auth`; `atlas-auth` is never requested while
 * waiting for `atlas-delete`, so no cycle is possible. There is no fallback without Web Locks.
 */
export class WipeService implements Wipe {
  constructor(private readonly k: Kernel) {}

  private get ports() {
    return this.k.ports.deletion;
  }

  /** The ledger entry for an account, or null (also null when the ledger cannot be read: never blocks a sign-in). */
  async outstanding(account: AccountId): Promise<PendingDeletion | null> {
    try {
      return await this.ports.ledger.read(account);
    } catch {
      return null;
    }
  }

  /**
   * `options.create` says whether an absent entry may be created here:
   * - `"operation"`: a confirmed operation recording its deletion. The entry is created only while THAT operation's own
   *   envelope fence is still in `atlas-auth`, checked in the creating transaction.
   * - `"never"`: a continuation of an entry that was seen earlier (a fresh sign-in, recovery at boot). An entry that is gone
   *   was resolved meanwhile; it is not recreated.
   * - omitted: the direct entry of the public API, used by tests and tooling: records first, unconditionally.
   */
  async run(
    account: AccountId,
    operationId: OperationId,
    options: { callLease?: LeaseId; create?: "operation" | "never" } = {},
  ): Promise<WipeOutcome> {
    const { k } = this;
    // The lock comes FIRST: a recorded entry that another caller is resolving must not be read, created or acted on from
    // outside the critical section. A wait for another caller's terminal outcome is not bounded.
    const lock = await k.ports.locks.acquire(LOCKS.wipe(account));
    if (lock === null) return { kind: "retry_later", reason: "blocked" };
    try {
      // 1. Record first: durable BEFORE any other local effect.
      let entry: PendingDeletion | null;
      try {
        entry = await this.ports.ledger.read(account);
        if (entry === null && options.create !== "never") {
          let incarnation: string | null = null;
          try {
            if (await this.ports.database.exists(account))
              incarnation = await this.ports.database.readIncarnation(account);
          } catch {
            return { kind: "retry_later", reason: "adapter_missing" };
          }
          await this.ports.ledger.create(
            {
              operation_id: operationId,
              account_id: account,
              incarnation_id: incarnation,
              status: "pending",
              digest: null,
              approved_digest: null,
              count: null,
              created_at: k.ports.clock.iso(),
            },
            { operationLive: options.create === "operation" },
          );
          entry = await this.ports.ledger.read(account);
        }
      } catch {
        return { kind: "retry_later", reason: "adapter_missing" };
      }
      if (entry === null) return { kind: "absent" };
      // A different operation's entry is driven to its end first (a fresh sign-in calls `run` before continuing).
      return await this.procedure(
        account,
        entry.operation_id,
        options.callLease,
      );
    } finally {
      lock.release();
    }
  }

  /** Steps 0 to 5. The caller HOLDS `atlas-delete:<account>`; this never acquires it. */
  private async procedure(
    account: AccountId,
    operationId: OperationId,
    callLease: LeaseId | undefined,
  ): Promise<WipeOutcome> {
    const { k } = this;
    const { ledger, database, coordination } = this.ports;
    k.emit("wipe.step", { step: 0, account });
    // Step 0: consent status, from the entry's OWN stored digest.
    const entry = await ledger.read(account);
    if (entry === null || entry.operation_id !== operationId)
      return { kind: "absent" };
    if (entry.status === "awaiting_consent") {
      this.surfaceConsent(entry);
      return { kind: "awaiting_consent", count: consentCount(entry) };
    }
    const baseline =
      entry.status === "deletion_approved"
        ? entry.approved_digest
        : await coordination.baselineDigest(account);

    // Step 1: existence probe; NEVER open() (which would create an absent database).
    k.emit("wipe.step", { step: 1, account });
    let exists: boolean;
    try {
      exists = await database.exists(account);
    } catch {
      k.emit("wipe.adapter_missing", { account });
      return { kind: "retry_later", reason: "adapter_missing" };
    }
    if (!exists) {
      await this.finishEntry(account, operationId, callLease);
      return { kind: "absent" };
    }

    // Steps 2 and 3: incarnation. A mismatch means a legitimate new session has created the database since.
    k.emit("wipe.step", { step: 3, account });
    const current = await database.readIncarnation(account);
    if (entry.incarnation_id !== null && current !== entry.incarnation_id) {
      await this.finishEntry(account, operationId, callLease);
      return { kind: "superseded_incarnation" };
    }

    // Step 3a: coordinated closure and the consent digest.
    k.emit("wipe.step", { step: "3a", account });
    coordination.broadcastImminent(account, operationId);
    // The durable closing flag is what excludes a recovery writer that has not heard the broadcast (a delayed or absent hint), and
    // the digest read below can be overtaken by exactly such a writer. Without the flag nothing is read and nothing is deleted:
    // the entry, the fence and the work stay, and the next entry repeats this step and recomputes the consent population.
    if (!(await this.confirmClosing(account))) {
      k.emit("wipe.closing_unconfirmed", { account });
      return { kind: "retry_later", reason: "closing_unconfirmed" };
    }
    await coordination.waitForClosure(account, k.config.wipeClosureWaitMs);
    const live = await coordination.liveDigest(account);
    if (baseline !== null && live !== baseline) {
      const renewed = await ledger.setStatus(account, operationId, {
        status: "awaiting_consent",
        digest: live,
        approved_digest: null,
        count: await coordination.liveCount(account),
      });
      // A refused update means the entry is gone or no longer this operation's: there is nothing to ask about.
      if (!renewed) return { kind: "absent" };
      const updated = await ledger.read(account);
      if (updated) this.surfaceConsent(updated);
      return {
        kind: "awaiting_consent",
        count: consentCount(updated ?? entry),
      };
    }

    // Step 4: delete. `blocked` stays pending and is NEVER reported as success.
    k.emit("wipe.step", { step: 4, account });
    await database.closeOwnConnections(account);
    const deleted = await database.delete(account);
    if (deleted === "error") {
      // The entry is NOT cleared; the outcome is retried.
      return { kind: "retry_later", reason: "delete_error" };
    }

    // Step 5: ownership-checked clear, THEN the atlas-auth completion, THEN broadcast.
    k.emit("wipe.step", { step: 5, account });
    await this.finishEntry(account, operationId, callLease);
    return { kind: "deleted" };
  }

  /**
   * Whether the durable closing flag is KNOWN to be set. Up to `closingWriteAttempts` asks: the first re-ask is at once (a single
   * transaction that aborted is the common case, and each ask is itself a full transaction), and any further ones follow the usual
   * back-off, so the page does not wait for its next boot for a transient fault. Only the exact answer `closing` counts: a rejection,
   * an `unconfirmed` and anything else are all "not known", so a port that swallows its failure cannot authorise a deletion. The
   * caller HOLDS `atlas-delete:<account>`.
   */
  private async confirmClosing(account: AccountId): Promise<boolean> {
    const { k } = this;
    const attempts = Math.max(1, k.config.closingWriteAttempts);
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (attempt >= 2) {
        await k.sleep(k.backoff(attempt - 2));
        if (k.disposed) return false;
      }
      let answer: unknown;
      try {
        answer = await this.ports.coordination.setClosing(account);
      } catch {
        answer = "unconfirmed";
      }
      if (answer === "closing") return true;
      k.emit("wipe.closing_write_failed", { account, attempt });
    }
    return false;
  }

  /** Step 5: `ledger.clear` (ownership-checked), then the `atlas-auth` completion (3.5.4), then broadcast. */
  private async finishEntry(
    account: AccountId,
    operationId: OperationId,
    callLease: LeaseId | undefined,
  ): Promise<void> {
    const { k } = this;
    await this.ports.ledger.clear(account, operationId);
    await this.complete(account, operationId, "confirmed_applied", callLease);
    k.ports.hints.post({ type: "auth_state_changed" });
    void k.hooks.evaluate("wiped");
  }

  /** The `atlas-auth` completion: one transaction removing the account's fences and leases, and `settled` only under 3.5.4. */
  async complete(
    account: AccountId,
    operationId: OperationId,
    outcome: "confirmed_applied" | "rejected_stale" | "superseded",
    callLease: LeaseId | undefined,
  ): Promise<void> {
    const { k } = this;
    for (let attempt = 0; !k.disposed; attempt += 1) {
      const auth = await k.ports.locks.acquire(LOCKS.auth, {
        signal: k.ports.clock.abortAfter(k.config.lockWaitMs),
      });
      if (auth !== null) {
        try {
          const result = await k.withStall(
            k.transact(
              (records) =>
                applyOperationOutcome(records, {
                  account_id: account,
                  operation_id: operationId,
                  outcome,
                  call_lease: callLease,
                  obs_id: k.ports.ids.uuid(),
                  now: k.ports.clock.iso(),
                }),
              "apply_outcome",
            ),
            k.config.recordingStallMs,
          );
          if (result !== "stalled") {
            k.emit("wipe.completed", { account, outcome, result: result.kind });
            // A newer settlement of the same account is left in place (3.5.4): the person signed in again to
            // recover, and is told so plainly. Never signed out automatically (a second unconfirmed, destructive action).
            if (
              result.kind === "WIPED" &&
              !result.settledCleared &&
              k.memory.settled?.account === account
            )
              k.notices.set([
                ...k.notices.get(),
                { id: k.ports.ids.uuid(), kind: "remained_signed_in" },
              ]);
            return;
          }
        } catch {
          // Retry: a crash leaves the envelope, the next page repeats the call and the ledger replays.
        } finally {
          auth.release();
        }
      }
      const elapsed = await k.sleep(k.backoff(attempt));
      if (!elapsed) attempt = -1;
    }
  }

  async resolveConsent(
    ticket: ConsentTicket,
    choice: "delete" | "keep",
  ): Promise<WipeOutcome> {
    const { k } = this;
    // The choice belongs to the prompt the person saw: its account, its operation and its consent digest. Nothing is looked
    // up by "the first entry waiting", and nothing is applied to a prompt that is no longer the current one.
    const prompt = k.memory.consentPrompt;
    if (prompt === null || prompt.ticket !== ticket) return this.supersede();
    const account = prompt.account;
    // Validation, the status change and "Keep for now" all happen inside the account's critical section, serialised with
    // the deletion procedure and with the other page's choice. A choice that waited for the lock is validated AFTER it.
    const lock = await k.ports.locks.acquire(LOCKS.wipe(account));
    if (lock === null) return { kind: "retry_later", reason: "blocked" };
    try {
      const { ledger, coordination } = this.ports;
      const entry = await ledger.read(account);
      if (
        entry === null ||
        entry.status !== "awaiting_consent" ||
        entry.operation_id !== prompt.operationId ||
        entry.digest !== prompt.digest ||
        k.memory.consentPrompt?.ticket !== ticket
      )
        return this.supersede();
      const operationId = entry.operation_id;
      if (choice === "delete") {
        // Never back to `pending`, which would loop. Committed only against the entry the person answered: if it changed
        // or was resolved since the read, the update is refused and NOTHING is recreated or deleted for it.
        const approved = await ledger.setStatus(
          account,
          operationId,
          { status: "deletion_approved", approved_digest: entry.digest },
          { status: "awaiting_consent", digest: prompt.digest },
        );
        if (!approved) return this.supersede();
        k.neutral = { ...k.neutral };
        // The same held lock continues into the procedure: no second acquisition, no window between approval and deletion.
        return await this.procedure(account, operationId, undefined);
      }
      // "Keep for now": three ordered writes, with recovery after each.
      // (1) the atlas-auth transaction that removes the envelope fence and applies 3.5.4, deleting nothing;
      await this.complete(account, operationId, "confirmed_applied", undefined);
      // (2) the ownership-scanning release of the draft fence;
      await coordination.releaseFence(account, operationId);
      // (3) the ledger entry.
      await ledger.clear(account, operationId);
      k.ports.hints.post({ type: "auth_state_changed" });
      void k.hooks.evaluate("consent_kept");
      return { kind: "absent" };
    } finally {
      lock.release();
    }
  }

  async recoverPending(): Promise<void> {
    const { k } = this;
    const entries = await this.ports.ledger.list();
    const record = k.lastRecord;
    for (const entry of entries) {
      const fenced = (record?.fences[entry.account_id] ?? []).some(
        (fence) =>
          fence.kind === "operation" &&
          fence.envelope.operation_id === entry.operation_id,
      );
      // An entry whose operation fence still exists is driven by `operations.resume()` instead.
      if (fenced) continue;
      if (entry.status === "awaiting_consent") {
        this.surfaceConsent(entry);
        continue;
      }
      // An entry that is gone by the time the lock is held was resolved meanwhile: it is not recreated.
      await this.run(entry.account_id, entry.operation_id, {
        create: "never",
      });
    }
    void k.hooks.evaluate("wipe_recovered");
  }

  /** The prompt a choice was made on is gone or changed: apply nothing and let the page derive the prompt that is current. */
  private supersede(): WipeOutcome {
    this.k.emit("wipe.consent_superseded");
    void this.k.hooks.evaluate("consent_superseded");
    return { kind: "prompt_superseded" };
  }

  private surfaceConsent(entry: PendingDeletion): void {
    // The post-success prompt shows from the durable `awaiting_consent` entry after every reload.
    this.k.emit("wipe.consent", { account: entry.account_id });
    void this.k.hooks.evaluate("wipe_consent");
  }
}

/** A count of changes only, never their content. */
export function consentCount(entry: PendingDeletion): number {
  return entry.count ?? 0;
}
