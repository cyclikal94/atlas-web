import type { Recovery, RecoveryBegin, RecoveryHandle } from "../api";
import { LOCKS } from "../constants";
import { finishRecovery } from "../model/reducers/operation";
import type { AccountId } from "../model/types";
import { isGating } from "../model/types";
import { admissionFrom } from "./admission";
import { readRecords } from "./evaluate";
import { convertOlderEpochLeases, verifyUnresolved } from "./identity";
import type { Kernel } from "./state";

/**
 * Recovery reads while an account is closed (matrix 3.7.3, decision D-07). WEB-08a provides the request class, the
 * eligibility decision and the `finish_recovery` release transaction; WEB-09b provides the job (leader, cursor and
 * snapshot paths, retry budgets) and calls `begin` and `finish`. It never edits `auth_state` itself.
 */
export class RecoveryService implements Recovery {
  private readonly retries = new Set<() => void>();
  constructor(private readonly k: Kernel) {}

  onRetry(listener: () => void): () => void {
    this.retries.add(listener);
    return () => {
      this.retries.delete(listener);
    };
  }

  /** The person's neutral "Try again" (session `actions.retry`): every listener (the page's sync leader) is told. */
  retried(): void {
    for (const listener of [...this.retries]) {
      try {
        listener();
      } catch {
        // A listener's failure is its own; the session's retry goes on.
      }
    }
  }

  async begin(account: AccountId): Promise<RecoveryBegin> {
    const { k } = this;
    for (let round = 0; round < 8; round += 1) {
      if (!k.ports.page.isOnline())
        return { kind: "ineligible", reason: "offline" };
      const records = await readRecords(k);
      if (records === null) return { kind: "ineligible", reason: "stale" };
      const state = records.auth_state;
      const settled = state.settled;
      if (!settled || settled.account_id !== account)
        return { kind: "ineligible", reason: "stale" };
      // WEB-08c K-2: a refusal carries the admission revision of THIS read, so a waiter's baseline is what the refusal was decided on.
      const refused = (
        reason: Exclude<
          Extract<RecoveryBegin, { kind: "ineligible" }>["reason"],
          "stale" | "offline" | "unresolved_lease"
        >,
      ): RecoveryBegin => ({
        kind: "ineligible",
        reason,
        revision: admissionFrom(k, records, "recovery", account, settled.epoch)
          .revision,
      });
      if (isGating(state.attempt)) return refused("attempt_gating");
      const fences = state.fences[account] ?? [];
      if (fences.length === 0) return refused("no_fence");
      if (fences.some((fence) => fence.kind === "operation"))
        return refused("operation_pending");
      if (fences.some((fence) => fence.kind === "credential_unverified"))
        return refused("credential_unverified");
      if (fences.some((fence) => fence.epoch >= settled.epoch))
        return refused("current_epoch_entry");

      // Like any cover, wait (outside atlas-auth) for every foreign lease of the account to be released to this page.
      const foreign = Object.entries(state.leases).filter(
        ([, lease]) =>
          lease.account_id === account && lease.boot_id !== k.bootId,
      );
      for (const [id] of foreign) {
        if (k.memory.released.has(id)) continue;
        const waited = await k.ports.locks.wait(LOCKS.lease(id));
        if (waited !== "granted")
          return { kind: "ineligible", reason: "unresolved_lease" };
        k.memory.released.add(id);
      }
      const remaining = new Set(
        foreign
          .filter(([, lease]) => lease.class !== "exposure")
          .map(([id]) => id),
      );
      if (remaining.size > 0) {
        // E5 converts an older epoch; an unresolved lease of epoch `e` is resolved by a verification first.
        await convertOlderEpochLeases(k, account, remaining);
        await verifyUnresolved(k, account, settled.epoch, remaining);
        continue;
      }
      // `s` is captured BEFORE the first request is sent (rule 9).
      return {
        kind: "eligible",
        handle: { account, epoch: settled.epoch, s: state.fence_seq },
      };
    }
    return { kind: "ineligible", reason: "unresolved_lease" };
  }

  async finish(
    handle: RecoveryHandle,
  ): Promise<
    | "cleared"
    | "not_eligible"
    | "rerun"
    | "superseded"
    | "lock_timeout"
    | "failed"
  > {
    const { k } = this;
    const auth = await k.ports.locks.acquire(LOCKS.auth, {
      signal: k.ports.clock.abortAfter(k.config.lockWaitMs),
    });
    if (auth === null) return "lock_timeout";
    try {
      const result = await k.transact(
        (records) =>
          finishRecovery(records, {
            account_id: handle.account,
            epoch: handle.epoch,
            s: handle.s,
          }),
        "finish_recovery",
      );
      k.ports.hints.post({ type: "auth_state_changed" });
      void k.hooks.evaluate("recovery_finished");
      switch (result.kind) {
        case "CLEARED":
          return "cleared";
        case "RERUN":
          return "rerun";
        case "NOT_ELIGIBLE":
          return "not_eligible";
        case "SUPERSEDED":
          return "superseded";
      }
    } catch {
      return "failed";
    } finally {
      auth.release();
    }
  }

  report(
    phase: "catching_up" | "failed" | null,
    scope?: { readonly account: AccountId; readonly epoch: number },
  ): void {
    const { k } = this;
    const settled = k.memory.settled;
    // A report while nothing is settled names no identity, so it shows nothing.
    k.memory.recoveryFor =
      phase &&
      (scope ??
        (settled && { account: settled.account, epoch: settled.epoch }));
    k.neutral = { ...k.neutral, recovery: k.memory.recoveryFor ? phase : null };
    void k.hooks.evaluate("recovery_report");
  }
}
