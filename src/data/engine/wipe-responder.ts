import type { AccountId } from "../model/types";
import type { ConnectionRegistry } from "../store/registry";
import type { SyncChannel } from "./sync-channel";

/**
 * What EVERY tab with an open account database does when another tab is wiping that account (plan 5.3.3):
 *
 *  - on `presence_query` it answers, but only if it has an open connection for the account (a tab with none has nothing to close
 *    and nothing to wait for);
 *  - on `wipe_imminent` it closes ALL its connections for the account SYNCHRONOUSLY, latches `closed_for_deletion` (so a late
 *    writer gets `closed` instead of re-opening), tells the page ("signing out"), and acknowledges.
 *
 * It never reads or writes the database. A tab that cannot respond (frozen) is not waited for beyond a bound: `closing` plus the
 * digest recheck protect correctness, and the delete completes the moment the tab wakes and closes on `versionchange`.
 */
export function attachWipeResponder(options: {
  channel: SyncChannel;
  registry: ConnectionRegistry;
  /** The page shows "signing out" and refuses recovery saves for the account. */
  onSigningOut?(account: AccountId): void;
}): () => void {
  const { channel, registry } = options;
  return channel.subscribe((message) => {
    if (message.type === "presence_query") {
      if (registry.openCount(message.account) > 0)
        channel.post({
          type: "presence",
          account: message.account,
          tab_id: registry.tabId,
          nonce: message.nonce,
        });
      return;
    }
    if (message.type === "wipe_imminent") {
      const had = registry.openCount(message.account) > 0;
      registry.closeAll(message.account, { latch: "closed_for_deletion" });
      if (had) options.onSigningOut?.(message.account);
      // Acknowledge even with nothing open: the coordinator waits only for tabs that said they were present, and an ack from a
      // tab that was not is harmless.
      channel.post({
        type: "closed_ack",
        account: message.account,
        tab_id: registry.tabId,
      });
    }
  });
}
